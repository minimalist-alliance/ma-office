import AppKit
import Foundation
import ServiceManagement

/// Starting at login, through macOS's own login items (System Settings › General › Login Items lists it).
public enum LoginItem {
    public static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    @discardableResult
    public static func set(_ on: Bool) -> Bool {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return true
        } catch {
            return false
        }
    }
}

/// Where the app keeps things on this Mac, all of it removed by "Remove MA Connector".
public enum AppPaths {
    public static let bundleId = "com.minimalistalliance.connector"

    public static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MA Connector", isDirectory: true)
    }

    public static var caches: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(bundleId, isDirectory: true)
    }

    public static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    public static var chatDB: String { home.appendingPathComponent("Library/Messages/chat.db").path }
    public static var attachments: URL { home.appendingPathComponent("Library/Messages/Attachments", isDirectory: true) }
}

/// A clean uninstall: the platform forgets this Mac, then everything the app put on it goes, and the app moves to the Trash.
public enum Uninstaller {
    public static func removeEverything(bridge: Bridge?, keyStore: KeyStore) async {
        await bridge?.disconnect()
        keyStore.delete()
        LoginItem.set(false)
        for dir in [AppPaths.support, AppPaths.caches] { try? FileManager.default.removeItem(at: dir) }
        UserDefaults.standard.removePersistentDomain(forName: AppPaths.bundleId)
        // macOS's own record of the permissions this app was given (best effort: Full Disk Access may need the member to
        // remove it in System Settings).
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        p.arguments = ["reset", "All", AppPaths.bundleId]
        try? p.run()
        p.waitUntilExit()
        await MainActor.run {
            NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { _, _ in
                NSApp.terminate(nil)
            }
        }
    }
}
