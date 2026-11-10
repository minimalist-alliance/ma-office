# 0023. Desk data-channel protocol: channels, framing, RPC and subscriptions, backpressure, resume

**Status:** Proposed (pending the owner's approval of design v1.1)
**Date:** 2026-11-04

## Context
- Under the hybrid (ADR 0022), all of an app's traffic between the client and its desk runs on one WebRTC connection. ADR 0006's REST routes, `/v1/events`, `/v1/collab` and Neko signaling no longer exist.
- SCTP over DTLS gives independent streams, but a large message's fragments are sent back to back and hold the association; message interleaving (RFC 8260) can't be relied on across stacks; 16 KiB is the message size every browser handles.
- Normal-mode pointer motion wants latency over reliability; keys must never be lost; Notebook text needs Yjs sync; agent runs stream tokens; downloads can be large; minified actions must stay fast under any load. The approved contract names "input (unreliable data channel)".

## Decision
- **Eight pre-negotiated channels** (`negotiated: true`, fixed ids): 0 `ctl`, 1 `rpc`, 2 `events`, 3 `collab`, 4 `mdoc`, 5 `bulk`, all reliable and ordered; 6 `input` (unordered, `maxRetransmits: 0`, pointer motion only, newest wins); 7 `keys` (reliable and ordered: keys, buttons, wheel, text). Splitting input this way refines the contract: a lost key-up would stick a key and a lost key-down would drop a character, and a reliable channel adds no latency without loss. Video and audio are media tracks on the same connection, pre-negotiated and idle until the Browser streams.
- **Framing:** a 12-byte header (`ver`, `kind`, `flags`, `id`, `seq`) and a payload of UTF-8 JSON or raw bytes. Frames are ≤ 16 KiB; longer messages span frames and reassemble by (`kind`, `id`). Limits: REQ/RES 1 MiB, EVT 64 KiB, DATA 4 MiB. No compression in v1. `input` and `keys` use a fixed binary layout.
- **App APIs** are RPC methods named `<app>.<resource>.<verb>`, with idempotency keys on mutations (results kept 10 min), `rowVersion` for optimistic concurrency, deadlines, `CANCEL` and a fixed list of error codes. **Subscriptions** (`SUB {topic, params, since}`) deliver EVT frames on `events` with a per-subscription sequence; their topics replace `/v1/events`.
- **Notebook** keeps Hocuspocus, fed through a WebSocket-shaped adapter over `collab` on both ends. Phase 0 verifies it; the fallback is plain y-protocols. Guild sync reuses the adapter (ADR 0024).
- **Transfers** on `bulk` are content-addressed, chunked, credit-controlled (initial window 1 MiB), resumable from the last credited offset and SHA-256-checked.
- **Backpressure:**
  - desk-rtc sends with strict priority (`ctl` > `keys`/`input` > `rpc` > `mdoc` > `events` > `collab` > `bulk`) and keeps ≤ 64 KiB queued per channel in SCTP. The client does the same.
  - `bulk` is capped at ~2 Mbps while video plays.
  - Slow consumers get coalesced snapshots or a `resync`, never an unbounded queue.
- **Resume:**
  - An ICE restart comes first; it keeps DTLS, SCTP and every channel.
  - Otherwise the client opens a new session and sends `HELLO {resume}`, then resubscribes with `since` per topic, retries with idempotency keys, resumes transfers from their offsets, and lets Yjs resync by state vector.
  - deskd keeps a dropped session for 2 min.
- **Activity:** the client reports input it handles locally (scrolling a minified page) as `ACTIVITY {lastInputAt}` on `ctl`, at most once a minute, for the heartbeat (ADR 0026).
- **Versioning:** `deskApi` (from 1.0), reported in hello, the gateway `ready` and HELLO, and gated by the web app's `deskApiRange`.

## Consequences
- One transport, one auth model and one place for flow control across all apps; a click's response is never stuck behind a download.
- deskd's handlers stay the same; only the transport layer changes. There is no HTTP surface to test with standard tools, so `deskctl` and a dev signaling shim ship in Phase 0.
- Every app protocol must tolerate resume (idempotency keys, sequence cursors). Tests that drop connections mid-request enforce it.
- Amends ADR 0006 (API surface) and ADR 0015 (collab transport).
- Alternatives rejected:
  - One channel per app or per request: more SCTP streams and no shared priority.
  - HTTP emulated over a data channel: heavier, with no benefit without browser fetch integration.
  - JSON-RPC 2.0 as is: no subscriptions, sequence numbers or binary chunks.
  - Unordered channels for app data: apps need ordering.
  - All input on one lossy channel with repeated full state: a key pressed and released between two delivered messages would vanish.
