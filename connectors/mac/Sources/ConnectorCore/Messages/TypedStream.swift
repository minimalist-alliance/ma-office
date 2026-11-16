import Foundation

/// The text of a message whose `text` column is empty: Messages keeps it only in `attributedBody`, an `NSAttributedString`
/// in Apple's old "typedstream" archive format. This reads the string's bytes without unarchiving anything (no object is
/// ever made from the blob, so a crafted archive can't instantiate a class): it finds the first `NSString` (or
/// `NSMutableString`) class record, then the `+` (a C string of bytes) that follows, its length, and the UTF-8 after it.
///
/// Layout after the class name: `... 0x84 0x01 0x2B <len> <bytes>`, where `<len>` is one byte below 0x80, or `0x81` and two
/// bytes little-endian, or `0x82` and four bytes little-endian.
public enum TypedStream {
    static let classNames: [[UInt8]] = [Array("NSMutableString".utf8), Array("NSString".utf8)]

    public static func text(_ blob: Data, max: Int = 1 << 20) -> String? {
        let b = [UInt8](blob)
        guard b.count > 16, b.count <= 8 << 20 else { return nil }
        guard let header = find(Array("streamtyped".utf8), in: b, from: 0), header < 16 else { return nil }
        var start: Int?
        for name in classNames {
            if let at = find(name, in: b, from: header) { start = min(start ?? at, at) }
        }
        guard var i = start else { return nil }
        // The first '+' after the class record, introduced by 0x84 0x01.
        let limit = min(b.count, i + 64)
        while i + 2 < limit {
            if b[i] == 0x84 && b[i + 1] == 0x01 && b[i + 2] == 0x2B { break }
            i += 1
        }
        guard i + 3 < b.count, b[i] == 0x84, b[i + 1] == 0x01, b[i + 2] == 0x2B else { return nil }
        var p = i + 3
        var length = 0
        switch b[p] {
        case 0x81:
            guard p + 2 < b.count else { return nil }
            length = Int(b[p + 1]) | Int(b[p + 2]) << 8
            p += 3
        case 0x82:
            guard p + 4 < b.count else { return nil }
            length = Int(b[p + 1]) | Int(b[p + 2]) << 8 | Int(b[p + 3]) << 16 | Int(b[p + 4]) << 24
            p += 5
        case let n where n < 0x80:
            length = Int(n)
            p += 1
        default:
            return nil
        }
        guard length > 0, length <= max, p + length <= b.count else { return nil }
        return String(bytes: b[p..<(p + length)], encoding: .utf8)
    }

    static func find(_ needle: [UInt8], in hay: [UInt8], from: Int) -> Int? {
        guard needle.count <= hay.count, from <= hay.count - needle.count else { return nil }
        var i = from
        while i <= hay.count - needle.count {
            if hay[i] == needle[0] && Array(hay[i..<(i + needle.count)]) == needle { return i }
            i += 1
        }
        return nil
    }
}
