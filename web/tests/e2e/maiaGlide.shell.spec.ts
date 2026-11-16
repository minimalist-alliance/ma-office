// Her words glide in, and her rare longer part folds under "More" (the owner, Nov 15: "the words didn't glide in, fade in and write
// naturally, they appeared instantly and abruptly"; `src/maiamode/glide.ts`, `Say.tsx`). On the mock desk with Desk Maia stood in
// for by `maiamode/mockSource.ts`, whose `stream` sends her reply in uneven bursts as a model does. Measured in Light, Zen and Dark,
// on desktop and a phone: the words come in over about two seconds at a steady pace whatever the bursts, no frame runs long, the
// line above never jumps, her choices come after her last word; with reduced motion the words are simply there. "More": only when
// there's a longer part, by pointer, keyboard and screen reader. Numbers go to $MAIA_GLIDE_OUT (JSON) when it's set.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId, openMenuSection } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ON = { configExtra: { maiaMode: { enabled: false, listed: true } }, meMaiaMode: { enabled: true } };
const PATH = '/?fixture=three';
const OUT = process.env['MAIA_GLIDE_OUT'] ?? '';
const SHOTS = process.env['MAIA_MODE_SHOTS'] ?? '';
const WELCOME = 'Welcome. I’m glad you’re here. Where would you like to start?';
const LONGER = 'Your Work desk found three laptops under $1,000.\n<more>\nThe Aero 14 is the lightest at 1.1 kg, and the Swift has the longest battery. Both have 16 GB of memory; the third, the Vela, is cheapest but heavier.';

/** Each measure, added to $MAIA_GLIDE_OUT as it's taken (a worker restarts after a failure, so nothing waits for the end). */
const results = {
  set(key: string, value: unknown): void {
    if (!OUT) return;
    mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>;
    } catch {
      /* the first */
    }
    all[key] = value;
    writeFileSync(OUT, JSON.stringify(all, null, 2));
  },
};

async function axe(page: Page, include: string): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

const steer = (page: Page, call: string, ...args: unknown[]): Promise<void> =>
  page.evaluate(([c, a]) => (window as unknown as Record<string, Record<string, (...x: unknown[]) => void>>)['__maMaiaModeMock']![c as string]!(...(a as unknown[])), [call, args] as const);

async function into(page: Page, request: APIRequestContext): Promise<void> {
  await harness(request, { reset: true });
  await harness(request, ON);
  watchConsole(page);
  await signIn(page, PATH);
  await canvasPainted(page);
  await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
  await page.getByRole('button', { name: 'Account', exact: true }).first().click();
  await openMenuSection(page, 'menu-maia');
  await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
  await dialog.getByRole('checkbox', { name: 'I’ve read this' }).check();
  await dialog.getByRole('button', { name: 'Turn on Maia' }).click();
  await expect(page.locator('.mm-layer.in')).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(800);
}

interface Glide {
  /** ms from the first words' arrival to the first word starting to show, and to the last fully shown. */
  firstMs: number;
  lastMs: number;
  /** Words shown (opacity over 0.5) at each sample, every 100 ms from the arrival. */
  shownBySample: number[];
  words: number;
  /** Frames: the longest gap between two, the 95th percentile, and how many ran past 50 ms. */
  frames: number;
  maxFrameMs: number;
  p95FrameMs: number;
  over50: number;
  /** Long animation frames the browser reported over 50 ms (Chrome's LoAF). */
  longFrames: number;
  /** The most the line above her reply moved in one frame, and her first word once shown, in px. */
  maxAboveJumpPx: number;
  maxWordJumpPx: number;
  /** The most the line above changed speed from one frame to the next, in px: a step (a jump) shows here, a glide doesn't. */
  maxAboveStepPx: number;
  aboveTrace?: number[];
  /** Her choices: when they showed after her last word, and their opacity on the first frame they were there. */
  choicesAfterLastMs: number;
  choicesFirstOpacity: number;
}

/** Streams her reply through the mock and watches every frame until her choices have settled. */
async function measure(page: Page, text: string, options: string[]): Promise<Glide> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const frames: number[] = [];
    const long: number[] = [];
    const above: number[] = [];
    const word: number[] = [];
    const shown: { t: number; n: number; total: number }[] = [];
    let choicesAt = -1;
    let choicesOpacity = -1;
    let arrival = -1;
    let lastShown = -1;
    let firstShown = -1;
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => e.duration > 50 && long.push(e.duration))).observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* not in this browser */
    }
    const log = (): HTMLElement | null => document.querySelector('.mm-log');
    // Her reply is the next line; the one above it is the last line now.
    const n0 = log()?.children.length ?? 0;
    const start = performance.now();
    let prevAbove: number | null = null;
    let prevWord: number | null = null;
    let last = start;
    let prevT = start;
    const tick = (t: number): void => {
      frames.push(t - last);
      last = t;
      const items = log()?.children;
      const reply = items?.[n0] as HTMLElement | undefined;
      const prior = n0 > 0 ? (items?.[n0 - 1] as HTMLElement | undefined) : undefined;
      const spans = reply ? [...reply.querySelectorAll<HTMLElement>('.mm-w')] : [];
      if (spans.length && arrival < 0) arrival = t;
      // Movement per 60 Hz frame: a frame the machine drops shows as one twice as long, not as a jump.
      const per = Math.max(1, (t - prevT) / (1000 / 60));
      if (prior) {
        const y = prior.getBoundingClientRect().top;
        if (prevAbove !== null) above.push(Math.abs(y - prevAbove) / per);
        prevAbove = y;
      }
      const vis = spans.filter((s) => Number(getComputedStyle(s).opacity) > 0.5).length;
      if (spans.length) {
        shown.push({ t: t - arrival, n: vis, total: spans.length });
        if (vis > 0 && firstShown < 0) firstShown = t - arrival;
        if (spans.every((s) => Number(getComputedStyle(s).opacity) >= 0.999) && lastShown < 0) lastShown = t - arrival;
        if (vis > 0) {
          const y = spans[0]!.getBoundingClientRect().top;
          if (prevWord !== null) word.push(Math.abs(y - prevWord) / per);
          prevWord = y;
        }
      }
      const group = document.querySelector<HTMLElement>('.mm-choices');
      if (group && choicesAt < 0 && arrival >= 0) {
        choicesAt = t - arrival;
        choicesOpacity = Number(getComputedStyle(group).opacity);
      }
      prevT = t;
      if (t - start < 9000 && !(choicesAt >= 0 && t - arrival > choicesAt + 900)) requestAnimationFrame(tick);
      else w['__glide'] = { frames, long, above, word, shown, choicesAt, choicesOpacity, firstShown, lastShown };
    };
    requestAnimationFrame(tick);
  });
  await steer(page, 'stream', text, options);
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>)['__glide'] !== undefined, null, { timeout: 15000 });
  const raw = await page.evaluate(() => (window as unknown as Record<string, unknown>)['__glide'] as {
    frames: number[]; long: number[]; above: number[]; word: number[]; shown: { t: number; n: number; total: number }[];
    choicesAt: number; choicesOpacity: number; firstShown: number; lastShown: number;
  });
  const f = raw.frames.slice(1).sort((a, b) => a - b);
  const samples: number[] = [];
  for (let at = 0; at <= 3000; at += 100) samples.push([...raw.shown].reverse().find((s) => s.t <= at)?.n ?? 0);
  return {
    firstMs: Math.round(raw.firstShown),
    lastMs: Math.round(raw.lastShown),
    shownBySample: samples,
    words: raw.shown.at(-1)?.total ?? 0,
    frames: f.length,
    maxFrameMs: Math.round(f.at(-1) ?? 0),
    p95FrameMs: Math.round(f[Math.floor(f.length * 0.95)] ?? 0),
    over50: f.filter((x) => x > 50).length,
    longFrames: raw.long.length,
    maxAboveJumpPx: Math.round(Math.max(0, ...raw.above) * 10) / 10,
    maxWordJumpPx: Math.round(Math.max(0, ...raw.word) * 10) / 10,
    aboveTrace: process.env['MAIA_GLIDE_TRACE'] ? raw.above.map((d) => Math.round(d * 10) / 10) : undefined,
    maxAboveStepPx: Math.round(Math.max(0, ...raw.above.slice(1).map((d, i) => Math.abs(d - raw.above[i]!))) * 10) / 10,
    choicesAfterLastMs: Math.round(raw.choicesAt - raw.lastShown),
    choicesFirstOpacity: Math.round(raw.choicesOpacity * 100) / 100,
  };
}

function expectSmooth(g: Glide): void {
  // Her greeting's 11 words: in over about two seconds, never all at once, never crawling.
  expect(g.words).toBe(11);
  expect(g.firstMs).toBeGreaterThanOrEqual(80);
  expect(g.firstMs).toBeLessThan(400);
  expect(g.lastMs).toBeGreaterThan(1200);
  expect(g.lastMs).toBeLessThan(3200);
  // A steady reveal: more words at each step, and partway through some shown and some not.
  for (let i = 1; i < g.shownBySample.length; i++) expect(g.shownBySample[i]!).toBeGreaterThanOrEqual(g.shownBySample[i - 1]!);
  expect(g.shownBySample[6]!).toBeGreaterThan(0);
  expect(g.shownBySample[6]!).toBeLessThan(11);
  // No long frames, no jumps: the line above glides up a few px a frame at most, and a shown word never moves.
  expect(g.over50).toBeLessThanOrEqual(1);
  expect(g.longFrames).toBe(0);
  expect(g.maxAboveJumpPx).toBeLessThanOrEqual(12);
  expect(g.maxWordJumpPx).toBeLessThanOrEqual(12);
  expect(g.maxAboveStepPx).toBeLessThanOrEqual(6);
  // Her choices after her last word, fading in.
  expect(g.choicesAfterLastMs).toBeGreaterThanOrEqual(0);
  expect(g.choicesFirstOpacity).toBeLessThan(0.9);
}

test.describe('Her words glide', () => {
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`in ${theme} on a desktop: a calm, steady reveal whatever the bursts, then her choices`, async ({ page, request }) => {
      await setTheme(page, theme);
      await into(page, request);
      await steer(page, 'clear');
      await steer(page, 'say', 'Hello. I’m here whenever you need me.');
      await page.waitForTimeout(2500);
      const g = await measure(page, WELCOME, ['Set things up together', 'Just look around']);
      results.set(`desktop-${theme}`, g);
      expectSmooth(g);
      await expect(page.getByRole('group', { name: 'Reply choices' }).getByRole('button')).toHaveText(['Set things up together', 'Just look around', 'Other']);
      // Screen readers get her words whole, once.
      await expect(page.locator('.mm-her').last()).toContainText(WELCOME);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/glide-${theme}.png` });
    });
  }

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
      test(`in ${theme}: the same reveal, at a phone's size`, async ({ page, request }) => {
        await setTheme(page, theme);
        await into(page, request);
        await steer(page, 'clear');
        await steer(page, 'say', 'Hello. I’m here whenever you need me.');
        await page.waitForTimeout(2500);
        const g = await measure(page, WELCOME, ['Set things up together', 'Just look around']);
        results.set(`phone-${theme}`, g);
        expectSmooth(g);
      });
    }
    test('with a CPU four times slower: still no long frames', async ({ page, request }) => {
      await into(page, request);
      await steer(page, 'clear');
      await steer(page, 'say', 'Hello. I’m here whenever you need me.');
      await page.waitForTimeout(2500);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const g = await measure(page, WELCOME, ['Set things up together', 'Just look around']);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      results.set('phone-cpu4x', g);
      expect(g.longFrames).toBe(0);
      expect(g.over50).toBeLessThanOrEqual(2);
      expect(g.maxAboveJumpPx).toBeLessThanOrEqual(12);
    });
  });

  test('with reduced motion her words are simply there, and so are her choices', async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await into(page, request);
    await steer(page, 'clear');
    await steer(page, 'say', WELCOME, ['Set things up together', 'Just look around']);
    const her = page.locator('.mm-her').last();
    await expect(her).toContainText(WELCOME, { timeout: 500 });
    expect(await her.locator('.mm-w').count()).toBe(0);
    await expect(page.getByRole('group', { name: 'Reply choices' })).toBeVisible({ timeout: 500 });
  });
});

test.describe('Her longer part', () => {
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`in ${theme}: "More" only when there's more; it unfolds under her reply and folds again, by pointer and keyboard`, async ({ page, request }) => {
      await setTheme(page, theme);
      await into(page, request);
      await steer(page, 'clear');
      await steer(page, 'say', WELCOME);
      await expect(page.locator('.mm-her').last()).toContainText(WELCOME);
      await page.waitForTimeout(2600);
      expect(await page.locator('.mm-more-btn').count()).toBe(0);
      await steer(page, 'say', LONGER);
      const her = page.locator('.mm-her').last();
      const more = her.getByRole('button', { name: 'More' });
      await expect(more).toBeVisible({ timeout: 5000 });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      const region = her.locator('.mm-more');
      await expect(region).toHaveAttribute('inert', '');
      // Folded: none of it in view, and the short reply never repeated in it.
      expect((await region.boundingBox())?.height ?? 0).toBeLessThan(2);
      await more.click();
      await expect(her.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
      await expect(region).not.toHaveAttribute('inert', '');
      await expect(region).toContainText('The Aero 14 is the lightest');
      expect(await region.innerText()).not.toContain('found three laptops');
      await page.waitForTimeout(500);
      expect((await region.boundingBox())?.height ?? 0).toBeGreaterThan(30);
      expect(await axe(page, '.mm-room')).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/more-open-${theme}.png` });
      await her.getByRole('button', { name: 'Less' }).focus();
      await page.keyboard.press('Enter');
      await expect(her.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
      await page.waitForTimeout(500);
      expect((await region.boundingBox())?.height ?? 0).toBeLessThan(2);
    });
  }
});
