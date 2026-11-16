import Foundation

/// Messages' own database on this Mac (`~/Library/Messages/chat.db`), read-only. This is the only file the connector reads
/// besides the attachments it sends (`AttachmentReader`): Full Disk Access covers far more, and the app never uses it for
/// anything else.
///
/// Columns differ between macOS versions, so the ones read are the ones this database has (`PRAGMA table_info`), and a
/// missing one reads as empty.
public final class ChatDB {
    let db: SQLiteReader
    let messageColumns: Set<String>

    /// Apple's epoch for `message.date`: 2001-01-01, in nanoseconds since macOS 10.13 (seconds before).
    static let appleEpoch: TimeInterval = 978_307_200

    public init(path: String) throws {
        db = try SQLiteReader(path: path)
        messageColumns = db.columns(of: "message")
        guard messageColumns.contains("ROWID") || messageColumns.contains("guid") else {
            throw SQLiteReader.Failure.prepare("no message table")
        }
    }

    public static func millis(_ appleDate: Int64) -> Int64 {
        guard appleDate > 0 else { return 0 }
        let seconds = appleDate > 1_000_000_000_000 ? Double(appleDate) / 1e9 : Double(appleDate)
        return Int64((seconds + appleEpoch) * 1000)
    }

    public static func appleDate(_ millis: Int64) -> Int64 {
        Int64((Double(millis) / 1000 - appleEpoch) * 1e9)
    }

    public func maxRowId() throws -> Int64 {
        (try db.query("SELECT MAX(ROWID) AS m FROM message").first?["m"] as? Int64) ?? 0
    }

    /// The last message before `millis`: where a backfill of the days since starts.
    public func rowIdBefore(millis: Int64) throws -> Int64 {
        let r = try db.query("SELECT MAX(ROWID) AS m FROM message WHERE date < ?", [ChatDB.appleDate(millis)])
        return (r.first?["m"] as? Int64) ?? 0
    }

    func col(_ name: String, as alias: String? = nil) -> String {
        messageColumns.contains(name) ? "m.\(name)" + (alias.map { " AS \($0)" } ?? "") : "NULL AS \(alias ?? name)"
    }

    var selectMessage: String {
        """
        SELECT m.ROWID AS rowid, m.guid AS guid, \(col("text")), \(col("attributedBody")), \(col("date")), \(col("is_from_me")),
               \(col("service")), h.id AS sender, h.service AS sender_service, \(col("associated_message_guid")),
               \(col("associated_message_type")), \(col("associated_message_emoji")), \(col("item_type")), \(col("group_action_type")),
               \(col("group_title")), \(col("date_edited")), \(col("date_retracted")), \(col("error")), \(col("subject")),
               \(col("cache_has_attachments")), \(col("balloon_bundle_id")), \(col("is_finished")),
               c.ROWID AS chat_rowid, c.guid AS chat_guid, c.display_name AS chat_name, c.style AS chat_style
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        """
    }

    /// Messages after `rowid`, oldest first.
    public func messages(after rowid: Int64, limit: Int) throws -> [SQLiteReader.Row] {
        try db.query(selectMessage + " WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?", [rowid, limit])
    }

    /// Messages edited or unsent since `mark` (Apple's date), among those after `fromRowid` and up to `throughRowid`.
    public func changes(since mark: Int64, fromRowid: Int64, throughRowid: Int64, limit: Int) throws -> [SQLiteReader.Row] {
        let parts = ["date_edited", "date_retracted"].filter { messageColumns.contains($0) }.map { "m.\($0) > ?" }
        guard !parts.isEmpty else { return [] }
        let args: [Any?] = [fromRowid, throughRowid] + parts.map { _ in mark } + [limit]
        return try db.query(selectMessage + " WHERE m.ROWID > ? AND m.ROWID <= ? AND (" + parts.joined(separator: " OR ") + ") ORDER BY m.ROWID LIMIT ?", args)
    }

    public func participants(chatRowId: Int64) throws -> [String] {
        try db.query("SELECT h.id AS id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id WHERE j.chat_id = ? ORDER BY h.ROWID",
                     [chatRowId]).compactMap { $0["id"] as? String }
    }

    public struct Attachment {
        public let guid: String
        public let path: String?
        public let mime: String?
        public let name: String?
        public let bytes: Int64
    }

    public func attachments(messageRowId: Int64) throws -> [Attachment] {
        try db.query("""
            SELECT a.guid AS guid, a.filename AS filename, a.mime_type AS mime, a.transfer_name AS name, a.total_bytes AS bytes
            FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
            WHERE j.message_id = ? ORDER BY a.ROWID
            """, [messageRowId]).compactMap { r in
            guard let g = r["guid"] as? String else { return nil }
            return Attachment(guid: g, path: r["filename"] as? String, mime: r["mime"] as? String, name: r["name"] as? String,
                              bytes: r["bytes"] as? Int64 ?? -1)
        }
    }

    /// The member's own message to `chatGuid` with this text since `sinceMillis`, newest first: how a send learns its guid,
    /// and how a retry finds a send that already went.
    public func findSent(chatGuid: String, text: String, sinceMillis: Int64) throws -> (guid: String, rowid: Int64)? {
        let rows = try db.query("""
            SELECT m.ROWID AS rowid, m.guid AS guid, \(col("text")), \(col("attributedBody"))
            FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE c.guid = ? AND m.is_from_me = 1 AND m.date >= ? ORDER BY m.ROWID DESC LIMIT 50
            """, [chatGuid, ChatDB.appleDate(sinceMillis)])
        for r in rows {
            let t = (r["text"] as? String) ?? (r["attributedBody"] as? Data).flatMap { TypedStream.text($0) }
            if t == text, let g = r["guid"] as? String, let id = r["rowid"] as? Int64 { return (g, id) }
        }
        return nil
    }

    /// Whether this chat exists here (a reply goes to a chat the Mac already has, or to a person by their handle).
    public func chatExists(_ guid: String) throws -> Bool {
        !(try db.query("SELECT 1 AS x FROM chat WHERE guid = ? LIMIT 1", [guid])).isEmpty
    }
}
