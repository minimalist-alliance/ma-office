// The bars at the widths where they once broke (task 34 item 3): at 375 px with four desks the bottom bar ran Fit off
// the right edge, at 320 px the scope switch reached the edge, and at 1024 px the hints wrapped to two lines. Every
// control in both bars is checked wholly on screen and on top, nothing scrolls sideways, and the bars don't meet. And
// the top bar is one row (`sub/topbar-narrow`): on screen and on top wasn't enough, as at 390 px with two desks it took
// three rows, every control still on screen; so each control's middle is checked level with the others'.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const FLEET = [
  { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
  { deskId: 'd-guild00000001', name: 'Guild', kind: 'guild', state: 'running' },
  { deskId: 'd-extra00000001', name: 'Extra', kind: 'work', state: 'running' },
];

type Box = { name: string; x: number; y: number; w: number; h: number; shown: boolean };

async function arriveWith(page: Page, request: APIRequestContext, desks: number, size: { width: number; height: number }, path = '/', more: Record<string, unknown> = {}): Promise<void> {
  await harness(request, { reset: true });
  await harness(request, { fleet: FLEET.slice(0, desks), ...more });
  await page.setViewportSize(size);
  await signIn(page, path);
  await canvasPainted(page);
  await page.waitForTimeout(800); // the camera lands
}

/** Every control in a bar, and whether it's wholly on screen and on top at its center and just inside each edge. */
function controls(page: Page, sel: string): Promise<Box[]> {
  return page.evaluate((s) => {
    return [...document.querySelectorAll<HTMLElement>(`${s} .home-mark > *, ${s} button`)].map((el, i) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const points = [[cx, cy], [r.left + 3, cy], [r.right - 3, cy], [cx, r.top + 3], [cx, r.bottom - 3]];
      const onTop = points.every(([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        return !!hit && el.contains(hit);
      });
      const inside = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      return { name: `${i}:${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName}`, x: r.left, y: r.top, w: r.width, h: r.height, shown: inside && onTop && r.width > 0 };
    });
  }, sel);
}

const box = async (page: Page, sel: string): Promise<{ left: number; right: number; top: number; bottom: number; height: number }> =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
  });
/** The hints say all they show: nothing cut off by their ellipsis. */
const whole = (page: Page): Promise<boolean> => page.locator('.hints').evaluate((el) => el.scrollWidth <= el.clientWidth);
const noSideScroll = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function everyControlShown(page: Page): Promise<void> {
  for (const bar of ['.topbar', '.bottombar']) {
    const seen = await controls(page, bar);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((c) => !c.shown).map((c) => c.name), bar).toEqual([]);
  }
  // The bandwidth circle, where the harness shows one, is beside the zoom, never on it.
  const circle = page.getByTestId('bandwidth-button');
  if (await circle.isVisible()) {
    const c = await box(page, '[data-testid="bandwidth-button"]');
    const zoom = await box(page, '.zoom-ctl');
    expect(zoom.right <= c.left || zoom.bottom <= c.top).toBe(true);
  }
  expect(await noSideScroll(page)).toBe(true);
}

test.describe('375 px', () => {
  test('four desks: Fit and every other control is on screen, the switch above the zoom', async ({ page, request }) => {
    await arriveWith(page, request, 4, { width: 375, height: 812 });
    await everyControlShown(page);
    const nav = await box(page, '.desk-nav');
    const zoom = await box(page, '.zoom-ctl');
    expect(nav.bottom).toBeLessThanOrEqual(zoom.top);
    await expect(page.getByRole('button', { name: 'Fit the desk' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: 'test-results/shots/bars-375-4.png' });
  });

  test('one desk: one row, as before, with the zoom where it was', async ({ page, request }) => {
    await arriveWith(page, request, 1, { width: 375, height: 812 });
    await everyControlShown(page);
    expect((await box(page, '.bottombar')).height).toBe(70);
    const zoom = await box(page, '.zoom-ctl');
    expect(Math.round(zoom.left)).toBe(77);
  });

  test('a notice sits above both rows of the bottom bar', async ({ page, request }) => {
    await arriveWith(page, request, 4, { width: 375, height: 812 }, '/?versionEveryMs=300');
    await harness(request, { releaseVersion: '2099.01.01-0000000' });
    await expect(page.getByTestId('new-version')).toBeVisible();
    const notice = await box(page, '[data-testid="new-version"]');
    expect(notice.bottom).toBeLessThanOrEqual((await box(page, '.desk-nav')).top);
    await everyControlShown(page);
  });
});

test.describe('320 px', () => {
  for (const desks of [3, 4]) {
    test(`${desks} desks: the scope's button keeps clear of the edge on one row, whichever scope is chosen`, async ({ page, request }) => {
      await arriveWith(page, request, desks, { width: 320, height: 640 });
      for (const scope of ['Personal', 'Work', 'Guild', 'All']) {
        await page.locator('.scope-menu .chip-btn').click();
        await page.getByRole('menuitemradio', { name: scope }).click();
        await expect(page.getByRole('button', { name: `Scope: ${scope}` })).toBeVisible();
        await page.waitForTimeout(150);
        const sw = await box(page, '.scope-menu .chip-btn');
        expect(sw.left, scope).toBeGreaterThanOrEqual(16);
        expect(sw.right, scope).toBeLessThanOrEqual((await box(page, '.top-actions .icon-btn')).left);
        await everyControlShown(page);
        await oneRow(page, scope);
      }
      await page.screenshot({ path: `test-results/shots/bars-320-${desks}.png` });
    });
  }
});

// ---------------------------------------------------------------- the top bar is one row (`sub/topbar-narrow`)
// From 320 px, with one desk to four, in a plain narrow window and on a phone (touch, the phone layout): where the whole
// scope switch doesn't fit one row beside the buttons it folds into one menu button naming the scope (`useScopeFolds`,
// `chrome/TopBar.tsx`), as short-viewport mode's does, decided before the first paint, so the bar never shows a second
// row first. At 390 px with two desks it took three: the switch under the mark, then the shield and full screen, then the
// bell and the account. The right group keeps a whole 44 px target each with a finger.
const WIDTHS = [320, 360, 375, 390, 1024];

/** Every control in the top bar (the mark, every button; not a menu's) and its middle: one row is one middle. */
async function oneRow(page: Page, when: string): Promise<void> {
  const seen = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.topbar')!;
    const els = [...bar.querySelectorAll<HTMLElement>('.home-mark > *, button')].filter((el) => !el.closest('.menu') && el.getBoundingClientRect().width > 0);
    return {
      height: bar.getBoundingClientRect().height,
      mids: els.map((el) => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName, mid: r.top + r.height / 2 };
      }),
    };
  });
  expect(seen.mids.length, when).toBeGreaterThanOrEqual(5);
  const first = seen.mids[0]!.mid;
  expect(seen.mids.filter((m) => Math.abs(m.mid - first) > 1).map((m) => `${m.name} at ${m.mid}`), when).toEqual([]);
  expect(seen.height, when).toBeLessThanOrEqual(66);
}

/** Records the top bar at every frame from the page's start, so a second row shown first and then folded is caught. */
async function watchFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __topFrames: string[] }).__topFrames = seen;
    const tick = (): void => {
      const bar = document.querySelector('.topbar');
      if (bar) {
        const now = `${Math.round(bar.getBoundingClientRect().height)}px ${bar.className}`;
        if (seen[seen.length - 1] !== now) seen.push(now);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const frames = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __topFrames: string[] }).__topFrames);

/** The narrowest press each of the right group's buttons and the scope's button takes, from its middle out, as a press lands. */
function targets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.top-actions button, .topbar .chip-btn')) {
      const b = el.getBoundingClientRect();
      const [cx, cy] = [b.left + b.width / 2, b.top + b.height / 2];
      const on = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const h = document.elementFromPoint(x, y);
        return !!h && el.contains(h);
      };
      let [l, r, t, d] = [0, 0, 0, 0];
      while (l < 30 && on(cx - l - 1, cy)) l++;
      while (r < 30 && on(cx + r + 1, cy)) r++;
      while (t < 30 && on(cx, cy - t - 1)) t++;
      while (d < 30 && on(cx, cy + d + 1)) d++;
      if (l + r + 1 < 44 || t + d + 1 < 44) out.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim()} ${l + r + 1}x${t + d + 1}`);
    }
    return out;
  });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate((src) => { (0, eval)(src); }, AXE);
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] });
    return r.violations.filter((v) => v.id !== 'color-contrast').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

for (const phone of [false, true]) {
  test.describe(phone ? 'one row, on a phone' : 'one row, in a narrow window', () => {
    if (phone) test.use({ hasTouch: true, isMobile: true });
    for (const desks of [1, 2, 3, 4]) {
      test(`${desks} desk${desks > 1 ? 's' : ''}: the top bar is one row at ${WIDTHS.join(', ')} px, from its first paint and as the window changes`, async ({ page, request }) => {
        await arriveWith(page, request, desks, { width: 390, height: 844 });
        await watchFrames(page);
        for (const width of WIDTHS) {
          const at = `${width} px`;
          await page.setViewportSize({ width, height: width >= 1024 ? 768 : 700 });
          await page.reload();
          await canvasPainted(page);
          // One look from the first frame the bar is drawn in: never a second row, then folded.
          expect(await frames(page), at).toHaveLength(1);
          await oneRow(page, at);
          await everyControlShown(page);
          // Folded on a phone's width with a scope to choose, the whole switch where it fits.
          const folds = desks > 1 && width < 1024;
          await expect(page.locator('.scope-menu .chip-btn'), at).toHaveCount(folds ? 1 : 0);
          await expect(page.getByRole('radiogroup', { name: 'Scope' }), at).toHaveCount(desks > 1 && !folds ? 1 : 0);
          if (folds) await expect(page.getByRole('button', { name: 'Scope: All' }), at).toBeVisible();
          if (phone) expect(await targets(page), at).toEqual([]);
        }
        // The window changing under it: one row at every step, folding and unfolding as it goes.
        for (const width of [1024, 700, 610, 600, 505, 500, 390, 375, 360, 320, 390, 1024]) {
          await page.setViewportSize({ width, height: 700 });
          await page.waitForTimeout(100);
          await oneRow(page, `resized to ${width} px`);
          expect(await noSideScroll(page), `resized to ${width} px`).toBe(true);
        }
        if (desks === 4) await page.screenshot({ path: `test-results/shots/bars-one-row-${phone ? 'phone' : 'window'}.png` });
      });
    }

    test('390 px, four desks: the folded scope opens its list, a pick or Esc shuts it and the keyboard goes back to its button; axe finds nothing', async ({ page, request }) => {
      await arriveWith(page, request, 4, { width: 390, height: 844 });
      const btn = page.getByRole('button', { name: 'Scope: All' });
      await expect(btn).toHaveAttribute('aria-haspopup', 'menu');
      await expect(btn).toHaveAttribute('aria-expanded', 'false');
      expect(await axeViolations(page), 'shut').toEqual([]);
      const menu = page.getByRole('menu', { name: 'Scope' });
      const items = menu.getByRole('menuitemradio');
      // The keyboard: Enter opens it on the current one, Down moves, Enter picks, and the keyboard is back on the button.
      await btn.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      await expect(btn).toHaveAttribute('aria-expanded', 'true');
      await expect(items).toHaveText(['Personal', 'Work', 'Guild', 'All']);
      await expect(items.nth(3)).toBeFocused();
      expect(await axeViolations(page), 'open').toEqual([]);
      const list = await box(page, '#scope-list');
      expect(list.left).toBeGreaterThanOrEqual(0);
      expect(list.right).toBeLessThanOrEqual(390);
      expect(list.top).toBeGreaterThanOrEqual((await box(page, '.scope-menu .chip-btn')).bottom);
      await page.screenshot({ path: `test-results/shots/bars-390-scope-open-${phone ? 'phone' : 'window'}.png` });
      await page.keyboard.press('ArrowDown');
      await expect(items.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(items.nth(1)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveCount(0);
      const work = page.getByRole('button', { name: 'Scope: Work' });
      await expect(work).toBeFocused();
      await expect(work).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.desk-nav-label')).toContainText('Work');
      await oneRow(page, 'Work chosen');
      // Esc shuts it, the keyboard back on its button, the scope as it was.
      await page.keyboard.press('Space');
      await expect(items.nth(1)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(work).toBeFocused();
      await expect(work).toHaveAttribute('aria-expanded', 'false');
      // A press (a tap on a phone) opens it and picks; the keyboard is back on the button.
      if (phone) await work.tap();
      else await work.click();
      await expect(menu).toBeVisible();
      const all = menu.getByRole('menuitemradio', { name: 'All' });
      if (phone) await all.tap();
      else await all.click();
      await expect(menu).toHaveCount(0);
      await expect(btn).toBeFocused();
      await oneRow(page, 'All chosen');
    });
  });
}

// The mark's menu open (its spec §3 and §9): nothing in the bar moves (the mark's button takes back its own padding), the
// bar stays one row, and the panel is wholly on screen, scrolling inside where the screen is short.
test.describe('the mark\'s menu open', () => {
  const where = (page: Page): Promise<{ mark: number[] | null; scope: number[] | null; folded: boolean }> =>
    page.evaluate(() => {
      const at = (s: string): number[] | null => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      };
      return { mark: at('.home-mark > h1'), scope: at('.topbar > .scope-menu'), folded: !!document.querySelector('.topbar.folded') };
    });
  for (const size of [{ width: 320, height: 640 }, { width: 360, height: 740 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 360, height: 225 }]) {
    test(`${size.width} x ${size.height}, one to four desks: the mark and the folded scope button stay put, one row, the panel on screen`, async ({ page, request }) => {
      for (let desks = 1; desks <= 4; desks++) {
        await arriveWith(page, request, desks, size);
        const before = await where(page);
        await page.getByRole('button', { name: 'Minimalist Alliance', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('navigation', { name: 'Minimalist Alliance' })).toBeVisible();
        await page.waitForTimeout(300);
        expect(await where(page), `${desks} desk(s)`).toEqual(before);
        if (desks > 1 && size.width <= 390) expect(before.folded, `${desks} desks fold the scope`).toBe(true);
        const middles = await page.evaluate(() =>
          [...document.querySelectorAll('.topbar > .home-mark, .topbar > .scope-menu, .topbar .top-actions > *')]
            .map((e) => e.getBoundingClientRect())
            .filter((r) => r.width > 0)
            .map((r) => r.top + r.height / 2),
        );
        expect(Math.max(...middles) - Math.min(...middles), `${desks} desk(s): one row`).toBeLessThanOrEqual(1);
        const pop = await box(page, '.mark-pop');
        expect(pop.left, 'the panel on screen').toBeGreaterThanOrEqual(0);
        expect(pop.top).toBeGreaterThanOrEqual(0);
        expect(pop.right).toBeLessThanOrEqual(size.width);
        expect(pop.bottom).toBeLessThanOrEqual(size.height);
        await page.keyboard.press('Escape');
        await expect(page.locator('.mark-pop')).toHaveCount(0);
      }
    });
  }
});

// With the office tour on (ADR 0056), "Take the tour" is one row more in the menu's first group: the panel is still wholly on
// screen, scrolling inside where the screen is short.
test('the mark\'s menu with Take the tour: one row more, the panel still wholly on screen', async ({ page, request }) => {
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('ma.tour.v1', JSON.stringify({ who: 'u-test', off: true }));
  });
  for (const size of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 360, height: 225 }, { width: 1440, height: 900 }]) {
    for (const desks of [1, 2]) {
      await arriveWith(page, request, desks, size, '/', { walkthrough: null });
      await page.getByRole('button', { name: 'Minimalist Alliance', exact: true }).focus();
      await page.keyboard.press('Enter');
      const nav = page.getByRole('navigation', { name: 'Minimalist Alliance' });
      await expect(nav.getByRole('button', { name: 'Take the tour' })).toBeVisible();
      await page.waitForTimeout(300);
      const pop = await box(page, '.mark-pop');
      const at = `${size.width} x ${size.height}, ${desks} desk(s)`;
      expect(pop.left, at).toBeGreaterThanOrEqual(0);
      expect(pop.top, at).toBeGreaterThanOrEqual(0);
      expect(pop.right, at).toBeLessThanOrEqual(size.width);
      expect(pop.bottom, at).toBeLessThanOrEqual(size.height);
      await page.keyboard.press('Escape');
      await expect(page.locator('.mark-pop')).toHaveCount(0);
    }
  }
});

test.describe('1024 px', () => {
  test('four desks: the hints stay on one line, at rest and with the canvas focused; a keyboard edit has its own row', async ({ page, request }) => {
    await arriveWith(page, request, 4, { width: 1024, height: 768 });
    const oneLine = async (when: string): Promise<void> => {
      const hints = await box(page, '.hints');
      expect(hints.height, when).toBeLessThanOrEqual(30);
      expect(hints.right, when).toBeLessThanOrEqual((await box(page, '.desk-nav')).left);
      expect(await whole(page), when).toBe(true);
    };
    await oneLine('at rest');
    await page.locator('.canvas-wrap').focus();
    await expect(page.locator('.hints')).toContainText('\\ privacy');
    await oneLine('canvas focused');
    // A move or a resize: the bar's row is the edit's own (`EditBar.tsx`, a11y 2.5.7), every button of it on screen and on top.
    await page.getByRole('button', { name: /^Personal desk/ }).focus();
    for (const [key, kind] of [['r', 'Resize'], ['m', 'Move']] as const) {
      await page.keyboard.press(key);
      await expect(page.getByRole('group', { name: kind === 'Move' ? /^Moving / : /^Resizing / })).toBeVisible();
      await expect(page.locator('.hints')).toHaveCount(0);
      const seen = await controls(page, '.bottombar');
      expect(seen.map((c) => c.name.replace(/^\d+:/, ''))).toEqual(kind === 'Move'
        ? ['Move left', 'Move up', 'Move down', 'Move right', 'Keep', 'Restore']
        : ['Narrower', 'Shorter', 'Taller', 'Wider', 'Keep', 'Restore']);
      expect(seen.filter((c) => !c.shown).map((c) => c.name), kind).toEqual([]);
      expect(await noSideScroll(page)).toBe(true);
      await page.keyboard.press('Escape');
    }
    await oneLine('after the edit');
    await everyControlShown(page);
    await page.screenshot({ path: 'test-results/shots/bars-1024-4.png' });
  });

  test('wide enough, the hints still say ← → switch desks', async ({ page, request }) => {
    await arriveWith(page, request, 4, { width: 1440, height: 900 });
    await expect(page.locator('.hints')).toContainText('← → switch desks');
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('.hint-switch')).toBeHidden();
  });

  test('a keyboard edit\'s row: its six on screen and on top beside the circle, with four desks and with one, at 1440 and 1024 px', async ({ page, request }) => {
    for (const [desks, size] of [[4, { width: 1440, height: 900 }], [4, { width: 1024, height: 768 }], [1, { width: 1024, height: 768 }]] as const) {
      await arriveWith(page, request, desks, size);
      await page.getByRole('button', { name: /^Personal desk/ }).focus();
      await page.keyboard.press('r');
      await expect(page.getByRole('group', { name: /^Resizing / })).toBeVisible();
      const seen = await controls(page, '.bottombar');
      expect(seen.length, `${desks} at ${size.width}`).toBe(6);
      expect(seen.filter((c) => !c.shown).map((c) => c.name), `${desks} at ${size.width}`).toEqual([]);
      if (await page.getByTestId('bandwidth-button').isVisible()) {
        expect((await box(page, '.edit-bar')).right).toBeLessThanOrEqual((await box(page, '[data-testid="bandwidth-button"]')).left);
      }
      expect(await noSideScroll(page)).toBe(true);
      await page.keyboard.press('Escape');
    }
  });
});

// Support Maia's bubble (task 30) sits in the right-most corner: in the bar's row, to the right of the bandwidth circle,
// from 1200 px; above the circle in the same corner on a narrower screen, and above both rows on a phone with several
// desks. She's off in prod today; this is with her on.
test.describe('with Support Maia on', () => {
  type R = { left: number; right: number; top: number; bottom: number };
  const clear = (a: R, b: R): boolean => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  const SIZES = [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 820, height: 1000 }, { width: 1024, height: 768 }, { width: 1200, height: 800 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }];

  for (const size of SIZES) {
    for (const desks of [1, 4]) {
      test(`${size.width} px, ${desks} desk${desks > 1 ? 's' : ''}: her bubble is right of the circle, clear of the switch, the zoom and the hints`, async ({ page, request }) => {
        await arriveWith(page, request, desks, size, '/', { maia: { enabled: true } });
        await expect(page.locator('.maia-launcher')).toBeVisible();
        const bubble = await box(page, '.maia-launcher');
        const circle = await box(page, '[data-testid="bandwidth-button"]');
        const zoom = await box(page, '.zoom-ctl');
        expect(clear(bubble, circle)).toBe(true);
        expect(clear(bubble, zoom)).toBe(true);
        expect(clear(circle, zoom)).toBe(true);
        if (desks > 1) expect(clear(bubble, await box(page, '.desk-nav'))).toBe(true);
        expect(bubble.top).toBeGreaterThanOrEqual(0);
        expect(bubble.right).toBeLessThanOrEqual(size.width);
        expect(Math.abs(size.width - bubble.right - (size.width >= 600 ? 32 : 16))).toBeLessThanOrEqual(1);
        if (size.width >= 1200) {
          expect(circle.right, 'right of the circle').toBeLessThanOrEqual(bubble.left);
          expect(zoom.right).toBeLessThanOrEqual(circle.left);
        } else {
          expect(bubble.bottom, 'above the circle').toBeLessThanOrEqual(circle.top);
        }
        await page.locator('.canvas-wrap').focus();
        if (size.width >= 1024) {
          const hints = await box(page, '.hints');
          expect(hints.height).toBeLessThanOrEqual(30);
          expect(clear(bubble, hints)).toBe(true);
          if (desks > 1) expect(hints.right).toBeLessThanOrEqual((await box(page, '.desk-nav')).left);
          // A keyboard resize's own row (`EditBar.tsx`) is clear of her and of the circle too.
          await page.getByRole('button', { name: /^Personal desk/ }).focus();
          await page.keyboard.press('r');
          await expect(page.getByRole('group', { name: /^Resizing / })).toBeVisible();
          expect(clear(bubble, await box(page, '.edit-bar'))).toBe(true);
          expect(clear(circle, await box(page, '.edit-bar'))).toBe(true);
          await page.keyboard.press('Escape');
        }
        await everyControlShown(page);
        await page.screenshot({ path: `test-results/shots/bars-maia-${size.width}-${desks}.png` });
      });
    }
  }

  for (const size of [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    test(`${size.width} px: the new-version notice and her bubble do not meet`, async ({ page, request }) => {
      await arriveWith(page, request, 4, size, '/?versionEveryMs=300', { maia: { enabled: true } });
      await harness(request, { releaseVersion: '2099.01.01-0000000' });
      await expect(page.getByTestId('new-version')).toBeVisible();
      const notice = await box(page, '[data-testid="new-version"]');
      const bubble = await box(page, '.maia-launcher');
      expect(clear(notice, bubble), 'the notice and her bubble').toBe(true);
      expect(clear(notice, await box(page, '[data-testid="bandwidth-button"]'))).toBe(true);
      await everyControlShown(page);
      await page.screenshot({ path: `test-results/shots/bars-maia-notice-${size.width}.png` });
    });

    test(`${size.width} px: the bandwidth heads-up and her bubble do not meet`, async ({ page, request }) => {
      const day = 86_400_000;
      const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
      const start = today - ((new Date(today).getUTCDay() + 6) % 7) * day;
      const meter = (gb: number): Record<string, unknown> => {
        const win = (limitGb: number, to: number): Record<string, unknown> => ({ usedBytes: gb * 1e9, usedGb: gb, limitGb, startsAt: new Date(start).toISOString(), resetsAt: new Date(to).toISOString() });
        return { tier: 'member', week: win(30, start + 7 * day), month: win(100, start + 30 * day), state: gb >= 24 ? 'warn' : 'ok', limitedBy: null, warnAtPct: 80, enforced: true, paused: false, resumesAt: null, asOf: new Date().toISOString(), pollAfterSeconds: 1 };
      };
      // Quiet on the page's first loads, then 83% of the week: the next poll (1 s) brings the one heads-up.
      await arriveWith(page, request, 4, size, '/', { maia: { enabled: true }, bandwidth: meter(0) });
      await harness(request, { bandwidth: meter(25) });
      await expect(page.getByTestId('bandwidth-notice')).toBeVisible();
      const notice = await box(page, '[data-testid="bandwidth-notice"]');
      expect(clear(notice, await box(page, '.maia-launcher')), 'the heads-up and her bubble').toBe(true);
      expect(clear(notice, await box(page, '[data-testid="bandwidth-button"]'))).toBe(true);
      expect(notice.left).toBeGreaterThanOrEqual(0);
      expect(notice.right).toBeLessThanOrEqual(size.width);
      await page.screenshot({ path: `test-results/shots/bars-maia-heads-up-${size.width}.png` });
    });
  }
});

// The weekend review: with the Browser windowed under it, the account menu opened under the window, and the centre of
// Sign out was the video. A popover in the top bar is over every window, and only while it's open.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the account menu is over a window under it, and the bar goes back under windows when it shuts`, async ({ page, request }) => {
    await harness(request, { reset: true });
    await setTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.getByRole('dialog', { name: /Browser/ }).first();
    await expect(win).toBeVisible();
    await win.getByRole('button', { name: 'Restore window' }).click();
    // Up to the top right, just under the bar, where the account menu opens.
    const at = await box(page, '.ma-window');
    const head = await box(page, '.ma-window .window-head');
    const from = { x: head.left + 40, y: head.top + head.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (1440 - 32 - at.right), from.y + (84 - at.top), { steps: 8 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const menu = page.locator('#account-panel');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(200);
    const signOut = await box(page, '#account-panel button:text-is("Sign out")');
    const under = await box(page, '.ma-window');
    const mid = { x: (signOut.left + signOut.right) / 2, y: (signOut.top + signOut.bottom) / 2 };
    // The test means something only with the window under the menu.
    expect(mid.x > under.left && mid.x < under.right && mid.y > under.top && mid.y < under.bottom, 'the window is under Sign out').toBe(true);
    const onTop = await menu.evaluate((el, m) => {
      const r = el.getBoundingClientRect();
      const points = [[m.x, m.y], [r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
      return points.map(([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        return !!hit && el.contains(hit);
      });
    }, mid);
    expect(onTop).toEqual([true, true, true, true, true, true]);
    await page.screenshot({ path: `test-results/shots/${theme}-account-menu-over-window.png` });
    // Shut, the window is over the bar again: the member's work comes first.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await page.locator('.topbar').evaluate((el) => getComputedStyle(el).zIndex)).toBe('12');
  });
}
