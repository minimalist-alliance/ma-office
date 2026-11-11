// TEST ONLY. ADR 0036 section 6 test 4 (and section 8's open item): the pause a live viewer sees when desk-egress changes the
// stream's profile, and when desk-stream is restarted mid-session, through the real desk-rtc. One client session (page2.js, as
// ../../../../spikes/browser-bench/real-stack/proof2.mjs opens it) watches the 1080p60 clip; the desk runs each step over SSH while
// every presented frame's time and size is recorded. A pause is a gap of over 50 ms between presented frames.
//   node pause.mjs --api http://127.0.0.1:8787 --cdp http://127.0.0.1:19222 --ssh 'ssh ... admin@DESK' --peer <client private address>
//        --out pause.json [--gap 15]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]]);
  return acc;
}, []));
const GAP = +(args.gap || 15) * 1000;
const PAGES = 'http://127.0.0.1:8000';
const ROWS = 'bash /var/tmp/lab/lab/throttle/real/rows.sh';
const STEPS = [
  ['to capped', `sudo env PEER=${args.peer} ROW=profile-capped ${ROWS}`],
  ['to deep', `sudo env PEER=${args.peer} ROW=profile-deep ${ROWS}`],
  ['back to normal', `sudo env PEER=${args.peer} ROW=profile-normal ${ROWS}`],
  ['try-restart 1', 'sudo systemctl try-restart desk-stream.service; echo restarted'],
  ['try-restart 2', 'sudo systemctl try-restart desk-stream.service; echo restarted'],
  ['try-restart 3', 'sudo systemctl try-restart desk-stream.service; echo restarted'],
];
const log = (...a) => console.error(`[pause ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => new Promise((resolve) => {
  const p = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('close', () => resolve(o.trim()));
});
const remote = (cmd) => sh(`${args.ssh} "${cmd}"`);

const pageServer = createServer((req, res) => {
  if (req.url === '/page.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(path.join(here, 'page2.js'))); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>pause</title><style>html,body{margin:0;background:#000}</style><script src="/page.js"></script>');
});
const port = await new Promise((r) => pageServer.listen(8098, '127.0.0.1', () => r(pageServer.address().port)));
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-sandbox'] });
const out = { args: { gap: GAP }, steps: [], failures: [], started: new Date().toISOString() };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const cp = await ctx.newPage();
  await cp.goto(`http://127.0.0.1:${port}`);
  await cp.evaluate((o) => window.openDesk(o), { api: args.api, deskId: 'd-dev0000000000' });
  await cp.evaluate(() => window.D.call('browser.stream.set', { state: 'live' }));
  let kiosk;
  for (let i = 0; i < 60 && !kiosk; i++) { try { kiosk = await chromium.connectOverCDP(args.cdp); } catch { await sleep(1000); } }
  const kpages = kiosk.contexts()[0].pages();
  const kpage = kpages[kpages.length - 1];
  await kpage.goto(`${PAGES}/bbb.html`, { waitUntil: 'load', timeout: 45000 });
  await sleep(4000);
  // every presented frame: its time (performance.now on the client) and size
  await cp.evaluate(() => {
    const v = window.D.video; window.__f = [];
    const f = (now, m) => { window.__f.push([+now.toFixed(1), m.width, m.height]); v.requestVideoFrameCallback(f); };
    v.requestVideoFrameCallback(f);
  });
  const t0 = await cp.evaluate(() => performance.now());
  await sleep(GAP);
  for (const [name, cmd] of STEPS) {
    const a = await cp.evaluate(() => performance.now());
    const said = await remote(cmd);
    const b = await cp.evaluate(() => performance.now());
    out.steps.push({ name, at: +(a - t0).toFixed(0), cmdMs: +(b - a).toFixed(0), said: said.split('\n').slice(-2).join(' | ').slice(0, 200) });
    log(name, said.split('\n').slice(-1)[0]);
    await sleep(GAP);
  }
  const frames = await cp.evaluate(() => window.__f);
  const st = await cp.evaluate(() => window.D.stats());
  const gaps = [];
  for (let i = 1; i < frames.length; i++) {
    const g = frames[i][0] - frames[i - 1][0];
    if (g > 50) gaps.push({ at: +(frames[i - 1][0] - t0).toFixed(0), ms: +g.toFixed(1), sizeBefore: `${frames[i - 1][1]}x${frames[i - 1][2]}`, sizeAfter: `${frames[i][1]}x${frames[i][2]}` });
  }
  for (const s of out.steps) {
    const next = out.steps[out.steps.indexOf(s) + 1]?.at ?? Infinity;
    s.gaps = gaps.filter((g) => g.at >= s.at - 100 && g.at < next).map((g) => ({ ...g, afterCmdStartMs: g.at - s.at }));
    const win = frames.filter((f) => f[0] - t0 >= s.at + 3000 && f[0] - t0 < Math.min(next, s.at + GAP));
    s.fpsAfter = win.length > 1 ? +((win.length - 1) / ((win[win.length - 1][0] - win[0][0]) / 1000)).toFixed(1) : null;
    s.sizeAfter = win.length ? `${win[win.length - 1][1]}x${win[win.length - 1][2]}` : null;
  }
  const base = frames.filter((f) => f[0] - t0 < out.steps[0].at);
  out.baseline = { fps: base.length > 1 ? +((base.length - 1) / ((base[base.length - 1][0] - base[0][0]) / 1000)).toFixed(1) : null, size: base.length ? `${base[0][1]}x${base[0][2]}` : null,
    gapsOver50: gaps.filter((g) => g.at < out.steps[0].at).length };
  out.frames = frames.length; out.gapsOver50 = gaps.length;
  out.client = { framesDecoded: st.video.framesDecoded, framesDropped: st.video.framesDropped, packetsLost: st.video.packetsLost, freezes: st.video.freezeCount, keyframes: st.video.keyFramesDecoded };
  await cp.evaluate(() => window.D.call('browser.stream.set', { state: 'off' })).catch(() => {});
  await kiosk.close().catch(() => {});
} catch (e) {
  out.failures.push(e.message.slice(0, 300)); log('FATAL', e.stack);
} finally {
  out.finished = new Date().toISOString();
  writeFileSync(args.out || 'pause.json', JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
  pageServer.close();
}
process.exit(out.failures.length ? 1 : 0);
