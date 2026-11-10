// Where a keystroke's time goes on the long page: a CPU profile and a timeline trace of typing,
// summed by function and by trace event. For finding a hot spot, not for the numbers in STATUS.md.
//
//   node tests/perf/profile.mjs [--words 150000] [--keys 60] [--port 5188] [--cv]
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const WORDS = Number(arg('words', '150000'));
const KEYS = Number(arg('keys', '60'));
const PORT = Number(arg('port', '5188'));
const CV = process.argv.includes('--cv');
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: CV });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?fixture=long&fresh=1&words=${WORDS}&pages=10&theme=light`);
  await page.locator('.nb-prose h1', { hasText: 'Long document' }).waitFor({ timeout: 120_000 });
  if (CV) await page.addStyleTag({ content: '.nb-prose > * { content-visibility: auto; contain-intrinsic-size: auto 3em; }' });
  const mid = page.locator('.nb-prose > p').nth(Math.floor((await page.locator('.nb-prose > p').count()) / 2));
  await mid.scrollIntoViewIfNeeded();
  await mid.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(500);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const traced = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  await cdp.send('Profiler.start');
  for (let i = 0; i < KEYS; i += 1) {
    await page.keyboard.type('x');
    await page.waitForTimeout(60);
  }
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Tracing.end');
  await traced;

  // Self time by function, from the sample counts.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples.length);
  for (const s of profile.samples) {
    const n = byId.get(s);
    const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`JS self time over ${KEYS} keys (ms, total ${((profile.endTime - profile.startTime) / 1000).toFixed(0)} ms of wall time):`);
  for (const [k, v] of top) console.log(`${(v / KEYS).toFixed(2).padStart(7)} ms/key  ${k}`);

  // Main-thread trace events by name (complete events on the renderer main thread).
  const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
  const sums = new Map();
  for (const e of events) {
    if (!main || e.tid !== main.tid || e.ph !== 'X' || !e.dur) continue;
    sums.set(e.name, (sums.get(e.name) ?? 0) + e.dur / 1000);
  }
  console.log('\nMain-thread trace events (ms per key, inclusive):');
  for (const [k, v] of [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`${(v / KEYS).toFixed(2).padStart(7)}  ${k}`);
  await browser.close();
} finally {
  server.kill();
}
process.exit(process.exitCode ?? 0);
