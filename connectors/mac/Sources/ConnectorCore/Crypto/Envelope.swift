import CryptoKit
import Foundation

/// The relay's envelope (relay.md 2.2): one HPKE seal (RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
/// ChaCha20-Poly1305, all CryptoKit's) of a padded plaintext to the recipient's box key.
///
///     info = "ma-courier/v1 " + kind
///     aad  = "ma-courier/v1 env\n" + kind + "\n" + to       to: for kind "device", the device id (both directions)
///     pt   = plaintext || 0x80 || 0x00... to a bucket
public enum Envelope {
    public static let device = "device"
    public static let encBytes = 32
    public static let tagBytes = 16

    static let suite = HPKE.Ciphersuite(kem: .Curve25519_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .chaChaPoly)

    static func info(_ kind: String) -> Data { Data("ma-courier/v1 \(kind)".utf8) }
    static func aad(_ kind: String, _ to: String) -> Data { Data("ma-courier/v1 env\n\(kind)\n\(to)".utf8) }

    public struct Sealed: Equatable {
        public let kind: String
        public let to: String
        public let enc: Data
        public let ct: Data
    }

    /// Seals `plaintext` to `to`'s box key.
    public static func seal(kind: String, to: String, boxKey: Curve25519.KeyAgreement.PublicKey, plaintext: Data) throws -> Sealed {
        var padded = try Padding.pad(plaintext)
        defer { padded.resetBytes(in: 0..<padded.count) }
        do {
            var sender = try HPKE.Sender(recipientKey: boxKey, ciphersuite: suite, info: info(kind))
            let ct = try sender.seal(padded, authenticating: aad(kind, to))
            return Sealed(kind: kind, to: to, enc: sender.encapsulatedKey, ct: ct)
        } catch {
            throw EnvelopeError.recipientKey
        }
    }

    /// Opens an envelope sealed to this device's box key for `to`.
    public static func open(kind: String, to: String, boxKey: Curve25519.KeyAgreement.PrivateKey, enc: Data, ct: Data) throws -> Data {
        guard enc.count == encBytes, ct.count <= Padding.maxEnvelope + tagBytes, Padding.isEnvelopeBucket(ct.count - tagBytes) else {
            throw EnvelopeError.format("not an envelope's shape")
        }
        let padded: Data
        do {
            var r = try HPKE.Recipient(privateKey: boxKey, ciphersuite: suite, info: info(kind), encapsulatedKey: enc)
            padded = try r.open(ct, authenticating: aad(kind, to))
        } catch {
            throw EnvelopeError.cannotOpen
        }
        return try Padding.unpad(padded)
    }
}

/// The plaintext inside a `device` envelope (SPEC B.1): `{"p": <payload string>, "s": <Ed25519, base64url>}`, signed over
/// `"ma-courier/v1 device sig\n" + p` (its own domain, so a device's signature never stands for a desk's or the door's).
public enum DeviceSigned {
    static let sigPrefix = "ma-courier/v1 device sig\n"
    static let ulid = try! NSRegularExpression(pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$")
    static let deviceId = try! NSRegularExpression(pattern: "^dv-[a-z2-7]{12}$")
    static let at = try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(Z|[+-]\\d{2}:\\d{2})$")

    /// A payload as read, before and after its signature is checked.
    public struct Payload {
        public let p: String
        public let fields: [String: Any]
        public var id: String { fields["id"] as? String ?? "" }
        public var type: String { fields["type"] as? String ?? "" }
        public var dir: String { fields["dir"] as? String ?? "" }
        public var device: String { fields["device"] as? String ?? "" }
        public var at: String { fields["at"] as? String ?? "" }
    }

    /// Signs a payload into an envelope's plaintext. `fields` gets `v`, `kind`, `id`, `device`, `dir` and `at` here.
    public static func wrap(keys: DeviceKeys, device: String, dir: String, type: String, fields: [String: Any], id: String = Ulid.make(), at: Date = Date()) throws -> (plaintext: Data, id: String) {
        var p = fields
        p["v"] = 1
        p["kind"] = "device"
        p["id"] = id
        p["device"] = device
        p["dir"] = dir
        p["at"] = Time.rfc3339(at)
        p["type"] = type
        let pData = try JSONSerialization.data(withJSONObject: p, options: [.sortedKeys, .withoutEscapingSlashes])
        guard let pText = String(data: pData, encoding: .utf8) else { throw EnvelopeError.format("payload") }
        let sig = keys.sign(Data((sigPrefix + pText).utf8))
        let outer = try JSONSerialization.data(withJSONObject: ["p": pText, "s": B64.encode(sig)], options: [.sortedKeys, .withoutEscapingSlashes])
        return (outer, id)
    }

    /// Reads a plaintext strictly and checks its signature under `signer`, its kind, its device and its direction.
    public static func open(_ plaintext: Data, signer: Curve25519.Signing.PublicKey, device: String, dir: String) throws -> Payload {
        guard let outer = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              Set(outer.keys) == ["p", "s"],
              let p = outer["p"] as? String,
              let sig = B64.decode(outer["s"] as? String, count: 64)
        else { throw EnvelopeError.format("not {p, s}") }
        guard signer.isValidSignature(sig, for: Data((sigPrefix + p).utf8)) else { throw EnvelopeError.badSignature }
        guard let fields = try? JSONSerialization.jsonObject(with: Data(p.utf8)) as? [String: Any] else {
            throw EnvelopeError.format("payload")
        }
        let payload = Payload(p: p, fields: fields)
        guard (fields["v"] as? Int) == 1, fields["kind"] as? String == "device",
              matches(ulid, payload.id), matches(at, payload.at), !payload.type.isEmpty, payload.type.count <= 32
        else { throw EnvelopeError.format("payload fields") }
        guard payload.device == device, payload.dir == dir else { throw EnvelopeError.notForMe }
        return payload
    }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    public static func isDeviceId(_ s: String) -> Bool { matches(deviceId, s) }
}

/// Time on the wire: RFC 3339 with milliseconds, in UTC.
public enum Time {
    static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
    static let lock = NSLock()

    public static func rfc3339(_ d: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        return formatter.string(from: d)
    }

    public static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        lock.lock(); defer { lock.unlock() }
        if let d = formatter.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: s)
    }
}

/// ULIDs: 48 bits of milliseconds and 80 random bits, Crockford base32.
public enum Ulid {
    static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    public static func make(_ date: Date = Date()) -> String {
        var ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        var time = [Character](repeating: "0", count: 10)
        for i in stride(from: 9, through: 0, by: -1) {
            time[i] = alphabet[Int(ms & 31)]
            ms >>= 5
        }
        var rnd = [UInt8](repeating: 0, count: 10)
        _ = SecRandomCopyBytes(kSecRandomDefault, rnd.count, &rnd)
        var bits = 0
        var acc: UInt32 = 0
        var out = [Character]()
        for b in rnd {
            acc = (acc << 8) | UInt32(b)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[Int((acc >> UInt32(bits)) & 31)])
            }
        }
        return String(time) + String(out.prefix(16))
    }
}
