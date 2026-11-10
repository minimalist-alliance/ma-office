# Stream quality kit: the four levels on the test desk (task 29, ADR 0039)

Measures each stream quality level (Low, Medium, High, Max; ADR 0039 section 1) on the staging test desk, in one live session that switches level with no reconnect: how long a switch takes, the data each level uses under video, scrolling and a still page, decoded and page frame rates, and input-to-screen. It's the measurement ADR 0039's gate asks for: no level slower to answer than High beyond run-to-run noise, and Max costing no page fps on the `c7g.large`. It sits outside `testDir`, so `npx playwright test`, the release gate, doesn't see it, and the spec skips unless `SQ_LABEL` is set. Browsers run headless with `DISPLAY` removed and `--disable-audio-output`.

## How it works
- **Setting a level:** the staging Desk app has no quality menu yet, so the client sets one by test-only injection. An init script wraps `RTCPeerConnection.prototype.createDataChannel` and keeps the session's `keys` channel; the page sends `QUALITY` on it (16 bytes, `[7, level 1..4, 0, 0, seq u32 BE, 0 x 8]`, `docs/interfaces/stream-quality.md` section 3) and records every `0x82` reply, the one on starting to view included.
- **The client:** desk-1 through Platform's real API and gateway, with `tests/streamlib.ts`' client, as `stream.spec.ts` and `av-sync/` run. `sqlib.ts`' sampler reads `getStats` once a second: video and audio `bytesReceived` (payload) and `headerBytesReceived`, the selected pair's bytes, frames decoded and received, keyframes, `frameWidth`/`frameHeight`, freezes, losses.
- **On the desk:** `video.html`, `scroll.html` and `latency.html` and the clip go over SSM, the clip in 40 KB pieces, to `/var/tmp/ma-sq`, served on `127.0.0.1:18769` by a transient unit (`ma-sq-pages`) as `nobody` that can't outlive an hour. The pages run in this run's own tab and publish their rAF count (frames, frames over 25 ms) in their title, read back through `browser.tab.list`, as `stream.spec.ts` does; none draws a visible counter, so the still page is really still.
- **The clip** (`make-clip.sh`, ffmpeg): 6 s, 1920x1080 at 60 fps, VP8 and Opus, about 3 MB. A slow pan and zoom over a detailed fractal still whose colours turn, a rotating test card crossing it, a ticker and per-frame grain, so the whole frame moves. Encoded locally with x264 as `stream.conf` sets each level (ultrafast, zerolatency, the quantizer as CRF, the VBV ceiling), it fills every level's ceiling: its GB/h are the ADR's "at most" column. Real footage sits below the ceiling at Max and High.
- **Per level,** in the order of `SQ_LEVELS` (default `high,low,medium,max,high`: High first and last, so run-to-run noise shows):
  1. **Switch,** while the clip plays: from sending `QUALITY`, the reply naming the level, the first keyframe decoded after it (`keyFramesDecoded`, polled about every 15 ms), and the first decoded frame at the new size (`requestVideoFrameCallback` metadata, exact). Asking for the level already in effect changes nothing and is marked `noChange`.
  2. **Video,** `SQ_VIDEO_S` (45) s with the clip playing with sound, after a click as a member's would start it: bytes a second (GB an hour, 10^9 bytes), decoded fps, picture size, the desk page's rAF fps and the clip's dropped frames, desk CPU.
  3. **Scroll,** `SQ_SCROLL_S` (30) s of `stream.spec.ts` test 2's wheel (about 1200 px/s, reversing every 4 s) on its scroll page: the same.
  4. **Still,** `SQ_STILL_S` (20) s of the same page left alone: the same. VFR sends a 10 fps heartbeat and a keyframe at least every 4 s, so this is mostly keyframes.
  5. **Input to screen,** `stream.spec.ts` test 6's method: `SQ_TRIALS` (30) keydowns flipping the latency page's square, frame callback time p50/p95. `SQ_LOADED=1` adds its loaded page (the animated canvas).
- **Safety:** a level that brings no picture (under 20 frames in 2 s after the switch), or a `desk-stream` restart during a level (PID or `NRestarts` changed), stops the run. `SQ_BUDGET_S` (1500) is the run's time budget: a level that wouldn't fit isn't started. At the end the client asks for High, closes its tab, sets the stream off and closes the session, and the pages, clip and unit are removed, pass or fail. The desk's `desk-stream` and `desk-rtc` journal lines about levels and warnings go in the report.

## Run
Hold `~/work/.test-desk.lock` for the whole desk session, and don't run anything else on the desk. `run-under-lock.sh` is the whole session as task 29 ran it: versions found, both rollouts (`desk-service-release.sh`, published beforehand), the kit, cleanup, both rollbacks and a check that the versions are back, each step logged with its UTC time to `results/<label>.desk-log.txt`.

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
cd e2e && npm ci && npx playwright install chromium        # once
./stream-quality/make-clip.sh stream-quality/results/clip.webm   # once
SQ_LOCAL=1 npx playwright test -c stream-quality local.spec.ts # the dry run, no desk (below)
flock ~/work/.test-desk.lock timeout 44m ./stream-quality/run-under-lock.sh sq-1 0.3.3 0.2.4   # 16 minutes held for sq-1
# or, with the levels already on the desk: SQ_LABEL=sq-1 SQ_LOADED=1 npx playwright test -c stream-quality stream-quality.spec.ts
node stream-quality/summarize.mjs sq-1                          # the table, and results/ to runs/ without raw arrays
```

`results/` is ignored by git; `runs/` is the summary to commit.

## The dry run (`local.spec.ts`, `SQ_LOCAL=1`)
No desk: this tree's `desk-rtc`, `gateway-shim` and `fake-deskd` from `desk-rtc/dist/amd64` (as `web/tests/e2e/rtcStack.ts` runs them), and `web/tests/e2e/fakeDeskStream.ts` (ffmpeg's H.264 and Opus at 1280x800, 30 fps). Same client, init script and page code as the desk run: it checks the kept `keys` channel, the `0x82` reply on viewing and after each `QUALITY`, `level <name>` reaching the stream socket, keyframes after a switch, a size that never comes timing out cleanly, and the sampler's rates. `FakeDeskStream` ignores `level`, so a size change can only show on the desk. The fixture page is served by a real loopback server: Chrome 1248's Local Network Access checks refuse a `page.route` page's WebSocket to `127.0.0.1`.

## What it reports (`results/<label>.json`)
Per level and run: `switch` (`replyMs`, `firstKeyframeMs`, `firstFrameAtNewSizeMs`, the reply's level, flags and limit), `afterSwitch`, then `video`, `scroll` and `still`, each with `client` (`size`, `decodedFps`, `decodedP5`, `videoMbps`, `videoGBh`, `videoWithRtpHeadersGBh`, `audioGBh`, `transportGBh`, keyframes, drops, freezes, losses, jitter buffer, decode time, RTT), `deskPage` (rAF `avg`, `p5`, long frames, scroll px, the clip's dropped frames) and `deskCpu`; `input` (and `inputLoaded`) with `callbackMs` p50/p95. Also the versions, the replies, every size the client saw, and the journal lines. GB an hour is 10^9 bytes, as the meter counts.

## Results: `sq-1` (2026-11-06, 15:43 to 15:59 UTC)
`desk-rtc` 0.3.3 and `desk-stream` 0.2.4 on the test desk (c7g.large, image 0.2.5, `deskd` `2026.11.06-e7199b1`), rolled back to 0.3.2 and 0.2.3 afterwards. Client headless Chrome 1248 here, RTT 47 to 55 ms. `runs/sq-1.json`, `runs/sq-1.desk-log.txt`. GB/h is video payload; sound adds 0.029 GB/h while the clip plays (64.8 kbit/s) and 0.001 otherwise, and the transport (SRTP, RTCP, channels) about 5% more.

| Level (run) | Picture | Switch, ms: reply / new size / keyframe | Video GB/h (Mbit/s) | Scroll GB/h | Still GB/h | Decoded fps v / s / still | Input idle p50/p95 | Input loaded p50/p95 | Page fps v / s | Clip frames dropped |
|---|---|---|---|---|---|---|---|---|---|---|
| High (1) | 1920x1080 | no change | 3.60 (8.01) | 1.47 | 0.371 | 60 / 60 / 10 | 75.4 / 97.0 | 103.9 / 116.9 | 60.0 / 60.0 | 3.5% |
| Low | 1280x720 | 57 / 83 / 109 | 1.13 (2.50) | 1.13 | 0.152 | 60 / 60 / 10 | 78.5 / 92.1 | 102.6 / 115.7 | 60.0 / 60.0 | 1.2% |
| Medium | 1920x1080 | 51 / 94 / 105 | 1.80 (4.00) | 1.20 | 0.295 | 60 / 60 / 10 | 86.4 / 104.4 | 90.4 / 110.7 | 60.0 / 59.9 | 3.4% |
| Max | 1920x1080 | 50 / same / 102 | 5.41 (12.02) | 1.68 | 0.466 | 60 / 60 / 10 | 75.9 / 93.5 | 106.2 / 115.1 | 60.0 / 60.0 | 6.8% |
| High (2) | 1920x1080 | 50 / same / 110 | 3.60 (8.01) | 1.46 | 0.373 | 60 / 60 / 10 | 83.0 / 96.7 | 107.7 / 123.6 | 60.0 / 59.9 | 3.2% |

- The clip fills every level's ceiling, so the video column is ADR 0039's "at most", measured. No freezes, no packets lost, `desk-stream` never restarted, and every switch kept the session.
- Scrolling at Low sits at its 2.5 Mbit/s ceiling (scaled text scrolls at a fractional pixel step, which motion search predicts badly), so Low saves only a quarter of High's scrolling data and about the same as Medium.
- A still page costs 0.15 to 0.47 GB/h, not ADR 0039's 0.02: the client drops a frame about every 2 s, asks for a keyframe (PLI), and gets one (keyframes = PLIs = drops, 10 in 20 s at every level, with no loss). That's the "0.5 dropped frames/s with VFR" in `stream.conf`'s notes, and it's in High as much as anywhere.

## Not covered
The real Desk app's menu (not on staging yet), Safari and Firefox, two viewers at different levels (the highest-ask rule is `desk-rtc`'s unit and `web/` rtc tests), a real display, and real footage (the clip is a worst case for data).
