# 0033. Normal-mode stream profiles and member desk size

**Status:** Proposed (pending the owner's approval of design v1.1; measured by the follow-up benchmark, see `docs/benchmarks/2026-11-follow-up.md`)
**Date:** 2026-11-05

## Context
- The owner's rule: "never sluggish" means 60 fps and low input latency. Bandwidth savings must never cost either.
- The first benchmark showed t4g.medium failing at 1080p60 (99% CPU, 54 fps scroll, 40 fps video) and c7g.large passing at $55/month. B12 (input to photon p50 <= 90 ms, p95 <= 150 ms) was recorded as a pass at 126 ms, which was wrong.
- The follow-up used a dedicated client box with 30 ms RTT and a stand-in for the JVM backend (not a real `deskd`), and tested CPU tuning, three bandwidth techniques and a capped profile.

## Real-stack result (2026-11-05, supersedes this ADR's B12 findings)
The numbers below this section were measured on Neko. `docs/benchmarks/2026-11-real-stack.md` repeated them on real `deskd`, `desk-rtc` and `desk-stream`, at 30 ms RTT, 2 to 3 repeats per row. Input-to-frame ms, loaded, p50/p95:

| Size and config | Page fps scrolling | B12 | B13 warm to live (off to live) | Result |
|---|---|---|---|---|
| c7g.large, 1080p, 8 Mbps CBR | 59.8 | 74.6/89.6 | 50/58 (287) | Pass |
| t4g.medium, 1080p, 8 Mbps CBR | **35** | 91.8/113 | 55/66 (384) | Fails B11 on the page; B12 p50 misses by 1.8 ms |
| t4g.medium, this ADR's default, 1280x800 | 59.7 | 73.6/86.2 | 74/118 (379) | Pass, except off to live if that counts for B13 |
| c7g.large, same | 59.8 | 69.8/79.8 | 83/124 (287) | Pass |
| t4g.medium, capped, 1280x800 | 59.7 | 70.7/83.8 | 72/107 (374) | Pass |

- **B12 is met** on the real stack. The RTP `playout-delay` extension is worth 19 to 28 ms, which explains the Neko miss, so the "not met by any size" finding below no longer holds. Measured to the decoded frame; a real display adds about 8 ms. Not measured on real sites, real networks with loss, or GPU clients.
- **Stream fps hides page fps.** The client decodes 60 fps everywhere, but on t4g.medium at 1080p the page itself renders 35 fps scrolling and 22 fps on video, because `desk-stream`'s CPU weight starves Chromium. Judge by page fps.
- **Member desk size is the owner's decision and is still open.** t4g.medium passes only with a 1280x800 screen, which needs an image change; c7g.large passes at 1080p but costs about twice as much (`~/ma-coord/system-eng.md`).
- **Default stream settings:** VFR, quantizer 23, 8 Mbps cap, NV12 at the current screen size (`image/recipe/desk-stream/stream.conf`), released as `desk-stream` 0.2.1. VFR shows a steady 0.5 dropped frames a second at the receiver with no freezes, not yet explained.

## Decision
- **Default normal-mode profile ("default"):** H.264 constrained baseline through GStreamer; capture BGRx converted with libyuv NEON to NV12 (replaces `videoconvert`); x264 ultrafast, zerolatency, 2 threads, `pass=qual quantizer=23` capped at 8 Mbps (`vbv-maxrate=8000 vbv-bufsize=1200`, 150 ms), 4 s keyframes; variable frame rate (identical frames dropped, 10 fps heartbeat, full 60 fps for 500 ms after any change); desktop and kiosk window 1280x800 at DPR 1; Chromium at nice 10. Measured on t4g.medium: 0.59 GB/h typical browsing (1.80 before), 3.70 GB/h video (unchanged, the cap), 59.3 / 59.8 fps scroll / video, 60 s scroll p5 60 with zero freezes.
- **Capped profile (after a member's 100 GB allowance), 60 fps and the same latency path, resolution and quality only:** the default with `quantizer=28`, `vbv-maxrate=4000 vbv-bufsize=600`, same 1280x800 desktop. **0.41 GB/h typical browsing, 1.85 GB/h video: 100 GB covers about 244 h of browsing or 54 h of video.** Text is not distinguishable from the default at 1:1. A deeper tier exists for Platform to use if needed: `quantizer=30`, max 2500, encode scaled to 960x600: 0.34 / 0.74 GB/h (294 h / 135 h), softer when upscaled.
- **Member desk size: t4g.medium for primaries and added desks stays viable only with the default profile and a low-weight backend.** It passes B11 (59.2 to 59.8 fps with the stand-in burst) and B12 p95 (131 ms), with no CPU headroom while a 1080p video plays (93%, 99% in a burst). c7g.large (+$28.4/month) and m7g.large (about +$35/month, estimate) give the headroom (64% video) but **do not fix B12's p50**.
- **B12 p50 is not met by any size** (t4g.medium about 106 ms, c7g.large 90 to 106, m7g.large 85 to 108) and is set by the Chromium receiver jitter buffer (29 to 52 ms; `jitterBufferTarget = 0` had no effect), not by instance size. This is flagged for the owner (Q9 is not triggered, because price does not buy it): the next step is a `desk-rtc` spike (RTP `playout-delay` extension, PLI to IDR, intra refresh), untested here.
- Always-on cost with surplus credits (t4g.medium, unlimited): about $30.5/month for typical browsing, $62.9 for the measured tuned soak mix, $69.4 for nonstop 1080p video; $26.13 at 2 h/day of any of them.
- The 1600x900 fallback is not needed. The 1280x800 default replaces 1080p; 1600x1000 passes fps but runs 97% CPU on video.

## Consequences
- Platform needs capped-profile GB/h (above) for the allowance and metering design. The profile switch is a pipeline restart.
- Static pages still cost about 0.4 to 0.5 Mbps (keyframes), not zero; shipping a longer GOP needs PLI support in `desk-rtc` first.
- Neko's 4 s join delay (B13) is a known gap until `desk-rtc` handles PLI.
- Combined numbers on c7g.large (GB/h) are assumed equal to t4g's; a real `deskd` confirmation run must repeat the load test on the final instance.
