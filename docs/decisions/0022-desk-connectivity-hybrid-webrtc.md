# 0022. Desk connectivity: the hybrid (Platform gateway for control and signaling, one WebRTC connection per desk for all content)

**Status:** Proposed (pending the owner's approval of design v1.1)
**Date:** 2026-11-04

## Context
- ADR 0010 chose direct TLS to each desk: Caddy with a Let's Encrypt certificate per desk, a per-desk DNS name rewritten on every start, a desk-host session cookie, and tcp/443, udp/443 and tcp/8443 open to the internet. Platform's first draft put a TLS-terminating gateway in front of desks, which would see desk traffic in plaintext and carries no UDP; its ADR 0030 then proposed WebRTC media direct with app traffic through the gateway.
- The coordinator approved the extended "hybrid" contract (`~/ma-coord/system-eng.md`, "Contract: hybrid", 2026-11-04). It resolves design Q1: Platform may not see plaintext. Platform's contracts 0.2.0 (`gateway.md`, `auth.md` §4, `desk-endpoint.md`) already implement it.
- The owner's quality bar: "if it feels slugish or slow thats a nogo". A TCP proxy or a VNC-class path is ruled out for the Browser.
- Every desk has its own public IPv4 (Platform ADR 0014), so clients can reach desks directly over UDP without per-desk names or certificates.

## Decision
- **Gateway (Platform)** carries only control: desk list and state, wake with progress events, WebRTC signaling, TURN credentials, badge counts and pushes to desks. Platform's REST API keeps sign-in, `connect` (desk tokens), account data, the layout doc (metadata, ADR 0005), the heartbeat, LLM key envelopes, usage totals, the sealed relay and the guild roster; none of these is client ⇄ desk traffic.
- **One WebRTC PeerConnection per (client tab, desk)** carries everything else: the Browser's video and audio (DTLS-SRTP) and eight data channels for input, minified pages, Notebook, Chat, Agent and transfers (DTLS; layout and protocol in ADR 0023). Platform relays only SDP, inside its `signal` messages, unread.
- **The desk listens for nothing but ICE.** No inbound HTTPS, no TLS certificate, no DNS name, no Let's Encrypt, no Caddy. Security group inbound: udp/443 and tcp/443 (ICE-TCP), both terminated by desk-rtc; SSM, no SSH. deskd binds only Unix sockets and keeps one **outbound** WSS to the gateway (signaling and pushes), authenticated with a presigned `sts:GetCallerIdentity` made with the per-desk IAM role (Platform ADR 0011). The role also signs SigV4 calls; IMDS stays reachable only by root and `desk`.
- **desk-rtc:** a Go service on Pion v4 that replaces Neko v3, modeled on its WebRTC, capture hand-off and input design and sharing no code with it. It runs ICE-lite on one UDP port (443) and a passive ICE-TCP listener (443), with the public IPv4 as its 1:1 NAT address. It answers STUN only for sessions deskd created, schedules channels by priority, bridges the data channels to deskd over a Unix socket, and holds no tokens or data.
- **Authentication** (design §4.2.2):
  - Each SPA tab makes one ECDSA P-256 `RTCCertificate`, held in memory, and uses it for all its desk connections.
  - `connect` takes the certificate's fingerprint and returns Platform's desk JWT (ES256 via JWKS, `exp − iat = 300`, `cnf.x5t#S256` = the certificate's thumbprint) plus `deskIdentity`, the desk's DTLS fingerprints from its hello.
  - On `session.open`, the gateway and then deskd verify the token offline: `typ`, `kid`, signature, `iss`, `aud` = `DeskId` tag, `ma_owner` = `UserId` tag, `nbf`/`exp` ±30 s, `scope`, revocations, `jti` replay. deskd also requires the offer's DTLS fingerprint to equal `cnf`.
  - The client rejects an answer whose fingerprint isn't in `deskIdentity`.
  - Sessions re-authenticate every ~4 min (`session.refresh`, or in band on `ctl` while the gateway is down), with the same `sub`, `sid`, `scope` and `cnf`. The gateway pushes revocations to the desk, which closes matching sessions at once.
- **The client never sends ICE candidates.** desk-rtc learns them as peer-reflexive, so signaling exposes no client addresses.
- **Fallback:** ICE tries udp/443 direct, ICE-TCP tcp/443 direct and TURN over TLS/443 at once. TURN is Platform's coturn with per-session credentials (1 h). The CDP-screencast compat mode is dropped.
- **Several desks:** one PeerConnection per connected desk; data-only for background desks; none for stopped or out-of-scope desks, whose state and badge counts come from the gateway; at most 8 per tab and 4 per desk (Platform's limits).
- **Desk-to-desk:** a member's Guild Desk syncs with its guild host over the same machinery, with a `cnf`-bound `guild_access` token and the member desk as the full-ICE offerer (ADR 0024, design §4.2.15).

## Consequences
- Platform never handles desk content in plaintext, including LLM keys at entry. A compromise of the gateway alone cannot read or inject desk traffic. Platform as a whole could (token signing, the fingerprint registry and the gateway together), as it could with a malicious SPA bundle; this is disclosed under "operator-blind and audited" (design §10.4).
- Gone: per-desk certificates and the Let's Encrypt rate limit, desk hostnames in Certificate Transparency logs, the recycled-IP certificate risk, cookies and CSRF on desk origins, and port 8443. A port scan of a desk gets no answer.
- Established sessions survive a gateway outage; new sessions and wakes need the gateway.
- The gateway still opens and closes every session, so its session count stays the authoritative client-activity signal; the desk's heartbeat cross-checks it (ADR 0026).
- New code to own: desk-rtc (our own service on Pion, replacing Neko) and the channel protocol, with interop tests in Chrome, Firefox and Safari. Hocuspocus needs a transport adapter (ADR 0015). There is no curl-able surface, so `deskctl` and a dev signaling shim are needed. Estimated +2–3 weeks over plain Neko integration, proven in the Phase 0 connectivity spike.
- TURN costs Platform a shared t4g.small (~$16/month) plus $0.09/GB relayed. Relayed video runs over TCP and can stutter under loss.
- A 5-minute token means about one `connect` per open desk per tab every 4 minutes.
- Supersedes ADR 0010. Amends ADRs 0006 (API surface), 0007 (no Caddy; desk-rtc in the image), 0008 (ports, fallback, desk-rtc), 0009 (kiosk blocklist), 0011 (what Platform sees; `/data` contents), 0012 (key entry path), 0015 (collab transport) and 0017 (context).
- Desk asks of Platform's contracts (design §13.2): `ma_support_apps` on support tokens, a per-tab in-memory client certificate, an `owner` session surviving its token by up to 30 min while both `api.` and `gw.` are down, and an `inbox` push topic.
- Alternatives rejected:
  - Direct TLS per desk (ADR 0010): certificates, DNS, CT exposure, three open ports.
  - A TLS-terminating gateway: plaintext at Platform, no UDP, sluggish.
  - Media-only direct: two transports and two auth models, with app traffic in plaintext at the gateway.
  - Separate WebRTC endpoints for media (Neko) and data (deskd): two connections per desk, against the contract's "one WebRTC connection".
