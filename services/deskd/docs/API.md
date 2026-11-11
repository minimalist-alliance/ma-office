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
| `agent.*` | | | §11 |
| `notebook.*` | | | §13 |
| `data.parts.list`, `data.manifest`, `data.read`, `data.read.stop`, `data.browser.hold`, `data.browser.release`, `data.browser.cookies` | Only hold and release | §12 | §12 |
| `browser.minified.*`: `get`, `act`, `image`, `island`, `site.get`, `site.set`, `sites.list`, `sites.clear` | Only `act` | §14 | §14 |
| `browser.adblock.site.set` | Yes | §14 | §14 |
| `apps.*`: `list`, `catalog.get`, `install`, `remove`, `start`, `stop`, `view.get`, `call`, `mutate` | Only `install`, `remove` and `mutate` | §19 | §19 |

For `desk.status.get`, every field is always present. No session can reach it before deskd has read IMDS and desk-rtc has answered, so none of them is null in practice. §10 has the `browser.*` methods, §11 the `agent.*` ones and §12 the `data.*` ones and §16 the `files.*` ones.

## 5. Subscriptions

The topics served today are `desk.attention`, `browser.tabs`, `browser.clipboard`, `browser.links` and `browser.view` (§10), `browser.minified:<tabId>` (§14), `agent.state` and `agent.conversation:<agentId>` (§11), `notebook.tree` (§13), `files.changes` (§16), `desk.contention` (§17), and `apps` and `app:<id>:<topic>` (§19). Any other SUB returns `not_found` for now, and so does `browser.clipboard` on a deskd older than the clipboard. The next stages add the others in design §4.2.5. Every topic is the owner's, except the three a guild member may have (§15) and the apps' (§19): an `export` session's SUB gets `forbidden` with `{reason: "scope"}`, and so does a guild member's to any other.

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
- SUB with the same `topic` and `params` as a live subscription of this session returns the same `subId`.
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

Milestone 2: see and drive a real Chromium on the desk (`desk-runtime.md` §8, ADR 0041). This is the only way a client reaches Chromium. No method exposes CDP or runs script in a page. deskd itself asks a page one fixed question, whether it's on screen, in an isolated world the page can't touch, and on a teen's desk it reads and replaces Chromium's own error page the same way ("A teen's filtered sites", below). A desk nobody looks at encodes nothing, and its Chromium freezes once nothing works it ("Nobody looking", below). The simplified view (§14), on with a kill switch, runs its own constant scripts in a world of its own, and so does the phone view ("On a phone", below). To tell when a page is refused protected playback, deskd also puts one fixed script in each tab's page, and listens for it in that same isolated world ("A protected video that can't play", below). Snapshots, downloads, file upload and agent tabs aren't built yet. Bringing passwords and bookmarks in, and the key button, are "Signing in", below: they run only Chromium's own constant functions, in hidden pages of Chromium's own.

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
- **A desk that becomes a teen's restarts Chromium at once,** so it comes back under the teen policy (`age.md` §8). The session's state doesn't change, the picture shows the desk without its Browser for a few seconds, `browser.tabs` goes quiet and then gives a new list with new `tabId`s, and calls get `unavailable` with `reason: chromium` until then. Tabs, cookies and history carry over (ADR 0035). A hold makes it wait for the release (§12). The other way, from teen to adult, waits for Chromium's next start, and nothing happens at the time.
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

An agent's Browser tools (§18) open their own tabs, never the member's: hidden targets with no window, in the run's own off-the-record browser context (no cookies, sign-ins or saved cards, nothing written to the profile, downloads denied), or, after the member's approval, one hidden tab in the member's own context for one site and one run. None is ever in `browser.tabs`, the tab on screen, the kept order or a crash's handling, no `browser.*` method reaches one by id, and every one goes when its run ends, at a freeze or with the connection to Chromium. deskd sends Chromium only commands on an allow-list for them, none that clears or writes storage, cookies or history, no trusted mouse or key input, and script only deskd's own, into deskd's own isolated world (`browser/AgentCdp`). A navigation off the granted site in the member's tab is cancelled, and loopback, link-local, private-range and single-label hosts are refused in both, from the tab's main frame and from every frame of it, a frame of another site in a process of its own included: each such frame is held at its start until its own document requests stop at deskd too, and one whose requests can't be stopped is never let run (S-14). The page is told it has focus (`Emulation.setFocusEmulationEnabled`), as a tab on screen has, so its focus events fire for the Agent's clicks and keys.

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
| `forbidden` | `{reason: "blocked"}` | The desk's policy blocks this URL (`net::ERR_BLOCKED_BY_ADMINISTRATOR`). Any other navigation error is a normal result with `netError`, such as `net::ERR_NAME_NOT_RESOLVED` |
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
| `agent.create` | Yes | `{name, purpose?, icon?, tone?, keyId?, model?, solo?, workspaceMb?}` | `{agent}`, or `precondition_failed` with `reason: agent_cap` at the tier's cap (task 49) |
| `agent.update` | Yes | `{agentId, name?, purpose?, icon?, tone?, solo?, workspaceMb?, badgeHidden?, dismissBadgeNotice?}` | `{agent}` |
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
| `agent.key.models` | No | `{keyId}` | `{models: [{id, label, inputMicroUsdPerMTok, outputMicroUsdPerMTok, free, tools}]}`, the first a good default |
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

- **Task 49, many agents** (desk-agent `docs/multi-agent.md`, ADR 0047): deskd relays the methods above like the rest and checks nothing of their params, but refuses every team method (`agent.create`, `agent.delete`, `agent.links.set`, `agent.caps`, `agent.workspace.*`, `agent.timer.*`, `agent.icon.*`, `agent.a2a.list`, `agent.proposal.answer`) for a guild member with `forbidden` and `{reason: "permission"}`, as desk-agent does; only `agent.get` (their own agent) passes. The new fields of an agent, a message's `origin`, `tools` and `proposals`, and `agent.state`'s `caps` come through unchanged. `desk.account.set`, deskd's own push, now carries `tier`, the owner's tier's agent values from the config's `agentDefaults.tier` (kept with the other account values in `account-defaults.json`; a config with no tier keeps the last one, and desk-agent keeps the last it received). It also carries `band`, the owner's age band as deskd holds it (`adult`, `teen` or `unknown`): while it isn't `adult`, desk-agent fires no timer and starts no timer- or message-started run (due timers wait and resume when it is adult).

- **Memory (S-14,** desk-agent `README.md`, "Memory"**):** each agent remembers short lines about its member across conversations (its `memory_save` and `memory_forget` tools) and keeps a summary of the part of its thread too long to send whole. The member sees and deletes them with `agent.memory.*`, relayed like the rest: the owner for the desk's agents, a guild member for their own agent only (not team methods, so not refused `permission`), a teen never (`age_band`). Results carry a line's text; deskd logs and audits no params or results, as for every `agent.*` call. A delete is final: a deleted summary's messages are never sent to a model or summarized again. They go with the agent, with a member's purge (its answer adds `memories`), and in the export's `agent` part (`agent.db`).
- **Errors** are desk-agent's, with its `code` and `details` as they came: `precondition_failed` with `reason` `no_key`, `limit_reached` (and `scope`), `key_refused` or `agent_cap`; `conflict` with `reason: busy`; `unavailable` with `reason: storage` (below); `bad_request` with `reason` and `detail`. A code deskd doesn't have becomes `internal`. A provider failure during a run isn't an error here: the reply's message ends `failed`, with `error: "provider_error"` and `errorDetail` one of `auth`, `rate_limited`, `free_limit`, `data_policy`, `bad_request`, `timeout`, `unavailable`, `cancelled`. `free_limit` is the provider's free allowance for today used up (OpenRouter's free requests a day): say "Today's free limit is used" plainly. `data_policy` is the member's privacy settings at OpenRouter allowing no endpoint for that model.
- **`agent.thread.get` comes in pages.** Without `before`, it's the thread's newest messages; with `before`, a message's `id`, those older than that message. A page holds as many as fit in about 960 KiB of JSON, up to 1000, so its RES is never `too_large`. `older: true` says there are more before its first message, whose `id` is the next `before`. The newest message of a page always comes: if it alone is too long, it keeps the start of its text and has `truncated: true`. A `before` that isn't a message of that agent's thread is `not_found` with `detail: message`. `seq` is the conversation topic's, as before. A client that doesn't send `before` gets the newest page, as it got the newest 1000 messages before; a thread past 1 MiB used to answer `too_large`.
- **desk-agent not running,** or not answering in time, is `unavailable` with `reason: unavailable`. Not running, a mutation's answer has no `mayHaveApplied`: nothing was sent, nothing changed, and the same key runs it once desk-agent is back. Only a desk-agent that drops while the request is going out, or doesn't answer in time, adds `mayHaveApplied: true`. deskd waits 30 s for `agent.key.add` and `agent.key.models`, which call the provider, and 10 s for the rest. Past that, desk-agent is told to stop the call. At most 16 calls of one session wait on desk-agent at once, half a session's 32 (§4), and more get `unavailable` at once, so a desk-agent that has stalled never gets a session's other calls, the Browser's included, `rate_limited`. A desk-agent that stops reading for 5 s mid-request loses its connection, and everything waiting on it gets `unavailable`; it reconnects as it does after a restart.
- **The Agent app is off for teens** (`ma-platform` age rules, §3.2). While the owner's age band is `teen`, every method here and every SUB below gets `forbidden` with `reason: age_band`, and while it isn't known yet `unavailable` with the same reason. Either comes after the scope check and the token's owner check, and before anything reaches desk-agent, so nothing was done, there's no `mayHaveApplied`, and after `unavailable` the same key runs the call. A key sent to `agent.key.add` gets the same answer, malformed or not, and deskd never copies it. Hide the app from what `GET /v1/me` says of `ageBand` rather than from these errors, which are the backstop.
- **`agent.key.add`** is the only call with a key. deskd takes `secret` out of the params and checks it's 8 to 1024 characters of printable ASCII with no space, or answers `bad_request` with `reason: key_malformed` and `detail: format`, and sends desk-agent nothing. Otherwise the key goes to desk-agent apart from the JSON, with this desk's id, and deskd zeroes its own bytes of it. desk-agent first refuses a key that starts with another provider's `keyPrefix` (`agent.providers`) rather than the one picked, before anything leaves the desk: `bad_request` with `reason: key_malformed` and `detail: provider_mismatch`. The longest prefix that fits says whose a key is, so `sk-ant-…` is Anthropic's though it starts with OpenAI's `sk-`; check it the same way on the client. A key with no known prefix goes on to the provider. Then desk-agent checks the key with the provider's model list (OpenRouter's key endpoint, as its list is public): a refusal is `precondition_failed` with `reason: key_refused` and `detail: auth`. It then seals the key on the desk's own disk: if it can't, the answer is `unavailable` with `reason: storage`, and nothing is kept, so a retry is safe. Don't log this call's params anywhere on the client.
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
- **A thread's snapshot is its newest messages, and `older: true` if there are more.** desk-agent sends `agent.thread.get`'s newest page (above), and an EVT is at most 64 KiB, so deskd may keep fewer: then `omitted` says how many of that page it left out, and `older` is `true`. Either way, page back from the snapshot's first message with `agent.thread.get` and `before`. `older` is new: a client that ignores it sees what it saw before, with no `error` for a long thread. A desk-agent from before pages can't send a long thread's snapshot at all, and then the topic starts with `{messages: [], older: true}` and carries on. A message too long keeps the start of its text and has `truncated: true`; `agent.thread.get` has the whole of it, up to about 960 KiB of JSON. A long `delta` comes as several, in order.
- **An agent that doesn't exist** ends the subscription with `{"type": "error", …}`.
- **While desk-agent is down** a subscription stays, with no events, and no first event if it began then. When desk-agent is back, it gets a fresh `snapshot`.
- **A desk that becomes a teen's** ends both topics at once, with `{"type": "error", "data": {"code": "forbidden"}}`, as a refresh that takes a right away does.

`GET /health` adds `agent`: `connected` or `waiting`, for information only. The heartbeat's `agent` (agent.md) comes from `agent.state`: `busy` while an agent is `working`, `error` if one is in error, `online` otherwise, and `offline` while desk-agent can't be reached. An agent `working` with `statusDetail: "awaiting_approval"` is waiting for the member, not working: it isn't `busy` and doesn't count in `activeTasks`, so a wait never keeps the desk awake (§18).

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

- **`data.parts.list`** is the helper's answer as it is. A part is a top-level directory of the desk's data, less what belongs to the machine (the draft, decision 4). deskd leaves those out itself too, whatever the helper says, and `data.manifest` and `data.read` of one get `not_found`: `rtc`, `selfhost` (a self-hosted desk's key and pairing), `desk-egress`, `lost+found`, `.ma-export-tmp` and `.ma-move`. `label` is its name for the member, and `files` and `bytes` are an estimate, from a walk with no hashing. Send a `deadlineMs` of a minute or more: on a cold disk the walk takes a while, and deskd gives the helper 2 min.
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

- **`part` and `next`:** a page's or version's ProseMirror JSON can pass RES's 1 MiB, so it comes as text in parts of at most 512 KiB. Concatenate them until `next` is null, then `JSON.parse`.
- **`notebook.activity`'s `rows` and `next`:** a reply holds as many rows as fit 1 MiB less 4 KiB, at most 10,000 (about 5,700 on a desk, fewer on a guild's with names). Concatenate `rows` across replies, passing each `next` back as `cursor` with the same `fromDay` and `toDay`, until it's null. Rows come newest day first, then by page id, highest first, so each row comes once and none is skipped however long the reads take; one written behind the cursor is in the next read, which the topic's next event asks for. A cursor is opaque and doesn't expire; one that isn't the desk's gets `bad_request` with `{reason: "cursor"}`. Before paging, a reply was every row in the range or `too_large`, at about 7,000 rows. A client that sends no cursor still gets that: everything, while it fits one reply, and past that the newest rows and a `next` it can ignore. On a guild desk every member gets the same rows: those of live pages, which any member may read, never a trashed page's.
- **`timeZone`:** call `notebook.settings.set` with `Intl.DateTimeFormat().resolvedOptions().timeZone` in `ready()`, when it differs from the last you sent on this desk. Activity days and midnight versions use the last zone seen, so the Temporal view follows the member. An unknown zone gets `bad_request` with `{reason: "time_zone"}`, and the desk keeps the last good one (UTC until there is one).
- **An empty desk** gets an empty tree. The client makes the first notebook, as it does with `LocalBackend`.
- **Editing a trashed page** keeps the edit (design 5.5).
- Versions, activity, search, derived titles and the 30-day Trash purge all happen on the desk.

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

An agent's `notebook_*` tools (§18) reach `desk-notebook` on deskd's own connection, never a client's, as the agent's owner by deskd's stamp: the desk's owner, or on a guild desk the member whose agent it is, under that member's grants and the edit budget as for their own edits. Two methods serve them that no client can call (a client gets `not_found`): `notebook.page.markdown` (a page as Markdown, 20,000 characters a read) and `notebook.page.agentEdit` (`create`, `append` or `replace_text`, with a `pre_agent` version saved first); search and trash are `notebook.search` and `notebook.page.trash` with their rules. `services/notebook/README.md` has both.

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
| `low_confidence` | Too little of the page came through: almost nothing to read, a form the view can't complete, or (round 4) a page four screens long or more of which the view kept under 600 characters and no cards, picture, table or player (a store's grid still drawing its placeholders). Round 6: when this document's view already had cards or 600 characters and more, a later look that finds such a long page blank (a store's virtual grid drawing its rows again after the pre-scroll) keeps that view instead, until the page's next change is looked at | Yes |
| `canvas_app` | A canvas takes half the viewport or more | Yes |
| `cross_origin_frames` | Another site's frame takes 40% or more | Yes |
| `terms_wall` | The page asks the member to agree to its terms before they read on: "The site asks you to agree to its terms" | No, and looked at again when the page changes, as once they agree it's gone |

Errors: `not_found {reason: "tab"}`, `unavailable {reason: "chromium"}` and `unavailable {reason: "active_tab"}` as §10, and `unavailable {reason: "disabled"}`.

**A forum's cloaked posts** (task 47, round 4). Discourse draws only the posts near the viewport and leaves the rest as empty boxes of the same height, so a member's tab, which nothing scrolls, would show the first few posts and a column of "21 days later". The posts' own words are in the topic the page already loaded and keeps in its document (`script#data-preloaded`, `application/json`): the distiller reads each cloaked box's post from it, parsed inert (`DOMParser`: no script runs and nothing loads), and walks it as content in the box's place, under its author's name and date. Nothing is fetched or pressed. Only on a page Discourse made (its generator), for the topic in the address, for a post shown to everyone (not hidden, deleted, a whisper or a moderator's note) whose author the box itself names. Posts the page hasn't loaded stay out, as on the real page.

**Ads by their own link** (round 4). A card whose own link is an ad's click (an ad network's click id, plain or URL-encoded in an engine's redirect, or a store's ad server) is dropped by deskd's builder wherever the distiller found it, and counted in `hidden.counts.sponsored`.

**An island's still** (round 4). `media.poster` is the `<video>`'s own poster, else the picture the player draws over it (an `<img>`, or a box's background, inside the player and over most of the video), read, never fetched: its bytes come as any image's, from what the tab loaded.

**What a control and a picture show** (round 5). A lone vote arrow with no score shown (Hacker News' ▲ on a comment) is a `vote` run with that one arrow and `score: ""` (R40), never a button labelled ▲. A button's `label` stays what the page shows (R1), with two exceptions that keep its words in `name`: a rating spelled out for a screen reader ("Review: 4.6 out of 5 stars. Total reviews: 2191") shows as `★ 4.6 (2191)`, and a shop's badge drawn on a control named otherwise (a swatch's "SALE") shows as `Jet Black (Black Sole) · SALE`. A link whose page text only repeats its name with a screen reader's copy ("Open 20 (20)") shows its name. An image's `alt` that is only a file's or an id's name ("ex-main-demo", "IMG_9231") is `""`. Round 6: a card's `snippet` is the distiller's whole snippet, words a page set in bold included ("The best **desk lamps** come in…"), never its plain pieces. A tile card's own picture and its line ("High: 66 °F · Chance Rain") are its `image` and `meta`. A shop's product page (its JSON-LD names a Product, or a button buys it) has no `article` read time.

**The pre-scroll** (task 47, round 3). A page loads some of itself only as it's scrolled to: lazy pictures, a thread's later replies, a list's next items. Nothing scrolls a member's tab while the view shows, so once per document deskd does: 400 ms after a `get` first hands a client a document's view (so the view covers the real page first; never on a navigation alone, never on a page still loading, and never while the real page is what shows), it scrolls the real page down a screen at a time to its end or a cap (12 screens or 1.5 s, so an infinite feed stops there), puts it back exactly where it was, and waits up to 600 ms for the pictures it came near to arrive. It runs under the tab's work, so no action comes between, and it never presses, types, focuses or writes anything. It doesn't run on a sensitive site or page (the view's own rules: the shipped list, the member's mark, a sensitive signal this session, a visible password, card or code field), with focus in a field or frame, on a page whose scrolling is locked (a modal open), in a hidden tab, with a dialog open, or once the member has acted on the document. An action, or the member choosing the real page for the site, stops it at its next step, and the page goes back at once. What it brought in is the view's next look: the topic says so as for any change. `/health` counts pre-scrolls under `browser.simplified.prescroll` by what came of them (`done`, `capped`, `stopped`, `skipped_<why>`, `not_restored`, `failed`), never which page. `prescroll-off` in the switch turns it off.

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

An agent's `files_*` tools (§18) work in the same tree, by the same rules, as the owner: inside `/data/files`, links never followed, never `.trash` or `.uploads` at any depth, nothing permanent (`files_trash` moves to the trash; there's no empty and no permanent delete). A write takes the free tier's cap and the floor as an upload does (`no_space`, with `cap` on a free desk), under the same last-bytes lock as an upload's `begin`, from its check of the room until the file is in place and counted, so a write and an upload can't both take the last bytes; replacing a file sends the old one to the trash first, and every change reaches `files.changes` as the app's own do. A guild desk has no Files, so no agent there has these. Never a path or content in the journal.

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

### Who may call

| Method | `owner` | `export` | `guild_member` |
|---|---|---|---|
| `agent.approvals.list`, `agent.approval.get` | yes | `forbidden` `{reason: "scope"}` | their own agent's only |
| `agent.approval.decide` (mutation, `idem`) | yes, with a token that has input | `forbidden` `{reason: "scope"}` | their own agent's only |

- **deskd's relay** adds the three to the `agent.*` methods it relays. They aren't team methods, so a guild member passes deskd; desk-agent answers `not_found` for an approval of an agent that isn't the caller's, so ids tell nothing. A teen gets `forbidden` `{reason: "age_band"}`, as every `agent.*` does (§11).
- **Input:** deskd refuses `agent.approval.decide` from an owner token without input with `forbidden` `{reason: "permission"}`, before desk-agent hears it. A guild member's token never has input (a guild desk has no Browser), so a member decides with their own member token, for their own agent only. A support session, once those exist, never decides.
- **deskd's own record** (`ApprovalTickets`): for each decide with `approve: true`, deskd keeps `{approvalId, sha256, caller}` in RAM from just before the request goes to desk-agent until 10 minutes later. desk-agent refusing the decision (`bad_request`, `not_found`, `conflict`, `forbidden`), or answering a state that isn't `approved`, `done`, `failed` or `interrupted`, drops it; a repeated yes for the same id neither replaces the first's ticket nor, when desk-agent answers it `answered`, drops it. A tool deskd runs for desk-agent (Browser, Files, Notebook) runs only against one of these, once: the call names `{approvalId, sha256}` and its `context`, deskd computes the hash of `{v: 1, agentId, runId, tool, context, payload}` from the arguments it received, and the ticket's caller must own the agent. Otherwise the tool's error is `approval_unknown` (none, lapsed, or lost with a deskd restart: the model asks again), `approval_used` or `approval_mismatch`, and a refusal leaves the ticket as it was. Nothing for a client to do.

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
| `notebook_write` | `{pageId?, new?: {tabId, title}, op, markdown, find?}`, `op` `create`, `append` or `replace_text` | `page` (`pageId` null for `create`, `title` the new one) | `{title}`, or `null` for `create` |
| `notebook_trash` | `{pageId}` | `page` | `{title}` |
| `browser_click`, `browser_press` | `{tabId, ref, label, role, origin, key?, spend?}`, `spend: true` on a spend, so the member's yes binds it | `element` (with `pageTitle`) | `null` |
| `browser_type` | `{tabId, ref, label, role, origin, text}` | `element` (with `pageTitle`) | `null` |
| `browser_open`, `browser_back` (only when they ask: always in the member's session, else under the Rule of Two; `risk: "egress"`) | `{tabId?, url}` (the address normalized), `{tabId}` | `site` with `origin` | `null` |
| `browser_use_my_session` | `{site}` | `site` with `site` | `null` |
| `follow_up` | `{at, prompt}`, `at` in ms since the epoch, within 7 days | `timer` with `at` and `when` (the same, ISO 8601 UTC) | `null` |
| `memory_save` (only in an untrusted run) | the memory runner's | `memory` | `null` |

For Browser actions the desk adds `label`, `role` and `origin` from the page as it read it, so the hash covers what the card shows; `ref` is `{node, fp, block, rev}` (the model names an element by a short ref such as `n12`, which the desk expands), `role` one of `link`, `button`, `field`, `check`, `select`, and the action proxy refuses (`changed`, `gone`) a page that no longer shows it: the node must be in the current MDoc with the same `fp` and block, the `rev` of the current document, and deskd's half takes the element's fingerprint again in the same call as the act. **In the member's signed-in session every navigation the agent starts asks as `egress`, whatever the run's taint** (Security's finding on the protocol): `browser_open`, `browser_back` and a click on a link on that tab; every other click, typing and press there is at least `write`.

**The class, before anything is done** (S-14): a click on a control that looks like a form's submit, or Enter in a field that sends (not a search box in the Agent's own context), is `send`; a click or such an Enter that looks like paying is `spend`: a control labelled buy, pay, place order, checkout, subscribe, donate or confirm purchase, a card field on the page, a payment provider's page, or **a payment provider's frame anywhere in the page, whatever its size and whatever the control says** (deskd's `payment-hosts.txt`: Stripe, PayPal, Adyen, Braintree, Square, Apple Pay and Google Pay among them; found in Chromium's frame tree, the tab's and each out-of-process frame's, and by deskd's half in the document). A spend's payload says `spend: true`; a call approved without it on a page that is now a payment page is refused `changed`, by deskd's tools and again by deskd's half at the act. A spend stays `spend` under the Rule of Two. Refused before asking: a link to another site in a member-session tab (`off_site`) or to a local host (`blocked`), by the address the walker read, and again on the element itself as it's clicked; a click or a key in a sensitive field or select (`sensitive`), and Backspace on a payment provider's page.

### The tools, as built

What the model is offered and what a card can be for. `services/desk-agent/README.md`, "Tools", has the rest.

| Area | Tools (class) | Runs in |
|---|---|---|
| Files | `files_list`, `files_search`, `files_read` (read); `files_write`, `files_mkdir`, `files_move` (write); `files_trash` (delete) | deskd, §16 |
| Browser | `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_press`, `browser_back`, `browser_close`, `browser_tabs` (read, rising); `browser_use_my_session` (egress; refused `origin` in a run the member didn't start) | deskd, §10 and §14 |
| Notebook | `notebook_search`, `notebook_read` (read); `notebook_write` (write); `notebook_trash` (delete) | deskd, §13 |
| The agent's own | `plan_update`, `workspace_delete` (own); `follow_up` (write) | desk-agent |

- **Who gets what:** the desk's agents get every area deskd offers; a guild member's own agent gets Notebook and `plan_update` only. No permanent delete, emptying a trash, shell or outbound message is a tool.
- **The Rule of Two is for browse actions only:** `browser_open`, `_click`, `_type`, `_press` and `_back` are `egress` in a run holding both `U` and `S` (a `spend` stays `spend`), in deskd, in desk-agent's policy and in its run loop's backstop. `browser_read`, `browser_tabs` and `browser_close` stay `read` and never ask; reading a member-session tab still adds `S` (and `U`) to the run.
- **Refused before asking,** so no card comes: input the tool doesn't take (`input`), a tool switched off on the desk (`off`), the session grant in a run the member didn't start (`origin`), a sensitive or payment field (`sensitive`), another site in a signed-in tab (`off_site`), a blocked site (`blocked`), the tab cap (`tab_cap`, 2 Agent tabs on the desk, 1 on a free desk), a third signed-in site (`ask_cap`), a file already there (`exists`), a Notebook edit that would fail (`not_found`, `ambiguous`, `whole_block`, `grant`, `budget`, `trashed`).
- **`result.error`** of a card is one word: `changed`, `gone`, `exists`, `no_space`, `off_site`, `approval_unknown`, `approval_used`, `approval_mismatch`, `unavailable`, … Never content.
- **Chips' `summary`** for these tools is the desk's own few words ("Saved a file in your Files", "Opened a page", "Edited your Notebook"), never a path, title or address; `target` is the card's.
- **`plan`** on a reply is built: `plan_update` replaces it, live while the reply streams, and it stays with the reply.

### Events and new fields

- **`agent.conversation:<agentId>`** gets a new event type, `approval`, with `{approval}`: adds or replaces one by `id`, when it's asked and on every change. The `snapshot` and `agent.thread.get` carry `approvals`: every approval of the messages in that page, `payload` left out over 32 KiB as above.
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
  - `session`: `agent` or `member`, on Browser calls.

  `summary` stays a few words the desk writes, never content.
- **`agent.state`:** each agent gains `approvalsPending` (a count, 0 when none) and, while its run waits, `status: "working"` with `statusDetail: "awaiting_approval"`.

### Changes to existing methods
- **`agent.message.send`** to an agent whose run is waiting: `conflict` `{reason: "awaiting_approval"}`. Answer or stop first.
- **`agent.run.stop`** on a waiting run ends it `stopped`, and its pending approvals `expired` with `detail: "stopped"`.
- **A desk-agent restart** ends a waiting run as any run (`failed`, `unavailable`, `errorDetail: "interrupted"`); its approvals become `expired` with `detail: "restart"`, or `interrupted` if the tool was running. Nothing resumes.

## 19. Apps

deskd's half of the desk app contract (`docs/decisions/draft-desk-app-contract.md`, with its Desk Engineer review of 2026-11-11, which this follows where they differ; launch row S-97). Signed packages installed under `/data/apps` with rollback, the catalog the Desk app reads, and `appApi` relayed from the Desk app to each app's own socket. **On, with a kill switch, and inert until an app is installed.** No image has the parts it needs yet (the System Engineer's helper `desk-apps`, `/data/apps`, a review key), so on every desk today `apps.list` says `available: false` and every install is refused before it touches anything.

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
| `apps.catalog.get` | No | None | `{available, reason, catalog: {seq, issuedAt, apps: [{id, name, publisher, description, installed, versions: [{version, packageSha256, bytes, appApi, permissions, net, resources, notes, installable, reason}]}]} or null}` |
| `apps.install` | Yes | `{id, version, packageSha256, grants}` | `{id, version, state}` |
| `apps.remove` | Yes | `{id, deleteData?}` (default `false`) | `{}` |
| `apps.start` | No | `{id}` | `{id, state, problem}` |
| `apps.stop` | No | `{id}` | `{id, state, problem}` |
| `apps.view.get` | No | `{id}` | `{id, version, manifest, signatures, files: {path: text}}` |
| `apps.call` | No | `{id, m, p?}` | the app's result |
| `apps.mutate` | Yes | `{id, m, p?}` | the app's result |

**App** is `{id, name, version, previous, publisher, description, appApi, start, resources: {memoryMaxMiB, cpuMax, tasksMax, diskMaxMiB}, permissions, net, views: {window: {width, height, minWidth, minHeight} or null, widget}, methods: [{name, mutation}], topics, tier, grants, state, problem, summary, installedAt, updatedAt}`.
- `state`: `stopped`, `starting`, `running`, `failed` (stays stopped until the member starts it) or `disabled` (revoked by the catalog).
- `problem`, for the tile's words (contract §2.6): `no_hello` ("Couldn't start"), `crashed`, `memory` ("Stopped: used too much memory"), `needs_update`, `host`, `revoked`, or null.
- `summary` is the widget's last `app.summary`, kept on the volume so it shows while the app isn't running: `{badge, problem, rows: [{text, detail, time}]}`, at most 6 rows of 120 characters, 8 KiB in all. The Desk app draws it with its own components; no app code runs on the canvas.

**`available: false`** comes with `reason`: `switched_off`, `no_storage` (no `/data/apps` that deskd can write), or `no_sandbox` (no helper). `apps.list` still lists what's installed, and `apps.catalog.get` gives `catalog: null` and fetches nothing.

**`apps.catalog.get`** gives deskd's verified copy of the catalog: fetched from the Platform's public route when the one in memory is over 10 minutes old, its signature checked against the review keys in the image, and refused if its `seq` is below the newest this desk has taken. Only this desk's arch is listed. `installable: false` comes with `reason`: `app_api` (this deskd doesn't speak the range), `not_supported` (a permission this deskd can't honour yet: today everything but `background`), or `revoked`. The Desk app never fetches or checks the catalog itself.

**`apps.install`** installs or upgrades. `packageSha256` must be the catalog's for that version, and `grants` exactly its `permissions` (the ones the install sheet showed), in any order. There's no step-up: the owner's or Founder's session and the tap are the consent. In order:
1. Refused before anything is touched: `unavailable` `{reason}` (`switched_off`, `no_storage`, `no_sandbox`, `catalog`), `conflict` `{reason: "busy"}` while another install or removal runs, `not_found` `{reason: "version"}`, `precondition_failed` `{reason}` (`catalog_changed`, `app_api`, `not_supported`, `revoked`, `downgrade`, `no_space`: less than 2 GiB left on `/data` for the Browser after it), `bad_request` `{reason: "grants"}`. The same version again is a no-op that answers as for an install.
2. Then deskd begins: the helper prepares the app's directories, uid (2000 to 2999, the app's for good while its data is kept) and quota; the package streams from the Platform into `releases/.staging-*`. Its manifest and both signatures are checked before a file is written, each file's hash as it's written, and the package's size and hash at the end. Any failure there is `precondition_failed` with `reason` `package`, `hash`, `size`, `signature`, `manifest`, `catalog`, `revoked` or `not_supported`, or `unavailable` `{reason: "download"}`, and nothing is left: for a first install the app's directories go too.
3. The release is renamed into place, the registry written, `current` and `previous` swapped. A running old version is stopped first.
4. A trial start: the app must answer HELLO within its `startTimeoutSec`. If it doesn't, everything goes back, the old version runs again if it ran, and the reply is `precondition_failed` `{reason: "no_hello" | "needs_update" | …, rolledBack: true}`: nothing was done. Until the HELLO the registry marks the entry `trial`, with the one it replaced, so a deskd that stops mid-trial rolls it back at its next start.

Only `current` and `previous` are kept. The reply's `state` is the app's after the trial start: `running` (it then stops after 10 idle minutes unless it's `background`).

**`apps.remove`** stops the app, deletes its releases and summary, and asks the helper for the rest. Its data stays unless `deleteData`, and with it its uid and its registry entry (`state: kept`, not listed), so a reinstall finds both. `deleteData: true` on a kept app deletes the data. `not_found` `{reason: "app"}` otherwise.

**`apps.start`** starts it if it isn't running, and is also how the member restarts a `failed` app. A call or a SUB to a stopped app starts it too, but not a `failed` one: those get `unavailable` with the problem as `reason`. **`apps.stop`** stops it now.

**`apps.view.get`** gives the window's three files as UTF-8 text, with the manifest and `ma-app.sig` exactly as signed, so the Desk app can check the review signature with MA's public keys and every file's SHA-256 before it builds the sandboxed frame (contract §3.2). `not_found` `{reason: "view"}` for an app with no window.

**`apps.call` and `apps.mutate`** relay one of the app's declared methods: `apps.call` its reads, `apps.mutate` its mutations, never the other way round (`bad_request` `{reason: "mutation"}`). An undeclared one is `not_found` `{reason: "method"}`. `apps.mutate`'s `idem` is kept by deskd's store as for any mutation (§4), and is passed on to the app as `idem`, so the app can dedupe across a deskd restart too. Its point of no return is when the request is queued to the app. The app's `ERR` comes back with its code if it's one of `bad_request`, `forbidden`, `not_found`, `precondition_failed`, `conflict`, `too_large`, `rate_limited`, `unavailable`, `deadline_exceeded`, `cancelled`, its message cut to 200 characters and its `details` if under 8 KiB; any other code is `internal`. 32 calls to one app at once, then `rate_limited` `{limit: "appCalls"}`; 30 s to answer, then `deadline_exceeded`.

### What the app is told about the caller

Every relayed request carries `from`: `{kind: "view", session, caller}`, never the member's name, account, email or a guild member's id (the review's change to contract §5.3).
- `session`: `p-` and 22 characters, an HMAC of the desk session under a key that lives only in this deskd's memory and differs by app. Stable for a session while deskd runs; two apps can't link it.
- `caller`: `{kind: "owner"}` on a member's desk. On a guild desk `{kind: "guild_member", member, role, grants, teen}`, where `member` is a pseudonym (`p-…`) under the app's own key in the registry: stable for that app on this desk, unlinkable across apps.

A SUB to the app carries `from: {kind: "view", caller: {kind, member?}}`.

### Topics

**`apps`**: what `apps.list` returns, as a `snapshot`, then a `patch` carrying the whole object again on any change (install, state, summary), at most once a second. Replace on each.

**`app:<id>:<topic>`**: one of the app's declared topics, relayed. While anyone is subscribed deskd holds one subscription of its own on the app's socket and fans its events out; a first subscriber's `snapshot` is that subscription's first event, a later one's a one-off subscription taken and dropped. A SUB starts the app if it isn't running. Coalescible, so an app's `patch` carries values, never increments (§5). When the app crashes and is started again (it is, after 1 s, 5 s and 30 s, while anyone is subscribed), subscribers get its first event again as a `snapshot`. On a guild desk each member's subscription is their own, and deskd's on the app's socket carries their pseudonym. `app.summary` isn't subscribable: it's deskd's, served in `summary`. A topic the app doesn't declare, or an app that isn't installed, is `not_found`. A revoked app's subscriptions end with `error` `forbidden`.

### The app's side

The socket, frames, HELLO, limits and everything an app must do are the contract's (§1.5 and §5), and the sample app meets them (`spikes/app-contract-sample/`). In short: the app listens on `/run/ma-apps/<id>/app.sock`; deskd connects, checks `SO_PEERCRED` is the app's uid, and sends HELLO `{appApi: "1.0", deskApi, app: {id, version}, grants, limits: {memoryMaxBytes, cpuMax, diskMaxBytes, maxRequestBytes, maxEventBytes, requestsPerSecond}}`; the app answers HELLO `{appApi, app}` within `startTimeoutSec`, or CLOSE 4426 for another major. Frames are a `u32be` length, then the 12-byte header and payload of §2, never fragmented: REQ and RES up to 1 MiB, everything else 64 KiB. deskd PINGs every 30 s and ends the link after 3 missed. An app may ask deskd `desk.info.get` (`{appApi, deskApi, timeZone, guildDesk}`), 50 a second and 8 at once; `browser.open` and `files.*` answer `forbidden` (no app can hold those permissions yet), anything else `not_found`.

### The helper deskd needs (the System Engineer's)

`/run/desk/apps.sock`, root, socket-activated, `0600` owner `desk`, one JSON line each way (`apps/HelperAppHost`): `prepare {id, uid, diskMaxBytes}`, `start {id, uid}`, `stop {id}`, `status {id}` (`{state, result}`, `result: "oom-kill"` for a kill at the memory limit), `remove {id, uid, deleteData}`; `{ok: true, …}` or `{ok: false, code, message}`. The contract's ADR (Desk Engineer review, "For the System Engineer") has what each verb must do.

### Health and the switch

`GET /health` adds `apps: {state: on|off|unavailable, reason, installed, running, failed, reviewKeys}`, counts only. **The kill switch** is `/data/desk/apps-switch`, read at most once a second: no file, on; `off`, everything `unavailable` `{reason: "switched_off"}` (`apps.list` and `apps.catalog.get` still answer, saying so), running apps stopped within 30 s, nothing fetched; `install-off`, no installs or upgrades while installed apps keep working. A file deskd can't read as a small plain file counts as `off`. Nothing in the journal names an app, a method, a member or a file.

| Variable | Meaning | Default |
|---|---|---|
| `DESKD_APPS_ROOT` | where apps are kept | `/data/apps` |
| `DESKD_APPS_SOCKET` | the helper's socket | `/run/desk/apps.sock` |
| `DESKD_APPS_RUN` | where each app's socket directory is | `/run/ma-apps` |
| `DESKD_APPS_KEYS` | the review keys' directories, comma-separated, files `<tier>.<name>.pem` | `/opt/ma/etc/app-keys,/etc/ma/app-keys.d` |

## 20. What the heartbeat says of deskd itself (ADR 0078 section 6)

Not a client call: what the Platform hears, for a release switched in where no release `health` can run, as in a shared host's slot.
- **`deskd: {version, status}`** (DE-2) is in every heartbeat: `version` is this deskd's, the string hello's `runtimeVersion` and `GET /health`'s `version` carry, and `status` is `ok` or `failing`, exactly `GET /health`'s own answer on the admin socket (200 or 503). deskd has no databases of its own, so that answer is "serving, with its data directory writable", the release `health` script's test (`desk-runtime.md` §6). A `failing` one also makes `health.status` `failing`. It writes one small file a heartbeat, as `/health` does; the final heartbeat repeats the last answer rather than write during the shutdown. The Platform promotes a host's canary batch once its desk's heartbeat names the new `version` with `status: ok` (ADR 0078 section 3.3).
- **No batch offer and no `update`** (DE-1). deskd doesn't relay desk batches yet (`desk-runtime.md` §6.1's offer on `/run/desk/batch.sock`, and the heartbeat's `update`): a heartbeat reply's `batch` is ignored, nothing asks `GET /v1/agent/batch`, nothing is logged of it, and no heartbeat carries `update`. A shared host's desk has no `batch.sock` (the host takes its releases), and when the relay is built a desk without that socket keeps exactly this behaviour.
