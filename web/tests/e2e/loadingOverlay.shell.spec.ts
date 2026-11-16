// The office's loading overlay (ADR 0058; the Product Designer's design, `design-drafts/loading-overlay/`). The harness
// serves a byte-for-byte copy of Platform's loader page and loading.css (`harness/loader/`), and holds the answers the
// office waits for (`desksDelayMs`, `meDelayMs`), so each spec can see the overlay up while they're out, on the first
// paint and after the canvas's first frame, and gone once the office is really ready: the list's answer in, /v1/me's, a
// free member's chunk, the canvas drawn after them; or a card or a page that isn't the office. The loader's own ends: a
// failure, a bundle from before it, the kill switch and its safety time. Reduced motion is the still; no input is held;
// axe while it's up; Light, Zen and Dark at 1280 and 390. Shots and a clip in $LOADING_SHOTS (skipped without it).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const GROUND: Record<ThemeId, string> = { light: 'rgb(233, 235, 239)', dusk: 'rgb(77, 84, 99)', dark: 'rgb(26, 29, 33)' };
const MARK: Record<ThemeId, string> = { light: 'ma-ld-l', dusk: 'ma-ld-z', dark: 'ma-ld-d' };
const SHOTS = process.env['LOADING_SHOTS'] ?? '';
const HOLD = 2500;

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

interface Timeline {
  /** The overlay as the page was first styled (DOMContentLoaded). */
  first: { display: string; background: string; marks: string[]; pointer: string; busy: string | null } | null;
  /** When either side began to take it away (aria-hidden), and how. */
  endAt?: number;
  endClass?: string;
  endAnimation?: string;
  /** The probes (`probe`) as they stood at that moment. */
  atEnd?: Record<string, boolean>;
  removedAt?: number;
}

/** Watches the overlay from the page's first style, every page load. `probe`: name to a `window` property, read as it starts to go. */
async function watchOverlay(page: Page, probe: Record<string, string> = {}): Promise<void> {
  await page.addInitScript((checks) => {
    const w = window as unknown as { __ld: Timeline };
    w.__ld = { first: null };
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('ma-ld');
      if (!el) return;
      const cs = getComputedStyle(el);
      w.__ld.first = {
        display: cs.display, background: cs.backgroundColor, pointer: cs.pointerEvents,
        marks: [...el.querySelectorAll('svg')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.getAttribute('class') ?? ''),
        busy: document.getElementById('ma-root')?.getAttribute('aria-busy') ?? null,
      };
      new MutationObserver(() => {
        if (w.__ld.endAt !== undefined || !el.hasAttribute('aria-hidden')) return;
        w.__ld.endAt = performance.now();
        w.__ld.endClass = el.className;
        const s = getComputedStyle(el);
        w.__ld.endAnimation = `${s.animationName} ${s.animationDuration} ${s.animationDelay}`;
        w.__ld.atEnd = Object.fromEntries(Object.entries(checks).map(([k, prop]) => [k, Boolean((window as unknown as Record<string, unknown>)[prop])]));
      }).observe(el, { attributes: true });
      new MutationObserver(() => {
        if (w.__ld.removedAt === undefined && !el.isConnected) w.__ld.removedAt = performance.now();
      }).observe(document.body, { childList: true });
    });
  }, probe);
}
const timeline = (page: Page): Promise<Timeline> => page.evaluate(() => (window as unknown as { __ld: Timeline }).__ld);
const readyMark = (page: Page): Promise<{ at: number; reason: string } | null> =>
  page.evaluate(() => {
    const m = performance.getEntriesByName('ma:office-ready')[0] as PerformanceMark | undefined;
    return m ? { at: m.startTime, reason: String(m.detail) } : null;
  });
const markAt = (page: Page, name: string): Promise<number | null> => page.evaluate((n) => performance.getEntriesByName(n)[0]?.startTime ?? null, name);
/** When this page's first answer from an API path came in. */
const answeredAt = (page: Page, path: string): Promise<number | null> =>
  page.evaluate((p) => {
    const e = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).find((r) => new URL(r.name).pathname === p);
    return e ? e.responseEnd : null;
  }, path);
const overlay = (page: Page) => page.locator('#ma-ld');
/** Gone, and the office no longer busy. The shots hold the list longest: 14 s, and the 600 ms fade. */
const gone = async (page: Page): Promise<void> => {
  await expect(overlay(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#ma-root')).not.toHaveAttribute('aria-busy', /.*/);
};

/** Signed in, then a load of `/` with the harness as `patch` says: the office's own page, with the overlay. */
async function officeLoad(page: Page, request: APIRequestContext, patch: Record<string, unknown> = {}, theme: ThemeId = 'light'): Promise<void> {
  await setTheme(page, theme);
  await signIn(page);
  await harness(request, patch);
  await page.goto('/');
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string }[] }> } };
    const r = await w.axe.run({ include: ['#ma-ld'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
  });
}

test.describe('until the office is ready', () => {
  test('on the first paint, still up after the canvas\'s first frame while the list is held, then the full fade once desks are drawn', async ({ page, request }) => {
    const errors = watchConsole(page);
    await watchOverlay(page);
    await officeLoad(page, request, { desksDelayMs: HOLD });
    // The first style: the theme's ground, its one mark, taking no input, the office busy.
    await expect.poll(async () => (await timeline(page)).first).toEqual({ display: 'flex', background: GROUND.light, marks: ['ma-ld-m ma-ld-l'], pointer: 'none', busy: 'true' });
    // The canvas paints with nothing answered: the overlay stays.
    await expect.poll(() => markAt(page, 'ma:first-canvas-paint')).not.toBeNull();
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).not.toHaveAttribute('aria-hidden', /.*/);
    await expect(page.locator('#ma-root')).toHaveAttribute('aria-busy', 'true');
    await gone(page);
    const t = await timeline(page);
    const desks = (await answeredAt(page, '/v1/desks'))!;
    const firstPaint = (await markAt(page, 'ma:first-canvas-paint'))!;
    expect(await readyMark(page)).toMatchObject({ reason: 'desks' });
    expect(t.endAt!).toBeGreaterThan(desks);
    expect(t.endAt!).toBeGreaterThan(firstPaint);
    // Past 500 ms the mark is showing, so the full fade: the ground's 480 ms from 120 ms.
    expect(t.endClass).toBe('ma-ld-out');
    expect(t.endAnimation).toBe('ma-ld-out 0.48s 0.12s');
    expect(t.removedAt! - t.endAt!).toBeGreaterThan(400);
    expect(t.removedAt! - t.endAt!).toBeLessThan(800);
    await expect(page.getByRole('group', { name: 'Personal desk' })).toBeAttached();
    expect(errors).toEqual([]);
  });

  test('a returning visit: the mirror\'s desks and the last visit\'s record don\'t count, only Platform\'s answers', async ({ page, request }) => {
    await watchOverlay(page);
    await officeLoad(page, request);
    await gone(page);
    // The list answers at once from here on, and /v1/me is held: this browser has both the mirror and the last-known me.
    await harness(request, { meDelayMs: HOLD });
    await page.reload();
    await expect.poll(() => markAt(page, 'ma:first-canvas-paint')).not.toBeNull();
    await expect(overlay(page)).toBeVisible();
    await gone(page);
    const t = await timeline(page);
    expect(t.endAt!).toBeGreaterThan((await answeredAt(page, '/v1/me'))!);
    expect(t.endAt!).toBeGreaterThan((await answeredAt(page, '/v1/desks'))! + 1000);
    expect(await readyMark(page)).toMatchObject({ reason: 'desks' });
  });

  test('a free member: only once the free tier\'s chunk is in, so nothing of it comes after the fade', async ({ page, request }) => {
    await watchOverlay(page, { free: '__maFree' });
    await officeLoad(page, request, { membership: { status: 'active', tier: 'free', ageBand: 'adult', adultFrom: null, parent: null } });
    await gone(page);
    expect((await timeline(page)).atEnd).toEqual({ free: true });
    expect(await readyMark(page)).toMatchObject({ reason: 'desks' });
  });

  test('takes no input: a click through it reaches the office, and nothing is left over the office after', async ({ page, request }) => {
    await officeLoad(page, request, { desksDelayMs: 4000 });
    await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
    await expect(overlay(page)).toBeVisible();
    const hit = await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#ma-ld') !== null);
    expect(hit).toBe(false);
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    await expect(overlay(page)).toBeVisible();
    await gone(page);
  });

  test('axe while it\'s up: the status and its words, nothing serious', async ({ page, request }) => {
    await officeLoad(page, request, { desksDelayMs: 6000 });
    await expect(overlay(page)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Loading your office' })).toHaveCount(1);
    expect(await axe(page)).toEqual([]);
  });
});

test.describe('every way it ends', () => {
  test('signed out: the sign-in card (a signed-out load with no card leaves for sign-in with it still up)', async ({ page }) => {
    await watchOverlay(page);
    await setTheme(page, 'light');
    await page.goto('/signed-out');
    await expect(page.getByTestId('sign-in')).toBeVisible();
    await gone(page);
    expect(await readyMark(page)).toMatchObject({ reason: 'signIn' });
  });

  test('the list failing: the office\'s own error card', async ({ page, request }) => {
    await setTheme(page, 'light');
    await harness(request, { desks: 'error' });
    await signIn(page);
    await expect(page.locator('.desk-notice').getByText("We can't reach your desks right now")).toBeVisible();
    await gone(page);
    expect(await readyMark(page)).toMatchObject({ reason: 'card' });
  });

  test('a refusal: its card', async ({ page, request }) => {
    await setTheme(page, 'light');
    await signIn(page);
    await harness(request, { desks: 'forbidden' });
    await page.reload();
    await gone(page);
    expect(await readyMark(page)).toMatchObject({ reason: 'refused' });
  });

  test('a closed account: its card, over the desks', async ({ page, request }) => {
    await setTheme(page, 'light');
    await harness(request, {
      closedAccount: true,
      membership: { status: 'ended', tier: 'officer', badge: null, stoppedBy: 'other', stoppedAt: null, dataDeleteAt: null, closed: true },
    });
    await signIn(page);
    await expect(page.getByRole('region', { name: 'This account is closed' })).toBeVisible();
    await gone(page);
    expect(await readyMark(page)).toMatchObject({ reason: 'card' });
  });

  test('the safety time: the loader fades it whatever the office is doing, and the office then finds it gone', async ({ page, request }) => {
    await watchOverlay(page);
    await setTheme(page, 'light');
    await signIn(page);
    await harness(request, { desksDelayMs: 20_000, loadingMaxMs: 1500 });
    await page.goto('/');
    await gone(page);
    expect(await readyMark(page)).toBeNull();
    const t = await timeline(page);
    expect(t.endClass).toBe('ma-ld-out');
    expect(t.endAt!).toBeGreaterThan(1400);
    expect(t.endAt!).toBeLessThan(5000);
  });

  test('the release failing to load: the ground fades to the loader\'s own line', async ({ page, request }) => {
    await watchOverlay(page);
    await setTheme(page, 'light');
    await harness(request, { releaseManifest: 'fail' });
    await page.goto('/');
    await expect(page.locator('#ma-root')).toHaveText('Desk is unavailable right now. Try again in a minute.');
    await gone(page);
    expect((await timeline(page)).endClass).toBe('ma-ld-fast');
  });

  test('a bundle from before the overlay (a rollback): the loader takes it away as the entry runs', async ({ page, request }) => {
    await watchOverlay(page);
    await setTheme(page, 'light');
    await signIn(page);
    await harness(request, { releaseManifest: 'noOverlay', desksDelayMs: HOLD });
    await page.goto('/');
    await gone(page);
    // Removed at once (no fade), long before the held list.
    const t = await timeline(page);
    expect(t.endClass).toBe('');
    expect(t.removedAt!).toBeLessThan((await answeredAt(page, '/v1/desks')) ?? Infinity);
  });

  test('the kill switch: client-config\'s loadingOverlay off takes it away as soon as client-config answers', async ({ page, request }) => {
    await watchOverlay(page);
    await setTheme(page, 'light');
    await signIn(page);
    await harness(request, { configExtra: { loadingOverlay: { enabled: false } }, desksDelayMs: HOLD });
    await page.goto('/');
    await gone(page);
    const t = await timeline(page);
    expect(t.endClass).toBe('');
    expect(t.removedAt!).toBeLessThan((await answeredAt(page, '/v1/desks')) ?? Infinity);
  });
});

test('loading.css not loading: never shown unstyled (the markup is hidden until it loads), and the office still takes it away', async ({ page, request }) => {
  await watchOverlay(page);
  await page.route('**/_loader/loading.css', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '' }));
  await officeLoad(page, request, { desksDelayMs: HOLD });
  await expect.poll(async () => (await timeline(page)).first?.display).toBe('none');
  await expect(overlay(page)).toBeHidden();
  await gone(page);
  expect(await readyMark(page)).toMatchObject({ reason: 'desks' });
  expect((await timeline(page)).endClass).toBe('');
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the still: the glint centred and not moving, no scale, and a 200 ms opacity fade at ready', async ({ page, request }) => {
    await watchOverlay(page);
    await officeLoad(page, request, { desksDelayMs: HOLD });
    const glint = page.locator('.ma-ld-g');
    await expect(glint).toHaveCSS('animation-name', 'none');
    expect(await glint.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)).toBeCloseTo(16, 1);
    await expect(page.locator('.ma-ld-in')).toHaveCSS('animation-name', 'ma-ld-show');
    await gone(page);
    expect((await timeline(page)).endAnimation).toBe('ma-ld-out 0.2s 0s');
  });
});

test.describe('each theme, and the phone', () => {
  for (const theme of THEMES) {
    test(`${theme}: the theme's ground and mark at 1440, the glint in the theme's accent`, async ({ page, request }) => {
      await watchOverlay(page);
      await officeLoad(page, request, { desksDelayMs: HOLD }, theme);
      await expect.poll(async () => (await timeline(page)).first).toMatchObject({ display: 'flex', background: GROUND[theme], marks: [`ma-ld-m ${MARK[theme]}`] });
      const mark = page.locator(`#ma-ld svg.${MARK[theme]}`);
      await expect(mark).toBeVisible();
      // Its laid-out size (the appear scales it from 0.97, which a box would catch midway).
      const [w, h] = await mark.evaluate((el) => [parseFloat(getComputedStyle(el).width), parseFloat(getComputedStyle(el).height)]);
      expect(w).toBe(88);
      expect(h).toBeCloseTo(54.6, 1);
      await gone(page);
    });
  }

  test.describe('a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    for (const theme of THEMES) {
      test(`${theme}: the phone's sizes, centred a little above the middle, then the office it lands on`, async ({ page, request }) => {
        await officeLoad(page, request, { desksDelayMs: HOLD }, theme);
        const mark = page.locator(`#ma-ld svg.${MARK[theme]}`);
        await expect(mark).toBeVisible();
        // Laid-out sizes (the appear scales from 0.97 about the middle, so the box's centre holds).
        expect(await mark.evaluate((el) => getComputedStyle(el).width)).toBe('72px');
        expect(await page.locator('.ma-ld-t').evaluate((el) => getComputedStyle(el).width)).toBe('48px');
        const box = (await mark.boundingBox())!;
        expect(box.x + box.width / 2).toBeCloseTo(195, 0);
        expect(box.y + box.height / 2).toBeLessThan(422);
        await expect(overlay(page)).toHaveCSS('background-color', GROUND[theme]);
        await gone(page);
      });
    }
  });
});

test.describe('shots and a clip for the Designer', () => {
  test.skip(!SHOTS, 'set LOADING_SHOTS to a folder');
  test.setTimeout(120_000);

  for (const size of [{ width: 1280, height: 800, dpr: 1 }, { width: 390, height: 844, dpr: 2 }]) {
    for (const theme of THEMES) {
      test(`${theme} at ${size.width}: 2 s, 10.8 s (the line), and reduced motion`, async ({ browser, request }) => {
        mkdirSync(SHOTS, { recursive: true });
        for (const reduced of [false, true]) {
          const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dpr, reducedMotion: reduced ? 'reduce' : 'no-preference', ...(size.width < 600 ? { hasTouch: true, isMobile: true } : {}) });
          const page = await context.newPage();
          await harness(request, { reset: true });
          await officeLoad(page, request, { desksDelayMs: reduced ? 4000 : 14_000, loadingMaxMs: 30_000 }, theme);
          const tag = `${theme}-${size.width}${reduced ? '-reduced' : ''}`;
          await page.waitForFunction(() => performance.now() > 2000);
          await page.screenshot({ path: `${SHOTS}/${tag}-2s.png` });
          if (!reduced) {
            await page.waitForFunction(() => performance.now() > 10_800);
            await page.screenshot({ path: `${SHOTS}/${tag}-10.8s.png` });
          }
          await gone(page);
          await page.screenshot({ path: `${SHOTS}/${tag}-ready.png` });
          await context.close();
        }
      });
    }
  }

  for (const theme of ['light', 'dusk'] as ThemeId[]) {
    test(`a cold load at 1280, ${theme}: the loop, then the fade to the office (video)`, async ({ browser, request }) => {
      // Signed in elsewhere first, so the recording is the office's own load and nothing before it.
      const signing = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const first = await signing.newPage();
      await setTheme(first, theme);
      await signIn(first);
      const state = await signing.storageState();
      await signing.close();
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state, recordVideo: { dir: `${SHOTS}/video-${theme}`, size: { width: 1280, height: 800 } } });
      const page = await context.newPage();
      await setTheme(page, theme);
      await harness(request, { desksDelayMs: 3200 });
      await page.goto('/');
      await gone(page);
      await page.waitForTimeout(800); // the office at rest after the fade, for the clip
      await context.close();
    });
  }
});
