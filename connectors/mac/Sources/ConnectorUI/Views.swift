import AppKit
import ConnectorCore
import SwiftUI

/// The office's colours (ma-desk `web/src/theme/tokens.ts`, Light and Dark): cool blues and greys, calm, no warm tints.
enum Theme {
    static func accent(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0x7FA7DD) : Color(hex: 0x3D6FA8) }
    static func accentSubtle(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0x22344D) : Color(hex: 0xE8F0FF) }
    static func onAccent(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0x14171B) : .white }
    static func window(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0x26292E) : .white }
    static func sunken(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0x1F2226) : Color(hex: 0xF3F5F8) }
    static func primary(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0xECEDEF) : Color(hex: 0x2B2D31) }
    static func secondary(_ s: ColorScheme) -> Color { s == .dark ? Color(hex: 0xB7BBC2) : Color(hex: 0x5F6166) }
    static func hairline(_ s: ColorScheme) -> Color { s == .dark ? Color.white.opacity(0.08) : Color(red: 16 / 255, green: 24 / 255, blue: 40 / 255).opacity(0.10) }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

struct PrimaryButton: ButtonStyle {
    @Environment(\.colorScheme) var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .padding(.horizontal, 16).padding(.vertical, 7)
            .background(Theme.accent(scheme).opacity(configuration.isPressed ? 0.85 : 1), in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(Theme.onAccent(scheme))
    }
}

struct QuietButton: ButtonStyle {
    @Environment(\.colorScheme) var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Theme.accentSubtle(scheme).opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(Theme.primary(scheme))
    }
}

/// The window: one calm card per step.
public struct MainWindow: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme

    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(28)
        .frame(width: 460)
        .background(Theme.window(scheme))
    }

    @ViewBuilder var content: some View {
        switch model.phase {
        case .unpaired: WelcomeView()
        case .pairing(let code, let expires): CodeView(code: code, expiresAt: expires)
        case .confirm(let desk, let who, let check): ConfirmView(desk: desk, claimedBy: who, check: check)
        case .disconnected: DisconnectedView()
        case .connected:
            if model.showDone && !model.needsPermissions {
                DoneView()
            } else if model.needsPermissions {
                PermissionsView()
            } else {
                SettingsView()
            }
        }
    }
}

struct Heading: View {
    @Environment(\.colorScheme) var scheme
    let title: String
    let lead: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.primary(scheme))
            if let lead { Text(lead).font(.system(size: 13)).foregroundStyle(Theme.secondary(scheme)).fixedSize(horizontal: false, vertical: true) }
        }
    }
}

struct WelcomeView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Mark().frame(width: 44, height: 44)
            Heading(title: Words.welcomeTitle, lead: Words.welcomeLead)
            if model.codeError { Text(Words.codeFailed).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)) }
            HStack { Spacer(); Button(model.codeError ? Words.tryAgain : Words.getCode) { model.getCode() }.buttonStyle(PrimaryButton()) }
        }
    }
}

struct CodeView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme
    let code: String
    let expiresAt: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let expired = ctx.date >= expiresAt
            VStack(alignment: .leading, spacing: 20) {
                Heading(title: Words.codeTitle, lead: Words.codeSteps)
                HStack {
                    Spacer()
                    Text(code)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .tracking(4)
                        .foregroundStyle(expired ? Theme.secondary(scheme) : Theme.primary(scheme))
                        .textSelection(.enabled)
                        .accessibilityLabel(code.map(String.init).joined(separator: " "))
                    Spacer()
                }
                .padding(.vertical, 18)
                .background(Theme.sunken(scheme), in: RoundedRectangle(cornerRadius: 12))
                if expired {
                    HStack {
                        Text(Words.codeExpired).font(.system(size: 13)).foregroundStyle(Theme.secondary(scheme))
                        Spacer()
                        Button(Words.newCode) { model.getCode() }.buttonStyle(PrimaryButton())
                    }
                } else {
                    HStack(spacing: 10) {
                        if Shots.assets == nil { ProgressView().controlSize(.small) } else { Circle().stroke(Theme.secondary(scheme), lineWidth: 2).frame(width: 12, height: 12) }
                        Text(Words.codeWaiting).font(.system(size: 13)).foregroundStyle(Theme.secondary(scheme))
                        Spacer()
                        Button(model.copied ? Words.copied : Words.copyCode) { model.copyCode(code) }.buttonStyle(QuietButton())
                    }
                    Text(Words.codeLife).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme))
                }
            }
        }
    }
}

/// After an office used the code: the member checks whose it was, and the number their office shows, before anything flows.
struct ConfirmView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme
    let desk: String
    let claimedBy: String?
    let check: String

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Heading(title: Words.confirmTitle, lead: Words.confirmWho(claimedBy, desk))
            VStack(alignment: .leading, spacing: 6) {
                Text(Words.confirmCheckLabel).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme))
                Text(check).font(.system(size: 24, weight: .semibold, design: .monospaced)).tracking(2)
                    .foregroundStyle(Theme.primary(scheme)).textSelection(.enabled)
                Text(Words.confirmCheckLine).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)).fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.sunken(scheme), in: RoundedRectangle(cornerRadius: 12))
            HStack {
                Button(Words.confirmNo) { model.reject() }.buttonStyle(QuietButton())
                Spacer()
                Button(Words.confirmYes) { model.confirm() }.buttonStyle(PrimaryButton())
            }
        }
    }
}

struct PermissionRow: View {
    @Environment(\.colorScheme) var scheme
    let title: String
    let line: String
    let state: Bool?
    let stateNote: String?
    let action: String
    let run: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.primary(scheme))
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(state == true ? Theme.accent(scheme) : Theme.secondary(scheme).opacity(0.5)).frame(width: 7, height: 7)
                    Text(state == true ? Words.allowed : Words.notYet).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme))
                }
            }
            Text(line).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)).fixedSize(horizontal: false, vertical: true)
            if state != true {
                if let stateNote { Text(stateNote).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)).fixedSize(horizontal: false, vertical: true) }
                HStack { Spacer(); Button(action, action: run).buttonStyle(QuietButton()) }
            }
        }
        .padding(16)
        .background(Theme.sunken(scheme), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct PermissionsView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Heading(title: Words.permsTitle, lead: Words.permsLead)
            PermissionRow(title: Words.fullDiskTitle, line: Words.fullDiskLine, state: model.health.fullDisk, stateNote: Words.fullDiskSteps,
                          action: Words.openSettings) { model.openFullDiskSettings() }
            PermissionRow(title: Words.automationTitle, line: Words.automationLine, state: model.automationOK ? true : model.health.automation,
                          stateNote: nil, action: Words.allow) { model.askAutomation() }
            HStack {
                Button(Words.checkAgain) { model.checkAgain() }.buttonStyle(QuietButton())
                Spacer()
                if !model.needsPermissions {
                    Button(Words.continueLabel) { model.showDone = true }.buttonStyle(PrimaryButton())
                }
            }
        }
    }
}

struct DoneView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Mark().frame(width: 44, height: 44)
            Heading(title: Words.doneTitle(model.deskName), lead: Words.doneLine(model.backfillDays))
            Text(Words.smsHint).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)).fixedSize(horizontal: false, vertical: true)
            if Shots.assets == nil {
                Toggle(Words.openAtLogin, isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
                    .toggleStyle(.switch).tint(Theme.accent(scheme))
            } else {
                HStack { Text(Words.openAtLogin).font(.system(size: 13)).foregroundStyle(Theme.primary(scheme)); Spacer(); ShotSwitch(on: true) }
            }
            HStack { Spacer(); Button(Words.done) { model.showDone = false; NSApp.keyWindow?.close() }.buttonStyle(PrimaryButton()) }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.colorScheme) var scheme
    @State private var confirmDisconnect = false
    @State private var confirmRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Mark().frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Words.connected(model.deskName)).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.primary(scheme))
                    Text(model.statusLine).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme))
                }
            }
            VStack(spacing: 0) {
                row(Words.checkLabel, model.pairCheck)
                Divider().overlay(Theme.hairline(scheme))
                row(Words.keyLabel, model.fingerprint)
                Divider().overlay(Theme.hairline(scheme))
                row(Words.versionLabel, Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? Shots.version)
                Divider().overlay(Theme.hairline(scheme))
                HStack {
                    Text(Words.openAtLogin).font(.system(size: 13)).foregroundStyle(Theme.primary(scheme))
                    Spacer()
                    if Shots.assets == nil {
                        Toggle("", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) })).toggleStyle(.switch).labelsHidden().tint(Theme.accent(scheme))
                    } else {
                        ShotSwitch(on: true)
                    }
                }.padding(.vertical, 10)
                Divider().overlay(Theme.hairline(scheme))
                HStack {
                    Text(Words.updatesLabel).font(.system(size: 13)).foregroundStyle(Theme.primary(scheme))
                    Spacer()
                    if let u = model.update {
                        Text(Words.updateReady(u.version)).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme))
                        Button(Words.installUpdate) { model.installUpdate() }.buttonStyle(QuietButton())
                    } else {
                        if let n = model.updateNote { Text(n).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)) }
                        Button(Words.checkUpdates) { Task { await model.checkForUpdates() } }.buttonStyle(QuietButton())
                    }
                }.padding(.vertical, 10)
            }
            .padding(.horizontal, 14)
            .background(Theme.sunken(scheme), in: RoundedRectangle(cornerRadius: 12))
            Text(Words.smsHint).font(.system(size: 12)).foregroundStyle(Theme.secondary(scheme)).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(Words.disconnect) { confirmDisconnect = true }.buttonStyle(QuietButton())
                Spacer()
                Button(Words.remove) { confirmRemove = true }.buttonStyle(QuietButton())
            }
        }
        .confirmationDialog(Words.disconnectTitle, isPresented: $confirmDisconnect) {
            Button(Words.disconnectConfirm) { model.disconnect() }
            Button(Words.cancel, role: .cancel) {}
        } message: { Text(Words.disconnectBody) }
        .confirmationDialog(Words.removeTitle, isPresented: $confirmRemove) {
            Button(Words.removeConfirm) { model.removeEverything() }
            Button(Words.cancel, role: .cancel) {}
        } message: { Text(Words.removeBody + " " + Words.removeFullDisk) }
    }

    func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 13)).foregroundStyle(Theme.primary(scheme))
            Spacer()
            Text(value).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondary(scheme)).textSelection(.enabled)
        }.padding(.vertical, 10)
    }
}

struct DisconnectedView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Heading(title: Words.disconnectedTitle, lead: Words.disconnectedBody)
            HStack { Spacer(); Button(Words.getCode) { model.reconnect() }.buttonStyle(PrimaryButton()) }
        }
    }
}

/// MA's mark, from the brand kit's files as they are (Resources/mark-primary.png or mark-on-dark.png).
struct Mark: View {
    @Environment(\.colorScheme) var scheme
    var body: some View {
        let name = scheme == .dark ? "mark-on-dark" : "mark-primary"
        if let img = Bundle.main.image(forResource: name) ?? Shots.assets.flatMap({ NSImage(contentsOf: $0.appendingPathComponent(name + ".png")) }) {
            Image(nsImage: img).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
        } else {
            Color.clear
        }
    }
}

/// The menu.
public struct MenuContent: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) var openWindow

    public init() {}

    public var body: some View {
        Text(model.statusLine)
        if case .connected(let desk) = model.phase, !desk.isEmpty, model.statusLine != Words.connected(desk) {
            Text(Words.connected(desk))
        }
        Divider()
        Button(Words.openApp) { open() }
        if case .connected = model.phase {
            Button(Words.checkAgain) { model.checkAgain() }
            Button(model.paused ? Words.resume : Words.pause) { model.setPaused(!model.paused) }
        }
        Button(Words.checkUpdates) { Task { await model.checkForUpdates(); open() } }
        if case .connected = model.phase {
            Divider()
            Button(Words.disconnect) { open() }
        }
        Divider()
        Button(Words.quit) { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    func open() {
        openWindow(id: "main")
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// The screenshots tool's settings: AppKit's own controls (the spinner, the switch) don't draw off screen, so the shots
/// show drawn stand-ins of the same size; the app itself never sets these.
public enum Shots {
    nonisolated(unsafe) public static var assets: URL?
    nonisolated(unsafe) public static var version = ""
}

struct ShotSwitch: View {
    @Environment(\.colorScheme) var scheme
    let on: Bool
    var body: some View {
        Capsule().fill(on ? Theme.accent(scheme) : Theme.secondary(scheme).opacity(0.3)).frame(width: 32, height: 18)
            .overlay(Circle().fill(.white).frame(width: 16, height: 16).offset(x: on ? 7 : -7))
    }
}
