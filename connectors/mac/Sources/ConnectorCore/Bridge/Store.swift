import Foundation
import Security

/// Where the device keeps its two secret keys (the identity seed and the box secret, 64 bytes).
public protocol KeyStore {
    func load() -> DeviceKeys?
    func save(_ keys: DeviceKeys) throws
    func delete()
}

/// The login keychain, as a generic password only this app may read (its code signature is on the item's access list).
/// The data-protection keychain needs a provisioning profile, which a Developer ID app without one doesn't have.
public struct KeychainKeyStore: KeyStore {
    let service: String
    let account = "device-keys"

    public init(service: String = "com.minimalistalliance.connector") {
        self.service = service
    }

    var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() -> DeviceKeys? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return DeviceKeys(secret: data)
    }

    public func save(_ keys: DeviceKeys) throws {
        delete()
        var q = query
        q[kSecValueData as String] = keys.secret
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrLabel as String] = "MA Connector"
        let rc = SecItemAdd(q as CFDictionary, nil)
        guard rc == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(rc)) }
    }

    public func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// A file, 0600: the test harness's store (never the app's).
public struct FileKeyStore: KeyStore {
    let url: URL

    public init(url: URL) { self.url = url }

    public func load() -> DeviceKeys? {
        (try? Data(contentsOf: url)).flatMap { DeviceKeys(secret: $0) }
    }

    public func save(_ keys: DeviceKeys) throws {
        try keys.secret.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public func delete() { try? FileManager.default.removeItem(at: url) }
}

/// What the connector remembers between runs. No message text, no address book: places in Messages' database, the desk's
/// public keys and the answers to recent sends.
public struct BridgeState: Codable, Equatable {
    public struct Pending: Codable, Equatable {
        public var pairingId: String
        public var userCode: String
        public var expiresAt: Date
    }

    public struct Link: Codable, Equatable {
        public var deviceId: String
        public var deskName: String
        public var deskKind: String
        public var desk: PublishedKeys
        public var pairedAt: Date
        public var account: String?
        /// Who claimed the code, as the platform names them (a masked email), shown before the member confirms.
        public var claimedBy: String?
        /// The member pressed Connect on this Mac: until then nothing is carried and no send is obeyed.
        public var confirmed: Bool = false

        public init(deviceId: String, deskName: String, deskKind: String, desk: PublishedKeys, pairedAt: Date, account: String?,
                    claimedBy: String?, confirmed: Bool) {
            self.deviceId = deviceId
            self.deskName = deskName
            self.deskKind = deskKind
            self.desk = desk
            self.pairedAt = pairedAt
            self.account = account
            self.claimedBy = claimedBy
            self.confirmed = confirmed
        }

        enum CodingKeys: String, CodingKey { case deviceId, deskName, deskKind, desk, pairedAt, account, claimedBy, confirmed }

        public init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            deviceId = try c.decode(String.self, forKey: .deviceId)
            deskName = try c.decode(String.self, forKey: .deskName)
            deskKind = try c.decode(String.self, forKey: .deskKind)
            desk = try c.decode(PublishedKeys.self, forKey: .desk)
            pairedAt = try c.decode(Date.self, forKey: .pairedAt)
            account = try c.decodeIfPresent(String.self, forKey: .account)
            claimedBy = try c.decodeIfPresent(String.self, forKey: .claimedBy)
            confirmed = try c.decodeIfPresent(Bool.self, forKey: .confirmed) ?? false
        }
    }

    public struct SendAnswer: Codable, Equatable {
        public var result: String
        public var guid: String?
        public var error: String?
        public var at: Date
    }

    public var pending: Pending?
    public var link: Link?
    /// This run of Messages' database (a fresh one if it's replaced or the desk lost its place).
    public var epoch: String?
    /// The last message the relay took (Messages' ROWID), and where the run began.
    public var cursor: Int64?
    public var startRow: Int64?
    /// How many times the desk asked to go again in this epoch.
    public var resumes = 0
    /// The newest edit or unsend already sent (Apple's date).
    public var editMark: Int64?
    /// Whether the desk said hello: pages start then.
    public var started = false
    public var backfillDays = 30
    public var paused = false
    /// Down payload ids for the whole window the Mac accepts them in, so a copy (a lost ack, or a replay) is handled once.
    public var seen: [String: Date] = [:]
    /// Past the most ids kept, anything older than this is refused rather than risk a replay passing.
    public var seenFloor: Date?
    /// Answers to recent sends, by the queue's row, so a repeated send gets the same answer.
    public var sends: [String: SendAnswer] = [:]
    public var sendTimes: [Date] = []
    public var lastStatus: String?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case pending, link, epoch, cursor, startRow, resumes, editMark, started, backfillDays, paused, seen, seenFloor, sends, sendTimes, lastStatus
    }

    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        pending = try c.decodeIfPresent(Pending.self, forKey: .pending)
        link = try c.decodeIfPresent(Link.self, forKey: .link)
        epoch = try c.decodeIfPresent(String.self, forKey: .epoch)
        cursor = try c.decodeIfPresent(Int64.self, forKey: .cursor)
        startRow = try c.decodeIfPresent(Int64.self, forKey: .startRow)
        resumes = try c.decodeIfPresent(Int.self, forKey: .resumes) ?? 0
        editMark = try c.decodeIfPresent(Int64.self, forKey: .editMark)
        started = try c.decodeIfPresent(Bool.self, forKey: .started) ?? false
        backfillDays = try c.decodeIfPresent(Int.self, forKey: .backfillDays) ?? 30
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        seen = try c.decodeIfPresent([String: Date].self, forKey: .seen) ?? [:]
        seenFloor = try c.decodeIfPresent(Date.self, forKey: .seenFloor)
        sends = try c.decodeIfPresent([String: SendAnswer].self, forKey: .sends) ?? [:]
        sendTimes = try c.decodeIfPresent([Date].self, forKey: .sendTimes) ?? []
        lastStatus = try c.decodeIfPresent(String.self, forKey: .lastStatus)
    }
}

/// The state file, `~/Library/Application Support/MA Connector/state.json`, 0600, written atomically.
public final class StateStore {
    public let url: URL

    public init(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        url = directory.appendingPathComponent("state.json")
    }

    public func load() -> BridgeState {
        guard let data = try? Data(contentsOf: url) else { return BridgeState() }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return (try? d.decode(BridgeState.self, from: data)) ?? BridgeState()
    }

    public func save(_ s: BridgeState) {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        guard let data = try? e.encode(s) else { return }
        try? data.write(to: url, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public func delete() {
        try? FileManager.default.removeItem(at: url)
    }
}
