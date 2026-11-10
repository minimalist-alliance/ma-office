# 0010. Desk connectivity and auth: direct TLS to the desk VM, Platform desk tokens, per-desk role

**Status:** Superseded by [0022](0022-desk-connectivity-hybrid-webrtc.md)
Why: the coordinator-approved hybrid contract (2026-11-04) replaces direct TLS, per-desk DNS, Let's Encrypt and the desk cookie with a control-only gateway and one end-to-end WebRTC connection per desk.
**Date:** 2026-11-04

## Context
- "Platform sees metadata only" requires that desk traffic (notes, chats, agent prompts, LLM keys at entry, the browser stream) is not decrypted by Platform infrastructure. WebRTC media needs UDP.
- Platform's draft ADR 0013 routes all desk traffic through CloudFront and one gateway that terminate TLS, with no UDP. Its ADR 0010 defines desk tokens and a `__Host-ma_desk` session cookie; its ADR 0011 gives each desk an IAM role.
- The drafts proposed several auth schemes: token in the first WebSocket message, one-time WebSocket tickets, bearer fetches for blobs. Browsers can't set `Authorization` on `<img>` or WebSocket requests. The VM draft proposed no instance profile; the Agent draft and Platform want per-desk roles.

## Decision
- **Direct path:** the client connects straight to the desk's public IPv4 at an opaque hostname `d-<id>.desk.minimalistalliance.com`. Platform upserts the A record on each start and deletes it at the start of each stop, before the public IP is released, so no record points at a recycled IP; CAA allows only Let's Encrypt and, if feasible, pins each desk's ACME account and TLS-ALPN-01. DeskLinks stop retrying once Platform reports a desk stopping or stopped. Caddy on the VM gets a Let's Encrypt certificate (TLS-ALPN-01) stored on `/data`. Security group inbound: tcp/443, udp/443, tcp/8443 only; no desk-to-desk traffic. No TLS-terminating proxy, CloudFront or ALB in the data path. If Platform needs a gateway, it must be SNI passthrough for TCP, with udp/443 direct. Escalated to the owner as design Q1.
- **Client auth:** Platform's desk token (ES256, `aud` = desk, `sub`, `scope`, `sid`, plus `auth_time`, ~10 min) is posted to `https://<desk>/_ma/session`; deskd verifies it offline against cached JWKS and sets the `__Host-ma_desk` cookie (HttpOnly, Secure, SameSite=Strict). The cookie authenticates REST, WebSockets, images and stream signaling. deskd checks `Origin` on state changes and WebSocket upgrades. Revocations arrive in heartbeat responses. Without a session, deskd answers only the rate-limited `/_ma/session` and a bare `/healthz` (details for localhost and Platform's `scope=health` token only).
- **Desk identity:** the per-desk IAM role (Platform ADR 0011) with SigV4 to `/v1/agent/*`. IMDS is reachable only by root and the `desk` user; the `agent` (LLM runtime) and `kiosk` (Chromium) users are blocked by nftables.

## Consequences
- Platform never handles desk content in plaintext; WebRTC works without TURN.
- Supersedes the drafts' first-message auth, WebSocket tickets and bearer blob fetches; supersedes the VM draft's "no instance profile". Requires changes to Platform's draft ADRs 0010, 0011 and 0013 (design §13.2).
- Each desk needs a public certificate: Let's Encrypt's ~50 new certs/week per domain must be raised before Phase 2. CT logs make every desk hostname publicly enumerable; the labels are opaque (no member names).
- Each desk is exposed to the internet on three ports; the SG comes only from a code template. This trade-off is part of design Q1.
