import Foundation

/// Base64url without padding (RFC 4648 §5), strict: the alphabet only, canonical, and of the length asked for. Every binary
/// value on the wire is this (relay.md 2.1).
public enum B64 {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func encode(_ bytes: [UInt8]) -> String { encode(Data(bytes)) }

    /// The bytes, or nil for anything but canonical base64url of `count` bytes (any length when nil).
    public static func decode(_ text: String?, count: Int? = nil) -> Data? {
        guard let text, text.utf8.allSatisfy({ isAlphabet($0) }) else { return nil }
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem == 1 { return nil }
        if rem > 0 { s += String(repeating: "=", count: 4 - rem) }
        guard let data = Data(base64Encoded: s), encode(data) == text else { return nil }
        if let count, data.count != count { return nil }
        return data
    }

    private static func isAlphabet(_ c: UInt8) -> Bool {
        (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
    }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }

    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        self = out
    }
}
