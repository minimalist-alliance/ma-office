// The perf-pr check (TD-73): run by hand, from this machine or a build box. No CI, no git hook.
//
//   node scripts/perf-pr.mjs            build, measure, compare with perf-baseline.json, exit 1 on a regression
//   node scripts/perf-pr.mjs --update   build, measure, write perf-baseline.json (do it from origin/main)
//   [--port 4751] [--skip-build] [--runs 3]    --port defaults to $MA_PW_PORT, else 4751; the e2e bundle takes port+1
//
// What it does: `npm run build:release` (its own report gives the initial JS and CSS gzip, and the check that the dev
// overlay is not in the bundle), `build:e2e`, then serves the e2e bundle with harness/serve.mjs and measures, in
// headless Chromium on the harness office (`?fixture=one`, Light, 1440x900):
//   1. frames during a 3 s canvas pan and a 3 s wheel zoom: median fps and 5th-percentile fps (from the
//      requestAnimationFrame deltas; p5 fps = 1000 / the 95th-percentile delta);
//   2. the time to open a window from its tile: pointer up to the window's first animation frame (the Chat window,
//      which has no chunk of its own to wait for), median of RUNS opens.
// The interaction numbers come from the e2e bundle, not the release one, because only it carries the mock desk
// (`__maDesk`, the tiles' apps); it is the same code and the same build tool. The release bundle gives the sizes.
//
// Thresholds (a run FAILS when any is true; a baseline is needed for the first three):
//   - fps p5 of the pan or the zoom is more than 10 % under the baseline's;
//   - the window opens more than 20 % slower than the baseline (and by at least 15 ms, below which is noise);
//   - the initial JS (gzip) is over 250 KB (always), or more than 5 % over the baseline's;
//   - the release bundle contains the dev overlay's marker.
// Headless Chromium here has software compositing and the machine is shared, so the absolute fps says little: the
// baseline is a ratio against the same machine, not a verdict on 60 fps (docs/desk-design.md 2.2). For a fair
// comparison run it with little else on the machine, and rerun once before believing a fail.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(WEB);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const PORT = Number(arg('port', process.env.MA_PW_PORT ?? '4751')) + 1;
const RUNS = Number(arg('runs', '3'));
const BASE = `http://localhost:${PORT}`;
const BASELINE = join(WEB, 'perf-baseline.json');
const MAX_JS_GZ = 250 * 1024;
const OVERLAY_MARKER = 'ma-dev-perf-overlay';
const T = { fpsP5: 0.10, open: 0.20, openMinMs: 15, js: 0.05 };

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });
const round = (v, d = 1) => Number(v.toFixed(d));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const median = (a) => pct(a, 0.5);

// 1. Builds.
let report = '';
if (!flag('skip-build')) {
  report = sh('node', ['scripts/build-release.mjs']);
  sh('npx', ['vite', 'build', '--mode', 'e2e', '--base', '/v/e2e/', '--outDir', 'dist/e2e', '--emptyOutDir']);
} else {
  console.log('--skip-build: the sizes come from the dist/release already there');
  report = sh('node', ['-e', `const{gzipSync}=require('zlib'),fs=require('fs');const r=JSON.parse(fs.readFileSync('dist/release/ma-release.json','utf8'));console.log('JS gz '+(gzipSync(fs.readFileSync('dist/release/'+r.entry)).length/1024).toFixed(1)+' KB initial');console.log('CSS gz '+(r.css.reduce((s,f)=>s+gzipSync(fs.readFileSync('dist/release/'+f)).length,0)/1024).toFixed(1)+' KB')`]);
}
const jsKb = Number(/JS gz\s+([\d.]+) KB/.exec(report)?.[1]);
const cssKb = Number(/CSS gz\s+([\d.]+) KB/.exec(report)?.[1]);
if (!jsKb || !cssKb) { console.error('perf-pr: could not read the sizes from the build report:\n' + report); process.exit(2); }
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const overlayInRelease = walk('dist/release').filter((f) => /\.(js|css|html)$/.test(f)).some((f) => readFileSync(f, 'utf8').includes(OVERLAY_MARKER));

// 2. Serve the e2e bundle with the harness and measure.
const server = spawn('node', ['harness/serve.mjs', '--dist', 'dist/e2e', '--port', String(PORT)], { stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(BASE)).status) break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const RAF = () => {
  const q = { t: [], run: false };
  window.__perfFrames = q;
  const loop = (t) => { if (q.run) q.t.push(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
};
const fpsOf = (ts) => {
  const d = ts.slice(1).map((t, i) => t - ts[i]);
  return { median: round(1000 / median(d)), p5: round(1000 / pct(d, 0.95)), frames: d.length };
};

const browser = await chromium.launch();
let numbers;
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  await page.addInitScript(() => { localStorage.setItem('ma.prefs.theme', JSON.stringify({ mode: 'light', systemDark: 'dark' })); localStorage.setItem('ma.theme.resolved', 'light'); });
  await page.goto(BASE);
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
  await button.or(page.locator('.ma-shell')).first().waitFor();
  if (await button.isVisible()) await button.click();
  await page.locator('.ma-shell').waitFor();
  await page.goto(`${BASE}/?fixture=one`);
  await page.locator('.ma-shell').waitFor();
  await page.waitForFunction(() => performance.getEntriesByName('ma:first-canvas-paint').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(RAF);
  await page.locator('.canvas-wrap').focus();
  await page.keyboard.press('0');
  await page.waitForTimeout(900);

  const frames = async (action) => {
    await page.evaluate(() => { window.__perfFrames.t = []; window.__perfFrames.run = true; });
    await action();
    return fpsOf(await page.evaluate(() => { window.__perfFrames.run = false; return window.__perfFrames.t; }));
  };
  const [px, py] = await page.evaluate(([vw, vh]) => {
    const st = window.__maDesk.camera.getStage();
    for (let y = 120; y < vh - 120; y += 20) for (let x = 60; x < vw - 60; x += 20) if (!st.getIntersection({ x, y })) return [x, y];
    return [20, vh / 2];
  }, [1440, 900]);
  // A 3 s pan: a real drag on the ground, back and forth.
  const pan = await frames(async () => {
    await page.mouse.move(px, py);
    await page.mouse.down();
    const end = Date.now() + 3000;
    for (let i = 0; Date.now() < end; i += 1) { const dx = (i % 60) * 5 * (Math.floor(i / 60) % 2 ? -1 : 1); await page.mouse.move(px + dx, py + dx * 0.4); await page.waitForTimeout(8); }
    await page.mouse.up();
  });
  // A 3 s zoom: wheel in and out at the middle, 20 steps each way.
  await page.keyboard.press('0');
  await page.waitForTimeout(900);
  await page.mouse.move(720, 450);
  const zoom = await frames(async () => {
    const end = Date.now() + 3000;
    for (let i = 0; Date.now() < end; i += 1) { await page.mouse.wheel(0, Math.floor(i / 20) % 2 ? 60 : -60); await page.waitForTimeout(14); }
  });
  // Opening a window from its tile (Chat): the Enter key to the window's first animation frame. The first open warms the code and is dropped.
  await page.keyboard.press('0');
  await page.waitForTimeout(900);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Chat/ });
  const opens = [];
  for (let i = 0; i < RUNS + 1; i += 1) {
    await tile.focus();
    await page.evaluate(() => {
      window.__perfOpen = new Promise((resolve) => {
        let t0 = 0;
        window.addEventListener('keydown', (e) => { t0 = e.timeStamp; }, { capture: true, once: true });
        const mo = new MutationObserver(() => {
          if (t0 && document.querySelector('[role=dialog]')) { mo.disconnect(); requestAnimationFrame(() => resolve(performance.now() - t0)); }
        });
        mo.observe(document.body, { childList: true, subtree: true });
      });
    });
    await page.keyboard.press('Enter');
    const ms = await page.evaluate(() => window.__perfOpen);
    if (i > 0) opens.push(ms);
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await page.waitForTimeout(400);
  }
  numbers = { pan, zoom, openMs: round(median(opens)), opensMs: opens.map((v) => round(v)) };
} finally {
  await browser.close();
  stop();
}

// 3. Compare.
const result = {
  note: 'perf-pr.mjs: headless Chromium, software compositing, 1440x900, Light, harness office ?fixture=one; interaction from the e2e bundle, sizes from the release build. A ratio against the same machine, not a verdict on 60 fps.',
  commit: sh('git', ['rev-parse', '--short', 'HEAD']).trim(),
  jsGzKb: jsKb, cssGzKb: cssKb,
  pan: numbers.pan, zoom: numbers.zoom, openMs: numbers.openMs, opensMs: numbers.opensMs,
};
console.log(JSON.stringify(result, null, 2));
if (flag('update')) {
  writeFileSync(BASELINE, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${BASELINE}`);
  process.exit(overlayInRelease ? 1 : 0);
}
const fails = [];
if (overlayInRelease) fails.push(`the release bundle contains the dev overlay ("${OVERLAY_MARKER}")`);
if (jsKb * 1024 > MAX_JS_GZ) fails.push(`initial JS ${jsKb} KB gzip is over the ${MAX_JS_GZ / 1024} KB budget`);
if (!existsSync(BASELINE)) {
  console.error('perf-pr: no perf-baseline.json; run with --update from origin/main first. Only the absolute checks ran.');
} else {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  for (const k of ['pan', 'zoom']) {
    if (result[k].p5 < base[k].p5 * (1 - T.fpsP5)) fails.push(`${k} fps p5 ${result[k].p5} is more than ${T.fpsP5 * 100} % under the baseline's ${base[k].p5}`);
  }
  if (result.openMs > base.openMs * (1 + T.open) && result.openMs - base.openMs >= T.openMinMs) fails.push(`window open ${result.openMs} ms is more than ${T.open * 100} % over the baseline's ${base.openMs} ms`);
  if (result.jsGzKb > base.jsGzKb * (1 + T.js)) fails.push(`initial JS ${result.jsGzKb} KB is more than ${T.js * 100} % over the baseline's ${base.jsGzKb} KB`);
}
if (fails.length) { console.error('\nperf-pr FAILED:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('\nperf-pr passed');
