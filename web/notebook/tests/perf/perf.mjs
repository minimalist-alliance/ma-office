// Typing and scrolling on a long page, in headless Chromium, with real input (CDP keys and wheel).
//
//   node tests/perf/perf.mjs [--words 150000] [--pages 300] [--trials 3] [--dpr 1] [--port 5186]
//                            [--cps 25] [--seconds 14] [--label name] [--cv]
//
// Builds nothing: run `npx vite build` first (npm run perf does). Serves dist/ with `vite preview`.
// What it measures, per trial:
//   open     click on the tab to the long page painted, as a member switching to it (design B5)
//   typing   keystroke to the next frame after it (rAF, then a task: the frame has been produced),
//            for every key; Event Timing's duration for any over 16 ms; frame intervals and long
//            tasks during the typing. The store's 10 s ceiling falls inside the default 14 s run.
//   scroll   wheel ticks of 100 px each frame for 3 s down the page, then 3 s back: frame intervals
//   jump     End and Home keys: the frame time of a jump to the far end and back
//   list     the 300-page list scrolled by wheel: frame intervals
//   search   a three-word query over every page, in the backend
// --cv adds `content-visibility: auto` to the page's blocks (an experiment; needs bypassCSP).
//
// Honest limits: this is headless Chromium with software compositing on whatever machine runs it.
// On a shared box, other work moves the numbers; the load average is recorded with each run.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const WORDS = Number(arg('words', '150000'));
const PAGES = Number(arg('pages', '300'));
const TRIALS = Number(arg('trials', '3'));
const DPR = Number(arg('dpr', '1'));
const PORT = Number(arg('port', '5186'));
const CPS = Number(arg('cps', '25'));
const SECONDS = Number(arg('seconds', '14'));
const LABEL = arg('label', hostname());
const CV = process.argv.includes('--cv');
const BASE = `http://127.0.0.1:${PORT}`;

const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
const r1 = (v) => (Number.isFinite(v) ? Number(v.toFixed(1)) : null);
const frames = (intervals) => ({
  n: intervals.length,
  p50: r1(pct(intervals, 0.5)),
  p95: r1(pct(intervals, 0.95)),
  p99: r1(pct(intervals, 0.99)),
  max: r1(Math.max(...intervals)),
  // A frame interval over 1.5 vsyncs means at least one frame was missed.
  dropped: r1((100 * intervals.filter((x) => x > 25).length) / Math.max(1, intervals.length)),
  fps: r1(1000 / (intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length))),
});

// Runs in the page: a rAF loop that keeps frame intervals, and long tasks.
const PROBE = () => {
  const w = window;
  w.__probe = { on: false, last: 0, intervals: [], longtasks: [], keys: [], events: [] };
  const loop = (t) => {
    const p = w.__probe;
    if (p.on && p.last) p.intervals.push(t - p.last);
    p.last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (w.__probe.on) w.__probe.longtasks.push(e.duration);
  }).observe({ type: 'longtask', buffered: false });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (w.__probe.on && (e.name === 'keydown' || e.name === 'keypress' || e.name === 'beforeinput' || e.name === 'input')) w.__probe.events.push({ name: e.name, d: e.duration, id: e.interactionId });
  }).observe({ type: 'event', durationThreshold: 16, buffered: false });
  const ch = new MessageChannel();
  const pending = [];
  ch.port1.onmessage = () => {
    const t0 = pending.shift();
    if (t0 !== undefined && w.__probe.on) w.__probe.keys.push(performance.now() - t0);
  };
  document.addEventListener(
    'keydown',
    (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => {
        pending.push(t0);
        ch.port2.postMessage(0);
      });
    },
    true,
  );
};

async function waitIdle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
const start = (page) => page.evaluate(() => Object.assign(window.__probe, { on: true, last: 0, intervals: [], longtasks: [], keys: [], events: [] }));
const stop = (page) => page.evaluate(() => {
  const p = window.__probe;
  p.on = false;
  return { intervals: p.intervals, longtasks: p.longtasks, keys: p.keys, events: p.events };
});

async function trial(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR, bypassCSP: CV });
  const page = await ctx.newPage();
  await page.addInitScript(PROBE);
  const t0 = Date.now();
  await page.goto(`${BASE}/?fixture=long&fresh=1&words=${WORDS}&pages=${PAGES}&theme=light`);
  await page.locator('.nb-prose h1', { hasText: 'Long document' }).waitFor({ timeout: 120_000 });
  const firstLoad = Date.now() - t0;
  if (CV) await page.addStyleTag({ content: '.nb-prose > * { content-visibility: auto; contain-intrinsic-size: auto 3em; }' });
  await waitIdle(page);
  const out = { firstLoadMs: firstLoad };

  // open: switch away and back, three times.
  const opens = [];
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('tab', { name: 'Many pages' }).click();
    await page.locator('.nb-prose h1', { hasText: 'Page 1:' }).waitFor();
    await waitIdle(page);
    const ms = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Long page');
          const t = performance.now();
          tab.click();
          const check = () => {
            const h = document.querySelector('.nb-prose h1');
            if (h && h.textContent.startsWith('Long document')) requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t), 0));
            else requestAnimationFrame(check);
          };
          check();
        }),
    );
    opens.push(ms);
  }
  out.open = { p50: r1(pct(opens, 0.5)), max: r1(Math.max(...opens)), all: opens.map(r1) };
  await waitIdle(page);

  // typing: in a paragraph near the middle of the page.
  const words = await page.evaluate(() => document.querySelector('.nb-prose').textContent.split(/\s+/).length);
  out.words = words;
  const mid = page.locator('.nb-prose > p').nth(Math.floor((await page.locator('.nb-prose > p').count()) / 2));
  await mid.scrollIntoViewIfNeeded();
  await mid.click();
  await page.keyboard.press('End');
  await waitIdle(page);
  await start(page);
  const text = ' the quick brown fox jumps over the lazy dog';
  const n = Math.round(CPS * SECONDS);
  for (let i = 0; i < n; i += 1) await page.keyboard.type(text[i % text.length], { delay: 0 }).then(() => page.waitForTimeout(1000 / CPS));
  await page.waitForTimeout(300);
  const typing = await stop(page);
  out.typing = {
    keys: typing.keys.length,
    keyToFrame: { p50: r1(pct(typing.keys, 0.5)), p95: r1(pct(typing.keys, 0.95)), p99: r1(pct(typing.keys, 0.99)), max: r1(Math.max(...typing.keys)) },
    eventTimingOver16: typing.events.length,
    eventTimingMax: r1(Math.max(0, ...typing.events.map((e) => e.d))),
    frames: frames(typing.intervals),
    longtasks: { n: typing.longtasks.length, max: r1(Math.max(0, ...typing.longtasks)), total: r1(typing.longtasks.reduce((a, b) => a + b, 0)) },
  };

  // scroll: wheel, a tick a frame.
  await page.mouse.move(900, 500);
  await page.locator('.nb-scroll').first().evaluate((el) => {
    el.scrollTop = 0;
  });
  await waitIdle(page);
  await start(page);
  for (let i = 0; i < 180; i += 1) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(16);
  }
  for (let i = 0; i < 180; i += 1) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(200);
  const scroll = await stop(page);
  out.scroll = { frames: frames(scroll.intervals), longtasks: { n: scroll.longtasks.length, max: r1(Math.max(0, ...scroll.longtasks)) } };

  // jump: End and Home in the scroller (the editor keeps focus, so ctrl+End moves the caret too).
  const jumps = [];
  for (const key of ['Control+End', 'Control+Home', 'Control+End', 'Control+Home']) {
    await start(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    const j = await stop(page);
    jumps.push(Math.max(0, ...j.intervals));
  }
  out.jumpWorstFrame = { all: jumps.map(r1), max: r1(Math.max(...jumps)) };

  // list: the 300-page list.
  await page.getByRole('tab', { name: 'Many pages' }).click();
  await page.locator('.nb-prose h1', { hasText: 'Page 1:' }).waitFor();
  const list = page.locator('.nb-side').first();
  const box = await list.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await waitIdle(page);
  await start(page);
  for (let i = 0; i < 120; i += 1) {
    await page.mouse.wheel(0, i < 60 ? 120 : -120);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(200);
  out.list = { frames: frames((await stop(page)).intervals) };

  // search, in the backend: every page plus the long one.
  out.searchMs = await page.evaluate(async () => {
    const nb = window.__nb;
    const times = [];
    for (const q of ['dolor magna', 'quick brown fox', 'section 12 lorem', 'zzz nothing']) {
      const t = performance.now();
      await nb.search(q);
      times.push(performance.now() - t);
    }
    return times.map((x) => Number(x.toFixed(1)));
  });
  await ctx.close();
  return out;
}

// vite itself, not npx, so killing it stops the server (an npx wrapper leaves vite running).
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const load = { start: loadavg().map(r1) };
  const browser = await chromium.launch();
  const results = [];
  for (let t = 0; t < TRIALS; t += 1) {
    results.push(await trial(browser));
    console.error(`trial ${t + 1}/${TRIALS} done`);
  }
  const version = browser.version();
  await browser.close();
  load.end = loadavg().map(r1);
  const report = {
    label: LABEL,
    when: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model, threads: cpus().length, load },
    browser: `headless Chromium ${version}, software compositing`,
    config: { words: WORDS, pages: PAGES, dpr: DPR, cps: CPS, seconds: SECONDS, viewport: '1440x900', contentVisibility: CV },
    trials: results,
  };
  const dir = join('tests', 'perf', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.when.slice(0, 19).replace(/[:T]/g, '-')}-${LABEL}${CV ? '-cv' : ''}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`wrote ${file}`);
} finally {
  server.kill();
}
process.exit(process.exitCode ?? 0);
