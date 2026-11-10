# 0037. Sound and picture: one capture clock, and the picture waits for the sound only while a member watches

**Status:** Proposed (task 23, 2026-11-06). Built on `sub/av-sync`, measured on the staging test desk, on no member's desk: `desk-rtc` 0.3.2, `desk-stream` 0.2.3 and the Desk app's player. The picture hold is the owner's call (`~/subcontractor-tasks/DECISIONS.md`), on by default.
**Date:** 2026-11-06
**Amends:** [0034](0034-desk-media-path.md) (RTP timestamps, sender reports, the audio buffers); `desk-runtime.md` 8.2, 8.5 and 8.6

## Context
The owner, after YouTube in his desk's Browser: "the delay is noticeable ... Not a deal breaker except that the audio and video were not in sync."

Measured with `e2e/av-sync/` (a white box and a 1 kHz tone on the same instant once a second, in the desk's own Browser; the desk records its screen and its Pulse monitor, a headless Chrome client here records what it decodes and hears; 79 to 94 events a run, 52 ms RTT to us-east-1; `e2e/av-sync/runs/`):

| p50 / p95, ms | Before |
|---|---|
| Picture: desk screen to the client's frame | 49.6 / 61.0 |
| Sound: desk monitor to the client's audio graph | 95.4 / 106.6 |
| Sound after picture, at the client | 33.1 / 55.6 (graph), 67.0 / 89.1 (through an output device) |
| Sound after picture, on the desk itself | -9.9 / 4.6 |
| Input to screen while the clip plays | 97.1 / 118.4 |

- **The desk is in sync with itself.** Its Chromium shows the frame within about 10 ms of handing the sound to Pulse.
- **The gap is made in the member's browser.** `desk-rtc` sends sound and picture as separate streams, on purpose (`desk-runtime.md` 8.5), so the browser never holds the picture to line it up. The picture has no jitter buffer (playout-delay 0, 0). The sound has NetEq's buffer (28 to 36 ms here, more on a jittery Wi-Fi) and the output device's (30 ms on Chrome's fake device; a laptop's speakers about 10 to 40; Bluetooth 150 to 250 more). So sound trails picture by about 35 to 70 ms here, before the member's own speakers.
- **Sender reports were on send time.** Pion maps each track's RTP time to when `desk-rtc` sent its last frame. Audio waits for its Opus frame and Pulse's fragments before it's sent, video for one encode, so even a browser that lined the tracks up would have been tens of ms off. `desk-stream`'s payloaders also picked random offsets, so `desk-rtc` couldn't know capture time.
- **Chrome ignores the video receiver's `jitterBufferTarget` while frames carry playout-delay 0, 0** (measured: 50 to 57 ms asked for, the video jitter buffer stayed at 0.5 ms).

## Decision
1. **One capture clock.** `desk-stream`'s pipeline runs with base time 0 and no start time, so its running time is CLOCK_MONOTONIC, and its payloaders have `timestamp-offset=0`. Every RTP timestamp it sends is its capture instant in the track's rate, mod 2^32. Checked on Debian 13's GStreamer 1.26 through a pause and resume: video 1.4 to 3.3 ms behind the clock when it reaches the payloader, audio 14 to 29 ms (an Opus frame), except one stale audio packet after each resume.
2. **Sender reports on that clock.** `desk-rtc` (`srclock.go`) rewrites the NTP and RTP pair of every report Pion makes, from the same clock, for a source it sees is clocked; an older `desk-stream` keeps Pion's mapping. A clocked source keeps a random per-viewer offset that never moves, and the stale packet after a resume is dropped. Unit tests: the report puts a capture within 3 ms of its real time, against 15 and 35 ms with Pion's.
3. **Smaller audio buffers:** Pulse fragments of 5 ms (from 10, with the same 40 ms of room) and Opus frames of 10 ms (from 20), in all three `stream*.conf`. About 9 ms less sound delay (95 to 84 ms), within run-to-run noise for the gap.
4. **The picture waits for the sound only while the member watches** (`web/src/desk/rtc/pictureHold.ts`). While sound is playing and there's been no input for 3 s, the app asks for the picture to be held by the sound's buffering (NetEq's plus the output device's, from `getStats`, less 10 ms for the picture's own decode and frame), easing in by 20 ms a step, at most 250 ms. Any input lets go at once, so the desk's answer to it, a round trip away, arrives with no hold. The app sends the hold as a `HOLD` event on `keys` (type 6, the ms at byte 12; `desk-runtime.md` 8.6), and `desk-rtc` puts it in the playout-delay extension of that session's video only, as min and max both, capped at 500 ms. 0 lets go. Without the extension, as in a browser that doesn't offer it, nothing changes.
5. **Separate streams stay.** Chrome's own lip sync would hold the picture all the time, and by the whole device delay on Bluetooth, which is exactly the latency 0028 rules out.

## Results (test desk, 2026-11-06; `e2e/av-sync/runs/`)
| p50 / p95, ms | Before (`desk-rtc` 0.3.0, `desk-stream` 0.2.2) | After (0.3.2, 0.2.3, the hold) |
|---|---|---|
| **Sound after picture at the client**, against the audio graph | 33.1 / 55.6, 35.0 / 59.1 | **-0.8 / 22.4** |
| Same, through Web Audio's own output | 67.0 / 89.1, 70.0 / 92.6 | 37.7 / 56.4 |
| Picture, desk screen to client, while watching (held by design) | 49.6 / 61.0 | 76.0 / 91.9 |
| Sound, desk monitor to the client's audio graph | 95.4 / 106.6, 90.9 / 101.7 | 79.1 / 85.6 |
| Input to screen while the clip plays | 97.1 / 118.4, 101.3 / 119.3 | 101.0 / 121.7; 98.5 / 123.7 at keydowns that found the picture held |
| `stream.spec` 6, idle and loaded | 78.6 / 96.0, 105.2 / 125.6 (RTT 53) | 75.9 / 92.9, 100.6 / 122.3 (RTT 49) |
| `stream.spec` 2: page fps avg / p5, client decoded | 60.0 / 59.1, 60.0 | 60.0 / 59.0, 60.0 |

A hold of 50 to 65 ms moved the picture about 28 ms: Chrome takes its own decode and render allowance out of a playout-delay. That's what brought the gap to about 0 against the audio graph; through an output device and a display both add their own, so the member's ears and eyes are within about 15 ms of that, sound slightly late rather than early. The hold through `jitterBufferTarget` (the first try, `hold-1`) moved nothing.

## Consequences
- Typing, clicking and scrolling are never held: any input lets go first, on the same ordered channel.
- A member who watches with headphones on Bluetooth gets the picture held by up to 250 ms while watching, which is what lets lips match there at all.
- The hold eases in, so the picture slows for a moment rather than stalling, and lets go in one step, which can skip a frame or two at the first input.
- `desk-rtc` 0.3.0 and older drop `HOLD` as a bad event (counted in `keysDropped`), so a new app on an old desk behaves as before.
- A change to `desk-stream`'s pipeline has to keep both payloaders at `timestamp-offset=0` on this one clock, or sound and picture can't be lined up again.
- Not measured: Safari, Firefox, a real output device, a real display. The client was headless Chrome 1248 with Chrome's fake audio device.
- Separately found: the desk's Chromium drops about 17% of a 720p60 clip's frames (software compositing, 79% CPU on c7g.large). Not this ADR's to fix.
