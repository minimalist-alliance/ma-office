import CryptoKit
import Foundation
import Testing
@testable import ConnectorCore
@testable import ConnectorFixtures

/// Messages' database, read from synthetic fixtures only.
struct MessagesTests {
    func temp() -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("mac-connector-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    @Test func typedStreamReadsApplesArchives() {
        for text in ["Hi", String(repeating: "é", count: 200), String(repeating: "word ", count: 20_000), "Emoji are fine 🙂"] {
            #expect(TypedStream.text(FixtureDB.attributedBody(text)) == text)
        }
        #expect(TypedStream.text(Data("streamtyped garbage".utf8)) == nil)
        #expect(TypedStream.text(Data(count: 100)) == nil)
    }

    @Test func mapsEveryKindOfMessage() throws {
        let home = temp()
        let f = try FixtureDB(home: home)
        let b = try f.basic()
        let db = try ChatDB(path: f.path)
        let rows = try db.messages(after: b.old, limit: 100)
        var mapped: [[String: Any]] = []
        for r in rows {
            let people = try db.participants(chatRowId: r["chat_rowid"] as! Int64)
            let files = try db.attachments(messageRowId: r["rowid"] as! Int64)
            if let m = MessageMapper.map(r, participants: people, files: files) { mapped.append(m.fields) }
        }
        #expect(mapped.count == 14)
        #expect(mapped[0]["text"] as? String == "Lunch at noon?")
        #expect(mapped[0]["sender"] as? String == "+17205550142")
        #expect(mapped[1]["fromMe"] as? Bool == true)
        #expect(mapped[1]["sender"] == nil)
        #expect(mapped[2]["text"] as? String == "Only in the archive")
        #expect((mapped[3]["chat"] as? [String: Any])?["guid"] as? String == "SMS;-;+17205550199")
        #expect(mapped[4]["text"] == nil)
        #expect((mapped[5]["reaction"] as? [String: Any])?["type"] as? String == "love")
        #expect(((mapped[5]["reaction"] as? [String: Any])?["target"] as? String)?.hasPrefix("p:0/") == true)
        #expect((mapped[6]["event"] as? [String: Any])?["title"] as? String == "Climbing Sundays")
        let group = mapped[7]["chat"] as! [String: Any]
        #expect(group["group"] as? Bool == true)
        #expect(group["name"] as? String == "Climbing")
        #expect((group["participants"] as! [String]).count == 2)
        #expect(mapped[12]["failed"] as? Bool == true)
        let date = mapped[0]["date"] as! Int64
        #expect(abs(Double(date) / 1000 - Date().addingTimeInterval(-86_400).timeIntervalSince1970) < 120)
    }

    @Test func attachmentsOnlyFromMessagesFolder() throws {
        let home = temp()
        let f = try FixtureDB(home: home)
        let b = try f.basic()
        let db = try ChatDB(path: f.path)
        let reader = AttachmentReader(root: f.attachmentsRoot)
        var outcomes: [String] = []
        for r in try db.messages(after: b.old, limit: 100) {
            for a in try db.attachments(messageRowId: r["rowid"] as! Int64) {
                switch reader.read(a, home: home) {
                case .bytes(let d): outcomes.append("bytes \(d.count > 0)")
                case .tooLarge: outcomes.append("too large")
                case .unreadable: outcomes.append("unreadable")
                }
            }
        }
        #expect(outcomes == ["bytes true", "unreadable", "too large"])
        // A path outside the folder, written into the database, is refused before anything opens.
        let outside = ChatDB.Attachment(guid: "x", path: "~/../../etc/hosts", mime: nil, name: nil, bytes: 10)
        if case .unreadable = reader.read(outside, home: home) {} else { Issue.record("read outside the folder") }
    }

    @Test func editsAndUnsends() throws {
        let home = temp()
        let f = try FixtureDB(home: home)
        let b = try f.basic()
        let db = try ChatDB(path: f.path)
        let mark = ChatDB.appleDate(Int64(Date().timeIntervalSince1970 * 1000)) - 1
        try f.edit(b.editable, text: "See you at 7")
        try f.retract(b.unsendable)
        let rows = try db.changes(since: mark, fromRowid: b.old, throughRowid: b.lastRow, limit: 50)
        let mapped = rows.compactMap { MessageMapper.map($0, participants: [], files: [])?.fields }
        #expect(mapped.count == 2)
        #expect(mapped[0]["text"] as? String == "See you at 7")
        #expect(mapped[0]["edited"] != nil)
        #expect(mapped[1]["retracted"] != nil)
    }

    @Test func theReaderNeverWrites() throws {
        let home = temp()
        let f = try FixtureDB(home: home)
        _ = try f.basic()
        let r = try SQLiteReader(path: f.path)
        #expect(throws: (any Error).self) { _ = try r.query("DELETE FROM message") }
        #expect(try ChatDB(path: f.path).maxRowId() > 0)
    }
}

/// The whole bridge against the in-memory platform and desk.
struct BridgeTests {
    final class Rig {
        let home: URL
        let fixture: FixtureDB
        let basic: FixtureDB.Basic
        let platform = FakePlatform()
        let sender: FakeSender
        let keys = DeviceKeys.generate()
        let keyStore: FileKeyStore
        let bridge: Bridge

        init(permissions: FakePermissions = FakePermissions()) throws {
            home = FileManager.default.temporaryDirectory.appendingPathComponent("mac-connector-\(UUID().uuidString)", isDirectory: true)
            fixture = try FixtureDB(home: home)
            basic = try fixture.basic()
            sender = FakeSender(fixture: fixture)
            keyStore = FileKeyStore(url: home.appendingPathComponent("keys"))
            try keyStore.save(keys)
            var cfg = Bridge.Config(relay: RelayClient(base: URL(string: "https://api.test")!, keys: keys, http: platform), keys: keys,
                                    keyStore: keyStore, store: StateStore(directory: home.appendingPathComponent("state")), chatDB: fixture.path,
                                    attachments: AttachmentReader(root: fixture.attachmentsRoot), home: home, sender: sender,
                                    permissions: permissions, appVersion: "1.0.0", osVersion: "15.7", deviceName: "Mac")
            cfg.sentWait = 1
            bridge = Bridge(cfg)
        }

        func pair(confirm: Bool = true) async throws {
            try await bridge.startPairing()
            #expect(try await bridge.checkPairing() == false)
            platform.claim()
            #expect(try await bridge.checkPairing() == true)
            if confirm { await bridge.confirm() }
        }

        func ticks(_ n: Int) async {
            for _ in 0..<n {
                await bridge.poke()
                _ = await bridge.tick()
            }
        }
    }

    @Test func pairsThenCarriesThirtyDaysWithFilesAndBigPayloads() async throws {
        let rig = try Rig()
        try await rig.pair()
        #expect(await rig.bridge.phase == .connected(desk: "Personal"))
        // Nothing goes up before the desk says hello.
        await rig.ticks(2)
        let before = try rig.platform.takeUp()
        #expect(before.filter { $0.type == "page" }.isEmpty)
        #expect(before.contains { $0.type == "status" })
        try rig.platform.sendDown("hello", ["account": "acct-1", "desk": ["name": "Personal"], "backfillDays": 30])
        await rig.ticks(4)
        let up = try rig.platform.takeUp()
        let pages = up.filter { $0.type == "page" }
        #expect(!pages.isEmpty)
        let messages = pages.flatMap { $0.fields["messages"] as! [[String: Any]] }
        // Everything from the last 30 days, not the 40-day-old one.
        #expect(messages.count == 14)
        #expect(!messages.contains { $0["text"] as? String == "From long ago" })
        #expect((pages.first!.fields["after"] as! Int64) == rig.basic.old)
        #expect((pages.last!.fields["through"] as! Int64) == rig.basic.lastRow)
        // The photo came through a drop and opens to the same bytes; the link and the 25 MiB file stayed on the Mac.
        let files = messages.flatMap { $0["files"] as? [[String: Any]] ?? [] }
        #expect(files.count == 3)
        let photo = files.first { $0["name"] as? String == "IMG_0001.png" }!
        #expect(try rig.platform.file(photo["drop"] as! [String: Any]) == FixtureDB.png())
        #expect(files.first { $0["name"] as? String == "secret.txt" }!["drop"] is NSNull)
        #expect(files.first { $0["name"] as? String == "movie.mov" }!["drop"] is NSNull)
        // The long text (about 20 KB) made the page too big for an envelope, so it went whole through a drop.
        #expect(messages.contains { ($0["text"] as? String)?.count ?? 0 > 19_000 })
        // New messages after that.
        let m = try rig.fixture.message(chat: rig.basic.rowanChat, handle: rig.basic.rowan, text: "One more")
        await rig.ticks(2)
        let next = try rig.platform.takeUp().filter { $0.type == "page" }
        #expect(next.count == 1)
        #expect((next[0].fields["after"] as! Int64) == rig.basic.lastRow)
        #expect((next[0].fields["through"] as! Int64) == m.rowid)
    }

    @Test func sendsOnceAnswersWithTheGuidAndFindsAnEarlierTry() async throws {
        let rig = try Rig()
        try await rig.pair()
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 0])
        await rig.ticks(2)
        _ = try rig.platform.takeUp()
        let send: [String: Any] = ["outboundId": "41", "messageId": "m1", "medium": "imessage", "chatGuid": "iMessage;-;+17205550142",
                                   "handles": ["+17205550142"], "text": "On my way", "attempt": 1, "maybeSentBefore": false]
        try rig.platform.sendDown("send", send)
        await rig.ticks(2)
        var up = try rig.platform.takeUp()
        let sent = up.first { $0.type == "sent" }!
        #expect(sent.fields["result"] as? String == "sent")
        #expect((sent.fields["guid"] as? String)?.isEmpty == false)
        #expect(rig.sender.sent.count == 1)
        // The `sent` answer goes before the page that holds the same message (the desk records the guid first).
        let order = up.map(\.type)
        if let s = order.firstIndex(of: "sent"), let p = order.firstIndex(of: "page") { #expect(s < p) }
        // The same row again (a lost ack): the same answer, nothing sent twice.
        try rig.platform.sendDown("send", send)
        await rig.ticks(2)
        up = try rig.platform.takeUp()
        #expect(up.first { $0.type == "sent" }?.fields["guid"] as? String == sent.fields["guid"] as? String)
        #expect(rig.sender.sent.count == 1)
        // A retry that may have gone, as a new row: found in Messages, not sent again.
        var retry = send
        retry["outboundId"] = "42"
        retry["maybeSentBefore"] = true
        try rig.platform.sendDown("send", retry)
        await rig.ticks(2)
        up = try rig.platform.takeUp()
        #expect(up.first { $0.type == "sent" }?.fields["guid"] as? String == sent.fields["guid"] as? String)
        #expect(rig.sender.sent.count == 1)
    }

    @Test func refusesForgedStaleAndMalformedSends() async throws {
        let rig = try Rig()
        try await rig.pair()
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 0])
        await rig.ticks(2)
        _ = try rig.platform.takeUp()
        // Signed by someone other than the desk.
        let stranger = DeviceKeys.generate()
        let (pt, _) = try DeviceSigned.wrap(keys: stranger, device: rig.platform.deviceId, dir: "down", type: "send",
                                            fields: ["outboundId": "9", "chatGuid": "iMessage;-;+17205550142", "text": "x", "medium": "imessage", "handles": [String]()])
        let e = try Envelope.seal(kind: "device", to: rig.platform.deviceId, boxKey: rig.platform.macBox, plaintext: pt)
        rig.platform.down.append(.init(id: Ulid.make(), to: rig.platform.deviceId, enc: e.enc, ct: e.ct, drops: []))
        // A month and a half old.
        try rig.platform.sendDown("send", ["outboundId": "10", "chatGuid": "iMessage;-;+17205550142", "text": "x", "medium": "imessage",
                                           "handles": [String]()], at: Date().addingTimeInterval(-45 * 86_400))
        // A chat guid with script in it.
        try rig.platform.sendDown("send", ["outboundId": "11", "chatGuid": "\" & do shell script \"id", "text": "x", "medium": "imessage",
                                           "handles": [String]()])
        await rig.ticks(3)
        #expect(rig.sender.sent.isEmpty)
        let answers = try rig.platform.takeUp().filter { $0.type == "sent" }
        #expect(answers.count == 1)
        #expect(answers[0].fields["result"] as? String == "failed")
        #expect(rig.platform.down.isEmpty)
    }

    @Test func permissionAndChatFailures() async throws {
        let rig = try Rig()
        try await rig.pair()
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 0])
        await rig.ticks(2)
        _ = try rig.platform.takeUp()
        rig.sender.fail = .permission
        try rig.platform.sendDown("send", ["outboundId": "1", "chatGuid": "iMessage;-;+17205550142", "text": "Hi", "medium": "imessage",
                                           "handles": ["+17205550142"]])
        await rig.ticks(2)
        var a = try rig.platform.takeUp().first { $0.type == "sent" }!
        #expect(a.fields["result"] as? String == "retry")
        #expect(a.fields["error"] as? String == "permission")
        #expect(a.fields["unclear"] as? Bool == false)
        rig.sender.fail = .chat
        try rig.platform.sendDown("send", ["outboundId": "2", "chatGuid": "iMessage;-;+17205550111", "text": "Hi", "medium": "imessage",
                                           "handles": ["+17205550111"]])
        await rig.ticks(2)
        a = try rig.platform.takeUp().first { $0.type == "sent" }!
        #expect(a.fields["result"] as? String == "failed")
        #expect(a.fields["error"] as? String == "chat")
    }

    @Test func editsUnsendsResumeAndANewEpoch() async throws {
        let rig = try Rig()
        try await rig.pair()
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 30])
        await rig.ticks(4)
        let first = try rig.platform.takeUp().filter { $0.type == "page" }
        let epoch = first[0].fields["epoch"] as! String
        try rig.fixture.edit(rig.basic.editable, text: "See you at 7")
        try rig.fixture.retract(rig.basic.unsendable)
        await rig.bridge.forceChangeScan()
        await rig.ticks(1)
        let changes = try rig.platform.takeUp().filter { $0.type == "changes" }
        #expect(changes.count == 1)
        #expect((changes[0].fields["messages"] as! [[String: Any]]).count == 2)
        // The desk lost a page: it asks to go again from where it has everything.
        try rig.platform.sendDown("resume", ["epoch": epoch, "after": rig.basic.firstNew])
        await rig.ticks(4)
        let again = try rig.platform.takeUp().filter { $0.type == "page" }
        #expect((again.first!.fields["after"] as! Int64) == rig.basic.firstNew)
        #expect(again.first!.fields["epoch"] as? String == epoch)
        // A hello again (the desk started over): a new epoch from the window's start.
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 30])
        await rig.ticks(4)
        let fresh = try rig.platform.takeUp().filter { $0.type == "page" }
        #expect(fresh.first!.fields["epoch"] as? String != epoch)
        #expect((fresh.first!.fields["after"] as! Int64) == rig.basic.old)
    }

    @Test func revokedFromTheOfficeForgetsEverything() async throws {
        let rig = try Rig()
        try await rig.pair()
        rig.platform.revoked = true
        await rig.ticks(1)
        #expect(await rig.bridge.phase == .disconnected)
        #expect(rig.keyStore.load() == nil)
        #expect(await rig.bridge.snapshot == BridgeState())
    }

    @Test func byeFromTheDeskAndTheMacsOwnDisconnect() async throws {
        let rig = try Rig()
        try await rig.pair()
        try rig.platform.sendDown("bye", [:])
        await rig.ticks(1)
        #expect(await rig.bridge.phase == .disconnected)
        let rig2 = try Rig()
        try await rig2.pair()
        await rig2.bridge.disconnect()
        #expect(rig2.platform.revoked)
        #expect(rig2.keyStore.load() == nil)
    }

    @Test func noFullDiskAccessCarriesNothing() async throws {
        let rig = try Rig(permissions: FakePermissions(fullDisk: false, automation: nil))
        try await rig.pair()
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 30])
        await rig.ticks(3)
        let up = try rig.platform.takeUp()
        #expect(up.filter { $0.type == "page" }.isEmpty)
        let status = up.first { $0.type == "status" }!
        #expect(status.fields["fullDisk"] as? Bool == false)
    }

    @Test func nothingFlowsUntilTheMemberConfirmsWhoClaimedTheCode() async throws {
        let rig = try Rig()
        try await rig.pair(confirm: false)
        guard case .confirm(let desk, let who, let check) = await rig.bridge.phase else { Issue.record("no confirm step"); return }
        #expect(desk == "Personal")
        #expect(who == "a•••@example.com")
        // The number is the desk's identity and this Mac's, as deskd computes it.
        let deskId = B64.decode(rig.platform.desk.identityKey, count: 32)!
        #expect(check == PairCheck.number(desk: deskId, device: rig.keys.identity.publicKey.rawRepresentation))
        #expect(check.count == 14)
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 30])
        try rig.platform.sendDown("send", ["outboundId": "1", "chatGuid": "iMessage;-;+17205550142", "text": "Hi", "medium": "imessage",
                                           "handles": ["+17205550142"]])
        await rig.ticks(3)
        #expect(try rig.platform.takeUp().isEmpty)
        #expect(rig.sender.sent.isEmpty)
        #expect(rig.platform.down.count == 2)
        // Connect: the hello and the send are read, and pages flow.
        await rig.bridge.confirm()
        await rig.ticks(4)
        let up = try rig.platform.takeUp()
        #expect(up.contains { $0.type == "page" })
        #expect(rig.sender.sent.count == 1)
    }

    @Test func thatsNotMeUnpairsAtOnce() async throws {
        let rig = try Rig()
        try await rig.pair(confirm: false)
        await rig.bridge.disconnect()
        #expect(rig.platform.revoked)
        #expect(await rig.bridge.phase == .unpaired)
    }

    @Test func aHugeTextIsClippedByUTF16AndPagesStayUnderTheirBudget() async throws {
        let rig = try Rig()
        try await rig.pair()
        try rig.platform.sendDown("hello", ["account": "acct-1", "backfillDays": 0])
        await rig.ticks(2)
        _ = try rig.platform.takeUp()
        // Flags: 4 UTF-16 units each; 20,000 of them would be 80,000 units.
        let flags = String(repeating: "🇺🇸", count: 20_000)
        try rig.fixture.message(chat: rig.basic.rowanChat, handle: rig.basic.rowan, text: flags)
        // Then 80 texts of 60 KB each (3 bytes a unit): over the 4 MiB budget, so more than one page, under 100 messages.
        let euros = String(repeating: "€", count: 20_000)
        for _ in 0..<80 { try rig.fixture.message(chat: rig.basic.rowanChat, handle: rig.basic.rowan, text: euros) }
        await rig.ticks(12)
        let pages = try rig.platform.takeUp().filter { $0.type == "page" }
        let all = pages.flatMap { $0.fields["messages"] as! [[String: Any]] }
        #expect(all.count == 81)
        for m in all { #expect(((m["text"] as? String) ?? "").utf16.count <= 20_000) }
        for p in pages {
            let size = try JSONSerialization.data(withJSONObject: p.fields).count
            #expect(size < 4_400_000)
        }
        #expect(pages.count >= 2)
    }

    @Test func aWrongClockIsCorrectedFromTheServer() async throws {
        let rig = try Rig()
        rig.platform.badDateOnce = true
        try await rig.bridge.startPairing()
        if case .pairing(let code, _) = await rig.bridge.phase { #expect(code == "BCDF-GHJK") } else { Issue.record("no code") }
    }
}

extension Bridge {
    func forceChangeScan() { resetChangeScan() }
}
