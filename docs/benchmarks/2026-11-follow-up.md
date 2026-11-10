# Normal-mode streaming follow-up benchmark (2026-11-05)

Status: measured, one run per cell unless noted. Harness: `spikes/browser-bench/f3.sh`, results: `spikes/browser-bench/followup3/results/*/result.json`, screenshots: `spikes/browser-bench/followup3/shots/`. Recommendation: ADR 0033.

## 1. Verdict (read this first)

**Budgets** (design §2.2): B11 avg >= 58 fps, p5 >= 55, zero freezes in a 60 s scroll; B12 input-to-photon p50 <= 90 ms and p95 <= 150 ms at 30 ms RTT; B13 first frame <= 300 ms after a mode switch. Old script bar for continuity: p50 <= ~140 ms. All rows below run **with the stand-in JVM load** (steady, plus a 65 s burst of about 1 vCPU overlapping scroll, latency and video). "Combined" = VFR + text-optimized x264 (CRF 23, capped 8 Mbps) + 1280x800 desktop, libyuv NV12 capture, Chromium nice 10.

| Size ($/month always-on, on-demand + 24 GB gp3) | Config | B11 (fps scroll / video; 60 s wiki p5; freezes) | B12 p50 / p95 ms (passes: standard, low-jitter, burst) | CPU scroll / video % (burst video) | Verdict |
|---|---|---|---|---|---|
| t4g.medium ($26.13) | stock 1080p (no stand-in; fails without it) | 53.7 / 40.3; p5 41; 0 | 123 / 141 | 99 / 100 | **fails B11** |
| t4g.medium | tuned 1080p + load | 59.8 / 59.7; p5 60; 0 | 109 / 124 (108, 107, 118 burst) | 88 / 95 (99) | B11 pass, B12 p50 **fails by ~19 ms**, p95 pass |
| t4g.medium | **combined 1280x800 + load** | 59.3 / 59.8; p5 60; 0 | 106 / 131 (106, 117, 92 burst) | 61 / 93 (99) | B11 pass, B12 p50 **fails by ~16 ms**, p95 pass |
| t4g.medium | combined 1600x1000 + load | 59.2 / 59.8; p5 60; 0 | 111 / 134 (111, 99, 89 burst) | 78 / 98 (100) | passes fps, no CPU headroom |
| c7g.large ($54.52) | stock 1080p + load | 59.7 / 59.8; p5 60; 0 | 107 / 128 (107, 108, 106 burst) | 73 / 77 (97) | B11 pass, B12 p50 fails by ~17 ms |
| c7g.large | combined 1280x800 + load | 59.4 / 59.8; p5 60; 0 | 90 / 111 (90, 94, 106 burst) | 41 / 64 (93) | B11 pass, B12 p50 **borderline (0 to 16 ms over)** |
| m7g.large (~$61, estimate) | combined 1280x800 + load | 59.4 / 59.8; p5 60; 0 | 85 / 109 (85, 79, 108 burst) | 41 / 64 (94) | B11 pass, B12 p50 borderline (met in 2 of 3 passes) |

- **Smallest instance that passes: t4g.medium, only at 1280x800 with the combined profile.** It meets B11 with the stand-in load, including during the burst (fps 59.2 scroll, 60.0 video), and B12 p95. It has no CPU headroom while a 1080p video plays (93% steady, 99% in a burst); fps held only because the stand-in ran at a low CPU weight (`--cpu-shares 128`), which a real `deskd` must also do.
- **No size passes B12's p50 reliably, and I'm not softening it.** t4g.medium misses by about 16 ms (median of its passes 106 ms against 90). c7g.large and m7g.large sit at 85 to 106 ms, so they hit 90 ms on some passes and miss on others. All pass the old <= ~140 ms bar (worst 125 ms).
- **The miss is not size-bound, so it is not (yet) a Q9 price decision.** Across 40 passes the time until the last packet of the changed frame arrived was 58 to 64 ms on every size (30 ms of that is RTT). The rest is the Chromium receiver's jitter buffer (29 to 52 ms measured, varying run to run, which is the +-15 to 20 ms spread) plus decode and display. Setting `jitterBufferTarget = 0` (design §6.5 relies on it) changed nothing in Chromium 155 (the "low-jitter" passes match the standard ones). Paying +$28/month for c7g.large buys at most the 0 to 16 ms that is inside the noise. The fix to test is on the sender side (`desk-rtc` sending the RTP `playout-delay` extension with max 0; **not tested here, an untested idea**). If that fails, the price question for the owner is whether to accept p50 ~105 ms on t4g.medium, or pay for c7g.large and still not be sure of 90 ms.
- **B13 not measured.** A new Neko connection takes 4.5 s to its first frame (`client_connect_s` 4.49 to 4.66 s in every run): Neko v3.2 ignores PLI, so a joining viewer waits for the periodic 4 s keyframe. B13 needs `desk-rtc` to force an IDR on resume.
- **Stand-in effects:** no fps loss (59.2 to 59.9 in every burst). Burst raised p50 by about 0 to 22 ms (c7g 90 to 106, m7g 85 to 108, t4g tuned 109 to 118; t4g combined 106 to 92, which is noise). Steady load adds 0.8 GiB RSS and about 2.5% CPU.
- **If the owner wants the margin:** none is needed for B11 on t4g.medium at 1280x800, but a larger instance buys CPU headroom (c7g.large at 41% scroll / 64% video against 61% / 93%), which matters for real `deskd` bursts. This is a call for the real-`deskd` confirmation run.

## 2. Method and what changed

- **Client:** dedicated `c7i.xlarge` (4 vCPU, x86) in the same AZ and VPC as the server, connecting over private IPs. `tc netem` adds 15 ms each way on both NICs: **30 ms RTT** (TCP connect 30.8 ms median; ICE RTT 31 ms), constant, no loss. Headless Playwright Chromium, viewport set to the stream's pixel size. **The client decoded every run at 1080p60 without a dropped frame, peaking at 22% of 4 vCPU.**
- **How the new client changed the baselines** (stock config):

| | old (workstation, ~53 ms RTT, contended) | new (c7i.xlarge, 31 ms RTT) |
|---|---|---|
| c7g.large fps scroll / video | 59.9 / 59.95 | 59.8 / 59.5 |
| c7g.large input-to-photon p50 / p95 | 126 / 144 (second run 141 / 158) | 123 / 140 |
| t4g.medium fps scroll / video / wiki | 55.2 / 46.3 / 49.7 | 53.7 / 40.3 / 48.1 |
| t4g.medium input-to-photon p50 / p95 | 152 / 168 | 123 / 141 |

  Frame rates are about the same (the t4g video figure is lower, so the earlier workstation numbers were not too pessimistic). Latency fell about 20 to 30 ms, which matches the 22 ms RTT reduction. The conclusions did not change.
- **Server:** Neko v3.2.0 (x264 ultrafast, zerolatency, constrained baseline, 1080p60 8 Mbps CBR as the stock config), Ubuntu 24.04 arm64, Docker, host networking, `unlimited` credits on t4g. Chromium Debian build 155.
- **Stand-in load** (`spikes/browser-bench/standin/`), **a stand-in, not `deskd`:** two `eclipse-temurin:21-jre` containers, host networking, SerialGC, `-Xms300m -Xmx340m`, `--cpu-shares 128` against Neko's default 1024. Measured: RSS 405 + 405 MB, steady CPU about 1.2 to 2.8% per container (first runs 2 x 2.5%; later 2 x 1%, about 2.5% combined). Burst: both containers at 50% duty for 65 s, about 1 vCPU, started before the scroll+latency phase and again before the video phase. A real `deskd` confirmation run comes later.
- **Measurements:** `measure.py` (idle, scroll page, video 60, wiki scroll, 40-trial photon probe, optional 60 s B11 wiki scroll with per-second fps) and `session.py` (scripted 10-minute sessions). Browse: ten 60 s cycles of 6 s navigation, 21 s read, 12 s scroll, 21 s read, so reading 70%, scrolling 20%, navigation 10%; pages are live Wikipedia (Turing, Linux, Coffee, Typography) and local `inbox.html` / `article.html`. Video: a synthetic 1080p60 test pattern with temporal noise (pessimistic for bitrate; no real footage was streamed). GB/h is bytes received by the client over the ICE candidate pairs (all RTP, RTCP and data channel) per second of the session. Surplus credits come from CloudWatch.
- **Latency probe:** key press on the client flips a square on the remote page; time to the frame callback that shows it. A pass is 40 trials. Each config has 2 to 3 passes (standard, low-jitter, burst); I report all of them because a pass varies +-15 ms by itself.
- **Counter fix:** an early ICE pair switch corrupted the byte counters of two sessions (base video, 1280x800 browse). The harness now sums every candidate pair. Those two were re-run (base browse 1.76 to 1.80 GB/h; 1280x800 browse corrected from a negative value to 1.35). Old and new are both kept (`*-oldcounter`). Other sessions had no negative segment.
- **Lost run:** the first t4g.medium combined+load attempt failed because the minified server still held port 8080. It was re-run on a fresh t4g.medium (a different instance, so credits start again); the failed directory is kept as `*-FAILED-port8080`.

## 3. t4g.medium CPU tuning (1080p unless noted; quick runs: scroll page, video, 40-trial photon)

| Variant | CPU idle / scroll / video % | fps scroll / video | p50 / p95 ms | Result |
|---|---|---|---|---|
| stock (videoconvert, 2 threads) | 70 / 99 / 100 | 53.7 / 40.3 | 123 / 141 | fails |
| libyuv I420 (NEON, `yuvconv`, replaces videoconvert) | 47 / 85 / 93 | 59.8 / 55.5 | 125 / 141 | **-14 pts scroll CPU** |
| libyuv **NV12** | 49 / 84 / 93 | 59.9 / 55.5 | 108 / 128 | same CPU as I420 |
| NV12 + x264 threads=1 | 49 / 86 / 93 | 59.2 / 48.5 | 124 / 145 | worse video |
| I420 + **Chromium nice 10** | 46 / 83 / 92 | 59.6 / **59.8** | 125 / 142 | keeps video at 60 fps |
| I420 + Chromium raster/compositor flags | 47 / 84 / 93 | 59.7 / 58.8 | 124 / 140 | no gain |
| I420, 1600x900 (last-resort fallback) | 39 / 70 / 97 | 59.8 / 58.4 | 140 / 159 | not needed |
| I420, 1280x800 | 27 / 54 / 95 | 59.8 / 59.7 | 103 / 123 | big scroll saving |
| **tuned-1080** = NV12 + nice 10 (full run, 60 s B11) | 48 / 85 / 93 | 59.7 / 59.8; wiki p5 59.0 | 108 / 128 | **passes B11 at 1080p** |

Direct capture is BGRx (X11) plus a NEON converter; GStreamer's `videoconvert` was the extra cost. Damage-based capture is the VFR element below (it compares frames; `ximagesrc use-damage` alone still emits 60 fps). x264 preset stays ultrafast (nothing cheaper). **1080p video cost is mostly Chromium's software decode and the encoder: 92 to 97% CPU in every variant, so the t4g.medium has no headroom on video.** 1600x900 was measured and is not needed.

**Soak (17.5 min, tuned-1080 + stand-in, alternating scroll and video, unlimited credits):** fps 59.96 scroll / 59.98 video (range 59.92 to 60.0), CPU 85% / 92%, steal 0.07%, zero drops or freezes. CloudWatch CPU credit usage over the 15 full minutes: 24.9 credits (99.6 credits/hour, 83% of 2 vCPU).

**Surplus-credit cost** (model; inputs are measured credit use per streaming hour: tuned-1080 soak 99.6, combined typical browsing 33, combined 1080p video 113, no viewer 3 (2.5% CPU measured with stand-in); earn 576/day; $0.04 per vCPU-hour; instance $26.13):

| Streaming | tuned-1080 (soak mix) | combined, typical browsing | combined, 1080p video |
|---|---|---|---|
| 2 h/day | $0 surplus, $26.13 | $0, $26.13 | $0, $26.13 |
| always on (24 h/day) | +$36.77 = **$62.90** | +$4.38 = **$30.51** | +$43.29 = **$69.42** |

Observed: the first t4g.medium (launched with a 0 credit balance in this account) accrued 266 surplus credits (about $0.18) over 5.5 h of mixed heavy use and was never throttled (unlimited). Always-on at video-level load costs more than c7g.large ($54.52); always-on typical browsing costs less than any alternative.

## 4. Bandwidth study (t4g.medium, H.264 only, 10-minute sessions, 60 fps held in every run)

Base = tuned-1080 (CBR 8 Mbps). Browse columns are GB/h for the whole session; read = static pages.

| Technique | Browse GB/h (read / scroll Mbps) | Video GB/h | CPU % (browse overall / video) | fps scroll avg (p5) | Photon p50 ms | Note |
|---|---|---|---|---|---|---|
| base 1080p CBR 8 Mbps | **1.80** (3.1 / 7.2) | **3.70** | 62 / 91 | 60.0 (60) | 124 | |
| (a) VFR (drop identical frames, 10 fps heartbeat, full rate 500 ms after any change) | 1.28 (1.7 / 7.0) | 3.51 | 43 / 93 | 59.4 (53) | 98 | idle CPU 49 -> 20%; **video fps 57.5 avg, p5 43 (95 s under 55 fps)**: the compare costs CPU at 1080p |
| (b) text-optimized x264 (CRF 23, cap 10 Mbps, 150 ms VBV) | 0.99 (0.8 / 7.5) | **4.62** | 57 / 92 | 60.1 (60) | 108 | cap 10 Mbps: video grows; the combined profile uses an 8 Mbps cap |
| (c) 1280x800 | 1.35 (2.2 / 6.2) | 3.70 | 36 / 91 | 60.1 (60) | 132 | CBR spends the budget at any size; CPU halves |
| (c) 1600x1000 | 1.65 (2.8 / 6.9) | 3.70 | 51 / 95 | 60.1 (60) | 141 | |
| **all three, 1280x800** | **0.59** (0.5 / 4.3) | **3.70** | 25 / 92 | 59.4 (53)* | 105 | -67% browse, 0% video |
| all three, 1600x1000 | 0.77 (0.7 / 5.4) | 3.70 | 34 / 96 | 59.4 (53)* | 104 | |

\* The session scroll p5 of 53 comes from the first second of each 12 s scroll: the stream is in 10 fps heartbeat mode when the wheel starts. In the continuous 60 s Wikipedia scroll (B11 proper) the combined profile gave avg 59.95, p5 60, min 59, 0 freezes.

- **Static pages are not near zero:** a blank page costs 45 kbps (10 fps), but a real static text page costs 0.4 to 0.5 Mbps under VFR+CRF, mostly the 4 s keyframe (an IDR of a 1280x800 text page is large). A longer GOP would cut it but conflicts with the 4 s wait for joiners (Neko ignores PLI). Intra refresh (design ADR 0030) would remove the spike; not tested.
- **Sources of savings:** the browse saving comes from the CRF rate control (reading and navigation), VFR adds the idle CPU saving. A fixed 8 Mbps CBR makes size alone save nothing (video 3.70 GB/h at every size). Video has no safe savings at the default profile: the cap defines its cost.
- **Combined on c7g.large, for comparison:** CPU 34% scroll / 65% video (t4g 54% / 94%), photon 92 / 112, fps unchanged. **I did not run the 10-minute sessions on c7g.large** (client box stopped), so its GB/h is assumed equal to t4g's (same pipeline, same output); `measure` bitrate on both was 6.0 to 6.1 Mbps.
- **Photon latency is not affected by any technique**: all runs are inside the 85 to 141 ms noise band; no technique cost frame rate except VFR alone at 1080p on t4g (above, and it disappears at 1280x800).

## 5. Capped profile (after the 100 GB allowance): lower resolution and quality only, 60 fps, same pipeline

| | Settings | Browse GB/h | Video GB/h | 100 GB covers (browse / video) | fps scroll / video; photon p50 / p95 |
|---|---|---|---|---|---|
| **A (recommended cap)** | VFR; x264 `pass=qual quantizer=28`, `vbv-maxrate=4000 vbv-bufsize=600` (150 ms); desktop 1280x800; 60 fps | **0.41** | **1.85** | **244 h / 54 h** | 59.3 / 59.8; 106 / 128 |
| B (deeper) | A but `quantizer=30`, max 2500 / buf 375, desktop 1280x800 scaled to **960x600** for the encode | 0.34 | 0.74 | 294 h / 135 h | 59.3 / 59.9; 111 / 127 |

Default (combined 1280x800) for reference: 0.59 GB/h browse (169 h per 100 GB), 3.70 GB/h video (27 h). **Looks:** A at 1:1 is not distinguishable from the default on text (screenshots `shots/cap-1280-q28-text-*.png` against `all-1280x800-text-*.png`); the synthetic video pattern showed no visible blocking (real footage not judged). B is smaller on screen and soft once the client scales 960x600 back up to the window; it is the emergency tier. Both keep full frame rate and latency (CPU unchanged at 54% scroll / 93% video).

## 6. Minified mode on t4g.medium (prototype `minified-proto`, stand-in Chromium per page, drive on the 30 ms RTT client)

Same sites as the c7g.large run (Wikipedia, Guardian, NPR, DuckDuckGo, form, TodoMVC, react.dev). The prototype runs its own headless Chromium with Neko stopped (no warm paused encoder, no kiosk Chromium), so real desks will use somewhat more.

| Metric | t4g.medium | t4g.medium + stand-in + burst | c7g.large (re-run, same client) | c7g.large + stand-in + burst | old c7g.large (52 ms RTT) |
|---|---|---|---|---|---|
| In-page actions p50 / p95 ms (toggle, SPA add/toggle; n=21) | 64 to 79 / 80 | 65 to 79 / 82 | 63 to 67 / 77 | 64 to 72 / 78 | 82 / 99 |
| SPA route with fetch p50 / p95 | 449 / 778 | 465 / 775 | 264 / 448 | 320 / 462 | 379 / 413 |
| Navigation click p50 / p95 | 815 / 4,671 | 873 / 4,216 | 767 / 2,115 | 780 / 2,650 | 719 / 1,250 |
| Extraction in page p50 ms | 11.1 | 12.6 | 10.8 | 7.6 | 11 |
| Payload (deflate) p50 KB | 3.0 | 2.3 | 2.3 | 2.3 | ~6 raw |
| Local scroll fps | 60 | 60 | 60 | 60 | 60 |
| CPU, document loaded, idle 60 s | 4.9% | 6.3% | 2.6% | 4.0% | n/a |

- MA overhead on an in-page action (RTT subtracted, 31.6 ms): about 33 to 47 ms on t4g.medium (B8 <= 50 ms p50) and 31 to 36 ms on c7g.large. t4g.medium is slower on heavy sites: SPA routes and navigation (render-bound on 2 vCPU).
- **15-minute mixed browsing loop (15 passes, 1,007 s):** machine CPU **36.8%** (0.74 vCPU), Chromium 18%. That is 44 credits/hour against 24 earned: a 576-credit bank would last about 29 h of nonstop browsing. Projected: 2 h/day of browsing plus an idle loaded page (5.9 credits/hour) uses about 218 credits/day, so **$0 surplus**; always-on nonstop browsing would be about 485 surplus credits/day, about **$9.7/month** (estimate).
- **Bandwidth:** 24.4 MB sent by the server over the 1,013 s loop = **0.087 GB/h** (NIC counter, includes a few KB of ssh).
- A real `deskd` run with the warm encoder is needed before relying on these CPU numbers.

## 7. Spend

Estimated from launch/terminate timestamps: **about $1.9 total**: instances and EBS $1.61 (c7i.xlarge client 7.0 h $1.26, t4g.medium 6.3 h $0.23, c7g.large 0.7 h $0.05, m7g.large 0.2 h $0.02, plus 24 GB gp3 each), surplus credits about $0.2 (CloudWatch: 266 credits on the first t4g.medium), egress about $0 (client to server over private IPs; workstation ssh only). The m7g.large price ($0.0816/h) is a list-price assumption, not looked up.

## 8. Not verified / caveats

- B13, and any `desk-rtc` behavior (PLI, intra refresh, playout-delay): Neko v3.2 only.
- B12 p50 is noisy at +-15 to 20 ms between passes; one connection per pass, 40 trials. Verdicts near 90 ms are ties.
- c7g.large and m7g.large did not get the 10-minute browse/video sessions; m7g.large got no minified run. Minified CPU numbers exclude the warm encoder and kiosk Chromium.
- Video is a synthetic noisy test pattern: bitrates are an upper bound, quality was not judged on real footage. Browse pages include live Wikipedia (variable).
- The stand-in is not `deskd`: its low CPU weight is what kept fps at 60 during bursts. Steady CPU was 2 x 1.2 to 2.8% in the first runs (a little over the 3% target when summed) and about 2.5% combined later.
- One run per cell; the soak is 17.5 minutes on the tuned 1080p config only (the combined config's credit use is modelled from its session CPU).
- `soak.py` reports "other workstation browsers" on the client box; that is its own wrapper process, ignore.
- Latency and fps on the old `(a) VFR` and `(b) CRF` single-technique rows used the quick runs (no 60 s B11 pass).
