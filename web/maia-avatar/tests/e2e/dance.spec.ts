// DANCE: the Party routine in Chromium, through createAvatar as an app uses her, on a clock driven by hand at exactly
// 60 frames a second. Each frame's ink is read off her canvas. A frame between two engine steps never draws her much
// thinner than the steps on either side: a blend of the transform across the pirouette's mirror would draw a sliver
// (about 6% of the steps' width in tests/unit/blend.test.ts, which proves the blend itself, the wink included). Her
// hair still blends across the mirror, so the frame at the first edge-on crossing is a little narrower than both
// steps: 82.7% of the narrower in Chromium, measured, with her transform held at the mirrored step.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { handClock } from './helpers.js';

type Handle = { state: string; stats: { frames: number; steps: number }; playRoutine(n: string): boolean; playScore(i: unknown): unknown; setStreamMode(on: boolean): void };
type Win = Window & { M: { createAvatar(c: HTMLCanvasElement, o?: object): Handle }; maia: Handle; __frame(ms: number): number; cspViolations: string[] };

async function open(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
  await handClock(page);
  await page.goto('/test.html');
  await page.evaluate(async (opts) => {
    const w = window as unknown as Win;
    w.M = await import('/lib/maia-avatar.js' as string);
    const box = document.createElement('div');
    box.style.cssText = 'position:relative;overflow:hidden;border-radius:50%;width:200px;height:200px;background:#4F5663';
    const c = document.createElement('canvas');
    c.id = 'maia';
    box.append(c);
    document.body.append(box);
    w.maia = w.M.createAvatar(c, { size: 200, theme: 'dusk', dpr: 1, ...opts });
  }, opts);
  await page.waitForTimeout(150); // the observer's first report, on real rendering
}

/** Runs n frames at 60 a second and returns, per frame, her state and her ink's width in canvas pixels. */
function frames(page: Page, n: number): Promise<{ state: string; width: number; drawn: number; stepped: number }[]> {
  return page.evaluate((n) => {
    const w = window as unknown as Win;
    const c = document.getElementById('maia') as HTMLCanvasElement, g = c.getContext('2d')!;
    const out: { state: string; width: number; drawn: number; stepped: number }[] = [];
    for (let i = 0; i < n; i += 1) {
      const before = w.maia.stats.frames, steps = w.maia.stats.steps;
      w.__frame(1000 / 60);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lo = c.width, hi = -1;
      for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) if (d[(y * c.width + x) * 4 + 3]! > 24) { if (x < lo) lo = x; if (x > hi) hi = x; }
      out.push({ state: w.maia.state, width: hi - lo + 1, drawn: w.maia.stats.frames - before, stepped: w.maia.stats.steps - steps });
    }
    return out;
  }, n);
}

test('she dances Party once at 60 frames a second, never drawn thinner between steps than at them, then settles', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await open(page);
  const rest = await frames(page, 30);
  expect(await page.evaluate(() => (window as unknown as Win).maia.playRoutine('party'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Win).maia.playRoutine('groove'))).toBe(false);
  const run = await frames(page, Math.round(26 * 60));
  const dancing = run.filter((f) => f.state === 'routine').length;
  // 23.2 s of dance, give or take a frame at either end.
  expect(Math.abs(dancing / 60 - 48 * 60 / 124)).toBeLessThan(0.05);
  expect(run.at(-1)!.state).toBe('score');
  // Every display frame is drawn: 60 a second, not 30.
  expect(run.slice(0, 1380).every((f) => f.drawn === 1)).toBe(true);
  const w0 = rest.at(-1)!.width;
  let worst = Infinity, narrowest = Infinity, at = 0;
  for (let i = 1; i < run.length - 1; i += 1) {
    const r = run[i]!.width / Math.min(run[i - 1]!.width, run[i + 1]!.width);
    if (r < worst) { worst = r; at = i; }
    narrowest = Math.min(narrowest, run[i]!.width / w0);
  }
  console.log(`narrowest against its neighbours at frame ${at}: ${run.slice(at - 4, at + 5).map((f) => `${f.width}${f.stepped ? ' (step)' : ''}`).join(', ')}`);
  console.log(`at rest ${w0} px wide; narrowest frame ${(narrowest * 100).toFixed(1)}% of that; no frame under ${(worst * 100).toFixed(1)}% of the narrower of its neighbours`);
  expect(worst).toBeGreaterThan(0.7);
  expect(narrowest).toBeGreaterThan(0.3);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as Win).cspViolations)).toEqual([]);
});

test('a score with "routine": "party" dances it first', async ({ page }) => {
  await open(page);
  await frames(page, 10);
  const parsed = await page.evaluate(() => (window as unknown as Win).maia.playScore({ v: 1, mood: 'bright', rhythm: 'lively', seconds: 24, beats: [], routine: 'party' }));
  expect(parsed).toMatchObject({ mood: 'bright', routine: 'party' });
  const run = await frames(page, 60);
  expect(run.filter((f) => f.state === 'routine').length).toBeGreaterThan(55);
});

test('with less motion, or during a desk stream, she smiles instead of dancing', async ({ page }) => {
  await open(page, { reducedMotion: true });
  await frames(page, 10);
  expect(await page.evaluate(() => (window as unknown as Win).maia.playRoutine('party'))).toBe(true);
  expect((await frames(page, 120)).some((f) => f.state === 'routine')).toBe(false);
  await page.evaluate(() => { const m = (window as unknown as Win).maia; m.playScore({ v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [] }); });

  const other = await page.context().newPage();
  await open(other);
  await other.evaluate(() => (window as unknown as Win).maia.setStreamMode(true));
  await frames(other, 10);
  await other.evaluate(() => (window as unknown as Win).maia.playRoutine('party'));
  const run = await frames(other, 120);
  expect(run.some((f) => f.state === 'routine')).toBe(false);
  // 15 frames a second during a stream, as before.
  const drawn = run.reduce((s, f) => s + f.drawn, 0);
  expect(drawn).toBeGreaterThanOrEqual(29);
  expect(drawn).toBeLessThanOrEqual(31);
});

test('the demo dances under the strict CSP with no console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#dance-play').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { maiaDemo: { dancers: { avatar: Handle }[] } }).maiaDemo.dancers.map((d) => d.avatar.state).join())).toBe('routine,routine');
  await page.locator('#dance-reduced').check();
  await page.locator('#dance-play').click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { maiaDemo: { dancers: { avatar: Handle }[] } }).maiaDemo.dancers.some((d) => d.avatar.state === 'routine'))).toBe(false);
  expect(errors).toEqual([]);
});

test('with no name she dances the one routine she knows', async ({ page }) => {
  await open(page);
  await frames(page, 10);
  expect(await page.evaluate(() => (window as unknown as { maia: { playRoutine(n?: string): boolean } }).maia.playRoutine())).toBe(true);
  expect((await frames(page, 30)).some((f) => f.state === 'routine')).toBe(true);
});
