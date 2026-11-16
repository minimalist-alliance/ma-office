import AppKit
import Carbon
import Foundation

public enum SendFailure: Error, Equatable {
    /// macOS hasn't let this app control Messages (Privacy & Security › Automation).
    case permission
    /// Messages has no such chat or person.
    case chat
    /// Messages refused or failed; it may or may not have gone.
    case messages(Int)
}

/// How the bridge sends what the member wrote: through Messages on this Mac, or a fake in tests.
public protocol MessagesSender: Sendable {
    func send(text: String, chatGuid: String, handles: [String], sms: Bool, chatExists: Bool) throws
}

/// Sends through Messages with a fixed, compiled AppleScript whose handlers take the text and the chat as parameters, so
/// nothing a message holds is ever read as script.
public final class AppleScriptSender: MessagesSender, @unchecked Sendable {
    static let source = """
        on send_to_chat(theText, theChat)
            tell application id "com.apple.MobileSMS"
                send theText to chat id theChat
            end tell
        end send_to_chat

        on send_to_handle(theText, theHandle, useSMS)
            tell application id "com.apple.MobileSMS"
                if useSMS then
                    set theService to 1st account whose service type = SMS
                else
                    set theService to 1st account whose service type = iMessage
                end if
                send theText to participant theHandle of theService
            end tell
        end send_to_handle
        """

    private let lock = NSLock()
    private var script: NSAppleScript?

    public init() {}

    public func send(text: String, chatGuid: String, handles: [String], sms: Bool, chatExists: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        if script == nil {
            let s = NSAppleScript(source: Self.source)
            var err: NSDictionary?
            guard s?.compileAndReturnError(&err) == true else { throw SendFailure.messages(-1) }
            script = s
        }
        let params: [NSAppleEventDescriptor]
        let handler: String
        if chatExists || chatGuid.contains(";+;") {
            handler = "send_to_chat"
            params = [.init(string: text), .init(string: chatGuid)]
        } else if handles.count == 1 {
            handler = "send_to_handle"
            params = [.init(string: text), .init(string: handles[0]), .init(boolean: sms)]
        } else {
            throw SendFailure.chat
        }
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent),
                                           targetDescriptor: .currentProcess(), returnID: AEReturnID(kAutoGenerateReturnID),
                                           transactionID: AETransactionID(kAnyTransactionID))
        event.setDescriptor(.init(string: handler), forKeyword: AEKeyword(keyASSubroutineName))
        let list = NSAppleEventDescriptor.list()
        for (i, p) in params.enumerated() { list.insert(p, at: i + 1) }
        event.setDescriptor(list, forKeyword: AEKeyword(keyDirectObject))
        var err: NSDictionary?
        _ = script!.executeAppleEvent(event, error: &err)
        if let err {
            let n = (err[NSAppleScript.errorNumber] as? Int) ?? -1
            switch n {
            case -1743, -1744: throw SendFailure.permission
            case -1728, -1719, -1700: throw SendFailure.chat
            default: throw SendFailure.messages(n)
            }
        }
    }
}

/// What macOS lets this app do, checked without changing anything.
public protocol PermissionProbe: Sendable {
    /// Whether Messages' database opens (Full Disk Access).
    func fullDisk() -> Bool
    /// Whether this app may send through Messages: true, false, or nil when macOS hasn't asked yet or Messages isn't running.
    func automation(ask: Bool) -> Bool?
}

public struct SystemPermissions: PermissionProbe {
    public let chatDB: String

    public init(chatDB: String) { self.chatDB = chatDB }

    public func fullDisk() -> Bool {
        guard let db = try? ChatDB(path: chatDB) else { return false }
        return (try? db.maxRowId()) != nil
    }

    public func automation(ask: Bool) -> Bool? {
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.MobileSMS")
        guard let desc = target.aeDesc else { return nil }
        let rc = AEDeterminePermissionToAutomateTarget(desc, typeWildCard, typeWildCard, ask)
        switch rc {
        case noErr: return true
        case OSStatus(errAEEventNotPermitted): return false
        default: return nil
        }
    }

    /// Opens System Settings at the pane a permission lives in.
    public static func openSettings(fullDisk: Bool) {
        let pane = fullDisk ? "Privacy_AllFiles" : "Privacy_Automation"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }
}
