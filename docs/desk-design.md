# Desk app — design

**Status:** Design v1.1 — revised 2026-11-04, draft for the owner's approval
**Owner:** the owner · **Author:** System Engineer · **Last updated:** 2026-11-04

- Source of truth: [`vision.md`](vision.md).
- Decisions: [ADR 0001](decisions/0001-separate-repo-and-aws-boundary.md) (Accepted); ADRs 0002–0009, 0011, 0012 and 0014–0031 (all **Proposed** until the owner approves this design); ADRs 0010 and 0013 are superseded. Index: [`decisions/README.md`](decisions/README.md).
- Platform's own design (`ma-platform/docs/platform-design.md`, also a draft) and its contracts (`docs/contracts/`, 0.2.0) are read-only here. Where this design needs something different from them, §13.2 says so.

> **What v1.1 changes.** the owner's later answers and the coordinator-approved **hybrid** contract (`~/ma-coord/system-eng.md`, "Contract: hybrid"), all 2026-11-04:
> - **Connectivity:** Platform's gateway carries only control and signaling; everything else runs client ⇄ desk over one WebRTC connection, DTLS end to end. Desks have no inbound HTTPS, certificate or DNS name (§2, §4.2; ADRs 0022, 0023). Q1 is resolved: Platform may not see plaintext.
> - **Guilds:** the Guild Desk exists only while the member is in a guild and is mandatory while they are. The Founder's Guild Desk hosts the guild; members' Guild Desks are lighter replicas (§4.5; ADRs 0024, 0025).
> - **Idle:** a desk stops only after **24 hours** of inactivity, with no shorter default, and a clear waking state (§3.14, §10.5; ADRs 0026, 0031).
> - **Quality bar:** "never sluggish" budgets, 60 fps, minified pages rendered locally (§2.2, §6.5, §7.4; ADRs 0028, 0030).
> - **Themes:** Light, Dusk and Dark (§3.12; ADR 0029).
> - **Pricing:** flat membership prices, planned always-on (§11; ADRs 0025, 0027).
> - **Review fixes (same day):** sizing rebased on Platform ADR 0032's 100 GB allowance, with a new blocking Q16 before guilds open; Browser phasing made explicit (Phases 1–2 browse stream-only; member Guild Desks get no Browser until minified mode ships, §7.4, §12); islands defined as a crop of the warm encoder (§7.4); Chromium kept running on primaries (§6.1, B18); contract 0.2.0 conflicts added to §13.2; the guild replica purged on any boot without a guild (§4.5.1).
>
> **Still pending:** the browser benchmark is running. Every instance size and remote latency number marked *pending benchmark* is confirmed or changed by a later pass.

## Contents
1. [Purpose and concepts](#1-purpose-and-concepts)
2. [Architecture overview](#2-architecture-overview)
3. [Canvas UX and visual system](#3-canvas-ux-and-visual-system)
4. [Desk daemon and app foundations](#4-desk-daemon-and-app-foundations)
5. [Notebook](#5-notebook)
6. [Browser: real browser and streaming](#6-browser-real-browser-and-streaming)
7. [Minified websites](#7-minified-websites)
8. [Chat](#8-chat)
9. [Agent](#9-agent)
10. [Desk VM image, data and lifecycle](#10-desk-vm-image-data-and-lifecycle)
11. [Sizing](#11-sizing)
12. [Phased roadmap](#12-phased-roadmap)
13. [What Desk needs from Platform](#13-what-desk-needs-from-platform)
14. [Risks](#14-risks)
15. [Open questions (blocking)](#15-open-questions-blocking)

---

## 1. Purpose and concepts

**Purpose.** Desk is the member's "only operating system": a full-screen web app where each workspace (**desk**) is a panel on a zoomable canvas. Each desk runs on its own EC2 VM, which holds that desk's data and a real browser. Four apps come first: **Notebook**, **Browser**, **Chat** and **Agent**. The pillars are compartmentalization, anti-stress and ease of use. Privacy is what we sell, so desk content stays on the desk VM.

**Ownership.** The System Engineer owns this repo: the web app, the desk daemon, the agent runtime and the desk image recipe. The Platform Engineer owns `ma-platform` and all AWS: auth, billing, desk lifecycle, the gateway and TURN, image builds and rollout, and hosting of the web app ([ADR 0001](decisions/0001-separate-repo-and-aws-boundary.md)).

### Glossary

| Term | Meaning |
|---|---|
| **Platform** | MA's control plane (`ma-platform`): accounts, billing, desk lifecycle, the gateway, TURN, desk tokens, the sealed relay, image builds and rollout. |
| **Gateway** | Platform's realtime service (`gw.`). Each SPA tab keeps one WebSocket to it, and so does each desk. It carries only control: desk state and wake progress, WebRTC signaling, TURN credentials, badge counts and pushes to desks. Never desk content. |
| **Desk** | A workspace with its own EC2 VM, data volume and apps. |
| **Primary desks** | **Personal** and **Work** for every member, plus the **Guild Desk** while the member is in a guild. Personal and Work share the primary minimum (t4g.medium, *pending benchmark*). Guild Desks are sized by role (ADR 0025). |
| **Guild Desk** | The member's desk for their guild. It exists only while they are in a guild, can't be removed while they are, and appears or disappears as Platform's desk list changes (§4.5.1). |
| **Guild host** | The guild leader's Guild Desk. Its `desk-guildhost` service holds the guild's shared spaces and guild agents and serves every member's Guild Desk. Sized by the guild's member count (ADR 0025). |
| **Member Guild Desk** | A lighter Guild Desk that keeps a replica of the guild spaces the member may see and syncs it with the host. It never streams: in Phase 2 it has no Browser (t4g.micro by default, Q16); from Phase 3 it may run a minified-only Browser on t4g.small (ADR 0025). |
| **Standby host** | A guild Officer's Guild Desk that holds a full replica and can be promoted to host (§4.5.6). |
| **Guild space** | A container on the host (notebooks, channels, files, guild agents) with its own access list. |
| **Custom desk** | Any extra desk. The member picks its size and pays for it on top of the flat price (Platform owns the pricing). |
| **Desk VM** | The EC2 instance of one desk. |
| **deskd** | The desk daemon on each desk VM: app APIs, storage, policy, session auth, the Playwright controller, the outbound gateway link (signaling, pushes), the heartbeat and SigV4 calls to Platform. It listens on no network port. |
| **desk-rtc** | The desk's one WebRTC endpoint (Go on Pion, modeled on Neko v3 and sharing no code with it): ICE-lite on udp/443 and tcp/443, DTLS, the Browser's video and audio tracks, input injection, and the bridge from the data channels to deskd. |
| **Data channels** | The eight WebRTC data channels of a desk connection (`ctl`, `rpc`, `events`, `collab`, `mdoc`, `bulk`, `input`, `keys`) that carry every app's data (§4.2.3). |
| **TURN** | Platform's coturn relay on TLS/443: the fallback for networks that block direct WebRTC. It relays ciphertext only. |
| **Agent runtime** (`desk-agent`) | The sandboxed process that runs LLM agent loops. It reaches desk data only through deskd. |
| **Kiosk Chromium** | The real Chromium on the desk VM, run as a sandboxed kiosk process and driven by Playwright. |
| **Desk app** (client, SPA) | The React + Konva web app at `app.minimalistalliance.com`. |
| **Canvas** (world) | The Konva surface where desks sit. |
| **Overview / desk mode** | Camera modes: fit all in-scope desks, or fit and focus one desk. |
| **Scope** | The Personal / Work / Guild / All switcher. It filters which desks render. |
| **Tile, widget, detail level** | An app's presence on a desk: an icon, or a widget whose detail (small, wide, large; like iOS apps vs widgets) is picked from the app's size (§3.4, [ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md)). |
| **Window** | An app's working UI (the vision's "modal"): React DOM over the canvas, in window or full mode. |
| **Cleanup** | The button in a desk's strip that re-places its apps without changing their sizes (§3.7, [ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md)). Apps are moved and resized directly; there is no Arrange mode. |
| **Layout doc** | One small JSON doc in Platform: desk positions, grids, tiles, scope tags and prefs. Metadata only. |
| **DeskLink** | The client's connection to one desk: one WebRTC PeerConnection with the data channels, plus the Browser's media while it streams. |
| **Normal / minified mode** | Browser views: the live 60 fps pixel stream, or a clean Desk-styled rendering of the page's structure, **rendered locally in the Desk app** from the MDoc the desk sends. |
| **Quality bar** | The "never sluggish" budgets B1–B18 (§2.2), enforced by the perf CI. |
| **Input to photon** | Time from an input event to the displayed frame that shows its effect. |
| **MA overhead** | What Desk adds to a remote action on top of the site's own response time and the network round trip. |
| **Light / Dusk / Dark** | The three viewing modes. Dusk has mid-tone slate surfaces, softer contrast, flat elevation and no pure black or white (§3.12). |
| **MDoc** | Minified Document: the typed JSON the desk sends for minified mode. Never site HTML. |
| **Recipe** | A cached, declarative layout plan for one site template (Stage C, §7). |
| **Island** | A cropped live view of one widget a distiller can't express, embedded in a minified page: a cropped region of the warm encoder's video (§7.4). |
| **Channel / medium** | Chat: one thread per person or group. The medium (MA, email, SMS, …) is chosen per message. |
| **Relay** | Platform's sealed store-and-forward mailbox (`desk_inbox`). It carries only ciphertext between desks. |
| **Manager / staff agent** | Every desk has one manager agent. Members add staff agents to build a "desk team". |
| **Provider badge** | The LLM provider's mark shown on every agent and its outputs. Hideable by preference. |
| **Run** | One durable agent task, checkpointed in SQLite. |
| **Approval** | A user confirmation of one exact tool payload (sends, deletes, submits). |
| **Taint U / S** | Per-run flags: untrusted input seen (U), sensitive desk data read (S). |
| **Desk token / desk session** | Desk token: a Platform JWT for one desk (ES256, 5 min), bound to the client tab's DTLS certificate (`cnf`). Desk session: one authenticated PeerConnection between a client tab and a desk. |
| **Idle-stop / wake** | Platform stops a desk only after 24 hours with no activity (§10.5) and starts it when the member opens it. |
| **Waking** | A stopped desk starting, shown in four steps: Platform's wake phases plus Desk's own "opening" step (§3.14). |
| **Release channel** | candidate → canary → waves, for desk images and web-app bundles. |

---

## 2. Architecture overview

**How people reach their desks (the owner, 2026-11-05):** the Desk app's host is **`office.`**, "because an office will have multiple desks"; `desk.` redirects to it. Everyone, the owner included, goes to `https://office.minimalistalliance.com/`, which always takes signed-in members to their home, or to a login page if they aren't logged in. The landing page links there: **My Desk** if signed in, **Login** if not. Nobody has a personal subdomain ("I'll go to my office at https://office.minimalistalliance.com just like everyone else"). Custom subdomains are for guild dashboards, a later feature still to be discussed. See [ADR 0032](decisions/0032-owners-desk-skeleton-hostname-and-rollout.md).

```
  Member's browser, any machine
  +----------------------------------------------------------------------+
  | Desk app  https://office.minimalistalliance.com (React + Konva SPA)  |
  |  Konva world: desks, tiles, widgets     React DOM: top bar, windows, |
  |  <video>: Browser stream                Notebook, Chat, Agent,       |
  |                                         minified view (local render) |
  +----------+-------------------------------------+---------------------+
             | HTTPS to api. + WSS to gw.          | ONE WebRTC connection per open desk,
             | (Cognito): sign-in, desk list and   | DTLS end to end (also via TURN):
             | state, wake, signaling, TURN creds, | video + audio (SRTP) and data channels
             | badge counts                        | ctl rpc events collab mdoc bulk input keys
             |                                     | udp/443 -> tcp/443 -> TURN on TLS/443
             v                                     v
  +------------------------------+     +--------------------------------------------------+
  | Platform (ma-platform)       |     | Desk VM (one per desk)                           |
  |  Cognito, REST API: connect, | WSS |  desk-rtc (user rtc): ICE-lite on udp/tcp 443,   |
  |   desk tokens (ES256), JWKS  |<----|   DTLS + SCTP, A/V tracks, input, channel bridge |
  |  gateway: signaling relay,   | out |  deskd (user desk): app APIs, SQLite, policy,    |
  |   desk state, wake progress, |     |   approvals, Playwright; outbound gateway WSS    |
  |   badges, pushes             |SigV4|   (signaling, pushes); SigV4 REST: hello,        |
  |  coturn TURN on TLS/443      |<----|   heartbeat, config, keys, usage, relay          |
  |  LLM key envelopes (opaque)  |     |  desk-guildhost (guild hosts only, §4.5)         |
  |  relay desk_inbox (sealed)   |     |  desk-agent (user agent) -> LLM APIs             |
  |  image builds and rollout    |     |  kiosk Chromium (user kiosk) -> the web          |
  +------------------------------+     |  desk-stream: capture + encode (on demand)       |
                                       |  /data volume (encrypted): all desk content      |
                                       |  no inbound HTTPS, no TLS cert, no DNS name      |
                                       +--------------------------------------------------+
```

| Component | Runs where | Owner | Notes |
|---|---|---|---|
| Desk app (SPA) | Browser; hosted by Platform (S3 + CloudFront at `office.`) | System Engineer builds; Platform hosts and releases | [ADR 0002](decisions/0002-web-app-react-konva.md) |
| Platform API, Cognito, gateway, TURN, lifecycle, relay | AWS, per Platform's design | Platform | `ma-platform` |
| deskd | Desk VM, Java 21 + Spring Boot in Docker | Desk Engineer | [ADR 0040](decisions/0040-desk-services-spring-boot-docker.md) (supersedes ADR 0006), [ADR 0023](decisions/0023-desk-data-channel-protocol.md) |
| desk-rtc | Desk VM, Go (Pion v4, modeled on Neko v3) | System Engineer | [ADR 0022](decisions/0022-desk-connectivity-hybrid-webrtc.md) |
| desk-guildhost | Guild host and standby Guild Desks only | System Engineer | [ADR 0024](decisions/0024-guild-host-and-member-sync.md) |
| desk-agent | Desk VM, Java 21 + Spring Boot in Docker | Desk Engineer | [ADR 0040](decisions/0040-desk-services-spring-boot-docker.md), [ADR 0018](decisions/0018-agent-framework-ai-sdk.md) until replaced, [ADR 0019](decisions/0019-agent-safety-policy-point.md) |
| Kiosk Chromium + Playwright + capture/encode | Desk VM | System Engineer | [ADR 0008](decisions/0008-browser-streaming-webrtc-neko.md), [ADR 0009](decisions/0009-browser-process-model.md), [ADR 0030](decisions/0030-browser-modes-local-minified-60fps-normal.md) |
| Desk image (AMI) | Recipe in `ma-desk/image/`; built and rolled out by Platform | Contents: System Engineer. Pipeline: Platform | [ADR 0007](decisions/0007-desk-image-debian-arm64.md) |

**Key flows.**
1. **Open a desk.** Each SPA tab keeps one WSS to the gateway and makes one DTLS certificate. To open a desk, the SPA calls Platform `POST /v1/desks/{id}/connect` with that certificate's fingerprint and watches the desk on the gateway. A stopped desk wakes, and the gateway streams its progress (the waking state, §3.14). Once the desk is ready, `connect` returns a desk token bound to the fingerprint (`cnf`) and the desk's registered DTLS fingerprints. The SPA sends `session.open` with the token; the gateway and deskd both verify it; the SDP offer and answer then travel in `signal` messages that the gateway relays unread. ICE, DTLS and SCTP run directly between the browser and the VM ([ADR 0022](decisions/0022-desk-connectivity-hybrid-webrtc.md), §4.2).
2. **Use the apps.** Every request, subscription, Notebook sync, upload and download runs on that connection's data channels (§4.2.3). Nothing goes through Platform.
3. **Browse.** Minified mode (the default) is rendered locally in the Desk app from MDoc on the `mdoc` channel (§7). Normal mode turns on the connection's pre-negotiated video and audio tracks; input runs on `input` and `keys`.
4. **Ask the agent.** The Agent window talks to deskd over `rpc` and `events`. desk-agent calls the member's LLM provider directly with the member's key, and calls desk tools only through deskd, which applies policy and asks for approvals.
5. **Desk to Platform.** deskd keeps one outbound WSS to the gateway, opened with the desk role. It carries signaling, badge counts and pushes (revocations, config, key and guild changes, support notices). SigV4 REST with the per-desk IAM role carries hello, the heartbeat every 60 s (activity, §4.2.9), config, LLM key envelopes, usage totals and the sealed relay.
6. **Guild.** A member's Guild Desk syncs with the guild host over its own desk-to-desk WebRTC connection, signaled through the gateway (§4.2.15, §4.5.4). Members' browsers connect only to their own desks.

**Trust boundary.** Desk content (notes, chats, agent prompts and replies, browsing, LLM keys in plaintext) exists only on the desk VM, in the member's browser memory, and at the member's chosen LLM provider. Between the browser and the desk it is encrypted end to end with DTLS, including through TURN. Platform sees metadata (signaling, desk state, heartbeats, badge counts, TURN byte counts) and ciphertext. Guild content lives on the guild host and members' Guild Desks, never in Platform ([ADR 0011](decisions/0011-desk-data-location-and-privacy.md), §4.5, §10.4). Design Q1 is resolved: Platform may not see plaintext.

### 2.1 How the drafts were reconciled
Five area drafts and Platform's draft ADRs disagreed in places, and v1.1 revisited some picks after the owner's answers. The table shows the current pick each time.

| Topic | Options on the table | Pick | ADR |
|---|---|---|---|
| Client form factor | Tauri/native (pre-v1 draft, superseded) vs web app | Web app, React + Konva | 0002 |
| Desk ingress | Platform TLS-terminating gateway (Platform's first draft) vs direct TLS to each desk VM (design v1, ADR 0010) vs WebRTC media direct with the app traffic through the gateway | **The hybrid, approved by the coordinator:** the gateway carries only control and signaling; all client ⇄ desk traffic is one WebRTC connection per desk, DTLS end to end, with TURN on TLS/443 as fallback. Q1 resolved: no plaintext at Platform | 0022 |
| Desk API auth | Token in the first WebSocket message; one-time WS tickets; bearer blob fetches; a desk-host or gateway session cookie | Platform desk JWT (ES256, 5 min) bound to the client's DTLS certificate (`cnf`), checked by the gateway and by deskd at `session.open` and refreshed in band; no cookies | 0022 |
| App API transport | REST + WSS on the desk host (design v1) vs HTTP/WS through the gateway | RPC and subscriptions over WebRTC data channels; deskd listens on no network port | 0023 |
| Desk → Platform identity | No instance profile + instance-identity document (VM draft) vs per-desk IAM role (Agent draft, Platform ADR 0011) | Per-desk IAM role for SigV4 REST and for the outbound gateway WebSocket (presigned STS); IMDS reachable only by root and deskd's user | 0022 |
| LLM key storage | Desk-encrypted KMS envelope, Platform-blind (Agent draft) vs Platform API encrypts (Platform ADR 0018) | Platform's CMK and envelope store, but **deskd** encrypts; Platform never sees plaintext | 0012 |
| Image build | Packer from GitHub Actions (VM draft) vs EC2 Image Builder run by Platform (Platform ADR 0015) | Platform's Image Builder; Desk owns the recipe and smoke tests (keeps ADR 0001's AWS boundary) | 0007 |
| OS | Debian 13 (VM draft) vs Amazon Linux 2023 (Platform's AMI contract) | Debian 13 arm64: AL2023 has no Chromium package | 0007 |
| Data path and volume | `/var/lib/desk`, 10 GB (Notebook draft) vs `/data`, 20 GB (VM draft) vs Platform rule (20 GB total) | `/data`; root 10 GB on every desk, data volume by class (§11.1), revisited after Phase 0 | 0011 |
| Who decides idle | deskd powers off (VM draft) vs Platform sweeper (Platform ADR 0016) | Platform sweeper, fed by desk heartbeats | 0026 |
| Idle threshold | Member-chosen shorter thresholds (design v1) vs 24 h (the owner) | 24 h for every desk, no shorter default | 0026 |
| Guild Desk size | Same minimum as Personal and Work (design v1) vs lighter member desks and a strong host (the owner) | Member Guild Desk t4g.small; guild host sized by member count (*pending benchmark*) | 0025 |
| Encoder frame cap | 30 fps if the bar allows vs 60 fps | 60 fps (the owner's quality bar) | 0030 |
| Minified rendering | Rendered on the desk and streamed vs rendered locally from MDoc | Rendered locally in the Desk app; only actions round-trip | 0030 |
| Badges on sleeping desks | Blank (Canvas draft) vs last counts (VM, Agent, Platform) | Last counts from Platform; never content | 0005 |
| Agent `chat.send` | Opt-in auto-send per channel (Chat draft) vs always confirm (Agent draft) | Always confirm in v1 | 0019 |
| Agent `notebook.trash_page` | Allowed (Chat draft) vs confirm (Agent draft) | Confirm (destructive class) | 0019 |
| Account-wide key limits | Later budget leases (Agent draft) vs desks report usage totals (Platform ADR 0018) | Platform aggregation of usage totals (no content) | 0020 |
| Spike and fallback instances | t3.medium (Minified draft), c7g.large (VM draft) | t4g.medium; CPU fallback c7g.large or Steady m7g.large | 0014 |
| Node version | 22 LTS vs 24 LTS | Node 24 LTS | 0006 |
| Guild sharing | Read-only per-item snapshots in Platform's S3 (Platform ADR 0019) plus per-member chat fan-out (ADR 0017) vs Founder-hosted guild spaces | Guild host on the leader's Guild Desk; member Guild Desks replicate over desk-to-desk WebRTC (the owner, 2026-11-04). Guild size cap stays 25 in v1 | 0024 |
| SSM on desks | None in prod (VM draft) vs allow-listed break-glass (Platform ADR 0009) | Agent installed for smoke tests and break-glass. It gives account admins root on a running desk, so v1 discloses it (§10.4) and every command is recorded outside the desk | 0011 |

### 2.2 Quality bar: "never sluggish"
The owner: "Minimalists are usually big about quality so if it feels slugish or slow thats a nogo." This section turns that into budgets that every feature must meet before it ships. A feature that misses its budget ships behind a flag or not at all. Decision: [ADR 0028](decisions/0028-quality-bar-never-sluggish.md).

**Principles.**
1. **Local first.** Anything the browser can answer by itself never waits for the network: scrolling, selection, typing, find, zoom, hover, window moves and canvas motion.
2. **Feedback in one frame.** Every input changes something on screen in the next frame (a pressed state, the caret, a drag ghost), even when its result needs the desk.
3. **No spinner under 100 ms, no blank screen over 100 ms.** Work that takes longer than 100 ms shows a progress cue. Work that is usually faster never flashes one.
4. **Measure MA's overhead, not the website's.** For remote actions the budget covers what Desk adds on top of the site's own time and the network round trip.
5. **60 fps is the floor.** On 120 Hz displays, local motion runs at the display rate where the device allows it.

**Reference conditions.** The budgets hold on the reference devices over US-East broadband (RTT to us-east-1 ≤ 30 ms). Q10 asks which devices; the default is a reference laptop and phone: a 2020-class Windows laptop (Intel Core i5 10th gen, integrated graphics, DPR 2) and an iPhone 12-class phone, in Chrome/Edge and Safari. West Coast and EU users add their RTT (70–100 ms), but only to the remote numbers. Numbers marked *pending* are confirmed or changed by the benchmark (§11) and the minified spike (§7.8).

| # | Surface | Metric | Budget (p95 unless stated) |
|---|---|---|---|
| B1 | Canvas: camera moves, pan, pinch, drag, move and resize | Frame rate on the 24 desks × 12 tiles fixture at DPR 2 | 60 fps floor; ≤ 8 ms of main-thread work per frame; ≤ 1% dropped frames; no frame > 33 ms |
| B2 | Local UI input (tile click, menus, toggles, window drag) | Input to next paint (Event Timing `duration`) | ≤ 50 ms (p99 ≤ 100 ms); the visible response starts in the next frame |
| B3 | Text input (Notebook, Chat, Agent composer, minified form fields) | Keystroke to glyph painted | ≤ 32 ms (2 frames at 60 Hz), p99 ≤ 50 ms, in a 20k-word note. Remote sync is never on this path |
| B4 | App window open, desk connection up | Click to first animation frame; click to content painted and interactive | ≤ 16 ms; ≤ 250 ms (inside the 240 ms open animation). App chunks are prefetched at idle, so a lazy chunk is never on this path |
| B5 | In-app navigation (Notebook page, Chat channel, Agent thread) | Click to content painted | ≤ 100 ms from memory; ≤ 100 ms + RTT when fetched from the desk |
| B6 | Agent reply streaming | Token received to painted | Next frame, with no layout jumps (scroll anchoring) |
| B7 | Minified page: scroll, select, find, zoom, expand | Frame rate and input to paint | Same as B1 and B2. Rendered locally, with no network on the path |
| B8 | Minified page: an action (click, toggle, submit) | Click to pressed state; click to progress cue if there is no result yet; click to result painted | ≤ 16 ms; at 100 ms; the site's time + RTT + MA overhead of ≤ 50 ms p50 and ≤ 150 ms p95 (*pending spike*) |
| B9 | Minified page: Back, Forward, tab switch | Click to previous view painted | ≤ 16 ms, from the client's in-memory MDoc history; the real page catches up behind it |
| B10 | Minified page: a new page arrives | MDoc received to first viewport painted | ≤ 50 ms; text before images; no layout shift when the images arrive |
| B11 | Normal mode (streamed) | Delivered frame rate while scrolling | ≥ 58 fps on average, p5 ≥ 55, zero freezes in a 60 s scroll (*pending benchmark*) |
| B12 | Normal mode | Input to photon | p50 ≤ 90 ms, p95 ≤ 150 ms from US-East (*pending benchmark*). The pointer is drawn locally (0 ms) |
| B13 | Switch from minified to normal | Click to first video frame | ≤ 300 ms (the encoder stays warm while the Browser window is visible) |
| B14 | Running desk | Focus or open to desk session plus first summary | ≤ 1.5 s; resume after a network blip ≤ 1 s |
| B15 | App start | Load to first canvas paint (from the mirrored layout doc) | ≤ 1 s cold, ≤ 400 ms with a cached bundle; initial JS ≤ 250 KB gzipped |
| B16 | Theme switch | Click to new theme fully applied | ≤ 50 ms of work, then a 200 ms crossfade; the wrong theme never flashes on load |
| B17 | Sleeping desk | Click to visible waking state; stopped to ready | ≤ 100 ms; p50 ≤ 35 s, p95 ≤ 60 s (*pending Phase 0*; §3.14) |
| B18 | Browser cold open (after a desk wake, or a Chromium restart or crash; §6.1) | Click to each tab's last snapshot painted under a visible "restoring" state; click to live tabs | ≤ 250 ms, as B4; live tabs p95 ≤ 5 s after session restore (*pending Phase 0*) |

**How it is measured.**
- **In the app:**
  - User Timing marks around every budgeted step (`ma:window-open:*`, `ma:act:<id>:*`).
  - Event Timing (`PerformanceObserver` type `event`, `durationThreshold: 16`), Long Animation Frames, layout shifts and rAF frame deltas.
  - Konva draw time per frame, in perf builds.
  - WebRTC `getStats()` for the stream: `framesPerSecond`, `framesDropped`, `freezeCount`, `jitterBufferDelay`, `totalDecodeTime`, and the candidate pair's `currentRoundTripTime`.
- **Minified action breakdown:**
  - Each action carries an id. deskd stamps when it received the action, dispatched it, saw the first DOM mutation and sent the patch. The client stamps when it sent the action, applied the patch and painted it.
  - MA overhead = the client-visible time − the site's own time (first mutation − dispatch) − RTT.
  - A "native baseline" runs the same scripted step in a local Chromium.
- **Photon probe (normal mode):**
  - A test page in the kiosk Chromium flips a 32 px marker on each key or click and shows a frame counter.
  - The client stamps each input, reads every decoded frame with `requestVideoFrameCallback`, samples the marker, and reports `expectedDisplayTime` − the input time.
  - The frame counter gives delivered fps, repeated frames and freezes.
  - Display scan-out is excluded, as it is for local UI.
- **Dev overlay** (Phase 1, Mod+K → "Performance"): fps and a frame-time histogram, the last 20 input latencies, data-channel RTT, stream stats and minified action breakdowns.

**Perf CI** (Phase 1; Playwright with Chrome DevTools Protocol performance traces):

| Tier | When | Where | What | Fails when |
|---|---|---|---|---|
| `perf-pr` | Every PR that touches the web app | GitHub-hosted runner, Chromium, no GPU | Canvas stress tour (B1); window open for each app (B4); 200 keystrokes into a 20k-word note (B3); a 5k-message Chat scroll; an Agent token stream; 30 recorded MDoc fixtures (B7, B10); a theme switch (B16). All run against a mock desk over a loopback WebRTC connection with 30 ms of netem delay | The median of 5 runs regresses > 10% against `main`, or crosses the runner's calibrated ceiling |
| `perf-desk` | Nightly and before every release | A `DeskKind=test` desk in us-east-1 (~1 h/night, ~$1–2/month) driven from CI, with RTT profiles of 30, 70 and 90 ms and a 1%-loss Wi-Fi profile. Once a week the run goes through TURN | Connect and resume (B14); minified actions on fixture pages served by the desk (B8, B9); the photon probe and a 60 s scroll (B11–B13); wake from stopped (B17) | Any p95 over budget at 30 ms RTT. The other profiles are published as trends |
| `perf-device` | Before every release | The reference devices, running the same Playwright suite in Chrome and Safari | All budgets, as absolute numbers | Any budget missed. This blocks the release |

Each failing run attaches its Playwright trace and Chrome performance trace to the PR or release.

**What fails the bar.** Any one of these blocks a merge or a release:
- A budget missed at p95 on a reference device, or a CI regression above 10%.
- A long animation frame over 50 ms during an interaction scenario, or more than 1% dropped frames during motion.
- A layout shift (> 0.01) after a window's content first paints.
- A spinner or skeleton on a local-only action.
- A remote action with no visible feedback within 100 ms.
- A stream freeze in the 60 s scroll, or a delivered-fps p5 below 55 (*pending benchmark*).
- A flash of the wrong theme on load, or a theme pair below its contrast minimum (§3.12).

**No field telemetry.** Privacy is the product, so the Desk app never sends performance data on its own. With a support request, a member can choose to send a performance report that holds only numbers (histograms, no URLs or content) (Q11). The cost: slowdowns on members' machines show up only in the nightly desk runs and in reports members send.

**Honest limits.**
- **Normal mode is video.** It can be smooth (60 fps) and quick (≤ 150 ms), but not as immediate as a local browser (~30–50 ms), and text is softer on HiDPI screens (§6.5). That is why minified mode becomes the default when it ships in Phase 3. Until then, Phases 1–2 browse in normal mode only (Q8).
- **Remote steps include the RTT:** +70–100 ms outside US-East until more regions exist. Local steps (B1–B7, B9, B10) are unaffected.
- **Slow sites stay slow.** The bar caps what MA adds, not the site's own time.
- **CI runners have no GPU,** so absolute frame budgets are proven only on the reference devices. CI catches regressions.
- **Pending benchmark:** whether t4g.medium sustains 60 fps encoding (§11), and how much headroom the t4g.small member Guild Desk has for minified browsing (it doesn't stream; Q12).

---

## 3. Canvas UX and visual system

This section covers everything outside an app's own window: the world canvas, desk panels, tiles and widgets, the scope switcher, window frames, themes, the waking state, and how badge and widget data reaches the canvas. Light colors are sampled from `docs/assets/desk-inspiration.webp`; Dusk and Dark are derived from them (§3.12). Decisions: [ADR 0003](decisions/0003-canvas-interaction-model.md), [ADR 0004](decisions/0004-canvas-rendering-and-accessibility.md), [ADR 0005](decisions/0005-client-state-and-storage.md), [ADR 0029](decisions/0029-themes-light-dusk-dark.md), [ADR 0031](decisions/0031-waking-and-reconnecting-ux.md).

**Principles.**
1. **Spatial memory.** Desks keep their world position. Scopes and focus move the camera, never the desks.
2. **Compartmentalization.** Each desk is a workspace with its own open windows. Apps never move between desks, because their data lives on different VMs.
3. **Calm by default.** Badges appear only where something needs the user, and one key turns on a privacy shield.
4. **Right tool per surface.** Konva draws the world. Plain React DOM handles anything text-heavy or form-like: the top bar, menus and windows.

### 3.1 World, camera, focus
- World units are CSS px at scale 1. The camera is `{x, y, scale}`, with scale between 0.2 and 3.
- **Camera modes:**
  - `overview` fits the in-scope desks (scale ≤ 1, 48 px margin).
  - `desk` fits the active desk (48 px margin, 16 on phones). Scale is capped at 1.75 so a desk with 2 apps doesn't balloon.
  - `free` applies after a manual pan or zoom.
- **Camera moves** take 320 ms plus up to 160 ms for distance, eased with `cubic-bezier(.2,0,0,1)`. The center is interpolated linearly and the scale in log space, so zoom speed feels even. A new move can interrupt one in progress. Under reduced motion the camera jumps and the change is a 120 ms crossfade.
- **Active desk.** There is always exactly one, drawn with the mockup's blue ring. Cycling and shortcuts act on it.
- **Cycle order** follows the spatial reading order of in-scope desks: rows grouped by vertical overlap, then x, wrapping at the end.
- **Leaving desk mode:** Esc, a click on empty background from a desk in focus, the top-bar breadcrumb ("Your office › Work"), or pinching out below 0.8× fit.
- **A desk in focus** (ADR 0003, 2026-11-09): one the member focused (a click or tap on it, a key, a card), or one they zoomed in on by hand, past 1.1× the zoom focusing it gives with the desk under the middle of the screen (`FOCUS_ZOOM`). A desk the office focused for them, on arriving or with a scope or Fit that has one desk, isn't one, and a pan or a zoom out leaves it. A click on empty background moves nothing from any other view.
- **Sleeping and waking desks.** A desk whose VM is stopped (24 h with no activity, §10.5) renders from the layout doc with no status text ("asleep" is not shown, §3.5) and the **last badge counts** Platform holds (numbers only, never content). Focusing it, or opening one of its apps, calls Platform `connect` with `start: true`. Within 100 ms the panel shows the **waking** state: the current step ("waking · 2 of 4"), driven by Platform's wake progress events (§3.14). There is no time estimate. A segmented progress bar on the panel is planned and not built yet. The canvas never blocks meanwhile. The All overview never wakes a desk by itself (§10.5).

| Input | Overview | Desk mode |
|---|---|---|
| Click or tap a desk | Focus it | Focus that desk |
| Click or tap a tile | Open the app (its desk focuses behind it) if the tile is ≥ 32 px on screen, otherwise focus the desk | Open the app |
| Click empty background | n/a | From a desk in focus, go to overview, except while an app window is open; otherwise nothing (in `free` too) |
| Two-finger scroll or wheel | Pan (Shift: horizontal) | Horizontal swipe ≥ 80 px goes to the next or previous desk, one step per gesture. A gesture ends after 200 ms without wheel events, which absorbs trackpad inertia. |
| Pinch or Ctrl+wheel | Zoom at the pointer and switch to `free` | Pinching out below 0.8× fit goes to overview |
| Drag background (mouse or one finger) | Pan | Paged drag: releasing past 20 % of the width, or faster than 0.6 px/ms, goes to the next or previous desk |
| `[` `]` or ← → | Move the active-desk ring | Next or previous desk |
| `1`–`9` / `0` | Focus the nth desk / fit the scope | Same |
| Enter or Space | Focus the active desk | Open the keyboard-focused app |
| Esc | n/a | Close the top window, otherwise go to overview |
| Right-click or 500 ms long-press | Desk or app context menu | Same |

**Global keys.** Apps must not bind these:
- **Esc.**
- **Shift+Esc** always leaves the current window. This includes Browser, where plain Esc goes to the web page.
- **Mod+K** opens the command palette (go to desk, open app, clean up desk, privacy shield, full screen).
- **`\`** toggles the privacy shield.

Single-key shortcuts fire only when focus is outside editable elements. A pref disables swipe-to-cycle.

**Browser limits.** Browsers reserve Ctrl/Cmd+Tab, W, T and N, and Esc exits browser full screen. Every Esc action therefore also has a visible control. In Chromium full screen we call `navigator.keyboard.lock(['Escape'])`: a short Esc reaches the app and a long press exits full screen. The top bar has a Full screen button, and the SPA ships a web manifest so it can be installed as an app window.

### 3.2 Scope switcher
A segmented control at the top right (Radix ToggleGroup): **Personal | Work | Guild | All**, followed by `⋯` for custom desks. The mockup has no Guild segment. It shows only while Platform's desk list holds a Guild Desk for the member, and it appears or disappears with guild membership (§4.5.1).
- **A scope is a filter.** Out-of-scope desks fade out over 160 ms and stop rendering, hit-testing and badging. The camera fits the desks that remain. A scope with one desk goes straight to desk mode on it, and a member can still zoom out. All is the overview of every desk. (The owner to confirm filter vs focus: Q6.)
- **Custom desks** get a scope tag (Personal, Work, Guild or none) at creation, editable from the desk menu. They appear under their scope and under All. Up to 3 can be pinned as their own segments; `⋯` lists the rest plus "New desk…".
- **Cross-scope activity** shows only as a 6 px dot on a segment whose desks have badges (pref `dot|off`, default `dot`). It never shows numbers, so Work stays quiet while the user is in Personal.
- On phones the switcher becomes a dropdown chip. With a single desk (Phase 1) the switcher is hidden.
- The mockup shows Work selected with Personal still visible. We read that as a mid-transition frame (Q6).

### 3.3 Desk panels and layout
Decision: [ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md), amended by [ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md). It replaces the cell grid and first-fit reflow on larger screens.
- **Surface.** A desk is a **work area** above a **44-unit strip** along its bottom edge:
  - Apps stay in the work area, so they never cover the name or the controls.
  - Padding is 24 at the sides and at the top (the top was 40, when a label sat there). Default apps sit at that 24. A dragged app can come within 8 of the sides and the top, and down to the strip. The smallest desk is 232 wide, so the longest status line fits.
  - The desk's name is etched into the strip at bottom center (§3.12). It replaces the label above the panel.
  - At rest the strip shows the name, plus the hidden count when it's above zero (§3.7). The status line (§3.5, only for a problem) sits at its left. At its right, from the right: the resize grip, the hidden count, then the cleanup button (§3.7). Each has a fixed slot, so nothing slides when the pointer enters the desk: the grip's slot stays reserved at rest. All of these icons are etched like the name (§3.12); the grip and the cleanup button show only on hover or focus, and cleanup only if it would change something.
- **Free placement (larger screens).** Each app stores its own position and size in the work area; the desk stores its size in units, not cells.
  - Apps are freely movable and resizable, with a minimum size of 56 × 56 so the glyph and pointer target stay usable, within the work area. Apps can stack: a drop never moves another app, and anything can go over anything ([ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md), §3.7). Apps still stay out of the strip, so a tile can't cover the name or the icons.
  - A desk moves and resizes without snapping. Desks never overlap: a moved or growing desk pushes its neighbors aside (§3.7).
  - Cleanup (§3.7) re-places the apps.
- **Phones** keep the cell grid, as before (no free placement, no cleanup):
  - Cell pitch is 92: a 76 tile plus a 16 gap.
  - Items are an ordered list of `{app, size}`, and positions come from first-fit, row-major packing into 4 columns and are not stored.
- **No inner scrolling.** A desk grows downward to fit its apps (dragging its corner, cleanup) and is never made smaller for them.
- **Too-wide items.** On phones, an item wider than its desk renders at the next size that fits (large → wide → small → icon). Its stored size does not change.
- **Defaults.** Primary desks start with Chat, Notebook, Browser and Agent as icons, 584 wide and 236 tall: six reference tiles wide, 24 padding at the top and sides, 168 of work height, then the 44 strip. Apps start in one row at the top, with a free band under them, and may reach the strip's top edge. No app is mandatory. v1 allows one instance of each app per desk.

### 3.4 Detail levels and widget content
An app is no longer one of four fixed sizes ([ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md)). It is freely resized (§3.3), and its content picks the **detail level** from its size: the largest level in the table that fits in both directions. Below small it is an icon. The thresholds are the old cell sizes (two cells is 168, four is 352); on phones the cell sizes still apply (§3.3).

| Level | From size | Notebook | Browser | Chat | Agent |
|---|---|---|---|---|---|
| icon | below small | Glyph | Glyph | Glyph + unread count | Glyph + needs-you count + provider mark |
| small | 168 × 168 | Last edited note: title, 2-line snippet, time | Page snapshot + host | Top unread channel: name, sender, 1-line preview | Primary agent: name, state, current task, provider mark |
| wide | 352 × 168 | 3 recent notes + New note | Snapshot, title, 3 recent sites | 3 channels with last message and medium glyph | Up to 3 agents with state and marks; today's spend vs limit |
| large | 352 × 352 | 6 recent notes + month strip with dots on edit days (Temporal view) | Large snapshot, 5 recent sites, Minified/Normal chip | 6 channels | Up to 4 agents, last 3 activity lines, spend bar |

- **Rollout.** Phase 1 ships icon and small. Wide and large come in Phase 2.
- **Changing size:** resize the app directly (§3.7). The context menu "Size ▸" is gone.
- **Browser widgets** show a still snapshot (WebP ≤ 640×400, refreshed at most every 10 s while the widget is visible and the browser stack is running; otherwise the last snapshot), never the live stream. The stream starts only when the Browser window opens.
- **Provider marks** are a vision requirement. One sits at the bottom right of the Agent tile (a 20 px `mark.disc` disc with a monochrome mark, §3.12), one sits beside each agent in widgets, and one sits beside the status line when it shows an agent's state (needs you, paused, agent error; §3.5). On the Agent tile the mark hides while the resize corner shows. Hiding rules are in §9.4.
- **Badges:**
  - Shape: a 24 px `badge.bg` disc, centered 12 px in from the tile's right edge and 10 px down from its top, with 13/600 `badge.fg` tabular figures, capped at `99+` (§3.12).
  - Defaults: Chat shows unread messages and Agent shows items that need the user. Notebook and Browser are off.
  - Prefs: count, dot or off per app, plus a quiet mode per desk.
  - Badges pop in over 200 ms (no animation under reduced motion).
- **Open windows.** A 4 px dot under a tile marks an open window, as in the macOS dock.

### 3.5 Agent status line
The strip's left shows an 8 px dot and a 13 px label, **only when there is a problem** ([ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md): "We should only show something on the desk if there's a problem"). If the line would touch the name, the name hides until the problem clears. When the line shows an agent's state (needs you, paused, agent error), that agent's provider mark sits beside it. The state merges Platform's VM state with deskd's agent state, and the last column says which states show:

| Condition | Dot | Label | Shown |
|---|---|---|---|
| VM stopped | Hollow grey | asleep (inside a Give Back window: "asleep · Give Back until 07:00") | hidden |
| Waking: Platform phase `queued` | Grey, pulsing | waiting for capacity · #3 | shown |
| Waking: Platform phases `starting`, `booting`, `connecting` | Grey, pulsing (static under reduced motion) | waking · 1 of 4 … 3 of 4, with a progress bar on the panel's bottom edge (§3.14) | shown |
| Running; desk session opening (signaling, ICE, DTLS, first summary) | Grey, pulsing | connecting… (also during a wake) | shown, after 2 s so it doesn't flash |
| VM state not yet known | Hollow grey | checking… | hidden |
| No connection to the desk is available yet (before layout sync and the gateway are connected) | Hollow grey | not connected yet | hidden |
| Platform denied access to the desk | error | access denied | shown |
| Session lost for more than 1 s while running | warn | reconnecting… (after 30 s: can't reach desk) | shown |
| Stop announced (`prepare_stop`) | warn | going to sleep · 0:45 | shown |
| Stop announced, `stopReason: "data_guard"` | warn | Your desks are stopping: your data use this month went past your plan. (· 0:45) | shown |
| `connect` refused `data_guard` | warn | stopped · data use past your plan | shown |
| Wake failed | error | couldn't wake · Retry | shown |
| No agent key bound | Hollow grey | no key | hidden |
| Agent idle | online green | agent online | hidden |
| Agent working | accent, 2 s pulse | working · ‹task› | hidden |
| Agent needs input or approval | warn | needs you | shown |
| Paused at usage limit | warn | paused · limit reached | shown |
| Error | error | agent error | shown |

The label always names the state, so color is never the only signal. Hidden states (a healthy desk, asleep including the Give Back wording, checking, not connected yet, agent online, working with its task, no key) are not shown on the desk; that information lives on the Agent tile or in "About this desk". Waiting states stay because the desk can't be used yet and a click would otherwise seem dead; the going-to-sleep warning stays because the member can still act.

### 3.6 App windows (DOM)
- **Screen space.** Windows are a DOM layer over the stage, which gives crisp text, IME input and accessibility. They do not zoom with the canvas.
- **Window sets per desk.** Switching the active desk parks the old desk's windows and restores the new desk's. Parked windows stay mounted for the 3 most recent desks, and the Browser stream pauses while parked. The overview parks everything.
- **Window mode:** drag by the title bar; resize from the edges; minimum 360×280; new windows cascade by 32 px. Defaults: Notebook 880×640, Chat 720×640, Agent 480 wide at full height on the right. Browser opens in full mode.
- **Full mode:** fills the area under the top bar with a 12 px margin; aria-modal, traps focus, dims the canvas. Toggle with the title-bar button or a double-click on the title bar.
- **Tablets and phones.** On tablets every window opens full. On phones a window is a full-screen sheet with a back chevron, and the top bar is hidden.
- **Several windows.** Up to 4 per desk, one per app. Clicking raises a window. The active window has the deeper shadow and a `text.primary` title; inactive windows have `text.tertiary` titles.
- **Open and close animation.** A window opens with a 240 ms FLIP from the tile's screen rect. From the overview, the camera focuses the desk first and the window launches halfway through that move. Closing takes 180 ms back into the tile, or fades if the tile is off-screen.
- **Closing.** ×, Esc (not in Browser) or Shift+Esc. Apps autosave, so closing never loses work.
- **Focus.** Focus moves to the app's `initialFocus` element on open and returns to the tile's proxy button on close. Windows use `role="dialog"` and are `aria-modal="false"` in window mode.
- **Frame.** Radius 16, with a 44 px title bar: an 18 px glyph, the app name at 14/600, the desk name in `text.tertiary`, and controls at the right.

### 3.7 Moving, resizing and cleanup
Decision: [ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md). There is no Arrange mode (it was never built). Apps and desks are moved and resized directly, so nothing needs a mode to be edited.
- **Desks:** drag to move, with no grid and no snapping; a bottom-right handle resizes without snapping (one corner handle of our own, no Konva Transformer, no rotation), and dropping it leaves the camera alone, so the corner stays under the pointer (Fit and `0` refit on request). "Tidy up" (Phase 2) lays desks out in rows.
- **Desks never overlap** ([ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)). Stacking is only for apps and widgets on a desk. Everything that changes a desk's bounds pushes its neighbors aside: dragging, the corner, the keyboard's arrows and `r`, and cleanup when a desk grows.
  - The desk in hand stays under the pointer, and a grown desk's corner stays under the pointer. Neighbors move away along the shortest way out, cascading through chains, and nothing hops.
  - A neighbor's direction is chosen at first contact and held for the rest of that drag.
  - Retreating brings neighbors back during the same drag, because positions are worked out from where everything was when the drag began. On drop they stay.
  - The gap between desks is at least 24 units. New desks are still placed 72 apart.
  - Desks don't swap on the way past. To swap two, push one aside and go round.
  - The camera doesn't move. Under reduced motion, timed moves are instant; moves during a drag still track the pointer.
  - A saved layout that overlaps loads clear, by the smallest moves, before first paint.
- **Apps (larger screens):** drag to move and resize freely within the work area (§3.3), over or under other apps (see Stacking below); a drop never moves another app. "−" removes an app (its data stays on the VM, "+" brings it back); the "+" tile opens the app picker. Apps cannot move to another desk.
- **Keyboard moving and resizing** (required before apps become movable for real, since dragging needs a keyboard alternative):
  - On a focused app, `m` moves and `r` resizes; or choose Move or Resize from its context menu (`.` or the menu key).
  - Arrows change it by 8 units, Shift+arrows by 40. Enter keeps the change; Esc restores where it started.
  - Arrows never jump past other apps: they move by their step and stop only at the edge of the work area ([ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)).
  - Tab keeps reading order, not stacking order, so hidden items stay reachable. An item that takes keyboard focus comes to the front, so its focus ring is never covered.
  - Each step announces through the live region: the position or size after moving, or "Can't go further".
  - A focused desk uses the same pattern: `m` then arrows move it (8 units, Shift 40), and `r` then arrows resize it. Plain arrows on a focused desk cycle desks, as everywhere on the canvas.
  - Cleanup is in the desk's context menu, and its button is in the proxy layer.
  - These are single keys and a mode because Alt+arrows and Mod+arrows are browser back and forward on some systems, and plain arrows already cycle desks. They act only while an app or desk on the canvas has focus, never inside an app window.
- **Stacking** ([ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)): anything can go over anything on a desk.
  - Each desk keeps its own stacking order, saved with the layout. Existing layouts start in reading order. A new app goes on top, at the first free spot if there is one.
  - Pressing an app or widget brings it to the front, on press and before any drag, so what you grab is what moves. A click also opens it. A press takes the topmost item under the pointer.
  - The context menu has Bring to front and Send to back.
  - The tile elevation (`elevation.tile`) separates overlapping tiles. It's faint in Dark, so check all three themes.
- **Hidden items** ([ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)): the count shows what stacking has buried.
  - An item is hidden when the part not covered by items above it has no area at least 12 × 12 units, so nothing is left to press. Measured in units, so zoom doesn't change it, and worked out only when the layout changes, never per frame.
  - The icon is two overlapping rounded squares with the number beside it (Jost 600, tabular digits), etched like the desk name (§3.12). It shows at rest whenever the count is above zero, and is gone at zero.
  - Accessible name: "3 hidden apps on the Personal desk", mirrored in the proxy layer. Tooltip: "3 hidden". Count changes are announced politely.
  - Click opens a small list above the icon in the normal menu style, not etched: each row is the app's icon and name, at most 6 rows before it scrolls. Choosing one brings it to the front, closes the list and rings the item for 600 ms (static under reduced motion). Enter opens, arrows move, Enter chooses, Esc closes. The list opens even for one item, so the icon always does the same thing.
- **Cleanup** (the "magic" button): re-places a desk's apps without shrinking anything.
  - **Where:** in the strip, just left of the resize grip, only while the pointer is over the desk or it has focus (touch: while focused), and only if cleanup would change something (any overlap counts). Also in the desk's context menu and, when built, the palette ("Clean up desk").
  - **Look:** a 28-unit ghost button (44 on touch) with a small sparkle glyph in `text.secondary`, `surface.fill` behind it on hover, tooltip "Clean up", accessible name "Clean up ‹desk› desk", mirrored in the proxy layer.
  - **What it does:**
    1. Takes the apps in reading order of where they are now, top then left. Filling a hole can change that order, so it repacks until the order it reads is the order it packed. If that never settles, it packs once more keeping the order, so running cleanup again changes nothing.
    2. Places each at the top-left-most free spot in the work area, 16 between apps and 24 from the edges.
    3. Keeps every app's width and height exactly: it never shrinks, and nothing overlaps once it's done.
    4. Keeps the desk's size; if the apps need more room the desk grows downward, pushing its neighbors aside, and it never gets smaller.
    5. Moves all apps together over 240 ms with the standard ease (instantly under reduced motion). Apps may cross during the move, by up to 68 units when the reading order changes. Neighbors a growing desk pushes aside move with it over the same 240 ms. Windows and the camera stay put, and the camera never moves when the desk grows.
    6. Resets the stacking order to reading order, so the hidden count goes to zero.
  - **Undo:** one level. The button becomes "Undo" for 10 s, and "Undo clean up" stays in the context menu until the next change on that desk. It restores every position, the desk's size, the stacking order and any neighbors it moved exactly, and is not kept across a reload.
  - **Announce:** "Desk cleaned up", through the live region.
  - **Tests:** no overlap after it runs; every size unchanged; running it twice changes nothing; stacking order is reading order and the hidden count is zero afterward; undo restores positions, the desk's size, the stacking order and moved neighbors exactly.
- **Phones** keep reordering items only (§3.3), with no cleanup. **New desks** go to the first free slot right of the last desk in the bottom row.

### 3.8 Persistence
| Data | Stored in | Why |
|---|---|---|
| Layout doc: desk x/y and size in units, each app's position and size, each desk's stacking order (phones: the ordered item list), scope tags, pins, prefs (badge styles, scope dots, provider-badge visibility, theme) | Platform `GET/PUT /v1/me/desk-layout` (JSON ≤ 64 KB, ETag/If-Match), mirrored in localStorage for an instant first paint | Spans desks and must render while VMs sleep. Metadata only. |
| Camera, scope, active desk, open windows and their rects | localStorage, per device | Each device has a different screen |
| Badge counts of running desks, widget content, snapshots | Memory only | Desk content; users may be on a shared machine |
| Last badge counts of sleeping and out-of-scope desks | Platform desk record, pushed over the gateway WebSocket (`GET /v1/desks` as fallback) | Counts only; lets a desk show "3" without a connection or a wake |

Writes are debounced 1 s after a move, resize, cleanup or pref change. On a 412 the client refetches and adopts the server copy; if a drag is in progress, the last write wins instead. Cleanup's undo is not stored.

**Contract:** the layout stores each app's position and size, each desk's stacking order, and the desk's size in units instead of cells ([ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md), [ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)). The layout document is opaque to Platform (contract `desks.md`, "Desk UI layout persistence"), so no contract change is needed; until layout sync is connected the layout is per browser. There is one user, so conflicts are rare.

### 3.9 Live data: deskd → canvas
- **`DeskLink`** is the client's connection to one desk: one WebRTC PeerConnection with its data channels (§4.2). §4.2.8 says which desks get one: running in-scope desks and desks with open or parked windows. Out-of-scope and stopped desks get none and show the badge counts the gateway pushes (numbers only).
- **Connecting.** Every rendered desk is watched on the gateway (state, wake progress, badges). A link opens with `connect {start: false}` when its running desk first renders in scope, so rendering never wakes a desk. Focusing a desk or opening one of its apps uses `start: true`. Setup and authentication follow §4.2.1 and §4.2.2.
- **Subscribe.** The client sends `SUB {topic: summary, params: {level: badges|widgets, items: [{app, size}]}}` on `rpc`, so deskd builds only what is on screen.
- **Updates** arrive on `events`: `snapshot {seq, agent, apps}`, then `patch {seq, apps}` messages that replace data per app, coalesced to at most 2 Hz per desk. Limits: text ≤ 120 chars, ≤ 6 rows per widget, ≤ 8 KB per app.
- **Browser snapshot.** The summary carries `{etag, w, h}`. The client fetches the image with `browser.snapshot.get` over `bulk` and draws it via `createImageBitmap` into a `Konva.Image`.
- **Reconnect and resume** follow §4.2.7: an ICE restart first, otherwise a new connection that resubscribes with `since: seq`; deskd replies with the missed events or a fresh snapshot. A link stops retrying as soon as the gateway reports its desk `stopping` or `stopped`, and comes back only through a fresh `connect`.
- **Close codes** on `ctl`: 4401 session expired or revoked (refresh the token and reconnect, or drop the desk if revoked), 4403 access denied (drop the desk), 4503 or `desk_stopping` (the close alone doesn't prove a stop, so check `connect {start: false}`, §4.2.7), 4002 plain restart (first retry at about 2 s, then normal backoff).
- **Grace period.** A link closes 30 s after its desk leaves the set, so toggling scopes doesn't thrash connections.
- **Batching.** Incoming messages are applied to the store once per animation frame.

### 3.10 Rendering and performance
- **Stage size.** The stage fills the viewport (ResizeObserver, `100dvh`, visualViewport on mobile). The background gradient is CSS on the container, not canvas.
- **Layers.** Two: **world** (panels, tiles, widgets) and **overlay** (focus ring, drag ghost). The camera sets the transforms of both layers' root groups.
- **Camera without React.** Tweens run in a rAF loop that changes Konva nodes through refs and commits to the store only when the move finishes. React re-renders only for structural or data changes, through per-desk and per-item Zustand selectors.
- **Hit testing.** While the camera moves, the world layer stops listening, so the hit graph isn't redrawn. Decorative nodes are always `listening(false)`. One delegated handler on the stage resolves node names (`desk:<id>`, `item:<desk>:<app>`).
- **Shadows** are the main cost. Tile and panel chrome (fill, shadow, hairline) is pre-rendered offscreen per size and scale bucket (×1.5 steps), drawn as shared `Konva.Image`s, and re-rendered when the camera settles in a new bucket. Glyphs are `Konva.Path` vectors; shapes use `perfectDrawEnabled(false)`.
- **Level of detail** by on-screen tile size s = 76·scale: s ≥ 40 full detail; 20 ≤ s < 40 glyphs and badge dots, no text; s < 20 a plain card with the name.
- **Culling.** Nodes outside the viewport are hidden, because Konva doesn't cull them.
- **DPR** is `min(devicePixelRatio, 2)`, updated on `matchMedia(resolution)` changes. If frames during a move exceed 20 ms, DPR drops to 1 until the camera settles.
- **Fonts.** Nunito is self-hosted and awaited with `document.fonts.load` before the first draw. Jost 600 (SIL Open Font License) is self-hosted for the etched desk name and icons, and the wordmark (§3.12).
- **Budget:** the canvas rows of the quality bar (§2.2: B1, B15, B16).
  - 60 fps floor, with ≤ 8 ms of main-thread work per frame on the 24 desks × 12 tiles fixture at DPR 2 on the reference devices.
  - ≤ 1% dropped frames and no frame over 33 ms.
  - Initial JS ≤ 250 KB gzipped. Each app's window is a lazy chunk, prefetched at idle after first paint.
  - The perf CI enforces this from Phase 1.
- **Theme changes** rebuild the chrome cache for the new theme (§3.12): the visible buckets before the next draw, the rest at idle. Dusk's flat elevation makes its chrome the cheapest to render.
- **120 Hz displays:** camera tweens and gestures run on rAF, so they follow the display rate. DPR and level of detail adapt to the same frame-time signal.

### 3.11 Accessibility and small screens
- **Proxy layer.** The `<canvas>` is `aria-hidden`. Over it sits a layer of transparent, focusable DOM buttons at each desk's and tile's screen rect (pointer-events none), with real names such as "Work desk, 3 apps, agent online" or "Chat, 4 unread". Keyboard focus lives there and the canvas draws the ring. Screen readers, voice control and Playwright `getByRole` all work through it.
- **Tab order:** top bar → switcher → canvas (one tab stop, arrows inside) → windows.
- **Announcements.** A polite live region announces desk focus, window open and close, and the active desk's badge changes, at most once every 5 s.
- **Contrast fixes against the mockup** (ratios: §3.12):
  - **Meta grey:** the mockup's light grey (3.3:1) becomes `text.tertiary`, which passes 4.5:1 on every surface it sits on.
  - **Active-desk ring:** the mockup's pale blue (2.2:1) becomes `ring.activeDesk`, which passes 3:1 against the panel and the whole world gradient.
  - **Selected scope segment:** gets a `border.strong` outline, because a fill change alone was 1.2:1.
  - **Keyboard focus:** adds a 2 px `focus.ring`.
  - **All themes:** Dusk and Dark are checked the same way.
- **Targets and preferences.** Touch targets ≥ 44 px (phone tiles ≥ 56 px). Honors reduced motion, browser zoom and a UI-scale pref.
- **Layout by width:** ≥ 1024 px full canvas with floating windows; 600–1023 px windows always full, compact top bar; < 600 px always desk mode with horizontal paging and page dots, All becomes a vertical stack of desk cards, windows are sheets, desks can't be moved or resized.
- **iPhone.** Safari on iPhone has no element full screen, so "Add to Home Screen" (manifest `display: standalone`) is the full-screen path. Safe-area insets apply.

### 3.12 Themes and visual tokens
The owner asked for three viewing modes: **Light**, **Dark**, and "something in between that contrasts and flattens appropriately for pleasant viewing", named **Dusk**. Decision: [ADR 0029](decisions/0029-themes-light-dusk-dark.md). It replaces ADR 0004's token bullet, which put Light in Phase 1 and Dark in Phase 2: **all three themes ship in Phase 1**.

**Architecture.**
- **Three layers in `tokens.ts`,** which holds the values in `docs/assets/brand/ui/tokens.json` (that file is the reference; a unit test pins them):
  - *Primitives:* palette ramps. Components never use them.
  - *Semantic tokens* (table below): the only names components may use.
  - A few *component tokens* that alias semantic ones (e.g. `switcher.selected`).
  - Each theme is one object with the same keys, and TypeScript checks that every theme defines every token.
- **DOM:**
  - A Vite plugin generates `themes.css` with one block per theme, e.g. `:root[data-theme="dusk"] { --ma-surface-tile: …; … }`.
  - Each block also sets `color-scheme` (light for Light; dark for Dusk and Dark), so native scrollbars and form controls match.
  - Components use only `var(--ma-…)`. Switching themes flips one attribute. Every app window, modal, menu, toast and the minified view follow it.
- **Konva:**
  - A Zustand `themeStore` holds `{pref, resolved, t, rev}`, where `t` is the resolved token object.
  - Konva components read colors, stroke widths and shadow specs through `useTheme(selector)` and pass them as node props. No Konva node has a literal color, so panels, tiles, widgets, badges, rings and the agent line all follow the theme.
  - Theme changes are rare, so every node may re-render once when one happens.
- **Re-caching on a theme change:**
  - The pre-rendered chrome cache (§3.10) keys each bitmap by `rev` + kind + size + scale bucket.
  - On a change, the store bumps `rev`. The visible buckets are rebuilt before the next draw and the rest at idle (`requestIdleCallback`).
  - Every node that used `node.cache()` is cached again, and the world layer is redrawn once.
- **Transition:**
  - The switch runs inside `document.startViewTransition()`, which snapshots the DOM and the canvas together and crossfades them over 200 ms.
  - The update callback redraws the canvas synchronously (`layer.draw()`) and must finish in ≤ 50 ms (B16).
  - Without View Transitions, or under reduced motion, the switch is instant.
  - There are no global CSS transitions, so nothing else animates during the switch.
- **Lint:** an ESLint rule rejects color literals (`#…`, `rgb(`, `hsl(`) outside `tokens.ts`, and a unit test rejects `#000000` and `#FFFFFF` anywhere in the Dusk set (`tokens.json` has neither).
- **What follows the theme:** the minified view (§7), widgets, window chrome, app UIs and provider marks.
  - Notebook highlight and tab colors are stored as names (`yellow`, `blue`, …) and mapped per theme, so notes read well in all three.
  - Images, video and the normal-mode stream are not themed.
  - The kiosk Chromium is told the theme's color scheme through Playwright `page.emulateMedia` (Light → `light`; Dusk and Dark → `dark`), so sites that have a dark mode use it. A per-desk Browser setting can pin sites to light or dark.
- **Provider marks** are drawn monochrome (`mark.fg` on `mark.disc`) in every theme. This keeps them legible and avoids brand colors clashing with mid-tone surfaces.

**Preference.**
- **Stored** in the layout doc (ADR 0005) as `prefs.theme = {mode: "system" | "light" | "dusk" | "dark", systemDark: "dark" | "dusk"}`.
- **Default** `{mode: "system", systemDark: "dark"}`: follow the OS between Light and Dark, with an option to use Dusk when the OS is dark.
- **Sync:** the choice persists and syncs across devices, and "System" is how a member gets different themes on different devices.
- **Where to change it:** the top bar's account menu, the command palette ("Theme: Dusk") and Settings.
- **No flash on load:**
  - The layout doc's localStorage mirror holds the preference.
  - A render-blocking `theme-boot.js` (≤ 1 KB, hashed, so the CSP needs no inline-script hash) sets `data-theme` before first paint.
  - On a device with no mirror, `@media (prefers-color-scheme)` rules pick Light or Dark. If the synced preference differs, the app crossfades once.
- **Installed app:** `<meta name="theme-color">` follows the theme, so the title bar matches.
- **Contrast modes:** under `forced-colors: active` (Windows contrast themes), the DOM uses system colors and the canvas reads them from a probe element into a fourth, generated token set (Phase 2).

**Semantic tokens.** The values for all three themes live in one place: [`docs/assets/brand/ui/tokens.json`](assets/brand/ui/tokens.json) ([ADR 0065](decisions/0065-apps-use-kit-colors-and-nunito.md)). This doc doesn't repeat them. What each token is for:
- **Surfaces:** `surface.world*` (the world's radial gradient, CSS), `panel`, `tile`, `window`, `overlay` (menus, popovers), `sunken` (inputs, code, hovered rows), `scrim` (behind full-mode windows), `fill` and `fillStrong`, `chrome`, `chip`.
- **Text:** `text.primary`, `secondary` (the etched name under `prefers-contrast: more`), `tertiary` (meta; never on the world background), `link`, `onAccent`, `disabled` (exempt from contrast rules).
- **Glyphs:** `glyph.default`, `soft`, `globe`, `page`.
- **Accent:** `accent.default` / `hover` / `pressed`, and `accent.subtle` (selection, active row).
- **Lines:** `border.hairline`, `border.default` (dividers), `border.strong` (input outlines, selected segment), `focus.ring` (2 px, 2 px offset), `ring.activeDesk` / `ring.activeGlow`.
- **State:** `badge.bg` / `badge.fg` (a dot uses `badge.bg`), `status.online` / `warn` / `error` / `offline`. Status and badge colors are the same as before the kit.
- **Marks and controls:** `mark.disc` / `mark.fg` (provider marks), `switcher.track` / `selected` / `text`.
- **Etch:** `etch.fill`, `etch.wall`, `etch.highlight` (the cut, below). `etch.top` and `etch.bottom` in the file are the old pair, kept only until the code drops them.
- **Elevation:** `elevation.tile`, `panel`, `panelActive`, `window`, `menu`, each a list of shadow layers in the file. Dusk's are flat: a tone step and a hairline for tiles, a small shadow plus a 1 px edge for windows.
- **Sign-in only:** `signin_only` in the file holds the extras the sign-in pages use.
- **Kit colors:** where a kit color passes AA it is used as is (graphite text, off-white character, near-black ground). Where it fails, the token moves within steel blue. Dusk is derived, since the kit has none, and keeps ADR 0050's neutral whites.

**What Dusk is.**
- **Surfaces** are a cool mid-tone slate. Light's are near white and Dark's near black (values in `tokens.json`).
- **Text** is neutral white, with no warm tint, and `text.primary` is at most #FAFAFA ([ADR 0050](decisions/0050-dusk-neutral-whites.md), kept by ADR 0065 over the kit's #E8EAED).
- **Elevation is flat:** tiles separate from panels by a small tone step and a hairline, not a shadow, and windows carry a 4 px shadow instead of a 64 px one.
- **No #000 or #FFF anywhere,** scrims included.
- **Softer contrast:** Dusk's text contrast range is narrower than Light's or Dark's. Every pair still meets WCAG AA.
- **Why not true mid-grey:** surfaces at L* ~50 were tried and rejected. On them, no text color reaches 4.5:1 with any hierarchy left; only near-black primary text passes, at about 4.5:1.

**Contrast.** WCAG 2.x: text needs 4.5:1; UI parts and graphics need 3:1. The ratio for every key pair in all three themes is in [`docs/assets/brand/ui/contrast.txt`](assets/brand/ui/contrast.txt), computed from `tokens.json`; it also lists the pairs under the bar ([ADR 0065](decisions/0065-apps-use-kit-colors-and-nunito.md): Google's border on Dusk's card is 2.39:1, to be judged on staging).

- **Tests:** a unit test computes every allowed text/surface pair from the theme tokens for all three themes and fails below the minimum. axe-core runs in the Playwright suite once per theme for the DOM.
- **Selected scope segment:** the mockup shows selection only as a fill change, about 1.2:1, which fails WCAG 1.4.11 for a state. In every theme the selected segment also gets a 1 px `border.strong` outline (3:1 minimum) and 600 weight.
- **Count badges in Dusk and Dark** use dark text on a lighter red. White text on a red that is also visible against a dark tile can't reach 4.5:1 with any margin.

**Other tokens (all themes).**
- **Radii:** panel 22, tile 18, widget 20, window 16; the switcher is a full pill.
- **Type (Nunito,** [ADR 0065](decisions/0065-apps-use-kit-colors-and-nunito.md)**):** self-hosted through a pinned `@fontsource-variable/nunito`, with no CDN. Details: `docs/assets/brand/ui/type.txt`.
  - Weights: 600 at 11 to 14 px, 700 for titles at those sizes, 500 at 24 px. Nunito at 400 or 500 reads thin at 1x.
  - Canvas text uses the same family and weights.
  - Sizes: home title 24/32; switcher 15/20; widget title 14/20; body and meta 13/18; badge 13 tabular.
  - Dusk and Dark use the same sizes and weights.
  - 4-pt spacing grid.
- **Etched desk name and icons** ([ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md), [ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)): the desk's name goes where a laptop's maker engraves its name, bottom center of the strip (§3.3). The bottom-right icons (§3.3) are etched the same way.
  - *Type:* capitals, Jost 600, tracking 0.16 em, 14 CSS px for the name and 16 CSS px for the icons at every zoom, with 28 px hit targets (44 on touch). The name is centered with its baseline 17 px up from the desk's bottom edge; the icons sit at the right. Names Jost can't draw fall back to Nunito.
  - *Depth:* a cut, not an outline: four steps, no blur, cached as one bitmap per string, theme and raster scale. (1) Draw the shape in `etch.highlight`, 1 px lower, on the panel: the cut's lit lower lip. (2) On a clear bitmap, draw the shape in `etch.wall`: the shaded upper wall. (3) With `source-atop`, draw the shape in `etch.fill`, 1 px lower, so only the top band of the wall stays visible. (4) Draw that bitmap on the panel. The 1 px is a CSS pixel at every scale. On Light's nearly white panel the highlight barely shows, so the wall carries the depth there.
  - *Legibility:* `etch.fill` clears 4.5:1 against the panel in every theme (`contrast.txt`), but 14 px is still small, so the name also stays in the proxy layer as the desk's accessible name. Under `prefers-contrast: more` it uses `text.secondary` with no edges.
  - *Constant size:* the name and icons don't scale with the camera. They hang from the desk's bottom edge in screen pixels, and only their position follows the camera. `controller.ts` counter-scales those nodes with no React render and snaps them to whole device pixels at rest, so the bevel stays crisp. `npm run perf` must still pass.
  - *No room:* nothing shrinks. (1) The icons hide if the desk is under 240 px wide or 72 px tall on screen, which clears the way for the name in the overview. (2) The name ellipsizes if it would come within 12 px of the status line, of any icons still showing or of the desk's edges, and hides only when fewer than four characters would fit. A strip shorter on screen than the text keeps the name at its baseline, running up onto the desk's surface; apps draw over the etch.
  - *No state changes:* it looks the same with or without focus.
  - *Rendering:* a cached bitmap as above, blitted into place, so there's no blur and no per-frame text.
- **Motion:**
  - 120 ms micro-interactions (hover lifts 1 px, press scales to 0.96).
  - 200 ms for badges, the segment slide and the theme crossfade.
  - 240 ms window open, 180 ms close; 320–480 ms camera.
  - Entrances `cubic-bezier(.2,0,0,1)`, exits `cubic-bezier(.3,0,1,1)`. Working pulse 2 s.
- **Glyphs:** Material Symbols Rounded, filled (Apache-2.0).
- **Provider marks:** Simple Icons SVGs, used nominatively under each provider's brand guidelines, with a text monogram fallback.
- **Self-hosting:** no font or icon CDNs and no third-party analytics.

### 3.13 Libraries, component tree, state
- **Libraries** (exact versions pinned; current lines checked on npm 2026-11-04): `react`/`react-dom` 19, `konva` 10 + `react-konva` 19, `zustand`, `@tanstack/react-query`, `@use-gesture/react`, Radix UI (ToggleGroup, DropdownMenu, ContextMenu, Dialog, Tooltip), `cmdk`, `react-rnd`, `@fontsource-variable/inter`.
- **Tooling:** Vite and TypeScript. Vitest covers packing, camera math and reducers; Playwright E2E tests go through the proxy layer.

```
<App> QueryClientProvider · PlatformSession
  <DeskLinks/>          non-visual; gateway watches + one PeerConnection per connected desk (§4.2.8) -> store
  <Shell>               100dvh, CSS background
    <TopBar>            Breadcrumb · ScopeSwitcher · ToolbarMenu (Privacy, Full screen, Account -> Platform)
    <WorldStage>        react-konva Stage
      <Layer world>     DeskPanel* -> DeskChrome · EtchedName · HiddenCount · CleanupButton · ItemTile|ItemWidget* (Badge, OpenDot) · AgentStatus
      <Layer overlay>   FocusRing · DragGhost
    <ProxyLayer/>       a11y + keyboard mirror of canvas nodes
    <WindowLayer>       AppWindow* (react-rnd) -> lazy app module
    <CommandPalette/> <ContextMenu/> <LiveRegion/> <Toasts/>
```

Each app registers `{id, glyph, sizes, Widget(size, vm, lod), Window (lazy DOM), defaultWindow, badgeDefault}`. Widgets are built from a shared react-konva kit (text row, thumbnail, provider mark), so app owners never touch canvas internals.

```ts
desks:   Record<DeskId, {name, kind:'personal'|'work'|'guild'|'custom', vm:'stopped'|'starting'|'running'|'stopping'|'error', phase?, stopReason?, lastBadges?}>
layout:  LayoutDoc & {etag, dirty}   // per desk {x,y,cols,rows,scope?,items:{app, size:'icon'|'small'|'wide'|'large'}[]}
live:    Record<DeskId, {link:'idle'|'signaling'|'connecting'|'open'|'resuming'|'retrying'|'denied', path?:'udp'|'tcp'|'relay', seq, agent, apps: Partial<Record<AppId,{badge?, widget?}>>}> // memory only
theme:   {pref, resolved:'light'|'dusk'|'dark', t, rev}   // themeStore, §3.12
view:    {scope, activeDesk, mode:'overview'|'desk'|'free', camera, kbFocus, cleanupUndo: null|{desk, positions, size}, privacyShield}
windows: Record<`${DeskId}:${AppId}`, {mode:'window'|'full', rect, z, parked}> & {active}
```

**Privacy shield.** Toolbar, `\`, or palette. While on: every widget renders icon-only (no text or snapshots), badges show dots only, and the window layer is blurred.

**Phase cut.**
- **Phase 1,** all on one live desk:
  - camera, focus and windows;
  - icon and small widgets, badges and the agent line;
  - moving and resizing, cleanup and layout sync;
  - the proxy layer;
  - all three themes (Light, Dusk, Dark; §3.12);
  - the waking, reconnecting and stopping states (§3.14);
  - the perf CI and dev overlay (§2.2);
  - desktop and tablet, plus basic phone paging.

  Cycling and scopes run against fixture desks in tests. The gateway WebSocket (desk state, wake progress, badges) ships in Phase 1.
- **Phase 2:**
  - scopes and cycling across real desks;
  - wide and large widgets;
  - custom-desk segments and New desk;
  - the Guild Desk appearing and disappearing with membership (§4.5.1);
  - the forced-colors token set;
  - Tidy up and alignment guides.

### 3.14 Waking, reconnecting and stopping
Under the 24-hour rule a daily desk rarely sleeps. A cold wake happens mostly after:
- a day or more away;
- a Give Back window;
- a resize or upgrade;
- a spend-cap or billing stop.

Most of the time, the "waking" a member sees is a running desk's session opening, which takes ≤ 1.5 s (B14). In every case the canvas never blocks. Decision: [ADR 0031](decisions/0031-waking-and-reconnecting-ux.md).

**States.** Platform's wake phases come from `desk.progress` on the gateway watch, or from `phase` in `GET /v1/desks`. Desk adds one step of its own, "Opening".

| Step | Source | Typical time (*pending Phase 0*) | Shown as |
|---|---|---|---|
| Asleep | `state: stopped` | — | Nothing shown (the strip shows only the name, §3.5); the last badge counts; tiles at full contrast |
| Waiting for capacity | `phase: queued`, `queue.position` | until `queue.expiresAt` (≤ 15 min) | "waiting for capacity · #3" |
| 1 Starting | `phase: starting` | ~10–20 s | "waking · 1 of 4" |
| 2 Booting | `phase: booting` (instance running, waiting for hello) | ~10–20 s | "waking · 2 of 4" |
| 3 Connecting | `phase: connecting` (hello received, waiting for the desk's gateway link) | ~1–3 s | "waking · 3 of 4" |
| 4 Opening | Desk: `connect` again for a fresh token, then `session.open`, signaling, ICE and DTLS, channels open, first summary | ≤ 1.5 s | "connecting…" |
| Ready | first summary applied | — | normal state; badges refresh |
| Failed | `phase: failed`, `error.code` | — | "couldn't wake" with Retry. A `capacity_timeout` is retried once automatically after 60 s |

**Progress.** Today the status line shows the step ("waking · 2 of 4"), and an open window shows the four steps in plain text. There is no time estimate. The panel's bar and the points below are the intent and are not built yet.
- **The bar:** a thin bar along the panel's bottom edge, and in any open window, with one segment per step.
- **Weights:** each segment is weighted by expected time, taken from this desk's last 5 wakes on this device (durations only, kept in localStorage), otherwise from the defaults above.
- **Movement:** inside a step the bar eases toward 90% of its segment, and it jumps to the next segment when the phase changes. It never runs backwards and never sits at 99%.
- **Time:** no estimate is shown. Elapsed time after 3 s, and a "taking longer than usual" note that names the current step, are planned and not built yet.
- **The click itself is answered in ≤ 100 ms (B17):** `connect` is called in the same tick, and the waking state shows before Platform replies.
- **Accessibility:**
  - The bar has `role="progressbar"` with text like "Booting, step 2 of 4".
  - The live region announces only "waking" and "ready".
  - Under reduced motion the pulse and the easing become plain steps.

**What the member can do meanwhile.**
- **Everything that doesn't need this desk:** other desks, scopes, the camera, moving and resizing (the layout doc is in Platform), settings and the theme.
- **Open any app on the waking desk.** Its window opens at once (B4's 16 ms) into a waking panel that shows the steps above, then fills in when the desk is ready.
- **Capture while waking:**
  - The member can start typing right away: a new Notebook note, a Chat message, an Agent prompt or a Browser address.
  - These drafts are held in memory only (ADR 0005), marked "saves when the desk is ready", and committed in order once it is. On a trusted device Notebook also opens cached pages and queues edits in `y-indexeddb` (§5.5).
  - Messages and agent prompts still need the member to press Send. Nothing goes out that the member didn't send.
  - Leaving the page before the desk is ready asks for confirmation.
- **Walk away:**
  - Closing the window or moving elsewhere doesn't stop the wake.
  - A quiet toast says "Work desk is ready", except when the wake came from the pre-warm on app open.
  - Once the desk is running, the desk menu's "Put to sleep" calls Platform `stop`.
- **What isn't available:** desk content can't be read while the desk wakes, because it lives only on the desk. The canvas shows only the last badge counts.

**Give Back windows** (Platform ADR 0034).
- Inside a scheduled downtime window the desk shows nothing extra: the "asleep · Give Back until 07:00" wording is hidden ([ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md)).
- Waking asks first: "Waking now reduces this window's Give Back." (`connect` with `overrideDowntime: true`).
- Ten minutes before a window starts, a connected member gets the `desk.downtime` notice with **Snooze 1 h** and **Skip this window**.

**Reconnecting.**
- **Resume:** a dropped connection to a running desk resumes by ICE restart, or by a new connection that resumes the desk session within 2 min (§4.2.7). A dropped gateway WebSocket resumes its sessions within Platform's 60 s hold and never interrupts the data path.
- **What shows:** blips under 1 s show nothing; after that, the status line and windows show "reconnecting…".
- **Local work continues:**
  - Notebook keeps editing; Yjs holds the edits in memory and syncs them on resume.
  - Minified pages keep scrolling and searching.
  - Composers keep their text.
- **Actions that need the desk** (minified clicks, sends) are disabled with a tooltip. They are never queued silently.
- **Normal mode** holds its last frame under a "reconnecting" scrim.
- **After 30 s:** "can't reach desk", with details (the ICE path and the last RTT).
- **Returning to a long-hidden tab** shows the in-memory state at once and reopens the connection behind it (B14).

**Stopping.**
- **Notice:** on `prepare_stop` (≥ 60 s ahead), the desk tells open clients the reason (`stopReason`) and the time. This and the flush below need desk sessions to stay open until `readyToStop` or `stopAt`. Contracts 0.2.0 close them within 5 s of `prepare_stop`, which would drop the countdown and can lose unsynced Notebook edits, so Desk asks Platform to keep them open and to push `desk.stopping {stopAt, reason}` to watching tabs (§13.2).
- **Toast:** e.g. "Work desk will sleep in 0:58 · Give Back window". It offers Snooze where the reason allows it (downtime) and the fix where there is one (spend cap → "Raise cap").
- **Before power-off:** apps flush their autosave and Chromium saves its session.
- **At power-off:** windows switch to the asleep panel with a **Wake** button, and capture-while-waking applies again.
- **Idle stops never interrupt a connected member:** under the 24-hour rule, a visible session keeps a desk awake (§10.5).

---

## 4. Desk daemon and app foundations

deskd is one Java 21 + Spring Boot process per desk VM, in Docker with host networking ([ADR 0040](decisions/0040-desk-services-spring-boot-docker.md), which supersedes ADR 0006; the owner's decision, 2026-11-05). Core desk services like deskd are Java 21 + Spring Boot; an app's own service, such as Notebook sync, may use the best tool (the owner, 2026-11-06, ADR 0040). It serves every app through modules: `notebook`, `chat`, `agent` (policy, tools, approvals, audit), `browser` (Playwright controller, distiller, snapshots, stream control), `blobs`, `search`, `events`, `collab`, `session` (token checks, sessions, the bridge to desk-rtc), `gateway` (the outbound WebSocket: signaling, pushes, badges), `platform` (SigV4 REST: hello, heartbeat, config, relay, key envelopes, usage) and `migrations`. deskd listens on no network port: clients reach it only through desk-rtc's data channels (§4.2). Nothing in this section stores user content in Platform.

### 4.1 Storage
- Everything lives on the encrypted data volume mounted at `/data` (§10.4), so image upgrades replace only the root volume.
- `/data/notebook/`: `notebook.db` and `readable/`, touched only by `desk-notebook` (uid `notebook`).
- `/data/desk/`: `chat.db`, `agent.db`, `settings.db`. SQLite in WAL mode via `sqlite-jdbc`, FTS5 where search is needed. One file per app gives isolation.
- `/data/desk/blobs/sha256/ab/cd/<hash>`: content-addressed, reference-counted per app.
- **IDs and ordering.** IDs are UUIDv7. Sibling order uses fractional-index strings, so a reorder rewrites one row.
- **Migrations.** deskd migrates `/data` at boot and refuses to start against a newer schema than it knows (§10.6).

### 4.2 Connectivity and the data path
The coordinator-approved **hybrid** contract (`~/ma-coord/system-eng.md`, "Contract: hybrid") applies: Platform's gateway carries control and signaling only, and everything else runs directly between the client and the desk over one WebRTC connection. Platform's contracts 0.2.0 (`gateway.md`, `auth.md` §4, `desk-endpoint.md`) fix the envelopes and message names; Desk owns the payload inside `signal` and everything on the data channels. Decisions: [ADR 0022](decisions/0022-desk-connectivity-hybrid-webrtc.md) (connectivity and auth), [ADR 0023](decisions/0023-desk-data-channel-protocol.md) (data-channel protocol).

| Path | Carries | Encryption | Plaintext visible to |
|---|---|---|---|
| Client ⇄ Platform API (`api.`) and gateway (`gw.`), HTTPS and WSS | Sign-in, desk list and state, `connect` (wake, desk tokens, the desk's DTLS fingerprints), wake progress, signaling, TURN credentials, badge counts; account data, the layout doc (ADR 0005), LLM key metadata | TLS to Platform | Platform: metadata only |
| Desk → gateway (one outbound WSS) | `ready`, session accept and reject, signaling, badge counts; pushes to the desk (`revoke`, `notify`) | TLS to Platform | Platform: metadata only |
| Desk → Platform API (SigV4 REST) | hello, heartbeat, config, LLM key envelopes, usage totals, sealed relay, guild roster | TLS to Platform | Platform: metadata and ciphertext |
| **Client ⇄ desk: one WebRTC connection** | Browser video and audio, input, minified page data and actions, Notebook, Chat and Agent data, uploads and downloads | **DTLS (data) and DTLS-SRTP (media), end to end**, also through TURN | The client and the desk only |
| Member Guild Desk ⇄ guild host: one WebRTC connection | Guild sync (§4.5.4) | DTLS, end to end | The two desks only |

The desk has **no inbound HTTPS**: no web server, no TLS certificate, no DNS name, no Let's Encrypt. Its security group admits only udp/443 and tcp/443, both terminated by desk-rtc's ICE (§4.2.10). deskd binds only Unix sockets.

#### 4.2.1 Gateway and signaling
- **Gateway shape (contract 0.3.3).** Platform runs it serverless on API Gateway WebSocket. Both sides use `wss://gw.…/v1`, read from config, and a desk is recognized by its `X-MA-Desk-Auth` header. Frames are at most 32 KB. Each side sends `{"type":"ping"}` at least every 5 min. Connections close with `1001` after 2 h; the side then reconnects and sends `ready` or `session.resume`, and live PeerConnections carry on. There's no TURN yet, so `iceServers` is empty.
- **Client link.** Each SPA tab keeps one gateway WSS, with no credentials at upgrade and a desk token in each desk-scoped message. `watch` brings `desk.state`, `desk.progress` (wake phases, §3.14), `desk.badges` and `desk.downtime` for a desk. Watches never keep a desk awake.
- **Desk link.** deskd keeps one outbound gateway WSS (§4.2.9).
- **Opening a session:**
  1. `POST /v1/desks/{id}/connect {start, clientDtlsFingerprint}` on `api.` wakes the desk if `start` is true and returns a desk token whose `cnf` is that fingerprint, plus `deskIdentity` (the desk's registered DTLS fingerprints). A session opens only with a `connect` response issued after `phase: ready`.
  2. `session.open {deskId, deskToken}`: the gateway checks the token and forwards it to the desk; deskd checks it (§4.2.2) and answers `session.accept` or `session.reject {code}`; the SPA gets `session.opened {sessionId, iceServers}`.
  3. `signal {sessionId, data}` carries Desk's payload both ways, relayed unread (the whole frame ≤ 32 KB): the client's offer, then the desk's answer or a refusal.
- **No client candidates.** desk-rtc is ICE-lite and learns the client's addresses from its connectivity checks (peer-reflexive), so the client sends its offer before gathering and never trickles candidates. Signaling never carries the client's local, public or relay addresses. The answer carries the desk's two host candidates: its public IPv4 on udp/443 and on tcp/443 (passive).
- **One negotiation.** Every offer pre-negotiates all eight data channels (§4.2.3) plus one `recvonly` video and one audio transceiver, so starting the Browser stream needs no signaling. Any later renegotiation runs in band on `ctl`; only ICE restarts go through `signal`.
- **Section order.** The client orders the offer audio, video, data. The first section carries the BUNDLE tag and rejecting it breaks the connection, so desk-rtc never rejects audio. It may reject video alone if there's no shared codec. From milestone 2 it answers audio and video `sendonly` with idle tracks, because a browser won't play an `inactive` section and starting video must not need a renegotiation; the walking skeleton answers `inactive`. Playwright's Chromium offers H.264 in its SDP, but decoding it there is untested.
- **Keeping it open.** Before `refreshAfter` (4 min) the client calls `connect` again with `start: false` (a refresh must never wake a stopped desk; the contract's default is `true`, §13.2) and sends `session.refresh` with the new token; if the gateway is unreachable, it sends `AUTH` on `ctl` instead (§4.2.2). After the client's gateway WebSocket reconnects, `session.resume` reattaches its sessions within Platform's 60 s hold; the PeerConnection is untouched. `session.close` ends a session from either side.
- The gateway logs neither SDP bodies nor tokens.

#### 4.2.2 Session setup and authentication
1. **Client certificate.** Each SPA tab generates one ECDSA P-256 `RTCCertificate` (private key non-extractable, 24 h), keeps it in memory and uses it for all its desk connections. Platform's `auth.md` suggests one persistent certificate per browser profile in IndexedDB; Desk keeps it per tab so nothing persists on shared machines (§4.3). Both fit `connect`.
2. **Token.** Platform gives a desk token only to an authorized caller (the owner, or a live support grant): ES256 with `typ=ma-desk+jwt` and a `kid` from Platform's JWKS; claims `iss`, `aud` (desk ID), `sub`, `scope`, `sid`, `jti`, `iat`, `nbf`, `exp` (`exp − iat = 300`), `auth_time`, `ma_owner`, `ma_kind`, `ma_name`, support-only `ma_support_until` and `ma_support_apps` (Desk ask, §4.2.12), and **`cnf: {x5t#S256: <thumbprint of the tab's DTLS certificate>}`**. With it come the desk's DTLS fingerprints, which deskd registered in its SigV4 hello.
3. **deskd checks the token** offline on every `session.open`, `session.refresh` and in-band `AUTH`, before desk-rtc allocates anything:

| # | Check |
|---|---|
| 1 | Header `alg=ES256`, `typ=ma-desk+jwt`, `kid` in the JWKS. deskd fetches the JWKS from `api.` over HTTPS, caches it 1 h, refetches at most once a minute on an unknown `kid`, and keeps known keys up to 24 h if `api.` is unreachable |
| 2 | Signature; `iss` = the environment's issuer |
| 3 | `aud` = IMDS tag `DeskId`; `ma_owner` = IMDS tag `UserId` |
| 4 | `nbf − 30 s ≤ now < exp + 30 s` and `exp − iat ≤ 300` |
| 5 | `scope` is `owner` or `support`; support needs `ma_support_until > now` |
| 6 | Not revoked (`sid`, user, `tokensValidAfter` from the gateway's `revoke` pushes and heartbeat responses); `jti` not seen before, so each new session needs its own token from `connect`. A token turned away from a full desk may retry, and a token from a wake's `connect` stays valid for `session.open` after `ready` if it hasn't been used and hasn't expired |
| 7 | When the offer arrives in `signal`: **every `a=fingerprint` line in the offer is SHA-256 and equals `cnf.x5t#S256`.** Chrome repeats the line in each section and Firefox writes one at session level. Compare the decoded bytes, because the token uses base64url and SDP uses colon-separated hex. On a refresh: `sub`, `sid`, `scope` and `cnf` equal the session's (after a step-up, see the step-up bullet below) |

   A failed token check → `session.reject` with `invalid_token` or `wrong_desk`; an offer with any other fingerprint → `session.close {reason: identity_mismatch}`. Nothing is allocated either way.
4. **Answer.** deskd asks desk-rtc for a session with the expected remote fingerprint, fresh ICE credentials and the session's permissions (video, input), which follow from `scope` and the support grant. desk-rtc answers with the desk's long-lived DTLS certificate (ECDSA P-256 on `/data/rtc`, rotated before it expires: hello reports `[current, next]` until clients have the new one, per `desk-endpoint.md` §2).
5. **The client checks** that every `a=fingerprint` line in the answer is one of `deskIdentity`'s fingerprints, otherwise it closes with `identity_mismatch`. WebRTC then enforces both fingerprints in the DTLS handshake.

The gateway only relays. An edited offer or answer fails the handshake, and a token is useless without the tab's DTLS private key, which never leaves the browser. A compromise of the gateway alone cannot read or inject desk traffic. A compromise that also controls Platform's token signing and the desk-fingerprint registry could stand in for a desk, just as a malicious SPA bundle could (§10.4).
- **In-session re-auth.** Every ~4 min the client refreshes the token (`session.refresh`, or `AUTH {deskToken}` on `ctl` while the gateway is unreachable); `sub`, `sid`, `scope` and `cnf` must match the session. Without a valid token by `exp + 30 s`, deskd closes the session (4401).
- **Step-up.** Revealing, deleting or assigning an LLM key needs `auth_time` within 1 hour (the owner: "1 hour sign in rule can replace the 5 minute one for something destructive like that"). Otherwise deskd returns `step_up_required`; the SPA re-authenticates (`prompt=login`), sends a fresh `AUTH` and retries. Contracts 0.2.0 give the step-up sign-in a new `sid`, which check 7 would reject (and with it every other tab's next refresh). Desk asks Platform to keep `sid` across step-up; failing that, deskd treats a token with the same `sub`, `scope` and `cnf` and a newer `auth_time` as the same session (§13.2).
- **Revocation.** The gateway pushes `revoke {revokedSessions, userIds, tokensValidAfter}` to the desk, and the heartbeat response carries the same fields as a backstop. deskd closes matching sessions at once (`CLOSE 4401`) and desk-rtc tears down their connections.
- **Platform outage.** Established sessions keep working, because the data path never touches Platform; a gateway outage shorter than a token's life is invisible. If both `api.` and `gw.` are unreachable, an `owner` session may run up to 30 min past `exp` (logged in the Activity log; a Desk ask, §13.2); support sessions never.
- Sessions live only in deskd and desk-rtc memory; none survives a desk stop.

#### 4.2.3 Data channels
All channels are created with `negotiated: true` and a fixed `id`, so both ends open them with no extra round trip.

| id | Label | Delivery | Direction | Carries |
|---|---|---|---|---|
| 0 | `ctl` | reliable, ordered | both | HELLO and resume, AUTH refresh, ACTIVITY reports, PING, CLOSE, in-band renegotiation |
| 1 | `rpc` | reliable, ordered | both | App API requests and responses, SUB and UNSUB, CANCEL |
| 2 | `events` | reliable, ordered | desk → client | Subscription events: canvas summary, app events, agent run streams, approvals, notices |
| 3 | `collab` | reliable, ordered | both | Notebook Yjs sync (Hocuspocus protocol, many pages on one virtual socket) |
| 4 | `mdoc` | reliable, ordered | both | Minified page state and patches, minified actions and their acks (content in §7) |
| 5 | `bulk` | reliable, ordered | both | Chunked transfers: attachments, uploads, downloads, snapshots, exports, image proxy |
| 6 | `input` | unordered, `maxRetransmits: 0` | client → desk | Normal-mode pointer motion: absolute position and sequence; newest wins |
| 7 | `keys` | reliable, ordered | both | Client to desk: normal-mode keys, buttons and wheel. Desk to client: the remote cursor's shape. Text insert is a deskd RPC, not an event here (`docs/interfaces/desk-runtime.md` §8) |

- **Media:** one H.264 video track and one Opus audio track, desk → client, bundled on the same transport. They carry RTP only while a Browser window is open and in normal mode, and visible or hidden for under 5 minutes. A tab hidden longer goes `warm`, unless the desk is playing sound: then both tracks keep flowing until a minute after it goes quiet ([ADR 0038](decisions/0038-sound-in-a-hidden-tab.md); `desk-runtime.md` §8.4).
- **Why two input channels.** The approved contract names "input (unreliable data channel)". Only pointer motion may be lost: the next move replaces it. A lost key-up would leave a key stuck, a lost key-down would drop a typed character, and a lost wheel delta would lose scroll distance, so keys, buttons and wheel are reliable, and each click carries its own coordinates. Without loss a reliable channel adds no latency. Scrolling a minified page is local to the client and sends nothing (§7).

#### 4.2.4 Framing
Every message on channels 0–5 is one or more frames of **at most 16 KiB**, the size every SCTP stack handles. Small frames also stop one big message from holding the association, since SCTP sends a message's fragments back to back.

| Bytes | Field |
|---|---|
| 0 | `ver` = 1 |
| 1 | `kind`, numbered from 1 in this order: HELLO, AUTH, ACTIVITY, PING, PONG, CLOSE, REQ, RES, ERR, SUB, UNSUB, EVT, CANCEL, DATA, CHUNK, CREDIT |
| 2 | `flags`: bit 0 MORE (the message continues in the next frame with the same `kind` and `id`), bit 1 BIN (raw bytes; otherwise UTF-8 JSON), bit 2 END (last chunk of a transfer) |
| 3 | reserved, 0 |
| 4–7 | `id`, u32 big-endian: request, subscription or transfer id, per session and direction |
| 8–11 | `seq`, u32: event sequence per subscription, chunk index per transfer, else 0 |
| 12– | payload |

- Reassembly is keyed by (`kind`, `id`), so a short response can overtake a long one on the same channel. Limits after reassembly: REQ and RES 1 MiB, EVT 64 KiB, DATA 4 MiB. Anything larger goes through `bulk`.
- JSON uses camelCase and RFC 3339 times. No compression in v1: compressing page text together with secrets would let a hostile page probe them through ciphertext length.
- `input` and `keys` use a fixed 16-byte binary layout without this header (`docs/interfaces/desk-runtime.md` §8.6).

#### 4.2.5 App APIs on channels
Design v1's REST routes and WebSocket streams become RPC methods and subscription topics. deskd's handlers stay the same; only the transport changes.
- **Requests.** `REQ {m, p, idem?, deadlineMs?}` → `RES {…}` or `ERR {code, message, details}`. Methods are named `<app>.<resource>.<verb>` (e.g. `notebook.page.get`, `chat.message.send`, `agent.run.start`). Every mutation carries an idempotency key (`idem`, UUIDv7); deskd keeps results 10 min, so a retry after a reconnect never applies twice. Optimistic concurrency uses `p.rowVersion` and fails with `precondition_failed`. `CANCEL` aborts a long request.
- **Error codes:** `bad_request`, `unauthorized`, `forbidden`, `step_up_required`, `not_found`, `precondition_failed`, `conflict`, `too_large`, `rate_limited`, `deadline_exceeded`, `cancelled`, `unavailable`, `internal`.
- **Subscriptions.** `SUB {topic, params, since?}` on `rpc` returns `{subId, seq}` and either replays events after `since` or starts with a `snapshot` event. Events then arrive on `events` as EVT frames with `id = subId` and a per-subscription `seq`. `UNSUB` ends one.

| Topic | Events |
|---|---|
| `summary` | Canvas badges and widgets (§3.9): `snapshot`, then `patch` at ≤ 2 Hz per desk |
| `notebook.tree`, `notebook.page.meta:<id>` | Structure changes, renames, trash |
| `chat.channels`, `chat.channel:<id>` | Messages, delivery status |
| `agent.conversation:<id>`, `agent.run:<id>` | Text deltas coalesced to ≤ 30 Hz, tool chips, approval cards, run state |
| `approvals`, `session.notices` | Pending approvals; support banners, revocation and stop notices |
| `browser.tabs` | Tab list, titles, minified or normal mode |

- **Notebook text** stays on Hocuspocus (ADR 0015). deskd's Hocuspocus server accepts a WebSocket-shaped adapter over `collab` (its `handleConnection` takes an externally created socket), and the client's `HocuspocusProviderWebsocket` takes a `WebSocketPolyfill` that wraps the channel. Phase 0 verifies this; the fallback is plain y-protocols sync over the same channel. The guild sync (§4.5.4) uses the same adapter.
- **Transfers** on `bulk`: `blobs.put {sha256, bytes, mime}` or `blobs.get {sha256 | token}` on `rpc` opens a transfer id. CHUNK frames (BIN) flow under the receiver's credit (`CREDIT {bytes}`, initial window 1 MiB); END closes the transfer and the receiver checks the SHA-256. An interrupted transfer resumes from the last credited offset, and content addressing (§4.1) makes uploads idempotent.

#### 4.2.6 Backpressure and priority
- **desk-rtc schedules the desk's sends** per session with strict priority: `ctl` > `keys` and `input` > `rpc` > `mdoc` > `events` > `collab` > `bulk`. It keeps SCTP's own send queue shallow (≤ 64 KiB per channel, refilled on buffered-amount-low), so a large download adds at most about 64 KiB of queueing ahead of a click's response. Media has its own congestion control (transport-wide CC); while video plays, `bulk` is capped at about 2 Mbps.
- **The client** writes the same way: per-channel writers wait for `bufferedamountlow` (threshold 32 KiB, high-water 64 KiB), and `input` frames are dropped, never queued, while that channel has anything buffered.
- **Slow consumers.** When a session's `events` backlog passes 1 MiB, deskd stops sending deltas for coalescible topics (`summary`, lists, trees) and sends one fresh `snapshot` once it drains. Streams that can't be coalesced (agent runs, chat) buffer up to 256 KiB per subscription and then get `resync`: the client resubscribes with `since` and replays from the desk's stored history, so nothing is lost.
- **Credits** bound transfers in both directions; phones and slow links get smaller windows. Total upload credit stays at or below 2 MiB per session, because SCTP's receive window is shared and more could stall the client's own `ctl`.
- **Limits per session:** 200 requests/s, 16 concurrent transfers, 64 subscriptions.

#### 4.2.7 Reconnect and resume
- **Hello.** Once SCTP is up, the client sends `HELLO {deskApi, appVersion, resume?}` on `ctl`; deskd answers `HELLO {deskApi, sessionId, resumeToken, serverTime, limits}`. A major `deskApi` mismatch closes with 4426 and the SPA reloads its bundle.
- **Liveness.** `ctl` PING every 10 s. Three missed pongs, or `connectionState = failed`, mark the link down. Browsers throttle timers in hidden tabs, so in a hidden tab missed pongs are soft and the client rechecks on focus. The desk never closes a session for missing client PINGs; it goes by ICE consent (`session.state`).
- **ICE restart first.** On `disconnected`, the client restarts ICE through `signal` (same PeerConnection). DTLS and SCTP survive it, so channels, subscriptions and transfers carry on untouched. Network changes (Wi-Fi to cellular, laptop sleep) take this path.
- **New connection** when the restart fails or the desk-side session is gone (desk-rtc or desk restart): backoff 0.5, 1, 2 … 30 s with ±20 % jitter, and an immediate retry on the browser's `online` event and on tab focus. The client opens a new session and sends `HELLO {resume: {sessionId, resumeToken}}`; deskd keeps a dropped session's subscriptions and request results for 2 min. In every case the client resubscribes with `since: seq` per topic, retries unanswered requests with their idempotency keys, resumes transfers from the last credited offset, and lets Yjs resync by state vector. Agent runs, Browser tabs and uploads already on the desk never depend on the connection.
- **Stop.** On `4503` or `desk_stopping` a link checks `connect {start: false}` at about 2 s, then every 3 s growing to at most 10 s, because a `deskd` restart looks the same as a stop. It rests only when `connect` or the gateway reports its desk `stopping` or `stopped`, never because a timer ran out, and a `ready` push ends any wait. A resting link comes back only through a fresh `connect`. This path never sends `start: true`, so it can't wake a desk. A recycled public IP is harmless: its next holder cannot present the desk's registered DTLS fingerprint.
- **Close codes** (`CLOSE {code, reason}` on `ctl`): 4401 token expired or revoked, 4403 forbidden or wrong desk, 4409 replaced by a newer session from the same tab, 4426 `deskApi` mismatch, 4429 rate limited, 4503 desk stopping. 4000–4399 are Desk-defined; 4002 means `deskd` is restarting, so retry at about 2 s, then on normal backoff.

#### 4.2.8 Several desks on the canvas
Every desk is its own VM, so there is one PeerConnection per (tab, desk).

| Desk on the canvas | Connection |
|---|---|
| Active desk with a Browser window visible in normal mode (or hidden for under 5 minutes, or longer while the desk plays sound, ADR 0038), or showing a live island (§7.4) | PeerConnection with media flowing |
| Running desks in scope, and desks with open or parked windows | Data only: the same PeerConnection with idle media tracks (no RTP); `summary` subscribed at widget level |
| Running desks out of scope | None. Badge counts come from the gateway (`desk.badges`) |
| Stopped or starting desks | None. State, last counts and wake progress come from the gateway |

- A tab holds at most 8 desk sessions (Platform's limit per gateway connection); beyond that, the least recently used data-only one closes. An idle connection costs only ICE consent checks (one small STUN exchange every ~5 s).
- A tab hidden for 60 min (while its desk plays sound, until within three minutes of the sound stopping, ADR 0038), or visible with no input for 24 h, closes its desk sessions and keeps only its watches, so a forgotten tab doesn't keep desks awake (§10.5). The desk then shows nothing once it stops (§3.5), and a click wakes it.
- Each tab and each device is its own session, at most 4 per desk (Platform's limit). deskd fans events out to all of a desk's sessions. The Browser stream is encoded once and its RTP sent to every session viewing it.

#### 4.2.9 Desk ↔ Platform: gateway link and heartbeat
- **Gateway link.** After each successful hello, deskd opens the outbound gateway WSS (§4.2.1) with a presigned `sts:GetCallerIdentity` made with the desk role, and sends `ready {bootId, runtimeVersion, deskApi, sessions}`. It reconnects with backoff (1–30 s, jittered), including after the 2 h close, and keeps live PeerConnections meanwhile. Clients may open sessions once the desk is `ready` (hello succeeded and this link is up).
- **Over the link.** From Platform: `session.open`, `signal`, `session.refresh`, `session.close`, `revoke`, and `notify` with the topics `config`, `keys` (`dropKeyIds`), `guild` (membership, role or host changes, §4.5), `support` and `heartbeat` (send one now, e.g. for `prepare_stop`). From the desk: `session.accept`, `session.reject`, `signal`, and `badges {total, apps}` at most every 5 s, which the gateway relays to clients. Desk asks one more topic, `inbox` (sealed relay mail waiting, §8.5).
- **Heartbeat** every 60 s, and on change (at least 15 s apart). The approved contract lists heartbeats among the gateway's duties; Platform's `agent.md` carries them as SigV4 `POST /v1/agent/heartbeat`, and the fields are the same either way. What counts as activity, and for how long, is §10.5.

| Field (approved contract; Platform's `agent.md` name) | Meaning |
|---|---|
| `boot_id`, `seq`, `sent_at` | `seq` is monotonic per boot |
| `client_connected` (`clients.connected` > 0) | At least one authenticated desk session has an open `ctl` (clients close the sessions of tabs hidden for 60 min, §4.2.8). A cross-check for the gateway's session count |
| `last_user_input_at` (`clients.lastInputAt`) | Latest real human input on this desk from any session. It includes input the client handles locally (scrolling a minified page), which the client reports on `ctl` as `ACTIVITY {lastInputAt}`, at most once a minute while input continues |
| `agent_tasks_running` (`agent.activeTasks`) | Agent tasks executing now, including unattended runs |
| `agent_last_activity_at` (`agent.lastActivityAt`) | Last finished step, LLM call or tool call of a running task: the sweeper's stall guard |
| `guild_activity_at` (Desk ask) | Guild hosts only: the latest member input in guild spaces, forwarded by member Guild Desks, or a running guild agent (§4.5.4) |
| `sessions`, `transports` | Open desk sessions, and how many use `udp`, `tcp` or `relay` (feeds TURN sizing) |
| `agent_status`, `badges`, `health` | Status line; counts only; `ok`, `degraded` or `failing`, with checks for `rtc`, `chromium`, `agent` and `data_volume` |
| `ready_to_stop`, `final` | Graceful stop |

- **Heartbeat response:** `prepare_stop` with `stopAt` and `stopReason`, `keysVersion` and `dropKeyIds`, revocations, `supportSession`, `limitsRemaining` (§9.9), `configVersion`. The pushes above are fast paths; the response stays authoritative.

#### 4.2.10 desk-rtc
- A Go service on Pion v4 that replaces Neko v3. It's modeled on Neko's WebRTC manager, capture hand-off and input injection, and shares no code with it; it has none of Neko's HTTP and WebSocket API, member system or own signaling. It runs from boot as user `rtc` with `CAP_NET_BIND_SERVICE` only.
- **ICE-lite** on one UDP socket (443, all sessions multiplexed) and one passive ICE-TCP listener (443), with the instance's public IPv4 from IMDS as its 1:1 NAT address. It answers STUN only for ICE usernames of sessions deskd created, with MESSAGE-INTEGRITY checked, so a port scan or an unsignaled peer gets no reply. nftables rate-limits new sources per address.
- It bridges channels 0–5 to deskd over a Unix socket (`/run/desk/rtc.sock`, accessible only to `desk`) using the same frames. It injects `input` and `keys` itself (XTEST into `:99`), only for sessions deskd has granted input. It attaches the H.264 and Opus RTP that `desk-stream` produces locally to the tracks of the sessions viewing the Browser.
- For guild sync it is also the full-ICE, offering peer of a member Guild Desk, and on a host it bridges `guild_member` sessions to `desk-guildhost` (§4.2.15).
- It holds no tokens and no desk data. deskd decides every session and permission.

#### 4.2.11 TURN fallback
- ICE tries every path at once and keeps the best: **udp/443 direct, then ICE-TCP tcp/443 direct, then TURN over TLS/443** (`turns:turn.…:443`, Platform's coturn).
- TURN credentials are per session and short-lived (1 h), issued in `session.opened` and renewed in `session.refreshed`; the client restarts ICE on relayed connections before they expire. coturn relays only DTLS and SRTP ciphertext, only to running desks' public IPv4s on UDP 443, at ≤ 20 Mbit/s per allocation, enough for a 60 fps stream. The desk never uses TURN.
- Relayed sessions work the same, but they run over TCP, so video can stutter under packet loss, and they cost Platform $0.09/GB. The Browser window shows a small "relayed" note, and the heartbeat reports the path type (`udp`, `tcp` or `relay`, nothing else) so Platform can size TURN.
- Design v1's compat mode (CDP screencast over a desk WebSocket) is dropped: TURN covers the networks it was for.

#### 4.2.12 Support sessions
A `scope=support` token (Platform ADR 0009) opens an ordinary desk session while the member's grant is live. deskd enforces least privilege:
- By default: desk health, diagnostics logs (which never contain content) and settings.
- Notebook, Chat, Agent, the Browser stream and input, and approvals only for the apps the grant names (`ma_support_apps`, a Desk ask).
- Never: revealing, adding, rotating or deleting LLM keys, or any other step-up action.
- The member is told live: a banner in every Desk app session they have open (`session.notices`), plus Activity log entries for the session and each app it opens. The support user sees a "Support session" banner on every window.

#### 4.2.13 Untrusted bytes in the app origin
There is no desk origin any more, so desk bytes arrive in `app.`, the origin that holds the member's Platform session:
- Attachments, Browser downloads and anything else deskd did not generate reach the client only as `application/octet-stream` Blobs saved through `<a download>`. They are never rendered, navigated to or given a `blob:` URL with an active type.
- Inline previews are only deskd-generated WebP (the minified image proxy re-encodes to WebP too), decoded with `createImageBitmap` or shown in `<img>`.
- Inbound email HTML (Phase 4) renders in a sandboxed `srcdoc` iframe without `allow-same-origin` or scripts, with remote images blocked.
- CSP on `app.`: `connect-src` only Platform's API, auth and gateway; `img-src 'self' blob: data:`; `object-src 'none'`; `frame-src 'self'`. CSP does not govern WebRTC, so only the DeskLink module creates PeerConnections, with ICE servers from the gateway.

#### 4.2.14 Exposure and versions
- **Internet exposure:** udp/443 and tcp/443, ICE only. Desks have no hostnames, so nothing about them appears in Certificate Transparency logs. Another desk can reach these ports but cannot open a session without a Platform-signed token bound to its own certificate.
- **API version.** deskd reports `deskApi` (this protocol, from 1.0) in hello, in the gateway `ready` and in HELLO. Each web-app release declares the range it supports (`deskApiRange`), and Platform's release pipeline enforces it.
- **Local development.** deskd and desk-rtc run on a dev machine with a dev signaling shim and a dev JWKS. `deskctl`, a small Pion-based CLI, speaks the protocol for tests and debugging, since there is no HTTP surface to curl.

#### 4.2.15 Desk-to-desk sessions (guild sync)
A member's Guild Desk keeps one WebRTC connection to its guild's host (§4.5.4), built from the same parts:
- The member's desk-rtc is the full-ICE, offering side (its egress to udp/443 is allowed); the host is ICE-lite as always. Desks have public IPs, so no TURN is needed.
- **Token:** a Platform-signed `guild_access` token (ES256, same JWKS, `exp − iat ≤ 300`): `aud` = host deskId, `sub` = the member's guild-scoped `memberId`, `ma_desk` = the member's Guild Desk, `gid`, `grole`, `scope=guild_member`, and `cnf` = the member desk's DTLS fingerprint. The member's deskd gets it with SigV4 after Platform checks the roster, together with the host's registered DTLS fingerprints, and refreshes it in band.
- **Signaling** runs over both desks' gateway links. The SDPs are also signed with both desks' Ed25519 identity keys (§8.5), so neither the gateway nor the fingerprint registry alone can insert itself.
- **On the host,** desk-rtc bridges a `guild_member` session's channels to `desk-guildhost` (§4.5.2), never to deskd's own apps, and `desk-guildhost` enforces what that member may read or write.
- **Channels:** `guild.ctl`, `guild.ydoc`, `guild.log`, `guild.blob` and `guild.rpc` (§4.5.4), with the framing of §4.2.4.
- A host accepts up to 25 member-desk sessions plus its standbys; Platform's 4-sessions-per-desk limit is for client sessions only (§13.1 #26).

### 4.3 Client cache policy
By default nothing desk-related persists in the browser: the vision says "no matter what machine", which includes borrowed machines. A per-device **"Trust this device"** toggle (Phase 2) enables IndexedDB: Notebook tree metadata, recent pages via `y-indexeddb`, and recent chat pages. The cache is wiped on sign-out and when the session is revoked. The layout doc (metadata) is the one exception and is always mirrored in localStorage ([ADR 0005](decisions/0005-client-state-and-storage.md)).

### 4.4 Widgets
Konva icon and widget sizes render from cheap summary view-models built by deskd for the summary channel (§3.9). Widgets are read-only in v1.

### 4.5 Guilds: Guild Desk lifecycle, guild host and member sync (Phase 2)

> **Current design (2026-11-07):** guilds are now one shared Guild Desk on its own server, up to 200 members, up to 3 guilds a member. See [ADR 0080](decisions/0080-guild-shared-desk.md). The text below is the earlier design (ADRs 0024 and 0025, superseded), kept for history.
The owner (2026-11-04): "If a member is not part of a guild, they obviously don't need a guild desk and we don't need to charge them for one. But if they are in a guild, their guild desk is mandatory." And: "An officer will have a strong guild desk since their guild desk(s) is essentially the host for their guild. Each member's guild desk can be smaller than their personal or work desks."

- **Sources of truth.** Platform's desk list and guild roster decide who is in a guild, each member's role and which desk hosts the guild. Members join by paying (self-serve); the owner approves only Founders; both are Platform's concern. The host decides guild content and who may open each space. Decisions: [ADR 0024](decisions/0024-guild-host-and-member-sync.md) (host and sync) and [ADR 0025](decisions/0025-guild-desk-sizing.md) (sizing). Instance sizes are **pending the benchmark** (ADR 0025).
- **Shape.** The guild leader's Guild Desk is the **guild host**: it holds the guild's shared spaces and guild agents in a separate service. Every other member's Guild Desk is lighter and keeps a replica of what that member may see, synced with the host. Members' clients connect only to their own desks.

#### 4.5.1 Lifecycle tied to membership
| Platform event (Guild Desk push on the gateway) | Desk app | Guild Desk |
|---|---|---|
| Not in a guild | No Guild panel, no Guild scope segment | None; not billed |
| Joins or creates a guild | The panel appears in its remembered layout slot (or the next free one) as "Setting up your Guild Desk" with progress; the Guild segment appears | Provisioned at its class: member class for members, host class for the leader, standby class for guild Officers (ADR 0025). A retained desk is restored instead |
| While in the guild | The panel can be moved and resized and its apps changed (no app is mandatory), but it has no Remove or Destroy action | Mandatory: Platform refuses destroy (`403 guild_desk_required`). Same 24-hour rule as any desk (§10.5) |
| Role change (member ↔ guild Officer, leadership transfer) | "Updating your Guild Desk for your new role" | Resized to the new class at a graceful stop (~1–2 min); host handover per §4.5.6 |
| Leaves, is removed, or the guild is archived | "You left ‹guild›. Your Guild Desk is kept for 30 days." for this session, then the panel and segment leave the canvas. Account lists the retained desk with Export (the member's own Guild-desk data only) | The host drops the member's session at once. The guild replica is purged at once on a running desk. A desk that was stopped goes straight to `retaining` with the replica on its volume, so **deskd purges `/data/guild` on any boot where config `guild` is `null`, export mode included, before it accepts any session**, and a member's export never contains guild data. The one exception is an archived guild's host data on the leader's own desk, kept for the leader's export (§4.5.6); deskd knows it from its own host role and the last guild push (`archived`). Desk also asks Platform to start a stopped Guild Desk briefly on removal so the purge lands before the retention snapshot (§13.2). Platform retains the desk 30 days (Platform N12) |
| Rejoins within 30 days | The panel returns to the same slot | Restored under the same `deskId`; a replica from another guild is purged at boot, before any session, when config `guild` names a different guild |

- A Founder-tier account with no guild has no Guild Desk. A Founder who is only a plain member of someone else's guild gets the member class.
- v1 allows one guild per member (Platform N13). If the owner later lets a Founder lead several guilds ("guild desk(s)"), one host desk serves them all, one data directory per guild, sized by total members.

#### 4.5.2 What the host holds
`desk-guildhost` is its own systemd service (Unix user `guild`; data under `/data/guild/<guildId>/`: `guild.db`, Y.Doc store, blobs). It runs only on host and standby desks. The leader's own Guild-desk data stays in deskd's `/data/desk/`, so members' connections never reach it.
- **Spaces**, each with an access list, holding:
  - **Shared notebooks:** notebooks → tabs → pages as in §5; page bodies are Y.Docs (co-edited); page history and the Temporal view live on the host.
  - **Guild channels:** append-only logs ordered by `(epoch, seq)` assigned by the host; each message signed by its author desk's Ed25519 key (§8.6).
  - **Files:** content-addressed blobs, 25 MB per file, guild quota by host tier (ADR 0025).
  - **Guild agents:** agents that belong to the guild. They run in the host's desk-agent with guild-space tools only (read, search, draft, edit within the invoking member's access, post to channels); no browser or other egress tools in v1; destructive actions need the invoking member's approval. They use an LLM key the leader assigns to the guild, with a guild monthly cap and per-member daily run caps (Q13). Keys are never shared and the provider badge always shows. Members start runs from their own Guild Desk; member agents can't call guild agents (no cross-member A2A in v1, §9.11).
- **Not on the host:** members' private Guild-desk notes, anyone's LLM keys except the leader's, and any shared Browser.

#### 4.5.3 Roles and access
| Platform guild role | On the host |
|---|---|
| Founder (lead) | Everything: spaces and access lists, guild agents and their key, guild settings, export, host handover |
| Officer (Officer or Founder tier) | Spaces, access lists and moderation; guild agents except the key; standby host |
| member | Read or write the spaces their access list grants; post in channels; run guild agents within daily caps; add files within quota |

- **Space access lists** live only on the host; Platform never sees them. Entries are viewers, editors and managers, by role or by member. The default space, General, lets every member edit. The leader and guild Officers can open every space because they host it, and the guild UI says so (Q14).
- **Auth.** A member's Guild Desk presents a Platform `guild_access` token (§4.2.15): `aud` = host deskId, `sub` = guild-scoped `memberId`, `gid`, `grole`, `cnf`, `exp` ≤ 5 min, refreshed over the open session. A membership or role change reaches the host as a push, and the host drops or downgrades that session at once.
- Member agents on a member's Guild Desk act on the replica with the member's role and the member's own key. Their writes carry `author_kind = agent` and the provider badge. Guild content is untrusted input (taint **U**, §9.7) for every agent.

#### 4.5.4 Member Guild Desk and sync
- **Path.** A member's clients connect only to their own Guild Desk. That desk keeps one desk-to-desk WebRTC connection to the host (§4.2.15): DTLS end to end, signaled through the gateway, with SDPs signed by both desks' Ed25519 identity keys. Host load therefore scales with member desks, not member devices. The host never sees members' client IPs, and the extra hop stays inside us-east-1 (~1–2 ms).
- **Protocol** (reliable, ordered data channels on that connection, framed as in §4.2.4):
  - `guild.ctl`: hello (token, protocol version, replica state vectors), role and access-list snapshot, subscriptions, acks.
  - `guild.ydoc`: y-protocols sync and awareness in Hocuspocus's message format ([ADR 0015](decisions/0015-notebook-editor-tiptap-yjs.md)), multiplexed by document name, through the same data-channel adapter that carries Notebook between client and desk (§4.2.5). Each space's structure (notebooks, tabs, page order, channel and folder lists) is one Y.Doc, so structure merges like text.
  - `guild.log`: channel-log replication by `(epoch, seq)` cursor.
  - `guild.blob`: chunked, resumable, SHA-256-verified files.
  - `guild.rpc`: history, archive search, guild agent runs and their streams.
- **What the member's desk keeps:**

| Data | Kept on the member's Guild Desk | Fetched live from the host |
|---|---|---|
| Space index (spaces, notebooks, tabs, pages, channels, folders, the member's access view) | Full replica | — |
| Page bodies | Every page the member can read | — |
| Page history and Temporal view | Last 7 days of activity | Older versions, "as of day X", restore |
| Channel messages | Last 90 days, plus pins and mentions | Older history; full backfill on joining |
| Files | Metadata and previews; pinned and recently opened originals (LRU, 2 GB) | Other originals, on open |
| Guild agent runs | Results the agent posts to pages or channels | Live run streams and run history |
| Presence and cursors | — | Live only; never stored |
| Search | FTS5 over the replica | Archive search on the host |

- **Writes.** Yjs updates go up as they are made, and the host applies them only where the member's access allows (Hocuspocus per-document read-only). The UI disables editing where the member can't write. If a role changed while the member was offline and the host rejects queued edits, the member's desk saves its version as an "Unsynced copy" in the member's own notes and reloads the page from the host. Chat sends carry a UUIDv7 and show as pending until the host assigns a `seq`.
- **Host asleep, waking or resizing.** The member's desk serves reads from the replica and queues writes, with the banner "Guild host is asleep. Your changes will sync." A member's write, or opening something not in the replica, requests a wake of the host (any member may; at most once per 10 min per member). Under the 24-hour rule an active guild's host rarely stops.
- **Activity.** Replication never keeps either desk awake. Member desks forward the time of the member's last input in guild spaces (at most once a minute), and the host reports it as `guild_activity_at` (§4.2.9, §10.5).

#### 4.5.5 Concurrency
- Host sessions are the member Guild Desks (≤ 25 in v1), standbys and the leader's own clients.
- Guild agent runs queue with per-member fairness at the tier's concurrency C. File transfers share a token bucket (default 20 MB/s). `desk-guildhost` and guild agents run at a lower CPU weight than the leader's Browser and windows, so guild load never makes the leader's desk sluggish.
- Host sizes by member count are in ADR 0025, pending the benchmark and the host load gate.

#### 4.5.6 Handover, failover and backup
- **Active host** = Platform's `hostDeskId` for the guild (default: the leader's Guild Desk). **Standbys** = guild Officers' Guild Desks, which replicate everything (history, access lists, files) as role `standby`.
- **Planned handover** (leadership transfer, resize): Platform promotes the new host, waits for its `host_ready` (replica caught up), switches `hostDeskId`, then retires or retains the old one. Member desks reconnect, Yjs state vectors converge, and the channel `epoch` goes up by one.
- **Host lost.** Platform alerts the leader and guild Officers when the host misses heartbeats for 10 min while members are active. In v1 any guild Officer can choose "Make my desk the host"; automatic failover comes later. A split brain is safe: documents merge (Yjs), and messages dedupe by id and order by `(epoch, seq)`.
- **Backups.** Host data volumes get snapshots every 6 h (keep 4) on top of the daily keep-7. After a restore, member replicas push back every document update and signed message the restored host lacks, so documents lose nothing any member's desk had seen; files come back only if some desk cached them. A guild with no Officers has no standby, so the leader can also export the whole guild.
- **Guild archived:** its data stays in the leader's retained Guild Desk snapshot for 30 days, exportable by the leader. Members' replicas are purged.

#### 4.5.7 Privacy
- Platform sees the roster, roles, host assignment, which member desk syncs with the host and when, and byte counts. It never sees guild content, space names or item titles.
- Guild data rests only on the host, standbys and members' replicas, on encrypted EBS, under the same operator-blind-and-audited posture as any desk (§10.4).
- Members' Personal, Work and private Guild-desk data never reaches the host. The leader's private Guild-desk data never reaches members (separate service, Unix user and data directory).
- The guild UI says plainly: the leader's desk stores the guild's data; the leader and guild Officers can open every space; on leaving or removal the replica is purged before any later session or export (§4.5.1), but copies a member already made elsewhere can't be recalled. Older daily snapshots hold the replica until they expire; any restore or export of them boots through the same purge.
- This replaces design v1's read-only per-item shares, whose snapshots Platform held in S3 with SSE-S3 (readable by MA) and whose titles Platform saw. Former Q7 is resolved.

---

## 5. Notebook

Apple Notes-like, with a **Tab view** and a **Temporal view**. Decisions: [ADR 0015](decisions/0015-notebook-editor-tiptap-yjs.md).

### 5.1 Editor
**TipTap 3 (ProseMirror), MIT-licensed packages only, no Tiptap Cloud.**
- The Apple Notes feature set comes as ready extensions: Title, Heading, Subheading and Body styles; bold, italic, underline, strikethrough, highlight; bulleted, numbered and dashed lists; nested `TaskList`/`TaskItem` checklists; quote, monospaced code block, link, horizontal rule, image; Markdown input rules such as `- [ ]` and `#`.
- First-class Yjs binding (`@tiptap/extension-collaboration`) and an MIT collab server (Hocuspocus).
- The same schema runs headless in deskd, so agent tools edit the real document model.
- A page's title is its first line, as in Apple Notes. Tables are Phase 4.
- Lexical was rejected: still 0.x with API churn, a thinner collab and server-side ecosystem, fewer ready extensions.

### 5.2 Tab view (notebooks → tabs → pages)
The data model is a strict hierarchy: notebooks contain an ordered list of tabs, and each tab holds an ordered list of pages. The UI is a binder with colored tabs on the edge, and you can page through continuously across tab boundaries. (The owner to confirm this reading of "add tabs to specific pages": Q5.)
- **"Add tab at this page"** inserts a new tab starting at page P and moves P and the pages after it, up to the next tab, into the new tab.
- Pages can be dragged between tabs and pinned. Deleted items go to Trash for 30 days.

### 5.3 Temporal view and edit history
1. **Activity (Temporal view).** `page_activity` has one row per (page, local day): created flag, first and last edit time, edit count, characters added and removed, and actors (user or agent id).
   - Days are bucketed in the desk's IANA timezone (a desk setting, seeded from the browser); UTC timestamps are kept too.
   - The UI has a month calendar with an activity heat-dot per day. Picking a day lists **Created** and **Edited** pages with time ranges and snippets. ←/→ jumps to the previous or next active day. Search can be scoped to a date range.
2. **Versions (restorable).** A zstd-compressed snapshot of the page's ProseMirror JSON is written:
   - at the end of an *editing session* (5 minutes idle, window close or page switch);
   - every 30 minutes during continuous editing;
   - at local midnight if a session spans it;
   - **immediately before every agent edit**.

   Every version is kept for 30 days; after that, only the last version of each day is kept until the user deletes it (about 3 KB per page-day, about 20 MB per year for a heavy user). "View as of this day" opens the day-end version read-only, with *Restore*. Restore is non-destructive: it is a new edit with its own snapshot. In-session undo is the editor's Yjs `UndoManager`; history does not come from Yjs, and the Yjs doc runs with `gc: true`.

### 5.4 Storage (`notebook.db`)

| Table | Key columns |
|---|---|
| `notebooks` | id, title, color, sort_key, created_at, updated_at, deleted_at, row_version |
| `tabs` | id, notebook_id, title, color, sort_key, …, row_version |
| `pages` | id, tab_id, sort_key, title, pinned, created_at/by, updated_at/by, deleted_at, `ydoc` BLOB, `pm_json`, `plain_text`, word_count |
| `page_versions` | id, page_id, created_at, reason (`session`/`interval`/`day_end`/`pre_agent`/`restore`/`manual`), actor, `pm_json_zstd` |
| `page_activity` | (page_id, day) PK, created, first_at, last_at, edits, added, removed, actors |
| `attachments` | id, page_id, sha256, mime, filename, bytes, width, height, created_at |
| `pages_fts` | FTS5(title, body, attachment_names); tokenizer `unicode61 remove_diacritics 2`; `prefix='2 3'` |

Hocuspocus `onStoreDocument` runs with a 2 s debounce and a 10 s maximum. Each store writes the `ydoc` state, derives `pm_json` and `plain_text`, and upserts FTS and `page_activity` in the same transaction.

### 5.5 Sync and conflicts
- **Page text** is a Yjs CRDT, synced over the `collab` data channel (§4.2.5); deskd is the authority. Tabs, devices and the agent merge character by character with no conflict dialogs. On a trusted device, edits made while a stopped desk wakes are queued in `y-indexeddb` and merge on connect. Otherwise they are held in memory, and `beforeunload` warns before closing the tab.
- **Structure** (rename, move, reorder, tab split, delete) uses RPC with `rowVersion`. On `precondition_failed` the client refetches and reapplies if still valid (field-level last-writer-wins). Every change is published on the `notebook.tree` topic (§4.2.5).
- **Editing a trashed page** keeps the edit and shows an "In Trash, Restore?" banner.

### 5.6 Search, images, export
- **Search:** FTS5 bm25, title weighted ×5, `snippet()` highlights. Filters: notebook, tab, date range, `has:checklist`, `has:attachment`; Trash excluded unless toggled. Ctrl/Cmd+K inside the window. Later: search inside past versions, PDF text extraction.
- **Images and attachments:** paste, drag-drop or pick. The client uploads with `blobs.put` over the `bulk` channel (deduplicated by SHA-256) *before* inserting a node that references `attachmentId`; base64 is never stored in the document. 25 MB per file. deskd makes a 1600 px WebP preview with libvips (`sharp`) and keeps the original; the editor shows only that preview (SVG included), and originals are sent as downloads under the untrusted-bytes rule (§4.2.13). Non-images render as a file chip with download. Orphaned blobs are garbage-collected after 30 days.
- **Export:** a page to Markdown with assets, self-contained HTML, or PDF via print (Phase 1). A notebook or all notebooks as a ZIP streamed by deskd over `bulk`, with `<notebook>/<tab>/<page>.md`, `assets/`, `manifest.json` and optional `history/` (Phase 2). Markdown/ZIP import Phase 4; Apple Notes import later.

Agent tools for Notebook are listed in §9.6.

---

## 6. Browser: real browser and streaming

Each desk runs a real Chromium on its VM, as the vision requires. **Normal mode** streams its pixels; **minified mode** (§7) renders the page's structure instead. Decisions: [ADR 0008](decisions/0008-browser-streaming-webrtc-neko.md), [ADR 0009](decisions/0009-browser-process-model.md).

### 6.1 Process model
- `desk-browser.service` (user `kiosk`) runs Debian's Chromium: `--kiosk --user-data-dir=/data/browser/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222`, **sandbox on**, disk cache capped at 1 GB. Managed policies: no microphone or camera, downloads go to `/data/browser/downloads`, and MA's own hosts (`app.`, `api.`, `auth.`, `gw.`) are blocked.
- It is launched as a normal process, not by Playwright, so it does not flag itself as automated (`navigator.webdriver`). deskd attaches with Playwright `connectOverCDP`; nftables lets only uid `desk` reach port 9222. Restarting deskd never kills tabs.
- The browser stack (Xorg dummy driver on `:99`, PulseAudio null sink, Chromium) starts on the first Browser use after boot and then **stays running on primaries**. With no Browser window open, deskd stops capture and encode, and after 60 s with nobody viewing the Browser and nothing working it, freezes all of Chromium with the kernel's cgroup freezer through `desk-units` ([ADR 0045](decisions/0045-unseen-desks-freeze.md), which replaces CDP page lifecycle `frozen`; `desk-runtime.md` §8.3), so reopening the Browser thaws live tabs within B4 (a thaw to the first page frame is about 0.1 s) instead of cold-starting Chromium (3–5 s, tabs reloaded, scroll and in-page state lost). Under memory pressure Chromium's tab discarding drops background tabs, which reload when shown. Desks are planned always-on (§11), so the ~1.5 GB a stop would free isn't worth a cold open.
- **Cold open** still happens after a desk wake or a Chromium crash. deskd keeps each tab's last snapshot (and, from Phase 3, its last MDoc) on `/data/browser`, so the window paints them at once under a "restoring" state (B18), and live tabs replace them when session restore finishes.
- **Session restore.** Chromium runs with the `RestoreOnStartup` policy set to restore the last session and is always stopped gracefully, so open tabs and session-only cookies come back after a desk stop or a Chromium restart; only in-page state such as unsent form text is lost. Phase 0 verifies that Debian's Chromium restores session cookies this way. This, not hibernation, is how tabs survive (§10.1).
- **Agent tabs.** The agent browses in its own Playwright `BrowserContext` in the same Chromium, with no user cookies or logins. Its tabs appear in the Browser window as "Agent tabs" with *Stop* and *Take over* (§9.6).

**Restarts and crashes (`ma-desk-0.2.1`).** `desk-browser` starts through a small wrapper. It passes the home page only when there's no saved session, and otherwise `--restore-last-session` with no URL, so a restart adds no tab. Before each launch it marks the last exit clean and removes stale `Singleton*` files, because Chromium skips session restore after a crash and its prompt is disabled. A hidden tab gets no animation frames and one timer tick a second, which is normal Chromium behaviour; the visible tab keeps 60 fps.

### 6.2 Streaming technology

| Option | Latency | Bandwidth, 1280×800 browsing | CPU, no GPU | Transport / license | Verdict |
|---|---|---|---|---|---|
| **Neko v3** (Pion + GStreamer, WebRTC) | 60–150 ms | ~1 Mbps avg at 30 fps; ~2–2.5 Mbps at 60 fps; 2.5–3 Mbps for video | x264 ultrafast ~0.3–0.7 vCPU in motion, ~0 static | UDP mux on one port, TCP-mux fallback; Apache-2.0; arm64 builds | **Pick:** its design for capture, encode and WebRTC, which `desk-stream` and desk-rtc are modeled on (they use no Neko code) |
| Selkies-GStreamer | 60–150 ms | similar | similar; heavier Python stack | WebRTC that expects TURN; MPL-2.0; restructured in 2025 | runner-up |
| Custom Pion/GStreamer | as Neko | as Neko | as Neko | ours | becomes desk-rtc (§4.2.10), modeled on Neko's design |
| CDP `Page.startScreencast` | 150–300 ms | 3–8 Mbps in motion (JPEG), 0 static | Chromium-side JPEG | would ride a data channel; no native popups, `<select>`, dialogs or audio | dropped: VNC-class, and TURN now covers restrictive networks |
| noVNC / KasmVNC | 80–200 ms | low static; 5–20 Mbps scrolling or video | low | WSS on 443; GPL server | rejected: egress on scroll and video |
| Amazon DCV | 50–120 ms | 1–3 Mbps | heavier (Xdcv) | closed source; browser client WebSocket-only; no Debian | rejected |

**Pick: WebRTC with a Neko-style GStreamer capture and encode (`desk-stream`, its own process and user, [ADR 0034](decisions/0034-desk-media-path.md)), sent by desk-rtc, H.264 constrained baseline** (safe for Safari). Capture and encode run natively under systemd, while Chromium stays a separate sandboxed unit (Neko's own Chromium image runs `--no-sandbox`). desk-rtc (§4.2.10) carries the tracks on the desk's one PeerConnection. Decisions: [ADR 0008](decisions/0008-browser-streaming-webrtc-neko.md), [ADR 0030](decisions/0030-browser-modes-local-minified-60fps-normal.md).
- **Encoder: 60 fps.** the owner's bar (60 fps scrolling and animation; "sluggish" is a no-go) settles ADR 0008's open choice.
  - **Codec:** H.264 constrained baseline, x264 `ultrafast`/`zerolatency`, no B-frames.
  - **Capture:** `ximagesrc` on `:99` with `yuvconv` to NV12 (libyuv, NEON) rather than `videoconvert` to I420. Under load, input to screen was 75/89 ms p50/p95 against 100/120 ms, on c7g.large at 1080p60, 8 Mbps and 30 ms RTT (a `fake-deskd` and a test page, not the real desk; [ADR 0034](decisions/0034-desk-media-path.md)). Settings live in `stream.conf` in the `desk-stream` release.
  - **Keyframes:** Milestone 2 sends one every 240 frames (`key-int-max`, 4 s at 60 fps) and one whenever a viewer is added or a client asks (PLI or FIR, forwarded over the media socket); it doesn't use intra refresh yet. The intended policy stays intra refresh instead of frequent keyframes, because a full keyframe is a 5–10× bitrate spike that the member sees as a latency spike ([ADR 0034](decisions/0034-desk-media-path.md)).
  - **Bitrate:** Milestone 2 sends 8 Mbps at 1080p60 (VBV buffer 300 kbit), the benchmark's setting, whatever the link: there is no congestion control yet (known limit, [ADR 0034](decisions/0034-desk-media-path.md)). The VBV caps of 2.5 Mbps at 1280×800 and 4 Mbps at 1080p in motion are still the target (*pending the capped-profile study*). On a static page the encoder's output drops to near zero; the benchmark measures the remaining capture cost.
  - **30 fps** is now only a congestion step (§6.5), never the default.
  - **Open question:** whether t4g.medium sustains this is the benchmark's main question (§11).
- Why: motion compensation cuts scroll bandwidth 3–10× against VNC or JPEG, and egress costs about as much as compute (§11). No GPU needed. desk-rtc's single-port UDP mux, with the desk's public IP as its 1:1 NAT address, means TURN is used only where direct paths are blocked (§4.2.11).
- **Path and playout.** RTP goes from `desk-stream` to `desk-rtc` over a Unix socket (`/run/desk-media/stream.sock`), never a loopback port, because web content can send to loopback ([ADR 0034](decisions/0034-desk-media-path.md)). The answer carries `playout-delay` 0,0 and the client sets `jitterBufferTarget = 0`.
- **One connection.** Video and audio are tracks on the same PeerConnection as the desk's data channels (§4.2), pre-negotiated so starting the stream needs no signaling. Platform relays only signaling.
- **Sound and picture in sync** ([ADR 0037](decisions/0037-sound-and-picture-sync.md), amends ADR 0034; live on the owner's desk with `desk-rtc` 0.3.2 and `desk-stream` 0.2.3, in image 0.2.5, and in the Desk app in prod). `desk-stream` stamps both tracks from one capture clock and `desk-rtc`'s sender reports use the same clock, with smaller audio buffers (5 ms Pulse fragments, 10 ms Opus frames). The tracks stay separate streams. While sound plays and there's been no input for 3 s, the Desk app holds the picture by the sound's own buffering, easing in, at most 250 ms; any input lets go at once, so input to screen is unchanged. On the test desk, sound after picture went from 33 to 42 ms p50 to within 10 ms. A hidden tab never holds.
- **Sound in a hidden tab** ([ADR 0038](decisions/0038-sound-in-a-hidden-tab.md), in the Desk app in prod). "Playing sound" is the same measure, from the audio receiver's `getStats`, and 60 s of silence means it has stopped. While the desk plays sound, a hidden tab's Browser stays `live` past 5 minutes and its sessions stay open past 60; the 24-hour no-input rule is unchanged. Until `desk-rtc` can send the sound alone (ADR 0038's proposed `PICTURE` event, not built), the unseen picture keeps coming too: about 27 MB an hour on a still music page, up to 1.3 to 3.2 GB an hour under a playing video.
- **When it streams:** only while a Browser window is open, visible and in normal mode, or while a minified page in a visible window shows a live island, which streams only its cropped region (§7.4). Parked windows, and minified mode with no island in view, pause it.
- **Warm encoder:** while a Browser window is visible in minified mode, the capture and encode pipeline stays initialized but paused. Switching to normal mode then shows a first frame in ≤ 300 ms (B13).
- **Fallback ladder:** udp/443 direct → ICE-TCP tcp/443 direct → TURN over TLS/443 (Platform's coturn; it carries only DTLS-SRTP ciphertext). ICE tries all three at once. Design v1's compat mode is dropped.

### 6.3 Input, audio, files
- **Normal mode input:**
  - **Transport:** pointer motion on the lossy `input` channel; keys (X keysyms), buttons and wheel on the reliable `keys` channel (§4.2.3). desk-rtc injects both into `:99` with XTEST. A lost motion packet is replaced by the next one, and keys can never stick or vanish.
  - **The pointer is drawn locally:** the remote cursor's shape arrives over the channel and is applied as the video element's CSS cursor, so pointer motion has no network latency.
  - **Wheel:** deltas are coalesced and sent once per display frame.
  - **Resolution** (not built yet; the stream is 1920×1080 for now): the window's CSS size sets the remote resolution (nearest xrandr mode, max 1920×1080; CSS pixels, not devicePixelRatio, to cap bandwidth). During a window resize the last frame is scaled locally, and the new mode is applied 150 ms after the resize ends.
  - **Clipboard** (not built yet): text syncs both ways through a gated deskd API. Pasting into an editable element on the page works today, through `browser.text.insert` (below).
  - **Touch** (not mapped yet): a phone can watch but not control. Planned: touch maps to the mouse.
  - **Full screen** (not built yet): Keyboard Lock (Chromium browsers) lets Ctrl+W and Ctrl+T reach the remote browser; other browsers get toolbar buttons.
  - **Composition and paste** are weak over keysyms, so there is no "type text" box. Keys go to a hidden textarea in the picture, because only an editable element gets composition and paste events. Composed text, dictation and pasted text go to the desk as the `deskd` RPC `browser.text.insert`, which uses CDP `Input.insertText`.
  - **Keys that stay with the member's browser:** Ctrl+W, Ctrl+T and Ctrl+N are never sent, and neither are Ctrl+Tab, F11 and developer tools. On a Mac, Cmd acts as Control. Ctrl+L (Cmd+L) or Alt+D leaves the stream for the address bar, and Shift+Esc closes the window. The exact rules are in `docs/interfaces/desk-runtime.md` §8.6.
- **Audio: output only, from Phase 1.** Opus 64 kbps (+0.03 GB/h, ~2% CPU), only while the window is open. No microphone or camera (`AudioCaptureAllowed=false`, `VideoCaptureAllowed=false`); microphone later.
- **Files:** downloads land in `/data/browser/downloads` and are listed by deskd, which sends them only as downloads under the untrusted-bytes rule (§4.2.13), never rendered in the app. Uploads are caught through Playwright's `filechooser` event and sent by the client over `bulk`.
- **Widget snapshot:** a CDP screenshot, WebP ≤ 640×400, at most every 10 s while the widget is visible (§3.4).

### 6.4 Known limits
- **Datacenter IP reputation.** Browsing from AWS IPs triggers more CAPTCHAs (Google, Cloudflare) and some blocks (banks, streaming). There is no v1 fix; residential egress would cost money and privacy.
- **No DRM.** arm64 Chromium has no Widevine, so Netflix-style sites won't play. H.264/AAC playback in Debian's Chromium is verified in Phase 0.
- **Single region** (us-east-1): West Coast and EU users add 70–100 ms RTT.

### 6.5 Normal mode: what the bar means for a stream
- **Targets** (§2.2, *pending benchmark*):
  - ≥ 58 fps on average while scrolling, with zero freezes;
  - input to photon p50 ≤ 90 ms and p95 ≤ 150 ms from US-East;
  - first frame ≤ 300 ms after a switch from minified mode.
- **Receiver:**
  - `jitterBufferTarget = 0` on the video receiver where the browser supports it, for the lowest playout delay the network allows.
  - Hardware decode where the browser offers it.
  - `requestVideoFrameCallback` is used only to measure.
- **When bandwidth drops** (Wi-Fi loss, TURN over TCP):
  - Lower the resolution first (down to 720p), then the frame rate (60 → 30).
  - Show a small "reduced quality" chip with the reason.
  - Never add buffering to hide the drop.
  - Minified mode is unaffected, because its data is kilobytes.
- **Honest limits.** A stream can be smooth but not native:
  - **Latency:** a local browser answers in ~30–50 ms. Normal mode answers in ~90 ms typical from US-East and ~160 ms or more from the West Coast or the EU.
  - **Scrolling** in normal mode is 60 fps video that trails the wheel by that much.
  - **Text** is rendered at CSS-pixel resolution, so it is softer than native on HiDPI screens. A "sharp text" option at DPR 2 would cost about 4× the pixels in encode CPU and egress. The benchmark evaluates it; it is not promised.
  - **Fast motion** shows compression artifacts at the bitrate cap.

  That is why minified mode, rendered locally, becomes the default when it ships in Phase 3 (§7.4), and normal mode is the fallback for what minified mode can't show. Until then, Phases 1–2 browse in normal mode only (Q8).

---

### 6.6 The browser session is carried over (ADR 0035)
**Product requirement, from the owner:** "A desk's browser session MUST be carried over no matter where that desk gets hosted. We should never clear browser history/cookies for any user."

- **The session** is everything a member would miss: cookies and sign-ins, including session cookies; history; open tabs; saved passwords and autofill; extensions and settings. It lives at `/data/browser/profile`, on the data volume.
- **The platform never clears it.** No rollout, volume replacement, resize, stop, crash, full disk, storage cap, support flow, plan change or host move may lose it. Anything freeing space may touch only rebuildable caches.
- **Allowed:** a member clearing their own data or deleting their account, and deletion about 37 days after payments stop (`ma-platform` ADR 0049; the owner: "Yes keep it").
- **History follows Chromium's own 90-day limit,** with no copy of our own beyond it (the owner: "Yes, 90 days is fine").
- **What can still lose it today:** a Chromium downgrade from a root swap (proven with faked newer version numbers: cookies are razed), a full `/data`, a restore (up to 24 h), a blank volume formatted at first boot, and a sign-in in the moments before a crash (a cookie set 2 s before a `kill -9` was lost). ADR 0035 has the audit, and what each gap needs.
- **Proven on a test desk:** cookies, including session cookies, history, tabs and a saved password survive a `kill -9`, a `deskd` restart and a clean restart of Chromium (`e2e/tests/browser-session.spec.ts`). A real stop and a root swap haven't been run with them yet.
- **Moving a desk between hosts isn't designed.** ADR 0035 lists what it would need.

## 7. Minified websites

**Status:** proposed; each stage is gated by the R&D spike (§7.8). Decisions: [ADR 0021](decisions/0021-minified-websites-structure-based.md), [ADR 0030](decisions/0030-browser-modes-local-minified-60fps-normal.md).

Every Browser tab has two views of one real page, and the real Chromium tab always runs on the desk VM:
- **Minified** (the default) is a clean, Desk-styled rendering of the page's content and controls, built on the desk from its DOM and accessibility tree and rendered locally in the Desk app.
- **Normal** is the live pixel stream.

Clicks and typing in the minified view are replayed on the real page's elements; the real page stays the source of truth.

**Headline:**
- **Rendered locally.** The minified view is rendered in the Desk app from a structure the desk extracts from the real page (MDoc). Scrolling, selection, find, zoom and typing therefore run at native speed (§2.2, B7). Only actions travel to the desk, where Playwright replays them on the real page.
- **No generative model** sits in the per-frame or per-click path. Minifying is deterministic code on the desk VM, expected (not yet measured) to take about 0.1–1 s per page. The spike (§7.8) tests that.
- **What a click costs:** the site's own response, plus the round trip, plus MA's overhead. The bar caps that overhead at 50 ms p50 and 150 ms p95 (B8, *pending spike*). Design v1's fixed ~300 ms settle wait is no longer on the visible path (§7.3).
- **An LLM** is used only asynchronously, once per site template, with the user's own key, and its output is cached.

### 7.1 Real-time feasibility

| Approach | Latency to a usable view | Marginal cost | Verdict |
|---|---|---|---|
| Diffusion re-draws page pixels | 1–4-step distilled models: ~0.1–0.3 s per ~512 px frame on A100/H100-class GPUs; ~1 s+ on the T4 in g4dn | GPU per desk: g4dn.xlarge $0.526/h ($384/mo 24×7); g5.xlarge $1.006/h ($734/mo) | No |
| Small local transformer on the desk CPU | Reading a ~10k-token page on 2 vCPUs takes tens of seconds to minutes | $0, but takes the CPU the browser needs | No |
| Hosted LLM rewrites every page | ~2–10 s (small model); 10–30 s+ (large) | ~$0.0025–0.05 per page | Not per page. Yes per template, async (Stage C) |
| DOM/accessibility distillation on the VM (Stage A), rendered locally | Hypothesis for the spike: ~0.1–0.5 s after load; per click, the site's time + RTT + ≤ 150 ms of MA overhead (p95); scrolling is local | ~$0 | **Yes, if the spike confirms: the near-real-time path** |
| Cached template recipe applied on the VM (Stage C hit) | Stage A time + ~10–50 ms (hypothesis) | $0 | Yes, if the spike confirms |

Why real-time diffusion is not realistic now:
- **Text.** Image models still garble small text, and a web page is mostly exact text, numbers and prices. One wrong digit in a balance or a flight time is unacceptable.
- **No semantics.** Generated pixels have no link to DOM elements, so clicks can't be mapped back to real elements without a second model guessing.
- **Frame rate and consistency.** Interactive UI needs 30–60 fps at 1080p+ with under 100 ms response. Even pipelined img2img reaches tens of fps only at ~512 px on a top GPU, and it flickers.
- **Cost.** One GPU desk running 24×7 costs many times a t4g.medium desk.
- **Lost features.** Selection, copy/paste, find-in-page, zoom and screen readers come free with real text and are lost with pixels.

A "lite transformer" is useful as a hosted model that writes a reusable layout *recipe*, not as a renderer. Neural rendering is worth revisiting only if per-frame cost falls about 100×. No GPU work is planned.

### 7.2 How it works on the desk VM

```
Chromium tab (real page; cookies and sessions stay on the VM)
  +- isolated-world script "ma-minify" (page JS can't see or modify it)
       Readability (articles) + role/name walker (all other pages)
       MutationObserver -> patches, coalesced per 16-33 ms (full re-snapshot debounced 100-250 ms)
deskd (Playwright for lifecycle + raw CDP)
  classify page -> distill -> apply recipe if cached -> MDoc
  action proxy: ref -> element -> hit-test -> trusted CDP input
  image proxy: images fetched with the tab's own session, downscaled, re-encoded to WebP, sent on bulk
        | WebRTC data channels on the desk connection (DTLS, §4.2): MDoc, patches and actions on mdoc
Desk app: Browser window -> <MinifiedView> (React DOM, rendered locally in the Desk theme; scroll, find, zoom stay local)
```

- **Injection.** `Page.addScriptToEvaluateOnNewDocument` with a `worldName`, so the script runs in an isolated world. Site scripts can't read or tamper with it, and the page DOM is never modified.
- **Distillers.** Article-like pages: `@mozilla/readability` (Apache-2.0) on a *cloned* document. Every other page: an accessibility-style walk with roles and names from `dom-accessibility-api`. Kept: landmarks, headings, text, links, lists, tables, images with alt text, form controls. Dropped: hidden, decorative, ad and tracker nodes. Most ads and trackers never get that far: the desk's Chromium blocks them with its own blocker, uBlock Origin Lite's pinned network lists and nothing else, in both views, on by default, with a per-site off switch the member controls and a kill switch ([ADR 0076](decisions/0076-browser-ad-and-tracker-blocking.md), `docs/interfaces/desk-runtime.md` §8.9). The spike compares the walker with CDP `Accessibility.getFullAXTree` and keeps the winner.
- **Shared with the agent.** The same walker, refs and action proxy back the agent's browser tools (§9.6), so pages are distilled once for both. The walker and action proxy therefore ship with the agent's browser tools in **Phase 2**, after the spike. If the spike finds wrong-target actions, Phase 2 ships only the read-only browser tools (walker, no action proxy) until the action proxy passes. The minified *view* ships in Phase 3.
- **Page classifier.** Rule-based at first: article, list/search, form, app, media, sensitive. Sensitive pages (login, payment, banking, health, a bare password form) open in normal mode and are never sent to an LLM.

### 7.3 MDoc and input mapping
deskd sends a typed JSON tree, never site HTML. The client renders it with Desk React components, so site markup and scripts never run in the Desk origin. URLs are limited to http and https. Images come through the deskd proxy, so the member's real browser never contacts third-party sites.

```json
{"v":1,"url":"https://example.com/search?q=…","title":"…","mode":"generic|reader|recipe:ab12",
 "blocks":[{"t":"heading","level":1,"text":"Results"},
  {"t":"field","ref":"e7","kind":"search","label":"Search","value":"lamps"},
  {"t":"button","ref":"e9","text":"Search"},
  {"t":"link","ref":"e41","text":"Brass desk lamp","href":"https://…"},
  {"t":"island","ref":"e88","reason":"canvas","w":640,"h":360}]}
```

- **Refs.** Each interactive node gets a short ref (e.g. `e41`). The isolated world keeps a WeakRef map from refs to elements; the client only sees refs.
- **Actions.** The client sends `{act: click|fill|select|check|press|scroll, ref, value?}`. deskd scrolls the element into view, hit-tests its centre with `elementFromPoint`, then sends trusted input (CDP `Input.dispatchMouseEvent` / `Input.insertText`).
- **Stale refs.** deskd re-locates a gone element by role, accessible name and index. If that doesn't give exactly one match, or the hit-test lands on another element (an overlay or modal), deskd **does not click**: it re-snapshots and shows the blocker (e.g. a cookie banner as a "Reject / Accept" block). **Rule: zero wrong-target clicks; refuse rather than guess.** Buttons labelled pay, buy, send or delete never use the re-locate fallback.
- **Typing.**
  - A minified field is a local input, so characters paint at once (B3).
  - Its value goes to the desk coalesced per frame (at most one message per 33 ms, replacing v1's 150 ms debounce) and is applied with CDP `Input.insertText`.
  - While the field has focus, the local value wins. The site's reformatted value (masks, autocorrect) is applied on blur, or after 600 ms without typing, and keeps the caret where it was.
  - Autocomplete suggestions appear as an MDoc list under the field when the site produces them.
- **After each action,** deskd streams patches as soon as the page changes.
  - The first DOM mutation after the action is distilled and sent within one 16–33 ms coalescing window. Later mutations follow as further patches.
  - "Settled" (no mutations for ~300 ms, or a navigation) is now only a flag that re-arms the hit-test guard for the next action. It no longer delays what the member sees.
  - Actions sent before the page settles queue on the desk in order, and still pass the zero-wrong-target checks.
  - Near the end of a list, the client asks deskd to scroll the real page two viewports early, so more items arrive before the member reaches the bottom.
- **What the user waits for:**
  - the pressed state in the next frame;
  - a progress line at the top of the view at 100 ms if nothing has changed yet;
  - then the site's own response time, plus RTT, plus MA's overhead (B8).

  Each action carries an id, so this breakdown is measured end to end (§2.2).

### 7.4 Local rendering, modes and fallbacks
**Rendering locally (the default view).**
- **What runs where.** The real page runs in the kiosk Chromium on the desk, and its MDoc runs as React DOM in the Desk app. The client never runs site HTML or scripts, so ADR 0021's safety model and its zero-wrong-target rule are unchanged.
- **Native speed by construction.** None of these ever leave the browser:
  - scrolling, which is the window's own scroll container;
  - text selection and copy;
  - find-in-page, which searches the MDoc data, including blocks that are off screen;
  - zoom (a local font scale);
  - hover styles;
  - expanding or collapsing a minified group.
- **Progressive delivery:**
  - deskd sends the first viewport's blocks first, then the rest. The client paints the first viewport within 50 ms of receiving it (B10).
  - Blocks are keyed by ref, so a patch re-renders only what changed.
  - Long lists are virtualized, and `content-visibility: auto` skips layout for off-screen blocks.
  - Images arrive after the text with their size known in advance, so nothing shifts. They are decoded off the main thread and downscaled to the rendered size × DPR (capped at 2).
- **Scroll anchoring:** content inserted above the viewport never moves what the member is reading (anchored by ref), and a selection survives a patch when its node's ref is unchanged.
- **Instant Back and tab switch:** the client keeps the last 10 MDocs per tab in memory. Back, Forward and tab switches therefore paint in one frame (B9); the real page navigates behind the view, and a patch reconciles any difference.
- **Optimistic where it is safe:**
  - Checkboxes, radios, selects and disclosure widgets flip at once and are confirmed by the echo. A mismatch reverts with a brief highlight.
  - Links and buttons are never optimistic: they show the pressed state and the progress cue.
- **Interactive traffic first:** MDoc messages and actions on `mdoc` never wait behind images or file transfers on `bulk` (§4.2.6).

**Modes and fallbacks.** Each page falls back automatically: **recipe (Stage C) → generic distillation (Stage A) → hybrid islands (Stage B) → normal mode.**
- **Confidence check** on each snapshot: main text extracted, the ratio of MDoc controls to visible page controls high enough, and no unhandled cross-origin iframes. Below the threshold, the tab switches to normal mode with a one-line notice.
- **Islands (Stage B):**
  - A widget the distiller can't handle (canvas, map, video, CAPTCHA, payment iframe) shows as a cropped live view of the real page inside the minified layout. Input passes through by coordinates, on the `input` and `keys` channels as in normal mode.
  - **Transport:** a cropped region of the warm encoder's output, sent on the desk connection's existing video track, with no new track, channel or signaling. deskd keeps the real page scrolled so the island's element sits inside Chromium's viewport and gives `desk-stream` its rectangle; the encoder crops to it (GStreamer `videocrop`) at 60 fps. One island is live at a time (the one under the pointer, else the largest in view); the others show their last frame (a CDP element screenshot) until they go live. CDP screencast stays dropped (§6.2).
  - **When it runs:** the encoder runs only while an island is in view in a visible Browser window. Scrolled out of view or parked, it pauses as in minified mode.
  - **Budget:** the island moves with the local scroll at native speed (B7). Inside it, B11 and B12 apply (normal-mode frame rate and input to photon), and its first frame appears ≤ 300 ms after it scrolls into view (the warm encoder, as B13), with its last frame shown until then.
  - **Cost:** in proportion to the cropped area. A 640×360 island is about a fifth of a 1280×800 frame: roughly 0.5–1 Mbps in motion (~$0.02–0.04 of egress per hour of motion), near zero when static, and encode CPU in proportion (*pending benchmark*).
  - **Not on member Guild Desks,** which have no Xorg or encoder: an island block there offers "Open on Personal" (Q12).
- **Errors:** a distiller error, or a timeout over 1.5 s, switches to normal mode. A refused action offers normal mode scrolled to that element.
- **Toggle:**
  - Per tab and instant, because the real page never stops.
  - The encoder stays warm while the Browser window is visible, so the first video frame appears ≤ 300 ms after a switch (B13). The minified view stays on screen until it does.
  - A per-site preference ("always normal here") is stored on the desk.
  - Switching keeps your place: the client sends the ref at the top of its viewport, and deskd scrolls that element into view.
- **Stream pause:** the full-page pixel stream pauses in minified mode; only a live island's crop streams. A 60 fps stream is 1–4 Mbps, about $0.04–0.16 of egress per active hour (*pending benchmark*); MDoc is about 10–100 KB per page.
- **Default** (non-blocking, revisit at Phase 3): minified everywhere the confidence check passes, normal mode otherwise, remembered per site. On a member Guild Desk the Browser is minified-only, with no islands (ADR 0025, Q12).
- **Before Phase 3, and on a NO-GO:** the minified view ships only in Phase 3, and only if the spike gives Stage A GO (§7.8). Until then every Browser browses in normal mode (Q8), and member Guild Desks, which can't stream, have no Browser app: its tile offers "Open on Personal" (`browserModes: none`, §13.1 #39). On a Stage A NO-GO that stays so, unless the owner pays to upsize member Guild Desks to stream (Q12).

**Honest limits of minified mode.**
- **Clicks can't beat the site.** A navigation or a search still waits for the real site, and minified mode adds RTT plus up to 150 ms (p95) on top. On a fast site from US-East a click lands in roughly 150–300 ms, close to a local browser. On a slow site it is as slow as the site.
- **The desk is a 2-vCPU VM.** Script-heavy sites run their JavaScript on Graviton cores, which can be slower than the member's laptop. Minified mode hides their rendering cost but not their script time.
- **It shows structure, not the site's design.** Animations, custom layouts and hover-only menus don't come through. A hover menu the distiller can't expand needs a `hover` action round trip.
- **Some sites need normal mode:** maps, video sites, canvas apps such as Excalidraw, online editors, and feeds that fight automation. They get the stream's limits (§6.5).
- **Refusals are visible.** Because of the zero-wrong-target rule, a click on a moving page is sometimes refused and offered again instead of guessed.
- **All of these numbers are hypotheses** until the spike (§7.8) and the benchmark (§11) measure them.

### 7.5 Stages

| Stage | Scope | Ships |
|---|---|---|
| **A. Distilled view** | Readability and role/name distillers, MDoc, React renderer, action proxy, image proxy, confidence fallback, sensitive-site rules, per-site mode memory. No LLM. | Phase 3, if the spike gives Stage A GO (walker and action proxy already in Phase 2 for the agent) |
| **B. Islands + curated recipes** | Live cropped islands. Hand-written recipes for ~20 common public sites, shipped through a signed update channel (no LLM, no user data). | Phase 3 |
| **C. LLM recipes (async, cached)** | On a cache miss the Stage A view shows at once; in the background the user's LLM writes a recipe for that template, which is validated, swapped in and reused. | Phase 4, if the spike gives Stage C GO |
| **D. Generative UI** | The LLM builds a task-specific UI from a fixed catalog of Desk components, bound to refs, cached per template. Model-written code never runs in the Desk origin. | Later, only if Stage C data shows headroom |

Stage C details:
- **Template key:** eTLD+1 + URL pattern with IDs collapsed (`/item/:id`) + a structural fingerprint (hash of the role skeleton, text removed).
- **The recipe** is declarative JSON: keep, drop, group and reorder regions, relabel controls, collapse filters, map repeated items to card fields. Regions are addressed by role/name paths, with CSS selectors as fallback. It is produced with structured output through the Agent app's provider layer (default: the cheapest model of the desk's provider). Recipe calls have no tools, so injection in page text can at worst produce a bad recipe, which validation rejects.
- **Validation before use:** ≥ 95% of main text kept and every visible control kept or dropped with a reason. Re-checked on each visit; on fingerprint drift the page goes back to Stage A and the recipe is regenerated.
- **Prompt redaction (default, non-blocking; the owner may revisit before Phase 4):** only structure and short UI labels (≤ 40 characters). Body text, input values, numbers, emails and query strings become placeholders. Full text is a per-desk opt-in, never for sensitive pages.
- **Budget:** a sub-limit inside the desk's LLM limits, default $2/month per desk and ≤ 30 recipes/hour. Over budget, Stage A only.
- **Storage:** SQLite on the desk volume, per desk. Personal and Work never share recipes.

### 7.6 Cost per page
Anthropic list prices (verified 2026-11-04; other providers are similar per tier). A recipe call is ~15k input + 2k output tokens; a generative-UI call ~20k + 8k.

| | Small tier (Claude Haiku 5.5, $0.10 / $0.50 per MTok) | Mid tier (Claude Sonnet 5.5, $2 / $10 per MTok) |
|---|---|---|
| Stage A page | $0 (VM CPU) | $0 |
| Stage C recipe, cache miss | ~$0.0025 | ~$0.05 |
| Stage C page, cache hit | $0 | $0 |
| Stage D generation, per template | ~$0.006 | ~$0.12 |
| Heavy user: 300 pages/day, ~20 new templates/day | ~$1.50/mo | ~$30/mo |
| Same user with an LLM call on every page | ~$22/mo | ~$450/mo |

- **BYO key only in v1.** The user's provider bills the user directly; MA has no LLM cost and content never touches MA systems. Users without a key get Stage A, which is fully usable.
- **MA-paid LLM (later, optional):** billed at cost + ~5% via per-user provider keys or workspaces called directly from the VM. Never a Platform proxy that sees prompts.

### 7.7 Privacy
Page content, cookies, sessions, snapshots, recipes and the image cache stay on the desk volume. The only path off the VM is Stage C/D calls to the user's own provider with the user's key: redacted by default, never for sensitive pages, and each one logged on the desk (site, tokens, cost) and viewable in Browser settings. No telemetry of visited sites. "Report broken page" is opt-in per report and sends only the URL pattern and recipe ID after the user confirms.

### 7.8 R&D spike (2 weeks, Phase 0)
- **Setup:** a dev machine with Playwright and Chromium; days 9–10 on a t4g.medium dev desk (the primary minimum) for target-hardware numbers. LLM ≤ $20 on a capped dev key (Q4). Public pages, automation practice sites, and a throwaway Google test account that the owner creates himself (Claude may not create accounts; Q4). No personal accounts.
- **Goals:** prove Stage A quality, latency and safe input mapping on real sites; measure whether Stage C recipes beat Stage A by enough to justify cost and privacy trade-offs; produce confidence thresholds and CPU/RSS data for sizing; validate the walker for the agent's browser tools.

| Days | Work |
|---|---|
| 1–2 | Harness: Playwright opens each site, runs its scripted task, records timings and snapshots. MDoc v0 and a minimal React renderer. |
| 3–4 | Distillers: Readability and the role/name walker, A/B-tested against CDP `getFullAXTree`. Classifier and sensitive-site rules. |
| 5–6 | Action proxy (refs, hit-test guard, trusted input, streamed patches), stale-ref recovery, mode switch with scroll sync, MA-overhead stamps. Run every scripted task. |
| 7–8 | Stage C: recipe schema, redacted prompt, validation. Recipes for 10 templated sites on the small and mid tiers, each reused across 5 pages, blind A/B against Stage A. |
| 9 | On the t4g.medium: latency, CPU and RSS with 1, 3 and 5 tabs. Stage D probe on 3 pages. |
| 10 | Report: metrics, go/no-go per stage, thresholds, ADR updates. |

**Test sites** (30, each with one scripted task):
- **Articles and docs:** en.wikipedia.org, bbc.com/news, theverge.com, a Substack post, developer.mozilla.org, docs.python.org.
- **Search and lists:** duckduckgo.com (search, open the 3rd result); news.ycombinator.com comments; a thread on old.reddit.com and www.reddit.com; amazon.com search results; ebay.com search with a filter; an allrecipes.com recipe (ad-heavy).
- **Forms and flows:** demo.playwright.dev/todomvc; saucedemo.com (log in, add to cart, check out); the-internet.herokuapp.com (login, dropdown, checkboxes, dynamic loading); gov.uk/check-uk-visa; a Google Form.
- **Logged-in apps (test account):** Gmail (read, draft a reply); Google Calendar (create an event); github.com (repo, issues, new issue on a test repo); a public Notion page.
- **Expected to fall back:** Google Maps, a YouTube watch page, the x.com feed, a Stripe test-mode checkout, the reCAPTCHA demo, excalidraw.com.
- **Bot-detection probe:** a Cloudflare challenge and Google sign-in, with Chromium launched normally and attached over CDP vs launched by Playwright.

**Targets:**
- **Usable view:** ≥ 70% of non-app, non-fallback pages rated 4/5 or better by the owner plus one other rater.
- **Fidelity:** main-text retention ≥ 95%; ≥ 95% of visible controls present.
- **Task success** with only the minified view: ≥ 90% on forms and lists. **Wrong-target actions: 0.**
- **Latency on the desk** (t4g.medium, *pending*):
  - distillation p50 ≤ 300 ms and p95 ≤ 1 s after load;
  - the first patch ≤ 33 ms after an action's first DOM mutation;
  - deskd's share of MA overhead (action received → dispatched, plus mutation → patch sent) ≤ 30 ms p95.
- **User-visible latency (the owner's bar, §2.2):**
  - Local interactions on the rendered MDoc meet B1–B3 on the reference devices.
  - Action to first visible result = the site's time + RTT + MA overhead of ≤ 50 ms p50 and ≤ 150 ms p95 from US-East (B8).
  - Back and Forward paint from the client's history in one frame (B9).
  - This replaces v1's working bar (click to updated view p50 ≤ 500 ms, p95 ≤ 1 s), which counted the fixed settle wait.
- **Payload:** MDoc ≤ 10% of the page's transfer size; median ≤ 100 KB. **Overhead:** ≤ 150 MB RSS and ≤ 1 CPU-second per page.
- **Fallback:** every expected-fallback site falls back automatically.
- **Stage C:** validation pass ≥ 80%; cache hit ≥ 80% on pages 2–5 of a template; blind preference over Stage A ≥ 65%; median ≤ $0.01 per recipe on the small tier; p95 generation ≤ 15 s; redacted prompts reach ≥ 80% of full-text quality.

**Go / no-go:**
- **Stage A GO:** all targets met, including the MA overhead budget (B8) and local rendering (B7, B10) → minified by default.
  - **Missing only the overhead budget** → at best PARTIAL, and the action path is reworked before Phase 3.
  - **PARTIAL** (usable 50–70% or task success 75–90%): minified by default only for articles, lists, search and docs.
  - **NO-GO** (usable < 50%, or any unfixable wrong-target action): normal mode plus an opt-in "Reader" button; revisit after islands.
- **Stage C GO:** all targets met. If quality needs full text (redacted < 80%), the owner must accept opt-in full text, otherwise only curated recipes ship. If preference < 55%, drop Stage C and invest in curated recipes.
- **Stage D:** not before Stage C ships; needs preference over Stage C on ≥ 60% of probe pages at ≤ 30 s and ≤ $0.05 per generation on the small tier.
- **Diffusion:** no-go by design. No GPU spend.

---

## 8. Chat

Channels that carry every medium to a person or group. **Phase 2**: the v1 transports are `local` and `ma` (member to member); real external transports come later, as the vision allows. Decisions: [ADR 0016](decisions/0016-chat-channels-and-delivery.md), [ADR 0017](decisions/0017-sealed-relay-desk-to-desk.md).

### 8.1 Concepts
- A **contact** has many **endpoints**: an MA address, email, E.164 phone number or Matrix ID. Contacts are scoped to the desk, so Work and Personal contacts stay separate.
- A **channel** is one per person (`direct`), per ad-hoc group (`group`) or per guild (`guild`), plus one `self` channel for notes to yourself. All media for that person or group share one thread.
- Inbound messages from unknown senders land in **Requests**; they never create a channel automatically.

### 8.2 Message model (`chat.db`)
- `messages`: id, channel_id, direction (`in`/`out`), `thread_key`, reply_to; `author_kind` (`human`/`agent`/`system`), author_id, and for an agent the provider (for the badge); **`medium`** (`local`/`ma`/`email`/`sms`/`matrix`, an open string), `external_id`; sent_at, received_at, `delivery_reason` (`explicit`/`last_inbound`/`channel_pref`/`ma_fallback`), status (`draft`/`queued`/`sent`/`delivered`/`failed`), error; body_text, body_format (`plain`/`md`; inbound HTML kept as a sanitized blob), `raw_blob`; deleted_at.
- `message_recipients`: message_id, endpoint_id, medium, status, external_id (per-recipient fan-out status).
- Also `attachments`, `contacts`, `endpoints` (with `last_inbound_at`), `channels` (kind, title, guild_id, `preferred_medium`, muted, archived, last_message_at, unread), `channel_members`, `transport_accounts` (config encrypted with a desk-local key), `messages_fts`.
- **"Agentic" is an author kind, not a transport.** An agent-written message travels over a real medium and always shows the agent's provider badge to both sides.

### 8.3 Default delivery
**The medium of the most recent message *received from the other party* in this channel** (in a group, the latest inbound from any member). The other person's last medium is where they are reachable now, so the default follows them when they switch.

Resolution order:
1. The explicit choice on this message (that message only).
2. `last_inbound`, if that adapter's status is `ok` and `canReach` covers every recipient.
3. `channel.preferred_medium`.
4. `ma`, if every recipient has an MA address.
5. Otherwise the composer requires the user to pick.

The composer chip states the medium and the reason, e.g. "via Email · last received 2h ago".

### 8.4 Transport adapters
Adapters run inside deskd, so credentials and plaintext stay on the VM.
```ts
interface TransportAdapter {
  readonly medium: string;                       // 'local' | 'ma' | 'email' | 'sms' | 'matrix' | …
  readonly caps: { groups: boolean; attachments: boolean; maxBytes: number;
                   format: 'plain' | 'md' | 'html'; receipts: boolean; needsRunningVm: boolean };
  status(): 'ok' | 'degraded' | 'needs_auth' | 'disabled';
  canReach(to: Endpoint[]): boolean;
  send(msg: OutboundMessage, to: Endpoint[]): Promise<RecipientResult[]>;
  start(sink: InboundSink): Promise<void>;   // sink.accept() is idempotent on (medium, externalId)
  catchUp(cursor: string | null): Promise<string>; // after wake: drain relay / IMAP since cursor
  stop(): Promise<void>;
}
```
Inbound routing: a `thread_key` match (MA channel id, email `References` root, Matrix room) → that channel; else one sender endpoint → that contact's `direct` channel; else Requests.

| Roadmap phase | Transports | Chat can do |
|---|---|---|
| Phase 2 | `local`, `ma`, guild channels on the guild host | Channels, contacts, one thread per person or group, attachments, search, agent hooks, notes to self, member-to-member channels over the relay, guild channels with history (§8.6) |
| Phase 4 | `email` (the user's own IMAP/SMTP account) | Email in the person's channel. No AWS mail infrastructure. IMAP IDLE while the VM runs, catch-up on wake. (Proton Mail needs Proton Bridge on the VM.) Needs desk egress on TCP 993/465/587 (§13.1). |
| Later | `matrix` (user's own homeserver account and bridges), `sms` (user's own Twilio account; inbound via a sealed webhook relay) | The "text a family member" case. iMessage has no API; WhatsApp/Signal only through Matrix bridges |
| Later | — | Web Push (no content in payload), edits, reactions, receipts, voice notes |

### 8.5 `ma` transport: sealed relay
Desks idle-stop, so desk-to-desk delivery goes through Platform's mailbox (`desk_inbox`), which holds only ciphertext ([ADR 0017](decisions/0017-sealed-relay-desk-to-desk.md)).
- Each desk generates X25519 and Ed25519 keypairs on first boot, keeps the private halves on `/data`, and registers the public halves with Platform's key directory.
- Envelope: `{to_desk, from_desk, ct}`, with `ct = crypto_box_seal(recipient_pk, payload ‖ ed25519_sig)` (libsodium). The payload carries msg_id, channel_id/kind, members, sent_at, author_kind, body, reply_to and attachment refs.
- Attachments are encrypted with a random key (secretstream) and uploaded to a Platform ciphertext drop; the key travels inside the envelope.
- **Platform sees:** from desk, to desk, time and size. Nothing else.
- The recipient desk pulls on wake and while running, then acks; unacked envelopes expire after 30 days. A running recipient gets an `inbox` push on its gateway link (Desk ask), so delivery doesn't wait for a poll. Platform shows pending counts so badges work while a desk is stopped.
- Display order is `(sent_at, msg_id)`; EC2 clocks sync through Amazon Time Sync.
- **Addresses (default; the owner to confirm before Phase 2, Q3):** each desk has its own address (e.g. `owner.personal`, `owner.work`, `owner.guild`). Guild-desk addresses are discoverable to guildmates; Personal and Work addresses are shared only through invite links.

### 8.6 Guild channels
- Guild channels live on the guild host (§4.5) as append-only logs. The host assigns `(epoch, seq)`, and each message is signed by its author desk's Ed25519 key, so a restored or newly promoted host can accept messages re-sent by member desks without trusting those desks.
- Each member's Guild Desk replicates the channels its access allows: the last 90 days plus pins and mentions; older history comes from the host. New members get the full history.
- Sending goes from the member's Guild Desk to the host over `guild.log`. While the host is asleep, messages wait as pending on the sender's desk and a wake is requested. There is no relay, no per-member fan-out and no Platform copy. The sealed relay (§8.5) stays for member-to-member channels outside the guild.
- Sub-channels are spaces with their own access list. Platform's guild size cap (25 in v1) bounds membership.
- Leaving purges the member's replica (best effort; the UI says so).
- Badges: a number for direct channels, a dot for guild channels (anti-stress), computed on the member's own Guild Desk.
- Notes, notebooks and files are shared with the guild by putting them in a guild space (§4.5.2), not by per-item grants.

### 8.7 UI
Channel list (unread count, last medium icon) and a thread where each message shows a small medium icon. Composer with the medium chip, attachments and search. Inbound email HTML (Phase 4) renders sanitized in a sandboxed iframe with remote images blocked by default. Any message or attachment has **Save to Notebook**. Agent tools for Chat are in §9.6.

---

## 9. Agent

The desk's "manager", plus optional staff agents: chat UI in the client, runtime on the desk VM, member's own LLM keys, usage limits, desk-scoped tools, and agent-to-agent messaging only with the member's grant. **Core rule:** deskd is the only policy enforcement point. Agents *propose*; deskd decides, asks the user when needed, executes and logs. Decisions: [ADR 0012](decisions/0012-llm-keys-desk-encrypted-envelopes.md), [ADR 0018](decisions/0018-agent-framework-ai-sdk.md), [ADR 0019](decisions/0019-agent-safety-policy-point.md), [ADR 0020](decisions/0020-agent-runs-and-usage-limits.md).

### 9.1 What the user sees
- **Canvas.** Each agent shows on the Agent tile with its provider badge and status: *online*, *working*, *needs you* (red count = pending approvals), *limit reached*, *no key*, *asleep*. The desk's status line reflects the manager agent when there is a problem (§3.5). Widget sizes add last reply, running task and a one-line prompt box.
- **Window** (React DOM): left rail = the desk's agents (avatar, badge, status); middle = conversations; main = thread + composer; right drawer = Tasks, Usage, Activity (audit).
- **Thread:** streaming Markdown (react-markdown + remark-gfm, no raw HTML, sanitized), code blocks with copy, stop / regenerate / edit-and-resend, per-message footer (model, tokens, est. $), collapsed tool-call chips ("Read note *Groceries*"), inline **approval cards** showing the exact payload.
- **Composer:** text, attachments (notebook page, desk image, "this browser tab"), model picker limited to the bound key's models, "run as background task" toggle.
- **Output safety:** remote images in model output are never auto-loaded (an exfiltration channel); links show the full URL and open in the desk's Browser by default.
- **The desk is the source of truth.** The client subscribes to `agent.conversation:<id>` and `agent.run:<id>` (§4.2.5) with a sequence cursor and replays on reconnect; closing the tab never stops a run.

### 9.2 Agents and the desk team
- `agent = {id, name, avatar, role: manager|staff, instructions, chat_binding{key_id, model, params}, image_binding?, tool_policy, limits, memory_on, badge_hidden?}`. The desk has a default binding that agents inherit.
- Every desk starts with one **Manager**, dormant (*no key*) until a key is bound. Members add **staff** agents (default cap 5 per desk) with narrower tools, e.g. *Researcher* (browser + notebook create) or *Writer* (notebook only).
- Phase 1: the manager only. Phase 2: staff agents, each chatted with directly. Phase 4: the manager gets `team.delegate(agent, brief)`; the sub-run uses the staff agent's own tools, key and limits; depth 1 (staff cannot delegate).
- Concurrency: one active run per agent, at most 2 per primary-size desk.

### 9.3 Providers
AI SDK Core behind our own `ChatModel` / `ImageModel` interfaces, plus a capability registry (tools, vision, context size, reasoning, image sizes).

| Provider | Chat adapter | Image generation (Phase 2) | Free key check |
|---|---|---|---|
| Anthropic | `@ai-sdk/anthropic` | none (no image API) | `GET /v1/models` |
| OpenAI | `@ai-sdk/openai` (Responses API) | `gpt-image-*` | `GET /v1/models` |
| Google | `@ai-sdk/google` (Gemini API key) | Gemini image models | `GET /v1beta/models` |
| xAI | `@ai-sdk/xai` | `grok-imagine-image` | `GET /v1/models` |
| Later | OpenAI-compatible base URL (OpenRouter, Mistral, a local model on a GPU desk) | | |

- **Rollout:** Phase 1 ships Anthropic and OpenAI chat; Google and xAI follow in Phase 2.
- Chat and image bindings are separate (an Anthropic agent can draw with an OpenAI or Google key). Every output is badged with the provider that produced it.
- **API keys only.** Consumer subscriptions (ChatGPT Plus, Claude Pro, SuperGrok) can't be used by third-party apps; the key form says so and links each provider console.
- First use per provider shows a one-time notice: prompts and tool results go to that provider under the member's own agreement. This is the one place desk content leaves MA infrastructure.

### 9.4 Provider badges
Shown by default on the Agent tile and widget, rail avatar, thread header, and every assistant message and generated image (the model can change mid-thread). Hideable globally (a pref in the layout doc) or per agent (desk setting). Hidden does not mean unknowable: provider and model stay in the message footer tooltip and agent settings, and a badge **reappears after any provider change until dismissed**. Assets: official marks per each provider's brand guidelines; fallback a neutral text monogram.

### 9.5 Provider keys
Platform's draft ADR 0018 stores keys as KMS envelopes that only the member's desks can decrypt. v1 keeps that and moves the encryption step onto the desk, so Platform never sees a key in plaintext ([ADR 0012](decisions/0012-llm-keys-desk-encrypted-envelopes.md)).
1. The member pastes a key in Agent settings. It goes **only to deskd**, over the desk's data channel (DTLS end to end, §4.2); the gateway and TURN never see it.
2. deskd validates it with the provider's free model-list call, then envelope-encrypts it: `kms:GenerateDataKey` on Platform's CMK `ma-llm-keys` with encryption context `{UserId, KeyId}` (the desk role may do this only for its own `UserId` tag), AES-256-GCM. It stores the envelope plus metadata (provider, label, last 4, created-by desk) in Platform's `llm_keys` and caches the envelope in `agent.db`.
3. **Scope:** a new key is assigned to **this desk only**. "Use on my other desks" adds assignments and needs step-up auth. Other desks then pick it from the metadata list, even while the source desk is stopped.
4. **Use:** deskd calls `kms:Decrypt` with the desk role (the key policy matches the context's `UserId` to the role's tag; Platform's API roles have no Decrypt) and hands the plaintext to desk-agent over the local socket. Plaintext exists only in RAM: briefly in deskd (validation in step 1, decrypt here; held in byte arrays it zeroes after hand-off, best effort on the JVM, where GC copies weaken this) and in desk-agent for as long as the key is in use. No swap (zram only, in RAM), core dumps off, and no hibernation (§10.1), so a key never reaches a disk without a logged `kms:Decrypt`.
5. **Delete or rotate:** step-up auth; Platform deletes the envelope and tells desks to wipe it (`notify keys` with `dropKeyIds` on the gateway link, and the heartbeat response as backstop). The UI tells the member to revoke at the provider too, the only real revocation. Rotation keeps the `KeyId`, so bindings survive.

**Honest limit:** AWS account admins can rewrite a key policy, and through SSM can run root commands on a running desk (§10.4). The "audited" half of the claim depends on Platform's CloudTrail trail and alarms (§13.1 need #15; Platform now runs a multi-region CloudTrail trail): every Decrypt logged, alarms on key-policy changes, desk-volume attach or snapshot restore, and SSM commands to desks. So the claim is "operator-blind by design, and audited", not "zero-knowledge" (Q2).

### 9.6 Desk-scoped tools and confirmation
Classes: **read** (auto); **local-write** (auto, versioned, attributed "edited by ‹agent›", undoable); **destructive** (confirm); **egress** (anything leaving the desk: always confirmed in v1, no auto-approve).

| Tool | Class | Phase |
|---|---|---|
| `notebook.search / list / read / activity(day) / history` (`read` returns GFM Markdown) | read | 1 |
| `notebook.create_page / append / insert_after_heading / replace_text / toggle_task / set_title` (applied to the live Y.Doc via Hocuspocus `openDirectConnection`; `pre_agent` snapshot first; "Edited by Agent · Undo" banner; `replace_text` fails on a missing or ambiguous match) | local-write | 1 |
| `notebook.trash_page` (Trash only; there is no hard-delete tool) | destructive | 1 |
| `browser.snapshot / scroll / extract` in the agent's own context (the context has no logins) | read | 2 |
| `browser.open / click / type` in the agent's own context | read; **egress while the run has both U and S** (§9.7) | 2 (`click` and `type` only if the spike's action proxy passes, §7.2) |
| `browser.submit` (form submit, Enter in a form, download, upload) | egress | 2 |
| `browser.read_user_tab` (only after the user clicks "share this tab") | read, untrusted | 2 |
| `memory.save / list / forget` | local-write | 1 |
| `chat.list_channels / read / search / default_medium` (inbound content from others tagged untrusted) | read | 2 |
| `chat.draft(channel, text, medium)` (shows in Chat as a draft) | local-write | 2 |
| `chat.send(draft_id)` (stamped `author_kind=agent` + provider badge) | egress | 2 |
| `image.generate` (saved to desk files, costed) | local-write | 2 |
| `a2a.ask(desk, message)` | egress | 4 |

Markdown is the agent's interchange format; deskd parses it with the same TipTap schema. Events `note.changed` and `chat.message.in` are delivered to the runtime for triage. No shell, filesystem or code-execution tools in v1.
- **Browser tools** use the §7 walker: a role/name snapshot with element refs, not raw HTML or pixels, and the same zero-wrong-target action proxy. They read the **real** DOM. Typing into password fields is blocked. Driving the member's logged-in context comes later, behind a per-task grant with every input confirmed.
- **Approval integrity:** deskd stores `{action, exact payload, sha256}` and the client renders it. The member approves through their own desk session (desk-agent never holds one), echoing the hash; deskd executes exactly that payload, once. Approvals expire after 24 h. AI SDK `toolApproval` drives only the loop UX; deskd re-checks independently.
- **Desk isolation:** tools exist only for local services; desk sessions are bound to a DTLS key in the member's browser and never enter Chromium; MA's own hosts are on the kiosk blocklist; a desk can reach another desk's ICE ports but cannot open a session without a Platform-signed token bound to its own certificate, and guild sync reaches only `desk-guildhost` (§4.2.15).

### 9.7 Prompt-injection defenses
Prompt injection is unsolved, so the design limits the blast radius instead of trusting the model. Following Meta's *Agents Rule of Two* (Oct 2025), no run may combine untrusted input, private data and an unconfirmed external action.
- deskd tracks taint per run: **U** (web content, inbound chat from others, guild content, A2A messages) and **S** (notebook, chat or memory read). Egress is always confirmed. With both U and S set, every agent browser action that can carry data to a site is egress too and needs confirmation, and the thread shows an "untrusted content in context" chip:
  - `browser.open` and any navigation an action causes, to any origin, including same-origin, query-string and fragment changes (`attacker.example/log?d=<notes>`);
  - `browser.type` into any page, because page script can read and send keystrokes without a submit;
  - `browser.click`, because a click can navigate or signal page script.
- **Browsing without prompts:** before untrusted browsing, the agent can fork a fresh sub-run with S clear (no desk data in its context). The sub-run browses freely, since it has nothing private to leak, and returns only its extracted result; the parent then becomes U and stays under the rule above.
- Untrusted tool output is wrapped in delimited blocks labelled with its origin. Snapshots drop hidden text. Tool output is capped (default 20k tokens).
- A memory write while U is set needs confirmation (blocks persistent injection).
- CI runs a fixture site of injection pages against the tool layer and asserts that confirmations fire, including a same-origin navigation with notebook text in the query string and a `browser.type` of memory text into a page field, both with U and S set. It tests policy, not model behaviour.

### 9.8 Runtime process model
```
client --data channels (DTLS, via desk-rtc)--> deskd [user desk]: API, SQLite (agent.db, audit), policy, approvals,
   |                           egress CONNECT proxy, KMS + Platform calls via the desk role
   |                        unix socket (tools RPC + events)
   |                           desk-agent [user agent]: AI SDK loops + LLM gateway (keys in RAM)
   |                             -> via proxy only: api.anthropic.com, api.openai.com,
   |                                generativelanguage.googleapis.com, api.x.ai
deskd --CDP (localhost)--> kiosk Chromium [user kiosk]: user context + agent context
```
- **desk-agent:** Java 21 + Spring Boot in Docker, as user `agent`, with the equivalent container options, because systemd limits don't reach containers: `User=agent`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths=/data/agent`, `MemoryMax=768M`, `CPUWeight=50`, `LimitCORE=0`. It cannot read deskd's data; everything goes through the tools RPC. A crash restarts it and runs resume from their checkpoint.
- **nftables owner-match:** user `agent` may reach only 127.0.0.1 (deskd's proxy, which allows provider hostnames only). IMDS (169.254.169.254) is reachable only by root and `desk`; `agent` and `kiosk` are blocked, which closes the Chromium and prompt-injection paths to the desk role's credentials.
- **Footprint:** desk-agent ~200–400 MB RSS; the agent BrowserContext ~150–300 MB per tab (cap 2 agent tabs on primary desks), inside desk-browser's 2.5 GB cap (§11). CPU is small; it mostly waits on the network.

### 9.9 Usage limits
- **Scopes:** per agent (day/week/month), per desk (month), per run (default $2 or 50 steps, which kills runaway loops), per key per desk (month). Units: estimated USD (primary) and/or tokens. Defaults: agent $5/day, desk $20/month; members can change them, agents cannot.
- **Enforced in the LLM gateway inside desk-agent:** AI SDK `wrapLanguageModel` middleware plus an equivalent wrapper on image calls. *Reserve* before the call (estimated input tokens, bytes/3, × input price + `maxOutputTokens` × output price; refuse if it exceeds what remains). *Settle* after from provider-reported usage (including cached and reasoning tokens). Ledger rows are written in one SQLite transaction, so concurrent runs can't overspend; overshoot is bounded by one call.
- **Account-wide per-key limits:** deskd reports usage totals (tokens, est. $, per key and feature tag `agent`/`minify`; never content) to Platform every 5 min; Platform aggregates across desks and returns `limitsRemaining` in heartbeat responses (Platform ADR 0018, §4.2.9). In Phase 1 (one desk) the local limits are what bind.
- **Prices:** a signed `pricing.json` ships with each desk release, with per-model user overrides. For an unknown model only token limits apply and $ shows as "unknown". Amounts are always labelled *estimated*; the UI recommends provider-side spend limits as the real backstop.
- **On hitting a limit:** status *limit reached*, runs pause (resumable), notification badge.

### 9.10 Runs, keep-awake and memory
- **Runs:** a durable SQLite state machine `queued → running → waiting_approval | paused_limit | paused_stop → done | failed | cancelled`. Each step is checkpointed before the next; tool calls carry idempotency keys, so resuming never re-executes. No Temporal or Redis.
- **Keep-awake:** while any run is *running* and making progress (a step finished in the last 60 min), the heartbeat reports `agent_tasks_running > 0` and `agent_last_activity_at`, and Platform's sweeper counts that as activity (§10.5). Unattended work counts; there is no cap tied to the member's last input (v1's 2-h cap is dropped). *waiting_approval* runs and idle schedules don't count. On `prepare_stop` deskd checkpoints and marks runs `paused_stop`.
- **Badges while stopped:** pending-approval and finished-run counts go out in the heartbeat; Platform keeps the last counts.
- **Scheduled runs** need Platform wake-on-schedule, so they come in Phase 4.
- **Memory:** thread history in SQLite, compacted into a viewable summary near the context limit; **explicit long-term memories** per agent that the member can see and edit (top N pinned into the system prompt, the rest recalled with FTS5); notebook search is a tool, not memory. Embeddings (sqlite-vec) later. All memory is desk-scoped.

### 9.11 Agent-to-agent (Phase 4) and the audit log
- **Scope:** only between the member's own desks. Cross-member (guild) A2A is out of scope in v1: members start guild agents on the guild host themselves (§4.5.2), and member agents can't call them.
- **Grant:** created only by the member in the client with step-up auth, stored in Platform as metadata: `{grant_id, from_desk, to_desk, scope: ask|notify, max_msgs_per_day: 20, expires: 30d, confirm: outgoing+reply}`. Directional, and the UI states the data flow plainly ("Work may ask Personal" means Personal's agent may send Personal information to Work). A grant never gives tool access across desks.
- **Transport:** the sealed relay (§8.5). The source deskd seals and signs; the relay checks grant, rate and expiry, then delivers or queues for up to 7 days and optionally wakes the target. The receiver re-verifies, marks the run **U**, and its reply is an egress action (confirmed by default). Revocation takes effect at once at the relay and on both desks.
- **Audit log (Phase 1, per desk):** an append-only SQLite table (triggers block UPDATE and DELETE), hash-chained `h_n = SHA256(h_{n-1} ‖ entry)`. Each entry: time, actor (`user | agent:<id> | desk:<id> | support | system`), action, target, payload hash, decision, cost. It covers key add/use/delete, every tool call, approvals, limit hits, support sessions, grant changes and A2A in/out. Bodies stay in conversation tables. Shown in the Activity drawer, exported as JSON, kept 1 year. Later: anchor the daily chain head in Platform.

### 9.12 Framework
**AI SDK Core (Vercel, Apache-2.0; `ai` v7 + `@ai-sdk/*`, checked on npm 2026-11-04) with our own thin orchestration** ([ADR 0018](decisions/0018-agent-framework-ai-sdk.md)). It is provider-neutral across all four providers and image generation, and gives the tool loop with `toolApproval`, streaming, structured output and middleware. No Vercel hosting; telemetry off. Rejected: Claude Agent SDK and OpenAI Agents SDK (vendor-centred), LangGraph (heavier, durable graphs we don't need), LiteLLM proxy (a second Python process holding keys), Mastra (younger; revisit if orchestration grows). AI SDK ships breaking majors, so we pin exact versions and persist **our own** message schema, mapped at the boundary.

---

## 10. Desk VM image, data and lifecycle

Decisions: [ADR 0007](decisions/0007-desk-image-debian-arm64.md), [ADR 0022](decisions/0022-desk-connectivity-hybrid-webrtc.md), [ADR 0011](decisions/0011-desk-data-location-and-privacy.md), [ADR 0026](decisions/0026-idle-24-hour-rule.md). Prices: AWS Pricing API, us-east-1, 2026-11-04, 730 h/month.

### 10.1 Image
- **Base OS: Debian 13 (trixie) arm64**, from the official Debian AMI (owner `136693071363`).
  - Debian ships a security-supported `chromium` .deb. Amazon Linux 2023 (Platform's AMI contract) has no Chromium package. Ubuntu 24.04's Chromium is snap-only and its AppArmor rules restrict the user namespaces Chromium's sandbox needs.
  - **No hibernation in v1: plain stop only** (Platform ADR 0016's default). A hibernation image writes all RAM to the root volume, including desk-agent's plaintext LLM keys and decrypted page and chat content, so anyone who can snapshot or attach that volume would read keys without a logged `kms:Decrypt`. Its one benefit, tabs surviving a stop, comes from Chromium session restore instead (§6.1). If the owner picks Platform's hibernation price-down option later, Desk first adds a pre-hibernate hook: stop desk-agent and drop deskd's key cache, with the kernel's `init_on_free=1` so freed pages are zeroed before the image is written, then decrypt keys again (logged) on resume. Debian is also not on AWS's tested hibernation list.
- **arm64 (Graviton):** t4g.medium costs $0.0336/h against $0.0416 for t3.medium, and a Graviton vCPU is a full core (helps software encoding). Trade-offs: no Google-branded Chrome, no Widevine. No x86 in v1 (Platform ADR 0022).
- **Build:** Desk owns the recipe in `ma-desk/image/`: EC2 Image Builder components that call plain shell scripts, plus smoke tests. Platform's pipeline builds it in the Platform account (Platform ADR 0015), which keeps ADR 0001's AWS boundary. Steps:
  1. `apt full-upgrade`.
  2. Packages: chromium, xserver-xorg-video-dummy, pulseaudio, GStreamer (base/good/bad/ugly, x264), Docker Engine, nftables, zram-generator, unattended-upgrades, chrony, amazon-ssm-agent. No web server.
  3. desk-rtc (our own Pion v4 service, modeled on Neko v3) and `desk-stream`, our own GStreamer capture pipeline.
  4. deskd, desk-agent, desk-guildhost and desk-rtc release artifacts (built for arm64 in this repo's CI).
  5. systemd units, config, hardening.
  6. **Smoke test** (Platform runs it on the candidate desk via SSM Run Command): units healthy; Playwright attaches to Chromium; a local test client (Pion, over loopback and a root-only test signaling socket) opens every data channel and receives video frames; hello and the outbound gateway link succeed.
  7. Scrub machine-id, logs and caches; publish an SBOM (syft).
- **Tags/metadata** per release: image version, git SHA, `data_schema`, `deskApi`, Chromium, desk-rtc and service image versions. Platform's rollout reads only these.
- **Cadence:** a build on every merge to `image/**`, a weekly rebuild, and on-demand builds for Chromium CVEs.

### 10.2 Hardening
- No sshd and no key pair. SSM agent installed for Platform's candidate smoke tests and break-glass (Platform ADR 0009). It runs commands as root, so anyone allowed `ssm:SendCommand` on a desk (including any account admin) can read that running desk's memory, decrypted keys and logged-in browser sessions. Platform's IAM policy limits operators to allow-listed Run Command documents with no Session Manager shell, but an account admin can bypass that policy, and the desk itself cannot enforce an allow-list. The record therefore lives outside the desk: CloudTrail logs every `SendCommand`, Platform mirrors it to its Object Lock `audit_log`, an alarm fires, and the member sees it in their access history (§13.1 need #15). Root could rewrite the desk's own Activity log, so that log is not the record.
- IMDSv2 required, hop limit 1. The per-desk IAM role (Platform ADR 0011) is used only by deskd.
- nftables per-uid rules: `kiosk`, `agent` and `guild` cannot reach IMDS, the VPC CIDR or RFC 1918 ranges (no lateral movement to other desks or Platform); `agent` reaches only deskd's local proxy; only uid `desk` may connect to CDP 9222 and desk-rtc's Unix socket. The only listening network sockets are desk-rtc's udp/443 and tcp/443, and new sources to them are rate-limited per address.
- Chromium sandbox on; desk-agent under a hardened unit (§9.8); unattended-upgrades for Debian security fixes (Chromium included).
- Logs go to journald (volatile, size-capped) and never leave the VM.

### 10.3 Services
| Unit | User | Role | Runs |
|---|---|---|---|
| `desk-firstboot` + `data.mount` | root | Mounts `/data` by label; on a blank volume runs mkfs.ext4 and creates the layout. deskd refuses to start if `/data` is not mounted | boot |
| `deskd` | desk | App APIs over desk-rtc's data channels, session auth, SQLite, Playwright controller, distiller, activity tracking, the outbound gateway link, heartbeat and SigV4 calls to Platform, data migrations. Unix sockets only. Runs in Docker, with its memory cap set as a container option (value pending measurement) | boot |
| `desk-rtc` | rtc | The desk's one WebRTC endpoint (§4.2.10): ICE-lite on udp/443 and tcp/443, DTLS and SCTP, video and audio tracks, input injection into `:99` (X access granted to `rtc` only), the data-channel bridge to deskd; `CAP_NET_BIND_SERVICE` only; `MemoryMax=128M` | boot |
| `desk-agent` | agent | Agent runtime (§9.8) | boot |
| `desk-xorg`, `desk-audio` | kiosk | Xorg dummy driver on `:99` (modes up to 1920×1080), PulseAudio null sink | from first Browser use after boot, then kept running on primaries (§6.1) |
| `desk-browser` | kiosk | Chromium kiosk (§6.1), `MemoryMax=2.5G` | from first Browser use after boot, then kept running on primaries, frozen while nobody views it (§6.1, ADR 0045) |
| `desk-stream` | stream | Capture and encode (GStreamer, its own user so a Chromium sandbox escape can't feed clients' decoders): `:99` → x264 + Opus → RTP to desk-rtc over a Unix socket (`docs/interfaces/desk-runtime.md` §8.2); `MemoryMax=384M` | while a Browser window is visible (paused but warm in minified mode, §6.2; a cropped region while a live island is in view, §7.4) |
| `desk-guildhost` | guild | Guild host service (§4.5): guild spaces, channel logs, files, access lists, member-desk sync over the desk-to-desk channels desk-rtc bridges to it; `MemoryMax` 1G (host S) / 2G (host M); CPU weight below the leader's interactive units | host and standby Guild Desks only |

`desk-stream` is an `ON_DEMAND` release: `ma-update` only restarts it when it is already running (its `run` execs the release's `desk-stream` with `stream.conf`), because deskd decides when it runs ([ADR 0034](decisions/0034-desk-media-path.md)). deskd starts and stops the on-demand units through `/run/desk/units.sock`, a narrow root helper limited to those units (`docs/interfaces/desk-runtime.md` §8.3). Memory caps (desk-browser 2.5G, desk-agent 768M, deskd 512M, desk-stream 384M, desk-rtc 128M) bound each service; they sum to more than the 4 GiB of a t4g.medium on purpose, with zram absorbing bursts, and the benchmark gate (§11) checks for OOM kills.

On a member Guild Desk, `desk-browser` runs headless for minified mode only, and `desk-xorg`, `desk-audio` and `desk-stream` never start (ADR 0025, Q12). Before minified mode ships (Phase 3), and under Q16's default, a member Guild Desk runs no `desk-browser` at all. On every desk, when no client is watching, deskd pauses `desk-stream` and freezes Chromium (ADR 0045); desk-agent runs under a CPU quota (ADR 0027).

### 10.4 Data location and privacy
- **Volumes** (sizes by desk class, §11.1): root gp3, disposable, replaced on upgrade, 10 GB on every class (Platform's draft sizes it to hold a hibernation image that v1 doesn't use, §13.2). The root holds no persistent content by design (temp files go to tmpfs or `/data`), but a running desk's RAM and any stray temp file could reach it, so Platform protects it like the data volume: same encryption, never snapshotted, and replaced roots deleted (`DeleteReplacedRootVolume=true`, §10.6). Data gp3 at `/dev/sdf`, ext4 label `ma-data`, mounted at `/data`, kept on termination, grows online (primary 10 GB, member Guild 8 GB, host S 30 GB, host M 50 GB; Phase 0 measures real use and may ask for more). **Since 2026-11-06 every desk's data volume is the platform setting `pricing#current` `deskDataVolumeGb`, 32 GB, the "32 GB storage drive" the site promises (platform ADR 0094); the class sizes here are the design's, and a guild host's is revisited when hosts are built.** `/data` holds `desk/` (SQLite and blobs), `browser/` (profile, cookies, downloads), `agent/`, `rtc/` (the desk's DTLS certificate, mode 0600, user `rtc`), `keys/` (relay identity keys), `guild/` (guild hosts and member replicas), `state/`.
- **Encryption:** EBS encryption on both volumes and snapshots. Platform's draft uses `aws/ebs`; Desk recommends one customer-managed key per member (KMS bills each key monthly) so account closure can crypto-shred volumes and snapshots. Platform decides; either meets Desk's v1 needs.
- **Backups:** DLM daily snapshots of the data volume, keep 7; guild host and standby data volumes also every 6 h, keep 4 (§4.5.6). Whether a session survives a crash-consistent snapshot is unproven until TD-110. Upstream Chromium uses a rollback journal by default, not WAL (read, not run). Restore = Platform swaps a volume created from a snapshot onto the stopped desk; a restored guild host then takes back newer changes from members' replicas. The root volume is rebuilt from the image.

| Platform can see | Platform cannot see (by design) |
|---|---|
| Desk existence, owner, size, state, running hours, public IP, image version | Notebook, Chat and Agent content; browsing history, cookies, passwords, page contents |
| Volume and snapshot sizes and times; hypervisor CPU, network and disk metrics; egress bytes | All client ⇄ desk traffic: Browser pixels and audio, input, minified pages, app data (DTLS and DTLS-SRTP end to end, also through TURN) |
| Signaling metadata: which client tab connects to which desk and when, SDP (the desk's address and ports, both DTLS fingerprints, codecs), the source IP of each gateway WebSocket; for relayed sessions, TURN's view of client and desk addresses and byte counts | The client's network addresses inside SDP (the client sends no candidates); anything inside a desk session |
| Heartbeat: activity times, versions, badge **counts**; LLM usage totals per key | Agent prompts and replies (desk → provider directly); in-guest logs |
| Relay metadata: from desk, to desk, time, size | Relay and attachment contents (sealed to the recipient desk) |
| LLM key metadata (provider, label, last 4) and envelopes | LLM keys in plaintext (only desk roles can decrypt) |
| Guild roster, roles and host assignment; which member desk syncs with the guild host and when; sync byte counts | Guild content, space names and item titles (they live on the guild host and members' Guild Desks, §4.5) |
| **Deliberate access, not routine:** break-glass SSM Run Command runs as root on a running desk and can read its memory, decrypted keys and logged-in browser sessions (§10.2); recorded outside the desk, alarmed and shown to the member | Nothing on a running desk is technically hidden from root; this is a disclosed, audited capability |

**Honest limits.** The AWS account owner controls KMS key policies, the EC2 API and SSM, and Platform serves the SPA's JavaScript. So "cannot see" means the data is not collected, and any access would be deliberate and audited (once Platform's CloudTrail trail and alarms exist: §13.1 need #15); it does not mean access is impossible. Platform must also leave VPC Flow Logs (or log REJECT only) and Route 53 Resolver query logs off for desk subnets; either would record which sites members visit. True zero access needs a later opt-in "vault mode" (LUKS on `/data` with a key only the member holds); its costs are lost data if the key is lost and a desk (and its agents) that can't start until the member unlocks it (Q2). Platform also relays signaling and signs desk tokens, so Platform as a whole (token signing, the desk-fingerprint registry and the gateway together) could stand in for a desk, as it could by shipping a malicious SPA; the gateway alone cannot (§4.2.2).

### 10.5 Idle, stop and wake (24-hour rule)
The owner (2026-11-04): "We should not be shutting down desks that are idle, unless they have been inactive for more than 24 hours." Decision: [ADR 0026](decisions/0026-idle-24-hour-rule.md) (supersedes ADR 0013).
- **Who decides:** Platform's sweeper (every 5 min). deskd reports signals in its heartbeat (§4.2.9) and never powers the VM off.
- **A desk is active** while any of these holds (each desk judged on its own):
  1. **Client present** (`client_connected`): at least one open desk session. Platform's gateway session count is authoritative (it opens and closes every session, including its 60 s resume hold); the desk's `client_connected` is the cross-check. A client closes a desk's sessions once its tab has been hidden for 60 min and the desk isn't playing sound (ADR 0038), or after 24 h with no input even if the tab is visible (§4.2.8), so a forgotten tab doesn't keep a desk awake. Watches and badge counts never count.
  2. **User input** (`last_user_input_at`): keyboard, pointer, scroll or touch on that desk's panel or windows, including scrolling a minified page rendered in the Desk app (the client reports it on `ctl` as `ACTIVITY`, at most once a minute); file transfers in progress. Playing media isn't a signal of its own: a visible tab already holds a session, and 24 h with no input closes it (§4.2.8), so a forgotten tab looping a video can't run through the 100 GB allowance at 1 to 4 GB/h. The desk then stops 24 h after that session closed.
  3. **Agent work** (`agent_tasks_running`, `agent_last_activity_at`): any run in *running* that made progress in the last 60 min (`agentStallMinutes`). Unattended runs count; *waiting_approval* and idle schedules don't. No cap tied to the last input.
  4. **Guild host only** (`guild_activity_at`): the latest member input in guild spaces, forwarded by member Guild Desks, or a guild agent run in progress (§4.5.4).
- **Not activity:** watches, keepalives and ICE consent checks, guild replication, inbound messages, Platform health checks, snapshots, image updates, and a pre-warm no client attaches to.
- **Rule:** stop after **24 h** with none of the above (`autoStopMinutes = 1440`) for every desk kind, Guild Desks and hosts included. There is no shorter threshold or default for member desks; a member can still put a desk to sleep by hand (§3.14). Dev/test desks keep their own rules (§11).
- **Sweeper inputs** (per desk): `last_active_at` = the latest of client presence, `last_user_input_at`, agent progress while running, and `guild_activity_at`; desk state; `autoStopMinutes`; pre-warm start time; heartbeat freshness. Missing heartbeats never stop a desk by themselves; they flag fleet health.
- **Graceful stop:** `prepare_stop` with `stopAt` ≥ 60 s ahead and a `stopReason`; deskd checkpoints runs, Chromium saves its session, SQLite flushes, then `ready_to_stop`. Plain stop, never hibernation ([ADR 0007](decisions/0007-desk-image-debian-arm64.md)). Under the 24-hour rule an idle stop never interrupts a connected member.
- **Wake:** Platform `connect` (or `start`) only. Focusing a desk or opening one of its apps wakes it; opening the Desk app pre-warms stopped desks in the current scope (stopped again after 10 min if no client attaches); the All overview, watches and badges never wake a desk. Any guild member's Guild Desk may wake the guild host (rate-limited, §4.5.4).
- **Waking state** (§3.14): Platform streams `desk.progress` with the phases `queued`, `starting`, `booting`, `connecting`, `ready` or `failed`; the client adds its own "opening" step (session, ICE and DTLS, first summary). The status line shows the step; there is no ETA, and the segmented bar is planned and not built yet. Meanwhile badges show the last counts, composers capture drafts in memory, and on a trusted device Notebook opens cached pages and queues edits (`y-indexeddb`).
- **Cold-start targets** (measured in Phase 0, *pending*; there is no certificate or DNS step):

| Step | Expected |
|---|---|
| EC2 stopped → running (`starting`) | 10–20 s |
| Debian boot to deskd ready and hello (`booting`) | 10–20 s |
| Gateway link up (`connecting`) | ~1 s |
| Session: signaling, ICE + DTLS, first summary ("opening"; via TURN) | ≤ 1.5 s (2–3 s) |
| **Stopped → app-ready** | **p50 ≤ 35 s; p95 ≤ 60 s (B17)** |
| First Browser open after wake | Last snapshots ≤ 250 ms under "restoring" (B18); live tabs after session restore, +3–5 s |
| First boot of a new desk (format, keys, hello) | 60–120 s |
| Guild Desk restored from a retained snapshot | First reads are slower (EBS lazy load); deskd pre-reads the volume in the background |

- **While stopped**, a desk's data is offline: no Notebook, Chat or Agent access; its agents and schedules don't run; its incoming relay messages queue; its guild replica stops syncing and catches up on wake. The canvas shows the last badge counts.

### 10.6 Image updates
- **Mechanism (Platform ADR 0015):** `CreateReplaceRootVolumeTask` with the new image and `DeleteReplacedRootVolume=true` (otherwise the old root is kept), at the desk's next stop (replace, wait for hello, stop) or at the next start. Under the 24-hour rule an always-on desk may need a scheduled upgrade stop, announced with `prepare_stop` and `stopReason: upgrade` (§3.14). Instance ID, ENI, IP, role and data volume stay.
- **Rollout:** candidate (smoke test) → canary (the owner's desks, 24 h) → waves 10% / 50% / 100%, gated on hello and heartbeat health.
- **Rollback:** repoint the channel and replace the root again with the previous image, or put the kept root back, after the preflight: `docs/runbooks/restore-rehearsal.md` Part 2, not yet run.
- **Data schema changes:** deskd migrates `/data` at boot. When a release raises `data_schema`, Platform snapshots the data volume first. deskd refuses to run against a newer schema than it knows, so a downgrade can't corrupt data.
- **Between images:** unattended-upgrades applies Debian security fixes; any root drift is wiped at the next replacement. Daemon-only updates without an image rebuild (for `pricing.json` and curated recipe packs) come later through a signed update channel.
- **Resize:** stop, modify the instance type, start (Platform).

---

## 11. Sizing

**Primary minimum for Personal and Work: t4g.medium** (2 vCPU Graviton2, 4 GiB), unlimited credits, 2 GiB zram, tab discarding ([ADR 0014](decisions/0014-minimum-instance-t4g-medium.md)). **Guild Desks are sized by role** ([ADR 0025](decisions/0025-guild-desk-sizing.md)): a member's Guild Desk is lighter (t4g.small; t4g.micro without a Browser in Phase 2 under Q16's default) and the guild host is sized by member count. **Every instance choice in this section is pending the benchmark** (t4g.medium, c7g.large, c7g.xlarge; running now); a later pass fills in measured numbers. If the gate fails, memory → t4g.large; frame rate, latency or CPU → c7g.large.

**Planning basis: always-on (730 h/month).** Under the 24-hour rule (§10.5) a desk used daily never stops. **Minified mode (the default) renders pages locally in the Desk app**, so the desk encodes video only in normal mode; that keeps average CPU near the t4g baseline and egress low, and it is what keeps t4g.medium plausible. Until minified mode ships in Phase 3, every browsing hour is streamed. Decision: [ADR 0027](decisions/0027-always-on-cost-envelope.md).

| Component (one active desk, Browser open) | RAM | CPU while active |
|---|---|---|
| OS, desk-rtc, chrony, journald, SSM agent | ~200 MB | ~0 (desk-rtc < 5% while streaming) |
| deskd and Docker (Java 21 + SQLite), estimate pending measurement | 350–650 MB | < 5% |
| desk-agent (1–2 agents, remote LLMs) | 150–400 MB | bursts |
| Xorg dummy + PulseAudio | ~100 MB | ~2% |
| Capture + encode (GStreamer, x264 + Opus, 60 fps) | 150–250 MB | 30–70% of a vCPU in motion (more at 60 fps; *pending benchmark*); 5–10% static |
| Chromium, member tabs (3–6, software raster) | 1.0–2.0 GB | 20–100% of a vCPU scrolling heavy pages |
| Chromium, agent tabs (0–2 on primary desks, §9.8) | 0–0.6 GB | bursts |
| Minified-mode overhead (Phase 3; spike target ≤ 150 MB per minified page, 1–2 active) | 0–0.3 GB | ≤ 1 CPU-second per page |
| **Total** | **~1.8–3.2 GB typical; up to ~3.8–4.1 GB worst case** | **~1–1.5 vCPU at peak; ~0.1–0.3 on average** |

- **Memory honesty:** the worst case is at or above the usable RAM of a 4 GiB instance, so t4g.medium relies on zram, tab discarding and the per-service caps (§10.3; all Chromium rows share desk-browser's 2.5 GB cap). t4g.large is the likely memory fallback until the gate runs.
- **Why not smaller for Personal and Work:** t4g.small (2 GiB) runs out of memory once Chromium, the stream and an agent all run; 1-vCPU types starve the encoder. A member Guild Desk fits on t4g.small only because its Browser never streams (ADR 0025).
- **Why burstable fits:** the t4g.medium baseline is 0.4 vCPU, above the expected 24-h average (~0.1–0.3 vCPU) for a desk that encodes only in normal mode. Desk contains CPU surplus on the VM instead of throttling (ADR 0027). Platform's daily switch to `standard` would make the desk sluggish, so Desk asks that it not be used on primaries or hosts (§13.2).
- **Benchmark gate** (Phase 0; scripted Playwright sessions from a US-East client). t4g.medium passes if:
  - it meets the owner's bar (§2.2) for normal mode at 1280×800 and at 1080p, measured with the photon probe:
    - 60 fps encoding, delivering ≥ 58 fps on average with zero freezes while scrolling (B11);
    - input to photon p50 ≤ 90 ms and p95 ≤ 150 ms from a US-East client (B12).

    30 fps is no longer a passing option; its numbers are recorded only for the congestion step. The member Guild Desk size (t4g.small) runs the memory and minified-mode tests; it doesn't stream (Q12). t4g.micro runs the no-Browser memory test (deskd, desk-agent and the replica in 1 GiB plus zram; Q16).
  - no out-of-memory kills with 6 member tabs, 2 agent tabs and a busy agent;
  - mean CPU ≤ 0.4 vCPU (the baseline) over a 30-min typical session, with surplus cost reported for a heavy session.

  Memory fail → t4g.large. CPU, frame-rate or latency fail → a non-burstable size (c7g.large, or Platform's Steady m7g.large).

### 11.1 Egress
Rates below are **pending the benchmark**.

| Traffic | Assumed rate |
|---|---|
| Normal mode, 60 fps, 1280×800 H.264 | ~2 Mbps average ≈ 0.9 GB/h |
| Video in normal mode | ~3 Mbps ≈ 1.35 GB/h |
| Minified mode (MDoc and re-encoded images, rendered locally) | ~0.05 GB/h |
| App data channels (Notebook, Chat, Agent) | < 0.05 GB/day |
| Guild sync, host ↔ member desk | ~0.2 GB per member-month plus files |
| TURN-relayed session | as direct |

- **Typical primary desk:** 2 h/day of browsing, 25% in normal mode → ~16 GB a month. **Heavy:** 4 h/day, 50% normal including video → ~75 GB.
- Every hour moved from normal to minified mode saves egress and most of the encode CPU. Platform meters egress per desk.

Cost, price and margin tables are kept out of the public repository for now.

---

## 12. Phased roadmap

MVP = canvas + Notebook + streamed Browser + Agent chat on **one** desk. Phases 2 and 3 touch different parts of deskd and can overlap; the order shows priority.

### Phase 0 — Foundation
**Scope**
- Repo scaffolding: web app (Vite, React, TypeScript, Konva), deskd and desk-agent skeletons (Java 21, Spring Boot), `image/` recipe, CI (lint, typecheck, Vitest, Playwright E2E), runbook drafts.
- Contracts agreed with Platform in `ma-platform/docs/contracts/` (0.2.0 already follows the hybrid): `connect` with `cnf` and `deskIdentity`, the gateway's client and desk WebSockets, session and signaling messages, revocation and refresh, TURN credentials, the heartbeat fields (§4.2.9), wake progress, the layout doc, the image contract, and Desk's remaining asks (§13.2).
- Image v0: Debian 13 arm64 + kiosk Chromium + capture/encode + desk-rtc + deskd (hello, gateway link, heartbeat), built by Platform's pipeline. Chromium session-restore test (§6.1).
- **Connectivity spike (desk-rtc):** Pion ICE-lite on udp/443 and tcp/443; the eight channels with framing and priority scheduling; Hocuspocus over `collab`; resume after an ICE restart and after a new connection; interop in current Chrome, Firefox, Safari and iOS Safari; through coturn on TLS/443 with UDP blocked. A dev signaling shim, a dev JWKS and `deskctl`.
- Benchmark gate at 60 fps (§11) and the minified/distiller spike (§7.8).

**Exit criteria**
- A dev desk launched by Platform from image v0 passes hello, holds its outbound gateway link, and accepts a desk session from the dev web app: token verified against JWKS, `cnf` and both DTLS fingerprints enforced, all eight channels open. A peer with a valid token but a different certificate, and a peer with no signaled session, get nothing. The same works through TURN with UDP blocked.
- Session setup on a running desk (`session.open` to channels open) p95 ≤ 1 s from US-East; an ICE restart after a network switch keeps every channel and subscription.
- A test page in the web app plays the desk's stream over the hybrid WebRTC connection from US-East and meets the quality bar (§2.2, B11–B13), as measured by the photon probe.
- Benchmark results recorded at the owner's bar (§2.2); ADRs 0014 and 0025 accepted or amended, Platform told the final sizes, with measured numbers (Q9 if larger primaries are needed).
- Spike report with Stage A and Stage C go/no-go and thresholds.
- Debian's Chromium restores tabs and session cookies after a graceful stop of the browser stack and of the desk.

### Phase 1 — MVP: one desk
**Scope**
- Platform provisions one desk (Personal) per tester.
- Canvas Phase 1 cut (§3.13), on one live desk.
- Notebook: editor, Tab and Temporal views, versions, search, images and attachments, single-page export.
- Browser: normal mode streamed at 60 fps (the only browsing mode until Phase 3, Q8), audio out, clipboard, downloads and uploads, TURN fallback, widget snapshots; Chromium kept running, frozen while nobody views it (ADR 0045), and the cold-open snapshots (§6.1, B18).
- Agent: chat with the manager agent; Anthropic and OpenAI chat; desk-encrypted key flow (this desk only); limits; notebook and memory tools; approvals and taint rules; durable runs; audit log; provider badges. No browser tools, so the MVP does not depend on the spike's outcome.
- Ops: activity heartbeat and the 24-hour rule, wake with the waking state, image rollout and rollback, data snapshots and restore, support sessions, runbooks.
- Quality: the perf CI (`perf-pr`, nightly `perf-desk`, and `perf-device` before releases) and the dev performance overlay (§2.2); all three themes (§3.12); the waking, reconnecting and stopping states (§3.14).

**Exit criteria**
- The owner uses the MVP desk as his daily Personal desk for 2 weeks with no lost data and no blocking bugs.
- Every Phase 1 budget in §2.2 (B1–B6, B11, B12 and B14–B18) holds on the reference devices. B13 (minified to normal) needs minified mode and is a Phase 3 criterion.
- The perf CI is green and blocking.
- All three themes pass the contrast test and axe-core.
- Privacy review: no desk content in Platform logs, databases or browser storage beyond the layout doc and counts; packet captures at the gateway and at TURN show only signaling and ciphertext.
- Agent: works with both Phase 1 providers; a limit stops a run at its cap; every egress needs approval; the injection fixture passes.
- An image upgrade, a rollback and a snapshot restore have been rehearsed on a dev desk, following the runbooks.
- Measured per-desk cost within ±20% of §11.

### Phase 2 — Primary desks and Chat
**Scope**
- Work desk, and the Guild Desk for members in a guild. Scopes, cycling, sleeping and waking, counts for stopped desks from gateway pushes.
- Wide and large widgets, Tidy up, the trusted-device cache, Notebook ZIP export, and the forced-colors token set (§3.12). The dark theme moved to Phase 1.
- Chat with `local` and `ma` transports over the sealed relay, guild channels on the guild host, agent chat tools.
- Key reuse across desks; image generation; account-wide key limits.
- Agent: staff agents; Google and xAI; agent-context browser tools (§9.6), with `click` and `type` only if the spike's action proxy had zero wrong-target actions (§7.2).
- Guilds (§4.5), opened only once the owner answers Q16: Guild Desk lifecycle tied to membership; member Guild Desk class (t4g.micro under Q16's default) with no Browser app, whose tile offers "Open on Personal" until minified mode ships (§7.4); guilds of at most 10 members until the host gate passes at N = 25 on t4g.large or a Savings Plan is in place (Q16's default); guild host with shared notebooks and guild channels; member replicas over desk-to-desk sync; roles and space access lists; waking-host behavior; the host load gate (ADR 0025). Files, guild agents, standbys and handover may slip to Phase 3 if Phase 2 runs long.

**Exit criteria**
- Member-to-member messages arrive across stopped desks through the relay, and a review confirms Platform holds only their ciphertext and no guild content.
- Switching among 3 desks stays within the camera budget (≤ 480 ms per move); stopped desks show correct counts without waking.
- Up to 5 external test members onboarded without operator help.
- Two members co-edit a guild page through the host. A member whose host is asleep keeps reading and writing from the replica and converges on wake. A removed member's session drops within 5 s and the replica is purged. The same holds for a member whose Guild Desk was stopped at removal: its next boot, and an export of the retained desk, purge `/data/guild` before any session opens, and the export contains no guild data. The host load gate passes at the tier's N.
- The injection fixture passes with the browser tools enabled.

### Phase 3 — Minified browsing
**Scope**
- Stage A distilled view and Stage B islands (a crop of the warm encoder, §7.4) and curated recipes (~20 sites), if the spike said GO (PARTIAL or NO-GO follow §7.8).
- The minified-only Browser on member Guild Desks (t4g.small, no islands), if Stage A is GO and the owner accepts that class (Q16). On a NO-GO they keep "Open on Personal" (Q12).
- A signed update channel for recipe packs and `pricing.json`.

**Exit criteria**
- On the 30-site suite in production: usable ≥ 70%, task success ≥ 90%, zero wrong-target actions, automatic fallback on every expected-fallback site.
- Measured egress per browsing hour drops against Phase 1.
- Minified mode meets B7–B10 and B13 on the reference devices and in the nightly `perf-desk` runs.

### Phase 4 — Desk team and integrations
**Scope**
- Manager delegation to staff agents; A2A between the member's own desks with grants.
- Custom desks: create, size and cost preview.
- Scheduled agent runs with Platform wake-on-schedule.
- Chat email transport (member's own IMAP/SMTP).
- Stage C LLM recipes (if GO).
- Notebook tables and Markdown import.

**Exit criteria**
- A delegated task and an A2A ask each complete with the confirmations and audit entries §9 requires.
- A custom desk can be created at a chosen size with its monthly cost shown first.
- Email threads land in the right person's channel and survive a stop/start.

### Later (unscheduled)
Matrix and SMS transports; Web Push; vault mode; locked notes; automatic guild host failover; guilds above 25 members (host L); Stage D generative UI; more regions and IPv6; an MA-paid LLM option; audit anchoring; driving the member's logged-in browser with per-task grants; embeddings memory.

---

## 13. What Desk needs from Platform

Platform's contracts 0.2.0 already follow the approved hybrid (no desk origins, no cookies, no desk TLS or DNS; `cnf`-bound 5-min tokens; ICE-only desk ports). The needs below are written against them; §13.2 lists what Desk still asks Platform to change, including the contract conflicts logged in `~/ma-coord/system-eng.md` ("Contract 0.2.0 objections"). Objection 1 (guild host sync) is needs #24 and #26; objection 7 (the per-tab certificate) is the `auth.md` row.

### 13.1 Prioritized needs
P0 = blocks the phase; P1 = needed within it; P2 = nice to have.

| # | Need | Phase | Priority |
|---|---|---|---|
| 1 | **Desk network (hybrid):** desk SG inbound udp/443 and tcp/443 from anywhere (ICE only, terminated by desk-rtc), nothing else; no inbound HTTPS and no TLS proxy, CloudFront or ALB in front of desks; no per-desk DNS, certificate or Let's Encrypt; SSM, no SSH; public IPv4 readable from IMDS (as `desk-endpoint.md` §1) | 0 | P0 |
| 2 | **Gateway, client side** (`gateway.md` §2): one WSS per SPA tab with no credentials at upgrade; `watch` with `desk.state`, `desk.progress`, `desk.badges` and `desk.downtime`; `session.open` → `session.opened` with TURN credentials; the `signal` relay (Desk-owned payload, never parsed or logged; Desk sends no client candidates); `session.refresh`, `session.resume`, `session.close`; Guild Desk add and remove pushed on membership change; per-user rate limits | 0 | P0 |
| 3 | **Desk tokens** (`auth.md` §4): `connect` with `clientDtlsFingerprint` → ES256 token with `cnf.x5t#S256` and `exp − iat = 300`, plus `deskIdentity`; `start: false`; JWKS; revocations pushed to the desk link (`revoke`) and repeated in heartbeat responses. Desk adds `ma_support_apps` on support tokens (#19) and uses a per-tab client certificate held in memory (§4.2.2) | 0 | P0 |
| 4 | **Desk identity, outbound link and heartbeat:** per-desk IAM role (Platform ADR 0011) for SigV4 `/v1/agent/*`: hello (with `deskApi`, versions, DTLS fingerprints `[current, next]`, relay public keys), config, key envelopes, usage, relay, guild roster. Presigned-STS auth for the desk's gateway WSS: `ready`, session accept and reject, `signal`, `badges`, `revoke` and `notify` (config, keys, guild, support, heartbeat; Desk adds `inbox`). The heartbeat with the §4.2.9 fields, including `guild_activity_at` | 0 | P0 |
| 5 | **Launch template** per §10: Debian 13 arm64 image, IMDSv2 hop limit 1, no key pair, unlimited credits, hibernation not enabled (plain stop, §10.1), root volume 10 GB encrypted like the data volume and never snapshotted, separate data volume (`/dev/sdf`, `DeleteOnTermination=false`, size by class, §11), no hostname and no user data (IMDS tags `DeskId`, `UserId`, `DeskKind`, `Env`), cost-allocation tags | 0 | P0 |
| 6 | **Image pipeline:** Image Builder building `ma-desk/image/` from a tagged release; candidate smoke test via SSM Run Command; a build log Desk can read | 0 | P0 |
| 7 | **Dev desks** for the benchmark gate and spike (t4g.medium, t4g.large, c7g.large, ~2 days each), plus TURN for dev (#28) | 0 | P0 |
| 8 | **SPA hosting:** history fallback, immutable hashed assets (including the render-blocking `theme-boot.js`, §3.12), strict CSP (`connect-src` Platform API, auth and the `wss://` gateway only; `img-src 'self' blob: data:`; `frame-src 'self'`; no desk hosts), web manifest, no third-party scripts; `/v1/client-config` cohort loader | 1 | P0 |
| 9 | **Desk list and lifecycle:** `GET /v1/desks` with kind, VM state, `phase` and last badge counts, pushed over the gateway WebSocket (#2) with polling as the fallback (2 s transitioning, 60 s otherwise); idempotent start | 1 | P0 |
| 10 | **Layout doc:** `GET/PUT /v1/me/desk-layout`, JSON ≤ 64 KB, ETag/If-Match, deleted with the account. Desk adds `prefs.theme` inside the layout (no contract change). The layout also stores app positions and sizes, each desk's stacking order and the desk size in units; the document is opaque to Platform, so none of this is a contract change (§3.8, [ADR 0062](decisions/0062-desk-surface-etched-name-and-cleanup.md), [ADR 0064](decisions/0064-desk-stacking-hidden-items-and-etch.md)) | 1 | P0 |
| 11 | **LLM key envelopes** (amends Platform ADR 0018): desk role may `GenerateDataKey` and `Decrypt` on `ma-llm-keys` with `UserId` context = its tag; `/v1/agent/llm-keys` PUT/GET envelope and LIST metadata; assignment per desk; DELETE with step-up; `dropKeyIds` pushed (`notify keys`) and in heartbeat responses; usage-total reports | 1 | P0 |
| 12 | **Idle sweeper, 24-hour rule** (§10.5): `autoStopMinutes` 1440 for every desk kind including Guild Desks and hosts, with no shorter default; activity = the gateway's session count (authoritative) or `last_user_input_at`, or agent progress while running (`agentStallMinutes` 60, no input-tied cap), or `guild_activity_at` on hosts; replication and watches never count; ≥ 60 s graceful stop; 10-min stop for untouched pre-warmed desks; per-desk cold-start history for ETAs | 1 | P0 |
| 13 | **Data volume backups:** DLM daily, keep 7 (hosts also every 6 h, #35); snapshot before schema-raising releases; restore flow | 1 | P0 |
| 14 | **Rollout and rollback:** release channels, root replacement with `DeleteReplacedRootVolume=true`, `deskApi` gating, upgrade stops announced with `stopReason: upgrade` | 1 | P0 |
| 15 | **Audit trail** (Platform's own P0 plan; a multi-region CloudTrail trail now exists): an account or org CloudTrail trail with management events, including KMS, delivered to immutable storage (S3 Object Lock, log-file validation); alarms on `ma-llm-keys` policy changes, on attaching a desk volume to another instance, creating a volume from a desk snapshot or snapshotting a root volume, and on SSM `SendCommand` to desks; each such event shown to the affected member as access history | 1 | P0 |
| 16 | **Session contract:** 401 semantics and refresh, sign-out, **step-up re-auth** (fresh `auth_time`), deep links for account, billing and desk size | 1 | P1 |
| 17 | **Metering and cost view under flat pricing:** per-desk egress (EC2 data transfer by tag, since the gateway no longer sees media), CPU surplus, IPv4 hours and EBS GB-months; TURN bytes per user from coturn; per-account cost alerts on CPU surplus and egress; no `standard`-mode throttle guard on primaries or hosts | 1 | P1 |
| 18 | **Privacy config:** no VPC Flow Logs (or REJECT only) and no Resolver query logs on desk subnets; no SSM Default Host Management; `__Host-` cookies for Platform; the gateway and TURN log no SDP bodies or desk tokens, and TURN keeps only per-user byte counts | 1 | P1 |
| 19 | **Support sessions** (Platform ADR 0009) with `scope=support` tokens carrying the member's per-app grant (`ma_support_apps`, §4.2.12) and a `notify support` push so every open session shows the notice; allow-listed SSM documents only, every run recorded per need #15 | 1 | P1 |
| 20 | **Desk egress** (amends Platform ADR 0014 and `contracts/desk-endpoint.md`, which allow only TCP 80/443 and UDP 443): from Phase 1, outbound TCP to any port, so the real Browser reaches sites on non-standard ports (nftables still confines the `agent` user to deskd's proxy); if Platform prefers an allow-list, a stated list plus a documented limitation. By Phase 4 at the latest, TCP 993, 465 and 587 for the email transport (§8.4) | 1 | P1 |
| 21 | **Desk key directory:** register X25519/Ed25519 public keys per desk, with rotation; lookup by chat address and guild roster | 2 | P0 |
| 22 | **Sealed relay** (`desk_inbox` holding only ciphertext): POST ≤ 256 KB envelopes, pull + ack, 30-day expiry, sender authorization (shared guild, accepted contact, or the member's own A2A grant), rate limits, pending counts for stopped desks, a `notify inbox` push to a running recipient's gateway link | 2 | P0 |
| 23 | **Ciphertext attachment drop:** presigned PUT/GET, ≤ 25 MB, 30-day lifecycle | 2 | P0 |
| 24 | **Guild roster and host assignment for desks:** members (guild-scoped `memberId`s), roles, Guild Desk ids and identity keys, `hostDeskId` and `standbyDeskIds`, with ETag; a `notify guild` push to the Guild Desks and the host on every membership, role or host change (the hybrid contract's Guild Desk push) | 2 | P0 |
| 25 | **Chat address registry** and invite links (needs Q3) | 2 | P0 |
| 26 | **Guild host access and desk-to-desk sessions** (replaces Platform ADR 0019's S3 share store and `/v1/agent/shares*` for content; §4.5, §4.2.15): `guild_access` tokens (ES256 via JWKS, `aud` = host deskId, `sub` = `memberId`, `ma_desk`, `gid`, `grole`, `scope=guild_member`, `cnf`, `exp − iat ≤ 300`) minted over SigV4 for a member's Guild Desk after a roster check, with the host's DTLS fingerprints; a signaling relay between two desks' gateway links, only between a member's Guild Desk and its guild's host or standbys; up to 25 member-desk sessions plus standbys on a host, outside the 4-client-session limit; members may wake their guild's host (≤ 1 per 10 min each); ADR 0019's "no one connects to another member's desk" amended to allow member Guild Desk → guild host service | 2 | P0 |
| 27 | **Desk events and wake progress** on the gateway (#2): keep the `desk.progress` phase names stable (`queued`, `starting`, `booting`, `connecting`, `ready`, `failed`, `stopped`); `stopReason` also in `desk.state` and the desk object, so §3.14 can say why and offer the fix; desk add, remove and rename; Guild Desk appear and disappear on membership change. Optional (P2): `expectedSeconds` per phase from fleet medians | 1 | P0 |
| 28 | **TURN:** coturn on TLS/443 (`turns:turn.…:443`, shared t4g.small), per-session credentials (1 h) in `session.opened` and `session.refreshed`, peers limited to running desks' public IPv4s (private, link-local and VPC ranges denied), ≤ 20 Mbit/s per allocation (60 fps normal mode needs ~2.5–4 Mbit/s), per-user relayed-byte metering, alarms on the host's NetworkOut and CPU, and the relayed share in fleet health (target ≤ 5%). Needed for dev in Phase 0 | 1 | P0 |
| 29 | **Signed update channel** for daemon builds, `pricing.json` and recipe packs without an image rebuild | 3 | P1 |
| 30 | **Custom desks:** create/rename/delete, size catalog with monthly price | 4 | P0 |
| 31 | **Wake-on-schedule** per desk | 4 | P1 |
| 32 | **A2A grants:** registry with step-up; relay enforcement of grant, rate and expiry; optional wake of the target | 4 | P1 |
| 33 | Later: per-member KMS key for EBS; Web Push without content; SMS webhook relay; relay block list; audit chain anchoring; vault-mode key relay; more regions and IPv6; MA-paid LLM keys or workspaces (never a content proxy) | Later | P2 |
| 34 | **Guild Desk classes** (amends Platform ADR 0033): member class t4g.small (t4g.micro without a Browser in Phase 2 under Q16's default); host S (≤ 10 members) t4g.large and host M (11–25) t4g.xlarge instead of a fixed c7g.xlarge; standbys (guild Officers in that guild) ≥ host S; a Founder-tier account that is a plain member of another guild gets the member class; resize on role change or tier crossing at a graceful stop. All pending the benchmark and the host load gate | 2 | P0 |
| 35 | **Host backups and handover:** host data volumes 30 GB (S) / 50 GB (M) with snapshots every 6 h (keep 4) plus daily keep 7; leadership handover promotes the new host and waits for `host_ready` before retaining the old leader's Guild Desk; unhealthy-host alert to the leader and guild Officers after 10 min without heartbeat while members are active; "make my desk the host" for guild Officers | 2 | P1 |
| 36 | **Savings Plan** (needs the owner, Q15): 1-yr EC2 Instance Savings Plan, No Upfront, t4g family, ~70% of the always-on floor, after ~3 months of history; before that, slices bought from Phase 2 start as paying members join (Q16's default) | 2 | P1 |
| 37 | **Control-path latency budgets** (the quality bar, §2.2 B14 and B17): `connect` p95 ≤ 500 ms; gateway events pushed ≤ 500 ms after a state change; first `desk.progress` ≤ 1 s after `connect` on a stopped desk; `session.open` → `session.opened` p95 ≤ 300 ms; the signal relay adds ≤ 50 ms p95 | 1 | P1 |
| 38 | **CI test desk:** a narrow credential (e.g. GitHub OIDC → a role, or a scoped Platform API token) that lets Desk's CI start, stop and connect to one `DeskKind=test` desk nightly (~1 h/night, ~$1–2/month from Desk's dev budget) and read its CPU and egress metrics, for `perf-desk` | 1 | P1 |
| 39 | **Browser capability per size:** `/v1/desk-sizes` carries `browserModes` (`normal+minified`, `minified` or `none`), set from the benchmark, so the SPA can make the Browser minified-only where a size can't stream within the bar (member Guild Desks, Q12), or show "Open on Personal" where a desk has no Browser (member Guild Desks before Phase 3, Q16) | 2 | P1 |

### 13.2 Where Desk asks Platform to change its draft
Both designs are drafts pending the owner. These are the deltas for the coordinator.

| Platform draft | It proposes | Desk asks | Why |
|---|---|---|---|
| ADRs 0013 and 0030, contracts 0.2.0 (the hybrid) | Gateway for control and signaling only; one WebRTC connection per session; Desk owns the `signal` payload and the data channels | **Agree.** Inside Desk's payloads: the client sends no ICE candidates (§4.2.1), and input is split into a lossy `input` channel for pointer motion and a reliable `keys` channel (§4.2.3), a refinement of the contract's "input (unreliable data channel)". No Platform change | Matches the approved hybrid; lossy keys would stick or drop characters |
| ADR 0010 + `auth.md` §4 (tokens) | 5-min `cnf`-bound token; one persistent client certificate per browser profile in IndexedDB; sessions close at `exp + 30 s` | Add `ma_support_apps` to support tokens (need #19). Desk keeps the client certificate per tab, in memory (no `connect` change). Let an `owner` session outlive its token by up to 30 min while both `api.` and `gw.` are unreachable (logged on the desk; never for support) | Least-privilege support; nothing persists on shared machines; a Platform outage shouldn't cut off a member who is working |
| ADR 0011 + image contract | Per-desk role; "only the agent user can reach IMDS" | Keep the role. IMDS for root and `desk` (deskd) only. Desk's `agent` user is the LLM runtime and must **not** reach IMDS | Naming clash; prompt-injection and SSRF path to credentials |
| ADR 0009 (support access) | Consented `scope=support` sessions; allow-listed SSM break-glass | Support tokens carry a per-app grant that deskd enforces, never key management (need #19); every SSM run recorded in CloudTrail and the Object Lock audit and shown to the member (need #15) | A support token would otherwise open every window; SSM is root on a running desk, and an IAM allow-list can be bypassed by account admins |
| ADR 0014 + `desk-endpoint.md` (ingress, egress) | Inbound UDP 443 and TCP 443 (ICE); egress TCP 80/443 and UDP 443 | Ingress: agree (need #1). Egress: any outbound TCP port from Phase 1, mail ports by Phase 4 (need #20) | Sites on other ports, and IMAP/SMTP |
| ADR 0015 + image contract | Amazon Linux 2023, hibernation-capable | Debian 13 arm64; plain stop, no hibernation (§10.1); `DeleteReplacedRootVolume=true` on root replacement; root 10 GB; no TLS listener at all (tcp/443 is ICE-TCP) | AL2023 has no Chromium package; a hibernation image or a kept old root would hold decrypted keys and content outside `/data`, readable without a logged `kms:Decrypt` |
| ADR 0016 + `agent.md` (auto-stop) | 24 h default; gateway session count authoritative; `clients.lastInputAt` shown but not counted; agent busy clamped to 10 min with a 60-min stall guard | Keep the gateway count authoritative and the agent rule. Also count `last_user_input_at` (input the client handles locally, e.g. scrolling a minified page) and, on guild hosts, `guild_activity_at`; replication never counts; 1440 min for every desk kind, Guild Desks and hosts included (§10.5) | The owner's 24-hour rule; reading a long page must not stop the desk; a guild host must stay up while its members work |
| ADR 0018 (LLM keys) | Member API role encrypts (plaintext passes through the API) | deskd encrypts; the key reaches the desk only over its DTLS data channel; the API never receives plaintext; the desk role gets `GenerateDataKey` | Under the hybrid, Platform's API would be the only place a key's plaintext touched Platform |
| ADR 0019 + `guild-sharing.md` | Read-only per-item grants; snapshots in S3 with SSE-S3; grant titles visible to Platform; no one connects to another member's desk | Guild host model (§4.5): content lives on the leader's Guild Desk and members' replicas; Platform keeps roster, roles, host assignment, guild tokens and signaling; the S3 share store and `/v1/agent/shares*` go unused; member Guild Desks may connect to the guild host service (needs #24, #26) | Platform-blind guild data (MA could read SSE-S3 snapshots); co-editing, history and backfill; the owner's "the officer's guild desk is the host" |
| ADR 0022 (credit mode) | A daily surplus guard switches a desk to `standard`; surplus metered to the member | No throttle guard on primaries or hosts; Desk contains surplus on the VM (ADR 0027); Platform alerts per account. Platform ADR 0032 bills surplus to the member as an extra; Desk agrees, as long as no throttle comes with it | Throttling makes the Browser sluggish, which the owner rules out |
| ADR 0023 + ADR 0033 | Root sized for hibernation; member Guild Desk t4g.small; every Founder-tier Guild Desk a fixed c7g.xlarge host | Root 10 GB on every size; host tiers by member count (t4g.large ≤ 10, t4g.xlarge 11–25, c7g.xlarge or m7g.xlarge only if the host gate fails); only the guild's leader hosts, guild Officers are standbys, and a Founder-tier member of another guild gets the member class (need #34); the member class on t4g.micro without a Browser in Phase 2 (Q16); plan everything always on (ADR 0027) | Small guilds don't need 4 fixed vCPUs; hosts need RAM for N members |
| `desk-endpoint.md` + `agent.md` (graceful stop) | Close a peer connection within 5 s when the desk leaves `running` (`prepare_stop`, `stopping`, `retaining`) | Keep desk sessions open from `prepare_stop` until `readyToStop` or `stopAt`, then close them; push `desk.stopping {stopAt, reason}` to watching tabs | §3.14's countdown toast and the apps' autosave and Yjs flush need the open session; closing at `prepare_stop` can lose unsynced Notebook edits |
| `auth.md` (step-up) | Step-up sign-in with `prompt=login` issues a new `sid` | Keep `sid` across step-up; or let deskd accept a token with the same `sub`, `scope` and `cnf` and a newer `auth_time` as the same session (§4.2.2) | Check 7 would reject the step-up `AUTH`, so LLM-key actions fail mid-session, and so would every other tab's next refresh |
| `auth.md` §4 (`connect`) | `start` defaults to `true`, also when a client calls `connect` only to refresh its token | Desk sends `start: false` on every refresh (§4.2.1); Platform documents that a refresh never wakes a desk and never returns `409` during downtime | A refresh must not wake a stopped desk or fail inside a Give Back window |
| `desks.md` + ADR 0034 (Give Back) | `desk.downtime` reaches only watching tabs; the desk itself gets only the ≥ 60 s `prepare_stop` | `nextDowntime` in config and heartbeat; a desk `notify downtime` ≥ 30 min ahead; the active task count in `desk.downtime`; a few minutes of `stopAt` grace while `activeTasks > 0` | Unattended agent runs need to checkpoint or finish before a scheduled stop |
| `gateway.md`, `desks.md`, ADR 0032 (gaps) | No push when the user's desk list changes; `deskIdentity` only from a `connect` after `ready`; the 100 GB allowance doesn't say what counts | A `desks.changed` push to the user's connections (need #27); the last-known `deskIdentity` in a waking `connect`'s 202 (it survives a stop on the data volume); desk-to-desk guild sync bytes don't count toward the 100 GB (§11.1) | A new Guild Desk would otherwise appear only after the 60 s poll; a wake shouldn't need a second `connect`; sync isn't internet egress |
| `desks.md` lifecycle (`stopped → retaining: left guild`) + `export` | A Guild Desk stopped at removal goes straight to `retaining` with its guild replica; export restores that snapshot to a temporary desk | Optional: start a stopped Guild Desk briefly on removal so deskd purges `/data/guild` before the retention snapshot. Desk's own rule needs no change: deskd purges on any boot where config `guild` is `null`, export mode included, before it accepts a session (§4.5.1) | A removed member must never download guild content through Export |

---

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **WebRTC reachability:** some networks block UDP or raw TCP; relayed video runs over TCP and can stutter under loss; TURN egress is Platform's cost ($0.09/GB) | ICE tries udp/443, ICE-TCP tcp/443 and TURN over TLS/443 at once; path type reported without content; a "relayed" note in the Browser window; TURN sized from the measured relayed share |
| 2 | **t4g.medium may fail the 60 fps bar** (Graviton2 encode on heavy pages; worst-case RAM ~3.8–4.1 GB against 4 GiB). If the gate forces c7g.large or t4g.large for primaries, the flat price needs another look | Minified-local default keeps encoding rare; benchmark gate; Chromium frozen while nobody views it (ADR 0045), zram, tab discarding, per-service memory caps; escalate prices to the owner with the result (Q9), never throttle; 3-yr Savings Plan as the last resort |
| 3 | **Streaming egress** (~$0.08 per normal-mode hour at 60 fps, ~$0.12 per video hour) rivals compute | Minified mode rendered locally is the default from Phase 3; the stream pauses when hidden or minified (a live island streams only its crop); per-desk egress metering; the 100 GB allowance with billed overage |
| 4 | **Datacenter IP reputation:** CAPTCHAs and blocks; Google may refuse sign-in | Launch Chromium normally (not automation-flagged); measured in the spike; no v1 fix |
| 5 | **Prompt injection** and approval fatigue | Rule of Two taint (with U and S set, every browser action that can carry data is confirmed; S-free sub-runs for prompt-free browsing), confirmed egress, payload-hash approvals, agent's own browser context, injection fixture in CI |
| 6 | **Privacy overclaim:** the AWS account owner controls KMS, EC2 and SSM (root on running desks), and Platform serves the SPA's JavaScript; no CloudTrail trail exists yet; the AWS root account has no MFA yet | "Operator-blind and audited" wording (Q2) with SSM root disclosed; CloudTrail trail with immutable storage and alarms on key-policy changes, desk-volume attach or snapshot restore and SSM commands, shown to the member (need #15); root MFA (Platform) |
| 7 | **desk-rtc is our own code** on Pion, replacing Neko v3 (a small-maintainer project) | We own it outright; Pion is widely used and pinned; the GStreamer capture stays close to upstream GStreamer; the Phase 0 connectivity spike proves it before Phase 1 |
| 8 | **Wake latency** (p50 ~35 s) works against anti-stress | The 24-h rule keeps daily desks awake; pre-warm on app open; a waking UX that never blocks, with phase progress and capture-while-waking (§3.14); Chromium session restore |
| 9 | **Canvas performance** at 4K/DPR 2 on low-end laptops (shadows, `Konva.Text`), and theme switches re-caching chrome | Pre-rendered chrome, LOD, culling, hit-graph pause, adaptive DPR; re-cache visible buckets first (§3.12); blocking perf CI and reference-device runs (§2.2) |
| 10 | **Browser-tab limits** on the "only OS" goal: reserved shortcuts, Esc exits full screen, no element full screen on iPhone | Shift+Esc, Keyboard Lock, visible controls, installable manifest |
| 11 | **Data loss** if snapshots are missing; a guild host with no Officers has no standby | DLM daily keep 7, hosts also every 6 h; member replicas push docs and signed messages back after a restore; standbys in guilds with Officers; guild export; restore rehearsal |
| 12 | **Minified quality** on poorly built sites, wrong-target actions on real accounts, and per-click latency that may feel sluggish | Local rendering (scroll, find and typing never wait); patches streamed with no fixed settle; optimistic toggles; instant Back from history; the MA-overhead budget (B8) in the Stage A go/no-go; confidence check and auto-fallback; zero-wrong-target rule; islands; curated recipes |
| 13 | **LLM spend estimates** drift from provider invoices; consumer subscriptions don't work | Reserve/settle, labelled estimates, provider-side spend limits, clear onboarding copy |
| 14 | **Dependency churn:** AI SDK breaking majors; Yjs/Hocuspocus moving parts | Exact pins, own message schema; fallback to prosemirror-collab with the same schema |
| 15 | **Gateway dependency and exposure:** new sessions and wakes need the gateway; each desk exposes udp/443 and tcp/443 to the internet | Established sessions survive a gateway outage (§4.2.2); desk-rtc answers only signaled ICE usernames and nftables rate-limits new sources; no hostnames or certificates to enumerate; a recycled IP cannot impersonate a desk |
| 16 | **Konva text limits** (RTL, emoji, CJK line breaking) in widget previews | Trim previews; icon-only fallback; full text lives in DOM windows |
| 17 | **Chromium attack surface:** an exploit plus sandbox escape would expose that desk's data and decrypted keys | Sandbox, uid separation, nftables, weekly images, unattended security updates |
| 18 | **Interaction scope** (camera, scopes, moving and resizing, windows, phone paging, three themes, the waking states) is the largest UX build cost | Phase 1 cut on one desk; wide/large widgets, custom segments and the forced-colors set deferred; one token set for all themes |
| 19 | **Provider logo use** must follow each brand's guidelines | Nominative use, monogram fallback |
| 20 | **Single region** adds 70–100 ms for West Coast and EU users | Later: more regions; local rendering keeps the minified view's scrolling and typing unaffected |
| 21 | **Data-channel transport quirks:** one large SCTP message can hold the association, message-size limits differ by browser, mobile browsers suspend connections in the background, and Hocuspocus runs over a custom transport | 16 KiB frames, desk-side priority scheduling and shallow queues (§4.2.6); resume by ICE restart or HELLO (§4.2.7); Phase 0 interop spike; fallback to plain y-protocols sync |
| 23 | **Guild host as a hub:** a stopped, resizing or lost host blocks live co-editing and guild agents | Member replicas serve reads and queue writes; any member can wake the host; standbys and handover; the 24-hour rule keeps active hosts on |
| 24 | **Noisy guild** degrades the leader's own 60 fps Browser on the host | cgroup CPU weights, guild agent concurrency caps, file-transfer token bucket; host load gate |
| 25 | **Desk-to-desk connections** widen the trust surface (member desks reach the leader's VM) | Only `desk-guildhost` answers guild channels; separate Unix user and data directory; 5-min `cnf`-bound guild tokens; SDP signed with desk identity keys |
| 26 | **Normal mode can't feel native:** ~90 ms vs ~40 ms for a local browser, and softer text on HiDPI screens | Minified mode is the default from Phase 3 (Phases 1–2 are stream-only); local cursor; 60 fps with intra refresh; honest copy in the UI; the owner decides (Q8) |
| 27 | **60 fps encoding** raises encode CPU and egress against v1's 30 fps option and may not fit t4g.medium | Benchmark gate at 60 fps; the stream pauses in minified mode and when hidden; congestion step to 30 fps; sizing fallbacks per §11 |
| 28 | **Perf CI noise** on GPU-less shared runners causes false failures or missed regressions | Relative budgets on calibrated runners, median of 5 runs; absolute checks only on reference devices before release |
| 29 | **No field telemetry** hides slowdowns on members' machines | Nightly real-desk runs at several RTTs; numbers-only reports that members choose to send (Q11) |
| 30 | **Dusk's narrow contrast range** (4.6–8.1:1) leaves little headroom for new tokens (charts, tags, highlights) | A contrast unit test over every allowed pair; the lint rule bans color literals; new colors are added as semantic tokens in all three themes at once |

---

## 15. Open questions (blocking)

Only questions that block a phase. Each has a default that applies until the owner answers.
- **Already answered by the owner:** the 24-hour idle rule; the Guild Desk exists only while in a guild and is mandatory while in one; the Founder's Guild Desk hosts the guild; the "never sluggish" bar; Light, Dusk and Dark; flat pricing.
- **Resolved:** Q1 (may Platform see desk traffic in plaintext?) by the approved hybrid contract: no; client ⇄ desk traffic is DTLS end to end (§4.2). Q7 (guild item sharing) by the guild host model: guild content lives on desks, not in Platform (§4.5). Q14 (guild space access) by the owner, 2026-11-06: the leader and guild Officers can open every guild space, and the guild UI says so; members' private notes stay on their own Guild Desk (§4.5.2).

| # | Question | Default | Blocks |
|---|---|---|---|
| Q2 | Is "operator-blind by design, and audited" an acceptable privacy claim for v1, or must MA be unable even in principle to read desk data and keys? | Operator-blind and audited: Platform services can't decrypt, every key decrypt is logged, policy changes alert (once Platform's CloudTrail trail exists, need #15). Disclosed: AWS account admins can also run root commands on a running desk through SSM break-glass, which would expose its memory, decrypted keys and logged-in sessions; every such command is recorded outside the desk and shown to the member. No "zero-knowledge" claim. A user-held-key "vault mode" is a later opt-in (if the key is lost the data is gone, and the desk can't start until unlocked). | Phase 1 |
| Q3 | When another member messages you, which desk receives it: does each desk get its own chat address, or one address per member routed to a single desk? | Each desk has its own address (`owner.personal`, `owner.work`, `owner.guild`). Guild-desk addresses are visible to guildmates; Personal and Work are shared only by invite link. | Phase 2 (Platform's address registry) |
| Q4 | Approve up to $20 of LLM spend on a capped dev API key for the minified spike? And for logged-in site tests, **you need to create a throwaway Google test account yourself** (Claude may not create accounts). | Yes to both. Without them the spike runs with no Stage C tests and no logged-in apps, and the Stage C decision slips. | Phase 0 |
| Q5 | Notebook "tabs": section dividers (a notebook splits into tabs, each holding pages) or sticky bookmarks on individual pages (a page can carry several)? | Section dividers: notebooks → tabs → pages, with "Add tab at this page" splitting at that page, shown as a binder with colored edge tabs. | Phase 1 |
| Q6 | The mockup shows Work selected with Personal still visible. Should Personal / Work / Guild hide the other desks and their badges (a filter), or keep every desk visible and just zoom to the chosen one? | Filter: other desks fade out and go quiet apart from a dot on their segment; a scope with one desk zooms straight to it; All shows every desk. | Phase 2 |
| Q8 | Normal (streamed) mode can be smooth (60 fps) and quick (≤ 150 ms p95 from US-East), but not as immediate as a local browser (~40 ms), and text is softer on HiDPI screens. **In Phases 1 and 2 it is the only way to browse:** minified mode, rendered locally at native speed, ships in Phase 3, and only if the spike says GO (on a NO-GO, normal mode stays the main mode, with an opt-in Reader view). Is that acceptable, both for Phases 1–2 and as the fallback after them? | Yes. The only stronger option is a GPU desk (G quota 0, about $384 or more per month per desk), which the flat prices can't carry. | Phase 0 |
| Q9 | If the benchmark shows Personal and Work need c7g.large (or t4g.large), what then? | Stay on t4g.medium if minified mode meets the bar and normal mode is close; otherwise bring you a price change with the benchmark data. Never throttle desks. | Phase 0 |
| Q10 | Which machines and browsers must meet the "never sluggish" bar? | A reference laptop and phone: a 2020-class Windows laptop (Intel Core i5 10th gen, integrated graphics) and an iPhone 12-class phone. Chrome/Edge and Safari are first-class; Firefox must work and meet the local-UI budgets, without Keyboard Lock. | Phase 1 |
| Q11 | Should the Desk app ever send performance numbers automatically, to catch slowdowns on members' machines? | No automatic telemetry. Members can choose to send a numbers-only performance report (no URLs or content) with a support request. | Phase 1 |
| Q12 | A member's Guild Desk is lighter, so it never streams normal mode. Until minified mode ships (Phase 3, if Stage A is GO) it has no Browser at all, and on a NO-GO it never gets one; from Phase 3 its Browser shows minified pages only, with no islands. When a member needs a browser in guild work, what happens? | Offer "Open on Personal" as a visible one-click step, from the Guild Desk's Browser tile and from any page or island that needs normal mode; the member's Guild Desk never streams. Upsizing it to stream (t4g.medium) would mean a larger machine for every member in a guild. | Phase 2 |
| Q13 | Who pays for shared guild agents' LLM use? | The leader assigns one of their own keys to guild agents, with a guild monthly cap and per-member daily run caps. Members can also run their own agents on their own Guild Desk with their own keys. Keys are never shared. | Phase 2 |
| Q15 | Commit to a 1-year AWS Savings Plan once there are ~3 months of usage? You pay it for 12 months even if members leave. | Yes: No Upfront, t4g family, part of the always-on floor. Q16 covers the months before it. | Public launch |
| Q16 | Guilds open in Phase 2, before Q15's Savings Plan can exist. How should guilds be sized from day one? (a) Member Guild Desks on t4g.micro with no Browser ("Open on Personal"). (b) Cap guilds at 10 members (host S) until the host gate passes on t4g.large at N = 25 or a Savings Plan is in place. (c) A guild add-on price. (d) Buy the Savings Plan from Phase 2 start in slices as paying members join. | (a), (b) and (d). | Phase 2 (guilds open) |
