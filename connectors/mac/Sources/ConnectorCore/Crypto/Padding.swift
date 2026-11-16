import Foundation

/// Sizes on the wire (relay.md 2.2 and 2.3), so a message's size says little about its length. The same rules as
/// ma-desk's `courier-envelope` Padding.java, byte for byte.
public enum Padding {
    public static let maxEnvelope = 64 * 1024
    /// What a device may send in one envelope (relay.md 0.4.3: 32,768 plus the tag keeps the body under the firewall's limit).
    public static let maxDeviceEnvelope = 32 * 1024
    public static let minDrop = 64 * 1024
    public static let maxDrop = 64 * 1024 * 1024

    /// The bucket for a plaintext of `length` bytes (its 0x80 included), or nil if it can't be one.
    public static func envelopeBucket(_ length: Int) -> Int? {
        let needed = length + 1
        guard length >= 0, needed <= maxEnvelope else { return nil }
        if needed <= 4096 { return (needed + 255) / 256 * 256 }
        var b = 4096
        while b < needed { b <<= 1 }
        return b
    }

    public static func isEnvelopeBucket(_ size: Int) -> Bool {
        guard size > 0, size <= maxEnvelope else { return false }
        return size <= 4096 ? size % 256 == 0 : size.nonzeroBitCount == 1
    }

    static func pad(_ plaintext: Data) throws -> Data {
        guard let bucket = envelopeBucket(plaintext.count) else { throw EnvelopeError.tooLarge }
        var out = plaintext
        out.append(0x80)
        out.append(Data(count: bucket - out.count))
        return out
    }

    static func unpad(_ padded: Data) throws -> Data {
        guard isEnvelopeBucket(padded.count) else { throw EnvelopeError.format("not a bucket's size") }
        let bytes = [UInt8](padded)
        var i = bytes.count - 1
        while i >= 0 && bytes[i] == 0 { i -= 1 }
        guard i >= 0, bytes[i] == 0x80 else { throw EnvelopeError.format("the padding isn't 0x80 then zeros") }
        guard envelopeBucket(i) == bytes.count else { throw EnvelopeError.format("padded past its bucket") }
        return Data(bytes[0..<i])
    }

    /// The drop bucket for `length` bytes of ciphertext, or nil past 64 MiB.
    public static func dropBucket(_ length: Int) -> Int? {
        guard length >= 0, length <= maxDrop else { return nil }
        var b = minDrop
        while b < length { b <<= 1 }
        return b
    }

    public static func isDropBucket(_ size: Int) -> Bool {
        size >= minDrop && size <= maxDrop && size.nonzeroBitCount == 1
    }
}

public enum EnvelopeError: Error, Equatable, CustomStringConvertible {
    case format(String)
    case tooLarge
    case cannotOpen
    case badSignature
    case notForMe
    case truncated
    case bodyMismatch
    case recipientKey

    public var description: String {
        switch self {
        case .format(let why): return "format: \(why)"
        case .tooLarge: return "too_large"
        case .cannotOpen: return "cannot_open"
        case .badSignature: return "bad_signature"
        case .notForMe: return "not_for_me"
        case .truncated: return "truncated"
        case .bodyMismatch: return "body_mismatch"
        case .recipientKey: return "recipient_key"
        }
    }
}
