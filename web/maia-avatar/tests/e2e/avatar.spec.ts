// The package in Chromium: a clear canvas, sleep at 5 minutes, and no frames while she's asleep, hidden or still.
// Timing tests use Playwright's fake clock, which also drives requestAnimationFrame (every 16 ms) and performance.now.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { countFrames, loadReference, openTestPage } from './helpers.js';

type Handle = {
  state: string; paused: boolean; stats: { frames: number; steps: number };
  setState(s: string): void; playScore(i: unknown): unknown; wake(): void; pause(): void; resume(): void;
  setTheme(t: string): void; setStreamMode(on: boolean): void; destroy(): void;
};
type Win = Window & { M: { createAvatar(c: HTMLCanvasElement, o?: object): Handle; defineMaiaAvatar(): void }; maia: Handle; rafCalls: number; cspViolations: string[] };

/** A bubble with her canvas, as an app holds her, and her handle on window.maia. */
async function addMaia(page: Page, opts: Record<string, unknown> = {}, css = ''): Promise<void> {
  await page.evaluate(({ opts, css }) => {
    const w = window as unknown as Win;
    const box = document.createElement('div');
    box.id = 'bubble';
    box.style.cssText = `position:relative;overflow:hidden;border-radius:50%;width:${opts['size'] ?? 64}px;height:${opts['size'] ?? 64}px;${css}`;
    const c = document.createElement('canvas');
    c.id = 'maia';
    box.append(c);
    document.body.append(box);
    w.maia = w.M.createAvatar(c, { size: 64, theme: 'light', ...opts });
  }, { opts, css });
  await rendered(page);
}

/** IntersectionObserver reports on the browser's real rendering, which the fake clock doesn't drive. */
const rendered = (page: Page) => page.waitForTimeout(100);

const stats = (page: Page) => page.evaluate(() => {
  const m = (window as unknown as Win).maia;
  return { state: m.state, frames: m.stats.frames, steps: m.stats.steps, raf: (window as unknown as Win).rafCalls };
});

/** Fake time from the start, standing still until a test moves it. */
async function fakeClock(page: Page): Promise<void> {
  await page.clock.install({ time: 0 });
  await countFrames(page);
  await page.goto('/test.html');
  await page.clock.pauseAt(1000);
  await page.evaluate(async () => { (window as unknown as { M: unknown }).M = await import('/lib/maia-avatar.js' as string); });
}

test("her canvas is clear before she's drawn: whatever was on it doesn't show, and nothing is drawn behind her", async ({ page }) => {
  await openTestPage(page);
  const r = await page.evaluate(() => {
    const w = window as unknown as Win;
    const make = (dirty: boolean) => {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 128;
      if (dirty) { const x = c.getContext('2d')!; x.fillStyle = '#FF00FF'; x.fillRect(0, 0, 128, 128); }
      const box = document.createElement('div');
      box.style.cssText = 'position:relative;width:64px;height:64px';
      box.append(c);
      document.body.append(box);
      w.M.createAvatar(c, { size: 64, theme: 'dusk', dpr: 1 }); // her first frame is drawn here, synchronously
      return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    };
    const dirty = make(true), clean = make(false);
    let same = dirty.length === clean.length, magenta = 0, outside = 0, opaque = 0;
    const W = 128, R = W / 2;
    for (let i = 0; i < clean.length; i += 4) {
      if (dirty[i] !== clean[i] || dirty[i + 1] !== clean[i + 1] || dirty[i + 2] !== clean[i + 2] || dirty[i + 3] !== clean[i + 3]) same = false;
      if (dirty[i] === 255 && dirty[i + 1] === 0 && dirty[i + 2] === 255) magenta += 1;
      const p = i / 4, x = (p % W) + 0.5 - R, y = Math.floor(p / W) + 0.5 - R;
      if (x * x + y * y > R * R && clean[i + 3]! > 0) outside += 1; // anything outside the bubble's circle
      if (clean[i + 3] === 255) opaque += 1;
    }
    return { same, magenta, outside, opaque, corner: [...clean.slice(0, 4)] };
  });
  expect(r.same).toBe(true);
  expect(r.magenta).toBe(0);
  expect(r.outside).toBe(0);
  expect(r.corner).toEqual([0, 0, 0, 0]);
  expect(r.opaque).toBeGreaterThan(1000); // and she is there
});

test('draws up to 60 frames a second from 30 engine steps, and 15 during a desk stream', async ({ page }) => {
  await fakeClock(page);
  await addMaia(page);
  await page.clock.runFor(500); // the observer reports her on screen and the loop starts
  const a = await stats(page);
  await page.clock.runFor(2000);
  const b = await stats(page);
  expect(b.steps - a.steps).toBeGreaterThanOrEqual(59);
  expect(b.steps - a.steps).toBeLessThanOrEqual(61);
  expect(b.frames - a.frames).toBeGreaterThanOrEqual(118);
  expect(b.frames - a.frames).toBeLessThanOrEqual(126);
  await page.evaluate(() => (window as unknown as Win).maia.setStreamMode(true));
  const c = await stats(page);
  await page.clock.runFor(2000);
  const d = await stats(page);
  expect(d.steps - c.steps).toBeGreaterThanOrEqual(59);
  expect(d.frames - c.frames).toBeGreaterThanOrEqual(29);
  expect(d.frames - c.frames).toBeLessThanOrEqual(31);
});

test('falls asleep at 5 minutes without use, breathes from the strip, and asks for no frames asleep', async ({ page }) => {
  await fakeClock(page);
  await addMaia(page); // the default sleepAfterMs
  await page.clock.runFor(1000);
  expect((await stats(page)).state).toBe('score');
  // Use at 1 minute starts the wait again, so she's still awake at 5 minutes and asleep at 6.
  await page.clock.fastForward(59_000);
  await page.evaluate(() => (window as unknown as Win).maia.wake());
  await page.clock.fastForward(4 * 60_000 - 1_000);
  await page.clock.runFor(1000); // 5:00 since she was made, 4:00 since she was used
  expect((await stats(page)).state).toBe('score');
  await page.clock.fastForward(58_000);
  await page.clock.runFor(1000); // 5:59 since use
  expect((await stats(page)).state).toBe('score');
  await page.clock.runFor(1500); // 6:00.5 since use
  expect((await stats(page)).state).toBe('falling');
  await page.clock.runFor(5000); // the fall takes 4 s
  const asleep = await stats(page);
  expect(asleep.state).toBe('sleeping');
  const strip = await page.evaluate(() => {
    const c = document.getElementById('maia')!;
    const s = c.nextElementSibling as HTMLElement | null;
    const el = s?.firstElementChild as HTMLCanvasElement | null;
    const anim = el?.getAnimations()[0];
    return { canvasHidden: getComputedStyle(c).visibility === 'hidden', strip: !!el, playing: anim?.playState, frames: el ? el.width / 64 : 0 /* the strip's cells are size x dpr */ };
  });
  expect(strip).toEqual({ canvasHidden: true, strip: true, playing: 'running', frames: 36 });
  // A minute asleep: not one animation frame asked for, nothing drawn, no engine step.
  await page.clock.runFor(60_000);
  const later = await stats(page);
  expect(later.raf).toBe(asleep.raf);
  expect(later.frames).toBe(asleep.frames);
  expect(later.steps).toBe(asleep.steps);
  // Use wakes her, live again.
  await page.evaluate(() => (window as unknown as Win).maia.wake());
  await page.clock.runFor(100);
  const woke = await stats(page);
  expect(woke.state).toBe('waking');
  expect(woke.frames).toBeGreaterThan(later.frames);
  expect(await page.evaluate(() => document.getElementById('maia')!.nextElementSibling)).toBeNull();
});

test('the sleep clock stands still while she thinks or speaks, and runs again from the reply', async ({ page }) => {
  await fakeClock(page);
  await addMaia(page, { sleepAfterMs: 60_000 });
  await page.clock.runFor(500);
  await page.evaluate(() => (window as unknown as Win).maia.setState('thinking'));
  await page.clock.fastForward(5 * 60_000);
  await page.clock.runFor(500);
  expect((await stats(page)).state).toBe('thinking');
  await page.evaluate(() => (window as unknown as Win).maia.playScore({ v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [] }));
  await page.clock.fastForward(58_000);
  await page.clock.runFor(1000);
  expect((await stats(page)).state).toBe('score');
  await page.clock.runFor(1500);
  expect((await stats(page)).state).toBe('falling');
});

test('no frames while she is off screen, hidden by display: none, or in a hidden tab', async ({ page }) => {
  await fakeClock(page);
  await addMaia(page, {}, 'margin-top:3000px');
  await page.clock.runFor(1000);
  const off = await stats(page);
  await page.clock.runFor(2000);
  expect((await stats(page)).raf).toBe(off.raf);
  expect((await stats(page)).frames).toBe(off.frames);

  await page.evaluate(() => document.getElementById('bubble')!.scrollIntoView());
  await rendered(page);
  await page.clock.runFor(1000);
  const on = await stats(page);
  expect(on.frames).toBeGreaterThan(off.frames + 30);

  await page.evaluate(() => { document.getElementById('bubble')!.style.display = 'none'; });
  await rendered(page);
  await page.clock.runFor(1000);
  const none = await stats(page);
  await page.clock.runFor(2000);
  expect((await stats(page)).frames).toBe(none.frames);
  expect((await stats(page)).raf).toBe(none.raf);
  await page.evaluate(() => { document.getElementById('bubble')!.style.display = 'block'; });
  await page.evaluate(() => document.getElementById('bubble')!.scrollIntoView()); // display: none shortened the page
  await rendered(page);
  await page.clock.runFor(1000);
  expect((await stats(page)).frames).toBeGreaterThan(none.frames + 30);

  // Headless Chromium never hides its tab, so the test says it's hidden the way the browser would.
  const setHidden = (hidden: boolean) => page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  const hidden = await stats(page);
  await page.clock.runFor(3000);
  expect((await stats(page)).frames).toBe(hidden.frames);
  expect((await stats(page)).raf).toBeLessThanOrEqual(hidden.raf + 1);
  await setHidden(false);
  await page.clock.runFor(1000);
  expect((await stats(page)).frames).toBeGreaterThan(hidden.frames + 30);
});

test('asleep while nobody can see her: she is simply asleep when they look again', async ({ page }) => {
  await fakeClock(page);
  await addMaia(page, { sleepAfterMs: 10_000 }, 'margin-top:3000px');
  await page.clock.runFor(12_000);
  expect((await stats(page)).state).toBe('sleeping');
  await page.evaluate(() => document.getElementById('bubble')!.scrollIntoView());
  await rendered(page);
  await page.clock.runFor(500);
  expect(await page.evaluate(() => !!document.getElementById('maia')!.nextElementSibling)).toBe(true);
});

test('paused: no frames, and what shows is her rest pose, the reference engine still', async ({ page }) => {
  await fakeClock(page);
  await loadReference(page);
  await addMaia(page, { theme: 'dark', dpr: 1 });
  await page.clock.runFor(2000);
  await page.evaluate(() => (window as unknown as Win).maia.pause());
  const p = await stats(page);
  await page.clock.runFor(3000);
  expect(await stats(page)).toEqual(p);
  const same = await page.evaluate(() => {
    const read = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const ref = document.createElement('canvas');
    (window as unknown as { MaiaEngine: { createAvatar(c: HTMLCanvasElement, o: object): { drawStill(): void } } }).MaiaEngine.createAvatar(ref, { size: 64, dpr: 1, theme: 'dark' }).drawStill();
    const a = read(document.getElementById('maia') as HTMLCanvasElement), b = read(ref);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  });
  expect(same).toBe(true);
  await page.evaluate(() => (window as unknown as Win).maia.resume());
  await page.clock.runFor(1000);
  expect((await stats(page)).frames).toBeGreaterThan(p.frames + 30);
});

test('reduced motion: hair and body stay at rest, frames stop once her eyes settle, and she sleeps without the strip', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fakeClock(page);
  await loadReference(page);
  await addMaia(page, { theme: 'light', dpr: 1, sleepAfterMs: 20_000 });
  await page.clock.runFor(3000);
  const settled = await stats(page);
  await page.clock.runFor(3000);
  expect((await stats(page)).frames).toBe(settled.frames);
  expect((await stats(page)).raf).toBe(settled.raf);
  // Hair and body at rest: the body and hair pixels are the reference's still; only the eyes may differ.
  const bodySame = await page.evaluate(() => {
    const engine = (window as unknown as { MaiaEngine: { createAvatar(c: HTMLCanvasElement, o: object): { drawStill(): void; paint(ctx: CanvasRenderingContext2D, g: CanvasGradient, w: number, o: object): void; grad: CanvasGradient; m: Float64Array } } }).MaiaEngine;
    const ref = document.createElement('canvas');
    const r = engine.createAvatar(ref, { size: 64, dpr: 1, theme: 'light' });
    r.drawStill();
    const live = document.getElementById('maia') as HTMLCanvasElement;
    // Compare only her silhouette's outline: every pixel's alpha, which hair and body decide.
    const a = live.getContext('2d')!.getImageData(0, 0, 128, 128).data, b = ref.getContext('2d')!.getImageData(0, 0, 128, 128).data;
    let differ = 0;
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) differ += 1;
    return differ;
  });
  expect(bodySame).toBe(0);
  // A new mood fades her eyes, then the frames stop again. The eyes follow her posture spring (omega 3.4) and
  // then their own fade (omega 5), so gentle's lower lids take about 4 s to settle.
  await page.evaluate(() => (window as unknown as Win).maia.playScore({ v: 1, mood: 'gentle', rhythm: 'quiet', seconds: 24, beats: [] }));
  await page.clock.runFor(200);
  expect((await stats(page)).frames).toBeGreaterThan(settled.frames);
  await page.clock.runFor(6000);
  const again = await stats(page);
  await page.clock.runFor(2000);
  expect((await stats(page)).frames).toBe(again.frames);
  await page.clock.runFor(20_000);
  const asleep = await stats(page);
  expect(asleep.state).toBe('sleeping');
  expect(await page.evaluate(() => document.getElementById('maia')!.nextElementSibling)).toBeNull();
  await page.clock.runFor(3000);
  expect((await stats(page)).frames).toBe(asleep.frames);
});

test('<maia-avatar>: follows the page theme, wakes on hover, and clips her strip to her bubble', async ({ page }) => {
  await fakeClock(page);
  const r = await page.evaluate(async () => {
    const w = window as unknown as Win;
    document.documentElement.dataset['theme'] = 'dusk';
    w.M.defineMaiaAvatar();
    const el = document.createElement('maia-avatar') as HTMLElement & { avatar: Handle; state: string };
    el.setAttribute('size', '64');
    el.setAttribute('sleep-after-ms', '2000');
    document.body.append(el);
    const box = el.getBoundingClientRect();
    return { w: box.width, h: box.height, display: getComputedStyle(el).display };
  });
  expect(r).toEqual({ w: 64, h: 64, display: 'inline-block' });
  await rendered(page);
  await page.clock.runFor(7000);
  expect(await page.evaluate(() => (document.querySelector('maia-avatar') as unknown as { state: string }).state)).toBe('sleeping');
  const rects = await page.evaluate(() => {
    const el = document.querySelector('maia-avatar')!;
    const stage = el.shadowRoot!.querySelector('[part=stage]')!;
    const clip = stage.querySelector('span')!;
    const a = stage.getBoundingClientRect(), b = clip.getBoundingClientRect();
    return [a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height];
  });
  expect(rects.slice(4)).toEqual(rects.slice(0, 4));
  await page.mouse.move(rects[0]! + 32, rects[1]! + 32);
  await page.clock.runFor(100);
  expect(await page.evaluate(() => (document.querySelector('maia-avatar') as unknown as { state: string }).state)).toBe('waking');
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'dark'; });
  await page.clock.runFor(100);
  const colors = await page.evaluate(() => {
    const c = document.querySelector('maia-avatar')!.shadowRoot!.querySelector('canvas')!;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && d[i + 2]! > d[i]! + 40) blue += 1;
    return blue;
  });
  expect(colors).toBeGreaterThan(500);
});

test('the demo page runs under the strict CSP with no violation and no console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await countFrames(page);
  await page.goto('/');
  await expect(page.locator('#pairs .pair')).toHaveCount(3);
  for (const theme of ['dusk', 'dark', 'light']) {
    await page.locator(`input[name=theme][value=${theme}]`).check({ force: true });
    await page.waitForTimeout(150);
  }
  await page.locator('[data-state=thinking]').click();
  await page.locator('#score-play').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as Win).cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
});
