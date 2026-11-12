// A screen recording of the demo: Playwright's own video of headless Chromium, a short tour of
// typing, formatting, binder tabs, search, history, the Temporal view and the three themes.
//
//   node tests/perf/record.mjs [--out media] [--port 5187]
//
// Writes <out>/notebook-demo.mp4: Playwright's VP8 video re-encoded to H.264 (plays anywhere, as
// web/agent's does), with metadata, chapters and the muxer's tags dropped (-map_metadata -1,
// -fflags +bitexact). Then prints what ffprobe still finds, to check. The raw video is kept in
// recording/ (ignored by git). Builds nothing: run `npx vite build` first (npm run record does).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const OUT = resolve(arg('out', 'media'));
const PORT = Number(arg('port', '5187'));
const BASE = `http://127.0.0.1:${PORT}`;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// vite itself, not npx, so killing it stops the server (an npx wrapper leaves vite running).
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const raw = resolve('recording');
try {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  rmSync(raw, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const browser = await chromium.launch();
  const size = { width: 1280, height: 800 };
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: raw, size } });
  const page = await ctx.newPage();
  const pause = (ms) => page.waitForTimeout(ms);
  const say = async (text, ms = 45) => page.keyboard.type(text, { delay: ms });

  await page.goto(`${BASE}/?fresh=1&theme=light`);
  await page.getByTestId('note-editor').waitFor();
  await pause(1200);

  // A new page: title, body with bold and highlight, a checklist.
  await page.getByTestId('new-page').click();
  await pause(300);
  await say('Saturday errands');
  await page.keyboard.press('Enter');
  await say('Pick up the ');
  await page.keyboard.press(`${MOD}+b`);
  await say('bike');
  await page.keyboard.press(`${MOD}+b`);
  await say(' from the shop, then ');
  await page.keyboard.press(`${MOD}+Shift+h`);
  await say('call about the gutter');
  await page.keyboard.press(`${MOD}+Shift+h`);
  await say('.');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Shift+l`);
  await say('Library books');
  await page.keyboard.press('Enter');
  await say('Farmers market');
  await page.keyboard.press('Enter');
  await say('Recycling');
  await pause(300);
  await page.locator('.nb-prose li[data-checked] input').first().click();
  await pause(900);

  // Binder tabs, and paging on across a tab boundary.
  await page.getByRole('tab', { name: 'Recipes' }).click();
  await pause(900);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await pause(700);
  await page.getByRole('button', { name: 'Previous page' }).click();
  await pause(900);

  // Search.
  await page.getByTestId('note-editor').click();
  await page.keyboard.press(`${MOD}+k`);
  await pause(300);
  await say('lake', 90);
  await pause(800);
  await page.keyboard.press('Enter');
  await pause(900);

  // History: an older version, then back.
  await page.getByRole('button', { name: 'History' }).click();
  await pause(700);
  await page.locator('.nb-history-item').last().click();
  await pause(1100);
  await page.getByRole('button', { name: 'Back to the page' }).click();
  await pause(500);

  // Temporal view, and a day back.
  await page.getByRole('radio', { name: 'By day' }).click();
  await pause(1000);
  await page.getByRole('button', { name: 'Previous day with notes' }).click();
  await pause(700);
  await page.getByRole('button', { name: 'Previous day with notes' }).click();
  await pause(900);

  // Zen and Dark.
  await page.getByRole('radio', { name: 'Zen' }).click();
  await pause(1100);
  await page.getByRole('radio', { name: 'By tab' }).click();
  await pause(1000);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await pause(1100);
  await page.getByRole('tab', { name: 'Trips' }).click();
  await pause(1200);

  await ctx.close();
  await browser.close();

  const file = readdirSync(raw).find((f) => f.endsWith('.webm'));
  if (!file) throw new Error('no video was written');
  mkdirSync(OUT, { recursive: true });
  const clean = join(OUT, 'notebook-demo.mp4');
  rmSync(clean, { force: true });
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', join(raw, file),
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-threads', '4', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-an',
    '-movflags', '+faststart', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    clean,
  ]);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags:format=duration,size', '-of', 'json', clean]).toString();
  console.log(probe);
  console.log(`${clean}: ${(statSync(clean).size / 1e6).toFixed(2)} MB`);
} finally {
  server.kill();
}
process.exit(process.exitCode ?? 0);
