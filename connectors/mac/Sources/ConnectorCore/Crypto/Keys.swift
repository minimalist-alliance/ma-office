import CryptoKit
import Foundation

/// The device's own keys (relay.md 2.1): an Ed25519 identity it signs with, and an X25519 box key the desk seals to, bound by
/// the identity's signature. Both come from CryptoKit; nothing here combines primitives in a new way.
public struct DeviceKeys {
    public let identity: Curve25519.Signing.PrivateKey
    public let box: Curve25519.KeyAgreement.PrivateKey
    /// The binding: the identity's signature over `"ma-courier-key/v1 bind\n" + boxKey` (the base64url text). Made once:
    /// CryptoKit's Ed25519 signatures are randomized, and any of them verifies.
    public let binding: String

    public init(identity: Curve25519.Signing.PrivateKey, box: Curve25519.KeyAgreement.PrivateKey) {
        self.identity = identity
        self.box = box
        let boxText = B64.encode(box.publicKey.rawRepresentation)
        let sig = try? identity.signature(for: Data(("ma-courier-key/v1 bind\n" + boxText).utf8))
        self.binding = B64.encode(sig ?? Data())
    }

    /// Fresh keys, from the system's random source.
    public static func generate() -> DeviceKeys {
        DeviceKeys(identity: .init(), box: .init())
    }

    /// From the 64 bytes `seed (32) || box secret (32)`, as the keychain keeps them.
    public init?(secret: Data) {
        guard secret.count == 64,
              let i = try? Curve25519.Signing.PrivateKey(rawRepresentation: secret.prefix(32)),
              let b = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret.suffix(32))
        else { return nil }
        self.init(identity: i, box: b)
    }

    public var secret: Data { identity.rawRepresentation + box.rawRepresentation }

    public var identityKey: String { B64.encode(identity.publicKey.rawRepresentation) }
    public var boxKey: String { B64.encode(box.publicKey.rawRepresentation) }

    public var published: PublishedKeys {
        PublishedKeys(identityKey: identityKey, boxKey: boxKey, binding: binding)
    }

    public var fingerprint: String {
        Fingerprint.of(identity: identity.publicKey.rawRepresentation, box: box.publicKey.rawRepresentation)
    }

    public func sign(_ data: Data) -> Data {
        (try? identity.signature(for: data)) ?? Data()
    }
}

/// Someone's published keys: the desk's, as the platform gave them at pairing.
public struct PublishedKeys: Codable, Equatable {
    public let identityKey: String
    public let boxKey: String
    public let binding: String

    public init(identityKey: String, boxKey: String, binding: String) {
        self.identityKey = identityKey
        self.boxKey = boxKey
        self.binding = binding
    }

    /// The identity's public key, when the bundle is whole: both keys decode, the box key isn't a low-order point, and the
    /// identity signed the binding.
    public func checked() -> (identity: Curve25519.Signing.PublicKey, box: Curve25519.KeyAgreement.PublicKey)? {
        guard let idRaw = B64.decode(identityKey, count: 32),
              let boxRaw = B64.decode(boxKey, count: 32),
              let sig = B64.decode(binding, count: 64),
              !LowOrder.isLowOrder(boxRaw),
              let id = try? Curve25519.Signing.PublicKey(rawRepresentation: idRaw),
              let box = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: boxRaw),
              id.isValidSignature(sig, for: Data(("ma-courier-key/v1 bind\n" + boxKey).utf8))
        else { return nil }
        return (id, box)
    }

    public var fingerprint: String? {
        guard let i = B64.decode(identityKey, count: 32), let b = B64.decode(boxKey, count: 32) else { return nil }
        return Fingerprint.of(identity: i, box: b)
    }
}

public enum Fingerprint {
    /// SHA-256 over `"ma-courier-key/v1\n" || identity || box`, its first 16 bytes as 8 groups of 4 lowercase hex.
    public static func of(identity: Data, box: Data) -> String {
        var h = SHA256()
        h.update(data: Data("ma-courier-key/v1\n".utf8))
        h.update(data: identity)
        h.update(data: box)
        let hex = Data(h.finalize()).prefix(16).hex
        var groups: [String] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 4)
            groups.append(String(hex[i..<j]))
            i = j
        }
        return groups.joined(separator: "-")
    }

    /// The first two groups, for a short line on screen ("3f2a-91c0").
    public static func short(_ fp: String) -> String {
        fp.split(separator: "-").prefix(2).joined(separator: "-")
    }
}

/// libsodium's blocklist of low-order X25519 encodings (the platform's keys.ts holds the same list).
enum LowOrder {
    static let points: [Data] = [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ].compactMap { Data(hex: $0) }

    static func isLowOrder(_ raw: Data) -> Bool {
        guard raw.count == 32 else { return true }
        var k = [UInt8](raw)
        k[31] &= 0x7f
        return points.contains(Data(k))
    }
}

/// The number both sides show after pairing, so the member can check that the office and the Mac hold each other's real
/// keys (nothing in between swapped one): SHA-256 over `"ma-device-pair/v1\n" || desk identity || device identity`, its first
/// 5 bytes as a number below 10^12, shown as three groups of four digits. Deskd computes the same (ConnectorLinks.check).
public enum PairCheck {
    public static func number(desk: Data, device: Data) -> String {
        var h = SHA256()
        h.update(data: Data("ma-device-pair/v1\n".utf8))
        h.update(data: desk)
        h.update(data: device)
        let b = [UInt8](Data(h.finalize()).prefix(5))
        var n: UInt64 = 0
        for x in b { n = (n << 8) | UInt64(x) }
        let d = String(format: "%012llu", n % 1_000_000_000_000)
        let a = d.index(d.startIndex, offsetBy: 4), c = d.index(d.startIndex, offsetBy: 8)
        return "\(d[..<a]) \(d[a..<c]) \(d[c...])"
    }
}
