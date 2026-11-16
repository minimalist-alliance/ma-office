# Draft. Courier's iMessage transport: the member's Mac, behind one `imsg` seam

**Status:** Proposed (draft; numbered from the Desk range when it's accepted). **Built** on `sub/mm-courier-imessage` (the
launch plan's Wave 2.6): deskd's `courier/imsg/` and `courier/imsg/bluebubbles/`, `courier.db` schema version 6, the test
kit's fake BlueBubbles gaining TLS, contacts, one message and unsend. In no release, on no desk; Courier stays behind
`COURIER_READY`.
**Date:** 2026-11-15
**Decision:** the owner, Nov 12 (D4 default): iMessage and iPhone texts at launch through BlueBubbles on the member's own
Mac, either mode. The owner, Nov 15: MA builds its own signed, notarized Mac connector, paired through the sealed relay, as
the main path; BlueBubbles stays as a second path; both behind one shared `imsg` transport seam in deskd.
**Builds on:** [draft-courier-store](draft-courier-store.md) (the sink, the queue, one thread per person §18),
[draft-courier-transports](draft-courier-transports.md), [draft-courier-channels](draft-courier-channels.md); ADR
[0016](0016-chat-channels-and-delivery.md). The seam's agreement with the connector: `docs/sub-status/imsg-seam.md`.

## Context
- A member's iMessages live on their Apple devices. A desk can't speak iMessage itself (copying Apple's login is off the
  table, plan §1.4); it needs a Mac signed in to Messages to relay. Two ways: BlueBubbles Server (open source, a REST API and
  a socket, on the member's Mac), and MA's own Mac connector (soon; paired through the relay, no tunnel).
- The member makes BlueBubbles reachable: their own domain or a port forward (TLS end to end), or BlueBubbles' Cloudflare,
  ngrok or zrok tunnel (which unlock the TLS on their servers). The platform is never in the path.

## Decisions

### 1. One seam, two paths
- `ImsgTransport` owns the account side for every path: one iMessage account a desk (kind `imessage`), its sign-in sealed in
  the Courier vault as a linked mailbox's is (plan §3.6), the path picked by the sealed server JSON's `path`, the outbound
  queue's `imessage` and `sms` senders, the chat a reply goes to, the kill switches (`imessage-off`, `imessage-send-off`).
- `ImsgSink` turns a Mac's message (`ImsgMessage`, path-neutral) into Courier's, the same way for both paths. A path
  (`ImsgPath`) only reads, sends and reports its state. Sink keys are the Mac's own guid (`imsg1:<guid>`), so moving from one
  path to the other stores nothing twice.

### 2. One thread per person (plan §1.5)
- A one-to-one chat's messages go to the person's own conversation (`direct:<contact>`), whatever the medium: iMessage,
  their iPhone's texts (`sms`, from a chat guid `SMS;` or `RCS;`), email and member messages are one thread once linked.
- A handle is a number (`phone`) or an Apple ID's address (`apple`). Linking is the member's (`courier.links.*`); the Mac's
  Contacts (§5) only suggest. A reply by iMessage goes to the person's number, or their Apple ID when that's where they last
  wrote from on iMessage.
- A group chat is one conversation per chat (`Courier.Inbound.group`: `chat:im1:<hash of account and chat guid>`), whoever
  joins or leaves, titled as on the iPhone; a rename renames it. A reply goes back to the group's own chat
  (`imessage_chats`).

### 3. Words for what Courier can't show as a bubble
Reactions ("Loved “see you at 6”", "Removed a heart from…", an emoji tapback, a sticker), edits ("Edited “…”: …"), unsends
("Unsent a message.") and a group's changes ("Named the conversation “Crag day”.", added, removed, left) are each their own
message from whoever did it, with their own sink key (`imsg1e:<guid>:<dateEdited>`, `imsg1u:<guid>`), stored once. An edit is
news only for a message the desk had before it; a message first seen edited is stored as it reads. Quotes are the desk's own
stored text, 60 characters, cleaned. Something only Messages can show (an app's bubble, handwriting) reads "Sent something
only Messages can show."

### 4. Files
- A path reads each file's bytes (BlueBubbles: `GET attachment/<guid>/download`), at most 16 MiB a file and 16 MiB a
  message; more stays on the Mac and says so in the message ("[video.mov, 48.2 MB: it stays in Messages on your Mac.]").
- The files are wrapped in one MIME container, every header built by deskd (a random boundary, base64, an allow-listed type,
  `message/*` and `multipart/*` as plain bytes, the name cleaned and RFC 2231 encoded), read by `desk-parse`'s Courier mode
  for the parts and their danger words, and kept as the message's raw bytes. Save to Files (with Files' `untrusted` mark),
  Download, previews and archive lists are then exactly email's (plan §2.7, §3.3): deskd never opens a file.
- deskd's heap is 208 MiB: one message's files are in it at a time (a message with files is committed alone, one permit
  across paths, the container written into one exact-size array, each file dropped once encoded; Security IM-H1). A sandbox
  that can't be reached holds the page with what came before it stored. A file the Mac can't serve is tried on 3 looks, then
  left there (IM-L2).

### 5. The Mac's Contacts
Read from BlueBubbles' `GET contact` on connect and daily into `cards` (source `mac:<accountId>`; at most 20,000 cards of 20
endpoints). They name a person who has no name yet, for a number or an Apple ID only (never an email address, whose sender
line is DMARC's), when exactly one name fits; and they make card-strength suggestions in `courier.links.suggest` (source
`mac`, onto the oldest named person already let in). They never link anyone, let anyone in or move a message. A number
matches by its last 10 digits unless both sides carry a country code, then exactly.

### 6. BlueBubbles' path
- **The address:** `https://` only, a DNS name or a public IP literal, a port (443, 8443, or 1024 to 65535), nothing else.
  Every connect goes through `Net`'s checks to an address it resolved and checked (never loopback, private, link-local and
  IMDS, CGNAT, ULA, the desk's own), and never the name again. No redirect is followed.
- **TLS:** the JDK's trust store with the host checked; or, for the member's own address only, the leaf certificate's SHA-256
  pinned on first connect (never a tunnel's). "Sign in again" keeps the pin for the same address, and a certificate that
  changed (self-signed or a CA's) stops at the handshake, before the password goes, with `certificate_changed` and the new
  fingerprint; only `acceptCertificate` naming exactly it re-pins (Security IM-M1).
- **Catching up:** `POST message/query` from the cursor less 20 minutes (edits and unsends of recent messages), oldest first,
  pages of 50, each page stored with its cursor; the first look brings 30 days, older than a day as `backfill` (not new to an
  agent's `courier_new`). The Mac keeps everything while the desk sleeps.
- **Live:** the socket (Socket.IO v4, websocket) is a doorbell: any event starts a look, and an `updated-message`'s guid is
  asked for again. Looks are at least 3 s apart; without the socket every minute, backing off to 10 minutes while the Mac
  doesn't answer. At most 20,000 new messages a day from one Mac (`waiting`, `daily_cap`).
- **Sending:** `POST message/text` by AppleScript (no Private API), the guid recorded before the next page is stored; a
  send whose answer was lost looks on the Mac first. A new chat, or a group no message came from, can't be started from
  Courier at launch (`chat`).
- **Limits against a hostile server:** headers 64 KiB and 100 lines, JSON answers 2 MiB (contacts 4), files as above, socket
  frames 1 MiB, every exchange within a wall-clock bound (90 s; a file's grows a second per 128 KiB), the handshake within
  30 s.
- **Modes:** BlueBubbles' Basic and Private API modes work the same; Courier reads which from `server/info` and shows it.

### 7. Agents
iMessages and texts go through the same lanes as email: a stranger's first message is a Request, which no agent sees; every
Courier result is `U` and `S` (agent tools §12). `senderConfirmed` is true for an iMessage (Apple's) and false for a text,
whose sender can be spoofed (Security IM-L1).

## Threats (adds to the plan's §3.9)
| # | Threat | Defence | Left |
|---|---|---|---|
| C14 | A tunnel or a proxy in front of the member's domain reads, and writes, iMessages, and sees the BlueBubbles password (it's a query parameter) | Said at setup, by name for Cloudflare, ngrok and zrok; MA's connector as the main path | The member's choice of tunnel; a proxy in front of their own domain reads "your own address" (IM-I2: the Designer's words to say so) |
| C16 | A hostile server at the member's address | `Net`'s address checks, no redirects, the limits above, the daily cap, the sink's cleaning | It can fabricate messages, including the member's own (letting a stranger in): it is the member's server |
| C17 | A spoofed text from a contact's number | `senderConfirmed: false` for texts | Shown in the contact's thread, as on the iPhone |
| C18 | A changed certificate on the member's own address | Pinned; a change stops before the password and asks the member | A member who accepts without checking |

## Open, with defaults
1. **Older history:** 30 days on first connect; older stays on the Mac. Default: a later "Bring in older messages".
2. **Files over 16 MiB:** stay on the Mac, said in words. Default: a later "Bring it in" on press, from the Mac.
3. **An unsent message's original** stays on the desk with "Unsent a message." after it. Default: keep (the member's copy);
   the Designer may prefer to hide it.
4. **Starting a new conversation** from Courier: not at launch (BlueBubbles needs the Private API's `chat/new`).
