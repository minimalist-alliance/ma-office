# W3 kit: `t4g.medium` at 1280x800 against `c7g.large` at 1920x1080

Numbers and same-size captures for the member desk size decision. The Product Designer session judges quality from the captures and the numbers; the desks run test accounts only, and nobody signs in by hand.

It sits outside `testDir`, so `npx playwright test`, the release gate, doesn't see it, and every spec skips unless `W3_DESK` (or `W3_PAIR`) is set. Browsers run headless with `DISPLAY` removed, so nothing can reach `:10`.

**First full runs: 2026-11-06, on both desks** (`docs/benchmarks/2026-11-w3-compare.md`). Run only on `DeskKind=test`, `Env=staging`: it checks the tags first, and refuses the owner's desk by id.

## Run

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
cd e2e && npm ci && npx playwright install chromium   # once

export W3_DESK=https://office.staging.minimalistalliance.com        # as a member's: test.office. refuses every account but desk-1 (desk_host_forbidden)
export W3_LABEL=t4g.medium-1280x800                                 # the folder name
export W3_USER_SSM=/ma/staging/test-users/desk-2                    # the desk's test account
export W3_EXPECT_SCREEN=1280x800                                    # stops at once if the desk isn't

npx playwright test -c w3 measure    # numbers: about 20 minutes for 3 rounds (19.3 and 19.2 on the first two desks)
npx playwright test -c w3 capture    # captures: both client profiles, about 5 minutes; -g 1512x982 for one

W3_PAIR=c7g.large-1920x1080,t4g.medium-1280x800 npx playwright test -c w3 pair   # after both desks. Touches no desk
```

For the 1080p reference: `W3_LABEL=c7g.large-1920x1080`, `W3_USER_SSM=/ma/staging/test-users/desk-1`, `W3_DESK_ID=<test-desk>`, `W3_EXPECT_SCREEN=1920x1080`. Don't run it alongside anything else on that desk: it refuses a desk already streaming.

Optional: `W3_DESK_ID` (needed if the account has several desks), `W3_RUNS` (default 3; fewer is marked a smoke run), `W3_TRIALS` (default 60 per latency pass), `W3_VIDEO` (`gen`, `off` or an https URL of an mp4 or a zip holding one, which is cut to 60 s from 2:00 with no audio), `W3_SCENARIOS` (comma list of `static,scroll,flick,motion,video,typing,latencyIdle,latencyLoaded,warmToLive,firstFrame`), `W3_ALLOW_BUSY=1`, `W3_OUT`.

**Latency is only a verdict from a client near the desk.** B12 assumes 30 ms RTT and an unloaded client, and `numbers.md` says whether the run qualifies. From this workstation (about 50 ms, shared) it still compares the two desks, if both run from here. For B12 itself, run it from a box in the desk's region.

## Wake and credits (TD-227, task 43; `docs/benchmarks/2026-11-alliance-desk.md`)

Two more specs, for a desk that stops and starts. Both skip unless asked, both use only a staging `DeskKind=test` instance tagged `Owner=...` (`wake.spec.ts` checks the tags, and refuses the owner's desk and `<instance>` by id).

```bash
export WAKE_INSTANCE=i-...                        # the temporary desk's instance
WAKE_LABEL=asbuilt WAKE_N=5 npx playwright test -c w3 'wake\.spec'      # a regex: the checkout's own path may contain "wake"
python3 w3/wake-report.py ~/ma-design-drafts/w3/<W3_LABEL> asbuilt [<a>+<b>]
CREDITS_LABEL=default CREDITS_MINUTES=10 CREDITS_SETTLE_S=240 W3_VIDEO=<url> npx playwright test -c w3 'credits\.spec'
```
- **`wake.spec.ts`** stops the desk with EC2's `StopInstances`, waits for EC2 and the desks table to say `stopped` and 8 s more, then loads the office afresh, which wakes it (the desk row needs `starts_with_office`). It opens the Browser as soon as the tile is there and records: the `connect` calls and their answers, EC2 `pending` and `running` (about 1 s resolution), the app's window-open and first-frame marks, Chromium's tabs, and afterwards the guest's journal and `systemd-analyze` over SSM. `wake-report.py` puts them on one clock and prints the phases and the four stretches (A EC2, B the guest's boot, C the app's poll, D the stream). A sample whose desk never stopped is marked `valid: false` and dropped; an office that answers "Desk is unavailable right now" is retried.
- **`WAKE_OWNER`** is the task's AWS owner tag (default `syseng-td227`); `wake.spec.ts` refuses an instance whose `Owner` tag doesn't start with it.
- **`credits.spec.ts`** runs each activity (`office`: the Browser never opened; `idle`; `reading`: a page turned every 20 s; `scroll`; `video`) for `CREDITS_MINUTES` while reading the desk's CPU time either side, then sums CloudWatch's `CPUCreditUsage` over exactly that window. The instance needs detailed monitoring (`aws ec2 monitor-instances`) for 1-minute points. `W3_LEVEL=low` sets the picture quality in the window's menu, for both `measure` and `credits`; the account's setting is put back to High at the end.

## What it writes

To `~/ma-design-drafts/w3/<label>/`: `numbers.md` and `numbers.json` after every scenario, all runs with RTT and client load beside them; `<profile>/` with the captures; a `README.md` saying what each pair is and what each page showed. `pages.json` beside the folders keeps the first desk's pages and words, so the second desk tries the same. `pairs-<a>-vs-<b>/` holds the crops side by side, and says where the two runs differ. No conclusions on taste anywhere.

Each crop waits until its words have stayed in one place for 6 s, read without scrolling, and starts where their paragraph, list item or table cell starts if they still fit. Before 2026-11-06 a crop re-read its words by scrolling to them again just before the screenshot, so a crop could follow a fresh scroll, and a crop started at its words, so small words that end a line (a link's site name) left it mostly empty. Waiting doesn't remove everything: after a scroll, the stream can show a faint double image of redrawn text on a still page until its next keyframe, and a crop may catch it (`docs/benchmarks/2026-11-w3-compare.md`, section 4). Captures from before that fix shouldn't be paired with captures after it.

## What it does to a desk

Over SSM: reads versions, units and CPU. Writes only `/var/tmp/ma-e2e-w3`, with a page server on loopback port 18767 as `nobody`, removed at the end. Makes a synthetic clip there with the desk's GStreamer, unless `W3_VIDEO=off`. Reads and scrolls the tab on screen through Chromium's debugging port, for the captures. In the app: opens the Browser window, a tab of its own, and closes both. The public pages stay in the test desk's browser history; it signs in to nothing, and clicks nothing on them.

**A run that's cut off cleans up nothing.** Its `finally` never runs, so its tab stays on a W3 page and the page server stays up. The first run on the temporary desk was cut off by a tool's 10-minute limit, and left `video.html` looping the 1080p clip for most of an hour, at more than half a core of the desk's two. So each run first closes any tab still on `127.0.0.1:18767`, which only W3 opens, and `numbers.md` says how many. Run `measure` in the background, or anywhere a command can last 30 minutes.

## How it measures

- **Page fps** is the rAF callback in the desk's Chromium, published in the page's title once a second with its own clock, and read from the window's tab strip. Decoded fps sits beside it and isn't the verdict.
- **Input to screen** is `stream.spec.ts`' method through the real window: a key's stamp in the listener, then the frame callback in which the middle pixel has flipped. `expectedDisplayTime` is kept and never quoted.
- **`warm` to `live`** goes on the app's own `rpc` channel, because a member's route (a tab hidden for 5 minutes) is too slow to repeat. Everything else goes through what a member touches. The sustained wheel and the bursts are real `WheelEvent`s dispatched on the app's video, because `page.mouse.wheel` can't keep frame timing; the single flicks are `page.mouse.wheel`.
- **Flicks:** `wheelBatch` is 8 clicks (960 px), tuned to a 1065 px scroller (`desk-rtc/internal/xinput/injector.go:18`), and a 1280x800 scroller is about 785 px. So the suspicion is that a merged batch falls short there. The flick table gives the distance actually travelled, per size, per run.
- **Cold root:** the first open on a boot, and an unmeasured pass through every page, are reported on their own and in no average. `desk-screen-1280x800.sh` starts Chromium, so on the temporary desk its output has the cold number instead.
- **Video:** the real-stack report's Big Buck Bunny clip isn't in the repo. `download.blender.org` answers 403 to a script from a desk, and the mirrors carry the film only as a zip, so `W3_VIDEO=https://mirror.clarkson.edu/blender/demo/movies/BBB/bbb_sunflower_1080p_60fps_normal.mp4.zip` fetches it on the desk and cuts the report's clip: 60 s from the last keyframe at or before 2:00, no audio, no re-encode, and the same video bytes on both desks (`numbers.md` gives their hash; the whole files differ, because `mp4mux` stamps the time). By default each desk makes a synthetic 1080p60 clip instead, which has never run: it's harder to encode than real footage, so its bitrate and CPU don't read against that report's rows.

## The root edit

`desk-screen-1280x800.sh`, for the Platform Engineer, as root over SSM (its header has the command). Refuses unless IMDS or the instance's tags say `DeskKind=test`, and refuses the owner's desk and the shared test desk by id. `--size 1600x900` sets that size instead (the owner asked for it, 2026-11-06), and `--size 1280x800` goes back; each edit starts from the 1920x1080 originals the first run backed up, so any size can follow any other.

**Proven on the temporary desk, 2026-11-06,** at 1280x800 (three times) and 1600x900 (once), with all six of its readback checks passing each time: Xorg's dummy driver takes the mode from the config file, `deskd` stays healthy while Xorg and Chromium restart under it, `desk-rtc` picks the size up (every click of `measure.spec.ts` landed), and a real stream reaches the client at that size. x264 chose level 4 at 1280x800 and 4.2 at 1600x900.

The 1280x800 mode is 59.96 Hz, the same as the 1920x1080 one; the 1600x900 mode is `cvt`'s, 59.95 Hz. The real-stack run's 1280x800 mode was 59.78 Hz, and its page read 59.7 against 59.8 to 59.9, so that small gap may have been the mode. Whether Chromium follows the mode's refresh here is unproven.

## Every hard-coded 1920x1080

Read from `ma-desk` and `ma-platform`, 2026-11-06.

**What sets the size (the edit changes these):** `image/recipe/files/etc/ma/xorg-dummy.conf:15,29,30`; `image/recipe/files/usr/local/lib/ma/desk-browser-start` `W=1920 H=1080` (`:18` on `main`, `:26` on `system-eng/browser-session`).

**What follows the screen, with no change:** `desk-stream` (`ximagesrc` takes the screen's size), `desk-rtc`'s input scaling (`x11.go:92,282`), `deskd` (nothing about size), the app (`videoWidth`, `contentBox`; its test stream is already 1280x800).

**Tuned to the height, not checked at it:** `desk-rtc/internal/xinput/injector.go:18,21`, `wheelBatch`.

**Would fail at 1280x800, which is why this can't run on the shared test desk:** `e2e/tests/stream.spec.ts:69,160,174`, with the fixed positions in its tests 4 and 5 (`:327,371-377,390,397,495-510`), and `streamlib.ts:210,352,905`; `e2e/tests/browser-window.spec.ts:17,18,167,198,209,218`; `image/verify.sh:275,279,435,436,438,511,612`; `desk-rtc/test/keyproof/main.go:239,240,691,692`; `desk-rtc/test/stream/proof.mjs:62,162,170`, `page.js:109`; `desk-rtc/internal/xinput/xinput_test.go:28,113` (its fake display, so it passes anyway).

**Words only:** `image/recipe/files/etc/systemd/system/desk-xorg.service:2` (left stale by the edit: it changes nothing); `image/recipe/desk-stream/stream.conf:7,17`; `image/README.md:42`; `image/RELEASES.md:22`; `desk-rtc/README.md:196,214`; `docs/desk-design.md:1110,1610`; `docs/interfaces/desk-runtime.md:232`; in `ma-platform`, `docs/platform-design.md:905` mentions 1080p in passing.

**Not a size, but related:** the answer declares H.264 level 3.1 (`desk-rtc/internal/rtcserver/media.go:80`). 1280x800 at 60 fps is over that level, as 1080p60 is. The edit's readback prints the level x264 chose.

## Ten-minute sessions and the simplified view (TD-128, `docs/benchmarks/2026-11-m7g-large.md`)

```bash
SESSION_LABEL=<l> SESSION_MINUTES=10 SESSION_KINDS=browse,video npx playwright test -c w3 'session\.spec'   # about 22 minutes for both
SIMPLE_LABEL=<l> SIMPLE_ROUNDS=3 SIMPLE_SITES=<url>,<url> npx playwright test -c w3 'simple\.spec'           # about 6 minutes for 4 pages
```
- **`session.spec.ts`**: the follow-up's 10-minute sessions through the real window, the simplified view switched off as in `measure`. Browse: ten cycles, the odd ones on the scroll page (read, a 12 s wheel, read), the even ones on the static article with a page turned every 7 s; video: the clip page in 56 s stretches. Page fps per second over the whole session, the client's `getStats`, the desk's CPU per cycle and the units' memory at the start and end. Writes `session-<SESSION_LABEL>.json`.
- **`simple.spec.ts`**: the simplified view as a member gets it (client-config's switch left on), on real pages typed into the window's address bar: the time from Enter to the view (or the real page with the desk's reason), `browser.minified.get`'s time on the desk off `rpc` (method names, codes and timings only, never a document), the desk's CPU, then 10 s of scrolling inside the view (drawn by the client). Writes `simple-<SIMPLE_LABEL>.json`. It types nothing into any page and signs in to nothing.
