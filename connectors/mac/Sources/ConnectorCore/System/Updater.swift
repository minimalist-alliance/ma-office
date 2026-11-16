import CryptoKit
import Foundation
import Security

/// A release, as MA's signed update feed describes it.
public struct UpdateManifest: Codable, Equatable, Sendable {
    public var v: Int
    public var app: String
    public var version: String
    public var build: Int
    public var minOS: String
    public var url: String
    public var sha256: String
    public var bytes: Int
    public var notes: String?

    public init(v: Int, app: String, version: String, build: Int, minOS: String, url: String, sha256: String, bytes: Int, notes: String?) {
        self.v = v
        self.app = app
        self.version = version
        self.build = build
        self.minOS = minOS
        self.url = url
        self.sha256 = sha256
        self.bytes = bytes
        self.notes = notes
    }
}

/// Signed updates. The feed is `{"manifest": "<JSON text>", "sig": "<base64url Ed25519>"}`, signed over
/// `"ma-connector-update/v1\n" + manifest` with MA's update key, whose public half is built into the app
/// (`MAUpdatePublicKey`). A build without a key never updates. With a Developer ID team set (`MATeamID`), the downloaded
/// app must also carry MA's own signature. Never a downgrade.
public struct Updater: Sendable {
    public static let domain = "ma-connector-update/v1\n"
    public static let bundleId = "com.minimalistalliance.connector"

    public let feed: URL?
    public let publicKey: Data?
    public let teamId: String?
    public let currentVersion: String
    public let currentBuild: Int
    let http: HTTPTransport

    public init(feed: URL?, publicKey: Data?, teamId: String?, currentVersion: String, currentBuild: Int, http: HTTPTransport = URLSessionTransport()) {
        self.feed = feed
        self.publicKey = publicKey
        self.teamId = teamId?.isEmpty == true ? nil : teamId
        self.currentVersion = currentVersion
        self.currentBuild = currentBuild
        self.http = http
    }

    /// Reads the app's own settings (Info.plist).
    public static func fromBundle(_ b: Bundle = .main) -> Updater {
        let info = b.infoDictionary ?? [:]
        let feed = (info["MAUpdateURL"] as? String).flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        let key = B64.decode(info["MAUpdatePublicKey"] as? String, count: 32)
        return Updater(feed: feed, publicKey: key, teamId: info["MATeamID"] as? String,
                       currentVersion: info["CFBundleShortVersionString"] as? String ?? "0",
                       currentBuild: Int(info["CFBundleVersion"] as? String ?? "0") ?? 0)
    }

    public var enabled: Bool { feed != nil && publicKey != nil }

    public enum Failure: Error, Equatable {
        case notSetUp, badSignature, badManifest, notNewer, tooOld, download, digest, bundle, codeSignature, install
    }

    /// The manifest, if its signature is MA's.
    public static func verify(_ signed: Data, publicKey: Data) throws -> UpdateManifest {
        guard let outer = try? JSONSerialization.jsonObject(with: signed) as? [String: Any], Set(outer.keys) == ["manifest", "sig"],
              let text = outer["manifest"] as? String, let sig = B64.decode(outer["sig"] as? String, count: 64),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey)
        else { throw Failure.badManifest }
        guard key.isValidSignature(sig, for: Data((domain + text).utf8)) else { throw Failure.badSignature }
        guard let m = try? JSONDecoder().decode(UpdateManifest.self, from: Data(text.utf8)), m.v == 1, m.app == bundleId,
              let u = URL(string: m.url), u.scheme == "https", u.user == nil, m.bytes > 0, m.bytes <= 200 * 1024 * 1024,
              Data(hex: m.sha256)?.count == 32
        else { throw Failure.badManifest }
        return m
    }

    /// Signs a manifest (the release tool; the key never ships).
    public static func sign(_ m: UpdateManifest, key: Curve25519.Signing.PrivateKey) throws -> Data {
        let text = String(data: try JSONEncoder().encode(m), encoding: .utf8)!
        let sig = try key.signature(for: Data((domain + text).utf8))
        return try JSONSerialization.data(withJSONObject: ["manifest": text, "sig": B64.encode(sig)], options: [.sortedKeys])
    }

    public static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0
            let y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// A newer release, or nil.
    public func check() async throws -> UpdateManifest? {
        guard let feed, let publicKey else { throw Failure.notSetUp }
        var req = URLRequest(url: feed)
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, resp) = try await http.send(req)
        guard resp.statusCode == 200 else { throw Failure.download }
        let m = try Self.verify(data, publicKey: publicKey)
        guard Self.isNewer(m.version, than: currentVersion), m.build > currentBuild else { return nil }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        guard !Self.isNewer(m.minOS, than: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)") else { throw Failure.tooOld }
        return m
    }

    /// Downloads, checks and unpacks a release; returns the new app's folder, ready to put in place.
    public func fetch(_ m: UpdateManifest) async throws -> URL {
        guard let u = URL(string: m.url), u.scheme == "https" else { throw Failure.badManifest }
        let (data, resp) = try await http.send(URLRequest(url: u))
        guard resp.statusCode == 200, data.count == m.bytes else { throw Failure.download }
        guard Data(SHA256.hash(data: data)).hex == m.sha256.lowercased() else { throw Failure.digest }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ma-connector-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let zip = dir.appendingPathComponent("update.zip")
        try data.write(to: zip)
        let out = dir.appendingPathComponent("x")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", zip.path, out.path]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw Failure.bundle }
        let app = out.appendingPathComponent("MA Connector.app")
        try checkBundle(app, version: m.version)
        return app
    }

    func checkBundle(_ app: URL, version: String) throws {
        guard let b = Bundle(url: app), b.bundleIdentifier == Self.bundleId,
              b.infoDictionary?["CFBundleShortVersionString"] as? String == version else { throw Failure.bundle }
        guard let teamId else { return }
        var code: SecStaticCode?
        var req: SecRequirement?
        // MA's Developer ID only (Security MC-I3): the Developer ID intermediate and leaf markers, not a development certificate.
        let text = "anchor apple generic and identifier \"\(Self.bundleId)\" and certificate leaf[subject.OU] = \"\(teamId)\""
            + " and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(text as CFString, [], &req) == errSecSuccess, let req,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate), req) == errSecSuccess
        else { throw Failure.codeSignature }
    }

    /// Puts the new app where this one is, then reopens it. The caller quits right after.
    public static func install(_ newApp: URL, over current: URL = Bundle.main.bundleURL) throws {
        do {
            _ = try FileManager.default.replaceItemAt(current, withItemAt: newApp)
        } catch {
            throw Failure.install
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "sleep 1; /usr/bin/open -n \"$0\"", current.path]
        try? p.run()
    }
}
