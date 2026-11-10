# Real-stack benchmark: member desk size on the real media path (2026-11-05)

Status: measured, 2 to 3 repeats per row (fresh client session each), 30 ms RTT. Harness: `spikes/browser-bench/real-stack/` (`rs.sh`, `proof2.mjs`). Raw results and logs: `spikes/browser-bench/real-stack/results/<row>/run*.json`. Proposed config: `image/recipe/desk-stream/stream.conf.proposed`. This settles the disagreement between `docs/benchmarks/2026-11-follow-up.md` (Neko, ADR 0033) and ADR 0034 (`desk-rtc` against `fake-deskd`). ADRs, the design and `CLAUDE.md` are not edited here.

## 1. Verdict (read this first)

**Budgets** (design §2.2): B11 a 60 s scroll at avg >= 58 fps, p5 >= 55, zero freezes; B12 input-to-photon p50 <= 90 ms and p95 <= 150 ms at 30 ms RTT; B13 switch to first video frame <= 300 ms. "Loaded" = a 1080p60 video playing on the page. Latency is the callback method (section 2), median of the repeats' p50 and p95.

| Size, config | B11 scroll (stream / page fps) | B12 idle p50/p95 | B12 loaded p50/p95 | B13 warm to live p50/p95 (off to live) | Verdict |
|---|---|---|---|---|---|
| c7g.large, current `stream.conf` (1080p) | 60.0 / 59.8 | 63.7 / 76.3 | 74.6 / 89.6 | 50 / 58 ms (287 ms) | **passes**. The 1080p video page presents 49 fps |
| t4g.medium, current `stream.conf` (1080p) | 60.0 / **35.4** | 73.4 / 91.0 | **91.8** / 113.3 | 55 / 66 ms (384 ms) | **fails B11 on the page** (the stream still says 60 fps), B12 p50 misses by 1.8 ms. CPU 89% scroll, 98% video, video page 22 fps |
| t4g.medium, ADR 0033 default, **1280x800 screen** | 60.0 / 59.7 | 64.9 / 78.4 | 73.6 / 86.2 | 74 / 118 ms (379 ms) | **passes**. Needs a 1280x800 screen, which a `stream.conf` release cannot set (section 5). CPU 61% scroll, 87% video |
| c7g.large, same | 60.0 / 59.8 | 60.6 / 75.8 | 69.8 / 79.8 | 83 / 124 ms (287 ms) | passes with headroom (CPU 40% scroll, 60% video) |
| t4g.medium, ADR 0033 capped, 1280x800 screen | 60.0 / 59.7 | 60.9 / 76.6 | 70.7 / 83.8 | 72 / 107 ms (374 ms) | passes |
| t4g.medium, ADR 0033 default conf at **1080p** (what a release alone can ship) | 60.0 / 59.8 | 67.8 / 83.1 | 84.7 / 99.7 | 98 / 138 ms (385 ms) | passes B11 scroll, B12, B13 warm. **Misses on the 1080p video page** (50.5 fps presented, CPU 95%, no headroom) |
| c7g.large, ADR 0033 default conf at 1080p | 60.0 / 59.9 | 65.4 / 77.1 | 74.8 / 86.9 | 80 / 129 ms (291 ms) | passes. Video page 49 fps presented, as with the current conf |

- **Smallest size and config that passes everything: t4g.medium with the ADR 0033 default (VFR, quantizer 23, 8 Mbps cap) on a 1280x800 screen.** The screen is the catch: the image fixes 1920x1080 (`xorg-dummy.conf`, `desk-browser-start`), so this is an image (AMI) or runtime change, not a `desk-stream` release.
- **With a `desk-stream` release alone (1080p), the smallest that passes everything is c7g.large.** t4g.medium at 1080p with the new config meets B11 (scroll), B12 and B13 from warm, and misses only the 1080p video page, by about 8 fps of presented video (50.5 against 58) with the CPU at 95%.
- **B12 p50 is met on every row but one,** with 5 to 20 ms to spare on the passing rows (callback method, section 2). The one miss is the current config on t4g.medium under load, 91.8 against 90. ADR 0033's "no size passes B12 p50" is superseded: it measured Neko, and ADR 0033 lists the `playout-delay` extension as untested there.
- **B13 from warm is met everywhere (at most 138 ms). From a stopped encoder (`off` to `live`) it is 287 to 291 ms on c7g.large and 374 to 385 ms on t4g.medium: a miss on t4g.medium** if B13 is read as including a `desk-stream` start. The first Browser use after boot was slower still (section 6).
- **A caveat on B12 that applies to every row:** the probe stops at the decoded frame's callback. A 60 Hz display adds up to one frame (0 to 16.7 ms, about 8 ms on average) before the photon. With 8 ms added, the best rows are about 78/88 and the t4g.medium 1080p rows are over 90 at p50.
- **Page fps is not stream fps.** The client decodes 60 fps on every row because the encoder repeats the last frame when the page stalls. The page itself (kiosk `requestAnimationFrame`, and the video element's presented frames) runs at 35 fps scrolling and 22 fps on video on t4g.medium at 1080p. Both earlier benchmarks scored decoded fps; this one scores both and the table says which.

**Always-on $/month** (ADR 0033's model: instance plus 24 GB gp3 as ADR 0033 prices them, t4g.medium $26.13 and c7g.large $54.52; surplus credits $0.04 per vCPU-hour above 24 credits/hour earned; credits/hour from measured CPU, 1.2 per CPU point on 2 vCPUs; "typical" is the benchmark's mix of 70% reading, 30% scrolling). The static-page figure comes from a blank page, so "typical" is optimistic by a few credits.

| Config | Typical browsing | Scrolling 24x7 | Video 24x7 | Passes? |
|---|---|---|---|---|
| c7g.large (any config) | $54.52 | $54.52 | $54.52 | yes |
| t4g.medium, ADR default, 1280x800 | $28.19 | $50.31 | $65.37 | yes, with the screen change |
| t4g.medium, ADR capped, 1280x800 | $27.33 | $48.67 | $64.62 | yes |
| t4g.medium, ADR default conf, 1080p | $33.51 | $60.12 | $69.81 | video page misses |
| t4g.medium, current conf, 1080p | $47.82 | $66.54 | $71.68 | no |

At 2 hours a day of any load, with the stream off the rest of the day (about 3 credits/hour, as ADR 0033 measured), all t4g rows stay inside the earned credits ($26.13). t4g.medium costs more than c7g.large once it averages above about 83 credits/hour (69% CPU all day).

**Recommended default:** `image/recipe/desk-stream/stream.conf.proposed` (VFR plus quantizer 23 capped at 8 Mbps, NV12). It passes at 1080p on c7g.large, and on t4g.medium except for the video page; it cuts idle CPU from 27 to 43% down to 6 to 13% (1080p), and cuts scroll bandwidth by 24% (c7g) to 45% (t4g). I found nothing the user would feel in exchange (a steady 0.5 dropped frames/s at the receiver, and a warm-to-live switch of 80 to 98 ms instead of 50 to 55, are the costs). **Size recommendation:** c7g.large ($54.52) today, with a `desk-stream` release alone. t4g.medium ($28 typical) after an image change to a 1280x800 screen, and only if the owner accepts that its video page has no headroom (87% CPU, 58 fps presented). I did not run the image change.

## 2. The two latency methods, on the same run

**What the two harnesses actually did** (both read from source): each presses a key in the client page, which flips an 800x800 square on a page in the kiosk (the same `latency.html`), and reads the changed pixel in `requestVideoFrameCallback`. Both record the callback's `now` and its `expectedDisplayTime`. Neko's `measure.py` reports `now` as its headline ("frame callback"); `desk-rtc/test/stream/proof.mjs` reports `expectedDisplayTime` ("display"). So the two did not use different probes. They differed in the **server** (Neko against `desk-rtc`) and in which of the two numbers got quoted.

**What I measured, per trial, over 3,000 trials in 51 passes:** `callback`, `display`, and a third method that needs no browser timing: both boxes on Amazon Time Sync (chrony offset about 1 microsecond on each), the kiosk page logs the wall-clock time of the keydown it receives, and the client logs the wall-clock time of the key press and of `receiveTime`, the arrival of the changed frame's last packet. That splits the trip into up (client keydown to kiosk keydown), desk (kiosk keydown to last packet at the client) and decode (last packet to callback). In all 51 passes the kiosk logged exactly one keydown per trial (`aligned`), and no trial was missed.

**Results, c7g.large, current `stream.conf`, 30 ms RTT, p50 of the 3 repeats' p50 [range], ms:**

| | idle | loaded |
|---|---|---|
| callback (measured event) | 63.7 [61.4-67.5] | 74.6 [72.7-76.0] |
| display (`expectedDisplayTime`, a prediction) | 67.5 [61.0-84.5] | 74.0 [72.8-90.8] |
| wall-clock split: up + desk + decode | 15.1 + 42.1 + 6.8 | 15.1 + 53.0 + 3.7 |
| receiver jitter buffer | 0.3 | 0.5 |

- **75/89 is real.** The loaded callback is 74.6/89.6, and the wall-clock split independently adds to about 72 ms. The 15 ms upstream and the 15 ms of the downstream are the netem delay; the rest is the kiosk's render and capture, the encoder and the receiver.
- **The idle "54/78" in ADR 0034 is partly an artifact.** `expectedDisplayTime` is a prediction, not an event. It varies by 23 ms between identical runs (61.0 to 84.5 here), it was 54 ms against a callback of 66 ms in the earlier run, its minimum there (23.7 ms) was below the 30 ms RTT floor so no real frame could have shown that early, and it sits 15 to 20 ms above the callback at 1280x800 and equal to it at 1080p. Use the callback or the wall-clock split. The loaded numbers in ADR 0034 are fine because there the two agree.
- **The Neko number was the missing extension, not the harness.** On the same real stack, switching the answer's `playout-delay` extension off (`desk-rtc --no-playout-delay`) gives 91.9/109.3 idle and 94.0/109.6 loaded, with the receiver's jitter buffer at 9 ms and about 23 ms more between the last packet and the callback. That is within 13 ms of Neko's 107/128 (stock 1080p, loaded). **Playout-delay is worth 19 to 28 ms** (the ADR's table said about 17).
- **`jitterBufferTarget = 0` does nothing once the extension is negotiated:** without it the stack gives 69.2/78.7 idle and 75.6/88.0 loaded (2 repeats), the same as with it. That matches the Neko finding that it had no effect there.

| c7g.large, 1080p, 2 repeats each | idle cb p50/p95 | loaded cb p50/p95 | jitter buffer idle/loaded | last packet to callback (idle) |
|---|---|---|---|---|
| playout-delay on, `jitterBufferTarget = 0` (the default) | 63.7 / 76.3 | 74.6 / 89.6 | 0.3 / 0.5 ms | 6.8 ms |
| playout-delay **off**, `jitterBufferTarget = 0` | 91.9 / 109.3 | 94.0 / 109.6 | 9.5 / 8.7 ms | 30.6 ms |
| playout-delay on, `jitterBufferTarget` not set | 69.2 / 78.7 | 75.6 / 88.0 | 0.3 / 0.6 ms | 12.2 ms |

## 3. Setup (what was real)

- **Server:** AMI `ma-desk-0.2.1` (`<ami>`), blank 20 GB gp3 on `/dev/sdf`, us-east-1a, on-demand, t4g.medium on default (unlimited) credits. `desk-rtc` 0.2.0, `desk-stream` 0.2.0 and **`deskd` 2026.11.05-bf3c366** installed with `ma-update` from presigned URLs of `s3://ma-lambda-artifacts-<account-id>/desk/<component>/<version>/`. Variant `stream.conf` files were packaged as `0.2.0-rs-<name>` and installed with `ma-update` from `file://`.
- **Stand-ins:** `gateway-shim` (built from `desk-rtc/` at origin/main, loopback, reached from the client through an ssh tunnel) instead of the gateway and Platform API; `fake-imds.py` for IMDS (below).
- **Client:** c7i.xlarge x86, Ubuntu 24.04, Chrome for Testing 156.0.8078.4 through Playwright 1.64.1 (new headless, software H.264 decode, 1920x1080 viewport), Node 24.11. `tc netem` 15 ms each way on both boxes = 30 ms RTT, no loss (ICE RTT 30 to 33 ms). Dropped frames: zero in the two CBR rows. The VFR rows show a constant 0.5 dropped frame per second (30 in 60 s) on both sizes, which points at the stream (VFR timestamps) and not the client; not investigated. Zero freezes and zero lost packets in every segment.
- **Driving the stream:** every row used **`deskd`'s real `browser.stream.set`** (`live`, `warm`, `off`) over the real data channel, through `units.sock` to `desk-stream` and `desk-browser`. No fallback was needed (section 7).
- **Scenarios per repeat:** cold `live`; 12 `warm` to `live` switches (B13, the first discarded); 60 photon trials idle; 60 trials with a 1080p60 video playing; 60 s scroll (wheel at about 1200 px/s, as the app sends it); 30 s of a 1080p60 video page; 10 s static page. CPU, memory and credits come from `/proc` and cgroups on the desk, per second (`sample2.py`).
- **Video:** *Big Buck Bunny* "sunflower" 1080p60 H.264 (the Blender Foundation, CC-BY 3.0, `bbb_sunflower_1080p_60fps_normal.mp4` from the Blender mirrors), a 60 s clip from 2:00 with the AC3 audio dropped, looped. It is real footage but animated and easier to encode than the earlier noisy test pattern, so bitrates are lower than ADR 0033's.
- **1280x800 rows:** the dummy X screen was set to 1280x800 with `xrandr` (a modeline added at run time), `desk-stream` was stopped first, and Chromium's viewport was set to 1280x800 at DPR 1 with CDP `Emulation.setDeviceMetricsOverride`, because the kiosk window ignored `xrandr` and `Browser.setWindowBounds` and stayed 1919x1079. That reproduces the render and encode cost of a 1280x800 desktop. It is not a path the product can ship.
- **IMDS and credentials:** the benchmark desk has no IAM role (IAM was off limits), and `deskd` signs its hello with the instance role's credentials from IMDS. `deskd.env` therefore also sets `DESKD_IMDS_URL` to the repo's `services/scripts/fake-imds.py` (tags, public IP and fixed fake credentials; the shim ignores signatures). Everything else `deskd` did was real: the tags check, `configure`, hello, gateway link, heartbeat.

## 4. Matrix

### Matrix (median [min-max] over the repeats; n in the first column)

| Row | n | Scroll fps: stream / page | Video fps: stream / page presented | Idle photon p50 / p95 (cb) | Loaded photon p50 / p95 (cb) | Warm to live p50 / p95 (cb) | Off to live (cb) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 c7g.large, stream.conf 0.2.0 (1080p60 NV12 8 Mbps CBR) | 3 | 60.0 [60.0-60.0] / 59.8 [59.7-59.8] | 60.0 [60.0-60.0] / 49.0 [48.5-49.4] | 63.7 [61.4-67.5] / 76.3 [75.9-81.5] | 74.6 [72.7-76.0] / 89.6 [87.5-92.0] | 50.3 [45.9-51.2] / 58.1 [57.2-58.3] | 287 [285-289] |
| 2 t4g.medium, same | 3 | 60.0 [60.0-60.0] / 35.4 [34.6-35.6] | 59.7 [59.6-59.8] / 22.4 [21.2-22.7] | 73.4 [72.4-74.6] / 91.0 [89.5-91.8] | 91.8 [91.2-93.0] / 113.3 [109.8-122.7] | 54.6 [53.2-57.0] / 65.7 [63.6-67.2] | 384 [380-35949] |
| 3 t4g.medium, ADR 0033 default, 1280x800 screen | 3 | 60.0 [60.0-60.0] / 59.7 [58.1-59.7] | 60.0 [60.0-60.0] / 58.2 [57.7-58.3] | 64.9 [63.0-66.6] / 78.4 [78.4-78.5] | 73.6 [73.3-75.2] / 86.2 [86.1-100.9] | 74.3 [58.8-87.3] / 118.0 [110.0-127.7] | 379 [364-391] |
| 4 c7g.large, ADR 0033 default, 1280x800 screen | 3 | 60.0 [60.0-60.0] / 59.8 [59.8-59.8] | 60.0 [60.0-60.0] / 59.7 [59.6-59.7] | 60.6 [57.5-65.5] / 75.8 [69.9-77.3] | 69.8 [61.3-72.2] / 79.8 [74.3-84.6] | 82.6 [72.3-92.1] / 123.9 [120.9-126.1] | 287 [283-292] |
| 5 t4g.medium, ADR 0033 capped, 1280x800 screen | 3 | 60.0 [60.0-60.0] / 59.7 [59.7-59.8] | 60.0 [60.0-60.0] / 58.8 [58.4-58.9] | 60.9 [56.1-63.8] / 76.6 [73.1-83.5] | 70.7 [68.3-75.4] / 83.8 [80.4-87.8] | 71.6 [65.0-85.6] / 106.6 [96.7-129.9] | 374 [369-386] |
| 6 t4g.medium, ADR 0033 default conf, 1080p (extra) | 2 | 60.0 [60.0-60.0] / 59.8 [59.8-59.8] | 60.0 [60.0-60.0] / 50.5 [50.5-50.5] | 67.8 [67.3-68.4] / 83.1 [81.9-84.3] | 84.7 [84.3-85.0] / 99.7 [93.0-106.3] | 97.8 [96.0-99.6] / 137.6 [131.1-144.1] | 385 [378-392] |
| 7 c7g.large, ADR 0033 default conf, 1080p (extra) | 3 | 60.0 [60.0-60.0] / 59.9 [59.9-59.9] | 60.0 [60.0-60.0] / 49.4 [49.2-50.8] | 65.4 [64.6-66.7] / 77.1 [75.6-78.6] | 74.8 [74.6-75.8] / 86.9 [85.1-89.1] | 80.1 [77.2-95.9] / 128.9 [126.6-135.8] | 291 [277-2836] |

### Cost side

| Row | CPU % scroll / video / idle | Credits/h scroll / video (2 vCPU, est.) | GB/h scroll / video / idle | deskd RSS MB | Chromium MB | desk-stream MB |
| --- | --- | --- | --- | --- | --- | --- |
| 1 c7g.large, stream.conf 0.2.0 (1080p60 NV12 8 Mbps CBR) | 76.4 [76.1-77.0] / 85.7 [85.3-86.1] / 27.4 [27.3-27.5] | 92 [91-92] / 103 [102-103] | 3.27 [3.22-3.29] / 3.49 [3.49-3.50] / 0.023 [0.023-0.023] | 110 [110-111] | 860 [840-870] | 50 [49-52] |
| 2 t4g.medium, same | 89.2 [89.0-90.3] / 98.0 [97.7-98.1] / 43.4 [43.2-43.4] | 107 [107-108] / 118 [117-118] | 3.27 [3.25-3.28] / 3.54 [3.52-3.55] / 0.018 [0.018-0.023] | 110 [110-111] | 870 [826-889] | 57 [51-153] |
| 3 t4g.medium, ADR 0033 default, 1280x800 screen | 61.4 [58.3-77.3] / 87.2 [86.9-87.8] / 7.3 [6.6-8.9] | 74 [70-93] / 105 [104-105] | 2.53 [2.36-2.58] / 2.04 [2.03-2.07] / 0.018 [0.018-0.027] | 110 [110-113] | 886 [883-899] | 34 [34-34] |
| 4 c7g.large, ADR 0033 default, 1280x800 screen | 39.6 [39.5-40.3] / 59.8 [59.7-59.9] / 3.4 [2.5-5.2] | 48 [47-48] / 72 [72-72] | 2.60 [2.53-2.61] / 2.04 [2.04-2.05] / 0.027 [0.018-0.032] | 112 [112-112] | 861 [857-880] | 32 [32-36] |
| 5 t4g.medium, ADR 0033 capped, 1280x800 screen | 58.6 [57.0-59.0] / 85.9 [85.7-86.1] / 6.4 [6.1-7.5] | 70 [68-71] / 103 [103-103] | 1.73 [1.69-1.73] / 1.09 [1.09-1.10] / 0.023 [0.018-0.027] | 113 [113-113] | 901 [897-903] | 32 [32-34] |
| 6 t4g.medium, ADR 0033 default conf, 1080p (extra) | 78.2 [78.0-78.3] / 94.8 [94.8-94.8] / 13.1 [13.0-13.1] | 94 [94-94] / 114 [114-114] | 1.79 [1.79-1.80] / 1.30 [1.29-1.31] / 0.029 [0.027-0.032] | 114 [113-114] | 908 [908-909] | 48 [47-50] |
| 7 c7g.large, ADR 0033 default conf, 1080p (extra) | 73.8 [73.3-74.4] / 85.1 [84.1-85.2] / 6.1 [6.1-7.1] | 89 [88-89] / 102 [101-102] | 2.48 [2.42-2.59] / 3.18 [3.15-3.19] / 0.018 [0.018-0.018] | 110 [110-110] | 878 [815-893] | 47 [47-149] |

### Latency by method and where the time goes (p50 ms, median over repeats; loaded = video playing)

| Row | idle callback | idle display | idle: up + desk + decode (wall clock) | idle jitter buf | loaded callback | loaded display | loaded: up + desk + decode | loaded jitter buf |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 c7g.large, stream.conf 0.2.0 (1080p60 NV12 8 Mbps CBR) | 63.7 [61.4-67.5] | 67.5 [61.0-84.5] | 15.1 + 42.1 + 6.8 | 0.3 | 74.6 [72.7-76.0] | 74.0 [72.8-90.8] | 15.1 + 53 + 3.7 | 0.5 |
| 2 t4g.medium, same | 73.4 [72.4-74.6] | 72.1 [67.3-72.5] | 15.2 + 51 + 12.1 | 0.3 | 91.8 [91.2-93.0] | 91.6 [91.1-92.4] | 15.3 + 68.5 + 9.3 | 0.8 |
| 3 t4g.medium, ADR 0033 default, 1280x800 screen | 64.9 [63.0-66.6] | 83.4 [71.6-90.3] | 15 + 45 + 10.1 | 0.3 | 73.6 [73.3-75.2] | 75.8 [73.5-90.0] | 15.2 + 49.3 + 10.6 | 0.5 |
| 4 c7g.large, ADR 0033 default, 1280x800 screen | 60.6 [57.5-65.5] | 80.2 [77.6-85.5] | 15.1 + 41.3 + 11.6 | 0.3 | 69.8 [61.3-72.2] | 86.5 [78.0-88.9] | 15 + 43.8 + 11.2 | 0.4 |
| 5 t4g.medium, ADR 0033 capped, 1280x800 screen | 60.9 [56.1-63.8] | 67.1 [61.4-81.8] | 15 + 43.8 + 5.5 | 0.3 | 70.7 [68.3-75.4] | 75.5 [71.7-85.2] | 15.3 + 49.3 + 4.6 | 0.4 |
| 6 t4g.medium, ADR 0033 default conf, 1080p (extra) | 67.8 [67.3-68.4] | 76.5 [61.8-91.2] | 15.1 + 46.2 + 5.5 | 0.3 | 84.7 [84.3-85.0] | 94.3 [84.0-104.6] | 15.5 + 59.0 + 10.2 | 0.5 |
| 7 c7g.large, ADR 0033 default conf, 1080p (extra) | 65.4 [64.6-66.7] | 85.0 [70.5-86.2] | 15.1 + 43.7 + 11.2 | 0.3 | 74.8 [74.6-75.8] | 91.2 [75.8-91.9] | 15.3 + 50.6 + 10 | 0.5 |


- **Row 2's off-to-live range** includes the first Browser use after boot (section 6), which took 36 s. Row 7's includes 2.8 s on a fresh c7g.large.
- **Stream fps and page fps:** "page" for scroll is the kiosk's `requestAnimationFrame` rate with the stream live; for video it is the video element's presented frames. Kiosk scroll `scroll_change_fps` agrees with the page figure.
- **Credits (CloudWatch, t4g.medium, 5 minute buckets, the repeats of one row at a time):** `CPUCreditUsage` per bucket 5.5 and 6.5 (row 2), 5.6 and 5.7 (row 3), 4.5 and 5.4 (row 5), 5.7 and 6.2 (row 6); that is 54 to 84 credits/hour for the benchmark's run mix against 24 earned. `CPUSurplusCreditsCharged` was 33.97 over the whole instance life (about $0.02). The per-hour scenario figures in the cost table above come from the measured CPU, not from CloudWatch.
- **GB/h:** bytes the client received over ICE, scaled to an hour, per scenario. Default config: 2.5 GB/h scrolling, 2.0 video (t4g, 1280x800). **Capped profile (quantizer 28, 4 Mbps cap, 1280x800): 1.73 GB/h scrolling and 1.09 GB/h video**, 68% and 53% of the default, which matches the ratios in ADR 0033 (0.41 against 0.59, 1.85 against 3.70). The absolute numbers are not ADR 0033's: that used a typical-browsing mix (not re-measured here; the static page here is blank, so no honest browsing number can be derived) and a noisier video. A 100 GB allowance covers about 58 h of scrolling or 92 h of this video at the capped profile. **At the same config the video page cost 3.18 GB/h on c7g.large and 1.30 on t4g.medium at 1080p; I don't know why** (both present about 50 fps).
- **Memory under an open session:** `deskd` RSS 110 to 114 MB (JVM; container cgroup about 92 MB), 0.1% of a core. Chromium 860 to 910 MB, `desk-stream` 32 to 57 MB.

## 5. Why the 1280x800 rows can't ship as a `stream.conf`

ADR 0033's default is "desktop and kiosk window 1280x800". A `desk-stream` release carries `stream.conf`, a Python script and GStreamer plugins. The screen size is the X server's (`xorg-dummy.conf`: `Virtual 1920 1080`, one mode) and Chromium's (`--window-size=1920,1080` in `desk-browser-start`), both in the AMI. `ximagesrc` follows whatever the screen is. So the VFR and quantizer parts of ADR 0033 translate into `stream.conf` (they are `conf/adr33-default.conf` here); the resolution does not. It needs either an AMI with a smaller screen and window, or `deskd` setting the mode and window at run time (nothing does yet: the desk-rtc README lists remote resolution changes as not built). Scaling in the capture (`videoscale` to 1280x720) would be release-only, but Chromium would still render at 1080p and the text would be resampled; I did not test it.

## 6. Warm-up, restart and first start

- **`deskd` restart during a stream** (t4g.medium, ADR default, 1280x800, 1 run; the c7g.large and t4g.medium 1080p runs agree to within 1.5 s): the video stops 0.78 s after the restart command (deskd closes its sessions on SIGTERM; v1 does not keep them), the client sees the connection close at 6.1 s, `deskd` is ready (gateway link up) 6.7 s after the command, and a reconnecting client has its first frame 1.2 s later. **There is no live stream through a `deskd` restart, so "fps and latency during its burst" can only be read around it.** The burst: `deskd`'s container peaks at 71% of one core, then 49, 27 and 16% (about 1.7 core-seconds in total, over about 8 s), with RSS going 114, 41, 85, 102, 105 MB. The kiosk page's frame rate stayed 54 to 62 fps from 3 s before the restart to 20 s after it. Right after reconnecting: 60.0 fps (p5 60), and photon latency with a video playing was 69.2/85.0 ms (40 trials, max 103), against 73.6/86.2 in steady state. On t4g.medium at 1080p the page is already starved (kiosk 16 fps minimum during the restart) and the post-restart latency was 90.4/121.9 (loaded), p95 within budget and p50 over.
- **First Browser use after boot:** on the first t4g.medium boot `browser.stream.set live` took 12.0 s to return and the first frame came at 35.9 s (the cold start through `units.sock`: Xorg, Chromium, `desk-stream`); on a fresh c7g.large it took 1.2 s and 2.8 s; the harness's first smoke run on another c7g.large took 23.6 s for the RPC alone. Probable cause is the AMI's EBS blocks loading lazily on first read, and `desk-stream`'s first GStreamer plugin scan; I did not isolate it. Later starts on the same boot: `off` to first frame 287 to 291 ms (c7g.large) and 374 to 385 ms (t4g.medium).
- **B13 and VFR:** the ADR default makes `warm` to `live` slower than CBR (74 to 98 ms p50, 118 to 138 p95, against 50/58 on c7g.large and 55/66 on t4g.medium), because a resumed encoder drops identical frames until the page changes or the heartbeat fires. All are inside 300 ms.

## 7. `deskd`, `desk-rtc` and `desk-stream`: what worked and what didn't

- **`deskd`'s real `browser.stream.set` path worked on a real boot,** with no fallback: `live` started `desk-browser` and `desk-stream` through `units.sock`, `warm` paused them, `off` stopped `desk-stream`, and `stream.state` and `session.video` behaved as the runtime spec says (about 160 to 270 ms for the RPC to return, with media already flowing about 50 ms after the request). `desk-rtc` 0.2.0 served the answer with `playout-delay` and `a=sendonly` on both tracks, 1080p and 1280x800 H.264 decoded in Chrome for Testing. No errors or warnings in the journals of `desk-stream`, `desk-rtc` or `desk-browser`. In `deskd`'s journal: `ERROR BootSequence no API base for Env tag dev: every session stays refused` before `DESKD_API_URL` was set (documented fail-closed), and one `Failed with result 'exit-code'` for a `systemctl restart` (SIGTERM, status 143).
- **Release status:** `desk-service-release.sh status deskd` shows `2026.11.05-bf3c366` as `PASSED-TEST: no` (the two older releases are `yes`). I ran it anyway as asked.
- **Not bugs, but surprises:**
  1. `deskd` can't start against the shim on an instance with no IAM role: with the real IMDS and no role, hello fails with `WARN BootSequence hello failed: IOException` (the cause, "this instance has no role", is not in the message). A dev run needs `fake-imds.py` as well as the shim; `desk-rtc/README.md`'s "Run the shim and desk-rtc against your own deskd" table does not list it.
  2. `CPUWeight=400` on `desk-stream` keeps the stream at 60 fps by starving Chromium when the CPU is short: the page fell to 35 fps scrolling while the client counted 60. That is the design's choice ("a late frame is worse than a slower page") but it hides a miss from any fps counter on the client.
  3. The kiosk (`--kiosk`) ignores `xrandr` mode changes and `Browser.setWindowBounds`, so a runtime resolution change needs more than `xrandr` (section 5).
  4. VFR gives a steady 0.5 dropped frames per second at the receiver (section 3), and the same bitrate unexplained between boxes (section 4).

## 8. Spend and clean-up

About **$0.6, estimated** (not billed): c7i.xlarge 1.73 h $0.31; c7g.large 0.68 h + 0.21 h $0.06; t4g.medium 0.79 h $0.03; surplus credits $0.02; public IPv4 about $0.02; EBS about $0.01; client to desk traffic over public IPs about 5 GB, $0.1 (estimate). All three instances were terminated and confirmed with `describe-instances` (no instance, volume, security group or key pair tagged `Purpose=browser-benchmark` is left; the key pair and `.pem` were deleted). The owner's desk `<instance>` and test desk `<instance>` were not touched (still running). `<instance>` was not touched and was found stopped.

## 9. Not verified

- **Scan-out and a real display.** B12's photon is the decoded frame's callback in new-headless Chrome with software decode on x86. A GPU client, Safari, Firefox and phones add their own time.
- **Real browsing.** No real sites were loaded (bot walls from AWS addresses), and no mixed browsing session was run, so GB/h for "typical browsing" is not re-measured and the ADR 0033 figure (0.59 GB/h) stands unchecked. The static-page numbers use a blank page.
- **Loss and jitter.** Constant 30 ms, no loss, no bursts; ADR 0034 measured 1% loss separately. No transport-wide congestion control exists yet.
- **The image change** (a 1280x800 screen) was emulated, not built. Its size effect on Chromium's memory and the video page's presentation at 1280x800 is as measured with the emulation only.
- **Single boot per instance type per row group:** rows 1 and 4 shared one c7g.large boot, rows 2, 3, 5 and 6 one t4g.medium boot, row 7 a second c7g.large boot. Boot-to-boot variance (the first-start times above differ 10x) is not characterised.
- **Row 6 has 2 repeats.** The deskd-restart result is one run per size.
- **Not run:** the `deskd` restart burst with a stream alive (impossible in v1), minified mode, guild hosts, the capped profile on c7g.large.
