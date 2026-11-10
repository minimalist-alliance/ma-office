# W3: `t4g.medium` at 1280x800 and 1600x900 against `c7g.large` at 1920x1080 (2026-11-06)

Status: measured, 3 rounds per desk and size, every scenario in every round, no round failed. **No verdict here:** the judge is the Product Designer session, and this feeds decision L6 (member desk size). 1600x900 was added at the owner's request ("Can we try to do 1600x900 equivalent at least please? or at least 720p equivalent?"), on the same temporary desk, which was then put back to 1280x800. Kit: `e2e/w3/` (`main`'s `e0f3a8d`, plus the fixes on `sub/w3`). Each run's own report, with every round, is its `numbers.md` (section 5).

## 1. Headline numbers

Median of the 3 rounds, with [min-max] where they differ. **Page fps is the verdict number** (the rAF callback inside the desk's Chromium). Decoded fps, in section 3, reads about 60 on every moving page of every run, because the encoder repeats frames.

| | `c7g.large` 1920x1080 | `t4g.medium` 1280x800 | `t4g.medium` 1600x900 |
|---|---|---|---|
| Scroll, page fps avg / p5 / min (60 s wheel) | 60.0 / 59.1 / 59.0 | 59.4 [57.4-59.4] / 56.2 [38.0-57.7] / 44.6 [12.1-49.5] | 59.2 [58.8-59.4] / 56.4 [49.9-57.6] / 46.0 [43.0-47.9] |
| Scroll, longest gap between page frames | 17 ms | 150 [133-200] ms | 183 [67-200] ms |
| Video page (1080p60 clip, full page), page fps avg / p5 | 60.0 / 59.8 | 58.1 [57.7-59.1] / 51.8 [49.0-57.4] | 37.2 [37.1-37.4] / 32.0 [32.0-32.4] |
| Video page, frames presented per s / dropped in 30 s | 59.9 / 0 [0-2] | 57.6 [57.5-59.0] / 235 [229-251] | 37.2 [36.6-37.4] / 869 [867-897] |
| Motion page (full-screen canvas), page fps avg | 31.4 [31.3-31.5] | 23.1 [23.0-23.3] | 19.3 [19.0-19.8] |
| Static page and flicks, page fps avg | 60.0 and 60.0 | 60.0 and 59.9 | 60.0 and 59.5 |
| Input to screen, idle, p50 / p95 | 77.0 [77.0-83.4] / 94.7 [93.1-95.7] ms | 85.9 [84.9-86.2] / 103.6 [101.6-107.2] ms | 85.9 [79.7-89.2] / 108.0 [104.3-109.5] ms |
| Input to screen, clip playing, p50 / p95 | 94.2 [91.0-100.3] / 108.4 [108.4-117.7] ms | 94.9 [91.3-101.1] / 120.7 [106.2-122.4] ms | 98.7 [95.4-102.4] / 117.2 [117.0-123.7] ms |
| Typing, key to screen p50 / p95; text right | 78.5 / 100.1 ms; 3 of 3 | 78.5 / 100.9 ms; 3 of 3 | 92.2 / 106.2 ms; 3 of 3 |
| `warm` to `live`, first frame p50 / p95 | 99.3 / 149.5 ms | 110.2 / 154.4 ms | 108.9 / 161.4 ms |
| Window open to first frame (9 opens) | 320 to 340 ms | 395 to 447 ms | 413 to 465 ms |
| Desk CPU, whole machine: idle page / scroll / video / clip at 520x292 | 11.3 / 55.6 / 60.8 / 53.7 % | 13.0 / 56.6 / 87.4 / 64.7 % | 14.4 / 71.6 / 92.5 / 72.5 % |
| Stream, Mbps: static / scroll / motion / video | 0.81 / 3.15 / 7.73 / 7.29 | 0.56 / 2.76 / 3.92 / 4.53 | 0.66 / 3.44 / 4.89 / 5.77 |
| RTT (ICE, client to desk), every round | 47 to 58 ms, median 53 | 46 to 58 ms, median 53 | 46 to 61 ms, median 53 |
| Client load (1-minute load average, 6 cores), every round | 1.18 to 4.97 | 0.60 to 2.94 | 0.99 to 3.24 in rounds 1 and 2; 1.93 to 11.68 in round 3 |

**Budgets, for reference only** (design §2.2, as `docs/benchmarks/2026-11-real-stack.md` states them): B11 scroll page avg >= 58, p5 >= 55, zero freezes; B12 input to screen p50 <= 90 and p95 <= 150 **at 30 ms RTT from an unloaded client**; B13 `warm` to `live` <= 300 ms. **These latency numbers are not a B12 reading:** they come from this workstation at about 53 ms RTT, so they compare the runs with each other and nothing else (the kit's own `numbers.md` says so for each). A 60 Hz display adds up to one frame on top of any latency here.

**Facts the judge may want beside the table, with no reading of them:**
- **1600x900 has 41% more pixels than 1280x800, and 69% of 1920x1080's.** On the video page it presented 37 frames a second and dropped 869 of the clip's frames in 30 s, at 92% desk CPU. Scrolling held a 59.2 average at 72% CPU, against 57% at 1280x800.
- **The 1600x900 run's round 3 had a busy client:** from 08:39 UTC the workstation's load rose as high as 11.7, from other work on the machine (this run held the build lock throughout). Page fps is counted on the desk and read the same in that round (video 37.4, scroll 58.8). The latency and typing rounds in it read idle p50 89.2, loaded 95.4 and typing 92.2, against 85.9 and 79.7, 98.7 and 102.4, and 93.4 and 86.3 in rounds 1 and 2.
- **The 1280x800 scroll stalled once:** round 2 dropped to 12.1 page fps at its worst second (p5 38.0, longest gap 200 ms). Rounds 1 and 3 had p5 56.2 and 57.7. `c7g.large` never went under 58.9 in any second of any round. No freezes at the client in any run.
- **Single wheel flicks fell short on `t4g.medium`:** by 160 px in 9 of 18 at 1280x800, and by 60 px in 7 of 18 at 1600x900. None did on `c7g.large`. Bursts of 20 and 40 frames landed exactly on every run. Table in section 3. The kit's README suspected `desk-rtc`'s 960 px `wheelBatch` against a short screen; this shows a shortfall, not its cause.
- **The video page at 1280x800:** the desk's Chromium dropped about 8 frames a second of the clip (235 in 30 s) at 87% CPU; on `c7g.large`, 0 dropped at 61%. `t4g.medium` is on unlimited credits, so it was never throttled. In the 1280x800 run its balance was 0 at the start and the end, and surplus credits went from 28.4 to 36.1, about half a cent at $0.04 a vCPU-hour. In the 1600x900 run the balance went from 9.3 to 2.1, with no surplus.
- **The motion page is under 60 on every run** (31, 23 and 19 fps): 24 radial gradients redrawn over the whole screen every frame is more than the desks' software-rendered Chromium keeps up with, at each desk's own size.
- **Latency, round by round:** at 1280x800, idle p50 was 3 to 9 ms higher than `c7g.large` (84.9, 85.9, 86.2 against 77.0, 77.0, 83.4). With the clip playing the p50s overlap (94.9, 101.1, 91.3 against 94.2, 91.0, 100.3), and the p95 medians are 120.7 and 108.4, with overlapping ranges. The highest client load in the 1280x800 and 1080p latency passes (4.97) was during `c7g.large`'s first loaded round (p50 94.2, p95 117.7).
- **Bandwidth, against 1080p for the same page:** 1280x800 sends 12 to 49% fewer bits (static 31%, scroll 12%, motion 49%, video 38%). 1600x900 sends 19 to 37% fewer on static, motion and video, and 9% more while scrolling.
- **A stream artifact in two captures (section 4):** after a scroll, text the encoder redrew can show a faint double image on a still page, until a keyframe replaces the frame.

## 2. What was the same, and what wasn't

**The same on every run:** image `ma-desk-0.2.2` (`<ami>`), `desk-rtc` 0.2.1, `desk-stream` 0.2.1, `deskd` `2026.11.05-f2711bb` for every measurement (one exception for captures, below), Chromium `156.0.8078.79-1~deb13u1`, `stream.conf` `155a7c94aab1c8ae` (x264 quantizer 23 capped at 8 Mbps, ultrafast, zerolatency, constrained baseline), us-east-1a, 2 vCPUs and about 3.8 GiB each. Client: a workstation (6 shared vCPUs), Chrome for Testing 156.0.8078.4 from Playwright 1.64.1, new headless, software H.264 decode, 1920x1080 at scale 1 for the numbers, through `office.staging.minimalistalliance.com`. Clip: the real-stack report's Big Buck Bunny cut (`W3_VIDEO`, the Clarkson mirror's zip), 56.9 s, 3414 frames, 60 fps, no audio, **the same video bytes on every run** (sha256 `4bafdddbd3bbb8f6…`). Every click of the size check (four corners and the middle) landed, and screen, page and stream were the same size within each run.

**Not the same:**
- Account and desk: `desk-1` (`<test-desk>`, `<instance>`, up since 2026-11-05 23:32 UTC) and `desk-2` (`<desk-id>`, `<instance>`, up since 2026-11-06 03:56 UTC, for both of its sizes). `desk-2` owns one desk, so its office shows no desk filter in the top bar of the window captures.
- **App build:** `2026.11.06-dd3958e` for the 1280x800 and 1080p measurements, `2026.11.06-2fe509c` for the 1600x900 one: staging's app changed in between.
- **`deskd` on the reference, for its recapture only:** the weekend integrators rolled `deskd` `2026.11.06-1599b0c` onto the test desk after its measurement, so the `c7g.large` captures ran on that build. Every `c7g.large` number here comes from the earlier run on `2026.11.05-f2711bb`. `desk-stream`, `desk-rtc`, Chromium and the image, which make the picture, were the same.
- Screen sizes on the temporary desk come from the root edit `e2e/w3/desk-screen-1280x800.sh`: 1280x800 by Platform at about 04:01 UTC; 1600x900 by me at 08:20 (`--size 1600x900`, the CVT mode at 59.95 Hz) and back to 1280x800 at 08:54. Every edit passed the script's six readback checks (X screen, Chromium's window, the page's view, a captured frame to its last row and column, the encoder's output, `deskd` healthy). x264 chose level 4 at 1280x800 and 4.2 at 1600x900. The desk never stopped, so no edit had to survive a stop.
- Credits: `t4g.medium` is burstable (unlimited) and `c7g.large` isn't. The `c7g.large` `numbers.md` prints its credit mode as `standard`, which is AWS's answer for a type with no credits; the kit now prints "not a burstable type" there.
- When: measured `t4g.medium` 1280x800 05:51 to 06:10 UTC, `c7g.large` 06:14 to 06:33, `t4g.medium` 1600x900 08:25 to 08:45. The captures in use: 1280x800 07:19 to 07:24, `c7g.large` 07:50 to 07:52 (1920x1080@1) and 08:23 to 08:26 (1512x982@2), 1600x900 08:45 to 08:55. One after another, never two at once.
- Before its first run, the temporary desk had a W3 tab left over from a cut-off run (section 6), playing the clip for about 50 minutes. That run closed it before its first page, and its idle-page CPU (11.4% with the stream live) is in line with `c7g.large`'s (9.4%).
- Every run held this workstation's shared build lock (`flock ~/work/.build.lock nice -n 10`), so no other agent's build ran beside it here. Other work on the machine (the owner's kiosk, processes not under the lock) went on; client load is in every table.

**Read against the real-stack report (2026-11-05), for context only.** That ran at 30 ms RTT from a dedicated client, with `desk-rtc`/`desk-stream` 0.2.0 and a `deskd` build of that day, and emulated 1280x800 with CDP. Its row 3 (`t4g.medium`, this `stream.conf`, 1280x800) read scroll 59.7, video presented 58.2, CPU 61% scroll and 87% video; here 59.4, 57.6, 57% and 87%. Its row 7 (`c7g.large`, this `stream.conf`, 1080p) read video presented 49.4 at 85% CPU and scroll at 74% CPU; here `c7g.large` presented 59.9 at 61% and scrolled at 56%. I didn't find why row 7 differs. Its row 6 (`t4g.medium`, this `stream.conf`, 1080p) presented 50.5 on the video page at 95% CPU; 1600x900 here presented 37.2 at 92%.

## 3. Every scenario

Generated by `~/work/16f-w3/compare.py` from the three `numbers.json` files (median [min-max] over the 3 rounds). Per-round rows, with each round's RTT and client load, are in each run's `numbers.md`. Desks: `c7g` is `c7g.large` 1920x1080, `t4g` is `t4g.medium` at the size given.

### Page fps and desk CPU

| Scenario | Desk | Page fps avg | p5 | min | Longest gap ms | Decoded fps | Freezes | Mbps | GB/h | Desk CPU % | `desk-stream` / Chromium, % of a core | RTT ms | Client load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| static | c7g 1920x1080 | 60.0 [59.9-60.0] | 60.0 [59.6-60.0] | 59.9 [59.0-60.0] | 17 | 10.0 | 0 | 0.81 [0.80-0.87] | 0.36 [0.36-0.39] | 11.3 [8.9-11.4] | 14 / 4 | 53.5 [52.0-55.5] | 2.35 [1.18-2.71] |
| static | t4g 1280x800 | 60.0 [59.9-60.0] | 60.0 [59.4-60.0] | 59.9 [59.0-60.0] | 17 | 10.0 | 0 | 0.56 [0.56-0.62] | 0.25 [0.25-0.28] | 13.0 [10.6-13.9] | 14 [13-15] / 6 | 51.0 [50.0-58.0] | 1.92 [0.98-2.09] |
| static | t4g 1600x900 | 60.0 [59.9-60.0] | 60.0 [59.0-60.0] | 60.0 [59.0-60.0] | 17 [17-33] | 10.0 | 0 | 0.66 [0.65-0.71] | 0.30 [0.29-0.32] | 14.4 [12.9-14.5] | 18 [17-18] / 6 | 56.5 [55.0-58.0] | 1.72 [0.99-1.93] |
| scroll | c7g 1920x1080 | 60.0 | 59.1 [59.0-59.1] | 59.0 [58.9-59.0] | 17 | 60.0 | 0 | 3.15 [3.09-3.21] | 1.42 [1.39-1.44] | 55.6 [54.7-56.2] | 58 / 40 | 52.0 [51.0-53.0] | 2.26 [1.82-2.80] |
| scroll | t4g 1280x800 | 59.4 [57.4-59.4] | 56.2 [38.0-57.7] | 44.6 [12.1-49.5] | 150 [133-200] | 59.6 [58.2-59.7] | 0 | 2.76 [2.73-2.83] | 1.24 [1.23-1.27] | 56.6 [55.4-58.6] | 52 [51-54] / 49 [48-49] | 53.0 [52.0-54.0] | 1.18 [0.84-1.74] |
| scroll | t4g 1600x900 | 59.2 [58.8-59.4] | 56.4 [49.9-57.6] | 46.0 [43.0-47.9] | 183 [67-200] | 59.6 [59.3-59.6] | 0 | 3.44 [3.39-3.55] | 1.55 [1.52-1.60] | 71.6 [71.5-72.9] | 69 [68-70] / 59 | 53.0 | 2.33 [1.16-4.66] |
| motion | c7g 1920x1080 | 31.4 [31.3-31.5] | 29.8 [29.7-30.3] | 28.7 [28.5-30.2] | 67 [50-67] | 60.0 | 0 | 7.73 [7.70-7.76] | 3.48 [3.46-3.49] | 85.2 [85.1-85.4] | 80 [79-80] / 82 | 53.0 [51.0-54.0] | 2.07 [2.04-2.43] |
| motion | t4g 1280x800 | 23.1 [23.0-23.3] | 21.0 [20.4-21.5] | 17.1 [13.6-20.3] | 233 [117-250] | 59.5 [59.4-60.0] | 0 | 3.92 [3.92-3.96] | 1.76 [1.76-1.78] | 80.2 [79.6-80.3] | 63 [63-64] / 87 | 54.0 [50.0-55.0] | 1.61 [0.60-1.74] |
| motion | t4g 1600x900 | 19.3 [19.0-19.8] | 17.6 [15.1-18.3] | 12.4 [8.2-14.5] | 300 [284-400] | 58.6 [58.2-59.5] | 0 | 4.89 [4.84-4.98] | 2.20 [2.18-2.24] | 87.1 [85.8-87.5] | 85 [84-85] / 78 [77-79] | 52.0 [52.0-53.0] | 2.91 [1.89-9.43] |
| video | c7g 1920x1080 | 60.0 | 59.8 [59.8-59.9] | 59.0 [59.0-59.1] | 17 | 60.0 | 0 | 7.29 [7.15-7.31] | 3.28 [3.22-3.29] | 60.8 [59.9-60.9] | 68 / 43 | 50.0 [49.0-50.0] | 2.46 [1.92-2.46] |
| video | t4g 1280x800 | 58.1 [57.7-59.1] | 51.8 [49.0-57.4] | 42.5 [40.3-56.0] | 150 [33-183] | 59.7 [59.0-60.0] | 0 | 4.53 [4.48-4.55] | 2.04 [2.02-2.05] | 87.4 [87.1-87.7] | 55 / 109 [108-110] | 54.0 [50.0-54.0] | 1.66 [1.23-2.14] |
| video | t4g 1600x900 | 37.2 [37.1-37.4] | 32.0 [32.0-32.4] | 30.0 [23.0-31.1] | 67 [50-150] | 60.0 [59.4-60.0] | 0 | 5.77 [5.63-5.93] | 2.59 [2.54-2.67] | 92.5 [90.6-92.9] | 77 [76-78] / 96 [94-96] | 55.0 [52.0-56.0] | 3.05 [1.32-11.68] |

Static is a still article, so the stream sends its 10 fps heartbeat. Scroll is 60 s of wheel at about 1200 px/s through the app's own wheel listener, reversing every 4 s. Motion is 24 moving gradients on a full-screen canvas. Video is the clip filling the page, decoded in software by the desk's Chromium.

### The video page

| Desk | Presented fps | Video frame callbacks per s | Decoded fps | Dropped in 30 s | Clip |
|---|---|---|---|---|---|
| c7g 1920x1080 | 59.9 [59.9-60.0] | 47.0 [46.6-47.4] | 60.0 | 0 [0-2] | 1920x1080 |
| t4g 1280x800 | 57.6 [57.5-59.0] | 46.6 [45.8-47.4] | 59.4 [59.2-60.0] | 235 [229-251] | 1920x1080 |
| t4g 1600x900 | 37.2 [36.6-37.4] | 28.1 [27.2-28.3] | 60.0 [59.0-60.0] | 869 [867-897] | 1920x1080 |

### Input to screen

A key press in the client to the changed pixel in the decoded frame's callback, 60 trials a pass, `stream.spec.ts`' method. "Clip" is the clip playing at 520x292 beside the square.

| Pass | Desk | Detected | p50 ms | p95 ms | max ms | ICE RTT p50 ms | Jitter buffer ms | Desk CPU % | Client load | One keydown per press |
|---|---|---|---|---|---|---|---|---|---|---|
| idle | c7g 1920x1080 | 60/60, 60/60, 60/60 | 77.0 [77.0-83.4] | 94.7 [93.1-95.7] | 107.6 [102.6-112.6] | 50.5 [50.5-56.0] | 0.4 [0.3-0.4] | 27.3 [25.4-27.4] | 2.26 [1.93-3.48] | yes, yes, yes |
| idle | t4g 1280x800 | 60/60, 60/60, 60/60 | 85.9 [84.9-86.2] | 103.6 [101.6-107.2] | 158.6 [110.2-160.6] | 50.0 [48.5-51.5] | 0.5 [0.4-0.5] | 25.3 [24.6-25.8] | 1.87 [1.83-2.60] | yes, yes, yes |
| idle | t4g 1600x900 | 60/60, 60/60, 60/60 | 85.9 [79.7-89.2] | 108.0 [104.3-109.5] | 122.4 [108.7-167.1] | 50.5 [49.5-57.0] | 0.3 [0.3-0.4] | 30.7 [30.3-32.4] | 2.63 [2.45-7.53] | yes, yes, yes |
| clip | c7g 1920x1080 | 60/60, 60/60, 60/60 | 94.2 [91.0-100.3] | 108.4 [108.4-117.7] | 116.3 [115.3-161.6] | 52.5 [50.5-53.0] | 0.7 [0.6-1.0] | 53.7 [52.9-54.0] | 3.02 [2.47-4.97] | yes, yes, yes |
| clip | t4g 1280x800 | 60/60, 60/60, 60/60 | 94.9 [91.3-101.1] | 120.7 [106.2-122.4] | 165.3 [120.3-244.4] | 52.5 [50.5-56.5] | 0.7 [0.6-0.7] | 64.7 [64.5-64.8] | 1.63 [1.52-2.94] | yes, yes, yes |
| clip | t4g 1600x900 | 60/60, 60/60, 60/60 | 98.7 [95.4-102.4] | 117.2 [117.0-123.7] | 168.6 [133.1-253.6] | 53.0 [50.5-53.0] | 0.6 [0.6-0.8] | 72.5 [71.9-72.7] | 2.20 [2.07-5.15] | yes, yes, yes |

### Typing, `warm` to `live`, first frame

Typing is about 80 words a minute with each key timed as above, then the same 54 characters at a 40 ms gap to see that each lands in order. `warm` to `live` is 12 switches a round on the app's own `rpc` channel. First frame is the real window closed and opened again from its tile, with Chromium already up.

| Desk | Key to screen p50 ms | p95 ms | Keys not timed, per round | Text right, paced and burst | `warm` to `live` p50 ms | p95 | max | Window open to first frame, every open, ms |
|---|---|---|---|---|---|---|---|---|
| c7g 1920x1080 | 78.5 [77.4-89.0] | 100.1 [92.5-101.1] | 1, 1, 1 | yes, yes, yes | 99.3 [95.8-103.4] | 149.5 [145.2-169.7] | 159.0 [151.2-173.1] | 328, 329, 333, 320, 322, 322, 340, 333, 332 |
| t4g 1280x800 | 78.5 [77.7-88.2] | 100.9 [95.2-107.0] | 1, 1, 1 | yes, yes, yes | 110.2 [101.8-112.4] | 154.4 [147.3-156.7] | 167.9 [152.1-170.1] | 405, 438, 408, 395, 403, 447, 411, 424, 426 |
| t4g 1600x900 | 92.2 [86.3-93.4] | 106.2 [98.7-106.4] | 1, 1, 1 | yes, yes, yes | 108.9 [97.8-120.6] | 161.4 [154.3-172.4] | 164.1 [163.1-189.3] | 429, 428, 434, 427, 427, 413, 439, 465, 428 |

One key a round went untimed in every run (the kit doesn't record which); every character still reached the page in order.

### Flicks: px travelled, each round

`desk-rtc` sends 120 px clicks in batches of 8 (960 px), at most 20 per event, and keeps a remainder of up to 119 px. "Reachable" allows for that cap.

| Flick | Reachable px | c7g 1920x1080 | t4g 1280x800 | t4g 1600x900 |
|---|---|---|---|---|
| 480 px | 480 | 480, 480, 480 | 480, 480, 480 | 480, 480, 480 |
| 960 px | 960 | 960, 960, 960 | 960, 800, 800 | 900, 960, 960 |
| 1200 px | 1200 | 1200, 1200, 1200 | 1040, 1200, 1200 | 1200, 1200, 1200 |
| 1920 px | 1920 | 1920, 1920, 1920 | 1760, 1760, 1920 | 1860, 1860, 1860 |
| 2400 px | 2400 | 2400, 2400, 2400 | 2240, 2240, 2400 | 2400, 2400, 2340 |
| 3600 px | 2400 | 2400, 2400, 2400 | 2400, 2240, 2240 | 2340, 2400, 2340 |
| 20 frames of 120 px | 2400 | 2400, 2400, 2400 | 2400, 2400, 2400 | 2400, 2400, 2400 |
| 40 frames of 120 px | 4800 | 4800, 4800, 4800 | 4800, 4800, 4800 | 4800, 4800, 4800 |

Page fps across the flicks: 60.0 (p5 59.4), 59.9 (p5 59.3) and 59.5 (p5 58.3).

### First open on this boot

No run gave a cold number: Chromium was already running on both desks (the root edit starts it on `t4g.medium`). First frame 362, 439 and 429 ms after the window's open mark.

## 4. Captures, and what I saw in them

**Same pages, same words, every run, both client profiles:** a Wikipedia article (`en.wikipedia.org/wiki/Typography`), a dense page with small text (Hacker News' front page for 2024-06-03), and a page in Japanese (`ja.wikipedia.org`'s 活版印刷). Every page in use showed on its first try, and every run found the first run's words. Profiles: a 1512x982 window at scale 2 (a laptop's retina screen) and 1920x1080 at scale 1. The Browser window opens at the app's default in every run, with the same video box (1488x776 and 1896x874 CSS px). So one desk pixel covers this many device pixels:

| Profile | `c7g.large` 1920x1080 | `t4g.medium` 1280x800 | `t4g.medium` 1600x900 |
|---|---|---|---|
| 1512x982 at scale 2 | 1.437 | 1.940 | 1.724 |
| 1920x1080 at scale 1 | 0.809 | 1.093 | 0.970 |

Per page: the decoded frame at 1:1 (`*-top.decoded.png`), the client's screenshot (`*-top.window.png`), and 720x400 crops of the same words from each (`*.crop-decoded.png`, `*.crop-window.png`), side by side in the two `pairs-…` folders.

**Checked by eye.** I looked at every capture of every run as contact sheets (108 files), and at about 20 at full size: the top frames of each page, and the Wikipedia and Hacker News crop pairs. Every page is the one asked for, whole and at the expected size, with no bot wall, cookie banner or half-loaded page.

**What the check found:**
- **A faint double image of text, after a scroll, on a still page.** The client screenshot of the Wikipedia small-text crop at 1920x1080@1 shows ghosted, doubled text in its lower half in two `t4g.medium` captures: 1280x800 (first captures, kept in `~/work/16f-w3/superseded/w3-captures-0635/t4g.medium-1280x800/1920x1080@1/wikipedia-small.crop-window.png`) and 1600x900 (`t4g.medium-1600x900/1920x1080@1/wikipedia-small.crop-window.png`). In the 1600x900 one, the page had not moved for at least 6 s. In both, the decoded crop of the same words taken a moment later is clean, apart from faint off-white blocks. So it's the stream's own frame until a keyframe replaces it: on a still page the client asks for a keyframe every 2 s or so on average (8 in each 15 s static round), but not on a fixed clock. I saw nothing like it in the `c7g.large` captures, which do show the faint off-white blocks. How often and for how long this happens on each size wasn't measured; the captures can't say.
- **The kit could scroll right before a screenshot.** It re-read the words' place by scrolling to them again, so a crop could follow a fresh scroll. Each crop now waits until its words have stayed put for 6 s, read without scrolling. Every crop in use held still on the first wait. That alone doesn't prevent the double image above, which is why the 1600x900 crop still shows it.
- **The dense page's "small" crop was mostly empty** in the first captures: a crop started at its words, and the small words there, a link's site name at 10.7 px, end their lines. Crops now start where their paragraph, list item or table cell starts, if the words still fit, so that crop holds titles, site names and the 9.3 px lines under them.
- All first captures (06:35 to 06:45 UTC) were retaken with the fixed kit and are not paired; they're in `~/work/16f-w3/superseded/`. Hacker News refused the reference once during the retake ("Sorry, we're not able to serve your requests this quickly"), so that profile was taken again until it served the page. At 1600x900, Chromium's debugging port twice timed out a connection during captures, which the kit now retries (section 7).

**Things the judge should know before looking:**
- **The Japanese page shows boxes on every run:** `ma-desk-0.2.2` has no Japanese fonts (`fc-list :lang=ja` counts 0 on both desks). Only the Wikipedia logo, an image, shows real characters. That page shows layout only; `0.2.3` adds the fonts.
- **No frame is bit-for-bit still** in any run ("Still 4.5 s later: false" in every capture README): each capture is whichever frame was current, between keyframes.
- The reference's tab strip, in its window screenshots, shows tabs other sessions opened on the shared test desk. W3 works in a tab of its own.
- The client screenshots come from headless Chrome's software scaling. A browser using a GPU, or a real display, may scale differently.

## 5. Where everything is

- **Numbers:** `~/work/16f-w3/w3/<label>/numbers.md` (every round, with RTT and client load) and `numbers.json` (raw), for `c7g.large-1920x1080`, `t4g.medium-1280x800` and `t4g.medium-1600x900`.
- **Captures:** `~/work/16f-w3/w3/<label>/<profile>/`, described by `~/work/16f-w3/w3/<label>/README.md`. Side by side: `~/work/16f-w3/w3/pairs-c7g.large-1920x1080-vs-t4g.medium-1280x800/` and `…-vs-t4g.medium-1600x900/`, each with its `README.md`. `pages.json` there records the pages and words every run used. These stay on this machine, outside git: they hold copies of third-party pages, and `numbers.json` holds the desks' public addresses.
- **Logs:** `~/work/16f-w3/logs/`. Rerun with `~/work/16f-w3/run-w3.sh <t4g|t4g1600|c7g|pair|pair1600> <measure|capture|pair> [playwright args]`. It holds the build lock, and `~/work/.test-desk.lock` for the reference desk. Regenerate the tables with `python3 -I ~/work/16f-w3/compare.py <numbers.json>...`.
- **Not used:** `~/ma-design-drafts/w3/t4g.medium-1280x800/` holds the first, cut-off run on the temporary desk (04:54 to 05:04 UTC, before this task: one and a half rounds, stopped by a tool's 10-minute limit). `~/work/16f-w3/superseded/` holds the captures from before the capture fixes.

## 6. What made a run invalid

- **No measurement:** 3 of 3 rounds of every scenario in every run, no errors, no reruns, every size check and click landed, the same clip bytes everywhere, no other viewer on either desk. The 1600x900 run's round 3 had a busy client (section 1).
- **The first captures,** for the empty small crop and the scroll right before a screenshot (section 4). All retaken.
- **The earlier cut-off run** (section 5) left its tab on the temporary desk playing the clip until this set's first run closed it. The kit now does that on its own.
- **Limits on every number here:** latency from a shared workstation at about 53 ms RTT, so no B12 reading; client load is in every row. One client, software decode, headless.

## 7. Kit changes on `sub/w3`

- A run closes any tab a cut-off run left on its page server (`pages.ts`, `deployPages`), and `numbers.md` says how many.
- Crops wait until their words have stayed put for 6 s, read without scrolling, and start where the words' block starts (`capture.spec.ts`, `pages.ts`).
- CDP reads on the desk are tried up to 4 times, 30 s apart. On `0.2.2` the 9222 rule rejects the kernel's closing packets, so finished connections sit in LAST-ACK on Chromium's side (20 of them during the 1600x900 captures). Twice, a new connection then timed out.
- The root edit takes `--size 1280x800` or `--size 1600x900`, and each edit starts from the 1920x1080 originals it backed up (`desk-screen-1280x800.sh`).
- `numbers.md` prints no credit mode for a type without credits.
