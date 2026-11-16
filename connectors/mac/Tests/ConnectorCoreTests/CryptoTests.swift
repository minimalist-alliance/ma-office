import CryptoKit
import Foundation
import Testing
@testable import ConnectorCore

/// The envelope library against ma-desk's published vectors (services/courier-envelope vectors.json): the same keys, the
/// same fingerprint, the same HPKE open, the same drop bytes.
struct VectorTests {
    let v: [String: Any] = {
        let url = Bundle.module.url(forResource: "vectors", withExtension: "json", subdirectory: "Resources")!
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }()

    func party(_ name: String) -> (DeviceKeys, [String: Any]) {
        let p = v[name] as! [String: Any]
        let id = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(hex: p["identitySeed"] as! String)!)
        let box = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(hex: p["boxSecret"] as! String)!)
        return (DeviceKeys(identity: id, box: box), p)
    }

    @Test func publishedKeysAndFingerprint() {
        for name in ["recipient", "sender"] {
            let (k, p) = party(name)
            let pub = p["publish"] as! [String: String]
            #expect(k.identityKey == pub["identityKey"])
            #expect(k.boxKey == pub["boxKey"])
            #expect(k.fingerprint == p["fingerprint"] as? String)
            let published = PublishedKeys(identityKey: pub["identityKey"]!, boxKey: pub["boxKey"]!, binding: pub["binding"]!)
            #expect(published.checked() != nil)
            #expect(published.fingerprint == p["fingerprint"] as? String)
            // Our own binding verifies too (CryptoKit's signatures are randomized; any valid one is accepted).
            #expect(k.published.checked() != nil)
        }
    }

    @Test func aBindingFromAnotherIdentityIsRefused() {
        let (r, _) = party("recipient")
        let (s, _) = party("sender")
        #expect(PublishedKeys(identityKey: r.identityKey, boxKey: r.boxKey, binding: s.binding).checked() == nil)
        let zero = B64.encode(Data(count: 32))
        #expect(PublishedKeys(identityKey: r.identityKey, boxKey: zero, binding: r.binding).checked() == nil)
    }

    @Test func opensTheJavaSealedEnvelopes() throws {
        let (r, p) = party("recipient")
        for c in v["cases"] as! [[String: Any]] {
            let relay = c["relay"] as! [String: String]
            let pt = try Envelope.open(kind: c["kind"] as! String, to: p["address"] as! String, boxKey: r.box,
                                       enc: B64.decode(relay["enc"])!, ct: B64.decode(relay["ct"])!)
            #expect(String(data: pt, encoding: .utf8) == c["plaintext"] as? String)
            #expect(B64.decode(relay["ct"])!.count - 16 == c["paddedLength"] as! Int)
            // The wrong address in the aad doesn't open it.
            #expect(throws: EnvelopeError.cannotOpen) {
                try Envelope.open(kind: c["kind"] as! String, to: "someone@courier.minimalistalliance.com", boxKey: r.box,
                                  enc: B64.decode(relay["enc"])!, ct: B64.decode(relay["ct"])!)
            }
        }
    }

    @Test func dropBytesMatchJava() throws {
        let c = (v["cases"] as! [[String: Any]]).first { $0["name"] as? String == "ma-with-drop" }!
        let body = Data((0..<150_000).map { UInt8(($0 * 31 + 7) % 256) })
        let sealed = try Drop.seal(body, key: Data(hex: c["dropKey"] as! String)!)
        #expect(sealed.bucket == c["dropLength"] as! Int)
        #expect(Data(SHA256.hash(data: sealed.bytes)).hex == c["dropSha256"] as? String)
        #expect(sealed.bytes.prefix(64).hex == c["dropFirst64Hex"] as? String)
        let ref = sealed.reference(dropId: "dr-01JCQ4V9X3M7K2P8R5T6W0Y1Z4")
        #expect(try Drop.open(reference: ref, bytes: sealed.bucket, drop: sealed.bytes) == body)
    }

    @Test func pairCheckMatchesTheDesks() {
        // The vectors' recipient as the desk, its sender as the Mac; deskd's ConnectorLinksTest holds the same number.
        let (r, _) = party("recipient")
        let (sd, _) = party("sender")
        #expect(PairCheck.number(desk: r.identity.publicKey.rawRepresentation, device: sd.identity.publicKey.rawRepresentation) == "7728 7949 2691")
    }

    @Test func padding() {
        #expect(Padding.envelopeBucket(0) == 256)
        #expect(Padding.envelopeBucket(255) == 256)
        #expect(Padding.envelopeBucket(256) == 512)
        #expect(Padding.envelopeBucket(4095) == 4096)
        #expect(Padding.envelopeBucket(4096) == 8192)
        #expect(Padding.envelopeBucket(65535) == 65536)
        #expect(Padding.envelopeBucket(65536) == nil)
        #expect(Padding.dropBucket(1) == 65536)
        #expect(Padding.dropBucket(65537) == 131072)
        #expect(throws: EnvelopeError.self) { try Padding.unpad(Data(count: 256)) }
        var over = Data([1, 2, 3, 0x80]); over.append(Data(count: 512 - 4))
        #expect(throws: EnvelopeError.self) { try Padding.unpad(over) }
    }

    @Test func dropTamperAndSizes() throws {
        let body = Data((0..<200_000).map { UInt8($0 % 251) })
        let s = try Drop.seal(body)
        let ref = s.reference(dropId: "dr-01JCQ4V9X3M7K2P8R5T6W0Y1Z9")
        var bad = s.bytes
        bad[70_000] ^= 1
        #expect(throws: EnvelopeError.cannotOpen) { try Drop.open(reference: ref, bytes: s.bucket, drop: bad) }
        #expect(throws: EnvelopeError.self) { try Drop.open(reference: ref, bytes: s.bucket * 2, drop: s.bytes) }
        var wrong = ref
        wrong["sha256"] = B64.encode(Data(count: 32))
        #expect(throws: EnvelopeError.bodyMismatch) { try Drop.open(reference: wrong, bytes: s.bucket, drop: s.bytes) }
    }
}

struct DeviceEnvelopeTests {
    let device = "dv-abcdefghijkl"

    @Test func roundTripBothWays() throws {
        let mac = DeviceKeys.generate()
        let desk = DeviceKeys.generate()
        let (pt, id) = try DeviceSigned.wrap(keys: mac, device: device, dir: "up", type: "status", fields: ["app": "1.0"])
        let env = try Envelope.seal(kind: "device", to: device, boxKey: desk.box.publicKey, plaintext: pt)
        let opened = try Envelope.open(kind: "device", to: device, boxKey: desk.box, enc: env.enc, ct: env.ct)
        let p = try DeviceSigned.open(opened, signer: mac.identity.publicKey, device: device, dir: "up")
        #expect(p.id == id)
        #expect(p.type == "status")
        #expect(p.fields["app"] as? String == "1.0")
    }

    @Test func refusesTheWrongSignerDirectionDeviceAndTampering() throws {
        let mac = DeviceKeys.generate()
        let other = DeviceKeys.generate()
        let (pt, _) = try DeviceSigned.wrap(keys: mac, device: device, dir: "up", type: "page", fields: [:])
        #expect(throws: EnvelopeError.badSignature) { try DeviceSigned.open(pt, signer: other.identity.publicKey, device: device, dir: "up") }
        #expect(throws: EnvelopeError.notForMe) { try DeviceSigned.open(pt, signer: mac.identity.publicKey, device: device, dir: "down") }
        #expect(throws: EnvelopeError.notForMe) { try DeviceSigned.open(pt, signer: mac.identity.publicKey, device: "dv-zzzzzzzzzzzz", dir: "up") }
        var s = String(data: pt, encoding: .utf8)!
        s = s.replacingOccurrences(of: "page", with: "send")
        #expect(throws: EnvelopeError.badSignature) { try DeviceSigned.open(Data(s.utf8), signer: mac.identity.publicKey, device: device, dir: "up") }
        // Sealed for another device's id: the aad doesn't match.
        let env = try Envelope.seal(kind: "device", to: "dv-zzzzzzzzzzzz", boxKey: other.box.publicKey, plaintext: pt)
        #expect(throws: EnvelopeError.cannotOpen) { try Envelope.open(kind: "device", to: device, boxKey: other.box, enc: env.enc, ct: env.ct) }
        // A device envelope never opens as a member's message.
        #expect(throws: EnvelopeError.cannotOpen) { try Envelope.open(kind: "ma", to: device, boxKey: other.box, enc: env.enc, ct: env.ct) }
    }

    @Test func signedRequestBytes() {
        let s = RelayClient.signedString(method: "GET", path: "/v1/device/relay", query: "limit=20", date: "2026-11-15T10:42:07.123Z",
                                         nonce: "AAAAAAAAAAAAAAAAAAAAAA", body: Data())
        #expect(String(data: s, encoding: .utf8) == "ma-device-req/v1\nGET\n/v1/device/relay\nlimit=20\n2026-11-15T10:42:07.123Z\nAAAAAAAAAAAAAAAAAAAAAA\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    @Test func ulids() {
        let u = Ulid.make()
        #expect(u.count == 26)
        #expect(DeviceSigned.matches(DeviceSigned.ulid, u))
    }
}

struct UpdaterTests {
    @Test func signsVerifiesAndRefusesTampering() throws {
        let key = Curve25519.Signing.PrivateKey()
        let m = UpdateManifest(v: 1, app: Updater.bundleId, version: "1.0.1", build: 2, minOS: "14.0", url: "https://example.com/u.zip",
                               sha256: String(repeating: "ab", count: 32), bytes: 10, notes: nil)
        let signed = try Updater.sign(m, key: key)
        #expect(try Updater.verify(signed, publicKey: key.publicKey.rawRepresentation) == m)
        #expect(throws: Updater.Failure.badSignature) { try Updater.verify(signed, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation) }
        var s = String(data: signed, encoding: .utf8)!
        s = s.replacingOccurrences(of: "1.0.1", with: "9.0.1")
        #expect(throws: Updater.Failure.badSignature) { try Updater.verify(Data(s.utf8), publicKey: key.publicKey.rawRepresentation) }
        var plain = m
        plain.url = "http://example.com/u.zip"
        #expect(throws: Updater.Failure.badManifest) { try Updater.verify(try Updater.sign(plain, key: key), publicKey: key.publicKey.rawRepresentation) }
    }

    @Test func versions() {
        #expect(Updater.isNewer("1.0.1", than: "1.0.0"))
        #expect(Updater.isNewer("1.10", than: "1.9.9"))
        #expect(!Updater.isNewer("1.0", than: "1.0.0"))
        #expect(!Updater.isNewer("0.9", than: "1.0"))
    }

    @Test func aBuildWithoutAKeyNeverUpdates() async {
        let u = Updater(feed: URL(string: "https://example.com/feed.json"), publicKey: nil, teamId: nil, currentVersion: "1.0", currentBuild: 1)
        #expect(!u.enabled)
        await #expect(throws: Updater.Failure.notSetUp) { _ = try await u.check() }
    }
}

struct WordsTests {
    @Test func calmAndNamed() {
        let mirror = Mirror(reflecting: Words.self)
        _ = mirror
        let all = [Words.welcomeLead, Words.codeSteps, Words.codeLife, Words.fullDiskLine, Words.fullDiskSteps, Words.automationLine,
                   Words.doneLine(30), Words.smsHint, Words.disconnectBody, Words.removeBody, Words.disconnectedBody, Words.codeFailed,
                   Words.updatesOff, Words.removeFullDisk, Words.permsLead]
        for w in all {
            #expect(!w.contains("!"))
            #expect(!w.lowercased().contains("amazon") && !w.lowercased().contains("aws"))
        }
    }
}
