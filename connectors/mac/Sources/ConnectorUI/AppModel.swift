import AppKit
import ConnectorCore
import Foundation
import SwiftUI

/// The app's one model: it builds the bridge with this Mac's real places (Messages' database, the login keychain), runs its
/// loop, and turns its phase into what the menu and the window show.
@MainActor
public final class AppModel: ObservableObject {
    @Published public var phase: BridgePhase = .unpaired
    @Published public var health = Bridge.Health()
    @Published public var codeError = false
    @Published public var copied = false
    @Published public var openAtLogin = LoginItem.isOn
    @Published public var update: UpdateManifest?
    @Published public var updateNote: String?
    @Published public var backfillDays = 30
    @Published public var paused = false
    @Published public var showDone = false

    let keyStore = KeychainKeyStore()
    let updater = Updater.fromBundle()
    private(set) var bridge: Bridge?
    private var loop: Task<Void, Never>?
    private(set) var fingerprint = ""

    static var relayURL: URL? {
        let s = Bundle.main.object(forInfoDictionaryKey: "MARelayURL") as? String
        return s.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
    }

    /// Made-up state for the screenshots: no bridge, no keychain, no Messages.
    public init(preview phase: BridgePhase, health: Bridge.Health = Bridge.Health(), showDone: Bool = false) {
        self.phase = phase
        self.health = health
        self.showDone = showDone
        self.fingerprint = "3f2a-91c0"
        self.pairCheck = "4071 2958 3316"
        self.preview = true
    }

    private var preview = false

    public init() {
        build()
        if LoginItem.isOn == false, UserDefaults.standard.object(forKey: "loginItemSet") == nil {
            openAtLogin = LoginItem.set(true)
            UserDefaults.standard.set(true, forKey: "loginItemSet")
        }
        Task { await checkForUpdates(quiet: true) }
    }

    /// The bridge, with this Mac's keys (made the first time and kept in the login keychain).
    private func build() {
        loop?.cancel()
        guard !preview else { return }
        guard let relay = Self.relayURL else { return }
        let keys: DeviceKeys
        if let k = keyStore.load() {
            keys = k
        } else {
            keys = DeviceKeys.generate()
            try? keyStore.save(keys)
        }
        fingerprint = Fingerprint.short(keys.fingerprint)
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let info = Bundle.main.infoDictionary ?? [:]
        let b = Bridge(.init(relay: RelayClient(base: relay, keys: keys), keys: keys, keyStore: keyStore,
                             store: StateStore(directory: AppPaths.support), chatDB: AppPaths.chatDB,
                             attachments: AttachmentReader(root: AppPaths.attachments), home: AppPaths.home,
                             sender: AppleScriptSender(), permissions: SystemPermissions(chatDB: AppPaths.chatDB),
                             appVersion: info["CFBundleShortVersionString"] as? String ?? "0",
                             osVersion: "\(os.majorVersion).\(os.minorVersion)", deviceName: "Mac"))
        bridge = b
        Task {
            await b.observe { [weak self] phase, health in
                Task { @MainActor in self?.apply(phase, health) }
            }
            let s = await b.snapshot
            self.backfillDays = s.backfillDays
            self.paused = s.paused
        }
        loop = Task.detached { await b.run() }
    }

    private func apply(_ p: BridgePhase, _ h: Bridge.Health) {
        if case .connected = p, case .pairing = phase { showDone = true }
        if case .confirm(_, _, let check) = p { pairCheck = check }
        if case .connected = p, pairCheck.isEmpty, let b = bridge {
            Task { let c = await b.pairCheck; await MainActor.run { self.pairCheck = c ?? "" } }
        }
        phase = p
        health = h
        if h.automation == true, !automationOK {
            automationOK = true
            UserDefaults.standard.set(true, forKey: "automationOK")
        }
    }

    /// Once macOS let this app send through Messages; the check reads nothing while Messages is closed, so this remembers.
    @Published public var automationOK = UserDefaults.standard.bool(forKey: "automationOK")

    public var needsPermissions: Bool {
        !health.fullDisk || health.automation == false || (health.automation == nil && !automationOK)
    }

    // MARK: what the member does

    public func getCode() {
        codeError = false
        guard !preview else { return }
        Task {
            do { try await bridge?.startPairing() } catch { codeError = true }
        }
    }

    public func copyCode(_ code: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        copied = true
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
    }

    public func checkAgain() {
        Task { await bridge?.poke() }
    }

    public func openFullDiskSettings() { SystemPermissions.openSettings(fullDisk: true) }

    public func askAutomation() {
        // Asking needs Messages running; macOS shows its own prompt once.
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/System/Applications/Messages.app"), configuration: {
            let c = NSWorkspace.OpenConfiguration()
            c.activates = false
            return c
        }()) { _, _ in
            DispatchQueue.global().async {
                Thread.sleep(forTimeInterval: 1.5)
                let answer = SystemPermissions(chatDB: AppPaths.chatDB).automation(ask: true)
                Task { @MainActor in
                    if answer == false { SystemPermissions.openSettings(fullDisk: false) }
                    self.checkAgain()
                }
            }
        }
    }

    /// The member's Connect after checking who used the code.
    public func confirm() {
        showDone = true
        Task { await bridge?.confirm() }
    }

    /// "That's not me": this Mac unpairs at once and forgets the desk.
    public func reject() {
        Task {
            await bridge?.disconnect()
            build()
        }
    }

    /// The pairing's check number, shown in settings too.
    @Published public var pairCheck = ""

    public func setPaused(_ p: Bool) {
        paused = p
        Task { await bridge?.setPaused(p) }
    }

    public func setOpenAtLogin(_ on: Bool) {
        if LoginItem.set(on) { openAtLogin = on } else { openAtLogin = LoginItem.isOn }
    }

    public func disconnect() {
        Task {
            await bridge?.disconnect()
            build()
        }
    }

    public func reconnect() {
        build()
        getCode()
    }

    public func removeEverything() {
        Task {
            loop?.cancel()
            await Uninstaller.removeEverything(bridge: bridge, keyStore: keyStore)
        }
    }

    public func checkForUpdates(quiet: Bool = false) async {
        guard updater.enabled else {
            if !quiet { updateNote = Words.updatesOff }
            return
        }
        do {
            update = try await updater.check()
            if update == nil, !quiet { updateNote = Words.upToDateVersion }
        } catch {
            if !quiet { updateNote = Words.updateFailed }
        }
    }

    public func installUpdate() {
        guard let m = update else { return }
        Task {
            do {
                let app = try await updater.fetch(m)
                try Updater.install(app)
                NSApp.terminate(nil)
            } catch {
                updateNote = Words.updateFailed
            }
        }
    }

    // MARK: what the menu says

    public var deskName: String {
        if case .connected(let d) = phase { return d }
        if case .confirm(let d, _, _) = phase { return d }
        return ""
    }

    public var needsYou: Bool {
        guard case .connected = phase else { return false }
        return needsPermissions
    }

    public var statusLine: String {
        switch phase {
        case .unpaired: return Words.notConnected
        case .pairing: return Words.waiting
        case .confirm: return Words.confirmTitle
        case .disconnected: return Words.disconnectedLine
        case .connected:
            if !health.fullDisk { return Words.needsFullDisk }
            if health.automation == false { return Words.needsAutomation }
            if paused { return Words.paused }
            if let e = health.lastError, e != "messages" { return e == "network" ? Words.cantReach : Words.cantReach }
            return health.behind > 0 ? Words.bringingIn(health.behind) : Words.upToDate
        }
    }
}
