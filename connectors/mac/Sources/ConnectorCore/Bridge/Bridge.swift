import CryptoKit
import Foundation

/// What the menu and the window show.
public enum BridgePhase: Equatable, Sendable {
    /// Not paired: no code yet, or the code expired.
    case unpaired
    /// A code is showing; the member types it into Courier on their office.
    case pairing(code: String, expiresAt: Date)
    /// Paired by someone's office: the member checks who, and presses Connect, before anything is carried.
    case confirm(desk: String, claimedBy: String?, check: String)
    /// Paired with a desk.
    case connected(desk: String)
    /// The desk or the member disconnected this Mac (the keys are gone).
    case disconnected
}

/// The connector's engine: one serial loop that reads the relay for what the desk sent (sends, hellos), answers, and
/// carries new messages from Messages' database to the desk as sealed pages (SPEC B). Everything leaves this Mac sealed to
/// the desk's own key and signed with this Mac's; the platform carries only ciphertext.
public actor Bridge {
    public struct Config {
        public var relay: RelayClient
        public var keys: DeviceKeys
        public var keyStore: KeyStore
        public var store: StateStore
        public var chatDB: String
        public var attachments: AttachmentReader
        public var home: URL
        public var sender: MessagesSender
        public var permissions: PermissionProbe
        public var appVersion: String
        public var osVersion: String
        public var deviceName: String
        /// How long the bridge waits after a send for Messages to record it, to learn its guid.
        public var sentWait: TimeInterval = 15

        public init(relay: RelayClient, keys: DeviceKeys, keyStore: KeyStore, store: StateStore, chatDB: String, attachments: AttachmentReader,
                    home: URL, sender: MessagesSender, permissions: PermissionProbe, appVersion: String, osVersion: String, deviceName: String) {
            self.relay = relay
            self.keys = keys
            self.keyStore = keyStore
            self.store = store
            self.chatDB = chatDB
            self.attachments = attachments
            self.home = home
            self.sender = sender
            self.permissions = permissions
            self.appVersion = appVersion
            self.osVersion = osVersion
            self.deviceName = deviceName
        }
    }

    /// What the status line says, beside the phase.
    public struct Health: Equatable, Sendable {
        public var fullDisk = false
        public var automation: Bool?
        public var behind = 0
        public var lastError: String?
        public var lastSync: Date?

        public init() {}
    }

    // Limits from the seam (deskd ImsgSink.Settings, ImsgSend) and the relay.
    // The seam keeps 16 MiB of files a message (deskd ImsgSink.Settings.DEFAULT).
    static let maxFile = 16 * 1024 * 1024
    static let maxPerMessage = 16 * 1024 * 1024
    static let pageMessages = 100
    /// A page's JSON stays under this (deskd reads a big payload of at most 8 MiB): one message is far smaller, so a page
    /// always ends, and no single hostile text can make a page the desk can't take.
    static let pageBytes = 4 * 1024 * 1024
    static let maxSeen = 50_000
    static let maxDropsPerEnvelope = 8
    static let downTtl: TimeInterval = 31 * 86_400
    static let skew: TimeInterval = 86_400
    static let sendsPerHour = 60
    static let sendsPerDay = 500

    let cfg: Config
    var state: BridgeState
    public private(set) var phase: BridgePhase = .unpaired
    public private(set) var health = Health()
    private var db: ChatDB?
    private var lastTraffic = Date.distantPast
    private var nextRelayRead = Date.distantPast
    private var nextChangeScan = Date.distantPast
    private var backoffUntil = Date.distantPast
    private var backoff: TimeInterval = 0
    private var lastStatusSent = Date.distantPast
    private var nextHealth = Date.distantPast
    private var observers: [UUID: @Sendable (BridgePhase, Health) -> Void] = [:]

    public init(_ cfg: Config) {
        self.cfg = cfg
        self.state = cfg.store.load()
        if let l = state.link {
            phase = l.confirmed ? .connected(desk: l.deskName) : .confirm(desk: l.deskName, claimedBy: l.claimedBy, check: Self.check(l, cfg.keys))
        } else if let p = state.pending, p.expiresAt > Date() {
            phase = .pairing(code: p.userCode, expiresAt: p.expiresAt)
        }
    }

    public func observe(_ f: @escaping @Sendable (BridgePhase, Health) -> Void) {
        observers[UUID()] = f
        f(phase, health)
    }

    private func publish() {
        for f in observers.values { f(phase, health) }
    }

    public var snapshot: BridgeState { state }

    // MARK: pairing

    /// A new code for the member to type into Courier.
    public func startPairing() async throws {
        let p = try await cfg.relay.startPairing(name: cfg.deviceName, version: cfg.appVersion)
        state.pending = .init(pairingId: p.pairingId, userCode: p.userCode, expiresAt: p.expiresAt)
        save()
        phase = .pairing(code: p.userCode, expiresAt: p.expiresAt)
        publish()
    }

    /// Asks once whether the member confirmed the code. True once paired.
    @discardableResult
    public func checkPairing() async throws -> Bool {
        guard let p = state.pending else { return state.link != nil }
        switch try await cfg.relay.pollPairing(p.pairingId) {
        case .waiting:
            return false
        case .expired:
            state.pending = nil
            save()
            phase = .unpaired
            publish()
            return false
        case .paired(let dv, let name, let kind, let desk, let claimedBy):
            guard desk.checked() != nil else { throw EnvelopeError.recipientKey }
            state.pending = nil
            let link = BridgeState.Link(deviceId: dv, deskName: name, deskKind: kind, desk: desk, pairedAt: Date(), account: nil,
                                        claimedBy: claimedBy, confirmed: false)
            state.link = link
            state.started = false
            save()
            phase = .confirm(desk: name, claimedBy: claimedBy, check: Self.check(link, cfg.keys))
            publish()
            return true
        }
    }

    /// The member's Connect on this Mac, after checking who claimed the code: only now is anything carried or sent.
    public func confirm() {
        guard var link = state.link, !link.confirmed else { return }
        link.confirmed = true
        state.link = link
        save()
        phase = .connected(desk: link.deskName)
        lastTraffic = Date()
        nextRelayRead = .distantPast
        publish()
    }

    /// The number both the Mac and the office show for this pairing.
    static func check(_ link: BridgeState.Link, _ keys: DeviceKeys) -> String {
        guard let desk = B64.decode(link.desk.identityKey, count: 32) else { return "" }
        return PairCheck.number(desk: desk, device: keys.identity.publicKey.rawRepresentation)
    }

    public var pairCheck: String? {
        state.link.map { Self.check($0, cfg.keys) }
    }

    // MARK: the loop

    /// One pass: read what the desk sent, then carry new messages. Returns how long to wait before the next pass.
    public func tick() async -> TimeInterval {
        guard let link = state.link else {
            if state.pending != nil { _ = try? await checkPairing() }
            return state.pending != nil ? 5 : 30
        }
        // Not yet confirmed on this Mac: nothing is read, carried or sent.
        guard link.confirmed else { return 1 }
        let now = Date()
        if now < backoffUntil { return min(5, backoffUntil.timeIntervalSince(now)) }
        do {
            refreshHealth()
            if now >= nextRelayRead {
                try await readRelay()
                let active = Date().timeIntervalSince(lastTraffic) < 300
                nextRelayRead = Date().addingTimeInterval(active ? 5 : 20)
            }
            if state.link != nil, state.started, !state.paused, health.fullDisk {
                let moved = try await carry()
                if Date() >= nextChangeScan {
                    try await carryChanges()
                    nextChangeScan = Date().addingTimeInterval(30)
                }
                if moved { lastTraffic = Date(); nextRelayRead = min(nextRelayRead, Date().addingTimeInterval(2)) }
            }
            if state.link != nil { try await sendStatusIfChanged() }
            backoff = 0
            health.lastError = nil
            health.lastSync = Date()
        } catch let e as RelayError {
            handle(e)
        } catch {
            health.lastError = "messages"
            delay(30)
        }
        publish()
        return 1
    }

    /// Runs until cancelled.
    public func run() async {
        while !Task.isCancelled {
            let wait = await tick()
            try? await Task.sleep(nanoseconds: UInt64(max(0.2, wait) * 1e9))
        }
    }

    private func handle(_ e: RelayError) {
        if e.status == 401 && e.code == "device_unknown" {
            wipe()
            phase = .disconnected
            return
        }
        health.lastError = e.code
        delay(e.retryAfter ?? nil)
    }

    private func delay(_ seconds: TimeInterval?) {
        backoff = min(300, max(5, backoff * 2))
        backoffUntil = Date().addingTimeInterval(seconds ?? backoff)
    }

    private func refreshHealth(force: Bool = false) {
        guard force || Date() >= nextHealth else { return }
        nextHealth = Date().addingTimeInterval(10)
        health.fullDisk = cfg.permissions.fullDisk()
        health.automation = cfg.permissions.automation(ask: false)
        if health.fullDisk, db == nil { db = try? ChatDB(path: cfg.chatDB) }
        if !health.fullDisk { db = nil }
        if let db, let c = state.cursor, let m = try? db.maxRowId() { health.behind = Int(max(0, m - c)) } else { health.behind = 0 }
    }

    /// Look for edits and unsends on the next pass.
    func resetChangeScan() { nextChangeScan = .distantPast }

    public func setPaused(_ p: Bool) {
        state.paused = p
        save()
        publish()
    }

    /// "Check again": look at the permissions and the relay now.
    public func poke() {
        nextRelayRead = .distantPast
        backoffUntil = .distantPast
        refreshHealth(force: true)
        publish()
    }

    // MARK: down: what the desk sent

    private func readRelay() async throws {
        guard let link = state.link, let deskKey = link.desk.checked()?.identity else { return }
        let page = try await cfg.relay.collect(after: nil, limit: 20)
        var done: [String] = []
        for env in page.envelopes {
            guard state.link != nil else { break }
            guard env.kind == Envelope.device, env.to == link.deviceId else { done.append(env.id); continue }
            let payload: DeviceSigned.Payload
            do {
                let pt = try Envelope.open(kind: Envelope.device, to: link.deviceId, boxKey: cfg.keys.box, enc: env.enc, ct: env.ct)
                payload = try DeviceSigned.open(pt, signer: deskKey, device: link.deviceId, dir: "down")
            } catch {
                done.append(env.id)
                continue
            }
            guard let at = Time.parse(payload.at), at > Date().addingTimeInterval(-(Self.downTtl + Self.skew)),
                  at < Date().addingTimeInterval(Self.skew), state.seen[payload.id] == nil, at > (state.seenFloor ?? .distantPast)
            else { done.append(env.id); continue }
            lastTraffic = Date()
            try await handleDown(payload)
            state.seen[payload.id] = Date()
            done.append(env.id)
            save()
        }
        pruneSeen()
        if !done.isEmpty { try await cfg.relay.ack(done) }
    }

    private func handleDown(_ p: DeviceSigned.Payload) async throws {
        switch p.type {
        case "hello":
            state.link?.account = p.fields["account"] as? String
            if let d = p.fields["desk"] as? [String: Any], let n = d["name"] as? String, !n.isEmpty, n.count <= 64 {
                state.link?.deskName = n
                phase = .connected(desk: n)
            }
            if let days = p.fields["backfillDays"] as? Int, (0...365).contains(days) { state.backfillDays = days }
            try beginRun()
        case "resume":
            if let epoch = p.fields["epoch"] as? String, epoch == state.epoch, let after = p.fields["after"] as? Int64 ?? (p.fields["after"] as? Int).map(Int64.init) {
                state.cursor = max(state.startRow ?? 0, min(state.cursor ?? after, after))
                // A page sent again must not look like the earlier try of the same page to the relay's idempotency.
                state.resumes += 1
            } else {
                try beginRun()
            }
        case "send":
            try await handleSend(p.fields, replyTo: p.id)
        case "bye":
            wipe()
            phase = .disconnected
        default:
            break
        }
    }

    /// A new run of pages: a fresh epoch, from the start of the backfill window.
    private func beginRun() throws {
        let since = Int64((Date().timeIntervalSince1970 - Double(state.backfillDays) * 86_400) * 1000)
        let start = (try? (db ?? ChatDB(path: cfg.chatDB)).rowIdBefore(millis: since)) ?? 0
        state.epoch = UUID().uuidString.lowercased()
        state.startRow = start
        state.cursor = start
        state.editMark = ChatDB.appleDate(Int64(Date().timeIntervalSince1970 * 1000))
        state.started = true
        save()
    }

    // MARK: sending what the member wrote

    private func handleSend(_ f: [String: Any], replyTo: String) async throws {
        guard let outbound = f["outboundId"] as? String, !outbound.isEmpty, outbound.count <= 128 else { return }
        if let prior = state.sends[outbound], prior.result != "retry" {
            try await answer(outbound, prior, replyTo: replyTo)
            return
        }
        let text = f["text"] as? String ?? ""
        let chat = MessageMapper.cleanGuid(f["chatGuid"] as? String)
        let handles = ((f["handles"] as? [String]) ?? []).filter { $0.count <= 320 }
        let medium = f["medium"] as? String ?? "imessage"
        let maybe = f["maybeSentBefore"] as? Bool ?? false
        func done(_ result: String, guid: String? = nil, error: String? = nil) async throws {
            let a = BridgeState.SendAnswer(result: result, guid: guid, error: error, at: Date())
            state.sends[outbound] = a
            save()
            try await answer(outbound, a, replyTo: replyTo)
        }
        guard let chat, !text.isEmpty, text.count <= 20_000, handles.count <= 50, ["imessage", "sms"].contains(medium) else {
            return try await done("failed", error: "refused")
        }
        let now = Date()
        state.sendTimes = state.sendTimes.filter { now.timeIntervalSince($0) < 86_400 }
        if state.sendTimes.filter({ now.timeIntervalSince($0) < 3600 }).count >= Self.sendsPerHour || state.sendTimes.count >= Self.sendsPerDay {
            return try await done("retry", error: "rate")
        }
        guard health.fullDisk, let db = db ?? (try? ChatDB(path: cfg.chatDB)) else { return try await done("retry", error: "full_disk") }
        let startMs = Int64(now.timeIntervalSince1970 * 1000)
        if maybe, let found = try? db.findSent(chatGuid: chat, text: text, sinceMillis: startMs - 86_400_000) {
            return try await done("sent", guid: found.guid)
        }
        let exists = (try? db.chatExists(chat)) ?? false
        do {
            state.sendTimes.append(now)
            try cfg.sender.send(text: text, chatGuid: chat, handles: handles, sms: medium == "sms", chatExists: exists)
        } catch SendFailure.permission {
            health.automation = false
            return try await done("retry", error: "permission")
        } catch SendFailure.chat {
            return try await done("failed", error: "chat")
        } catch {
            return try await done("retry", error: "messages")
        }
        // Messages records the message a moment later: its guid lets the desk know the echo.
        var guid: String?
        let until = Date().addingTimeInterval(cfg.sentWait)
        while guid == nil && Date() < until {
            guid = (try? db.findSent(chatGuid: chat, text: text, sinceMillis: startMs - 5000))?.guid
            if guid == nil { try? await Task.sleep(nanoseconds: 500_000_000) }
        }
        try await done("sent", guid: guid)
    }

    /// One answer for each `send` the desk sealed (each try is its own envelope), keyed by that envelope's payload id.
    private func answer(_ outbound: String, _ a: BridgeState.SendAnswer, replyTo: String) async throws {
        var f: [String: Any] = ["outboundId": outbound, "result": a.result, "replyTo": replyTo]
        if let g = a.guid { f["guid"] = g }
        if let e = a.error { f["error"] = e }
        if a.result == "retry" { f["unclear"] = a.error == "messages" }
        try await sendUp(type: "sent", fields: f, drops: [], key: "sn-\(replyTo)")
        pruneSends()
    }

    // MARK: up: new messages

    /// One page of new messages, if there are any. True if one went.
    private func carry() async throws -> Bool {
        guard let db, let epoch = state.epoch, let cursor = state.cursor else { return false }
        let rows = try db.messages(after: cursor, limit: Self.pageMessages)
        guard !rows.isEmpty else { return false }
        var seenRows = Set<Int64>()
        var messages: [OutMessage] = []
        var fileCount = 0
        var pageBytes = 0
        for r in rows {
            guard let rowid = r["rowid"] as? Int64, seenRows.insert(rowid).inserted else { continue }
            let chatRow = r["chat_rowid"] as? Int64
            let people = chatRow.flatMap { try? db.participants(chatRowId: $0) } ?? []
            let files = (r["cache_has_attachments"] as? Int64 ?? 0) == 1 ? ((try? db.attachments(messageRowId: rowid)) ?? []) : []
            guard let m = MessageMapper.map(r, participants: people, files: files) else {
                messages.append(OutMessage(seq: rowid, fields: [:], files: []))
                continue
            }
            let wanted = min(m.files.count, Self.maxDropsPerEnvelope - 1)
            let size = ((try? JSONSerialization.data(withJSONObject: m.fields)).map { $0.count } ?? 0) + 300 * min(m.files.count, 50)
            if !messages.isEmpty && (fileCount + wanted > Self.maxDropsPerEnvelope - 1 || pageBytes + size > Self.pageBytes) { break }
            fileCount += wanted
            pageBytes += size
            messages.append(m)
        }
        guard let last = messages.last else { return false }
        var drops: [String] = []
        var out: [[String: Any]] = []
        for m in messages where !m.fields.isEmpty {
            var fields = m.fields
            var files: [[String: Any]] = []
            var budget = Self.maxPerMessage
            for a in m.files.prefix(50) {
                var f: [String: Any] = ["guid": a.guid]
                if let n = MessageMapper.clip(a.name, 255) { f["name"] = n }
                if let t = MessageMapper.clip(a.mime, 100) { f["mime"] = t }
                f["bytes"] = a.bytes
                f["drop"] = NSNull()
                if drops.count < Self.maxDropsPerEnvelope - 1, budget > 0, MessageMapper.cleanGuid(a.guid) != nil {
                    if case .bytes(let data) = cfg.attachments.read(a, home: cfg.home), data.count <= budget {
                        let sealed = try Drop.seal(data)
                        let r = try await cfg.relay.reserveDrop(bytes: sealed.bucket)
                        try await cfg.relay.upload(r, bytes: sealed.bytes)
                        f["drop"] = sealed.reference(dropId: r.dropId)
                        f["bytes"] = data.count
                        drops.append(r.dropId)
                        budget -= data.count
                    }
                }
                files.append(f)
            }
            fields["files"] = files
            out.append(fields)
        }
        let more = rows.count >= Self.pageMessages || messages.count < seenRows.count
        let page: [String: Any] = ["epoch": epoch, "after": cursor, "through": last.seq, "messages": out, "more": more]
        try await sendUp(type: "page", fields: page, drops: drops, key: "pg-\(epoch.prefix(8))-\(state.resumes)-\(last.seq)")
        state.cursor = last.seq
        save()
        return true
    }

    /// Edits and unsends of messages already carried.
    private func carryChanges() async throws {
        guard let db, let mark = state.editMark, let cursor = state.cursor, let start = state.startRow else { return }
        let rows = try db.changes(since: mark, fromRowid: start, throughRowid: cursor, limit: 50)
        guard !rows.isEmpty else { return }
        var out: [[String: Any]] = []
        var newMark = mark
        for r in rows {
            newMark = max(newMark, r["date_edited"] as? Int64 ?? 0, r["date_retracted"] as? Int64 ?? 0)
            let people = (r["chat_rowid"] as? Int64).flatMap { try? db.participants(chatRowId: $0) } ?? []
            guard var m = MessageMapper.map(r, participants: people, files: [])?.fields else { continue }
            m["files"] = [Any]()
            out.append(m)
        }
        if !out.isEmpty {
            try await sendUp(type: "changes", fields: ["messages": out], drops: [], key: "ch-\(newMark)")
        }
        state.editMark = newMark
        save()
    }

    // MARK: status

    private func sendStatusIfChanged() async throws {
        let s: [String: Any] = ["app": cfg.appVersion, "os": cfg.osVersion, "fullDisk": health.fullDisk,
                                "automation": health.automation.map { $0 as Any } ?? NSNull(), "messages": health.fullDisk,
                                "paused": state.paused]
        let key = (try? JSONSerialization.data(withJSONObject: s, options: [.sortedKeys])).map { Data(SHA256.hash(data: $0)).hex } ?? ""
        guard key != state.lastStatus, Date().timeIntervalSince(lastStatusSent) >= 60 || state.lastStatus == nil else { return }
        try await sendUp(type: "status", fields: s, drops: [], key: "st-\(key.prefix(16))-\(Int(Date().timeIntervalSince1970 / 60))")
        state.lastStatus = key
        lastStatusSent = Date()
        save()
    }

    // MARK: sealing

    /// Signs, seals and sends one payload up. A payload too big for a device envelope goes whole into a drop, and the
    /// envelope carries `big` with its reference (the signature covers the drop's digest).
    func sendUp(type: String, fields: [String: Any], drops: [String], key: String) async throws {
        guard let link = state.link, let desk = link.desk.checked() else { return }
        var (plaintext, _) = try DeviceSigned.wrap(keys: cfg.keys, device: link.deviceId, dir: "up", type: type, fields: fields)
        var allDrops = drops
        if plaintext.count >= Padding.maxDeviceEnvelope {
            var inner = fields
            inner["type"] = type
            let body = try JSONSerialization.data(withJSONObject: inner, options: [.sortedKeys, .withoutEscapingSlashes])
            let sealed = try Drop.seal(body)
            let r = try await cfg.relay.reserveDrop(bytes: sealed.bucket)
            try await cfg.relay.upload(r, bytes: sealed.bytes)
            allDrops.append(r.dropId)
            (plaintext, _) = try DeviceSigned.wrap(keys: cfg.keys, device: link.deviceId, dir: "up", type: "big",
                                                   fields: ["drop": sealed.reference(dropId: r.dropId)])
        }
        let env = try Envelope.seal(kind: Envelope.device, to: link.deviceId, boxKey: desk.box, plaintext: plaintext)
        do {
            _ = try await cfg.relay.send(enc: env.enc, ct: env.ct, drops: allDrops, idempotencyKey: Self.idem(key))
        } catch let e as RelayError where e.code == "idempotency_key_reused" {
            // An earlier try of this same payload got through and its answer was lost: it's there.
        }
        lastTraffic = Date()
    }

    static func idem(_ key: String) -> String {
        let safe = key.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" ? Character($0) : "_" }
        let s = String(safe)
        return s.count >= 16 ? String(s.prefix(64)) : s + String(repeating: "_", count: 16 - s.count)
    }

    static func short(_ s: String) -> String {
        Data(SHA256.hash(data: Data(s.utf8))).prefix(8).hex
    }

    // MARK: housekeeping

    /// Every id seen in the window a down payload is accepted in, so a replay inside it is refused; past the most kept, the
    /// oldest go and anything older than what's kept is refused too (Security MC-L3).
    private func pruneSeen() {
        let cutoff = Date().addingTimeInterval(-(Self.downTtl + Self.skew))
        state.seen = state.seen.filter { $0.value > cutoff }
        if state.seen.count > Self.maxSeen {
            let kept = state.seen.sorted { $0.value > $1.value }.prefix(Self.maxSeen)
            state.seen = Dictionary(uniqueKeysWithValues: kept.map { ($0.key, $0.value) })
            state.seenFloor = kept.last?.value
        }
    }

    private func pruneSends() {
        let cutoff = Date().addingTimeInterval(-(Self.downTtl + Self.skew))
        state.sends = state.sends.filter { $0.value.at > cutoff }
    }

    private func save() { cfg.store.save(state) }

    /// Forgets the pairing on this Mac: the keys, the state.
    private func wipe() {
        cfg.keyStore.delete()
        cfg.store.delete()
        state = BridgeState()
        db = nil
        publish()
    }

    /// The member's "Disconnect this Mac": the platform forgets the device, then this Mac forgets everything.
    public func disconnect() async {
        if state.link != nil { try? await cfg.relay.unpair() }
        wipe()
        phase = .unpaired
        publish()
    }
}
