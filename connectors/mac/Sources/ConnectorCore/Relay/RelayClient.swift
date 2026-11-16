import CryptoKit
import Foundation

/// An answer the platform refused, in its error envelope (contract errors.md).
public struct RelayError: Error, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let retryable: Bool
    public let retryAfter: TimeInterval?
    public let details: [String: Any]

    public var description: String { "\(status) \(code)" }

    /// Nothing reached the platform, or it didn't answer.
    public static func network(_ why: String) -> RelayError {
        RelayError(status: 0, code: "network", retryable: true, retryAfter: nil, details: ["why": why])
    }
}

/// What carries the device's requests: URLSession in the app, a fake in tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession

    public init() {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 300
        c.httpCookieStorage = nil
        c.urlCache = nil
        c.httpShouldSetCookies = false
        c.waitsForConnectivity = false
        session = URLSession(configuration: c)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, resp) = try await session.data(for: request)
        guard let http = resp as? HTTPURLResponse else { throw RelayError.network("not http") }
        return (data, http)
    }
}

/// The device's side of relay.md 0.4.3: every request signed with the device's identity key (no token, no password), the
/// pairing routes, the device's relay routes and the drops' presigned links.
public final class RelayClient: @unchecked Sendable {
    public let base: URL
    let keys: DeviceKeys
    let http: HTTPTransport
    /// Seconds to add to this Mac's clock, learnt from a `bad_date` answer's `serverTime`.
    private var offset: TimeInterval = 0
    private let lock = NSLock()

    public init(base: URL, keys: DeviceKeys, http: HTTPTransport = URLSessionTransport()) {
        self.base = base
        self.keys = keys
        self.http = http
    }

    // MARK: pairing

    public struct Pairing {
        public let pairingId: String
        public let userCode: String
        public let expiresAt: Date
        public let interval: TimeInterval
    }

    public func startPairing(name: String, version: String) async throws -> Pairing {
        let body: [String: Any] = ["kind": "mac", "name": name, "identityKey": keys.identityKey, "boxKey": keys.boxKey,
                                   "binding": keys.binding, "app": ["version": version]]
        let j = try await call("POST", "/v1/device/pairings", body: body)
        guard let id = j["pairingId"] as? String, let code = j["userCode"] as? String,
              let exp = Time.parse(j["expiresAt"] as? String) else { throw RelayError.network("pairing answer") }
        return Pairing(pairingId: id, userCode: code, expiresAt: exp, interval: TimeInterval((j["interval"] as? Int) ?? 5))
    }

    public enum PairingState {
        case waiting(Date)
        case paired(deviceId: String, deskName: String, deskKind: String, desk: PublishedKeys, claimedBy: String?)
        case expired
    }

    public func pollPairing(_ id: String) async throws -> PairingState {
        do {
            let j = try await call("GET", "/v1/device/pairings/\(id)")
            if j["state"] as? String == "paired",
               let dv = j["deviceId"] as? String, DeviceSigned.isDeviceId(dv),
               let desk = j["desk"] as? [String: Any],
               let ik = desk["identityKey"] as? String, let bk = desk["boxKey"] as? String, let b = desk["binding"] as? String {
                let email = (j["claimedBy"] as? [String: Any])?["email"] as? String
                return .paired(deviceId: dv, deskName: MessageMapper.clip(desk["name"] as? String, 64) ?? "", deskKind: desk["kind"] as? String ?? "",
                               desk: PublishedKeys(identityKey: ik, boxKey: bk, binding: b),
                               claimedBy: email.flatMap { $0.count <= 320 && !$0.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format }) ? $0 : nil })
            }
            return .waiting(Time.parse(j["expiresAt"] as? String) ?? Date())
        } catch let e as RelayError where e.code == "pairing_expired" || e.status == 404 {
            return .expired
        }
    }

    // MARK: the relay

    public struct Incoming {
        public let id: String
        public let kind: String
        public let to: String
        public let enc: Data
        public let ct: Data
        public let drops: [(dropId: String, bytes: Int, url: URL?)]
    }

    public func send(enc: Data, ct: Data, drops: [String], idempotencyKey: String) async throws -> String {
        var body: [String: Any] = ["kind": Envelope.device, "enc": B64.encode(enc), "ct": B64.encode(ct)]
        if !drops.isEmpty { body["drops"] = drops }
        let j = try await call("POST", "/v1/device/relay/send", body: body, headers: ["Idempotency-Key": idempotencyKey])
        return j["id"] as? String ?? ""
    }

    public struct Reservation {
        public let dropId: String
        public let url: URL
        public let headers: [String: String]
    }

    public func reserveDrop(bytes: Int) async throws -> Reservation {
        let j = try await call("POST", "/v1/device/relay/drops", body: ["bytes": bytes])
        guard let id = j["dropId"] as? String, let u = (j["url"] as? String).flatMap(URL.init(string:)), Self.safeLink(u) else {
            throw RelayError.network("drop answer")
        }
        return Reservation(dropId: id, url: u, headers: (j["headers"] as? [String: String]) ?? [:])
    }

    /// Uploads a drop to its presigned link: exactly its bytes, with every header the reservation signed.
    public func upload(_ r: Reservation, bytes: Data) async throws {
        var req = URLRequest(url: r.url)
        req.httpMethod = "PUT"
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = bytes
        let (_, resp) = try await transport(req)
        guard (200..<300).contains(resp.statusCode) else { throw RelayError(status: resp.statusCode, code: "upload", retryable: true, retryAfter: nil, details: [:]) }
    }

    public func download(_ url: URL, bytes: Int) async throws -> Data {
        guard Self.safeLink(url) else { throw RelayError.network("link") }
        let (data, resp) = try await transport(URLRequest(url: url))
        guard (200..<300).contains(resp.statusCode), data.count == bytes else { throw RelayError.network("download") }
        return data
    }

    public func collect(after: String?, limit: Int = 20) async throws -> (envelopes: [Incoming], next: String?) {
        var q = "limit=\(limit)"
        if let after { q = "after=\(after)&" + q }
        let j = try await call("GET", "/v1/device/relay", query: q)
        let list = (j["envelopes"] as? [[String: Any]]) ?? []
        let envs: [Incoming] = list.compactMap { e in
            guard let id = e["id"] as? String, let kind = e["kind"] as? String, let to = e["to"] as? String,
                  let enc = B64.decode(e["enc"] as? String, count: Envelope.encBytes), let ct = B64.decode(e["ct"] as? String)
            else { return nil }
            let drops = ((e["drops"] as? [[String: Any]]) ?? []).compactMap { d -> (String, Int, URL?)? in
                guard let id = d["dropId"] as? String, let b = d["bytes"] as? Int else { return nil }
                return (id, b, (d["url"] as? String).flatMap(URL.init(string:)))
            }
            return Incoming(id: id, kind: kind, to: to, enc: enc, ct: ct, drops: drops.map { (dropId: $0.0, bytes: $0.1, url: $0.2) })
        }
        return (envs, j["next"] as? String)
    }

    public func ack(_ ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        _ = try await call("POST", "/v1/device/relay/ack", body: ["ids": ids])
    }

    /// The device unpairs itself: the platform forgets its keys, its inbox and its drops.
    public func unpair() async throws {
        _ = try await call("DELETE", "/v1/device/self")
    }

    // MARK: signing

    /// The bytes the device signs (relay.md 0.4.3 A.2).
    public static func signedString(method: String, path: String, query: String, date: String, nonce: String, body: Data) -> Data {
        let hash = Data(SHA256.hash(data: body)).hex
        return Data("ma-device-req/v1\n\(method)\n\(path)\n\(query)\n\(date)\n\(nonce)\n\(hash)".utf8)
    }

    func call(_ method: String, _ path: String, query: String = "", body: [String: Any]? = nil, headers: [String: String] = [:]) async throws -> [String: Any] {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.withoutEscapingSlashes]) } ?? Data()
        do {
            return try await attempt(method, path, query, data, headers)
        } catch let e as RelayError where e.code == "bad_date" {
            if let server = Time.parse(e.details["serverTime"] as? String) {
                lock.withLock { offset = server.timeIntervalSinceNow }
            }
            return try await attempt(method, path, query, data, headers)
        }
    }

    private func attempt(_ method: String, _ path: String, _ query: String, _ body: Data, _ headers: [String: String]) async throws -> [String: Any] {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.percentEncodedPath = path
        comps.percentEncodedQuery = query.isEmpty ? nil : query
        guard let url = comps.url else { throw RelayError.network("url") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        let skew = lock.withLock { offset }
        let date = Time.rfc3339(Date().addingTimeInterval(skew))
        var nonceBytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, 16, &nonceBytes)
        let nonce = B64.encode(nonceBytes)
        let sig = keys.sign(Self.signedString(method: method, path: path, query: query, date: date, nonce: nonce, body: body))
        req.setValue(keys.identityKey, forHTTPHeaderField: "MA-Device-Key")
        req.setValue(date, forHTTPHeaderField: "MA-Date")
        req.setValue(nonce, forHTTPHeaderField: "MA-Nonce")
        req.setValue(B64.encode(sig), forHTTPHeaderField: "MA-Signature")
        req.setValue("MA-Connector-Mac", forHTTPHeaderField: "User-Agent")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if !body.isEmpty {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await transport(req)
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        if (200..<300).contains(resp.statusCode) { return json }
        let err = json["error"] as? [String: Any] ?? [:]
        let ra = (resp.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
        throw RelayError(status: resp.statusCode, code: err["code"] as? String ?? "http_\(resp.statusCode)",
                         retryable: err["retryable"] as? Bool ?? (resp.statusCode >= 500 || resp.statusCode == 429),
                         retryAfter: ra, details: err["details"] as? [String: Any] ?? [:])
    }

    private func transport(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await http.send(req)
        } catch let e as RelayError {
            throw e
        } catch {
            throw RelayError.network(String(describing: type(of: error)))
        }
    }

    /// A presigned link must be https with no user info (loopback http only for the test kit's fake relay).
    static func safeLink(_ u: URL) -> Bool {
        guard u.user == nil, u.password == nil, let host = u.host else { return false }
        if u.scheme == "https" { return true }
        return u.scheme == "http" && (host == "127.0.0.1" || host == "localhost") && allowLoopback
    }

    /// Only the test harness turns this on.
    nonisolated(unsafe) public static var allowLoopback = false
}
