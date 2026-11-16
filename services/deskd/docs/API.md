# deskd client API

**deskApi 1.0.** For the TypeScript client. Built from design §4.2.3–4.2.7 and `docs/interfaces/desk-runtime.md`. Where they leave a choice open, this file records what deskd does.

Clients reach deskd **only through desk-rtc's WebRTC data channels**. deskd has no network listener: desk-rtc bridges channels 0–5 to it unchanged over a Unix socket. Opening the connection goes through the gateway: Platform's `gateway.md`, `desk-runtime.md` §4.5 for `signal.data`, and §9 here for what deskd checks.

## 1. Channels

All channels use `negotiated: true` with these fixed ids.

| id | Label | Kinds a client may send | Kinds deskd sends |
|---|---|---|---|
| 0 | `ctl` | HELLO, AUTH, ACTIVITY, PING, PONG, CLOSE | HELLO, AUTH, PONG, CLOSE |
| 1 | `rpc` | REQ, SUB, UNSUB, CANCEL | RES, ERR |
| 2 | `events` | None. desk-rtc drops anything sent here | EVT |
| 3 | `collab` | DATA with BIN (§13) | DATA (§13) |
| 4 | `mdoc` | Not served yet. On a guild desk, `commons` (§15) | DATA on a guild desk (§15) |
| 5 | `bulk` | CREDIT. Served: `data.read` transfers (§12) | CHUNK |

Channels 6 (`input`) and 7 (`keys`) use their own binary layout and stop at desk-rtc. They never reach deskd.

Frames on 4 are accepted and dropped for now. On 3, deskd takes DATA with BIN from an `owner` session (§13) and drops anything else. On 5, deskd takes CREDIT for its transfers and drops anything else. Anything sent on 3–5 before HELLO is dropped too.

## 2. Frames

Every message on channels 0–5 is one or more frames of **at most 16384 bytes, header included**.

| Bytes | Field | Notes |
|---|---|---|
| 0 | `ver` | 1 |
| 1 | `kind` | See below |
| 2 | `flags` | bit 0 MORE, bit 1 BIN, bit 2 END. Other bits must be 0 |
| 3 | reserved | 0 |
| 4–7 | `id` | u32 big-endian |
| 8–11 | `seq` | u32 big-endian |
| 12– | payload | UTF-8 JSON unless BIN is set |

| kind | Name | | kind | Name |
|---|---|---|---|---|
| 1 | HELLO | | 9 | ERR |
| 2 | AUTH | | 10 | SUB |
| 3 | ACTIVITY | | 11 | UNSUB |
| 4 | PING | | 12 | EVT |
| 5 | PONG | | 13 | CANCEL |
| 6 | CLOSE | | 14 | DATA |
| 7 | REQ | | 15 | CHUNK |
| 8 | RES | | 16 | CREDIT |

**Rules**
- A wrong `ver`, a set reserved byte, an unknown flag or a frame over 16384 bytes closes the session with 4000.
- A frame with an unknown `kind` is ignored, and clients should do the same.
- JSON readers must ignore unknown fields.
- JSON is camelCase, with RFC 3339 times. There's no compression.

**Fragmentation**
- A message that doesn't fit one frame goes in several. Every frame but the last has MORE.
- All frames of a message have the same `kind`, `id`, `seq` and BIN. A fragment that differs closes the session with 4000.
- END, when used, is only on the last frame.
- Reassemble by (`kind`, `id`) per channel, since frames of different messages interleave. deskd sends one frame of each waiting message in turn, so a short reply passes a long one.
- Send one frame per `send()`, each at most 16384 bytes. Fill non-final frames to 16372 bytes of payload.

**Limits after reassembly**

| Kind | Limit |
|---|---|
| REQ, RES | 1 MiB |
| EVT | 64 KiB |
| DATA | 4 MiB |
| CHUNK | one frame, 16372 bytes |
| All others | 64 KiB |

Also per session: at most 64 incomplete messages per channel, and 5 MiB of incomplete messages in total.

- An oversize REQ, SUB or UNSUB gets `ERR too_large` for that id; the rest of its frames are dropped and the session goes on.
- Any other limit closes the session with 4001.

**Golden vectors:** `services/deskd/src/test/resources/frames/vectors.json` has the bytes and their meaning. deskd's tests check every byte of it. Test the client against the same file:
- `valid`: frames to decode and encode.
- `invalid`: frames to refuse.
- `messages`: payloads and their exact fragments.

## 3. Session flow

### HELLO
Send it first on `ctl` once the channels are open, with `id` 0:

```json
{"deskApi": "1.0", "appVersion": "0.1.0", "resume": {"sessionId": "cs-…", "resumeToken": "…"}}
```

`resume` is optional. deskd answers on `ctl`:

```json
{
  "deskApi": "1.0",
  "sessionId": "cs-…",
  "resumeToken": "…",
  "resumed": false,
  "serverTime": "2026-11-05T04:46:24Z",
  "limits": {
    "maxFrameBytes": 16384, "maxRequestBytes": 1048576, "maxResponseBytes": 1048576,
    "maxEventBytes": 65536, "maxDataBytes": 4194304,
    "maxIncompleteMessagesPerChannel": 64, "maxIncompleteBytes": 5242880,
    "requestsPerSecond": 200, "maxConcurrentRequests": 32, "maxSubscriptions": 64,
    "maxSessions": 4, "resumeWindowSec": 120, "idempotencyRetentionSec": 600
  },
  "service": "deskd",
  "version": "0.1.0",
  "deskId": "d-…",
  "startedAt": "2026-11-05T04:40:00Z",
  "runtime": "java-21"
}
```

- `sessionId` is the one the gateway assigned.
- A different **major** `deskApi`, or none, closes with 4426, and the CLOSE carries deskd's `deskApi`. Reload the bundle. A different minor is fine.
- Before HELLO, only PING and CLOSE are accepted on `ctl`; anything else closes with 4000. A REQ, SUB or UNSUB before HELLO gets `ERR unauthorized`.
- A second HELLO closes with 4000.

### Resume
Used when the old connection is gone and the client opens a **new session**. ICE restart keeps the same session and needs none of this.

Send `resume` with the previous `sessionId` and `resumeToken`. Keep them in memory only.

| Reply | Meaning |
|---|---|
| `resumed: true` | Subscriptions carried over. Subscribe again with `since` (§5): that's what restarts their events. Any you don't ask for again within 2 min are dropped |
| `resumed: false` | Nothing carried over: too late (2 min), a deskd restart, a revocation, CLOSE on `ctl`, a wrong token, or another user. Not an error. Subscribe fresh |

- Tokens are single-use. Every HELLO returns a new one.
- Either way, retry unanswered requests with the same `idem`. Results are kept 10 min, whether or not the resume worked, unless deskd restarted, which loses them (§4).

### PING and PONG
`PING` on `ctl`; deskd answers `PONG` with the same `id` and payload. deskd never closes a session for missing PINGs, so a throttled hidden tab is safe. It goes by ICE consent from desk-rtc. deskd sends no PINGs.

### ACTIVITY
`{"lastInputAt": "2026-11-05T04:46:20Z"}` on `ctl`, at most once a minute while input continues, for input the client handles locally. It feeds the heartbeat and keeps the desk awake. deskd gives no reply. It ignores it from a session whose token allows no input (an `export` one), as desk-rtc does. It ignores a time it can't read, and treats a future time as now. Normal-mode input on channels 6 and 7 is counted by desk-rtc, so don't report it here.

### Token refresh
The usual path is the gateway's `session.refresh`. While the gateway is unreachable, send on `ctl`:

```json
AUTH {"deskToken": "eyJ…"}
```

with an `id` you choose. deskd answers `AUTH` with the same `id`:

```json
{"ok": true, "validUntil": "2026-11-05T04:51:54Z"}
{"ok": false, "code": "invalid_token"}
```

A refused AUTH leaves the session as it was. Without a valid token by `exp + 30 s`, the session closes with 4401. A refresh can also change what the session may do, however it arrives: the new token applies at once, to calls still waiting too, and a subscription it no longer allows ends with an `error` event (§5). While one AUTH is being checked, another gets `code: "rate_limited"`. The rules in §9 apply, including that a token works once. Sending one token both ways is harmless, and useful, because the gateway answers `session.refreshed` even when the desk's link to it is down and it couldn't relay the token: whichever copy arrives second is refused, which changes nothing. An older token arriving late is accepted but doesn't shorten the session, and `validUntil` says so.

### CLOSE
`{"code": 4401, "reason": "token_expired"}` on `ctl`, either way. deskd also tears down the peer connection. Sending CLOSE on `ctl` ends the session with no resume, so use it only when the tab is really done with this desk. `session.close` through the gateway with `closed_by_client` keeps the state for the resume window, so that's the one to use on the way to a new connection.

## 4. RPC

On `rpc`. The client picks each `id`; use a counter per session. REQ, SUB and UNSUB share one id space. An id still in flight gets `ERR bad_request`.

```
REQ {"m": "desk.status.get", "p": {}, "idem": "…", "deadlineMs": 5000}
RES {…result…}
ERR {"code": "not_found", "message": "No such method", "details": {}}
```

- `p` defaults to `{}`. `idem` and `deadlineMs` are optional, except that mutations need `idem`.
- The RES payload is the result object itself. An empty result is `{}`.
- `message` is for logs, not for showing to users. Branch on `code`.
- Replies come in any order.

**Mutations** need `idem` (UUIDv7, at most 128 chars), or they fail with `bad_request`.

**One action keeps one key across every retry.** An action is one thing the member asked for: one paste, one click on Back. Keep its key whatever comes back, and give the next action a new one.
- A repeat with the same key, method and user returns the stored reply without running the handler. The exception is `data.browser.hold` (§12), whose effect lasts only as long as its session: its key also names the session, so a retry from another session runs it again. If the first call is still running, the repeat waits for it.
- Results are kept 10 min on the desk, not on the session, so they survive a lost session. A deskd restart loses them.
- The store is bounded (4096 results, 8 MiB). Under sustained load the oldest can go early, so a very late retry could run again. Use `p.rowVersion` where that matters; it fails with `precondition_failed`.
- **Until a mutation starts applying,** a cancel, a deadline or the session ending stops it, and a retry runs it again.
- **Once it has started,** nothing stops it. A cancel or a deadline still gets its `ERR` at once, but that doesn't say nothing happened. It runs to its end, and a retry with the same key gets the result, waiting for it if it has to. So keep the key, and retry to find out. For `browser.*`, that point is right before the command goes to Chromium.

**What an error says about a mutation:**

| Error | What was done | A retry with the same key |
|---|---|---|
| `unavailable` with no `mayHaveApplied` | Nothing | Runs the method, as deskd doesn't store this one |
| `unavailable`, `internal` or `too_large` with `details.mayHaveApplied: true` | Not known. It started applying, and may have finished or may still finish | Replays this reply, and doesn't run the method again, for as long as deskd keeps it |
| `cancelled`, `deadline_exceeded` | Can't say, as the reply goes before the call ends | Runs the method if it hadn't started. If it had, gets how it ended, which can be any row here or a result |
| Any other error | Nothing | Replays this reply, if the method ran. A request refused before that, by `rate_limited`, `unauthorized` or a malformed request's `bad_request`, isn't stored, and runs the method |

- **No flag means nothing was done,** on every code but `cancelled` and `deadline_exceeded`.
- **`mayHaveApplied` is added to the error's other `details`,** so a `reason` is still there.
- **With `mayHaveApplied`, a new key does it again.** That's harmless for `browser.tab.navigate`, `reload`, `activate` and `close`, but not for `browser.text.insert`, `back`, `forward` or `open`: it types the text twice, goes two steps, or opens a second tab. So for those, show the member what happened and let them decide.
- **A stored refusal is an answer,** so there's nothing to retry. If the member tries again later, that's a new action with a new key.
- **A key only protects while deskd keeps the reply.** After a deskd restart, after 10 min, or once the store has dropped it, the same key finds nothing and runs the method. If the first try got as far as applying, that's a second time, and a client that never got the first reply can't tell. So an unanswered `browser.text.insert`, `back`, `forward` or `open` isn't always safe to retry: after a 4002 or a `resumed: false`, or once 10 min have passed, show the member what happened and let them decide.

**`deadlineMs`** counts from when deskd starts the call. When it passes, deskd sends `ERR deadline_exceeded` and interrupts the handler, unless it's a mutation that has started applying.

**CANCEL** on `rpc`, with `id` set to the request's id and an empty payload. deskd answers that id with `ERR cancelled` and interrupts the handler, unless it's a mutation that has started applying. There's no reply if the request isn't running.

**Limits per session**
- 200 requests per second, counting REQ, SUB and UNSUB. Over it you get `ERR rate_limited`, with `details.limit: "requestsPerSecond"`.
- 32 running at once. Over it you get `ERR rate_limited`, with `details.limit: "concurrentRequests"`.
- After 1000 refusals in a row, the session closes with 4429.
- A flood on `ctl` is ignored at 50 frames per second, and also closes with 4429 after 1000 in a row.

### Error codes
`bad_request`, `unauthorized`, `forbidden`, `step_up_required`, `not_found`, `precondition_failed`, `conflict`, `too_large`, `rate_limited`, `deadline_exceeded`, `cancelled`, `unavailable`, `internal`, and these only `data.*` and `files.*` give: `invalid` and `too_many` (§12, §16), and five only `files.*` gives: `exists`, `no_space`, `check_required`, `check_invalid` and `hash_mismatch` (§16).

`internal` always has the fixed message `Internal error`.

**Scope.** Each method says which token scopes may call it (§9). Today that's only the owner's, except `desk.status.get` and `data.*`, which an `export` session may call too (`files.*` is the owner's alone, §16), and on a guild desk what §15 lists for a `guild_member` session. Anything else from an `export` session, a method that doesn't exist included, gets `forbidden` with `{reason: "scope"}`, and so do its SUB and UNSUB. It's checked before anything else about the method, `idem` included, and isn't stored.

### Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `desk.status.get` | No | None | `{deskId, deskdVersion, rtcVersion, bootId, uptimeSec, javaVersion, instanceType}` |
| `desk.attention.set` | No | `{seen, device?}`: `true` or `false`; `device` on a phone, §10 "On a phone" | `{seen, frozen}`: the desk's, §10 |
| `browser.stream.set` | No | `{state}`: `live`, `warm` or `off` | `{state}` |
| `browser.tab.list` | No | None | `{tabs}` |
| `browser.tab.navigate` | Yes | `{url, tabId?}` | `{tabId, netError?}` |
| `browser.tab.back`, `browser.tab.forward`, `browser.tab.reload` | Yes | `{tabId?}` | `{tabId}` |
| `browser.tab.activate` | Yes | `{tabId}` | `{tabId}` |
| `browser.tab.open` | Yes | `{url?}` | `{tabId}` |
| `browser.tab.close` | Yes | `{tabId}` | `{}` |
| `browser.text.insert` | Yes | `{text, tabId?}` | `{}` |
| `browser.pinch` | Yes | `{x, y, scale}` | `{}` |
| `browser.field.at` | No | `{x, y}` | `{field}`: `{kind, enterKey}` or null |
| `browser.clipboard.write` | No | `{text}` | `{}` |
| `browser.clipboard.read` | No | None | `{text}`: a string, or null |
| `browser.import` | Yes | `{kind: "bookmarks", path}`, `path` a Files path. `kind: "passwords"` is refused, `bad_request` `{reason: "use_upload"}` | `{kind, found, added, alreadySaved, refused, folderId}`, §10 "Signing in" |
| `browser.import.begin` | Yes, of this session (as `files.upload.begin`) | `{kind: "passwords", size}`, `size` 1 to 2 MiB | `{uploadId, transferId, window, size}`, then the file's bytes on `bulk`, §10 "Signing in" |
| `browser.import.finish` | Yes | `{uploadId}` | `{kind, found, added, alreadySaved, refused, notAdded}`, §10 "Signing in" |
| `browser.import.abort` | Yes | `{uploadId}` | `{}` |
| `browser.bookmarks.list` | No | `{folderId?, offset?}` | `{folder, items, more}` |
| `browser.extensions.list` | No | None | `{extensions}` |
| `browser.extension.open` | Yes | `{id}` | `{tabId, page}` |
| `browser.extension.close` | Yes | `{id}` | `{closed}` |
| `agent.*` | | | §11 (§18 for tools and approvals; §23 for Maia Mode's `agent.maia.*` and `agent.usage.summary`) |
| `notebook.*` | | | §13 |
| `data.parts.list`, `data.manifest`, `data.read`, `data.read.stop`, `data.browser.hold`, `data.browser.release`, `data.browser.cookies` | Only hold and release | §12 | §12 |
| `browser.minified.*`: `get`, `act`, `image`, `island`, `site.get`, `site.set`, `sites.list`, `sites.clear` | Only `act` | §14 | §14 |
| `browser.adblock.site.set` | Yes | §14 | §14 |
| `apps.*`: `list`, `catalog.get`, `install`, `remove`, `start`, `stop`, `view.get`, `call`, `mutate` | Only `install`, `remove` and `mutate` | §19 | §19 |
| `courier.*` | Those that change something | §21 | §21 |
| `todo.*`: `list`, `get`, `summary`, `changes`, `export`, `add`, `update`, `close`, `reopen`, `snooze`, `pin`, `answer`, `trash`, `restore`, `undo`, `seen` | All but `list`, `get`, `summary`, `changes` and `export` | §22 | §22 |

For `desk.status.get`, every field is always present. No session can reach it before deskd has read IMDS and desk-rtc has answered, so none of them is null in practice. §10 has the `browser.*` methods, §11 the `agent.*` ones and §12 the `data.*` ones and §16 the `files.*` ones.

## 5. Subscriptions

The topics served today are `desk.attention`, `browser.tabs`, `browser.clipboard`, `browser.links` and `browser.view` (§10), `browser.minified:<tabId>` (§14), `agent.state` and `agent.conversation:<agentId>` (§11), `agent.desks.outbox` (§18), `agent.maia` (§23), `notebook.tree` (§13), `files.changes` (§16), `desk.contention` (§17), `apps` and `app:<id>:<topic>` (§19), `courier.changed` (§21), and `todo` (§22). Any other SUB returns `not_found` for now, and so does `browser.clipboard` on a deskd older than the clipboard. The next stages add the others in design §4.2.5. Every topic is the owner's, except the three a guild member may have (§15) and the apps' (§19): an `export` session's SUB gets `forbidden` with `{reason: "scope"}`, and so does a guild member's to any other.

```
SUB   id=N  {"topic": "summary", "params": {}, "since": 41}
RES   id=N  {"subId": 9, "seq": 41}
UNSUB id=M  {"subId": 9}
RES   id=M  {}
EVT   id=9  seq=42  {"type": "patch", "data": {…}}
```

- `seq` in the SUB reply is the subscription's latest. The next event has a higher one.
- With no `since`, or a `since` deskd can't serve, the first event is `{"type": "snapshot", "data": {…}}`. Replace your state with it.
- With a `since` it can serve, events after `since` come first, and no snapshot.
- **Channels aren't ordered against each other**, so an EVT can arrive before the RES of its SUB. Buffer events for a `subId` you don't know yet.
- SUB with the same `topic` and `params` as a live subscription of this session returns the same `subId`. So a client must never UNSUB an id that another of its SUBs may have been given: one that drops a topic while its SUB is still on its way, and wants it again before the reply, keeps that one subscription and asks again for a fresh snapshot (the Desk app's `rtc/subs.ts`, `sub/mm-fix-bundle-2`: release 3 found an open Agent window deaf after a restart of deskd, its new client's subscription ended by the old one's late UNSUB).
- At most 64 per session; past that, `ERR rate_limited`, with `details.limit: "subscriptions"`.
- A `topic` is 1 to 256 characters with no control character (`U+0000` to `U+001F`, `U+007F` to `U+009F`), or `ERR bad_request` before any topic is looked up (audit Z29).

**Event types deskd adds itself**

| Type | Meaning | Do |
|---|---|---|
| `snapshot` | Current state | Replace yours. `seq` may have jumped since the last event |
| `resync` | A stream fell behind and events were dropped. It repeats the latest `seq` | SUB again with `since` set to the last `seq` you processed. Replay or a snapshot follows |
| `error` | `data.code` says what failed. The subscription is dead. `forbidden` means a token refresh took away what it needs | SUB again later |

**If the client falls behind** (the session's event backlog passes 1 MiB), a coalescible topic stops sending deltas and sends one fresh `snapshot` once the backlog drains. A stream (agent run, chat) buffers up to 256 KiB and then gets `resync`. So:
- A delta published while a snapshot is being made follows that snapshot, and may repeat a change already in it. Apply patches so that repeats are harmless.
- deskd keeps recent stream events (up to 512 KiB per subscription and 1 MiB per session). Older than that, `since` gets a snapshot.

## 6. Flow control
Flow control is your own `bufferedAmount` handling (design §4.2.6). Between desk-rtc and deskd there's per-channel credit that clients never see: when deskd is behind on a channel, desk-rtc stops reading that channel, and SCTP pushes back on your send. A slow `bulk` doesn't hold up `ctl`, because deskd handles each channel on its own.

The other way too: if you stop reading a channel, deskd queues up to 3 MiB or 4096 messages of replies on it, and then stops handling what you send on that channel until you read again. The session stays open, and your sends on it stall once SCTP pushes back. So keep reading `ctl` and `rpc`, or a PING or a request can wait behind replies you haven't taken.

## 7. Close codes

| Code | Reason | Meaning | Client |
|---|---|---|---|
| 1000 | `closed_by_client`, `client_gone`, `desk_disconnected`, or another reason from the gateway | The gateway ended the session and nothing went wrong | Open a new one if you still want it. After `closed_by_client` or `client_gone`, HELLO `resume` still works |
| 4000 | `protocol_error` | Bad frame, JSON or sequence | A bug. Reconnect, and log it |
| 4001 | `too_large` | A limit on incomplete messages or non-request size | A bug. Reconnect, and log it |
| 4002 | `deskd_restarting` | deskd is restarting, and as far as it knows the desk isn't stopping | Reconnect straight away, with normal backoff (the web client's first retry is at about 2 s, design §4.2.7). Expect a new session: neither resume state nor kept results survive a restart (§4) |
| 4003 | `internal`, or the refusal's code after a refused offer | deskd failed on this session | Reconnect |
| 4401 | `token_expired`, `revoked` | No valid token, or revoked | Get a new token through `connect` |
| 4403 | `identity_mismatch`, `closed_by_desk` | Forbidden | Don't retry |
| 4409 | `replaced` | A newer session from this tab | Stop using this one |
| 4426 | `desk_api_mismatch` | Different major `deskApi` | Reload the bundle |
| 4429 | `rate_limited` | Kept going past the limits | Back off, then reconnect |
| 4503 | `desk_stopping` | The desk is stopping, or an older deskd is restarting (see below) | Check `connect {start: false}` (design §4.2.7), and stop retrying only once it or `desk.state` reports `stopping` or `stopped` |

**4503 only means a stop deskd knows about.** deskd sends it when it has seen `prepare_stop` in a heartbeat response since it started, or when the gateway closes the session with `desk_stopping`. On any other SIGTERM it sends 4002, and `session.closed` from the gateway says `closed_by_desk`, because `deskd_restarting` isn't on `gateway.md` §2.3's list. So a stop with no `prepare_stop` looks like a restart. Learn that a desk stopped from `connect` or `desk.state`, not from 4503 alone: a deskd of an older release sends 4503 on every SIGTERM, so the update away from it still does.

`session.reject` codes from the gateway are separate: `invalid_token`, `wrong_desk`, `session_limit_reached`, `desk_not_ready`.

## 8. Not built yet
- `collab` and `mdoc` are the owner's alone: DATA from an `export` session on either is dropped before any module sees it. `bulk` is open to `export` sessions, for `data.read`.
- DATA serves `collab` (§13), and is reserved for `mdoc` (design §4.2.5), which nothing serves yet. CHUNK and CREDIT serve `bulk`'s `data.read` (§12), and no other use of `bulk` exists yet.
- Support scope and step-up: a `support` token is refused for now, and `step_up_required` exists as a code only.

## 9. What deskd checks before a session exists

Nothing is allocated for a session that fails any of these. A token is checked on `session.open`, `session.refresh` and AUTH.

| Check | Failure |
|---|---|
| Header: `alg` ES256, `typ` exactly `ma-desk+jwt`, `kid` in Platform's JWKS | `invalid_token` |
| Signature, and `iss` equal to config's `endpoints.issuer` | `invalid_token` |
| `aud` is this desk (a string, never an array), and `ma_owner` is its owner | `wrong_desk` |
| `nbf − 30 s ≤ now < exp + 30 s`, `exp − iat ≤ 300` | `invalid_token` |
| `scope` is `owner` or `export`, and `sub` is the owner either way | `invalid_token` |
| Not revoked by `sid`, user or `tokensValidAfter` | `invalid_token` |
| `cnf.x5t#S256` is 32 bytes of base64url | `invalid_token` |
| `jti` not seen before | `invalid_token` |
| deskd has read IMDS and has config and signing keys, and desk-rtc is configured | `desk_not_ready`, which is worth retrying |

- **desk-rtc not up yet:** a desk whose desk-rtc isn't configured 30 s into a boot says hello anyway, with the identity desk-rtc had on an earlier boot, so the Platform hears it and its heartbeat says `rtc: failing`. `connect` can then answer the desk as running while `session.open` still gets `desk_not_ready`. Keep retrying it as you do now; it works once desk-rtc is up, with no new token flow.
- **A token works once.** Every `session.open` and every refresh needs one deskd hasn't seen. Platform's docs say any unexpired token may open a session, which holds for the gateway. So after `session.reject` with `invalid_token`, call `connect` and try again with the new token, as `errors.md` says to. A token refused for another reason isn't used up, so after `session_limit_reached` the same token can try again.
- **A refresh must keep `sub`, `sid`, `scope` and `cnf`.** A refused one needs no answer: the session carries on until `exp + 30 s`. So an `export` session stays one, and can't become the owner's.
- **`export` is for taking the owner's data away** (§12): the closed account's export window and the transfer script get it. Its session has `video: false` and `input: false`, so desk-rtc sends it no media and takes no input from it, and it may call only `desk.status.get` and `data.*` (§4, Scope). Resuming needs the same scope. A new session from the same tab with the other scope doesn't replace this one: both stay open, and each counts toward the desk's 4. A deskd before §12 refuses an `export` token with `invalid_token`. `support` is still refused.

**The offer**, in `signal`, is valid only if it has at least one `a=fingerprint` line and every such line is sha-256 and equals the token's `cnf`, compared as bytes. That also goes for an offer with `restart: true`.

**Refusals.** `signal.data` is then `{"type":"refusal","code":…,"message":…}`, followed by `session.closed`, whatever the code. So a failed ICE restart also ends the session; start a new connection and use HELLO `resume`. `code` is `identity_mismatch`, `bad_state` (a second offer without `restart`, or `restart` before an answer), `unknown_session`, `internal`, or one of desk-rtc's (`not_configured`, `session_limit_reached`, `bad_offer`). `session.closed`'s reason is `identity_mismatch` for a fingerprint, and otherwise `closed_by_desk`.

## 10. The Browser

Milestone 2: see and drive a real Chromium on the desk (`desk-runtime.md` §8, ADR 0041). This is the only way a client reaches Chromium. No method exposes CDP or runs script in a page. deskd itself asks a page one fixed question, whether it's on screen, in an isolated world the page can't touch, and on a teen's desk it reads and replaces Chromium's own error page the same way ("A teen's filtered sites", below). On any desk, it sends the policy's blocked page for the member's own office on to the portal, from that same world ("The office in the Browser", below). A desk nobody looks at encodes nothing, and its Chromium freezes once nothing works it ("Nobody looking", below). The simplified view (§14), on with a kill switch, runs its own constant scripts in a world of its own, and so does the phone view ("On a phone", below). To tell when a page is refused protected playback, deskd also puts one fixed script in each tab's page, and listens for it in that same isolated world ("A protected video that can't play", below). Snapshots, downloads, file upload and agent tabs aren't built yet. Bringing passwords and bookmarks in, and the key button, are "Signing in", below: they run only Chromium's own constant functions, in hidden pages of Chromium's own.

### The stream

`browser.stream.set {state}` says what this session wants. deskd keeps one state for the desk, from what every session wants.

| `state` | Use it when | deskd does |
|---|---|---|
| `live` | Browser visible, normal mode | Starts `desk-browser`, starts `desk-stream`, then sends media to this session. The token must allow video. While nobody looks at the desk, it's held at what `warm` costs ("Nobody looking", below) |
| `warm` | Browser visible, minified mode | Starts `desk-stream`, and sends this session no media. The pipeline waits, paused, so `live` is quick |
| `off` | No Browser window visible | Cuts this session's media, then stops `desk-stream` if no session wants `live` or `warm`. Xorg keeps running, and Chromium freezes once nothing works it |

**What each state runs.** `live` with a session getting media: `desk-stream`'s pipeline is playing, capturing `:99` at 60 fps, dropping unchanged frames down to a 10 fps heartbeat, and encoding H.264 and Opus. That's about a quarter of a core on a still page (`spikes/shared-hosts-test3`). `warm`, and `live` with nobody getting media: the process is up and its pipeline paused, so its live sources make nothing and nothing is captured or encoded. About 0 CPU and 32 to 57 MB (`docs/benchmarks/2026-11-real-stack.md`). Back to `live` from there takes 74 to 98 ms p50. `off`: no `desk-stream`, and a `live` starts it, 287 to 291 ms p50 to a first frame on `c7g.large` and 374 to 385 ms on `t4g.medium`. Chromium is the same in all three.

- **The result** is `{state}`: this session's state when the units got there. It can differ from what you asked if you've since asked for something else. So the last request wins, and an earlier one is answered with the state that now applies.
- **It needs no `idem`,** since setting a state twice is harmless. Sending `live` again also starts any unit that has stopped by itself.
- **Send a `deadlineMs` of about 35 s or more.** A unit can take that long (a stop of the Browser's Chromium up to about 80 s, which `deskd` allows 95 s), and a request may wait for one already under way. If you stop waiting, the work carries on and your state stands: don't send it again just for that. Media can start before the reply.
- **A session ending counts as `off`,** whichever way it ended, and its media is cut at once. After a resume, a new connection asks again.
- **Media arrives over the tracks already negotiated.** Nothing renegotiates (`desk-runtime.md` §8.5).
- **A desk that becomes a teen's restarts Chromium at once,** so it comes back under the teen policy (`age.md` §8). The session's state doesn't change, the picture shows the desk without its Browser for a few seconds, `browser.tabs` goes quiet and then gives a new list with new `tabId`s, and calls get `unavailable` with `reason: chromium` until then. Tabs, cookies and history carry over (ADR 0035). A hold makes it wait for the release (§12). **From teen (or a band not yet known) to adult,** once the band's file says `adult`, Chromium restarts the same way at the first moment no session wants `live` or waits on a start, the simplified view isn't in use, and no hold or other restart is under way, so it comes back with the adult allowlist (the teen lock is stricter, so it's safe meanwhile); or its next start from down does it, whichever comes first. A Chromium that's down isn't touched. `live` is never refused for it: one that comes during its stop starts after it. A restart owed when deskd stops (its stop hadn't worked yet, or nobody had left the Browser yet) outlives the restart of deskd, in `/data/desk/browser-lock-owed` or `browser-unlock-owed` beside `age-band`, deskd's own directory that only deskd writes (never `/run/desk`, which `rtc` can write). Each holds this boot's id (`/proc/sys/kernel/random/boot_id`) and a newline, so one from another boot (before a reboot, which Chromium doesn't outlive, or carried by a restore, a move or an export) counts for nothing and is removed, as is anything else at those names. The next deskd of the boot does it: the teen one at once, with `live` refused `age_band` until its stop has worked. Every one goes through desk-units' stop and start of `desk-browser`, as before, and never touches `/data/browser/profile`.
- **How deskd knows the band** (`age.md` §8). An explicit `ageBand` of `teen` or `adult`, on `GET /v1/agent/config` or in hello's copy of the config, is the band, and deskd writes it to `/data/desk/age-band` for the image: `teen` takes effect at once, and only `adult` brings a teen's desk down. **A config with no `ageBand` never lowers the band and never writes the file** (the Security Analyst's `TD-2`): the last explicit answer since deskd started stands, or else the file's, so a teen's desk stays a teen's through a Platform that drops the field. A desk with neither (no word and no file) is an adult's, as before, and `adult\n` is written, with one log line saying the band came from the default. A file that says `adult` stays `adult` on a config with no field. A file that's there and isn't exactly `teen\n` or `adult\n`, or can't be read, counts as `teen` until an explicit answer, failing closed as the image does; only no file at all is unknown. Any other value, a null included, changes nothing. The log has the band and whether it changed, never an account.

| Error | `details` | Meaning |
|---|---|---|
| `forbidden` | `{reason: "permission"}` | `live` with a token that doesn't allow video |
| `bad_request` | `{reason: "state"}` | Not one of the three |
| `unavailable` | `{unit, code}` | A unit failed. `unit` is `desk-browser` or `desk-stream`. `code` is `denied`, `bad_request`, `failed`, `timeout`, `unreachable`, `bad_reply` or `internal`. This session is now `off`, unless the failure was stopping `desk-stream`. Ask again when you like. The next `off` tries the stop again, as does any session ending with nobody left wanting the stream |
| `unavailable` | `{reason: "bandwidth_limit", resumesAt}` | `live` while the Platform has paused this member's Browser at a bandwidth limit (`ma-platform` ADR 0095, contract `bandwidth.md`): a heartbeat reply or the config said `streaming.streamProfile: "paused"`. Nothing was asked of the units. `resumesAt` is when it ends by itself, an ISO time, or null if the Platform didn't say. `warm`, `off`, the tabs, input, Notebook, Chat and Agent all still work. A session already `live` when the pause begins has its media cut at once and is left `off`, with no message, and desk-stream stops once nobody wants `warm`. Chromium isn't stopped, so its tabs, cookies and history stay as they are. `/health` adds `browser.bandwidthPaused` while it's on. Ask again at `resumesAt` |
| `unavailable` | `{reason: "bandwidth_limit", resumesAt, limit: "browser_time"}` | `live` on a free desk whose Browser time for the day is used up (§17, ADR 0090). The bandwidth pause's refusal, so a client that pauses for that pauses for this, with `limit` to tell the two apart. `resumesAt` is the member's next midnight, an ISO time, when it ends by itself; an upgrade, or a raised limit, ends it sooner, at the next config. Nothing was asked of the units. `warm`, `off`, the tabs, input, Notebook, Chat and Agent all still work. A session already `live` when the time runs out has its media cut at once and is left `off`, with no message, exactly as for the pause, and Chromium isn't stopped. `/health` adds `browser.timeUsedUntil` while it's on. With both on, the pause's refusal comes first |
| `unavailable` | `{reason: "held"}` | `live` or `warm` while a session holds the Browser for a copy (`data.browser.hold`, §12): nothing was asked of the units, and what this session wanted before stands. One still waiting when the hold came gets this too, and leaves its session `off`. It lasts until that session releases it or ends, or 30 minutes. Retrying every few seconds is fine |
| `unavailable` | `{reason: "moved", since}` | `live` or `warm` after this desk was moved to the member's own computer (`data.browser.keep`, §12): its Browser stays stopped so the sign-ins the move carried are used in one place only, and a site that rotates its sign-in tokens can't sign the member out on the new desk. `since` is when, an ISO time. It never ends by itself, a restart of deskd included, so **don't retry**: say so, and offer the member a way to start the Browser here anyway, which is `data.browser.release` with `{kept: true}` from this owner session, then `live` again. Warn them that using the Browser on both desks can sign them out of sites on the other. Nothing was asked of the units. `/health` adds `browser.moved: since` while it lasts |
| `unavailable` | `{reason: "age_band"}` | `live` while Chromium can't start yet, because the desk doesn't know its owner's age band (`ma-platform` contract `age.md` §8), or can't yet write what it knows. Nothing was asked of the units for Chromium. **Unlike the other refusals here, your `live` stands:** once that's settled, the units start and media comes without another request. Asking again is harmless, and `off` or the session's end takes it back. It's short: a desk with a band on disk never waits for the Platform, so this is a desk's first config, a Platform that can't read the membership (`503`, retried), a write to the data volume that keeps failing, or the moments of a restart for the teen policy (below). `warm`, the tabs and everything else still work. `/health` adds `browser.ageGate: "closed"` while it lasts |
| `unavailable` | `{unit: "desk-browser", code: "failed", reason: "chromium_older_than_profile"}` | The desk refused to start Chromium, which keeps the member's browser session safe: the profile last ran a newer Chromium, or the two versions can't be compared (ADR 0035). Only `live` can get this, since `warm` doesn't start Chromium. This session is now `off`. Show a message and don't keep retrying by yourself: only a fix on the desk clears this, either a newer image or Chromium updated in place, and each try costs a Python process and a `crit` line in the journal. A try the member asks for is fine |

### Nobody looking

**`desk.attention.set {seen}`** says whether this session is looking at the desk: `true` for the one desk the member is looking at (its window focused and its tab visible), `false` for every other. The desk is looked at if any session says so. Send it on every change, and again on every new session, a resume included: a session that ends says nothing any more. It isn't a mutation, so it needs no `idem`, and saying the same twice is harmless. The result is the desk's `{seen, frozen}`, as the topic has them. `seen` that isn't a boolean gets `bad_request` with `{reason: "seen"}`. On a phone it also says so, with `device` ("On a phone", below). Owner sessions only: an `export` one gets `forbidden` with `{reason: "scope"}`.

**A session that has never sent it** counts as looking while it wants `warm` or `live`, which is what a client from before this means by them, so it works as it did. Once it has sent it, its word is what counts.

| | deskd does |
|---|---|
| Nobody looking for 5 s | Cuts every session's media, so `desk-stream` pauses and nothing is captured or encoded. What each session wants stays: a `live` is held at what `warm` costs, and `desk-stream` stays up, so coming back is `warm` to `live`. The tabs aren't read on a timer any more |
| Nobody viewing the Browser for 60 s, and nothing working it for 60 s | Freezes Chromium: every process of `desk-browser`, at once (ADR 0045). Viewing is looking at the desk with a Browser window open, a session wanting `warm` or `live`, so a desk looked at only for its Notebook freezes too. Its tabs, scroll, cookies, history and sign-ins stay exactly as they are: nothing in Chromium is closed, cleared or reloaded, and pages don't see the freeze, only time jumping on |
| Someone looks | Sends media again at once to every session that wants `live`, from the frame on screen, which is a frozen Chromium's last, and thaws Chromium without waiting |
| `browser.stream.set {state: "live"}` | Thaws Chromium first, then works as above. Its reply comes once Chromium is thawed and the units are there |

**Working**, which keeps Chromium from freezing:
- **deskd's own calls to it:** every `browser.tab.*` and `browser.text.insert`, `browser.clipboard.read` and `.write` (Chromium can own the clipboard), a SUB to `browser.tabs`, and `data.browser.cookies`. Each thaws Chromium first, and keeps it for 60 s after it ends. `data.browser.hold` stops Chromium outright, and deskd thaws it before that stop and before every start, as systemd won't stop a frozen one.
- **Input:** desk-rtc's report of input on the screen, which comes with the first event after a second without any. It thaws, and keeps Chromium for 60 s.
- **A tab loading:** a member tab's main frame between `Page.frameStartedLoading` and `Page.frameStoppedLoading`, as far as deskd has heard, which is while it's connected. Looked at again in 30 s.
- **A download being written, or Chromium moving data over the network** (more than about 64 KB in 2 s, which keeps an upload, a call or a stream going), which the desk checks at the moment of the freeze, outside deskd, and declines it. Looked at again in 30 s. On an image without these checks, an upload left running with the Browser window closed stalls once Chromium freezes.
- **Not sound.** Media goes only to a desk somebody views, so sound nobody hears doesn't hold off a freeze: it pauses with Chromium and carries on after the thaw. To keep hearing a desk, keep it `seen: true`.
- **Not an export.** A desk being exported is unseen, as the export page looks at no desk, so it can freeze. `data.parts.list`, `data.manifest`, `data.read` and `data.read.stop` never reach Chromium, so they work frozen and don't thaw it; `data.browser.cookies` thaws it first (§12).
- **The simplified view's calls:** every `browser.minified.*` call and a SUB's first look at `browser.minified:<tabId>` (§14). Not the topic's watch for changes, which stops while Chromium is frozen.
- **Not yet:** an agent using the Browser, which would go through deskd's calls above when it's built.

**Topic `desk.attention`** carries `{seen, frozen}` whenever either changes, as a `snapshot`, and a SUB gets one first. `frozen` is true from a freeze until its thaw is done, so `seen: true` with `frozen: true` is the moment to say "Resuming…". Owner sessions only.

**A call while frozen** waits for the thaw, which should take about 0.1 to 0.2 s (a Python process and `systemctl`, not yet measured on a desk), and up to 10 s. If the thaw fails, the call gets `unavailable` with `{reason: "chromium"}`, as with no Chromium, and deskd keeps trying to thaw it. A call works on an unseen desk, but keeps it from freezing for 60 s, so don't poll one.

**The still.** deskd serves none. A frozen desk's screen doesn't change, so the last frame you decoded before it stopped being seen is its still.

### The Agent's tabs

An agent's Browser tools (§18) open their own tabs, never the member's: hidden targets with no window, in the run's own off-the-record browser context (no cookies, sign-ins or saved cards, nothing written to the profile, downloads denied), or, after the member's approval, one hidden tab in the member's own context for one site and one run. None is ever in `browser.tabs`, the tab on screen, the kept order or a crash's handling, no `browser.*` method reaches one by id, and every one goes when its run ends, at a freeze or with the connection to Chromium. **At most 2 on the desk, 1 on a free desk, counting the member's-session tabs** (the Browser bar's gap 4). **A run's open tabs hold off a freeze for 10 minutes after its last Browser call** (gap 6), as the freeze closes deskd's connection and every Agent tab with it: a card the member answers a few minutes later still finds its page; past that, or once the run ends, Chromium may freeze as before, and a later call on a tab it closed gets `not_found`. **An Agent tab's page holds at most 300 MB** (gap 7), by Chromium's `Runtime.getHeapUsage` over the tab and its out-of-process frames, each renderer process once (`Runtime.getIsolateId`): the V8 heap committed, Blink's heap, array buffers. A first look over it is taken again after a full collection in each of those processes (`HeapProfiler.collectGarbage`), so garbage V8 hasn't collected yet never closes a tab. The figure is per renderer process, so in the member's session a process the member's own tabs of that site share counts them too, which can only close the Agent's tab sooner: one past it is closed, at the call that finds it (`too_large`, `reason: "memory"`, `limit` in MB) or by deskd's look every 30 s between calls while Chromium isn't frozen; a later call on that tab, or one it was closed under (a page that grew as it loaded), gets the same `too_large`, never `not_found`. **After a click, a key or Back there's no fixed wait** (gap 5): a navigation the act or the page's script asked for is known before the act's reply, and is waited for by Chromium's own signs (requested, started, refused here) and then its load; one the act should start gets up to 1 s to show a first sign; one the page starts later on a timer isn't waited for, and the next read shows it. deskd sends Chromium only commands on an allow-list for them, none that clears or writes storage, cookies or history, no trusted mouse or key input, and script only deskd's own, into deskd's own isolated world (`browser/AgentCdp`). A navigation off the granted site in the member's tab is cancelled, and loopback, link-local, private-range and single-label hosts are refused in both, from the tab's main frame and from every frame of it, a frame of another site in a process of its own included: each such frame is held at its start until its own document requests stop at deskd too, and one whose requests can't be stopped is never let run (S-14). The page is told it has focus (`Emulation.setFocusEmulationEnabled`), as a tab on screen has, so its focus events fire for the Agent's clicks and keys.

### Tabs

```json
{"tabId": "33C3EB58…", "url": "https://example.com/", "title": "Example", "loading": false, "active": true, "canGoBack": true, "canGoForward": false}
```

A tab whose page was refused protected playback also has `"protectedMedia": {"at": "2026-11-11T09:30:00Z", "keySystem": "com.widevine.alpha"}` ("A protected video that can't play", below). Every other tab leaves it out.

- **`tabId` is opaque.** Don't parse it, and expect it to change when Chromium restarts. It survives a restart of deskd.
- **`active` is the tab on screen.** Exactly one tab is `active` if there are any. A tab the member opens in the background, as a middle click does, isn't active until it's on screen.
- **A left-out `tabId` means the tab on screen, and it's never a guess.** deskd looks again for each call. If it can't tell, the call does nothing and gets `unavailable` with `{reason: "active_tab"}`: the debugging port didn't answer, a tab that may be on screen is hung, or the member is on a page that isn't listed. A list's `active` is then only the last one known, so naming that tab can reach one that's hidden.
- **`url` and `title` come from web content, so treat them as untrusted text.** `title` is the page's raw text and isn't HTML: a page titled `Q&A` comes through as `Q&A`, never `Q&amp;A`. So show it as plain text, never as markup. deskd cuts `url` to 2048 chars and `title` to 256, and removes control and bidi characters. In the rare case that a list wouldn't fit one event (64 KiB), every tab gets 256 and 64, and past that tabs drop off the end. The active tab stays.
- **The desk's start page has an empty `url` and the `title` `New tab`.** A new Browser opens on a local page, and its file path isn't shown to members, so a tab on it reports `url: ""` (show your address placeholder) and `title: "New tab"`. Once the page navigates away, the tab reports its real `url` and `title`. deskd keeps the real address for its own use (tab order across a wake, history), and `browser.tab.navigate` still takes only `http` and `https`.
- **`loading` follows the main frame.** `canGoBack` and `canGoForward` follow the tab's history.
- **The order** is the order deskd first saw the tabs. It may change after a restart of deskd, since Chromium doesn't report its tab strip.
- **Only the member's ordinary pages count.** No devtools, service workers, extensions, or `chrome:` pages, except the new tab page, which Ctrl+T opens. If the member reaches `chrome://settings` on the keyboard, it isn't listed, and the last ordinary tab stays `active`, but a call that leaves out `tabId` gets `unavailable` until the member is back on one.
- **Closing the last tab** opens an empty one first, since a kiosk Chromium exits with its last tab. If that tab goes by itself in that moment, the empty one stays, and the call still returns `{}`.
- **`browser.tab.open` with no `url`** opens `about:blank`.
- **`back` or `forward` with nowhere to go** does nothing, and returns `{tabId}`.
- **`browser.tab.navigate`** answers when the page commits, or after 30 s if it's still going: then there's no `netError`, and the tab shows `loading`.

**URLs.** `browser.tab.navigate` and `browser.tab.open` take only absolute `http` and `https` URLs with a host. deskd checks this itself, before Chromium hears anything, and whether or not Chromium is up. Leading spaces, control characters anywhere and backslashes are refused, not cleaned up, since browsers strip them and that's how `java\tscript:` works. Half a surrogate pair is refused too. Spaces and `"<>^\`{|}` are encoded for you, and after the host so are `[`, `]`, a `%` that doesn't start an escape, and any `#` after the first. A non-ASCII host goes through IDNA, and is refused if a character would map to a delimiter, such as a fullwidth `@`, or if Chromium would read it as another host (ß, ς, ZWJ, ZWNJ). An ASCII host can have underscores, and can't end in a number unless it's an IP address. So add `https://` to what a member types first.

**`browser.text.insert`** types into the tab through CDP `Input.insertText`, for IME and pasted text. It works on a tab that isn't active, into whatever has focus there, so leave `tabId` out for what the member is typing or pasting: that goes only to the tab on screen, or nowhere. Empty text does nothing.

| Error | `details` | Meaning |
|---|---|---|
| `not_found` | `{reason: "tab"}` | That `tabId` is dead, or there are no tabs |
| `unavailable` | `{reason: "chromium"}` | Chromium isn't reachable, or didn't answer in 5 s, before the command went out. Nothing was done. It's the one code for all of that, and nothing holds the call: `browser.stream.set {state: "live"}` is what starts Chromium. Retry with the same key |
| `unavailable` | `{reason: "chromium", mayHaveApplied: true}` | deskd got as far as sending the command, then Chromium didn't answer in 5 s or the connection dropped. A slow page can still apply it. A retry with the same key replays this reply, and doesn't send the command again, for as long as deskd keeps it (§4) |
| `unavailable` | `{reason: "active_tab"}` | You left out `tabId`, and deskd can't tell which tab is on screen. Nothing was done. Try again shortly with the same key, or name a tab |
| `bad_request` | `{reason: "scheme"}` | Anything but `http` or `https`, including no scheme |
| `bad_request` | `{reason: "url"}` | The right scheme, but no proper host, or not a URL at all |
| `bad_request` | `{reason: "tabId"}`, `{reason: "text"}` | A required field is missing, or the wrong type |
| `too_large` | `{limit}` | `url` over 16384 chars, `text` over 65536, or over 256 tabs |
| `forbidden` | `{reason: "blocked"}` | The desk's policy blocks this URL (`net::ERR_BLOCKED_BY_ADMINISTRATOR`). Any other navigation error is a normal result with `netError`, such as `net::ERR_NAME_NOT_RESOLVED`. The office's own URLs go to the portal instead, while that's on ("The office in the Browser", below) |
| `forbidden` | `{reason: "permission"}` | A token without input, on anything that drives the Browser. A token without video can't use `browser.tab.list` or `browser.tabs` either. It goes by the token as it is now, so a refresh can stop a call that hasn't reached Chromium |

**`idem`** works as in §4: one action keeps one key across every retry.
- **After `unavailable` with no `mayHaveApplied`,** nothing was done, and the same key runs the call.
- **After `unavailable` with `mayHaveApplied: true`,** the same key replays that reply, and doesn't send the command again, for as long as deskd keeps it (§4). A new key sends it again. That's harmless for `navigate`, `reload`, `activate` and `close`, but not for `browser.text.insert`, which types twice, `back` or `forward`, which go two steps, or `open`, which opens a second tab.
- **After `deadline_exceeded` or `cancelled`,** keep the key: the command may have gone out, and a retry won't send it twice while deskd keeps the result (§4).
- **A session ending,** a revocation included, stops a call that hasn't reached Chromium yet, so a retry from a new session runs it.

### A protected video that can't play

The desk's Chromium plays no DRM: it has no Widevine, and no Chromium on Linux has PlayReady or FairPlay. So a site whose video is protected, such as a film or music service, fails, often with an error page of its own that doesn't say why. deskd tells the client when that happens, so the Desk app can say so. No site is blocked, and nothing on the page changes.

- **What a client sees.** The tab gets `protectedMedia: {at, keySystem}` in `browser.tab.list` and in every `browser.tabs` snapshot, so a change to it is one more snapshot on that topic, and a SUB or a list made later has it too. `at` is when deskd heard of it, to the second, in UTC. `keySystem` is `com.widevine.alpha`, `com.microsoft.playready` or `com.apple.fps`, whichever the page asked for first.
- **When.** The first time the tab's page asks for one of those key systems and is refused, which on a desk is every time it asks. Players ask before they play, so this is the moment the page's own video fails. ClearKey, which Chromium has, never counts, nor does a request for a key system nobody uses, nor a player's error of any other kind.
- **Once per page.** It stays, unchanged, however often the page asks again, and through a same-document navigation, as a single-page site makes between its own pages. A navigation to a new document clears it, and that page is watched afresh. So show the note while the tab has it, and key a member's dismissal to the tab and its `at`.
- **Only while deskd is connected to Chromium,** as for everything here: while someone views the Browser, is subscribed to `browser.tabs`, or has called in the last minute. A page that loaded while deskd was connected is told of again when it's next connected, even if it was refused in between, unless deskd restarted. One that loaded while it wasn't is told of only if it asks again.
- **Not seen:** a player in a frame of another site, such as one embedded from a video host. Only the tab's top-level page is watched.
- **A probe looks the same.** A site that asks for a key system only to learn what the browser can do, with no protected video to play, sets it too. Make the note small and easy to dismiss.
- **Privacy.** deskd learns only which of the three key systems, for which tab. The journal gets one line, the tab's id and nothing of the page. Nothing reaches the heartbeat or Platform.
- **How.** A fixed script in the page's own world wraps `navigator.requestMediaKeySystemAccess`, and on the first refusal of a protected key system fires an event with a random name, which deskd's isolated world in that document hears and passes on through a binding there. Runtime is never enabled, so a page's console costs nothing more and can't tell. The page gets Chromium's own answer, the same error object, a microtask later. What a page could notice: the method's `Function.prototype.toString` no longer names it inside `[native code]`.
- **The kill switch** (the owner's rule: finished features ship on, and a switch only turns them off). `/data/desk/protected-media-switch`, read while deskd runs by the same reader as `minified-switch` (a stat at most once a second, never on the CDP reader's or a caller's thread). With no file, the note is on. The word `off` turns it off; any other word, and an empty file, change nothing; a file deskd can't read as a plain small file (a symlink, one over 1 KiB, one it can't open) counts as `off`. The desk's operator writes it as root over SSM. **Off means:** a tab attached or navigated gets no script (nothing is added with `Page.addScriptToEvaluateOnNewDocument`, no binding, no isolated-world listener); the script already registered in an open tab is taken out with `Page.removeScriptToEvaluateOnNewDocument`; a binding call that arrives is ignored; and `browser.tab.list` and `browser.tabs` carry no `protectedMedia`, from the next read, a mark cleared included (one more snapshot says so). The copy already running in a loaded page can't be taken back, and does nothing deskd hears; it goes with that page. **Switching while tabs are open** is noticed at the next publish tick of the tab list, which runs while someone is viewing the Browser and subscribed to `browser.tabs`, and at once for any tab that attaches or commits meanwhile. Taking the file away turns it back on: tabs already attached are registered again at the next tick, and the script runs at once in the document each holds, so a page already open is watched again too.

### Links out

A page on the desk can hold a link the desk can't open: `mailto:`, `tel:`, a Zoom or Teams join link. Chromium hands such a link to the desk's OS, and the image's stand-in for `xdg-open` passes it to deskd (`desk-runtime.md` §8.11), which tells the client, so the member's own device can offer to open it. Built, and in no release yet; the image's side isn't baked yet either. Until both are, SUB `browser.links` gets `not_found`, and such links do nothing, as before.

**Topic `browser.links`.** SUB with no params. Its one event:

```json
{"type": "linkOut", "data": {"url": "mailto:a@example.com?subject=Hi%20there", "scheme": "mailto", "displayText": "mailto:a@example.com?subject=Hi there", "reason": "externalScheme", "at": "2026-11-11T10:00:00Z", "tabId": "33C3EB58…"}}
```

- **`scheme`** is one of `mailto`, `tel`, `sms`, `zoommtg`, `msteams`, `facetime`, `webcal`, `http` and `https`, lowercase. Nothing else ever comes: any other link is dropped on the desk and counted. So no `file:`, `javascript:`, `data:`, or a scheme that runs a program on the member's device (`ms-msdt:`, `search-ms:` and their kind). Still check it against your own list before you hand the URL to the device: a later deskd may send more.
- **`url`** is the link to open, in printable ASCII: the scheme lowercased, and spaces, quotes, `<>\^`{|}`, non-ASCII characters and a `%` that starts no escape percent-encoded. An `http` or `https` one has been through the same rules as `browser.tab.navigate` (below). At most 8192 chars; a longer link is dropped, never cut. **It's a web page's link, so it's untrusted.** Open it only through the browser on the member's device (an `<a href>` the member clicks, or `location.href` from that click), never by parsing it yourself.
- **`displayText`** is the URL to show the member: escapes of printable ASCII decoded, so `%20` reads as a space and `%40` as `@`, and every other escape left as it is, so no control, bidi or lookalike character can appear that the URL doesn't plainly hold. At most 200 chars, the last an ellipsis when cut. Show it as plain text, never as markup.
- **`reason`** is `externalScheme`: Chromium handed it to the OS, as it does a scheme it doesn't open itself. Ignore an event with a reason you don't know.
- **`at`** is when deskd had it, to the second, in UTC.
- **`tabId`** is the member's tab deskd last knew to be on screen, which is where the click was. Left out when deskd doesn't know which, as when nobody has called and nothing is subscribed to `browser.tabs`. Look it up in your tab list to name the site; deskd doesn't say which page in the tab asked, and a frame from another site can.
- **When.** Chromium hands a page one such link per input from the member (a click, a key, a tap), so a page that tries again and again with no input gets nowhere. deskd also passes on at most 3 in any 10 s, and never the same URL twice within 5 s, as a double click would. So one click is one event.
- **Who.** Owner sessions with video and input, read live, as for the clipboard. A SUB without both gets `ERR forbidden` with `{reason: "permission"}`, and a refresh that takes either away ends it with `{"type": "error", "data": {"code": "forbidden"}}`. **Every subscribed session gets it,** so offer it only on the device the member clicked from: one that sent input through the stream in about the last 2 s, the rule a copy follows.
- **No first event, and nothing kept.** An event is published only while someone is subscribed: a link with nobody subscribed is dropped. `since` has no effect, and a `linkOut` lost to a client falling behind stays lost. SUB again after a resume (§3).
- **Ask first, always.** Never open it without the member's own click on your offer, which names the scheme's app ("Open in your mail app?", "Call +1 555 123 4567?") and shows `displayText`.
- **Not seen:** a link a page opens in a way Chromium doesn't hand to the OS. And on a desk the link never opens: there's no mail app or phone there.

**Open on this device.** The Browser bar's button, for what a desk can't do itself (a protected video, a site that blocks cloud addresses, a call), needs nothing new from deskd: open the tab's `url` from `browser.tabs` on the member's device. Offer it only when that's `http` or `https`; the desk's start page has an empty one. It's cut at 2048 chars, so a URL exactly that long may be cut: say so, or offer the site's front page.

**Send to my desk.** The other way, from the member's phone or computer, is `browser.tab.open` with `{url}`, which takes only `http` and `https` (below), after the member has said yes to the site by name. It needs the Browser up first: `browser.stream.set` with `warm` or `live`; until then it gets `unavailable` with `{reason: "chromium"}`. Use one `idem` for the whole action, so a retry doesn't open two tabs.

| What deskd drops | Counted in `/health` as |
|---|---|
| A scheme not listed above, or no scheme at all (a file path from Chromium's download bubble) | `scheme` |
| A listed scheme with nothing after it, a control character, half a surrogate pair, a bad `http` URL, or over 8192 chars | `url` |
| The same URL again within 5 s | `repeat` |
| A 4th in 10 s | `rate` |
| Nobody subscribed | `nobody` |
| A connection to its socket from any user but Chromium's, or one that sent no proper line | `peer`, `request` |

### A teen's filtered sites

On a teen's desk Chromium resolves every name through Cloudflare's family resolver (`family.cloudflare-dns.com`, the image's teen policy), which answers `0.0.0.0` and `::` for a site it filters. Such a page fails with Chromium's own `ERR_CONNECTION_REFUSED` page, which doesn't say why. So while the desk's age band is `teen`, deskd puts a page of its own in that one's place: "This site is filtered", "Your Browser uses a family filter until you're 18." and a Back button. Nothing for a client to call or handle.

- **When.** A tab's main frame commits Chromium's error page for a connection error: `ERR_CONNECTION_REFUSED`, which is what a desk gets (checked on Chromium 156 with the real resolver), or `ERR_CONNECTION_FAILED`, `_RESET`, `_CLOSED`, `ERR_EMPTY_RESPONSE`, `ERR_ADDRESS_INVALID` or `ERR_ADDRESS_UNREACHABLE`. deskd asks the same resolver about that host over DoH (RFC 8484), and only if every address in its answer is `0.0.0.0` or `::` does the page change. A subframe never does this, and neither does any other error. A tab already showing such a page when deskd attaches to it, as a restored session or a tab opened straight onto the site can be, is looked at then.
- **What clients see.** `browser.tab.navigate` still answers `netError: "net::ERR_CONNECTION_REFUSED"`. The tab's `url` stays the one that failed, and its `title` becomes `This site is filtered` once the page is in. Measured from a build machine, not a desk: the resolver answered in about 0.5 s on a new connection and about 20 ms on one kept open, and the write itself takes a few ms. Back goes where `browser.tab.back` would, and does nothing in a tab with no page before this one. A reload tries the site again.
- **It never holds anything up.** Chromium's page shows first and stays if the answer takes over 2 s, fails, or 4 lookups are already out. Navigation, calls and other tabs never wait for it. An adult's desk, or one whose band isn't known yet, never looks.
- **Privacy.** The resolver hears one host, one Chromium has just asked it about, and nothing else. An IP literal, `localhost`, `.local`, `.internal`, `.arpa` or a name with no dot is never sent. Neither the host nor the URL is logged, and `/health` says nothing of it, as it would tell a teen's desk from an adult's.

### The office in the Browser

The desk's Chromium blocks Minimalist Alliance's own hosts by policy (the image's `URLBlocklist`: `office.`, `desk.`, `api.`, `auth.` and `gw.`, with the staging names from image 0.3.7), so the office can never open inside itself. As the owner's easter egg, a top-level visit to the office lands on a portal page instead of Chromium's "This page is blocked": `https://portal.minimalistalliance.com/`, or `https://portal.staging.minimalistalliance.com/` on a staging desk. The office is `office.minimalistalliance.com`, `desk.minimalistalliance.com`, `office.staging.minimalistalliance.com`, `desk.staging.minimalistalliance.com` and any name under them. Nothing for a client to call or handle.

- **Typed, a link the Desk app opens, a new tab.** `browser.tab.navigate` and `browser.tab.open` with an office URL go straight to the portal. The reply is the portal's, the office never shows, and it never gets an entry in the tab's history.
- **Anything else:** a link on a page, a server's redirect, `window.open`, a page restored with its tab. Chromium blocks it, and when a tab's main frame commits that blocked page for an office host, deskd replaces it with the portal: a `location.replace` from deskd's isolated world in that very page. The office's entry leaves the history with it, so Back from the portal goes straight to the page before, and Forward comes back to the portal. A `browser.tab.navigate` whose URL a redirect took to the office answers as a normal result with no `netError`, as the tab is on its way there. A tab already on that blocked page when deskd connects goes on then.
- **Never:** a frame, so the office stays blocked inside any page that frames it; `api.`, `auth.` and `gw.`, which stay `forbidden` and Chromium's page; a name that only looks like the office's (the host is read as Chromium reads it: past any userinfo, without its port or trailing dot, lower case and through IDNA); an agent's tab, whose tools still say `blocked`; any error but the policy's; and a blocked office page that comes right after the portal, so a portal that sent a tab back to the office would leave it on Chromium's page rather than loop.
- **It fails closed.** The policy still blocks the office, and deskd only ever sends a tab to the portal. With deskd down, not connected to Chromium (as for everything here: while someone views the Browser, is subscribed to `browser.tabs`, or has called in the last minute), busy with 4 at once, or switched off (`DESKD_PORTAL_URL=off` in `deskd.env`), the member sees Chromium's blocked page as before.
- **Every band and every host.** Adult and teen desks alike, cloud and self-hosted. On a teen's desk the office's page never reaches the filter's lookup ("A teen's filtered sites"), nor the filter's pages the portal.
- **Privacy.** The portal's URL is a constant (by the desk's `Env`, or deskd's setting), never taken from a page or a URL, and the portal learns nothing of what was asked: no referrer goes from an error page, and none from a navigation deskd makes. No URL, host or path is logged or kept; the journal gets counts at debug, and `/health` says nothing of it.

### The clipboard

Built, and in no release yet: a deskd before it answers `not_found`. The desk side also needs a `desk-rtc` with the clipboard. Until a desk has one, every call gets `unavailable` with `{reason: "display"}`: the first after deskd's own wait, and the rest at once (the table below).

This is the desk's X `CLIPBOARD` selection, both ways, text only. Never `PRIMARY`. The text travels only on the session's own `rpc` data channel, end to end, so the platform never sees it.

**`browser.clipboard.write`** takes `{text}` and returns `{}`. It isn't a mutation, so it needs no `idem`: setting it twice is harmless, and the last one to arrive wins. Writes from every session take turns in the order they came, each waiting for the one before to be answered.
- **The reply is the ack.** When it arrives, the desk's `CLIPBOARD` holds this text and the X server has confirmed it. `keys` is a different channel from `rpc` and nothing orders them, so **send the paste key only after the reply.**
- **A retry after a lost reply is safe.**
- **NUL characters are removed.** The cap counts the text as you sent it, before that. Half a surrogate pair is refused, as it is for URLs.
- **Empty text does nothing,** and returns `{}`, including text that's empty once NUL is gone. Don't send a paste key then.
- **It needs a token with input.**

**`browser.clipboard.read`** takes no params and returns `{text}`: a string that's never empty, or null if the clipboard holds no text, for example an image or nothing at all. It isn't a mutation either. Reads that come while another is waiting its turn share that one's answer, which is read after all of them came, so one sent after a write's reply always sees that write.
- **It needs a token with both video and input.** The clipboard can hold something that was never on screen, such as a copied password, so watching isn't enough to read it.
- **The text is untrusted,** since a page can put anything there. Treat it as plain text, never as markup.
- **Newlines and tabs are kept.** NUL is removed, and bytes that aren't UTF-8 become U+FFFD.

**The cap is 1,000,000 bytes of UTF-8, both ways.** Over it you get `too_large` with `{limit: 1000000}`. Nothing changes, and a read returns no piece of the text. Never a cut piece. Check the size first with `new TextEncoder().encode(text).length`, so you can say so clearly. A read is held to it twice: the text as the desk holds it, and the text once cleaned, since each byte that isn't UTF-8 becomes U+FFFD, which takes 3.

**JSON escaping counts too,** because a REQ or a RES stops at 1 MiB, which is 1048576 bytes of JSON (§2). A newline, tab, quote or backslash takes 2 bytes there, and most other control characters take 6. So text under the cap can still go over: 1,000,000 bytes with 50,000 newlines in them does. The check above doesn't catch that, and these two errors have empty `details`, so there's no `limit` to read:
- **A REQ over 1 MiB** gets `ERR too_large`, with nothing changed, and the session goes on. deskd answers as soon as it has counted past the limit, so the reply can arrive while you're still sending. Send the rest of the frames anyway: until the last one, the message holds one of the 64 incomplete slots (§2).
- **A read whose reply wouldn't fit** gets `too_large`.

| Error | `details` | Meaning |
|---|---|---|
| `forbidden` | `{reason: "permission"}` | The token doesn't allow it. It goes by the token as it is now: a write's again once its turn comes, and a read's again before its text goes out |
| `forbidden` | `{reason: "scope"}` | The session isn't an owner's, such as an `export` one (§4) |
| `unavailable` | `{reason: "display"}` | There's no X server yet, because the Browser hasn't started, or the part of the desk that holds the clipboard didn't answer in time. Treat the text as not written, so don't send the paste key. Retry shortly: after a timeout it could still land, which a retry of the same text makes harmless. Neither method starts X: `browser.stream.set` with `live` or `warm` does. This is also what a desk gets while its `desk-rtc` is too old to know these methods, and there a retry won't help, so a paste that keeps getting this falls back to `browser.text.insert`. deskd waits 12 s for a write's answer and 25 s for a read's, longer than the desk takes to say this itself. Once a wait has run out with no word at all from the clipboard, deskd answers this at once until it hears from it, or `desk-rtc` restarts |
| `unavailable` | `{reason: "clipboard"}` | `read` only. Whatever holds the clipboard didn't answer in 3 s, such as a hung tab, or the desk couldn't take the read just then. Retry shortly |
| `bad_request` | `{reason: "text"}` | `text` is missing, the wrong type, or has half a surrogate pair |
| `too_large` | `{limit: 1000000}` | The text is over the cap |
| `too_large` | `{}` | The REQ or the reply is over 1 MiB as JSON |
| `rate_limited` | `{limit: "clipboard"}` | `write` only. Four writes are already waiting or running on the desk, from every session together. Nothing changed. Try again once one of yours is answered |
| `not_found` | `{}` | A deskd older than this, on either method or on SUB |

These aren't mutations, so no error here has `mayHaveApplied`, and §4's table of what an error says about a mutation doesn't apply. After `cancelled`, `deadline_exceeded` or a lost session, you can't say whether a `write` landed. Only its `{}` says so, so don't send the paste key without one. On a `read`, a `deadlineMs` under 3 s can get `deadline_exceeded` before deskd has given up with `{reason: "clipboard"}`.

**Topic `browser.clipboard`.** SUB with no params. Its one event is:

```json
{"type": "changed", "data": {}}
```

- **There's no text in it, ever,** and no first event on SUB. So §5's first `snapshot` doesn't apply, and nor does the fresh one if you fall behind: a `changed` can be lost then, and nothing replaces it. `since` has no effect here. SUB again after a resume (§3).
- **At most about 4 a second,** coalesced: the first after a quiet spell comes at once, and the last of a burst always comes.
- **It fires when something on the desk takes the clipboard,** not for a client's `write`, from any session.
- **It needs video and input, read live.** A SUB without them gets `ERR forbidden` with `{reason: "permission"}`. A refresh that takes either away ends it, the way `browser.tabs` ends, with `{"type": "error", "data": {"code": "forbidden"}}`.
- **It stays subscribed while the display is down.**
- **It's what makes the desk watch the clipboard at all.** While no session is subscribed, `desk-rtc` isn't told of changes.

**Who can reach it**
- **A web page on the desk has no way to these methods.** They exist only on the `rpc` channel of a session that presented a token. deskd has no TCP listener, and Chromium's user can't open deskd's or desk-rtc's Unix sockets (`desk-runtime.md` §1, §2, §4). desk-rtc's port 443 carries only sessions deskd created after checking a token.
- **But a page can change the desk's clipboard by itself:** Chromium lets a focused page write text. So **`changed` isn't a member's copy, and it's not a reason to touch the member's own clipboard.**
- **The rule for a copy:** read, and put text on the member's computer, only when the member just copied, meaning `changed` arrives within about 2 s of a copy or cut chord or a click sent through the stream. Otherwise a page could overwrite the member's clipboard whenever it likes.
- **The rule for a paste:** send the member's text to the desk only on a real paste, never in the background. Once it's on the desk, the paste key hands it to whatever has focus. Other than that, a page can read it only through Chromium's `clipboard-read` permission, which by default asks the member. That default is read from Chromium's documentation and hasn't been tried in the kiosk. The kiosk's policy file, `image/recipe/files/etc/chromium/policies/managed/ma.json`, doesn't set `DefaultClipboardSetting`.

**How it fits with `browser.text.insert`.** That method stays for composed text and dictation, and as the fallback. A paste becomes: `write`, wait for the reply, then the paste key on `keys`. That also reaches places `browser.text.insert` can't, which is why it exists.
- **The paste key** is Ctrl+V, as `KEY` events (`desk-runtime.md` §8.6), and on a Mac too, since Cmd goes to the desk as Control. Control has to be down on the desk when `v` goes down, and the member may have let go while `write` was on its way. That section says Ctrl+V isn't sent as a key, which describes today's paste. desk-rtc itself has no rule against it.
- **On a deskd older than this,** any method gets `not_found`, and SUB gets what §5 says, which is `not_found` too. So keep `browser.text.insert` for paste there. Its own cap is lower: 65536 chars.

### Signing in

Signing in that works on the desk (`docs/sub-status/desk-sign-ins.md`). Chrome sync can't work in the desk's Chromium (Google lets only Chrome use it), and a kiosk has no toolbar to press an extension in, so a member brings a browser's passwords and bookmarks in once, and uses a password manager from the Browser bar's key button. Passkeys live in that password manager.

**Who.** The owner's sessions only. `browser.import`, `browser.import.begin`, `finish` and `abort`, `browser.extension.open` and `close` need input; `browser.bookmarks.list` and `browser.extensions.list` need video, read live (`forbidden`, `{reason: "permission"}`). Every one of them answers `forbidden` with `{reason: "age_band"}` unless the desk is known to be an adult's: a teen's Browser has every extension off, and an unknown band is treated as a teen's. **Chromium must be running,** so call them while the Browser window is open: otherwise `unavailable` with `{reason: "chromium"}`, and nothing was done.

**What deskd does in Chromium.** Only Chromium writes the profile (ADR 0035): passwords go into Chromium's own Password Manager and bookmarks into its own bookmarks, through Chromium's own pages, opened hidden for the call (no tab, nothing in history or the restored session) and closed after it. Nothing already there is replaced or removed. deskd opens an extension's page in a tab and never attaches to it, reads it or runs anything in it: such a tab isn't in `browser.tabs`, and the simplified view and the Agent can't reach it.

#### Passwords: `browser.import.begin`, the bytes on `bulk`, `browser.import.finish`

A passwords file holds every password in plain text, so it **never touches a disk on the desk**: the Desk app reads the member's file in their own browser and sends its bytes straight to deskd over the desk session, into deskd's memory. It's never in Files, under `/data`, in `/tmp` or at any other path, so no snapshot of the desk's volumes (before a rollout, or a backup) can hold it. deskd parses it there, hands the rows to Chromium, and zeroes its buffers.

1. **`browser.import.begin {kind: "passwords", size}`** → `{uploadId, transferId, window, size}`. `size` is the file's bytes, 1 to 2 MiB (2,097,152). `uploadId` is 22 characters of `A-Za-z0-9_-`; `window` is `size`: credit for the whole file at once. Chromium must be running ("Who", above): otherwise `unavailable` `{reason: "chromium"}` before a byte is sent. It takes one place in the session's transfers on `bulk` (8 a session, 12 a desk, with `data.read` and Files' transfers) until it's finished or zeroed. A session mutation, as `files.upload.begin` is: a retry from another session runs it again.
2. **The bytes, on `bulk`**, exactly as a Files upload sends them (`files.md` §5.2): CHUNK, kind 15, flags `BIN`, `id` = `transferId`, `seq` from 0, payloads of at most 16,372 bytes in order, never more than `size` in all. When the last byte is in, deskd sends CREDIT `{"bytes": 0, "committed": size}`. A frame past `size` or out of sequence ends the transfer with the terminal CREDIT `{"bytes": 0, "committed": c, "error": "credit_violation"}` or `"seq"`, and the bytes are zeroed; so do `aborted`, `superseded` (a new `begin` in the same session) and `expired`.
3. **`browser.import.finish {uploadId}`** → the import's reply (below). It waits for the last byte, for up to 30 s since the latest one (frames on `bulk` and this call on `rpc` aren't ordered), parses the file, zeroes the buffer, and hands the rows to Chromium. **Whatever happens from here, the bytes are gone:** after any error, `begin` again with the same file. That's safe, as nothing is ever added twice.

**`browser.import.abort {uploadId}`** → `{}`: zeroes it and ends its transfer. Idempotent.

**What's held, and for how long.** One passwords file on the desk at a time, in the session that began it: `begin` from another session while one is held is `conflict` `{reason: "busy"}`, and `finish` or `abort` from another session finds nothing. The buffer is zeroed when the import has parsed it, on `abort`, when its transfer ends with an error, 60 s after its last byte (or its `begin`) with no `finish`, when its session ends, and when deskd stops. Nothing is kept for a later session: there's no resume, so a lost session means `begin` again.

**What's true of memory.** deskd zeroes its own copies: the buffer the file is assembled in, and each chunk's array as it's copied in. It can't zero the transport's copies (desk-rtc's buffers, the `rtc.sock` read buffer, each frame's array before its payload is cut out) or the Java strings the parser and the call to Chromium make (ADR 0040 says the same of keys); they're garbage once the import is done. None of it can reach a disk: deskd's container may not swap (its run script gives docker a swap limit equal to its memory limit, so the cgroup's swap is 0), the desk's only swap is zram, which is compressed RAM, core files are off (`--ulimit core=0`, `-XX:-CreateCoredumpOnCrash`), heap dumps are off, and nothing can attach to the JVM. **The journal never has any of it:** deskd's one log line is counts.

**A passwords file a member put in Files anyway** (an export named `Chrome Passwords.csv`, say, or anything with a passwords header) is never read, moved or deleted by deskd: `browser.import` with `kind: "passwords"` is refused, `bad_request` `{reason: "use_upload"}`, with no path read. What's in Files is the member's to keep or delete.

#### Bookmarks: `browser.import {kind: "bookmarks", path}`

A bookmarks file holds no secrets, so it comes from Files: `path` is a Files path (`files.md` §0). The file is read whole, by deskd, never by Chromium, and kept.

#### What a file may hold, and the reply

| `kind` | The file | Limit |
|---|---|---|
| `passwords` | A passwords CSV, UTF-8, with a header row: what Chrome, Edge, Firefox, Safari, Bitwarden and 1Password export. Columns by name, in any order and case: `url`, `website`, `origin`, `hostname` or `login_uri`; `username`, `user`, `login`, `account` or `login_username`; `password` or `login_password`; `note`, `notes`, `comment` or `extra` | 2 MiB, 10,000 rows |
| `bookmarks` | A bookmarks HTML file, the Netscape format every browser exports | 8 MiB, 20,000 folders and links |

**The reply** (`browser.import.finish` for passwords, `browser.import` for bookmarks):

| Field | Meaning |
|---|---|
| `kind` | `passwords` or `bookmarks` |
| `found` | Rows (`passwords`) or links (`bookmarks`) in the file. Blank rows and folders aren't counted |
| `added` | Added to Chromium now |
| `alreadySaved` | Chromium has one already: a password for that site and username (it's kept as it is, whatever the file says), or a bookmark of that address anywhere |
| `refused` | Not added: not an http or https address with a host, no password, a field over 1,000 characters (2,048 for an address), or, for bookmarks, `javascript:`, `place:`, `file:` and the like |
| `notAdded` | `passwords` only: up to 100 of the rows not added, `{site, username, reason}`, so the member knows which. `site` is the address's host, or null; `username` is cut at 64 characters; `reason` is `exists`, `url`, `password` or `too_long`. Never a password |
| `folderId` | `bookmarks` only: the `Imported` folder under Other bookmarks that this import added to, or null if nothing was new. A second import of the same file adds to the same folder |

**Errors.** Since nothing is ever added twice, an import that failed part way can simply be run again: for passwords, from `begin`.

| Error | `details` | Meaning |
|---|---|---|
| `bad_request` | `{reason: "kind"}`, `{reason: "path"}`, `{reason: "size"}`, `{reason: "uploadId"}` | A param is missing or wrong |
| `bad_request` | `{reason: "use_upload"}` | `browser.import` with `kind: "passwords"`: send the file with `browser.import.begin` instead. Nothing was read |
| `bad_request` | `{reason: "format"}` | Not a file this can read: no header naming an address and a password column, not UTF-8, a quoted field left open (`passwords`); no list and no link at all (`bookmarks`) |
| `too_large` | `{limit}`, or `{limit, reason: "rows"}`, `{limit, reason: "bookmarks"}` | The file (at `begin`, its `size`), or what's in it, is over the limit |
| `conflict` | `{reason: "busy"}` | `begin`: another session's passwords file is held. It goes within 60 s if nobody finishes it |
| `too_many` | `{limit, reason}` | `begin`: the session's or the desk's transfers on `bulk` are all in use (§16) |
| `conflict` | `{reason: "incomplete", committed}` | `finish`: the bytes stopped coming for 30 s before the last, or the transfer ended. The bytes that came are zeroed |
| `not_found` | `{reason: "upload"}` | `finish`: no passwords file of this session's by that id: finished, aborted, expired, ended by an error, or never begun |
| `not_found`, `invalid` | As `files.*` (`files.md` §1), with `invalid` `{reason: "is_a_folder"}` for a folder | `bookmarks`: the path |
| `unavailable` | `{reason: "tree"}` | `bookmarks`: the Files tree can't be used |
| `unavailable` | `{reason: "chromium"}` | Chromium isn't reachable, its page didn't load in 5 s, or it failed part way. With `mayHaveApplied` (§4), some rows may be in. Run it again: the second run adds only what's missing |

A passwords file of a few hundred rows takes a second or two; Chromium takes rows one at a time, so give `finish`'s `deadlineMs` room for a big one, or none. Once rows have begun to go, a deadline doesn't stop it (§4), and a retry with the same `idem` gets the result.

#### `browser.bookmarks.list {folderId?, offset?}`

A kiosk shows no bookmarks bar, so this is where bookmarks are seen. One folder at a time, 200 items a page:

```json
{"folder": {"id": "2", "title": "Other bookmarks", "parentId": "0"},
 "items": [{"id": "31", "title": "Imported"}, {"id": "40", "title": "News", "url": "https://news.example/"}],
 "more": false}
```

- No `folderId` is the top, `"0"`, whose items are Chromium's own folders (Bookmarks bar, Other bookmarks, and Mobile bookmarks when it has any). Its `title` is empty and its `parentId` null. Ids are Chromium's, digits.
- An item with `url` is a link, and one without is a folder. Titles are cleaned and cut at 256 characters, as tab titles are, and addresses at 2,048. Open one with `browser.tab.open` or `navigate`.
- `offset` pages through a big folder (`more: true` says there's more).
- `not_found` `{reason: "folder"}`: no such folder. `bad_request` `{reason: "folderId"}`: not an id, or a link's.

#### The key button

The Browser bar's key button opens a password manager, from a fixed list of three, and nothing else: Bitwarden (`nngceckbapebfimnlniiiahkandclblb`), 1Password (`aeblfdkhhhdcdjpifhhbdiojplfjncoa`) and Proton Pass (`ghmbeldphafepmbegfdlkpapadhbakde`), the ids the image's extension allowlist names.

`browser.extensions.list {}` gives all three, always in that order:

```json
{"extensions": [{"id": "nngceckbapebfimnlniiiahkandclblb", "name": "Bitwarden", "state": "installed", "open": false}, …]}
```

`state` is `installed`, `off` (installed and turned off, as a policy does) or `missing`. `open` says whether its page is open in a tab.

`browser.extension.open {id}`:
- **Installed:** opens the extension's own page (what its toolbar button would show) in a tab of its own, on screen, and answers `{tabId, page: "extension"}`. If one is open already, that tab comes to the front instead. This tab isn't in `browser.tabs`, so while it's on screen `browser.tabs` has no active tab: show the extension's name in the bar, and the key button as pressed. The member types into it through the stream as into any page. A password manager also opens windows of its own, for a passkey or to unlock; those come up on the desk's screen by themselves.
- **Missing:** opens its Chrome Web Store page as the member's own tab (in `browser.tabs`), and answers `{tabId, page: "store"}`. Adding it there is the member's own click.
- **Off:** `unavailable` `{reason: "extension_off"}`.
- An id that isn't one of the three is `forbidden` `{reason: "extension"}`; anything that isn't an extension id is `bad_request` `{reason: "id"}`.

`browser.extension.close {id}` closes that extension's tabs and goes back to the tab the member was on when it opened, if that's still there; `{closed}` is how many. With nothing open it's `{closed: 0}`. If the member had no tab of their own left, an empty one is opened first, as Chromium closes with its last tab.

The member can also close the extension's tab on the keyboard; `browser.extensions.list` then says `open: false`. There's no event for it: ask `browser.extensions.list` again when the Browser bar needs to know.

### On a phone

Touch control on phones (the owner's launch feature, Nov 11): a member drives the desk's Browser from a phone, not only watches it. While the session that looked at the Browser last is a phone's, deskd lays out every one of the member's tabs as that phone would, and turns on Chromium's touch emulation, so the pointer desk-rtc moves is a finger to the page. desk-rtc, the stream and the input channels don't change.

**Say what the session is on.** `desk.attention.set {seen, device}`. On a phone, `device` is `{kind: "phone", width, height}`: the CSS size of the box the Browser's picture fills, without the Browser's bar and without the on-screen keyboard, whole numbers from 160 to 2048. Send it with every `desk.attention.set`, and again when the box changes, as when the phone turns on its side, but not when the keyboard comes or goes: each new size reflows the page. Any other `kind`, or no `device`, isn't a phone. A `device` that isn't an object with a string `kind`, or a phone without both sizes in range, gets `bad_request` with `{reason: "device"}`, and nothing changes, `seen` included. A deskd older than this ignores `device`, so it's safe to send to every desk.

**Who the tabs follow.** Of the sessions that want `live` and look at the desk (`seen: true`, or a client that never says), the one that most recently began to look, went `live`, changed its device or put input on the screen (desk-rtc's report, which comes with the first input after a second without any) has the tabs. If it's a phone, they get its view, and otherwise the desk's own.
- A phone leaving gives the desk its own view back: its session ending, `seen: false`, `warm` or `off`.
- A desktop's first input after a second's rest takes the tabs from a phone. Saying `seen: true` again doesn't.
- **A change waits until it has held for 0.8 s,** and one between a phone's view and the desk's also waits until 4 s after the last, so two people taking turns can't reflow a page faster than that. A phone turning on its side waits only the 0.8 s.
- **The simplified view (§14)** is `warm`, so it never votes, and while it's in use anywhere (a `browser.minified` subscription on a desk somebody looks at, or for 15 s after a page call) the tabs keep the desk's own view, at once and with no wait. It reads the desk's layout, and its clicks are CDP's mouse, which under touch emulation lands at the screen's scale and never answers. So **unsubscribe `browser.minified:<tabId>` when the member leaves the simplified view**, or the phone's view doesn't come back.

**What deskd sets,** on each tab's own CDP session, and on a tab opened later as it attaches:
- `Emulation.setDeviceMetricsOverride`: `mobile: true`, the phone's CSS size, a screen of the same size, its orientation, and a scale that fits Chromium's window, `min(W / width, H / height)` rounded down to 0.01: 1.27 for 390x844 in 1920x1080. The page's `devicePixelRatio` is the same scale, so a box times the ratio is still its place on the screen.
- `Emulation.setTouchEmulationEnabled` (5 points) and `Emulation.setEmitTouchEventsForMouse` (`mobile`).
- **Chromium drops all of it with deskd's session,** so a lost connection, or a restart of deskd or Chromium, leaves the desk's own view until deskd sets it again.
- **No reload, no phone's user agent, nothing in the profile** (ADR 0035). A site's sign-in, or a bot wall's clearance, can be bound to the user agent it saw, so it never changes. Sites that go by the user agent alone keep sending their desktop page, at a phone's width.
- **The tab on screen keeps its place.** Chromium keeps the scroll offset in pixels, not what was at it (Chrome for Testing 158), so deskd puts the element nearest the top back where it was, both ways.
- **What a page sees then** (Chrome for Testing 158, `BrowserViewChromiumIT`): `innerWidth` 390, `devicePixelRatio` 1.27, `(pointer: coarse)`, `(hover: none)`, `maxTouchPoints` 5, a 390x844 portrait screen. `'ontouchstart' in window` is true only in a document made under the view, so a page already open is a phone's page from its next load.

**The picture.** Chromium draws the phone's view at its window's top left, at `scale` screen pixels per CSS pixel, and nothing of the page outside it. The stream is still the whole screen. While `browser.view` says `phone`, show only its `region` of the picture, scaled to fill the box, and send input as now, normalized to the whole picture: `x = round(65535 * (region.x + fx * region.width) / screen.width)`, with `fx` the touch's place across the box from 0 to 1, and `y` the same way. A desktop watching meanwhile sees the phone's view in the screen's top left corner: tell the member so, since its first input takes the tabs back.

**Gestures.** One finger is the primary button on `input` and `keys`, as a mouse is (`desk-runtime.md` §8.6): `BUTTON` 1 down where it lands, `MOVE` once a frame while it moves, `BUTTON` 1 up where it lifts. Touch emulation makes that a finger: a tap is a tap and a click, a drag scrolls the page with Chromium's own momentum, and a hold is a long press, which opens the page's menu or Chromium's (`contextmenu`). Don't send `WHEEL` for a drag in the phone's view. Measured with Chromium in kiosk mode on Xvfb and XTest input, as desk-rtc injects it: a tap at screen (300, 200) reached the page as a `pointerdown` of type `touch` at (236, 157), a 600 px drag up scrolled 702 px, a hold of 0.9 s fired `contextmenu`, a tap on a field focused it, and a tap outside the region reached nothing.
- **Before the view is the phone's** (`mode: "desktop"`), the same events are a mouse: a tap clicks, but a drag selects text. Send a drag as `WHEEL` then.
- **Hold a first finger back** for up to 100 ms, or until it moves 8 px or lifts, before sending its press. A second finger in that time makes it a pinch, and nothing goes on `input`.

**`browser.pinch {x, y, scale}`** zooms the tab on screen around `(x, y)`, normalized to the whole picture as input is, by `scale`, from 0.25 to 4. It's a mutation and needs input. It's Chromium's touchpad pinch, `Input.synthesizePinchGesture` with `gestureSourceType: mouse` at Chromium's own speed, since a touch source, or a faster pinch, didn't zoom at all (Chrome for Testing 158). It zoomed to the scale asked, around the point, in both views, and answers once the zoom is done, about 0.3 s later. One goes at a time. Show the pinch by scaling the picture locally, then send one with the whole scale when the fingers lift; in a long pinch, one about every 250 ms with the scale since the last, each after the last's reply. A page that forbids zoom (`user-scalable=no`) doesn't zoom, as on a phone. Errors: `bad_request` with `{reason}` `x`, `y` or `scale`, `forbidden` with `{reason: "permission"}`, and the tab calls' `unavailable` and `not_found`.

**Topic `browser.view`** needs a token with video. A SUB gets a snapshot first, then one whenever it changes: once a flip is done on every tab, and when what's focused changes. It's coalescible.

```json
{"mode": "phone", "sessionId": "cs-…", "width": 390, "height": 844, "scale": 1.27,
 "region": {"x": 0, "y": 0, "width": 495, "height": 1072}, "screen": {"width": 1920, "height": 1080},
 "field": {"tabId": "33C3EB58…", "kind": "email_address", "enterKey": "next", "box": {"x": 433, "y": 7706, "width": 13005, "height": 3083}}}
```

With the desk's own view it's `{"mode": "desktop", "field": null}`. `sessionId` is the phone's session, so a client knows whether the view is its own.

**`field`** is what has focus in the tab on screen while the view is a phone's, or null:
- `kind` is in the simplified view's words (§14): `plain`, `query`, `email_address`, `phone_number`, `web_address`, `numeric` or `multiline` (a `textarea` or anything editable), plus `decimal`, `secret` (a password: no suggestions) and `unknown`, which is the focus in a frame of another origin, which deskd can't see into: offer a keyboard button there rather than raising the keyboard.
- `enterKey` is the page's `enterkeyhint`: `enter`, `done`, `go`, `next`, `previous`, `search` or `send`, or null.
- `box` is normalized to the whole picture, as input is.
- **Null for anything not typed into:** a date, a select, a checkbox, a `readonly` or `disabled` field, `inputmode=none`. A new page in the tab ends it.
- **Never a value, a name, an id, a label or a URL.** deskd watches focus with listeners of its own in a world of its own in each document, and hears them through `Runtime.addBinding` on that world alone, with no `Runtime.enable`, at most every 30 ms.

**Raise the keyboard** when `field` becomes non-null for the tab on screen: focus the stream's hidden textarea with the `inputmode` and `enterkeyhint` that match, and place it at `box`. Blur it when `field` is null. Typing goes as today: composed text with `browser.text.insert`, and `KEY` for Backspace and Enter, since a phone's keyboard sends Backspace as a `deleteContentBackward` input event rather than a key.

**iOS raises its keyboard only for a focus inside the tap's own handler,** so `field` comes too late there. **`browser.field.at {x, y}`** says what a tap at that point would focus, normalized as input is: `{field: {kind, enterKey}}`, or `{field: null}`. It isn't a mutation, needs video, and goes by the tab on screen as last known, without reading the tab list again, so it takes one call into the page. Send it at `touchstart` with the touch's point and don't wait; if its answer is there by `touchend` and says a field, focus the textarea in the `touchend` handler. If it's late, show a keyboard button when `field` comes. A tap on a field's `label` counts as its field. It looks through open shadow roots and frames of the same origin; a frame of another origin is `unknown`. Errors as `browser.pinch`'s, with `forbidden` for a token without video.

`/health` adds `browser.view`: `phone` or `desktop`, and never whose.

### Zoom

The owner's per-app zoom (Nov 12; the office's half is ADR 0055): one level for the whole Browser, every one of the member's tabs and every site, now and later, from 50 to 200%. It's Chromium's own page zoom, so pages lay out again at the new width and text is drawn sharp at its new size: not a scaled picture, and not `browser.pinch`.

**`browser.zoom.get`** takes no params and answers `{level}`, a whole percent from 50 to 200. It needs a token with video, and doesn't reach Chromium.

**`browser.zoom.set {level}`** sets it: `level` a whole number from 50 to 200 (`150` or `150.0`), or `bad_request` with `{reason: "level"}` and nothing changes. It's a mutation and needs input (`forbidden` without, as a guild viewer's token is). It answers `{level}` once the level is kept on the desk; Chromium takes it then too if deskd is connected, or as deskd next connects. Any level in the range is taken, so the office's 10% steps and Chromium's own (67, 75, 80, 90, 110, 125, 150, 175) both are; 67 is Chromium's 2/3.

**`browser.view` says `zoom`**, the level, in every message, `desktop` and `phone` alike, so a client follows a change made anywhere (another session, Chromium's keys) without asking again. A deskd before this has no `zoom` there and answers `not_found` to both methods.

**Kept on the desk.** In `/data/desk/browser-zoom.json` (`{"level": 150, "swept": true}`, mode 0600, written whole through a new file and a rename), so the level is the desk's wherever the member comes from, and comes through a restart or a move with the volume. Chromium keeps it too, in its own profile, which deskd never writes (ADR 0035); deskd's file wins, so a Chromium that lost its copy gets the level back as deskd connects. A file that can't be read, or a link in its place, is 100%.

**How it's set.** CDP has no page zoom (Chrome for Testing 156 and 158), so deskd sets Chromium's default zoom with `chrome.settingsPrivate.setDefaultZoom` in a hidden page of Chromium's own, `chrome://password-manager/settings` (`ChromiumPages`, as the sign-ins' pages are: hidden, so no tab, no history, nothing session restore brings back, and only deskd's constant functions run there). `chrome://settings` has the same API but crashes Chromium's browser process when opened hidden. The page stays open 20 s after its last use, as it costs about 45 MB, then closes. Chromium applies a new default to every tab at once (about 2 ms) and opens new tabs at it. As deskd connects it checks: if every member tab already shows the level, no page opens.

**A site's own zoom.** Chromium remembers a zoom per site, which beats the default: Ctrl+= and Ctrl+- in the stream make one, and earlier ones may be in the profile. Setting the default to a site's level erases the site's, from Chromium's prefs too. So:
- **Chromium's keys fold in.** A member's tab whose page zoom changes with no new page (`Page.frameResized`, read from `Page.getLayoutMetrics` 0.3 s after its last change) is the member zooming: the level becomes it, held to 50..200, the site's own goes, and `browser.view` says the new level. Ctrl+0 sets a site back to the default, the level, so it changes nothing.
- **A site's remembered zoom is erased.** A tab whose new page comes at another zoom (within 1.5 s of its commit), or one found so as deskd connects, keeps the desk's level and the site's goes.
- **Once per desk,** at the first connection after this, deskd passes the default over every level Chromium's keys can make from 50 to 200% (11 of them) and back to the level, which erases those; `swept` in the file says it's done. Open tabs reflow 12 times in a few tens of milliseconds, once. Not past 200%, where a page's images could be fetched again at a larger scale: a site left at 250% or more is erased as its page commits.

**Not read while a phone's view is in play** (wanted, shown, or still on a tab): Chromium's mobile emulation sets page zoom aside (a tab reads 1 there), so the phone's layout is as before and nothing is folded in. The office offers no zoom then.

**Points from a client** on the desk's own view, `browser.pinch` and `browser.field.at`, are divided by the zoom: CDP's input is in the page's CSS pixels at its zoom, the screen's over the level. desk-rtc's pointer and keys are X's and need nothing.

**The Agent's tabs follow Chromium's default too,** in its own contexts and the member's, so deskd sizes each Agent tab's viewport by it (`Emulation.setDeviceMetricsOverride` at 1280z by 800z, scale factor 1/z): the Agent's page is 1280x800 CSS pixels at a ratio of 1 at any level, opened before a change or after.

`/health` adds `browser.zoom`: `{level, page}`, the level and whether the hidden page is open. deskd logs the level as it changes, and never a site.

Checked against Chrome for Testing 156 and 158 under no policy, the image's `ma.json`, and `ma.json` with the teen lock (`BrowserZoomChromiumIT`, and the Agent's in `AgentBrowsingChromiumIT`).

### Topic `browser.tabs`

SUB `browser.tabs` with no params. Every event is a whole list, the same shape as `browser.tab.list`:

```json
{"type": "snapshot", "data": {"tabs": [ … ]}}
```

- At most about 4 a second, coalesced, and only when something changed.
- It covers what happens by itself: a link clicked in the page, a new tab, a title the page sets. A title set with nothing else happening, or a tab changed on the keyboard, can take a second to show, and shows only while some session wants `live` or `warm`. Otherwise it shows at the next navigation, page load or call.
- **It stays subscribed while Chromium is down.** There's no event then, so you keep your last list, and no first event at all if there's no Chromium when you subscribe. The next one comes once Chromium is up, and it replaces your list, new `tabId`s included. Until then, calls get `unavailable`.
- If you fall behind, it follows the coalescible rule of §5: you get one fresh snapshot.
- **`since` has no effect here.** The topic publishes only while someone is subscribed, so nothing records what changed while you were away. Every SUB gets a whole list first, and that's also what starts the events again after a resume.
- **A refresh that takes away video ends it,** with `{"type": "error", "data": {"code": "forbidden"}}`.

`GET /health` on the admin socket adds `browser: {cdp, tabs, freeze, view}` and `stream: {wanted, rtc, seen}`, and, while deskd has the links socket up, `browser.links: {sent, dropped}`: how many links went out since deskd started, and how many were dropped, by the reasons under "Links out", a reason with none left out. Never a URL or a scheme. `freeze` is `running`, `freezing`, `frozen`, `thawing`, or `unsupported` when the image's `desk-units` doesn't know the verb (ADR 0045). `seen` is whether anyone is looking at the desk. The heartbeat says `health.checks.browser: "frozen"` while Chromium is frozen, and nothing else of it. They're counts and states, for information, and never fail health. `cdp` is `connected`, `connecting`, `idle`, `refused` or `displaced`. `refused` means the last look at Chromium's debugging port found a listener with the wrong uid, or a connection accepted on the port by one, or couldn't read who holds it, so deskd won't connect and calls get `unavailable`. With the wrong uid, `browser` also has `listenerUid`. `displaced` means Chromium is up on `::1`, as 127.0.0.1 was taken when it started. deskd restarts it, at most every 5 minutes, and until it's back calls get `unavailable`. While `browser.chromium` says `older_than_profile` it isn't restarted, as the start would very likely be refused and the stop would take away a browser that works. `browser.chromium` is `older_than_profile` from a refused start of Chromium until a start works, and absent otherwise. It's the one thing here for a person to act on, and the status stays what it was. It outlives a restart of deskd. A reboot clears it until the next start. `browser.ageGate` is `closed` while a start of Chromium has to wait for the owner's age band, and absent otherwise. It never says which band.

## 11. Agents

The Agent app's methods and topics (`web/agent/README.md`, "Interface"). desk-agent serves them and holds the agents, threads, keys and limits. deskd checks the session, `idem` and the rate limit as for any RPC, and relays each one unchanged to desk-agent's socket (`services/desk-agent/docs/proposals.md` §5). Only `owner` tokens may call or subscribe: an `export` session gets `forbidden` with `reason: scope` from the method table first (§4), and the relay's own check, `reason: permission`, stands behind it.

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.providers` | No | None | `{providers: [{id, name, console, keyPrefix}]}` |
| `agent.list` | No | None | `{agents}` |
| `agent.create` | Yes | `{name, purpose?, icon?, color?, tone?, keyId?, model?, solo?, workspaceMb?, ifRunnable?}` | `{agent}`, or `precondition_failed` with `reason: agent_cap` at the tier's cap (task 49), or `reason: cant_run` when `ifRunnable` is `true`, no `keyId` is given and the agent couldn't run now on the member's MA credits (§24; nothing is made). `icon` defaults to `hat`, `color` to the next free one (desk-agent `docs/multi-agent.md` section 7); an unknown `color` is `bad_request` `detail: color` |
| `agent.update` | Yes | `{agentId, name?, purpose?, icon?, color?, tone?, solo?, workspaceMb?, badgeHidden?, dismissBadgeNotice?}` | `{agent}`; `bad_request` `detail: color` for an unknown colour or for the lead, which keeps the Agent app's own (`indigo`) |
| `agent.bind` | Yes | `{agentId, keyId, model}` | `{agent}` |
| `agent.thread.get` | No | `{agentId, before?}` | `{agentId, messages, older, seq}`: a page, oldest first (below) |
| `agent.message.send` | Yes | `{agentId, text, attachments?}` | `{messageId, runId}`. The reply streams on the conversation topic. `attachments` is a list of upload ids from `agent.attach.put`; `text` may be empty when there are files. Refusals add `too_large` and `bad_request` with `details.reason` (and `name`, `limit`): `too_many`, `too_large`, `total_too_large`, `too_long`, `unsupported_type`, `legacy_office`, `binary`, `empty`, `encrypted`, `no_text`, `unreadable`, `too_complex`, `timeout`, `image_too_big`, `no_vision`, `missing`, `bad_upload`; `conflict` + `busy` or `staging_full` when the desk is holding too much |
| `agent.attach.put` | Yes | `{agentId, uploadId, name, size, index, data}` | `{uploadId, received, complete}`. One chunk of one file, `data` base64 of at most 512 KiB of the file, chunks in order from `index` 0, `size` the whole file's bytes, `uploadId` 8 to 48 of `A-Za-z0-9_-` chosen by the client. Held in desk-agent's memory only (ADR 0049); expires 10 minutes after its last chunk |
| `agent.attach.remove` | Yes | `{agentId, uploadId}` | `{}`. Zeroes a staged file |
| `agent.attach.caps` | No | `{agentId?}` | `{caps: {maxFiles, maxFileBytes, maxImageBytes, maxTotalBytes, maxFileChars, maxTotalChars, maxPdfPages}, ceiling, chunkBytes, vision?}`; `vision` (with `agentId`) says whether that agent's model takes pictures |
| `agent.attach.caps.set` | Yes | the `caps` fields to change | `{caps, ceiling}`. The desk owner's only (`forbidden` + `permission` for a guild member); each field within its ceiling or `bad_request` |
| `agent.run.stop` | Yes | `{runId}` | `{}` |
| `agent.seen` | No | `{agentId}` | `{}` |
| `agent.key.list` | No | None | `{keys}`, each with `available`. Never a key itself |
| `agent.key.add` | Yes | `{provider, label, secret}` | `{key}` |
| `agent.key.delete` | Yes | `{keyId}` | `{}` |
| `agent.key.models` | No | `{keyId}` | `{models: [{id, label, inputMicroUsdPerMTok, outputMicroUsdPerMTok, free, tools}]}`, the first a good default: for an Anthropic key `claude-sonnet-5-5` (else an older Sonnet, else the first that isn't a Fable model), never the provider's newest by default; OpenRouter's picks first |
| `agent.limits.get` | No | `{agentId}` | `{agentId, policy, usage, timeZone, pricesAsOf, desk, account}` |
| `agent.limits.set` | Yes | `{agentId, policy?, timeZone?}` | The same as `get` |
| `agent.audit.list` | No | `{beforeSeq?, limit?}` | `{entries, headHash, nextBeforeSeq}`, newest first |
| `agent.get` | No | `{agentId}` | `{agent}` (task 49) |
| `agent.caps` | No | None | `{caps}`: the tier's values as the desk applies them |
| `agent.delete` | Yes | `{agentId}` | `{}`. Never the lead |
| `agent.links.set` | Yes | `{agentId, solo, links: [{to, rules}]}` | `{agent}` |
| `agent.workspace.get`, `.read` | No | `{agentId, path?}`, `{agentId, path}` | `{quotaBytes, usedBytes, sharedWith, entries}`, `{path, text, bytes, truncated}` |
| `agent.workspace.delete`, `.share` | Yes | `{agentId, path}`, `{agentId, with}` | `{usedBytes}`, `{agent}` |
| `agent.timer.list` | No | `{agentId}` | `{timers, zone}` |
| `agent.timer.set`, `.delete` | Yes | `{agentId, timer}`, `{agentId, timerId}` | `{timer}`, `{}` |
| `agent.icon.upload` | Yes | `{agentId, png}` (base64, 256 KiB at most before encoding) | `{agent}` |
| `agent.icon.get` | No | `{agentId}` | `{png, version}`: the mask, owner tokens only like every method here |
| `agent.a2a.list` | No | `{agentId?, before?}` | `{messages, older}`, newest first |
| `agent.proposal.answer` | Yes | `{proposalId, accept, sha256}` | `{proposal}` |
| `agent.memory.list` | No | `{agentId}` | `{agentId, memories: [{id, text, createdAt, untrusted}], summary: {id, text, messages, throughId, at, untrusted} \| null, limits: {items, chars}}`: what the agent remembers, newest first, and its thread's summary (S-14) |
| `agent.memory.delete` | Yes | `{agentId, memoryId}` | `{deleted: true}`: one line, or the summary by its id; `not_found` with `detail: memory` for neither |
| `agent.memory.clear` | Yes | `{agentId}` | `{deleted}`: every line, and the summary |
| `agent.approvals.list`, `agent.approval.get` | No | §18 (draft) | §18 |
| `agent.approval.decide` | Yes | §18 (draft): `{approvalId, approve, sha256, note?}` | `{approval}`. Needs a token with input |
| `agent.access.get` | No | §18, "An agent's access": `{agentId}` | `{access}` |
| `agent.access.set`, `agent.desks.revoke` | Yes | §18: `{agentId, apps?, auto?, desks?}`, `{grantId}` | `{access}`, `{agentId, access}`. Need a token with input; deskd records the choice itself |

- **Task 49, many agents** (desk-agent `docs/multi-agent.md`, ADR 0047): deskd relays the methods above like the rest and checks nothing of their params, but refuses every team method (`agent.create`, `agent.delete`, `agent.links.set`, `agent.caps`, `agent.workspace.*`, `agent.timer.*`, `agent.icon.*`, `agent.a2a.list`, `agent.proposal.answer`) for a guild member with `forbidden` and `{reason: "permission"}`, as desk-agent does; only `agent.get` (their own agent) passes. The new fields of an agent, a message's `origin`, `tools` and `proposals`, and `agent.state`'s `caps` come through unchanged. `desk.account.set`, deskd's own push, now carries `tier`, the owner's tier's agent values from the config's `agentDefaults.tier` (kept with the other account values in `account-defaults.json`; a config with no tier keeps the last one, and desk-agent keeps the last it received). It also carries `band`, the owner's age band as deskd holds it (`adult`, `teen` or `unknown`): while it isn't `adult`, desk-agent fires no timer and starts no timer- or message-started run (due timers wait and resume when it is adult).

- **Memory (S-14,** desk-agent `README.md`, "Memory"**):** each agent remembers short lines about its member across conversations (its `memory_save` and `memory_forget` tools) and keeps a summary of the part of its thread too long to send whole. The member sees and deletes them with `agent.memory.*`, relayed like the rest: the owner for the desk's agents, a guild member for their own agent only (not team methods, so not refused `permission`), a teen never (`age_band`). Results carry a line's text; deskd logs and audits no params or results, as for every `agent.*` call. A delete is final: a deleted summary's messages are never sent to a model or summarized again. They go with the agent, with a member's purge (its answer adds `memories`), and in the export's `agent` part (`agent.db`).
- **Errors** are desk-agent's, with its `code` and `details` as they came: `precondition_failed` with `reason` `no_key`, `limit_reached` (and `scope`), `key_refused` or `agent_cap`; `conflict` with `reason: busy`; `unavailable` with `reason: storage` (below); `bad_request` with `reason` and `detail`. A code deskd doesn't have becomes `internal`. A provider failure during a run isn't an error here: the reply's message ends `failed`, with `error: "provider_error"` and `errorDetail` one of `auth`, `rate_limited`, `free_limit`, `data_policy`, `bad_request`, `timeout`, `unavailable`, `cancelled`. `free_limit` is the provider's free allowance for today used up (OpenRouter's free requests a day): say "Today's free limit is used" plainly. `data_policy` is the member's privacy settings at OpenRouter allowing no endpoint for that model.
- **`agent.thread.get` comes in pages.** Without `before`, it's the thread's newest messages; with `before`, a message's `id`, those older than that message. A page holds as many as fit in about 960 KiB of JSON, up to 1000, so its RES is never `too_large`. `older: true` says there are more before its first message, whose `id` is the next `before`. The newest message of a page always comes: if it alone is too long, it keeps the start of its text and has `truncated: true`. A `before` that isn't a message of that agent's thread is `not_found` with `detail: message`. `seq` is the conversation topic's, as before. A client that doesn't send `before` gets the newest page, as it got the newest 1000 messages before; a thread past 1 MiB used to answer `too_large`.
- **desk-agent not running,** or not answering in time, is `unavailable` with `reason: unavailable`. Not running, a mutation's answer has no `mayHaveApplied`: nothing was sent, nothing changed, and the same key runs it once desk-agent is back. Only a desk-agent that drops while the request is going out, or doesn't answer in time, adds `mayHaveApplied: true`. deskd waits 30 s for `agent.key.add` and `agent.key.models`, which call the provider, and 10 s for the rest. Past that, desk-agent is told to stop the call. At most 16 calls of one session wait on desk-agent at once, half a session's 32 (§4), and more get `unavailable` at once, so a desk-agent that has stalled never gets a session's other calls, the Browser's included, `rate_limited`. A desk-agent that stops reading for 5 s mid-request loses its connection, and everything waiting on it gets `unavailable`; it reconnects as it does after a restart.
- **The Agent app is off for teens** (`ma-platform` age rules, §3.2). While the owner's age band is `teen`, every method here and every SUB below gets `forbidden` with `reason: age_band`, and while it isn't known yet `unavailable` with the same reason. Either comes after the scope check and the token's owner check, and before anything reaches desk-agent, so nothing was done, there's no `mayHaveApplied`, and after `unavailable` the same key runs the call. A key sent to `agent.key.add` gets the same answer, malformed or not, and deskd never copies it. Hide the app from what `GET /v1/me` says of `ageBand` rather than from these errors, which are the backstop.
- **`agent.key.add`** is the only call with a key. deskd takes `secret` out of the params and checks it's 8 to 1024 characters of printable ASCII with no space, or answers `bad_request` with `reason: key_malformed` and `detail: format`, and sends desk-agent nothing. Otherwise the key goes to desk-agent apart from the JSON, with this desk's id, and deskd zeroes its own bytes of it. desk-agent first refuses a key that starts with another provider's `keyPrefix` (`agent.providers`) rather than the one picked, before anything leaves the desk: `bad_request` with `reason: key_malformed` and `detail: provider_mismatch`. The longest prefix that fits says whose a key is, so `sk-ant-…` is Anthropic's though it starts with OpenAI's `sk-`; a prefix two providers share at that length (OpenAI's and Moonshot AI's `sk-`) names neither. Check it the same way on the client. A key with no known prefix goes on to the provider. Then desk-agent checks the key with the provider's model list (OpenRouter's key endpoint, as its list is public): a refusal is `precondition_failed` with `reason: key_refused` and `detail: auth`. It then seals the key on the desk's own disk: if it can't, the answer is `unavailable` with `reason: storage`, and nothing is kept, so a retry is safe. Don't log this call's params anywhere on the client.
- **Google and Moonshot AI, a member's own keys** (desk-agent `README.md`, "Google and Moonshot AI", 2026-11-15). `agent.providers` lists `{id: "google", name: "Google", console: "aistudio.google.com", keyPrefix: "AIza"}` and `{id: "moonshot", name: "Moonshot AI", console: "platform.kimi.ai", keyPrefix: "sk-"}`, after `openrouter`. Moonshot's `sk-` is OpenAI's too: two providers sharing the longest prefix that fits means the key could be either's, so neither is a mismatch (the desk sends it on to the picked provider's check, and a client names both). A Moonshot key has no marker of its own, so one picked as OpenAI's goes on to OpenAI's check; OpenAI's project, service-account and admin keys (`sk-proj-`, `sk-svcacct-`, `sk-admin-`) are OpenAI's alone on the desk, so one picked as Moonshot's is `provider_mismatch` (those longer prefixes aren't in `agent.providers`, so a client's form lets such a key through and the desk refuses it). An OpenRouter or Anthropic key picked as Moonshot's, and a Gemini key picked as anyone else's, are `provider_mismatch` too. The key check is the provider's model list; `agent.key.models` lists its chat models, newest family first, with null prices (neither is in the price table yet, so their calls count at the table's highest). On a desk, desk-agent reaches `generativelanguage.googleapis.com` and `api.moonshot.ai` only once the image's name filter lists them.
- **OpenRouter, the "$0 first Agent run"** (desk-agent `README.md`, "OpenRouter"). `agent.providers` lists `{id: "openrouter", name: "OpenRouter", console: "openrouter.ai", keyPrefix: "sk-or-"}`, after `xai`. The Agent app gets the key with OpenRouter's PKCE flow in the member's browser (`https://openrouter.ai/auth` with `callback_url`, `code_challenge` and `code_challenge_method: S256`, then `POST https://openrouter.ai/api/v1/auth/keys` with `code`, `code_verifier` and `code_challenge_method`, both from the browser) and sends it with `agent.key.add`, `provider: "openrouter"`, as any key: it never goes to the platform. `sk-or-` is longer than OpenAI's `sk-`, so an OpenRouter key picked as OpenAI's, or an OpenAI or Anthropic one picked as OpenRouter's, is `provider_mismatch`. `agent.key.models` then lists OpenRouter's free models only, best first; each has `free: true` and 0 prices, and `tools: false` for one that takes no tools, which still chats but can do nothing on the desk. A free model costs $0, so no dollar limit refuses it (token limits still bind). Paid OpenRouter models aren't listed yet. On a desk, desk-agent reaches `openrouter.ai` only once the image's name filter lists it.
- **Keys last** (ADR 0042). They survive restarts, updates and reboots, move with an export or a move (§12), and go with the desk. A key belongs to one desk: to use it on another, enter it there. `available` is `false` when a key's sealed file is missing or won't open, as after a lost `master.key`: it stays listed, a send or `agent.key.models` gets `precondition_failed` with `reason: no_key`, and the member deletes it and adds it again.
- **`agent.key.delete`** answers once the key's row, its copy in RAM and its sealed file are gone. `unavailable` with `reason: storage` means the file couldn't be removed: the key is already out of the list and unusable, and the same call finishes the job, as does the next start. A key that doesn't exist is `not_found`.
- **A mutation's point of no return** is the moment the request's bytes start going to desk-agent. Before it, a cancel, a deadline or the session's end stops it, and an `unavailable` has no `mayHaveApplied`. After it, a retry with the same key gets its result (§4).
- **CANCEL** reaches desk-agent too, unless the mutation has started.
- **Spending limits** (ADR 0043). `policy` has the scopes in force, now with `deskDay` beside `deskMonth`, and `usage` has `desk_day` with its `resetsAt`. A limit it passes refuses with `limit_reached` and `scope: desk_day`, like the others.
  - **Three values layer, desk then account then default:** `deskDay` (none), `deskMonth` ($20) and `timeZone` (null, which means periods run in UTC). `policy` and `timeZone` are what's in force. `desk` and `account` are each `{deskDay, deskMonth, timeZone}`: what this desk and the account have set, each field null when nothing is set. `timeZone`, `deskDay`, `deskMonth` and `keyMonth` apply to the whole desk.
  - **`agent.limits.set`:** for `policy.deskDay`, `policy.deskMonth` and `timeZone`, absent changes nothing, an explicit null clears this desk's so it follows the account, and a `Limit` with both caps null is "no limit, set on this desk". So send one only when the member changed it: sending back what's in force pins it to this desk. Every other field of a `policy` is required, or it's `bad_request` with `detail` naming the field. With neither `policy` nor `timeZone`, nothing changes. **Audit:** the call writes one row, `limits.set`, except when it carries only `timeZone` (no `policy`): that is the app setting the browser's zone on its own, and the row's action is `limits.timezone` (actor `user`, target `agent:<agentId>`), so Activity can say "Time zone set to …". A call with a `policy`, with or without `timeZone`, is `limits.set`.
  - **A zone** is an IANA region the JDK knows, or `UTC`. A fixed offset (`+05:00`, `Etc/GMT+5`) or an unknown name is `bad_request` with `reason: time_zone`, and nothing changes. Days, weeks from Monday and months begin at midnight there, and a changed zone applies at once to what's already been spent.
  - **Prices:** `pricesAsOf` is the `checked` date of the table in use, the Platform's or else the bundled one, or null if it has none. A model the table doesn't list counts at its provider's highest listed price by `output`, or the whole table's if it lists nothing for that provider, in the reservation and in what's settled, so a dollar limit always binds. A model the table lists at `input` 0 and `output` 0, in either length tier, counts as one it doesn't list: a table never makes a model free. `agent.key.models` still gives such a model null prices, so say it has no listed price. Its messages' `costMicroUsd` is that estimate, not null. The one way a model is free is its provider serving it free by its id: OpenRouter's `:free` models and `openrouter/free` are $0 (prices 0, `free: true`, `costMicroUsd` 0), whatever the table says, and a cost OpenRouter reports anyway is charged. `free` is `false` for every other model.

### Topics `agent.state` and `agent.conversation:<agentId>`

SUB with no params. `<agentId>` is 1 to 64 of `A-Z a-z 0-9 _ -`; anything else is `not_found`.

- **`agent.state`:** every event is `{"type": "snapshot", "data": {"agents": [ … ]}}`, the whole list, on each change.
- **`agent.conversation:<agentId>`:** a `snapshot` with `{messages, older}` first, then `message` with `{message}`, which adds or replaces a message by `id`, and `delta` with `{messageId, runId, text}`, which appends to a streaming reply. The reply's last `message` has its whole text.
- **Both are coalescible and serve no `since`:** every SUB gets a snapshot first, and a client that falls behind gets a fresh one (§5). A `delta` that comes while your snapshot is being made can repeat text already in it, until the reply's last `message`.
- **A thread's snapshot is its newest messages, and `older: true` if there are more.** desk-agent sends `agent.thread.get`'s newest page (above), and an EVT is at most 64 KiB, so deskd may keep fewer: then `omitted` says how many of that page it left out, and `older` is `true`. Either way, page back from the snapshot's first message with `agent.thread.get` and `before`. `older` is new: a client that ignores it sees what it saw before, with no `error` for a long thread. A desk-agent from before pages can't send a long thread's snapshot at all, and then the topic starts with `{messages: [], older: true}` and carries on. A message too long keeps the start of its text and has `truncated: true`; `agent.thread.get` has the whole of it, up to about 960 KiB of JSON. A long `delta` comes as several, in order. **`agent.thread.get` answers what desk-agent had when it was asked,** and it travels apart from the topic's events (§5: channels aren't ordered against each other), so an `approval`, `message` or `delta` that came while it was out can be newer than it. Merge it, never put it over what's shown: what an event touched since the read was asked stays as the events made it, and the rest comes from the read; a `snapshot` that came meanwhile replaces it, so read again after that one if it's cut too (the Desk app's `watchConversation`, `sub/mm-fix-bundle-2`: release 3 found an open window's card put back to "Running" after a desk-agent restart).
- **An agent that doesn't exist** ends the subscription with `{"type": "error", …}`.
- **While desk-agent is down** a subscription stays, with no events, and no first event if it began then. When desk-agent is back, it gets a fresh `snapshot`.
- **A desk that becomes a teen's** ends both topics at once, with `{"type": "error", "data": {"code": "forbidden"}}`, as a refresh that takes a right away does.

`GET /health` adds `agent`: `connected` or `waiting`, for information only. The heartbeat's `agent` (agent.md) comes from `agent.state`: `busy` while an agent is `working`, `error` if one is in error, `online` otherwise, and `offline` while desk-agent can't be reached. An agent `working` with `statusDetail: "awaiting_approval"` is waiting for the member, not working, and one with `"waiting_desk"` is waiting for another of the member's desks: neither is `busy` or counts in `activeTasks`, so a wait never keeps the desk awake (§18).

## 12. Data export and transfer

Built for task 32 (`docs/decisions/draft-data-export-and-transfer.md`), and in no release yet: a deskd before it answers `not_found`, and refuses an `export` token. It's how the owner downloads all their data and how `ma-move` copies a desk to their own hardware. The desk's files come from a root helper, `desk-data`, on `/run/desk/data.sock` (that draft's Appendix), as deskd itself can read only its own directory. **A desk without the helper answers `data.parts.list`, `data.manifest` and `data.read` with `unavailable` and `{reason: "helper"}`.** No image has it yet.

Owner and `export` sessions may call all of these (§9). None needs video or input. The bytes go only over this session's own data channels, so the platform never sees them.

**A frozen Browser** (§10, "Nobody looking"): a desk being exported is unseen, so its Chromium can freeze. `data.parts.list`, `data.manifest`, `data.read`, `data.read.stop` and the free-byte count go to `desk-data` alone, so they work as ever and don't thaw it. `data.browser.cookies` thaws Chromium first, which adds about a tenth of a second, and keeps it thawed for a minute. `data.browser.hold` and `data.browser.release` thaw it before their stop and start, as systemd won't stop a frozen unit; if that thaw fails, the stop is refused and so is the hold.

**What's free.** A `data.read` from an `export` session doesn't count against the member's bandwidth limit, up to 3 times the size of the desk's data volume in 30 days, which covers a full export, a move and retries. The 30 days start at the first free byte, and deskd keeps the count on the volume, so a restart doesn't refill it. Past that, its bytes count like anything else the desk sends, and they still arrive, during a bandwidth pause too (below). A `data.read` from an `owner` session always counts. So an export asks `POST /v1/desks/{id}/connect` for an `export` token, as the Desk app and `ma-move` do. Every frame byte counts, header and END frame included, and the heartbeat's `media.freeBytesSent` says how many were free.

### Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `data.parts.list` | No | None | `{parts: [{part, label, files, bytes}], helperVersion}` |
| `data.manifest` | No | `{part, cursor?}` | `{entries: [{path, type, size, mtimeMs, mode, target?}], next}` |
| `data.read` | No | `{part, path, offset?}` | `{transferId, size, mtimeMs}`, then the file on `bulk` |
| `data.read.stop` | No | `{transferId}` | `{}` |
| `data.browser.hold` | Yes | None | `{held: true, until}` |
| `data.browser.keep` | Yes | None | `{held: true, kept: true, since}` |
| `data.browser.release` | Yes | `{kept?}` | `{held}` |
| `data.browser.cookies` | No | None | `{count, items: [{k, v, e}]}` |

- **`data.parts.list`** is the helper's answer as it is. A part is a top-level directory of the desk's data, less what belongs to the machine (the draft, decision 4). deskd leaves those out itself too, whatever the helper says, and `data.manifest` and `data.read` of one get `not_found`: `rtc`, `selfhost` (a self-hosted desk's key and pairing), `desk-egress`, `lost+found`, `.ma-export-tmp` and `.ma-move`. Inside `desk`, deskd also leaves out the bundled apps' registry (`apps/registry.json`), each one's member-pseudonym key (`apps/<id>/member.key`) and every bundled app's `apps/<id>/cache` (§19, "Bundled apps"). Inside `apps` it leaves out the same: `registry.json`, `<id>/member.key` and `<id>/cache`. They're dropped from `data.manifest`'s pages, so a page can come back shorter, or empty with a `next`, and `data.read` of one gets `not_found` before the helper hears of it. `label` is its name for the member, and `files` and `bytes` are an estimate, from a walk with no hashing. Send a `deadlineMs` of a minute or more: on a cold disk the walk takes a while, and deskd gives the helper 2 min.
- **`data.manifest`** is one page of a part, at most 2,000 entries, in an order that holds while nothing changes, so a page never repeats or skips one. `type` is `file`, `dir` or `link`, with `target` for a link. `path` is relative to the part and `/`-separated. Pass `next` back as `cursor` for the next page: it's `null` on the last one, and opaque. A page whose reply wouldn't fit one RES (§2) comes smaller, down to one entry, with `next` as usual. A SQLite file's `size` is its size on disk, which can differ from what `data.read` sends.
- **`data.read`** answers straight away, and the file follows on `bulk` (below). `size` is the length of the whole file, counting from byte 0, as it will be sent: for SQLite, a consistent copy's. `offset` defaults to 0. `transferId` is unique in this session, from 1, and never comes back within it. While the Platform has this member paused at a bandwidth limit (§10), it's refused, as `live` is, for an `owner` session. **An `export` session's is never refused for a pause,** within its free 3 volumes or past them, so a paused member can always take their data away. Past them its bytes still reach the meter, and the Platform's cost guard and the desk's throttle bound what they can cost. Before this (Security's `NE-1`), an `export` session past them was refused too, and the Desk app's download ended "done" with every file it hadn't reached skipped. Transfers already running finish, and nothing else in this section is refused for a pause.
- **`data.read.stop`** ends a transfer now, with nothing more sent for it, not even END. A transfer that has ended, or never was, gets `{}` too.
- **`data.browser.hold`** stops Chromium and keeps it stopped, so a copy of its profile is exact, until `data.browser.release`, this session's end, or `until`: 30 minutes. The reply comes once Chromium has stopped. While held:
  - `browser.stream.set` with `live` or `warm` gets `unavailable` with `{reason: "held"}`, from every session, and so does one still waiting when the hold came. `off` works.
  - A session that was already `live` or `warm` stays so, with the stream showing the desk without its Browser, and gets Chromium back when the hold ends.
  - Holding again from the same session is the same hold, and `until` starts again. Another session can hold too: Chromium stays stopped until the last of them lets go.
  - It needs `idem`, as a mutation.
- **`data.browser.keep`** keeps this session's hold after the session ends, with no time limit, until the owner lets go: what a move does once its last pass over the Browser is done (Security's `NE-2`). Without it the move's release started the cloud desk's Chromium again on the cookies the member's new desk now has, and a site that rotates its sign-in tokens would sign them out there. The session must hold the Browser now, and have held it since its hold, so Chromium can't have run between the copy and the keep. deskd writes `/data/desk/browser-moved.json` (`{since}`) before it answers, so the keep outlasts a restart of deskd and a reboot: deskd holds the Browser again as it starts, before anyone can ask. Kept again, from any session that holds, it's the same keep, with `since` from now. It's a mutation whose effect outlasts the session, so a retry with the same `idem` from another session gets the same reply. It never touches `/data/browser/profile` (ADR 0035). While kept, `browser.stream.set` with `live` or `warm` gets `unavailable` with `{reason: "moved", since}` (§10). An `export` session's own `data.browser.release` leaves it as it is, and so does the session's end.
- **`data.browser.release`** lets go of this session's hold. `held` is true only while another session still holds it, or a move kept it. With `{kept: true}`, from an **owner** session only, it also lets go of a move's kept hold: the member's word, given in the Desk app, that they want this desk's Browser back. deskd removes the file first. An `export` session asking that gets `forbidden` with `{reason: "scope"}`, as a download or a move is never the member's say. With nothing kept, `kept: true` is harmless. Once the last hold ends, however it ends, Chromium starts again if it was running when the hold stopped it, whether or not a session wants `live`, so the desk is as the hold found it; one that wasn't running stays stopped unless a session wants `live`. After a restart of deskd a kept hold found Chromium stopped, so ask for `live` again once it's let go.
- **`data.browser.cookies`** says which cookies Chromium has, and never a cookie: for each one, `k` is the first 16 hex characters of SHA-256 of UTF-8 `domain\tname\tpath`, `v` the same of its value, and `e` when it expires, in whole Unix seconds, or `-1` for a session cookie, so the move can leave out what expired in between. Items are sorted by `k`, `v`, then `e`, so two desks with the same cookies give the same answer, which is what the move compares. Two cookies that differ only by partition have the same `k`. It reads the running Chromium, so it doesn't start one.

### Transfers on `bulk`

| From | Kind | Flags | `id` | `seq` | Payload |
|---|---|---|---|---|---|
| deskd | CHUNK (15) | BIN | `transferId` | 0, 1, 2… | Up to 16,372 bytes of the file, in order from `offset` |
| deskd | CHUNK (15) | BIN, END | `transferId` | The next | The trailer, 40 bytes, or nothing if the transfer failed |
| Client | CREDIT (16) | None: JSON | `transferId` | 0 | `{"bytes": n}` |

- **Credit** counts the file's bytes, which are CHUNK payloads before the END. `data.read` grants the first 1 MiB itself, so send CREDIT only to grant more: after you've written what came, in steps of at least 256 KiB. deskd sends exactly up to the credit, so a frame is smaller when that's what's left. The END frame needs none.
- **Each CHUNK is a message of its own,** with no MORE, and transfers' frames interleave. deskd sends a transfer's first CHUNK once the RES of its `data.read` has gone, but channels aren't ordered against each other (§5), so keep CHUNKs for a `transferId` you don't know yet.
- **The trailer** is the SHA-256 of the whole file from byte 0 to its end, then a u64 big-endian of how many bytes that was. It comes from the helper unchanged, so a read from an offset is checked end to end: hash the bytes you had with the ones that came. A file that changed while the helper read it, one that ended early or grew included, gets no trailer: its END is empty (below). If what you have doesn't match the trailer, or its length isn't `data.read`'s `size`, read it again from 0.
- **An END with an empty payload** means the transfer failed: the helper failed, the file changed while it was read, or deskd had no credit from you for 5 minutes. The helper itself waits longer than that for deskd (`tools/desk-data/README.md`), so 5 minutes is the limit you meet. What came before it is the file's, but nothing has checked it. Read again, from your offset if you like, as that read's trailer checks all of it.
- **A transfer ends with its session.** Nothing on `bulk` carries over a resume or a new connection: read again from your offset.
- **A CREDIT deskd can't read,** or for a transfer that has ended, is dropped, and so is any other kind on `bulk`.
- **At most 8 transfers at once per session, and 12 on the whole desk.** One past either gets `too_many` and nothing is asked of the helper. A session's transfers give their places back as they end, its own end included. deskd reads from the helper only what it's about to send, and holds about 80 KiB per transfer waiting for desk-rtc, so one slow transfer slows only itself.
- **Speed.** `bulk` goes after every other channel (§6), and desk-rtc sends it at about 8.8 Mbit/s at 50 ms (`desk-runtime.md` §4.5), so clicks stay quick while a download runs. Up to 8 at once fill that best.

### Errors

| Error | `details` | Meaning |
|---|---|---|
| `bad_request` | `{reason}`: `part`, `path`, `offset`, `cursor` or `transferId` | That field is missing or the wrong type, or `offset` isn't a whole number from 0 |
| `invalid` | `{reason: "part"}`, `{reason: "path"}` | Not a part's name (empty, `.`, `..`, or with `/` or NUL in it), or not a path inside one: empty, starting with `/`, with an empty, `.` or `..` component, or with NUL. deskd checks before the helper hears of it |
| `invalid` | `{reason: "length"}` | The request is too long for the helper, which takes 16 KiB: a path or cursor of about 16,000 bytes, or fewer with characters JSON escapes |
| `invalid` | `{}` | The helper refused the path: it leads out of the part, or isn't a regular file for `data.read` |
| `not_found` | `{}` | No such part or path, or one of the machine's (above) |
| `too_many` | `{limit: 8, reason: "session"}` | `data.read`, past 8 transfers in this session. Stop one, or wait for one to end |
| `too_many` | `{limit: 12, reason: "desk"}` | `data.read`, past 12 transfers on the desk, from all its sessions. Wait for one to end |
| `unavailable` | `{reason: "helper"}` | This desk has no helper yet, or it failed or didn't answer in 2 min. Nothing was done |
| `unavailable` | `{reason: "bandwidth_limit", resumesAt}` | `data.read`, from an `owner` session, while the member is paused at a bandwidth limit. `resumesAt` is when the pause ends, as in §10, or null if the Platform didn't say. Nothing was opened. Read again then. Never sent to an `export` session; a deskd before `NE-1`'s fix sends it to one past its free bytes, and a client should then stop the whole run and say when it can go on, never skip the file |
| `unavailable` | `{reason: "chromium"}` | `data.browser.cookies`: Chromium isn't running, or didn't answer in 5 s |
| `unavailable` | `{reason: "chromium", code?, mayHaveApplied: true}` | `data.browser.hold`: Chromium couldn't be stopped, or not within 50 s. `code` is the unit's, as in §10, when it gave one. This session doesn't hold it, and nothing else changed |
| `unavailable` | `{reason: "not_held", mayHaveApplied: true}` | `data.browser.keep` from a session that doesn't hold the Browser, or whose hold ended while the keep was written. Nothing is kept: hold, copy what changed, and keep again |
| `unavailable` | `{reason: "disk", mayHaveApplied: true}` | `data.browser.keep`: the desk couldn't write its file, so nothing is kept. `data.browser.release` with `kept: true`: it couldn't remove it, so the Browser stays kept |
| `bad_request` | `{reason: "kept"}` | `data.browser.release` with a `kept` that isn't `true` or `false` |
| `unavailable` | `{}` | The session ended while the call ran |
| `forbidden` | `{reason: "scope"}` | Any method but these and `desk.status.get`, from an `export` session (§4), and `data.browser.release` with `kept: true` from one |

## 13. Notebook

Built for S-13, and in no release yet: a deskd before it answers `not_found` on these methods and the topic, and drops `collab`. Notebook's pages live only on the desk, in `desk-notebook`, a service nothing but deskd can reach. deskd checks the session and relays: it reads and keeps no note content, and logs none. Nothing goes to the Platform, and nothing needs keeping in the browser beyond the open tab's memory.

Only `owner` tokens may use any of this. An `export` session gets `forbidden` with `{reason: "scope"}` on every method and on SUB, as §4 says, and its DATA is dropped with no reply.

### Page text: `collab` (channel 3)

**`collab` is one virtual WebSocket per session.** Each binary message of Hocuspocus's protocol is one DATA message with BIN set, and Hocuspocus's own multiplexing carries many pages over it.

- **The client side:** `HocuspocusProviderWebsocket` with a `WebSocketPolyfill` around the channel, and one `HocuspocusProvider` per open page. `name` is the page's id. `token` is any non-empty string, as deskd has already checked the session.
- **The virtual socket opens with your first DATA.** The adapter can report `open` as soon as the channel is open. Choose any `id` for your DATA, and `seq` 0. Send each message whole before the next, as §2 says of any message.
- **Reassemble what deskd sends as §2 says.** All of it has `id` 0, one whole message after another. BIN set means a message for the provider.
- **DATA without BIN from you is ignored,** as is any other kind on this channel.

**Reset.** One DATA without BIN, whose payload is `{"t":"reset"}`, means the virtual socket has gone. The adapter fires `close`, the provider reconnects with its own backoff and resends what's unsynced, and the first DATA opens a new one. Keep `hasUnsyncedChanges` for the `beforeunload` warning (design 5.5).
- **It comes when** `desk-notebook` restarts, or isn't there when DATA comes, in which case that DATA was dropped. It also comes if deskd drops the session's link to it: `desk-notebook` stalled for 5 s with bytes waiting, or sent a message that couldn't reach you (over 4 MiB), or you left its messages unread for 30 s.
- **It's only about the virtual socket.** The session stays, and with it the Browser and everything else. Only a session that has sent DATA since the last one gets one.
- **One can arrive on a socket the adapter has just opened,** while `desk-notebook` is still away, if the DATA that earned it was already on its way. That just closes it again, which is right.

**Sizes.** DATA stops at 4 MiB after reassembly, and going over it closes the whole session, Browser included, with 4001 (§2). So:
- The editor must split a paste over about 1 MiB into several transactions, and the adapter must never send a message over 4 MiB.
- A page whose Yjs state passes about 3.5 MiB (about 700 printed pages) can't sync to a new client, so the desk refuses further growth on that page, keeps what it has, and says so through the provider's close reason `page_full`. Other pages carry on.
- A message from `desk-notebook` over 4 MiB is deskd's to stop. You get `reset`, and the session stays.

### Everything else: methods on `rpc`

Records are `web/notebook/src/model/types.ts` as they are. Last writer wins: no client sends `rowVersion`, which stays on the records only for information. Mutations carry `idem` (§4).

| `NotebookBackend` | Method | Mutation | Params | Result |
|---|---|---|---|---|
| `tree()`, `ready()` | `notebook.tree` | No | `{cursor?}` | `{notebooks: NotebookRec[], tabs: TabRec[], pages: PageRec[], rev, next}`. Flat; the client builds `Tree` with `model/tree.ts`. Pages come 1,000 at a time; repeat with `next` until it's null |
| `createNotebook` | `notebook.notebook.create` | Yes | `{title?}` | `{notebook, tab, page}` |
| `renameNotebook` | `notebook.notebook.rename` | Yes | `{id, title}` | `{}` |
| `createTab` | `notebook.tab.create` | Yes | `{notebookId, title?, color?}` | `{tab, page}` |
| `renameTab` | `notebook.tab.rename` | Yes | `{id, title}` | `{}` |
| `recolorTab` | `notebook.tab.recolor` | Yes | `{id, color}` | `{}` |
| `addTabAtPage` | `notebook.tab.addAtPage` | Yes | `{pageId, title?}` | `{tab}` |
| `createPage` | `notebook.page.create` | Yes | `{tabId, after?}` | `{page}` |
| `movePage` | `notebook.page.move` | Yes | `{pageId, tabId, index?}` | `{}` |
| `trashPage` | `notebook.page.trash` | Yes | `{pageId}` | `{}` |
| `restorePage` | `notebook.page.restore` | Yes | `{pageId}` | `{}`. On a guild desk, `forbidden` (`reason: grant`) unless the caller holds `moderate` or trashed the page themselves; a trashed page's `content`, `version.*` and collab open are refused the same way to anyone without `moderate` (`docs/sub-status/notebook-guild.md`) |
| `pageContent` | `notebook.page.content` | No | `{pageId, cursor?}` | `{part, next}` |
| `versions` | `notebook.version.list` | No | `{pageId}` | `{versions: VersionMeta[]}` |
| `version` | `notebook.version.get` | No | `{versionId, cursor?}` | `{meta: VersionMeta \| null, part, next}` |
| `saveVersion` | `notebook.version.save` | Yes | `{pageId, reason?}` | `{version: VersionMeta \| null}` |
| `restoreVersion` | `notebook.version.restore` | Yes | `{pageId, versionId}` | `{}` |
| `versionAsOf` | `notebook.version.asOf` | No | `{pageId, day}` | `{versionId: string \| null}`, then `notebook.version.get` |
| `activity` | `notebook.activity` | No | `{fromDay, toDay, cursor?}` | `{rows: ActivityRow[], next}`. Newest day first, then by page id; repeat with `next` until it's null |
| `activeDays` | `notebook.activity.days` | No | `{}` | `{days: string[]}` |
| `search` | `notebook.search` | No | `{query, notebookId?, tabId?, fromDay?, toDay?, limit?}` | `{hits: SearchHit[]}` |
| (new) | `notebook.settings.set` | Yes | `{timeZone}` | `{}` |
| `agentEdits` | `notebook.page.agentEdits` | No | `{pageId}` | `{edits: AgentEdit[]}`: the page's agent edits of the last 30 days, newest first, 50 at most (`{editId, op, agent, at, versionId, undone}`; `agent` is the agent's id, or on a guild desk the member's), for the page's foot ("Edited by {agent}") |
| `undoAgentEdit` | `notebook.page.agentUndo` | Yes | `{editId}` | `{editId, pageId, op, undone: true}`: exactly what that agent edit put there comes out, while it's as the agent left it. The page's newest agent edit goes first, each back to exactly the page before it: an older one while a newer stands is `conflict` `reason: newer`, with the newer one's `editId`. `conflict` with `reason: changed` and the `versionId` from before it to offer instead, `undone`, `trashed`; `not_found`; on a guild desk `forbidden` `grant` unless it was the caller's own agent's or they hold `moderate` |

- **`part` and `next`:** a page's or version's ProseMirror JSON can pass RES's 1 MiB, so it comes as text in parts of at most 512 KiB. Concatenate them until `next` is null, then `JSON.parse`.
- **`notebook.activity`'s `rows` and `next`:** a reply holds as many rows as fit 1 MiB less 4 KiB, at most 10,000 (about 5,700 on a desk, fewer on a guild's with names). Concatenate `rows` across replies, passing each `next` back as `cursor` with the same `fromDay` and `toDay`, until it's null. Rows come newest day first, then by page id, highest first, so each row comes once and none is skipped however long the reads take; one written behind the cursor is in the next read, which the topic's next event asks for. A cursor is opaque and doesn't expire; one that isn't the desk's gets `bad_request` with `{reason: "cursor"}`. Before paging, a reply was every row in the range or `too_large`, at about 7,000 rows. A client that sends no cursor still gets that: everything, while it fits one reply, and past that the newest rows and a `next` it can ignore. On a guild desk every member gets the same rows: those of live pages, which any member may read, never a trashed page's.
- **`timeZone`:** call `notebook.settings.set` with `Intl.DateTimeFormat().resolvedOptions().timeZone` in `ready()`, when it differs from the last you sent on this desk. Activity days and midnight versions use the last zone seen, so the Temporal view follows the member. An unknown zone gets `bad_request` with `{reason: "time_zone"}`, and the desk keeps the last good one (UTC until there is one).
- **An empty desk** gets an empty tree. The client makes the first notebook, as it does with `LocalBackend`.
- **Editing a trashed page** keeps the edit (design 5.5).
- Versions, activity, search, derived titles and the 30-day Trash purge all happen on the desk.
- **A `pre_agent` version** in `notebook.version.list` and `.get` also has `agent`, `editId` and `undone`: History's "Before {agent}'s edit", and its undo.

| Error | `details` | Meaning |
|---|---|---|
| `not_found` | `{}` | No such row. A `notebook.*` method not in the table above gets it too, with the message `No such method` |
| `bad_request` | `{reason}` | desk-notebook's, for a field it won't take |
| `unavailable` | `{reason: "notebook"}` | Nothing was done. `desk-notebook` isn't there, a call to it stalled, or this session already has 16 calls waiting on it. With a mutation the same key runs it next time |
| `unavailable` | `{reason: "notebook", mayHaveApplied: true}` | A mutation went to `desk-notebook`, and no answer came: it restarted, or took over 10 s. It may have happened. As §4 says, **the same key replays this reply for as long as deskd keeps it, and doesn't run the method again,** so fetch `notebook.tree` to see where things stand, and treat a new try as a new action |
| `too_large` | `{}` | A result that wouldn't fit a RES |
| `internal` | `{}` | `desk-notebook` answered with an error deskd doesn't know, or one too long to pass on |
| `forbidden` | `{reason: "scope"}` | Any session but an `owner`'s |

A read that gets `unavailable` is safe to send again whenever you like. deskd waits 10 s for an answer, and then `desk-notebook` is told to stop the call. CANCEL and `deadlineMs` reach it too, unless a mutation has gone out, as §4 says of any mutation, or the call hadn't gone out yet, when it simply never does.

A stalled or absent `desk-notebook` costs only these calls and `collab`. At most 16 calls per session wait on it, half of §4's 32, so the Browser and everything else on the session keep working.

### The Agent's Notebook tools (§18)

An agent's `notebook_*` tools (§18) reach `desk-notebook` on deskd's own connection, never a client's, as the agent's owner by deskd's stamp: the desk's owner, or on a guild desk the member whose agent it is, under that member's grants and the edit budget as for their own edits. Four methods serve them that no client can call (a client gets `not_found`): `notebook.page.markdown` (a page as exact Markdown, 20,000 characters a read), `notebook.outline` (the notebooks and their tabs, or one tab's pages 100 at a time), `notebook.page.marked` (which of up to 100 pages hold marked text, for a search's hits) and `notebook.page.agentEdit` (`create`, `append` or `replace_text`, with a `pre_agent` version saved first, done once under deskd's key, the approval's id (a member's yes, or `autoApprovalId` for a call done without asking), and refused `unavailable` `storage` with nothing made when its row can't be kept). `notebook.page.agentUndo` takes that key from deskd (the auto-approve undo's seam, `tools/NotebookTools.undo`) and an `editId` from the member's app, in the table above; search and trash are `notebook.search` and `notebook.page.trash` with their rules. The Markdown reads back as exactly the page, colors included, and what the Notebook has no node for (a table, an image) is converted and said. `services/notebook/README.md`, "The Agent's tools", has all of it.

- **The untrusted mark** (Security's ATN-M1; the draft ADR's §6): every `notebook.page.agentEdit` carries `untrusted`, deskd's own copy of the run's `U`. desk-notebook marks the blocks of text an edit from a `U` run writes (and any agent edit of a page already holding marked text), and `notebook.page.markdown`, a tab's `notebook.outline` and the edit's own answer say `untrusted: true` while the page holds one; `notebook.page.marked` says it of a search's hits. deskd then adds `U` to that tool result, so a later run that reads it can't browse with no card (the Rule of Two). A search whose marks can't be read counts as `U`. A mark ends for a block when the member changes its words or links; moving it, recolouring it or a version bringing it back keeps it; undo takes it out with the text.
- **What a client sees:** the edit itself, live in an open page and on `notebook.tree`; a version with reason `pre_agent`, which `notebook.version.restore` undoes; and the day's activity `actors` gaining `agent:<agentId>` beside the member's own ("Edited by", with the agent's name from `agent.state`). On a guild desk its `actorNames` entry is null.
- **Releases:** `desk-notebook` before `deskd`. An older `desk-notebook` makes the tools answer `unavailable`.

### Topic `notebook.tree`

SUB with no params. Each event is the tree's revision:

```json
{"type": "snapshot", "data": {"rev": 42}}
```

- **Fetch `notebook.tree` when `rev` is newer** than the one you have. An event isn't always news: the same or an older `rev` can come, for instance after `desk-notebook` restarts, and needs nothing from you.
- **At most about 4 a second.**
- **Every SUB gets the current one first,** as soon as deskd has it. It's coalescible and serves no `since`, like `browser.tabs`, so one that falls behind gets a fresh one (§5).
- **While `desk-notebook` is away** the subscription stays, with no events, and no first event if it began then. When it's back, the next one comes.

`GET /health` on the admin socket adds `notebook`: `connected` if any session has a connection to `desk-notebook` now, and otherwise `waiting`, which includes a desk where no session is using Notebook. Beside it, `notebookStorage` is `desk-notebook`'s storage state from its own health frame, `{state: "ok" | "degraded", unsavedPages, unsavedBytes, refusing, degradedSeconds}`, counts and state only, or null when it isn't there, didn't answer within a second, doesn't say, or hasn't been read yet; it's the last read, at most every 10 s, and `/health` never waits for one. Both are for information, and never fail health. The heartbeat carries the same as `health.checks.notebook`: `ok`, `degraded` while its writes fail and edits wait, `failing` once it refuses edits.

## 14. The simplified view

Task 47, Stage A ([ADR 0046](../../../docs/decisions/0046-minified-stage-a.md), design §7). A Browser tab shown as a clean page the Desk app renders itself, from a typed document deskd builds on the desk (MDoc), with clicks and typing done on the real page through deskd's action proxy. Built, in no release. **On by default, with a kill switch.**

**The switch is a kill switch** (the owner's rule, Nov 7: finished features ship on, and switches are for getting out of trouble). `/data/desk/minified-switch`, read while deskd runs (a stat at most once a second, never on the caller's thread), so it works without a release. With no file, the view is on, and so are the media verbs and the consent press. The file can only turn things off: the word `off` turns off everything, `media-actions-off` the media verbs, `consent-reject-off` the consent press, `prescroll-off` the pre-scroll (below). Words go on lines or spaces, and any other word is ignored, so an empty file changes nothing. A file deskd can't read as a plain small file (a symlink, one over 1 KiB, one it can't open) counts as `off`. The desk's operator writes it as root over SSM; deskd only reads it, and Chromium's user can't reach `/data/desk`. **Off is fully inert:** every `browser.minified.*` method answers `unavailable` with `{reason: "disabled"}`, a SUB to the topic gets the same, and nothing of the view reaches Chromium: no script, no isolated world, no frame attach, no call into a page, no thread per attach.

**A frozen Chromium** (ADR 0045, "Nobody looking" in §10). Every `browser.minified.*` call, and a SUB's first look, is work: it thaws Chromium first and keeps it for the grace after. The topic's watch for changes isn't work: it never thaws Chromium nor holds off a freeze, and it stops while Chromium is frozen. The freeze closes deskd's connection, and the view goes with it, so after a thaw a client gets it again with `get`: an `act` on the old one gets `conflict` with `{reason: "changed"}`, and an `island` gets `not_found`. A Browser window showing the view wants `warm` (§10), so a view someone looks at doesn't freeze.

**Who.** Every method and the topic are the owner's alone, as §4 has it, so an `export` session gets `forbidden` with `{reason: "scope"}`. What a page shows needs a token with video (`get`, `image`, `site.get`, `sites.list`, the topic). Anything that changes the page or the site's memory needs video and input (`act`, `island`, `site.set`, `sites.clear`, `browser.adblock.site.set`), checked again right before the page is touched. Without them: `forbidden` with `{reason: "permission"}`.

### Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `browser.minified.get` | No | `{tabId?, since?, retry?}` | `{tabId, rev, view, mdoc?, fallback?, unchanged?}` |
| `browser.minified.act` | Yes | `{tabId, nodeId, action, value?, fp, block, rev}` | `{done, reason?, reformatted?}` and media facts |
| `browser.minified.image` | No | `{tabId, imageId}` | `{imageId, mime, data}` |
| `browser.minified.island` | No | `{tabId, islandId}` | `{islandId, kind, epoch, live, reason?, rect, viewport, dpr, playing?, muted?}` |
| `browser.minified.site.get` | No | `{tabId?}` or `{host}` | `{host, view?, sensitive, lastFallback?}` |
| `browser.minified.site.set` | No | `{tabId?}` or `{host}`, and `view?`, `sensitive?` | as `site.get` |
| `browser.minified.sites.list` | No | None | `{sites: [ … ]}` |
| `browser.minified.sites.clear` | No | None | `{}` |
| `browser.adblock.site.set` | Yes | `{tabId?}` or `{host}`, and `on` | `{host, on}` |

A left-out `tabId` means the tab on screen, as in §10, and is never a guess.

### Browser time on a free desk
ADR 0090 section 2, [§17](#17-the-free-tier). On a free desk the simplified view counts as Browser time and is held to the day's minutes, as `live` is.

- **In use** while the desk is looked at (`desk.attention`, §10) and any session holds a `browser.minified:` subscription, or for 15 s after an answered `get`, `act`, `image` or `island` (so a client that polls without subscribing is counted). Counted once per desk with `live`: both together are one count.
- **At the day's limit** `get`, `act`, `image`, `island` and a SUB to `browser.minified:<tabId>` are refused with `unavailable` `{reason: "bandwidth_limit", resumesAt, limit: "browser_time"}`, the refusal `browser.stream.set live` gets, after the permission check. Every open subscription ends with an `error` event `{code: "unavailable"}`, and the client's next ask gets the refusal and its `resumesAt`. The site memory methods (`site.*`, `sites.*`, `browser.adblock.site.set`) carry on: they don't read the page. No tab, cookie or the session is touched (ADR 0035).
- **It lifts** by itself at `resumesAt`, and at once when the limits lift or grow past what's used (an upgrade). A desk with no `tierLimits` is never refused.

### `browser.minified.get`

What the tab shows in the simplified view now. `view` is one of:
- **`simplified`**, with `mdoc`, the whole document (below), at most 512 KiB of JSON.
- **`stream`**, with `fallback: {reason, cause?}`: show the real page. No `mdoc`.
- **`pending`**: deskd has nothing yet, as for a page still loading. Keep what you show, and ask again or wait for the topic.

`since`: the `rev` you have. If it's still the tab's `rev`, the reply is `{tabId, rev, view, unchanged: true}` and nothing more. A view whose page has gone (a navigation, a lost connection to Chromium, or one of the views past the three kept) is never `unchanged` and never `simplified` without its `mdoc`: its `rev` moves on and it's `pending` until deskd has looked at the new page. `retry: true` looks at the page again whatever the site's memory and this document's last fallback say, for when the member asks to try the simplified view again.

| `fallback.reason` | Meaning | Remembered for the site |
|---|---|---|
| `not_page` | Not a web page: an empty tab, the new tab page, an error page | No |
| `sensitive_site` | On deskd's shipped list (money, mail, health, identity) or marked by the member | By the list or the member |
| `member_choice` | The member chose the stream for this site | Yes |
| `remembered` | Two pages of this site fell back by themselves lately; `cause` says why | Its 7 days |
| `dialog` | The page has an alert, confirm, prompt or beforeunload open. Only the stream shows it, and deskd never answers it | No |
| `http_auth` | The page came back 401 or 407 | No |
| `http_error` | The page came back with another error, 400 or more: show it as the site made it | No |
| `challenge` | Only the member can get through this page, on the real page. `cause` says which: `person_check` (a CAPTCHA or bot check: "The site wants to check you're a person"), `sign_in` (a sign-in page: "Sign in on the real page") or `payment` (a checkout: "Payment is always the real page") | No, and looked at again when the page changes, as once they're through it's gone |
| `distiller_error` | The distiller failed | No |
| `timeout` | Making the view took over 1.5 s | No, as a just-thawed Chromium or a busy desk is slow too |
| `too_large` | The page is past what deskd simplifies | Yes |
| `low_confidence` | Too little of the page came through: almost nothing to read, a form the view can't complete, or (round 4) a page four screens long or more of which the view kept under 600 characters and no cards, picture, table or player (a store's grid still drawing its placeholders). Round 6: when this document's view already had cards or 600 characters and more, a later look that finds such a long page blank (a store's virtual grid drawing its rows again after the pre-scroll) keeps that view instead, until the page's next change is looked at. S-111: only while the tab's whole URL, fragment included, is the one that view was looked at on, with no same-document navigation of the top frame since (an app's route change, by the History API or its fragment), and for 5 s at most. Such a navigation while it's held, or the 5 s, ends it at once: the topic says `low_confidence` for that moment, and the page's next change (at once, after a navigation) is looked at afresh | Yes |
| `canvas_app` | A canvas takes half the viewport or more | Yes |
| `cross_origin_frames` | Another site's frame takes 40% or more | Yes |
| `terms_wall` | The page asks the member to agree to its terms before they read on: "The site asks you to agree to its terms" | No, and looked at again when the page changes, as once they agree it's gone |

Errors: `not_found {reason: "tab"}`, `unavailable {reason: "chromium"}` and `unavailable {reason: "active_tab"}` as §10, and `unavailable {reason: "disabled"}`.

**A forum's cloaked posts** (task 47, round 4). Discourse draws only the posts near the viewport and leaves the rest as empty boxes of the same height, so a member's tab, which nothing scrolls, would show the first few posts and a column of "21 days later". The posts' own words are in the topic the page already loaded and keeps in its document (`script#data-preloaded`, `application/json`): the distiller reads each cloaked box's post from it, parsed inert (`DOMParser`: no script runs and nothing loads), and walks it as content in the box's place, under its author's name and date. Nothing is fetched or pressed. Only on a page Discourse made (its generator), for the topic in the address, for a post shown to everyone (not hidden, deleted, a whisper or a moderator's note) whose author the box itself names. Posts the page hasn't loaded stay out, as on the real page.

**Ads by their own link** (round 4). A card whose own link is an ad's click (an ad network's click id, plain or URL-encoded in an engine's redirect, or a store's ad server) is dropped by deskd's builder wherever the distiller found it, and counted in `hidden.counts.sponsored`.

**An island's still** (round 4). `media.poster` is the `<video>`'s own poster, else the picture the player draws over it (an `<img>`, or a box's background, inside the player and over most of the video), read, never fetched: its bytes come as any image's, from what the tab loaded.

**What a control and a picture show** (round 5). A lone vote arrow with no score shown (Hacker News' ▲ on a comment) is a `vote` run with that one arrow and `score: ""` (R40), never a button labelled ▲. A button's `label` stays what the page shows (R1), with two exceptions that keep its words in `name`: a rating spelled out for a screen reader ("Review: 4.6 out of 5 stars. Total reviews: 2191") shows as `★ 4.6 (2191)`, and a shop's badge drawn on a control named otherwise (a swatch's "SALE") shows as `Jet Black (Black Sole) · SALE`. A link whose page text only repeats its name with a screen reader's copy ("Open 20 (20)") shows its name. An image's `alt` that is only a file's or an id's name ("ex-main-demo", "IMG_9231") is `""`. Round 6: a card's `snippet` is the distiller's whole snippet, words a page set in bold included ("The best **desk lamps** come in…"), never its plain pieces. A tile card's own picture and its line ("High: 66 °F · Chance Rain") are its `image` and `meta`. A shop's product page (its JSON-LD names a Product, or a button buys it) has no `article` read time.

**The pre-scroll** (task 47, round 3). A page loads some of itself only as it's scrolled to: lazy pictures, a thread's later replies, a list's next items. Nothing scrolls a member's tab while the view shows, so once per document deskd does: 400 ms after a `get` first hands a client a document's view (so the view covers the real page first; never on a navigation alone, never on a page still loading, and never while the real page is what shows), it scrolls the real page down a screen at a time to its end or a cap (12 screens or 1.5 s, so an infinite feed stops there), puts it back exactly where it was, and waits up to 600 ms for the pictures it came near to arrive. It runs under the tab's work, so no action comes between, and it never presses, types, focuses or writes anything. It doesn't run on a sensitive site or page (the view's own rules: the shipped list, the member's mark, a sensitive signal this session, a visible password, card or code field, in the page or an open shadow root, looked for again as the scroll starts), with focus in a field or frame, on a page whose scrolling is locked (a modal open), in a hidden tab, with a dialog open, or once the member has acted on the document. An action, or the member choosing the real page for the site, stops it at its next step, and the page goes back at once. What it brought in is the view's next look: the topic says so as for any change. `/health` counts pre-scrolls under `browser.simplified.prescroll` by what came of them (`done`, `capped`, `stopped`, `skipped_<why>`, `not_restored`, `failed`), never which page. `prescroll-off` in the switch turns it off.

### MDoc

Typed JSON, never site HTML. **Every field a head part, block or run may carry, with its type, is in `services/deskd/src/test/resources/minified/mdoc-schema.json`,** and `MDocSchemaTest`'s checker holds deskd to it: nothing else is ever sent, so render from a whitelist of those fields and never spread an object into props. Everything in it came from the page, so treat every string as untrusted plain text, never markup (Security T47-6).

**Head:** `v` (1), `tabId`, `rev`, `url` (cut to 2048), `origin` (`https://host[:port]`, the host in punycode: show it outside the content), `title` (the page's, 256, never the office tab's title), `kind` (`article` or `page`), `sensitive`, `truncated`, `loading`, `blocks`, and when known `site`, `hidden`, `challenge`, `article` and `pageHeight`.
- `sensitive` is true once this tab, or any page of its site (its registrable domain) this deskd session, showed a password, one-time code, card or masked field, or a payment provider's frame. It only goes one way.
- `site`: `name`, `icon` (an image id), `themeColor` (`#rgb` or `#rrggbb`, for a letter tile, R4), and `actions` (at most 3: `{tag, node, fp, label, count?}`, `tag` one of `search`, `sections`, `signin`, `cart`). An action's `block` for `act` is `"site"`.
- `hidden`: `counts` by kind (`ads`, `cookie`, `newsletter`, `popup`, `recommended`, `sponsored`, `shorts`, `shelves`, `signin`, `other`), `trackers` when the blocklist says, and `done: {cookie: "hidden" | "rejected"}`. **What the counts mean without a blocklist:** they count what deskd's distiller took out of the view, by its structural rules (ad labels and slots, sponsored items, consent and newsletter boxes, shelves) and its small built-in cosmetic rules, never EasyList, which stays off the desk. An ad the page never drew, as the desk's network blocklist (the System Engineer's) keeps it from loading, isn't counted, and `trackers` is left out. So a page can show fewer hidden ads on a desk with the blocklist than without it, and that's the blocklist working.
- `challenge`: `{reason}`, one of `person_check`, `sign_in`, `payment`. A page with one falls back (`fallback.reason: "challenge"`, `cause` the same word), so a client sees it only on a document it already holds.
  - **How deskd knows a person check** (`sub/minified-challenge`): the distiller's word first, then deskd's own look, since a variant can slip past the distiller (Stack Overflow's, on a desk's network, came through as one block). Cloudflare's interstitial by its own script (its inline options or its orchestrator), unless the view holds over 3000 characters. On a page whose view holds 1500 characters or fewer: a check's words in the title or a visible heading ("Human verification", "Performing security verification", "Just a moment"), a check's form (one posting to a CAPTCHA address, Cloudflare's challenge boxes), a visible check widget (Turnstile, hCaptcha, reCAPTCHA's box, Arkose, DataDome; never an invisible one), or an address like `/nocaptcha`. And a view of 600 characters or fewer whose words are a check's prompt ("Verifying you are human", "needs to review the security of your connection", "unusual activity", "are you a robot"). The distiller's sign-in and payment words win over deskd's.
- `article`: `kicker`, `byline` (names), `date`, `readMinutes`, `lead` (`{image, width, height, caption?, credit?}`). Only for an article: never on a thread (votes on two or more posts, or a `QAPage` or `DiscussionForumPosting`) or a listing (a cards block of six or more with little prose), whose length isn't a read.
- `pageHeight`: the real page's height in CSS pixels.

**Blocks** each have `t` and `key`. `key` is a hash of the block, unique in the document: key React by it, and patch by it. Kinds: `heading`, `para`, `item`, `code`, `rule`, `image`, `table`, `meta`, `controls`, `bar`, `cards`, `group`, `fold`, `filters`, `island`, `sensitive`, `structured`, `answer`, `comment`, `paywall`. Any block may have `dialog: true` (from a dialog on the page: label it with `origin`, styled apart from MA's own) or `grouped: true` (one of the `size` blocks after a `group` or `fold` header, collapsed by default).

**Runs** are text strings, or objects with `r`: `b`, `i`, `code`, `sup`, `sub`, `s`, `br`, `image`, `link`, `button`, `field`, `check`, `select`, `sensitive`, `vote`.

**Never more than the real page shows the member** (the Product Designer's round two; the owner's default until they decide). deskd's own half finds the text the member can't see on the real page: not drawn, clipped away by a box it's in, or under a wall, an overlay over most of the screen or over a page that won't scroll. The builder leaves out a block of hidden text, and ends the document at the first block under a wall, whatever the distiller sent:
- **A paywall** (the wall's words ask for a subscription or a sign-in to read on): the document ends with one `paywall` block, `{t: "paywall", key}`, and nothing after it. Show one line, "The rest is for subscribers · Subscribe or sign in on the real page", which opens the stream. A distiller's own paywall mark ends it the same way.
- **A terms wall** (the site asks the member to agree to its terms): the tab falls back with `terms_wall`. Show "The site asks you to agree to its terms" with the real page. A wall drawn by another site's frame (a consent platform's terms modal) counts too: deskd reads that frame's words and buttons in its own world there, as the prototype does, and nothing of them reaches the view.
- A dismissible nag isn't a wall: the distiller hides it and counts it in `hidden` as `popup`.

**Controls.** A `link`, `button`, `field`, `check` or `select` the member can use has `node` and `fp`. One without them is shown, and isn't usable here.
- A control's `label` is what it shows (R1). `name`, when there is one, is its accessible name, for a screen reader.
- **A `sensitive` run or block** stands where a password, one-time code, card or masked field, or a payment frame is (Security T47-1): `{kind, origin}`, `kind` one of `password`, `one_time_code`, `card`, `masked`, `payment`. Show "Sign in on (origin)" or "Pay on (origin)", which switches the tab to the stream. It's never a field, and deskd refuses any action on it.
- **A `field`'s `kind` is deskd's own word,** never an HTML input type: `plain`, `query`, `email_address`, `phone_number`, `web_address`, `numeric`, `date_choice`, `time_choice`, `datetime_choice`, `month_choice`, `week_choice`, `colour_choice`, `range_choice`, `file_choice`, `multiline`. Never set `type=` from it, and never render a `<form>`, a `name` or an `id`, with `autocomplete="off"` (T47-1). The `_choice` kinds and `file_choice` can't be typed into: offer the stream.
- A `select` is by index: `options` are labels, and `selected` an index, or −1.
- **A `vote` run** (R26) is a site's up and down votes and its score as one control: `{score, up?: {node, fp}, down?: {node, fp}, state?}`, `state` `up` or `down` as the page shows the member's vote. Each arrow is the real page's own control: `act {action: "click"}` on its `node`, with its `fp`.
- A `link`'s `url` is an absolute http(s) URL with no userinfo, for showing as text, never an `href`. `redirect: true` says it's where a search engine's redirect goes (R23): a click still goes through the page's own link. `next: true` marks the page's next page (R16), `signIn: true` a control that only leads to signing in (R7), `primary: true` the page's main action.

**Images** go by opaque id: `image` on `image` blocks and runs, `site.icon`, `media.poster`, `cards`' images, the article's lead. deskd never sends an image's URL (T47-5). `width` and `height` are its size on the page as declared, and `renderedWidth`/`renderedHeight`, when the distiller gives them, the size it's shown at: lay out by them before the pixels come. Get the pixels with `browser.minified.image`.

**Islands** are live views of part of the real page, cropped to the media element's own rectangle (a `<video>`'s, never its player's box with the player's chrome), and only while nothing is over it: `{kind, width, height, island?, fp?, box?, state, ad?, preRoll?, main?, label?, media?}`. `kind` is `video`, `audio`, `canvas`, `frame` or `embed`. `state` is `live` (deskd found its element and can give its box), `click` (the page shows a poster that needs a click on the real page) or `none`. `box` is its place on the page in CSS pixels. `media` has `duration`, `time`, `paused`, `muted`, `drm`, `poster`, `tracks` (`{kind, label, lang, on}`), `chapters` (`{time, label}`, R17), `frame` and `crossOrigin`. An island without `island` isn't live here.

**Other blocks:** `cards` (`layout` `grid` or `list`, `repeat`, `items`: `{title: {text, node?, fp?, url?}, image?, price?, listPrice?, rating?, ratingCount?, badge?, deal?, delivery?, duration?, meta?, chips?, snippet?, actions?}`); `structured` (`type` `recipe`, `product`, `qa` or `video`, `data` from the page's JSON-LD, and `fold`, the index of the first block after the story before a recipe); `answer` (a search engine's own answer, R22: `label`, `runs`, `sources`); `comment` (R26 to R30: `kind` `comment`, `answer` or `question`, `depth`, `author: {name, role?}`, `score`, `up`, `down`, `reply` as button runs, `collapsed`, `more`, `accepted`); `bar` and `controls` (the site's chrome: `runs`, and `menus: [{label, kind, runs}]`, `kind` `menu`, `filters` or `contents`); `fold` (R17, R32: a header like `group`'s, `{label, kind, lead, size, meta?}`, `kind` `description`, `comments` or `other`, folded to one line with `meta` such as "119 comments"; the first `lead` of its `size` grouped blocks show open; a comments fold can have `size` 0); `filters` (R10, a listing's filter rail as one row: `runs`, the first filters as chips, `sort?`, the sort control as one run, `count?`, how many filters in all, and `menus`, the whole rail, each `kind: "filters"`); `paywall` (above).

### `browser.minified.act`

One thing the member did, done to the real page, or refused (design §7.3: zero wrong-target actions). One action keeps one `idem`, as §4. Send the node's `fp`, the `key` of the block it's in as `block`, and the `rev` of the MDoc it was in.

| `action` | On | `value` |
|---|---|---|
| `click` | link, button, check | None |
| `check` | check | `true` or `false`: what it should be |
| `fill` | field | The whole text, which replaces what's there. Coalesce typing to at most one a frame |
| `press` | field, select | `Enter`, `Escape`, `Tab`, `ArrowUp`, `ArrowDown` or `Backspace` |
| `select` | select | `{index, label}`: the label as the MDoc gave it |
| `scroll` | any node, or an island's id | `"start"` (the default) or `"center"`: scrolls the real page to it, as the end of a list nears |
| `media` | an island's id, with its `fp` | `{verb, time?, volume?, muted?, track?}`, `verb` one of `play`, `pause`, `seek`, `volume`, `track`. Off unless the switch says `media-actions` |

**What deskd does,** and refuses at any step rather than guess (Security T47-2, T47-3):
1. The node must be in the tab's current MDoc, in that block, with that fingerprint, from an MDoc of the tab's current document (`rev`).
2. Every other frame of the tab, those in processes of their own included, is armed to cancel any trusted input. One that can't be armed, or that deskd couldn't keep track of, refuses the action. **A frame that isn't a web page's is never armed, walked or read** (the sign-ins work's finding, Nov 11): a password manager's in-page menu is a frame of its extension's page (`chrome-extension:`), which Chromium attaches with no URL, held before its document is known. deskd puts nothing in a frame until it commits to an `http` or `https` page (or an `about:`, `data:` or `blob:` document of a web or opaque origin), lets one that commits to anything else run and detaches from it, never runs anything of its own in such a frame's document (its half there refuses every op, and deskd checks each frame's origin as it reads the frame tree), and never lists such a frame as media or an island. Chromium still lists that frame under the tab, so the tab's actions refuse while it's there. `/health` counts them under `browser.simplified`: `framesPending`, `framesGuardedAtCommit`, `framesLeft.attach` and `.commit`.
3. In one call into deskd's isolated world on the page: the element is looked up, its fingerprint taken again, a sensitive field refused, it's scrolled into view and fingerprinted again, hit-tested at the point, refused if any frame is within 24 px of the point, and armed. Typing focuses it, selects its text, and checks again that it's not sensitive.
4. Right before the press: the arm is young enough, and no frame came, went or navigated since.
5. Press and release with no move before them; or `Input.insertText`. A dialog that opens ends the wait.
6. A click counts as done only if the element itself got pointerdown, pointerup and click, still showing what the member saw at the press. Typing counts only if the element holds the text, or got it and kept focus.

**The result** is `{done: true}`, or `{done: false, reason}`:

| `reason` | Meaning | Do |
|---|---|---|
| `missed` | The element didn't get the input: something else may have, or a guard stopped it | Show the fresh view, which follows on the topic. Say the click didn't land |
| `navigated` | The page moved on before deskd could check | Nothing: the new page follows |
| `unknown` | Chromium didn't answer after the input went out | Show the fresh view when it comes |
| `dialog` | The page opened a dialog, which only the stream shows | Offer the stream |
| `value` | The field doesn't hold the text | Show the field's value from the fresh view |
| `superseded` | A newer `fill` of the same field came first | Nothing |
| `changed` | It stopped showing what the member saw while being pressed, and the click was cancelled | Show the fresh view |
| `sensitive` | The field turned sensitive under the keys: they were stopped, and it's refused from now on | Offer the stream |
| `gone`, `label`, and the refusals below | The page changed under it | Show the fresh view |

`reformatted: true` with `done: true` means the page reformatted the text, as masks do. `media` also answers the element's state after the verb, for the island's own controls: `paused`, `muted` and `captions` (a captions or subtitles track showing), always, and `time`, `duration`, `buffered` (the end of the buffered stretch the playhead is in) and `volume` (0 to 1) when the element has them, all in seconds but `volume`.

| Error | `details` | Meaning |
|---|---|---|
| `conflict` | `{reason}`: `changed`, `gone`, `covered`, `frame_near`, `hidden`, `disabled`, `focus`, `label`, `kind`, `frames` | Refused, nothing done. deskd looks at the page again and the topic brings the fresh view. Never retry with the same `fp` |
| `forbidden` | `{reason: "sensitive", kind?}` | A field that must never be typed into or clicked here (T47-1), remembered for the rest of the document. Offer the stream |
| `forbidden` | `{reason: "permission"}`, `{reason: "scope"}`, `{reason: "disabled"}` (media or consent off) | As above |
| `rate_limited` | `{limit: "minified"}` | Over 30 actions a second on a tab, 60 on the desk, or 16 waiting on a tab |
| `bad_request` | `{reason}` | A field missing or the wrong type, `rev` included |
| `too_large` | `{limit: 65536}` | A `fill` over 64 Ki characters |
| `unavailable` | `{reason: "chromium"}`, and `mayHaveApplied` once the input went out | As §10 |

### `browser.minified.image`

The bytes of an image the tab already loaded, from Chromium's own copy (`Page.getResourceContent`): deskd never fetches one, and never decodes one (T47-5). `mime` is `image/png`, `image/jpeg`, `image/gif`, `image/webp` or `image/avif`, from the bytes; never SVG. `data` is base64. Show it only as a blob URL you make, never by a site's URL. Errors: `not_found {reason: "image"}` (unknown id, or not loaded, as a lazy image below the fold: try again after a `scroll`), `not_found {reason: "image_type"}`, `too_large {limit: 716800}`.

### `browser.minified.island`

An island's box on the real page now (Security T47-4, deskd's part), scrolled into view if it wasn't whole: `rect` in CSS pixels of the viewport, clamped to it, with `viewport` and `dpr`. `epoch` changes whenever the box does: whatever maps input to the island by it drops what's older. `rect` is the media element's own: a `<video>`'s, not its player's. `live` is false, with `reason` `not_active` (the tab isn't on screen), `hidden`, `covered` (something other than its player is over its middle or a quarter in, or a box inside the player asks the member something: sign in, cookies, consent, their age), `wall` (the page has a wall up) or `fullscreen`: show the last frame and offer the stream. An island in another site's frame (`kind: "frame"`) gives the frame's box, as deskd can't see into it, and a consent box inside such a player isn't seen. Cropping the encoder to it is the System Engineer's. Errors: `not_found {reason: "island"}`.

### The site's memory

On the desk only, in `/data/desk/minified-sites.json` (T47-9): keep none of it in the layout, `localStorage` or IndexedDB, and ask. **A site is its registrable domain:** send any host, or a `tabId`, and deskd maps it (`news.example.co.uk` is `example.co.uk`); the reply's `host` is the site. Per site: `view` (`simplified`, `stream`, or none), `sensitive` (the member's mark; the shipped list holds whatever this says), and `lastFallback`. At most 2000 hosts; untouched for 90 days, as Chromium's history, a host goes; an automatic fallback goes after 7 days. `site.set` with `view: null` forgets a choice; `view: "simplified"` also forgets the automatic fallbacks. **`sites.clear` is what the member's clear-history must call.** It also empties the ad-blocking off list (below), and it works with the view switched off, as it touches only deskd's own files. A clear done inside Chromium's own settings doesn't reach deskd. Past 90 days a host goes at deskd's start too, and the file stays under 512 KiB: past that the oldest go, sites marked sensitive last. No site is ever logged.

### The per-site ad switch

ADR 0073's per-site switch, UI/UX's proposal as built (Security `T47S-3`, deskd's half). `browser.adblock.site.set {host, on}` (or `{tabId, on}`), a mutation with `idem`, owner only, needing video and input: `on: false` turns ads and trackers back on for the site (its registrable domain, as above), `on: true` blocks them again; the result is `{host, on}`. `on` that isn't a boolean is `bad_request` with `{reason: "on"}`; a list that couldn't be written is `unavailable` with `{reason: "storage"}`, and nothing changed. It works with the view switched off.
- **The file.** deskd keeps the sites with blocking off in `/data/desk/adblock-off`, one registrable domain a line, sorted, at most 2000, written atomically as the site memory is, and **0640**: not readable by the desk's other users. The image's `desk-adblock` reads it into Chromium's policy (the System Engineer's half); a page shows the change when it next loads.
- **Clear-history empties it:** `browser.minified.sites.clear` writes it empty, and `desk-adblock` follows.
- **It's in the export**, in the `desk` part (§12), as the site memory is: the member's own choices, which a move carries to the new desk.
- **The head:** `hidden.blocking: false` on a page of a site with blocking off. Absent, blocking is on.

### Topic `browser.minified:<tabId>`

SUB with no params, one per tab you show. Needs video. Events:
- `snapshot`: `{tabId, rev, view, fallback?}`, never the MDoc, which can pass an event's 64 KiB. Call `get` for it. `view` can also be `closed`: the tab is gone.
- `patch`: `{tabId, base, rev, at, remove, insert, head}`. If your MDoc is at `rev` `base`, remove `remove` blocks at index `at`, put `insert` there, and take `head` for the head. Otherwise, `get` with `since`.
- `changed`: as `snapshot`: call `get`.

A subscribed tab is watched while the switch is on: one parked call in the page that its next change answers, at most one look per 100 ms or three times the last look's length. Coalescible, as §5: if you fall behind you get a fresh `snapshot`. `since` has no effect. While nobody is subscribed and nobody has asked for a minute, deskd's script comes off the tab and Chromium no longer holds its new frames for deskd's guard.

### Limits

| What | Limit |
|---|---|
| MDoc | 512 KiB of JSON; past it, blocks are left off the end and `truncated: true` |
| Distiller output | 1,000,000 characters, 6000 blocks; past them, `too_large` |
| Usable controls | 4000 a document; past it, shown but not usable |
| Images | 400 ids a document; 700 KiB each; 2 reads at once |
| Islands | 50 a document |
| Frames | 64 a tab; a tab with more refuses actions |
| Tabs | 256 tracked; MDoc kept for the 3 used last |
| Actions | 30 a second a tab, 60 the desk, 16 waiting a tab |

### The Agent's walker (§18)

An agent's Browser tools (§18) read pages with this walker and act with this action proxy, on tabs of their own (§10, "The Agent's tabs"), through a second instance no session reaches. It follows the same kill switch: off, the tools aren't offered. It never counts as Browser time on a free desk (the Agent sends no video), never writes the member's per-site memory, never presses a consent banner, and never reads a site on the sensitive lists or one the member marked. The action proxy's refusals are the same, sensitive fields included.

**Its clicks and keys are deskd's half's own** (S-14): the Agent's tabs are hidden targets, which trusted mouse and key input never reaches on a desk's Chromium, so for the Agent the action proxy calls deskd's half in deskd's isolated world, never the page's: an untrusted `el.click()` for a click, and untrusted `keydown`, `keypress` (Enter) and `keyup` events on the focused element for a key, with Enter's implicit submission of the field's form (its default button clicked, or `requestSubmit()` when it has none) unless the page cancels the key, and Backspace's own edit of a plain field. Escape, Tab and the arrows are the events alone (Tab doesn't move focus). No input is dispatched, so no frame can take it, and the page gets no user activation (no pop-up, fullscreen or clipboard). Each act is two calls into one document's world, each one synchronous run: a look (the node in the current MDoc with the approved `fp`, block and a `rev` of the current document; deskd's half takes the fingerprint again, refuses a sensitive field, a disabled, hidden or covered element, and says where the act would navigate: a link's address, or the form a submit control or Enter would send), then deskd's check of that address (another site in a member-session tab `off_site`, a local host or any scheme but `http`, `https` and the page's own `javascript:` `blocked`), then the act, which makes every check again and refuses `changed` if it would now go anywhere else, or if a payment provider's frame is on the page and the member didn't approve the call as a spend. Typing stays `Input.insertText`; emptying a field is deskd's half's own. A navigation the page starts anyway is cancelled at the request, as every one is. A page that checks `event.isTrusted` may ignore these, and the outcome says what the element got.

### For the acceptance check

The Product Designer's check (`~/ma-coord/design-drafts/simplified/targets/check.py`) reads the prototype's raw shape. Its fields, in MDoc v1: `meta.fallback` and `meta.fallback_why` are `get`'s `view: "stream"` and `fallback.reason`; `rw`/`rh` are `renderedWidth`/`renderedHeight`; a `card` block is one item of `cards`; comment `depth` is `depth` on `para` and `comment`; an island's state and ad flag are `state` and `ad`; a menu group in the chrome is `menus` on `bar` and `controls`; `meta.doc_h` is `pageHeight`; `pri` is `primary`. Image and media URLs aren't in MDoc by design (T47-5), so `no_hosts` for them is to be checked on the distiller's raw output on the desk.

## 15. A guild desk

Built for task 48, and in no release yet. A **guild desk** is a guild's one shared desk (the `DeskKind=guild` tag, read once by the image into `/run/ma/desk-kind` as `guild` (or `member` for every other kind), which deskd checks IMDS against: `docs/sub-status/deskd-guild-sessions.md`, GDS-5; `docs/decisions/draft-guild-shared-desk.md` §1, §5 and §7, all its defaults accepted). It has no Browser and no owner: its members open it from their own office, each with a **guild token**, and see only what a member needs. Everything here is inert on any other desk. The Platform's side is `ma-platform` contract 0.3.30 (`auth.md` §4.5, `guild-sharing.md` "The shared Guild Desk", `desks.md` "Guild Desk").

### Who comes in

**The token** is `typ: ma-guild+jwt`, the same keys as a desk token. A guild desk takes only these, and no other desk takes them: an `owner` or `export` token on a guild desk, the Founder's included, and a guild token anywhere else, get `invalid_token`. Every claim must be there and well formed, or the token is refused:

| Check | Failure |
|---|---|
| Header `alg` ES256, `typ` exactly `ma-guild+jwt`, `kid` in the JWKS; the signature; `iss` | `invalid_token` |
| `aud` is this desk (one string), and `ma_gid` is the guild in config's `guild.guildId` | `wrong_desk` |
| `scope` is `guild_member`; `sub` is `gm-` and lowercase letters and digits; `sid` and `jti` present | `invalid_token` |
| `iat`, `nbf`, `exp`, `auth_time` whole numbers; `nbf − 30 s ≤ now < exp + 30 s`; `exp − iat ≤ 300` | `invalid_token` |
| `ma_grole` is `lead`, `officer` or `member`; `ma_grants` an array of strings; `ma_name` 1 to 128 characters with no control character; `ma_badge` present, `officer`, `lead` or null; `ma_teen` a boolean | `invalid_token` |
| `cnf.x5t#S256` is 32 bytes, and the offer's fingerprint equals it, as for a desk token (§9) | `invalid_token`, `identity_mismatch` |
| Not revoked by `sid`; `jti` not seen before | `invalid_token` |
| `sub` is on the guild's roster with the same role, grants and teen flag (below) | `invalid_token` |
| deskd has read IMDS, config with `guild.guildId`, the signing keys, and a roster (read now, or kept from before a restart). Until there's a roster, every member gets this, so a removed member's token can't stand alone (audit Z30) | `desk_not_ready` |

**The caller.** Each session carries who it is, made from the token and nothing else: `{kind: "guild_member", memberId, role, grants, name, badge, teen}`. No frame a client sends can set or change it. `grants` are the role's: `lead` has all five (`moderate`, `invite`, `remove_member`, `manage_spaces`, `manage_agents`) whatever the token lists, `member` none whatever it lists, and `officer` the token's less any this deskd doesn't know. deskd hands the caller to desk-agent, desk-notebook and Commons with every relayed request or connection.

**Refresh** works as for a desk token (§3), and must keep `sub`, `sid`, `scope`, `cnf` and `ma_gid`. It may change the role, grants, name, badge and teen flag: the new caller applies at once, to calls and subscriptions (a subscription it no longer allows ends with `error`), and the relays hear it. A session not refreshed closes at `exp + 30 s` with 4401, so a member the Platform stops refreshing is gone within about 5½ minutes, and at once when the roster says so.

**Sessions.** Up to 3 per member and 200 members, so 600 on the desk, outside the owner's limit of 4. A member's 4th session from another tab is refused with `session_limit_reached`, as the owner's 5th is, and a new session from the same tab replaces that tab's old one (4409), as the owner's does. A 201st member is refused the same way. HELLO's `limits.maxSessions` says 3 to a member. Sessions have no video and no input: desk-rtc sends them no stream and takes no input from them.

### The roster

The roster wins over the token. The Platform says when it changes: `notify` with `topic: "guild.roster"` and a `version` on the gateway, `guildVersion` in a heartbeat reply, and `guild.rosterVersion` in config. deskd then reads `GET /v1/agent/guild/roster`, keeps it in `/data/desk/guild-roster.json` (written whole), and at once closes every session of a member who is gone, or whose role, grants or teen flag changed, with 4401 and reason `member_changed`, and nothing kept for a resume. Their relays (`collab`, `agent.*`, `commons`) close with them. The client gets a fresh token through `connect` and opens again, or can't. A closed guild (`closed: true`) closes everyone. A version no newer than the last applied is ignored; a read that fails is tried again from 1 s to 30 s, and the last roster stands meanwhile. A name or badge changing alone closes nothing: the next refresh carries it. A token whose role, grants or teen flag disagree with the roster is refused and makes deskd read the roster again (at most once per 5 s), in case the token is the newer.

**Leaving deletes the member's agent conversations** (ADR 0080 decision 12; its addendum of 2026-11-10 has the reasons). Leaving, removal and a deleted account all arrive as the member missing from a newer roster:
- **Owed** only when a roster newer than the last applied one (read, or kept in the file) doesn't list a member the last one listed. An entry naming the member counts as listing them even if it's malformed otherwise. Never from a desk's first roster, a failed or 503 read, another guild's roster, a malformed body, an older or same version, a closed guild, or a member who merely has no session.
- **Held**, all of that roster's drops, when the roster lists no `lead`, has an entry whose `memberId` can't be read, or drops more than half the last roster's members. A later roster with a higher version that still leaves them out, lists a `lead`, has every entry readable and isn't closed makes them owed.
- **Cancelled**, owed or held, by any roster that lists the member again: they keep their data.
- An owed purge waits 10 minutes, then goes to desk-agent as `desk.member.purge {memberId}`: deskd's own `req` on the agent socket, with no caller, which no client can send (it's not on the relay's lists; desk-agent refuses it from any frame with a caller). desk-agent answers `{purged: true, agents, messages, files, usage, staged}` (counts) and is idempotent; deskd retries on an error (5 s, doubling to 5 min) and on every new connection, and asks an older desk-agent that answered `not_found` again only on its next connection.
- The list is `/data/desk/guild-purges.json` (`{guildId, purges: [{memberId, state, version, dueAtMs}], done}`, written whole, before the roster that changed it is kept). `GET /health` shows `guildPurges: {owed, held, done}`, counts only. Nothing logs a member's id.
- desk-agent deletes the member's agent, thread, the notes of attached files, their limits and staged files, and keeps their usage rows only as the guild's spend, under `guild:departed`; `agent.db` and `usage.db` are left with an empty WAL and `secure_delete` on. The audit log keeps its rows (no content). Notebook pages and Commons stay: the guild made them together.

### What a member may call

Everything a guild member may call is below; anything else, a method that doesn't exist included, gets `forbidden` with `{reason: "scope"}`, before anything else is looked at (§4, Scope). So `desk.*`, `browser.*`, `data.*`, export and every owner topic are refused. A SUB to any topic but `agent.state`, `agent.conversation:<agentId>`, `notebook.tree`, `apps` and `app:<id>:<topic>` gets the same.

| Family | What a member gets |
|---|---|
| `guild.hello` | Any member: `{guildId, memberId, role, grants, name, apps}`. `apps` is `["commons", "notebook", "agent"]`, without `agent` for a teen |
| `guild.settings.get` | Any member: `{agents, notebook, updatedAt, updatedBy}` (below) |
| `guild.settings.set` (mutation) | Per block: `agents` needs the Founder or an Officer with `manage_agents`; `notebook` needs the Founder or an Officer with `manage_spaces`. A set carrying both needs both. Anyone else `forbidden` with `{reason: "grant"}` |
| `guild.usage.get` | The Founder and Officers (`role` `lead` or `officer`); a member `forbidden` with `{reason: "grant"}`: `{members: [{memberId, name, today: {runs, microUsd, usd}, month: {…}}], timeZone}`; `name` is the member's name on the last roster read, else on a live session's token, else `null`. Counts only, never a thread |
| `notebook.*`, `notebook.tree`, `collab` | Every member, as §13, with the caller in desk-notebook's hello. The space structure needs the Founder or `manage_spaces`, checked here and again in desk-notebook: `notebook.notebook.create`, `notebook.notebook.rename`, `notebook.tab.create`, `notebook.tab.rename`, `notebook.tab.recolor`, `notebook.tab.addAtPage` and `notebook.settings.set` (the desk's time zone); a member without it gets `forbidden` with `{reason: "grant"}`. Pages (`notebook.page.*`, versions) stay open to every member. What a member may change inside the Notebook, such as deleting another member's content (which needs `moderate`, or else stays within the edit budget below), is desk-notebook's to enforce, and its `forbidden` comes back unchanged |
| `agent.*`, `agent.state`, `agent.conversation:<agentId>` | Every member, as §11, with these differences: the member's own agent only (its `agentId` is their `memberId`, made the first time they look); the guild's keys (`agent.key.add`, `agent.key.delete`), `agent.limits.set` and `agent.audit.list` need the Founder or `manage_agents`, else `forbidden` with `{reason: "grant"}`; `agent.memory.*` is the member's own agent's, which the Founder's view never shows; a teen member gets `forbidden` with `{reason: "age_band"}` on every one and every SUB |
| `commons` (channel 4) | Every member: below |
| `apps.*`, `apps`, `app:<id>:<topic>` | Every member, as §19, with the caller sent to the app as a pseudonym; installing, removing and stopping an app need the Founder (`role: lead`), else `forbidden` with `{reason: "grant"}` |

### Guild settings

The Founder's limits on members' agents, and the guild's Notebook edit budget, kept on the desk in `/data/desk/guild-settings.json` and never sent to the Platform. Every field of a block is required, and a set replaces the whole of each block it carries:

```json
{"agents": {
  "perMember": {"runsPerDay": 20, "usdPerDay": 1, "usdPerMonth": 10},
  "perGuild": {"usdPerMonth": 50, "runsAtOnce": 2},
  "tools": {"read": true, "search": true, "edit": true, "post": true, "boards": true},
  "ownKeys": false},
 "notebook": {"editBudget": null}}
```

These are the defaults. A set carries `agents`, `notebook` or both; a block it leaves out stays as it was (a set with neither is `bad_request` with `detail: "agents"`). `notebook.editBudget` is `{"chars": 0 to 100,000, "windowMinutes": 1 to 1,440}`, whole numbers, or `null` for none of the guild's own, which falls back to the Platform's value and then to 500 in 10 minutes (below); out of range or malformed is `bad_request` with `{reason: "settings", detail: "notebook.editBudget.chars"}` (or `.windowMinutes`, or `notebook.editBudget` when the key is missing). A set that carries `notebook` is audited with that block, and one that doesn't isn't audited as having touched it. Dollars are a number from 0 to 100,000 with at most 6 decimals, or null for no cap; `runsPerDay` a whole number up to 10,000, or null; `runsAtOnce` 1 to 8. A field missing or out of range is `bad_request` with `{reason: "settings", detail: "agents.perMember.usdPerDay"}` (the field's path), and nothing changes. A storage failure is `unavailable` with `{reason: "storage"}`, and nothing changed. Each set is audited on the desk (`/data/desk/guild-audit.jsonl`: when, the member id and role, and the settings). desk-agent gets them at once and on every reconnect. A member's agent is bound by their own caps and the guild's, both: a refusal is `precondition_failed` with `reason: limit_reached` and `scope` `agent_day` or `agent_month` (the member's dollars), `desk_month` (the guild's), `member_runs_day` or `guild_runs` (runs at once). `tools` and `ownKeys` are kept and shown, and change nothing yet: agents have no tools, and members can't add keys of their own.

### The Notebook's edit budget

On a guild desk a member without `moderate` may remove only so much of other members' text from one page over a rolling window, and desk-notebook refuses an update past it (`docs/sub-status/notebook-guild.md`). Blocks and embeds count at least 50. The size is a setting with three levels, the first that is present and in bounds winning:

1. **The guild's own**, `guild.settings` `notebook.editBudget`, set by the Founder or an Officer with `manage_spaces`; `null` clears it.
2. **The Platform's**, `guild.notebookEditBudget` in the config deskd reads (`GET /v1/agent/config`, and the copy hello's reply carries): `{"chars": N, "windowMinutes": M}`, platform-wide. A config without it, or with one malformed or out of bounds, has none.
3. **The default**, 500 characters in 10 minutes.

`chars` 0 means only moderators may remove what another member wrote (a typo fix in another member's text is refused). Bounds: `chars` 0 to 100,000, `windowMinutes` 1 to 1,440, whole numbers. Anything out of bounds or malformed at a level is ignored and the next level applies; a guild's own 0 is a value.

deskd sends the budget in force to desk-notebook, on a guild desk only, as `settings` in the hello on each connection, next to `caller`, and as a `settings` frame on every open connection whenever what is in force changes (the guild's set, the config's value, a clear). An owner or member desk never sends either.

```json
{"t":"hello","sessionId":"cs-1","sub":"gm-…","caller":{…},"settings":{"editBudget":{"chars":500,"windowMinutes":10}}}
{"t":"settings","settings":{"editBudget":{"chars":0,"windowMinutes":1440}}}
```

desk-notebook applies the latest to that connection's checks from the next update (and to `notebook.version.restore` on it), and keeps what it has already counted in its window: a longer window counts more of it, a shorter one less. A hello without `settings`, and a `settings` frame that is unusable, leave the connection with what it had (500 in 10 minutes to begin with). **An older desk-notebook** ignores `settings` in the hello and so keeps 500 in 10 minutes, but drops the connection on a `settings` frame, as on any message it doesn't know: the client reconnects and the page reopens. Release desk-notebook before deskd, so a change never reaches one that can't read it.

### Commons: channel 4

On a guild desk, channel 4 is `commons`, the room link to Commons (`negotiated: true`, id 4; it's `mdoc`'s id, which a guild desk never serves). Each room-link message is one DATA with BIN, sent whole, both ways, up to DATA's 4 MiB. deskd relays it on the session's own connection to Commons, which gets the member's caller in that connection's hello and never reads identity from the messages. `{"t":"reset"}` without BIN means the link to Commons went: reconnect, as for `collab`. On any other desk, and from any other session, DATA on channel 4 is dropped.

### The heartbeat

A guild desk's heartbeat carries exactly `ma-platform` `desks.md`'s `guild: {sessions}`: each member session's `sessionId`, `memberId`, `bytesSent` (desk-rtc's count for that session), `commonsBytesSent`, `connectedSeconds`, `commonsSeconds` (how long its room link to Commons was up) and `closed`, cumulative, at most 600, and a closed one once more with its last counts. `commonsBytesSent` is what Commons' SFU sent to the session's voice connection: Commons sends `{"t":"usage","voiceBytesSent":N}` on the session's relay connection (every 30 s while voice is up, and a last one with `"final": true` when that voice connection closes), N cumulative for one voice connection; deskd keeps a per-session total: every final value plus the latest value of the connection still open (a new connection restarts at 0; a value that drops without a final frame counts as a new connection). A malformed or negative N, and any other `t` from Commons, count for nothing. `GET /health` adds `commons: connected | waiting` and `guildPurges: {owed, held, done}` on a guild desk.

**desk-rtc 0.4.0 on a guild desk** (`desk-rtc/README.md`, "Guild mode"; deskd tells it from 0.3.x by `credit` in `configured`, which only a 0.4.0 Guild Desk reply has; `RtcClient.deskRtcHasFinalCounts`). deskd does three things only with it, and each does nothing with 0.3.x, which also works:
- **Final counts.** `session.closed` carries the session's `memberId`, `bytesSent` and `bytesReceived`, and the same go on in every `stats` as a row with `closed: true` until deskd lists the session in `stats.get {ack: [...]}`. A closed session's last heartbeat row (`closed: true`) uses those bytes, not the last `stats`, so what it sent since is billed. The closed row also settles a session whose `session.closed` was lost with `rtc.sock`. A session deskd closed itself ends first, so its row waits for the counts, at most 60 s, then goes with the last it had (as with 0.3.x). Every closed row seen, for a session deskd still knows or not, is acked in the next `stats.get` (at most 2048 ids), and forgotten here once the reply has come. Stats come in parts on a guild desk (`part`, `last`), and deskd joins them before it reads any. `stats.members` is not used: it is per process, and the meter is per session.
- **The 64 KiB credit.** A guild desk's `configure` asks `credit: 65536`, and each member session starts with `configured.credit` as its send credit per channel (256 KiB with 0.3.x, which ignores the field and echoes none). deskd never sends past it (more is `credit_violation`); `desk-rtc` grants it back as the data drains, and deskd's own grants to `desk-rtc` are unchanged (every 64 KiB drained).
- **Two more close reasons,** `protocol_error` (the member's client sent data on a stream that is not one of the eight channels, or broke an SCTP limit) and `over_budget` (a stalled member's queued data passed the desk's budget). `desk-rtc` has already ended the connection, so there is no CLOSE for the client; the session ends in deskd, the gateway hears `closed_by_desk`, the final counts are recorded as for any close, and one log line says which (the session id, never the member).

## 16. Files

The Files app's desk side (`docs/decisions/0048-files-app.md`): a window onto `/data/files`, a tree only deskd writes. **The exact wire, with every parameter, result, detail and golden example, is [`files.md`](files.md); this section is the table of what is served and the rules that decide who may.** [`files-vectors.json`](files-vectors.json) has the golden frames, and `FilesVectorsTest` replays them against deskd.

### Who may call

| Method or topic | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `files.list`, `files.stat`, `files.search`, `files.usage` | yes | `forbidden` | `forbidden` |
| `files.mkdir`, `files.rename`, `files.delete`, `files.trash.list`, `files.trash.restore`, `files.trash.empty` | yes | `forbidden` | `forbidden` |
| `files.upload.begin`, `.status`, `.finish`, `.abort` | yes | `forbidden` | `forbidden` |
| `files.read`, `files.read.stop` | yes | `forbidden` | `forbidden` |
| topic `files.changes` | yes | `forbidden` | `forbidden` |

`forbidden` carries `{reason: "scope"}`. An `export` session never gets any `files.*`: a closed account's export already carries the `files` part through `data.*`. A guild desk (`DeskKind=guild`) answers `forbidden` `{reason: "scope"}` to the owner too, as it has no Files. A deskd that predates this section answers `not_found`, which the client treats as "this desk can't do Files yet".

### Methods

`files.list {path, cursor?, limit?}`, `files.stat {path}`, `files.search {q, under?, limit?}`, `files.usage {}`, `files.mkdir {path, parents?}`, `files.rename {from, to, replace?}`, `files.delete {paths, permanent?}`, `files.trash.list {cursor?, limit?}`, `files.trash.restore {id, to?}`, `files.trash.empty {}`, `files.upload.begin {path, size, replace?, sha256?, token?, mtimeMs?}`, `files.upload.status {uploadId}`, `files.upload.finish {uploadId, sha256, size, token?}`, `files.upload.abort {uploadId}`, `files.read {path, offset?}`, `files.read.stop {transferId}`. Mutations (`mkdir`, `rename`, `delete`, `trash.*`, `upload.*`) need `idem`; `upload.begin` and `upload.status` are session mutations (a retry from another session runs again, as their effect is a transfer of this session). Every namespace change runs under one lock.

### Transfers on `bulk`

Downloads are `data.read`'s frames unchanged (§12): `files.read` replies `{transferId, size, mtimeMs}`, then CHUNKs flow within the reader's CREDIT, the last with END and the 40-byte trailer (SHA-256 of the whole file from byte 0, then `u64be` size). Uploads are the new direction on the same channel: the client sends CHUNK (kind 15, flags BIN) with the upload's `transferId` and `seq` from 0 for each attachment (`begin` or `status`); deskd answers CREDIT (kind 16, JSON) `{"bytes": n, "committed": c}`, and ends a transfer with `{"bytes": 0, "committed": c, "error": "<no_space|credit_violation|seq|superseded|aborted|io|expired>"}`. Credit never goes past the file's size, so the last acknowledgement of a small file can be `bytes: 0`. The `bulk` handler only queues a chunk to the upload's own writer thread and returns, so a slow disk never holds up the same session's downloads. Uploads and downloads share one table: 8 transfers a session and 12 a desk (`too_many` `{limit, reason}`), with `data.read`.

### The image gate

At `files.upload.finish`, deskd sniffs the finished partial's first 4 KiB by magic bytes, never by name (jpeg, png, gif, webp, heic, heif, avif, bmp, tiff, svg). An image is placed only with a verdict `token`, a JWS `typ ma-image-verdict+jwt` signed ES256 with a key in the JWKS deskd caches for desk tokens, bound to this desk (`aud`), the session's member (`sub`), and the SHA-256 and size of the **original** bytes, `ma_feature` `files`, `ma_state` `ok` or `unchecked`, at most 30 minutes. No token is `check_required`; a token that fails is `check_invalid` with the first failing reason of `signature`, `desk`, `member`, `expired`, `feature`, `state`, `size`, `hash`; a token on a file that is not an image is `kind`. There is no refusal by image type or size. Archives and documents are never checked.

### The Agent's Files tools (§18)

`files_read`'s `offset` is the `next` of the page before: one the file doesn't have (past its end, or inside a character) is refused `bad_request` `offset`, never `path`, which the model would read as a wrong path (`sub/mm-fix-bundle-2`). An agent's `files_*` tools (§18) work in the same tree, by the same rules, as the owner: inside `/data/files`, links never followed, never `.trash` or `.uploads` at any depth, nothing permanent (`files_trash` moves to the trash; there's no empty and no permanent delete). A write takes the free tier's cap and the floor as an upload does (`no_space`, with `cap` on a free desk), under the same last-bytes lock as an upload's `begin`, from its check of the room until the file is in place and counted, so a write and an upload can't both take the last bytes; replacing a file sends the old one to the trash first, and every change reaches `files.changes` as the app's own do. A guild desk has no Files, so no agent there has these. Never a path or content in the journal.

### Configuration (container environment)

| Variable | Meaning | Default |
|---|---|---|
| `DESKD_FILES_ROOT` | where the tree is | `/data/files` |
| `DESKD_FILES_IMAGE_GATE` | `stub` makes the string `stub.<sha256>` a valid token. A test desk's own env file only; no release image sets it. | unset |
| `DESKD_FILES_ALLOW_UNCHECKED` | whether `ma_state: unchecked` (the checker was offline) is taken | `true` |
| `DESKD_FILES_VERDICT_KEYS_FILE` | a JWKS file to verify tokens with instead of the cached desk keys | unset |

The tree must be owned by the process's uid with mode `0700`, and on a filesystem with `openat`; otherwise every `files.*` answers `unavailable` `{reason: "tree"}` until deskd restarts. The image makes `/data/files` (1100:1100, `0700`) in `desk-datadirs` and mounts it into deskd's container.

**On a shared host** deskd runs in the slot's own sandbox (`image/host/`, ADR 0072), whose `/data` is a small root-owned tmpfs with only the desk's `/data/desk` moved in. Host images up to 0.1.10 don't move the desk's `/data/files` in, so deskd can't make the tree, logs `the Files tree can't be used: AccessDeniedException` once at start, and every `files.*` answers `unavailable` `{reason: "tree"}` (free walk H5: "Your desk couldn't open that just now"). The fix is the host's: the volume's own `files` directory, 1100:1100 `0700`, moved into deskd's sandbox as `/data/desk` is. deskd needs no change, and still never makes the tree anywhere else.

## 17. The free tier

A free member's desk holds the limits the Platform's config gives it in `tierLimits` (`ma-platform` contract `agent.md`, `tiers.md` section 11; `docs/decisions/0090-free-tier-desk.md`): `{tier: "free", browserMinutesPerDay, filesGb, idleStopMinutes}`. Absent means no limits. They change at the next config after an upgrade or a downgrade, with nothing restarted, and a read that fails, or hello's copy the Platform couldn't finish (`configVersion: 0`), changes nothing. deskd keeps the last word in `/data/desk/tier-limits.json`.

### Browser time
- **What counts:** the seconds the Browser is in use: its video going to at least one session (a session wants `live` and the desk is looked at: §10, "Nobody looking", which cuts the media 5 s after nobody is), **or the simplified view in use** (§14, "Browser time"). Once per desk: `live` and the simplified view together are one count, never two. Not `warm` alone, not a desk nobody looks at, not Chromium merely running.
- **The day** ends at midnight in the account's `agentDefaults.timeZone`, or UTC with none. Its end is fixed when its first second is counted, so a zone change applies from the next day, and a day never ends less than 23 hours after the last did. Kept in `/data/desk/browser-time.json`, so a restart, a stop and a move keep it.
- **At the limit,** `live` is refused with `unavailable` `{reason: "bandwidth_limit", resumesAt, limit: "browser_time"}` (§10's table), and any session that's `live` is moved down to `off` as the bandwidth pause does. The simplified view's page calls and subscriptions get the same refusal, and its open subscriptions end (§14, "Browser time"). Tabs, cookies and sign-ins are never touched.
- **The time left isn't served here.** The heartbeat carries `media.browserLiveSeconds` (whole seconds the Browser was in use, live or the simplified view, since the desk booted, on every desk), the Platform's meter turns it into the member's `browserTime`, and the Desk app reads that.

### Files
Capped at `filesGb` GiB on top of the 2 GiB floor: `files.usage` adds `capBytes` and `capUsedBytes`, and a new upload past the cap gets `no_space` with `reason: "cap"` ([`files.md`](files.md) sections 1, 2 and 5). Nothing already there is touched.

### Topic `desk.contention`
SUB (any owner session) gets a `snapshot` `{held}`, then a `patch` `{held}` on each change. `held` is true while the desk's whole cgroup on its shared host is held back from the CPU for long enough to feel: its `cpu.pressure` `some avg10` at 25% or more, until it's under 10% (and the same for `cpu.stat`'s `throttled_usec` over 10 s, should a class ever have a CPU cap). It comes only from the desk's own cgroup, never from a client.
- **Where it can't be seen,** the SUB gets `unavailable` with `{reason: "source"}`: every desk of its own, and a shared host that doesn't give deskd the desk's cgroup files yet. A client treats that as "not held" and says nothing. A file that becomes unreadable while subscribed is "not held".
- **Cost:** two small files read every 2 s while anyone is subscribed.

| Variable | Meaning | Default |
|---|---|---|
| `DESKD_CONTENTION_DIR` | where the host puts the desk's cgroup `cpu.pressure` and `cpu.stat`, read-only | `/run/desk-host/cgroup` |

## 18. Agent tools and approvals

**Draft (protocol), 2026-11-11. Built: desk-agent's gate, the three methods, the event and the new fields, and deskd's relay and tickets (`sub/agent-approvals`); the tool registry and policy, and the Files, Browser and Notebook tools, `plan_update`, `follow_up` and `workspace_delete` (`sub/agent-tools`, "The tools, as built" below); `browser_click` and `browser_press`, done by deskd's half in deskd's own world (§14, "The Agent's walker"), and Security's S-14 rules (`sub/agent-click-press`).** The Agent at launch acts on the desk through declared tools, and asks the member before anything that matters: writes, deletes, sending and spending ([draft ADR](../../../docs/decisions/draft-agent-tools-approvals.md)). desk-agent serves everything here and deskd relays it as §11, with two checks of its own (below). Every name is a wire name. Everything in a `payload`, `target` or `before` came from a model, a page or a file: render it as plain text only, never as markup or a link.

**Nov 12, here now (`sub/lsub-agent-tools-setup`, Ready, not merged):** the new-agent setup screen's wire, "An agent's access" below: `agent.access.get` and `.set`, `agent.desks.revoke`, an agent's `setup`, deskd's own record of each agent's access, the hello's `access`, and the refusals `setup` and `scope`. **Since built:** messages between desks (`sub/mm-desk-messages`, "Messages between the member's desks" below: `agent.desks.answer`, `.take`, `.deliver` and `.done`, the `agent.desks.outbox` topic, `statusDetail: "waiting_desk"` and the refusal `no_grant`). **Nov 13 (`sub/mm-auto-approve`, W3):** auto-approve acts on the switches: "Done without asking" below, with `agent.approval.undo`, an approval's `decidedBy: "auto"`, `auto` and `undoneAt`, and a reply's `auto`. Writing them here is the first item of the work breakdown (`docs/sub-status/lsub-agent-tools-adr.md`).

### Who may call

| Method | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `agent.approvals.list`, `agent.approval.get` | yes | `forbidden` `{reason: "scope"}` | their own agent's only |
| `agent.approval.decide` (mutation, `idem`) | yes, with a token that has input | `forbidden` `{reason: "scope"}` | their own agent's only |

- **deskd's relay** adds the three to the `agent.*` methods it relays. They aren't team methods, so a guild member passes deskd; desk-agent answers `not_found` for an approval of an agent that isn't the caller's, so ids tell nothing. A teen gets `forbidden` `{reason: "age_band"}`, as every `agent.*` does (§11).
- **Input:** deskd refuses `agent.approval.decide` from an owner token without input with `forbidden` `{reason: "permission"}`, before desk-agent hears it. A guild member's token never has input (a guild desk has no Browser), so a member decides with their own member token, for their own agent only. A support session, once those exist, never decides.
- **deskd's own record** (`ApprovalTickets`): for each decide with `approve: true`, deskd keeps `{approvalId, sha256, caller}` in RAM from just before the request goes to desk-agent until 10 minutes later. desk-agent refusing the decision (`bad_request`, `not_found`, `conflict`, `forbidden`), or answering a state that isn't `approved`, `done`, `failed` or `interrupted`, drops it; a repeated yes for the same id neither replaces the first's ticket nor, when desk-agent answers it `answered`, drops it. A tool deskd runs for desk-agent (Browser, Files, Notebook) runs only against one of these, once: the call names `{approvalId, sha256}` and its `context`, deskd computes the hash of `{v: 1, agentId, runId, tool, context, payload}` from the arguments it received, and the ticket's caller must own the agent. Otherwise the tool's error is `approval_unknown` (none, lapsed, or lost with a deskd restart: the model asks again), `approval_used` or `approval_mismatch`, and a refusal leaves the ticket as it was. Nothing for a client to do.
- **A call done without asking** (the owner's decision of Nov 12, the draft ADR's §15; `sub/lsub-agent-tools-core`, a policy point with nothing in it yet: both low-risk maps are empty until the ADR's W3): desk-agent's `tcall` carries `auto: <group>` (`notebook`, `files`, `todos`) in place of `approval`, for a call its gate let through under a switch the member turned on for that agent, and `autoApprovalId`, that call's own approval id from desk-agent's gate (`ap-…`, named on its `approval.auto` audit row): required with `auto` (missing or malformed is `bad_request` `autoApprovalId`, nothing run), and the key a tool uses as it uses a member's approval id (the Notebook's edit key, so an unasked edit is made once and the ADR's undo by approval id finds it). deskd runs it only if the group is the one its own declarations give the tool (`HostedDecls.LOW_RISK`, empty today), its own record says the agent's owner switched that group on (`ToolHost.AccessRecord`, answered by `agent/AccessRecord`, which records the switches from the member's relayed `agent.access.set`; wired at the setup branch's merge), and the call is in the low-risk class by deskd's own class, context, taint and arguments: exactly `write` with a `write` floor, the agent's own context, a run deskd hasn't seen read `U`, only adding (no replace; a Notebook `create` or `append`) within 64 Ki characters of file text or 8,000 of Markdown, never a guild member's agent. Otherwise `approval_unknown`, as for a yes deskd never relayed. A malformed `auto` is `bad_request`. Until the ADR's W3 fills the class, every call that asks needs a relayed yes. desk-agent's gate checks the same class again whatever its policy says, never lets `follow_up` (a timer, which deskd never sees) run unasked, and asks for a call that comes after one in the same step that runs (or may), isn't itself done unasked, and whose result can add `U` before deskd checks it (Security's ATC-I1). Every tool's result can, but for a closed list whose results never do (`Approvals.NEVER_ADDS_UNTRUSTED`): `files_list`, `files_search`, Files' writes, `browser_close`, `desk_answer`, To-do's writes, the agent's workspace listing and writes, `desk_agents`, `desk_choices`, the proposals, `plan_update`, `follow_up` and the memory tools. A look-up whose result deskd may mark as it runs (a Notebook read or listing, `todo_list`, `todo_get`, any Browser read), a workspace read, another agent's answer and any tool not on the list still make the write after it ask (`sub/mm-fix-bundle-2`, release 3's bug E).

### Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.approvals.list` | No | `{agentId?, state?, before?}` | `{approvals, older}`: newest first, 50 a page (fewer past about 900 KiB), payloads over 32 KiB left out. `state` is `pending` (the default) or `all`. Without `agentId`, every agent the caller may see. `before` is an approval's `id`, of that agent when `agentId` is given. An `agentId` the caller doesn't see is `not_found` `{detail: "agent"}` |
| `agent.approval.get` | No | `{approvalId}` | `{approval}`, always with the whole `payload` |
| `agent.approval.decide` | Yes | `{approvalId, approve, sha256, note?}` | `{approval}`, as it is after the decision |

- **`sha256`** is what the app computes from the `payload` it shows (below), not a copy of the field. A card whose computed hash isn't its `sha256` shows no Approve.
- **`note`:** only with `approve: false`, 1 to 500 characters, no hidden characters. The agent reads it as the member's words.
- **An approval is answered once.** After `approve: true` the tool runs at once; the answer may already say `done` or `failed`, or still `approved` while it runs, and an `approval` event follows each change.
- **Approve all** is one `agent.approval.decide` per card, each with its own hash. Offer it only for one run's pending cards when none has `risk: "spend"` or `risk: "egress"` and none is `untrusted` (Security: egress is never batched).
- **Refused before asking** there is no card: the call's chip has `ok: false` and no `approval`, and the model reads "Not allowed: {reason}." The reasons: `ask_cap` (10 asked a run, 5 pending for the agent, 20 on the desk, 2 signed-in sites a run, or a second `spend` in one step), `unattended_spend`, `origin` (`browser_use_my_session` in a run a timer or another agent's message started: only a run the member started may ask for their session, Security's S-14 rule), `declined_before` (the same hash declined or expired earlier in the run), `declined` (after 3 declines or expiries in a run), `tool_cap` (past 100 tool calls a run), `too_large` (a payload over 900 KiB of JSON), `payload`, `sensitive` and the tool policy's own.

| Error | `details` | Meaning |
|---|---|---|
| `not_found` | `{detail: "approval"}` | No such approval, or not the caller's |
| `bad_request` | `{detail: "sha256"}` | Not the hash of the stored payload: fetch it with `agent.approval.get` and show it again |
| `bad_request` | `{detail: "note"}`, with `reason: "hidden_chars"` or none | A note with `approve: true`, empty, over 500, or with hidden characters |
| `conflict` | `{reason: "answered"}` | Already decided |
| `conflict` | `{reason: "expired"}` | Expired, or its run ended. Nothing was done |
| `forbidden` | `{reason: "permission"}`, `{reason: "scope"}`, `{reason: "age_band"}` | Above |

### The approval

```json
{ "id": "ap-7k2m4q1z9x0d3n5b8c6v", "agentId": "ag-3k9x0d2m4q1z", "runId": "…", "messageId": "…",
  "tool": "files_write", "risk": "write", "title": "Save “Plans/trip.md” in your Files",
  "context": "agent",
  "target": { "kind": "file", "path": "Plans/trip.md" },
  "payload": { "path": "Plans/trip.md", "text": "…", "replace": true },
  "payloadOmitted": false, "payloadBytes": 1834,
  "before": { "sha256": "…", "bytes": 912 },
  "sha256": "…", "untrusted": false,
  "origin": { "kind": "member" },
  "state": "pending", "detail": null,
  "createdAt": 1762850000000, "expiresAt": 1762853600000,
  "decidedAt": null, "decidedBy": null, "note": null, "result": null }
```

| Field | Meaning |
|---|---|
| `id` | `ap-` and 20 lowercase base32 characters |
| `tool`, `risk` | The tool and this call's class: `write`, `delete`, `send`, `spend`, `egress`, or `own` (a memory save in an untrusted run). The class can be higher than the tool's usual one, never lower: a click on a submit control is `send` |
| `title` | The desk's words for the card, from the tool's template and `target`, never the model's text. Build the card from your own template per `tool` and use `title` only for a tool you don't know |
| `context` | `agent` (the agent's own signed-out Browser, or no Browser) or `member:<site>` (the member's signed-in session for that site) |
| `target` | What it acts on: `{kind: "file", path, to?}`, `{kind: "page", pageId, title}`, `{kind: "element", origin, pageTitle, label, role}`, `{kind: "site", site}` or `{kind: "site", origin}`, `{kind: "timer", at}`, `{kind: "memory"}` |
| `payload` | The exact arguments the tool will run with, hashed. Show it in full as data: the text to save, type or send, quoted. Over 32 KiB of JSON it's left out of events (`payloadOmitted: true`, `payloadBytes`); get it with `agent.approval.get` before offering Approve |
| `before` | What the change replaces, read when asked, not hashed: a file's `{sha256, bytes}` (the write is refused `changed` if it differs at run time), a page's `{title}`, or `null` |
| `sha256` | Hex SHA-256 of the canonical JSON, the encoding `agent.proposal.answer` uses, of `{"v": 1, "agentId", "runId", "tool", "context", "payload"}` |
| `untrusted` | The run read web pages, files or another agent's messages before asking. Say so on the card |
| `origin` | What started the run, as a proposal's: `{kind: "member"}`, `{kind: "timer", agentId, timerId, label}`, `{kind: "agent", agentId, name}` |
| `state`, `detail` | Below |
| `expiresAt` | 1 hour after asking in a run the member started; 24 hours in one a timer or another agent started |
| `decidedBy` | `owner`, or the guild member's id |
| `note` | The member's note, when they declined with one |
| `result` | After the tool ran: `{ok: true}` or `{ok: false, error}`, `error` a word such as `changed`, `gone`, `off_site`, `exists`, `no_space`. Never content |

**States.** `pending` → `approved` (running) → `done`, `failed` or `interrupted`; or `pending` → `declined` or `expired`. An `approved` one whose tool never started, because its run stopped or desk-agent went down first, becomes `expired` with that `detail`: nothing was done.

| `state` | Card |
|---|---|
| `pending` | Approve and Decline, the time left |
| `approved` | "Doing it…" |
| `done` | Done |
| `failed` | "Approved, but it didn't work", with `result.error` |
| `declined` | Declined, with the note |
| `expired` | Nothing was done. `detail`: `timeout` (no answer in time), `stopped` (the member stopped the run), `restart` (the agent restarted or the desk stopped), `age_band` |
| `interrupted` | "The agent restarted while doing this. It may have happened: check {target}" |

### Payloads by tool, for the card templates

| `tool` | `payload` | `target.kind` | `before` |
|---|---|---|---|
| `files_write` | `{path, text, replace}`, `replace` always a boolean | `file` | `{sha256, bytes}` when replacing, else `null` |
| `files_mkdir` | `{path}` | `file` | `null` |
| `files_move` | `{from, to}` | `file` (`path` is `from`) | `null` |
| `files_trash` | `{path}` | `file` | `{bytes, dir}` |
| `notebook_write` | `{pageId?, new?: {tabId, title}, op, markdown, find?}`, `op` `create`, `append` or `replace_text` | `page` (`pageId` null for `create`, `title` the new one), with `converted` (`table`, `image`, `html`, `heading_level`) when the Notebook has no node for some of the Markdown: say so on the card ("Tables become lines of text") | `{title}`, or `null` for `create` |
| `notebook_trash` | `{pageId}` | `page` | `{title}` |
| `browser_click`, `browser_press` | `{tabId, ref, label, role, origin, key?, spend?, submit?}`, `spend: true` on a spend and `submit: true` on a click that submits a form, so the member's yes binds each | `element` (with `pageTitle`) | `null` |
| `browser_type` | `{tabId, ref, label, role, origin, text}` | `element` (with `pageTitle`) | `null` |
| `browser_open`, `browser_back` (only when they ask: always in the member's session, else under the Rule of Two; `risk: "egress"`) | `{tabId?, url}` (the address normalized), `{tabId}` | `site` with `origin` | `null` |
| `browser_use_my_session` | `{site}` | `site` with `site` | `null` |
| `follow_up` | `{at, prompt}`, `at` in ms since the epoch, within 7 days | `timer` with `at` and `when` (the same, ISO 8601 UTC) | `null` |
| `memory_save` (only in an untrusted run) | the memory runner's | `memory` | `null` |

For Browser actions the desk adds `label`, `role` and `origin` from the page as it read it, so the hash covers what the card shows; `ref` is `{node, fp, block, rev}` (the model names an element by a short ref such as `n12`, which the desk expands), `role` one of `link`, `button`, `field`, `check`, `select`, and the action proxy refuses (`changed`, `gone`) a page that no longer shows it: the node must be in the current MDoc with the same `fp` and block, the `rev` of the current document, and deskd's half takes the element's fingerprint again in the same call as the act. **In the member's signed-in session every navigation the agent starts asks as `egress`, whatever the run's taint** (Security's finding on the protocol): `browser_open`, `browser_back` and a click on a link on that tab; every other click, typing and press there is at least `write`.

**The class, before anything is done** (S-14): a click on a form's submit control, or Enter in a field that sends (not a search box of a GET form in the Agent's own context), is `send`. What a click or an Enter submits is found by deskd's half on the element itself, with nothing clicked, focused or scrolled: a click by what the browser would activate (a `<button>` in a form, `input type=submit` or `image`, by its `form` too, a label's control, the nearest such element over a span in it, across shadow roots), whatever its label (the Browser bar's gap 1); an Enter by its form's implicit submission, whatever the field's kind, and the submit button's words for paying (Security's BB-L1); also by a control's words ("Send", "Post", "Sign up", …) or as the page's main action on a page with fields. A submit of a GET form that holds a search box (`input type=search`, or a `role=search` or `<search>` form) is a search: a `read` in the Agent's own context, `send` in the member's session. A submit's payload says `submit: true`; one approved without it, on a control the page has made a submit since, is refused `changed`, by deskd's tools and again by deskd's half at the click, and a click that submits a form nobody approved as one is never done. **The model's arguments never set the class:** `spend` and `submit` count only on a call the member approved, whose arguments are the card's payload (an approval on a call whose class doesn't ask is never redeemed and never reaches the tool: Security's BB-L2), and a control is judged by what deskd's last read of the tab showed: an expanded ref (`{node, fp, block, rev}`) for a node that read didn't show is `not_found` unless an approval bound its `label` and `role` (gaps 2 and 3). A click or such an Enter that looks like paying is `spend`: a control labelled buy, pay, place order, checkout, subscribe, donate or confirm purchase, a card field on the page, a payment provider's page, or **a payment provider's frame anywhere in the page, whatever its size and whatever the control says** (deskd's `payment-hosts.txt`: Stripe, PayPal, Adyen, Braintree, Square, Apple Pay and Google Pay among them; found in Chromium's frame tree, the tab's and each out-of-process frame's, and by deskd's half in the document). A spend's payload says `spend: true`; a call approved without it on a page that is now a payment page is refused `changed`, by deskd's tools and again by deskd's half at the act. A spend stays `spend` under the Rule of Two. Refused before asking: a link or a form's address to another site in a member-session tab (`off_site`) or to a local host (`blocked`), by the address the walker read and by the element itself at the look, and again on the element as it's clicked; a click or a key in a sensitive field or select (`sensitive`), and Backspace on a payment provider's page.

**An act that was done is answered as done** (Security's BB-L5): what followed a click, a key or typing goes in its result, never as a failure, so an approved send or spend never reads as not done and is never asked again. `stopped: "off_site"` or `"blocked"` when a navigation it led to was cancelled at the request; `closed: "memory"` (no page after it) when the page then held more than an Agent tab may; `view: "unknown"` when the page after it couldn't be read. A refusal before the act (`changed`, `off_site` by where the element goes, `sensitive`, …) still fails the call, as nothing was done.

### The tools, as built

What the model is offered and what a card can be for. `services/desk-agent/README.md`, "Tools", has the rest.

| Area | Tools (class) | Runs in |
|---|---|---|
| Files | `files_list`, `files_search`, `files_read` (read); `files_write`, `files_mkdir`, `files_move` (write); `files_trash` (delete) | deskd, §16 |
| Browser | `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_back`, `browser_close`, `browser_tabs` (read, rising); `browser_use_my_session` (egress; refused `origin` in a run the member didn't start) | deskd, §10 and §14 |
| Notebook | `notebook_search`, `notebook_list`, `notebook_read` (read; `S`, and `U` on a guild desk or for marked text); `notebook_write` (write); `notebook_trash` (delete) | deskd, §13 |
| To-do | `todo_list`, `todo_get` (read; `S`, and `U` for an untrusted item); `todo_add`, `todo_update` (write); `todo_close` (own as a suggestion, write as a close) | deskd, §22 |
| Courier | `courier_list`, `courier_search`, `courier_read`, `courier_new` (read; every result `U` and `S`). No send of any kind | deskd, §21 ("The agent's Courier tools") |
| The agent's own | `plan_update`, `workspace_delete` (own); `follow_up` (write) | desk-agent |

- **Who gets what:** the desk's agents get every area deskd offers; a guild member's own agent gets Notebook and `plan_update` only. No permanent delete, emptying a trash, shell or outbound message is a tool.
- **The Rule of Two is for browse actions only:** `browser_open`, `_click`, `_type`, `_press` and `_back` are `egress` in a run holding both `U` and `S` (a `spend` stays `spend`), in deskd, in desk-agent's policy and in its run loop's backstop. `browser_read`, `browser_tabs` and `browser_close` stay `read` and never ask; reading a member-session tab still adds `S` (and `U`) to the run.
- **Refused before asking,** so no card comes: input the tool doesn't take (`input`), a tool switched off on the desk (`off`), the session grant in a run the member didn't start (`origin`), a sensitive or payment field (`sensitive`), another site in a signed-in tab (`off_site`), a blocked site (`blocked`), the tab cap (`tab_cap`, 2 Agent tabs on the desk, 1 on a free desk, a member's-session tab one of them: so `browser_use_my_session` too when its site's tab isn't open), a third signed-in site (`ask_cap`), a file already there (`exists`), a Notebook edit that would fail (`not_found`, `ambiguous`, `whole_block`, `grant`, `budget`, `trashed`).
- **`result.error`** of a card is one word: `changed`, `gone`, `exists`, `no_space`, `off_site`, `approval_unknown`, `approval_used`, `approval_mismatch`, `unavailable`, … Never content. A card whose call may have happened (a desk-agent restart while it ran, or a lost link its key couldn't confirm: "Keys" below) is `interrupted`, with no `result`.
- **Paged reads** (`files_read`, `browser_read`, `notebook_read`; `sub/lsub-agent-tools-core`): the model reads at most 20,000 characters of any tool result (desk-agent's run loop), so desk-agent fits each page under that, fenced or not: the page's fields first and its text last, and a text that doesn't fit is cut at the end with `next` moved back to just after the last character kept (in a text file's UTF-8 bytes; a document's, page's or note's characters) and a `note` to read on. Reading on from each `next` gives the whole file, page or note, nothing skipped. deskd still sends up to 128 Ki characters of a file a page; the model reads about 19,000 a call, so a run of 100 tool calls reads about 1.9 MB of one text file.
- **Files paths the Agent may use** (`sub/lsub-agent-tools-core`): Files' own grammar (§16), and also no invisible or format character (zero-width spaces and joiners, the BOM, the soft hyphen, word joiners, tag characters, Hangul fillers and the other default-ignorables), no line or paragraph separator, no private-use, unassigned or noncharacter code point, no character drawn like a slash or a backslash (`∕ ⁄ ／ ⧸ ⧹ ＼ ∖ ﹨ ╱ ╲`), no name of dots alone (`...`, `‥`, `．．`), and no space at either end: each refused `path`, at the look and at the run, so a card never shows one name while the tool acts on another. Variation selectors stay (a name with an emoji). The member's own Files take any name Files does. A FIFO, a link, a device or a hard-linked file is never opened, as a folder or a file, at any depth.
- **Chips' `summary`** for these tools is the desk's own few words ("Saved a file in your Files", "Opened a page", "Edited your Notebook"), never a path, title or address; `target` is the card's.
- **`plan`** on a reply is built: `plan_update` replaces it, live while the reply streams, and it stays with the reply.

### Keys: a tool call asked again (Nov 13, durable runs' seam)

desk-agent's tool calls on the agent socket keep their replies by a key, as a client's mutations do by `idem` (§4), so a call whose answer was lost is never run twice. Nothing here reaches a client.

- **The hello says so:** `desk.tools.hello` carries `keys: {ttlSec: 600}`. desk-agent asks a call again only on a connection whose hello said it; an older deskd, which would run it twice, never gets `retry`.
- **Every `tcall` but a look and `run_end` carries `key`:** desk-agent's UUIDv7 for the call, which names its record in `agent.db` (`run_calls`). Not a UUIDv7 in lower case: `bad_request` `key`, nothing run.
- **deskd keeps the reply** (`tres` or `terr`, refusals included) for 10 minutes after the call ends, in RAM, in a store of its own bounded as §4's (4,096 replies, 8 MiB; past that the oldest go first), by the agent and the key. A tool whose rule is `safe` (`HostedDecls`: the reads, `browser_close`, `browser_tabs`) has its reply kept only when its class rose to one that asks. deskd binds the key to the call: its run, agent, tool, `args`, `approval`, `auto`, `autoApprovalId` and `context`.
- **The same key again** gets the kept reply, with its own `id`, and runs nothing; while the first still runs, it waits for it. The same key for another call: `bad_request` `key_mismatch`, nothing run, never another call's reply.
- **`retry: true`** says desk-agent sent this call before and got no answer (the link went, its 60 s ran out, or deskd answered `unavailable` `stopping`). A key deskd doesn't hold (deskd restarted, or 10 minutes passed, or the store let it go) is refused `conflict` `key_unknown`, and nothing runs: it may have run before. desk-agent then ends the call `interrupted`. A retry with no `key` is `bad_request` `key`.
- **A first call with a key made more than 10 minutes ago** (by the time in the UUIDv7, against deskd's clock) is refused `conflict` `key_expired`, and nothing runs.
- **A resend binds what the first sending bound** (`ToolHost.fingerprint`: run, agent, tool, arguments, approval, switch and `context`), or deskd refuses it `bad_request` `key_mismatch` and runs nothing. A step picked up after a restart takes its calls' `context` from its checkpoint (`ToolPolicy.resumed`, Nov 14, `sub/mm-release-fixes`; before it the resend went without one and was refused). desk-agent ends a resend refused `key_mismatch` `interrupted`, as `key_unknown`: something ran under that key.
- **What desk-agent does** (draft ADR §3, "Restarts"): a call with no answer whose rule is `retry_by_key` (what deskd runs that changes something; a call whose class rose to one that asks) is asked again with the same key and `retry: true` on the next keyed link, for up to 2 minutes. deskd's kept reply settles it as it would have; `key_unknown`, `key_expired`, no link, or a deskd that keeps no keys end it `interrupted`, and an approved card with it ("may have happened"), never `failed` and never run again. A `safe` call with no answer fails `unavailable`, as before.
- **A deskd restart** loses the kept replies with the tickets (§18, "deskd's own record"): a call asked again after one is `key_unknown`.

### Runs across a restart (Nov 13, durable runs' resume)

**Built on `sub/mm-durable-resume`** (draft ADR §3, "Restarts"; ADR 0020 as amended; `docs/sub-status/mm-durable-resume.md`). A run survives a restart of desk-agent (a kill, a rollout, the desk's stop): it picks up from its last checkpoint in `agent.db`. Nothing new on deskd's side of the agent socket: a call the restart left in flight comes again with its first `key` and `retry: true` (above), so deskd answers from what it kept, or `key_unknown`, and runs nothing. What clients see:
- **A reply stays `streaming`** across the restart (or `awaiting_approval` while its run waits on a card), and goes on; the next snapshot and `message` event carry its text so far. A reply whose run picked up after a restart has **`resumed`**, how many times (a number, on assistant messages only, absent when never). A run that can't resume ends as before: `failed`, `error: "unavailable"`, `errorDetail: "interrupted"`, with what it had.
- **A pending card stays `pending`** and answerable through the restart (`agent.approval.decide` works on it as soon as desk-agent is up), until its own `expiresAt`. A card whose call was running when the restart came ends `done` or `failed` with deskd's kept result, or `interrupted` when deskd no longer held it (deskd restarted, or the desk stopped). An approved card whose call hadn't started, after a deskd restart, ends `failed` with `result.error: "approval_unknown"`: deskd lost the member's yes, and nothing ran.
- **A chip** (`tools[]` on a reply) has **`interrupted: true`** when its call may or may not have happened (a restart or a lost link its key couldn't confirm); `ok` is `false`, and its `target` says what to check.
- **`statusDetail: "waiting_<kind>"`** on `agent.state` (`waiting_desk`: a run waiting on another desk's answer, §14): `status` stays `working`, and, like `awaiting_approval`, it doesn't keep the desk awake (deskd counts neither as an active task).
- **Release order:** either. An older desk-agent never resumes, ends every run at its open as before, and ignores the new rows; this one opening a file an older one wrote drops checkpoints whose replies that one ended.

### An agent's access: the setup screen and its settings

**Built on `sub/lsub-agent-tools-setup`** (draft ADR §14 to §16; `docs/sub-status/lsub-agent-tools-setup.md`). What each agent may use, as the member chose it on the agent's setup screen and later in its settings. **No run of an agent starts before the member has saved its screen**, and deskd keeps its own copy of every choice, which the tools it runs go by.

| Method | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `agent.access.get` | yes | `forbidden` `{reason: "scope"}` | their own agent's only |
| `agent.access.set`, `agent.desks.revoke` (mutations, `idem`) | yes, with a token that has input | `forbidden` `{reason: "scope"}` | their own agent's only |

| Method | Params | Result |
|---|---|---|
| `agent.access.get` | `{agentId}` | `{access}` |
| `agent.access.set` | `{agentId, apps?, auto?, desks?}` | `{access}`, as it is after the change |
| `agent.desks.revoke` | `{grantId}` | `{agentId, access}`: the grant's agent and its access after |

```json
{ "access": { "chosen": true, "setup": null,
  "apps": { "notebook": true, "files": true, "browser": true, "courier": false, "todos": true },
  "auto": { "notebook": { "tabId": "tab-1" }, "files": null, "todos": false },
  "desks": [ { "grantId": "dg-…", "agentId": "ag-…", "toDeskId": "d-…", "toDeskName": "Work", "toKey": null,
               "state": "offered", "createdAt": 1762850000000, "lastUsedAt": null, "count": 0 } ],
  "incoming": [], "updatedAt": 1762850000000 } }
```

| Field | Meaning |
|---|---|
| `chosen` | The member has saved the screen. While `false`, every run of the agent is refused `precondition_failed` `{reason: "setup"}`: the member's message, a timer's (its `lastState` is `setup`) and another agent's (`message_agent`'s result says the agent is waiting for the member) |
| `setup` | Why the screen shows, or `null` once chosen: `new` (never set up: an agent made by hand, by a lead's proposal, a new desk's lead), `upgrade` (made before the screen existed: its next run waits for the screen, which starts from what it could use, Notebook, Files and Browser), `confirm` (deskd holds no copy of the choice, or the record didn't read back whole: the screen starts from what was chosen, never more). Also on each agent in `agent.list`, `agent.get` and `agent.state` |
| `apps` | One switch each. A new agent's screen starts with every app on but Courier; a guild member's own agent has Notebook alone, whatever is sent. An app switched off takes its tools away from the agent's very next step, a run already going included, and its calls are refused `scope` before anything is asked |
| `auto` | The "without asking" switches (§15), all off by default: a Notebook tab by id, a Files folder relative to the Files' top (never the top itself, the trash or the uploads), and to-dos. Each needs its app: an app switched off takes its switch. **Recorded and checked here; acted on by the auto-approve build (§15), which isn't here yet** |
| `desks` | The send halves of the agent's grants to the member's other desks (§14), offered or active, never revoked. Off by default: each is the member's explicit choice. `offered` until the other desk allows it, then `active`, with `toAgentName` (messages between desks, below) |
| `incoming` | The answer halves this agent answers, and the offers from the member's other desks waiting here (messages between desks, below) |

- **`agent.access.set`:** the first save (while `chosen` is false) must carry every app (`apps.notebook` … `apps.todos`) and every switch (`auto.notebook`, `auto.files`, `auto.todos`), or it's `bad_request` with `detail` the first missing field and `reason: "required"`; the screen always sends them. A later one changes only what it names. `desks` is `[{deskId, deskName?, on}]`: `on: true` for a desk with no live half offers one (needs `deskName`, 1 to 60 characters, no hidden characters), `on: false` revokes its half at once. Refusals, all `bad_request` with `detail`: a key it doesn't take (`detail` the key), an app or switch that isn't one (`apps.<name>`, `auto.<name>`), `reason: "app_off"` for a switch turned on for an app that's off, `reason: "folder"` for a folder it can't be, `reason: "name"`, `reason: "too_many"` (20 desks), `reason: "guild"` for anything but Notebook on a guild member's agent, and from deskd, before desk-agent hears, `{detail: "desks", reason: "self"}` for this desk itself. A refusal changes nothing.
- **`agent.desks.revoke`:** `not_found` `{detail: "grant"}` for a grant that isn't one of the caller's agents' or is already revoked. Deleting an agent revokes its halves.
- **Who:** only a session that may act, as for a decision: deskd refuses an owner token without input (`forbidden` `{reason: "permission"}`) before desk-agent hears; an `export` session gets `scope`; a guild member chooses for their own agent alone. Never a lead's proposal (`propose_agent` and `propose_agent_change` can't carry it, and an agent a proposal makes waits for its screen), a timer, a message, another desk or the model: nothing else reaches these.
- **Audit (desk-agent's log):** `access.set` (actor `user` or `member`; target `agent:<id>` and which apps and switches changed, `files:off courier:on auto.notebook:on`; decision `setup` for the first save, else `ok`; never a place or a desk's name), `desks.offer` and `desks.revoke` (`agent:<id> grant:<id> desk:<id>`; `deleted` when the agent went), `access.confirm` (actor `system`; `hello` or `deskd`) and `access.tampered` (a row that didn't read back whole, once).
- **desk-agent's row** in `agent.db` (`agent_access`, `desk_grants`) carries a SHA-256 over the agent's id and the choice; a row whose hash doesn't match, or that doesn't parse, is nothing chosen (`setup: "confirm"`). That's an integrity check, not the boundary: deskd's record is.

**deskd's own record** (`agent/AccessRecord`; Security's question 5): for each `agent.access.set` desk-agent answers, deskd merges the member's params onto its own last copy and keeps only what desk-agent's answer also holds, so it never holds more than the member asked or desk-agent applied; a refusal records nothing; `agent.desks.revoke` and `agent.delete` only take away. It's `/data/desk/agent-access.json`, deskd's own file (0600, written whole), with an HMAC-SHA256 under `/data/desk/agent-access.key` (32 random bytes, 0600, made once). A file that doesn't verify (a hand edit, another key, a torn write, a link) is set aside as `agent-access.json.bad` and nothing is recorded: every agent gets `setup` until the member saves its screen again. A write that fails (a full `/data`, say) never leaves the last file to be read back, since it could hold more than the member now allows: it's set aside as `agent-access.json.unsaved`, so a restart before the next good write records nothing, and every agent waits for its setup. `agent.delete` and a guild member's purge forget the agent; a Files switch's folder is kept as desk-agent keeps it, with no slash at either end.
- **The tools deskd runs** (Files, Browser, Notebook) check it before anything else, a `look` included: an agent with no record is `forbidden` `{reason: "setup"}`, and an app it has off `forbidden` `{reason: "scope"}`, whatever approval or context desk-agent sends. On `setup`, desk-agent has the agent wait for the member to confirm its screen (`setup: "confirm"`).
- **The hello** (`desk.tools.hello`) adds `access: {recorded: [agentId, …]}`: desk-agent has any agent it holds as set up that isn't listed wait for the member to confirm. A hello with no `access` (an older deskd, which checks none) changes nothing.
- **Releases:** deskd before (or with) desk-agent. A desk-agent with the gate under a deskd without these methods would leave every agent waiting for a screen that can't be saved (`not_found`).

### Messages between the member's desks (W6)

**Built on `sub/mm-desk-messages`** (draft ADR §14; `docs/sub-status/mm-desk-messages.md`). An agent on one of the member's desks messages an agent on another of their desks, one hop, carried by the member's own office (ma-platform `docs/maia.md` §9, the switchboard): desks never connect to each other, and nothing goes through the Platform. **Off by default:** an agent with no active grant has no `desk_message` tool. **Never on a Guild Desk** (as sender, target or carrier: every method below is `forbidden` `{reason: "guild"}` there) **and never across members** (each desk checks that an envelope names its own owner's account and is signed by the key it pinned for that grant).

**The grant's two halves.** The send half (desk A, agent X) is made by the member's `agent.access.set` (`desks[{deskId, deskName, on: true}]`, as built): `offered`, with an `offer` envelope queued for desk B. B's member sees the offer (`agent.desks.list`, and `deskOffers` on `agent.state`) and allows it with `agent.desks.answer`, choosing the agent that answers (Y): B's answer half is `active` and an `accept` envelope goes back. When A receives it, A's send half is `active` and X has `desk_message`. Either desk's Stop (`agent.desks.revoke`) revokes its own half at once, and a `revoke` envelope tells the other. Deleting an agent revokes its halves.

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.desks.list` | No | `{}` | `{offers, answers}`: `offers` are other desks' offers waiting here (`state` `offered`, or `declined` after Not now), `answers` this desk's answer halves (`active`). Each `{grantId, fromDeskId, fromAgentId, fromAgentName, agentId, state, createdAt, lastUsedAt, count}`, `agentId` the answering agent (null for an offer) |
| `agent.desks.answer` | Yes, input | `{grantId, allow, agentId?}`: `agentId` (the agent that answers, required with `allow: true`; not a guild member's) | `{half}`, the offer or answer half after. `allow: false` ("Not now") leaves it `declined`, still listed, and sends nothing |
| `agent.desks.revoke` | Yes, input | `{grantId}`: a send half or an answer half | `{agentId, access}`, as before: the half's agent (an answer half's answering agent) and its access after |
| `agent.desks.take` | No | `{toDeskId, limit?}`, `limit` 1 to 100 (50) | `{envelopes: [{id, toDeskId, envelope}], more}`: what waits for that desk, oldest first. `envelope` is opaque: carry it as it is |
| `agent.desks.deliver` | Yes, input | `{envelope}` | `{id, outcome}`, `outcome` `delivered` or `duplicate` (already delivered: nothing done again) |
| `agent.desks.done` | Yes | `{results: [{id, outcome, reason?}]}`, `outcome` `delivered`, `duplicate` or `refused` (with the refusal's `reason`), at most 100 | `{done, revoked}`: how many it marked, and the grants the other desk refused as `revoked`, whose half here is revoked too |

**Topic `agent.desks.outbox`** (SUB, no params, owner tokens only): every event is `{"type": "snapshot", "data": {"pending": [{toDeskId, count, oldestAt}]}}`, the whole list on each change, never content. **`agent.state`** adds `deskOffers` beside `agents` (the owner's view only): how many offers wait here, so the app knows when to read `agent.desks.list`. **`agent.access.get`**'s `incoming` is now the answer halves this agent answers and every offer waiting here (`agentId` null), and an active send half adds `toAgentName`, the other desk's answering agent as its accept named it (plain text only).

**The carrier (the office, `web/src`).** For each ordered pair of the member's desks X → Y, neither a Guild Desk, while both links are `open`: when X's `agent.desks.outbox` lists Y, take from X (`toDeskId: Y`), deliver each envelope to Y in the order taken, waiting for each answer before the next, then `done` on X with every outcome. Then take again while `more` or the topic still lists Y. One loop at a time per ordered pair. A refusal (`bad_request`, `forbidden`, `conflict` or `too_large` with a `reason`) is outcome `refused` with that reason; anything else (`unavailable`, `rate_limited`, a timeout, a link that closed) stops the pair where it is, without `done` for that envelope, and it starts again from a fresh take once the link is back (back off 1 s, doubling to 30 s; at once when a link opens). It reads nothing: an envelope is opaque. It never wakes a stopped desk. Every mutation has its own `idem`. Retrying is always safe: a desk drops an envelope it has by id (`duplicate`), and refuses one older than the last it took from that grant (`stale`), so order holds per pair whatever the office does.

**Refusals of `agent.desks.deliver`** (final: report them in `done`): `bad_request` `{reason: "envelope"}` (not one); `too_large` (over 64 KiB); `forbidden` with `reason` `not_for_me` (another desk's), `account` (another member's), `cannot_open`, `bad_signature` (not signed by the key pinned for the grant), `no_grant` (no such half here), `revoked` (this desk's half is revoked), `rate` (past 20 a grant a day), `guild`; `conflict` with `reason` `stale` (older than the last taken from that grant) or `expired` (sent more than 7 days ago: refused, never delivered late).

**The envelope** (the chat spike's, `spikes/chat/README.md` §1): `{v: 1, id, from, to, enc, ct}`, where `ct` is HPKE (RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305) to the receiving desk's X25519 key, `info` `ma-desk-msg/v1`, `aad` `"ma-desk-msg/v1 env\n" + id + "\n" + from + "\n" + to`, of `{p, s}`: `p` the payload as a JSON string, `s` the sending desk's Ed25519 signature of `"ma-desk-msg/v1 sig\n" + p`. The payload is `{v: 1, kind, id, grantId, from, to, account, sentAt, seq, …}`, `kind` one of `offer`, `accept`, `msg`, `answer`, `revoke`. An `offer` (and a `revoke` of a half the other desk never accepted) can't be sealed, as the sender has no key of the other desk yet: it is `{v: 1, id, from, to, p, s}`, signed only, with the sender's public keys in `p.keys` (`{sig, box, binding}`, the box key signed by the signing key). deskd makes and keeps the desk's keys (`/data/desk/desk-keys.json`, 0600) and signs and seals every envelope; desk-agent keeps the outbox and never sees a private key.

**The office's trust at pairing** (Security's ATA-I2). The keys are exchanged in `offer` and `accept`, which the office carries, and each desk pins the first key it sees for a grant. So against the office itself, which holds sessions with input on both desks, the signature and the seal protect only against bugs: an office that swapped keys at pairing could read and forge that grant's messages. Against the sealed relay that can carry the same bytes later (ADR 0017), and against anything that sees only the envelopes, they hold. B's offer card names desk A from the member's own desk list by id (`GET /v1/desks`), never from anything in the envelope.

**`desk_message {desk, text}`** (desk-agent's registry and deskd's `HostedDecls`, area `desks`): `desk` a desk's name or id among the agent's active grants, `text` 1 to 8,000 characters. `own` from a run holding no `S`, `send` from one holding `S` (deskd's own class from its own ledger, and a `send` runs only on a relayed approval it redeems). Refused before asking: `no_grant` (no active grant for that desk; deskd's record decides), `rate` (20 a grant a day), `input`. Its card: "Send this to {Y} on your {desk} desk? It may include things {X} read on this desk.", with the exact text; `payload` `{desk: deskId, text}`, `target` `{kind: "desk", deskId, deskName, agentName}`. The answer, if it comes within 120 s (both desks up and the office open), is the tool's result, untrusted; the run meanwhile is `working` with `statusDetail: "waiting_desk"`, which doesn't keep the desk awake. Otherwise the result is "Sent. It reaches {desk} when your office is open and {desk} is running, and the answer will come to this thread."

**On desk B** a `msg` starts one run of the answering agent Y, origin `{kind: "desk", deskId, agentId, agentName, grantId, envelopeId}`: `U` from the start, only this grant's messages and Y's replies to them, no memory lines, no shared workspaces, no `desk_message` and no `message_agent` (one hop), unattended (3 of the 4 run slots, 24-hour cards, no `spend`, no signed-in session). It has To-do's tools as any of the desk's runs does (§22, since the To-do store's merge; Security's DM-I6): a read holds `S`, so its answer then asks as `send`, and an add is marked untrusted, with the message as its `desk` source. Y's reply is the answer, 8,000 characters at most: it goes back without a card when the run holds no `S`, and otherwise asks on B as `send` (`desk_answer`, `payload` `{grantId, replyTo, text}`): "Send this answer to {X} on your {A} desk? It includes things {Y} read here.", with the exact text. A run that can't start, fails or is stopped sends back a failure in place of an answer.

**In the threads.** A message's `origin` `{kind: "desk", deskId, agentId, agentName, grantId, envelopeId, replyTo?, role, private?, notice?, reason?}`:
- `role: "message"`: on B, in Y's thread, the message from X ("From {X} on your {A} desk").
- `role: "answer"`: on A, in X's thread, an answer that came after the 120 s wait ("From {Y} on your {B} desk"), untrusted, `private: true` when Y's run held `S`. It starts no run: X reads it in its next one, which then holds `U` (and `S` with `private`).
- `role: "notice"`, `notice` one of `not_delivered` ("Not delivered: your {desk} desk wasn't reachable for 7 days."), `refused` (B refused it: `reason`), `failed` (Y couldn't answer: `reason`), in X's thread on A.

Name `{desk}` from the member's desk list by `deskId`; `agentName` is the other desk's text: plain text only, hidden and bidi characters removed.

**Audit** (each desk's own log, ids only): `desks.offer`, `desks.accept`, `desks.decline`, `desks.revoke` (`peer` when the other desk's revoke or refusal took it), `desks.sent` (`grant:<id> env:<id>`, once per envelope: a `desk_message` asked again by its key after a restart gets the same envelope back, which isn't audited or counted against the grant again; `sub/mm-fix-bundle-2`), `desks.delivered` (with the kind), `desks.refused` (with the reason), `desks.answered` (`ok`, or the failure word sent back), `desks.expired`.

**Between deskd and desk-agent** (`services/desk-agent/docs/proposals.md` §5; no client can send these: deskd's relay lists only its own methods, and desk-agent refuses both from any frame carrying a caller): `desk.desks.queue {envelopes: [{id, grantId, toDeskId, kind, seq, envelope}]}` → `{ids}`, the envelopes deskd made from the member's choices (offers, accepts, revokes), sent on every connection until desk-agent has them (kept in deskd's record meanwhile); and `desk.desks.deliver {opened}` → `{id, outcome, taken?}`, deskd's own view of an envelope it opened and checked, the only form in which one reaches desk-agent (`taken: true` when an answer went to the `desk_message` call still waiting for it). `desk_message` and `desk_answer` are `tcall`s like any of deskd's tools, kept by their key (`retry_by_key`): their result's `content` is the sealed envelope, which desk-agent puts in its outbox. A failure sent back in place of an answer is a `desk_answer` with `{grantId, replyTo, failed}` (a word: `stopped`, `interrupted`, `declined`, `setup`, `no_key`, `limit_reached`, `revoked`, …) under a run id of its own. `desk_answer` runs only as a run's own closing call, under an id desk-agent made for it, never as a model's call (`scope`; Security's DM-I1).

**To-do's source kind `desk`** (§22): a message from another of the member's desks is a run's source only by deskd's own record (`desks/DeskSources`, in memory, 7 days). On the answering desk, every `tcall` of a run another desk's message started carries `origin: {kind: "desk", envelopeId}`; deskd gives that run the message if it opened it here for that agent, the agent the member chose to answer, and no other run has it (the first run to name it). On the asking desk, an answer `desk.desks.deliver` says was `taken` is given to the run whose `desk_message` made the message it answers, by deskd's record of that call, and only within 150 s of that call (the 120 s wait and a margin; Security's DM-I5). The ref is `{deskId, messageId}` (the envelope's id), the label "Message from {name} on another of your desks" or "Answer from {name} on another of your desks" from the signed envelope, the thread key `desk:<deskId>`. **Desk Maia's reports** (Maia Mode Phase 2, `sub/mm-away-fixes`): an answer to her brief that came after her wait (a report put in her thread, while the member was away or not) is given to a later run of hers. deskd keeps each answer it opens (with words, not a failure word) under the agent of this desk's half of its grant; every `tcall` of her runs carries `origin: {kind: "maia", answers: [envelopeId, …]}`, the answers in her newest 200 thread rows, oldest first (desk-agent's `MaiaProfile.origin`); deskd gives each one it opened for `maia`, within 7 days, at most the newest 32, in that order (so `desk {}` names the newest), and adds `U` (and `S` for a private answer) to its own copy of the run's taint, whatever desk-agent sends, so the item is marked untrusted. Only her runs: another agent naming one, or a forged or unknown id, is given nothing. A deskd restart forgets the record: her `todo_add` from an answer delivered before it is then refused `source_unknown`, never allowed. The label's name is the other desk's, shown as one plain line (control, format, bidi and private-use characters dropped; Security's DMA2-L2). The model never sees an envelope's id, so `todo_add`'s `source: {kind: "desk", ref: {}}` names the last one deskd gave the run. `desk` is untrusted content, as `courier` and `browser` are: an add from a run holding `U` with it needs no card (ATA-L1).

**Restarts.** deskd's keys, its record and the `seq` it last sent on each half are on `/data/desk`, so a deskd restart sends nothing twice. desk-agent's outbox and inbox are in `agent.db`, each change one transaction. A desk-agent restart while Y is answering ends that message with the failure `interrupted` (never a second run), and a `desk_message` waiting for its answer ends with the run, as any run does today; the answer that comes later goes to the thread. Durable runs will keep the wait (`DeskWaits`, kind `desk`).

**Releases:** deskd with or before desk-agent, and the office after both: an older deskd answers these methods `not_found`, and the office then carries nothing.

### Done without asking (auto-approve)

**Built on `sub/mm-auto-approve`** (draft ADR §15, the work breakdown's W3; `docs/sub-status/mm-auto-approve.md`). An agent whose member switched on one of its "without asking" switches (`auto` in its access, above) makes that group's additions with no card. **Asking stays the default:** every switch is off until the member turns it on for that agent, at setup, in its settings or with a card's "Don't ask again". Each call is checked twice, by desk-agent's gate and again by deskd from its own records, and each one is in `agent.approvals.list` with an Undo.

| Group (switch) | Done without asking | Its place, checked when it runs | Undo (`agent.approval.undo`) |
|---|---|---|---|
| `notebook` ("Add pages and notes in the Notebook tab {tab}") | `notebook_write` with `op: "create"` and `new.tabId` the switch's tab, or `op: "append"` to a page in that tab | The tab by id: a page's tab as desk-notebook holds it at the moment it writes, inside the page's queue, so a page moved out since the look is outside; a renamed tab is the same tab, and a new tab with the same title isn't. Never a page in the Trash | An append's blocks come out while they're as the agent left them; a created page goes to the Trash while it's as made. Otherwise `conflict` `{reason: "changed", versionId}`: the `pre_agent` version to offer from History |
| `files` ("Save new files in the folder {folder}") | `files_write` with `replace: false`, and `files_mkdir`, inside that folder | The folder by Files' own path rules, part by part (`Research2/x` and `research/x` aren't inside `Research`), at least one part below it, no link followed at any depth, as the write happens | The file to Files' trash while its SHA-256 is still what the agent wrote; a folder while it's still an empty folder. Otherwise `conflict` `{reason: "changed"}`, and it stays |
| `todos` ("Add to-dos, and tick off ones it added") | The To-do tools, by their own rules (§22, W4) | None | §22 |

- **The class, exactly** (both sides): the switch is on in deskd's own record, with its app; the call's class after deskd's look is still exactly `write` in the agent's own context; it only adds (never `replace_text`, a replace, a move, a trash or a rename); at most 8,000 characters of Markdown, a new page's title included, or 65,536 of file text; the run holds no `U` (the To-do tools' own exception is §22's); not on a Guild Desk; not a payload the member declined in this run (`declined_before` first); and the counts below. Anything else asks on a card, as before.
- **Counts:** 20 a run and 100 an agent a day. desk-agent's day ends at the member's midnight (ADR 0043's zone); deskd counts again by the account's zone (or UTC), reserved before each call runs, so concurrent calls can't pass them. Past either, the next call asks as usual.
- **On the agent socket:** the `tcall` carries `auto: <group>` and `autoApprovalId` (`ap-` and 20 lowercase base32 characters, the call's own approval id from desk-agent's gate) in place of `approval`. deskd runs it only if its own record, class, place, taint copy and counts all allow it, and each id once. Its refusals: `forbidden` `{reason: "approval_unknown"}` (no record, switch, place, class or count), `{reason: "approval_used"}` (an id it has run), `bad_request` `{detail: "autoApprovalId"}`. desk-agent then asks a card for the same payload if the model tries again in that run. The Notebook keys an unasked edit `auto:<id>`, a space a member's approval can't use, and a repeated key is `approval_used`.
- **deskd's ledger of unasked calls** (`tools/AutoLedger`, `/data/desk/agent-auto.jsonl`, deskd's own, 0600, one JSON line per call: the approval id, agent, run, tool, group, the arguments' SHA-256, the outcome and what it made, a file's path and SHA-256 or the Notebook edit's key; and a line per undo; 30 days kept, read back at start): the counts, the ids run, and what an Undo takes back. Never content beyond a path.

**The approval row** of a call done without asking is an approval like any other in `agent.approvals.list`, `agent.approval.get` and the `approval` event, with these differences:

```json
{ "id": "ap-…", "tool": "files_write", "risk": "write", "title": "Save “Research/notes.md” in your Files",
  "target": { "kind": "file", "path": "Research/notes.md" }, "payload": { "path": "Research/notes.md", "text": "…", "replace": false },
  "before": null, "sha256": "…", "untrusted": false, "state": "done", "detail": null,
  "createdAt": 1762850000000, "expiresAt": 1762850000000, "decidedAt": 1762850000000, "decidedBy": "auto",
  "auto": { "group": "files", "folder": "Research" }, "undoneAt": null, "undoneBy": null, "result": { "ok": true } }
```

| Field | Meaning |
|---|---|
| `decidedBy` | `auto`: nobody was asked. Never show Approve or Decline for it |
| `auto` | `{group, tabId?, folder?}`: the switch it ran under and its place then |
| `state` | `approved` while it runs, then `done` or `failed` (`result.error` says why: `approval_unknown` when deskd's own check refused it, so nothing was done). `interrupted` and `expired` as for a card, at a restart. The app shows an `interrupted` one as "May have been done without asking", with Undo, not counted as done: deskd may have finished it, and its undo answers `not_done` if it didn't |
| `undoneAt`, `undoneBy` | When the member undid it, and who (`owner` or the guild member's id); `null` before |

- **A reply** lists these in its `approvals` too, each with `decidedBy: "auto"` (its place and payload for the app's line and Undo: never render one as a card), and gains `auto: [{approvalId, tool, target, group, state, undoneAt}]`, its run's calls done without asking in their order (absent for none). The thread shows one line under the reply: "Did 3 things without asking: 2 notes and a file in Research · Undo all · See them". Count only `state: "done"` not undone.
- **An agent** in `agent.state` and `agent.get` gains `autoUnseen`: how many calls done without asking in runs the member didn't start (a timer's, another agent's) are done, not undone and not yet seen. `agent.seen` clears it. Its tile adds it to `unseen`.
- **A page's target** from deskd's look of an append carries the page's `tabId`, for the card's "Don't ask again" and desk-agent's place check.
- **Its chip** has `auto: <group>` and `approval: {id, decision: "auto"}`, and says "Done without asking · Undo".
- **The model reads** "Done without asking, under the member's setting for this agent." before the result, so its reply says what it did.
- **Audit (desk-agent's log):** `tool.call` with `auto:<group>`, `approval.auto` with the call's approval id and the payload's hash, and `approval.undo` for each undo (decision `ok` or `refused:<word>`). Ids and hashes only.

| Method | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `agent.approval.undo` (mutation, `idem`) | yes, with a token that has input | `forbidden` `{reason: "scope"}` | their own agent's only (never on a Guild Desk today: nothing runs unasked there) |

| Method | Params | Result |
|---|---|---|
| `agent.approval.undo` | `{approvalId}` | `{approval}`, with `undoneAt` set |

- **deskd does the undo itself,** from its own ledger: the agent and what the call made, never desk-agent's word; it checks the caller may decide for that agent, takes it back through the same tool host (Files' trash, desk-notebook's undo of the edit by its key, checking the edit is that agent's), then relays the outcome to desk-agent, which stamps the row, audits it and sends the `approval` event. **Undo all** is one call per row, the newest first. Nothing is deleted for good: a file goes to Files' trash and a page to the Notebook's Trash.

| Error | `details` | Meaning |
|---|---|---|
| `not_found` | `{detail: "approval"}` | No call done without asking with this id for an agent the caller may decide for, or older than 30 days |
| `conflict` | `{reason: "undone"}` | Already undone |
| `conflict` | `{reason: "not_done"}` | It didn't run, or failed: nothing to undo |
| `conflict` | `{reason: "changed", versionId?}` | Changed since (the member edited the blocks or the file, or the page or file moved): nothing taken back. For a Notebook edit, `versionId` is the page from before it |
| `conflict` | `{reason: "trashed"}` | The page is in the Trash already |
| `conflict` | `{reason: "newer"}` | A later agent edit of the same page stands: that one is undone first (desk-notebook undoes a page's agent edits newest first). Nothing taken back; it can be undone after |
| `conflict` | `{reason: "unknown"}` | deskd stopped while the call ran, so its ledger has no end for it: it may have happened, and deskd doesn't know what it made, so it can't take it back. The app says so, never "it didn't happen" |
| `forbidden` | `{reason: "permission"}`, `{reason: "scope"}`, `{reason: "age_band"}` | As for a decision |
| `unavailable` | `{reason: …}` | desk-agent, Files or desk-notebook isn't there: nothing changed |

**"Don't ask again" on a card** (the agent-tools spec's §1.4): offered only on a pending card whose call is in the class above (a `notebook_write` create or append, a `files_write` that doesn't replace, a `files_mkdir`), whose run doesn't hold `U` (`untrusted: false`), whose agent has that switch off, and whose app is on. Its button names the place in words, "Save new files in {folder} without asking" (the file's folder) or "Add pages and notes in {tab} without asking" (the tab's name, with its notebook's, "Work › Inbox" as Notebook's Search names a tab, when another tab has the same title; the setup screen's tab list and the line under a reply name it the same way). It sends `agent.access.set {agentId, auto: {files: {folder}}}` (or `{notebook: {tabId}}`) from the member's own session, then approves this card with `agent.approval.decide` as usual. It never rides on `agent.approval.decide`.

### Events and new fields

- **`agent.conversation:<agentId>`** gets a new event type, `approval`, with `{approval}`: adds or replaces one by `id`, when it's asked and on every change. The `snapshot` and `agent.thread.get` carry `approvals`: every approval of the messages in that page, `payload` left out over 32 KiB as above, beside each reply's own list (below). **Built Nov 14 (`sub/mm-release-fixes`):** desk-agent before it sent only each reply's own, so the Agent app never drew a waiting card after a reload or a restart; the app now reads both, by id, the page's copy first, so it draws with any desk-agent. A page counts the two copies; the newest reply alone too big sends both without payloads (`payloadOmitted`). deskd's snapshot fit (`EventFit`, 64 KiB) keeps the approvals of the messages it keeps and drops the rest, and for the newest message alone leaves out payloads first.
- **A reply message** gains:
  - `state: "awaiting_approval"` between `streaming` and its end, with `pendingApprovals`, the ids it waits on (absent otherwise);
  - `untrusted: true` when its run read untrusted content (show the "untrusted content in context" chip). A later run whose context holds that reply starts untrusted, and holding the member's private data likewise, and a thread summary that folds it is marked;
  - `egressCount`: how many `egress` calls its run made, approved and run (absent for none), live while it runs;
  - `plan`: `[{text, state}]` from the agent's checklist, `state` `todo`, `doing`, `done` or `skipped`, or absent.
- **Tool chips** (`tools`, today `{name, summary, ok, path?, reason?}`) gain:
  - `risk`;
  - `approval`: `{id, decision}` when the call asked, `decision` being `approved`, `declined`, `expired` or `interrupted` (absent for a call that didn't ask);
  - `target`, as the approval's;
  - `untrusted: true` on a call whose result was untrusted content;
  - `session`: `agent` or `member`, on Browser calls;
  - `auto`: the switch's group on a call done without asking ("Done without asking" above), with `approval: {id, decision: "auto"}`, its own approval id, for its Undo.

  `summary` stays a few words the desk writes, never content.
- **`agent.state`:** each agent gains `approvalsPending` (a count, 0 when none) and, while its run waits, `status: "working"` with `statusDetail: "awaiting_approval"`.

### Changes to existing methods
- **`agent.message.send`** to an agent whose run is waiting: `conflict` `{reason: "awaiting_approval"}`. Answer or stop first.
- **`agent.run.stop`** on a waiting run ends it `stopped`, and its pending approvals `expired` with `detail: "stopped"`.
- **A desk-agent restart** ends a waiting run as any run (`failed`, `unavailable`, `errorDetail: "interrupted"`); its approvals become `expired` with `detail: "restart"`, or `interrupted` if the tool was running. Nothing resumes.

## 19. Apps

deskd's half of the desk app contract (`docs/decisions/draft-desk-app-contract.md`, with its Desk Engineer review of 2026-11-11, which this follows where they differ; launch row S-97). Signed packages installed under `/data/apps` with rollback, the catalog the Desk app reads, and `appApi` relayed from the Desk app to each app's own socket. **On, with a kill switch, and inert until an app is installed.** No image has the parts a catalog app needs yet (the System Engineer's helper `desk-apps`, `/data/apps`, a review key), so on every desk today every catalog install is refused before it touches anything. **The first-party apps bundled in deskd's own image (below, "Bundled apps"; today the Bible) need none of them**: where deskd bundles one, `apps.list` says `available: true` and it installs and runs.

### Who may call

| Method or topic | `owner` | `export` | `guild_member` (a guild desk only) |
|---|---|---|---|
| `apps.list`, `apps.catalog.get`, `apps.view.get`, `apps.start`, `apps.call`, `apps.mutate`, topics `apps` and `app:<id>:<topic>` | yes | `forbidden` | yes |
| `apps.install`, `apps.remove`, `apps.stop` | yes | `forbidden` | the Founder (`role: lead`) only; anyone else `forbidden` with `{reason: "grant"}` |

`forbidden` for a scope carries `{reason: "scope"}`. An app's own rules (who may delete what) are the app's, by the caller deskd sends it (below), as desk-notebook's are.

### Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `apps.list` | No | None | `{available, reason, appApi, apps: [App]}` |
| `apps.catalog.get` | No | None | `{available, reason, catalog: {seq, issuedAt, apps: [{id, name, publisher, description, installed, bundled?, versions: [{version, packageSha256, bytes, appApi, permissions, net, resources, notes, installable, reason, bundled?}]}]} or null}` |
| `apps.install` | Yes | `{id, version, packageSha256, grants}` | `{id, version, state}` |
| `apps.remove` | Yes | `{id, deleteData?}` (default `false`) | `{}` |
| `apps.start` | No | `{id}` | `{id, state, problem}` |
| `apps.stop` | No | `{id}` | `{id, state, problem}` |
| `apps.view.get` | No | `{id}` | `{id, version, manifest, signatures, bundled, files: {path: text}}` |
| `apps.call` | No | `{id, m, p?}` | the app's result |
| `apps.mutate` | Yes | `{id, m, p?}` | the app's result |

**App** is `{id, name, version, previous, bundled, publisher, description, appApi, start, resources: {memoryMaxMiB, cpuMax, tasksMax, diskMaxMiB}, permissions, net, views: {window: {width, height, minWidth, minHeight} or null, widget}, methods: [{name, mutation}], topics, tier, grants, state, problem, summary, installedAt, updatedAt}`. `bundled` is true for an app from deskd's image (below).
- `state`: `stopped`, `starting`, `running`, `failed` (stays stopped until the member starts it) or `disabled` (revoked by the catalog).
- `problem`, for the tile's words (contract §2.6): `no_hello` ("Couldn't start"), `crashed`, `memory` ("Stopped: used too much memory"), `needs_update`, `host`, `revoked`, or null.
- `summary` is the widget's last `app.summary`, kept on the volume so it shows while the app isn't running: `{badge, problem, rows: [{text, detail, time}]}`, at most 6 rows of 120 characters, 8 KiB in all. The Desk app draws it with its own components; no app code runs on the canvas.

**`available: false`** comes with `reason`: `switched_off`, `no_storage` (no `/data/apps` that deskd can write), or `no_sandbox` (no helper), and only when this deskd bundles no app that can run either. `apps.list` still lists what's installed, and `apps.catalog.get` gives `catalog: null` and fetches nothing.

**`apps.catalog.get`** gives deskd's verified copy of the catalog: fetched from the Platform's public route when the one in memory is over 10 minutes old, its signature checked against the review keys in the image, and refused if its `seq` is below the newest this desk has taken. Only this desk's arch is listed. `installable: false` comes with `reason`: `app_api` (this deskd doesn't speak the range), `not_supported` (a permission this deskd can't honour yet: today everything but `background`), or `revoked`. The Desk app never fetches or checks the catalog itself.

**`apps.install`** installs or upgrades. `packageSha256` must be the catalog's for that version, and `grants` exactly its `permissions` (the ones the install sheet showed), in any order. There's no step-up: the owner's or Founder's session and the tap are the consent. In order:
1. Refused before anything is touched: `unavailable` `{reason}` (`switched_off`, `no_storage`, `no_sandbox`, `catalog`), `conflict` `{reason: "busy"}` while another install or removal runs, `not_found` `{reason: "version"}`, `precondition_failed` `{reason}` (`catalog_changed`, `app_api`, `not_supported`, `revoked`, `downgrade`, `no_space`: less than 2 GiB left on `/data` for the Browser after it), `bad_request` `{reason: "grants"}`. The same version again is a no-op that answers as for an install.
2. Then deskd begins: the helper prepares the app's directories, uid (2000 to 2999, the app's for good while its data is kept) and quota; the package streams from the Platform into `releases/.staging-*`. Its manifest and both signatures are checked before a file is written, each file's hash as it's written, and the package's size and hash at the end. Any failure there is `precondition_failed` with `reason` `package`, `hash`, `size`, `signature`, `manifest`, `catalog`, `revoked` or `not_supported`, or `unavailable` `{reason: "download"}`, and nothing is left: for a first install the app's directories go too.
3. The release is renamed into place, the registry written, `current` and `previous` swapped. A running old version is stopped first.
4. A trial start: the app must answer HELLO within its `startTimeoutSec`. If it doesn't, everything goes back, the old version runs again if it ran, and the reply is `precondition_failed` `{reason: "no_hello" | "needs_update" | …, rolledBack: true}`: nothing was done. Until the HELLO the registry marks the entry `trial`, with the one it replaced, so a deskd that stops mid-trial rolls it back at its next start.

Only `current` and `previous` are kept. The reply's `state` is the app's after the trial start: `running` (it then stops after 10 idle minutes unless it's `background`).

**`apps.remove`** stops the app, deletes its releases and summary, and asks the helper for the rest. Its data stays unless `deleteData`, and with it its uid and its registry entry (`state: kept`, not listed), so a reinstall finds both. `deleteData: true` on a kept app deletes the data. `not_found` `{reason: "app"}` otherwise.

**`apps.start`** starts it if it isn't running, and is also how the member restarts a `failed` app. A call or a SUB to a stopped app starts it too, but not a `failed` one: those get `unavailable` with the problem as `reason`. **`apps.stop`** stops it now.

**`apps.view.get`** gives the window's three files as UTF-8 text, with the manifest and `ma-app.sig` exactly as signed, so the Desk app can check the review signature with MA's public keys and every file's SHA-256 before it builds the sandboxed frame (contract §3.2). `bundled` is false. A bundled app's is below. `not_found` `{reason: "view"}` for an app with no window.

**`apps.call` and `apps.mutate`** relay one of the app's declared methods: `apps.call` its reads, `apps.mutate` its mutations, never the other way round (`bad_request` `{reason: "mutation"}`). An undeclared one is `not_found` `{reason: "method"}`. `apps.mutate`'s `idem` is kept by deskd's store as for any mutation (§4), and is passed on to the app as `idem`, so the app can dedupe across a deskd restart too. Its point of no return is when the request is queued to the app. The app's `ERR` comes back with its code if it's one of `bad_request`, `forbidden`, `not_found`, `precondition_failed`, `conflict`, `too_large`, `rate_limited`, `unavailable`, `deadline_exceeded`, `cancelled`, its message cut to 200 characters and its `details` if under 8 KiB; any other code is `internal`. 32 calls to one app at once, then `rate_limited` `{limit: "appCalls"}`; 30 s to answer, then `deadline_exceeded`.

### What the app is told about the caller

Every relayed request carries `from`: `{kind: "view", session, caller}`, never the member's name, account, email or a guild member's id (the review's change to contract §5.3).
- `session`: `p-` and 22 characters, an HMAC of the desk session under a key that lives only in this deskd's memory and differs by app. Stable for a session while deskd runs; two apps can't link it.
- `caller`: `{kind: "owner"}` on a member's desk. On a guild desk `{kind: "guild_member", member, role, grants, teen}`, where `member` is a pseudonym (`p-…`) under the app's own key in the registry: stable for that app on this desk, unlinkable across apps.

A SUB to the app carries `from: {kind: "view", caller: {kind, member?}}`. Every relayed REQ carries `caller`, and so does each guild member's own SUB: a member's subscription is theirs alone (below), and deskd's subscription for it carries their pseudonym. So an app on a Guild Desk keeps each member's data, marks and settings apart by `caller.member`, and shows each only their own. deskd's own requests carry `from: {kind: "desk"}`, with no caller.

### Topics

**`apps`**: what `apps.list` returns, as a `snapshot`, then a `patch` carrying the whole object again on any change (install, state, summary), at most once a second. Replace on each.

**`app:<id>:<topic>`**: one of the app's declared topics, relayed. While anyone is subscribed deskd holds one subscription of its own on the app's socket and fans its events out; a first subscriber's `snapshot` is that subscription's first event, a later one's a one-off subscription taken and dropped. A SUB starts the app if it isn't running. Coalescible, so an app's `patch` carries values, never increments (§5). When the app crashes and is started again (it is, after 1 s, 5 s and 30 s, while anyone is subscribed), subscribers get its first event again as a `snapshot`. On a guild desk each member's subscription is their own, and deskd's on the app's socket carries their pseudonym. `app.summary` isn't subscribable: it's deskd's, served in `summary`. A topic the app doesn't declare, or an app that isn't installed, is `not_found`. A revoked app's subscriptions end with `error` `forbidden`.

### The app's side

The socket, frames, HELLO, limits and everything an app must do are the contract's (§1.5 and §5), and the sample app meets them (`spikes/app-contract-sample/`). In short: the app listens on `/run/ma-apps/<id>/app.sock`; deskd connects, checks `SO_PEERCRED` is the app's uid, and sends HELLO `{appApi: "1.0", deskApi, app: {id, version}, grants, limits: {memoryMaxBytes, cpuMax, diskMaxBytes, maxRequestBytes, maxEventBytes, requestsPerSecond}}`; the app answers HELLO `{appApi, app}` within `startTimeoutSec`, or CLOSE 4426 for another major. Frames are a `u32be` length, then the 12-byte header and payload of §2, never fragmented: REQ and RES up to 1 MiB, everything else 64 KiB. deskd PINGs every 30 s and ends the link after 3 missed. An app may ask deskd `desk.info.get` (`{appApi, deskApi, timeZone, guildDesk}`), 50 a second and 8 at once; `browser.open` and `files.*` answer `forbidden` (no app can hold those permissions yet), anything else `not_found`.

### Bundled apps

deskd's image carries first-party apps that deskd hosts itself until the System Engineer's helper exists. Today that's the Bible, `com.minimalistalliance.bible`, built from `apps/bible`. They install and run on every desk with no helper, no `/data/apps`, no Platform catalog and no review key. Otherwise they're apps like any other here: the same methods and topics, relay, `idem`, `from`, limits, crash and idle rules, and the same table of who may call.
- **On a Guild Desk** the Founder (`role: lead`) adds and removes them, and every member opens and uses them, as for any app. The app keeps each member's data apart by `from.caller.member` (below), and a member who leaves loses theirs ("Members leaving").
- **In the image:** `/app/bundled-apps/<id>/` holds exactly what a package unpacks to: `ma-app.json`, with every file's SHA-256, size and mode, and `files/`. It's root's and read-only, made by the image's build (`deskd/docker/bundle-app.go`, from the Dockerfile's `bundled` stage), which then runs deskd's own check below on it and fails for an app deskd wouldn't offer. The app finds its own files from its executable's path (`files/<run.exec>`), as under the helper's unit, since its working directory is its data.
- **Checked once at start:** deskd checks each one at start, on a thread of its own, so deskd's start and `/health` never wait:
  - the manifest strictly, as a first-party package's;
  - the bundled ceiling (64 MiB of memory, 0.25 CPU, 32 tasks, 1 GiB of disk), since it shares deskd's container;
  - only permissions deskd can honour;
  - the directory named for its id;
  - every file there with its size and hash, nothing else, and no link;
  - an id under `com.minimalistalliance.`;
  - the directory and everything in it root's, with no group or other write, so nothing deskd's own uid could have written passes, wherever `DESKD_APPS_BUNDLED` points.
  
  One that fails isn't offered, and the journal names the rule. `apps.*` waits for the check, which takes a moment after deskd starts.
- **`apps.list`** is `available: true` where this image bundles an app that passed, even where catalog apps can't run (`no_sandbox`, `no_storage`). Catalog installs are refused there as before.
- **`apps.catalog.get`** lists bundled apps first. Each has `bundled: true` and one version: `{version, packageSha256, bytes, appApi, permissions, net, resources, notes: null, installable: true, reason: null, bundled: true}`.
  - `packageSha256` is the SHA-256 of the app's `ma-app.json`, which names every file's hash. Send it back to `apps.install` as for any version.
  - The Platform's catalog follows. It's fetched only where catalog apps could be installed, and lists no id this deskd bundles.
  - Without a Platform catalog, `catalog` is `{seq: null, issuedAt: null, apps: [the bundled ones]}`.
- **`apps.install`** of a bundled version first applies step 1's refusals where they fit: `switched_off`, `busy`, `not_found` `{reason: "version"}`, `catalog_changed`, `grants`, `no_space`.
  - Nothing is downloaded. deskd makes `/data/desk/apps/<id>/data` and `cache` (`0700`, deskd's) and records the app in `/data/desk/apps/registry.json` (`bundled: true`, `uid: -1`, `tier: first-party`).
  - Then come the trial start and rollback of step 4. A failed trial removes the app's directory only if this install made it, so data a move brought stays.
- **Versions follow the image.** At each start an installed bundled app takes the image's version, with no `previous` and no downgrade check. Its grants stay, and a permission they don't hold isn't honoured. An installed app the image no longer bundles is left out of `apps.list`, and its record and data are kept for an image that has it again.
- **`apps.remove`** keeps the data unless `deleteData`. Re-adding finds it, with the same member-pseudonym key.
- **`apps.view.get`** serves the files from the image with `manifest` exactly as it is there, `signatures: null` and `bundled: true`. There is no review signature, because the files are deskd's own image's, which the desk already trusts as much as deskd itself. **The Desk app checks every file's SHA-256 against `manifest` and accepts a bundled app's view on those hashes alone.** A catalog app's view keeps `bundled: false` and its signatures, checked as before.
- **How it runs:** as deskd's own child, in deskd's container and as deskd's uid.
  - Its environment is exactly the contract's (§1.5): `MA_APP_DATA` and `MA_APP_CACHE` are the directories above, `MA_APP_MEMORY_MAX` (bytes) and `MA_APP_CPU_MAX` come from its manifest, `MA_DESKD_UID` is deskd's own uid, and `HOME` is its data. Nothing else.
  - Its working directory is its data, and stdin is `/dev/null`. Its output is dropped, as an app's log could name what the member reads.
  - Its socket is in `/tmp/ma-apps/<id>/` (`0700`, deskd's), in the container's own tmpfs. deskd checks that the peer is deskd's uid, and so does the app.
  - It runs under `nice -n 10`, with `oom_score_adj` 1000 (the app raises its own too).
  - It has no cgroup, quota or firewall rule of its own. Its own runtime holds it to its limits, and the container's limits are deskd's. A SIGKILL deskd didn't send reads as `memory`.
  - It stops with deskd, and never runs in the image's AppCDS training.
- **The export:** each bundled app's `data` and summary are in the `desk` part (`apps/<id>/…`). deskd leaves out `apps/registry.json`, each app's member-pseudonym key `apps/<id>/member.key`, and every `apps/<id>/cache`, whatever the helper says (§12).
  - On a Guild Desk, that `data` holds every current member's data under their pseudonyms, and none of a member who's left, once their app was told ("Members leaving").
  - This matches the members' Agent data (ADR 0080's addendum of 2026-11-10): the export's `agent` part keeps current members' conversations, and a departed member's are purged.
  - Guild members themselves can't call `data.*` (§15). Without the registry's keys, the export can't tie a pseudonym to a member.
- **The switch and health:** `/data/desk/apps-switch` governs bundled apps as it does any app. `GET /health`'s `apps` counts them in `installed`, `running` and `failed`, and adds `bundled`: how many this image offers, 0 until the check is done.
- **When the helper ships:** the contract's addendum, "deskd hosts first-party apps bundled in its image until the helper exists", says what moves.

### Members leaving (a Guild Desk)

A member who leaves the guild loses their data in every app, as they lose their agent conversations (ADR 0080 decision 12, and its addendum's guard). deskd sends each app a reserved call, an `appApi` 1.x addition (contract §5.3):

`REQ {m: "app.members.retain", p: {members: ["p-…", …]}, idem, from: {kind: "desk"}}`
- **`members`** is every current member's pseudonym for that app: the roster's members, and those whose purge is owed but still in its 10-minute grace. **The app deletes everything of any member not listed and answers `{removed}`**, how many members' data it deleted. Data under `caller: {kind: "owner"}` isn't a member's, and stays.
- **When:** on a Guild Desk only, after each HELLO, and whenever the roster or a purge changes, or an owed purge's grace ends. An app that isn't running hears at its next start; none is started to be told. Each send has a fresh `idem` (a UUIDv7), so a member set seen before is never answered from memory. One at a time per app.
- **Only on a roster the purges' guard trusts** (`guild/GuildRoster.appMembers`, the same code as the agent purge). Nothing is sent while:
  - no roster is known;
  - the guild is closed;
  - the roster lists no Founder, or has an entry whose id can't be read;
  - any member's purge is held, as when a roster drops more than half the members at once.
- **Answers:** `not_found` from an app that doesn't take the call is tolerated: the app runs on as before, and keeps what it has. Any other error, or none in 30 s, is tried again at the next change or start. The journal says only how many members were kept and removed, never who.
- **The members' key.** Pseudonyms come from each app's member key, kept in the registry and, so a lost registry changes no member's pseudonym, beside the app's data in `<app>/member.key` (`0600`, deskd's, outside the `data` and `cache` the app is told about). An install reads it first, then the registry's, and makes a new one only when neither exists. The key goes with the data, on a removal with `deleteData` or a first install rolled back.
- **Never a deletion on a key that could be wrong** (Security's S-150 Medium). A key made while the app already had data, which a move or a lost registry and key can leave, is marked so in the registry and the key file, and that app is never sent `app.members.retain`: every member's data would be under pseudonyms of a key deskd no longer has, and listing today's would delete it all. Nor is an app whose entry has no key, and the per-run session key is never used for it.
- **Never an empty list.** A guild always has its Founder, so a roster that leaves nobody sends nothing. deskd never sends `all`.
- **Only on a roster compared with an earlier one** (Security's L2): the first roster a desk reads, with none before it and none kept, isn't trusted to delete by. One kept from before a restart is.
- Bundled and catalog apps alike. Off a Guild Desk, nothing is sent.

### The helper deskd needs (the System Engineer's)

`/run/desk/apps.sock`, root, socket-activated, `0600` owner `desk`, one JSON line each way (`apps/HelperAppHost`): `prepare {id, uid, diskMaxBytes}`, `start {id, uid}`, `stop {id}`, `status {id}` (`{state, result}`, `result: "oom-kill"` for a kill at the memory limit), `remove {id, uid, deleteData}`; `{ok: true, …}` or `{ok: false, code, message}`. The contract's ADR (Desk Engineer review, "For the System Engineer") has what each verb must do.

### Health and the switch

`GET /health` adds `apps: {state: on|off|unavailable, reason, installed, running, failed, bundled, reviewKeys}`, counts only. **The kill switch** is `/data/desk/apps-switch`, read at most once a second: no file, on; `off`, everything `unavailable` `{reason: "switched_off"}` (`apps.list` and `apps.catalog.get` still answer, saying so), running apps stopped within 30 s, nothing fetched; `install-off`, no installs or upgrades while installed apps keep working. A file deskd can't read as a small plain file counts as `off`. Nothing in the journal names an app, a method, a member or a file.

| Variable | Meaning | Default |
|---|---|---|
| `DESKD_APPS_ROOT` | where apps are kept | `/data/apps` |
| `DESKD_APPS_SOCKET` | the helper's socket | `/run/desk/apps.sock` |
| `DESKD_APPS_RUN` | where each app's socket directory is | `/run/ma-apps` |
| `DESKD_APPS_KEYS` | the review keys' directories, comma-separated, files `<tier>.<name>.pem` | `/opt/ma/etc/app-keys,/etc/ma/app-keys.d` |
| `DESKD_APPS_BUNDLED` | where the image keeps its bundled apps | `/app/bundled-apps` |
| `DESKD_APPS_BUNDLED_RUN` | where each bundled app's socket directory is | `/tmp/ma-apps` |

## 20. What the heartbeat says of deskd itself (ADR 0078 section 6)

Not a client call: what the Platform hears, for a release switched in where no release `health` can run, as in a shared host's slot.
- **`deskd: {version, status}`** (DE-2) is in every heartbeat: `version` is this deskd's, the string hello's `runtimeVersion` and `GET /health`'s `version` carry, and `status` is `ok` or `failing`, exactly `GET /health`'s own answer on the admin socket (200 or 503). That answer is "serving, with its data directory writable", the release `health` script's test (`desk-runtime.md` §6). deskd's one database, Courier's store (§21), isn't part of it: a store that can't be opened makes `courier.*` answer `unavailable` and leaves health as it is, so it can't roll a release back. A `failing` one also makes `health.status` `failing`. It writes one small file a heartbeat, as `/health` does; the final heartbeat repeats the last answer rather than write during the shutdown. The Platform promotes a host's canary batch once its desk's heartbeat names the new `version` with `status: ok` (ADR 0078 section 3.3).
- **No batch offer and no `update`** (DE-1). deskd doesn't relay desk batches yet (`desk-runtime.md` §6.1's offer on `/run/desk/batch.sock`, and the heartbeat's `update`): a heartbeat reply's `batch` is ignored, nothing asks `GET /v1/agent/batch`, nothing is logged of it, and no heartbeat carries `update`. A shared host's desk has no `batch.sock` (the host takes its releases), and when the relay is built a desk without that socket keeps exactly this behaviour.

## 21. Courier

Courier's desk side (draft ADR [`draft-courier-store`](../../../docs/decisions/draft-courier-store.md)): the store in `/data/courier`, the one idempotent sink every transport hands messages to, and what the office reads and changes.
- **Mail is read by `desk-parse`'s Courier mode,** in ADR 0097's sandbox, over its socket (the draft ADR §4). An image without that sandbox leaves email `pending` until it answers.
- **Linked mailboxes' sign-ins are sealed on the desk** (§9).
- **The desk's own keys** (draft ADR `draft-courier-envelope`, the launch plan's Wave 1.4): an Ed25519 identity and an X25519 box key in `/data/keys`, published to the platform's key directory at start and after a change (ma-platform contract 0.4.0 §3.1), the box key rotated every 180 days. `courier.keys` shows them. The `ma` and mail-door transports (Wave 2.5) sign and open with them.
- **Linked mailboxes over IMAP and SMTP are wired** (the launch plan's Wave 2.1, `courier/linked`, below: "Linked mailboxes"): the first transport.
- **iMessage and iPhone texts through the member's own Mac are wired** (Wave 2.6, `courier/imsg`, below: "iMessage on the member's Mac"): one seam for every path to a Mac, BlueBubbles Server built, MA's Mac connector to come.
- **The desk's own address and messages between members' desks are wired** (Wave 2.5, `courier/relay`, below: "The desk's address and members' messages"): collected from Platform's relay, sealed, signed and pinned. Mail to the address needs Platform's mail door (CR-2.3) and sending from it `courier-send` (CR-2.4), both contract 0.4.1.
- **`courier.changed`** names ids and lanes only, never a sender, a subject or text.

### Who may call

| Method or topic | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `courier.*`, topic `courier.changed` | yes, on an adult's personal desk | `forbidden` `{reason: "scope"}` | `forbidden` `{reason: "scope"}` |

Checked in this order, for every call but `courier.status`:
- a guild desk: `forbidden` `{reason: "scope"}` (guild chat is Commons', §15);
- a teen's desk: `forbidden` `{reason: "teen"}` (ADR 0098 decision 7);
- the band not known yet: `unavailable` `{reason: "age_band"}`;
- no store (no `/data/courier` on this image, a schema from a newer release, SQLite's library not loaded): `unavailable` `{reason: "store"}`;
- the kill switch `/data/desk/courier-switch` saying `off`: `unavailable` `{reason: "switched_off"}`.

`courier.status` answers whatever the state (but `forbidden` on a guild desk), so the office can say why. A deskd before this section answers `not_found`: "this desk can't do Courier yet".

### Methods

Ids (`messageId`, `channelId`, `contactId`, `draftId`, `outboundId`) are 26-character ULIDs; anything else is `bad_request` `{reason: <param>}`. Lanes are `people`, `requests`, `updates`, `other`, `spam`, `trash`. Pages: `limit` 1 to 100 (default 50), and `before` is a page's `next`, opaque. Mutations need `idem`, as every mutation (§4).

| Method | Mutation | Params | Result |
|---|---|---|---|
| `courier.status` | No | None | `{state: on \| off \| unavailable, reason, lanes: {<lane>: {count, unread}}, drafts, waiting, failed, pending, filter, bytes, sending}`; the counts only when `on`. `filter` is the learning filter's `{state: learning \| on \| off, spam, wanted}` (below, "Spam and safety"). `count` is people (channels) in the lane, Done ones left out; `waiting` is sends not yet out, `pending` emails waiting for the parser, `bytes` the store's size as a cap counts it (the database, and each kept raw message at full size) |
| `courier.list` | No | `{lane, accountId?, before?, limit?, includeDone?}` | `{rows: [{channelId, kind, title, contacts: [{contactId, name, endpoint: {kind, value}, known}], lane, lastAt, count, unread, done, medium, last: {messageId, medium, direction, from, subject, snippet, at, read, accountId, warned}}], next}`, newest first. `warned` says the last message carries sender warnings (below), without saying what. `kind` is `direct`, `group` or `self`; a list's channel has its `title` |
| `courier.attention` | No | None | `{threads: [{channelId, kind: direct \| group, contactIds, known, confirmed, bulk, theyWroteLastAt, replyBand, unread, newestAt}]}`: the People lane's channels with something unread and not Done, newest first, at most 50, **structure only** for the focus shield (§23 "What reaches the member"): never a subject, a snippet, a name or an address; Requests, Spam, Trash and a note to self never. `contactIds`: up to 8 of the channel's people; `known`, `confirmed` (as `senderConfirmed`: DMARC pass for an email, never a text) and `bulk` describe the newest unread message; `theyWroteLastAt`: their first message after the member's last (when they wrote last), else null; `replyBand`: what the member sent there in 30 days (0 none, 1 one to 4, 2 five to 12, 3 more). The office reads it from each of the member's own open desks while Courier's switch is on, at most every 5 s on `courier.changed`, and passes it in `agent.maia.observe` (`desks[].courier`) |
| `courier.thread` | No | `{channelId, lane?, before?, limit?}` | `{channel, messages, next}`: the newest page first, each page oldest first. Without `lane`, everything but Spam and Trash. Each message is the shape below with its first 2,000 characters of `text` and `textMore` |
| `courier.message` | No | `{messageId, from?}` | The message whole: the shape below with `text` from `from` (characters), 150,000 a slice, `textFrom`, `textNext` (null at the end), and `recipients: [{role, endpoint, contactId, name}]` |
| `courier.message.html` | No | `{messageId, from?}` | `{messageId, html, from, next}`: the sandbox's sanitized HTML, a slice at a time. Show it only in a frame with no `allow-scripts` and no `allow-same-origin`, under its own CSP (the plan §3.1). `not_found` if it has none |
| `courier.search` | No | `{q, lane?, channelId?, before?, limit?, zone?}` | `{hits: [{messageId, channelId, lane, medium, direction, from, subject, snippet, matches: [[start, end]], at, read, accountId}], next}`, newest first; a hit deleted between pages skips nothing. `zone` is an IANA zone for `before:` and `after:` (default UTC). An empty `q` is `{hits: []}`; a bad operator is `bad_request` `{reason: date \| in \| has \| is \| too_long \| too_many_terms}` |
| `courier.contacts.list` | No | `{q?, after?, limit?}` | `{contacts: [{contactId, name, named, endpoints: [{kind, value, standing, lastInboundAt, lastInboundMedium}]}], next}` |
| `courier.contact.get` | No | `{contactId}` | One contact, as above |
| `courier.drafts.list` | No | None | `{drafts: [{draftId, channelId, medium, accountId, to, subject, text (first 200), version, updatedAt}]}` |
| `courier.draft.get` | No | `{draftId}` | One draft whole, with `replyTo` |
| `courier.outbound.list` | No | None | `{outbound: [{outboundId, messageId, channelId, state, notBefore, attempts, error, giveUpAt, medium, subject}]}` |
| `courier.accounts.list` | No | None | `{accounts: [{accountId, kind, label, address, state, sending, signedIn, sync}]}`; `kind` `desk`, `imap`, `jmap`, `ma` or `imessage`; `sending` is whether a transport can send through it now; `signedIn` (linked mailboxes and the Mac, null otherwise) is whether the desk has a sign-in it can use: sealed, opening, and not refused by the provider (or the Mac) since (`sync.state` `needs_you`); false means "Sign in again". `sync` (a linked mailbox's, null otherwise): `{state: connecting \| syncing \| live \| waiting \| needs_you \| off, reason, provider, checkedAt, nextTryAt, firstSync: {done, messages, oldestAt}, changesOwed}` (below, "Linked mailboxes"); the Mac's: `{state: connecting \| syncing \| live \| waiting \| away \| needs_you \| off, reason, path, mode, through, certificate, socket, checkedAt, nextTryAt, firstSync: {done, messages}, cards}` (below, "iMessage on the member's Mac") |
| `courier.accounts.check` | No | `{accountId}` | `{}`: "Check again": the Mac (or a linked mailbox) is looked at now. `not_found`; `bad_request` `{reason: accountId}` for another kind |
| `courier.accounts.providers` | No | None | `{providers: [{provider, label, imapHost, imapPort, smtpHost, smtpPort, security, signIn: app_password \| oauth, available, appPasswordUrl}]}`: what the setup screen offers (Gmail, iCloud Mail, Fastmail, Yahoo Mail, Outlook, any other mailbox). `available: false` (Outlook: Microsoft sign-in only) waits for Wave 2.2 |
| `courier.blocks.list` | No | None | `{blocks: [{kind: address \| domain, value}]}` |
| `courier.read.set` | Yes | `{messageIds}` or `{channelId, lane?}`, and `read` (default true) | `{changed}` |
| `courier.move` | Yes | `{messageIds}` or `{channelId, lane?}`, and `to`: a lane but `requests`, or `restore` (back from Spam or Trash to where it was) | `{moved}`. To People or Updates from Requests, Other or Spam lets the sender in. Into Spam teaches the learning filter spam; out of it (not to Trash) teaches it wanted. `restore` of what the filter put in Spam puts it where it would have been: Requests, or Other |
| `courier.done` | Yes | `{channelId, lane, done}` | `{}`; the row leaves the lane's list until a newer message comes. `not_found` if the channel has nothing there |
| `courier.request.decide` | Yes | `{channelId, decision: let_in \| not_now \| block}` | `{}`; `not_found` if the channel has no Request. `let_in` teaches the filter wanted, and brings back what the filter alone had put in Spam from them; `block` writes a block for each of the sender's addresses (in `courier.blocks.list`) and teaches the filter spam |
| `courier.block`, `courier.unblock` | Yes | `{kind: address \| domain, value}` | `{senders}` (how many known endpoints it caught) and `{}`; a domain covers its subdomains. Unblock ends exactly that block: the senders it covered that no other block covers are strangers again. With no such block it's `not_found` and nothing changes (Security CS-I2) |
| `courier.report` | Yes | `{messageIds, block?}` | `{reported}`: "Report spam". The messages go to Spam (a linked mailbox's to its provider's Junk too) and teach the filter; one that came to this desk's own address from a sender the door's DMARC confirmed owes the mail door a report of its sender for the platform's suppression list (an unconfirmed From is never reported: it could be anyone's). With `block`, each sender's address is blocked as well, except a known contact's address on mail DMARC didn't confirm (it only claimed to be them). The member's own mail and Trash are left out |
| `courier.attachment.save` | Yes | `{messageId, part, allowDanger?, zone?}` | `{path, folder, name, bytes, sha256, already, danger}`: "Save to Files", into `Courier/<date> <subject>/` (the message's day in `zone`, default UTC). Never replaces a file: the same bytes already there are `already: true`; other bytes under the name get `name (2).ext`. Below, "Attachments" |
| `courier.attachment.read` | No | `{messageId, part, allowDanger?}` | `{transferId, size, mtimeMs, sha256, name, type, danger}`, then the bytes on `bulk` as `files.read` sends a file (§16): "Download". `type` is `application/octet-stream` for a dangerous type, whatever the sender claimed: save the bytes as a file, never open them in a tab |
| `courier.attachment.image` | No | `{messageId, part}` | `{transferId, size, mtimeMs, sha256, format: png \| jpeg, width, height}`, then the image on `bulk`: a preview, drawn again from its pixels in the sandbox. Only for PNG, JPEG, GIF and BMP with no `danger`; anything else is `bad_request` `{reason: unsupported}` or `forbidden` `{reason: danger}` |
| `courier.attachment.archive` | No | `{messageId, part}` | `{format: zip \| tar, entries: [{name, bytes, dir, encrypted, danger}], total, truncated, danger}`: an archive's list, read in the sandbox without unpacking it, at most 500 entries, each name cleaned. `bad_request` `{reason: unsupported}` for what isn't a ZIP or tar it can read |
| `courier.message.raw` | No | `{messageId, zone?, allowDanger?}` | `{transferId, size, mtimeMs, sha256, name}`, then the message exactly as it came on `bulk`, as a `.eml` file: the raw download a refused message offers. One with a dangerous attachment or a virus verdict needs `allowDanger`, as the attachment would, and so does every message the sandbox refused to read (`forbidden` `{reason: danger, danger: unread}`: nothing is known of what it holds) |
| `courier.attachment.stop` | No | `{transferId}` | `{}`: ends one of this session's Courier transfers now (the member cancelled a Download or closed a preview), its staged bytes with it. An id that has ended, or isn't this session's, is fine and touches nothing |
| `courier.delete` | Yes | `{messageIds, forever?}` | `{deleted}`: to Trash, or with `forever` for good, only from Trash or Spam |
| `courier.trash.empty` | Yes | None | `{deleted}` |
| `courier.draft.save` | Yes | `{draftId?, channelId?, medium?, accountId?, to?, subject?, text, replyTo?, baseVersion?}` | `{draftId, version}`. With `baseVersion`, a save from a device that hasn't seen the latest is `conflict` `{reason: version}`. Save every 2 seconds while the member types |
| `courier.draft.discard` | Yes | `{draftId}` | `{}` |
| `courier.send` | Yes | `{draftId}` | `{messageId, outboundId, undoUntil}`: the message is in its channel at once, `queued`, and goes after 10 seconds. `unavailable` `{reason: medium}` when no transport can send on the draft's medium and account (until a provider is live, a desk address only receives), and `{reason: switched_off}` while sending is off; both before anything is done. `forbidden` `{reason: blocked}` to a blocked address |
| `courier.send.undo` | Yes | `{outboundId}` | `{draftId}`: back to the draft, while it hasn't started going (in the undo window, waiting to retry, or failed); `conflict` `{reason: too_late}` after |
| `courier.contact.rename` | Yes | `{contactId, name}` | `{}`; the member's name, which no display name replaces |
| `courier.contact.merge` | Yes | `{into, from}` | `{}`; one person: their endpoints, channel, messages and drafts |
| `courier.accounts.add` | Yes | `{kind: imap, address, auth: password \| app_password, secret, username?, label?, provider?, server?: {imapHost, imapPort, smtpHost, smtpPort, security: tls \| starttls}}` | `{accountId}`: a linked mailbox, **write-only**. The secret (1 to 8,192 bytes, no controls) goes once. The transport signs in to the provider's IMAP and SMTP with it (and lists the folders) before anything is kept; it's sealed on the desk (the draft ADR §9), and never sent back, logged or sent to the platform. `provider` (one of `courier.accounts.providers`) fills in `server` when it's left out. With neither, the address says which named provider it is: its domain (`gmail.com`, `me.com`, `fastmail.com`, `ymail.com`, `hotmail.com` and the like), or else where its mail goes, the domain's MX records all at one named provider (Google Workspace, iCloud, Fastmail, Yahoo or Microsoft hosting a domain of the member's own; the office sends servers only for "Other"); otherwise `bad_request` `{reason: server}`. `server`'s `security` follows the SMTP port, whatever was sent: 465 is TLS from the first byte, 587 STARTTLS. The label shown defaults to the provider's name (agents see it, never the address). At most 5 linked mailboxes. One mailbox (kind and address) is linked once: adding it again while it needs a sign-in (`signedIn` false) is "Sign in again", checked and sealed over its own, and answers its `accountId`; while it doesn't, `conflict` `{reason: exists}`. Errors: `unavailable` `{reason: medium}` while no transport can check this kind (JMAP, Wave 2.2), `{reason: oauth}` for a provider that takes only its own sign-in (Outlook, Wave 2.2), `{reason: provider}` when the provider can't be reached, `{reason: storage}` when it can't be kept, and `{reason: provider, cause: tls \| imap \| smtp}` when a server answered but not as one should (`tls`: no valid certificate for the host); `forbidden` `{reason: sign_in, cause, provider?}` when the provider refused the sign-in itself, `provider` the named provider's name for the sentence ("Gmail"; absent for any other mailbox) and `cause` one of `auth`, `app_password` (the provider wants an app password), `imap_off` (IMAP is off in the account's settings), `web_login`, `smtp_auth` (IMAP took it and SMTP didn't); `conflict` `{reason: too_many \| exists}`; `bad_request` `{reason: kind \| address \| auth \| secret \| username \| provider}`, and `{reason: server, cause?}` for servers the desk won't use, `cause` one of `host`, `port` (only 993 for IMAP, 465 and 587 for SMTP, as desk egress allows), `address` (the host resolves to an address a desk never connects to: loopback, link-local, private, the desk's own), `server` |
| `courier.accounts.signin` | Yes | `{accountId, secret, username?, server?}`; for the Mac `{accountId, secret, server?, acceptCertificate?}` | `{}`: "Sign in again" for a linked mailbox whose provider stopped taking its sign-in (a new app password). Checked with the provider as `add` is, then sealed over the old one; write-only, never sent back. `server` only when the sealed sign-in is gone and its servers with it. For the Mac, a new password, or a new address in `server` (a Cloudflare tunnel's changes when BlueBubbles restarts), checked as `add` is; the certificate pinned for the same address is kept, and one the Mac no longer shows is `forbidden` `{reason: certificate_changed, fingerprint}` before any password goes, until the member accepts it: the same call with `acceptCertificate` set to that `fingerprint`. Errors as `add`'s, and `not_found` |
| `courier.accounts.remove` | Yes | `{accountId, keepMail?}` | `{}`: a linked mailbox's (or the Mac's) row and its mail (unless `keepMail`), then its sealed sign-in. `not_found`; `bad_request` `{reason: accountId}` for an account that isn't a linked mailbox or the Mac. Revoking at the provider (or changing BlueBubbles' password) is the only real revocation: link to it |
| `courier.keys` | No | `{peer?}` | The desk's own Courier keys, public facts only (draft ADR [`draft-courier-envelope`](../../../docs/decisions/draft-courier-envelope.md)): `{available, identityKey, boxKey, fingerprint, identityCreatedAt, boxCreatedAt, boxRotatesAt, boxKeysKept, replacedAt, published: {current, keysVersion, at, problem}}`. Keys are base64url; `fingerprint` is the contract's (8 groups of 4 hex), what an invite link carries; `replacedAt` (epoch ms, or null) says a damaged identity was replaced, so contacts will see a key change. `published.current` is whether the platform's key directory holds these keys; `problem` is the last refusal's code while it doesn't. With `peer` (a contact's identity key, base64url), also `safetyNumber`: 60 digits in 12 groups, the same on both desks, unchanged by either desk's box key rotation. `unavailable` `{reason: keys}` with no `/data/keys` on this image or keys that couldn't be read or written; `bad_request` `{reason: peer}` |

**A message** is `{messageId, channelId, threadId, rfcMessageId, direction: in | out, medium: email | ma | imessage | sms, accountId, from: {contactId, name, endpoint: {kind, value}, known} | {me: true}, at, sentAt, receivedAt, subject, snippet, lane, read, bulk, senderKnown, authorKind, status: received | queued | sending | sent | failed, hasHtml, textTruncated, textLength, parse: null | {state: refused, reason}, auth: {spam, virus, spf, dkim, dmarc, dmarcDomain, senderConfirmed} | null, labels, rawBytes, attachmentCount, attachments: [{part, name, type, bytes, contentId, inline, danger}], screen: null | filter, warnings: [{kind, ...}]}`.
- `from` is the contact record of the message's sender endpoint, never a name in the message: show the address with the contact's name, and **never a display name alone**. `senderConfirmed` is true only when DMARC passed **for the From's own domain**; when it's false, **or when an email has no `auth` or no `dmarc`**, say "Couldn't confirm this came from {domain}" (the plan §3.5). The verdicts come only from the transport's own verifier, never a header the sender wrote: a linked mailbox's from the topmost `Authentication-Results` field alone, when it carries the provider's authserv-id; nothing below it is read or merged in, so a field the sender wrote can't fill a result the provider left out (none for a provider whose id isn't known yet, so its mail is unconfirmed). `dmarcDomain` is the domain the verifier checked; a pass for another domain than the From's is kept as `dmarc: unaligned` (Security CP-L2).
- `direction: out` and `{me: true}` are the member's own: what the transport says is theirs (a Sent folder, Courier's own echo), or an email from one of their addresses whose DMARC passed. Mail that only claims the member's address in its From is a stranger's, with that address as its sender (Security CS-M1, Nov 13).
- Every string a transport or the sandbox hands over loses controls, format characters (bidi, zero-width, tag characters), line and paragraph separators and the Hangul fillers before it's stored; text keeps only the zero-width joiners scripts and emoji need. An address holding any of them, or any kind of space, isn't one (Security CS-L2).
- `at` is when to show it: its date, never later than when it arrived. `threadId` groups an email conversation inside the channel; show each as a quiet card with its subject.
- `parse.state: refused` is "This message couldn't be read safely". Its raw bytes are kept: `courier.message.raw` downloads them.
- `screen: filter` says the desk's learning filter put it in Spam, not the member, a block, the door or the provider: "Not spam" (`courier.move` `restore`) puts it back in Requests or Other and teaches the filter. `warnings` are the sender warnings made as it arrived (below, "Spam and safety"); show each as a neutral card.
- `danger` names a type that can't be previewed, most dangerous first: `program`, `script`, `macros`, `shortcut`, `disk_image`, `archive_programs` (an archive whose list holds one of those), `html`, `archive_unread` (an archive whose list couldn't be read). Never offer to open one; say what it is. Save to Files and Download of one need `allowDanger: true`, the second press after saying what it is; without it they're `forbidden` `{reason: danger, danger}`.
- **`courier.message.html`'s HTML is inert:** nothing in it loads or runs. Show it only as the plan says (a frame with no `allow-scripts` and no `allow-same-origin`, its own CSP); these are what it carries instead of live URLs:
  - **A link** has no `href`. `data-ma-href` is its destination made plain: ASCII host, no user-info, known tracking parameters removed. `data-ma-host` is that host, `title` the full destination (a pointer shows it), and `data-ma-warn` the warnings, space-separated: `mismatch` (its words name another domain), `ip`, `punycode`, `userinfo`, `tracker`. Opening it is the office's to offer outside the frame, in the desk's Browser by default.
  - **A remote image** has no `src`, only `data-ma-src` (tracking parameters removed). It loads only on the member's "Show images", fetched by the desk, not built yet. Tracking pixels are already gone.
  - **An inline image** is `data-ma-cid` (the part with that `contentId`); a `data:` image the sandbox drew again is the only `src`, `data:image/png` or `data:image/jpeg`.
  - **The office does exactly this** (Wave 1.6, `web/src/apps/courier/frame.ts`; the draft ADR §15): a `srcdoc` frame with `sandbox=""`, its own policy first, and the links listed outside it, each `data-ma-href` parsed again (http, https, mailto, tel only) and a web link opened in the desk's Browser.

### Spam and safety (Wave 3.2)

The draft ADR's §17. Requests is still the main filter: a stranger never reaches People on their own.
- **The learning filter** is naive Bayes over each message's words, per desk, kept in `courier.db` as keyed hashes of the words (never the words), taught only by what the member does: into Spam (`courier.move`, `courier.report`, a Request's Block, `courier.block`) is spam; out of Spam, a Let in, and writing to someone are wanted. It judges only a stranger's mail that would be a Request or Other, never a known sender's, the member's own or a reply in their thread, and acts once it has learned from 10 spam and 10 wanted messages, at a score of 0.95. What it puts in Spam is `screen: filter`; a later Let in brings it back. On a linked mailbox it stays on the desk: the provider isn't told (only the member's own Spam moves mail to the provider's Junk). Nothing of it leaves the desk. Its kill switch is `filter-off` in `courier-switch`: it judges nothing then, and keeps learning.
- **Sender warnings,** made once as a stranger's message arrives, each `{kind, ...}`:
  - `not_usual_address` `{contactId, name}`: the display name is a known contact's ("This isn't Dana's usual address"); a mailbox's role ("Support", "No-reply") is never a name;
  - `lookalike` `{domain, like}`: the domain (ASCII form) is drawn to look like `like`: one of the member's own domains, a known contact's, or a well-known one (letters that pass for others, one letter off a well-known name of six or more, or a well-known domain written in front of another);
  - `punycode` `{domain}`: an internationalized domain that mixes scripts or is spelled in letters that pass for Latin: show `domain` (its `xn--` form), never the Unicode;
  - `name_held_address`: the display name held an address, which isn't shown (the real address is).
- **A known sender's email whose DMARC failed is a Request** (the coordinator's call, Nov 14, for `mm-courier-safety.md`'s question 4): it only claims to be them, so it waits in Requests in their conversation, and the office shows "Couldn't confirm it's really them" with Let in, Not now and Report spam (never Block, which would block the real contact's address). Mail that merely can't be confirmed (`dmarc` `none`, `unaligned` or missing: no policy, no result) stays in People, marked "Couldn't confirm". Let in brings it to People. `Lanes.pick`'s `dmarcFailed`; `LanesTest.aKnownSendersMailWhoseDmarcFailedIsARequestAndOneThatCantBeConfirmedStaysTheirs`.
- **Linked mailboxes** (the plan §2.4, §2.8): the provider's Junk is kept, as Spam, whoever sent it; a Sent folder's correspondents are known; other strangers are Other, never Requests.

### Attachments (Wave 3.1)

The draft ADR's §10. Every byte comes from `desk-parse`'s Courier mode, which cuts a part out of the kept raw message: deskd never opens, runs or renders an attachment.
- **Save to Files** writes through Files' own door (the tree, its path rules, the quota and the floor as `files.*` has them: `no_space` `{reason: cap | floor}`), never replacing anything, and `files.changes` tells the Files app. An agent's `files_read` is untrusted (`U`) for every file, so a saved attachment carries that wherever it goes. Images saved this way aren't sent to the image check, as with a Browser download (ADR 0048 §8). Names lose hidden, reordering and look-alike characters, slashes and what other systems refuse, a leading dot and trailing dots and spaces, and keep their real extension when cut to 200 bytes.
- **A file whose bytes start like a program** (Windows, ELF, Mach-O, a `#!` script, a shortcut) is `danger: program` whatever its name and the sandbox said.
- **Download, a preview and the raw message** (the office's `bulk.ts`: each piece written as it comes, the whole checked against the reply's `sha256` and the trailer before anything is kept; `courier.attachment.stop` when the member cancels) go over `bulk` as `files.read`'s do (§12's frames, the trailer the SHA-256 and size), staged in an unlinked file under `/data/courier/parts` for the transfer's life, so nothing stays on the volume after it. The Platform's bandwidth pause refuses a new one (`unavailable` `{reason: bandwidth_limit, resumesAt}`), as it does `files.read`; Save to Files isn't a download and goes on.
- **One at a time:** a second extraction waits up to a minute for the first (`unavailable` `{reason: busy}` past it). The turn covers the bytes' whole life on the desk (the raw message, the part, the write into Files or the staging), so attachments add at most a raw message and one part to deskd's heap.
- **The floor:** a download is staged only if the volume keeps 2 GiB free after it (ADR 0035's floor, as Files keeps it), else `no_space` `{reason: floor, needed}`. Its transfer place is taken first and given back on any refusal, so a `too_many` stages nothing.
- **Errors:** `not_found` (no such message or part, or no raw bytes: `{reason: raw}`), `too_large` `{reason: too_large}` (a part over 25 MiB: download the raw message), `unavailable` `{reason: parse}` (the sandbox can't be reached), `{reason: refused, cause}` (it refused the part), `{reason: files}` (no Files tree), `{reason: transfers}`, `{reason: storage}`; `conflict` `{reason: folder}` (a file named `Courier` or like the day's folder is in the way).

### One person across channels (`courier.links.*`)

The office's flow 11 (`web/src/apps/courier/People.tsx`; the Designer's screens README flow 11; the draft ADR `draft-courier-store` §18), built in deskd (`courier/store/Links`, `courier.db` version 5). A person holds endpoints and has one conversation (`direct:<contactId>`). **A link is never made without the member's call:** nothing an arriving message does links, merges or lets anyone in, and `suggest` only reads. An address's `ma` and `email` endpoints are one desk and always move together. Endpoints are `{kind, value}`, `kind` one of `email`, `ma`, `phone`, `apple`, the value normalized as the store keeps it (`bad_request` `{reason: endpoint}` otherwise). Every link and unlink is one row in `links`, every "not them" one in `links_not`; both are in `courier.db`, and so in its export.

| Method | Mutation | Params | Result |
|---|---|---|---|
| `courier.links.suggest` | No | `{endpoint?}` | `{suggestions: [{endpoint, fromContactId, channelId, into: {contactId, name}, source: signature \| name, provider: null, strength: hint \| name}]}`, strongest first, at most 100. `signature`: the last 12 lines (above any quoted mail) of one of the 500 newest People emails from a known sender whose DMARC passed name this number or address. `name`: the same name and nothing else, into the older known person, and only for a sender with nothing in Requests, Other, Spam or Trash whose email (every message of it) passed DMARC: a display name is anyone's to write. Never from Requests, Other, Spam or Trash, an unconfirmed sender or anything an agent wrote; never a blocked or own endpoint; only an endpoint that is a person on its own (one endpoint, or an address's two halves); never a pair the member said "not them" to. `mac`, `card` and `provider` come with Wave 2.6's contacts |
| `courier.links.link` | Yes | `{into, from}` (a whole person) or `{into, endpoint}` (one endpoint, made on `into` with `source: added` if it's new) | `{linkId, channelId}`: the endpoint(s), every message that came from or went to them in their person's conversation (with the rest of each email thread), and for a whole person their drafts, join `into`'s conversation. The person a link empties, and their conversation, go (kept in the row for Undo). When `into` was known before the link, the moved endpoints that weren't are let in: only their own Requests and Other mail (and the filter's Spam) goes to People or Updates. Errors: `not_found` `{reason: contact}`, `bad_request` `{reason: from \| endpoint \| own}`, `conflict` `{reason: already}` (it's theirs), `conflict` `{reason: blocked}` (a blocked sender joins no one by a link: Unblock first) |
| `courier.links.undo` | Yes | `{linkId}` | `{}`: that link reversed exactly: the endpoints, their messages and threads (and any that came through them since), the drafts it moved, the person and conversation it emptied under their own ids, and what letting in changed (lanes, `sender_known`, standing). A new endpoint made by the link goes again while nothing came or went through it. `not_found` `{reason: link}` once undone, or once something else moved those endpoints (a later link or unlink) |
| `courier.links.unlink` | Yes | `{endpoint}` | `{contactId, channelId}`: the endpoint (and its address's other half) back to a person of its own (named by its display name, a hint), with the messages that came from or went to it, in a new conversation. Its standing doesn't change; nothing is deleted. `not_found` `{reason: endpoint}`; `conflict` `{reason: only}` for a person's only endpoint |
| `courier.links.dismiss` | Yes | `{endpoint, into}` | `{}`: "Not {first name}", remembered for that pair (and the address's other half); never suggested again. `not_found` `{reason: endpoint \| contact}` |
| `courier.links.lookup` | No | `{endpoint}` | `{contactId, name, endpoints, messages}`: whose it is here, how many endpoints that person has, and how many messages came from or went to it ("This brings in {n} messages"); `contactId` null and the counts 0 for one the desk doesn't have |

`courier.contact.get`'s endpoints also carry `source` (`added` for one the member typed or an invite's Add, else `message`; `card`, `mac` and `provider` with Wave 2.6) and `provider` (null until then).

### Topic `courier.changed`

SUB gets a `snapshot` of `{}` (coalescible: a client that fell behind gets a fresh one). Then `changed` events `{channels: [channelId] | null, lanes, counts, drafts, outbound, accounts}`, after any change by any session, a transport, the queue or the sweep, merged to at most two a second. Over 50 channels, `channels` is null: refresh what's shown. Two offices open at once both get every event.

### What a transport does (for the next pieces)

Not a client call: the seams in deskd (`courier/store/CourierStore`, `Outbox`, `courier/parse/CourierParser`, `courier/CourierRead`).
- **Receive:** `accept(batch, cursor)` stores each message once by `(medium, externalId)` (`ExternalIds.email` for email) and commits the transport's cursor in the same transaction; ack the source only after it returns. Answers: `STORED`, `DUPLICATE` (with the first's id), `PENDING` (kept raw, waiting for the parser), `REFUSED` (with a reason; nothing kept). A transport's DMARC result carries the domain it was for (`Courier.Verdicts`' `dmarcDomain`): a pass counts only for the From's own domain. A linked mailbox records its places with the messages (`LinkedState.arrive`, in the sink's own transaction).
- **Send:** `outbox().register(medium, accountId, sender)`; the sender gets each due message with `attempt` and `maybeSentBefore` and answers `Sent`, `Retry(error)`, `Retry(error, unclear: true)` (it may have gone: the row is marked, so the next try is told `maybeSentBefore`) or `Failed(error)`.
- **Parse:** `desk-parse`'s Courier mode answers `parse-courier 1` (the draft ADR, section 4) through `CourierSandbox`, which is deskd's `CourierParser`; it also gives a part's bytes, a part re-encoded as an image, and an archive's list, for the attachments' wave.
- **Sign in:** `CourierModule.linkedAccounts()`. `register(kind, verifier)` lets `courier.accounts.add` check sign-ins of that kind with the provider; `open(accountId)` gives the transport its sealed sign-in (close it once used); `change(accountId, signIn)` seals a refreshed one.
- **Its kill switch:** its own word in `courier-switch`, `<medium>-off` (linked mailboxes: `imap-off`, and `imap-send-off` for their sending).
- **Spam reports (the mail door's transport, Wave 2.5):** `CourierStore.owedReports(limit)` lists the reports `courier.report` made for mail to this desk's own address (the sender's address only), oldest first; deliver each to the platform's suppression list, then `reportDelivered(id)`. Delivered ones go after 30 days.

### Linked mailboxes (Wave 2.1)

**Built Nov 14, `sub/mm-courier-imap`** (the draft ADR §15; `docs/sub-status/mm-courier-imap.md`). Each linked mailbox (`kind: imap`) has its own sync in deskd over one IMAP connection, from the desk to the member's provider: the platform is never in the path.
- **What it syncs:** every folder but Drafts and views of others; on Gmail, All Mail (labels from X-GM-LABELS), Sent, Spam and Trash. A provider's Junk is Spam, its Trash is Trash, its Sent is the member's own. A stranger through a linked mailbox is Other, never Requests. A user folder's name (or a Gmail label) is a label on its messages.
- **The first sync** goes newest first, the last 12 months of every folder before older mail, Sent first; paced (2 MiB/s at most, and Gmail's daily download kept under 2 GB). Its messages are `origin: backfill`, which `courier_new` never gives an agent (mail of the last day before the link is `catchup`, which it does). `sync.firstSync` says how far: `oldestAt` is "Bringing in older mail: {year} so far".
- **Then live:** IDLE on INBOX (Gmail: All Mail), and the other folders looked at every 5 minutes, opened only if they changed. A desk that slept catches up from where each folder was (QRESYNC, CONDSTORE, or the UID list), marking what came meanwhile `catchup`.
- **Both ways:** `courier.read.set`, `courier.move` (Trash, Spam, `restore`), `courier.delete` (Trash, and for good) and blocking reach the provider (`\Seen`, a move to its Trash, Junk or INBOX, a delete for good from its Trash); the provider's flags, moves and deletes reach the desk. A message deleted at the provider goes to Trash on the desk, and one deleted from the provider's Trash is deleted for good. While a member's change is owed to the provider, what the provider says of that message waits, so the member's last word wins. `sync.changesOwed` counts what's owed.
- **`sync.provider`:** which named provider the account's servers are (`gmail`, `icloud`, `fastmail`, `yahoo`, `outlook`) or `other`, as of its last sign-in, so the office's "Sign in again" opens the right tile (a Workspace address is `gmail`). The office's named tiles send `provider` to `courier.accounts.add`; the address inference is for a caller that sends neither.
- **`sync.state`:** `connecting`, `syncing` (the first sync), `live`, `waiting` (`reason`: `unreachable`, `throttled`, `daily_limit`, `tls`, `storage`; it tries again at `nextTryAt`), `needs_you` (`reason`: `auth`, `app_password`, `imap_off`, `web_login`, `signed_out`, `server`, `host`, `port`, `address`: "Sign in again", `courier.accounts.signin`), `off` (`switched_off`).
- **Sending** goes through the outbound queue, from the account's own address (never a draft's), by SMTP submission to the member's provider, and a copy is filed in its Sent where it doesn't file one itself (Gmail does). After an end that leaves it unclear whether it went, the next try looks for its Message-ID in Sent first.
- **Kill switches** in `courier-switch`: `imap-off` or `email-off` stop the sync and sending, `imap-send-off` or `send-off` sending only, `off` all of Courier. Seen within 30 seconds; turned back on, the sync catches up.
- **Not here yet:** Microsoft and Google sign-in (Wave 2.2), JMAP (2.2), "Remove from this desk only" on a delete, attachments fetched only when opened (a message is brought whole; one over 48 MiB as its header only).

### The desk's address and members' messages (Wave 2.5)

**Built Nov 14, `sub/mm-courier-transports`** (draft ADR [`draft-courier-transports`](../../../docs/decisions/draft-courier-transports.md); `docs/sub-status/mm-courier-transports.md`). One transport through Platform's relay (ma-platform contract 0.4.0) for both: mail to the desk's address, sealed by the mail door, and sealed messages between members' desks (`ma`). Its store accounts are `desk` (kind `desk`, email) and `ma` (kind `ma`), from the platform's answer for this desk's addresses; closed addresses stay the member's own.
- **Collecting:** at deskd's start (origin `catchup`), on the gateway's `notify relay`, and every 10 minutes while running. **It never wakes a desk.** Each envelope is stored once, then acked; one that may pass later (the directory unreachable, a drop's link not issued today, the door's key not known) waits for the next drain. A refusal is counted by reason, never with content; one envelope never stops the drain for the others.
- **Who sent it:** a member's message is accepted only under the identity this desk pinned for its address. The first one from an address pins the directory's keys (unverified) and is a Request. One signed by a new identity the directory now gives is **held** out of the store and the pin marked changed; anything else is a forgery and refused. A message older than the relay's wait plus a day or dated more than a day ahead, from an address off the Courier domain, or one already taken in (even after the member deleted it), is refused. Held messages are capped (200 and 64 MiB an address, 2,000 and 256 MiB a desk); past that they wait in the relay.
- **Sending:** `courier.send` on medium `ma` (account `ma`) seals one envelope per recipient to their pinned keys, long text through the ciphertext drop. **A recipient whose pinned key changed waits** (`courier.outbound.list` `error: key_changed`) until the member checks the new safety number. Medium `email` from account `desk` goes through Platform's `courier-send`, except to members' addresses, which get it sealed; it's offered only while the platform says sending works (`courier.address` `sending.email`), else `courier.send` is `unavailable` `{reason: medium}`. A message up to 4 MiB goes inside the call (`raw`, the door's inline cap in contract 0.4.1); a larger one goes up first through the door's `POST /v1/agent/courier/uploads` and its presigned `PUT` (the relay's drop uploader: https only, its signed length checked), then is sent by its upload id, up to the door's 25 MiB; an upload that expired before the send is made again once.
- **Delivery notes** from the door set a recipient's `status` on the member's sent message: `delivered`, `bounced`, `complained`, `deferred`, `refused`; every recipient bounced or refused makes the message `failed`.
- **Kill switches** in `courier-switch`: `ma-off` (members' messages both ways; their envelopes wait in the relay), `ma-send-off`, `door-off` (the desk's address both ways), `door-send-off`; `email-off`, `send-off` and `off` as for every transport.

| Method | Mutation | Params | Result |
|---|---|---|---|
| `courier.address` | No | None | `{address, domain, closed: [address], fingerprint, invite, sending: {ma, email, provider}, doorKey, relay: {state, problem, lastDrainAt, pending, waiting, stored, duplicates, held, notes, refused: {<reason>: n}, removedByDoor: {<reason>: n}}}`. `address` is null until the member picks a name (then `invite` is null too); `invite` is `ma://courier/<address>#k=<fingerprint>`, the link to share. `relay.state`: `starting`, `ok`, `unreachable`, `paused` (the platform's kill switch), `off` (this desk's switches), `no_address`, `closed` (only closed addresses), `keys` (no `/data/keys`). `pending` is the relay's count after the last drain |
| `courier.invite.open` | Yes | `{link}` | `{contactId, address, outcome: verified \| changed_verified \| rotated, safetyNumber, released}`: someone's invite link. The directory's keys for its address must have the link's fingerprint; then they're pinned as checked (a changed pin takes them: the link vouches for them, and `released` held messages go in), and the contact is made and let in. `rotated`: the pinned identity with a box key this desk recorded for it before a rotation (an old link), nothing more checked. An unchecked pin takes the link's keys (`changed_verified`); a pin the member checked under another identity is marked changed instead: `conflict` `{reason: key_changed, newSafetyNumber}`, settled with `courier.contact.verify`. Errors: `bad_request` `{reason: link \| own}`, `conflict` `{reason: invite_mismatch, pinned}` (nothing pinned; `pinned` true: ask for the safety number), `not_found` `{reason: address_unknown \| address_closed}`, `unavailable` `{reason: keys_not_set \| paused \| unreachable \| keys_invalid \| keys}`, `rate_limited`, `forbidden` `{reason: blocked}` |
| `courier.contacts.add` | Yes | `{name, fingerprint?, displayName?}` | `{contactId, channelId, checked: invite \| null, address, safetyNumber, released}`: the office's Add for an invite link it read (the shape `sub/mm-courier-ui` proposed; built here): the member address `<name>@<Courier domain>`, its keys looked up and, with `fingerprint`, pinned as checked only if they match it, by `courier.invite.open`'s rules (`checked: invite`); without one, pinned on first use (`checked: null`; a pin already there stays). `displayName` names a new contact (a hint, never identity). Errors: `conflict` `{reason: fingerprint, pinned}` or `{reason: key_changed, newSafetyNumber}`, `not_found` `{reason: address_unknown \| address_closed \| keys_not_set}`, `bad_request` `{reason: name \| fingerprint \| displayName \| own}`, and `courier.invite.open`'s `unavailable`, `rate_limited` and `forbidden` |
| `courier.contact.keys` | No | `{contactId}` or `{address}` | `{keys: [{address, state: none \| unverified \| verified \| changed, source, identityKey, safetyNumber, pinnedAt, verifiedAt, changedAt?, newIdentityKey?, newSafetyNumber?, held}]}`, one per member address of the contact. `changed`: show the new number (`newSafetyNumber`) and that sending waits; `held` messages came under the new key |
| `courier.contact.verify` | Yes | `{address, safetyNumber}` | `{state: verified, released}`: the member compared the 60 digits (12 groups of 5, as shown) with their contact. The pinned identity's number marks it checked; a changed pin's new number pins the new identity, puts its held messages in and sends what waited. With no pin yet, the directory's keys are checked against it first. `conflict` `{reason: safety_number}` for any other number; `bad_request` `{reason: address \| safetyNumber \| own}` |
| `courier.compose.pick` | No | `{channelId}` or `{to: [address or phone]}` | `{medium, accountId, reason: {kind, medium, at, addresses?}, options: [{medium, accountId, kind, label, sendable, reaches, blocked?}]}`: the medium a message goes by (design §8.3): the last message received from them in this channel when it can be sent and reaches everyone (`kind: last_inbound`, its `medium` and `at` for "By email · her last message was an email, 2 h ago"), else the channel's preferred medium (`preferred`), else sealed when everyone has a member's address (`all_members`), else `medium: null` (`choose`). A recipient whose pinned key changed gives `medium: null`, `kind: key_changed` and the `addresses` |

### iMessage on the member's Mac (Wave 2.6)
Draft ADR [`draft-courier-imessage`](../../../docs/decisions/draft-courier-imessage.md); the seam's agreement with MA's Mac connector, `docs/sub-status/imsg-seam.md`. deskd `courier/imsg/` (`ImsgTransport`, `ImsgSink`, `ImsgPath`) and `courier/imsg/bluebubbles/`.
- **Adding the Mac** (the Designer's flow 8): `courier.accounts.add` `{kind: "imessage", path?: "bluebubbles", server, secret}`, mutation, `{accountId}`. `server` is the address BlueBubbles gives (`https://` only; a DNS name or a public IP, a port 443, 8443 or 1024 to 65535, nothing else); `secret` the server's password. The desk asks the server about itself (`GET /api/v1/server/info`) with them before anything is kept; then both are sealed together in the Courier vault, never in a row, an answer or a log. One Mac a desk. The answers the office words:
  - `bad_request` `{reason: https}`: "Courier only connects to your Mac over HTTPS." `{reason: server, cause: address | host | port}`: an address the desk won't use.
  - `forbidden` `{reason: sign_in, cause: password}`: "Your Mac didn't accept that password." `{reason: messages}`: "Your Mac isn't signed in to Messages."
  - `unavailable` `{reason: unreachable}` (with `cause: tls` or `not_bluebubbles` when something answered wrongly): "Couldn't reach your Mac at that address."
  - `conflict` `{reason: too_many}`: this desk has a Mac already.
- **Certificates:** one the JDK trusts, with the host checked; or, at the member's own address only, the certificate the Mac shows on first connect, pinned (`sync.certificate: pinned`, "Certificate pinned on first connect"). A tunnel's address (`through` `cloudflare`, `ngrok`, `zrok`) is never pinned.
- **Its state** (`courier.accounts.list`'s `sync`): `state` `syncing` (the first 30 days coming in), `live`, `away` (`reason` `asleep`, `unreachable`, `tls`, an address word: "Can't reach your Mac. Messages wait on it until it's back."), `needs_you` (`password`: "Your Mac stopped accepting the password"; `certificate`: its certificate changed; `signed_out`), `waiting` (`parse`: the desk's reader is busy; `daily_cap`: 20,000 new messages today), `off` (`switched_off`). `mode` `basic` or `private_api`, `through` `own`, `cloudflare`, `ngrok` or `zrok`, `certificate` `trusted` or `pinned`, `socket` (live updates on), `cards` (the Mac's contact cards read).
- **What comes in:** iMessages (`medium: imessage`) and the iPhone's texts (`sms`), each person's in their own conversation with their email and member messages; group chats as one conversation each, titled as on the iPhone; reactions, edits, unsends and a group's changes as words ("Loved “see you at 6”", "Edited “…”: …", "Unsent a message.", "Named the conversation “Crag day”."); files up to 16 MiB each and a message through the Courier mode, as email's attachments (Save to Files, Download, previews, danger words), larger ones said in the text ("[video.mov, 48.2 MB: it stays in Messages on your Mac.]"). The member's own messages from their iPhone or Mac are `direction: out` and let the person in. A stranger's first message is a Request. The first look brings 30 days, older than a day as backfill.
- **The Mac's Contacts** name people with no name yet (numbers and Apple IDs only) and make `courier.links.suggest` suggestions with `source: "mac"`, `strength: "card"` ("Your Mac's contacts list this number on Dana's card."), strongest first. They never link anyone.
- **Sending:** `courier.send` with a draft's `medium` `imessage` or `sms` and the Mac's `accountId`: to the person's number (or the Apple ID they last wrote from on iMessage), or a group's own chat. A first message to someone with no conversation on the Mac, or a new group, is `failed` `chat` at launch. No reactions, typing or edits are sent.
- **Agents:** `senderConfirmed` is `true` for an iMessage and `false` for a text (a text's sender can be spoofed).
- **Switches:** `imessage-off` (both ways), `imessage-send-off`, and `send-off` and `off` as everywhere.

### iMessage through MA Connector for Mac (the `connector` path)
Draft ADR [`draft-courier-mac-connector`](../../../docs/decisions/draft-courier-mac-connector.md); ma-platform `relay.md` 0.4.3 (paired devices); the app is `connectors/mac/`. deskd `courier/imsg/connector/` (`ConnectorLinks`, `ConnectorPath`) behind the same seam: everything above about what comes in, sending, agents and switches holds. The Mac is a paired device: it talks to the platform's relay only, sealed to this desk's box key and signed with its own key; the desk never connects to the Mac.
- **Pairing** (mutation): `courier.imsg.pair {code}` → `{accountId, fingerprint, check}`. `code` is the 8 letters MA Connector shows (any case, spaces and dashes ignored). The desk claims it (`POST /v1/agent/devices/claim`), which binds that Mac to this desk and its member, checks the Mac's key binding, pins its keys in a new iMessage account's sealed sign-in (`path: connector`, never in a row), and starts its path, which says hello to the Mac. `fingerprint` is the first two groups of the Mac's key; `check` the pairing's check number (`"1234 5678 9012"`), which the Mac shows too on its "Connect this Mac?" screen beside the claiming member's masked email: nothing flows until the member presses Connect there. One Mac a desk. Errors: `bad_request` `{reason: code}` (not a code's shape); `not_found` `{reason: code}` ("That code isn't waiting": unknown, expired or claimed); `conflict` `{reason: too_many}` (a Mac already, or the platform's 5 devices); `rate_limited` (10 claims an hour, 30 a day); `forbidden` `{reason: teen}`; `unavailable` `{reason: paused | switched_off | keys | store | medium | unreachable | keys_invalid}`.
- **Its state** (`courier.accounts.list`'s `sync` for `path: connector`): `{state, reason, path: "connector", device: {fingerprint, pairedAt, check}, mac: {app, os, fullDisk, automation, paused}, checkedAt}`. `state` `waiting` `reason` `mac` until the Mac's first word (the member hasn't pressed Connect yet), then `live`; `needs_you` with `reason` `full_disk` (the Mac can't read Messages), `automation` (the Mac may not send through Messages), `unpaired` (the Mac or the account site disconnected it; Remove, then pair again) or `signed_out`; `waiting` `paused` (paused on the Mac); `off` `switched_off`. `checkedAt` is when the Mac was last heard from.
- **Removing it:** `courier.accounts.remove {accountId, keepMail}` tells the Mac `bye` and has the platform forget the device; the Mac's next request is refused and it forgets this desk.
- **Its place:** `courier.db` cursors `mac:place` (`<epoch>:<rowid>`, committed with each page's messages) and `mac:hello`. A page past the place in the same epoch isn't kept and the Mac is asked to send again from the place (`resume`); a page of a new epoch is taken whatever its place. While iMessage is switched off, pages are refused and the place stays.
- **Limits:** a device envelope is at most 32 KiB, a page carried whole in a drop at most 8 MiB (the Mac keeps pages to 4 MiB; a larger one is refused, never held), texts 20,000 UTF-16 units, files 16 MiB. The relay keeps the Mac's envelopes 90 days for a sleeping desk.

### The agent's Courier tools (§18)

**Built Nov 13, W5, `sub/mm-courier-read`** (the draft ADR "the Agent's tools and approvals", §12; `docs/sub-status/mm-courier-read.md`). `tool.courier.*` on the agent socket, through `ToolHost` like Files and To-do (`tools/CourierTools`, over `courier/CourierRead`): no client reaches them. Read only: **there's no send tool**, and nothing here writes to Courier but an agent's cursor. Scope `courier:read`, the setup screen's Courier app, **off for every agent until the member switches it on** (§18, "An agent's access"; a call for an agent with it off is `forbidden` `{reason: "scope"}` from deskd's own record). The hello names the four only while Courier's store is there and on (not on an image without `/data/courier`, with the kill switch off, on a guild desk or a teen's); a call then is `unavailable` `{reason: "courier"}`.

| Tool | Input | Returns | Restart |
|---|---|---|---|
| `courier_list` | `{kind?: "direct" \| "group" \| "self", unread?: bool, before?}` | `{channels: [{channelId, kind, title, contacts: [name] (10 named, each cut at 80; the rest counted in `contactsMore`), medium, lastAt, unread, lane, accountLabel}], next}`, newest first, up to 50 | safe |
| `courier_search` | `{q: 1–200, channelId?, from?, fromDay?, toDay?: "YYYY-MM-DD"}` (days in the member's zone) | `{hits: [{messageId, channelId, from, at, medium, subject, snippet (≤ 200), lane, accountLabel, bulk, senderKnown, senderConfirmed}], more}`, newest first, up to 25 | safe |
| `courier_read` | `{messageId, from?}` or `{channelId, before?}` | One message, its text a page at a time (`textFrom`, `textNext`, null at the end), or a conversation a page at a time, newest page first, oldest first in it (`next`) | safe |
| `courier_new` | `{}` | `{messages, more, cursor}`: inbound messages after this agent's place, oldest first, without bulk mail, each text cut at 2,000 characters (`textMore`, `textNext`: the rest with `courier_read`); call again while `more` | by key |

**A message** as the model reads it: `{messageId, channelId, direction, from: {contactId, name, endpoint} | {me: true}, at (ISO 8601, the member's zone), medium, subject, text, attachments: [{name, type, bytes}] (10 named, the rest counted in attachmentsMore), bulk, authorKind, lane, senderKnown, senderConfirmed, accountLabel}`.
- **Every result is `U` and `S`** (the declarations', in deskd and desk-agent), so from the first Courier call the run holds both: every browse action asks (`egress`), a memory save asks, a desk message asks (§14), and §15's auto-approve stops for everything but adding a to-do. desk-agent fences each result as one line of JSON behind "Untrusted content from Courier, the member's messages and email, written by other people".
- **`from` is Courier's contact record** for the sender's endpoint, never a name in the text or a display name alone; `senderConfirmed` false (no DMARC pass) and `senderKnown` false (Other's strangers) say so. Requests, Spam and Trash are never read (in the store's SQL), and `courier_new` never gives bulk mail (`List-Unsubscribe`, `Precedence: bulk` or `list`), the member's own, or a linked mailbox's first sync of its old mail (`origin: backfill`).
- **Text is plain:** the store's text, which the sandbox made from any HTML (deskd never reads a message's HTML, and no tool returns it), with links as `[link: example.com]` and quoted mail folded. Attachments are named, typed and sized, never opened. Every string a sender wrote (subjects, names, titles, attachment names, text) is cleaned again here of hidden and bidi characters, one line where it's a line (Security's Q6 condition).
- **Each result reaches the model whole:** fitted to 18,000 characters as desk-agent's fence carries it (whole rows only; a page's `next` moved back to just after the last row kept; one message too long alone has its text cut, with `textNext`). desk-agent's run loop cuts any result at 20,000, which would otherwise drop messages the cursor had passed.
- **The cursor:** one per agent, in Courier's store (`agent_cursors`). An agent with none starts 24 hours back, stored at its first call. Each `courier_new` gives what comes after the further of the stored cursor and the run's own place (deskd's RAM), and moves the run's place; it reads the store 16 at a time, only as far as a result can take. A lost reply asked again by its key (§18, "Keys") gets the same messages, never the next. **The cursor moves only at a `run_end` with `args.state: "done"`,** to `args.courier`, the last cursor desk-agent received, and none once a `courier_new` of the run was interrupted (a reply its key couldn't recover: deskd may have moved the run's place past messages the model never saw; Security's CR-L2): stored if deskd gave this run exactly that, or, when deskd holds no record of the run (it restarted since), if it names a message `courier_new` could have given (inbound, not bulk, in a lane it reads; CR-I1). A run's end reaches Courier's tools only for an agent the member gave Courier. `state: "ended"` (failed, stopped), no `run_end` (desk-agent killed) and a desk-agent restart store nothing: the next run is given the same messages again, which To-do's dedupe makes harmless. Courier's store gives a message caught up after a wake, parsed late, let in or moved back out of Spam a later `receivedAt`, so it's never behind a cursor. A deleted agent's cursor goes with it.
- **To-do's provenance:** a message `courier_read` or `courier_new` gave the run whole is a `todo_add` source (`{kind: "courier", ref: {messageId}}`), labelled "Email from {contact} · {subject}" from the contact record; a sender Courier couldn't confirm (Other's strangers, no DMARC pass) is named by the address it came from, never a display name it wrote, with "(unconfirmed)", the name or address cut to 40 characters so the mark always fits To-do's 80 (Security's CR-L1); a search's hit or a list isn't (Security's TD-L1).
- **Chips:** "Looked at your messages", "Searched your messages", "Read your messages", "Checked for new messages": never a name, a subject or an address. Reads never ask, so there's no card.
- **Refusals,** `bad_request` with the field: an argument the tool doesn't take, `kind`, `unread`, `q` (missing, blank, over 200, or with hidden characters), `fromDay`/`toDay`, `messageId` (neither or both of a message and a channel), `from`, `before`. A message or channel an agent may not see is `not_found` `{reason: "message" | "channel"}`, as one that isn't there. A store that fails is `unavailable` `{reason: "store"}`.
- **`run_end`** (desk-agent's, any tool host): `{runId, agentId, tool: "run_end", args: {state: "done" | "ended", courier?: {receivedAt, messageId}}}`; an older desk-agent sends no `args`, which stores nothing.

### Configuration (container environment)

| Variable | Meaning | Default |
|---|---|---|
| `DESKD_COURIER_ROOT` | the store's directory | `/data/courier` |
| `DESKD_COURIER_AGENTS_SEE_OTHER` | whether the agent read tools see the Other lane (the plan's §6 amendment 2; accepted by Security's read, Nov 13) | `true` |
| `DESKD_COURIER_PARSE_SOCKET` | the socket of `desk-parse`'s Courier sandbox; `run` mounts its directory read-only where the image has it | `/run/desk-parse-courier/sock/parse.sock` |

The directory must be one deskd can make or write (the image's `desk-datadirs` makes it, 1100:1100 `0700`, and mounts it into deskd's container, as `/data/files`); otherwise every `courier.*` answers `unavailable` `{reason: "store"}`. deskd never makes `/data` itself.

## 22. To-do

To-do's desk side (id `todo`; the owner named it, Nov 12): the desk's own list of to-dos, which the member keeps and agents add to through their tools (§18, "The To-do tools"). The product design is the To-do VISION (Nov 12, the Lead Subcontractor's `todo-product`); the agent tools' safety is the draft ADR's §13 ([draft ADR](../../../docs/decisions/draft-agent-tools-approvals.md)). **The store and this wire are the contract the To-do app builds to;** everything here is stable from the first push of `sub/mm-todo-store`, and a change is recorded in `docs/sub-status/mm-todo-store.md`.

**Where it lives.** `/data/desk/todo.db`, deskd's own SQLite file (WAL, `synchronous=FULL`, 0600), one per desk, beside deskd's other files on the desk's encrypted volume. It works with the Agent off (a teen's desk, a member with no key). Nothing of it leaves the desk: the office's "All desks" view merges each desk's `todo.list` in the browser. **A Guild Desk has no To-do at launch.** The data export's `desk` part carries it (§12), whose friendly name becomes "Desk settings, Courier and To-do".

### Who may call

| Method or topic | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `todo.*`, topic `todo` | yes, on any personal desk (a teen's too) | `forbidden` `{reason: "scope"}` | `forbidden` `{reason: "scope"}` |

Checked in this order: a guild desk, `forbidden` `{reason: "scope"}` (the owner too); no store (the file can't open, a schema from a newer release, SQLite's library not loaded), `unavailable` `{reason: "store"}`; the kill switch `/data/desk/todo-switch` saying `off`, `unavailable` `{reason: "switched_off"}`. To-do ships on; the switch only stops it. A deskd before this section answers `not_found`: "this desk can't do To-do yet".

### Ids, times and dates
- Ids are UUIDv7 strings (36 characters); anything else is `bad_request` `{reason: "id"}`. Times are UTC ms.
- **Dates are the member's**, in the desk's IANA time zone: the account's `timeZone` (the setting Notebook's Temporal view and ADR 0043's midnight use), UTC until one is known. `due` is `{date: "YYYY-MM-DD", time?: "HH:MM"}`, never a timestamp, so it means the same day wherever the member looks. "Today" is the desk's, and every list says which day it judged by (`today`, `zone`).
- **`rev`** is one desk-wide counter. Every change to an item gives it the next `rev`; an item's `rev` is the last one it got, and `todo.update` names it (`precondition_failed` when it moved).

### An item

```json
{ "id": "0193…", "rev": 412, "title": "Sign and return the lease renewal", "note": null,
  "due": { "date": "2026-11-14", "time": null, "by": "agent:ag-3k9x0d2m4q1z" },
  "state": "open", "closed": null, "snoozedUntil": null, "pinned": false,
  "by": "agent:ag-3k9x0d2m4q1z", "runId": "…",
  "source": { "kind": "courier", "ref": { "messageId": "01JC…", "channelId": "01JC…" },
              "label": "Email from Dana Ortiz · Lease renewal for 2027" },
  "alsoFrom": [], "mergeCount": 0, "untrusted": true,
  "suggestion": null, "seen": false, "group": "today",
  "createdAt": 1762850000000, "updatedAt": 1762850000000, "trashedAt": null }
```

| Field | Meaning |
|---|---|
| `title` | 1 to 200 characters, one line: newlines become spaces; control, format (bidi, zero-width), private-use and unassigned characters removed. Plain text: never Markdown, never a link, even when it holds an address |
| `note` | Up to 2,000 characters, the same rules but newlines kept, or `null`. Plain text |
| `due` | `{date, time, by}` or `null`. `by` is `member` or `agent:<id>`: whose date it is. An agent's date says so ("date from the email"); a merge never overwrites the member's |
| `state` | `open`, `done` or `not_needed`. `closed` is `{at, by}` once closed, `by` `member` or `agent:<id>` |
| `snoozedUntil`, `pinned` | The member's alone: snoozed items leave every list but `open` (where they're `group: "snoozed"`) until then; `pinned` is "Keep in Needs you" |
| `by`, `runId` | Who made it, stamped by deskd: `member`, or `agent:<id>` with the run that made it. Never from an argument |
| `source` | `{kind, ref, label}`. `kind`: `member` (typed by the member; `ref` `null`), `courier` (`{messageId, channelId}`), `notebook` (`{pageId}`), `browser` (`{url}`, http and https only), `files` (`{path}`), `agent_chat` (`{agentId, threadId, messageId}`, the member's own message that started the run; `threadId` is the agent's id while an agent has one thread; an agent's tool call names it as `{}`, and deskd fills it from its own record)), `desk` (`{deskId, messageId}`, a message from another of the member's desks deskd gave the run: §18, "To-do's source kind `desk`"; an agent's tool call names it as `{}`, the last one, or by `messageId`). `label` is at most 80 characters, written by deskd from its own record of what the run read (the sender's contact name and the subject; the page's title; the file's name; the site's host and title; "Your message to the agent"), never from the model's arguments. Show it as plain text, with Open going to `ref` in that desk's own app |
| `alsoFrom` | Up to 5 later sources merged into this item (below): `[{kind, ref, label, at}]` |
| `mergeCount` | How many merges it took |
| `untrusted` | Made, or last changed, by a run that had read untrusted content (email, web pages, files, other agents). Say so ("From an email. Check it before you act on it."). The member's own new title ends it, when the note is theirs too or there's none; a note alone, or the same title sent back, doesn't |
| `suggestion` | An agent's "Looks done?": `{as: "done" \| "not_needed", by: "agent:<id>", reason, at, untrusted}`, `reason` ≤ 140 characters of plain text from the model (`untrusted: true` when its run had read untrusted content: say so), or `null`. One at a time; `todo.answer` settles it |
| `seen` | Whether the member's view has shown it (`todo.seen`), for "new from agents" |
| `group` | Where it sits on `open` today, judged by deskd in the desk's zone: `overdue`, `today`, `upcoming`, `no_date`, `snoozed`; on `done` and `trash`, `null` |
| `trashedAt` | In the Trash since then (30 days, then gone), or `null` |

### Methods

Every mutation needs `idem` (§4), and To-do also keeps each mutation's result by its `idem` for 30 days in `todo.db`, across deskd restarts: the trusted device's queue can replay a tick or a new to-do hours later, after a restart, and it's applied once. A replay with the same `idem` and another method or other params is `conflict` `{reason: "idem"}`.

| Method | Mutation | Params | Result |
|---|---|---|---|
| `todo.list` | No | `{view, by?, source?, q?, cursor?, limit?}` | `{items, next, rev, today, zone}`; for `needs_you` also `more` and `footer` (below) |
| `todo.get` | No | `{id}` | `{item, events}`: the item with its `alsoFrom`, and its last 50 events, newest first |
| `todo.summary` | No | None | `{open, needsYou, overdue, dueToday, newFromAgents, toConfirm, badge, rev, today, zone}`: counts for the tile and Maia's For you. `badge` is `overdue + dueToday`. The office reads it on each `todo` topic event and just after the desk's midnight in `zone` (`web/src/desk/todoBadge.ts`; there's no `summary` topic, §5) |
| `todo.changes` | No | `{since}` | `{changes: [{rev, id, op}], rev, reset}`: what changed after `since`, oldest first, 500 at most (then ask again from the last `rev`). `reset: true` when `since` is older than the kept log (30 days or 50,000 changes): refetch what's shown |
| `todo.add` | Yes | `{title, note?, due?, pinned?}` | `{item}`: the member's own to-do, `source.kind: "member"`, `by: "member"` |
| `todo.update` | Yes | `{id, rev, title?, note?, due?}` | `{item}`. `due: null` clears it. The member's date is `by: "member"` |
| `todo.close` | Yes | `{id, as: "done" \| "not_needed"}` | `{item}`. Closing a closed item changes nothing and answers it as it is |
| `todo.reopen` | Yes | `{id}` | `{item}`. Reopening an open item changes nothing |
| `todo.snooze` | Yes | `{id, until}` | `{item}`. `until` is ms within 400 days, or `null` to wake it |
| `todo.pin` | Yes | `{id, on}` | `{item}` |
| `todo.answer` | Yes | `{id, accept}` | `{item}`: `accept: true` closes it as the suggestion said (closed by the member), `false` ("Not yet") clears the suggestion. `conflict` `{reason: "no_suggestion"}` when there's none |
| `todo.trash` | Yes | `{id}` | `{item}` |
| `todo.restore` | Yes | `{id}` | `{item}` |
| `todo.undo` | Yes | `{eventId}` | `{item}`: puts back what that event changed (below) |
| `todo.seen` | Yes | `{ids}` | `{}`: up to 200 ids; ids that aren't items are skipped |
| `todo.export` | No | `{format: "md" \| "json"}` | `{transferId, size, mtimeMs, name}`, then the file's bytes on `bulk` as `files.read`'s (§16): CHUNKs within CREDIT, the last with END and the 40-byte trailer. `md` is a Markdown checklist of the open items then the done ones; `json` every item with its events |

**`todo.list` views:**
- **`needs_you`:** open, not snoozed, not trashed, and overdue, due today or pinned; ordered overdue (oldest first), today with a time (earliest first), today, then pinned (latest pin first). At most 5, with `more` (how many more qualify) and `footer: {newFromAgents, toConfirm}`: the unseen agent items not in the list, and the open suggestions. No model, text or agent field moves an item in: only dates and pins, and an agent's date brings an item in only on that day. `cursor` and `limit` don't apply.
- **`open`:** every open item, grouped by `group` in the order overdue, today, upcoming (by date, then time), no date, snoozed; within a group oldest first.
- **`done`:** done and not needed, newest closed first.
- **`trash`:** trashed, newest first.
- **Filters**, on any view but `needs_you`: `by` (`member`, `agents`, or `agent:<id>`), `source` (a `kind`), `q` (up to 100 characters: every word, by prefix, in the title or note). `limit` 1 to 100 (50); `next` is opaque, or `null` at the end.

**Errors:**

| Error | `details` | Meaning |
|---|---|---|
| `bad_request` | `{reason}`: `id`, `view`, `title`, `note`, `due`, `until`, `as`, `ids`, `q`, `cursor`, `format`, `by`, `source` | A param it doesn't take. Nothing changed |
| `not_found` | `{reason: "item"}` or `{reason: "event"}` | No such item or event (gone from the Trash, or removed a year after it closed) |
| `precondition_failed` | `{reason: "rev", rev}` | `todo.update`'s `rev` isn't the item's: refetch, reapply the member's fields (field by field, last writer wins) and send again |
| `conflict` | `{reason}`: `closed` (an update or snooze of a closed item), `trashed` (anything but restore and undo on a trashed item), `no_suggestion`, `changed` (an undo whose fields were changed again since), `idem` | Nothing changed |
| `conflict` | `{reason: "cap", which: "open"}` | 2,000 open items on the desk |
| `unavailable` | `{reason: "store"}`, `{reason: "switched_off"}` | Above |

**Undo** (`todo.undo {eventId}`): an event's `before` goes back onto the item when the fields it changed still hold its `after`, else `conflict` `{reason: "changed"}`. An `add`'s undo closes the item as `not_needed` (it stays deduped, so the same message doesn't bring it back); a `merge`'s takes that source out of `alsoFrom` and puts the date back; a `close`'s reopens; a `trash`'s restores. An undo is itself an event (`undo`), with its own undo.

### Topic `todo`

SUB (owner only) gets a `snapshot` of `{rev}`, then `changed` events `{op, id, rev}` after every change by anyone (the member's other devices, an agent's tool, the nightly tidy), at most 100 ms after it commits. `op` is the event's (`add`, `edit`, `close`, `reopen`, `snooze`, `pin`, `suggest`, `answer`, `merge`, `trash`, `restore`, `undo`, `seen`, `remove`). Coalescible: a client that fell behind gets a fresh `snapshot`, then calls `todo.changes {since}` with the last `rev` it applied. Ids only, never a title.

### What deskd does on its own
- **Dedupe**, for every agent add, in this order (a hit isn't an error):
  1. **The same source and the same to-do:** an item with the same `(source.kind, source.ref)` and the same normalised title (NFKC, lower case, punctuation and stop words out), in any state, made in the last 30 days: nothing is added, the existing item is answered (`created: false`). So the same message read twice, at once or across a restart, makes one row, and one the member dismissed doesn't come back.
  2. **The same thing again from the same source or scope:** an open item from the same `source.ref` or the same scope (the Courier channel, which is the conversation with that contact; the same page, file or site) whose normalised title shares at least 80% of its words (token Jaccard ≥ 0.8), made in the last 14 days: merged. The new source goes into `alsoFrom` (5 at most), `mergeCount` goes up, and a later date wins only if the item's date is an agent's. An event `merge`, with Undo. The member sees "A reminder from {sender} was merged in".
  3. **Closed in the last 30 days:** the same scope and a similar title, closed: not added, unless the new date differs.
  4. **The agent's `same_as`:** merged into the open item it names (`not_found` or `closed` otherwise).

  **Measured** on a hand-labelled set of 530 to-dos from 476 messages (`deskd/src/test/resources/todo/dedupe/`, `TodoDedupeEvalTest`): rules 1 to 3 never merge two different tasks (precision 1.0) and catch every message read again, but catch only 4.5% of a real inbox's repeats, which are mostly paraphrases. Recall is rule 4's: the model's judgement with the open list in front of it, measured by its capability run.
- **Caps** (an agent's add past one is refused `cap`, `details.which`; the member's own adds count only towards `open`):

| Cap | `which` | Value |
|---|---|---|
| Adds and merges per run | `run` | 10 |
| Adds per agent per day (the member's midnight) | `agent_day` | 30 |
| Agent adds per desk per day | `desk_day` | 100 |
| Open items per desk | `open` | 2,000 |
| Suggestions per agent per day | `suggest_day` | 20 |

- **The tidy**, nightly and at start: closed items go 365 days after they closed, the Trash empties after 30 days, events go with their item, `idem` results after 30 days, and the change log keeps 30 days or 50,000 changes. Each removal is a `remove` change.

### The agent's To-do tools (§18)

`tool.todo.*` on the agent socket, through `ToolHost` like Files and Notebook: no client reaches them. Every call acts as the agent's owner on this desk only, under scopes `todo:read` and `todo:write` (the setup screen's To-do app, §18 "An agent's access"). Not offered on a Guild Desk, nor where the Agent is off (teens).

| Tool | Input | Class | Taints | Returns |
|---|---|---|---|---|
| `todo_list` | `{view?: "needs_you" \| "open" \| "done", by?: "me" \| "member" \| "agent:<id>", source?: <kind>, due_before?: "YYYY-MM-DD", q?: ≤ 100, limit?: 1–50 (20), cursor?}` | read | `S`; `U` if any item returned is `untrusted` | `{items: [{id, rev, title, due, state, by, source: {kind, label}, untrusted, suggestion?}], next?}`. No notes |
| `todo_get` | `{id}` | read | `S`; `U` if it's `untrusted` | The item with its note, sources and last 20 events |
| `todo_add` | `{title, note?, due?: {date, time?}, source: {kind: "courier" \| "notebook" \| "browser" \| "files" \| "agent_chat" \| "desk", ref}, same_as?: id}` | write | | `{id, created, merged?, rev}`. `same_as` names an open item the agent judges the same task (from `todo_list`): the new source is merged into it, as a code merge is. `agent_chat`'s `ref` is `{}` |
| `todo_update` | `{id, rev, title?, note?, due?: {date, time?} \| null}` | write | | `{id, rev}` |
| `todo_close` | `{id, as: "done" \| "not_needed", reason: ≤ 140}` | own (a suggestion), rising to write (a close) | | `{id, result: "closed" \| "suggested"}` |

**deskd's checks, before anything else** (after `ToolHost`'s own: the area, the setup record, the run's taint):
- **Provenance:** `source.ref` must be something this run was given by a tool deskd hosts (a Courier message `courier_read` or `courier_new` gave it whole, not a search's hit or a list, §21; a page `notebook_read` read, a URL a `browser_*` result read, a path `files_read` read; a search hit or a listed page isn't read; deskd's own record per run in its run ledger), or for `agent_chat` the member's message that started this run (deskd's own record of the `agent.message.send` it relayed), or for `desk` a message from another of the member's desks deskd gave this run (§18, "To-do's source kind `desk`"). Otherwise refused `source_unknown`. A deskd restart forgets a run's record, so the model reads the source again.
- **Fields:** `label` from deskd's record of that source, `untrusted` from deskd's copy of the run's taint, `by` and `runId` stamped. A `due` more than 1 day in the past or 400 days ahead is `invalid`; a title or note with an address stays plain text.
- **Caps and dedupe** as above. A dedupe hit or a merge isn't an error.

**When it runs without asking** (the `todos` group of the draft ADR's §15: the member's "Add to-dos, and tick off ones it added" switch for this agent, in deskd's own record; with it off, each of these asks on a card, and the rest is unchanged). deskd decides each call from its own facts: the item's `by` and `runId`, its copy of the run's taint, and whether the run is **attended** (started by the member's own message, by deskd's record of the `agent.message.send` it relayed; a timer, another agent or Maia is unattended). **Clean** is a run without `U`.

| Call | Clean, attended | Clean, unattended | With `U`, attended | With `U`, unattended |
|---|---|---|---|---|
| `todo_add` | without asking | without asking | without asking with a `courier` or `browser` source the run read; else a card (Security's ATA-L1, TD-L1) | the same; else a card |
| `todo_update`, its own item | without asking | without asking | a card | a card |
| `todo_update`, the member's or another agent's | a card | refused `not_yours` | a card | refused `not_yours` |
| `todo_close`, its own item | closes without asking | closes without asking if from this run; else a suggestion | a card | a suggestion |
| `todo_close`, any other | a card | a suggestion | a card | a suggestion |

A suggestion (`result: "suggested"`) closes nothing: it puts "Looks done?" on the item for the member's tap (`todo.answer`), never asks, and needs no switch. From a run holding U it marks the item `untrusted`, and the suggestion carries `untrusted: true` (its reason is the model's words). A `same_as` add's card names the item it merges into (`target.mergeInto: {id, title}`); from a run holding U it adds the source only and never moves the date; merges count toward the run's 10.

**Refusals** (the model reads "Not allowed: {reason}."): `cap` (`details.which`), `source_unknown`, `not_yours`, `stale` (the item's `rev` moved: get it again), `closed`, `trashed`, `invalid` (with `details.field`), `not_found`.

**Words:** the card "Add {title} to To-do", "Change {title} in To-do", "Mark {title} done in To-do"; the chips "Looked at your to-dos", "Added a to-do", "Merged into a to-do", "Already on your to-dos", "Changed a to-do", "Marked a to-do done" or "Marked a to-do not needed" (by the close's `as`), "Asked if a to-do is done" or "Asked if a to-do is still needed" (a suggestion, by its `as`). A chip never holds the title: its `target` (`{kind: "todo", id, title}`) is the card's, for the app to open the item.

**Audit:** desk-agent's `tool.call` rows (ids and the payload hash only) and `approval.*`; the item's text lives only in `todo.db` and its `events`.

**Undo** of an agent's change is the member's: `todo.undo` on its event, or `agent.approval.undo {approvalId}` (§15), which reaches the same undo through `ToolHost` by the call's approval id (`TodoTools.undoAuto`; the store's undo by approval id always names the agent, and there's no form without it). A call done without asking writes under its own key, `auto:<approvalId>`, a space no member's approval can use: it runs once (a key the store has seen is `approval_used`), and its undo takes back only that agent's events under that key, never a change the member approved on a card (Security's AAB-L2).

## 23. Maia Mode: Desk Maia

**Contract for Maia Mode Phase 1, `sub/mm-maia-runtime`** (the room UI, `sub/mm-maia-room`, builds against this with a mock; the design is `CONCEPT.md` Part 2, the draft ADR is [`draft-desk-maia.md`](../../../docs/decisions/draft-desk-maia.md)). Desk Maia is the Maia who runs on the member's **home desk** in Maia Mode: a built-in agent in desk-agent with the fixed id **`maia`**. **She runs on Minimalist Alliance's AI service, never a member's key** (the owner, Nov 14: "Maia ALWAYS runs on the company account"): every model call of hers goes through deskd to her service ("Her model", below; ma-platform `docs/contracts/desk-maia.md`), which picks the model and owns her Maia Mode instructions, and meters each call against the member's Maia allowance, **in credits, never money** (the owner, Nov 15: members never see a dollar figure for Maia; "Her allowance in credits", below). Her calls are Minimalist Alliance's: they never count on the member's own-key limits, and the only cap of the desk's on her spend is one the member sets in credits (`caps.coordinatorDailyCredits`, below). Members never add a key for her; their own desk agents keep their own keys. Support Maia ("Account help", ma-platform `docs/maia.md`) is unchanged. Everything else here stays on the desks: the office (the switchboard, ma-platform `docs/maia.md` §9) talks to each desk over its own data channel, and desks never connect to each other.

**Dark by default, listed desks only, and a kill switch.** Maia Mode is off on every desk until the member turns it on (`agent.maia.set {on: true}` below), and the Platform flag (`client-config` `maiaMode`, the Platform builder's) decides who sees the switch at all. The desk's own switch is `/data/agent/maia-switch` (or `DESK_AGENT_MAIA` in `desk-agent.env`), read at every call:

| Switch | The desk |
|---|---|
| No file, no variable | **Not listed:** Desk Maia is refused here (`forbidden` `{reason: "not_listed"}`); `{maia}.listed` is `false`. The Platform's list (`/v1/me` `maiaMode.enabled`) doesn't reach a desk yet, so a desk is listed only by its switch: in Phase 1 the release writes `on` on the owner's desk alone |
| First line `on` | **Listed:** the member may turn Maia Mode on |
| First line `off`, any other text, a file that isn't a plain file or can't be read, or `DESK_AGENT_MAIA=off` | **Killed:** off at once, whatever the member chose (`{maia}.killed: true`, everything above is `forbidden` `{reason: "maia_off"}`, her runs stop within 10 minutes and her `desk_message` is refused). `off` wins over `on` |

Taking things away always works, whatever the switch says: `agent.maia.set {on: false}`, `agent.maia.grant.revoke`, `agent.maia.forget` and `agent.maia.todos.set {on: false}`; so do the reads (`get`, `grants.list`, `choices.get`, `notes.list`). Everything else, and every message to `maia`, needs the desk listed and Maia Mode on. A teen's desk refuses all of it (`forbidden` `{reason: "age_band"}`, as every `agent.*` method, §11); a Free desk and a Guild Desk refuse `agent.maia.set {on: true}` (`forbidden` `{reason: "tier"}`, `{reason: "guild"}`): deskd refuses it on a Free desk itself, by its own tier record, before desk-agent hears.

**Her chats are kept 90 days.** Every 10 minutes (and at desk-agent's start) the desk deletes her messages older than 90 days with what they kept: their approvals, runs, steps, results and marks, her reply extras, and her thread's summary; her note log goes at 90 days too, and held notes at 7 (below). The disclosure says so. `agent.maia.forget` deletes all of it at once.

### Who may call

| Method or topic | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `agent.maia.*`, topic `agent.maia` | yes, on the member's home desk (any desk of theirs that isn't a Guild Desk) | `forbidden` `{reason: "scope"}` | `forbidden` `{reason: "permission"}` |
| `agent.usage.summary` | yes, on every desk (the team view reads each desk) | `forbidden` `{reason: "scope"}` | `forbidden` `{reason: "permission"}` |

Mutations need `idem` (§4) and a session that may act (a token with input), as `agent.approval.decide` does: an owner token without input gets `forbidden` `{reason: "permission"}` from deskd before desk-agent hears. **No step-up:** the owner's rule of Nov 7 removes step-up and sign-in-age checks (Security's ATA Q3); the controls are a session that may act, the grants' expiry and revoke, and the hash-chained audit on each desk.

### Desk Maia as an agent
- **Her thread is an agent thread:** `agent.thread.get {agentId: "maia"}`, topic `agent.conversation:maia`, `agent.message.send {agentId: "maia", text, choice?}`, `agent.run.stop`, `agent.approvals.list`, `agent.approval.decide` and `agent.approval.undo` all work for her as §11 and §18 say. Her limits are `agent.limits.*` with `agentId: "maia"`: since Nov 15 only her run's step count binds her there (no dollar limit does, and her usage shows no dollars).
- **Her binding is the desk's own:** key `ma-maia` (Minimalist Alliance's service, which holds no key material on the desk and is in no key list), provider `ma` (in no `agent.providers` list; `agent.key.add` refuses it), model `turn` (a task, not a model). It's set when her row is made and again at every start (a desk that bound her to a member's key before Nov 14 is rebound), and `agent.bind {agentId: "maia", …}` is `forbidden` `{reason: "company"}`. No other agent can bind `ma-maia`. A reply of hers is badged `ma`, "Minimalist Alliance", model `maia`: never a model's name.
- **Her memory** (`agent.memory.*` with `agentId: "maia"`) goes with every run of hers to her service, so it keeps Support Maia's rules (ma-platform `docs/maia.md` §16): only how the member likes answers, how she can help and what they've set up, never anything private (details of their life, money or health, other people, contact details, what's on their desks). Her instructions say so, and code refuses a private-shaped line (`refused:private`, the Platform's check ported); a line saved before Nov 14 that fails the check stays listed for the member but is never pinned into her runs. Other agents' memory is unchanged.
- **She isn't a team agent:** `agent.list`, `agent.state`'s `agents` and the lead's tools don't list her; `agent.update`, `agent.delete`, `agent.links.set`, `agent.timer.*`, `agent.workspace.*`, `agent.icon.*` and every proposal answer `not_found` `{detail: "agent"}` for `maia`; no agent may `message_agent` her. She exists from `agent.maia.set {on: true}` and stays (her thread is the member's) until `agent.maia.forget` (below).
- **Her access** is an agent's access (§18, "An agent's access"), which the member saves when turning Maia Mode on, from their own session, so deskd records it: `agent.access.set {agentId: "maia", apps: {notebook: true, files: false, browser: false, courier: false, todos: true}, auto: {notebook: {tabId: <the From Maia tab>}, files: null, todos: true}}`. Turning Maia Mode on doesn't save it for the member; the room's first-run sheet does, with the disclosure. Until it's saved, a message to `maia` answers `precondition_failed` `{reason: "setup"}` as for any agent.
- **Her briefs to other desks** are `desk_message` under the member's grants (§18, "Messages between the member's desks"): the room's grant sheet makes the send half with `agent.access.set {agentId: "maia", desks: [{deskId, deskName, on: true}]}` on the home desk and allows it on the other desk with `agent.desks.answer {grantId, allow: true, agentId}` (the agent that answers her there, the Lead by default), then sets Maia's own scope for that desk with `agent.maia.grant.set` (below).

### Her model (Nov 14: the company account)

desk-agent can't reach the Platform (nftables, ADR 0010 and 0019), so each model call of hers is a `tcall` on the agent socket with **`tool: "maia_model"`**, which deskd relays to Desk Maia's service on Minimalist Alliance's AI account and never to the tool host:

```json
{ "t": "tcall", "id": 41, "agentId": "maia", "tool": "maia_model", "taint": [],
  "args": { "task": "turn", "callId": "0192f1c4-7a1e-7b3c-9d2e-5f6a7b8c9d0e",
            "context": "The member's home desk adds (data from the desk, not the member): …",
            "messages": [ { "role": "user", "text": "Compare three laptops under $1,000" } ],
            "tools": [ { "name": "desk_message", "description": "…", "inputSchema": { "type": "object" } } ],
            "maxOutputTokens": 4000,
            "note": "Now: Sunday 15 November 2026, 1:05 PM in the member's time zone.\nYour choice weight for this member is 0.8 (0 to 1).\nBriefs left today: 58.\nMaia credits: 1,550 of 2,500 left this month (renews 1 December).\nToday's and this week's shares are used, so this is coming from this month's." } }
```
- **`args`** are the contract's request fields only (`task`, `callId`, `context`, `messages`, `tools`, `maxOutputTokens`, `units`, `note`; ma-platform `desk-maia.md` 0.4.8; `units` is `"credits"`, which desk-agent sends on every task so the answer carries its cost in credits and no `costMicroUsd`, Security's MC-M1; its value is the service's to check, anything else being its `400` `units`): the **task** (`turn`, her first call of a run; `step`, a later call after tool results; `notes`, the note-taker's small job with no tools), never a model. `messages` start and end with the member's turn, same-role turns joined; a file is never sent, only a line naming it (`[Attached: name]`). desk-agent waits up to 160 s.
- **Context and note (Nov 15, prompt caching).** Her service puts its own instructions first, then `context`, then the thread, with cache breakpoints on `context` and on the thread's last block, so any byte that changes in `context` throws away the cache for everything after it. So **`context` is byte-stable across a session**: the desk's part that changes only when a grant or her memory does (her desks and grants, the choice rule, a line saying what the note holds, her memory, the desk's tool rules; for `notes` the note-taker's rules). Her Maia Mode instructions are her service's. **`note`** carries what changes on every call, one a line: the time to the minute in the member's zone, her choice weight, briefs left today, her Maia allowance as her service's last answer reported it (left out before any answer and once it has reset), **never a dollar figure for her own usage** (her briefs' cost on the member's own agents is the wallet's lines, the member's money, in dollars: "Her briefs and the member's wallet", below): with credits (contract 0.4.8) "Maia credits: 1,550 of 2,500 left this month (renews 1 December)." and one pace line when today's share is used ("Today's share of the member's credits is used, so this is coming from this week's." / "Today's and this week's shares are used, so this is coming from this month's." / "The month's credits are used; this is coming from top-up credits: 300 left."), or on the lighter model a line telling her so ("...you're on a lighter model until they renew (1 December) or the member tops up: say so plainly once, keep helping, and never stop because of it."); without credits (a shared tier, an older Platform) the share left and its reset in the desk's zone ("Maia allowance left: 64% (resets 5:00 pm)."); then "Credits today on this desk: 12.5 of the member's own day cap of 200." only when the member set one, and a plain stop line only when her service refused her (`limit`). No day or week lockout line. Her service sends the note after the thread, as the last text of the newest user turn, outside every cached prefix, labelled as the desk's data. At most 2,000 characters, line breaks allowed, no other control character; empty means the field isn't sent (the note-taker never has one). A run's steps carry the note its start made.
- **deskd sends** `POST {endpoints.maia}/v1/desk-maia/call` with the body `{"v": 1, …args}` and a fresh `X-MA-Desk-Auth` per call: the gateway's desk proof (a signed `sts:GetCallerIdentity`, base64url JSON) with two more signed headers, `x-ma-maia-id` (the config's `endpoints.maiaId`) and `x-ma-body-sha256` (lowercase hex SHA-256 of the exact body sent), by the desk role's current credentials, fetched again once on a `401` with `reason: "desk_auth"`. 150 s for the whole answer; an answer over 2 MiB isn't read. Nothing of a call, its answer or the proof is logged: an outcome word and sizes at most.
- **deskd's own checks come first, by its own facts** (never desk-agent's word), in this order: the agent is `maia` (else `forbidden` `{reason: "not_maia"}`); not a Guild Desk (`guild_desk`); the owner is an adult by deskd's band (`teen`, an unknown band included); not on the free tier by deskd's tier record (`free`); the service is configured (`unavailable` `{reason: "no_service"}`); `args` an object with only the fields above (`bad_request` `{reason: "args" | "field"}`) and the body at most 3 MiB (`too_large` `{reason: "body"}`); at most 4 relayed calls at once (`rate_limited` `{reason: "maia_model"}`). Each call runs on its own virtual thread; the socket's reader never waits.
- **The answer:** `tres` with `r` the service's 200 body as it came (`{v, text, toolCalls, stopReason, usage, costCredits, allowance}`, and `costMicroUsd` only for a request without `units`; deskd reads none of it, so contract 0.4.8's fields pass through as they came), or `terr` with `code` the service's `error.code` (`limit`, `rate_limited`, `unavailable`, `forbidden`, `bad_request`, `too_large`, `unauthenticated`, `desk_mismatch`, `desk_destroyed`) and `details` carrying only `reason`, `resetsAt` (ISO 8601 UTC), `window` (`day`, `week`, `month`, `memberTrial`) and `retryAfterSec`, each as given when it has its shape. deskd's own `unavailable` reasons: `no_service`, `unreachable` (no connection, or an answer with no envelope), `timeout` (no whole answer in 150 s: the call may have been made), `response` (an answer deskd won't read).
- **The hello:** deskd's tools hello (`desk.tools.hello`) carries **`"maia": {"model": true}`** while the service is configured (both `endpoints.maia`, an https URL, and `endpoints.maiaId`, `maia.` and 3 to 200 of `[a-z0-9.-]`, in `GET /v1/agent/config`; anything else reads as absent). When that changes after a connection's hello (the endpoint first appears), the hello is sent again. An older desk-agent ignores the field.
- **In desk-agent:** until the hello offers it, a message to `maia` is refused `unavailable` `{reason: "no_service"}` before anything is added to her thread, and no `maia_model` call is sent. Her run ends cleanly on any refusal: `failed` with `error: "provider_error"` and `errorDetail` `limit`, `unavailable`, `rate_limited`, `forbidden`, `bad_request` or `too_large` (after `too_large` her thread is compacted if it has grown past the budget). **On `limit`** the reply also carries `limit: {reason, window, resetsAt}` (`limit_personal`, `limit_pool` or `limit_trial` from her service; `limit_cap` with window `day` and the desk's next midnight when the member's own day cap in credits is reached, below), for the room's one line with the reset in the member's own time as a date or a time of day, never a countdown, and **nothing more is sent until `resetsAt`**: each call before then is refused on the desk with the same details. With Maia Mode credits a service `limit` is rare: past the month's credits and top-ups she keeps working on a lighter model. **Not billed means not billed:** a refusal before the call settles nothing on the desk's ledger; a call that may have been made (no answer came, deskd's `timeout`) keeps its reservation.
- **No thinking goes back (Nov 15, the staging proof; `sub/mm-away-fixes`).** desk-agent sends back only the Responses wire's encrypted `reasoning` items on her calls, never `thinking` or `redacted_thinking`. Her service puts `note` after the newest turn on the member's side and the next call's note after the next one, so every turn before a thinking block has changed by the time it's sent back; Opus 5.5's preserved thinking (enforced for accounts made from Aug 31, 2026, the company's among them) refuses such a request with a 400 before any output, which her service answers `unavailable` `{reason: "provider"}`. On staging every step after a call in which she thought failed so (8 of 8), and none after a call without thinking (7). Without thinking blocks there is nothing to check; she thinks afresh each step, and the cache is unchanged. Sending her reasoning back again needs her service to keep each call's note in its turn (a contract change, ma-platform `desk-maia.md`).
- **The desk's ledger (Nov 15):** her calls are the company's, never the member's money. They're rows of the usage ledger for her run's step count and token counts, but they reserve and settle **no dollars** (the answer's `costMicroUsd` is never kept; dollars an older desk-agent settled on her rows count as none), they're left out of the desk's day and month and a key's month (her spend never uses up the member's $20 desk month), and no dollar limit binds her: her agent's day, week and month, the desk's, a key's and a run's. Her reply's `costMicroUsd` is null, and `agent.usage.summary` and `agent.limits.get` show her at $0.
- **One wallet (contract 0.4.10 with desk-helpers.md, the coordinator's decision of Nov 15).** Every tier's Maia Mode draws from the member's **one credits wallet**, shared with their agents on MA's credits (§24): the tier's monthly Maia allowance (it renews each billing month at `renewsAt` and doesn't roll over; 0 for a tier without one, Alliance by default), the one-time starting credits (210 by default) and any top-ups land in one balance, spent month first, then starting, then top-ups; the day and week amounts pace the whole wallet and never lock it; past everything, the lighter model on one daily lighter share per tier (`drawingFrom` `lighter`, `lighterLeft`), or `none` for a plan with no lighter share (Free, unpaid: a plain "used up", never the lighter model). Her answer's `allowance.credits` is then the same object as a helper's `credits`: `{left, month, monthLeft, starting, topUp, topUpLeft, day, dayUsed, week, weekUsed, drawingFrom, lighter, lighterLeft?, renewsAt}`. desk-agent keeps **one view, the newest from either service** (`provider/ma/CreditsWallet`, until its `renewsAt`), for the room's `allowance.credits` (with `left`, `starting`, `lighterLeft` besides), her note ("Credits: 1,760 left (1,550 of this month's 2,500, 210 starting), shared with the member's agents; this month's renew 1 December.", one pace line: week, month, `starting`, `topUp`; the lighter line with today's share; a plain line for `none`) and the Keys list's credits row (§24). An answer without `left` (0.4.8) is Desk Maia's own credits, as before. Her refusals from the wallet: `429 limit` `credits_used` (no reset: the desk holds a minute, as for an agent) and `limit_lighter` / `limit_pool` (`window: "day"`, the next midnight UTC); the room says "Your credits are used up for now." and "Today’s lighter-model share is used up. It resets …". Each call's `costCredits` is also counted per agent a day on the desk (`limits/CreditDays`, table `credit_days` of `agent.db`) for the team view's usage per source.
- **Her allowance in credits (contract 0.4.8, the owner's decisions of Nov 15).** Every Maia Mode turn is her service's model choice (the desk never picks one). Each 200 may carry `costCredits` (what the call drew, up to 2 decimals) and `allowance.credits` `{month, monthLeft, week, weekUsed, day, dayUsed, topUpLeft, drawingFrom}` (whole credits, for a tier with Maia Mode credits; absent for a tier that shares its Maia allowance) and `allowance.lighter`. With credits, `allowance.fraction` is the month's share left and `resetsAt` the month's renewal. The day and week amounts **pace only**: no lockout and no countdown; past today's share she draws on the week's, then the month's (`drawingFrom` `day`, `week`, `month`), then top-up credits (`topUp`), then she keeps working on a lighter model (`lighter`, with `allowance.lighter: true`) until the month renews or the member tops up. desk-agent keeps the last `allowance` until its `resetsAt` (`MaiaServiceProvider.allowance()`), and counts each call's `costCredits` per day in the desk's zone (`maia_counts` kind `credits`, in hundredths of a credit) for the member's own cap. An older Platform sends none of these: her note and the room show today's share left, and nothing is counted. The credit's dollar value is a Platform setting the desk never gets.

### `agent.maia.*` methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.maia.get` | No | None | `{maia}` (below) |
| `agent.maia.set` | Yes, input | `{on?, disclosure?, attention?, caps?, notesTabId?, homeDeskId?, noteRules?, budget?}` | `{maia}`. `on: true` needs `disclosure: "maia-mode-v2"` unless the desk already holds it (the version the member accepted) and makes her agent, bound to her service; on a desk that holds only `maia-mode-v1` it records v2 (audit `maia.disclosure`). `on: false` revokes every Maia grant at once and stops her runs (notes and to-dos stay: they're the member's) |
| `agent.maia.forget` | Yes, input | `{}` | `{maia}`: "Delete Maia’s desk history" (the menu's words): her thread, her note log and her choice counts. Grants and the setting stay |
| `agent.maia.observe` | No | `{desks, typing?, focus?}` (below; `focus` and each desk's `courier` and `docs`: "What reaches the member") | `{}`: what the office sees on the member's desks, for the list. Kept in memory only, never written |
| `agent.maia.typing` | No | `{typing}` | `{}`: the member is typing in her chat (`true`), or stopped (`false`; also after 20 s without a `true`) |
| `agent.maia.seen` | No | `{back?: true}` | `{}`: the member looked at the list; `back: true` when they return to the room after 5 minutes away (the batch is due) |
| `agent.maia.item.snooze` | Yes | `{itemId}` | `{item}`: "Later", 2 hours or until the next `back` |
| `agent.maia.item.dismiss` | Yes | `{itemId}` | `{}`: out of the list. An approval, a limit or a failed desk can't be dismissed (`bad_request` `{reason: "kind"}`): they leave when resolved |
| `agent.maia.choose` | Yes, input | `{messageId, choiceId}` | `{messageId, runId}`: the member tapped a choice. The choice's label goes to her as the member's message, exactly as `agent.message.send` would send it. On code's own question about held notes (`choices.kind: "notes"`) it files those notes instead and starts no run: `{messageId}` |
| `agent.maia.choices.get` | No | None | `{choices}`: `{weight, offered, tapped, other, ignored, askedMore, askedFewer, updatedAt}` |
| `agent.maia.choices.reset` | Yes, input | `{}` | `{choices}`: the counts to 0 and the weight to its start (0.8) |
| `agent.maia.grants.list` | No | None | `{grants}` |
| `agent.maia.grant.set` | Yes, input | `{deskId, deskName, scopes, days?, keepsToItself?}` | `{grant}`: creates or extends Maia's grant for that desk. `scopes` ⊆ `["brief", "show"]`, `days` 1 to 30 (7) from now. deskd records it itself (§18's rule for `AccessRecord`) |
| `agent.maia.grant.revoke` | Yes, input | `{deskId}` | `{grants}`: at once; her next brief to that desk is refused |
| `agent.maia.note.file` | Yes, input | `{noteId, area}` | `{note}`: the member's answer to "could go either way": `area` `work`, `personal` or `drop` |
| `agent.maia.notes.list` | No | `{day?}` (`YYYY-MM-DD`, the desk's zone; today) | `{notes}`: the day's notes, ids and states (below), for "Show me" and "Undo today's" |
| `agent.maia.reach.*` | Below | | The focus shield's settings, answers, hold, Back and learned rules: "What reaches the member", below |

**Refusals:** `forbidden` `{reason: "maia_off"}` (Maia Mode off, or the kill switch), `{reason: "not_listed"}` (the desk's switch doesn't list it, above), `{reason: "tier"}`, `{reason: "guild"}`, `{reason: "permission"}` (no input), `{reason: "age_band"}`, `{reason: "company"}` (`agent.bind` for her); `precondition_failed` `{reason: "disclosure"}` (turning on without the version in force, `maia-mode-v2`; and every message to her and every turn of hers while the desk holds only `maia-mode-v1`, which said she ran on the member's key: the room shows the new disclosure); `unavailable` `{reason: "no_service"}` (a message to her while deskd's hello doesn't offer her model); `bad_request` `{reason, detail}` for a malformed field; `not_found` `{detail: "item" | "message" | "choice" | "note" | "grant"}`; `conflict` `{reason: "answered"}` (a choice already answered or passed by).

### `{maia}`

```json
{ "on": true, "killed": false, "listed": true, "agentId": "maia", "disclosure": "maia-mode-v2",
  "home": { "deskId": "d-…" },
  "attention": { "visible": 3, "nowMax": 1, "interruptEveryMin": 15, "batchEveryMin": 30,
                 "quietWhileTyping": true, "todosVisible": 1 },
  "caps": { "coordinatorDailyCredits": null, "startedRunsDailyUsd": 4, "briefsPerDay": 120, "notesPerDay": 100,
            "todosPerDeskPerDay": 40 },
  "notesTabId": "tab-…", "choices": { "weight": 0.8 }, "updatedAt": 1763100000000 }
```
- `attention`: the concept's §3 settings, each within its range (`visible` 1 to 5, `nowMax` always 1, `interruptEveryMin` 5 to 120, `batchEveryMin` 10 to 240, `todosVisible` 1 to 3); out of range is `bad_request` `{reason: "range", detail}`.
- `caps`: each one's top is the Platform's tier value (`maiaMode` in the tier deskd last sent) when it sends one, else the default: `startedRunsDailyUsd` 2 (her briefs' runs on the member's own agents and keys: the member's money, so dollars), `briefsPerDay` 60, `notesPerDay` 50, `todosPerDeskPerDay` 20. The member may lower each, never raise it past its top (`bad_request` `{reason: "above_tier"}`). **Her own spend has no cap of the desk's** (Nov 15): her service's allowance, in credits, per tier in the Platform's settings, is the limit, and its day and week amounts only pace her. `coordinatorDailyCredits` is the member's own day cap on her, if they want one: whole credits from 0 to 1,000,000 against what her calls drew on this desk today (the sum of her service's `costCredits`, in the desk's zone), `null` for none (the default; `null` clears it); the Platform never sets it. Once reached her note has said where she stands, her briefs stop (`maia_cap`), at 80% it's a Now item, and her next turn and step are refused on the desk as `limit` `limit_cap` until the desk's next midnight (the note-taker's small job isn't). **`coordinatorDailyUsd` is retired:** her calls are the company's, so a dollar cap means nothing on the desk; one stored before binds nothing and is dropped at the next change of caps, sending one is `bad_request` `{detail: "caps.coordinatorDailyUsd"}`, and the Platform's tier value of that name is ignored. No screen ever set one (the room has no caps setting), and the old desk-written day limit on her ledger row ($3, or the agent default $5) no longer binds her, so nothing a member chose is lost.
- `budget`: the member's own comfort for her briefs (their agents, their keys; "Her briefs and the member's wallet", below): `{dailyUsd, askAboveUsd, alwaysOk: [{deskId, agentId, upToUsd, at}]}`, $3 and $0.50 by default. `agent.maia.set {budget: {dailyUsd?, askAboveUsd?, alwaysOk?}}` sets each from 0 to 1,000 (`bad_request` `{reason: "range", detail}`); `alwaysOk` only ever narrows (a list of entries already there, `bad_request` `{reason: "narrow_only"}` otherwise): a new one comes only from the member's tap on code's card. It's never a desk's limit and no tier caps it; she has no tool that changes it.
- `homeDeskId`: the desk this is, as the office knows it from `GET /v1/desks`; she may show things on it without a grant. `noteRules`: the member's own routing words for notes, `[{word, area: "work" | "personal"}]`, at most 20, each word 1 to 40 plain characters; code applies them over the note-taker's area. `todos`: who files to-dos from Courier here (below).
- `trackerCollapsed` and the startup chooser (`startup: {ask, mode}`, `lastMode`) **are not on the desk**: they're the member's prefs on the Platform, beside `prefs.theme` (the Platform builder's), because the loader needs them before any desk connects.

### Topic `agent.maia` (the room's state stream)

SUB with no params, owner tokens only, on the home desk. Every event is `{"type": "snapshot", "data": {room}}`, the whole room on each change (coalescible, no `since`, as `agent.state`). The list, its urgency and its words are code (desk-agent `maia/Attention`), never the model's.

```json
{ "on": true, "killed": false,
  "status": { "desks": 2, "agents": 5, "working": 2, "line": "Watching 2 desks · 5 agents · 2 working" },
  "todo": {
    "items": [
      { "id": "mi-…", "kind": "approval", "urgency": "now", "deskId": "d-…", "deskName": "Work",
        "title": "Scout needs your OK on Work", "count": 1, "expiresAt": 1763103600000,
        "action": { "kind": "approvals", "deskId": "d-…", "approvalIds": ["ap-…"] },
        "createdAt": 1763100000000, "state": "new" } ],
    "later": { "count": 2, "lines": ["6 notes today", "Personal is asleep"] },
    "open": 3, "now": 1, "held": 0 },
  "allowance": { "fraction": 0.62, "resetsAt": "2026-12-01T07:00:00Z", "usedUp": false, "lighter": false,
                 "credits": { "month": 2500, "monthLeft": 1550, "week": 800, "weekUsed": 120, "day": 200, "dayUsed": 90,
                              "topUpLeft": 0, "drawingFrom": "month" },
                 "today": 12.5, "cap": null },
  "foot": { "onIt": 2, "doneToday": 5, "line": "On it: 2 · Done today: 5 · Briefs today $1.20 of $3" },
  "briefs": { "todayMicroUsd": 1200000, "monthMicroUsd": 8400000, "budgetMicroUsd": 3000000, "desks": […],
              "line": "Briefs today $1.20 of $3" },
  "notice": { "itemId": "mi-…", "at": 1763100000000 },
  "show": null,
  "notes": { "today": 6, "held": 1 },
  "choices": { "weight": 0.8 },
  "connecting": false }
```

| Field | Meaning |
|---|---|
| `status` | From the last `agent.maia.observe`: the desks with a live link (not Guild Desks), their agents (Maia not counted), and how many are `working` (not waiting for the member or another desk). `line` is the template, ready to show |
| `todo.items` | **At most `attention.visible` (3), at most one `urgency: "now"`, the rest `next`**, ordered by code: Now, then Next by when it came. `title` is a template; any desk-written part (an agent's name, a desk's name) is plain text cut to 60 characters, hidden and bidi characters removed, never a link or Markdown |
| `todo.later` | What waits: a count and up to 5 template lines (notes filed, a desk asleep, snoozed items, account notices) |
| `todo.open`, `todo.now` | Counts for the collapsed edge ("For you, 3 items, 1 now" is the UI's words over `open` and `now`) |
| `todo.held` | New items held back while the member types, or until the next batch: they show when the member stops typing, on `back`, or at the batch (`batchEveryMin`) |
| `allowance` | Her Maia allowance as her service last reported it, **never money** (Nov 15; replaces `spend`, her cost in dollars, which an older room read and a new one never does): `fraction` and `resetsAt` (with credits, the month's share and its renewal: the room shows a date, never a countdown), `usedUp` (her service said `limit`), `lighter`, and `credits` as the service sent them (absent for a tier that shares its allowance, or an older Platform); all of those absent before any answer and once it has reset. `today`: what her calls drew on this desk today, in credits (2 decimals); `cap`: the member's own day cap on her (`caps.coordinatorDailyCredits`), or null. At 80% of a cap it's a Now item (`kind: "cap"`) |
| `foot` | `onIt`: her briefs still waiting on an answer; `doneToday`: briefs answered today. `line` is the template ("On it: 2 · Done today: 5 · Briefs today $1.20 of $3": her briefs' cost on the member's own keys, never her own usage) |
| `briefs` | Her day summary's money (Nov 15): what her briefs cost the member today and this month, `{todayMicroUsd, monthMicroUsd, budgetMicroUsd, desks: [{deskId, deskName, todayMicroUsd, monthMicroUsd}], line}`: on each desk its own ledger's figure (the office's last read) plus the estimates of briefs still out there; a desk the office hasn't read counts her estimates. Dollars, because it's the member's own agents on their own keys (their provider's bill); Maia's own usage is never in it. Null while Maia Mode is off |
| `notice` | The interrupt: set when a Now item arrives, **at most once every `interruptEveryMin` (15)**, never while the member types, and never with a sound (there's no sound field: the room plays none). The UI plays Maia's `noticing` beat once per new `notice.at` |
| `show` | A viewport request she made (`office_show`, below): `{showId, deskId, app, ref, open, at}`. `open: true` means open it now (unprompted shows at most once every 10 minutes, or the member asked); `open: false` means offer a "Show me" button instead. `app` is one of `notebook`, `files`, `agent`, `browser`, `todo`, `courier`, `approvals`; `ref` is an id the app knows, **never a URL**, in that app's shape (code checks it): `notebook`, `agent`, `browser`, `courier` an id of letters, digits and `_:-` (1 to 100, no dot); `files` a relative path (no leading `/`, `..`, `?` or `#`, 1 to 200); `todo` a view (`needs_you`, `all`, `today`, `upcoming`, `done`, `trash`, `courier`, `agents`) or an item id; `approvals` 1 to 20 approval ids joined by `,`; empty is the app's start. The UI opens only its own window parts for `(deskId, app, ref)` |
| `connecting` | No `agent.maia.observe` in the last 2 minutes: the room shows "Connecting to your desks…" |

**Item kinds and urgency (code, `maia/Attention`):**

| Urgency | Kinds and rules |
|---|---|
| `now` | `approval`: an approval on a desk that expires within 60 minutes. `limit`: a task stopped by a limit. `desk_failed`: a desk whose state is `failed`. `cap`: Maia's credits at 80% of the day cap the member set on her (`coordinatorDailyCredits`; none by default, so no item): "Maia has used 80% of the 200 credits you set for today", at 100% "...the 200 credits you set for today and paused". `todos`: a to-do due within 2 hours (by its `due`, never its words) |
| `next` | `approval` waiting (expiring later), `result` (a brief answered), `todos` (new to-dos from agents on a desk, one item per desk, "3 new to-dos on Work"), `notes_unsure` ("2 notes could go either way") |
| `later` | `notes` (filed today), `desk_asleep`, snoozed items, `account` |

Items of the same desk and kind merge into one with a `count` ("3 things need your OK on Work"). An item resolved anywhere (on the desk, in the Agent app, on another device) leaves quietly at the next observe. Only one Now shows: a second waits as Next, and takes the Now place when the first resolves. Maia can't make an item, raise one to Now or hide one: she has no tool for it.

**`action`** says what tapping the item does, as data: `{kind: "approvals", deskId, approvalIds}` (open that desk's own approval cards in the viewport: the decision is only ever `agent.approval.decide` on that desk), `{kind: "show", deskId, app, ref}`, `{kind: "result", messageId}` (scroll her chat to it), `{kind: "notes", day}`, `{kind: "wake", deskId}` (the office's own wake card), `{kind: "none"}`.

### `agent.maia.observe`

The office sends what it sees, on every change it hears (not on a timer: a background tab's timers throttle), at most 2 a second (more is `rate_limited`), each call the whole picture:

```json
{ "desks": [
    { "deskId": "d-…", "name": "Work", "kind": "work", "guild": false, "state": "running",
      "link": "open",
      "agents": [ { "agentId": "ag-…", "name": "Scout", "status": "working", "statusDetail": null,
                    "approvalsPending": 1 } ],
      "approvals": [ { "approvalId": "ap-…", "agentId": "ag-…", "expiresAt": 1763103600000 } ],
      "stopped": [ { "agentId": "ag-…", "messageId": "m-…", "reason": "limit_reached", "at": 1763100000000 } ],
      "todo": { "newFromAgents": 3, "dueSoon": [ { "id": "0193…", "title": "…", "dueAt": 1763104000000 } ] } } ],
  "typing": false }
```
- `state`: the desk's (`GET /v1/desks`): `running`, `starting`, `asleep`, `stopped`, `failed`. `link`: the office's data channel, `open` or `closed`. A Guild Desk is ignored.
- `agents`, `approvals`: from that desk's `agent.state` and `agent.approvals.list {state: "pending"}`; `stopped`: replies that ended `failed` with `limit_reached` in the last hour, from the conversation topics the office has open; `todo`: from that desk's `todo.summary` and `todo.list {view: "needs_you"}` (items with a time today).
- Names and titles are the other desk's text: desk-agent keeps them in memory only, cuts them to 60 characters and strips hidden and bidi characters, and her tools give them to her as untrusted data. Limits: 20 desks, 50 agents and 100 approvals a desk, 20 `dueSoon`; past them `too_large`.
- **For her wallet** (Nov 15, "Her briefs and the member's wallet" below), each optional and read leniently (a figure that isn't a number from 0 to 10¹² is no figure): an agent's **`budget`** `{dayLeftMicroUsd, monthLeftMicroUsd, runMaxMicroUsd, briefMaxMicroUsd, perTaskMicroUsd, tasks, perBriefMicroUsd, briefs}`, that agent's `headroom` from its desk's `agent.usage.summary`; and a desk's **`briefs`** `{todayMicroUsd, monthMicroUsd, today, month}`, that desk's `maiaBriefs`. The office reads each desk's team view when it connects and again when an agent there stops working (its spend just changed), at most once every 20 seconds a desk, never on a timer of its own. Counts and dollars only.

### A chat turn, with choices

She asks with choices whenever she can (the owner, Nov 12: ESSENTIAL). A reply of hers carries, beside §11's and §18's fields:

```json
{ "id": "m-…", "role": "assistant", "text": "Which laptops should I compare?",
  "choices": { "question": "Which laptops should I compare?",
               "options": [ { "id": "c1", "label": "Three under $1,000" }, { "id": "c2", "label": "Only ultralights" },
                            { "id": "c3", "label": "Ones with 32 GB" } ],
               "recommended": "c1", "other": true, "state": "open", "answer": null },
  "notes": [ { "noteId": "mn-…", "area": "work", "state": "filed", "approvalId": "ap-…", "line": "Noted for Work" } ],
  "show": null }
```
- **Said once (Nov 15):** her `ask_member` ends her run: once the choices are shown no further model call is made, so the reply is never written twice (the owner's first use showed her welcome twice: the call after the tool wrote it again). A reply with no words of its own takes her question as its `text`. Any other tool's later step is cut to what's new before it's shown (desk-agent `maia/Restated`).
- **Her longer part (Nov 15):** rarely, `text` holds a short reply, then a line `<more>`, then a longer part that continues from it. The room shows the short reply and folds the rest under "More"; desk-agent drops sentences of the longer part that repeat the short reply, and the marker with them when nothing new is left. Another client shows `text` as it is.
- `choices`: 2 to 4 options, each a short answer in the member's words (1 to 40 characters, plain text), the first her recommendation (`recommended`), and `other: true` always ("Other" opens the composer). `state`: `open`, `answered` (`answer` the choice id, or `"other"`), or `passed` (the member wrote something else). Only her newest reply's choices are `open`.
- **Answering:** a tap is `agent.maia.choose {messageId, choiceId}`. "Other" is the composer: send `agent.message.send {agentId: "maia", text, choice: {messageId, other: true}}`. A message sent with no `choice` while choices are open passes them by (counted `ignored`).
- **The weight** (`choices.weight`, 0 to 1, starting 0.8) is per member, kept on the home desk (so every device sees the same), counts only, never text. A tap raises it; "Other" and passing by lower it; asking for choices ("give me options", "multiple choice please") puts it straight back to at least 0.8, and asking for fewer drops it to at most 0.3. Her prompt gets the weight and the rule: "Offer choices when the weight is above 0.5, and always for a decision with clear options or anything that needs the member's OK." `agent.maia.choices.reset` starts it again.

### Notes (use case A)

- After each message the member sends her, a **note-taker** reads only the member's own recent messages (never her replies, reports, tool results or files), so it never holds untrusted content. It returns at most 5 notes, each `{text ≤ 280, area: work | personal | unsure, kind: fact | decision | reminder | idea, due?}`; anything shaped like a password, code, card or key is dropped by code.
- **Code files them** in the home desk's Notebook, in the member's "From Maia" tab (`notesTabId`, the tab her access lets her add to without asking), on that day's page for the area ("Work · Sat Nov 14"), as Maia's own call done without asking (§18, "Done without asking"), in a clean run of her own that reads nothing. The approval row is the note's record, with its Undo.
- `notes` on her reply: one chip per area, `line` "Noted for Work" or "Noted for Personal", `state` `filed` (with `approvalId`: Undo is `agent.approval.undo {approvalId}`), `pending` (filing), `held` (the area is `unsure`: she asks once, below), `failed`, or `undone`. The room adds " · Undo" to a `filed` chip only; a `failed` chip reads "Couldn't save that note" and an `undone` one "Note removed".
- **Unsure:** held on the home desk, never filed, until the conversation goes quiet (10 minutes with no message from the member). Then she asks once, in her thread, a code-written message with choices: "2 notes could go either way. Where should they go?" (or "A note could go either way. Where should it go?") with `Work`, `Personal` and `Don't keep` (ids `work`, `personal`, `drop`; `other: false`; `kind: "notes"` and `noteIds`). A tap is `agent.maia.choose` as for any of her choices, which files every note it names and starts no run; `agent.maia.note.file {noteId, area}` does one. Held notes not answered in 7 days are dropped, their text wiped.
- **Notes are never Now or Next:** one Later line, "6 notes today". `agent.maia.notes.list {day}` gives `{notes: [{noteId, area, kind, state, approvalId, pageId, at}]}` (no text: the text is in the Notebook) for "Show me" (`app: "notebook"`, `ref` the page id) and "Undo today's" (the room calls `agent.approval.undo` for each `filed` one, newest first).

### To-dos (use case B)

Each desk files to-dos from its own Courier into its own To-do (§22) when the member switches it on for an agent with Courier on (`agent.maia.todos.set {agentId, on}`, input; off by default; `{maia}.todos` lists who), while Maia Mode is on and listed on that desk (off or killed, the runs read nothing; switching one off always works): once when switched on, then every 30 minutes and at desk-agent's start (a wake's catch-up), never per message. A **reader** model call holding the new messages (`courier_new`, known contacts only, bulk skipped, every result untrusted) with no tools at all returns only `[{messageId, action ≤ 120, due?, confidence}]`; **code files** each with `todo_add` and `source: {kind: "courier", ref: {messageId}}` (deskd checks the run read it), after checking the id was in the batch, that the action is plain text with no link or Markdown, and the caps (`todosPerDeskPerDay`). Dedupe and merge are To-do's own (§22). The list shows one item per desk ("3 new to-dos on Work"); a to-do is Now only when its `due` is within 2 hours. Real email waits for Courier's email transport.

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.maia.todos.set` | Yes, input | `{agentId, on}` | `{todos: [{agentId, on, lastRunAt, lastFiled}]}`. Any desk of the member's (not a Guild Desk); the agent needs Courier and To-do on in its access (`bad_request` `{reason: "app_off"}`) |

### Her tools (what the model is offered)

| Tool | Class | What it does |
|---|---|---|
| `office_desks` | read (untrusted) | The desks from the last observe: ids, names, states, agents and counts, as data |
| `office_desk_status` | read (untrusted) | One desk's agents, waits and approvals pending, titles as data |
| `office_show` | own | Asks the room to show `(deskId, app, ref)`: the home desk always, another desk only with a grant holding `show`; `app` from the enum and `ref` an id, never an address (refused otherwise). Opened at once when the member's last message asked to see something (read in code), or at most once every 10 minutes unprompted; else a "Show me" button |
| `ask_member` | own | Her question with 2 to 4 choices (the reply's `choices`). One per reply; her last call wins. Shown, it ends her run (no further model call) |
| `todo_list`, `todo_get`, `todo_add`, `todo_update`, `todo_close` | §22's | The home desk's To-do, under her access |
| `desk_message` | own or send (§18), under a Maia grant | Brief the answering agent on another desk. Refused `maia_grant` with no live grant with `brief` for it, `maia_cap` past `briefsPerDay` or at the day cap in credits the member set on her, and `maia_held` or `maia_limit` when the member's wallet says ask first ("Her briefs and the member's wallet", below). A run that read a desk's answer while that desk is marked `keepsToItself` asks before briefing any other desk |

She has no tool that approves, changes a grant, a setting, a limit or a key, reaches `/v1/agent/*`, `/v1/admin/*` or another person, deletes, buys or pays (the concept's §8.1 "Never" column): those don't exist.

### Grants

```json
{ "grantId": "mg-…", "deskId": "d-…", "deskName": "Work", "scopes": ["brief", "show"],
  "keepsToItself": false, "expiresAt": 1763704800000, "createdAt": 1763100000000,
  "briefsToday": 3, "lastUsedAt": 1763100000000, "half": "active" }
```
- `half`: the state of her `desk_message` grant to that desk (§18): `none`, `offered` (waiting for the member's Allow on that desk) or `active`. A brief needs both `brief` here and an `active` half.
- **Expiry:** 7 days by default, 30 at most; an expired grant is listed with `expiresAt` in the past until revoked or extended (`agent.maia.grant.set` again). Turning Maia Mode off revokes them all.
- **`keepsToItself`:** this desk's answers stay with this desk: once her run has read one, briefing any other desk from that run asks on a card.
- **Never a Guild Desk** (`forbidden` `{reason: "guild"}`).
- **deskd's own record** (`agent/MaiaRecord`, as `AccessRecord` is for an agent's access). Whether Maia Mode is on and each grant's desk, scopes, "keeps to itself" and expiry, recorded only from the member's relayed `agent.maia.set`, `agent.maia.grant.set` and `agent.maia.grant.revoke`, and only what desk-agent's answer also holds: on where both say on; the scopes in both; the expiry desk-agent answered, at most 30 days from now; "keeps to itself" when either side says so. What the member takes away holds before desk-agent hears (Maia Mode off drops every grant; a revoke drops one; a narrower `grant.set` narrows it), whatever desk-agent answers; a refusal records nothing more. It's `/data/desk/maia-record.json` (0600, written whole) under an HMAC-SHA256 with `maia-record.key` (32 random bytes, 0600, made once). A file that doesn't verify is set aside as `.bad` and nothing is recorded (Maia Mode reads as off here, so every brief of hers is refused until the member turns it on again); a write that fails sets the last file aside as `.unsaved`. No desk name is kept.
- **Her briefs in deskd** (`desks/DeskTools`, agent `maia` only): `desk_message` is refused `maia_grant` at the look and again as it runs, unless deskd's record has Maia Mode on and a live grant for that desk with `brief` (W6's own half and its 20 a day still apply after it). Under the grant the class is `own` even when her run holds `S` (the concept's `delegate`: the member's own private desks), and `send`, which asks on a card, when her run holds `S` and has read an answer from another desk that keeps to itself, or from one she has no live grant for. The desks a run read answers from are those deskd gave it itself (an answer its `desk_message` took, `DeskSources`) and those desk-agent names in the call's `taint` as `D:<deskId>`, which only ever add; past 64 the run names `*`, which no grant covers. Every other agent keeps W6's rule exactly. Desk Maia never answers another desk (`desk_answer` from `maia` is refused `maia_grant`).
- **Her private briefs** (Security's DMA-M1). A brief of hers from a run holding `S` goes with `private: true` sealed in the envelope (only hers: the word from any other agent is not taken). On the other desk the opened `msg` says `private: true`, and the answering agent's run starts with `S` as well as `U`, so its browse actions are `egress` and ask there (the Rule of Two, on both desk-agent's side and deskd's). Its `desk_answer` back to her desk, from the run that has her brief as its origin, stays `own` (deskd's `DeskSources` record, 7 days); any other answer keeps W6's rule (`send` from a run holding `S`). The answer goes `private`, so her runs that read it hold `S` and its desk as an origin.
- **Audit** (the home desk's log, ids only): `maia.on`, `maia.off`, `maia.grant` (`desk:<id> scopes:brief,show days:7`), `maia.revoke`, `maia.brief` (`desk:<id> env:<id>`), `maia.note` (`note:<id> area:<a> ap:<id>`), `maia.note.undo`, `maia.show`, `maia.todos`, `maia.choices.reset`, `maia.forget`.

### While the member is away (Maia Mode Phase 2, Nov 15; draft-desk-maia.md decision 12; ma-platform ADR 0141)

She keeps going with no office open. **deskd's part** (`agent/MaiaAway`), only while the Platform's heartbeat reply says `maia.away` (ma-platform agent.md "Maia while you're away"), never on a Guild Desk:
- **The heartbeat's `maia`** from desk-agent's `agent.state` `maiaAway {on, inFlight, wakeAt, away, asks, done}`: `holdUntil` 10 minutes ahead while `inFlight`, `wakeAt` her next check-in, `home: true` while Maia Mode is on here. The reply's `maia {away, hold, hoursLeft, home, pollSeconds, waiting}` goes to desk-agent as **`desk.maia.away {away, hold}`** (deskd-only, no caller), on a change and every 10 minutes.
- **The carrier:** every `pollSeconds` (60) while away is on: `desk.desks.outbox`, then for each desk whose oldest envelope is 30 s old (the office carries anything sooner), `desk.desks.take {toDeskId, limit: 20, olderThanMs: 30000}` and `POST /v1/agent/maia {action: "send", toDeskId, envelopes, wake?}` (`wake` when a taken envelope is her brief: the row's `wake: true`); when the reply's `waiting` is above 0, `GET /v1/agent/maia`, each envelope opened and checked as `agent.desks.deliver` does and handed to desk-agent (`desk.desks.deliver`) in order, stopping at a transient failure; outcomes of what this desk sent to `desk.desks.done`; then `ack`. A post the Platform has isn't sent again for 10 minutes.
- **The bell:** `POST /v1/agent/maia {action: "notify", kind}` once per rise of `asks` (`question`), `done` (`done`) or the agents' `approvalsPending` (`approval`). **With the focus shield on** (Nov 15, §23 "What reaches the member"), desk-agent's `maiaAway` also carries **`ring {question, done, reach}`**, counts that rise only as the shield's delivery rules let a bell ring, and deskd rings by them instead of `asks` and `done`: her question and her finishing don't ring in quiet hours (they wait for the return catch-up), at most 12 bells a day from the shield (the Platform's own cap), and `reach` (an item the shield holds at interrupt level: a let-through match or a code-rule Now, never an approval, which each desk's deskd rings itself) rings only once the Platform's heartbeat reply lists it in **`maia.notifyKinds`** (absent: Phase 2's three; the Platform's half, kind `reach` with fixed words, isn't built). deskd takes the counts it first sees from `ring` (and the shield's own count when the member leaves) as already rung, so a restart or an idle stretch at the office never rings late. Without `ring` (an older desk-agent, "Show everything as it comes") Phase 2's rule stands.
- **deskd-only methods added to desk-agent** (refused from any frame with a caller): `desk.desks.take` and `desk.desks.done` (the office's, for deskd's carrier), `desk.desks.outbox` (`outboxSnapshot`), `desk.maia.away`. `agent.desks.take`'s envelopes may carry `wake: true` (her briefs) and it takes `olderThanMs`.

**desk-agent's part** (`maia/Away`, `AwayStore`, `Reports`):
- **Her tools add** `maia_check_in {minutes}` (`own`, 5 to 1,440: her run starts again then, even with the office closed) and `maia_read {desk, writeup?, query?, question}` (`read`, `U`+`S`: write-ups another desk's agents left for her briefs, read by a small call on her service, task `read`). `desk_message` for her adds `expect {fields, then, urgentIf, newWork}`; code appends a fixed block asking for a full write-up and one `REPORT {...}` line; a brief naming a write-up (`wu-…`) is refused `use_maia_read` unless `expect.newWork`.
- **On the answering desk:** an answer to her brief keeps the agent's full reply as a write-up (`desk_writeups`, 90 days) and sends back `[report] status=… urgency=… importance=… writeup=wu-…`, the fields and a summary, at most 1,500 characters. Her reader's request (`[maia-read v1] {writeup | query}`) is answered by code from write-ups for her desk whose answer needed no card here; never an agent run.
- **Her to-dos while away** (`sub/mm-away-fixes`): a to-do she files from a report names it as `source: {kind: "desk", ref: {}}` (her batch and check-in runs say so); her runs name the answers in her thread to deskd (§18, "To-do's source kind `desk`"), so it's a source the run was given: in the `todos` group, done without asking under her To-do switch, the item marked untrusted. `agent_chat` stays the member's own message that started the run, which an away run has none of (`source_unknown`). Nothing else she does while away changes.
- **On the home desk:** reports go to `maia_reports` (filed by code when they need nothing from her; else due by urgency and importance, batched into one run of hers, origin `{kind: "maia", role: "reports"}`); check-ins in `maia_checkins` (origin `role: "check_in"`, at most 24 runs a day); the member is away after 2 minutes with no `agent.maia.observe`; "While you were away" is a code-written message of hers when they're back (`agent.maia.observe` after 5 minutes away, or `agent.maia.seen {back: true}`), with choices (her open question moved onto it, or `kind: "away"` with "Tell me more" and "That's all for now", which starts no run).
- `{maia}` adds `reports: {laterMaxMin}` (30, 5 to 240), settable with `agent.maia.set {reports: {laterMaxMin}}`. "Delete Maia’s desk history" also clears her briefs, reports, check-ins and away log (write-ups are the answering agents', on their desks).

### Her briefs and the member's wallet (Nov 15)

The owner: "People aren't going to want to use and trust Maia Mode if it just destroys their wallets", then "Will users have to approve that EVERY time?" The agents she briefs run on the member's own keys. She plans around what they cost, and normal work never asks: desk-agent `maia/Wallet`.
- **What she reads.** Each desk's team view gives every agent's `headroom` (above), and the office passes it in `agent.maia.observe` (agents' `budget`, desks' `briefs`). Her note lists each desk she may brief: its answering agent (the agent her send half was accepted for, else the desk's only agent), its usual task cost, what's left today and this month, and what one brief may spend there; and her briefs today against the budget. `office_desks` and `office_desk_status` give the same figures per agent (`usualTaskUsd`, `leftTodayUsd`, `leftThisMonthUsd`, `oneBriefMaxUsd`). Her context says to pick the cheapest desk that can do the job well and to trim or split a brief to fit.
- **The estimate.** The answering agent's usual task (its average over her briefs there once it has 2, else over its tasks once it has 2, else $0.20) times the brief's size, 1 to 6, from code: past 120 words, a list of 4 or more items, a count of 5 or more things ("12 laptops"), and words that widen it ("all", "every", "in depth"). Never under a cent.
- **The member's settings** (`{maia}.budget`): a daily budget for her briefs ($3), an ask line ($0.50), and what they've said is always OK. Set once at setup or later; shown in the team view.
- **When code holds a brief** (her guard on `desk_message`, decided once per run, desk and brief text, before deskd hears anything): (1) it would pass the answering agent's own limit (what's left today or this month, or what one brief may spend there): **`maia_limit`**, never waived; (2) it would take her briefs past the day's budget: **`maia_held`**; (3) it costs more than 3 times that agent's usual task **and** more than the ask line: **`maia_held`**. Otherwise it goes, and its estimate counts toward the day until the desk's own figure replaces it. "Always OK" for that agent covers (2) and (3) up to its size. A default day of ordinary briefs never asks.
- **The card.** Held, code posts one message of hers in her thread, once while it's open: its text is code's ("This one's bigger than usual: about $1.20 on your Work Lead, about 6 times its usual task. Go ahead?"; "About $0.40 on your Work Lead would take my briefs past today's $3 budget ($2.80 used). Go ahead?"; "Your Work Lead has $0.10 left today, and this is about $0.40. It would stop at its limit."), the desk's and agent's names plain and cut, nothing of the brief. It carries `choices` with `kind: "budget"`, `other: false`, `brief: {deskId, agentId, estimateMicroUsd, reason}`, and **`cost`** `{estimateMicroUsd, usualMicroUsd, reason, line}` on the message view ("About $1.20 · usually $0.20 · Work Lead"). Choices: unusual `go`, `always` ("Always OK for tasks like this"), `cheaper`, `skip`; past the budget `cheaper`, `go`, `always`, `skip`; at a limit `cheaper`, `try` ("Try anyway"), `skip`, or with nothing left only `another` ("Another way") and `skip`. While it's open her own `ask_member` is refused (`held`).
- **A tap** (`agent.maia.choose`): `go`, `try` and `always` let that agent take one brief up to 1.5 times the estimate in the next 15 minutes (an agent's limit with nothing left still refuses); `always` also keeps that agent's tasks up to 1.25 times this one (to the next 10 cents) from asking again; `cheaper` and `another` give no pass; each of these goes to her as the member's words, and her next note says what the member chose and the brief as she wrote it. `skip` drops it and starts no run (`{messageId}`). Code's card isn't her question: it moves no choice weight.
- **Never.** Nothing here raises a limit: each desk's ledger, run cap and share for desk messages still refuse a run that would pass them. She has no tool that changes the budget, the ask line, "Always OK", a cap or a limit, and her own `ask_member` choices can't make an "Always OK" (only code's card, kind `budget`, can). A failure here lets the desks' caps decide, as before.
- **Audit** (the home desk's log, ids and amounts only): `maia.brief.held` (`desk:<id> est:<µ$>`, decision `unusual`, `budget` or `limit`), `maia.brief.answer` (decision the choice id), `maia.budget.always` (`desk:<id> agent:<id> upTo:<µ$>`).

### `agent.usage.summary` (the team view)

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.usage.summary` | No | `{days?}` (1 to 7; 7) | `{zone, today, agents: [{agentId, name, keyLast4, days: [{date, spendMicroUsd, calls, inputTokens, outputTokens, cacheReadTokens, tasksDone, tasksFailed, tasksStopped, approvalsAsked, approvalsApproved, approvalsDeclined, undone}], headroom}], maiaBriefs, maia?}` |

Per agent per day on this desk, from its usage ledger (ADR 0043) and its approvals, in the desk's zone; counts and dollars only. Desk Maia is listed on the home desk as `maia`, with `spendMicroUsd` 0 on every day and **`spendCredits`** instead (what her own calls drew that day, 2 decimals; her calls are the company's, never the member's money, Nov 15): the office shows her in credits and never a dollar figure for her. **Usage per source (one wallet, Nov 15):** an agent bound to the member's MA credits (`ma-credits`), or one that drew any in these days, also has `spendCredits` each day (`CreditDays`) and `source` (`credits`, or `credits_and_key` when it also ran on a key of the member's); its calls on credits keep no dollars, so its `spendMicroUsd` is only what it spent on the member's own key. An agent on the member's own keys is unchanged: its own provider's dollars are the member's. The office fetches it from each desk over its own channel and sums the columns (Today, Trend, 7 days, Tasks, Per task, Asks a task, Kept); nothing goes to the Platform.
- **`headroom`** (every agent but Desk Maia; Nov 15, for her planning): µ$, null where there's no cap. `dayLeftMicroUsd`: before its day or week limit or the desk's day limit; `monthLeftMicroUsd`: before its month, the desk's month or its key's month; `runMaxMicroUsd`: its run limit; `briefMaxMicroUsd`: what a run answering another desk's message may spend there now (§18, W6: its share for messages and the desk's, and its run limit); `perTaskMicroUsd` and `tasks`: its spend over its tasks (done, failed, stopped) in these days; `perBriefMicroUsd` and `briefs`: over runs Desk Maia's briefs started here in 30 days. Read only: nothing here changes a limit.
- **`maiaBriefs`**: runs Desk Maia's briefs started on this desk (an opening message whose origin is a desk message from agent `maia`) and what they spent, by run, from the ledger: `{todayMicroUsd, monthMicroUsd, today, month}`.
- **`maia`** (the home desk, Maia Mode on): her briefs' spend across the member's desks and the day's budget for them, the room's `briefs` (above), for the team view's Maia line.

### What reaches the member (the focus shield, Nov 15)

The owner, Nov 15: Maia is "a protective focus shield", bringing what's close to the member's work first and holding the rest for a good time, "like a really really good executive assistant". Design: `~/ma-coord/design-drafts/maia-shield/CONCEPT.md`; the owner's yes to activity signals (Nov 15): the home desk may see which desk and app the member is on and when they pause, **ids and times only, never leaving their desks**. Internal name **the shield**; members never see "shield" (the office's Privacy shield is another thing) or "Maia Mode": its settings section is **What reaches you**. desk-agent `maia/Focus` (the model of now, states, breaks), `maia/Reach` (the distance score), `maia/Deliver` (levels, budgets, cards, the held line), `maia/Rhythm` (catch-ups), `maia/Learn` (corrections), `maia/Shield` (the state between calls) and `maia/FocusStore` (`maia_focus_*` rows in `agent.db`). **Code decides, never a model:** no model call, no credits, and nothing here reaches her model but "holding until …" while a hold is on and the member's own task label in the turn that set it. **On by default** while Desk Maia is on; the member's own off switch is "Show everything as it comes" (`reach.showAll`), which falls back to the list as it was (the 30-minute batch).

#### `focus` in `agent.maia.observe`

The office sends what the member is doing, as structure, inside `agent.maia.observe` (optional; an office without it gets the list as before). It's sent **in every view while Desk Maia is on** (the room, the desk view, the overview), not only while her room is open: debounced 2 s, only when it changes, plus the 60 s keep-alive. Typing is two edges, never per key.

```json
"focus": { "surface": "desk", "deskId": "d-…", "scope": "work", "app": "notebook",
           "item": { "kind": "page", "id": "pg-…" },
           "people": [ { "deskId": "d-…", "contactId": "01JD…" } ],
           "input": { "typing": false, "idle": false, "lastAt": 1763100000000, "flowSince": 1763096400000 },
           "call": false, "share": false, "visible": true, "device": "dv-k3j9…",
           "events": [ { "kind": "sent", "at": 1763100000000 } ] }
```

| Field | Meaning and limits |
|---|---|
| `surface` | `room`, `desk`, `overview` or `phone` |
| `deskId`, `scope` | The desk in front (a `d-` id) and the office's scope, `personal`, `work`, `guild` or `all`. A Guild Desk in front sends `scope: guild` with no `deskId`, `app`, `item` or `people` (other people use it) |
| `app` | Closed enum: `notebook`, `courier`, `todo`, `files`, `browser`, `agent`, `agent:<id>`, `app:<id>`, `commons`, `maia`; anything else is no app |
| `item` | `{kind, id}`, `kind` one of `page`, `thread`, `channel`, `todo`, `folder`, `run`; `id` 1 to 80 of `[A-Za-z0-9_:-]`. **Never a URL, a tab or a title**: the Browser sends `app: browser` and no item; a Files folder is `h-` and 16 base32 characters of the SHA-256 of its path, made in the browser, so no name travels |
| `people` | Up to 8 `{deskId, contactId}` (Courier's 26-character contact ids) of the open thread or channel, or the open to-do's source. Never names |
| `input` | `typing`: a key in the last 20 s (edges only); `idle`: no input for 2 minutes; `lastAt`: the last input, at the edges and at most once a minute; `flowSince`: when the current stretch of input began (a 5-minute pause ends one). **Timing only**: never keys, text or clipboard |
| `call`, `share` | A call or screen share is on, where the office can tell; false when unknown. **The office's sources** (`web/src/maiamode/dnd.ts`): `call` while the member is in a Commons room with voice on (a Guild call); `share` while the office's Privacy shield is on (someone else can see the screen). Any later source (Maia's voice, a screen share) says on or off there. On or off only, never who or where. Either holds every card and catch-up until it ends, and its end is a coarse break |
| `visible` | The tab is visible and its window focused |
| `device` | `dv-` and 8 to 32 of `[a-z0-9]`, random per browser: with two devices, the one with the latest input is where the member is, and only it shows cards (`reach.device`) |
| `events` | Up to 10 completed actions since the last observe, each `{kind, at}`: `sent` (a message sent in Courier, an agent chat or her chat), `todo_checked`, `approval_decided`, `saved` (a file saved or uploaded), `page_left` (a Notebook page left for another page in the same notebook), sent **after 5 s with no input following** (the office's own check: a fine break), and `window_closed` at once (a coarse break) |

Out-of-shape fields are dropped, never an error (the rest of the observe still counts). **Kept in memory on the home desk only** (the working sphere and Back's snapshot included); the day's counts and the member's own settings go in `maia_focus_*` rows; nothing of it is sent to the Platform, Support Maia, any model or a push.

**For closeness, also optional in each desk of `agent.maia.observe`:**
- **`courier`** `{threads: [{channelId, kind: direct | group, contactIds, known, confirmed, bulk, theyWroteLastAt, replyBand, unread, newestAt}]}`, at most 50: the People lane's channels with something unread, from that desk's Courier summary (deskd `courier.attention`, §21), read by the office while Courier's switch is on and held to this shape (`web/src/maiamode/shieldSeams.ts` `cleanThreads`). Structure only: never a subject, a snippet or a name. Requests, Spam and Trash never. A group thread names no person (its newest sender isn't known by id), so a person on the list never matches another member's message. **No model reads it** (0 credits): ranking is code's; the member reads a message's words in the card's quote (the browser, at draw time) or in Courier. Her reading an item's content on request is the Phase 2 Haiku reader's (the routing rule, on her credits), which reads write-ups only: she has no Courier path (draft ADR decision 8).
- **`docs`** `[{docId, place: needs_you | maybe | read_later | records, contactIds?, agentId?, channelId?, todoId?, approvalId?, dueAt?, changed?, at}]`, at most 50: the documents index's places (the documents work), ids only: the office reads each own open desk's `docs.feed {front: true}` (§25) and sends it here (`focusSource.ts` `readDocsFront`), again on each `docs` event; never a Guild Desk's.

#### What it does (code, desk-agent)

- **States**, first match wins: `away` (no observe for 2 minutes), `call` (call or share), `typing`, `hold` (the member's "Hold everything"), `deep` (the member's focus hours), `fine` or `coarse` (a break is open), `steady`.
- **Breaks** open for 20 s, then at most one card: **fine** from an office event above; **coarse** when the desk in front changes, the overview opens, the app or its item changes, a window closes, the member comes back from 2 minutes idle or 2 minutes hidden, a call or share ends, a hold or the focus hours end, or her room opens. **Never** while typing, nor in the first 10 minutes of a hold or a focus stretch.
- **Items**: every list item (`Attention`'s kinds), plus `message` (a People-lane Courier thread, from `courier`), `doc` (from `docs`), `pickup` (a task she pulled the member away from, not resumed in 2 minutes). Each has a **distance from now**, 0 to 100: `100·(1 − (0.45·C + 0.20·U + 0.15·I + 0.20·D))` plus what's learned (±15), repeats (+10 each, to +30) and the budget (+10), from closeness to the member's working sphere, task and people (C), urgency by fixed rules (U), the sender's or topic's standing (I) and a deadline code can check (D). **The interrupt gate is U = 1 only**: a code-rule Now (as the list's) or a let-through match with the sender's identity checked (an email's `confirmed`, a text's known channel). No weight, learning or score opens it, and **nothing a desk wrote moves an item** ("URGENT" in a subject changes nothing).
- **Levels:** **interrupt** (the gate: a heads-up line, then the card 8 s later unless it expires sooner); **offer** (distance ≤ 40 at a fine break, ≤ 60 at a coarse one, ≤ 20 in focus hours; one quiet card that tucks back after 20 s); **periphery** (61 to 85: counted, listed in To-do, at the next catch-up); **hold** (over 85, and anything learned "Not important": counted, in the catch-up's tail). Offers at most 1 a break, 3 an hour, 10 a day.
- **Fewer interruptions** (tuned by the scenario-day evals below, the concept's §13): interrupts are **spaced 30 minutes** apart, and one whose deadline can't wait that long comes after 15; **a card carries up to 2 more** interrupt-level items that came meanwhile (`more`), so it's one interruption; a deadline item that isn't a person on the list comes **just in time**: at a coarse break, or once its deadline is 25 minutes off. While the member is **idle** at the office (2 minutes without input) nothing is put in front of them but what's about to expire; after 5 minutes idle, interrupt-level items may ring Phase 2's bell (fixed words) as while away (`maiaAway.ring`, above: the Platform skips it while any of the member's desks has an open session). On the **phone**, the app open with nobody typing is a moment between tasks.
- **Never lost:** every held item is in `agent.maia.reach.held`; an item with a deadline is never held past the last catch-up before it (or is offered once it's within 3 hours); state survives restarts (`maia_focus_items`); a held item that expired, or "Should have told me sooner", is logged as a miss and asks the member for a rule.
- **Work and Personal by the clock:** in work hours (the span of the catch-ups, weekdays) Personal items hold; in the evening and at weekends Work items hold (unless `evenings: let`); quiet hours (two hours after the last catch-up until the first, unless set) let only code-rule Now and "any time" entries through. The member's list always gets through.
- **Catch-ups** at the member's times (9:00, 1:00, 5:00 by default, the desk's zone): at most 7 lines after grouping, **Needs you · Working on · Read later · Records · Done for you**, "Cleared without you: n", then "That's all for now." A catch-up that finds nothing says nothing. While the member types, is on a call or in focus hours it waits for a coarse break, up to 60 minutes, then the line says "Your 1:00 catch-up is ready". The first presence of the day is the **morning brief** (at most 3, Mondays "Anything to keep close this week?"); the last catch-up asks "Hold Work until tomorrow at 9?"; Friday's last says the week line ("This week I held 41 things. Nothing urgent was missed.") only when true; coming back from away is the **return catch-up** (Phase 2's "While you were away", in this shape).
- **Learning** (`maia/Learn`): "Not important" holds that class (source, kind, scope) until undone; "Not now" three times in 14 days asks "Keep them for catch-ups?"; "Sooner next time" pulls the class 15 closer and, for a person, asks "Add {name} to your list?"; quick acts and fast dismissals drift a class by at most ±15 (counts halve every 30 days). **Learning can't open the gate, can't hold a code-rule Now or a list item, and can't hide anything.**

#### Topic `agent.maia`: `reach`

The room's snapshot gains **`reach`** (null while Desk Maia is off):

```json
"reach": { "on": true, "device": "dv-k3j9…",
  "line": { "kind": "held", "text": "6 held · nothing urgent", "held": 6, "dot": "none", "action": null },
  "card": { "cardId": "mc-…", "itemId": "mi-…", "level": "interrupt", "kind": "approval", "deskId": "d-…",
            "source": "Work · Invoices agent", "what": "The invoice agent needs your OK.", "why": "Expires in 40 min",
            "whyMore": null, "go": { "kind": "approvals", "deskId": "d-…", "approvalIds": ["ap-…"] }, "goLabel": "Review",
            "choices": [ { "id": "in_20", "label": "In 20 min" } ], "quote": null, "first": null, "after": null,
            "at": 1763100000000, "tuckAt": null },
  "catchup": null, "back": null, "working": { "label": "Q3 plan" }, "hold": null,
  "held": { "count": 6, "now": 0 } }
```

| Field | Meaning |
|---|---|
| `on` | False while "Show everything as it comes" is on: the room's list is as before and nothing below shows |
| `device` | Where the member is (the device with the latest input): only that device shows `card`, `catchup` and `back`; null means any |
| `line` | The still held line (desk view: beside the account menu; the room: the To-do column's head; the phone: the To-do pill). `kind` `clear` ("All clear"), `held` ("6 held · nothing urgent"), `catchup` ("Your 1:00 catch-up is ready"), `hold` ("Holding until 11:30 · your list still gets through"), `heads_up` ("One thing in a moment", `dot: accent`), `back` ("Back to Q3 plan"), `pickup` ("Pick up: Q3 plan"). `dot` is `accent` only for a heads-up or an interrupt waiting out a call; never a warning colour, never motion. `action`: `{kind: back, cardId}`, `{kind: pickup, itemId}`, `{kind: catchup, catchupId}` or null (the line opens To-do) |
| `card` | One at a time. **`{who}`** in any of its words is the browser's slot: it fills in the sender's name from that desk's Courier contact (`who: {deskId, contactId}`) when it draws the card; the desk holds no names. `more`: up to 2 riders `[{itemId, kind, source, what, why, go, goLabel}]`, each with its own one thing. `source` (desk · who, plain, ≤ 60 each), `what` (code's template), `why` (a reason in under 10 words), `whyMore` (the rule behind it: "Rosa is on your list"), `go` (the item's own action, the list's `action` shape, plus `{kind: "doc", deskId, docId}` for a document and `{kind: "back", cardId, deskId, app, item}` for a pick-up) with `goLabel` (Review, Open, Reply, See result), `choices` (1 to 3 of `after_this` "After this", `in_20` "In 20 min", `at_catchup` "At 1:00", `not_now` "Not now"; time choices only when the deadline allows, `not_now` never on an approval, a limit, a failed desk or her cap). `quote`: `{deskId, channelId}` when the item is a message: the browser shows the sender's own subject from that desk's Courier, in quotes, at draw time; the desk never holds it. `first`: on the first let-through by a rule, `{text: "I let this through because Rosa is on your list.", choices: [keep, not_for_this]}`. `after`: once answered "Not now", `{text: "Held until 1:00", choices: [not_important, undo]}` for 5 s. `tuckAt`: an offer leaves the screen then if untouched (it stays in To-do) |
| `catchup` | `{catchupId, kind: brief | catchup | return | evening, head, groups: [{id: needs_you | working_on | read_later | records | done_for_you, label, items: [{itemId, line, go, goLabel, choices}], summary}], lines, question, end, at}`: at most 7 lines in all; `question` `{questionId, text, choices, who?}` (`keep_for_catchups`, `add_to_list`, `hold_work_tonight`, `week_pick`, `email_me`, `pace`, `tag_contact`: "Is {who} family, a client, or neither?", its choices the list's groups); a group's `summary` counts what didn't get its own line ("And 4 more: 3 messages · 1 answer"), so every held thing is said; `end` is "That's all for now." |
| `back` | After the member took a card's one thing and finished it: `{cardId, label: "Back to Q3 plan", resume: "You were on Q3 plan in Notebook, Work. Last change 3 min ago.", deskId, app, item, surface, until}` for 60 s. The office restores the windows it saved for that card itself (they never leave the browser), else this `deskId`, `app` and `item` |
| `working` | The member's stated task (`working_on`, below): `{label}`, ≤ 40 characters in their own words, until the end of the day |
| `hold` | `{until}` while "Hold everything" is on |
| `held` | Everything held: `count`, and `now` (interrupt-level items waiting) |
| `accent` | The office's tiles that keep the accent under the shield: `[{deskId, app, agentId}]`, at most 20, the desks' apps where an interrupt-level item waits (a let-through match or a code-rule Now); `agentId` for an agent's item. Every other tile badge is a still, neutral count (Courier's a dot, no count) while `on` (`web/src/state/tileCalm.ts`) |

With `reach.on`, the room's `todo` follows it: hold-level items don't take a visible place (they're counted in `todo.held` and listed by `agent.maia.reach.held`), Next items come when the shield offers them or at a catch-up instead of the 30-minute batch, and `notice` is the shield's interrupt card.

#### `agent.maia.reach.*` methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.maia.reach.get` | No | None | `{reach}`: the settings below, `learned` (each rule: `{ruleId, line, at}`), and `counts` (`heldToday`, `deliveredToday`, `missedThisWeek`) |
| `agent.maia.reach.set` | Yes, input | Any of the settings below | `{reach}`. The welcome's Q4 to Q7 write these; so does What reaches you |
| `agent.maia.reach.answer` | Yes, input | `{cardId \| itemId \| catchupId, answer, questionId?, pick?}` | `{}`. `answer`: `go`, `after_this`, `in_20`, `at_catchup`, `not_now`, `not_important`, `sooner`, `missed` ("Should have told me sooner"), `undo`, `keep`, `not_for_this`, `not_yet` (on a heads-up), `dismiss`, `replied` (a quick reply went from the card or a held row: a message's or a document's item only, done, a quick act, no Back); with `questionId`: `yes`, `no`, `not_today`, `keep`, `change`, or `pick` (a `week_pick` item id, `calm`/`ok`/`too_much`/`missed` for `pace`) |
| `agent.maia.reach.hold` | Yes, input | `{minutes}` (15 to 720), `{until: "catchup" \| "tomorrow"}` or `{clear: true}` | `{hold}`: "Hold everything". The let-through list and code-rule Now still get through |
| `agent.maia.reach.held` | No | `{deskId?, kind?, contactId?, limit?}` | `{items: [{itemId, kind, deskId, deskName, title, level, reason, at, go, who?}]}`, newest first: "All held". `who` `{deskId, contactId}` on a person's direct message (for the row's quick reply; the browser draws the name). Searching it before an item was offered counts as "should have come sooner" |
| `agent.maia.reach.back` | Yes | `{cardId, taken}` | `{}`: the member took Back (or let it go); ends the pick-up |
| `agent.maia.reach.working.clear` | Yes, input | `{}` | `{}`: ends the stated task |
| `agent.maia.reach.learned.undo` | Yes, input | `{ruleId}` | `{reach}` |
| `agent.maia.reach.learned.reset` | Yes, input | `{}` | `{reach}`: "Reset what I've learned": every learned rule and drift |

**Settings (`{reach}`)**, each checked, `bad_request` `{reason, detail}` otherwise:

```json
{ "letThrough": [ { "ruleId": "mr-…", "kind": "group", "group": "family", "anyTime": true, "source": "welcome" },
                  { "ruleId": "mr-…", "kind": "match", "match": "due_today", "anyTime": false, "source": "welcome" },
                  { "ruleId": "mr-…", "kind": "person", "person": { "pendingName": "Rosa" }, "anyTime": false, "source": "welcome" } ],
  "holdAll": false, "catchUps": ["09:00", "13:00", "17:00"], "focusHours": [ { "from": "09:00", "to": "12:00" } ],
  "quietHours": null, "evenings": "hold", "detail": "paragraph", "showAll": false }
```
- **`letThrough`**: at most **5** (`bad_request` `{reason: "too_many"}`): `person` (`{deskId, contactId}`, or `{pendingName}`, 1 to 60 plain characters typed under "Someone by name…", which the office sends straight here and **never to a model**; Maia confirms a match once: "Is this the Rosa you meant?"), `group` (`family`, `boss`, `clients`, `team`, matching contacts the member tagged), or `match` (`due_today`: a to-do the member made due today, date-only counted as the end of the workday; one an agent made, or changed after reading something untrusted, doesn't count (the office says `mine` in `dueSoon`); `money`: her cap at 80%, a limit stop, a billing notice that isn't already critical; `waiting_reply`: a known, confirmed person in a direct thread who wrote last 24 hours or more ago, on a working day). A report's own status ("blocked") never opens the gate: "a desk stuck" is the desk's failed state. `anyTime` lets it through quiet hours too (true by default for `family`). **"A desk or agent stuck" is always on** and isn't one of the five. Sent without `ruleId`, an entry gets one. With `holdAll` ("Nothing, hold it all") the list must be empty.
- **`catchUps`**: 0 to 8 times `HH:MM` in the desk's zone, at least 60 minutes apart; empty is "Only when I ask" (the held line and the morning brief stay). Work hours are their span (9:00 to 5:00 when empty), weekdays.
- **`focusHours`**: 0 to 3 spans `{from, to}` (`HH:MM`, at least 30 minutes), weekdays. Welcome: Mornings 9:00 to 12:00, Afternoons 2:00 to 5:00.
- **`quietHours`**: `{from, to}` or null (two hours after the last catch-up until the first).
- **`evenings`**: `hold` (Work holds in the evening and at weekends) or `let`.
- **`detail`**: `line`, `paragraph` or `full`: how much she writes in her own turns and composed catch-ups (her note says it); the cards are fixed templates.
- **`showAll`**: "Show everything as it comes", the member's off switch.

Defaults (Skip in the welcome): `letThrough` due today and money; catch-ups 9:00, 1:00, 5:00; no focus hours; quiet hours derived; evenings hold; detail paragraph.

#### Her tool `working_on` (the concept's `focus_set`)

`working_on {label}` (class `own`): the member told her what they're on ("I'm finishing the Q3 plan"). `label` is 1 to 40 plain characters in their words; code picks up to 3 refs from what the member dwelt on in the last 2 hours, so her model never sees an id. **Only in a run started by the member's own message** (refused, "Refused: origin.", in a run a report, a check-in or another desk started, so an injected report can't make its own item "close"). It changes closeness only, never the gate, and ends at the end of the day or after 2 hours with focus elsewhere.

#### Audit and what's kept

Audit (ids only): `maia.reach.set`, `maia.reach.hold` (`until` or `clear`), `maia.reach.rule` (`learned:<answer>`, `undo` or `reset`). Misses are kept in `maia_focus_misses` (below). `maia_focus_kv` keeps the settings (the let-through list with any pending names, the only text, the member's own) and the shield's state: each item's key, kind, desk, level, state and times (no titles), learned rules and counts, the hold, and the stated task (its label in the member's words and up to 3 item ids, until the end of the day); `maia_focus_counts` the day's counts for the measurement signals and `maia_focus_misses` the misses, 90 days. Focus itself (desk, app, item, people, timing) is never written. "Delete Maia Mode history" (`agent.maia.forget`) clears items, counts and learned rules; the member's settings and list stay.

#### Proof: the scenario-day evals

desk-agent `maia/eval/ShieldScenarioEvalTest` replays 27 scripted days (9 personas: founder, developer, designer with clients, phone only, parent part-time, light user, crunch day, adversarial, away day; Monday fresh, Tuesday with corrections, Wednesday checking they held) against the real `Attention`, `ReachItems` and `Shield` on a virtual clock, under four arms (A everything at once, B today's list, C the shield with a 30-minute batch, D the default), and scores each day with the concept's EA rubric by code (a deterministic packaging checker stands in for the concept's Opus judge: no model, no credits). The pass bar holds for D: G1 and G2 on all 27 days, every criterion 3 or more on every persona, overall 3.4 or more; A far below on protected focus and the right moment. Courier threads and documents reach the replay as the office sends them (`courier.attention`'s shape, `desks[].docs`'s) through the desk's own parser, Tuesday's calls are screen shares, and the report counts the bells (the shield's own at most 12 a day, approvals rung by their desk). The report is `target/shield-evals.md`; `ShieldTraceTest` (`-Dshield.trace=persona,day,HH:MM,HH:MM`) prints a window of one day.

### The tray: papers that need the member's decision (Nov 15)

The owner, Nov 15: "an assistant putting some brief papers and supporting materials on an executive desk and him needing to sign off or decline or follow up". Design: `~/ma-coord/design-drafts/maia-tray/SPEC.md`; built on `sub/mm-tray`. Internal name **the tray**, each thing in it **a paper**; members see neither word, nor "Maia Mode": papers live under the shield's **Needs you**, and outside a catch-up the entry reads **Go through them**. desk-agent `maia/Tray` (pure: papers from what the shield holds) and `maia/TrayStore` (`maia_tray_*` rows in `agent.db`). **Code builds every paper, never a model**; her one part is a line and up to 3 answers on a report's paper, in the turn she already runs (`paper_note`, below: 0 extra calls). **She can't answer or approve one:** every answer is the member's tap, carried by the member's own device with their own token. The tray rides the shield: off with it, and off with "Show everything as it comes".

#### Which things get a paper (code, one paper each)

| Source | Paper when | Answers (code's) | Free-form | The answer goes as |
|---|---|---|---|---|
| A pending approval (the shield's merged `approval:<desk>` split, one paper per approval) | not expired | **Approve** · Ask for changes · Decline; for `risk` `send`, `spend`, `delete`, `egress`, or none or one it doesn't know, **Approve…** with `confirm` (`send`, `pay`, `delete`, `share`, or `approve` for the unknown) and no pick | note ≤ 500 (a decline with it) | `agent.approval.decide` on the asking desk |
| A Phase 2 report, `needs_decision` or `blocked` | when it comes to her thread | her `paper_note` answers, else the agent's `ask.options`, else Reply (blocked: Open {agent} · Stop it) | message ≤ 2,000 | her brief's follow-up from the home desk (below) |
| A document in Needs you (`desks[].docs`, `place: needs_you`) | while it's there | Open · Done · Remind me {day} | reply to its person (Courier) or its agent | `docs.tap {chip: done}`; a reply through Courier or `agent.message.send` |
| A person waiting on the member's reply (a known, confirmed direct thread, they wrote last ≥ 24 h ago, a workday) | as above | Reply (quick reply, below) · Remind me {day} · No reply needed | reply ≤ 2,000, sent after 5 s with Undo (no confirm strip) | Courier's draft and send on that desk, the way the message came |
| A to-do due today that came from someone (`dueSoon[].from`) | due today | Done · Move to {day} | none | `todo.close` / `todo.update` on that desk |

Never on a Guild Desk. A Lead's proposal and an agent's own question in its thread aren't papers yet (no source for them reaches the home desk). "Remind me" and "No reply needed" stay on the home desk (the paper comes back that day, or files). Later three times on one paper adds **Tell {asker}: not now** (a decline with the note "Not now"), offered, never done for the member.

**For the confirm strip and the line**, `agent.maia.observe`'s `desks[].approvals[]` add optional `risk` (`write`, `own`, `send`, `spend`, `delete`, `egress`; anything else is dropped) and `untrusted` (boolean), and `desks[].todo.dueSoon[]` adds optional `from` (the to-do's source kind when it came from someone: `courier`, `notebook`, `browser`, `files`, `agent_chat`, `desk`). Never a payload, a title beyond the to-do's own (already sent), or a label.

#### `reach.tray` (topic `agent.maia`)

```json
"tray": { "count": 3, "now": 2, "later": 1,
  "papers": [ { "paperId": "pp-…", "itemId": "mi-…", "kind": "approval",
      "asker": { "kind": "agent", "deskId": "d-…", "agentId": "ag-…", "label": "Work · Writer", "name": "Writer" },
      "title": "Writer needs your OK",
      "line": { "text": "Writer asked while working. Nothing happens until you answer.", "by": "code", "from": null },
      "answers": [ { "id": "approve", "label": "Approve…", "does": "approve", "confirm": { "verb": "send" } },
                   { "id": "revise", "label": "Ask for changes", "does": "revise" },
                   { "id": "decline", "label": "Decline", "does": "decline" } ],
      "pick": null, "freeform": { "to": "Writer", "max": 500, "as": "note" },
      "later": { "allowed": true, "until": 1763150400000, "kind": "catchup" }, "dismissable": false,
      "materials": [ { "materialId": "m-payload", "kind": "payload", "deskId": "d-…", "ref": { "approvalId": "ap-…" }, "label": "What Writer wants to do" } ],
      "reply": { "kind": "approval", "deskId": "d-…", "approvalId": "ap-…", "agentId": "ag-…" },
      "dueAt": null, "expiresAt": 1763142000000, "untrusted": true, "risk": "send",
      "state": "open", "laterCount": 0, "at": 1763140000000 } ],
  "filed": [ { "paperId": "pp-…", "kind": "report", "label": "X1 Carbon", "to": "Scout", "state": "sent", "at": 1763140200000 } ] }
```

| Field | Meaning |
|---|---|
| `count`, `now`, `later` | Open papers; those shown now; those put off by Later or Remind me (they come back at their time) |
| `papers` | The open papers not put off, in stack order: a deadline within 3 hours first (soonest first), then by asker (one asker's papers together, in the order they came), at most 50 |
| `paperId` | `pp-` and 20 base32 characters of the SHA-256 of its source (`approval:<desk>:<approvalId>`, `report:<desk>:<messageId>`, `doc:<desk>:<docId>`, `reply:<desk>:<channelId>:<theyWroteLastAt>`, `todo:<desk>:<id>:<dueAt>`): the same paper on every build |
| `itemId` | The shield item it hangs on (a card's or a catch-up row's `itemId`): the office opens the paper in place for that item's one thing |
| `asker` | `kind` `agent`, `person` or `desk`; `label` "{desk} · {who}" (plain, ≤ 60 a part); `who` `{deskId, contactId}` for a person (the browser fills `{who}` from that desk's Courier at draw time, as the card does) |
| `title` | Code's template, ≤ 80; a report's agent `ask.question` when it gave one (its words, plain) |
| `line` | ≤ 140. `by`: `maia` (her `paper_note`, labelled "Maia's summary"), `agent` (the report's summary, labelled "{agent}'s summary"), `code` (unlabelled). `from`: the material a tap on it opens |
| `answers` | 1 to 4: `{id, label ≤ 28, does, value?, confirm?}`. `does`: `approve`, `decline`, `revise` (decline with the member's note), `done`, `follow_up` (Remind me: `value` is when), `move` (`value` the new day), `reply`, `custom` (her or the agent's answer: `value` the words that go), `open` (opens the first material: never an answer), `not_now`. `confirm.verb`: `send`, `pay`, `delete`, `share` |
| `pick` | The answer drawn as the one primary, or null: never on an approval that confirms, never on Decline |
| `freeform` | `{to, max, as: note | message | reply | none}`: who the box is addressed to and its limit |
| `later` | `{allowed, until, kind: catchup | in_20}`: the next catch-up when it comes before the deadline, else in 20 minutes when that fits (5 minutes to spare), else not allowed (the shield's deadline floor) |
| `dismissable` | False for approvals: no Not now, only Later |
| `materials` | ≤ 4, opened inside the paper: `payload` (`{approvalId}`: the Agent app's card for its tool from `agent.approval.get`), `writeup` (`{writeupId}`: Documents' viewer, `docs.byPath {writeup}`, §25), `doc` (`{docId}`), `thread` (`{channelId}`: Courier's last 5, read-only), `todo` (`{todoId}`) |
| `reply` | Where the answer goes, set by code from the source (never by a model): `kind` `approval`, `maia_brief`, `doc`, `courier`, `todo`, with the ids it needs |
| `filed` | The last 10 papers filed in 2 hours: `state` `sending`, `sent`, `queued` (waiting for its desk), `failed`, `answered`, `withdrawn` (answered elsewhere: the source left while its desk was open), `expired`; `label` the answer's label (code's or hers), never the member's words |

Hidden by the office while a screen share is on ("Something from Writer"); never in a push, the bell or an email.

#### `agent.maia.tray.*` methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `agent.maia.tray.get` | No | `{paperId}` or `{}` | `{paper}`; or `{papers, out}`: every open paper (Later ones with `laterUntil`) and the answers waiting for a desk, `[{outId, paperId, deskId, replyKind, answerId, does, value?, text?, at, expiresAt, reply, sha256?}]` (the member's own words only until sent; `reply` the asking thing's ids as the paper had them when answered, carried from these and never a rebuilt paper; `sha256` the payload hash an Approve named). One past its `expiresAt` (an approval's own; a reply, document or to-do answer 24 hours) is dropped here and its paper `expired` |
| `agent.maia.tray.answer` | Yes, input | `{paperId, answerId, text?, sha256?, device?}` | `{deliver, outId?, until?, paper}`. `answerId` one the paper offers, or `custom` with `text` (where it takes free-form). `text`: ≤ the paper's `max`, no hidden characters; `revise` and `reply` need it. An `approve` needs `sha256`, the 64-hex hash of the payload the paper showed (the office offers Approve only once the asking desk's approval loads and its hash checks); the office approves only that hash, anything else comes back `changed`. `deliver`: `office` (the answer is queued here as `outId` and this device carries it now), `home` (her brief's follow-up goes from here), `none` (Remind me, No reply needed). Errors: `bad_request` `paperId`/`answerId`/`text`/`sha256`, `not_found` `paper`, `conflict` `{reason: answered}` |
| `agent.maia.tray.answer` | Yes, input | `{paperId, outId, delivered}` | `{state}`: the office carried (or couldn't carry) a queued answer: `sent`, `queued` (its desk is asleep: kept with its words), `failed`, `gone` (answered elsewhere: `withdrawn`), `changed` (the payload's hash moved: the paper opens again), `expired`. All but `queued` wipe the words |
| `agent.maia.tray.later` | Yes, input | `{paperId}` | `{paper, until}`; `bad_request` `{reason: deadline}` where Later isn't allowed |

**Carrying an answer** (the office, `web/src/maiamode/shield/trayActions.ts`), on the asking desk's own channel with the member's token: `approval`: `agent.approval.get` (a state not `pending` is `gone` or `expired`), for an Approve the desk's hash equal to the one the member approved and the payload's hash checked as the Agent app checks it (else `changed`), then `agent.approval.decide {approvalId, approve, sha256, note?}` (`revise`, `custom` and `decline` decline, with the note; `not_now` the note "Not now"); `todo`: `todo.close` or `todo.update {due}`; `doc`: `docs.tap {chip: done}`, a reply as Courier's draft and send, or `agent.message.send {agentId, text, origin: "tray"}` (a label only); `courier`: `courier.draft.save {channelId, text}` then `courier.send`. A closed desk keeps the answer here; the office carries what waits when that desk's channel opens. **`maia_brief`**: the home desk sends "The member answered from their desk: {label}." (plus their words) as a code-made `desk_message` under her brief grant for that desk, with the brief block every brief of hers carries, so the agent's answer comes back as a report; it doesn't wait for the answer (role `tray`). No grant: `failed`.

**Learning:** an answer counts as a quick act for its shield item's class (`go`), Later as a hold to the catch-up (`at_catchup`).

#### Her tool `paper_note` and the REPORT `ask`

- **`paper_note {paperId, line, answers?, pick?}`** (class `own`): only in the batched run that read that report (Phase 2's, origin role `reports`), and only for a paper code named in that run's text ("Papers waiting for the member's decision: pp-… (Scout)"). `line` plain ≤ 140; `answers` ≤ 3, each through code's label filter: plain, ≤ 28, and **any** with a link or dotted name (checked after NFKC, the ideographic full stops too), an address, an @, a slash or colon, a number of 5 digits or more (counted across spaces, dots, dashes, a plus and commas), markup or a hidden character drops them all; the agent's own `ask.question` heads a paper only when it passes the same filter (the paper keeps the agent's or code's). It sets no kind, deadline, level, `dismissable` or `reply`, and answers nothing.
- **A report's `ask`:** a desk agent's REPORT line may carry `"ask": {"question": "≤ 140", "options": ["≤ 4 of ≤ 28"], "dueAt": ms}` with `needs_decision` or `blocked` (the brief block says so); the answering desk's code passes it on in the compact report as an `ask:` line, and the home desk reads it through the same filter. Any other status drops it.
- **Her note** lists the open papers by id and kind only ("[paper:pp-…] an approval"), never a title or anyone's words; when the member asks what needs them, her reply names them and the room draws each paper from `reach.tray` (a `[paper:pp-…]` that isn't one of the member's papers draws nothing).

#### Quick reply (the owner, Nov 15)

"Kind of like how iPhones have that drag and reply feature with notifications that show up at the top." On every card, held row and paper about a message from a person, a **reply arrow** ("Reply to Rosa") opens a reply field right there, focused, with their last message quoted (read from that desk's Courier at draw time, `courier.thread`, never stored); dragging the card down (or a long press on a phone) and R on a focused card are shortcuts; Esc closes; Cmd/Ctrl+Enter sends. **Typing and Send is deliberate:** no second confirm; "Sent to Rosa · Undo" for 5 s, then the reply goes, and an Undo sends nothing (one-tap answers that send, pay or delete keep the confirm strip). It goes **the way the message came**, as Courier's own composer does: the last received message's medium and account, to its sender (`courier.draft.save {channelId, text, medium, accountId, replyTo, to, subject?}` then `courier.send`), and the arrow shows only where that can send (Courier's switch on in the office, that desk's `courier.status` on and `sending`, the account it came to able to send and signed in). A card's or a row's item then hears `agent.maia.reach.answer {answer: replied}` (no Back: the member never left); a paper's reply is its own answer (`reply`, `text`). Maia never drafts it (the owner's answer to the tray's open question: no).

#### Audit and what's kept

Audit (ids only): `maia.tray.answer` (`paper:<id>`, the `does` word), `maia.tray.delivered` (the delivered word), `maia.tray.later`. `maia_tray_papers`: each paper's id, its source key, kind and desk, state, Later's time and count, the answer's id and label, when and on which device, her line and answers (7 days, then cleared on disk too); answered ones 30 days; a report's paper still open after 7 days goes. `maia_tray_out`: answers waiting for a desk, the member's words only until sent. Never a message's subject, a document's text or the member's words past sending. "Delete Maia Mode history" clears both.

## 24. Helpers on MA's credits

The owner, Nov 15: Minimalist Alliance acts as the AI provider for members' own desk agents ("helpers") too, so the welcome never stalls on "bring your own key", and "we can continue to be a provider and just arbitrate with minimal overhead the best model that we find that can drive a desk". A helper whose provider is MA runs on the member's **MA credits**; members keep bringing their own keys per helper whenever they like. Platform contract: ma-platform `docs/contracts/desk-helpers.md` (0.4.8 draft, ADR 0142).

**On the agent socket (deskd and desk-agent):**
- **The hello:** deskd's tools hello carries `helpers: {model: true}` while the Platform's service is configured (`endpoints.maia` in the agent config, the same service as §23's), and goes again with the same `maiaServiceChanged` resend. An older desk-agent ignores it.
- **`tcall` `helpers_model`**: one model call of a helper. `args` only the contract's fields: `task` (`agent` or `small`), `callId`, `context` (the helper's own instructions, at most 100,000 characters), `messages`, `tools` (at most 128), `maxOutputTokens`. deskd adds `"v": 1` and posts it to `{endpoints.maia}/v1/desk-helpers/call` with §23's proof (the same audience, a fresh proof over the exact body, one retry on `401 desk_auth`). The `tres` is the Platform's 200 as given: `text`, `toolCalls`, `stopReason`, `usage`, `costCredits` and `credits`; never money, never a model's name.
- **`tcall` `helpers_credits`**: the member's credits, `args` `{callId}` (a fresh UUID, so each read's proof is its own) or none; posted to `/v1/desk-helpers/credits`. The `tres`: `{v: 1, enabled, credits: {left, starting, topUp, lighter, lighterLeft?}}`; since the one wallet (desk-maia.md 0.4.10, Nov 15) `credits` also carries `month`, `monthLeft`, `topUpLeft`, `day`, `dayUsed`, `week`, `weekUsed`, `drawingFrom` and `renewsAt`, the same object as Desk Maia's `allowance.credits` (§23, "One wallet"), and deskd relays it as it came. The first read or call from any of the member's desks makes their starting grant.
- **deskd's own refusals, in order, before anything goes out** (`terr`): `forbidden` `maia` (Desk Maia's calls are hers, §23, never on the member's credits), `bad_request` `agentId` (none), `forbidden` `guild_desk`, `forbidden` `teen` (deskd's band isn't adult; unknown counts as a teen), `unavailable` `no_service`, `bad_request` `args`/`field`, `too_large` `body` (over 3 MiB), `rate_limited` (more than 4 at once). Free members' desks may call: their helpers get starting credits too. The Platform's refusals come back with their `code` and only `reason`, `resetsAt`, `window`, `retryAfterSec` in their shapes: `forbidden` (`self_hosted`, `closed`, `teen`, `guild_desk`), `limit` (`credits_used` with no reset; `limit_lighter` or `limit_pool` with `resetsAt` at midnight UTC and `window: "day"`), `rate_limited`, `too_large`, `unavailable` (`off`, `provider`, `no_model`).
- Never reaches `ToolHost`. Nothing of a call or its answer is logged.

**In desk-agent:**
- **The provider and the "key":** provider `ma-credits` ("Minimalist Alliance", `ProviderId.MA_CREDITS`, in no `agent.providers` list), key `ma-credits` (`KeyRing.CREDITS`: no key material, lent as an empty lease, never held, sealed or put; no key can be added for `ma-credits`), model `auto` (the Platform picks; the small jobs go as task `small`). `LlmGateway` lets any of the member's own agents use it on that key only, never Desk Maia (and Desk Maia's `ma` stays hers alone); it keeps no dollars for these calls (only the desk's token limits bind them: the Platform's credits are the limit).
- **`agent.key.list`:** while deskd offers helpers and this isn't a Guild Desk, a first row `{keyId: "ma-credits", provider: "ma-credits", providerName: "Minimalist Alliance", label: "MA credits", last4: "", available: true, credits: {left, starting, topUp, lighter, lighterLeft?} | null}` (whole credits, never money; null while it can't be read, waiting at most 3 s). With the one wallet (0.4.10) it's the newest wallet view from Desk Maia's answers or any agent's, with `month`, `monthLeft` and `renewsAt` besides. `agent.key.models` for it: one model, `{id: "auto", label: "Picked by Minimalist Alliance", tools: true, credits: true}`. `agent.key.delete` for it: `forbidden` `credits`.
- **`agent.bind {agentId, keyId: "ma-credits", model: "auto"}`** puts a helper on the member's credits: `bad_request` `model` for any other model, `precondition_failed` `no_service` where deskd doesn't offer helpers (or on a Guild Desk); Desk Maia stays `forbidden` `company`. `agent.create` and `agent.update` take the same key.
- **New helpers default to the credits:** an `agent.create` with no `keyId`, where deskd offers helpers and the member's credits are usable (some left, or the lighter model's share for today), is bound to `ma-credits`/`auto` (audited `agent.bind … key:ma-credits` `credits`); otherwise it waits for a key as before. A key given always wins. The welcome's helpers (`agent.create` with no key) take this path.
- **The welcome never makes a helper that can't run:** it sends `agent.create` with `ifRunnable: true` and no key, so desk-agent makes the helper only when it can run now on the member's credits (deskd offers helpers, not a Guild Desk, credits usable) and binds it to `ma-credits`/`auto`; otherwise it answers `precondition_failed` `reason: cant_run` and makes nothing (the owner, Nov 15: helpers with no key and no credits sat dead on the desk). With a `keyId`, `ifRunnable` changes nothing.
- **Runs:** a refusal before the call settles nothing. After `limit` with a reset nothing is sent until then; with none (`credits_used`), a minute (a top-up can come at any time). The run ends `provider_error` with `errorDetail` `limit`, `forbidden` or `rate_limited`, which the Agent app words for MA's credits ("Your MA credits are used up for now. Give this agent your own key to keep going."). Files read to text go fenced in the member's turn as with every provider; a picture goes as a line naming it (the contract takes no images yet).

## 25. Documents

Documents' desk side (id `docs`; the office calls it **Documents**): one index of every document this desk holds, from Files, Browser downloads (once they land in Files, ADR 0092), Courier attachments, Notebook pages, agents' outputs and Desk Maia's write-ups (Phase 2), sorted into places that are **labels, never folders**. Nothing is moved or renamed to sort it. The product design is the owner-approved documents concept (Nov 15: "a viewer inside the office, and Maia can sort, find and hand over documents, contents read only when the member taps"); the decisions are [draft ADR "Documents"](../../../docs/decisions/draft-documents.md). Built on `sub/mm-documents`; Notebook pages, write-ups, the office's person key and the front's ids on `sub/mm-documents-2`.

**Where it lives.** `/data/desk/docs.db` (deskd's own SQLite file, WAL, `synchronous=FULL`, 0600), the render cache `/data/desk/docs-cache/` (page images, 7 days, at most 1 GiB, least recently used first) and the version store `/data/desk/versions/<sha256>` (old bytes of a document, at most 10% of the drive; unnamed versions go after 30 days, named milestones stay). One per desk. **Nothing of it leaves the desk**: the office's "All desks" view merges each desk's `docs.list` in the browser, and between the member's own desks only structure moves (ids, enums, times, counts, person keys). A Guild Desk has none. A teen's desk has the index and the viewer (code only), never the reader. The data export's `desk` part carries `docs.db`'s rules, links, milestones and summaries as JSON (`docs.export`).

### Who may call

| Method or topic | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `docs.*`, topic `docs` | yes, on any personal desk (a teen's too) | `docs.export` only | `forbidden` `{reason: "scope"}` |

Checked in this order: a guild desk, `forbidden` `{reason: "scope"}`; no store, `unavailable` `{reason: "store"}`; the kill switch `/data/desk/docs-switch` saying `off`, `unavailable` `{reason: "switched_off"}`. Documents ships on; the switch only stops it. A deskd before this section answers `not_found`.

### A document

```json
{ "id": "d_01jc…", "kind": "attachment", "type": "pdf", "title": "12 Nov · Rosa Ortiz · Contract",
  "origName": "Contract v3 final (1).pdf", "size": 182044, "place": "needs", "maybe": false,
  "reason": { "code": "changed", "text": "Page 3 changed" }, "dueAt": null,
  "from": { "name": "Rosa Ortiz", "personKey": "pk_3f…" }, "arrivedAt": 1763100000000, "changedAt": 1763190000000,
  "changedBy": { "kind": "person", "name": "Rosa Ortiz" }, "state": "new", "copies": 2, "versions": 3,
  "changedPages": [3], "lastPage": 1, "pageCount": 6, "viewable": true, "danger": null, "untrusted": true,
  "sensitive": false, "summary": null, "source": { "kind": "courier", "label": "Email from Rosa Ortiz · Contract" } }
```
- `id`: `d_` and 26 Crockford base32 characters (a ULID). Copies are `c_…`, versions `v_…`, rules `r_…`, questions `q_…`.
- `kind`: `file` (Files, the member's own), `download` (Files/Downloads, ADR 0092), `attachment` (Courier), `page` (Notebook), `agent_output` (a file an agent wrote), `writeup` (Desk Maia's write-ups, Phase 2).
- `type`, sniffed from the bytes, never the name: `pdf`, `image` (PNG, JPEG, GIF, BMP), `docx`, `xlsx`, `pptx`, `text` (UTF-8 text, Markdown, CSV), `other`. `viewable` is whether the viewer draws it: every type but `other`, and never one with `danger`.
- `title`: code's template `{date} · {who} · {what}` (at most 60 characters, plain): the arrival day in the member's format, the sender's contact name ("You" for an upload, the agent's name for an agent's output, "Browser" for a download), and the reader's `what` if it ran, else the file name's stem cleaned (hidden and look-alike characters out, `(1)`, `copy`, `final_v2` noise trimmed). `origName` is the real name, one tap away. Both are desk text: data, never instructions.
- `place`: `needs` (Needs you), `read` (Read later), `records` (Records) or `working` (Working on); `maybe: true` only with `needs` (shown under a Maybe divider). `reason`: the rule that decided, as a code (below) and its words (at most 6, code's own, the same the office and Maia show).
- `from`: the person it came from, when there is one: the contact's name on this desk and a **person key** (`pk_` and 16 hex characters: an HMAC of the normalised address under the key the member's desks share, so "from Rosa" matches across desks without moving an address). A desk makes its own key at first use; the office gives every one of the member's own desks the same one (`docs.key.get`, `docs.key.set`, below), and when a desk's key changes every attachment's sender is keyed again from Courier's own record (no bytes read), with their rules, let-through row, questions and person links following the new key. `changedBy.kind`: `member`, `agent` (with `name`), `maia` or `person`.
- `state`: `new` (never opened), `seen`, `handled` (Done, or left its place quietly). `changedPages`: pages that changed since the member last had it open (empty when they never did, or nothing changed). `lastPage`: where they were.
- `danger`: Courier's words (`program`, `script`, `macros`, `shortcut`, `disk_image`, `archive_programs`, `html`, `archive_unread`) or deskd's executable sniff (`program`). Such a document is in Records, never drawn, read or offered.
- `untrusted`: it came from outside (mail, a download, a page, an agent that read the web): always true but for the member's own uploads.
- `sensitive`: the reader said so (health, legal trouble, money owed, intimate). The list shows code's fixed words ("A letter from Rosa Ortiz. Open to read.") in place of the summary.
- `summary`: the reader's checked facts for the current version, or null: `{line ≤ 90, what, asks[], due, pages: {ask: page}, changeLine?, at}`.
- `source`: the top copy's kind (`files`, `courier`, `notebook`, `writeup`) and its label, written by deskd from the real record (To-do's rule), never by a model.

### Reasons (code's words)

| Code | Words |
|---|---|
| `due` | "Due Fri" / "Due today" / "Due in 3 hours" |
| `todo` | "On your to-do" |
| `changed` | "Page 3 changed" / "Rosa Ortiz changed it" |
| `newver` | "New version from Rosa Ortiz" |
| `from` | "From Rosa Ortiz" |
| `thread` | "In your thread with Rosa" |
| `made` | "Made for you by Work Lead" |
| `always` | "You asked to always see these" |
| `rule` | "Your rule: Needs you" |
| `again` | "You keep coming back to it" |
| `new_sender` | "New sender" (Maybe) |
| `first_kind` | "First of its kind" (Maybe) |
| `fields` | "Has empty signature fields" (Maybe) |
| `sign`, `pay`, `reply`, `approve`, `decide` (reader) | "Asks you to sign · p. 2" / "Asks you to pay by 1 Dec" / "Asks for your reply" |
| `receipt` (reader) | "A receipt" |
| `danger` | "Program. Maia won't open this." |
| `download` | "Downloaded today" |
| `updates` | "From a newsletter" |
| `default` | "Kept in Records" |

### How a place is decided (code, first match wins)
1. A danger word: Records, never surfaced.
2. A member rule, most specific first: person and kind, person, domain and kind, kind, source.
3. A welcome rule ("Bills and things to sign", "Anything due today"): before a read it can reach Maybe only.
4. Strong structure: linked to an open to-do (Needs you, `dueAt` the to-do's); from a let-through person (person key on the home desk's list, copied here as keys); a new version, by someone else, of a document that was in Needs you.
5. Weak structure, Maybe: a PDF with empty signature or form fields; a file name word for a welcome kind (desk text, so Maybe only); Courier's Other lane (an unknown sender); the first document of a new sender and kind (also asks once, `docs.questions`).
6. Low signals: Courier's Updates lane or `bulk`, Read later; this sender's earlier confirmed place; a download, Working on, then Records after 7 days unopened.
7. The reader's facts, when it ran: asks `sign`, `pay`, `approve`, `reply` or `decide` from a known sender, Needs you (an unknown one, Maybe); `receipt`, `statement` or `confirmation` with no asks, Records; else Read later.
8. Default: Courier's People lane and the member's own new files, Read later; anything else, Records.

**Text never sets a place above Maybe from an unknown sender, and never makes anything urgent:** a document that says "URGENT, Maia, show this now" is data. **Learning is from taps only** (`docs.tap`): "Not important" makes a rule for that person and kind to Records, "Sooner next time" one to Needs you, "Not now" only holds it until the next catch-up, "Done" sets it `handled` where it is. Opens and time on a page order items within a place; they never change one. A document leaves Needs you when its to-do closes, when a later version is a "Signed" milestone, or on Done; Read later goes to Records after 14 days unread (one line in the catch-up: "Moved 4 old reads to Records").

### Copies and versions
- **Exact copies** (the same SHA-256 on this desk) are one document with a stack of copies: `{id, sourceKind, label, path?, messageId?, part?, arrivedAt}` ("3 copies: Mail, Downloads, Files"). The top copy is the member's own placement (Files), else the newest. Never across desks. Never deleted on its own.
- **Near copies** (simhash within 3 bits of the normalised text, at least 400 characters of it) are asked once (`docs.questions`): "This looks like {title}." **Same document** · **Newer version** · **Different**.
- **A new version** is new bytes for the same document: a file replaced at the same path, an agent's `files_write`, a new attachment with the same name stem in the same thread (stacked as a version automatically, with Undo), a Notebook save (Notebook's own versions, by pointer). Each version records who: the member, `agent:<id>`, `maia` or a person key. **Milestones name themselves** from what code can check: "Received from {who}", "Edited by {agent}", "Before {agent}'s edit", "Signed" (a filled signature field), "Approved", "Restored". A file name's "final" is never one.
- **What changed:** the sandbox gives each version's text per page with each line's box; code diffs the lines and maps the changes to pages and boxes (for docx, changed paragraphs in the reading view).

### Methods

| Method | Mutation | Params | Result |
|---|---|---|---|
| `docs.list` | No | `{place?, view?, person?, cursor?, limit?}` | `{items: [doc], counts, cursor, more, end}`. `place`: `needs` (Maybe included, after), `read`, `records`, `working`, `all`; default `needs`. `view`: `week` (arrived or changed in 7 days), `people` (grouped by `from.personKey`, with `person` to narrow). `limit` 1 to 100 (50). `counts`: `{needs, maybe, read, records, working}`. `end`: "That's all for now." when nothing more needs the member, else null |
| `docs.get` | No | `{id}` | `{doc, copies, versions: [{id, sha256, at, by, milestone, pagesChanged, current}], links: [{kind, ref, label}], alsoIn: [{kind, ref, label}], questions: [question]}` |
| `docs.search` | No | `{q?, person?, from?, to?, kind?, type?, inText?, limit?}` | `{items: [doc + {matchedText}], more}`. Code only: person, time, place and words in the title and file name; `inText: true` also searches each version's text (FTS5). The same query gives the same order for 7 days unless a document changed or went. Never a snippet |
| `docs.byPath` | No | `{path}` or `{writeup}` | `{id}` for a Files path, `not_found` when it isn't indexed (yet); with `{writeup: "wu-…"}`, the write-up's document (the decision tray's material, §23) |
| `docs.text` | No | `{id, version?}` | `{type, pages: [{n, text}]}` or `{type, sections: [{kind: p \| h \| table \| slide \| sheet, text, rows?}]}`, at most 200,000 characters, plain text only (the reading view and "Read as text"). `forbidden` `{reason: danger}` |
| `docs.page` | No | `{id, page, width, version?}` | `{transferId, size, sha256, format: jpeg \| png, width, height, pageCount, lines: [{b: [x, y, w, h], changed}]}`, then the image on `bulk` (as `courier.attachment.image`). A PDF page drawn in the sandbox at `width` (200 to 1,600 px) or an image drawn again from its pixels; boxes are 0 to 1 of the page, `changed` against the version the member last saw. Never the original bytes. `forbidden` `{reason: danger}`, `bad_request` `{reason: unsupported}` for a type with no pages |
| `docs.page.stop` | No | `{transferId}` | `{}` |
| `docs.changes` | No | `{id, from?, to?}` | `{pages: [n], line, changeLine?, paragraphs?: [i]}`: what changed between two versions (default: the one last seen and the current one). `line` is code's ("Pages 3 and 7 changed"); `changeLine` the reader's, when it ran |
| `docs.questions` | No | `{}` | `{questions: [{id, kind: file \| near \| project \| tidy \| missed \| rename, text, choices: [{id, label}], docIds}]}`: at most one is asked per catch-up (Desk Maia and the shield take the first) |
| `docs.rules` | No | `{}` | `{rules: [{id, match: {person?, personName?, domain?, kind?, source?}, effect: needs \| read \| records \| ask, madeBy: tap \| welcome \| answer, at, text}]}`. `text` is the rule in plain words ("Invoices from Northwind → Records") |
| `docs.summary` | No | `{}` | `{counts, needsYou: n, maybe: n, held: n, firstSort?: {n, k}}`: counts only, for To-do's tile and Desk Maia |
| `docs.feed` | No | `{since?}` or `{front: true}` | `{rev, items: [{id, kind, type, place, maybe, reason, dueAt, changedAt, personKeys, links, copies, state}], more}`: structure only (S0), for the home desk's ranking. Never a title or name. With `front`: `{items: [{docId, place, dueAt, changed, at, contactIds?, channelId?, agentId?}], more}`, at most 50 (what each goes with, for the shield's "close to what's open": an attachment's Courier contact and channel ids, the agent that made an output or write-up; ids only), the documents in front of the member now (open Needs you and Maybe, new in Read later, anything changed since last opened; never held, handled or gone), `place` in the shield's words (`needs_you`, `maybe`, `read_later`, `records`, `working`). The office sends these as `desks[].docs` in `agent.maia.observe` (§23), so a document rides the focus shield's breaks and catch-ups; read again on each `docs` event |
| `docs.tidy` | No | `{}` | `{copies, downloads, drafts, bytes, items: [{id, copyId, label, size}]}`: what "Tidy up" would move to the trash |
| `docs.export` | No | `{}` | `{rules, links, milestones, summaries, projects}` as JSON (the data export's `desk` part) |
| `docs.tap` | Yes | `{id, chip: not_now \| not_important \| sooner \| done}` | `{doc, rule?, toast: {text, undo}}`. "Not important": `Not important: Invoices from Northwind go to Records now.`; "Sooner": `Invoices from Northwind go to Needs you now.`; "Not now": `Held until 5:00 pm`; "Done": `Done`. `undo` is a token for `docs.undo` (10 minutes) |
| `docs.undo` | Yes | `{token}` | `{doc}` |
| `docs.answer` | Yes | `{questionId, choice}` | `{rule?, doc?}` |
| `docs.rule.add` | Yes | `{match, effect}` | `{rule}` |
| `docs.rule.remove` | Yes | `{id}` | `{}` |
| `docs.seen` | Yes | `{id, page?, ms?}` | `{}`: the member had it open (the viewer sends it on open and on leaving). Sets `state: seen`, `lastPage`, the version they saw (for `changedPages`), and after 20 s takes a Read later document to Records |
| `docs.restore` | Yes | `{id, version}` | `{doc, toast: {text: "Restored. The newer one is kept as a version.", undo}}`. Files copies only |
| `docs.rename` | Yes | `{id}` | `{doc, from, to}`: renames the Files copy to the clean title, once, on the member's tap ("Rename it to match?"). Idempotent; never a file open elsewhere; a version event with the old name |
| `docs.tidy.apply` | Yes | `{}` | `{moved, toast: {text: "Tidied. 6 items in the trash for 30 days.", undo}}`: extra exact copies (where the stack keeps one in the member's place), downloads never opened after 30 days, agents' superseded drafts never opened. Never the only copy, anything linked to an open to-do, anything opened in 30 days, a milestone or a Notebook page. Into Files' trash, 30 days |
| `docs.read` | No | `{id}` | `{asked, have}`: "What's this?" or "What changed" with no reading yet asks the reader once for the current version (a tap, outside the day's 15); the facts come on the topic `docs`. `asked: false` where the reader can't run (Desk Maia off here, a teen's desk, a danger type, text the sandbox couldn't read) |
| `docs.key.get` | No | `{}` | `{keyId, shared, key?, at?}`: the person-key secret the office gave this desk (`key`, 64 hex characters) and when it was first made (`at`, ms), only once the office set one (`shared: true`); a key the desk made for itself is never handed out. The office reads it to give a desk opened later, or another browser, the same one |
| `docs.key.set` | Yes | `{key, at?}` | `{keyId, changed}`: the office gives every one of the member's desks the same person-key secret (64 hex characters), so "from Rosa" matches across desks; `at` is when that secret was first made (default now; at most a day ahead), so two made at once settle on the earliest. On a change, the senders are keyed again as above. Never leaves the member's own channel; `docs.summary`'s `keyId` says whether two desks agree |
| `docs.ask.allow` | Yes | `{id}` | `{until}`: the member tapped "Ask Maia about this" in the viewer (after the first-time sheet): Desk Maia's `docs_ask` may read passages of this document for 10 minutes. Since Nov 15 the office's viewer asks the desk's own agent instead (draft ADR "Documents", amendment) and calls this no more; it stays for a client that does |

Errors: `not_found` `{reason: "doc"}`; `forbidden` `{reason: "danger", danger}`; `bad_request` `{reason}` with the field; `unavailable` `{reason: "sandbox"}` when the parse sandbox can't be reached (the list still works; the viewer says "Open this when your desk can draw it."); `unavailable` `{reason: bandwidth_limit, resumesAt}` for `docs.page` while the member is paused at a bandwidth limit.

### Topic `docs`

SUB (owner only) gets a `snapshot` of `{rev, counts}`, then `changed` events `{rev, ids, counts}` (at most 50 ids; over that, `ids` is null and the client refreshes), merged to at most twice a second. Ids and counts only, never a title.

### What deskd does on its own
- **Intake.** From Files' changes (any folder but the trash), Courier's accepted mail (People, Updates and Other lanes only; Requests, Spam and Trash never; backfill never "new"), Notebook's pages and Desk Maia's write-ups. Each new version: SHA-256 → exact copy → the sandbox's pass (text per page, each line's box, empty signature and form fields) → simhash → near copy → title → place → `docs` event. One file at a time through the sandbox, at its own `cpu-shares 256`.
  - **Notebook pages** (`page`, copy ref `n:<pageId>`, label "Notebook · {tab}"): read through deskd's own calls to desk-notebook as the owner, reads only (`notebook.outline`, `notebook.page.markdown`, as the Agent's Notebook tools), every 5 minutes and when Notebook's tree changes while it's open; a page is read again only when its `updatedAt` moved. Its Markdown (at most 1,000,000 characters) is the text for search and the reading view; the title is the page's own. A change follows the page **in place** (one version row; Notebook keeps its own history). Quiet: `state: seen`, never "new", placed by the same table (the member's own notes land in Records unless a rule or a to-do says otherwise). Two pages that read the same are two documents; a file is never stacked onto a page. A page that leaves the outline (trashed, purged) leaves; while Notebook is away, nothing does. Agent-marked text on a page makes it `untrusted`.
  - **Desk Maia's write-ups** (`writeup`, copy ref `w:<wu-id>`, label "Write-up by {agent}", title "{date} · {agent} · Write-up"): the full write-ups agents on this desk kept for her briefs (Phase 2's `desk_writeups`, 90 days), read from desk-agent by cursor every 5 minutes (`desk.docs.writeups`, below). Agents' words: `untrusted`, "Made for you by {agent}", quiet (`seen`). One whose answer held this desk's private data (desk-agent's `readable` mark, private until its answer's call says otherwise) is **never sent to the reader**, and the mark is followed if it changes. One desk-agent no longer keeps leaves the index.
- **The first index** of an existing drive runs only while nobody is streaming the desk (or nobody's looked in 2 minutes), at most 2 files a second, and resumes where it stopped after a restart. When it ends, one question: "I sorted 312 documents. 4 might need you." (`firstSort`).
- **The reader** (when Desk Maia is on for this desk, never on a teen's desk): for Needs you and Maybe documents about to be shown (`docs.list` with `place: needs`, Desk Maia's offer) and on the member's "What's this?" or "What changed", deskd asks desk-agent for one reading of one version (`desk.docs.read`, below). Cached per version (one read per version, ever), at most 15 a day per desk outside taps, skipped when her allowance is used up (code falls back to structure, no error shown). Its facts are checked by code (§ "The reader's facts").
- **The tidy**, nightly: render cache over 7 days or 1 GiB, versions past their 30 days or the 10% cap (unnamed first), seen records past 90 days, a document's rows when its last copy left the trash.

### The reader's facts (desk-agent `maia/DocReader`, task `read` on her service)
deskd → desk-agent `desk.docs.writeups` (deskd's own, never relayed; refused with any caller): `{after, afterId, limit?}` → `{items: [{id, agentId, agentName, at, readable, text}]}`, the write-ups kept after that cursor, oldest first, at most 20, each text cut to 200,000 characters; `{id}` → that one; `{kept: true}` → `{kept: [id], readable: [id]}`.

deskd → desk-agent `desk.docs.read {docId, versionSha256, title, pages: [{n, text}], before?: [{n, text}]}` (at most 30,000 characters of text, fenced as untrusted, never a path or another document) → `{what, asks, due, pages, line, changeLine?, sensitive}` or `{skipped: reason}`. desk-agent makes one tool-less call through her service (task `read`, Haiku-class by MA's setting, her credits) and checks every field: `what` one of invoice, contract, statement, receipt, confirmation, letter, form, report, slides, sheet, photo, other; `asks` a subset of sign, pay, approve, reply, review, decide; `due` a real date or null; `pages` only pages the document has; `line` and `changeLine` at most 90 characters, plain, no link, address or markup. There's no importance score: code decides from the facts.

### Desk Maia's document tools (§23, on the home desk)

`tool.docs.*` on the agent socket, through `ToolHost`, for Desk Maia only (agent `maia`), never a team agent:

| Tool | Does | Returns to her model |
|---|---|---|
| `docs_find` | Code search of this desk's index: `{person?, from?, to?, kind?, words?, inText?}` | At most 20 pointers `{deskId, docId}` with titles (data), kind, place, who and dates |
| `docs_handover` | One document's facts and its card: `{docId}` | Title, who, kind, place, reason, due, changed pages, copies; the reply then carries `doc: {deskId, docId, page}` and the room draws the card from the desk |
| `docs_ask` | Passages for the member's question, only within 10 minutes of their tap ("Ask Maia about this", `docs.ask.allow`): `{docId, question}` | At most 1,200 characters of passages with their pages, fenced as untrusted; `maia_not_allowed` without the tap |
| `docs_offer_rule` | Puts a sorting question to the member as choices: `{docId}` | The member's tap, as their next message |

She can't change a place, make or remove a rule, hide, delete, rename or stack: each needs the member's tap. `office_show` takes `app: "documents"` with `ref` a document id (`d_…`, optionally `#p3` for a page) to open the viewer in her room.

### Audit
The desk's log, ids only: `docs.read` (`doc:<id> v:<sha8>`), `docs.ask` (`doc:<id>`), `docs.rule` (`rule:<id> effect:<e>`), `docs.tidy` (`moved:<n>`), `docs.rename` (`doc:<id>`), `docs.restore` (`doc:<id>`).
