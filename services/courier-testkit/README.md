# courier-testkit

Courier's test kit, for tests only: nothing here ships in an image. Package `com.minimalistalliance.desk.courier.testkit`.

| What | Class | Resource |
|---|---|---|
| The MIME corpus: raw messages and what a correct parser makes of each | `MimeCorpus` | `courier-testkit/mime/*.eml`, `expect.tsv` |
| Hostile HTML: XSS and remote-load vectors | `HostileHtml` | `courier-testkit/html/vectors.txt` |
| A labelled spam and wanted-mail corpus for the learning filter (Wave 3.2): 8 spam families, 7 wanted ones, generated | `SpamCorpus` | |
| A fake mail provider: IMAP and SMTP (and both over TLS) on 127.0.0.1 | `FakeMailServer` | GreenMail 2.1.15 |
| A fake BlueBubbles Server: REST, a Socket.IO socket and webhooks on 127.0.0.1 | `FakeBlueBubbles` | Java-WebSocket 1.6.0 |
| A fake of Platform's relay (contract 0.4.0) and its mail door, on 127.0.0.1 | `FakeRelay`, `RelayClient`, `PeerDesk` | `courier-envelope` |
| Paired devices on the fake relay (relay.md 0.4.3: signed device requests, pairing by code, the claim, device inboxes, removal from all three sides) and MA Connector for Mac faked in Java (SPEC B's pages, sends and answers) | `FakeRelay` (`start(port)`, `lastUserCode`, `deviceIds`, `removeDeviceAsMember`, `setDevicesEnabled`), `FakeMac` | `courier-envelope` (`DeviceEnvelope`) |
| The soak harness: 7 days, 100,000 messages, every channel, 0 lost and 0 doubled | `soak.Soak`, `Runner`, `Channels`, `Faults`, `Ledger` | |
| A scripted IMAP server: CONDSTORE, QRESYNC, SPECIAL-USE, ESEARCH, Gmail mode, faults | `FakeImapServer` | JDK only |
| A scripted SMTP submission server: 465 and 587 shapes, faults | `FakeSmtpServer` | JDK only |
| The two fakes' TLS: GreenMail's test certificate, and a client context that trusts it | `FakeTls` | `greenmail.p12` (GreenMail's jar) |

Everything is synthetic: written by hand or generated here. No real mail, no third-party corpus.

## Using it from deskd (wave 2.1's IMAP builder)

Add it to `deskd/pom.xml` in test scope (`courier-parse` already does the same):

```xml
<dependency>
  <groupId>com.minimalistalliance.desk</groupId>
  <artifactId>courier-testkit</artifactId>
  <version>${project.version}</version>
  <scope>test</scope>
</dependency>
```

Then, in a test:

```java
try (FakeMailServer server = FakeMailServer.start()) {
    server.addUser("owner@example.com", "owner", "secret");
    for (MimeCorpus.Sample s : MimeCorpus.handWritten()) {
        server.deliver("owner@example.com", s.raw());                 // into INBOX
    }
    server.deliver("owner@example.com", "Archive", MimeCorpus.tooDeep(21).raw());  // makes the folder

    // Point the IMAP builder at 127.0.0.1:server.imapPort() as owner / secret (or imapsPort(), trusting any certificate).
    // Each message it hands the sink should be FakeMailServer.stored(sample.raw()) exactly.

    long next = server.resetUidValidity("owner@example.com", "INBOX");  // the builder must notice and resync
    server.greenMail();                                                  // GreenMail itself: flags, moves, expunges
}
```

`received(address)` is what's in that user's folders now (INBOX first, then by name, each in UID order), whether it came
through SMTP or `deliver`. A `deliver` to an address no one added makes a user whose login and password are the address.

## The corpus

`MimeCorpus.standard()` is `handWritten()` then `generated(DEFAULT_SEED, STANDARD_COUNT)`: 5,155 samples, 41,500,093 bytes
(largest 566,214), with seed 20261113 and 5,000 generated. `MimeCorpusTest` prints the generated set's SHA-256.

**Hand-written (155):** deskd's 27 (`services/deskd/src/test/resources/courier/mime/`, copied byte for byte, rows mapped
from `ok` and `refused:x`) and 128 more. Each new one says what it tests in an `X-Corpus-Note` header. Families:

- `charset` (30): every charset in the generator's list, UTF-7, UTF-16 with and without a byte order mark, an unknown charset, mislabeled ones
- `encoding` (20): every transfer encoding (base64 with and without line breaks, an unknown token, `x-uuencode`), uuencoded bodies, LF and mixed line ends, a 60,000-character line, NUL bytes
- `header` (31): encoded-word abuse (nested, bad base64, unknown charset), RFC 2231 continuations, groups, duplicate From and Subject (refused, as is a From of two mailboxes: Security CP-L2), IDN and quoted local parts, a header without a colon
- `structure` (18): related with cid images (real PNG, GIF, JPEG), PGP and S/MIME signed, PGP-encrypted, `application/pkcs7-mime`, a DSN, a digest, `format=flowed` with `delsp`, a calendar REQUEST, Apple Mail, Outlook and Gmail shapes
- `attachment` (17): TNEF, ZIPs (one holding an `.exe`, a clean one, an encrypted entry), a `.docm` with `vbaProject.bin`, a jar, a tar, an OLE2 `.doc` naming `_VBA_PROJECT`, every dangerous extension, `invoice.pdf.exe`, a right-to-left override in a name
- `html` (7), `links` (6): script, style, iframe, forms, meta refresh, base href, SVG, MathML; tracking pixels, `utm_*`, `fbclid`, `gclid`, a link whose text says paypal.com, bare-IP, punycode and mixed-script hosts, `javascript:` and `data:` links
- `bulk` (3), `basic` (4), `malformed` (13, all `either`), `limits` (6): at and over 2,000 parts and 20 deep

**Generated (`generated(seed, count)`):** sample `n` is `gen-<family>-<n>`, made from its own `SplittableRandom` seeded
from the seed and `n` alone, so a shorter run is a prefix of a longer one. No clock, host or default locale is read. The
family comes from a fixed cycle of 25, so any 25 samples have every family:

| Family | Share | What |
|---|---|---|
| `charset` | 6/25 | One of 15 languages in one of 26 charset labels (UTF-8, US-ASCII, ISO-8859-1/2/5/7/9/15, windows-1250/1251/1252/1253/1255/1256, KOI8-R, Big5, GB2312, GBK, GB18030, Shift_JIS, EUC-JP, ISO-2022-JP, EUC-KR, UTF-16 LE and BE with a BOM): plain, HTML or both, subject and sender name in it too |
| `structure` | 4/25 | Alternative, mixed, related with cid images, nested 1 to 19 deep, digest, PGP and S/MIME signed, a DSN, forwarded as `message/rfc822` and Gmail-style, calendar invites |
| `header` | 3/25 | Long folded B words, Q words in Latin charsets, plain text between encoded words, raw UTF-8, lower-case markers, RFC 2231 language tags; senders with commas, escaped quotes, comments, an address as the name |
| `encoding` | 3/25 | 7bit, none, 8bit, binary (a line past 998), base64 at 76, 64 and one line, quoted-printable, upper and mixed case tokens; some messages all bare LF |
| `attachment` | 3/25 | 1 to 4 files of 18 kinds (real PNGs and ZIPs, others by their leading bytes), names in every language, RFC 2231 or encoded words, dangerous names; up to about 200 KB |
| `html` | 2/25 | 1 to 5 `HostileHtml` vectors after the words, pointing at `http://hit.invalid/hit/<name>` (`HostileHtml.CORPUS_HIT_BASE`) |
| `links` | 2/25 | Newsletters: tracking pixels, tracking parameters, lying links, list headers |
| `mutation` | 2/25 | A clean sample of another family, then truncated, a boundary changed, bytes flipped, CRs deleted, a header doubled, the blank line removed or NULs added: `EITHER` |

Text is real words in each script (Latin, Cyrillic, Greek, Hebrew, Arabic, Chinese, Japanese, Korean), checked to read
back through its charset before a sample is returned.

**On demand, never stored** (family `limits`):

- `large(bytes)`: exactly that many bytes, nearly all one base64 attachment. `overLimit()` is 41,943,041 bytes: `too_large`.
- `tooDeep(depth)`: that many multiparts, each inside the last, the message's own the first; `too_deep` past 20.
- `tooManyParts(parts)`: exactly that many MIME parts, **counting the message itself and every multipart** as deskd's
  `TestMime` does (so 2,000 is a multipart/mixed of a text part and 1,998 attachments); `too_many_parts` past 2,000.

## What `Expect` means

`outcome` is `READ`, `REFUSED` (with `reason`: `too_large`, `too_deep`, `too_many_parts`, `timeout`, `malformed`,
`too_complex`) or `EITHER` (broken input a parser may read or cleanly refuse, with any reason; nothing else is checked).
For the rest, null means not checked:

- `subject`: decoded as RFC 5322 and 2047 say: folds removed (the CRLF only), encoded words decoded, the space between two
  adjacent encoded words dropped. `""` means the message has no subject.
- `from`: the first From mailbox's address, lower case (compare ignoring case). `nobody@invalid` when there's none, as
  deskd's store shows it. Every `READ` sample has one.
- `attachments`: every leaf except the body (the first `text/plain` and the first `text/html` with no file name and not
  marked attachment) and except parts marked `Content-Disposition: inline`; a `message/rfc822` part counts once and isn't
  descended. Null where a reasonable parser could count otherwise (DSN status parts, digests, Google's invite shape).
- `word`: lower case, at least four letters, in the body's decoded text (the plain part, or the HTML's visible text when
  there's none), compared ignoring case.

`ExpectationsAgreeTest` reads every `READ` sample with Jakarta Mail as a second opinion; all 4,747 checked agree but four
of deskd's rows, which show what deskd's store keeps rather than the parser's raw answer: `bidi-subject` and
`nul-and-controls` (the store strips the override and the BEL), `long-header` (the store caps a subject at 998) and
`eight-bit-headers` (`koln` finds "Köln" through deskd's search, which folds accents).

## Hostile HTML

`HostileHtml.vectors()` has 351 vectors: 236 call `alert(` when they run and 117 fetch their own URL when they load (two do
both). Categories: script tags in every case and spacing, event handlers on every element, `javascript:`, `vbscript:` and
`data:` URLs in every encoding, SVG and MathML, mXSS (noscript, noembed, xmp, srcdoc, template, comments, CDATA,
namespace confusion), CSS (`expression`, `url()`, `@import`, `behavior`, `-moz-binding`, `image-set`), meta refresh, base
href, link rel, forms and `formaction`, object, embed and applet, every image and media source, tables, frames, `ping`,
protocol-relative URLs, legacy attributes. Some are unclosed on purpose and swallow what follows them.

`vectors(hitBase)` fills `{{HIT}}` with `hitBase + "/" + name` and `{{HIT//}}` with the same less its scheme, so with
`http://127.0.0.1:PORT/hit` a browser check counts hits per vector. `vectors.txt`'s header has the format; `{{U+hhhh}}` is
one code point, so the file holds no control bytes.

## The fake provider, and what GreenMail can't do

GreenMail keeps a message as a Jakarta Mail `MimeMessage`. So IMAP serves the raw bytes with the header section's line ends
made CRLF and a blank line added if there was none; the body is untouched (`FakeMailServer.stored(raw)` gives exactly
that). 148 of the 155 hand-written samples come back byte for byte, and so does each generated one the test delivers (the
first 300, mutations aside) whose header is CRLF. The other 7 have bare LF or CR line ends or no blank line in their header
(`empty` and `garbage-binary` among them). SMTP adds `Return-Path` in front. Folders nest with `.`.
UIDVALIDITY is the second a folder was made, which is why `resetUidValidity` waits for the next second; for INBOX it remakes
the whole account, so every folder of that user gets a new one.

**No CONDSTORE or QRESYNC**, as far as checked against 2.1.15 (`FakeMailServerTest.noCondstoreOrQresync` prints the replies):

- `CAPABILITY` answers `IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE SASL-IR AUTH=XOAUTH2 QUOTA`.
- `ENABLE CONDSTORE QRESYNC` gets `BAD Invalid command.`; `SELECT INBOX (CONDSTORE)` gets `BAD`; `FETCH 1 (UID MODSEQ)` gets
  `BAD Invalid fetch attribute: MODSEQ`; `UID FETCH 1:* (FLAGS) (CHANGEDSINCE 1)` gets `BAD`. A plain `SELECT` has no
  `HIGHESTMODSEQ`.
- The jar's IMAP commands are APPEND, AUTHENTICATE, CAPABILITY, CHECK, CLOSE, COPY, CREATE, DELETE, EXAMINE, EXPUNGE, FETCH,
  GETQUOTA, GETQUOTAROOT, IDLE, LIST, LOGIN, LOGOUT, LSUB, MOVE, NOOP, RENAME, SEARCH, SELECT, SETQUOTA, SORT, STATUS,
  STORE, SUBSCRIBE, UID and UNSUBSCRIBE. So no ENABLE, NAMESPACE, ID, UNSELECT, ESEARCH, SPECIAL-USE, COMPRESS or STARTTLS.

So the IMAP builder's CONDSTORE and QRESYNC paths are tested against `FakeImapServer` (below); GreenMail covers the
plain UID and UIDVALIDITY path.

## The fake BlueBubbles server

`FakeBlueBubbles` stands in for a member's own BlueBubbles Server, for the iMessage adapter's tests. The adapter connects out
to it, as it will to the real one, and catches up by time after a wake. Names, envelopes and field names follow the real
server's. Everything is on 127.0.0.1, on ports the system picks. The REST API and the socket are on two ports.

**What it serves:**

- REST under `/api/v1`, with the password as the `guid` query parameter (`password` and `token` work too). A wrong or missing
  one is a 401 with `{"status":401,"message":"Unauthorized","error":{"type":"Authentication Error","error":".."}}`.
- Answers are `{"status":200,"message":"..","data":..}`. Lists add `metadata` (`offset`, `limit`, `total`, `count`).
- Routes: `GET ping`, `GET server/info`, `POST message/query` (`chatGuid`, `with`, `offset`, `limit` capped at 1000, `sort`,
  `after` and `before` as exclusive epoch milliseconds), `GET message/count`, `GET message/{guid}` (with `with`),
  `POST message/text`, `POST chat/query`, `GET chat/{guid}/message`, `GET attachment/{guid}/download`, `GET contact`
  (the Mac's cards: `firstName`, `lastName`, `displayName`, `phoneNumbers` and `emails` as `[{address}]`; 500 while
  `denyContacts(true)`).
- **HTTPS and WSS** with `Options.withTls(FakeTls.serverContext())`: a Mac behind a port forward with its own self-signed
  certificate (Wave 2.6's pin-on-first-connect test). `baseUrl()` and `socketUrl()` then say `https` and `wss`.
- `POST message/text` takes `chatGuid`, `message`, `tempGuid`, `method`, `subject`, `effectId`, `selectedMessageGuid` and
  `partIndex`. `private-api` and replies get a 400 while the Private API is off. An unknown chat is a 400.
- Message and chat JSON have every field of the real ones. `with` decides what is included: `chat`, `chat.participants`,
  `attachment`, `handle`. Without them `handle` is null and `attachments` is empty, as on the real server.
- The socket is Socket.IO v4 over Engine.IO 4, websocket transport only: `socketUrl()` is
  `ws://127.0.0.1:<port>/socket.io/?EIO=4&transport=websocket&guid=<password>`. The server sends `0{..}`, answers `40` with
  `40{"sid":..}`, pings (`2`) every ping interval and closes a socket that doesn't answer `3` in time. A bad password gets
  `44{"message":"Unauthorized"}` and a close.
- Events, on the socket and as webhooks (`{"type":..,"data":..}` to each URL): `new-message`, `updated-message`,
  `message-send-error`, `typing-indicator`, `chat-read-status-changed`, `group-name-change`, `participant-added`,
  `participant-removed`, `participant-left`, `hello-world`.

**The Java API:**

```java
try (FakeBlueBubbles bb = FakeBlueBubbles.start("pw")) {      // or start(Options.defaults("pw").withPing(..).withClock(..))
    String chat = bb.directChat("+15551230001");               // iMessage;-;+15551230001 (also groupChat, addChat)
    bb.setDown(true);                                          // the Mac sleeps: 503s, no sockets
    bb.receive(chat, "+15551230001", "hi", Instant.parse("2026-11-14T10:00:00Z"), new Attachment("a.png", "image/png", bytes));
    bb.setDown(false);
    // the adapter under test: baseUrl(), socketUrl(), password(); then
    bb.sent();  bb.messages();                                 // what it sent, everything held
}
```

Also: `tapback`, `edit` (sets `dateEdited`), `retract` (sets `dateRetracted`, clears the text, emits `updated-message`),
`sendFromPhone` (the member's own message from their iPhone: `isFromMe`), `addContact`, `denyContacts`, `markRead`, `typing`,
`renameGroup`, `addParticipant`, `removeParticipant`, `leave`,
`emit(event, data)`, `addWebhook(URI)`, `webhookFailures()` (a failed post is recorded, never thrown; posts are made before
the causing call returns), `setClock`.

**Faults:** `setDown(boolean)` (REST 503, new sockets refused, open ones closed, nothing emitted; data kept),
`setPrivateApi(boolean)`, `dropSockets()` (closed without a closing handshake), `setLatency(Duration)`, `failNextSends(n)`
(`POST message/text` answers 500 and emits `message-send-error`; nothing is stored), `restart()` (sockets closed, all data
and row numbers kept, same ports). Messages sent through REST also emit `new-message`, with `tempGuid`.

**What it doesn't do:** no Private API features beyond replies and the flag (`effectId` is accepted either way), no FaceTime,
no Find My, no long-polling Engine.IO transport, no attachment upload endpoint (attachments come from `receive`), no
reactions or typing from the client, no edit or unsend through REST. REST and socket are two ports, where the real server
has one.

`FakeBlueBubblesTest` has 20 tests (about 5 s): auth, ping and info, query filters and metadata, catch-up after a sleep,
count, send, chats, attachments, the socket handshake, events, ping and pong, webhooks, down, restart, dropped sockets and
failed sends.

## The fake relay
`FakeRelay` is ma-platform's Courier relay (contract 0.4.0, `docs/contracts/relay.md` on `sub/courier-relay`) in the
test's JVM: one HTTP server on 127.0.0.1, for the desk's `ma` and mail-door transports (Wave 2.5) and the soak.

- **Routes:** every agent route of §3, with its answers and error codes: `PUT` and `GET /v1/agent/keys` (the binding
  checked, small-order box keys refused, 3 changes a UTC day), `GET /v1/agent/keys/lookup` (`address_unknown`,
  `address_closed`, `keys_not_set`, plus addressing, the lookup caps), `GET /v1/agent/courier-addresses`, drops
  (`POST /v1/agent/relay/drops`, its presigned URL being the fake's own `/fake-s3/<dropId>`), `POST /v1/agent/relay/send`
  (`Idempotency-Key`, `unpadded`, `too_large`, `kind_not_allowed`, `drop_missing`, `no_address`, `recipient_full`, the
  send caps), collect (`GET /v1/agent/relay`, oldest first, paged), `ack` and `pending`. The caps are `caps()`, settable.
- **Who's calling:** the access key id in a SigV4 `Authorization` header (`addDesk(deskId, accessKeyId)`), unchecked, so
  deskd's own `AgentClient` works against `baseUrl()` unchanged; or `X-MA-Fake-Desk`, which `RelayClient` sends.
- **Addresses:** `assignAddress` (names never reused; `replace` closes the old one), `closeAddress`, `setDeskKind`
  (a Guild Desk is `desk_kind`, a teen's `courier_teen`), `setConnected` (a push only reaches a connected desk).
- **The push:** `onNotify((deskId, reason) -> ...)` for each `notify relay` (`envelopes` or `address`), on a thread of
  its own.
- **Expiry:** 30 days for `ma`, 90 for `mail`, against `setClock`; unlinked drops after a day.
- **The mail door:** `deliverMail(rcpt, raw, mailFrom, verdicts)` seals the proposed 0.4.1 `mail` payload (draft ADR
  `draft-courier-envelope` §9), signed by `doorKey()`, the raw message inline or in a drop.
- **Faults:** `setDown` (503 with no code), `setPaused` (`courier_paused`), `setLatency`, `loseNextAcks` (an ack answers
  but deletes nothing), `duplicateNextFetches`, `reorderFetches`, `failNextSends`, `swapKeys` (a directory that lies).
- **What it saw:** `seen()` (every request, with its body, for a canary search), `pending`, `keysOf`, `dropCount`.
- **`PeerDesk`** is another member's desk on the fake: its own keys and address, `send` (look up, check the pin, seal,
  send, with a drop for a big body) and `collect` (open, verify against the pin or the door's key, ack).

- **`courier-send` and the door's notes** (proposed for 0.4.1, draft ADR `draft-courier-transports` §9):
  `POST /v1/agent/courier/send` (`from` checked, 1 to 50 recipients, members' addresses refused per recipient, an
  `Idempotency-Key` kept 5 days, `422` for the same key with other bytes), `mailSent()`, `setCourierSend(false)`
  (`no_provider`), `refuseRecipient`, `failNextCourierSends`, `loseNextCourierSendAnswers` (taken, the answer lost);
  `deliveryNote(address, rfcMessageId, recipient, status)` and `removedNote(address, reason)` seal the door's notes;
  the addresses answer carries `doorKeys` (`setDoorKeysServed(false)` to leave them out) and `sending`;
  `inject(address, kind, enc, ct)` puts a raw envelope in a desk's queue. As the door (0.4.1): `raw` up to 4 MiB
  inline (`413 too_large` past it), a larger message through `POST /v1/agent/courier/uploads {bytes}` (up to 25 MiB),
  a presigned PUT of exactly those bytes to `/fake-s3/out/<desk>/<uploadId>` (only the length signed), then
  `{upload: uploadId}`; `409 upload_missing` for one that isn't there; `uploadsMade()`, `uploadsHeld()`,
  `loseNextUploads(n)` (gone once PUT, as one that expired before the send).
- **Drops sign their headers** as staging's do (`Content-Length`, `x-amz-tagging`): an upload without the tagging is
  refused. `RelayClient.upload(url, headers, bytes)` sends what the reservation named.

`FakeRelayTest`: 13 tests. deskd's relay transport runs against it in `courier/relay/RelayTransportTest` and `RelaySoakTest`.

## The soak harness
`soak/` is the launch plan's soak (§7: "7 days on test desks, 100,000 inbound messages across all channels: 0 lost, 0
doubled"), apart from the desk under test.

- **A plan** (`Soak.Plan`): a seed, a count, a duration, the channels, the share sent in bursts of ten, the fault windows
  and how long to settle. `Plan.launchBar(seed)` is the launch plan's: 100,000 over 7 days on `imap`, `door`, `ma` and
  `imessage`, the relay down for an hour and for a day, lost acks, duplicates, the Mac gone a day, a UIDVALIDITY reset,
  the desk stopped and deskd killed.
- **Channels** (`Channels`): each puts one message with a unique marker into a source: `imap` (`FakeMailServer`),
  `door` (`FakeRelay.deliverMail`), `ma` (a `PeerDesk`), `imessage` (`FakeBlueBubbles`).
- **Faults** (`Faults`): `relay-down`, `relay-loses-acks`, `relay-duplicates`, `imessage-gone`, `imap-uidvalidity`, and
  `hook(name, begin, end)` for the desk's own (`desk-stop`, `deskd-kill`, a full disk, a skewed clock).
- **An observer** says which markers the desk holds, and how many times each.
- **The runner** spreads the messages (deterministic for the seed), runs the faults' windows, plans each message in the
  **ledger** before it goes and confirms it after (synced at every line, so a stopped run resumes and still reconciles
  everything), keeps a message its source refused and tries again, settles, then **reports** lost, doubled, unexpected
  and never-sent markers per channel (`report.toJson()`, `report.toMarkdown()`). It passes only with all four at 0.

`SoakSelfTest` is the harness's own proof: 2,000 messages over 20 s through every fake and every source-side fault,
into a stand-in desk of simple reference readers (IMAP by UID, the relay's collect-open-ack, BlueBubbles by time) that
store each message once, passes; a desk that doubles, loses or invents one fails, naming the markers; so does a message no
source takes; and a run stopped mid-way resumes from its ledger. 5 tests, about 70 s.

**The real run (CR-4.1, running since Nov 15):** deskd's `CourierStagingSoak` (test sources, `courier/relay/`) runs two staging
test desks of deskd's own Courier code on the real staging relay and mail door, with the member, door-inbound and
door-outbound channels and faults made on the desks' side (`FaultyLinks`); setup `services/deskd/e2e/courier-soak.mjs`,
unattended by `courier-soak-watchdog.sh`; status in ma-platform `docs/sub-status/courier-soak.md`. `Runner.anchoredAt(origin)`
keeps a run that restarts over days on its first start's clock: what fell due goes at once, an open fault window is applied
again, a closed one is never repeated. Linked mailboxes at real providers and iMessage wait for the owner's test mailboxes
and the test Mac (D4).

## The scripted fakes: `FakeImapServer` and `FakeSmtpServer`

GreenMail has no CONDSTORE, QRESYNC, ENABLE, SPECIAL-USE, ESEARCH or Gmail extensions and no fault injection, so wave 2.1's
client is tested against these two instead. Both are JDK only (no GreenMail classes), listen on 127.0.0.1 on a port the
system picks, run one virtual thread per connection, and are thread-safe from the test's side. Changes made through the
test API reach clients as another client's would.

```java
try (FakeImapServer imap = FakeImapServer.start(FakeImapServer.Options.defaults().tls(true));   // or Options.gmail()
     FakeSmtpServer smtp = FakeSmtpServer.start(FakeSmtpServer.Options.implicitTls())) {       // or startTls()
    imap.addUser("owner@example.com", "secret");
    smtp.addUser("owner@example.com", "secret");
    smtp.onMessage(r -> imap.deliver(r.login(), "Sent", r.data(), Set.of("\\Seen"), null));   // Gmail saves sent mail
    long uid = imap.deliver("owner@example.com", "INBOX", raw, Set.of(), Instant.now());
    imap.deliver("owner@example.com", "INBOX", size, () -> bytesFor(seed, n), Set.of(), when); // lazy: no bytes held
    // Point the client at 127.0.0.1:imap.port() and smtp.port(), trusting FakeTls.clientContext().
    imap.setFlags("owner@example.com", "INBOX", uid, Set.of("\\Seen"));
    imap.expunge("owner@example.com", "INBOX", uid);                  // sessions see EXPUNGE, or VANISHED with QRESYNC on
    imap.failNext("UID FETCH", 2, "NO [THROTTLED] slow down");
}
```

### TLS

`FakeTls` reads GreenMail's bundled PKCS#12 keystore `greenmail.p12` (resource in `greenmail-2.1.15.jar`), password
`changeit` for the store and the key, alias `greenmail`. The certificate is self-signed, `CN=GreenMail selfsigned Test
Certificate, OU=GreenMail, O=Icegreen Technologies, C=US`, valid 2026-10-25 to 2029-01-27, **with no subject alternative
names**: a client must trust it (`FakeTls.clientContext()` trusts it and nothing else, `FakeTls.certificate()` is the
certificate) and must not check the host name against it (an `SSLSocket`'s default; Jakarta Mail's
`mail.imaps.ssl.checkserveridentity=false`). `Options.sslContext(ctx)` serves another certificate, for a client that has to
check names. The key is public: tests only.

### `FakeImapServer`

`FakeImapServer.start(Options)`, `port()`, `close()`. `Options.defaults()` advertises every capability but `LOGINDISABLED`
and `X-GM-EXT-1`; `Options.gmail()` adds `X-GM-EXT-1`; `.with(...)`, `.without(...)`, `.only(...)`, `.tls(true)` (implicit
TLS), `.defaultFolders(...)`, `.maxLineLength(n)` (64 KiB), `.maxLiteral(n)` (64 MiB). The capabilities, each off-able, are
`IDLE`, `UIDPLUS`, `MOVE`, `CONDSTORE`, `QRESYNC` (which brings `ENABLE` and `CONDSTORE`), `ENABLE`, `SPECIAL_USE`,
`ESEARCH`, `LITERAL_PLUS`, `SASL_IR`, `X_GM_EXT_1`, `ID`, `NAMESPACE`, `AUTH_PLAIN` and `LOGINDISABLED`. One that's off
isn't advertised and its commands and arguments answer BAD, as on a server without it. `UNSELECT` and `CHILDREN` are always
on. Once authenticated, the capability list drops `AUTH=PLAIN`, `SASL-IR` and `LOGINDISABLED`, and LOGIN's tagged OK carries
the new list.

**Commands:** CAPABILITY, NOOP, LOGOUT, LOGIN (atoms, quoted strings, literals), AUTHENTICATE PLAIN (with SASL-IR's initial
response or after `+ `), ENABLE (`* ENABLED ...`), ID, NAMESPACE (`(("" "/")) NIL NIL`), LIST and LSUB (`*`, `%`, a
reference, `LIST (SPECIAL-USE) "" "*"`, `RETURN (SPECIAL-USE)`, `\HasChildren`/`\HasNoChildren`, `\Noselect`, special-use
attributes whenever SPECIAL-USE is on), STATUS (MESSAGES, RECENT, UIDNEXT, UIDVALIDITY, UNSEEN, HIGHESTMODSEQ), SELECT and
EXAMINE (plain, `(CONDSTORE)`, `(QRESYNC (uidvalidity modseq [known-uids [seq-match]]))`), CREATE, DELETE, SUBSCRIBE and
UNSUBSCRIBE (no-ops), CHECK, CLOSE (expunges quietly), UNSELECT, FETCH and UID FETCH, STORE and UID STORE, SEARCH and UID
SEARCH, COPY and UID COPY, MOVE and UID MOVE, EXPUNGE and UID EXPUNGE, APPEND (flags, date-time, `{n}` and `{n+}`), IDLE.
Anything else, STARTTLS included, is BAD.

- **FETCH:** UID, FLAGS, RFC822.SIZE, INTERNALDATE, MODSEQ, FAST, RFC822, RFC822.HEADER, RFC822.TEXT, `BODY[]`,
  `BODY[HEADER]`, `BODY[TEXT]`, `BODY[HEADER.FIELDS (...)]` and `.NOT` (the matching lines with their continuations, then a
  blank line), each with `.PEEK` and a `<start.length>` partial, and in Gmail mode X-GM-MSGID, X-GM-THRID and X-GM-LABELS.
  Bodies are literals of the exact bytes. `BODY[]` without PEEK on a read-write folder sets `\Seen`, bumps the MODSEQ and
  adds FLAGS (and MODSEQ) to the response. A UID command's responses lead with UID. Modifiers `(CHANGEDSINCE n)` and, on UID
  FETCH with QRESYNC enabled, `(CHANGEDSINCE n VANISHED)` (`* VANISHED (EARLIER)` first). Sequence sets take `*`, ranges in
  either order and lists; a message number past the count is BAD, a UID that isn't there is just left out, and `n:*` with
  n past the highest UID still names the highest, as RFC 3501 says.
- **STORE:** `FLAGS`, `+FLAGS`, `-FLAGS`, each `.SILENT`; `(UNCHANGEDSINCE n)` answers `OK [MODIFIED set]` for those it
  skipped; Gmail mode's `X-GM-LABELS`, `+X-GM-LABELS`, `-X-GM-LABELS` with atoms, quoted strings or literals. A change bumps
  the folder's HIGHESTMODSEQ and gives the message that MODSEQ; a STORE that changes nothing changes no MODSEQ. Once
  CONDSTORE is enabled (ENABLE, `SELECT (CONDSTORE)`, a MODSEQ fetch, CHANGEDSINCE, UNCHANGEDSINCE, STATUS HIGHESTMODSEQ or
  SEARCH MODSEQ) every FETCH with FLAGS carries MODSEQ, and a `.SILENT` change still answers `(UID n MODSEQ (m))`.
- **SEARCH:** ALL, a message set, `UID set`, SINCE, BEFORE, ON (by INTERNALDATE's date), HEADER (substring, any case, of
  the unfolded value; no encoded-word decoding), FROM, TO, CC, BCC, SUBJECT, BODY, TEXT, the flag keys (SEEN, UNSEEN, DELETED,
  UNDELETED, FLAGGED, ANSWERED, DRAFT and their UN- forms, KEYWORD, UNKEYWORD; NEW and RECENT match nothing, OLD
  everything), LARGER, SMALLER, NOT, OR, parentheses, MODSEQ (with `(MODSEQ n)` added), X-GM-MSGID, X-GM-THRID,
  X-GM-LABELS; CHARSET UTF-8 or US-ASCII. With ESEARCH, `RETURN (MIN MAX COUNT ALL)` (`()` is ALL) answers `* ESEARCH (TAG
  "t") [UID] ...` in the order asked, ALL as a compact set.
- **COPY and MOVE:** `[COPYUID uidvalidity source-set target-set]` with UIDPLUS (tagged for COPY; for MOVE an untagged
  `* OK [COPYUID ...]` before the EXPUNGEs or VANISHED). A missing target is `NO [TRYCREATE]`. APPEND answers `[APPENDUID
  uidvalidity uid]`; `appended(login)` lists each APPEND.
- **Pushed changes:** a session with a folder selected is told of every change by another session or the test API, at
  once in IDLE, else before the next command's tagged response (NOOP included): new messages as `* n EXISTS`, flag and label
  changes as `* n FETCH (UID u FLAGS (...) [MODSEQ (m)] [X-GM-LABELS (...)])`, expunges as `* n EXPUNGE`, or `* VANISHED
  uids` once QRESYNC is enabled. Expunges wait during FETCH, STORE and SEARCH by message number (RFC 3501 7.4.1), and message
  numbers stay as the session knows them; a message expunged and not yet told is left out of such a FETCH (RFC 2180 4.1).
- **QRESYNC:** every expunge keeps a tombstone with its MODSEQ, so `SELECT ... (QRESYNC (v m [known]))` answers `* VANISHED
  (EARLIER)` for UIDs expunged after m (only known ones, if listed) and `* n FETCH (UID u FLAGS (...) MODSEQ (x))` for every
  message changed or added after m; with another UIDVALIDITY it's a plain SELECT. QRESYNC data needs `ENABLE QRESYNC` first
  (else BAD). Switching folders with QRESYNC advertised says `* OK [CLOSED]`. EXPUNGE, UID EXPUNGE and MOVE answer `OK
  [HIGHESTMODSEQ n]` with QRESYNC enabled.
- **Limits:** a command line over `maxLineLength` gets `* BYE Command line too long`; a synchronizing literal over
  `maxLiteral` gets `NO [TOOBIG]` without the `+`, a non-synchronizing one `* BYE [TOOBIG]`; `{n+}` with LITERAL+ off is
  read and answered BAD.
- **Not implemented:** ENVELOPE, BODYSTRUCTURE, bare BODY, ALL and FULL, part numbers (`BODY[1]`, `MIME`), BINARY, RENAME,
  STARTTLS, COMPRESS, UTF8=ACCEPT, LIST-EXTENDED beyond the above (several patterns, LIST-STATUS), NOTIFY, QUOTA, ACLs,
  SEARCHRES, SORT, THREAD, X-GM-RAW, `\Recent` (always 0), SENTBEFORE/SENTON/SENTSINCE, and seq-match-data, which is read
  and ignored. All answer BAD.

**Users and folders.** `addUser(login, password)` gives INBOX plus `Options.defaultFolders`: Sent (`\Sent`), Drafts
(`\Drafts`), Junk (`\Junk`), Trash (`\Trash`) and Archive (`\Archive`). `addFolder(login, name, attributes...)` makes a folder
and any missing parent as `\Noselect` (`/` between levels). Names are given and returned decoded; the wire has modified UTF-7
(`Réunions` is `R&AOk-unions`). Each folder has its own UIDVALIDITY (a counter from the clock's seconds), UIDNEXT and
HIGHESTMODSEQ (1 when empty; every add, change and expunge takes the next). Flags are kept system flags first in RFC 3501's
order, then keywords as given.

**Test-side API** (all thread-safe): `deliver(login, folder, raw, flags, internalDate)` and `deliver(login, folder, size,
supplier, flags, internalDate)` (lazy: the supplier is called each time the bytes are needed and must give exactly `size`
bytes; RFC822.SIZE is `size`) return the UID; a folder that isn't there is made. `setFlags(login, folder, uid, flags)`,
`labels(login, allMailUid, labels...)`, `labels(login, folder, uid, labels)`, `gmailThread(login, folder, uid, thrId)`,
`expunge(login, folder, uid)`, `move(login, folder, uid, toFolder)` (the new UID), `resetUidValidity(login, folder)` (the
new UIDVALIDITY: messages renumbered from 1 with the same bytes, flags, labels and dates; sessions with it selected get `*
BYE Mailbox UIDVALIDITY changed` and are closed, as Dovecot does), `messages(login, folder)` (uid, flags, labels, gmMsgId,
gmThrId, modSeq, size, internalDate, `bytes()`), `folders(login)`, `folder(login, name)`, `appended(login)`. Counters:
`commands()` and `commandCount(name)` (by name, `UID FETCH` apart from `FETCH`), `bytesServed()`, `connectionsOpened()`,
`connectionsOpen()`, `logins()`. A 50,000-message lazy mailbox of 1 GB costs about 10 MB of heap, and `UID FETCH 1:* (UID
RFC822.SIZE)` over it takes under 100 ms here (`FakeImapServerTest` prints both).

**Faults** (thread-safe, for traffic from then on; `clearFaults()` ends them all):

| Call | Effect |
|---|---|
| `dropConnections()` | Every connection closed now with a TCP reset, no BYE |
| `byeConnections(text)` | `* BYE <text>` on every connection, then closed |
| `failNext(command, times, response)` | The next `times` commands of that name get `<tag> <response>`, e.g. `NO [THROTTLED] slow down`, `NO [LIMIT] ...`, `BAD` |
| `failLogin(response)`, `failLogin(response, times)` | LOGIN and AUTHENTICATE get `<tag> <response>` whatever the credentials, e.g. `NO [AUTHENTICATIONFAILED] Invalid credentials` or Gmail's `NO [ALERT] Application-specific password required`; `failLogin(null)` stops |
| `delayResponses(duration)` | Each command's response (and the greeting) waits that long |
| `cutAfterBytes(n)` | One shot: once n more bytes have been written (all connections), the connection writing is reset there, mid-literal or wherever |
| `idleByeAfter(duration)` | Each IDLE from then on ends with `* BYE IDLE timed out` and a close after that long |
| `refuseConnections(duration)`, `acceptConnections()` | The port is closed (connect gets "connection refused") for that long, or until `acceptConnections()`; open connections stay |
| `maxConnectionsPerUser(n)` | A login past n authenticated connections of that user gets `* BYE Too many simultaneous connections` and a close |

**Gmail mode** (`X-GM-EXT-1`). Folders: INBOX, `[Gmail]` (`\Noselect`), `[Gmail]/All Mail` (`\All`), `[Gmail]/Drafts`
(`\Drafts`), `[Gmail]/Important` (`\Important`), `[Gmail]/Sent Mail` (`\Sent`), `[Gmail]/Spam` (`\Junk`), `[Gmail]/Starred`
(`\Flagged`), `[Gmail]/Trash` (`\Trash`), and one per user label. Each user has one set of messages. A message is in exactly
one of All Mail, Spam and Trash, and has a set of labels (`\Inbox`, `\Sent`, `\Draft`, `\Important`, `\Starred` and user
labels, shown in X-GM-LABELS, system ones as `"\\Inbox"`, others as atoms or quoted, in modified UTF-7). Flags are the
message's, the same in every folder. **INBOX and the other label folders are live views**, each with its own UIDs, MODSEQs
and tombstones: a label folder shows the All Mail messages that have its label (INBOX `\Inbox`, Sent Mail `\Sent`, Drafts
`\Draft`, Important `\Important`, Starred `\Starred`, a user label folder that label), so adding a label adds the message
there with a new UID and removing it expunges it there. `\Flagged` and `\Starred` go together. Every label or flag change
bumps the MODSEQ in each folder showing the message. Each message gets a unique X-GM-MSGID (19 digits), kept for life,
across MOVE; X-GM-THRID is its own X-GM-MSGID unless `gmailThread` sets it. Then:

- `deliver` to INBOX or All Mail puts the message in All Mail with `\Inbox` (returning its UID in the folder named); to
  Spam or Trash, there; to a label folder, in All Mail with that label (a new user label gets its folder).
- MOVE (and COPY) to All Mail, Spam or Trash moves the message there: a new UID in the target, gone from the source, the
  X-GM-MSGID kept. To a label folder it adds the label (bringing the message back to All Mail if it was in Spam or Trash).
  MOVE out of a label folder also removes that label; MOVE from All Mail to a label folder leaves it in All Mail.
- APPEND to All Mail, Spam or Trash puts it there; to a label folder, in All Mail with that label.
- EXPUNGE of a `\Deleted` message: from a label folder the label goes; from All Mail or Spam it goes to Trash (`\Deleted`
  cleared); from Trash it's deleted. The test API's `expunge` from All Mail, Spam or Trash deletes it outright.
- CREATE makes a label folder; DELETE of one removes its label from every message. The system folders can't be deleted.

### `FakeSmtpServer`

`FakeSmtpServer.start(Options)`, `port()`, `close()`. `Options.implicitTls()` (TLS from the first byte, as 465),
`Options.startTls()` (plain text, then STARTTLS, as 587) or `Options.plain()`; `.without(Extension...)` for `AUTH` (`AUTH
PLAIN LOGIN`), `SIZE` (`SIZE 35882577` by default, `.maxSize(n)`), `EIGHTBITMIME`, `PIPELINING`, `SMTPUTF8` and `STARTTLS`;
`.requireAuth(false)`; `.hostname(name)`; `.sslContext(ctx)`.

- EHLO lists the extensions on; STARTTLS only in STARTTLS mode before TLS, AUTH only once TLS is up there (any time in the
  other modes). In STARTTLS mode, AUTH and MAIL before TLS get `530 5.7.0 Must issue a STARTTLS command first`. STARTTLS
  forgets EHLO and AUTH, and drops whatever plain text the client sent after it.
- AUTH PLAIN with an initial response or after `334 `, AUTH LOGIN (with or without the user name as initial response;
  `334 VXNlcm5hbWU6`, `334 UGFzc3dvcmQ6`), `*` cancels (501), against `addUser(login, password)`: `235 2.7.0 Accepted` or
  `535 5.7.8 Username and Password not accepted.` MAIL needs AUTH unless `requireAuth(false)` (`530 5.7.0 Authentication
  Required.`).
- MAIL FROM with `SIZE=` (over the limit: 552), `SMTPUTF8`, `BODY=8BITMIME` or `BODY=7BIT` (others, or one whose extension
  is off: 555), RCPT TO, DATA (`354 Go ahead`; a leading dot is removed from each line; the `.` line ends it; over the size:
  552), RSET, NOOP, QUIT, VRFY (252), HELO. Others are 502. Pipelined commands are answered in order.
- `received()` lists each accepted message: `login`, `from`, the `recipients` it accepted, `data` (exactly as sent, dots
  unstuffed, ending with the last line's CRLF, the `.` line not included), `mailParameters`, `tls`, `at`. `onMessage(hook)`
  is called before the 250, so a test can put the message in a `FakeImapServer` user's Sent folder as Gmail does (if it
  throws, the client gets `451 4.3.0` and nothing is kept). Counters: `commands()`, `commandCount(verb)`,
  `connectionsOpened()`, `logins()`.
- **Faults** (`clearFaults()` ends them): `failAt(Stage, times, reply)` replies that line at `MAIL`, `RCPT`, `DATA` (instead
  of 354) or `END_OF_DATA` (after the dot, the message not kept); `failRcpt(address, reply)` for one recipient;
  `dropAfterData(times, keep)` closes the connection after the final dot with no reply, the "did it go?" case, keeping the
  message or not; `delayReplies(duration)`; `refuseAuth(reply)` answers every AUTH with that (e.g. `454 4.7.0 Temporary
  authentication failure`); `dropConnections()`.
- **Not implemented:** CHUNKING/BDAT, DSN, ENHANCEDSTATUSCODES in EHLO (the codes are sent anyway), XOAUTH2, CRAM-MD5,
  relay rules, any delivery.

## Changing it

- **A hand-written sample:** add `<name>.eml` to `src/main/resources/courier-testkit/mime/` (CRLF unless the endings are the
  point; `.gitattributes` there keeps git from touching them) and a row to `expect.tsv`, whose header explains the columns.
  `ExpectationsAgreeTest` will tell you if Jakarta Mail reads it differently.
- **The generator:** `Generator` (families), `Langs` (words and charsets), `Mime` (encoders), `Blobs` (file bodies).
  Any change changes the bytes for every seed: say so in the commit, with the new SHA-256 `MimeCorpusTest` prints. A `READ`
  sample must hold its `Expect` by construction, and `ExpectationsAgreeTest` checks every one.
- **A vector:** add a `== <name>` block to `vectors.txt`, with `alert(` or `{{HIT}}` in it.
- **Run:** `./mvnw -q -pl courier-testkit -am test` from `services/` (86 tests, about 2 minutes; `-Dtest=FakeImapServerTest,FakeSmtpServerTest` for the two scripted fakes alone, 27 tests, a few seconds).
