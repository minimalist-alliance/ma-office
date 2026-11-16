import CryptoKit
import Foundation

/// A body too big for an envelope, in the relay's ciphertext drop: ma-desk's `Drop` format exactly (relay.md 2.2 and 2.3).
/// A 44-byte content key (a ChaCha20-Poly1305 key and a 12-byte base nonce) for this one body; 64 KiB chunks, chunk `i`
/// sealed with nonce `base XOR i` (RFC 9180 §5.2's sequence) and aad `"ma-courier/v1 drop\n" || u64be i || last`; then zeros
/// to the drop bucket. The signed payload carries `{id, key, len, sha256, bytes}`.
public enum Drop {
    public static let chunk = 64 * 1024
    public static let maxBody = 48 * 1024 * 1024
    static let keyBytes = 44
    static let aadPrefix = Data("ma-courier/v1 drop\n".utf8)

    public static func ciphertextLength(_ body: Int) -> Int {
        let chunks = max(1, (body + chunk - 1) / chunk)
        return body + chunks * Envelope.tagBytes
    }

    static func aad(_ index: UInt64, last: Bool) -> Data {
        var d = aadPrefix
        withUnsafeBytes(of: index.bigEndian) { d.append(contentsOf: $0) }
        d.append(last ? 1 : 0)
        return d
    }

    static func nonce(_ base: Data, _ seq: UInt64) -> Data {
        var n = [UInt8](base)
        withUnsafeBytes(of: seq.bigEndian) { b in
            for i in 0..<8 { n[4 + i] ^= b[i] }
        }
        return Data(n)
    }

    /// A sealed body: the drop's bytes, padded to its bucket, and the reference for the payload once the platform names it.
    public struct Sealed {
        public let bytes: Data
        public let key: Data
        public let length: Int
        public let sha256: Data

        public var bucket: Int { bytes.count }

        public func reference(dropId: String) -> [String: Any] {
            ["id": dropId, "key": B64.encode(key), "len": length, "sha256": B64.encode(sha256), "bytes": bucket]
        }
    }

    public static func seal(_ body: Data, key: Data? = nil) throws -> Sealed {
        guard !body.isEmpty else { throw EnvelopeError.format("an empty body needs no drop") }
        guard body.count <= maxBody else { throw EnvelopeError.tooLarge }
        let k: Data
        if let key {
            k = key
        } else {
            var r = [UInt8](repeating: 0, count: keyBytes)
            guard SecRandomCopyBytes(kSecRandomDefault, r.count, &r) == errSecSuccess else { throw EnvelopeError.format("random") }
            k = Data(r)
        }
        guard k.count == keyBytes, let bucket = Padding.dropBucket(ciphertextLength(body.count)) else { throw EnvelopeError.tooLarge }
        let sym = SymmetricKey(data: k.prefix(32))
        let base = k.suffix(12)
        var out = Data(capacity: bucket)
        let chunks = max(1, (body.count + chunk - 1) / chunk)
        for i in 0..<chunks {
            let start = body.startIndex + i * chunk
            let end = min(start + chunk, body.endIndex)
            let box = try ChaChaPoly.seal(body[start..<end], using: sym, nonce: try ChaChaPoly.Nonce(data: nonce(base, UInt64(i))),
                                          authenticating: aad(UInt64(i), last: i == chunks - 1))
            out.append(box.ciphertext)
            out.append(box.tag)
        }
        out.append(Data(count: bucket - out.count))
        return Sealed(bytes: out, key: k, length: body.count, sha256: Data(SHA256.hash(data: body)))
    }

    /// Opens and checks a drop against its reference from a verified payload. `bytes` is the drop's size as the relay gave it.
    public static func open(reference: [String: Any], bytes: Int, drop: Data) throws -> Data {
        guard Set(reference.keys) == ["id", "key", "len", "sha256", "bytes"],
              let id = reference["id"] as? String, id.hasPrefix("dr-"), id.count == 29,
              let key = B64.decode(reference["key"] as? String, count: keyBytes),
              let length = reference["len"] as? Int, let declared = reference["bytes"] as? Int,
              let sha = B64.decode(reference["sha256"] as? String, count: 32),
              length > 0, length <= maxBody, declared == Padding.dropBucket(ciphertextLength(length)), bytes == declared
        else { throw EnvelopeError.format("not a drop reference") }
        guard drop.count == declared else { throw EnvelopeError.truncated }
        let sym = SymmetricKey(data: key.prefix(32))
        let base = key.suffix(12)
        var body = Data(capacity: length)
        let chunks = max(1, (length + chunk - 1) / chunk)
        var offset = drop.startIndex
        var left = length
        for i in 0..<chunks {
            let size = min(chunk, left)
            let sealed = drop[offset..<(offset + size + Envelope.tagBytes)]
            offset += size + Envelope.tagBytes
            do {
                let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: nonce(base, UInt64(i))),
                                                   ciphertext: sealed.prefix(size), tag: sealed.suffix(Envelope.tagBytes))
                body.append(try ChaChaPoly.open(box, using: sym, authenticating: aad(UInt64(i), last: i == chunks - 1)))
            } catch {
                throw EnvelopeError.cannotOpen
            }
            left -= size
        }
        guard drop[offset...].allSatisfy({ $0 == 0 }) else { throw EnvelopeError.format("the drop's padding isn't zeros") }
        guard Data(SHA256.hash(data: body)) == sha else { throw EnvelopeError.bodyMismatch }
        return body
    }
}
