import CryptoKit
import Foundation
@testable import ConnectorCore

/// The platform's device routes (relay.md 0.4.3), in memory, checking every signature as the platform does, plus a desk that
/// claims the code and talks to the Mac in SPEC B's format. Only for the Swift tests; the Java test kit's fake relay is the
/// one deskd and the cross-language test use.
final class FakePlatform: HTTPTransport, @unchecked Sendable {
    struct Env {
        var id: String
        var to: String
        var enc: Data
        var ct: Data
        var drops: [String]
    }

    let lock = NSLock()
    var pairings: [String: (code: String, key: String, box: String, binding: String, device: String?)] = [:]
    var deviceKey: String?
    var deviceId = "dv-abcdefghijkl"
    var revoked = false
    var up: [Env] = []
    var down: [Env] = []
    var drops: [String: Data] = [:]
    var idem: [String: String] = [:]
    var badDateOnce = false
    var requests: [String] = []
    let desk = DeviceKeys.generate()
    var seenNonces = Set<String>()

    func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { handle(req) }
    }

    func handle(_ req: URLRequest) -> (Data, HTTPURLResponse) {
        let url = req.url!
        let method = req.httpMethod ?? "GET"
        if url.host == "drops.test" {
            let id = url.lastPathComponent
            if method == "PUT" { drops[id] = req.httpBody ?? Data(); return reply(200, [:]) }
            return (drops[id] ?? Data(), HTTPURLResponse(url: url, statusCode: drops[id] == nil ? 404 : 200, httpVersion: nil, headerFields: nil)!)
        }
        requests.append("\(method) \(url.path)")
        // A.2: the signature.
        guard let key = req.value(forHTTPHeaderField: "MA-Device-Key"), let date = req.value(forHTTPHeaderField: "MA-Date"),
              let nonce = req.value(forHTTPHeaderField: "MA-Nonce"), let sig = B64.decode(req.value(forHTTPHeaderField: "MA-Signature"), count: 64),
              let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: B64.decode(key, count: 32) ?? Data())
        else { return error(401, "bad_signature") }
        if badDateOnce {
            badDateOnce = false
            return error(401, "bad_date", details: ["serverTime": Time.rfc3339(Date().addingTimeInterval(3600))])
        }
        let body = req.httpBody ?? Data()
        let signed = RelayClient.signedString(method: method, path: url.path, query: url.query ?? "", date: date, nonce: nonce, body: body)
        guard pub.isValidSignature(sig, for: signed) else { return error(401, "bad_signature") }
        if method != "GET" {
            guard seenNonces.insert(key + nonce).inserted else { return error(401, "replay") }
        }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let path = url.path
        if method == "POST" && path == "/v1/device/pairings" {
            guard json["identityKey"] as? String == key else { return error(401, "bad_signature") }
            let id = "pr-" + Ulid.make()
            pairings[id] = ("BCDF-GHJK", key, json["boxKey"] as! String, json["binding"] as! String, nil)
            return reply(201, ["pairingId": id, "userCode": "BCDF-GHJK", "expiresAt": Time.rfc3339(Date().addingTimeInterval(600)), "interval": 5])
        }
        if method == "GET" && path.hasPrefix("/v1/device/pairings/") {
            guard let p = pairings[url.lastPathComponent], p.key == key else { return error(404, "not_found") }
            guard let dv = p.device else { return reply(200, ["state": "waiting", "expiresAt": Time.rfc3339(Date().addingTimeInterval(500))]) }
            return reply(200, ["state": "paired", "deviceId": dv, "pairedAt": Time.rfc3339(Date()), "claimedBy": ["email": "a•••@example.com"],
                               "desk": ["name": "Personal", "kind": "personal", "identityKey": desk.identityKey, "boxKey": desk.boxKey,
                                        "binding": desk.binding, "fingerprint": desk.fingerprint, "keysVersion": 1]])
        }
        guard key == deviceKey, !revoked else { return error(401, "device_unknown") }
        switch (method, path) {
        case ("POST", "/v1/device/relay/drops"):
            let id = "dr-" + Ulid.make()
            return reply(201, ["dropId": id, "url": "https://drops.test/\(id)", "method": "PUT", "headers": ["x-test": "1"]])
        case ("POST", "/v1/device/relay/send"):
            if let k = req.value(forHTTPHeaderField: "Idempotency-Key"), let prior = idem[k] { return reply(202, ["id": prior]) }
            let ct = B64.decode(json["ct"] as? String)!
            guard ct.count <= 32_784 else { return error(413, "too_large") }
            let e = Env(id: Ulid.make(), to: deviceId, enc: B64.decode(json["enc"] as? String)!, ct: ct, drops: json["drops"] as? [String] ?? [])
            up.append(e)
            if let k = req.value(forHTTPHeaderField: "Idempotency-Key") { idem[k] = e.id }
            return reply(202, ["id": e.id, "receivedAt": Time.rfc3339(Date())])
        case ("GET", "/v1/device/relay"):
            let list = down.prefix(20).map { e -> [String: Any] in
                ["id": e.id, "kind": "device", "to": e.to, "enc": B64.encode(e.enc), "ct": B64.encode(e.ct), "drops": [Any]()]
            }
            return reply(200, ["envelopes": Array(list), "next": NSNull(), "pending": down.count])
        case ("POST", "/v1/device/relay/ack"):
            let ids = Set(json["ids"] as? [String] ?? [])
            down.removeAll { ids.contains($0.id) }
            return reply(200, ["acked": ids.count, "pending": down.count])
        case ("DELETE", "/v1/device/self"):
            revoked = true
            return (Data(), HTTPURLResponse(url: url, statusCode: 204, httpVersion: nil, headerFields: nil)!)
        default:
            return error(404, "not_found")
        }
    }

    func reply(_ status: Int, _ obj: [String: Any]) -> (Data, HTTPURLResponse) {
        (try! JSONSerialization.data(withJSONObject: obj), HTTPURLResponse(url: URL(string: "https://api.test")!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func error(_ status: Int, _ code: String, details: [String: Any] = [:]) -> (Data, HTTPURLResponse) {
        reply(status, ["error": ["code": code, "message": code, "retryable": false, "details": details]])
    }

    // MARK: the desk's side

    /// The member typed the code into Courier: the desk claims it.
    func claim() {
        lock.lock(); defer { lock.unlock() }
        for (id, p) in pairings where p.device == nil {
            pairings[id]!.device = deviceId
            deviceKey = p.key
        }
    }

    var macKey: Curve25519.Signing.PublicKey {
        try! Curve25519.Signing.PublicKey(rawRepresentation: B64.decode(deviceKey!, count: 32)!)
    }

    var macBox: Curve25519.KeyAgreement.PublicKey {
        let p = pairings.values.first { $0.key == deviceKey }!
        return try! Curve25519.KeyAgreement.PublicKey(rawRepresentation: B64.decode(p.box, count: 32)!)
    }

    /// The desk seals something down to the Mac.
    func sendDown(_ type: String, _ fields: [String: Any], at: Date = Date()) throws {
        let (pt, _) = try DeviceSigned.wrap(keys: desk, device: deviceId, dir: "down", type: type, fields: fields, at: at)
        lock.lock(); defer { lock.unlock() }
        let e = try Envelope.seal(kind: "device", to: deviceId, boxKey: macBox, plaintext: pt)
        down.append(Env(id: Ulid.make(), to: deviceId, enc: e.enc, ct: e.ct, drops: []))
    }

    /// Everything the Mac sent up, opened and verified as the desk would, `big` ones unwrapped from their drop.
    func takeUp() throws -> [DeviceSigned.Payload] {
        lock.lock(); defer { lock.unlock() }
        var out: [DeviceSigned.Payload] = []
        for e in up {
            let pt = try Envelope.open(kind: "device", to: deviceId, boxKey: desk.box, enc: e.enc, ct: e.ct)
            var p = try DeviceSigned.open(pt, signer: macKey, device: deviceId, dir: "up")
            if p.type == "big", let ref = p.fields["drop"] as? [String: Any], let id = ref["id"] as? String {
                let body = try Drop.open(reference: ref, bytes: ref["bytes"] as! Int, drop: drops[id]!)
                let inner = try JSONSerialization.jsonObject(with: body) as! [String: Any]
                p = DeviceSigned.Payload(p: String(data: body, encoding: .utf8)!, fields: inner)
            }
            out.append(p)
        }
        up.removeAll()
        return out
    }

    func file(_ ref: [String: Any]) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        return try Drop.open(reference: ref, bytes: ref["bytes"] as! Int, drop: drops[ref["id"] as! String]!)
    }
}
