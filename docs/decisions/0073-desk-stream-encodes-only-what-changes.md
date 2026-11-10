# 0073. `desk-stream` encodes only what changes, and holds 30 fps under contention

**Status:** Proposed (task 46, levers 1 and 3). `desk-stream` 0.3.0 and 0.3.1 (the climb back), built on `sub/desk-stream-damage`, published, passed on the staging test desk (0.3.1 stays there) and pinned for the next image; on no member's desk yet. 0.3.3 adds the CPU-levers spike's two winners (addendum below).
**Date:** 2026-11-07
**Amends:** [0033](0033-normal-mode-stream-profiles-and-member-desk-size.md) (the default capture is no longer a fixed 60 fps), [0034](0034-desk-media-path.md) (the capture element, what a keyframe request does on a still screen, the capture's shared memory), [0039](0039-stream-quality-levels.md) (a level is now the ceiling for the contention steps below it). [0036](0036-per-desk-outbound-throttle.md)'s capped and deep confs get the same capture.

## Context
- The owner, on task 46: "find a way to get 6 on a desk [...]. there must be a way while still keeping over 30fps for concurrent users. think outside the box if you have to." And on the floor: "Its okay if sometimes people get less than 60. Below 30 is unacceptable."
- Shared-hosts test 3 (`spikes/shared-hosts-test3/README.md`): a viewed desk doing nothing costs about a third of a core, two thirds of it `desk-stream`, "because the encoder looks at 60 captured frames a second and the page's counter changes twice a second". A reader costs about half a core, a video desk about 130%.
- 0.2.4's capture was `ximagesrc` grabbing the whole screen 60 times a second, and `yuvconv` dropping a frame identical to the last, except for 500 ms after any change, when it passed all 60. So a page with a clock, a caret or a spinner on it was encoded at 60 frames a second forever, and a 24 or 30 fps video at 60.
- `desk-stream` and `desk-rtc` run at CPU weight 400 against Chromium's 100, so on a busy machine the encoder keeps up and the page is what slows (test 3, everyone scrolling: the stream held 55, the page 37.5).

## Decision
**1. Capture only what changed (`deskcap`).** A GStreamer source of our own, shipped in the release's `gst-plugins/<arch>/` (`aarch64` for cloud desks, `x86_64` for self-hosted ones, each with a `BUILD` naming its source's hash), replaces `ximagesrc` and `yuvconv` in all three `stream*.conf`:
- XDamage on the root window says when and where the screen changed. Only those rectangles are read over MIT-SHM, compared with the last picture, and converted to NV12 (libyuv, BT.601 limited range, as `yuvconv`), straight into whichever output buffer is missing them.
- A frame goes out only when a pixel changed, a keyframe was asked for, or a heartbeat is due. A still screen costs no grab, no conversion and almost no encode.
- Motion runs at up to `max-fps` (60), paced by a token bucket (burst 2), so the first frame after a still spell is grabbed the moment its damage arrives, never on a later tick, and steady motion grabs each paint as it lands.
- **Heartbeats:** on a still screen a repeat of the last picture keeps each gap under 0.8 of the browser's freeze bound (webrtc-stats: max(3 x avg, avg + 150 ms) over the last 30 frames) and under 1 s, because Chrome asks for a keyframe after 3 s without a frame. About 130 ms right after motion, 1 s after about 15 s still. x264 codes a repeat as skips.
- **A keyframe request sends a frame at once.** `desk-stream` emits `deskcap`'s `refresh` with every keyframe it asks x264 for (`keyframe`, `resume`, a `level` change), so a PLI or a joining viewer doesn't wait for the screen to change.
- RTP timestamps stay each frame's capture instant on CLOCK_MONOTONIC (ADR 0037).

**2. Hold 30 fps under contention (`[adapt]`, lever 3), per desk, with no host coordination.** Twice a second `desk-stream` reads `deskcap`'s and `framemeter`'s counters (a passthrough after the encoder) and the CPU pressure (PSI "some") of the cgroup that holds its own: `system.slice` on a desk VM, the desk's own cgroup on a shared host.
- **Over budget:** frames dropped ahead of the encoder, captures starting more than a frame late, or capture to encoded over 1.5 frame intervals at p75. **Starved:** pressure of 40% or more while fewer frames changed than 90% of the step's rate, which is how a busy machine shows when the encoder's weight keeps it ahead and the page slows.
- Two such windows in a row step down: 900, 720, 540 lines, then quantizer +4, then 30 fps. Never under 30.
- It climbs one step after a hold (5 s, doubling to 60 s when a climb is followed by a fall within 10 s) once 3 s of motion predict the step above fits with room (mean capture-to-encoded latency, scaled by the step's pixels, under 0.9 of its frame interval; back to the screen's own size, the current step's own mean, since `videoscale` drops out) and pressure is under 15%. A still screen tells it nothing, so it stays. (0.3.0 scaled every step and climbed under 0.75, and stayed at 900 lines on an idle box; 0.3.1 fixed that.)
- In `scale` order the 30 fps step is taken only while fewer than 30 frames a second get through: a stream already holding 30 or more at the smallest picture would only lose frames to the cap.
- Steps apply below the member's level (ADR 0039): its height and quantizer are where they start, and a step never raises them.
- **The owner's option, off by default:** `order = fps` caps at 30 fps first, at full size, then lowers resolution and quality. Measured below; the owner decides.

**3. The capture's shared memory is the X server's group's only.** `0660`, the segment owned by `stream` and its group the X server's, read from the X socket's peer credentials (Xorg runs as `kiosk`). `ximagesrc` made its segments `0777`.

**4. A fallback.** If `deskcap` won't load (another architecture, another GStreamer), each conf's `fallback-capture` and `fallback-convert` run instead: 0.2.4's lines, at 0.2.4's cost.

## Measurements
One `c7g.xlarge` desk from `ma-desk-0.2.9` (`spikes/desk-stream-damage/README.md`, every run's JSON in its `results/`). CPU in percent of one core; page fps is the desk Chromium's own.
- **Lever 1, no other load (2 runs each before and after):** `desk-stream` idle 50.5% → 4.0% (stream 60 → 2.5 fps), reading flicks 27.8% → 9.6%, 30 fps video 67.1% → 35.7%; steady scroll, wheel and 1080p60 video unchanged (56-67%), as every pixel changes every frame. Page fps unchanged everywhere (60, every flick 59.9 or more, video 59.5-59.6). Key to frame (keydown to the encoded frame, no network) quicker in every case, by 5 to 10 ms at p50 averaged over the runs (29 samples a run).
- **Lever 3, a hog beside the desk, `order = scale`:** with a third of the box (weight 200) the worst 5 s seen was 43.6 fps on 1080p60 video and 56.6 scrolling, against 27.4 and 44.8 on 0.2.4. With a fifth (weight 400), scrolling held 43.6 against 21.4, but **1080p60 video fell under 30 with every setting tried** (0.3.0 20.6 worst and 24.8 average, 0.2.4 14.2 and 20.6): Chromium alone needs about 0.6 core for it. Input p50 under load 32-92 ms against 0.2.4's 100-185.
- **`order = fps`, measured for the owner:** at weight 200 the stream sits at 29-30 (video's worst 5 s 25.4) where `scale` gives 49-59, with about the same page fps; at weight 400 both end on the same step. `scale` stays the default.
- **Climbing back:** with the hog stopped after about 45 s of a 90 s run, 0.3.0 climbed from 540 to 900 lines in 18 s and stayed there on the idle box; 0.3.1 is back at 1080 in 23, 18 and 18 s (video at weights 400 and 200, scrolling at 400), and none of the three stepped down again.
- **On the staging test desk** (`c7g.large`): 0.3.0 and then 0.3.1 each passed all of `e2e/` (23 passed, 1 skipped) and `av-sync`. `av-sync` on one stack (image 0.2.9, `desk-rtc` 0.3.5), 0.2.4 against 0.3.0 and 0.3.1, a 720p60 clip playing: `desk-stream` 51.7% of a core against 27.0 and 26.6; the desk page 55.8 fps against 59.7 and 59.6, with 330 long frames against 22 and 31 and the clip dropping 793 frames against 268 and 247. Picture desk to client p50 46.9 ms against 37.9 and 37.3. The desk-side sound against picture is unchanged (p50 -12.8 against -4.7 and -0.1 ms: ADR 0037's clock holds). At the client the sound lands 74.1 ms after the picture against 90.4 and 81.2: the picture comes about 9 ms sooner, and the sound's own delay varies by run (135, 144, 117 ms; Chrome's audio jitter target 26, 37, 28 ms). The app's picture hold (ADR 0037) covers the gap. Input to screen while it plays p50 93.4 against 92.5 and 93.5 ms.

## Consequences
- **A still desk's stream costs about a twelfth of what it did, a reader's about a third, and 30 fps video's half,** which is most of test 3's idle and reading cost per desk: task 46's packing (test 5) measures what that buys in desks per host.
- **The stream is variable-rate.** A client sees a frame when the screen changes, and a repeat at least once a second otherwise; `getStats` frame rates on a still screen are low by design, and a freeze counter must not read them as stalls (the heartbeat keeps each gap under a browser's freeze bound; the test desk's `e2e/` saw no freezes). `e2e/` passes as it was.
- **Under contention a member may see a softer picture** (540 lines at worst, quantizer +4) for as long as the host is busy, and it climbs back within seconds of the host freeing up. 30 fps is the floor of the control, not a promise: a desk given less than about 0.8 core for 1080p60 video still falls under it, so packing decides that, not the encoder.
- **New native code in a release:** `deskcap` is C, built per architecture, with its source and a `BUILD` record in the release; `package-desk-stream.sh` refuses a plugin built from other source. If it won't load, 0.2.4's capture runs.
- **An image pinned to `desk-stream` 0.3.x** bakes the new release, and `build.sh`'s plugin registry includes `gst-plugins/<arch>/`. Images before that get it by `ma-update`, which scans the new folder once on the first start.
- **The capture's shared memory is no longer world-readable** (0660, X server's group): a tightening, not a change to the wall.

## Addendum, 2026-11-08: `desk-stream` 0.3.3, the CPU-levers spike's two winners
Task 46's CPU-levers spike (`spikes/desk-cpu-levers/README.md`) found two savings inside `desk-stream`. 0.3.3 ships them on top of
0.3.2 (islands, ADR 0075). Numbers: `spikes/desk-stream-0.3.3/README.md`.

**1. x264 without its ARMv8-only code, on arm64 only.** `[video] x264-aarch64 = asm=NEON` in all three confs; `desk-stream` adds
a `[video] x264-<machine>` line to the x264 option string only where `os.uname().machine` names that machine. On Graviton x264
then skips a dozen prefetch hints that cost more than they save (the spike's profile: 10.6% of a scrolling desk's samples). The
output is the same bytes (`test_desk_stream_sound.py` encodes 60 frames both ways at `threads=1` and compares). On x86_64,
`NEON` isn't a CPU x264 knows, so self-hosted amd64 desks keep 0.3.2's x264 line.

**2. Sound sent only while something plays.** `[audio] gate = sink-input`, `gate-tail-ms = 3000`, `gate-stops = sending`.
`desk-stream` watches the desk's Pulse server with `pactl subscribe` (and `pactl list short sink-inputs` at start). While it has
no playback stream for 3 s, a `valve` right after the capture drops the sound, so nothing is converted, encoded, payloaded or
sent, and `desk-rtc` forwards nothing. The capture itself stays connected exactly as in 0.3.2, so the null sink and its clock
are untouched and a sound starts as soon as it did before. If `pactl` can't run, sound is sent all the time, as before.
- **ADR 0037 holds:** the capture never stops, so sound keeps its capture timestamps on CLOCK_MONOTONIC; a browser's jitter
  buffer treats the gap as silence, as with Opus DTX; `desk-rtc` keeps the track's offset. At most one 10 ms Opus frame from
  before a shut can come first after it opens, stamped then: `desk-rtc` drops it past 2 s, a browser drops it as late.
- **The picture hold still works:** `pictureHold.ts` holds the picture only while sound packets flow with energy; with the gate
  shut no packets flow, which it already read as quiet.

**Measured and not shipped: stopping the capture too** (`gate-stops = capture`, in the code, off). It saves the capture's
5 ms wakeups as well, but with nothing recording the null sink's monitor, PulseAudio's null sink renders up to 2 s ahead and
sleeps, and a new client doesn't wake it: a page's first sound reached a capture started on its arrival 17 to 1982 ms later
(p50 946 ms, 12 cold starts). Restarting the sink's clock (suspend and resume) fixed the delay, and holding it suspended while
quiet fixed an AudioContext's lost first 25 ms, but suspending the sink left the bench's sink at 44.1 kHz with its monitor at
48 kHz, where 0.3.1 then delivered about 8% too few samples (11,500 concealed at the client every 2.5 s).

**The image pins 48 kHz (2026-11-08, `sub/sink-48k`).** The server's `default-sample-rate` and `alternate-sample-rate` are 48000
(`/etc/pulse/daemon.conf.d/ma-48k.conf`) and the null sink is loaded with `rate=48000`. Unpinned, `ma-desk-0.2.9`'s sink and
monitor sat at 44.1 kHz from the start (so `verify.sh`'s new check fails there); pinned, both read 48000 Hz on a fresh server and
after a suspend and resume. **That fixes the rate, and the rollback:** with the pin, `capture` mode in all three starts (`restart`,
`hold`, `none`) left sink and monitor at 48 kHz, and a rollback to 0.3.1 from it kept every tone whole (12 trials, 252 to 255
packets in 2.5 s, 0 samples concealed, against 253 on a fresh sink). **It doesn't fix the delay,** and `capture` stays off. Cold
sound starts, page play to client p50 / p95 ms, 12 of each kind (`spikes/desk-stream-0.3.3/README.md`):

| Mode | Media element | `AudioContext` | Tone heard (400 ms sent), p50 / min | Idle desk CPU, % of a core |
|---|---|---|---|---|
| `sending` (shipped) | 91.8 / 109.1 | 70.2 / 80.6 | 399.3 / 396.3 and 400.6 / 399.9 | 5.3 |
| `capture`, `gate-start = restart` | 111.0 / 119.3 (+19.2 / +10.2) | 94.7 / 105.3 (+24.5 / +24.7) | 392.3 / 388.3 and 380.6 / 380.6 | 3.3 |
| `capture`, `hold` | 107.7 / 116.8 (+15.9 / +7.7) | 89.7 / 101.2 (+19.5 / +20.6) | 388.3 / 388.3 and 387.6 / 380.6 | 3.0 |
| `capture`, `none` | 1257.3 / 1835.4 | 1238.0 / 1694.0 | 397.8 and 385.8 | not run |

The bar was no more than 20 ms later than `sending` at both p50 and p95: `restart` misses on `AudioContext` (and on the media
element's p50 by a hair under), `hold` misses `AudioContext` p95 by 0.6 ms and cuts the first 12 to 20 ms of every tone, and
`none` is the 1 s delay again, so the pin alone doesn't remove it. The saving is real (2.0 to 2.3 points of a core per idle desk)
and small against the 5 to 20 ms it costs every first sound. `sending` it stays, with the pin in the image so a later
`capture` (a faster start, such as keeping the sink running with a recorder that costs nothing) can be tried on a safe sink.

**Measured** (one `c7g.xlarge` desk from `ma-desk-0.2.9` and a client at about 15 ms, 2 runs a case, `spikes/desk-stream-0.3.3/`):
desk CPU in % of one core, 0.3.1 → 0.3.3: idle 9.9 → 5.7, reading 22.8 → 17.8, scrolling 105.6 → 91.2, 1080p60 video with sound
123.3 → 113.2. Page fps, stream fps and bitrate the same to 0.1; input p50 / p95 23.5 / 35.5, 29.5 / 52.2, 56.1 / 74.7 and 41.7 /
54.1 ms (70 to 114 keys a case), against 24.5 / 41.4, 30.3 / 58.1, 57.3 / 71.6 and 39.8 / 51.2. Sound starts (6 trials of each
kind and state): page play to client 113.9 / 114.2 ms (media element) and 86.0 / 95.4 (`AudioContext`) with the gate shut,
against 104.0 / 118.6 and 84.2 / 100.0 on 0.3.1; first sample on the desk's monitor to the client 52.8 to 60.8 ms p50 against
56.8 to 61.1; every tone whole. On the staging test desk, see `docs/sub-status/desk-stream-0.3.3.md`.

**Consequences:**
- A quiet desk sends no sound at all. A client's `getStats` lists no inbound audio stream until the first sound, and
  `stats.stream.audioPackets` stands still; the Desk app reads both as quiet already. `e2e/` test 4 now asks for the Opus track
  once the page plays, not before.
- A page that holds an `AudioContext` open keeps a stream, so its desk sends silence, as before 0.3.3.
- `gate-stops = capture` stays off: the image pins the null sink at 48 kHz now, but `capture` still starts sound 12 to 25 ms late.
