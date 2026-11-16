import AppKit
import ConnectorCore
import ConnectorUI
import SwiftUI

// Renders each of the window's screens to a PNG in light and dark, from made-up state (no bridge, no keychain, no
// Messages), for the brand review and the docs:  connector-shots <out-dir>

@MainActor
func render(_ name: String, _ model: AppModel, to dir: URL) {
    for (scheme, label) in [(ColorScheme.light, "light"), (.dark, "dark")] {
        let view = MainWindow().environmentObject(model).environment(\.colorScheme, scheme)
        let r = ImageRenderer(content: view)
        r.scale = 2
        guard let cg = r.cgImage else { print("failed \(name)"); continue }
        let rep = NSBitmapImageRep(cgImage: cg)
        let url = dir.appendingPathComponent("\(name)-\(label).png")
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        print(url.lastPathComponent)
    }
}

@MainActor
func run() {
    let dir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "shots", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    Shots.assets = URL(fileURLWithPath: CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "Resources/brand", isDirectory: true)
    Shots.version = "1.0.0"
    var ok = Bridge.Health()
    ok.fullDisk = true
    ok.automation = true
    var noDisk = Bridge.Health()
    noDisk.automation = nil
    var halfway = Bridge.Health()
    halfway.fullDisk = true
    halfway.automation = nil
    render("01-welcome", AppModel(preview: .unpaired), to: dir)
    render("02-code", AppModel(preview: .pairing(code: "BCDF-GHJK", expiresAt: Date().addingTimeInterval(540))), to: dir)
    render("03-code-expired", AppModel(preview: .pairing(code: "BCDF-GHJK", expiresAt: Date().addingTimeInterval(-5))), to: dir)
    render("03b-confirm", AppModel(preview: .confirm(desk: "Personal", claimedBy: "a•••@example.com", check: "4071 2958 3316")), to: dir)
    render("04-permissions", AppModel(preview: .connected(desk: "Personal"), health: noDisk), to: dir)
    render("05-permissions-half", AppModel(preview: .connected(desk: "Personal"), health: halfway), to: dir)
    render("06-done", AppModel(preview: .connected(desk: "Personal"), health: ok, showDone: true), to: dir)
    let settings = AppModel(preview: .connected(desk: "Personal"), health: ok)
    settings.automationOK = true
    render("07-settings", settings, to: dir)
    render("08-disconnected", AppModel(preview: .disconnected), to: dir)
}

MainActor.assumeIsolated { run() }
