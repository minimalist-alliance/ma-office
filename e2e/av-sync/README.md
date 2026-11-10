# A/V sync kit: sound and picture from the desk to the client (task 23, ADR 0037)

Measures, on the staging test desk, how long the picture and the sound take from the desk to a client, and the gap between them, plus input-to-screen and frame rate while a video plays. It sits outside `testDir`, so `npx playwright test`, the release gate, doesn't see it, and the spec skips unless `AV_LABEL` is set. Browsers run headless with `DISPLAY` removed and `--disable-audio-output` (Chrome's fake audio device, which keeps real-time pace and makes no sound on this machine).

## How it works
- **The clip** (`make-clip.sh`, ffmpeg): 10 s, 1280x720 at 60 fps, VP8 and Opus. Every second at +0.5 s a white box (the middle quarter) shows for 100 ms and a 1 kHz tone plays for 100 ms, on the same instant (checked by decoding: 0.04 ms apart). A frame counter as text and as 10 blocks along the top. It loops, so events stay away from the loop point.
- **On the desk:** the spec copies the clip and `sync.html` over SSM, in 40 KB pieces, to `/var/tmp/ma-avsync`, served on `127.0.0.1:18768` by a transient unit as `nobody`. It opens the page in its own tab, clicks to start it with sound, as a member would, and starts `sampler.py` as `stream` in a transient unit (10 minutes at most): a 4x4 patch of `:99` polled about 500 times a second, and the Pulse monitor that `desk-stream` captures, both in CLOCK_REALTIME. Everything is removed at the end, pass or fail.
- **On the client:** desk-1 through Platform's real API and gateway, with `tests/streamlib.ts`' client. `avlib.ts`' probe reads every decoded frame (`requestVideoFrameCallback`) for the box, the counter and the input square, finds the tone's onset sample-exactly in an AudioWorklet on the received track, and reads `getStats` every 250 ms.
- **Clocks:** the workstation's against true time by SNTP (`time.cloudflare.com`, the least round trip of 12), the desk's from `chronyc tracking`, before and after.

## Run
Hold `~/work/.test-desk.lock` for the whole run, and don't run it alongside another spec on the desk.

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
cd e2e && npm ci && npx playwright install chromium     # once
./av-sync/make-clip.sh av-sync/results/sync.webm 10      # once
AV_LABEL=before-1 npx playwright test -c av-sync         # about 4 minutes
AV_LABEL=hold-1 AV_HOLD=1 npx playwright test -c av-sync # with the Desk app's picture hold, about 7 minutes
node av-sync/summarize.mjs before-1 hold-1               # results/ to runs/, without anything that holds an address
```

Optional: `AV_SECONDS` (80), `AV_TRIALS` (60), `AV_CLIP`, `AV_START=0` to skip the pause-and-play phase. `results/` is ignored by git; `runs/` is the summary to commit.

## What it reports (`results/<label>.json`)
- **`delays desk to client`:** picture, desk screen to the client's frame callback; sound, desk monitor to the client's audio graph (`seenByWorklet`) and through Web Audio's output (`heard`). The clocks' skew is applied; its error is at most half the SNTP round trip.
- **`sound after picture at the client`:** the gap, from the client's own times only, so no clock is involved. Positive is sound late. The graph is when Chrome hands the sound on; a real device plays it its own output delay later (`client getStats` `audioPlayoutDelayMs` is Chrome's figure for that), and a real display shows the frame a refresh or two after the callback.
- **`desk side`:** the gap on the desk itself, screen against monitor.
- **`client getStats`:** jitter buffers, the output device's delay, sender reports, RTT, decoded fps, frames dropped, the counter's skips. Chrome reports no `estimatedPlayoutTimestamp` or rVFC `captureTime` here: they need an RTT, which a receive-only browser never gets.
- **`input to screen while the clip plays`:** 60 keydowns flipping a square in the corner. With `AV_HOLD=1`, every other one comes after the hold has engaged, and those are reported apart (`heldAtKeydown`).
- **`desk page fps`:** the desk Chromium's own rAF rate and the clip's dropped frames.
- **`after a pause and play`:** the gap per event in the first 14 s after the clip restarts.

For frame rate under scrolling and the usual input-to-screen, run `tests/stream.spec.ts -g "2 frame rate|6 input-to-screen"` in the same lock.

## Not covered
Safari and Firefox (no Mac here), a real output device and a real display, the owner's own network.
