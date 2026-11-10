// Shared by the perf, screenshot and recording scripts: the stand-in server, members, and a few
// drawing moves made with real input.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const here = import.meta.dirname;
export const PORT = Number(process.env.MA_CM_PORT ?? 5192);
export const BASE = `http://127.0.0.1:${PORT}`;
const BIN = process.env.COMMONS_SERVER ?? resolve(here, '../../../server/bin/commons-server');

export async function startServer(extra = []) {
  const data = mkdtempSync(pathJoin(tmpdir(), 'commons-perf-'));
  const proc = spawn(BIN, ['-dev', '-addr', `127.0.0.1:${PORT}`, '-udp', `127.0.0.1:${PORT + 1}`, '-web', resolve(here, '../../dist'), '-data', data, ...extra], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {
      // starting
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    async stop() {
      const done = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await done;
      rmSync(data, { recursive: true, force: true });
    },
  };
}

export async function launch() {
  return chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
}

export async function member(browser, name, { theme = 'light', width = 1280, height = 800, dpr = 1, video, query = '' } = {}) {
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width, height },
    deviceScaleFactor: dpr,
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`${name}: ${e}`));
  await page.goto(`${BASE}/?name=${encodeURIComponent(name)}&theme=${theme}${query}`);
  await page.locator('.ma-cm-btn-join').waitFor();
  await page.waitForFunction(() => !document.querySelector('.ma-cm-btn-join')?.hasAttribute('disabled'));
  return { ctx, page, name };
}

export async function join(m) {
  await m.page.locator('.ma-cm-btn-join').click();
  await m.page.locator('.ma-cm-btn-leave').waitFor();
  await m.page.locator('.ma-cm-board').focus();
}

/** The board's top-left on the page, so moves are in board-window coordinates. */
async function origin(m) {
  const b = await m.page.locator('.ma-cm-board').boundingBox();
  return { x: b.x, y: b.y };
}

export async function tool(m, key) {
  await m.page.locator('.ma-cm-board').focus();
  await m.page.keyboard.press(key);
}

export async function color(m, label) {
  const button = m.page.locator('.ma-cm-stylewrap > .ma-cm-icon');
  await button.click();
  await m.page.getByRole('radio', { name: label, exact: true }).click();
  await button.click();
}

/** A pen stroke through points (window-relative), steps per segment. */
export async function stroke(m, pts, steps = 3) {
  const o = await origin(m);
  await m.page.mouse.move(o.x + pts[0][0], o.y + pts[0][1]);
  await m.page.mouse.down();
  for (const [x, y] of pts.slice(1)) await m.page.mouse.move(o.x + x, o.y + y, { steps });
  await m.page.mouse.up();
}

export async function drag(m, x0, y0, x1, y1, steps = 12) {
  const o = await origin(m);
  await m.page.mouse.move(o.x + x0, o.y + y0);
  await m.page.mouse.down();
  await m.page.mouse.move(o.x + x1, o.y + y1, { steps });
  await m.page.mouse.up();
}

export async function click(m, x, y) {
  const o = await origin(m);
  await m.page.mouse.click(o.x + x, o.y + y);
}

export async function hover(m, x, y, steps = 10) {
  const o = await origin(m);
  await m.page.mouse.move(o.x + x, o.y + y, { steps });
}

export function circle(cx, cy, r, n = 24, from = 0, to = Math.PI * 2) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

export async function note(m, x, y, text) {
  await tool(m, 'n');
  await click(m, x, y);
  await m.page.locator('.ma-cm-editor').waitFor();
  await m.page.keyboard.type(text, { delay: 40 });
  await m.page.keyboard.press('Escape');
}

export async function text(m, x, y, t) {
  await tool(m, 't');
  await click(m, x, y);
  await m.page.locator('.ma-cm-editor').waitFor();
  await m.page.keyboard.type(t, { delay: 35 });
  await m.page.keyboard.press('Escape');
}

/** A small sketch: a sun, a hill line, a house, used by the screenshots and the recording. */
export async function sketch(m, dx = 0, dy = 0) {
  await tool(m, 'p');
  await color(m, 'Amber');
  await stroke(m, circle(140 + dx, 150 + dy, 34, 28), 2);
  await color(m, 'Ink');
  await stroke(m, [[60 + dx, 330 + dy], [140 + dx, 290 + dy], [230 + dx, 310 + dy], [330 + dx, 270 + dy], [420 + dx, 300 + dy]], 6);
  await stroke(m, [[240 + dx, 260 + dy], [240 + dx, 200 + dy], [280 + dx, 165 + dy], [320 + dx, 200 + dy], [320 + dx, 260 + dy]], 6);
}
