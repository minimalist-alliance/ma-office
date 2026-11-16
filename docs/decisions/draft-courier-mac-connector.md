# Draft. Courier's Mac connector: a member's iMessage and iPhone texts through MA's own app, paired through the sealed relay

**Status:** Proposed (draft; numbered from the Desk range when accepted). **Built** on `sub/mm-mac-connector` (ma-desk:
`connectors/mac`, `courier-envelope`'s `DeviceEnvelope`, deskd `courier/imsg/connector/`, the drain's device inbox, the office's
Accounts) and ma-platform `sub/courier-devices` (relay.md 0.4.3, paired devices). In no release; the platform half on staging only,
behind Courier's kill switch and `courier#current.devices.enabled`.
**Date:** 2026-11-15
**Decision:** the owner, Nov 15: "Yes go ahead" to an MA-signed Mac connector that links a member's iMessage and iPhone texts to
their office, replacing the BlueBubbles path ("Geez this is not easy... maybe I would like some kind of signed MA installer").
**Builds on:** the Courier launch plan §1.4 ("MA Connector for Mac, our own small menu-bar app, signed and notarized ... through
the sealed relay, as a paired device with its own keys") and D4; [draft-courier-envelope](draft-courier-envelope.md);
[draft-courier-transports](draft-courier-transports.md); [draft-courier-imessage](draft-courier-imessage.md) and the seam's
agreement `docs/sub-status/imsg-seam.md`. **Contract:** ma-platform `docs/contracts/relay.md` 0.4.3.

## Context
- BlueBubbles needs the member to install a third party's server, pick a mode, make the Mac reachable (a tunnel that reads the
  messages, or a port forward) and type its address and password into Courier. The owner tried it and asked for MA's own app.
- The relay already carries sealed envelopes between desks and holds them while a desk sleeps; 0.4.0 reserved a `device` kind.

## Decisions

### 1. A paired device, not a server
The Mac app never listens: it signs every request to the platform with its own Ed25519 key (relay.md 0.4.3 A.2) and polls its
own inbox. The desk never connects to the Mac. No tunnel, no port, no password, no account sign-in on the Mac.

### 2. Pairing: the member confirms on both sides
- The Mac asks the platform for a code (8 consonants, about 34.6 bits, 10 minutes). The member types it into Courier on the desk
  that should get their texts (Accounts › Add an account › iMessage on your Mac). That desk claims it, which binds the device to
  that desk and its member, and pins the Mac's keys in the new account's sealed sign-in.
- The Mac then shows "Connect this Mac?" with the claiming member's masked email (from the platform, `claimedBy`) and the
  pairing's **check number** (SHA-256 over `"ma-device-pair/v1\n"`, the desk's identity and the Mac's identity, 12 digits). The
  office shows the same number. Nothing is carried and no send is obeyed until the member presses Connect (Security MC-M1).
  "That's not me" unpairs at once.
- **Why the desk is chosen in the office, not on the Mac:** the Mac then never holds a sign-in to the member's account, so a
  stolen Mac's connector reaches one desk's relay inbox, not the account.
- **The honest limit (MC-I1):** each side takes the other's keys from the platform. The check number is how a member can know
  nothing in between swapped one; without comparing it, sealing protects against bugs and a curious operator, not a hostile
  platform at pairing.

### 3. The envelope (desk-owned; relay.md 2.2's `device` kind)
- `kind: device`, `to` the device id in both directions; `info = "ma-courier/v1 device"`, `aad = "ma-courier/v1 env\ndevice\n" +
  deviceId`; the same HPKE suite, padding and buckets; at most 32 KiB of plaintext. Up is sealed to the desk's box key, down to
  the device's.
- Plaintext `{"p", "s"}`, `s` Ed25519 over `"ma-courier/v1 device sig\n" + p`, its own domain. `p`: `v`, `kind: device`, `id`
  (ULID), `device`, `dir` (`up`/`down`), `at`, `type`, then the type's fields.
- A payload over the envelope goes whole into one drop (the `Drop` format) and the envelope carries `type: big` with its signed
  reference; deskd reads at most 8 MiB of it, the Mac keeps pages to 4 MiB, and a larger one is refused (MC-M2).
- **Up:** `page {epoch, after, through, messages, more}` (M mirrors deskd's `ImsgMessage`, with `seq` and each file's drop
  reference or `null`), `changes {messages}` (edits and unsends), `sent {outboundId, replyTo, result, guid?, error?, unclear?}`,
  `status {app, os, fullDisk, automation, messages, paused}`. **Down:** `hello {account, backfillDays}`, `resume {epoch, after}`,
  `send` (mirrors `ImsgSend`), `bye`.
- Checks on both sides: open, verify under the pinned peer key, `device` and `dir`, an `at` window (91 days up, 31 down, a day of
  skew), duplicate ids dropped (the Mac keeps every id in its window, MC-L3).

### 4. The place and the order
- The desk keeps `(epoch, through)` with each page's messages in one transaction (the sink). A page past it in the same epoch
  isn't kept, and the Mac is asked to go again (`resume`, at most every 10 minutes). A new epoch (a replaced Messages database,
  or a fresh `hello`) is taken whatever its place; the seam's guid keys store nothing twice.
- The Mac answers a `send` with `sent` before any page holding the message, so the desk records its guid first; each try of a send
  is its own down envelope and gets its own answer (idempotency keyed by the down payload's id).

### 5. On the Mac
- **Full Disk Access** is used for two things only: `~/Library/Messages/chat.db`, opened read-only with `query_only` and never
  through a link, and attachments under `~/Library/Messages/Attachments` (resolved with `realpath`, opened `O_NOFOLLOW`, a regular
  file, at most 16 MiB). `attributedBody` text is read from the typedstream without unarchiving any object.
- **Sending** goes through one fixed AppleScript compiled once; the text and the chat reach it as Apple Event parameters, never as
  script. At most 60 sends an hour and 500 a day; a retry that "may have gone" looks in Messages first.
- **State:** the two secret keys in the login keychain; places, ids and the desk's public keys in
  `~/Library/Application Support/MA Connector/state.json` (0600); no message text anywhere but the sealed envelopes.
- **Updates:** a feed signed with MA's Ed25519 update key (built into the app); a newer version and build only; the zip's SHA-256
  and size checked; with MA's team set, the new app must carry MA's Developer ID. A build without the key never updates.
- **Remove MA Connector** unpairs on the platform, deletes the keys, the state, caches and preferences, takes the login item out,
  resets the app's permissions it can, and moves the app to the Trash.

### 6. Signing
Ad-hoc with the hardened runtime until MA's Apple Developer account exists (the owner is enrolling MA as an organisation).
`scripts/sign-notarize.sh` then signs with "Developer ID Application: Minimalist Alliance (TEAMID)" from a dedicated keychain,
notarizes with MA's App Store Connect API key and staples; it refuses any other identity. Never a person's Apple ID.

## Consequences
- iMessage and texts need no server, tunnel or password from the member: install, a code, Connect, two macOS permissions.
- The platform sees a device's public keys, its desk, request times and bucketed sizes; never a message.
- A desk without an address of its own still collects its Mac's envelopes. Device envelopes share the desk's relay caps.
- **Rejected:** a member sign-in on the Mac (a stolen Mac would reach the account); the Mac as a server (tunnels read messages);
  `NSUnarchiver` on `attributedBody` (it instantiates classes from the blob); trusting the platform's keys with no check number.

## Security's read
Stand-in read `~/work/maia-mode/mac-connector/security.md` (Nov 15): platform CLEAR (Infos MC-I2, MC-I4 fixed); desk MC-M1
(confirm on the Mac), MC-M2 (UTF-16 clipping, a page budget, oversize refused), MC-L1 (the check number in the office), MC-L2
(switched off keeps nothing), MC-L3 (the whole replay window), MC-I1, MC-I3 (Developer ID markers), MC-I4 (16 MiB), all fixed.

## Questions, each with the default taken
1. **Where MA Connector is downloaded from** (no release yet). *Default:* a signed zip on MA's downloads host with its signed
   feed, linked from Courier's iMessage setup once the first release exists.
2. **The relay's per-route throttle for devices before prod** (MC-I2: about 500 active Macs at one poll each 5 s). *Default:*
   size it with Platform before the device route goes to prod.
3. **A device share of the desk's relay caps** (MC-I4). *Default:* shared, as built; revisit with real backfills.
4. **BlueBubbles in the office.** *Default:* the office offers MA Connector only; BlueBubbles stays in deskd behind the seam.
