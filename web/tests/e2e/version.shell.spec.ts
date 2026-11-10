// A new release while a tab is open: one calm notice above the bottom bar, never a reload by itself, and Reload is the
// member's. It sits among the shell's notices, out of the flow, so no control in either bar moves or hides for it. The
// turn is 15 minutes; `?versionEveryMs=` shortens it outside production builds. `src/platform/newVersion.test.ts` has
// the hidden-tab and failure rules.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const NEWER = '2099.01.01-0000000';
const SAID = 'A new version is ready. Reload when you like.';
const line = (page: Page) => page.getByTestId('new-version');
const configAsks = async (request: APIRequestContext): Promise<number> =>
  (((await (await request.get('/__harness')).json()) as { log: string[] }).log).filter((l) => l === 'GET /v1/client-config').length;

const FLEET = [
  { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
  { deskId: 'd-guild00000001', name: 'Guild', kind: 'guild', state: 'running' },
  { deskId: 'd-extra00000001', name: 'Extra', kind: 'work', state: 'running' },
];
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 600, height: 960 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

async function arrive(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one&versionEveryMs=300');
  await canvasPainted(page);
}

/** With `desks` from the harness's list, so the scope switch shows with more than one. */
async function arriveWith(page: Page, request: APIRequestContext, desks: number): Promise<void> {
  await harness(request, { fleet: FLEET.slice(0, desks) });
  await signIn(page, '/?versionEveryMs=300');
  await canvasPainted(page);
  await page.waitForTimeout(800); // the camera lands
}

async function resize(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForTimeout(150);
}

type Seen = { name: string; x: number; y: number; w: number; h: number; shown: boolean };

/**
 * Every control in the top and bottom bars: where it is, and whether it's wholly on screen and on top at its center
 * and just inside each edge (rounded corners don't take a press, so not the corners).
 */
function controls(page: Page, bar: '.topbar' | '.bottombar'): Promise<Seen[]> {
  return page.evaluate((sel) => {
    const els = [...document.querySelectorAll<HTMLElement>(`${sel} .home-mark > *, ${sel} button`)];
    return els.map((el, i) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const points = [[cx, cy], [r.left + 3, cy], [r.right - 3, cy], [cx, r.top + 3], [cx, r.bottom - 3]];
      const onTop = points.every(([x, y]) => {
        const hit = document.elementFromPoint(x!, y!);
        return !!hit && el.contains(hit);
      });
      const inside = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      const name = `${i}:${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName}`;
      return { name, x: r.left, y: r.top, w: r.width, h: r.height, shown: inside && onTop && r.width > 0 };
    });
  }, bar);
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the same version says nothing; a new one gets one calm notice, said once, nothing reloads, and asking stops', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await page.evaluate(() => {
    const w = window as unknown as { __stillHere: boolean; __said: string[] };
    w.__stillHere = true;
    w.__said = [];
    const region = document.querySelector('[aria-live="polite"]')!;
    new MutationObserver(() => w.__said.push(region.textContent ?? '')).observe(region, { childList: true, characterData: true, subtree: true });
  });
  await expect.poll(() => configAsks(request)).toBeGreaterThanOrEqual(3); // it is asking, and hears the same version
  await expect(line(page)).toHaveCount(0);

  await harness(request, { releaseVersion: NEWER });
  await expect(line(page)).toHaveText('A new version is ready, reload when you like' + 'Reload');
  await expect(line(page)).toHaveAccessibleName('A new version is ready, reload when you like');
  await expect(line(page).getByRole('button', { name: 'Dismiss' })).toBeVisible();
  const asks = await configAsks(request);
  await page.waitForTimeout(1_500);
  expect(await configAsks(request)).toBe(asks);
  expect(await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBe(true);
  // Said once, politely, through the live region that was already there; the notice itself isn't live.
  expect((await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).filter((t) => t === SAID)).toHaveLength(1);
  expect(await line(page).evaluate((el) => el.closest('[aria-live], [role="status"], [role="alert"]'))).toBeNull();
  expect(errors).toEqual([]);
});

test("Reload is the member's, and the reloaded tab is current", async ({ page, request }) => {
  await arrive(page);
  await harness(request, { releaseVersion: NEWER });
  await expect(line(page)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __stillHere: boolean }).__stillHere = true;
  });
  await harness(request, { releaseVersion: null }); // what the harness serves is its one bundle
  await line(page).getByRole('button', { name: 'Reload' }).click();
  await canvasPainted(page);
  expect(await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBeUndefined();
  await page.waitForTimeout(1_000);
  await expect(line(page)).toHaveCount(0);
});

test('the keyboard reaches Reload and Dismiss after the bottom bar, and Dismiss puts it away without a reload', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await harness(request, { releaseVersion: NEWER });
  await expect(line(page)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __stillHere: boolean }).__stillHere = true;
  });
  await page.getByRole('button', { name: 'Fit the desk' }).focus();
  await page.keyboard.press('Tab');
  // Task 24's bandwidth circle comes between the bottom bar and the notices, where the harness shows one.
  const circle = page.getByTestId('bandwidth-button');
  if (await circle.isVisible()) {
    await expect(circle).toBeFocused();
    await page.keyboard.press('Tab');
  }
  await expect(line(page).getByRole('button', { name: 'Reload' })).toBeFocused();
  await page.keyboard.press('Tab');
  const dismiss = line(page).getByRole('button', { name: 'Dismiss' });
  await expect(dismiss).toBeFocused();
  expect(await dismiss.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid'); // the ring shows
  await page.keyboard.press('Enter');
  await expect(line(page)).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expect(line(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBe(true);
  expect(errors).toEqual([]);
});

test('another notice stacks above it, and neither moves the other', async ({ page, request }) => {
  await arrive(page);
  await harness(request, { releaseVersion: NEWER });
  await expect(line(page)).toBeVisible();
  const before = (await line(page).boundingBox())!;
  await page.evaluate(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new Error('not here'));
  });
  await page.getByRole('button', { name: 'Full screen' }).click();
  const other = page.locator('.notice', { hasText: 'Full screen is not available here.' });
  await expect(other).toBeVisible();
  const after = (await line(page).boundingBox())!;
  expect(after).toEqual(before);
  const above = (await other.boundingBox())!;
  expect(above.y + above.height).toBeLessThanOrEqual(before.y);
});

for (const desks of [1, 4]) {
  test(`with ${desks} desk${desks > 1 ? 's' : ''}, every top-bar control stays wholly visible and in place at each width, and the bottom bar too`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await arriveWith(page, request, desks);
    const before = new Map<number, { top: Seen[]; bottom: Seen[] }>();
    for (const size of WIDTHS) {
      await resize(page, size);
      before.set(size.width, { top: await controls(page, '.topbar'), bottom: await controls(page, '.bottombar') });
    }
    await expect(line(page)).toHaveCount(0);

    await harness(request, { releaseVersion: NEWER });
    await expect(line(page)).toBeVisible();
    for (const size of WIDTHS) {
      await resize(page, size);
      const at = `${size.width} px, ${desks} desk(s)`;
      const top = await controls(page, '.topbar');
      const bottom = await controls(page, '.bottombar');
      const was = before.get(size.width)!;
      expect(top.length, at).toBeGreaterThanOrEqual(desks > 1 ? 8 : 4); // the mark, the scope switch, shield, full screen, account
      expect(top, at).toEqual(was.top);
      expect(bottom, at).toEqual(was.bottom); // the bottom bar is as it was, on screen or not, and the notice is on none of it
      for (const c of top) expect(c.shown, `${c.name} at ${at}`).toBe(true);

      const box = (await line(page).boundingBox())!;
      expect(box.x, at).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, at).toBeLessThanOrEqual(size.width);
      expect(box.height, at).toBeLessThanOrEqual(36);
      for (const c of [...top, ...bottom]) expect(overlaps({ x: box.x, y: box.y, w: box.width, h: box.height }, c), `${c.name} at ${at}`).toBe(false);
      const reload = (await line(page).getByRole('button', { name: 'Reload' }).boundingBox())!;
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, { x: reload.x + reload.width / 2, y: reload.y + reload.height / 2 })).toBe('Reload');
      expect(await page.evaluate(() => document.documentElement.scrollWidth), at).toBeLessThanOrEqual(size.width);
    }
    expect(errors).toEqual([]);
  });
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  for (const desks of [1, 4]) {
    test(`${theme}: screenshots of the notice with ${desks} desk${desks > 1 ? 's' : ''} at each width`, async ({ page, request }) => {
      await setTheme(page, theme);
      await arriveWith(page, request, desks);
      await harness(request, { releaseVersion: NEWER });
      await expect(line(page)).toBeVisible();
      for (const size of WIDTHS) {
        await resize(page, size);
        await page.waitForTimeout(300); // the camera's refit
        await page.screenshot({ path: `test-results/shots/${theme}-new-version-${desks}-${size.width}.png` });
      }
      if (desks === 1) {
        await line(page).getByRole('button', { name: 'Reload' }).focus();
        await page.keyboard.press('Tab');
        await page.screenshot({ path: `test-results/shots/${theme}-new-version-1-1440-focus.png` });
        await resize(page, { width: 320, height: 640 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: `test-results/shots/${theme}-new-version-1-320.png` });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      }
    });
  }
}
