import AppKit
import ConnectorCore
import ConnectorUI
import SwiftUI

/// MA Connector: a menu-bar app (no Dock icon) with one small window for setup and settings.
@main
struct MAConnectorApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent().environmentObject(model)
        } label: {
            Image(nsImage: MenuIcon.image(attention: model.needsYou))
                .accessibilityLabel(Words.appName)
        }
        Window(Words.appName, id: "main") {
            MainWindow().environmentObject(model)
        }
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // The first run opens the window, so the member sees where to start.
        if UserDefaults.standard.object(forKey: "launched") == nil {
            UserDefaults.standard.set(true, forKey: "launched")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                if let w = NSApp.windows.first(where: { $0.identifier?.rawValue.contains("main") == true }) {
                    w.makeKeyAndOrderFront(nil)
                }
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// The menu-bar glyph: MA's mark as a template image (macOS tints it for the menu bar), with a small dot when the member
/// needs to do something. Never red: a dot in the menu bar's own colour.
enum MenuIcon {
    static func image(attention: Bool) -> NSImage {
        let base = Bundle.main.image(forResource: "MenuIcon") ?? NSImage(systemSymbolName: "message", accessibilityDescription: nil) ?? NSImage()
        // The mark at 16 pt high, its own width; room on the right for the dot.
        let markSize = NSSize(width: 26, height: 16)
        let size = NSSize(width: attention ? 32 : 26, height: 16)
        let img = NSImage(size: size, flipped: false) { _ in
            base.draw(in: NSRect(origin: .zero, size: markSize))
            if attention {
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: 27, y: 10, width: 5, height: 5)).fill()
            }
            return true
        }
        img.isTemplate = true
        return img
    }
}
