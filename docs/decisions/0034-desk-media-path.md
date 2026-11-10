# 0034. Desk media path: `desk-stream` as its own user, RTP over a Unix socket

**Status:** Accepted for the owner's desk (Milestone 2, `docs/interfaces/desk-runtime.md` §8, 2026-11-05)
**Date:** 2026-11-05
**Amends:** [0008](0008-browser-streaming-webrtc-neko.md) (capture and encode move out of Neko into `desk-stream`; the keyframe policy) and [0030](0030-browser-modes-local-minified-60fps-normal.md) (intra refresh, the encoder's starting point); design §6.2, §10.3

## Context
- Milestone 2 puts the Browser's video on the desk's one WebRTC connection (ADR 0022). Capture and encode run in GStreamer on the desk VM; `desk-rtc` (Go, `CGO_ENABLED=0`) forwards the RTP.
- Chromium renders untrusted web content, and a renderer sandbox escape gives its attacker Chromium's user. Whatever that user can write into the media path reaches every client's video decoder.
- `deskd` runs in a Docker container with no capabilities (ADR 0040), so it can't use polkit or `systemctl` itself to start and stop the stream.
- Input-to-screen latency is the quality bar (B12, ADR 0028). The first build of the encoder missed it under load.

## Decision
- **`desk-stream` runs as its own user `stream` (1104),** not `kiosk`. Chromium is `kiosk`, so on one uid a sandbox escape could feed arbitrary bytes to every client's decoder. `desk-xorg` grants `stream` X access, as it does `rtc`.
- **RTP crosses a Unix stream socket, `/run/desk-media/stream.sock`, not a loopback port.** Web content can send to loopback itself (`fetch`, ICE to `127.0.0.1`, from Chromium's network process), so nftables would be the only guard; a Unix path can't be named from web content at all. The directory is `0750 rtc:stream`, and `desk-rtc` also checks `SO_PEERCRED` and closes any peer whose uid isn't 1104. Frames are RFC 4571 (length-prefixed RTP). Writes block and a one-frame leaky queue ahead of the encoder drops raw frames, so a stalled `desk-rtc` can't build up latency.
- **`/run/desk/units.sock` replaces the polkit rule** of design §10.3: `deskd` can't use polkit from a container with no capabilities. A root helper, `desk-units`, runs once per connection (socket activation), accepts only uid 1100 (`SO_PEERCRED`), takes `start` or `stop` for four named units (`desk-xorg`, `desk-audio`, `desk-browser`, `desk-stream`), and runs `systemctl` with no shell.
- **Default capture is `yuvconv` to NV12, not `videoconvert` to I420.** `yuvconv` is a small GStreamer element over libyuv (NEON), shipped in the image. `videoconvert` missed B12 under load. Measured input-to-screen with video playing, p50 / p95:

  | Converter | Idle | Under load (video playing) | Scroll CPU |
  |---|---|---|---|
  | `videoconvert`, I420 | 83 / 93 ms | 100 / 120 ms | 88% |
  | `yuvconv`, NV12 | 54 / 78 ms | 75 / 89 ms | 74% |

  The encoder settings live in `stream.conf` in the `desk-stream` release, so tuning them is a release, not code or an AMI: x264 `ultrafast`, `zerolatency`, no B-frames, 2 threads, 8 Mbps, `key-int-max=240`.
- **Conditions of the measurement, and a caveat.** c7g.large, 1080p60, 8 Mbps, 30 ms RTT, 60 trials per run. The server side was `desk-rtc` against **`fake-deskd`** (a stand-in for `deskd`), and the client played a **test page** (the harness also has a real-page phase). These are not results from the real `deskd` or from real browsing. Raw results: `desk-rtc/test/stream/results/` (`final-base.json`, `final-nv12.json`). B12 on the real desk is still to be measured.
- **Playout:** the answer carries the `playout-delay` extension at 0, 0 where the offer has it, and the client sets `receiver.jitterBufferTarget = 0`. Measured jitter buffer was under 1 ms.
- **Known limit: no congestion control yet.** The configured bitrate is sent whatever the link: no transport-wide CC, no resolution ladder, no "reduced quality" chip. A link below the bitrate loses packets and stalls. The capped-profile work (design §6.5, §11) closes this.

## Consequences
- A Chromium sandbox escape reaches `kiosk` files but not the media socket, `desk-stream` or clients' decoders.
- ADR 0008: capture and encode are `desk-stream`'s own GStreamer pipeline (x264 constrained baseline and Opus, as it said) run as a separate unit, not Neko's process. `desk-rtc` still carries the tracks. The keyframe policy: a keyframe every 240 frames (4 s at 60 fps) and one when a viewer is added or a client asks, over the socket's `keyframe` line.
- ADR 0030: it asked for intra refresh instead of periodic keyframes. Milestone 2 doesn't use intra refresh (the config has none); it sends periodic and on-request keyframes. The 60 fps, `jitterBufferTarget = 0` and warm-encoder decisions stand.
- `desk-stream` is an `ON_DEMAND` release (an `ON_DEMAND` file at its root): `ma-update` only restarts it when it's already running, because `deskd` decides when it runs (`deskd` starts it through `units.sock`).
- The `yuvconv` plugin is built into the image; a release may also ship plugins in `gst-plugins/` beside `stream.conf`.
- The 8 Mbps figure is the benchmark's, above the 4 Mbps VBV cap design §6.2 had. Bandwidth shaping is still ahead (§11, the capped-profile study).
