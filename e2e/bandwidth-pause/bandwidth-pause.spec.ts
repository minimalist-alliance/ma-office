// The Platform's bandwidth pause, honoured by the real desk (ma-platform ADR 0095, contract bandwidth.md; task 33 item 1).
// As desk-1 on the staging test desk, with a deskd that reads `streaming` (sub/desk-followups on). It lowers desk-1's
// weekly limit with staging's test knob, `bw_test_week_gb` on the test desk's row, below what the desk has already sent
// this week, so Platform pauses desk-1. Then: the open stream ends, a new `live` is refused with `bandwidth_limit`, the
// session and the other calls go on, and Chromium keeps running, its process and profile untouched. Afterwards it puts the
// row back as it found it, and checks that, and that `live` works again. Staging only: lib.ts names only the test desk.
//
//   cd e2e && BANDWIDTH_PAUSE=1 npx playwright test -c bandwidth-pause --output test-results-pause
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { API, APP, DESK_ID, apiToken, loadUser, onDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

const TABLE = 'ma-staging-desks';
const KEY = JSON.stringify({ desk_id: { S: DESK_ID } });
const KNOB_GB = '0.05';
const ddb = (...args: string[]) => execFileSync('aws', ['dynamodb', ...args, '--output', 'json'], { encoding: 'utf8', env: { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' } });
/** The two attributes this touches, as DynamoDB has them, or absent. Never the counts' history: only what's put back. */
const row = (): { knob?: unknown; hold?: unknown; weekBytes: number } => {
  const item = JSON.parse(ddb('get-item', '--table-name', TABLE, '--key', KEY, '--projection-expression', 'bw_test_week_gb, bw_hold, bw.week_bytes') || '{}').Item ?? {};
  return { knob: item.bw_test_week_gb, hold: item.bw_hold, weekBytes: Number(item.bw?.M?.week_bytes?.N ?? 0) };
};
const setAttr = (name: string, value: unknown) => {
  if (value === undefined) ddb('update-item', '--table-name', TABLE, '--key', KEY, '--update-expression', `REMOVE ${name}`);
  else ddb('update-item', '--table-name', TABLE, '--key', KEY, '--update-expression', `SET ${name} = :v`, '--expression-attribute-values', JSON.stringify({ ':v': value }));
};
const health = async () => JSON.parse((await onDesk('curl -s -m 5 --unix-socket /run/desk/deskd-admin.sock http://desk/health')).trim());
const browserPid = async () => (await onDesk('echo "$(systemctl is-active desk-browser) $(systemctl show -p MainPID --value desk-browser)"')).trim();

test.skip(process.env.BANDWIDTH_PAUSE !== '1', 'writes staging: set BANDWIDTH_PAUSE=1');
test.setTimeout(12 * 60_000);

let context: BrowserContext;
let page: Page;
let client: DeskClient;
let bearer = '';
let found: ReturnType<typeof row> | null = null;
const meter = async () => (await fetch(`${API}/v1/desks/bandwidth`, { headers: { authorization: `Bearer ${bearer}` } })).json();

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  bearer = await apiToken(context, loadUser('desk-1'));
  page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 6 && !opened.ok; i++) {
    opened = await client.open(false);
    if (!opened.ok) await sleep(5000);
  }
  if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code })}`);
});

test.afterAll(async () => {
  if (found) {
    // As found, whatever happened: the knob first, then a read of the meter to lift the hold, then the hold as it was.
    setAttr('bw_test_week_gb', found.knob);
    const after = await meter().catch(() => null);
    console.log(`[pause] meter after the knob went back: ${JSON.stringify({ state: after?.state, paused: after?.paused })}`);
    setAttr('bw_hold', found.hold);
    const now = row();
    console.log(`[pause] row put back: ${JSON.stringify({ knob: now.knob ?? 'absent', hold: now.hold ?? 'absent' })}`);
    expect(JSON.stringify([now.knob, now.hold]), 'the row is as it was found').toBe(JSON.stringify([found.knob, found.hold]));
  }
  await client?.finish().catch(() => {});
  await context?.close();
});

test('paused: the open stream ends, live is refused, the rest goes on, Chromium untouched; then it all comes back', async () => {
  found = row();
  console.log(`[pause] found: ${JSON.stringify({ knob: found.knob ?? 'absent', hold: found.hold ?? 'absent', weekBytes: found.weekBytes })}`);
  expect(found.knob, 'no test knob on the row already').toBeUndefined();
  expect(found.weekBytes, 'more sent this week than the knob allows').toBeGreaterThan(Number(KNOB_GB) * 1e9);
  const h0 = await health();
  expect(h0.browser?.bandwidthPaused, 'not paused at the start').toBeUndefined();

  const live = await client.c<{ error?: unknown; firstCbMs: number | null }>('firstFrame', { state: 'live', waitMs: 60_000 });
  expect(live.error ?? null, 'live before the pause').toBeNull();
  expect(live.firstCbMs, 'a frame before the pause').not.toBeNull();
  const pidBefore = await browserPid();
  console.log(`[pause] desk-browser before: ${pidBefore}`);

  setAttr('bw_test_week_gb', { N: KNOB_GB });
  const m = await meter();
  console.log(`[pause] meter with the knob: ${JSON.stringify({ state: m.state, limitedBy: m.limitedBy, enforced: m.enforced, paused: m.paused, resumesAt: m.resumesAt, weekLimitGb: m.week?.limitGb })}`);
  expect(m.paused, 'Platform pauses desk-1').toBe(true);

  // The desk hears it on its next heartbeat, at most a minute away.
  let h: { browser?: { bandwidthPaused?: unknown }; stream?: { wanted?: string } } = {};
  const t0 = Date.now();
  for (; Date.now() - t0 < 100_000; await sleep(5000)) {
    h = await health();
    if (h.browser?.bandwidthPaused) break;
  }
  console.log(`[pause] desk heard it after ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify({ paused: h.browser?.bandwidthPaused, wanted: h.stream?.wanted })}`);
  // deskd writes the time as Java's Instant does, without Platform's milliseconds, so compare times.
  expect(Date.parse(String(h.browser?.bandwidthPaused)), "/health's browser.bandwidthPaused is resumesAt").toBe(Date.parse(m.resumesAt));

  // The open stream: no more video, and nobody wants it.
  await sleep(3000);
  const s1 = await client.stats();
  await sleep(4000);
  const s2 = await client.stats();
  console.log(`[pause] video packets 4 s apart: ${s1.video?.packetsReceived} -> ${s2.video?.packetsReceived}`);
  expect(s2.video?.packetsReceived, 'no video reaches the session').toBe(s1.video?.packetsReceived);
  expect((await health()).stream?.wanted, 'no session wants the stream').toBe('off');

  const again = await client.rpcTry('browser.stream.set', { state: 'live' }, { deadlineMs: 40_000 });
  console.log(`[pause] live while paused: ${JSON.stringify({ code: again.code, details: again.details })}`);
  expect(again.code).toBe('unavailable');
  const details = again.details as { reason?: string; resumesAt?: string };
  expect(details.reason).toBe('bandwidth_limit');
  expect(Date.parse(String(details.resumesAt)), 'the refusal says when it ends').toBe(Date.parse(m.resumesAt));

  // Everything else goes on. There's no Notebook service on a desk yet, so these are what a desk serves today.
  expect((await client.rpcTry('desk.status.get')).ok, 'desk.status.get').toBe(true);
  expect((await client.rpcTry('browser.tab.list')).ok, 'browser.tab.list: the tabs are still there').toBe(true);
  expect((await client.rpcTry('browser.stream.set', { state: 'warm' }, { deadlineMs: 40_000 })).ok, 'warm still works').toBe(true);
  expect(await browserPid(), 'Chromium is the same process: never stopped, its profile left alone').toBe(pidBefore);
  const journal = (await onDesk("journalctl -u desk-browser --since -10min --no-pager -o cat | grep -c -E 'Stopping|Stopped|Started' || true")).trim();
  expect(journal, 'no stop or start of desk-browser').toBe('0');

  // Back as found.
  setAttr('bw_test_week_gb', found.knob);
  const back = await meter();
  console.log(`[pause] meter with the knob gone: ${JSON.stringify({ state: back.state, paused: back.paused })}`);
  expect(back.paused).toBe(false);
  const t1 = Date.now();
  for (; Date.now() - t1 < 100_000; await sleep(5000)) {
    h = await health();
    if (!h.browser?.bandwidthPaused) break;
  }
  console.log(`[pause] desk heard the end after ${Math.round((Date.now() - t1) / 1000)} s`);
  expect(h.browser?.bandwidthPaused, 'not paused any more').toBeUndefined();
  const relive = await client.c<{ error?: unknown; firstCbMs: number | null }>('firstFrame', { state: 'live', waitMs: 60_000 });
  expect(relive.error ?? null, 'live after the pause').toBeNull();
  expect(relive.firstCbMs, 'a frame after the pause').not.toBeNull();
});
