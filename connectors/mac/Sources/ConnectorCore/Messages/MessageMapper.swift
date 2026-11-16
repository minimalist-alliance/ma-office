import Foundation

/// One message as the desk's `imsg` seam reads it (deskd `ImsgMessage`; SPEC B.2's M), from a row of Messages' database.
/// Files are listed here and filled in by the bridge once each is sealed into a drop.
public struct OutMessage {
    public var seq: Int64
    public var fields: [String: Any]
    public var files: [ChatDB.Attachment]
}

public enum MessageMapper {
    /// Tapbacks: Messages' 2000 to 2007 add one, 3000 to 3007 take it away (the seam's names, a leading "-" for removal).
    static let tapbacks = ["love", "like", "dislike", "laugh", "emphasize", "question", "emoji", "sticker"]

    static let guidChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:;+@/-")

    static func cleanGuid(_ s: String?) -> String? {
        guard let s, !s.isEmpty, s.count <= 200, s.unicodeScalars.allSatisfy({ guidChars.contains($0) }) else { return nil }
        return s
    }

    /// At most `max` UTF-16 units (what deskd's Java strings count), cut on a character boundary.
    static func clip(_ s: String?, _ max: Int) -> String? {
        guard let s, !s.isEmpty else { return nil }
        if s.utf16.count <= max { return s }
        var out = ""
        var units = 0
        for ch in s {
            let n = String(ch).utf16.count
            if units + n > max { break }
            out.append(ch)
            units += n
        }
        return out.isEmpty ? nil : out
    }

    /// The row as a message, or nil for one the desk never stores (no guid, an unfinished outgoing one).
    public static func map(_ r: SQLiteReader.Row, participants: [String], files: [ChatDB.Attachment]) -> OutMessage? {
        guard let rowid = r["rowid"] as? Int64, let guid = cleanGuid(r["guid"] as? String) else { return nil }
        let fromMe = (r["is_from_me"] as? Int64 ?? 0) == 1
        var text = r["text"] as? String
        if (text ?? "").isEmpty, let blob = r["attributedBody"] as? Data { text = TypedStream.text(blob) }
        // U+FFFC is the placeholder Messages leaves where an attachment sits in the text.
        text = text.map { $0.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespacesAndNewlines) }
        let chatGuid = cleanGuid(r["chat_guid"] as? String)
        let group = (r["chat_style"] as? Int64) == 43 || (chatGuid?.contains(";+;") ?? false)
        var m: [String: Any] = [
            "seq": rowid,
            "guid": guid,
            "date": ChatDB.millis(r["date"] as? Int64 ?? 0),
            "fromMe": fromMe,
            "failed": (r["error"] as? Int64 ?? 0) != 0 && fromMe,
            "appOnly": (r["balloon_bundle_id"] as? String).map { !$0.isEmpty && !$0.contains("URLBalloonProvider") } ?? false,
        ]
        if !fromMe, let s = clip(r["sender"] as? String, 320) { m["sender"] = s }
        if let s = clip((r["sender_service"] as? String) ?? (r["service"] as? String), 16) { m["senderService"] = s }
        if let chatGuid {
            var chat: [String: Any] = ["guid": chatGuid, "group": group, "participants": Array(participants.prefix(100))]
            if let n = clip(r["chat_name"] as? String, 200) { chat["name"] = n }
            m["chat"] = chat
        }
        if let t = clip(text, 20_000) { m["text"] = t }
        if let s = clip(r["subject"] as? String, 500) { m["subject"] = s }

        let assocType = Int(r["associated_message_type"] as? Int64 ?? 0)
        if assocType == 1000 {
            m["reaction"] = ["type": "sticker-message"]
        } else if (2000...2007).contains(assocType) || (3000...3007).contains(assocType) {
            let name = tapbacks[assocType % 1000]
            var re: [String: Any] = ["type": (assocType >= 3000 ? "-" : "") + name]
            if let t = cleanGuid(r["associated_message_guid"] as? String) { re["target"] = t }
            if let e = clip(r["associated_message_emoji"] as? String, 16) { re["emoji"] = e }
            m["reaction"] = re
        }
        switch r["item_type"] as? Int64 ?? 0 {
        case 1: m["event"] = ["kind": (r["group_action_type"] as? Int64 ?? 0) == 1 ? "removed" : "added"]
        case 2:
            var e: [String: Any] = ["kind": "named"]
            if let t = clip(r["group_title"] as? String, 200) { e["title"] = t }
            m["event"] = e
        case 3: m["event"] = ["kind": "left"]
        default: break
        }
        if let d = r["date_edited"] as? Int64, d > 0 { m["edited"] = ChatDB.millis(d) }
        if let d = r["date_retracted"] as? Int64, d > 0 { m["retracted"] = ChatDB.millis(d) }
        return OutMessage(seq: rowid, fields: m, files: files)
    }
}
