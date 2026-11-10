// Test 2: a real stop through POST /v1/desks/{id}/stop as desk-1, then a real wake from the app.
// node rt-wake.mjs            stop, then wake
// node rt-wake.mjs --wake     the desk is already stopped: wake only
import { mkdirSync } from 'node:fs';
import { ALLOWED, compact, ec2State, events, getDesk, HOST, log, mark, openSession, OTHER, pcStats, S, shot, shutdown, stopDesk, testLabel, wait, waitPanel } from './rt-lib.mjs';

const SHOTS = new URL('../../test-results/real-desk/rt-shots-wake/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const wakeOnly = process.argv.includes('--wake');

const watchdog = setTimeout(() => void shutdown(1, 'watchdog'), 25 * 60 * 1000);
watchdog.unref();

await openSession();

// Poll Platform's word and EC2's word on a schedule, logging only changes.
let pollOn = true;
let lastDesk = '';
let lastEc2 = '';
let desk = null;
async function pollDesk(everyMs) {
  while (pollOn) {
    try {
      desk = await getDesk();
      const key = JSON.stringify([desk.status, desk.state, desk.phase, desk.stopAt, desk.stopReason, desk.lastError]);
      if (key !== lastDesk) {
        lastDesk = key;
        events.push({ at: Date.now(), k: 'desk.poll', state: desk.state, phase: desk.phase });
        log('GET desk', JSON.stringify(desk));
      }
    } catch (e) {
      log('GET desk failed', e.message);
    }
    await wait(everyMs);
  }
}
async function pollEc2(everyMs) {
  while (pollOn) {
    const s = await ec2State();
    if (s !== lastEc2) {
      lastEc2 = s;
      events.push({ at: Date.now(), k: 'ec2', state: s });
      log('EC2 state', s);
    }
    await wait(everyMs);
  }
}

// A screenshot on each new panel label, plus one on a timer.
let shotPrefix = 'start';
let pendingShot = false;
S.onPanel = (d) => {
  if (d.desk === ALLOWED) pendingShot = true;
};
let shooting = false;
async function shooter(everyMs) {
  let last = 0;
  while (pollOn) {
    if (shooting && (pendingShot || Date.now() - last > everyMs)) {
      pendingShot = false;
      last = Date.now();
      const secs = ((Date.now() - (S.markAt ?? Date.now())) / 1000).toFixed(1);
      await shot(SHOTS, `${shotPrefix}+${secs}s`);
    }
    await wait(150);
  }
}
const setShots = (prefix) => {
  shotPrefix = prefix;
  S.markAt = Date.now();
};
void shooter(5000);

const connectsSince = (t) => S.connects.filter((c) => c.at >= t && c.action === 'connect');
const startsSince = (t) => connectsSince(t).filter((c) => c.start === true);

if (!wakeOnly) {
  // ----- 1. A tab open and online, then the stop
  if (!(await waitPanel(/online/, 45000))) {
    log('panel never came online:', testLabel());
    await shutdown(1, 'not online');
  }
  await wait(2500);
  log('online', compact(await pcStats()));
  const before = await getDesk();
  log('desk before', JSON.stringify(before));
  if (before.state !== 'running') await shutdown(1, `desk is ${before.state}, expected running`);
  if (!before.allowedActions?.includes('stop')) {
    log('RESULT: this account has no stop on this desk. allowedActions:', JSON.stringify(before.allowedActions));
    await shutdown(4, 'no stop allowed');
  }
  log('view', await S.page.evaluate(() => localStorage.getItem('ma.view.v1')));

  void pollDesk(2000);
  void pollEc2(10000);
  setShots('stop');
  shooting = true;
  await shot(SHOTS, 'before-stop');

  const tStop = mark('stop-sent');
  const res = await stopDesk();
  log('POST stop', JSON.stringify(res));
  if (res.status !== 200 && res.status !== 202) {
    log('RESULT: the stop was refused. The desk is untouched.');
    await shutdown(4, 'stop refused');
  }

  // Wait for Platform to say stopped.
  const limit = Date.now() + 10 * 60 * 1000;
  while (Date.now() < limit && desk?.state !== 'stopped') await wait(500);
  if (desk?.state !== 'stopped') {
    log('RESULT: not stopped after 10 min', JSON.stringify(desk));
    await shutdown(1, 'stop did not finish');
  }
  const tStopped = Date.now();
  log(`STOPPED per Platform ${(tStopped - tStop) / 1000} s after the POST`);
  log('EC2 now', await ec2State());

  // Keep watching the open tab: when does the panel say asleep, and does anything try to wake?
  const panelLimit = Date.now() + 90 * 1000;
  while (Date.now() < panelLimit && !/asleep/.test(testLabel())) await wait(200);
  log(`panel now ${JSON.stringify(testLabel())}, ${(Date.now() - tStopped) / 1000} s after Platform said stopped`);
  await wait(15000);
  log('open tab, connect calls since the stop:', JSON.stringify(connectsSince(tStop).map((c) => ({ t: (c.at - tStop) / 1000, desk: c.desk, start: c.start }))));
  log('open tab, start:true since the stop:', startsSince(tStop).length);
  log('open tab, close events:', JSON.stringify(events.filter((e) => e.at >= tStop && (e.k === 'ctl.close' || (e.k === 'ws' && /session\.closed|desk\.stopping|desk\.state|desk\.progress/.test(e.type)))).map((e) => ({ t: (e.at - tStop) / 1000, k: e.k, type: e.type, code: e.code, reason: e.reason, state: e.state, phase: e.phase, stopAt: e.stopAt, stopReason: e.stopReason }))));
  await shot(SHOTS, 'open-tab-after-stop');
  shooting = false;
} else {
  void pollDesk(2000);
  void pollEc2(10000);
  await wait(6000);
  log('desk at start', JSON.stringify(desk));
  if (desk?.state !== 'stopped') await shutdown(1, `--wake needs a stopped desk, it is ${desk?.state}`);
}

// ----- 2. A fresh page load: start:false only, and asleep
const tLoad = mark('fresh-load');
delete S.labels[ALLOWED];
await S.page.goto(HOST, { waitUntil: 'load' });
await wait(12000);
const loadConnects = connectsSince(tLoad);
log('fresh load, connect calls:', JSON.stringify(loadConnects.map((c) => ({ t: (c.at - tLoad) / 1000, desk: c.desk, start: c.start }))));
log('fresh load, start:true:', startsSince(tLoad).length);
log('fresh load, panels:', JSON.stringify(S.labels));
log('view', await S.page.evaluate(() => localStorage.getItem('ma.view.v1')));
log('body', (await S.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300));
await shot(SHOTS, 'fresh-load-asleep');
if (startsSince(tLoad).length || !/asleep/.test(testLabel())) {
  log('RESULT: the overview load did not stay asleep. Going on to see where the desk lands.');
}

// ----- 3. Focus the desk, by its accessible button
const button = S.page.locator(`#proxy-${ALLOWED}`);
await button.focus();
await shot(SHOTS, 'before-click');
setShots('wake');
shooting = true;
const tClick = mark('click');
await button.press('Enter');
log('pressed Enter on the desk button');

const online = await waitPanel(/online · /, 6 * 60 * 1000);
const tOnline = Date.now();
log(online ? `ONLINE ${(tOnline - tClick) / 1000} s after the click` : `NOT online 6 min after the click`, JSON.stringify(testLabel()));
await shot(SHOTS, 'wake-end');
shooting = false;
log('stats', compact(await pcStats()));

// The timeline, from the click.
const w = events.filter((e) => e.at >= tClick);
const rel = (e) => (e ? +((e.at - tClick) / 1000).toFixed(3) : null);
const wsFirst = (dir, type, f = () => true) => w.find((e) => e.k === 'ws' && e.dir === dir && e.type === type && f(e));
const timeline = {
  connects: w.filter((e) => e.k === 'api.res' && e.action === 'connect' && e.desk === ALLOWED).map((e) => ({ t: rel(e), start: e.start, status: e.status, state: e.state, phase: e.phase, retryAfter: e.retryAfter, retryAfterSeconds: e.retryAfterSeconds, pollAfterSeconds: e.pollAfterSeconds })),
  connectRequests: w.filter((e) => e.k === 'api.req' && e.action === 'connect').map((e) => ({ t: rel(e), desk: e.desk === ALLOWED ? 'test' : 'other', start: e.start })),
  sessionOpen: rel(wsFirst('->', 'session.open')),
  sessionOpened: rel(wsFirst('<-', 'session.opened')),
  gatewayErrors: w.filter((e) => e.k === 'ws' && e.type === 'error').map((e) => ({ t: rel(e), code: e.code, message: e.message })),
  watch: rel(wsFirst('->', 'watch')),
  gatewayProgress: w.filter((e) => e.k === 'ws' && /desk\.(progress|state)/.test(e.type)).map((e) => ({ t: rel(e), type: e.type, state: e.state, phase: e.phase })),
  offer: rel(wsFirst('->', 'signal')),
  answer: rel(wsFirst('<-', 'signal', (e) => e.data?.type === 'answer')),
  connConnected: rel(w.find((e) => e.k === 'pc.state' && e.connection === 'connected')),
  firstChannelOpen: rel(w.find((e) => e.k === 'dc.open')),
  channels: w.filter((e) => e.k === 'dc.open').map((e) => ({ t: rel(e), label: e.label })),
  hello: rel(w.find((e) => e.k === 'ctl.hello')),
  firstRpc: rel(w.find((e) => e.k === 'rpc.res')),
  panelOnline: online ? +((tOnline - tClick) / 1000).toFixed(3) : null,
  panel: w.filter((e) => e.k === 'panel' && e.desk === ALLOWED).map((e) => ({ t: rel(e), label: e.label.replace(/^[^,]+, \d+ apps, /, '') })),
  otherDeskPanel: w.filter((e) => e.k === 'panel' && e.desk === OTHER).map((e) => ({ t: rel(e), label: e.label.replace(/^[^,]+, \d+ apps, /, '') })),
  platform: w.filter((e) => e.k === 'desk.poll').map((e) => ({ t: rel(e), state: e.state, phase: e.phase })),
  ec2: w.filter((e) => e.k === 'ec2').map((e) => ({ t: rel(e), state: e.state })),
  consoleProblems: w.filter((e) => e.k === 'console').length,
  linkSetupMs: await S.page.evaluate(() => performance.getEntriesByName('ma:desk-link-open').map((e) => Math.round(e.duration))),
};
log('WAKE TIMELINE', JSON.stringify(timeline));

// ----- 4. Does it hold, and is the data real?
await wait(20000);
log('20 s later', compact(await pcStats()), JSON.stringify(testLabel()));
log('final panels', JSON.stringify(S.labels));
try {
  await S.page.getByRole('button', { name: /account/i }).first().click();
  await wait(400);
  const about = S.page.getByRole('menuitem', { name: /about this desk/i });
  if (await about.count()) {
    await about.click();
    await wait(1200);
  }
  log('about text', (await S.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500));
  await shot(SHOTS, 'about');
} catch (e) {
  log('about panel not read:', e.message.slice(0, 200));
}
log('start:true total to any desk since the click:', JSON.stringify(startsSince(tClick).map((c) => ({ t: (c.at - tClick) / 1000, desk: c.desk === ALLOWED ? 'test' : 'other' }))));
log('final desk', JSON.stringify(await getDesk()));
log('final EC2', await ec2State());
pollOn = false;
await shutdown(online ? 0 : 1, 'done');
