// What the centred glyph costs at the farthest zoom (`card`, under 20 px a cell), where a larger tile was a plain card before.
// Nine desks, each with an open, a large, a wide and a medium tile and two icons, seen whole at 20 to 25 %: the bitmaps held,
// the draw that rasters every tile again at a new scale (a zoom's settle), and a pan's draws. Run against this branch and
// against `origin/main`'s e2e bundle on a clear box; the numbers are in the status doc. Skipped unless TILE_CARD_PERF names
// the JSON file to write:
//   TILE_CARD_PERF=/abs/out.json MA_PW_PORT=5101 npx playwright test --project=shell tilefaces.perf --workers=1
// TILE_CARD_CPU=4 slows the page's CPU four times (Chromium's throttling) once the office has painted. `deskSettleMs` is a whole
// desk's redraw: the first desk filling the screen near 100 %, the one draw after a zoom settles at each of five new scales.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn } from './helpers';

const OUT = process.env['TILE_CARD_PERF'] ?? '';
const CPU = Number(process.env['TILE_CARD_CPU'] ?? 1);
const BIBLE = 'com.minimalistalliance.bible';

test.skip(!OUT, 'TILE_CARD_PERF names the file for the numbers');
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
test.setTimeout(300_000);

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const ids = Array.from({ length: 9 }, (_, n) => `d-perf0000000${n}0`.slice(0, 15));
type Hook = { __maDesk: { spriteCount(): number; spriteBytes?: () => number; camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void; getStage(): unknown } } };

const APPS = ['files', 'browser', 'notebook', 'courier', 'agent', `app:${BIBLE}`];
/** Each desk puts a different app in each spot, so every size holds every app somewhere: the most bitmaps the glyph can add. */
function desk(id: string, n: number): { x: number; y: number; w: number; h: number; items: { id: string; app: string; x: number; y: number; w: number; h: number }[] } {
  // The second column starts past a 7 x 5 open tile, the Browser's, whichever app is open.
  const c2 = 24 + span(7) + 16;
  const items = [
    { x: 24, y: 24, w: span(6), h: span(5) },
    { x: c2, y: 24, w: span(4), h: span(4) },
    { x: 24, y: 24 + span(5) + 16, w: span(4), h: span(2) },
    { x: 24 + span(4) + 16, y: 24 + span(5) + 16, w: span(2), h: span(2) },
    { x: c2, y: 24 + span(4) + 16, w: 76, h: 76 },
    { x: c2 + 92, y: 24 + span(4) + 16, w: 76, h: 76 },
  ].map((r, k) => {
    const app = APPS[(k + n) % APPS.length]!;
    return { id: `${id}:${app}`, app, ...r, w: app === 'browser' && k === 0 ? span(7) : r.w };
  });
  const w = 24 + span(7) + 16 + span(4) + 24;
  const h = 24 + span(5) + 16 + span(2) + 60;
  return { x: (n % 3) * (w + 120), y: Math.floor(n / 3) * (h + 120), w, h, items };
}
const DESKS = Object.fromEntries(ids.map((id, n) => [id, desk(id, n)]));

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

test('the farthest zoom: bitmaps, a settle\'s raster and a pan\'s draws', async ({ page, request }) => {
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 60_000, preinstalled: Object.fromEntries(ids.map((d) => [d, [BIBLE]])), tamper: {} });
  await setTheme(page, 'light');
  await harness(request, { reset: true });
  await harness(request, {
    fleet: ids.map((deskId, n) => ({ deskId, name: `Desk ${n + 1}`, kind: n === 0 ? 'personal' : 'work', state: 'running' })),
    files: { enabled: true },
    appFrames: true,
    layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks: DESKS, z: ids } } },
  });
  await signIn(page, '/?widgets=none');
  await canvasPainted(page);
  await page.waitForTimeout(800);
  await focusCanvas(page);
  await page.keyboard.press('0');
  await settled(page);
  if (CPU > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: CPU });
  // Every draw of the canvas's layer, timed.
  await page.evaluate(() => {
    const w = window as unknown as { __draws: number[] } & Hook;
    w.__draws = [];
    const layer = (w.__maDesk.camera.getStage() as { getLayers(): { drawScene(...a: unknown[]): unknown }[] }).getLayers()[0]!;
    const own = layer.drawScene.bind(layer);
    layer.drawScene = (...a: unknown[]) => {
      const t0 = performance.now();
      const r = own(...a);
      w.__draws.push(performance.now() - t0);
      return r;
    };
  });
  const take = (): Promise<number[]> => page.evaluate(() => {
    const w = window as unknown as { __draws: number[] };
    const d = w.__draws;
    w.__draws = [];
    return d;
  });
  const look = (s: number, dx = 0): Promise<void> => page.evaluate(({ s, dx }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: 40 + dx, y: 100 }), { s, dx });

  // A settle at a new scale rasters every tile's bitmap again: ten scales, each new.
  const settles: number[] = [];
  for (let k = 0; k < 10; k += 1) {
    await look(0.25 - k * 0.005);
    await settled(page);
    const d = await take();
    settles.push(Math.max(...d));
  }
  const sprites = await page.evaluate(() => (window as unknown as Hook).__maDesk.spriteCount());
  const mb = (): Promise<number | null> => page.evaluate(() => {
    const b = (window as unknown as Hook).__maDesk.spriteBytes?.();
    return b === undefined ? null : Math.round(b / 10_000) / 100;
  });
  const cardMb = await mb();
  // A pan at 22 %: 120 frames, nothing rastered.
  await take();
  await page.evaluate(async () => {
    const c = (window as unknown as Hook).__maDesk.camera;
    for (let f = 0; f < 120; f += 1) {
      c.set({ s: 0.22, x: 40 - f * 2, y: 100 });
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const pan = (await take()).sort((a, b) => a - b);
  await settled(page);
  const lod = await page.evaluate(() => 76 * 0.22 < 20);
  // Close in on the first desk's open tile: its settles at five new scales from 175 %, and at the most zoom, 300 %; the
  // bitmaps held, which are largest there.
  const near = async (s: number): Promise<number> => {
    const d = DESKS[ids[0]!]!;
    const i = d.items[0]!;
    await page.evaluate(({ s, x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: 720 - x * s, y: 450 - y * s }), { s, x: d.x + i.x + i.w / 2, y: d.y + i.y + i.h / 2 });
    await settled(page);
    return Math.max(0, ...(await take()));
  };
  await take();
  const close: number[] = [];
  for (const s of [1.75, 1.7, 1.65, 1.6, 1.55]) close.push(await near(s));
  const closeMb = await mb();
  const most = await near(3);
  const mostMb = await mb();
  // A whole desk: the first one filling the screen, the draw after each of five new scales near 100 %.
  const whole = async (s: number): Promise<number> => {
    const d = DESKS[ids[0]!]!;
    await page.evaluate(({ s, x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: 720 - x * s, y: 450 - y * s }), { s, x: d.x + d.w / 2, y: d.y + d.h / 2 });
    await settled(page);
    return Math.max(0, ...(await take()));
  };
  await take();
  const desk: number[] = [];
  for (const s of [1.2, 1.18, 1.16, 1.14, 1.12]) desk.push(await whole(s));
  const sorted = [...settles].sort((a, b) => a - b);
  const q = (xs: number[], p: number): number => Math.round(xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]! * 100) / 100;
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  writeFileSync(OUT, JSON.stringify({ cpu: CPU, deskSettleMs: desk.map(r2), card: lod, sprites, cardMb, closeSettleMs: close.map(r2), closeMb, mostSettleMs: r2(most), mostMb, settleMs: { median: q(sorted, 0.5), max: q(sorted, 0.99), all: settles.map((x) => Math.round(x * 100) / 100) }, panMs: { frames: pan.length, median: q(pan, 0.5), p95: q(pan, 0.95) } }, null, 1));
});
