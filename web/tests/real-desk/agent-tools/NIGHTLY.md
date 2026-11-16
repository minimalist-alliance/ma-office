# Proposal: the Agent tools' real-desk runs, nightly

**A proposal, not a change.** The regression controller lives in ma-platform (`ops/regression/`), and nothing there is
changed by this. Whoever owns the controller (the Lead, by `owners.json`) takes it or not.

ADR 0028's `perf-desk` tier runs nightly on a `DeskKind=test` desk at round trips of 30, 70 and 90 ms and a lossy profile,
and the draft ADR "the Agent's tools and approvals" §17 says each tool's real-desk and performance runs block its release.
This puts `rt-agent-tools.mjs` and `rt-agent-perf.mjs` on the controller's staging tier, as `staging-desk-e2e` is: no
GitHub Actions, the controller's own cron, its own lock handling, its own triage.

## The suites (`suites.json`, under `ma-desk.suites`)

```json
"staging-agent-tools": {
  "tier": "staging",
  "schedule": "nightly 05:45 MT",
  "dir": "web",
  "kind": "nodetest",
  "timeoutMin": 40,
  "local": true,
  "lock": "~/work/.test-desk.lock",
  "cmd": "MA_TEST_DESK_LOCK=held MA_AGENT_TEST_KEY_PARAM=/ma/staging/agent-harness/model-key node tests/real-desk/rt-agent-tools.mjs --tool all --remove-leftovers --budget-min 30 --junit $RESULTS/junit-agent-tools.xml",
  "_note": "Draft ADR 'the Agent's tools and approvals' §17, 'A real desk'. On the controller (local), as staging-desk-e2e: it reads desk-1 and the capped model key from SSM, which never go to the boxes. The lock is the test desk's; inside it MA_TEST_DESK_LOCK=held tells the script it holds it. Never wakes the desk. One junit case per tool case (`files/files-3-approve`) and per run check (`run: no CSP violations`). Cleans up its agent, its key and the Harness world at the end, and an earlier crashed run's leftovers at the start."
},
"staging-agent-perf": {
  "tier": "staging",
  "schedule": "nightly 06:30 MT",
  "dir": "web",
  "kind": "nodetest",
  "timeoutMin": 58,
  "local": true,
  "lock": "~/work/.test-desk.lock",
  "cmd": "MA_TEST_DESK_LOCK=held MA_AGENT_TEST_KEY_PARAM=/ma/staging/agent-harness/model-key node tests/real-desk/rt-agent-perf.mjs --profiles 30,70,90,lossy --runs 10 --budget-min 45 --junit $RESULTS/junit-agent-perf.xml",
  "_note": "ADR 0028's perf-desk, for the Agent's tools: draft ADR §17's client-side numbers at 30, 70 and 90 ms and lossy, the round trip emulated in the page (agent-tools/rtt-shim.mjs; tc netem on a box with root is the real thing). One junit case per profile and measure (`70/cardShown`), failed on a budget miss. On the controller (local). Never wakes the desk."
}
```

`kind: nodetest` reads every `junit*.xml` in `$RESULTS`, which both scripts write with `--junit`. Neither has a `rerun`
template, so a red run reruns whole, once, as the README's "Reruns" section says. A held test desk lock (a release agent
on the desk) is flock's exit 75 and reads as `skipped (lock)`, never as a failure.

The controller checkout has no `dist/release`, so both scripts load the bundle staging serves that night and log its
version, which a red run's log then names. To hold a run to one version, add `MA_EXPECT_VERSION=<version>` to its `cmd`:
the tools run then fails at once on any other bundle.

## The cron lines (`installCron()` in `regression.mjs`)

Two more lines in `lines`, under the staging lock as the others are. The test desk's own lock is the suite's `lock` field,
which `runLocalSuite` takes with `flock -n`.

```js
// After fleet-journeys (05:10, 30 min at most) and before the 08:40 smoke: the tools run, then the perf run.
`45 5 * * * flock -w 3600 ${slock} bash -c '${pre} staging staging-agent-tools' >> ${slog} 2>&1 # ma-regression`,
`30 6 * * * flock -w 3600 ${slock} bash -c '${pre} staging staging-agent-perf' >> ${slog} 2>&1 # ma-regression`,
```

Today's staging crons are 02:40 (smoke, also 08:40, 14:40, 20:40), 03:20 (platform e2e, 45 min), 03:40 (desk e2e, 45 min)
and 05:10 (fleet journeys, 30 min). 05:45 to 06:25 and 06:30 to 07:28 at the most sit between the fleet journeys and the
08:40 smoke, so none of them waits on the staging lock. Run `install-cron` again after the merge.

## Owners (`owners.json`, `stagingSpecs`)

First match wins, by a test id's text, so the narrow ones go first:

```json
"/setupOpen": "UI/UX Engineer",
"/cardShown": "UI/UX Engineer",
"/appendShows": "Desk Engineer",
"rt-agent-perf": "Desk Engineer",
"browser/": "Desk Engineer",
"notebook/": "Desk Engineer",
"files/": "Desk Engineer",
"rt-agent-tools": "Desk Engineer"
```

The Desk Engineer owns deskd and desk-agent, where a tool or a card goes wrong; the UI/UX Engineer the Agent window, where a
card shows late or the setup screen opens slowly. The AI Engineer co-owns the tools (the owner's decision of Nov 12) and
should be copied on every `files/`, `notebook/` and `browser/` line; the controller names one owner, so that's a note in the
PROGRESS line's runbook, not a key.

## What it needs

- **The capped model key**, in SSM at a parameter under `/ma/staging/` (proposed: `/ma/staging/agent-harness/model-key`,
  SecureString), readable by the controller's AWS identity, and capped at the provider (a spend limit that a night of both
  suites can't pass: the tools run makes about 20 short model runs, the perf run about 80). It doesn't exist yet: the
  Platform Engineer makes it, and the owner approves the provider and the cap, since it's a paid key.
- **A box**: the controller itself (`local: true`), as for `staging-desk-e2e`. It has the AWS read access for desk-1 and
  the key, Node 24 and Playwright's Chromium (`runLocalSuite` installs `web`'s `node_modules` and the browser). Nothing goes
  to the build boxes.
- **SSM send-command on the test desk's instance**, for the tools run's one journal count (the canary). Without it that
  check fails with "not read", and the rest still run.
- **The test desk running at 05:45.** Neither script wakes it, by rule; a stopped desk fails the suite at its start
  ("the desk is stopped"), which the controller reports as a run that didn't run, not a regression. Open: whether the test
  desk's auto stop leaves it running then, or the suites need a wake before them (a step the owner of the test desk agrees to).
- **Optional:** `MA_AGENT_FIXTURE_BASE`, an https origin serving `cases/browser.mjs`'s `FIXTURES` (a static bucket on
  staging), which turns the injection case on. Without it that case is skipped and says so.

## Not in this

- The runs stay off GitHub Actions entirely, as the controller does.
- `perf-device` (reference devices) and the weekly TURN profile are ADR 0028's other tiers, not these suites.
- The first nightly results should be read by hand for a week before either suite's misses page anyone: the emulated round
  trip is new, and the budgets come from §17, not from a measured baseline.
