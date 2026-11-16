// swift-tools-version:5.10
// MA Connector for Mac: links a member's iMessage and iPhone texts to their desk through the sealed relay.
// Built with SwiftPM only (no Xcode project): scripts/build-app.sh assembles the .app from these products.
import PackageDescription

let package = Package(
    name: "MAConnector",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "MAConnector", targets: ["MAConnector"]),
        .executable(name: "connector-harness", targets: ["connector-harness"]),
        .executable(name: "connector-tool", targets: ["connector-tool"]),
        .executable(name: "connector-shots", targets: ["connector-shots"]),
    ],
    targets: [
        // Everything that can be tested without a screen: the envelope, the relay client, Messages' database, the bridge.
        .target(name: "ConnectorCore", linkerSettings: [.linkedLibrary("sqlite3")]),
        // The app's screens and its model (SwiftUI and AppKit).
        .target(name: "ConnectorUI", dependencies: ["ConnectorCore"]),
        // The menu-bar app.
        .executableTarget(name: "MAConnector", dependencies: ["ConnectorCore", "ConnectorUI"]),
        // Renders each screen to a PNG in light and dark, from made-up state, for the brand review (never shipped).
        .executableTarget(name: "connector-shots", dependencies: ["ConnectorCore", "ConnectorUI"]),
        // Synthetic Messages databases (made-up people, 555 numbers): tests and the harness only, never in the app.
        .target(name: "ConnectorFixtures", dependencies: ["ConnectorCore"], linkerSettings: [.linkedLibrary("sqlite3")]),
        // Runs the bridge against a fixture database and a fake Messages, for the end-to-end test with the fake relay.
        .executableTarget(name: "connector-harness", dependencies: ["ConnectorCore", "ConnectorFixtures"]),
        // Fixtures and signed update manifests: build-time and test-time only, never shipped.
        .executableTarget(name: "connector-tool", dependencies: ["ConnectorCore", "ConnectorFixtures"]),
        .testTarget(name: "ConnectorCoreTests", dependencies: ["ConnectorCore", "ConnectorFixtures"], resources: [.copy("Resources")]),
    ]
)
