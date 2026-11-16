import Foundation

/// Every sentence the member reads in MA Connector, in one place: plain, calm, short, and saying what to do next. No
/// exclamation marks, no emoji, no provider names. The office's words for the same steps are in ma-desk
/// `web/src/apps/courier/words.ts`.
public enum Words {
    public static let appName = "MA Connector"

    // The menu
    public static let notConnected = "Not connected to your office"
    public static let waiting = "Waiting for your office"
    public static func connected(_ desk: String) -> String { desk.isEmpty ? "Connected to your office" : "Connected to your \(desk) desk" }
    public static let upToDate = "Up to date"
    public static func bringingIn(_ n: Int) -> String { n == 1 ? "Bringing in 1 message" : "Bringing in \(n) messages" }
    public static let paused = "Paused. Nothing comes in or goes out."
    public static let needsFullDisk = "Needs you: allow Full Disk Access"
    public static let needsAutomation = "Needs you: allow sending through Messages"
    public static let cantReach = "Can’t reach your office. Trying again."
    public static let disconnectedLine = "This Mac was disconnected from your office."
    public static let openApp = "Open MA Connector"
    public static let checkAgain = "Check again"
    public static let pause = "Pause"
    public static let resume = "Resume"
    public static let checkUpdates = "Check for updates"
    public static let disconnect = "Disconnect this Mac…"
    public static let quit = "Quit MA Connector"

    // Welcome
    public static let welcomeTitle = "Your texts, in your office"
    public static let welcomeLead = "MA Connector brings your iMessages and your iPhone’s texts from this Mac into Courier. They’re sealed on this Mac so only your desk can read them. MA never sees them."
    public static let getCode = "Get a code"

    // The code
    public static let codeTitle = "Connect to your office"
    public static let codeSteps = "In your office, open Courier on the desk that should get your texts. Go to Accounts › Add an account › iMessage on your Mac, and type this code."
    public static let copyCode = "Copy code"
    public static let copied = "Copied"
    public static let codeWaiting = "Waiting for your office…"
    public static let codeLife = "This code works for 10 minutes. Only type it into your own office."
    public static let codeExpired = "That code expired."
    public static let newCode = "New code"
    public static let codeFailed = "Couldn’t get a code. Check this Mac’s connection, then try again."
    public static let tryAgain = "Try again"

    // Permissions
    public static let permsTitle = "Allow two things"
    public static let permsLead = "macOS asks you to allow each one. You can change them later in System Settings › Privacy & Security."
    public static let fullDiskTitle = "Read your messages"
    public static let fullDiskLine = "macOS keeps Messages’ history behind Full Disk Access. MA Connector reads only Messages’ history and its attachments, nothing else on this Mac."
    public static let fullDiskSteps = "In System Settings, turn on MA Connector under Full Disk Access. If it isn’t listed, press + and choose it from Applications."
    public static let automationTitle = "Send what you write"
    public static let automationLine = "When you reply in Courier, MA Connector asks Messages on this Mac to send it. macOS asks you once."
    public static let openSettings = "Open Settings"
    public static let allow = "Allow"
    public static let allowed = "Allowed"
    public static let notYet = "Not yet"
    public static let messagesClosed = "Open Messages, then check again."
    public static let continueLabel = "Continue"

    // Confirm (after an office used the code)
    public static let confirmTitle = "Connect this Mac?"
    public static func confirmWho(_ email: String?, _ desk: String) -> String {
        let deskWords = desk.isEmpty ? "a desk" : "the \(desk) desk"
        if let email, !email.isEmpty { return "The code was used in \(email)’s office, for \(deskWords). Connect only if that’s you." }
        return "The code was used in an office, for \(deskWords). Connect only if it was yours."
    }
    public static let confirmCheckLabel = "Your office shows this number"
    public static let confirmCheckLine = "Courier shows it under iMessage on your Mac. If it doesn’t match, don’t connect."
    public static let confirmYes = "Connect"
    public static let confirmNo = "That’s not me"
    public static let checkLabel = "Check number"

    // Connected
    public static func doneTitle(_ desk: String) -> String { connected(desk) + "." }
    public static func doneLine(_ days: Int) -> String {
        "Your messages from the last \(days) days come in first, then new ones as they arrive. Keep this Mac on, awake and signed in to Messages."
    }
    public static let smsHint = "For your iPhone’s texts too: on the iPhone, open Settings › Messages › Text Message Forwarding, then turn on this Mac."
    public static let openAtLogin = "Open at login"
    public static let done = "Done"

    // Settings
    public static let deskLabel = "Desk"
    public static let keyLabel = "This Mac’s key"
    public static let versionLabel = "Version"
    public static let updatesLabel = "Updates"
    public static let updatesOff = "Updates arrive with MA’s signed releases."
    public static let upToDateVersion = "You have the latest version."
    public static func updateReady(_ v: String) -> String { "Version \(v) is ready." }
    public static let installUpdate = "Install and reopen"
    public static let updateFailed = "Couldn’t update. Try again later."
    public static let disconnectTitle = "Disconnect this Mac?"
    public static let disconnectBody = "Your texts stop coming into Courier. What’s already there stays."
    public static let disconnectConfirm = "Disconnect"
    public static let cancel = "Cancel"
    public static let remove = "Remove MA Connector…"
    public static let removeTitle = "Remove MA Connector?"
    public static let removeBody = "This disconnects this Mac from your office and removes the app and everything it kept on this Mac. Your messages stay in Messages and in Courier."
    public static let removeConfirm = "Remove"
    public static let removeFullDisk = "If MA Connector still shows under Full Disk Access, you can remove it there with −."

    // Disconnected
    public static let disconnectedTitle = "Disconnected"
    public static let disconnectedBody = "This Mac was disconnected from your office, so nothing comes in or goes out. To connect it again, get a new code."
}
