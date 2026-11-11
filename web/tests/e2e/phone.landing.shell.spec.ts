// A phone lands on its desk, not on three small rectangles (the apps review, row 8). With several desks, the first fit of a
// page load at phone width is desk mode on the desk the phone remembers, else the first; the home mark and a reload that
// follows it still behave. At 390 x 844 with the harness's three desks (Personal, Work, Guild).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

const view = (page: Page): Promise<{ mode: string; activeDesk: string | null }> => page.evaluate(() => JSON.parse(localStorage.getItem('ma.view.v1') ?? '{}'));
const home = (page: Page) => page.getByRole('button', { name: 'Your office, show all desks' });

async function remember(page: Page, v: { mode: string; activeDesk: string }): Promise<void> {
  await page.addInitScript((saved) => {
    // Only the page the test goes to: the sign-in's first load writes a view of its own, which would overwrite it.
    if ((location.search.includes('fixture=') || location.search.includes('link=')) && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('ma.view.v1', JSON.stringify({ scope: 'all', ...saved }));
    }
  }, v);
}
async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(900);
}

test('lands in desk mode on the remembered desk, over a saved overview', async ({ page }) => {
  const errors = watchConsole(page);
  await remember(page, { mode: 'overview', activeDesk: 'd-work' });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await settled(page);
  expect(await view(page)).toMatchObject({ mode: 'desk', activeDesk: 'd-work' });
  await expect(page.locator('.desk-nav-label')).toContainText('Work');
  await expect(home(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('in desk mode no neighbour desk peeks in at the edge', async ({ page }) => {
  await setTheme(page, 'light'); // Zen paints its picture on the canvas; Light leaves it clear
  await remember(page, { mode: 'overview', activeDesk: 'd-work' });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await settled(page);
  // Konva draws to a canvas with nothing behind the desks in Light. Above and below the shown desk (which spans the middle,
  // with its shadow), the screen's edge columns are clear: a neighbour used to peek in there, lower down.
  const painted = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.canvas-wrap canvas')!;
    const g = c.getContext('2d')!;
    const w = Math.round(c.width * 0.05);
    const bands: [number, number][] = [[0, Math.round(c.height * 0.3)], [Math.round(c.height * 0.7), c.height]];
    let n = 0;
    for (const x of [0, c.width - w]) for (const [y, y2] of bands) for (const [i, v] of g.getImageData(x, y, w, y2 - y).data.entries()) if (i % 4 === 3 && v) n++;
    return n;
  });
  expect(painted).toBe(0);
});

test('a remembered desk that is gone lands on the first', async ({ page }) => {
  await remember(page, { mode: 'overview', activeDesk: 'd-gone' });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await settled(page);
  expect(await view(page)).toMatchObject({ mode: 'desk', activeDesk: 'd-personal' });
});

test('the home mark goes to the overview, and a reload after it lands on the desk again', async ({ page }) => {
  await remember(page, { mode: 'overview', activeDesk: 'd-work' });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await settled(page);
  await home(page).tap();
  await settled(page);
  const parked = await view(page); // the overview's own ring: whichever desk it rests on is the one remembered
  expect(parked.mode).toBe('overview');
  await expect(home(page)).toHaveCount(0);
  await page.reload();
  await canvasPainted(page);
  await settled(page);
  expect(await view(page)).toEqual({ ...parked, mode: 'desk' });
});

test('a screen reader meets the desk first: its first app, not the overview', async ({ page }) => {
  await remember(page, { mode: 'overview', activeDesk: 'd-work' });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await settled(page);
  const first = page.locator('.proxy-layer [tabindex="0"]').first();
  await expect(first).toHaveAttribute('aria-label', /^(Notebook|Browser|Chat|Agent|Commons|Files)/);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`the arrival, ${theme}`, async ({ page }, info) => {
    await setTheme(page, theme);
    await remember(page, { mode: 'overview', activeDesk: 'd-work' });
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await settled(page);
    if (process.env['LANDING_SHOTS']) await page.screenshot({ path: `${process.env['LANDING_SHOTS']}/phone-arrival-${theme}.png` });
    expect(await view(page), info.title).toMatchObject({ mode: 'desk', activeDesk: 'd-work' });
    await expect(page.locator('.desk-nav-label')).toContainText('Work');
  });
}

// A phone's first visit never starts a desk the member didn't pick. The real link against the harness's `connect`, which counts
// every call: a wake is `start: true`.
const DESK_A = 'd-aaaa00000001';
const DESK_B = 'd-bbbb00000002';
const fleet = (a: string, b: string) => [
  { deskId: DESK_A, name: 'Personal', kind: 'personal', state: a },
  { deskId: DESK_B, name: 'Work', kind: 'work', state: b },
];
const connects = async (request: APIRequestContext): Promise<{ deskId: string; start: unknown }[]> => ((await (await request.get('/__harness')).json()) as { connects: { deskId: string; start: unknown }[] }).connects;
const wakes = async (request: APIRequestContext): Promise<string[]> => (await connects(request)).filter((c) => c.start === true).map((c) => c.deskId);

test.describe('no wake the member did not ask for', () => {
  test('a stopped desk first and a running one second: lands on the running one, zero wakes', async ({ page, request }) => {
    await harness(request, { fleet: fleet('stopped', 'running') });
    await signIn(page, '/?link=real');
    await canvasPainted(page);
    await settled(page);
    expect(await view(page)).toMatchObject({ mode: 'desk' });
    expect((await view(page)).activeDesk).toBe(DESK_B);
    await expect(page.locator('.desk-nav-label')).toContainText('Work');
    expect(await wakes(request)).toEqual([]);
    expect((await connects(request)).some((c) => c.deskId === DESK_A && c.start === true)).toBe(false);
  });

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`none running: lands on the first, zero wakes, its own start is there, ${theme}`, async ({ page, request }) => {
      await setTheme(page, theme);
      await harness(request, { fleet: fleet('stopped', 'stopped') });
      await signIn(page, '/?link=real');
      await canvasPainted(page);
      await settled(page);
      expect((await view(page)).activeDesk).toBe(DESK_A);
      expect(await view(page)).toMatchObject({ mode: 'desk' });
      expect(await wakes(request)).toEqual([]);
      if (process.env['LANDING_SHOTS']) await page.screenshot({ path: `${process.env['LANDING_SHOTS']}/phone-asleep-${theme}.png` });
      // A reload is still no choice of the member's: the desk the office framed isn't remembered.
      await page.reload();
      await canvasPainted(page);
      await settled(page);
      expect(await wakes(request)).toEqual([]);
      // The desk's own icons are on screen and within reach, and a tap on one is the member's choice: it wakes the desk.
      const browser = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: 'Browser', exact: true });
      await expect(browser).toHaveCount(1);
      const at = await browser.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; });
      expect(at.x).toBeGreaterThan(0);
      expect(at.x).toBeLessThan(390);
      expect(at.y).toBeLessThan(844);
      expect(at.w).toBeGreaterThanOrEqual(44);
      await page.touchscreen.tap(at.x, at.y);
      await expect.poll(() => wakes(request)).toEqual([DESK_A]);
    });
  }

  test('a remembered stopped desk still wakes, as before', async ({ page, request }) => {
    await harness(request, { fleet: fleet('stopped', 'running') });
    await remember(page, { mode: 'overview', activeDesk: DESK_A });
    await signIn(page, '/?link=real');
    await canvasPainted(page);
    await settled(page);
    expect((await view(page)).activeDesk).toBe(DESK_A);
    await expect.poll(() => wakes(request)).toEqual([DESK_A]);
  });
});
