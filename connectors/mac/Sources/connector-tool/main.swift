import ConnectorCore
import CryptoKit
import Foundation

// Release-time tools. Nothing here ships in the app.
//
//   connector-tool update-key <private-key-file>
//       Makes MA's update signing key (Ed25519). Writes the private seed (0600) and prints the public key for
//       MAUpdatePublicKey. Keep the private file off every repo.
//   connector-tool sign-update <private-key-file> <zip> <version> <build> <download-url> [min-os]
//       Prints the signed feed (appcast.json) for that zip.
//   connector-tool verify-update <feed.json> <public-key>
//       Checks a feed's signature and prints its manifest.

func fail(_ s: String) -> Never {
    FileHandle.standardError.write(Data((s + "\n").utf8))
    exit(1)
}

let a = CommandLine.arguments
guard a.count >= 2 else { fail("usage: connector-tool update-key | sign-update | verify-update") }

switch a[1] {
case "update-key":
    guard a.count == 3 else { fail("usage: connector-tool update-key <private-key-file>") }
    let url = URL(fileURLWithPath: a[2])
    guard !FileManager.default.fileExists(atPath: url.path) else { fail("refusing to overwrite \(url.path)") }
    let k = Curve25519.Signing.PrivateKey()
    FileManager.default.createFile(atPath: url.path, contents: k.rawRepresentation, attributes: [.posixPermissions: 0o600])
    print(B64.encode(k.publicKey.rawRepresentation))
case "sign-update":
    guard a.count >= 7 else { fail("usage: connector-tool sign-update <key> <zip> <version> <build> <url> [min-os]") }
    guard let seed = FileManager.default.contents(atPath: a[2]), let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else {
        fail("can't read the key")
    }
    guard let zip = FileManager.default.contents(atPath: a[3]) else { fail("can't read the zip") }
    guard let build = Int(a[5]), a[6].hasPrefix("https://") else { fail("build must be a number and the url https") }
    let m = UpdateManifest(v: 1, app: Updater.bundleId, version: a[4], build: build, minOS: a.count > 7 ? a[7] : "14.0", url: a[6],
                           sha256: Data(SHA256.hash(data: zip)).map { String(format: "%02x", $0) }.joined(), bytes: zip.count, notes: nil)
    let signed = try Updater.sign(m, key: key)
    print(String(data: signed, encoding: .utf8)!)
case "verify-update":
    guard a.count == 4, let feed = FileManager.default.contents(atPath: a[2]), let pub = B64.decode(a[3], count: 32) else {
        fail("usage: connector-tool verify-update <feed.json> <public-key>")
    }
    do {
        let m = try Updater.verify(feed, publicKey: pub)
        print("ok \(m.version) build \(m.build) \(m.url)")
    } catch {
        fail("not signed by that key: \(error)")
    }
default:
    fail("unknown command")
}
