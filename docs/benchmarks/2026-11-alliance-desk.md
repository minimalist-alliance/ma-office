# The Alliance desk: screen size and wake time on a `t4g.medium` (TD-227, task 43, 2026-11-09)

Status: measured on one temporary staging test desk, `ma-desk-0.3.1` (`<ami>`), `t4g.medium`, kind `personal`, 1920x1080, unlimited credits. **No verdict on the size or the price:** that is the owner's. This says pass or fail against the two bars he gave: "Below 30 is unacceptable" (page fps) and "Anything we can do to get it closer to 20 seconds consistently?" (the wake; his floor was "doesn't require more than 15 seconds boot up time").

## 1. The answer in one table

| Question | Result | Samples |
|---|---|---|
| Reading, scrolling, video at 1920x1080: page fps 30 or above? | **Pass.** Static article 59.9, sustained wheel 59.8 to 59.9 (p5 59.0 to 59.2), flicks 59.8 to 60.0, 1080p60 clip 60.0 (p5 59.4 to 59.8) | 3 rounds each |
| The same video page at Low (the stream is 1280x720) | **Pass.** Page fps 60.0, 59.9, 60.0 (p5 58.9 to 59.8), 1.7 Mbps against 4.2 to 4.4 at High | 3 rounds |
| A full-screen canvas of 24 moving gradients (the kit's stress page, not reading, scrolling or video) at 1920x1080: 30 or above? | **Fail.** 22.6, 22.2 and 24.1 (p5 20.7 to 22.7). `c7g.large` made 31.4 on it in the 2026-11-06 run, and `t4g.medium` at 1280x800 made 23.1 | 3 rounds |
| Same, at 1280x800 (step 3, because the stress page fell under 30) | **Still fail on the stress page:** 27.2, 29.0 and 28.6 (p5 25.7 to 27.6). Reading, scrolling and video: 59.9 to 60.0. Section 7 | 3 rounds |
| Wake as built (0.3.1), office loading to the first Browser frame | median **27.9 s** (24.3 to 29.2); to Chromium's tabs **31.1 s** (27.6 to 32.4) | 5 wakes |
| Wake with the two changes landed in the recipe | median **24.0 s** (20.7 to 24.2); to Chromium's tabs **24.2 s** (21.4 to 24.5) | 5 wakes |
| Against the owner's 20 s | **Not met at the median.** The wake has four stretches (section 4); the image owns two of them and the changes took 3.4 s and 3.5 s out of those. EC2's own power-on (A, 9.8 s) and the app's polling (C, 2.3 s) are the rest | |
| Against the 15 s floor | **Not met**, and not reachable by anything in the image: A alone is 9.8 s | |
| CPU credits an hour, by activity | Office open 0.6, a still page 9.8, reading 9.5, scrolling 74, video 75 (High) or 88 (Low), against 24 earned. Section 5 | 2 CloudWatch buckets each |
| EC2 hibernation as a way to a quicker wake | Works on this image. **Not quicker** (resume 22 s from the start call with a 1.4 GB image), the public address changes, and the link took 197 s to come back (section 6) | 1 run |
| **2026-11-11: the wake on `ma-desk-0.3.3`** (the trims baked; the app's 1 s `connect` poll and the pushed ready) | median **21.0 s** to the first Browser frame (20.6 to 22.4), **21.6 s** to Chromium's tabs (20.9 to 22.9), against 24.0 and 24.2 s. **20 s not met at the median, about 1 s away; 15 s not met.** The app's stretch C went 2.5 to 0.7 s; A, B and D are unchanged (section 11) | 5 wakes |

## 2. How it was measured

- **The desk:** `<desk-id>`, `<instance>`, made by `scripts/desk-provision.sh --env staging --test --kind personal --size t4g.medium` (staging test account `desk-2`, Owner tag `syseng-td227`, `starts_with_office` set on its own desk row so the app wakes it the way an Alliance Member's office does). Root 12 GB and data 32 GB (the provisioner refuses a drive under the site's promise), not Alliance's 8 GB; it doesn't change these numbers. `desk_image#current` was `ma-desk-0.3.1`. Detailed (1-minute) CloudWatch monitoring was switched on for the credits.
- **The client:** this workstation (6 cores, shared with every session), Chrome for Testing 156.0.8078.4 headless at 1920x1080, scale 1, the Desk app `2026.11.09-1688e939`. **RTT to the desk 49 to 59 ms (median 53), client load 1.4 to 7.8 per 6 cores across the W3 passes** (it was above 6 in two of them: the typing and the first video pass). The B12 latency budget assumes 30 ms and an unloaded client, so **the input latencies below are not a B12 verdict**; they compare only with the 2026-11-06 runs from the same client.
- **W3 kit** (`e2e/w3`, `README.md` there): `measure` for 3 rounds with every scenario, page fps from the rAF callback inside the desk's Chromium. Two additions: `W3_LEVEL` (the picture quality, set in the window's own menu) and, for this task, `wake.spec.ts` (section 4) and `credits.spec.ts` (section 5), with `wake-report.py`. All numbers and the raw files: `image/evidence/alliance-wake-2026-11-09/`.
- **Not the owner's desk, nothing else's:** `<instance>` and `<instance>` were never touched; the other desks and the shared test desk were never used.

## 3. 1920x1080: page fps, input and the stream

Medians of 3 rounds with the range where they differ (`w3-1920x1080-numbers.md` has every run, with RTT and client load beside each).

| | `t4g.medium` 1920x1080 | `c7g.large` 1920x1080, 2026-11-06 |
|---|---|---|
| Static article, page fps | 59.9 | 60.0 |
| Sustained wheel scroll (60 s), page fps avg / p5 / min | 59.8 [59.8-59.9] / 59.1 [59.0-59.2] / 55.7 [53.9-58.8] | 60.0 / 59.1 / 59.0 |
| Single flicks and bursts, page fps avg | 59.9 [59.8-60.0]; all 8 flicks travelled the reachable distance in all 3 rounds | 60.0 |
| Video page (1080p60 clip, full page), page fps avg / p5 | 60.0 / 59.6 [59.4-59.8]; 0 to 2 dropped frames in 30 s | 60.0 / 59.8 |
| Motion page (24 gradients, whole screen), page fps avg | **22.6 / 22.2 / 24.1** | 31.4 [31.3-31.5] |
| Input to screen, idle, p50 / p95 | 69.7 [69.5-70.1] / 87.7 [86.4-89.6] ms | 77.0 / 94.7 ms |
| Input to screen, clip playing, p50 / p95 | 91.0 [86.8-91.2] / 103.4 [101.3-110.7] ms | 94.2 / 108.4 ms |
| Typing, key to screen p50 / p95 | 68.5 [63.1-68.7] / 82.4 [79.3-83.9] ms (text readback empty in all 3 runs: unproven) | 78.5 / 100.1 ms |
| `warm` to `live`, first frame p50 | 63.6 [61.5-64.6] ms | 99.3 ms |
| Window open to first frame (3 opens a round) | 497 to 548 ms | 320 to 340 ms |
| Desk CPU, whole machine: idle page / scroll / motion / video | 4.7 to 12.9 / 79 to 80 / 77 to 78 / 79 to 83 % | 11.3 / 55.6 / n.r. / 60.8 % |
| Stream, Mbps: static / scroll / motion / video | 0.00 to 0.10 / 2.8 / 3.0 / 4.2 to 4.4 | 0.81 / 3.15 / 7.73 / 7.29 |

### The video page at Low (picture quality, 3 rounds, app `2026.11.10-96df0766`)

Alliance's 10 GB limit will push members to Low. At Low the stream is **1280x720 of the 1920x1080 screen** (the kit's size check allows that only with `W3_LEVEL` set, and its click mapping scales desk pixels to the smaller picture).

| 1080p60 clip, full page | High (1920x1080) | Low (1280x720) |
|---|---|---|
| Page fps avg / p5 | 60.0 / 59.6 [59.4-59.8] | 60.0 [59.9-60.0] / 59.4 [58.9-59.8] |
| Longest gap between page frames | 17 ms | 17 to 33 ms |
| Stream, Mbps | 4.2 to 4.4 | 1.7 |
| Desk CPU, whole machine | 79 to 83 % | 76 % |
| Input to screen, clip playing at 520x292, p50 / p95 | 91.0 / 103.4 ms | 87.3 to 90.6 / 102.2 to 110.6 ms |

Facts beside it, with no reading of them:
- The scroll and video pages hold 60 on two vCPUs at 79 to 83% of the whole machine. The stream and Chromium each take about 0.6 to 0.8 of a core while that happens.
- The motion page has Chromium at 93 to 100% of a core and the stream at 47 to 52%: it is Chromium's software raster that runs out, not the encoder. It is a stress page. No member workload in this kit is like it.
- The 2026-11-06 comparison ran on a 0.2.x image, before `desk-stream` 0.3.0's variable-rate stream, so its bandwidth and CPU columns differ from these for that reason as well as for the size.
- The kit's text check (typing) read nothing back in all three runs (`Paced text right: NO:`), and one key was missed in each: a harness fault or a real fault, not told apart here. Key to screen was timed on 53 of the 54 characters.
- The first Browser open on this boot, Chromium not running: 1272 ms to the first frame, 2211 ms until its tabs answered (1 sample).

## 4. The wake

### What a wake is, and how it was cut

The app wakes a `starts_with_office` desk the moment the office loads (`web/src/desk/liveStore.ts`, `wakeWithOffice`): it posts `connect` with `start: true`, and polls it every 3 s until it answers 200. `wake.spec.ts` does exactly that with the real app: **EC2's own `StopInstances` (what the sweep's last step is), wait for EC2 and the desks table to say stopped and 8 s more, then a fresh load of the office, nothing clicked to wake.** The member's click on Browser comes as soon as the tile is there (about 3 s after the load) and the stopwatch ends at the app's `ma:browser-first-frame` mark, and at Chromium's tabs answering. The guest's own events (kernel start, `deskd` ready, hello, gateway link) come from its journal over SSM afterwards, put on the same clock by `date` minus `/proc/uptime` (about 100 ms of rounding and the workstation's clock offset); the EC2 states come from a polling loop with about 1 s resolution.

The wait splits into four stretches that add up:

| | What | Who owns it |
|---|---|---|
| **A** | The office loading, the `connect` call, EC2 `pending` then `running`, to the kernel's first instruction | EC2 (the page is 1.5 s of it; `StartInstances` answers in 0.2 s; `pending` is seen at 3.6 to 4.6 s; `running` at 6.5 to 10.6 s; the kernel 1.7 s later) |
| **B** | The kernel to `deskd`'s hello accepted | the image |
| **C** | Hello to the app's next `connect` poll answering 200 | the app (a 3 s poll) |
| **D** | That answer to the first frame, or to Chromium's tabs | the image and `desk-rtc` |

### As built, by phase (`ma-desk-0.3.1`, 5 wakes; milliseconds from the office starting to load)

| Phase | #1 | #2 | #3 | #4 | #5 | median |
|---|---|---|---|---|---|---|
| `connect` request sent | 1371 | 1943 | 1469 | 2654 | 1529 | 1529 |
| `StartInstances` answered (`connect` 202) | 1598 | 2134 | 1680 | 2874 | 1723 | 1723 |
| EC2 `pending` seen | 3916 | 3603 | 3697 | 4640 | 3850 | 3850 |
| EC2 `running` seen | 8373 | 9416 | 6481 | 10562 | 7701 | 8373 |
| Kernel starts (guest) | 10151 | 11787 | 9525 | 12643 | 10289 | 10289 |
| Network online (guest) | 17380 | 19320 | 16139 | 18412 | 16547 | 17380 |
| `deskd` container started | 19358 | 21375 | 18080 | 20349 | 18541 | 19358 |
| `deskd` ready | 21307 | 23380 | 20133 | 22376 | 20682 | 21307 |
| Hello accepted | 22122 | 24075 | 21237 | 23077 | 21398 | 22122 |
| Gateway link up | 22355 | 24374 | 21448 | 23281 | 21569 | 22355 |
| Desks row `running` (server) | 22054 | 23797 | 20328 | 22957 | 21160 | 22054 |
| First Browser frame | 28275 | 27944 | 24262 | 29172 | 24647 | 27944 |
| Chromium's tabs answer | 31233 | 31134 | 27625 | 32410 | 27920 | 31134 |

Inside the guest, a wake's `systemd-analyze` read 8.0 s (1.36 kernel + 6.65 userspace) and `deskd` was ready 9.8 s after the kernel started. `critical-chain` for `deskd` on a wake: `cloud-init-main` (1.0 s) then `cloud-init-local` (1.1 s, which is `network-pre.target`), `systemd-networkd` and its wait-online (1.1 to 1.6 s), `cloud-init-network` (before `sysinit.target`), then `containerd` (0.6 s), `docker` (0.9 s), `deskd` (0.2 s to started, 1.5 s more for the JVM). The first boot (one sample, 23:50:29 to hello at 23:51:13, 43 s) also has `desk-firstboot` at 7.3 s formatting the blank drive, which is on no wake.

### What was tried: five wakes each, same desk, one change at a time

Medians in seconds with [min-max]. Each row is a state of the same desk's root, changed over SSM and measured with the same spec. B is the kernel to the hello; D and D' end at the first frame and at Chromium's tabs. Rows 1, 2, 4 and 5 are what lands, or why a change was not kept.

| Variant | n | A | B | C | D | D' | Total to first frame | Total to tabs |
|---|---|---|---|---|---|---|---|---|
| 1. As built | 5 | 10.3 [9.5-12.6] | **11.7** [10.4-12.3] | 1.1 [0.4-3.4] | 2.7 [2.6-2.7] | **5.9** [5.7-6.0] | 27.9 [24.3-29.2] | 31.1 [27.6-32.4] |
| 2. cloud-init off after the first boot | 5 | 9.6 [9.5-10.0] | **8.3** [8.1-8.6] | 1.0 [0.5-4.0] | 2.8 [2.6-3.3] | 6.1 [5.4-6.5] | 21.8 [21.2-25.1] | 25.1 [24.1-28.4] |
| 3. Browser prewarm only | 5 | 9.8 [9.4-18.1] | 12.0 [11.5-12.4] | 3.0 [0.5-3.2] | **1.7** [1.6-2.1] | **2.0** [1.7-3.3] | 26.7 [23.4-32.9] | 26.8 [24.6-34.1] |
| **4. Both (what lands)** | 5 | 10.6 [9.3-10.9] | **8.8** [8.5-8.8] | 2.5 [1.0-3.1] | **1.9** [1.8-2.2] | **2.4** [1.9-2.6] | **24.0** [20.7-24.2] | **24.2** [21.4-24.5] |
| 5. Row 2 plus Docker without `After=network-online.target` | 5 | 9.2 [9.0-10.6] | 8.2 [8.2-8.8] | 3.1 [0.8-7.0] | 2.6 [2.4-2.7] | 5.8 [5.3-5.9] | 24.5 [20.6-27.3] | 27.6 [23.5-30.7] |
| 6. Row 2 plus the Browser started at multi-user.target (not after `deskd`) | 5 | 10.9 [9.8-11.4] | 10.4 [10.2-16.7] | 2.1 [0.9-3.4] | 1.8 [1.7-2.0] | 2.1 [2.0-2.4] | 26.3 [24.1-29.8] | 26.8 [24.3-30.0] |

Reading it:
- **A and C are noise from the image's point of view.** A moves 9.5 to 12.6 s between wakes of the same desk and C 0.4 to 7.0 s, so the totals move by several seconds with no change in the image (row 5's total is 2.7 s above row 2's with B within 0.1 s). B, D and D' are the stretches the image owns, and they are tight (spread under 1 s except where a run was slow). Pooled over all 30 wakes, A is 9.8 s and C 2.3 s; with those two fixed, the first-frame wake comes to 26.6 s as built and 22.8 s with both changes (the Chromium-tabs wake, 29.8 s and 23.3 s).
- **Row 2, cloud-init off, B: 11.7 to 8.3 s (-3.4 s).** In the as-built chain `cloud-init-local` (1.1 s) stands in front of the network and `cloud-init-network` in front of `sysinit.target`, so `containerd`, `docker` and `deskd` all waited for DHCP. `systemd-analyze` on one boot of each: 8.0 s to 5.9 s.
- **Row 3, prewarm, D': 5.9 to 2.0 s (-3.9 s), first frame 2.7 to 1.7 s.** The first frame is a page now, not an empty screen. B stays 12.0 s without row 2, as it should.
- **Row 4 B is 8.8 s against row 2's 8.3 s:** the prewarm costs about 0.5 s of hello, because Chromium starts as the JVM finishes (the five hellos are 8.5 to 8.8 s against 8.1 to 8.6). **Row 6 shows why it waits for `deskd`:** started at multi-user.target, hello comes 2.1 s later (10.4 s).
- **Row 5, Docker earlier, no gain.** Without the network ordering `docker` and `containerd` start at `basic.target` and take about 1.8 s, as long as the network does: `deskd` started 5.97 s after the kernel against 5.75 s with it. Not kept.
- **Not tried:** a read of the whole disk in the background after a new image (the image already has `desk-preread` for what the Browser loads; the cold-root first open measured 1.3 s here); `deskd` without Docker (the Desk Engineer's); a faster JVM start for `deskd` (1.4 to 1.5 s of B: the Desk Engineer's).

### What each stretch still costs, and who could move it

| Stretch | Median now | Could be | By whom |
|---|---|---|---|
| A, EC2 | 9.8 s (9.3 to 12.6) | nothing short of keeping the instance running or a warm pool; hibernation pays the same start (section 6) | Platform / the owner's cost call |
| B, the image | 8.8 s | 2 s of it is `deskd`'s JVM and its container start, 2 s DHCP (`wait-online`), 1.8 s `containerd` and `docker`, 1.3 s the kernel | the Desk Engineer (JVM start, class-data sharing), the System Engineer (nothing cheap left here) |
| C, the app's poll | 2.3 s (0.4 to 7.0) | the desk is up at the hello; the app finds out at its next 3 s poll. A shorter poll while a wake is open, or the gateway pushing `desk.progress: ready` to a tab that is waiting, would take about 1.5 s off on average | the UI/UX Engineer and Platform (neither was changed here) |
| D, the stream | 1.9 s to the first frame | WebRTC setup and the encoder's first keyframe | `desk-rtc` |

## 5. CPU credits

A `t4g.medium` earns 24 credits an hour (20% of each of two vCPUs). The desk is on unlimited credits, so nothing throttles it: usage past the balance is billed as surplus, $0.05 per vCPU-hour, which is $0.000833 a credit. `credits.spec.ts` ran each activity for 10 minutes through the real app (the Browser open on the kit's pages, picture quality High, the clip at 1080p60) and summed CloudWatch's `CPUCreditUsage` over the window. **CloudWatch publishes credit metrics every 5 minutes, whatever the monitoring**, so a 10-minute window holds two points and starts and ends at a bucket's edge by luck: the figures are two buckets each, ±5 minutes. The guest's own CPU time (`/proc/stat`, 2 vCPUs x 60 min x machine %) is the cross-check. 1 window each, so a sketch with a spread you can see in the two buckets, not a mean.

| Activity (10 min) | CloudWatch, credits an hour | Guest CPU, machine % -> credits an hour | Earned an hour | Net an hour | Surplus cost an hour* |
|---|---|---|---|---|---|
| Office open, Browser never opened (prewarmed Chromium frozen or idle) | 0.6 (0.055 and 0.048 per bucket) | 0.2% -> 0.2 | 24 | +23 | $0 |
| Browser on a still page | 9.8 (0.84, 0.78) | 4.2% -> 5.0 | 24 | +14 | $0 |
| Reading (a page turned every 20 s) | 9.5 (0.79, 0.79) | 4.2% -> 5.0 | 24 | +14 | $0 |
| Continuous scroll | 74.2 (5.9, 6.4) | 67.4% -> 80.9 | 24 | -50 | $0.042 |
| 1080p60 video, High | 74.8 (6.3, 6.2) | 59.9% -> 71.9 | 24 | -51 | $0.042 |
| 1080p60 video, **Low** (the stream is 1280x720) | 87.8 (7.6, 7.0; the first bucket held 2 minutes of the run before) | 75.3% -> 90.4 | 24 | -64 | $0.053 |

\* If the balance is empty. The balance in the run climbed from 4 to 14.5 credits over 35 minutes of office, idle and reading, fell to 0 during the scroll window and showed 2.3 surplus credits at the end of the video window; `CPUSurplusCreditsCharged` stayed 0 over the whole run (it is posted when the instance stops or each hour).

- **Low is not clearly cheaper in CPU than High on the video page.** The 10-minute credit windows say 60% of the machine at High and 75% at Low; the 30-second W3 passes on the same page say 79 to 83% at High and 76% at Low (3 rounds each). The two disagree, so no direction is claimed: at Low `desk-stream` scales the 1920x1080 screen to 1280x720 before it encodes, which costs CPU as the smaller picture saves it. What Low does save is bandwidth: 1.7 Mbps against 4.2 to 4.4 on the same page.
- **The prewarm costs nothing at rest:** the office window with Chromium started at boot used 0.6 credits an hour (0.2% of the machine), well inside the 24 earned.
- **Surplus over a month:** measured, a month of reading, chat and idle pages earns more credits than it spends and bills $0 of surplus. A month of nothing but scrolling or video bills surplus at $0.042 an hour at High and $0.053 an hour at Low,
 the extremes. A mixed month sits between the two; **the desk's real mix is 
not known**, which is why this is a bound and not an estimate. Banked credits (the balance builds about 1.2 to 2 an hour of idle, to a cap of 576) and the 20 minutes after idle (which earn about 8 credits and spend almost none) pull the bound down.

## 6. EC2 hibernation, as an option only

Tried on a second, throw-away `t4g.medium` from the same image (launched with `--hibernation-options Configured=true` and a 20 GB encrypted root; ended since, with its two volumes; it was not a desk and `deskd` could not say hello from it, with no instance-tag metadata). **One run, so a sketch, not a measurement.**

- **Does Debian 13 arm64 on `t4g.medium` with an encrypted root support it?** Yes, with four things the image doesn't have: the instance launched with hibernation configured (it can't be turned on afterwards), a swap file at least as big as RAM on the root (5 GB here; an Alliance desk's 12 GB root has 7.9 GB free, so it would fit), `resume=UUID=<root>` and `resume_offset=<swap file's first block>` on the kernel command line (and `RESUME=` for the initramfs), and zram swap turned off (`zramswap` is enabled in the image). The kernel has `CONFIG_HIBERNATION=y` and `/sys/power/state` lists `disk`. `systemctl hibernate` inside the guest wrote the image and EC2 reported `stopped`; a `start-instances` resumed it, 1.4 GB python process and all (its counter file kept ticking, `uptime` kept counting from the original boot).
- **Times:** `systemctl hibernate` to EC2 `stopped` 17.2 s (a 1.47 GB image: 4.9 s to allocate it, the rest writing it to a default gp3, 125 MB/s). `start-instances` to `running` 4.8 s. The guest had its clock corrected, by `chronyd`'s own log, about 22 s after the start call (consistent with reading 1.47 GB back at a default gp3's 125 MB/s, which is 12 s of it; the read time itself was not logged), and NTP was selectable again 33 s after that. **Not quicker than a boot:** a stopped desk's start call reaches the hello after a median 20.2 s as built (19.6 to 21.9, 5 wakes) and 17.4 s with the two changes (16.1 to 17.6); the resumed guest is running its processes again at about 22 s, with its network and clock still to come.
- **Does a resumed desk keep its gateway link and stream?** No, and not by a short way. The public IPv4 address changed (the instance was stopped), so every TCP connection and WebRTC path the desk had was dead on resume. The SSM agent, which holds a websocket the same way `deskd` holds its gateway link, came back as `Online` **197 s after the start call**. `deskd` would need its own reconnect to be much quicker than that, and the stream would need a new ICE negotiation anyway. Not tried with `deskd`: the probe could not say hello.
- **What it would change in Platform:** the stop path (`readyToStop` then `StopInstances` becomes `StopInstances --hibernate` and a guest that handles the signal), the launch parameters (hibernation configured and an encrypted root), and the image (a swap file as big as RAM, the resume parameters, no zram). A Guild Desk or a member size above 4 GiB needs a bigger swap file on a bigger root.
- **Verdict on the option:** works, costs a root-size increase and a Platform stop-path change, and **does not beat a boot at the default EBS throughput**. A provisioned throughput (up to 1000 MB/s on gp3, extra cost) would shorten the read, to a floor of the 4.8 s start plus the kernel's 3 s; the link problem stays. Reported, not built.

## 7. 1280x800 (step 3)

Run because the stress page fell under 30 at 1920x1080 (step 3), with `e2e/w3/desk-screen-1280x800.sh` on the same desk, and **no choice of size made or implied**: that is the owner's. The kit's script applied the edit and its readbacks of the X screen, Chromium's window, the page and a captured frame passed; its own x264 check failed on a `stream.conf` key it no longer finds (`KeyError: 'convert'`, a kit fault from before `desk-stream` 0.3.x's config) and `measure.spec.ts` with `W3_EXPECT_SCREEN=1280x800` then proved the real stream reaches the client at 1280x800 and the clicks land (`screen 1280x800, page 1280x800, stream 1280x800`). Desk app `2026.11.10-96df0766` for this run and the Low one, with the simplified view's client-config kill switch set in the test browser (`noSimpleView` in `w3lib.ts`): from that build the Browser draws a simplified view of a page it can, and keeps the stream `warm`, which no streamed-page measurement can use. 3 rounds, same client and RTT (53 ms median).

| `t4g.medium` | 1920x1080 | 1280x800 |
|---|---|---|
| Static article, page fps | 59.9 | 59.9 [59.9-60.0] |
| Sustained wheel scroll, page fps avg / p5 / min | 59.8 / 59.1 / 55.7 [53.9-58.8] | 59.9 / 59.1 [59.1-59.8] / 55.9 [54.0-57.0] |
| Flicks, page fps avg | 59.9 | 60.0 [59.9-60.0] |
| Video page, page fps avg / p5 | 60.0 / 59.6 | 59.9 [59.8-60.0] / 59.0 [58.7-59.1]; the clip's decoded fps 56 against the page's 60 |
| **Motion page, page fps avg / p5 / min** | **22.6 / 22.2 / 24.1** (p5 20.7 to 22.7) | **27.2 / 29.0 / 28.6** (p5 25.7 to 27.6; min 23.5 to 27.1). **Still under 30 in all three rounds** |
| Input to screen, idle, p50 / p95 | 69.7 / 87.7 ms | 67.4 / 80.3, 64.1 / 83.2, 76.3 / 116.4 ms (round 3 has a 60.5 ms RTT) |
| Input to screen, clip playing, p50 / p95 | 91.0 / 103.4 ms | 84.8 / 100.7, 80.5 / 94.1, 85.1 / 100.9 ms |
| Desk CPU, whole machine: scroll / motion / video | 79 to 80 / 77 to 78 / 79 to 83 % | 54 to 65 / 70 to 72 / 81 to 82 % |
| Stream, Mbps: scroll / motion / video | 2.8 / 3.0 / 4.2 to 4.4 | 7.3 to 7.8 / 2.1 to 3.3 / 1.4 |

Read plainly: at 1280x800 the stress page rises about 5 fps and stays under 30; reading, scrolling and video are 60 at both. Chromium is at 100 to 116% of a core on the motion page at 1280x800 too, so the size moves the limit and does not remove it. (**Unexplained:** the scroll row sends more bits at 1280x800 (7.3 to 7.8 Mbps) than at 1920x1080 (2.8), the opposite of the 2026-11-06 runs, and video far fewer (1.4 against 4.2 to 4.4). The two sizes ran on different Desk app builds (`2026.11.09-1688e939` and `2026.11.10-96df0766`) and nothing here separates the build from the size, so the Mbps rows are not a size comparison.)

## 8. Spend, and what was left

About $0.5 of AWS, estimated and not read from a bill: the `t4g.medium` for about 4 hours (about $0.14 and its address), a second `t4g.medium` for 15 minutes (the hibernation probe), 32 GB, 20 GB and 8 GB of gp3 for a few hours, detailed monitoring, and the surplus credits the video and scroll windows ran up (about 100 credits, $0.08). Ended by `scripts/test-desk-stop.sh staging --desk <desk-id>` (which marks it `stopping`), then `terminate-instances` on both instances, a delete of the desk's data volume (the provisioner keeps it on termination), its IAM role and instance profile, and its row in `ma-staging-desks`. **Checked by tag `Owner=syseng-td227`: no instance but the terminated desk (it lists for an hour after), no volume, no key pair, no security group.** The shared test desk and the other desks were not touched.

## 9. What stayed unmeasured

- **The picture of a real member:** these are the kit's synthetic pages and one 60 s clip (Big Buck Bunny, 1080p60, no sound). Real sites (video calls, WebGL, canvases, ad-heavy pages) are not in it. The motion stress page falling under 30 is the one known case where this desk is below the bar.
- **B12** (input to screen at 30 ms RTT from an unloaded client): this client is 53 ms away and loaded (up to 7.8 on 6 cores). Run it from a box in `us-east-1`.
- **Wakes at other times of day**, from another region, or of a desk whose last stop was not EC2's `StopInstances` but the platform's own idle-stop path (the sweep's `StopInstances` is the same call, but `readyToStop` comes before it, and its shutdown order was not exercised here). A wake from a member's real browser (cold cache, a slower page load) adds to A.
- **The next bake.** Nothing was baked: the two changes were applied by hand to a 0.3.1 root and the `verify-wake.sh` parts run on it one at a time; `verify.sh` as a whole hasn't run with them (`image/RELEASES.md`).
- **A wake after a root replacement in production.** The mechanism is the same (a fresh root has no marker, so cloud-init runs once), but the real `ma-update` root swap path was not run with it.
- **The prewarm over a day.** What the prewarm costs the desk's idle CPU between a wake and the idle stop is in section 5; whether `deskd` freezes the prewarmed Chromium and how long that takes was read from one desk for about 10 minutes, not for the 20 before the idle stop.
- **The wake on the newer Desk app.** Every wake, the 1920x1080 W3 run and the default credits run used Desk app `2026.11.09-1688e939`; staging took `2026.11.10-96df0766` (the simplified Browser view) meanwhile, and the 1280x800 and Low runs used it with that view's kill switch set in the test browser. A wake with the view's probe in front of the stream ("asked beside the stream, never ahead of it", `web/CLAUDE.md`) was not measured.
- **The typing check's text readback** (section 3) and the cause of the one missed key per round.

## 10. To run it again

```bash
. ~/work/syseng-1109/td227/env.sh   # W3_DESK, W3_LABEL, W3_USER_SSM, W3_DESK_ID, W3_EXPECT_SCREEN, WAKE_INSTANCE
cd e2e
npx playwright test -c w3 'wake\.spec'      # WAKE_LABEL, WAKE_N (default 5); a regex, since the checkout path may hold "wake"
npx playwright test -c w3 'credits\.spec'   # CREDITS_LABEL, CREDITS_MINUTES, CREDITS_ACTIVITIES, CREDITS_SETTLE_S, W3_LEVEL
python3 w3/wake-report.py ~/ma-design-drafts/w3/<W3_LABEL> <label> [<a>+<b>]
```
Test desks tagged `Owner=<yours>` only; the spec refuses anything else, and the owner's desk by id.

## 11. 2026-11-11: the wake on `ma-desk-0.3.3` (TD-128 part 2)

Asked: does the wake reach the owner's 20 s ("Anything we can do to get it closer to 20 seconds consistently?", with "doesn't require more than 15 seconds boot up time" as the floor) now that the image carries section 4's two trims and the Desk app polls `connect` every second while a wake it asked for is open (`web/src/desk/rtc/policy.ts` `wakePollMs`, where it was every 3 s)?

**How:** the same `wake.spec.ts` and `wake-report.py` as section 4, on a new temporary staging test desk: `scripts/desk-provision.sh --env staging --test --kind personal --size t4g.medium` on `desk_image#current` (`ma-desk-0.3.3`, nothing changed by hand), staging test account `desk-2`, tagged `Owner=syseng-td128`, `starts_with_office` set on its row as section 4's was. Root 12 GB, data 32 GB, unlimited credits, us-east-1a. One unmeasured wake first, so the root's blocks were read once (21.7 s, in no median), then 5. Desk app `2026.11.11-bfe6c02d` (it has `wakePollMs` and listens for the pushed `desk.progress: ready`), Chrome for Testing 156 headless from this workstation (RTT about 55 ms; client load 3.9 to 11.1 on 6 cores across the wakes). `wake.spec.ts` now takes the task's owner tag from `WAKE_OWNER`; nothing else in the kit changed.

### By stretch, beside 0.3.1 with the two trims (section 4, row 4)

Medians of 5 wakes in seconds, [min-max]. A is EC2's, B the image's and `deskd`'s, C the app's and Platform's, D the stream's (`desk-rtc` and the app's open).

| Stretch | 0.3.1 + trims (Nov 9) | **0.3.3 (Nov 11)** | Change |
|---|---|---|---|
| A: the office loading to the kernel's start | 10.6 [9.3-10.9] | **9.9** [9.1-11.4] | -0.7 (A moves 2 s between wakes of one desk: noise) |
| B: the kernel to `deskd`'s hello accepted | 8.8 [8.5-8.8] | **8.7** [8.6-8.7] | -0.1 |
| C: the hello to the app's `connect` answering 200 | 2.5 [1.0-3.1] | **0.7** [0.4-0.9] | **-1.8** |
| D: that 200 to the first Browser frame | 1.9 [1.8-2.2] | **1.8** [1.6-2.6] | -0.1 |
| D': that 200 to Chromium's tabs | 2.4 [1.9-2.6] | **2.1** [2.0-2.9] | -0.3 |
| **Total to the first Browser frame** | 24.0 [20.7-24.2] | **21.0** [20.6-22.4] | **-3.0** |
| **Total to Chromium's tabs** | 24.2 [21.4-24.5] | **21.6** [20.9-22.9] | **-2.6** |

The five wakes, to the first frame: 20.7, 22.4, 22.4, 20.6 and 21.0 s; to the tabs 20.9, 22.6, 22.9, 21.6 and 21.2 s. All five were valid (the desk was stopped each time) and the office loaded each time.

### Inside the stretches (medians [min-max], seconds)

| | 0.3.1 + trims | 0.3.3 | Whose |
|---|---|---|---|
| Office load to the `connect` request | 1.68 [1.43-2.07] | 1.12 [0.88-1.60] | the app |
| `connect` to its 202 (`StartInstances`) | 0.18 | 0.27 | Platform |
| 202 to EC2 `pending` seen | 1.87 | 2.07 | EC2 (about 1 s of it is the poll's resolution) |
| `pending` to `running` seen | 4.14 [2.91-4.89] | 4.35 [2.94-6.10] | EC2 |
| `running` to the kernel's start | 2.50 | 2.37 | EC2 (firmware) |
| Kernel to `network-online` | 4.51 [4.17-4.76] | 4.61 [4.06-4.67] | the image: the kernel 1.35, then userspace, `systemd-networkd-wait-online` 1.3 |
| `network-online` to `docker` started | 0.95 | 0.95 | the image (`containerd` 0.6, `docker` 0.9) |
| `docker` to `deskd` started | 0.23 | **0.75** | the image: since 0.3.3 `deskd` is started only once `desk-oom-container` has run (`ExecStartPost=`, `image/RELEASES.md`) |
| `deskd` started to ready | 1.93 | **1.53** | `deskd`'s JVM (the Desk Engineer's); it was already starting under the `ExecStartPost=`, so the two changes cancel: docker to ready 2.16 against 2.28 |
| `deskd` ready to hello accepted | 0.87 | 0.87 | `deskd`'s signed hello to Platform's API |
| Hello to the gateway link | 0.21 | 0.21 | `deskd` and the gateway |
| Hello to the app's pushed `ready` | none seen | 0.56 [0.27-0.71] | Platform's push |
| Hello to `connect` 200 | 2.50 [0.97-3.11] | 0.68 [0.44-0.88] | the app, now on the push |

- **The app's change did what it was meant to, and more:** C fell from 2.5 s to 0.7 s, because the app now hears the gateway's `desk.progress: ready` (0.56 s after the hello) and asks `connect` straight away; its 200 comes 0.04 to 0.17 s after the push. The 1 s poll is the fallback: the app made 17 to 19 `connect` calls a wake against 8 to 9 before (all answered 202 or 200; no 429).
- **The image's own stretch is unchanged** (B 8.7 against 8.8 s): the 0.3.3 bake's `desk-oom-container` step delays `deskd`'s `Started` by 0.5 s, but the JVM was already running under it, so the hello is no later. The 0.3.3 release note saw `deskd` active 0.5 s later in one sample and left the hello unmeasured; at the hello there is no cost.
- **A is EC2's and still half the wait** (9.9 s of 21.0). The page itself sends `connect` 1.1 s after it starts to load, 0.6 s sooner than on Nov 9.

### Against the owner's bars

- **20 s: not met at the median** (21.0 s to the first frame, 21.6 s to the tabs). 2 of 5 wakes were within 0.7 s of it (20.6 and 20.7 s). It is about 1 s away.
- **15 s: not met, and out of reach of everything but EC2:** A alone is 9.9 s, and B, C and D together are 11.2 s.

### What could still be cut, and whose it is

| Where | Now | What might move it | Whose |
|---|---|---|---|
| A, EC2's power-on | 9.9 s, of which about 8.7 s after the `connect` | nothing short of keeping the instance running or a warm pool; hibernation is not quicker (section 6) | EC2; the choice is Platform's and the owner's (cost) |
| A, the office loading to `connect` | 1.1 s | sending `connect` from the loader before the app's bundle has booted, for a `starts_with_office` desk | the app (UI/UX Engineer) |
| B, kernel to `network-online` | 4.6 s | the 1.3 s DHCP wait is the one large piece; section 4 found nothing cheap (Docker without `network-online` gained nothing) | the image (System Engineer): nothing cheap left |
| B, `deskd`'s container start and JVM | 0.75 + 1.53 s | a faster JVM start (class-data sharing is in, `services/CLAUDE.md`; a native image or a checkpoint would be next), and starting the container without waiting for `desk-oom-container` | `deskd`'s JVM: the Desk Engineer; the `ExecStartPost=` order: the image |
| B, ready to hello | 0.87 s | the hello's round trip and Platform's handling of it | the Desk Engineer and Platform |
| C | 0.7 s | little: 0.56 s is the gateway's push after the hello | Platform |
| D, to the first frame | 1.8 s | the session's open, ICE and DTLS (several round trips at about 55 ms here) and `desk-stream`'s first keyframe; Chromium is already up (the prewarm) | `desk-rtc` and the app |

Getting under 20 s at the median needs about 1 s from the rows above that aren't EC2's; the app's earlier `connect` and `deskd`'s start are the two largest candidates. Nothing here was changed or tried; these are where the time is.

### Spend and clean-up

About $0.01 of compute (the `t4g.medium` ran about 11 minutes in all between 10:20 and 10:31 UTC, stopped in between), its 44 GB of gp3 for the same, and a little stream. Ended with `scripts/test-desk-stop.sh staging --desk <its id>` (marked `stopping`), `terminate-instances`, a delete of its data volume, its IAM role and instance profile, and its row in `ma-staging-desks`. **Checked by tag `Owner=syseng-td128`: only terminated instances list; no volume, snapshot, key pair or security group.** The shared test desk, the owner's desk and every other desk were not touched. Phases and sub-stretches: `image/evidence/alliance-wake-2026-11-11/`.

### Not measured

- Wakes of a desk whose `connect` came from a member's real browser (a cold cache and a slower page add to A), from another region, or at other times of day.
- A wake with the Browser's last tab on a page the simplified view takes: the desk's tab was a new tab each time.
- B12-style latency after a wake; the window's own first-frame marks only.
