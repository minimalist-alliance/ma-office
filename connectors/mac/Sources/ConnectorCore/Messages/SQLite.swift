import Foundation
import SQLite3

/// A small read-only wrapper over the system's SQLite, for Messages' database. Nothing here writes.
public final class SQLiteReader {
    private var db: OpaquePointer?

    public enum Failure: Error {
        case open(Int32)
        case prepare(String)
        case step(Int32)
    }

    /// Opens read-only, never through a link: the folder is resolved first (macOS's own folders may sit behind one, such
    /// as /var), then SQLite refuses any link left in the path. `SQLITE_OPEN_READONLY` means this connection can never
    /// change Messages' data.
    public init(path: String) throws {
        var handle: OpaquePointer?
        let url = URL(fileURLWithPath: path)
        // realpath(3), not URL.resolvingSymlinksInPath (which turns /private/var back into the /var link).
        guard let dir = realpath(url.deletingLastPathComponent().path, nil) else { throw Failure.open(SQLITE_CANTOPEN) }
        let real = String(cString: dir) + "/" + url.lastPathComponent
        free(dir)
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_NOFOLLOW
        let rc = sqlite3_open_v2(real, &handle, flags, nil)
        guard rc == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }
            throw Failure.open(rc)
        }
        db = handle
        sqlite3_busy_timeout(handle, 2000)
        // Belt and braces: even a statement that tried to write would be refused.
        sqlite3_exec(handle, "PRAGMA query_only = 1", nil, nil, nil)
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    public typealias Row = [String: Any]

    /// Runs one SELECT with bound values (Int64, String, Data, Double or nil) and returns its rows.
    public func query(_ sql: String, _ args: [Any?] = []) throws -> [Row] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw Failure.prepare(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Double: sqlite3_bind_double(stmt, idx, v)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, transient)
            case let v as Data: _ = v.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(v.count), transient) }
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        var rows: [Row] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw Failure.step(rc) }
            var row: Row = [:]
            for c in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = sqlite3_column_int64(stmt, c)
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(stmt, c)
                case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(stmt, c))
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(stmt, c))
                    row[name] = n > 0 ? Data(bytes: sqlite3_column_blob(stmt, c), count: n) : Data()
                default: break
                }
            }
            rows.append(row)
        }
        return rows
    }

    func columns(of table: String) -> Set<String> {
        let rows = (try? query("PRAGMA table_info(\(table))")) ?? []
        return Set(rows.compactMap { $0["name"] as? String })
    }
}
