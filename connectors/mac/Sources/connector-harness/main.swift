import ConnectorCore
import ConnectorFixtures
import Foundation

// The connector's bridge, run against a synthetic Messages database (FixtureDB) and a fake Messages (FakeSender), talking
// to a relay: the test kit's fake relay (loopback http, through an SSH tunnel to this Mac) or staging. It never opens a real
// Messages database and never sends a real message.
//
//   connector-harness <home> fixture                      make the basic scenario; prints its rows as JSON
//   connector-harness <home> add <chatGuid> <handle> <text>   one more incoming message
//   connector-harness <home> edit <rowid> <text> | unsend <rowid>
//   connector-harness <home> pair <relayURL>              print the code as JSON, wait until paired (up to 10 minutes)
//   connector-harness <home> run <relayURL> <seconds>     run the bridge
//   connector-harness <home> state | sent                 print the bridge's state, or what the fake Messages sent
//   connector-harness <home> unpair <relayURL>            the Mac's own "Disconnect"

func out(_ obj: Any) {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: connector-harness <home> <command> ...\n".utf8))
    exit(2)
}
let home = URL(fileURLWithPath: args[1], isDirectory: true)
let command = args[2]
let stateDir = home.appendingPathComponent("connector-state", isDirectory: true)
try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
let keyStore = FileKeyStore(url: stateDir.appendingPathComponent("keys"))
RelayClient.allowLoopback = true

func bridge(_ relay: String) throws -> (Bridge, FixtureDB) {
    guard let url = URL(string: relay) else { throw NSError(domain: "harness", code: 1) }
    let keys: DeviceKeys
    if let k = keyStore.load() { keys = k } else { keys = DeviceKeys.generate(); try keyStore.save(keys) }
    let fixture = try FixtureDB(home: home)
    var cfg = Bridge.Config(relay: RelayClient(base: url, keys: keys), keys: keys, keyStore: keyStore, store: StateStore(directory: stateDir),
                            chatDB: fixture.path, attachments: AttachmentReader(root: fixture.attachmentsRoot), home: home,
                            sender: FakeSender(fixture: fixture, log: stateDir.appendingPathComponent("sent.json")),
                            permissions: FakePermissions(), appVersion: "0.9.0-harness", osVersion: "15.7", deviceName: "Mac")
    cfg.sentWait = 3
    return (Bridge(cfg), fixture)
}

do {
    switch command {
    case "fixture":
        let f = try FixtureDB(home: home)
        let b = try f.basic()
        out(["old": b.old, "firstNew": b.firstNew, "lastRow": b.lastRow, "editable": b.editable, "unsendable": b.unsendable])
    case "add":
        let f = try FixtureDB(home: home)
        let chat: Int64
        if let row = try? f.chatRow(args[3]) {
            chat = row
        } else {
            chat = try f.chat(args[3], group: args[3].contains(";+;"), handles: [try f.handle(args[4])])
        }
        let m = try f.message(chat: chat, handle: try f.handle(args[4], service: args[3].hasPrefix("SMS") ? "SMS" : "iMessage"), text: args[5])
        out(["rowid": m.rowid, "guid": m.guid])
    case "edit":
        try FixtureDB(home: home).edit(Int64(args[3])!, text: args[4])
        out(["edited": args[3]])
    case "unsend":
        try FixtureDB(home: home).retract(Int64(args[3])!)
        out(["unsent": args[3]])
    case "pair":
        let (b, _) = try bridge(args[3])
        try await b.startPairing()
        if case .pairing(let code, let exp) = await b.phase { out(["userCode": code, "expiresAt": Time.rfc3339(exp)]) }
        let until = Date().addingTimeInterval(600)
        while Date() < until {
            if try await b.checkPairing() {
                // The member checks who claimed the code and the number, then presses Connect (the harness presses it).
                let s = await b.snapshot
                let check = await b.pairCheck ?? ""
                await b.confirm()
                out(["paired": s.link?.deviceId ?? "", "desk": s.link?.deskName ?? "", "check": check, "claimedBy": s.link?.claimedBy ?? ""])
                exit(0)
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        out(["error": "timeout"])
        exit(1)
    case "run":
        let (b, _) = try bridge(args[3])
        let until = Date().addingTimeInterval(Double(args[4]) ?? 30)
        while Date() < until {
            let wait = await b.tick()
            try await Task.sleep(nanoseconds: UInt64(min(wait, 0.5) * 1e9))
        }
        let s = await b.snapshot
        let h = await b.health
        out(["cursor": s.cursor ?? -1, "epoch": s.epoch ?? "", "started": s.started, "sends": s.sends.count, "lastError": h.lastError ?? "",
             "linked": s.link != nil])
    case "state":
        let s = StateStore(directory: stateDir).load()
        out(["cursor": s.cursor ?? -1, "startRow": s.startRow ?? -1, "started": s.started, "linked": s.link != nil,
             "deviceId": s.link?.deviceId ?? "", "account": s.link?.account ?? ""])
    case "sent":
        let d = (try? Data(contentsOf: stateDir.appendingPathComponent("sent.json"))) ?? Data("[]".utf8)
        print(String(data: d, encoding: .utf8) ?? "[]")
    case "unpair":
        let (b, _) = try bridge(args[3])
        await b.disconnect()
        out(["unpaired": true])
    default:
        FileHandle.standardError.write(Data("unknown command\n".utf8))
        exit(2)
    }
} catch {
    out(["error": String(describing: error)])
    exit(1)
}
