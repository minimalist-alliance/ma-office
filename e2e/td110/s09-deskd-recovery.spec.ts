// S-09's leftover, measured (TD-110 rerun): how long the real Desk app page takes to recover while `deskd` is switched on the desk,
// two ways: a component rollout (desk-service-release.sh rollout deskd <v> test --instance <i>) and a signed desk batch (tools/batch,
// KMS alias/ma-desk-batch, an idle.json written by hand on this test desk only and removed after). Each way: S09_CYCLES (3) forward
// switches and 3 back, so the desk ends on the version it started on. The page is signed in and the desk focused the way
// tests/skeleton.spec.ts does, and recovery is read the way its test 5 does: a new peer connection by itself, then a fresh
// desk.status.get reply on it. Needs S09_DIR (runstep.sh, batch/m1..m6.json(.sig)), S09_FROM (the desk's deskd), S09_TO.
// Runs on the temporary desk named by TD_INSTANCE only (lib.ts).
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DESK_ID, INSTANCE, loadUser, openAbout, signInApp, watch } from '../tests/lib';

const DIR = process.env.S09_DIR ?? '';
test.skip(!DIR, 'S09_DIR is not set');
const FROM = process.env.S09_FROM ?? '';
const TO = process.env.S09_TO ?? '';
const CYCLES = Number(process.env.S09_CYCLES ?? 3);
const HOME = process.env.HOME ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);
const marks = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const e = (window as unknown as { __e2e: { marks: Record<string, number[]>; pcs: RTCPeerConnection[] } }).__e2e;
  return { pcCreated: e.marks.pcCreated.length, rpcMsg: e.marks.rpcMsg.length, connected: e.pcs.filter((pc) => pc.connectionState === 'connected').length };
});

interface Sample { method: string; to: string; issueToLiveS: number | null; downToLiveS: number | null; commandDoneToLiveS: number | null; commandS: number | null; newPeerConnections: number; reload: boolean; reloadToLiveS?: number | null; deskd: string }
const samples: Sample[] = [];

test('S-09: the page through a deskd switch', async ({ browser }) => {
  test.setTimeout(90 * 60_000);
  if (!process.env.TD_INSTANCE || INSTANCE !== process.env.TD_INSTANCE || INSTANCE === process.env['E2E_TEST_INSTANCE']) throw new Error('this rerun runs on its own temporary staging test desk only (TD_INSTANCE)');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const w = watch(page);
  await signInApp(context, page, loadUser(process.env.TD_USER ?? 'desk-1'));
  await expect.poll(() => w.desks.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.locator('.ma-shell').waitFor({ timeout: 30_000 });
  await page.locator(`#proxy-${DESK_ID}`).focus();
  await page.keyboard.press('Enter');
  await openAbout(page);
  await page.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });

  // `run` starts the switch, and returns when it is over. `issued` is set when it began.
  async function measure(method: string, to: string, start: () => { done: Promise<void>; issued: () => number }): Promise<void> {
    const m0 = await marks(page);
    const t = start();
    let tDone = 0;
    void t.done.then(() => { tDone = Date.now(); });
    const tIssue = t.issued();
    let tDown = 0, tLive = 0, text = '';
    while (Date.now() - tIssue < 240_000) {
      const m = await marks(page);
      if (!tDown && (m.connected === 0 || m.pcCreated > m0.pcCreated)) tDown = Date.now();
      if (m.pcCreated > m0.pcCreated) {
        text = await openAbout(page, { afterPc: m0.pcCreated, maxAgeMs: 60_000, timeoutMs: 800 }).catch(() => '');
        if (text) { tLive = Date.now(); break; }
      }
      await sleep(200);
    }
    await t.done.catch(() => undefined);
    if (!tDone) tDone = Date.now();
    const s: Sample = { method, to, issueToLiveS: tLive ? +((tLive - tIssue) / 1000).toFixed(1) : null, downToLiveS: tLive && tDown ? +((tLive - tDown) / 1000).toFixed(1) : null, commandDoneToLiveS: tLive ? +((tLive - tDone) / 1000).toFixed(1) : null, commandS: +((tDone - tIssue) / 1000).toFixed(1), newPeerConnections: (await marks(page)).pcCreated - m0.pcCreated, reload: false, deskd: /Service deskd (\S+)/.exec(text)?.[1] ?? '' };
    if (!tLive) { // the page did not come back by itself: a reload is what a member would do
      const r0 = Date.now();
      await page.reload();
      await page.locator('.ma-shell').waitFor({ timeout: 60_000 });
      await page.locator(`#proxy-${DESK_ID}`).focus();
      await page.keyboard.press('Enter');
      const t2 = await openAbout(page, { timeoutMs: 120_000 }).catch(() => '');
      s.reload = true; s.reloadToLiveS = t2 ? +((Date.now() - r0) / 1000).toFixed(1) : null; s.deskd = /Service deskd (\S+)/.exec(t2)?.[1] ?? '';
      await page.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
    }
    samples.push(s);
    console.log(`[s09] ${clock(Date.now())} ${JSON.stringify(s)}`);
    writeFileSync(`${DIR}/s09-result.json`, JSON.stringify({ samples, errors: w.errors.slice(0, 10) }, null, 2));
    await sleep(30_000);
  }

  const rollout = (ver: string) => () => {
    const issued = Date.now();
    const p = spawn(`${HOME}/minimalist-alliance/scripts/desk-service-release.sh`, ['rollout', 'deskd', ver, 'test', '--instance', INSTANCE], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    return { issued: () => issued, done: new Promise<void>((res, rej) => p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`rollout exit ${c}: ${out.slice(-300)}`))))) };
  };
  const batch = (k: number) => () => {
    const urls = execFileSync(`${process.cwd()}/../tools/batch/batch-urls`, [`${DIR}/batch/m${k}.json`], { env, encoding: 'utf8' });
    const b64 = (f: string) => readFileSync(f).toString('base64');
    const idle = `python3 -I -c "import json,datetime as d;n=d.datetime.now(d.timezone.utc);f=lambda t:t.strftime('%Y-%m-%dT%H:%M:%SZ');json.dump({'at':f(n),'sessions':0,'agentTasks':0,'exports':0,'downloads':0,'idleSince':f(n-d.timedelta(seconds=900))},open('/run/desk/idle.tmp','w'))" && chown desk:desk /run/desk/idle.tmp && chmod 644 /run/desk/idle.tmp && mv /run/desk/idle.tmp /run/desk/idle.json`;
    const script = [
      'install -d -m 0700 /var/tmp/td110b',
      `echo ${b64(`${DIR}/batch/m${k}.json`)} | base64 -d > /var/tmp/td110b/m.json`,
      `echo ${b64(`${DIR}/batch/m${k}.json.sig`)} | base64 -d > /var/tmp/td110b/m.sig`,
      `echo ${Buffer.from(urls).toString('base64')} | base64 -d > /var/tmp/td110b/urls.json`,
      `idle() { ${idle}; }`,
      '/usr/local/lib/ma/desk-batch offer /var/tmp/td110b/m.json /var/tmp/td110b/m.sig /var/tmp/td110b/urls.json 2>&1 | tail -n 1',
      'idle; ( while :; do idle; sleep 2; done ) & W=$!',
      'echo "tick start $(date +%s.%N)"; /usr/local/lib/ma/desk-batch tick 2>&1 | tail -n 3; echo "tick end rc=$? $(date +%s.%N)"',
      'kill $W; rm -f /run/desk/idle.json /var/tmp/td110b/urls.json',
      'journalctl -u desk-batch --no-pager -o cat --since "-3min" | grep -a "batch" | tail -n 5',
    ].join('\n');
    const file = `${DIR}/s09-batch-step.sh`;
    writeFileSync(file, script + '\n');
    const issued = Date.now();
    return { issued: () => issued, done: new Promise<void>((res, rej) => execFile(`${DIR}/runstep.sh`, ['300', file], { env, cwd: DIR, maxBuffer: 8 << 20 }, (e, so) => { console.log(`[s09] batch ${k} on the desk:\n${so}`); e ? rej(e) : res(); })) };
  };

  // ma-update refuses `rollout <version>` for a release that is already installed as previous ("from another artifact"), so the
  // first switch is a real rollout of a new release (S09_TO) and every later one is `rollback`, which swaps current and previous.
  // The desk starts on S09_FROM, so S09_ROLLBACKS (odd) ends on S09_FROM.
  // (S09_SKIP_ROLLOUT=1: the desk already ran S09_TO as current, from an earlier attempt's real rollout.)
  if (!process.env.S09_SKIP_ROLLOUT) await measure('rollout', TO, rollout(TO));
  const rollbackFn = () => {
    const issued = Date.now();
    const p = spawn(`${HOME}/minimalist-alliance/scripts/desk-service-release.sh`, ['rollback', 'deskd', 'test', '--instance', INSTANCE], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    return { issued: () => issued, done: new Promise<void>((res, rej) => p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`rollback exit ${c}: ${out.slice(-300)}`))))) };
  };
  for (let c = 1; c <= Number(process.env.S09_ROLLBACKS ?? 5); c++) await measure('rollback', c % 2 === 1 ? FROM : TO, rollbackFn);
  for (let c = 1; c <= CYCLES; c++) {
    await measure('batch', TO, batch(2 * c - 1));
    await measure('batch', FROM, batch(2 * c));
  }
  expect(await page.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel), 'no reload happened at the end').toBe(1);
  await context.close();
});
