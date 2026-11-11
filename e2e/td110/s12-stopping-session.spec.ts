// S-12 (coordinator, Nov 11): a real session opened through the Desk app while the test desk is `stopping` from a planned stop
// (scripts/desk-stop-test.py, the platform's own stop path). Records what the member sees at each point, lets the stop finish and the
// app's `connect` wake the desk, then reads the desk's cookie and tabs. Runs on a temporary staging test desk (TD_INSTANCE, TD_DESK_ID, TD_APP, TD_USER; lib.ts). Needs S12_DIR, the folder
// with runstep.sh and the on-desk step files (the TD-110 rerun's scratch), and S12_RUNS (default 2).
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { DESK_ID, INSTANCE, loadUser, signInApp, watch } from '../tests/lib';

const DIR = process.env.S12_DIR ?? '';
test.skip(!DIR, 'S12_DIR is not set');
const RUNS = Number(process.env.S12_RUNS ?? 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' };
const aws = (...a: string[]) => execFileSync('aws', a, { encoding: 'utf8', env, maxBuffer: 64 << 20 });
const step = (t: number, ...files: string[]) => execFileSync(`${DIR}/runstep.sh`, [String(t), ...files], { encoding: 'utf8', env, cwd: DIR, timeout: (t + 60) * 1000 });
const row = () => { const i = JSON.parse(aws('dynamodb', 'get-item', '--table-name', 'ma-staging-desks', '--key', JSON.stringify({ desk_id: { S: DESK_ID } }), '--consistent-read', '--output', 'json')).Item ?? {}; return String(i.state?.S ?? '?'); };
const ec2 = () => aws('ec2', 'describe-instances', '--instance-ids', INSTANCE, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text').trim();
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);

test('S-12: a session opened mid-stop', async ({ browser }) => {
  if (!process.env.TD_INSTANCE || INSTANCE !== process.env.TD_INSTANCE || INSTANCE === process.env['E2E_TEST_INSTANCE']) throw new Error('this rerun runs on its own temporary staging test desk only (TD_INSTANCE)');
  const out: unknown[] = [];
  for (let n = 1; n <= RUNS; n++) {
    const log: string[] = [];
    const L = (m: string) => { const s = `${clock(Date.now())} ${m}`; log.push(s); console.log(`[s12 run ${n}] ${s}`); };
    // 1. the desk running with the seed, and a marker cookie set well before the stop
    step(300, 'c_pre.sh');
    for (let i = 0; i < 40 && row() !== 'running'; i++) await sleep(8000);
    L(`row ${row()}, EC2 ${ec2()}`);
    step(100, `c_mark_s12_${n}.sh`);
    await sleep(35_000); // past Chromium's 30 s commit: this run is about the session, not the commit window
    // 2. the member signs in to the office (no desk session yet)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const w = watch(page);
    await signInApp(context, page, loadUser(process.env.TD_USER ?? 'desk-1'));
    await page.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
    L('signed in to the office; desk not opened yet');
    // 3. the planned stop, then the page opens the desk straight after the mark
    const stop = spawn('python3', ['-u', `${process.env.HOME}/minimalist-alliance/scripts/desk-stop-test.py`, '--desk', DESK_ID], { env });
    let stopOut = '';
    stop.stdout.on('data', (d) => { stopOut += d; });
    for (let i = 0; i < 4200 && !stopOut.includes('MARKED'); i++) await sleep(100);
    if (!stopOut.includes('MARKED')) throw new Error('desk-stop-test never marked the desk');
    L(`desk-stop-test marked: ${stopOut.split('\n').find((l) => l.includes('MARKED'))}`);
    const tMark = Date.now();
    const trace: { t: number; panel: string; row: string }[] = [];
    let lastKey = '';
    const sample = async (panelText: string, rowState: string) => {
      const key = `${panelText}|${rowState}`;
      if (key !== lastKey) { lastKey = key; trace.push({ t: Date.now() - tMark, panel: panelText, row: rowState }); L(`+${((Date.now() - tMark) / 1000).toFixed(1)} s  app: "${panelText}"  desks row: ${rowState}  connect: [${w.connectStatuses.join(',')}]`); }
    };
    const tileOpen = async () => {
      const proxy = page.locator(`#proxy-${DESK_ID}`);
      await proxy.focus();
      await page.keyboard.press('Enter');
      const tile = proxy.locator('..').getByRole('button', { name: /^Browser/ });
      let box = await tile.boundingBox();
      for (let i = 0, held = 0; i < 60 && held < 4; i++) { await sleep(250); const b = await tile.boundingBox(); held = b && JSON.stringify(b) === JSON.stringify(box) ? held + 1 : 0; box = b; }
      if (!box) throw new Error('no Browser tile');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(150);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    let rowState = row();
    let opened = false;
    let live = false;
    let tLive = 0;
    let sawDown = false;
    let woke = false;
    let lastRow = 0;
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      if (Date.now() - lastRow > 3000) { rowState = row(); lastRow = Date.now(); }
      if (!opened) { await tileOpen().catch((e) => L(`open: ${String(e).slice(0, 160)}`)); opened = true; L('Browser tile clicked'); }
      const dlg = page.getByRole('dialog', { name: /Browser/ });
      const text = (await dlg.innerText().catch(() => '(no Browser window)')).replace(/\s+/g, ' ').slice(0, 140);
      const video = await page.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0)).catch(() => false);
      await sample(video ? `${text} [video has pixels]` : text, rowState);
      if (rowState !== 'running') sawDown = true;
      const wake = page.getByRole('button', { name: /^Wake this desk$/ });
      if (!woke && (await wake.isVisible().catch(() => false))) { woke = true; L(`+${((Date.now() - tMark) / 1000).toFixed(1)} s  the member presses "Wake this desk" (the app does not wake it by itself)`); await wake.click().catch((e) => L(`wake click: ${String(e).slice(0, 120)}`)); }
      if (video && rowState === 'running' && sawDown) { live = true; tLive = Date.now(); break; }
      await sleep(500);
    }
    const stopCode = await new Promise<number | null>((res) => { if (stop.exitCode !== null) res(stop.exitCode); else stop.on('exit', (c) => res(c)); setTimeout(() => res(null), 10_000); });
    L(`desk-stop-test exit ${stopCode}: ${stopOut.split('\n').filter((l) => /STOPPED|state/.test(l)).slice(-3).join(' / ')}`);
    L(`live=${live}${live ? ` ${((tLive - tMark) / 1000).toFixed(1)} s after the mark` : ''}; reload happened: ${(await page.evaluate(() => (window as unknown as { __sentinel?: number }).__sentinel).catch(() => undefined)) !== 1}`);
    L(`EC2 ${ec2()}; row ${row()}; console errors: ${JSON.stringify(w.errors.slice(0, 5))}; connect statuses: [${w.connectStatuses.join(',')}]`);
    await page.screenshot({ path: `${DIR}/s12-run${n}-end.png` }).catch(() => undefined);
    // 4. what the desk kept (the app still has its session open)
    let chk = '';
    try { chk = step(200, `c_chk_s12_${n}.sh`); } catch (e) { chk = `check failed: ${String(e).slice(0, 300)}`; }
    L(`desk after the wake:\n${chk}`);
    out.push({ run: n, trace, log, stopOut });
    await context.close();
    await sleep(20_000);
  }
  writeFileSync(`${DIR}/s12-result.json`, JSON.stringify(out, null, 2));
});
