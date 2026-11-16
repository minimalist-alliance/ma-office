# MA Connector for Mac

A small menu-bar app that brings a member's iMessages and their iPhone's texts from their own Mac into Courier, sealed so only
their desk can read them. It pairs with a desk through the platform's sealed relay as a paired device: no server, tunnel, port
or password on the Mac, and no sign-in to the member's account. Design: `docs/decisions/draft-courier-mac-connector.md`;
contract: ma-platform `docs/contracts/relay.md` 0.4.3; the desk's side: deskd `courier/imsg/connector/` (API.md §21).

SwiftPM only (no Xcode project): Swift 6.1 or later with the Command Line Tools, macOS 14+, Apple silicon and Intel.

## Layout
| Target | What | Ships in the app |
|---|---|---|
| `ConnectorCore` | The envelope, signed device payloads and drops (CryptoKit; byte-exact with `courier-envelope`'s vectors), the signed relay client, Messages' database (read-only), the bridge, permissions, updates, login item, uninstall, the words | yes |
| `ConnectorUI` | The window's screens and the app's model (SwiftUI) | yes |
| `MAConnector` | The app's entry and the menu | yes |
| `ConnectorFixtures` | Synthetic Messages databases (made-up people, 555 numbers) and a fake Messages | no |
| `connector-harness` | The bridge against a fixture database and a fake Messages, for the end-to-end test | no |
| `connector-tool` | MA's update key and signed update feeds | no |
| `connector-shots` | Each screen to a PNG in light and dark, from made-up state | no |

## Build and test
Everything runs on a Mac; from Linux, `MAC_HOST=user@mac scripts/mac.sh '<command>'` copies this folder to the build Mac's `~/ma-build/mac-connector`
and runs it there.
- `swift test`: 32 tests, fixtures only.
- `scripts/build-app.sh [--relay https://api.staging.minimalistalliance.com] [--version 1.0.0] [--build 1]`: both architectures,
  one universal binary, the bundle assembled by hand, ad-hoc signed with the hardened runtime, `dist/MA Connector.app` and
  `dist/MA-Connector-<version>.zip`. It stops if a local path or a name is in the bundle.
- `MAC_HOST=… JAVA_HOST=… scripts/e2e-fake-relay.sh` (from a ma-desk checkout on Linux): this app's bridge on the Mac against deskd's connector path on a
  Java build box, through the test kit's fake relay and two SSH tunnels.
- `swift run connector-shots <dir>`: the screens for a review.

**Never run the app, the harness or the tests against a real Messages database.** The build Mac is a person's own Mac, signed in
to their iMessage: nothing here opens `~/Library/Messages` except the app itself, which only a member runs on their own Mac.

## Signing
- **Now:** ad-hoc (`build-app.sh`). macOS asks the member to open it from System Settings › Privacy & Security the first time, and
  after an ad-hoc update the keychain asks once for the app's keys.
- **Once MA's Apple Developer account exists** (MA, the organisation; never a person's Apple ID):
  1. In the developer account, the Account Holder makes a "Developer ID Application" certificate for Minimalist Alliance and an
     App Store Connect API key (Developer role) for notarization.
  2. On the build Mac: `security create-keychain ~/ma-build/ma-signing.keychain-db`; import the certificate's `.p12` into it
     with `-T /usr/bin/codesign`; `xcrun notarytool store-credentials ma-notary --key AuthKey_<KEYID>.p8 --key-id <KEYID>
     --issuer <ISSUER> --keychain ~/ma-build/ma-signing.keychain-db`.
  3. Each release: `scripts/sign-notarize.sh --team <TEAMID> --version <v> --build <n> --relay https://api.minimalistalliance.com
     --update-url <feed> --update-key <public key>`: builds, signs with MA's Developer ID (it refuses any other identity),
     notarizes, staples, checks with `spctl`, and zips.
- **Updates:** `connector-tool update-key <file>` makes MA's update key once (keep the private file in MA's secrets, never a
  repo); build with `--update-url` and `--update-key`; `connector-tool sign-update <key> <zip> <version> <build> <url>` writes the
  signed feed. A build without a key never updates.

## Privacy
- Full Disk Access is used for Messages' history (`~/Library/Messages/chat.db`, read-only) and its attachments only.
- Everything that leaves the Mac is sealed to the desk's key and signed with this Mac's key; the platform carries ciphertext.
- On the Mac: the two secret keys in the login keychain; places and ids in `~/Library/Application Support/MA Connector/state.json`.
- "Remove MA Connector…" unpairs and removes all of it. If the app was deleted without it: the platform forgets the device when
  the member removes "iMessage on your Mac" in Courier; delete `~/Library/Application Support/MA Connector` and the keychain item
  "MA Connector", and remove it under Full Disk Access.
