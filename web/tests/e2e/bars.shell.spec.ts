// The bars at the widths where they once broke (task 34 item 3): at 375 px with four desks the bottom bar ran Fit off
// the right edge, at 320 px the scope switch reached the edge, and at 1024 px the hints wrapped to two lines. Every
// control in both bars is checked wholly on screen and on top, nothing scrolls sideways, and the bars don't meet.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

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
    test(`${desks} desks: the scope switch keeps clear of the edge, whichever scope is chosen`, async ({ page, request }) => {
      await arriveWith(page, request, desks, { width: 320, height: 640 });
      for (const scope of ['Personal', 'Work', 'Guild', 'All']) {
        await page.getByRole('radio', { name: scope }).click();
        await page.waitForTimeout(150);
        const sw = await box(page, '.segmented.scope');
        expect(sw.left, scope).toBeGreaterThanOrEqual(16);
        expect(sw.right, scope).toBeLessThanOrEqual(320 - 16);
        await everyControlShown(page);
      }
      await page.screenshot({ path: `test-results/shots/bars-320-${desks}.png` });
    });
  }
});

test.describe('1024 px', () => {
  test('four desks: the hints stay on one line, at rest, with the canvas focused and in a keyboard edit', async ({ page, request }) => {
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
    await page.getByRole('button', { name: /^Personal desk/ }).focus();
    await page.keyboard.press('r');
    await expect(page.locator('.hints')).toContainText('esc restores');
    await oneLine('resizing');
    await page.keyboard.press('Escape');
    await page.keyboard.press('m');
    await expect(page.locator('.hints')).toContainText('arrows move');
    await oneLine('moving');
    await page.keyboard.press('Escape');
    await everyControlShown(page);
    await page.screenshot({ path: 'test-results/shots/bars-1024-4.png' });
  });

  test('wide enough, the hints still say ← → switch desks', async ({ page, request }) => {
    await arriveWith(page, request, 4, { width: 1440, height: 900 });
    await expect(page.locator('.hints')).toContainText('← → switch desks');
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('.hint-switch')).toBeHidden();
  });

  test('a keyboard resize says "shift 40" where there is room, and never loses "esc restores" to the ellipsis', async ({ page, request }) => {
    const resize = async (): Promise<void> => {
      await page.getByRole('button', { name: /^Personal desk/ }).focus();
      await page.keyboard.press('r');
      await expect(page.locator('.hints')).toContainText('esc restores');
    };
    await arriveWith(page, request, 4, { width: 1440, height: 900 });
    await resize();
    await expect(page.locator('.hints')).toHaveText('arrows resize · shift 40 · enter keeps · esc restores');
    expect(await whole(page)).toBe(true);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('.hint-shift')).toBeHidden();
    expect(await whole(page)).toBe(true);
    await page.keyboard.press('Escape');
    // One desk: no switch beside the hints, so there's room for all of it.
    await arriveWith(page, request, 1, { width: 1024, height: 768 });
    await resize();
    await expect(page.locator('.hint-shift')).toBeVisible();
    expect(await whole(page)).toBe(true);
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
          await page.getByRole('button', { name: /^Personal desk/ }).focus();
          await page.keyboard.press('r');
          await expect(page.locator('.hints')).toContainText('esc restores');
          expect(await whole(page)).toBe(true);
          expect(clear(bubble, await box(page, '.hints'))).toBe(true);
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
