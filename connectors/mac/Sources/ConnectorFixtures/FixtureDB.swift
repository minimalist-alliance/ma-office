import AppKit
import ConnectorCore
import Foundation
import SQLite3

/// A synthetic Messages database, laid out as macOS 14 and 15 lay out `chat.db`, with made-up people and 555 numbers. Tests
/// and the harness use it; the app never does, and nothing here ever opens a real Messages database.
public final class FixtureDB {
    public let path: String
    /// The fake home folder: attachments go under `<home>/Library/Messages/Attachments`.
    public let home: URL
    private var db: OpaquePointer?

    public static let schema = """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL,
          uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
        CREATE TABLE IF NOT EXISTS chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER,
          account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT,
          is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0,
          successful_query INTEGER, last_read_message_timestamp INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
          replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB,
          version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0,
          date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0,
          is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0,
          is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
          is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT,
          item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0,
          share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0,
          message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT,
          associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, expressive_send_style_id TEXT,
          associated_message_range_location INTEGER DEFAULT 0, associated_message_range_length INTEGER DEFAULT 0,
          time_expressive_send_played INTEGER DEFAULT 0, message_summary_info BLOB, ck_sync_state INTEGER DEFAULT 0, ck_record_id TEXT,
          ck_record_change_tag TEXT, destination_caller_id TEXT, is_corrupt INTEGER DEFAULT 0, reply_to_guid TEXT, sort_id INTEGER,
          is_spam INTEGER DEFAULT 0, has_unseen_mention INTEGER DEFAULT 0, thread_originator_guid TEXT, thread_originator_part TEXT,
          syndication_ranges TEXT, synced_syndication_ranges TEXT, was_deduplicated INTEGER DEFAULT 0, is_stewie INTEGER DEFAULT 0,
          date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0, associated_message_emoji TEXT);
        CREATE TABLE IF NOT EXISTS attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0,
          start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0,
          user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB,
          attribution_info BLOB, hide_attachment INTEGER DEFAULT 0, ck_sync_state INTEGER DEFAULT 0, ck_server_change_token_blob BLOB,
          ck_record_id TEXT, original_guid TEXT UNIQUE NOT NULL, is_commsafety_sensitive INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
          message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
        CREATE TABLE IF NOT EXISTS chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
          handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
        CREATE TABLE IF NOT EXISTS message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
          attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
        """

    public init(home: URL) throws {
        self.home = home
        let dir = home.appendingPathComponent("Library/Messages", isDirectory: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Attachments"), withIntermediateDirectories: true)
        path = dir.appendingPathComponent("chat.db").path
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw NSError(domain: "fixture", code: 1)
        }
        sqlite3_busy_timeout(db, 5000)
        try exec(Self.schema)
    }

    deinit { sqlite3_close(db) }

    public var attachmentsRoot: URL { home.appendingPathComponent("Library/Messages/Attachments", isDirectory: true) }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let m = err.map { String(cString: $0) } ?? "?"
            sqlite3_free(err)
            throw NSError(domain: "fixture", code: 2, userInfo: [NSLocalizedDescriptionKey: m])
        }
    }

    @discardableResult
    func run(_ sql: String, _ args: [Any?]) throws -> Int64 {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw NSError(domain: "fixture", code: 3, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
        }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, transient)
            case let v as Data: _ = v.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(v.count), transient) }
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw NSError(domain: "fixture", code: 4, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
        }
        return sqlite3_last_insert_rowid(db)
    }

    public func handle(_ id: String, service: String = "iMessage") throws -> Int64 {
        try run("INSERT OR IGNORE INTO handle (id, service, country) VALUES (?, ?, 'us')", [id, service])
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT ROWID FROM handle WHERE id = ? AND service = ?", -1, &stmt, nil)
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(stmt, 1, id, -1, transient)
        sqlite3_bind_text(stmt, 2, service, -1, transient)
        return sqlite3_step(stmt) == SQLITE_ROW ? sqlite3_column_int64(stmt, 0) : 0
    }

    public func chat(_ guid: String, group: Bool, name: String? = nil, handles: [Int64]) throws -> Int64 {
        let service = guid.hasPrefix("SMS") ? "SMS" : "iMessage"
        let id = try run("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) VALUES (?, ?, ?, ?, ?)",
                         [guid, group ? 43 : 45, String(guid.split(separator: ";").last ?? ""), service, name ?? ""])
        for h in handles { try run("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)", [id, h]) }
        return id
    }

    public struct File {
        public var name: String
        public var mime: String
        public var bytes: Data
        /// A link to somewhere else instead of a file (the reader must refuse it).
        public var linkTo: String?

        public init(name: String, mime: String, bytes: Data, linkTo: String? = nil) {
            self.name = name
            self.mime = mime
            self.bytes = bytes
            self.linkTo = linkTo
        }
    }

    /// Adds a message; returns its ROWID and guid.
    @discardableResult
    public func message(chat: Int64, handle: Int64 = 0, fromMe: Bool = false, text: String? = nil, attributedOnly: Bool = false,
                        date: Date = Date(), service: String = "iMessage", guid: String? = nil, assocGuid: String? = nil,
                        assocType: Int = 0, itemType: Int = 0, groupAction: Int = 0, groupTitle: String? = nil, error: Int = 0,
                        files: [File] = [], balloon: String? = nil) throws -> (rowid: Int64, guid: String) {
        let g = guid ?? UUID().uuidString
        let appleDate = ChatDB.appleDate(Int64(date.timeIntervalSince1970 * 1000))
        let body = text.map { Self.attributedBody($0) }
        let rowid = try run("""
            INSERT INTO message (guid, text, handle_id, attributedBody, service, date, is_from_me, is_finished, cache_has_attachments,
              associated_message_guid, associated_message_type, item_type, group_action_type, group_title, error, balloon_bundle_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [g, attributedOnly ? nil : text, handle, body, service, appleDate, fromMe ? 1 : 0, files.isEmpty ? 0 : 1,
                  assocGuid, assocType, itemType, groupAction, groupTitle, error, balloon])
        try run("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)", [chat, rowid, appleDate])
        for f in files {
            let ag = UUID().uuidString
            let rel = "Library/Messages/Attachments/\(ag.prefix(2))/\(ag.dropFirst(2).prefix(2))/\(ag)/\(f.name)"
            let url = home.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let target = f.linkTo {
                try FileManager.default.createSymbolicLink(atPath: url.path, withDestinationPath: target)
            } else {
                try f.bytes.write(to: url)
            }
            let aid = try run("INSERT INTO attachment (guid, original_guid, filename, mime_type, transfer_name, total_bytes, is_outgoing) VALUES (?, ?, ?, ?, ?, ?, ?)",
                              [ag, ag, "~/" + rel, f.mime, f.name, f.bytes.count, fromMe ? 1 : 0])
            try run("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)", [rowid, aid])
        }
        return (rowid, g)
    }

    public func edit(_ rowid: Int64, text: String, at: Date = Date()) throws {
        try run("UPDATE message SET text = ?, attributedBody = ?, date_edited = ? WHERE ROWID = ?",
                [text, Self.attributedBody(text), ChatDB.appleDate(Int64(at.timeIntervalSince1970 * 1000)), rowid])
    }

    public func retract(_ rowid: Int64, at: Date = Date()) throws {
        try run("UPDATE message SET text = NULL, attributedBody = NULL, date_retracted = ? WHERE ROWID = ?",
                [ChatDB.appleDate(Int64(at.timeIntervalSince1970 * 1000)), rowid])
    }

    /// The text as Messages stores it in `attributedBody`: an NSAttributedString in a typedstream archive, made by Apple's own
    /// archiver, so the reader is tested against the real format.
    public static func attributedBody(_ text: String) -> Data {
        let s = NSAttributedString(string: text, attributes: [NSAttributedString.Key("__kIMMessagePartAttributeName"): 0])
        return NSArchiver.archivedData(withRootObject: s)
    }

    /// The scenario every test starts from: three made-up people, a group, and the kinds of message Messages holds.
    public struct Basic {
        public var rowan: Int64 = 0, dana: Int64 = 0, jules: Int64 = 0
        public var rowanChat: Int64 = 0, danaChat: Int64 = 0, julesChat: Int64 = 0, group: Int64 = 0
        public var old: Int64 = 0, firstNew: Int64 = 0, lastRow: Int64 = 0
        public var editable: Int64 = 0, unsendable: Int64 = 0
    }

    public func basic(now: Date = Date()) throws -> Basic {
        var b = Basic()
        b.rowan = try handle("+17205550142")
        b.dana = try handle("dana@example.com")
        b.jules = try handle("+17205550199", service: "SMS")
        b.rowanChat = try chat("iMessage;-;+17205550142", group: false, handles: [b.rowan])
        b.danaChat = try chat("iMessage;-;dana@example.com", group: false, handles: [b.dana])
        b.julesChat = try chat("SMS;-;+17205550199", group: false, handles: [b.jules])
        b.group = try chat("iMessage;+;chat000000000000000001", group: true, name: "Climbing", handles: [b.rowan, b.jules])
        b.old = try message(chat: b.rowanChat, handle: b.rowan, text: "From long ago", date: now.addingTimeInterval(-40 * 86_400)).rowid
        let day = now.addingTimeInterval(-86_400)
        b.firstNew = try message(chat: b.rowanChat, handle: b.rowan, text: "Lunch at noon?", date: day).rowid
        try message(chat: b.rowanChat, fromMe: true, text: "Sounds good", date: day.addingTimeInterval(60))
        try message(chat: b.danaChat, handle: b.dana, text: "Only in the archive", attributedOnly: true, date: day.addingTimeInterval(120))
        try message(chat: b.julesChat, handle: b.jules, text: "Running late", date: day.addingTimeInterval(180), service: "SMS")
        let photo = try message(chat: b.rowanChat, handle: b.rowan, text: "\u{FFFC}", date: day.addingTimeInterval(240),
                                files: [File(name: "IMG_0001.png", mime: "image/png", bytes: Self.png())])
        try message(chat: b.rowanChat, handle: b.rowan, date: day.addingTimeInterval(300), assocGuid: "p:0/" + photo.guid, assocType: 2000)
        try message(chat: b.group, handle: b.jules, date: day.addingTimeInterval(360), itemType: 2, groupTitle: "Climbing Sundays")
        try message(chat: b.group, handle: b.rowan, text: "Who’s in?", date: day.addingTimeInterval(420))
        try message(chat: b.rowanChat, handle: b.rowan, text: "Look", date: day.addingTimeInterval(480),
                    files: [File(name: "secret.txt", mime: "text/plain", bytes: Data(), linkTo: "/etc/hosts")])
        try message(chat: b.rowanChat, handle: b.rowan, text: "Big one", date: day.addingTimeInterval(540),
                    files: [File(name: "movie.mov", mime: "video/quicktime", bytes: Data(count: 25 * 1024 * 1024))])
        b.editable = try message(chat: b.danaChat, handle: b.dana, text: "See you at 6", date: day.addingTimeInterval(600)).rowid
        b.unsendable = try message(chat: b.danaChat, handle: b.dana, text: "Oops", date: day.addingTimeInterval(660)).rowid
        try message(chat: b.rowanChat, fromMe: true, text: "Didn’t go", date: day.addingTimeInterval(720), error: 22)
        b.lastRow = try message(chat: b.rowanChat, handle: b.rowan, text: String(repeating: "Long words for a long text. ", count: 700),
                                date: day.addingTimeInterval(780)).rowid
        return b
    }

    /// A small, real PNG (a 4 x 4 cool blue square).
    public static func png() -> Data {
        let img = NSImage(size: NSSize(width: 4, height: 4), flipped: false) { r in
            NSColor(red: 0.24, green: 0.44, blue: 0.66, alpha: 1).setFill()
            r.fill()
            return true
        }
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return Data([0x89, 0x50, 0x4E, 0x47]) }
        return png
    }
}

/// Messages, faked: records each send and writes it into the fixture database as Messages would, so its guid can be found.
public final class FakeSender: MessagesSender, @unchecked Sendable {
    public struct Sent: Codable, Equatable {
        public var text: String
        public var chat: String
        public var handles: [String]
        public var sms: Bool
    }

    private let lock = NSLock()
    public private(set) var sent: [Sent] = []
    let fixture: FixtureDB
    let log: URL?
    public var fail: SendFailure?

    public init(fixture: FixtureDB, log: URL? = nil) {
        self.fixture = fixture
        self.log = log
    }

    public func send(text: String, chatGuid: String, handles: [String], sms: Bool, chatExists: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        if let fail { throw fail }
        sent.append(Sent(text: text, chat: chatGuid, handles: handles, sms: sms))
        if let log, let data = try? JSONEncoder().encode(sent) { try? data.write(to: log) }
        var chatRow: Int64 = 0
        if let r = try? fixture.chatRow(chatGuid) { chatRow = r } else {
            chatRow = (try? fixture.chat(chatGuid, group: false, handles: [])) ?? 0
        }
        try? fixture.message(chat: chatRow, fromMe: true, text: text, service: sms ? "SMS" : "iMessage")
    }
}

public struct FakePermissions: PermissionProbe {
    public var disk: Bool
    public var auto: Bool?

    public init(fullDisk: Bool = true, automation: Bool? = true) {
        disk = fullDisk
        auto = automation
    }

    public func fullDisk() -> Bool { disk }
    public func automation(ask: Bool) -> Bool? { auto }
}

extension FixtureDB {
    public func chatRow(_ guid: String) throws -> Int64 {
        var stmt: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT ROWID FROM chat WHERE guid = ?", -1, &stmt, nil)
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, guid, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw NSError(domain: "fixture", code: 5) }
        return sqlite3_column_int64(stmt, 0)
    }
}
