# Desk walking-skeleton e2e

Gates promotion to a real member's desk. The shipping web app at `test.office.staging.minimalistalliance.com`, through Platform's API and gateway, over WebRTC to the real `desk-rtc` and `deskd` on the staging test desk `<instance>` (`<test-desk>`). No mocks.

Run (about 10 minutes, mostly the 6.5-minute token-refresh soak):

```bash
export PATH=$HOME/.local/node-v24/bin:$PATH
cd e2e && npm ci && npx playwright install chromium   # once
npx playwright test
```

Needs AWS credentials that can read `/ma/staging/test-users/*` (SSM) and `ssm:SendCommand` on the test desk. Tests run serially (the desk allows 4 sessions). Test 5 runs `systemctl restart deskd` on the test desk; nothing else is changed.

Tests: 1 live `desk.status.get` matches the desk's own `/health` and journal; 2 WebRTC path via `getStats` (desk public IPv4, port 443, not relayed); 3 `session.open` to first rpc reply, 5 opens, p50 against B14 (1.5 s); 4 a 6.5-minute session; 5 recovery after a `deskd` restart; 6 another account is refused.

## Stream check

`tests/stream.spec.ts` proves video, audio, input and reconnect on the same test desk, through Platform's real API and gateway. It signs in, then drives the stack with test code on a stubbed page at the app's origin, so it doesn't exercise the real Browser window. It serves its test pages from a temporary `python3 http.server` on the desk's loopback over SSM, and reads what a page saw from `document.title` through `browser.tab.list` and `browser.tabs`.

```bash
npx playwright test tests/stream.spec.ts --output test-results-stream
```

Measured values go to `screenshots/stream-report.json`, and one decoded frame to `screenshots/stream-frame.png`. Test 6 records latency with the real RTT and fails only if input doesn't work. Its B12 budget assumes 30 ms RTT and an unloaded client, so read the numbers with both in mind. Test 7 restarts `deskd`. The first `live` after boot is measured only on a desk with Chromium stopped.

All tests passed on `ma-desk-0.2.2`, `desk-rtc` 0.2.1 and `deskd` `2026.11.05-f2711bb` on 2026-11-05. On a fresh root the first `live` can take over a minute, so its first frame gets a long wait.

Sign-in works on either managed login or Platform's own pages at `/_signin/`, whichever the app sends it to. The own-pages path is untested until the Desk app honours `auth.signInPath` on staging. Credentials are read from SSM into memory and never printed. Screenshots go to `screenshots/` (ignored by git); `screenshots/report.json` holds the measured numbers.

## Browser window check

`tests/browser-window.spec.ts` gates the real Browser window before it reaches the owner's desk. It drives the shipped app at `test.office.staging.minimalistalliance.com` as `desk-1` on the test desk, with no test client: a real click on the Browser tile opens the window, the video plays at the desk's size with frames advancing and the right pixels, the address bar takes a new tab to a test page, clicks, typing and a wheel scroll are checked from the page's own report in the window's tab strip, closing the window takes `/health` out of `live`, and any console or CSP error fails it. Run it with `npx playwright test tests/browser-window.spec.ts --output test-results-browser`; look at `screenshots/browser-window.png`, and the numbers are in `screenshots/browser-window-report.json`. It has not run yet (2026-11-05), and it fails until the app from `milestone-2-app` is on staging, which also goes for a bare `npx playwright test` now. It shares `stream.spec.ts`'s page server on the desk, so never run the two together, and another viewer on the desk fails its `/health` step.

## Browser session check

`tests/browser-session.spec.ts` carries a real session through events on the test desk's real Chromium and profile (ADR 0035): a persistent and a session cookie, both `HttpOnly`, history, two open tabs and a saved password. It reads them back from Chromium over CDP on the desk: the cookies a test page's server receives, the live tab list, `chrome://history`, `chrome.passwordsPrivate` including decrypting the password. Test data only, from a server on the desk's loopback, on port 18766.

```bash
npx playwright test tests/browser-session.spec.ts --output test-results-session    # kill -9, deskd restart, clean restart
SESSION_KEEP=1 npx playwright test tests/browser-session.spec.ts --output test-results-session   # the same, leaving the seed in place
# then Platform stops and wakes the desk, or swaps its root, and:
SESSION_CHECK=stop-wake npx playwright test tests/browser-session.spec.ts --output test-results-session
SESSION_CHECK=root-swap npx playwright test tests/browser-session.spec.ts --output test-results-session
```

The default run also closes Chromium as the root swap path does (`image/desk-browser-close.sh`, task 33 item 3): `deskd` first, then `desk-browser`, and checks the exit was clean (`exit_type` `SessionEnded` or `Normal`) before anything starts it again, then that the session is intact. It sends the helper from this tree over SSM, so it runs on any image. `SESSION_CHECK=root-swap` reads `exit_type` before it starts Chromium, and fails a swap that wasn't preceded by that close.

The restore rehearsal adds `SESSION_MARK`, and `SESSION_CHECK=restore`, `putback` and `rollback`, with `SESSION_ABSENT`, `SESSION_PRESENT` and `SESSION_VOLUME`. `docs/runbooks/restore-rehearsal.md` has the commands and the order. They need that rehearsal's seed, so don't run them on their own. They ran against the test desk on 2026-11-07, Parts 1 to 5 of that rehearsal (its "Results, 2026-11-07"). The first `SESSION_MARK` run keeps the baseline in `screenshots/session-baseline.json`. **Use marker names nobody has used on that profile:** the cookies stay, so `on_new` from 2026-11-06 is still there and would pass a `SESSION_PRESENT` check by itself (the 2026-11-07 run used `d7_…`). **A marker needs Chromium to keep running about 30 s after it's set to reach the disk,** clean exit or not, so don't stop Chromium straight after a `SESSION_MARK_WAIT=0`.

Its test password and cookies stay in the test desk's profile. It restarts Chromium and `deskd`, so don't run it with another spec or a viewer on the desk. Its last test measures a cookie set 2 s before a `kill -9`, and doesn't gate.

Passed 5 of 5 on the test desk on 2026-11-06, `ma-desk-0.2.2`: the session survived `kill -9`, a `deskd` restart and a clean restart, each read back separately. The cookie set 2 s before a `kill -9` was lost. Since then that last measurement reads nothing: `e2e_fresh` from earlier runs stays in the profile, so it reads "survived" whatever happens (6 of 6 on 2026-11-07, 0.2.9). It needs a cookie name new to each run. A tab closed a few seconds before a restart can come back, because Chromium saves tabs a few seconds late. `SESSION_CHECK` ran for stop and wake, root swaps, a rollback, two restores and three putbacks on 2026-11-07.

## Clipboard check

`tests/clipboard.spec.ts` (TD-209, handoffs 14 B, 15 B and 15 C) copies and pastes through the real Browser window of the shipped app as `desk-1`, with the member's clipboard granted to the app: the exact text with a newline and a tab, once, through the page's own paste event; 1,000,000 bytes whole and 1,000,001 refused with the bar's line; a copy on the desk on the member's clipboard exactly; copy then paste; and a page's own write with no gesture kept off it (measured only: on the kiosk that write has never settled, so the step shows nothing reached the member, not that a write was stopped). It fails if any of the text is in the desk's journal or the console. Numbers go to `screenshots/clipboard-report.json`. It shares `stream.spec.ts`'s page server and opens the window as `browser-window.spec.ts` does, so never run it alongside either.

```bash
npx playwright test tests/clipboard.spec.ts --output test-results-clipboard
```

## Agent relay check

`tests/agent-relay.spec.ts` checks deskd's relay of `agent.*` (`services/deskd/docs/API.md` §11) on a desk with no `desk-agent`, as images up to 0.2.6 are until it's rolled on: each call is `unavailable` with `reason: unavailable`, a write says nothing changed (no `mayHaveApplied`), a malformed key is `bad_request` with `key_malformed` from deskd, `/health` says `agent: waiting`, and the test key never reaches the journal. A desk with `desk-agent` connected skips it and runs the second test instead (task 37, from image 0.2.6 with `desk-agent` rolled on): `agent.providers` lists the three providers, `agent.list`, `agent.key.list` and `agent.audit.list` answer from `desk-agent`, a malformed key is still `bad_request` from deskd, the unit is active and its `health` passes, and the test key never reaches the journal. It only reads: nothing is created and nothing goes to a provider.

```bash
npx playwright test tests/agent-relay.spec.ts --output test-results-agent
```

Both were the weekend's integration checks (`int-15c`), made part of this gate by task 33. The agent relay check's "nothing changed" needs a `deskd` from `sub/desk-followups` on: an older one says `mayHaveApplied: true` there and fails it.

## Bandwidth pause check (opt-in, writes staging)

`bandwidth-pause/` checks that the desk honours the Platform's bandwidth pause (`ma-platform` ADR 0095; task 33 item 1), on the test desk as `desk-1`, with a `deskd` from `sub/desk-followups` on. It sets staging's test knob, `bw_test_week_gb`, on the test desk's row below what the desk has sent this week, so Platform pauses `desk-1`, and checks that the open stream ends, a new `live` is refused with `bandwidth_limit`, `warm`, the tabs and `desk.status.get` go on, and Chromium is the same process, never stopped. Then it puts the row back as it found it, checks that, and that `live` works again. Outside the gate's `testDir`, and skipped unless `BANDWIDTH_PAUSE=1`:

```bash
BANDWIDTH_PAUSE=1 npx playwright test -c bandwidth-pause --output test-results-pause
```

W3 member desk size kit: see `w3/README.md`. Not part of this gate.

Real-sites check (TD-212), 20 sites a member would try first, each pass, challenge or block, with GB/h: see `real-sites/README.md`. Not part of this gate.
