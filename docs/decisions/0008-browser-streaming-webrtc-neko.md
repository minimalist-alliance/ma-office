# 0008. Browser streaming: WebRTC via Neko v3, CDP screencast as compat fallback

**Status:** Proposed (pending the owner's approval of design v1)
**Date:** 2026-11-04
**Amended:** 2026-11-04 by [0022](0022-desk-connectivity-hybrid-webrtc.md) (transport, fallback) and [0030](0030-browser-modes-local-minified-60fps-normal.md) (60 fps, encoder, input)

## Context
- The Browser app shows a real Chromium running on the desk VM. Egress at $0.09/GB costs about as much as compute; the minimum instance has no GPU; the stream must play in a React window in any modern browser and work on typical networks without extra infrastructure.
- Options compared: Neko v3, Selkies-GStreamer, a custom Pion/GStreamer server, CDP `Page.startScreencast`, noVNC/KasmVNC, Amazon DCV.

## Decision
- Stream with **Neko v3**'s capture and encode (GStreamer), run natively under systemd: H.264 constrained baseline (x264 ultrafast/zerolatency) at **60 fps** with intra refresh (ADR 0030), Opus 64 kbps audio output. desk-rtc (ADR 0022), the desk's single WebRTC endpoint, modeled on Neko and sharing no code with it, sends the video and audio tracks on the same PeerConnection as the data channels: UDP mux on udp/443, ICE-TCP on tcp/443, 1:1 NAT = the desk's public IP. Neko's own signaling and HTTP server are not used.
- Stream **only while a Browser window is open, visible and in normal mode**; parked windows and minified mode pause it.
- **Fallback ladder:** udp/443 → ICE-TCP tcp/443 → TURN over TLS/443 (Platform's coturn, ciphertext only). The CDP-screencast compat mode is dropped.
- Audio output only; no microphone or camera in v1.

## Consequences
- ~0.9 GB/h of egress for normal browsing at 60 fps (*pending benchmark*); TURN on TLS/443 run by Platform as the fallback.
- desk-rtc (our own service on Pion, replacing Neko) is ours to maintain; the custom Pion/GStreamer exit path becomes the main path, modeled on Neko's design.
- Alternatives rejected: Selkies (expects TURN, project in flux), noVNC/KasmVNC (5–20 Mbps on scroll and video), DCV (closed, WebSocket-only browser client, no Debian), screencast as primary (3–8 Mbps, no audio or native popups).
