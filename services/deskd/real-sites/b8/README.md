# B8: deskd's own overhead per member action (task 47)

B8 in the design (`docs/desk-design.md`, section 9) caps what the office adds to a click in the simplified view: the site's own time + RTT + MA's overhead of at most 50 ms p50 and 150 ms p95. This measures **deskd's share of that overhead**: the time from `browser.minified.act` arriving at deskd's method to its reply, split by the action proxy's phases (`ActionProxy`, ADR 0046, `API.md` section 14). The client's own rendering, desk-rtc, WebRTC and the network are not in it.

**The numbers are for `sub/minified-stage-a` at `d0561b4c`** (the harness on `sub/minified-b8`, nothing in `main` changed). A 5-run trial on `bceeecac` is in the notes at the end.

## Results, 2026-11-07

**The answer.** On a simple page deskd's method takes 1 to 6 ms p50 and at most 23 ms. On a heavy page (about 5,000 elements, 20 frames, 4 of them cross-site) a click or typing takes 13 to 26 ms p50, 28 to 42 ms p95, at most 84 ms; a select or a scroll still 1 to 3 ms. That's within B8 (50 / 150 ms for all of MA's overhead), but on a heavy page deskd alone takes up to half the p50 budget. **The biggest cost is the frame guard** (Security T47-3): listing the tab's frames, arming every other frame, listing them again before the press, and disarming them, 62 to 71% of the method on the heavy page, 94 to 95 CDP calls per click. deskd's own Java work between calls is under 0.3 ms p50. Separately, **the re-distill after each action is 76 ms p50 and 114 ms p95 on the heavy page**: with the Desk app subscribed it holds the tab's work lock, so an action arriving during it waits, and the member's result is painted only after it.

Machine: AMD Ryzen 5 7600X, 6 cores, x86_64, shared with other sessions (1-minute load 5.1 to 8.3 during the run), Chrome for Testing 156.0.8078.4 headless (`--headless=new --disable-gpu`, 1280x800), JDK 21.0.13, `MinifiedModule.Timing.DEFAULT`, nobody subscribed. 60 timed runs per row after 6 warm-ups. Every run was `done`, and the page's own counters agree (a select that picks what's already selected fires no `change`, so its counter is one short).

| Page | Action | deskd's method p50 / p95 / max (ms) | Through the RPC p50 / p95 / max (ms) | CDP calls | Frame guard p50 / p95 (share) | Chromium CPU per action (ms) |
|---|---|---|---|---|---|---|
| simple | click a link | 4.56 / 11.60 / 22.90 | 5.31 / 12.27 / 23.73 | 7 | 0.87 / 3.89 (25%) | 5.2 |
| simple | click a button | 4.40 / 8.15 / 14.11 | 4.88 / 10.56 / 16.57 | 7 | 0.85 / 2.19 (21%) | 3.7 |
| simple | click a checkbox | 4.73 / 10.80 / 15.36 | 5.22 / 13.52 / 17.64 | 7 | 0.91 / 3.47 (25%) | 3.5 |
| simple | type 20 characters | 4.40 / 10.53 / 20.12 | 4.85 / 10.96 / 28.74 | 6 | 1.15 / 3.83 (33%) | 4.3 |
| simple | select | 2.15 / 4.78 / 8.97 | 2.67 / 5.19 / 11.00 | 4 | none | 1.3 |
| simple | scroll a far element into view | 1.11 / 4.01 / 7.86 | 1.48 / 4.38 / 10.53 | 2 | none | 1.8 |
| simple | click a far button (scrolled first) | 6.23 / 12.03 / 15.21 | 6.69 / 12.32 / 16.73 | 7 | 1.15 / 3.29 (24%) | 5.8 |
| heavy | click a link | 19.93 / 32.30 / 52.16 | 20.66 / 32.79 / 57.91 | 95 | 12.79 / 23.74 (64%) | 16.3 |
| heavy | click a button | 15.84 / 27.57 / 40.93 | 16.14 / 28.64 / 42.02 | 95 | 9.92 / 18.53 (63%) | 17.5 |
| heavy | click a checkbox | 13.07 / 42.15 / 51.29 | 13.39 / 43.05 / 51.67 | 95 | 7.73 / 29.06 (62%) | 15.3 |
| heavy | type 20 characters | 26.31 / 39.24 / 84.32 | 26.72 / 42.11 / 85.52 | 94 | 18.54 / 26.62 (71%) | 18.3 |
| heavy | select | 2.62 / 7.56 / 12.82 | 3.29 / 7.92 / 13.61 | 4 | none | 2.3 |
| heavy | scroll a far element into view | 1.14 / 4.06 / 4.63 | 1.55 / 4.84 / 6.77 | 2 | none | 2.2 |
| heavy | click a far button (scrolled first) | 16.14 / 38.73 / 44.78 | 16.56 / 39.02 / 45.48 | 95 | 10.97 / 25.18 (70%) | 22.7 |

"Through the RPC" is the test client's round trip over the fake desk-rtc socket, so it adds deskd's RPC session, idempotency store and framing (about 0.4 ms p50). "Frame guard" is the sum of `frames list`, `arm frames`, `frames recheck` and `disarm frames` per run, and its share is of the method's total time. Chromium CPU is all of Chromium's processes during the call, in 10 ms ticks averaged over the runs.

**Phases on the heavy page, p50 / p95 / max (ms):**

| Phase | click a link | click a button | click a checkbox | type 20 characters | far button |
|---|---|---|---|---|---|
| thaw + resolve | 0.02 / 0.03 / 0.09 | 0.01 / 0.03 / 0.04 | 0.01 / 0.03 / 0.10 | 0.01 / 0.04 / 0.07 | 0.01 / 0.03 / 0.04 |
| frames list (`Page.getFrameTree`, tab + 4 frame sessions, one after another) | 2.77 / 7.22 / 12.93 | 2.23 / 5.24 / 8.79 | 2.13 / 7.89 / 17.97 | 2.71 / 9.18 / 35.40 | 2.16 / 4.60 / 6.06 |
| arm frames (20 frames at once, each `createIsolatedWorld` + `arm`) | 3.68 / 7.12 / 13.20 | 2.63 / 5.11 / 5.52 | 2.05 / 8.91 / 15.21 | 4.19 / 8.61 / 11.01 | 2.48 / 8.03 / 9.68 |
| context (top frame's world, pinned) | 0.26 / 0.87 / 1.54 | 0.24 / 0.82 / 3.07 | 0.24 / 0.65 / 3.26 | 0.27 / 1.34 / 3.63 | 0.24 / 1.07 / 3.22 |
| prepare (fingerprint, sensitive, scroll, hit-test, frame-near, arm the element) | 2.21 / 4.98 / 10.00 | 1.80 / 3.64 / 4.01 | 1.81 / 3.37 / 8.26 | 1.28 / 7.24 / 12.02 | 2.30 / 5.62 / 10.31 |
| frames recheck (the list again, before the press) | 1.97 / 5.99 / 8.36 | 1.68 / 4.03 / 9.41 | 1.52 / 3.69 / 6.58 | 3.51 / 6.72 / 11.21 | 3.93 / 8.84 / 14.58 |
| dispatch (press and release, or `insertText`) | 2.91 / 6.16 / 8.92 | 2.33 / 5.00 / 19.81 | 2.19 / 6.27 / 21.36 | 1.49 / 5.19 / 10.63 | 1.28 / 4.95 / 8.66 |
| result (what the element got) | 0.42 / 2.43 / 5.54 | 0.39 / 1.55 / 2.25 | 0.36 / 1.60 / 7.32 | 1.55 / 8.00 / 12.38 | 0.38 / 1.11 / 2.63 |
| disarm frames (before the reply) | 3.46 / 7.29 / 12.45 | 2.37 / 6.70 / 8.75 | 1.99 / 8.40 / 11.18 | 5.51 / 11.67 / 17.74 | 2.51 / 8.42 / 12.64 |
| deskd's own work between calls | 0.23 / 0.29 / 0.32 | 0.22 / 0.28 / 0.30 | 0.21 / 0.26 / 0.35 | 0.25 / 0.51 / 1.38 | 0.23 / 0.26 / 0.29 |

On the simple page (no frames) each phase is under 1 ms p50 but dispatch, 1.0 to 2.2 ms; a select is `context` 0.8 + `select check` 0.5 + `select set` 0.5 to 0.7, and a scroll is `context` 0.5 + `scroll` 0.5. Every sample's phases are in `b8-samples.json`; the summary of this run is `results/2026-11-07-d0561b4c-6core.json`.

**In the page (profiler, ms of renderer time per action).** The in-page half is small: `prepare` is 0.15 to 0.2 ms on the simple page, and 1.9 to 2.1 ms on the heavy one, of which `frameNear` (every element, to find any frame within 24 px of the point) is 1.3 to 1.5 ms, the fingerprint (`see`) 0.26 to 0.54 ms and the hit-test (`deepHit`) about 0.1 ms. The scroll itself (`scrollIntoView` in `prepare`, or the `scroll` op) is under 0.11 ms even on the heavy page. Typing's `prepare` is 0.6 ms (fingerprint 0.5), a select's 0.9 ms (fingerprint 0.8). `arm` and `disarm` are about 0.03 ms each. So the guard's cost is round trips through Chromium's browser process, not the scripts.

**The re-distill (`snapshot` in the page, as the `get` before each action ran it):**

| Page | In-page snapshot p50 / p95 / max (ms) | Whole `get` with the reply, p50 / p95 / max (ms) | MDoc |
|---|---|---|---|
| simple (56 elements) | 2.17 / 4.24 / 11.75 | 4.43 / 9.70 / 29.81 | 1.8 KB, 9 blocks |
| heavy (4,967 elements) | 76.0 / 114.4 / 210.1 | 97.5 / 149.2 / 291.9 | 203 KB, 900 blocks |

On the heavy page 61 to 66 ms of it is the distiller's `extractText`. On `bceeecac`, before `e050ad72` swapped in the prototype's distiller v2, the same page's snapshot was about 30 ms.

**Pinned to 2 cores** (`taskset -c 4,5` on the whole run, deskd and Chromium both, as a stand-in for a c7g.large's 2 vCPUs, not its speed; 60 runs, no profile pass; load 5.1 to 11.8). Every run `done`. The same picture: `results/2026-11-07-d0561b4c-2core.json`.

| Page | Action | deskd's method p50 / p95 / max (ms) | Frame guard p50 (share) |
|---|---|---|---|
| simple | click a link, a button, a checkbox | 4.9 to 5.8 / 10.9 to 11.5 / 15.4 to 75.0 | 0.9 to 1.0 (21 to 22%) |
| simple | type 20 characters | 5.35 / 9.35 / 13.79 | 1.29 (29%) |
| simple | select; scroll | 2.22 / 6.16 / 8.34; 0.96 / 2.41 / 4.69 | none |
| heavy | click a link | 20.61 / 29.23 / 30.29 | 13.66 (67%) |
| heavy | click a button | 17.40 / 26.23 / 46.29 | 11.55 (66%) |
| heavy | click a checkbox | 17.01 / 27.13 / 57.17 | 11.37 (67%) |
| heavy | type 20 characters | 16.72 / 25.90 / 38.81 | 12.64 (75%) |
| heavy | select; scroll | 3.64 / 6.61 / 9.91; 1.31 / 5.35 / 7.07 | none |
| heavy | click a far button (scrolled first) | 32.28 / 51.75 / 76.36 | 22.65 (71%) |

The far button's batch ran last, as the machine's load rose from 6.7 to 11.8, so read it as the loaded case. The heavy page's re-distill on 2 cores: 77.8 / 124.0 / 169.5 ms in the page, 99.7 / 154.6 / 202.4 ms for the whole `get`.

### Against B8 and the prototype

- **B8** caps all of MA's overhead at 50 ms p50 and 150 ms p95. deskd's method is 1 to 6 ms p50 on the simple page and 13 to 26 ms on the heavy one, with p95 at most 42 ms: within budget, leaving 24 ms p50 or more for the client, desk-rtc and the data channel on the heaviest case. The design's "click to pressed state 16 ms" is the client's local feedback and doesn't wait for deskd.
- **The prototype's 82/99 ms p50/p95** (`spikes/browser-bench/minified-proto/results/summary-final-only.json`, 25 in-page actions on real pages from a c7g.large) was the client's round trip over a 52.6 ms p50 WebSocket RTT, so about 30 ms of it wasn't the network. Its server's own action step was 6.9 / 18.7 ms p50/p95 (Playwright, no frame guard and no fingerprint), plus a 7.4 ms settle and a 2.5 ms extract. deskd's method on the simple page (4.4 to 6.2 ms p50) is about the prototype's action step; with 20 frames it is two to four times it, which is the guard.
- **Not in the method, but on the member's path to a painted result:** the re-distill. After an action deskd marks the view dirty; a subscriber's watcher re-distills 24 ms later (the debounce), holding the tab's work lock, and sends the patch. On the heavy page that's 76 ms p50 and 114 ms p95 of snapshot alone. So "click to result painted" on a heavy page is about 16 to 26 + 24 + 76 to 98 ms of deskd p50 before the patch leaves, past B8's 50 ms p50 on its own, and an action that arrives during a re-distill waits for it. On the simple page it's about 2 ms.

### The biggest cost, and how to cut it

The frame guard: about 95 CDP round trips through Chromium's browser process per click or fill on a page with 20 frames (each frame's world is created again for every call, so arming and disarming 20 frames is 80 messages), plus two frame lists done one session after another. None of these suggestions removes a check of Security's (T47-1, T47-2, T47-3):

1. **Disarm after the reply, keeping the tab's work lock until it's done.** The reply waits only for `result`. Frames stay armed a few ms longer, which is stricter, not looser; the guard checks the id, so a late `disarm` can't touch a newer arm; and the next action on the tab still waits for the lock, so arms never overlap. Saves 2 to 5.5 ms p50 on the heavy page (`disarm frames`), up to 12 ms at p95.
2. **Keep each other frame's isolated-world context per document, and list frame sessions at once.** `Page.createIsolatedWorld` hands back the same world each time, so for the frames being armed and disarmed, cache its context id by session, frame and `loaderId` (the frame signature already carries `loaderId`), and drop it on the next commit. A call into a context that's gone fails, and a failed arm already refuses with `frames`, so it still refuses rather than guesses. The top frame's pinned context stays as it is, since it's how a navigation mid-action is caught. That's 40 of the 95 messages. And `PageWorld.frames` asks each frame session for its tree one after another: asking them at once makes `frames list` and `frames recheck` about one round trip each. By the phases above this should take about 3 to 6 ms p50 off a heavy page's click, and with the first, 6 to 12 ms of the 13 to 26 (an estimate from the phases, not measured).

For the re-distill: don't make an action wait on it. The snapshot only reads, and the action's own checks are against the page in the same call (the fingerprint and hit-test in `prepare`), so an action could take the lock ahead of a pending or debounced re-distill rather than queue behind one. That's the Desk Engineer's call on how the lock is shared. The distiller's own time is for `distiller.js`.

## The harness

`MinifiedB8Bench` (`src/test/java/.../browser/`). Not a test: its name matches neither surefire's nor failsafe's patterns, so no build runs it. Nothing in `main` changes:
- The view's `TabAccess` is wrapped to time every call it makes on Chromium (and deskd's own resolve and thaw), and the view is built on it as `enableMinified` builds it, with `MinifiedModule.Timing.DEFAULT`.
- The dispatcher's handler for `browser.minified.act` is wrapped, by reflection, to time the method from its arrival to its return.
- Each CDP call in that window goes into a phase by its method and op: `frames list` (`Page.getFrameTree` on the tab and each frame session), `arm frames` (every other frame's world and its `arm`), `context` (the top frame's world, pinned), `prepare` (deskd's half in the page: fingerprint, sensitive check, scroll into view if needed, hit-test, frame-near check, arming the one element), `frames recheck` (the frame tree again, just before the press), `dispatch` (`Input.*`), `result` (what the element got), `disarm frames`, `select check` / `select set`, `scroll`. `deskd own` is the window less the union of all calls: locks, maps, JSON, threads.
- A second pass runs the CDP sampling profiler (100 us) on the tab's renderer, from the harness's own debugging socket, and splits the time under each of deskd's in-page ops by the function it called. Native calls (scrollIntoView, layout, elementFromPoint, querySelectorAll) count as the self time of the function that made them. Profiled runs aren't in the timings.
- Before each action, a `browser.minified.get` re-distills the view the last action left dirty, and its in-page `snapshot` is timed too. Nobody is subscribed during the timed runs, so no re-distill runs during an action: the numbers are the action's own cost.

Pages, from two local origins (`a.test` and `b.test`, both mapped to loopback by `--host-resolver-rules`, each on its own port), no real sites:
- `/simple`: a short article with a link (the page's own handler, no navigation), a button, a checkbox, a text field and a select near the top, 30 paragraphs of prose, and a button at the bottom. 56 elements.
- `/heavy`: 4,967 elements: an 80-link menu, the same controls, 67 sections of text, lists and tables, a 100-link footer, and **20 frames, 4 of them from the other origin**, so in a renderer of their own (deskd holds 4 frame sessions).

Actions: click a link, a button, a checkbox; type 20 characters (`fill`, one `Input.insertText`, alternating two strings); a select (alternating two options); a scroll of a far element into view (`scroll`, alternating the bottom button and the top link); and a click on a far button, which `prepare` scrolls into view first (alternating the bottom and top buttons). Every action starts from a fresh view, 100 ms after it, and every one is checked: `done`, and the page's own counter.

## Run

From `services/`, with Playwright's Chromium (build 1248, Chrome for Testing 156):

```bash
JAVA_HOME=$HOME/.local/share/ma-desk-toolchain/jdk-21 DESKD_CHROMIUM_BIN=<chrome> MINIFIED_B8_OUT=<folder outside git> ./mvnw -q -f deskd/pom.xml test -Dtest=MinifiedB8Bench -Dsurefire.failIfNoSpecifiedTests=false
```

`MINIFIED_B8_RUNS` (60), `MINIFIED_B8_WARMUP` (3 per batch, after 3 of each action per page), `MINIFIED_B8_PROFILE_RUNS` (30, 0 skips the profile), `MINIFIED_B8_PAUSE_MS` (100), `MINIFIED_B8_PAGES` (`simple,heavy`), `MINIFIED_B8_ONLY` (action names). It writes `b8-summary.md`, `b8-summary.json` and every sample in `b8-samples.json`. The whole run takes about 8 minutes. It was run under `~/work/.build.lock`, so no full `verify` ran beside it.

## What this doesn't cover

- **A desk.** Headless Chromium on a fast x86 core over loopback CDP, not the kiosk's headed Chromium on a c7g.large. Graviton's cores are slower than a 7600X's, and a desk has 2 vCPUs.
- **The Desk app subscribed.** With a subscriber, the re-distill runs on its own after every action and can delay the next one; measured here only as the re-distill's own time.
- **Real pages.** Real sites have heavier scripts and layouts. 20 frames is a lot for an article and few for an ad-heavy page.

## Notes as it went

- Trial, 5 runs each, on `bceeecac`: every action `done` and counted by the page. Simple page 1 to 6 ms in deskd's method; heavy page clicks and typing 14 to 29 ms with 94 to 95 CDP calls each, most of it the frame guard. Selects and scrolls arm nothing: 1 to 3 ms on either page. In the page, `prepare` was about 1 ms on the heavy page, most of it `frameNear`; the re-distill about 30 ms of renderer time.
- Full run on `d0561b4c` (6 cores): the tables above. The re-distill on the heavy page went from about 30 ms to 76 ms p50 with the distiller swap in `e050ad72`.
- Second run on `d0561b4c` pinned to 2 cores: no material change, a click or typing on the heavy page 17 to 21 ms p50, the guard two thirds of it.
