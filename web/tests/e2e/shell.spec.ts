// The shell through its proxy layer (design 3.11), with MockDeskLink and fixtures.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, themeRadio, watchConsole, type ThemeId } from './helpers';

type KNode = {
  x(): number;
  y(): number;
  text(): string;
  width(): number;
  getAttr(k: string): unknown;
  findOne(q: string): KNode;
  find(q: string): KNode[];
  findAncestor(q: string, self?: boolean): KNode | null;
  getAbsolutePosition(): { x: number; y: number };
  getClientRect(): { x: number; y: number; width: number; height: number };
  getIntersection(p: { x: number; y: number }): KNode | null;
  getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[];
};
/** The read-only hook, in page functions. Not in a production bundle. */
declare const __maDesk: {
  camera: {
    cam: { x: number; y: number; s: number };
    vp: { w: number; h: number };
    dpr(): number;
    isMoving(): boolean;
    animateTo(c: { x: number; y: number; s: number }, duration?: number): number;
    getStage(): KNode;
  };
  etchRasters(): number;
  spriteCount(): number;
};

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test.describe(theme, () => {
    test('one desk: open and close every app through the proxy layer', async ({ page }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      // One desk: straight to desk mode, no scope switcher, no desk switcher.
      await expect(page.getByRole('radiogroup', { name: 'Scope' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Next desk' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Personal desk, 4 apps/ })).toHaveCount(1);

      for (const app of ['Chat', 'Notebook', 'Browser', 'Agent']) {
        const tile = page.getByRole('button', { name: new RegExp(`^${app}`) });
        await tile.focus();
        await page.keyboard.press('Enter');
        const win = page.getByRole('dialog', { name: new RegExp(app) });
        await expect(win).toBeVisible();
        if (app === 'Browser') {
          await expect(win.getByTestId('browser-video')).toBeVisible();
        } else if (app === 'Agent') {
          await expect(win.getByTestId('key-setup')).toBeVisible(); // agent.shell.spec.ts has the rest
        } else if (app === 'Notebook') {
          await expect(win.getByTestId('note-editor')).toBeVisible();
        } else {
          await expect(win.getByText(`${app} is on its way`)).toBeVisible();
          await expect(win.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
        }
        // Shift+Esc always leaves; plain Esc too, except in Browser.
        await page.keyboard.press(app === 'Browser' ? 'Shift+Escape' : 'Escape');
        await expect(win).toHaveCount(0);
        await expect(tile).toBeFocused();
      }
      expect(errors).toEqual([]);
    });

    test('screenshot of the canvas', async ({ page }) => {
      await setTheme(page, theme);
      await signIn(page, '/?fixture=three');
      await canvasPainted(page);
      await page.screenshot({ path: `test-results/shots/${theme}-overview.png` });
      await focusCanvas(page);
      await page.keyboard.press('1');
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-results/shots/${theme}-desk.png` });
      const tile = page.getByRole('button', { name: /^Notebook/ }).first();
      await tile.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/shots/${theme}-window.png` });
    });

    test('screenshot of the etched name at 1x and 2x, at rest and with a status line', async ({ browser }) => {
      for (const scale of [1, 2]) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, baseURL: test.info().project.use.baseURL });
        const page = await ctx.newPage();
        await setTheme(page, theme);
        await signIn(page, '/?fixture=three&agent=needs-you');
        await canvasPainted(page);
        await page.waitForTimeout(600);
        await page.screenshot({ path: `test-results/shots/${theme}-etched-${scale}x.png` });
        await ctx.close();
      }
    });

    test('screenshot of a desk mid-growth at 2x, to check its stretched pieces for seams', async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await setTheme(page, theme);
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await page.waitForTimeout(600);
      const box = (await proxyOf(page, 'Personal').boundingBox())!;
      const from = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 90, from.y + 150, { steps: 8 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: `test-results/shots/${theme}-growing-2x.png`, clip: { x: box.x - 40, y: box.y - 10, width: box.width + 170, height: box.height + 220 } });
      await page.mouse.up();
      await ctx.close();
    });

    test('screenshot of an app mid-resize at 2x, to check its stretched pieces for seams', async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await setTheme(page, theme);
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await page.waitForTimeout(600);
      const tile = (await page.getByRole('button', { name: /^Agent/ }).boundingBox())!;
      await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2);
      await page.waitForTimeout(100);
      const from = { x: tile.x + tile.width - 6, y: tile.y + tile.height - 6 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 180, from.y + 20, { steps: 8 });
      await page.waitForTimeout(100);
      await page.screenshot({ path: `test-results/shots/${theme}-app-resizing-2x.png`, clip: { x: tile.x - 30, y: tile.y - 30, width: tile.width + 240, height: tile.height + 70 } });
      await page.mouse.up();
      await ctx.close();
    });

    test('screenshot of a problem on the desk', async ({ page, request }) => {
      await setTheme(page, theme);
      await harness(request, { fleet: [personal('running')] });
      await refuseConnect(page, 503);
      await signIn(page, REAL_LINK);
      await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/reconnecting…$/);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-results/shots/${theme}-problem.png` });
    });

    test('screenshot of the longest line on the smallest desk', async ({ page, request }) => {
      await setTheme(page, theme);
      await page.addInitScript((id) => {
        const items = ['chat', 'notebook', 'browser', 'agent'].map((app) => ({ id: `${id}:${app}`, app, size: 'icon' }));
        localStorage.setItem('ma.layout.v1', JSON.stringify({ desks: { [id]: { id, x: 0, y: 36, cols: 2, rows: 2, items } }, z: [id] }));
      }, PERSONAL);
      await harness(request, { fleet: [personal('starting')] });
      await page.route('**/v1/desks/*/connect', (route) => route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ deskId: PERSONAL, state: 'starting', phase: 'queued', queue: { position: 12 }, deskToken: 'none', retryAfterSeconds: 30 }),
      }));
      await signIn(page, REAL_LINK);
      await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/waiting for capacity · #12$/);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-results/shots/${theme}-small-desk.png` });
    });
  });
}

test('a real click on the canvas opens the app under the pointer', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const box = await page.getByRole('button', { name: /^Browser/ }).boundingBox();
  if (!box) throw new Error('no proxy box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
});

test('the proxy layer follows the camera', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const proxy = page.getByRole('button', { name: /^Chat/ });
  const before = await proxy.boundingBox();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(500);
  const after = await proxy.boundingBox();
  expect(after!.width).toBeLessThan(before!.width);
});

test('three desks: scope, cycling, overview', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  const allDesks = page.getByRole('button', { name: 'Your office, show all desks' });
  await expect(page.getByRole('radiogroup', { name: 'Scope' })).toBeVisible();
  await page.getByRole('radio', { name: 'Work' }).click();
  await page.waitForTimeout(600);
  await expect(page.getByRole('img', { name: 'Minimalist Alliance' })).toBeVisible(); // one desk in scope: nowhere to go back to
  await page.getByRole('radio', { name: 'All' }).click();
  await page.waitForTimeout(600);
  await expect(allDesks).toHaveCount(0);
  await focusCanvas(page);
  await page.keyboard.press('2'); // the nth desk, while the canvas has focus
  await page.waitForTimeout(600);
  await expect(allDesks).toBeVisible();
  await expect(page.locator('.desk-nav-label')).toContainText('Work');
  await allDesks.click(); // the mark goes back to all desks
  await page.waitForTimeout(600);
  await expect(allDesks).toHaveCount(0);
  await focusCanvas(page);
  await page.keyboard.press('2');
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await expect(allDesks).toHaveCount(0);
  await focusCanvas(page);
  await page.keyboard.press(']'); // the ring moves
  await page.keyboard.press('Enter'); // and Enter focuses the desk it's on
  await page.waitForTimeout(600);
  await expect(allDesks).toBeVisible();
  expect(errors).toEqual([]);
});

test('the top left is the mark alone, by theme, with an accessible name', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await expect(page.getByRole('img', { name: 'Minimalist Alliance' })).toBeVisible();
  await expect(page.locator('.topbar')).toHaveText(''); // no words beside the mark, under any name
  for (const [theme, file] of [['light', 'ma-mark-primary'], ['dusk', 'ma-mark-zen'], ['dark', 'ma-mark-on-dark']] as const) {
    await page.evaluate((t) => { document.documentElement.dataset['theme'] = t; }, theme);
    const shown = page.locator('.home-mark-img:visible');
    await expect(shown).toHaveCount(1);
    await expect(shown).toHaveAttribute('src', new RegExp(file));
  }
  expect(errors).toEqual([]);
});

test('Tab order reaches the canvas as one stop, and arrows move inside it', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const stops = await page.locator('.proxy-layer [tabindex="0"]').count();
  expect(stops).toBe(1);
  await page.locator('.proxy-layer [tabindex="0"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.proxy-layer :focus')).toHaveAttribute('aria-label', /^Notebook/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.proxy-layer :focus')).toHaveAttribute('aria-label', /^Chat/);
});

test('the hints name the privacy key while it works, with one desk and with several', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await expect(page.locator('.hints')).toHaveText('scroll to zoom · drag to pan');
  await focusCanvas(page);
  await expect(page.locator('.hints')).toHaveText('scroll to zoom · drag to pan · \\ privacy');
  await page.getByRole('button', { name: 'Privacy shield' }).focus();
  await expect(page.locator('.hints')).toHaveText('scroll to zoom · drag to pan');
  await page.goto('/?fixture=three');
  await canvasPainted(page);
  await expect(page.locator('.hints')).toHaveText('← → switch desks · scroll to zoom · drag to pan');
  await page.locator('.proxy-layer [tabindex="0"]').focus();
  await expect(page.locator('.hints')).toHaveText('← → switch desks · scroll to zoom · drag to pan · \\ privacy');
});

test('privacy shield: \\ toggles it and it blurs windows', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('\\');
  await expect(page.getByRole('button', { name: 'Privacy shield' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.window-layer')).toHaveClass(/shielded/);
  await page.keyboard.press('\\');
  await expect(page.getByRole('button', { name: 'Privacy shield' })).toHaveAttribute('aria-pressed', 'false');
});

test('windows: full mode, drag, one window per app', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const tile = page.getByRole('button', { name: 'Notebook', exact: true }); // the window has a notebook of that name in its list, with a count
  await tile.focus();
  await page.keyboard.press('Enter');
  const win = page.getByRole('dialog', { name: /Notebook/ });
  await expect(win).toHaveAttribute('aria-modal', 'false');
  await page.waitForTimeout(300);
  const before = await win.boundingBox();
  const head = win.locator('.window-head');
  const hb = await head.boundingBox();
  await page.mouse.move(hb!.x + 200, hb!.y + 20);
  await page.mouse.down();
  await page.mouse.move(hb!.x + 260, hb!.y + 60, { steps: 4 });
  await page.mouse.up();
  const after = await win.boundingBox();
  expect(after!.x).toBeCloseTo(before!.x + 60, 0);
  await win.getByRole('button', { name: 'Fill the screen' }).click();
  await expect(win).toHaveAttribute('aria-modal', 'true');
  await win.getByRole('button', { name: 'Restore window' }).click();
  await expect(win).toHaveAttribute('aria-modal', 'false');
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Notebook/ })).toHaveCount(1);
});

test('theme switch applies to DOM and canvas, and persists', async ({ page }) => {
  const errors = watchConsole(page);
  await setTheme(page, 'light');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.getByRole('button', { name: 'Account' }).click();
  await themeRadio(page, 'Zen').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
  expect(await page.evaluate(() => localStorage.getItem('ma.theme.resolved'))).toBe('dusk');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(77, 84, 99)'); // Zen's slate ground (#4D5463), lighter than a desk
  const measure = await page.evaluate(() => performance.getEntriesByName('ma:theme-switch').at(-1)?.duration ?? -1);
  expect(measure).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('About this desk shows desk.status.get when a link is open', async ({ page, request }) => {
  await harness(request, { roles: ['owner'] });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByTestId('about-toggle').click();
  const about = page.getByTestId('about-desk');
  await expect(about).toContainText('deskd mock-0.0.0');
  await expect(about).toContainText('desk-rtc mock-0.0.0');
  await expect(about).toContainText('mock.large');
});

test('About this desk is the owner\'s only: a member sees none of it', async ({ page }) => {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.getByRole('button', { name: 'Account' }).click();
  const menu = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(menu.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); // the menu is open and whole
  await expect(menu.getByText('About this desk')).toHaveCount(0);
  await expect(page.getByTestId('about-toggle')).toHaveCount(0);
  await expect(page.getByTestId('about-desk')).toHaveCount(0);
  await expect(page.locator('.about-version')).toHaveCount(0);
  await expect(menu).not.toContainText(/deskd|Uptime|Instance|Boot|App \d/);
});

test('the owner\'s About this desk starts shut, opens, and stays as he left it in this browser', async ({ page, request }) => {
  await harness(request, { roles: ['owner'] });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await account.click();
  const toggle = page.getByTestId('about-toggle');
  await expect(toggle).toHaveText('About this desk');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('about-desk')).toHaveCount(0);
  await expect(page.locator('.about-version')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('about-desk')).toBeVisible();
  await expect(page.locator('.about-version')).toHaveText(/^App /);
  await page.reload();
  await canvasPainted(page);
  await account.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('about-desk')).toBeVisible();
  // Shut again, and it stays shut.
  await toggle.click();
  await page.reload();
  await canvasPainted(page);
  await account.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('about-desk')).toHaveCount(0);
});

test('perf fixture: 24 desks of 12 tiles render through the proxy layer', async ({ page }) => {
  await signIn(page, '/?fixture=perf');
  await canvasPainted(page);
  // Each desk, its carousel switch, and its 12 apps.
  await expect(page.locator('.proxy-layer button')).toHaveCount(24 * 2 + 24 * 12);
});

test('a phone gets a sheet and no resize handles', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const tile = page.getByRole('button', { name: /^Chat/ });
  await tile.focus();
  await page.keyboard.press('Enter');
  // The sheet is the desk's carousel on a phone (carousel.phone.shell.spec.ts), named by its app as a window is.
  const win = page.getByRole('dialog', { name: /Chat/ });
  await expect(win).toHaveClass(/carousel-stage phone/);
  await page.waitForTimeout(350); // the open animation
  const box = await win.boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await expect(win.getByRole('button', { name: 'Back from Chat' })).toBeVisible();
  await expect(win.locator('.window-edge')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/shots/phone-window.png' });
  await ctx.close();
});

// ----- rendering never wakes a desk. The real link against the harness's own small `connect`.
const REAL_LINK = '/?link=real';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const GUILD = 'd-guild00000001';
const desk = (deskId: string, name: string, kind: string, state: string) => ({ deskId, name, kind, state });
const personal = (state = 'stopped') => desk(PERSONAL, 'Personal', 'personal', state);
const work = (state = 'stopped') => desk(WORK, 'Work', 'work', state);
const guild = (state = 'stopped') => desk(GUILD, 'Guild', 'guild', state);

async function connects(request: APIRequestContext): Promise<{ deskId: string; start: unknown }[]> {
  return ((await (await request.get('/__harness')).json()) as { connects: { deskId: string; start: unknown }[] }).connects;
}
const wakes = async (request: APIRequestContext): Promise<string[]> => (await connects(request)).filter((c) => c.start === true).map((c) => c.deskId);
const proxyOf = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name} desk, `) });

async function press(locator: Locator): Promise<void> {
  await locator.focus();
  await locator.press('Enter');
}

test.describe('waking', () => {
  test('the overview wakes nothing, and a stopped desk shows asleep with no more connects', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work(), guild('running')] });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, asleep$/);
    await page.waitForTimeout(4_000);
    const all = await connects(request);
    expect(new Set(all.map((c) => c.deskId))).toEqual(new Set([PERSONAL, WORK, GUILD]));
    expect(all.every((c) => c.start === false)).toBe(true);
    expect(all.filter((c) => c.deskId === PERSONAL)).toHaveLength(1);
    expect(all.filter((c) => c.deskId === WORK)).toHaveLength(1);
  });

  test('focusing a stopped desk wakes that desk only; focusing a running one wakes nothing', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work(), guild('running')] });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, asleep$/);

    await press(proxyOf(page, 'Guild'));
    await page.waitForTimeout(500);
    expect(await wakes(request)).toEqual([]);

    await press(proxyOf(page, 'Work'));
    await expect.poll(() => wakes(request)).toEqual([WORK]);
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, waking · 1 of 4$/);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);

    // Still waking: polled with start: false, and asking again changes nothing.
    await press(proxyOf(page, 'Work'));
    const before = (await connects(request)).filter((c) => c.deskId === WORK).length;
    await expect.poll(async () => (await connects(request)).filter((c) => c.deskId === WORK).length, { timeout: 8_000 }).toBeGreaterThan(before);
    expect(await wakes(request)).toEqual([WORK]);
  });

  test('one desk wakes on arrival', async ({ page, request }) => {
    await harness(request, { fleet: [personal()] });
    await signIn(page, REAL_LINK);
    await expect.poll(() => wakes(request)).toEqual([PERSONAL]);
    expect((await connects(request)).slice(0, 2).map((c) => c.start)).toEqual([false, true]);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, waking · 1 of 4$/);
  });

  // ----- arriving: "one desk" is what Platform's list says. The list answers late here, so the first refit
  // always runs on what this browser remembers, which is what makes the race.
  async function arriveWith(page: Page, remembered: { mirror: string[]; layout: string[]; view?: Record<string, unknown> }): Promise<void> {
    await page.addInitScript(({ names, mirror, layout, view }) => {
      localStorage.setItem('ma.desks.v1', JSON.stringify(mirror.map((id) => ({ id, name: names[id], kind: names[id]!.toLowerCase() }))));
      const items = (id: string): unknown[] => [{ id: `${id}:chat`, app: 'chat', x: 24, y: 24, w: 76, h: 76 }];
      const desks = Object.fromEntries(layout.map((id, i) => [id, { id, x: i * 656, y: 0, w: 584, h: 144, items: items(id) }]));
      localStorage.setItem('ma.layout.v2', JSON.stringify({ desks, z: layout }));
      if (view) localStorage.setItem('ma.view.v1', JSON.stringify(view));
      else localStorage.removeItem('ma.view.v1');
    }, { names: { [PERSONAL]: 'Personal', [WORK]: 'Work' } as Record<string, string>, mirror: remembered.mirror, layout: remembered.layout, view: remembered.view ?? null });
    await page.route('**/v1/desks', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await page.waitForTimeout(2_500); // well past the list's answer, and any wake it could have let through
  }

  test('a new desk with no layout yet: arriving wakes neither, whatever this browser remembers', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    // Both remembered, and only one with a layout, as in a reload just after the new desk first appeared.
    await arriveWith(page, { mirror: [PERSONAL, WORK], layout: [PERSONAL] });
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, asleep$/);
    expect(await wakes(request)).toEqual([]);
    await expect(page.locator('.desk-nav-label')).toContainText('1 of 2'); // the overview, with both
  });

  test('a new desk this browser has never heard of: arriving wakes neither', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    // Last visit there was one desk, and it would have woken. There are two now.
    await arriveWith(page, { mirror: [PERSONAL], layout: [PERSONAL], view: { mode: 'overview', activeDesk: PERSONAL, scope: 'all' } });
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, asleep$/);
    expect(await wakes(request)).toEqual([]);
  });

  test('one desk still wakes on arrival, once the list has said so, and only once', async ({ page, request }) => {
    await harness(request, { fleet: [personal()] });
    await arriveWith(page, { mirror: [PERSONAL], layout: [PERSONAL], view: { mode: 'overview', activeDesk: PERSONAL, scope: 'all' } });
    expect(await wakes(request)).toEqual([PERSONAL]);
  });

  test('one desk in the scope of two doesn\'t count as one desk', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    await arriveWith(page, { mirror: [PERSONAL, WORK], layout: [PERSONAL, WORK], view: { mode: 'overview', activeDesk: PERSONAL, scope: 'personal' } });
    expect(await wakes(request)).toEqual([]);
  });

  test('a reload in desk mode still wakes the desk it was on, with the list slow to answer', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    await arriveWith(page, { mirror: [PERSONAL, WORK], layout: [PERSONAL, WORK], view: { mode: 'desk', activeDesk: WORK, scope: 'all' } });
    expect(await wakes(request)).toEqual([WORK]);
  });

  test('a wake that hits a passing failure tries again with no second click', async ({ page, request }) => {
    await harness(request, { fleet: [personal()], refuseWake: { status: 500, code: 'internal', times: 1 } });
    await signIn(page, REAL_LINK);
    await expect.poll(() => wakes(request), { timeout: 15_000 }).toEqual([PERSONAL, PERSONAL]);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, waking · 1 of 4$/);
  });

  test('a reload that restores desk mode wakes the focused desk only', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await press(proxyOf(page, 'Work'));
    await expect.poll(() => wakes(request)).toEqual([WORK]);

    await harness(request, { fleet: [personal(), work()], connects: [] });
    await page.goto(REAL_LINK);
    await expect.poll(() => wakes(request)).toEqual([WORK]);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);
  });

  test('opening an app on a stopped desk from the overview wakes that desk only', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);
    await press(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ }));
    await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
    await expect.poll(() => wakes(request)).toEqual([PERSONAL]);
  });

  test('a refused wake stays asleep; a resize asks nothing; opening an app asks again', async ({ page, request }) => {
    await harness(request, { fleet: [personal()], refuseWake: { status: 409, code: 'downtime_active' } });
    await signIn(page, REAL_LINK);
    await expect.poll(async () => (await connects(request)).map((c) => c.start)).toEqual([false, true, false]);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);

    await harness(request, { refuseWake: null });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(800);
    expect(await connects(request)).toHaveLength(3);

    await press(page.getByRole('button', { name: /^Chat/ }));
    await expect(page.getByRole('dialog', { name: /Chat/ })).toBeVisible();
    await expect.poll(() => wakes(request)).toHaveLength(2);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, waking · 1 of 4$/);
  });
});

// ----- what a desk shows (ADR 0062), read from the Konva nodes, since those are what gets drawn.
const surfaceOf = (page: Page, deskId: string): Promise<{ status: string[]; dots: number; texts: string[]; name: string }> => page.evaluate((id) => {
  type Node = { text(): string; getAttr(k: string): string };
  type Group = { find(selector: string): Node[] };
  const stage = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(s: string): Group } } } }).__maDesk.camera.getStage();
  const desk = stage.findOne(`#desk-${id}`);
  return {
    status: desk.find('.desk-status').map((n) => n.text()),
    dots: desk.find('.desk-status-dot').length,
    texts: desk.find('Text').map((n) => n.text()),
    name: desk.find('.desk-name')[0]!.getAttr('drawn'),
  };
}, deskId);

async function refuseConnect(page: Page, status: number): Promise<void> {
  await page.route('**/v1/desks/*/connect', (route) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'refused', message: 'Refused.', retryable: status >= 500 } }),
  }));
}

test.describe('what a desk shows', () => {
  test('online: its name and nothing else, with the state still in its accessible name', async ({ page }) => {
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await page.waitForTimeout(2_300); // past the wait before a slow open shows
    for (const [id, name] of [['d-personal', 'Personal'], ['d-work', 'Work'], ['d-guild', 'Guild']] as const) {
      expect(await surfaceOf(page, id)).toEqual({ status: [], dots: 0, texts: [], name: name.toUpperCase() });
      await expect(proxyOf(page, name)).toHaveAccessibleName(`${name} desk, 4 apps, agent online`);
    }
  });

  const spaceUnderChat = async (page: Page): Promise<number> => {
    const box = await proxyOf(page, 'Personal').boundingBox();
    const tile = await page.getByRole('button', { name: /^Chat/ }).boundingBox();
    const scale = await page.evaluate(() => (window as unknown as { __maDesk: { camera: { cam: { s: number } } } }).__maDesk.camera.cam.s);
    return (box!.y + box!.height - (tile!.y + tile!.height)) / scale;
  };

  test('no empty row: a saved desk one row tall stays that way, with the strip under its apps and no more', async ({ page, request }) => {
    await page.addInitScript((id) => {
      const items = [{ id: `${id}:chat`, app: 'chat', x: 24, y: 24, w: 76, h: 76 }];
      localStorage.setItem('ma.layout.v2', JSON.stringify({ desks: { [id]: { id, x: 0, y: 0, w: 584, h: 144, items } }, z: [id] }));
    }, PERSONAL);
    await harness(request, { fleet: [personal('running')] });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(800);
    expect(await spaceUnderChat(page)).toBeCloseTo(44, 0);
  });

  test('a new desk has a free band under its row, and then the strip', async ({ page }) => {
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    expect(await spaceUnderChat(page)).toBeCloseTo(92 + 44, 0);
  });

  test('asleep shows nothing, and waking shows once the member has asked', async ({ page, request }) => {
    await harness(request, { fleet: [personal(), work()] });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/);
    expect(await surfaceOf(page, PERSONAL)).toEqual({ status: [], dots: 0, texts: [], name: 'PERSONAL' });

    await press(proxyOf(page, 'Work'));
    await expect(proxyOf(page, 'Work')).toHaveAccessibleName(/, waking · 1 of 4$/);
    await expect.poll(() => surfaceOf(page, WORK)).toEqual({ status: ['waking · 1 of 4'], dots: 1, texts: ['waking · 1 of 4'], name: 'WORK' });
    expect((await surfaceOf(page, PERSONAL)).status).toEqual([]);
  });

  test('a problem shows, and leaves nothing behind when it clears', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work()] }); // two desks, so arriving asks for no wake
    await refuseConnect(page, 503);
    await signIn(page, REAL_LINK);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, reconnecting…$/);
    await expect.poll(() => surfaceOf(page, PERSONAL)).toEqual({ status: ['reconnecting…'], dots: 1, texts: ['reconnecting…'], name: 'PERSONAL' });

    await harness(request, { fleet: [personal('stopped'), work()] });
    await page.unroute('**/v1/desks/*/connect');
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/, { timeout: 20_000 });
    await expect.poll(() => surfaceOf(page, PERSONAL)).toEqual({ status: [], dots: 0, texts: [], name: 'PERSONAL' });
  });

  test('a widget with no data is blank, not "Not connected yet"', async ({ page, request }) => {
    await page.addInitScript((id) => {
      const items = [{ id: `${id}:chat`, app: 'chat', size: 'small' }, { id: `${id}:notebook`, app: 'notebook', size: 'icon' }];
      localStorage.setItem('ma.layout.v1', JSON.stringify({ desks: { [id]: { id, x: 0, y: 36, cols: 6, rows: 2, items } }, z: [id] }));
    }, PERSONAL);
    await harness(request, { fleet: [personal('running'), work()] }); // two desks, so arriving asks for no wake
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    const { texts } = await surfaceOf(page, PERSONAL);
    expect(texts).toContain('Chat'); // the widget is there
    expect(texts).not.toContain('Not connected yet');
    await page.screenshot({ path: 'test-results/shots/widget-no-data.png' });
  });

  test('going to sleep counts down, and drops the clock when the time is up', async ({ page, request }) => {
    const inSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
    const status = async (id: string): Promise<string> => (await surfaceOf(page, id)).status[0] ?? '';
    await harness(request, { fleet: [{ ...personal('stopping'), stopAt: inSeconds(65) }, { ...work('stopping'), stopAt: inSeconds(4) }] });
    await signIn(page, REAL_LINK);
    await canvasPainted(page);
    await expect.poll(() => status(PERSONAL)).toMatch(/^going to sleep · 1:0\d$/);
    const first = await status(PERSONAL);
    await expect.poll(() => status(PERSONAL), { timeout: 3_000 }).not.toBe(first);
    await expect.poll(() => status(WORK), { timeout: 8_000 }).toBe('going to sleep');
    await page.screenshot({ path: 'test-results/shots/going-to-sleep.png' });
    // A screen reader hears the state, not a clock reading itself out every second.
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, going to sleep$/);
  });

  test('a refused desk says access denied', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running')] });
    await refuseConnect(page, 403);
    await signIn(page, REAL_LINK);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, access denied$/);
    await expect.poll(async () => (await surfaceOf(page, PERSONAL)).status).toEqual(['access denied']);
  });

  test('connecting stays quiet for 2 s, so a normal open never flashes', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running')] }); // the harness's connect keeps saying "not ready"
    await signIn(page, REAL_LINK);
    const seen = await page.evaluate((id) => new Promise<{ shownAt: number | null; connectAt: number | null; firstSample: string | null }>((done) => {
      type Stage = { findOne(s: string): { find(s: string): { text(): string }[] } | undefined };
      const stage = (window as unknown as { __maDesk: { camera: { getStage(): Stage } } }).__maDesk.camera.getStage();
      const read = (): string | null => stage.findOne(`#desk-${id}`)?.find('.desk-status')[0]?.text() ?? null;
      const firstSample = read();
      const finish = (shownAt: number | null): void => {
        const connect = performance.getEntriesByType('resource').find((e) => e.name.endsWith('/connect'));
        done({ shownAt, connectAt: connect?.startTime ?? null, firstSample });
      };
      const giveUp = performance.now() + 6_000;
      const timer = window.setInterval(() => {
        const now = performance.now();
        if (read() === 'connecting…') {
          window.clearInterval(timer);
          finish(now);
        } else if (now > giveUp) {
          window.clearInterval(timer);
          finish(null);
        }
      }, 25);
    }), PERSONAL);
    expect(seen.firstSample).toBeNull();
    expect(seen.shownAt).not.toBeNull();
    expect(seen.shownAt! - seen.connectAt!).toBeGreaterThanOrEqual(1_900);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, connecting…$/);
  });
});

// ----- a desk grows freely, and can't shrink past what it holds (ADR 0062).
test.describe('growing a desk', () => {
  const scaleOf = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __maDesk: { camera: { cam: { s: number } } } }).__maDesk.camera.cam.s);
  const saved = (page: Page, key = 'ma.layout.v2'): Promise<{ desks: Record<string, { x: number; y: number; w: number; h: number; items: { id: string; x: number; y: number; w: number; h: number }[] }>; z: string[] }> =>
    page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), key);

  /** Drags a desk's corner by screen pixels, and hands back its size in world units. */
  async function dragCorner(page: Page, name: string, dx: number, dy: number): Promise<{ w: number; h: number }> {
    const box = (await proxyOf(page, name).boundingBox())!;
    const from = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = (await proxyOf(page, name).boundingBox())!;
    const s = await scaleOf(page);
    return { w: after.width / s, h: after.height / s };
  }

  test('a desk goes where it\'s dropped, with no grid, and stays there across a reload', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('stopped')] });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(600);
    const place = (): Promise<{ x: number; y: number }> => proxyOf(page, 'Personal').evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
    const before = await place();
    const box = (await proxyOf(page, 'Personal').boundingBox())!;
    const s = await scaleOf(page);
    const from = { x: box.x + box.width / 2, y: box.y + box.height - 20 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 37 * s, from.y + 21 * s, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await place();
    expect(Math.abs(after.x - (before.x + 37))).toBeLessThan(1.5);
    expect(Math.abs(after.y - (before.y + 21))).toBeLessThan(1.5);
    expect(after.x % 8 === 0 && after.y % 8 === 0).toBe(false); // 37 and 21 are nowhere near a multiple of 8
    await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(400);
    expect(await place()).toEqual(after);
  });

  test('any size, with no snapping to cells, and it keeps that size across a reload', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('running')] });
    await signIn(page);
    await canvasPainted(page);
    const s = await scaleOf(page);
    const size = await dragCorner(page, 'Personal', 97, 63);
    expect(size.w).toBeCloseTo(584 + 97 / s, 0);
    expect(size.h).toBeCloseTo(236 + 63 / s, 0);
    expect((size.w - 32) % 92).not.toBeCloseTo(0, 0); // not whole cells

    await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
    await page.reload();
    await canvasPainted(page);
    const doc = await saved(page);
    expect(doc.desks[PERSONAL]!.w).toBeCloseTo(584 + 97 / s, 0);
    expect(doc.desks[PERSONAL]!.h).toBeCloseTo(236 + 63 / s, 0);
  });

  test("it can't shrink past what it holds, and stops there without jumping", async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('running')] });
    await signIn(page);
    await canvasPainted(page);
    const size = await dragCorner(page, 'Personal', -900, -700);
    expect(size.w).toBeCloseTo(300 + 76 + 8, 0); // the Agent tile's right edge, and the margin
    expect(size.h).toBeCloseTo(24 + 76 + 44, 0); // the row, and the strip
  });

  const cameraOf = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...(window as unknown as { __maDesk: { camera: { cam: { x: number; y: number; s: number } } } }).__maDesk.camera.cam }));
  const handleAt = (page: Page, id: string): Promise<{ x: number; y: number }> => page.evaluate((deskId) => {
    type Node = { getAbsolutePosition(): { x: number; y: number } };
    const stage = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): { findOne(q: string): Node } } } } }).__maDesk.camera.getStage();
    return stage.findOne(`#desk-${deskId}`).findOne('.resize-handle').getAbsolutePosition();
  }, id);

  for (const [mode, fixture] of [['the one desk it focused on arrival', 'one'], ['a focused desk among three', 'three']] as const) {
    test(`a corner drop leaves the camera exactly where it was: ${mode}`, async ({ page }) => {
      await signIn(page, `/?fixture=${fixture}`);
      await canvasPainted(page);
      if (fixture === 'three') {
        await focusCanvas(page);
        await page.keyboard.press('1');
      }
      await page.waitForTimeout(800);
      const before = await cameraOf(page);
      await dragCorner(page, 'Personal', 60, 40);
      await page.waitForTimeout(800);
      expect(await cameraOf(page)).toEqual(before);
    });
  }

  test('a corner drop leaves the camera where it was in the overview, and the desk under the pointer', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('running')] });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(600);
    const before = await cameraOf(page);
    const box = (await proxyOf(page, 'Personal').boundingBox())!;
    const from = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + 50, { steps: 8 });
    const held = await handleAt(page, PERSONAL);
    await page.mouse.up();
    await page.waitForTimeout(800);
    expect(await cameraOf(page)).toEqual(before);
    expect(await handleAt(page, PERSONAL)).toEqual(held);
  });

  test('Fit still refits after a corner drop, and so does a window resize', async ({ page }) => {
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.waitForTimeout(600);
    await dragCorner(page, 'Personal', 150, 100);
    const grown = await cameraOf(page);
    await page.getByRole('button', { name: 'Fit the desk' }).click();
    await page.waitForTimeout(800);
    const fitted = await cameraOf(page);
    expect(fitted).not.toEqual(grown);

    await dragCorner(page, 'Personal', -30, -20);
    const again = await cameraOf(page);
    expect(again).toEqual(fitted);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(800);
    expect(await cameraOf(page)).not.toEqual(again);
  });

  test('the desk list coming round again doesn\'t move the camera after a corner drop', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work('running')] });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(600);
    await dragCorner(page, 'Personal', 80, 60);
    const before = await cameraOf(page);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // polls the list
    await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { log: string[] }).log.filter((l) => l === 'GET /v1/desks').length).toBeGreaterThan(1);
    await page.waitForTimeout(800);
    expect(await cameraOf(page)).toEqual(before);
  });

  test('at the screen\'s edge the camera pans, and the desk keeps growing under a still pointer', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.waitForTimeout(600);
    const box = (await proxyOf(page, 'Personal').boundingBox())!;
    const from = { x: box.x + box.width - 12, y: box.y + box.height - 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(1430, from.y, { steps: 12 });
    const offset = await handleAt(page, 'd-personal');
    const start = await cameraOf(page);
    await page.waitForTimeout(600); // the pointer is still
    const during = await cameraOf(page);
    expect(during.x).toBeLessThan(start.x - 50);
    expect(during.y).toBe(start.y);
    expect(during.s).toBe(start.s);
    const after = await handleAt(page, 'd-personal');
    expect(Math.abs(after.x - offset.x)).toBeLessThan(3); // the corner is still under the pointer, on screen
    await page.screenshot({ path: 'test-results/shots/desk-at-edge.png' });
    await page.mouse.up();
    const atDrop = await cameraOf(page);
    await page.waitForTimeout(800);
    const settled = await cameraOf(page);
    expect(Math.abs(settled.x - atDrop.x)).toBeLessThanOrEqual(1); // no refit brought it back
    expect(settled.s).toBe(start.s);
    expect(errors).toEqual([]);
  });

  test('the status line and the name stay with the corner while it moves', async ({ page, request }) => {
    await harness(request, { fleet: [personal('running'), work()] });
    await refuseConnect(page, 503);
    await signIn(page, REAL_LINK);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, reconnecting…$/);
    await page.waitForTimeout(600);
    const box = (await proxyOf(page, 'Personal').boundingBox())!;
    const s = await scaleOf(page);
    await page.mouse.move(box.x + box.width - 12, box.y + box.height - 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 88, box.y + box.height + 48, { steps: 10 });
    const live = await page.evaluate((id) => {
      type Group = { getClientRect(c: { relativeTo: unknown }): { y: number }; y(): number; findOne(q: string): Group | undefined; getParent(): Group };
      const stage = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): Group } } } }).__maDesk.camera.getStage();
      const desk = stage.findOne(`#desk-${id}`);
      return { statusY: desk.findOne('.desk-status')!.getParent().y() };
    }, PERSONAL);
    expect(live.statusY).toBeCloseTo(236 + 60 / s - 22, 0);
    await page.screenshot({ path: 'test-results/shots/desk-growing.png' });
    await page.mouse.up();
  });

  test('a phone keeps the grid: four columns, and no corner to drag', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    const handles = await page.evaluate(() => (window as unknown as { __maDesk: { camera: { getStage(): { find(q: string): unknown[] } } } }).__maDesk.camera.getStage().find('.resize-handle').length);
    expect(handles).toBe(0);
    const desk = (await proxyOf(page, 'Personal').boundingBox())!;
    const s = await scaleOf(page);
    expect(desk.width / s).toBeCloseTo(400, 0);
    await page.screenshot({ path: 'test-results/shots/phone-desk.png' });
    await ctx.close();
  });

  // Written by a real browser on the last version-1 build. src/canvas/layoutDoc.test.ts holds the same one.
  const REAL_V1_ID = { personal: 'd-test5i2qpxd', work: 'd-test9w4kzt7', guild: 'd-test3hqr8xb' };
  const REAL_V1 = '{"desks":{"d-test5i2qpxd":{"id":"d-test5i2qpxd","x":0,"y":36,"cols":7,"rows":3,"items":[{"id":"d-test5i2qpxd:chat","app":"chat","size":"small"},{"id":"d-test5i2qpxd:notebook","app":"notebook","size":"icon"},{"id":"d-test5i2qpxd:browser","app":"browser","size":"icon"},{"id":"d-test5i2qpxd:agent","app":"agent","size":"icon"}]},"d-test9w4kzt7":{"id":"d-test9w4kzt7","x":728,"y":128,"cols":6,"rows":1,"items":[{"id":"d-test9w4kzt7:chat","app":"chat","size":"icon"},{"id":"d-test9w4kzt7:notebook","app":"notebook","size":"icon"},{"id":"d-test9w4kzt7:browser","app":"browser","size":"icon"},{"id":"d-test9w4kzt7:agent","app":"agent","size":"icon"}]},"d-test3hqr8xb":{"id":"d-test3hqr8xb","x":1312,"y":36,"cols":6,"rows":1,"items":[{"id":"d-test3hqr8xb:agent","app":"agent","size":"icon"},{"id":"d-test3hqr8xb:chat","app":"chat","size":"icon"},{"id":"d-test3hqr8xb:notebook","app":"notebook","size":"icon"},{"id":"d-test3hqr8xb:browser","app":"browser","size":"icon"}]}},"z":["d-test3hqr8xb","d-test9w4kzt7","d-test5i2qpxd"]}';

  test('a real saved layout from before migrates with nothing lost, and the old copy stays for a rollback', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.addInitScript((doc) => {
      if (!localStorage.getItem('ma.layout.seeded')) {
        localStorage.setItem('ma.layout.v1', doc);
        localStorage.setItem('ma.layout.seeded', '1');
      }
    }, REAL_V1);
    await harness(request, { fleet: [desk(REAL_V1_ID.personal, 'Personal', 'personal', 'running'), desk(REAL_V1_ID.work, 'Work', 'work', 'running'), desk(REAL_V1_ID.guild, 'Guild', 'guild', 'running')] });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(600);

    const doc = await saved(page);
    expect(doc.desks[REAL_V1_ID.work]).toMatchObject({ x: 728, y: 128, w: 584, h: 144 });
    expect(doc.desks[REAL_V1_ID.personal]).toMatchObject({ x: 0, y: 36, w: 676, h: 328 });
    expect(doc.desks[REAL_V1_ID.personal]!.items[0]).toMatchObject({ id: `${REAL_V1_ID.personal}:chat`, w: 168, h: 168 });
    expect(doc.desks[REAL_V1_ID.guild]!.items.map((i) => i.id.split(':')[1])).toEqual(['agent', 'chat', 'notebook', 'browser']);
    expect(doc.z).toEqual([REAL_V1_ID.guild, REAL_V1_ID.work, REAL_V1_ID.personal]);
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v1'))).toBe(REAL_V1);

    await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Chat/ })).toHaveCount(1);
    await page.screenshot({ path: 'test-results/shots/migrated-layout.png' });

    // A change lands in the new copy only.
    await dragCorner(page, 'Work', 40, 40);
    await page.waitForTimeout(1_200);
    expect((await saved(page)).desks[REAL_V1_ID.work]!.w).toBeGreaterThan(584);
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v1'))).toBe(REAL_V1);
    expect(errors).toEqual([]);
  });
});

const G_MIN_DESK_W = 232;

// ----- the strip at a constant size (ADR 0064), read from the pixels on the canvas and from the hit graph.
test.describe('the etched strip', () => {
  type Cam = { x: number; y: number; s: number };
  type Ink = { count: number; x0: number; x1: number; y0: number; y1: number; darkest: number; lightest: number; sig: string };
  type Box = { x: number; y: number; w: number; h: number };
  type Seed = Box & { id: string; items: (Box & { id: string; app: string })[] };

  const tile = (deskId: string, app: string, x: number, y: number, w = 76, h = 76): Seed['items'][number] => ({ id: `${deskId}:${app}`, app, x, y, w, h });
  // Off the whole numbers, so a desk's corner lands on a fraction of a pixel at any zoom.
  const BIG = (id: string, items: Seed['items'] = [tile(id, 'chat', 24, 24)]): Seed => ({ id, x: 13.37, y: 7.77, w: 1200, h: 800, items });

  async function seed(page: Page, request: APIRequestContext, desks: Seed[], names?: Record<string, string>): Promise<void> {
    const doc = { desks: Object.fromEntries(desks.map((d) => [d.id, d])), z: desks.map((d) => d.id) };
    await page.addInitScript((d) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', JSON.stringify(d));
    }, doc);
    const kinds: Record<string, string> = { [PERSONAL]: 'personal', [WORK]: 'work', [GUILD]: 'guild' };
    const label: Record<string, string> = { [PERSONAL]: 'Personal', [WORK]: 'Work', [GUILD]: 'Guild', ...names };
    await harness(request, { fleet: desks.map((d) => desk(d.id, label[d.id]!, kinds[d.id]!, 'running')) });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(500);
  }

  /** Put this world point at the middle of the viewport at this zoom, and wait for the camera to settle. */
  async function aim(page: Page, s: number, wx: number, wy: number): Promise<void> {
    await page.evaluate(({ zoom, x, y }) => {
      const { camera } = __maDesk;
      camera.animateTo({ s: zoom, x: camera.vp.w / 2 - x * zoom + 0.37, y: camera.vp.h / 2 - y * zoom + 0.19 }, 0);
    }, { zoom: s, x: wx, y: wy });
    await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
    await page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); }));
  }

  type Rect = { left: number; top: number; right: number; bottom: number; cx: number; w: number; h: number; s: number };
  /**
   * A desk on screen, in CSS pixels, from where its proxy is, and the zoom. The etched name and icons are in desk units, so
   * on screen they're their size at 100 %, times the zoom (ADR 0064, Nov 9 note).
   */
  const rectOf = async (page: Page, id: string): Promise<Rect> => {
    const b = (await page.locator(`[id="proxy-${id}"]`).boundingBox())!;
    const s = await page.evaluate(() => __maDesk.camera.cam.s);
    return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, cx: b.x + b.width / 2, w: b.width, h: b.height, s };
  };

  /** What's in this box on the canvas against the color of its first pixel, in screen CSS pixels, with a signature of its pixels. */
  const inkIn = (page: Page, box: Box): Promise<Ink> => page.evaluate((b) => {
    const { camera } = __maDesk;
    const d = camera.dpr();
    const ctx = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context;
    const left = Math.round(b.x * d);
    const top = Math.round(b.y * d);
    const width = Math.round(b.w * d);
    const height = Math.round(b.h * d);
    const { data } = ctx.getImageData(left, top, width, height);
    const base = [data[0]!, data[1]!, data[2]!];
    let count = 0;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    let [darkest, lightest] = [255, 0];
    for (let row = 0; row < height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const at = (row * width + col) * 4;
        if (Math.abs(data[at]! - base[0]!) + Math.abs(data[at + 1]! - base[1]!) + Math.abs(data[at + 2]! - base[2]!) < 18) continue;
        count += 1;
        x0 = Math.min(x0, col);
        x1 = Math.max(x1, col + 1);
        y0 = Math.min(y0, row);
        y1 = Math.max(y1, row + 1);
        darkest = Math.min(darkest, data[at]!);
        lightest = Math.max(lightest, data[at]!);
      }
    }
    let sig = 0;
    for (let row = y0; row < y1; row += 1) {
      for (let col = x0; col < x1; col += 1) {
        const at = (row * width + col) * 4;
        sig = (Math.imul(sig, 31) + data[at]! + 257 * data[at + 1]! + 65537 * data[at + 2]!) | 0;
      }
    }
    return { count, x0: (left + x0) / d, x1: (left + x1) / d, y0: (top + y0) / d, y1: (top + y1) / d, darkest, lightest, sig: `${x1 - x0}x${y1 - y0}:${sig}` };
  }, box);

  /** Round the name at zoom `s`: at 100 % and under, this box holds it; over 100 %, the box grows with it. */
  const nameBox = (r: { cx: number; bottom: number }, halfW = 118, s = 1): Box => {
    const k = Math.max(1, s);
    return { x: r.cx - halfW * k, y: r.bottom - 40 * k, w: 2 * halfW * k, h: 38 * k };
  };
  /** An icon's 16-unit box, and two units round it for its lip, from its center on the name's center line, at zoom `s`. */
  const iconBox = (r: { right: number; bottom: number }, fromRight: number, s = 1): Box => ({ x: r.right - (fromRight + 10) * s, y: r.bottom - (22 + 10) * s, w: 20 * s, h: 20 * s });
  // From the right, in desk units: the grip's target is 6 to 34, cleanup's 42 to 70, and the hidden count's 78 to 124 while
  // cleanup's slot is held. On screen that's times the zoom.
  const GRIP = 20;
  // On a desk at least 300 units wide the carousel's switch is the grip's neighbour, and cleanup and the count are a
  // slot further in (SPARKLE is that). Under that the row is as it was, and cleanup is the grip's neighbour.
  const SWITCH = 56;
  const SPARKLE = 92;
  const COUNT = { x: 114, w: 46 };

  const hitAt = (page: Page, x: number, y: number): Promise<string> => page.evaluate((p) => {
    const n = __maDesk.camera.getStage().getIntersection(p);
    if (!n) return 'canvas';
    return ['.app-tile', '.resize-handle', '.desk-cleanup', '.desk-undo', '.desk-carousel', '.desk'].find((q) => n.findAncestor(q, true))?.slice(1) ?? 'other';
  }, { x, y });
  /** What a press this many desk units in from the desk's bottom-right corner gets, at the zoom `r` was read at. */
  const hitIn = (page: Page, r: Rect, dx: number, dy: number): Promise<string> => hitAt(page, r.right - dx * r.s, r.bottom - dy * r.s);

  const drawnName = (page: Page, id: string): Promise<{ text: string; x: number; y: number }> => page.evaluate((deskId) => {
    const n = __maDesk.camera.getStage().findOne(`#desk-${deskId}`).findOne('.desk-name');
    return { text: n.getAttr('drawn') as string, x: n.getAttr('drawnX') as number, y: n.getAttr('drawnY') as number };
  }, id);

  test('the smallest desk fits every status line, with no cut, so hiding the name is all it takes', async ({ page, request }) => {
    await page.addInitScript(({ id }) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', JSON.stringify({ desks: { [id]: { id, x: 0, y: 0, w: 100, h: 124, items: [] } }, z: [id] }));
    }, { id: PERSONAL });
    await harness(request, { fleet: [personal('starting')] });
    await page.route('**/v1/desks/*/connect', (route) => route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ deskId: PERSONAL, state: 'starting', phase: 'queued', queue: { position: 123 }, deskToken: 'none', retryAfterSeconds: 30 }),
    }));
    await signIn(page, REAL_LINK);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, waiting for capacity · #123$/);
    await page.waitForTimeout(500);
    const read = await page.evaluate((id) => {
      const line = __maDesk.camera.getStage().findOne(`#desk-${id}`).find('.desk-status')[0]!;
      const c = new OffscreenCanvas(1, 1).getContext('2d')!;
      c.font = '13px "Inter Variable", system-ui';
      return { room: line.width(), natural: c.measureText(line.text()).width };
    }, PERSONAL);
    expect(read.natural).toBeLessThanOrEqual(read.room);
    await page.screenshot({ path: 'test-results/shots/etched-smallest.png' });
  });

  test('it replaces the label: centered in the strip, baseline 17 up times the zoom, with nothing above the desk', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.waitForTimeout(400);
    expect(await surfaceOf(page, 'd-personal')).toEqual({ status: [], dots: 0, texts: [], name: 'PERSONAL' });
    const r = await rectOf(page, 'd-personal');
    // One desk fills the screen, over 100 %: the name is its size and place at 100 %, times the zoom.
    const s = r.s;
    const ink = await inkIn(page, nameBox(r, 118, s));
    expect(ink.count).toBeGreaterThan(100);
    expect(Math.abs((ink.x0 + ink.x1) / 2 - r.cx)).toBeLessThan(s); // centered on what's seen
    expect(r.bottom - ink.y1).toBeGreaterThanOrEqual(14.5 * s); // the baseline, with its lip
    expect(r.bottom - ink.y1).toBeLessThanOrEqual(17 * s);
    expect(ink.y1 - ink.y0).toBeGreaterThan(9.5 * s); // capitals in 14 px
    expect(ink.y1 - ink.y0).toBeLessThan(13 * s);
    // The desk's proxy is the panel, and no more.
    const proxy = (await page.locator('[id="proxy-d-personal"]').boundingBox())!;
    const chat = (await page.getByRole('button', { name: /^Chat/ }).boundingBox())!;
    expect((chat.y - proxy.y) / s).toBeCloseTo(24, 0);
    // An app's name on hover hangs just under it. Here that's the free band, well above the etched name.
    const browser = (await page.getByRole('button', { name: /^Browser/ }).boundingBox())!;
    await page.mouse.move(browser.x + browser.width / 2, browser.y + browser.height / 2);
    await page.waitForTimeout(150);
    await page.screenshot({ path: 'test-results/shots/etched-hover.png' });
    expect(errors).toEqual([]);
  });

  test('it looks the same whether or not the desk has focus', async ({ page }) => {
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await page.waitForTimeout(400);
    const r = await rectOf(page, 'd-work');
    const a = await inkIn(page, nameBox(r, 60));
    await page.keyboard.press('ArrowRight'); // the ring moves in the overview, and the camera doesn't
    await page.waitForTimeout(300);
    const b = await inkIn(page, nameBox(r, 60));
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const c = await inkIn(page, nameBox(r, 60));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test('a move draws from the same bitmap: panning and dragging a desk make none', async ({ page }) => {
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await page.waitForTimeout(600);
    const count = (): Promise<number> => page.evaluate(() => __maDesk.spriteCount());
    const before = await count();
    const box = (await page.getByRole('button', { name: /^Work desk, / }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height + 10, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await count()).toBe(before);
  });

  test('a long name gets an ellipsis, 12 from the grip\'s slot, and a name Jost can\'t draw still shows', async ({ page, request }) => {
    const errors = watchConsole(page);
    const row = (id: string, x: number): Seed => ({ id, x, y: 0, w: 584, h: 144, items: [] });
    await seed(page, request, [row(PERSONAL, 0), row(WORK, 620), row(GUILD, 1240)], { [PERSONAL]: 'The very long name of a desk that a member chose for a guild, with more besides', [WORK]: '机の名前', [GUILD]: 'Личный стол' });
    await aim(page, 0.7, 912, 72);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(200);
    const long = await drawnName(page, PERSONAL);
    expect(long.text.endsWith('…')).toBe(true);
    expect(long.text.startsWith('THE VERY LONG')).toBe(true);
    const r = await rectOf(page, PERSONAL);
    // The grip's slot ends 34 in, and the name keeps 12 from it: in desk units, so at 0.7 that's 32 px on screen.
    const ink = await inkIn(page, { x: r.left + 3, y: r.bottom - 32 * r.s, w: r.w - 38 * r.s, h: 20 * r.s });
    expect(ink.x0).toBeGreaterThanOrEqual(r.left + (34 + 12) * r.s - 1);
    expect(ink.x1).toBeLessThanOrEqual(r.right - (34 + 12) * r.s + 1);

    expect((await drawnName(page, WORK)).text).toBe('机の名前');
    expect((await inkIn(page, nameBox(await rectOf(page, WORK)))).count).toBeGreaterThan(50);
    expect((await drawnName(page, GUILD)).text).toBe('ЛИЧНЫЙ СТОЛ');
    expect((await inkIn(page, nameBox(await rectOf(page, GUILD)))).count).toBeGreaterThan(50);
    await page.screenshot({ path: 'test-results/shots/etched-names.png' });
    expect(errors).toEqual([]);
  });

  test('the status line sits at the left, and the name gives way only while they\'d touch', async ({ page, request }) => {
    const small = { id: PERSONAL, x: 0, y: 0, w: G_MIN_DESK_W, h: 124, items: [{ id: `${PERSONAL}:chat`, app: 'chat', x: 24, y: 24, w: 56, h: 56 }] };
    const wide = { id: WORK, x: 300, y: 0, w: 584, h: 144, items: [] };
    await page.addInitScript(({ doc }) => {
      if (!localStorage.getItem('test.seeded')) {
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v2', JSON.stringify(doc));
      }
    }, { doc: { desks: { [PERSONAL]: small, [WORK]: wide }, z: [PERSONAL, WORK] } });
    await harness(request, { fleet: [personal('running'), work('running')] });
    await page.route('**/v1/desks/*/connect', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'refused', message: 'Refused.', retryable: true } }) }));
    await signIn(page, REAL_LINK);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, reconnecting…$/);
    await page.waitForTimeout(600);
    await expect.poll(() => surfaceOf(page, PERSONAL)).toMatchObject({ status: ['reconnecting…'], name: '' }); // the smallest desk
    await expect.poll(() => surfaceOf(page, WORK)).toMatchObject({ status: ['reconnecting…'], name: 'WORK' }); // 584 wide
    await page.screenshot({ path: 'test-results/shots/etched-status.png' });

    await harness(request, { fleet: [personal('stopped'), work('stopped')] });
    await page.unroute('**/v1/desks/*/connect');
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, asleep$/, { timeout: 20_000 });
    await expect.poll(() => surfaceOf(page, PERSONAL)).toMatchObject({ status: [], name: 'PERSONAL' });
  });

  test('an agent\'s status has its provider mark beside it', async ({ page }) => {
    await signIn(page, '/?fixture=one&agent=needs-you');
    await canvasPainted(page);
    await page.waitForTimeout(400);
    const marks = await page.evaluate(() => __maDesk.camera.getStage().find('.desk-status-mark').length);
    expect(marks).toBe(1);
    expect(await surfaceOf(page, 'd-personal')).toMatchObject({ status: ['needs you'], name: 'PERSONAL' });
    await page.screenshot({ path: 'test-results/shots/etched-agent-status.png' });
  });

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    for (const scale of [1, 2]) {
      test(`${theme} at ${scale}x: the name scales with the desk, in the same place on it at every zoom, on whole pixels, and hides under 50 %`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, baseURL: test.info().project.use.baseURL });
        const page = await ctx.newPage();
        const errors = watchConsole(page);
        await page.request.post('/__harness', { data: { reset: true } });
        await setTheme(page, theme);
        const big = BIG(PERSONAL);
        await seed(page, page.request, [big]);
        const seen: (Ink & { s: number })[] = [];
        for (const s of [0.25, 0.41, 0.49, 0.5, 0.63, 1, 1.37, 1.75, 2.6, 1]) {
          await aim(page, s, big.x + big.w / 2, big.y + big.h - 60);
          const r = await rectOf(page, PERSONAL);
          if (s < 0.5) {
            // 14 px times the zoom is under 7 px: it hides, and nothing of it is left.
            expect((await drawnName(page, PERSONAL)).text, `hidden at ${s}`).toBe('');
            expect((await inkIn(page, nameBox(r))).count, `no ink at ${s}`).toBe(0);
            continue;
          }
          const ink = await inkIn(page, nameBox(r, 118, s));
          seen.push({ ...ink, s });
          expect(Math.abs((ink.x0 + ink.x1) / 2 - r.cx), `centered at ${s}`).toBeLessThanOrEqual(1.5 * Math.max(1, s)); // on its advance, and on a whole pixel
          // Baseline 17 up at 100 %, times the zoom. The cut's lip is below it, and a round letter's overshoot a little more.
          expect(r.bottom - ink.y1, `baseline at ${s}`).toBeGreaterThanOrEqual(14.5 * s - 0.5);
          expect(r.bottom - ink.y1, `baseline at ${s}`).toBeLessThanOrEqual(17 * s + 0.5);
          expect((await drawnName(page, PERSONAL)).text).toBe('PERSONAL');
          // At rest, on whole device pixels.
          const at = await drawnName(page, PERSONAL);
          expect(Math.abs(at.x * scale - Math.round(at.x * scale))).toBeLessThan(1e-6);
          expect(Math.abs(at.y * scale - Math.round(at.y * scale))).toBeLessThan(1e-6);
        }
        const [one, again] = seen.filter((i) => i.s === 1);
        expect(one!.y1 - one!.y0).toBeGreaterThan(9.5); // capitals in 14 px, with the cut
        expect(one!.y1 - one!.y0).toBeLessThan(13);
        expect(one!.x1 - one!.x0).toBeGreaterThan(84);
        expect(one!.x1 - one!.x0).toBeLessThan(92);
        // At every other zoom it's that, times the zoom: the same cut, scaled with the desk.
        console.log(`NAME ${theme} ${scale}x`, JSON.stringify(seen.map((i) => ({ s: i.s, w: +(i.x1 - i.x0).toFixed(2), h: +(i.y1 - i.y0).toFixed(2) }))));
        for (const ink of seen) {
          expect(Math.abs(ink.x1 - ink.x0 - (one!.x1 - one!.x0) * ink.s), `width at ${ink.s}`).toBeLessThanOrEqual(1.5 * Math.max(1, ink.s));
          expect(Math.abs(ink.y1 - ink.y0 - (one!.y1 - one!.y0) * ink.s), `height at ${ink.s}`).toBeLessThanOrEqual(1.5 * Math.max(1, ink.s));
        }
        // Back at 100 % after all that, it's the same pixels: the 100 % bitmap, drawn as it was.
        expect(again!.sig).toBe(one!.sig);
        expect(errors).toEqual([]);
        await ctx.close();
      });
    }
  }

  test('the cut is a CSS pixel at every scale: one device pixel of lip at 1x, and two at 2x', async ({ browser }) => {
    for (const scale of [1, 2]) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await page.request.post('/__harness', { data: { reset: true } });
      await setTheme(page, 'dusk');
      await seed(page, page.request, [BIG(PERSONAL)]);
      await aim(page, 1, 613.37, 700);
      const r = await rectOf(page, PERSONAL);
      // Down a column through the grip's flat foot: fill, then the lip, then the panel. Its right side is 15.5 from its center.
      const rows = await page.evaluate(({ x, y0, y1 }) => {
        const { camera } = __maDesk;
        const d = camera.dpr();
        const ctx2 = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context;
        const out: number[][] = [];
        for (let y = Math.round(y0 * d); y < Math.round(y1 * d); y += 1) out.push(Array.from(ctx2.getImageData(Math.round(x * d), y, 1, 1).data.slice(0, 3)));
        return out;
      }, { x: r.right - 18, y0: r.bottom - 22, y1: r.bottom - 8 });
      // Zen's highlight, .30 of its white (241, 243, 247) on the panel #404654.
      const lip = [0x40, 0x46, 0x54].map((c, i) => Math.round(c * 0.7 + [241, 243, 247][i]! * 0.3));
      const isLip = (p: number[]): boolean => p.every((c, i) => Math.abs(c - lip[i]!) <= 2);
      expect(rows.filter(isLip).length, JSON.stringify(rows)).toBe(scale);
      await ctx.close();
    }
  });

  test('every bitmap is one per string, theme and scale: a zoom at or under 100 % makes none, over it one per power of two, and panning makes none', async ({ page, request }) => {
    const big = BIG(PERSONAL);
    await seed(page, request, [big]);
    const at = (s: number, wx = big.x + big.w / 2): Promise<void> => aim(page, s, wx, big.y + big.h - 60);
    const rasters = (): Promise<number> => page.evaluate(() => __maDesk.etchRasters());
    await at(1);
    const before = await rasters();
    // At or under 100 % the name and the icons are the 100 % bitmaps, scaled down.
    for (const s of [0.3, 0.5, 0.77, 0.9]) await at(s);
    await at(0.9, big.x + 300); // a pan
    expect(await rasters()).toBe(before);
    // Over it they're cut again at twice the device scale up to 200 %, and at four times past it: once each.
    await at(1.3);
    const twice = await rasters();
    expect(twice).toBeGreaterThan(before);
    await at(1.9);
    expect(await rasters()).toBe(twice);
    await at(2.2);
    const four = await rasters();
    expect(four).toBeGreaterThan(twice);
    for (const s of [3, 2.6, 1.3, 0.9]) await at(s);
    await at(1.3, big.x + 300);
    await at(0.9);
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    expect(await rasters()).toBe(four);
  });

  test('a camera move renders nothing, draws no new bitmap, and holds the cut, out past where the name hides and back', async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w['__commits'] = 0;
      w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
        isDisabled: false, supportsFiber: true, renderers: new Map(), inject: () => 1, checkDCE: () => {},
        onScheduleFiberRoot: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: () => { w['__commits'] = (w['__commits'] as number) + 1; },
      };
    });
    const small = { id: PERSONAL, x: 0, y: 0, w: 600, h: 300, items: [tile(PERSONAL, 'chat', 24, 24)] };
    await seed(page, request, [small], { [PERSONAL]: 'The very long name of a desk that a member chose' });
    await aim(page, 1, 300, 150);
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 10); // into free mode, which is a render
    await page.waitForTimeout(400);
    const cutAtRest = (await drawnName(page, PERSONAL)).text;
    await page.evaluate(() => {
      const frames: { moving: boolean; commits: number; rasters: number; drawn: string; s: number }[] = [];
      (window as unknown as { __frames: typeof frames }).__frames = frames;
      const loop = (): void => {
        const { camera, etchRasters } = __maDesk;
        frames.push({
          moving: camera.isMoving(),
          commits: (window as unknown as { __commits: number }).__commits,
          rasters: etchRasters(),
          drawn: camera.getStage().findOne(`#desk-d-personal00001`).findOne('.desk-name').getAttr('drawn') as string,
          s: camera.cam.s,
        });
        if (frames.length < 600) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    for (let i = 0; i < 30; i += 1) {
      await page.mouse.wheel(0, 60); // out to the smallest zoom, past 50 %, where the name hides
      await page.waitForTimeout(14);
    }
    for (let i = 0; i < 15; i += 1) {
      await page.mouse.wheel(0, -60); // and back in past it, to under 100 %
      await page.waitForTimeout(14);
    }
    await page.waitForTimeout(500);
    const frames = await page.evaluate(() => (window as unknown as { __frames: { moving: boolean; commits: number; rasters: number; drawn: string; s: number }[] }).__frames);
    // A slow machine might settle between wheel events, so go by each unbroken run of frames in motion.
    const runs: (typeof frames)[] = [];
    frames.forEach((f, i) => {
      if (!f.moving) return;
      if (!frames[i - 1]?.moving) runs.push([]);
      runs[runs.length - 1]!.push(f);
    });
    expect(runs.reduce((n, run) => n + run.length, 0)).toBeGreaterThan(10);
    for (const run of runs) {
      expect(new Set(run.map((f) => f.commits)).size, 'renders during a move').toBe(1);
      expect(new Set(run.map((f) => f.rasters)).size, 'bitmaps during a move').toBe(1);
      // The cut is in desk units, so a zoom doesn't change it: one cut, or nothing where the name is under 7 px.
      expect(new Set(run.map((f) => f.drawn).filter(Boolean)).size, 'the cut held during a move').toBeLessThanOrEqual(1);
    }
    expect(runs[0]![0]!.drawn).toBe(cutAtRest);
    // Out past 50 % it hid.
    expect(Math.min(...frames.map((f) => f.s))).toBeLessThan(0.5);
    expect(runs.flat().some((f) => !f.drawn)).toBe(true);
    // It lands, and fits at rest, the same: at most one new bitmap per landing.
    const last = frames[frames.length - 1]!;
    expect(last.moving).toBe(false);
    expect(last.drawn).toBe(cutAtRest);
    expect(last.rasters - runs[0]![0]!.rasters).toBeLessThanOrEqual(runs.length);
  });

  test('a desk that\'s off screen does none of this', async ({ page, request }) => {
    const far = (id: string, x: number): Seed => ({ id, x, y: 0, w: 800, h: 300, items: [tile(id, 'chat', 24, 24)] });
    await seed(page, request, [far(PERSONAL, 0), far(WORK, 9000)]);
    await aim(page, 1, 400, 150);
    const before = { near: await drawnName(page, PERSONAL), far: await drawnName(page, WORK) };
    await page.mouse.move(720, 450);
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 40);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
    expect((await drawnName(page, PERSONAL)).y).not.toBe(before.near.y); // it zoomed about the desk's center, so its x stayed
    expect(await drawnName(page, WORK)).toEqual(before.far);
  });

  for (const scale of [1, 2]) {
    test(`at ${scale}x, moving follows the desk, and landing on a whole pixel is under a device pixel on each axis, and doesn't hop`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await page.request.post('/__harness', { data: { reset: true } });
      const big = BIG(PERSONAL);
      await seed(page, page.request, [big]);
      await aim(page, 0.8, big.x + big.w / 2, big.y + big.h - 100);
      await page.mouse.move(700, 400);
      await page.evaluate(() => {
        const landings: { moving: { x: number; y: number }; rest: { x: number; y: number }; off: number }[] = [];
        (window as unknown as { __landings: typeof landings }).__landings = landings;
        let last: { x: number; y: number } | null = null;
        let fractions = 0;
        let since = 0;
        const loop = (): void => {
          const { camera } = __maDesk;
          const n = camera.getStage().findOne('#desk-d-personal00001').findOne('.desk-name');
          const at = { x: n.getAttr('drawnX') as number, y: n.getAttr('drawnY') as number };
          if (camera.isMoving()) {
            last = at;
            since = 0;
            if (at.x * camera.dpr() % 1 !== 0) fractions += 1;
          } else if (last) {
            // The frame after the camera stops has yet to draw.
            since += 1;
            if (since >= 3) {
              landings.push({ moving: last, rest: at, off: fractions });
              last = null;
            }
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      for (let g = 0; g < 12; g += 1) {
        for (let i = 0; i < 4; i += 1) {
          await page.mouse.wheel(0, g % 2 ? 37 : -41);
          await page.waitForTimeout(16);
        }
        await page.mouse.move(700 + g * 3, 400 + g);
        await page.waitForTimeout(500);
      }
      const landings = await page.evaluate(() => (window as unknown as { __landings: { moving: { x: number; y: number }; rest: { x: number; y: number }; off: number }[] }).__landings);
      expect(landings.length).toBeGreaterThanOrEqual(8);
      const hops = landings.flatMap((l) => [Math.abs(l.rest.x - l.moving.x), Math.abs(l.rest.y - l.moving.y)]);
      const worst = Math.max(...hops);
      console.log(`largest landing at ${scale}x: ${worst.toFixed(3)} CSS px, ${(worst * scale).toFixed(3)} device px, over ${landings.length} landings`);
      // Half a device pixel for the camera's own landing, and half for the strip's on top of it.
      expect(worst * scale).toBeLessThanOrEqual(1 + 1e-6);
      expect(landings[landings.length - 1]!.off, 'moving, it isn\'t held to whole pixels').toBeGreaterThan(0);
      await ctx.close();
    });
  }

  // ----- the icons
  const WORK_X = 700;
  const WITH_WORK = (): Seed[] => [
    { id: PERSONAL, x: 0, y: 0, w: 600, h: 300, items: [tile(PERSONAL, 'chat', 24, 24)] }, // tidy, and the first: it has the ring
    { id: WORK, x: WORK_X, y: 0, w: 800, h: 300, items: [tile(WORK, 'chat', 200, 100)] }, // not tidy, and needs the pointer
  ];
  const WORK_MID = WORK_X + 400;
  const WORK_END = WORK_X + 800;

  test('at rest nothing shows. With the pointer on the desk the grip and sparkle are in their slots, and the count\'s slot is empty', async ({ page, request }) => {
    const errors = watchConsole(page);
    await seed(page, request, WITH_WORK());
    await aim(page, 1, WORK_MID, 150);
    const r = await rectOf(page, WORK);
    const counts = async (): Promise<number[]> => Promise.all([iconBox(r, GRIP), iconBox(r, SPARKLE), { x: r.right - COUNT.x - COUNT.w, y: r.bottom - 36, w: COUNT.w, h: 28 }].map(async (b) => (await inkIn(page, b)).count));
    await page.mouse.move(r.left - 40, r.top - 40);
    await page.waitForTimeout(200);
    expect(await counts()).toEqual([0, 0, 0]);
    await page.mouse.move(r.left + 40, r.top + 30);
    await page.waitForTimeout(200);
    const [grip, sparkle, count] = await counts();
    expect(grip).toBeGreaterThan(20);
    expect(sparkle).toBeGreaterThan(20);
    expect(count).toBe(0);
    // Each on the line, and at 16 px or under, with its lip.
    for (const [from, name] of [[GRIP, 'grip'], [SPARKLE, 'sparkle']] as const) {
      const ink = await inkIn(page, iconBox(r, from));
      expect(ink.x1 - ink.x0, name).toBeLessThanOrEqual(17);
      expect(ink.y1 - ink.y0, name).toBeLessThanOrEqual(17);
      expect(Math.abs((ink.y0 + ink.y1) / 2 - (r.bottom - 22)), name).toBeLessThanOrEqual(4);
    }
    await page.screenshot({ path: 'test-results/shots/strip-hover.png', clip: { x: r.right - 220, y: r.bottom - 60, width: 220, height: 70 } });

    // Nothing slides when what's in cleanup's slot changes.
    const gripBefore = await inkIn(page, iconBox(r, GRIP));
    await page.mouse.click(r.right - SPARKLE, r.bottom - 22);
    await page.waitForTimeout(120);
    await expect(page.getByRole('button', { name: 'Undo clean up Work desk' })).toHaveCount(1);
    expect((await inkIn(page, iconBox(r, GRIP))).sig).toBe(gripBefore.sig);
    expect(await hitAt(page, r.right - SPARKLE, r.bottom - 22)).toBe('desk-undo');
    await page.screenshot({ path: 'test-results/shots/strip-undo.png', clip: { x: r.right - 220, y: r.bottom - 60, width: 220, height: 70 } });
    expect(errors).toEqual([]);
  });

  test('a tidy desk shows only the grip and the carousel\'s switch, and its ring shows them without the pointer', async ({ page, request }) => {
    await seed(page, request, WITH_WORK());
    await aim(page, 1, 300, 150);
    const r = await rectOf(page, PERSONAL);
    await page.mouse.move(10, 500);
    await page.waitForTimeout(200);
    expect((await inkIn(page, iconBox(r, GRIP))).count).toBeGreaterThan(20);
    expect((await inkIn(page, iconBox(r, SWITCH))).count).toBeGreaterThan(20);
    expect((await inkIn(page, iconBox(r, SPARKLE))).count).toBe(0);
  });

  test('on hover an icon has surface.fill behind it, in a box its target\'s size', async ({ page, request }) => {
    await setTheme(page, 'light');
    await seed(page, request, WITH_WORK());
    await aim(page, 1, WORK_MID, 150);
    const r = await rectOf(page, WORK);
    const pixel = (x: number, y: number): Promise<number[]> => page.evaluate((p) => Array.from(__maDesk.camera.getStage().getLayers()[0]!.getCanvas().getContext()._context.getImageData(p.x, p.y, 1, 1).data.slice(0, 3)), { x, y });
    const PANEL = [0xfd, 0xfd, 0xfd];
    const FILL = [0xec, 0xee, 0xf2];
    await page.mouse.move(r.left + 40, r.top + 30);
    await page.waitForTimeout(150);
    expect(await pixel(r.right - 20, r.bottom - 34)).toEqual(PANEL);
    await page.mouse.move(r.right - GRIP, r.bottom - 22);
    await page.waitForTimeout(150);
    expect(await pixel(r.right - 20, r.bottom - 34)).toEqual(FILL); // inside it
    expect(await pixel(r.right - 20, r.bottom - 37)).toEqual(PANEL); // above it
    expect(await pixel(r.right - SPARKLE, r.bottom - 34)).toEqual(PANEL); // and not behind the other
    await page.mouse.move(r.right - SPARKLE, r.bottom - 22);
    await page.waitForTimeout(150);
    expect(await pixel(r.right - SPARKLE, r.bottom - 34)).toEqual(FILL);
    expect(await pixel(r.right - 20, r.bottom - 34)).toEqual(PANEL);
  });

  test('targets are 28 at 100 %, times the zoom, the grip\'s runs on into the corner, cleanup\'s is the grip\'s neighbour, and under 50 % there are none', async ({ page, request }) => {
    await seed(page, request, WITH_WORK());
    for (const s of [0.37, 0.5, 1, 1.4]) {
      await aim(page, s, WORK_END, 300);
      const r = await rectOf(page, WORK);
      await page.mouse.move(r.right - 300 * s, r.top + 10);
      await page.waitForTimeout(150);
      const where = `at ${s}`;
      // In desk units from the corner. `p` is a pixel on screen: the edges are on fractions of one now, and the hit graph
      // is on whole pixels, so a press a pixel in from an edge is the nearest that's sure to be in.
      const at = (dx: number, dy: number): Promise<string> => hitIn(page, r, dx, dy);
      const p = 1 / s;
      // The carousel's switch is the grip's neighbour on a desk 300 units wide or more, and cleanup's is the switch's.
      const c = (r.right - r.left) / s >= 300 ? 36 : 0;
      if (s < 0.5) {
        // The icons hide with the name: in the strip a press is the desk's, and the corner is the panel's round one.
        for (const [dx, dy] of [[GRIP, 22], [6 + p, 22], [56, 22], [(56 + c), 22], [101, 22]] as const) expect(await at(dx, dy), where).toBe('desk');
        expect(await at(p, p), where).not.toBe('resize-handle');
        continue;
      }
      expect(await at(6 + p, 22), where).toBe('resize-handle');
      expect(await at(34 - p, 22), where).toBe('resize-handle');
      expect(await at(GRIP, 36 - p), where).toBe('resize-handle');
      expect(await at(p, p), where).toBe('resize-handle'); // the corner
      expect(await at(34 + p, 22), where).toBe('desk');
      expect(await at(GRIP, 36 + p), where).toBe('desk');
      if (c) {
        expect(await at(42 + p, 22), where).toBe('desk-carousel');
        expect(await at(70 - p, 22), where).toBe('desk-carousel');
        expect(await at(74, 22), where).toBe('desk'); // the gap between the switch's and cleanup's
      }
      expect(await at(42 + p + c, 22), where).toBe('desk-cleanup');
      expect(await at(70 - p + c, 22), where).toBe('desk-cleanup');
      expect(await at((56 + c), 8 + p), where).toBe('desk-cleanup');
      expect(await at((56 + c), 36 - p), where).toBe('desk-cleanup');
      expect(await at(38, 22), where).toBe('desk'); // the gap between the grip's and its neighbour
      expect(await at(70 + p + c, 22), where).toBe('desk');
      expect(await at((56 + c), 8 - p), where).toBe('desk');
      expect(await at(101 + c, 22), where).toBe('desk'); // the count's slot, with no count
    }
  });

  test('at high zoom the row scales with the corner, so it needs no inset to stay on the panel, and press and proxy go with it', async ({ page, request }) => {
    await seed(page, request, WITH_WORK());
    await aim(page, 3, WORK_END - 100, 250);
    const r = await rectOf(page, WORK);
    await page.mouse.move(r.right - 400, r.bottom - 300);
    await page.waitForTimeout(150);
    // The corner's 22 and the row are both in desk units, so the row is where it is at 100 %, times the zoom.
    const ink = await inkIn(page, iconBox(r, GRIP, r.s));
    expect(ink.count).toBeGreaterThan(20);
    expect(await hitIn(page, r, GRIP, 22)).toBe('resize-handle');
    expect(await hitIn(page, r, SPARKLE, 22)).toBe('desk-cleanup');
    const proxy = (await page.getByRole('button', { name: 'Clean up Work desk' }).boundingBox())!;
    expect(Math.abs(proxy.x + proxy.width / 2 - (r.right - SPARKLE * r.s))).toBeLessThan(0.51);
    expect(Math.abs(proxy.y + proxy.height / 2 - (r.bottom - 22 * r.s))).toBeLessThan(0.51);
    await page.screenshot({ path: 'test-results/shots/strip-corner-at-3x.png', clip: { x: r.right - 360, y: r.bottom - 160, width: 380, height: 180 } });
  });

  test('they hide on a desk under 290 wide at any zoom, and on any desk under 50 %, and then a press there is the desk\'s', async ({ page, request }) => {
    // 289 and 290 wide, in desk units, and a flat one for the zoom. A desk is at least 124 tall, so the 72 never decides.
    const narrow: Seed = { id: PERSONAL, x: 0, y: 0, w: 289, h: 400, items: [tile(PERSONAL, 'chat', 24, 24)] };
    const flat: Seed = { id: WORK, x: WORK_X, y: 0, w: 1000, h: 144, items: [tile(WORK, 'chat', 200, 24)] };
    const wide: Seed = { id: GUILD, x: WORK_X + 1100, y: 0, w: 290, h: 400, items: [tile(GUILD, 'chat', 24, 24)] };
    await seed(page, request, [narrow, flat, wide]);
    // At 50 % the name is 7 px, and they show; just under, they're gone.
    await aim(page, 0.5, WORK_X + 500, 72);
    let r = await rectOf(page, WORK);
    await page.mouse.move(r.left + 30, r.top + 12);
    await page.waitForTimeout(150);
    expect(await hitIn(page, r, GRIP, 22)).toBe('resize-handle');
    expect((await inkIn(page, iconBox(r, GRIP, r.s))).count).toBeGreaterThan(5);
    await aim(page, 0.49, WORK_X + 500, 72);
    r = await rectOf(page, WORK);
    await page.mouse.move(r.left + 30, r.top + 8);
    await page.waitForTimeout(150);
    expect(await hitIn(page, r, GRIP, 22)).toBe('desk');
    expect(await hitIn(page, r, SPARKLE, 22)).toBe('desk');
    expect((await inkIn(page, { x: r.right - 40 * r.s, y: r.bottom - 32 * r.s, w: 28 * r.s, h: 20 * r.s })).count).toBe(0);

    // 290 wide: they show, though at 0.73 it's 212 px on screen.
    await aim(page, 0.73, wide.x + 145, 200);
    r = await rectOf(page, GUILD);
    expect(r.w).toBeLessThan(290);
    await page.mouse.move(r.left + 12, r.top + 12);
    await page.waitForTimeout(150);
    expect(await hitIn(page, r, GRIP, 22)).toBe('resize-handle');
    // 289 wide: they don't, though at 1.5 it's 433 px on screen.
    await aim(page, 1.5, narrow.x + 144.5, 200);
    r = await rectOf(page, PERSONAL);
    expect(r.w).toBeGreaterThan(290);
    await page.mouse.move(r.left + 12, r.top + 12);
    await page.waitForTimeout(150);
    expect(await hitIn(page, r, GRIP, 22)).toBe('desk');
    expect((await inkIn(page, { x: r.right - 34 * r.s, y: r.bottom - 32 * r.s, w: 28 * r.s, h: 20 * r.s })).count).toBe(0);
  });

  test('an app right above the strip never covers an icon, since the icons scale with the desk: a press on the app is the app\'s, on an icon the icon\'s, and under 50 % the desk\'s', async ({ page, request }) => {
    // An app in the work area's bottom right corner, right above the strip. Apps stop at the strip's top edge, 44 up, and the
    // icons are in the strip at every zoom (ADR 0064, Nov 9 note), so no app is ever over one.
    const under: Seed = { id: WORK, x: WORK_X, y: 0, w: 1000, h: 700, items: [tile(WORK, 'chat', 1000 - 8 - 460, 700 - 44 - 200, 460, 200)] };
    await seed(page, request, [WITH_WORK()[0]!, under]);
    // At 0.3 the icons are hidden with the name: in the strip a press is the desk's, and above it the app's.
    await aim(page, 0.3, WORK_X + 500, 350);
    let r = await rectOf(page, WORK);
    await page.mouse.move(r.left + 12, r.top + 12);
    await page.waitForTimeout(200);
    expect(await hitIn(page, r, GRIP, 22)).toBe('desk');
    expect(await hitIn(page, r, SPARKLE, 22)).toBe('desk');
    expect(await hitIn(page, r, GRIP, 60)).toBe('app-tile');
    // At 0.6 they show, under the app's bottom edge, and are drawn whole.
    await aim(page, 0.6, WORK_X + 500, 350);
    r = await rectOf(page, WORK);
    await page.mouse.move(r.left + 12, r.top + 12);
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'test-results/shots/strip-under-app.png', clip: { x: r.right - 200, y: r.bottom - 90, width: 210, height: 100 } });
    const c = (r.right - r.left) / r.s >= 300 ? 36 : 0; // the carousel's switch takes a slot on a desk this wide
    expect(await hitIn(page, r, GRIP, 22)).toBe('resize-handle');
    expect(await hitIn(page, r, (56 + c), 22)).toBe('desk-cleanup');
    expect(await hitIn(page, r, GRIP, 60)).toBe('app-tile');
    expect(await hitIn(page, r, (56 + c), 60)).toBe('app-tile');
    expect((await inkIn(page, iconBox(r, GRIP, r.s))).count).toBeGreaterThan(10);
    // A drag from the app above the icons, clear of its own corner handle, moves the app, and doesn't resize the desk.
    const app = page.locator(`[id="proxy-${WORK}:chat"]`);
    const place = (): Promise<number> => app.evaluate((el: HTMLElement) => parseFloat(el.style.left));
    const before = await place();
    const from = { x: r.right - SPARKLE * r.s, y: r.bottom - 100 * r.s };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 60, from.y - 20, { steps: 6 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await place()).toBeLessThan(before - 50);
    const after = await rectOf(page, WORK);
    expect(after.w).toBe(r.w);
    expect(after.h).toBe(r.h);
  });

  async function dragGrip(page: Page, id: string, s: number, world: { x: number; y: number }): Promise<void> {
    await aim(page, s, world.x, world.y);
    const r = await rectOf(page, id);
    const cornerAt = (): Promise<{ x: number; y: number }> => page.evaluate((deskId) => __maDesk.camera.getStage().findOne(`#desk-${deskId}`).findOne('.resize-handle').getAbsolutePosition(), id);
    const from = { x: r.right - GRIP * s, y: r.bottom - 22 * s };
    await page.mouse.move(from.x, from.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    const start = await cornerAt();
    const offset = { x: from.x - start.x, y: from.y - start.y };
    for (const [dx, dy] of [[6, 4], [10, 7], [41, 23], [-20, 90], [73, 41]] as const) {
      await page.mouse.move(from.x + dx, from.y + dy, { steps: 3 });
      const at = await cornerAt();
      // Exactly under the pointer, on screen, at this zoom.
      expect(Math.abs(at.x + offset.x - (from.x + dx)), `x at ${s}`).toBeLessThanOrEqual(0.51);
      expect(Math.abs(at.y + offset.y - (from.y + dy)), `y at ${s}`).toBeLessThanOrEqual(0.51);
    }
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await rectOf(page, id);
    expect(Math.abs(after.right - (r.right + 73))).toBeLessThan(1);
    expect(Math.abs(after.bottom - (r.bottom + 41))).toBeLessThan(1);
  }

  // 50 % is the lowest zoom the grip shows at.
  for (const s of [0.5, 0.62, 1, 2.2]) {
    test(`dragging the grip at zoom ${s} follows the pointer exactly, and the size lands in units`, async ({ page, request }) => {
      await seed(page, request, WITH_WORK());
      const before = 800;
      await dragGrip(page, WORK, s, { x: WORK_END, y: 300 });
      await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
      const doc = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2')!) as { desks: Record<string, { w: number; h: number }> });
      expect(Math.abs(doc.desks[WORK]!.w - (before + 73 / s))).toBeLessThan(1 / s);
      expect(Math.abs(doc.desks[WORK]!.h - (300 + 41 / s))).toBeLessThan(1 / s);
    });
  }

  test('under 50 % there\'s no grip: at 0.37 and 0.45 a press where it would be is the desk\'s, and a drag there moves the desk and doesn\'t resize it', async ({ page, request }) => {
    await seed(page, request, WITH_WORK());
    for (const s of [0.45, 0.37]) {
      await aim(page, s, WORK_END, 300);
      const r = await rectOf(page, WORK);
      await page.mouse.move(r.right - 300 * s, r.top + 10);
      await page.waitForTimeout(150);
      expect(await hitIn(page, r, GRIP, 22), `at ${s}`).toBe('desk');
    }
    const r = await rectOf(page, WORK);
    const from = { x: r.right - GRIP * r.s, y: r.bottom - 22 * r.s };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 73, from.y + 41, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
    const doc = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2')!) as { desks: Record<string, { x: number; w: number; h: number }> });
    expect(doc.desks[WORK]!.x).toBeGreaterThan(WORK_X + 100);
    expect(doc.desks[WORK]!.w).toBe(800);
    expect(doc.desks[WORK]!.h).toBe(300);
  });

  test('at low zoom the corner still stops at what the desk holds', async ({ page, request }) => {
    await seed(page, request, WITH_WORK());
    await aim(page, 0.5, 1200, 300); // the lowest zoom the grip shows at
    const r = await rectOf(page, WORK);
    await page.mouse.move(r.right - GRIP * r.s, r.bottom - 22 * r.s);
    await page.mouse.down();
    await page.mouse.move(r.right - 2000, r.bottom - 1500, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await rectOf(page, WORK);
    expect(after.w / 0.5).toBeCloseTo(200 + 76 + 8, 0);
    expect(after.h / 0.5).toBeCloseTo(100 + 76 + 44, 0);
  });

  // Low and high: 0.6, since under 50 % there's no grip to drag.
  for (const s of [0.6, 1.6]) {
    test(`at zoom ${s}, at the viewport's edge the camera still pans, and the corner stays under a still pointer`, async ({ page, request }) => {
      await seed(page, request, WITH_WORK());
      await aim(page, s, WORK_END, 300);
      const r = await rectOf(page, WORK);
      const from = { x: r.right - GRIP * s, y: r.bottom - 22 * s };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(1430, from.y, { steps: 12 });
      const camAt = (): Promise<Cam> => page.evaluate(() => ({ ...__maDesk.camera.cam }));
      const cornerAt = (): Promise<{ x: number; y: number }> => page.evaluate((deskId) => __maDesk.camera.getStage().findOne(`#desk-${deskId}`).findOne('.resize-handle').getAbsolutePosition(), WORK);
      const c0 = await camAt();
      const k0 = await cornerAt();
      await page.waitForTimeout(600);
      const c1 = await camAt();
      const k1 = await cornerAt();
      expect(c1.x).toBeLessThan(c0.x - 50);
      expect(c1.s).toBe(c0.s);
      expect(Math.abs(k1.x - k0.x)).toBeLessThan(3);
      await page.mouse.up();
    });
  }

  test('the proxy for cleanup is where the icon is, at its size, 28 at 100 % times the zoom, as the sparkle and as "Undo", and stays when the icon hides', async ({ page, request }) => {
    await seed(page, request, WITH_WORK());
    for (const s of [0.37, 0.62, 1, 1.75, 2.6]) {
      await aim(page, s, WORK_END - 100 / s, 300 - 100 / s);
      const r = await rectOf(page, WORK);
      await page.mouse.move(r.right - 200, r.bottom - 100);
      await page.waitForTimeout(120);
      const box = (await page.getByRole('button', { name: 'Clean up Work desk' }).boundingBox())!;
      expect(box.width, `at ${s}`).toBeCloseTo(28 * s, 1);
      expect(box.height, `at ${s}`).toBeCloseTo(28 * s, 1);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (s < 0.5) {
        // Under 50 % the icon hides with the name, and the proxy stays for the keyboard: a press there is the desk's.
        expect(await hitAt(page, cx, cy), `at ${s}`).toBe('desk');
        expect((await inkIn(page, { x: box.x, y: box.y, w: box.width, h: box.height })).count, `at ${s}`).toBe(0);
        continue;
      }
      expect(await hitAt(page, cx, cy), `at ${s}`).toBe('desk-cleanup');
      expect(await hitAt(page, box.x + 1, box.y + 1), `at ${s}`).toBe('desk-cleanup');
      expect(await hitAt(page, box.x + box.width - 1, box.y + box.height - 1), `at ${s}`).toBe('desk-cleanup');
      // And it's over the sparkle: its ink is centered in the proxy.
      const ink = await inkIn(page, { x: box.x + 4 * s, y: box.y + 4 * s, w: 20 * s, h: 20 * s });
      expect(ink.count, `at ${s}`).toBeGreaterThan(20 * Math.min(1, s * s));
      expect(Math.abs((ink.x0 + ink.x1) / 2 - cx), `at ${s}`).toBeLessThanOrEqual(1.5 * Math.max(1, s));
      expect(Math.abs((ink.y0 + ink.y1) / 2 - cy), `at ${s}`).toBeLessThanOrEqual(1.5 * Math.max(1, s));
    }
    const s = 0.62;
    await aim(page, s, WORK_END - 100 / s, 300 - 100 / s);
    await page.getByRole('button', { name: 'Clean up Work desk' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    const undo = (await page.getByRole('button', { name: 'Undo clean up Work desk' }).boundingBox())!;
    expect(undo.width).toBeGreaterThan(28 * s);
    expect(undo.height).toBeCloseTo(28 * s, 1);
    expect(await hitAt(page, undo.x + 1, undo.y + undo.height / 2)).toBe('desk-undo');
    expect(await hitAt(page, undo.x + undo.width - 1, undo.y + undo.height / 2)).toBe('desk-undo');
    await page.screenshot({ path: 'test-results/shots/strip-undo-ring.png', clip: { x: undo.x - 40, y: undo.y - 20, width: undo.width + 100, height: 70 } });
  });

  test('on touch the targets are 44 at 100 %, times the zoom', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await page.request.post('/__harness', { data: { reset: true } });
    await seed(page, page.request, [{ id: PERSONAL, x: 0, y: 0, w: 800, h: 500, items: [tile(PERSONAL, 'chat', 300, 200)] }]);
    for (const s of [0.5, 1, 1.5]) {
      await aim(page, s, 700, 400);
      const r = await rectOf(page, PERSONAL);
      const p = 1 / s; // a pixel on screen, in desk units
      expect(await hitIn(page, r, p, p), `at ${s}`).toBe('resize-handle');
      expect(await hitIn(page, r, 44 - p, 44 - p), `at ${s}`).toBe('resize-handle');
      // The grip's neighbour, on touch a target being its own margin: the carousel's switch on a desk 300 units wide or more, then cleanup.
      const c = (r.right - r.left) / s >= 300 ? 44 : 0;
      if (c) expect(await hitIn(page, r, 46, 22), `at ${s}`).toBe('desk-carousel');
      expect(await hitIn(page, r, 46 + c, 22), `at ${s}`).toBe('desk-cleanup');
      expect(await hitIn(page, r, 90 + c, 22), `at ${s}`).toBe('desk');
      const box = (await page.getByRole('button', { name: 'Clean up Personal desk' }).boundingBox())!;
      expect(box.width, `at ${s}`).toBeCloseTo(44 * s, 1);
      expect(box.height, `at ${s}`).toBeCloseTo(44 * s, 1);
      expect(await hitAt(page, box.x + 1, box.y + 1), `at ${s}`).toBe('desk-cleanup');
      expect(await hitAt(page, box.x + box.width - 1, box.y + box.height - 1), `at ${s}`).toBe('desk-cleanup');
    }
    await ctx.close();
  });

  // ----- when there's no room
  test('the name ellipsizes in desk units, the same at every zoom: 12 from the edges, the icons going first under 290 wide clears the way, and under 50 % it hides', async ({ page, request }) => {
    const long = 'The very long name of a desk that a member chose for a guild';
    await seed(page, request, [
      { id: PERSONAL, x: 0, y: 0, w: 290, h: 400, items: [] },
      { id: WORK, x: 400, y: 0, w: 289, h: 400, items: [] },
      { id: GUILD, x: 800, y: 0, w: 400, h: 400, items: [] },
    ], { [PERSONAL]: long, [WORK]: long });
    const name = async (id: string): Promise<string> => (await drawnName(page, id)).text;
    // From 8 in, clear of the active desk's ring and glow, which scale with it, to `stop` from the right.
    const inkOfName = async (r: Rect, stop: number): Promise<Ink> => inkIn(page, { x: r.left + 8 * r.s, y: r.bottom - 32 * r.s, w: r.w - (8 + stop) * r.s, h: 20 * r.s });

    // The fit is in desk units (ADR 0064, Nov 9 note), so the cut is the same at every zoom the name shows at.
    let withIcons = '';
    let withoutIcons = '';
    for (const s of [0.5, 0.73, 1, 1.5]) {
      await aim(page, s, 345, 200);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(200);
      const at = `at ${s}`;
      // 290 wide: the icons show, so the name keeps 12 clear of the grip's slot, 34 in, which stays reserved at rest.
      let r = await rectOf(page, PERSONAL);
      const a = await name(PERSONAL);
      withIcons ||= a;
      expect(a, at).toBe(withIcons);
      let ink = await inkOfName(r, 35);
      expect(ink.x1, at).toBeLessThanOrEqual(r.right - (34 + 12) * s + 1);
      expect(ink.x0, at).toBeGreaterThanOrEqual(r.left + (34 + 12) * s - 1); // centered, so the same at its left
      // 289: they're gone, and it has the desk, to 12 from each edge.
      r = await rectOf(page, WORK);
      const b = await name(WORK);
      withoutIcons ||= b;
      expect(b, at).toBe(withoutIcons);
      ink = await inkOfName(r, 8);
      expect(ink.x1, at).toBeLessThanOrEqual(r.right - 12 * s + 1);
      expect(ink.x0, at).toBeGreaterThanOrEqual(r.left + 12 * s - 1);
      if (s === 1) await page.screenshot({ path: 'test-results/shots/strip-ellipsis.png', clip: { x: r.left - 400, y: r.top - 10, width: r.w + 410, height: r.h + 20 } });
    }
    expect(withIcons.endsWith('…')).toBe(true);
    expect(withoutIcons.endsWith('…')).toBe(true);
    expect(withoutIcons.length).toBeGreaterThan(withIcons.length);

    // Under 50 % it would be under 7 px: long or short, it hides. And it comes back as it was.
    for (const s of [0.45, 0.35, 0.2]) {
      await aim(page, s, 600, 200);
      for (const id of [PERSONAL, WORK, GUILD]) expect(await name(id), `${id} at ${s}`).toBe('');
    }
    await aim(page, 0.5, 600, 200);
    expect(await name(PERSONAL)).toBe(withIcons);
    expect(await name(WORK)).toBe(withoutIcons);
    expect(await name(GUILD)).toBe('GUILD');
  });

  test('a name is gone where it would be under 7 px, with nothing of it left, and comes back whole: a zoom never cuts it', async ({ page, request }) => {
    // The smallest desk. Its name's room is in desk units, 208 of it, so it holds all of PERSONAL at every zoom it shows at.
    await seed(page, request, [{ id: PERSONAL, x: 0, y: 0, w: 232, h: 124, items: [] }]);
    for (const s of [0.2, 0.45]) {
      await aim(page, s, 116, 62);
      expect((await drawnName(page, PERSONAL)).text, `at ${s}`).toBe('');
      const r = await rectOf(page, PERSONAL);
      expect((await inkIn(page, { x: r.left + 8, y: r.bottom - 20, w: r.w - 16, h: 18 })).count, `at ${s}`).toBe(0);
    }
    for (const s of [0.5, 0.6, 1]) {
      await aim(page, s, 116, 62);
      expect((await drawnName(page, PERSONAL)).text, `at ${s}`).toBe('PERSONAL');
    }
  });

  test('the name stays in the strip at every zoom, so an app right above it never covers it, and under 50 % it hides', async ({ page, request }) => {
    // An app right where the name goes, straight above the strip. The strip and the name scale together (ADR 0064, Nov 9
    // note): the capitals, 17 to 27 up, are always under the strip's top edge, 44 up, where apps stop.
    const covered: Seed = { id: PERSONAL, x: 0, y: 0, w: 584, h: 300, items: [tile(PERSONAL, 'chat', 292 - 85, 300 - 44 - 170, 170, 170)] };
    await seed(page, request, [covered]);
    for (const s of [1, 0.6, 0.5]) {
      await aim(page, s, 292, 150);
      const r = await rectOf(page, PERSONAL);
      expect((await drawnName(page, PERSONAL)).text, `at ${s}`).toBe('PERSONAL');
      if (s === 0.5) await page.screenshot({ path: 'test-results/shots/strip-name-under-app.png', clip: { x: r.left - 10, y: r.top - 10, width: r.w + 20, height: r.h + 20 } });
      // Nothing covers it: the middle of the name and its ends are ink.
      const middle = await inkIn(page, { x: r.cx - 6 * s, y: r.bottom - 30 * s, w: 12 * s, h: 14 * s });
      const end = await inkIn(page, { x: r.cx + 18 * s, y: r.bottom - 30 * s, w: 30 * s, h: 14 * s });
      expect(middle.count, `at ${s}`).toBeGreaterThan(0);
      expect(end.count, `at ${s}`).toBeGreaterThan(5 * s);
    }
    // At 0.32 it would be under 7 px: it hides, and nothing of it is left in the strip.
    await aim(page, 0.32, 292, 150);
    const r = await rectOf(page, PERSONAL);
    expect((await drawnName(page, PERSONAL)).text).toBe('');
    expect((await inkIn(page, { x: r.left + 8, y: r.bottom - 40 * r.s, w: r.w - 16, h: 38 * r.s })).count).toBe(0);
  });

  test('the name keeps 12 from the status line, in desk units, as both scale with the desk', async ({ page, request }) => {
    const long = 'A rather long name for this one desk';
    const seeds = [{ id: PERSONAL, x: 0, y: 0, w: 584, h: 300, items: [] }];
    await page.addInitScript((d) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', JSON.stringify(d));
    }, { desks: Object.fromEntries(seeds.map((d) => [d.id, d])), z: [PERSONAL] });
    await harness(request, { fleet: [desk(PERSONAL, long, 'personal', 'running')] });
    await refuseConnect(page, 503);
    await signIn(page, REAL_LINK);
    await expect(page.locator(`[id="proxy-${PERSONAL}"]`)).toHaveAccessibleName(/, reconnecting…$/);
    await page.waitForTimeout(600);
    for (const s of [0.8, 1.2, 1.7]) {
      await aim(page, s, 292, 150);
      const statusEnd = await page.evaluate((id) => {
        const line = __maDesk.camera.getStage().findOne(`#desk-${id}`).findOne('.desk-status');
        const c = new OffscreenCanvas(1, 1).getContext('2d')!;
        c.font = '13px "Inter Variable", system-ui';
        return line.getClientRect().x + c.measureText(line.text()).width * __maDesk.camera.cam.s;
      }, PERSONAL);
      const at = await drawnName(page, PERSONAL);
      expect(at.text.length, `at ${s}`).toBeGreaterThan(0);
      expect(at.x, `at ${s}`).toBeGreaterThanOrEqual(statusEnd + 12 * s - 1); // 12 at 100 %, times the zoom
    }
  });

  test('prefers-contrast: more draws the name and the icons in text.secondary, with no wall and no lip', async ({ page, request }) => {
    await setTheme(page, 'light');
    await seed(page, request, WITH_WORK());
    await aim(page, 1, WORK_MID, 150);
    const r = await rectOf(page, WORK);
    await page.mouse.move(r.left + 40, r.top + 30);
    await page.waitForTimeout(150);
    const name = await inkIn(page, nameBox(r, 60));
    const grip = await inkIn(page, iconBox(r, GRIP));
    const sparkle = await inkIn(page, iconBox(r, SPARKLE));
    // Light's wall is #3A3F47.
    expect(name.darkest).toBeLessThan(0x50);
    expect(grip.darkest).toBeLessThan(0x5c); // antialiased along its slope, at 1x
    await page.emulateMedia({ contrast: 'more' });
    await page.waitForTimeout(200);
    const plainName = await inkIn(page, nameBox(r, 60));
    const plainGrip = await inkIn(page, iconBox(r, GRIP));
    const plainSparkle = await inkIn(page, iconBox(r, SPARKLE));
    // And text.secondary is #5F6166: the darkest thing that's left.
    for (const ink of [plainName, plainGrip, plainSparkle]) expect(ink.darkest).toBeGreaterThanOrEqual(0x5c);
    expect(plainName.sig).not.toBe(name.sig);
    expect(plainSparkle.sig).not.toBe(sparkle.sig);
    expect((await drawnName(page, WORK)).text).toBe('WORK');
    await page.screenshot({ path: 'test-results/shots/strip-more-contrast.png', clip: { x: r.right - 220, y: r.bottom - 60, width: 220, height: 70 } });
    await page.emulateMedia({ contrast: 'no-preference' });
    await page.waitForTimeout(200);
    expect((await inkIn(page, nameBox(r, 60))).sig).toBe(name.sig);
  });

  test('Jost 600 is there before the first bitmap, and is what\'s fetched', async ({ page, request }) => {
    const fonts: string[] = [];
    page.on('request', (q) => { if (q.url().includes('jost')) fonts.push(q.url()); });
    await page.addInitScript(() => {
      new PerformanceObserver((list) => {
        if (list.getEntriesByName('ma:first-canvas-paint').length) (window as unknown as { __jostAtPaint: boolean }).__jostAtPaint = document.fonts.check('600 14px "Jost"', 'PERSONAL');
      }).observe({ entryTypes: ['mark'] });
    });
    await seed(page, request, [BIG(PERSONAL)]);
    expect(await page.evaluate(() => (window as unknown as { __jostAtPaint: boolean }).__jostAtPaint)).toBe(true);
    expect(fonts.length).toBe(1);
    expect(fonts[0]).toMatch(/jost-latin-600-normal.*\.woff2$/);
  });

  test('a font that arrives late redraws the name and refits it, with no error and no reload', async ({ page, request }) => {
    const errors = watchConsole(page);
    let release = (): void => {};
    const held = new Promise<void>((done) => { release = done; });
    await page.route('**/jost-latin-600-normal*', async (route) => {
      await held;
      await route.continue();
    });
    const doc = { desks: { [PERSONAL]: BIG(PERSONAL) }, z: [PERSONAL] };
    await page.addInitScript((d) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', JSON.stringify(d));
    }, doc);
    await harness(request, { fleet: [personal('running')] });
    await signIn(page);
    await canvasPainted(page); // past the 800 ms it's waited for
    await aim(page, 1, 613, 700);
    const r = await rectOf(page, PERSONAL);
    expect(await page.evaluate(() => document.fonts.check('600 14px "Jost"', 'PERSONAL'))).toBe(false);
    const fallback = await inkIn(page, nameBox(r, 150));
    expect(fallback.count).toBeGreaterThan(50);
    release(); // and a screenshot waits for fonts, so none before this
    await page.waitForFunction(() => document.fonts.check('600 14px "Jost"', 'PERSONAL'));
    await expect.poll(async () => (await inkIn(page, nameBox(r, 150))).sig).not.toBe(fallback.sig);
    const jost = await inkIn(page, nameBox(r, 150));
    expect(Math.abs((jost.x0 + jost.x1) / 2 - r.cx)).toBeLessThanOrEqual(1.5); // measured again, so centered again
    expect((await drawnName(page, PERSONAL)).text).toBe('PERSONAL');
    expect(errors).toEqual([]);
  });

  // ----- screenshots to look at. Not a check: `web/CLAUDE.md`, step 2 of shipping.
  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    for (const scale of [1, 2]) {
      test(`screenshots, ${theme} at ${scale}x: at full detail and zoomed out, in the real app`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, baseURL: test.info().project.use.baseURL });
        const page = await ctx.newPage();
        await page.request.post('/__harness', { data: { reset: true } });
        await setTheme(page, theme);
        await signIn(page, '/?fixture=three');
        await canvasPainted(page);
        await page.waitForTimeout(600);
        // Something to clean up, so the sparkle offers, and the pointer on the desk so the grip shows.
        const app = (await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ }).boundingBox())!;
        await page.mouse.move(app.x + app.width / 2, app.y + app.height / 2);
        await page.mouse.down();
        await page.mouse.move(app.x + app.width / 2 + 12, app.y + app.height / 2 + 6, { steps: 4 });
        await page.mouse.up();
        await page.waitForTimeout(300);
        await page.mouse.move(app.x + app.width + 200, app.y + 4);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `test-results/shots/strip-${theme}-${scale}x-overview.png` });

        await page.keyboard.press('1');
        await page.waitForTimeout(800);
        const r = await rectOf(page, 'd-personal');
        await page.mouse.move(r.left + r.w / 2, r.top + 10);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `test-results/shots/strip-${theme}-${scale}x-full.png` });
        await page.screenshot({ path: `test-results/shots/strip-${theme}-${scale}x-full-crop.png`, clip: { x: r.left, y: r.bottom - 64, width: r.w, height: 72 } });

        await page.keyboard.press('0');
        await page.waitForTimeout(700);
        await page.evaluate(() => {
          const { camera } = __maDesk;
          camera.animateTo({ s: 0.42, x: camera.vp.w / 2 - 620 * 0.42, y: camera.vp.h / 2 - 230 * 0.42 }, 0);
        });
        await page.waitForTimeout(400);
        await page.screenshot({ path: `test-results/shots/strip-${theme}-${scale}x-zoomed-out.png` });
        await ctx.close();
      });

      test(`screenshot, ${theme} at ${scale}x: a small desk in the overview`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, baseURL: test.info().project.use.baseURL });
        const page = await ctx.newPage();
        await page.request.post('/__harness', { data: { reset: true } });
        await setTheme(page, theme);
        const row = (id: string, x: number, w: number, h: number, apps: string[]): Seed => ({ id, x, y: 0, w, h, items: apps.map((a, i) => tile(id, a, 24 + i * 92, 24)) });
        await seed(page, page.request, [
          row(PERSONAL, 0, 232, 124, ['chat']), // the smallest a desk can be
          row(WORK, 300, 584, 236, ['chat', 'notebook', 'browser', 'agent']),
          row(GUILD, 960, 584, 144, ['chat', 'notebook', 'browser', 'agent']), // apps right above the strip
        ]);
        await aim(page, 0.42, 770, 80);
        await page.mouse.move(5, 5);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `test-results/shots/strip-${theme}-${scale}x-small-desk-overview.png` });
        await ctx.close();
      });
    }
  }
});

// ----- apps move and resize freely, and anything can go over anything (ADR 0062, 0064).
test.describe('moving and resizing apps', () => {
  const CHAT = `${PERSONAL}:chat`;
  const NOTEBOOK = `${PERSONAL}:notebook`;
  const BROWSER = `${PERSONAL}:browser`;
  const AGENT = `${PERSONAL}:agent`;
  type Box = { x: number; y: number; w: number; h: number };

  /**
   * One desk, 800 x 500, four icons. Only the first load seeds it, so a reload shows what was saved. `stack` is stored
   * as given, and left out if there's none. `list` is the order of `items`, which is a phone's grid: Chat, Notebook,
   * Browser, Agent unless it says otherwise.
   */
  async function seeded(page: Page, request: APIRequestContext, at: Partial<Record<string, Box>> = {}, stack?: unknown, list: readonly string[] = []): Promise<void> {
    await page.addInitScript(({ id, chat, notebook, browser, agent, at: over, stack: order, list: listed }) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      const place = (key: string, app: string, x: number): Record<string, unknown> => ({ id: key, app, x, y: 24, w: 76, h: 76, ...over[key] });
      const items = [place(chat, 'chat', 24), place(notebook, 'notebook', 300), place(browser, 'browser', 500), place(agent, 'agent', 650)];
      if (listed.length) items.sort((a, b) => listed.indexOf(a['id'] as string) - listed.indexOf(b['id'] as string));
      localStorage.setItem('ma.layout.v2', JSON.stringify({ desks: { [id]: { id, x: 0, y: 36, w: 800, h: 500, items, ...(order === undefined ? {} : { stack: order }) } }, z: [id] }));
    }, { id: PERSONAL, chat: CHAT, notebook: NOTEBOOK, browser: BROWSER, agent: AGENT, at, stack, list });
    await harness(request, { fleet: [personal('running')] });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(800);
  }

  // A proxy's style holds an app's place in world units, relative to the world.
  const placeOf = async (page: Page, id: string): Promise<Box> => {
    const b = await page.locator(`[id="proxy-${id}"]`).evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
    return { ...b, y: b.y - 36 }; // this desk is at (0, 36), so these are the desk's coordinates
  };
  const scale = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __maDesk: { camera: { cam: { s: number } } } }).__maDesk.camera.cam.s);
  const centerOf = async (page: Page, id: string): Promise<{ x: number; y: number }> => {
    const b = (await page.locator(`[id="proxy-${id}"]`).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  async function dragApp(page: Page, id: string, dxUnits: number, dyUnits: number, steps = 10): Promise<void> {
    const c = await centerOf(page, id);
    const s = await scale(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + dxUnits * s, c.y + dyUnits * s, { steps });
    await page.mouse.up();
    await page.waitForTimeout(100);
  }

  async function resizeApp(page: Page, id: string, dxUnits: number, dyUnits: number, steps = 10): Promise<void> {
    const b = (await page.locator(`[id="proxy-${id}"]`).boundingBox())!;
    const s = await scale(page);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(80); // the corner shows on hover
    const from = { x: b.x + b.width - 4 * s, y: b.y + b.height - 4 * s };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dxUnits * s, from.y + dyUnits * s, { steps });
    await page.mouse.up();
    await page.waitForTimeout(100);
  }

  // A mouse event lands on a whole pixel, so a drag is exact to about a pixel.
  const near = (actual: number, expected: number): void => expect(Math.abs(actual - expected)).toBeLessThan(1);

  function clear(a: Box, b: Box): boolean {
    return a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01;
  }

  const ALL_APPS = [CHAT, NOTEBOOK, BROWSER, AGENT];

  async function expectOnDesk(page: Page, deskW = 800, deskH = 500): Promise<void> {
    for (const id of ALL_APPS) {
      const a = await placeOf(page, id);
      expect(a.x).toBeGreaterThanOrEqual(8 - 0.01);
      expect(a.y).toBeGreaterThanOrEqual(8 - 0.01);
      expect(a.x + a.w).toBeLessThanOrEqual(deskW - 8 + 0.01);
      expect(a.y + a.h).toBeLessThanOrEqual(deskH - 44 + 0.01);
      expect(a.w).toBeGreaterThanOrEqual(56);
      expect(a.h).toBeGreaterThanOrEqual(56);
    }
  }

  async function expectAllClear(page: Page, deskW = 800, deskH = 500): Promise<void> {
    await expectOnDesk(page, deskW, deskH);
    const boxes = await Promise.all(ALL_APPS.map((id) => placeOf(page, id)));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) expect(clear(boxes[i]!, boxes[j]!), `${JSON.stringify(boxes[i])} and ${JSON.stringify(boxes[j])}`).toBe(true);
    }
  }

  /** The apps as Konva will draw them, bottom to top. */
  const drawOrder = (page: Page): Promise<string[]> => page.evaluate((deskId) => {
    type N = { id(): string; find(q: string): N[]; findOne(q: string): N };
    const stage = (window as unknown as { __maDesk: { camera: { getStage(): N } } }).__maDesk.camera.getStage();
    return stage.findOne(`#desk-${deskId}`).find('.app-tile').map((n) => n.id().slice('tile-'.length));
  }, PERSONAL);
  const onTop = async (page: Page): Promise<string> => (await drawOrder(page)).at(-1)!;
  const savedDesk = (page: Page): Promise<{ stack?: string[]; items: { id: string }[] }> => page.evaluate((deskId) => (JSON.parse(localStorage.getItem('ma.layout.v2')!) as { desks: Record<string, { stack?: string[]; items: { id: string }[] }> }).desks[deskId]!, PERSONAL);
  /** The list as saved, which is a phone's grid. The mirror is debounced by 1 s. */
  const savedList = async (page: Page): Promise<string[]> => (await savedDesk(page)).items.map((i) => i.id);
  /** The stack as saved: its field, or the list's order if there's none. */
  const savedStack = async (page: Page): Promise<string[]> => {
    const d = await savedDesk(page);
    return d.stack ?? d.items.map((i) => i.id);
  };
  const storedDoc = (page: Page): Promise<string> => page.evaluate(() => localStorage.getItem('ma.layout.v2')!);
  const tileAt = (page: Page, id: string): Promise<{ x: number; y: number }> => page.evaluate((tile) => {
    const node = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): { x(): number; y(): number } } } } }).__maDesk.camera.getStage().findOne(`#tile-${tile}`);
    return { x: node.x(), y: node.y() };
  }, id);
  /** A point on the screen, from the desk's coordinates. */
  const onDesk = async (page: Page, x: number, y: number): Promise<{ x: number; y: number }> => {
    const d = (await page.locator(`[id="proxy-${PERSONAL}"]`).boundingBox())!;
    const s = await scale(page);
    return { x: d.x + x * s, y: d.y + y * s };
  };
  /** The apps' buttons, in the order the keyboard and a screen reader meet them. */
  const domOrder = (page: Page): Promise<string[]> => page.evaluate((ids) => Array.from(document.querySelectorAll('.proxy')).map((el) => el.id.slice('proxy-'.length)).filter((id) => ids.includes(id)), ALL_APPS);

  test('an app goes where it\'s dragged, with no grid, and stays there across a reload', async ({ page, request }) => {
    const errors = watchConsole(page);
    await seeded(page, request);
    await dragApp(page, CHAT, 37.5, 111.25);
    const place = await placeOf(page, CHAT);
    near(place.x, 24 + 37.5);
    near(place.y, 24 + 111.25);
    await page.screenshot({ path: 'test-results/shots/apps-moved.png' });

    await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(600);
    expect(await placeOf(page, CHAT)).toEqual(place);
    expect(errors).toEqual([]);
  });

  test('a drag doesn\'t open the app, and a click still does', async ({ page, request }) => {
    await seeded(page, request);
    await dragApp(page, CHAT, 60, 60);
    await expect(page.getByRole('dialog', { name: /Chat/ })).toHaveCount(0);
    const c = await centerOf(page, CHAT);
    await page.mouse.click(c.x, c.y);
    await expect(page.getByRole('dialog', { name: /Chat/ })).toBeVisible();
  });

  test('an app dragged over another ends overlapping it, exactly where it was dropped', async ({ page, request }) => {
    const errors = watchConsole(page);
    await seeded(page, request);
    await dragApp(page, CHAT, 300, 20); // onto the Notebook
    const place = await placeOf(page, CHAT);
    near(place.x, 324);
    near(place.y, 44);
    const notebook = await placeOf(page, NOTEBOOK);
    expect(notebook).toEqual({ x: 300, y: 24, w: 76, h: 76 }); // a drop never moves another app
    expect(clear(place, notebook)).toBe(false);
    expect(await onTop(page)).toBe(CHAT);
    await page.screenshot({ path: 'test-results/shots/apps-stacked.png' });
    expect(errors).toEqual([]);
  });

  test('dragged across and past another app, it stays with the pointer at every step, with no hop', async ({ page, request }) => {
    await seeded(page, request);
    const c = await centerOf(page, CHAT);
    const s = await scale(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 8 * s, c.y); // past the drag threshold
    // Over the Notebook at 300 and the Browser at 500, and out past both.
    for (let units = 16; units <= 620; units += 12) {
      await page.mouse.move(c.x + units * s, c.y);
      const at = await tileAt(page, CHAT);
      near(at.x, 24 + units);
      near(at.y, 24);
    }
    // And back again, at a slant, onto the Browser.
    for (let units = 620; units >= 440; units -= 12) {
      await page.mouse.move(c.x + units * s, c.y + (620 - units) * s * 0.2);
      const at = await tileAt(page, CHAT);
      near(at.x, 24 + units);
      near(at.y, 24 + (620 - units) * 0.2);
    }
    await page.mouse.up();
    await page.waitForTimeout(100);
    const place = await placeOf(page, CHAT);
    near(place.x, 24 + 440);
    near(place.y, 24 + 180 * 0.2);
    expect(await placeOf(page, BROWSER)).toEqual({ x: 500, y: 24, w: 76, h: 76 });
  });

  test('a single huge step lands on the far side of what it crossed', async ({ page, request }) => {
    await seeded(page, request);
    await dragApp(page, CHAT, 600, 0, 1);
    near((await placeOf(page, CHAT)).x, 624);
    await expectOnDesk(page);
  });

  test('a release lands exactly under the pointer, at once', async ({ page, request }) => {
    await seeded(page, request);
    const c = await centerOf(page, CHAT);
    const s = await scale(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 320 * s, c.y + 90 * s, { steps: 2 });
    await page.mouse.up();
    const place = await placeOf(page, CHAT);
    near(place.x, 344);
    near(place.y, 114);
  });

  // Chat is under the Notebook, sticking out to the right and below.
  const CHAT_UNDER: Box = { x: 320, y: 44, w: 76, h: 76 };

  test('where two apps overlap, the top one takes the hover and the click', async ({ page, request }) => {
    await seeded(page, request, { [CHAT]: CHAT_UNDER });
    expect(await onTop(page)).toBe(AGENT);
    const both = await onDesk(page, 350, 70);
    await page.mouse.move(both.x, both.y);
    await page.waitForTimeout(120);
    expect(await hoverNow(page)).toEqual({ corners: [`tile-${NOTEBOOK}`], names: ['Notebook'] });
    await page.mouse.click(both.x, both.y);
    await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Chat/ })).toHaveCount(0);
  });

  test('the lower app\'s visible part takes the hover, and pressing it raises it at once, before any drag', async ({ page, request }) => {
    await seeded(page, request, { [CHAT]: CHAT_UNDER }, [CHAT, NOTEBOOK, BROWSER, AGENT]);
    const visible = await onDesk(page, 386, 70); // Chat alone, and clear of its resize corner
    await page.mouse.move(visible.x, visible.y);
    await page.waitForTimeout(120);
    expect((await hoverNow(page)).corners).toEqual([`tile-${CHAT}`]);
    expect((await drawOrder(page)).indexOf(CHAT)).toBe(0);

    await page.mouse.down();
    await page.waitForTimeout(50);
    expect(await onTop(page)).toBe(CHAT);
    expect(await drawOrder(page)).toEqual([NOTEBOOK, BROWSER, AGENT, CHAT]);
    await page.mouse.up();
    await expect(page.getByRole('dialog', { name: /Chat/ })).toBeVisible(); // a click also opens it, as it did
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(300);

    // Chat now takes what the Notebook took.
    const both = await onDesk(page, 350, 70);
    await page.mouse.move(both.x, both.y);
    await page.waitForTimeout(120);
    expect((await hoverNow(page)).corners).toEqual([`tile-${CHAT}`]);
    await page.waitForTimeout(1_200);
    expect((await savedStack(page)).at(-1)).toBe(CHAT);
    expect(await savedList(page)).toEqual(ALL_APPS); // the list didn't move for it
  });

  test('a press on the app already on top changes nothing, not even a render', async ({ page, request }) => {
    await countCommits(page);
    await seeded(page, request, { [AGENT]: { x: 60, y: 60, w: 76, h: 76 } });
    const c = await centerOf(page, AGENT);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(120);
    const before = await commits(page);
    const stack = await drawOrder(page);
    await page.mouse.down();
    await page.waitForTimeout(100);
    expect(await commits(page) - before).toBe(0);
    expect(await drawOrder(page)).toEqual(stack);
    await page.mouse.move(c.x + 300, c.y + 300); // so the release is a drop, not a click
    await page.mouse.up();
  });

  test('what you grab is what moves: the raised app stays on top through a drag, and a render in the middle of it', async ({ page, request }) => {
    await countCommits(page);
    await seeded(page, request, { [CHAT]: CHAT_UNDER }, [CHAT, NOTEBOOK, BROWSER, AGENT]);
    const visible = await onDesk(page, 386, 70);
    const s = await scale(page);
    await page.mouse.move(visible.x, visible.y);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.mouse.move(visible.x + 20 * s, visible.y + 20 * s, { steps: 3 });
    await page.waitForTimeout(50);
    const raised = [NOTEBOOK, BROWSER, AGENT, CHAT];
    expect(await drawOrder(page)).toEqual(raised);

    // The privacy shield re-renders the desk and every app on it, with the drag still going.
    const before = await commits(page);
    await page.keyboard.press('\\');
    await page.waitForTimeout(100);
    expect(await commits(page) - before).toBeGreaterThan(0);
    expect(await drawOrder(page)).toEqual(raised);

    await page.mouse.move(visible.x + 90 * s, visible.y + 60 * s, { steps: 5 });
    await page.waitForTimeout(50);
    const at = await tileAt(page, CHAT);
    near(at.x, CHAT_UNDER.x + 90);
    near(at.y, CHAT_UNDER.y + 60);
    await page.keyboard.press('\\');
    await page.waitForTimeout(100);
    expect(await drawOrder(page)).toEqual(raised);
    near((await tileAt(page, CHAT)).x, CHAT_UNDER.x + 90);
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await drawOrder(page)).toEqual(raised);
    near((await placeOf(page, CHAT)).x, CHAT_UNDER.x + 90);
  });

  test('on a touch screen too, a press raises what\'s under the finger, and only that', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await page.request.post('/__harness', { data: { reset: true } });
    await seeded(page, page.request, { [CHAT]: CHAT_UNDER }, [CHAT, NOTEBOOK, BROWSER, AGENT]);
    const visible = await onDesk(page, 386, 70);
    await page.touchscreen.tap(visible.x, visible.y);
    await expect(page.getByRole('dialog', { name: /Chat/ })).toBeVisible();
    expect(await drawOrder(page)).toEqual([NOTEBOOK, BROWSER, AGENT, CHAT]);
    await ctx.close();
  });

  test('the resize corner goes to the top app too: one under another can\'t be grabbed', async ({ page, request }) => {
    // Chat's corner is inside the Notebook.
    await seeded(page, request, { [CHAT]: { x: 230, y: 10, w: 76, h: 76 } }, [CHAT, NOTEBOOK, BROWSER, AGENT]);
    const corner = await onDesk(page, 303, 83);
    const s = await scale(page);
    await page.mouse.move(corner.x, corner.y);
    await page.waitForTimeout(120);
    expect((await hoverNow(page)).corners).toEqual([`tile-${NOTEBOOK}`]);
    await page.mouse.down();
    await page.mouse.move(corner.x + 40 * s, corner.y + 40 * s, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await placeOf(page, CHAT)).toEqual({ x: 230, y: 10, w: 76, h: 76 });
    const notebook = await placeOf(page, NOTEBOOK);
    near(notebook.x, 340);
    near(notebook.y, 64);
    expect(notebook.w).toBe(76); // moved, not resized
  });

  test('the stack and every place survive a reload', async ({ page, request }) => {
    const errors = watchConsole(page);
    await seeded(page, request);
    await dragApp(page, CHAT, 300, 20); // on the Notebook
    await dragApp(page, BROWSER, -170, 30); // on both
    await resizeApp(page, AGENT, 0, 0, 1); // lifts the Agent, moving nothing
    const stack = await drawOrder(page);
    expect(stack).toEqual([NOTEBOOK, CHAT, BROWSER, AGENT]);
    const places = await Promise.all(ALL_APPS.map((id) => placeOf(page, id)));
    await page.waitForTimeout(1_200);
    expect((await savedDesk(page)).stack).toEqual(stack);
    expect(await savedList(page)).toEqual(ALL_APPS);
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(600);
    expect(await drawOrder(page)).toEqual(stack);
    expect(await Promise.all(ALL_APPS.map((id) => placeOf(page, id)))).toEqual(places);
    // And what's on top still takes the pointer.
    const c = await centerOf(page, BROWSER);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(120);
    expect((await hoverNow(page)).corners).toEqual([`tile-${BROWSER}`]);
    expect(errors).toEqual([]);
  });

  test('a saved desk with overlaps loads as it is, in its order, with nothing repaired or written back', async ({ page, request }) => {
    const errors = watchConsole(page);
    const twins: Record<string, Box> = { [CHAT]: { x: 100, y: 100, w: 76, h: 76 }, [NOTEBOOK]: { x: 100, y: 100, w: 76, h: 76 }, [BROWSER]: { x: 130, y: 120, w: 76, h: 76 } };
    await seeded(page, request, twins, [BROWSER, AGENT, NOTEBOOK, CHAT]);
    for (const id of [CHAT, NOTEBOOK, BROWSER]) expect(await placeOf(page, id)).toEqual(twins[id]);
    expect(await drawOrder(page)).toEqual([BROWSER, AGENT, NOTEBOOK, CHAT]);
    const stored = await page.evaluate(() => localStorage.getItem('ma.layout.v2'));
    await page.waitForTimeout(1_200);
    expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2'))).toBe(stored);
    expect(errors).toEqual([]);
  });

  test('a saved desk from before stacking looks the same, and keeps its list', async ({ page, request }) => {
    await seeded(page, request, {}, undefined, [AGENT, CHAT, BROWSER, NOTEBOOK]); // not reading order, as a phone may have left it
    expect(await drawOrder(page)).toEqual([AGENT, CHAT, BROWSER, NOTEBOOK]);
    expect(await domOrder(page)).toEqual([CHAT, NOTEBOOK, BROWSER, AGENT]); // the keyboard reads by place regardless
    await expect(page.getByRole('button', { name: 'Clean up Personal desk', exact: true })).toHaveCount(1); // as it was: these aren't 16 apart
  });

  test('a desk with no stack stays byte-identical, read and written, until something raises, and again once the stack says what the list says', async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __layoutWrites: number };
      w.__layoutWrites = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key: string, value: string): void {
        if (key === 'ma.layout.v2') w.__layoutWrites += 1;
        set.call(this, key, value);
      };
    });
    const writes = (): Promise<number> => page.evaluate(() => (window as unknown as { __layoutWrites: number }).__layoutWrites);
    await seeded(page, request);
    const original = await storedDoc(page);
    expect(original).not.toContain('"stack"');

    // Read: nothing is written back.
    const atLoad = await writes();
    await page.waitForTimeout(1_200);
    expect(await writes()).toBe(atLoad);

    // Written: a step out and a step back stores a new desk that says the same thing, with nothing raised.
    await page.locator(`[id="proxy-${PERSONAL}"]`).focus();
    await page.keyboard.press('r');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1_200);
    expect(await writes()).toBeGreaterThan(atLoad);
    expect(await storedDoc(page)).toBe(original);

    // A raise adds the field and changes nothing else.
    const focus = (id: string): Promise<void> => page.locator(`[id="proxy-${id}"]`).focus();
    await focus(CHAT);
    await page.waitForTimeout(1_200);
    const raised = await storedDoc(page);
    expect((await savedDesk(page)).stack).toEqual([NOTEBOOK, BROWSER, AGENT, CHAT]);
    expect(raised.replace(/,"stack":\[[^\]]*\]/, '')).toBe(original);

    // Raised around until it says what the list says: the field goes, and the doc is what it was.
    for (const id of [NOTEBOOK, BROWSER, AGENT]) await focus(id);
    expect(await drawOrder(page)).toEqual(ALL_APPS);
    await page.waitForTimeout(1_200);
    expect(await storedDoc(page)).toBe(original);
  });

  for (const [what, bad, want] of [
    ['isn\'t a list', 'nope', ALL_APPS],
    ['is a number', 7, ALL_APPS],
    ['holds only ids that aren\'t here', ['gone', 'also-gone'], ALL_APPS],
    ['has junk, repeats and unknown ids, and leaves some out', [1, null, 'gone', BROWSER, { a: 1 }, BROWSER, AGENT], [BROWSER, AGENT, CHAT, NOTEBOOK]],
  ] as const) {
    test(`a stack that ${what} loads, and takes a raise`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await seeded(page, request, {}, bad);
      expect(await drawOrder(page)).toEqual(want);
      for (const id of ALL_APPS) expect(await page.locator(`[id="proxy-${id}"]`).count()).toBe(1);
      const lowest = want[0]!;
      await page.locator(`[id="proxy-${lowest}"]`).focus();
      expect(await onTop(page)).toBe(lowest);
      await page.waitForTimeout(1_200);
      expect(await savedStack(page)).toEqual([...want.slice(1), lowest]);
      expect(await savedList(page)).toEqual(ALL_APPS);
      expect(errors).toEqual([]);
    });
  }

  const PHONE_SIZE = { width: 390, height: 844 };
  const WIDE_SIZE = { width: 1440, height: 900 };
  const sizedTo = async (page: Page, size: { width: number; height: number }): Promise<void> => {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
  };

  test('raises on a larger screen leave a phone\'s grid alone, and the stack comes back with the width', async ({ page, request }) => {
    const errors = watchConsole(page);
    await seeded(page, request, { [CHAT]: CHAT_UNDER });
    const cells = (): Promise<Box[]> => Promise.all(ALL_APPS.map((id) => placeOf(page, id)));
    await sizedTo(page, PHONE_SIZE);
    const grid = await cells();
    expect(new Set(grid.map((b) => `${b.x},${b.y}`)).size).toBe(4);
    expect(await domOrder(page)).toEqual(ALL_APPS);
    await sizedTo(page, WIDE_SIZE);

    await page.locator(`[id="proxy-${BROWSER}"]`).focus();
    await page.locator(`[id="proxy-${CHAT}"]`).focus();
    const stack = [NOTEBOOK, AGENT, BROWSER, CHAT];
    expect(await drawOrder(page)).toEqual(stack);

    await sizedTo(page, PHONE_SIZE);
    expect(await cells()).toEqual(grid);
    expect(await domOrder(page)).toEqual(ALL_APPS);
    expect(await drawOrder(page)).toEqual(ALL_APPS);

    await sizedTo(page, WIDE_SIZE);
    expect(await drawOrder(page)).toEqual(stack);
    await page.waitForTimeout(1_200);
    expect(await savedStack(page)).toEqual(stack);
    expect(await savedList(page)).toEqual(ALL_APPS);
    expect(errors).toEqual([]);
  });

  test('a phone\'s drag lifts the tile and puts it back, so a wider window finds every app where the stack says', async ({ page, request }) => {
    await page.setViewportSize(PHONE_SIZE);
    await seeded(page, request);
    expect(await drawOrder(page)).toEqual(ALL_APPS);

    // Chat is first in the list, and stays in its own cell.
    const c = await centerOf(page, CHAT);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 12, c.y + 12, { steps: 4 });
    await page.waitForTimeout(100);
    expect(await onTop(page)).toBe(CHAT); // it passes over the others
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await drawOrder(page)).toEqual(ALL_APPS); // and goes back

    await sizedTo(page, WIDE_SIZE);
    expect(await drawOrder(page)).toEqual(ALL_APPS);
    expect(await onTop(page)).toBe(AGENT);
  });

  test('a phone\'s drag that reorders changes the list, and the stack doesn\'t follow', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.setViewportSize(PHONE_SIZE);
    await seeded(page, request);
    const browserCell = await placeOf(page, BROWSER);
    const from = await centerOf(page, CHAT);
    const to = await centerOf(page, BROWSER);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.waitForTimeout(100);
    expect(await onTop(page)).toBe(CHAT);
    const held = await tileAt(page, CHAT); // React moved its node mid-drag, and it stayed with the pointer
    expect(Math.abs(held.x - browserCell.x)).toBeLessThan(2);
    await page.mouse.up();
    await page.waitForTimeout(400);
    await page.waitForTimeout(1_200);

    const list = await savedList(page);
    expect(list).not.toEqual(ALL_APPS);
    expect(await drawOrder(page)).toEqual(list);
    expect(await savedStack(page)).toEqual(ALL_APPS);

    await sizedTo(page, WIDE_SIZE);
    expect(await drawOrder(page)).toEqual(ALL_APPS);
    expect(errors).toEqual([]);
  });

  // ----- no hover during a drag. Every commit of every React root, from the hook React keeps for its
  // devtools, which is in every build. A render anywhere counts, so this holds for all of the app.
  async function countCommits(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w['__commits'] = 0;
      w['__REACT_DEVTOOLS_GLOBAL_HOOK__'] = {
        isDisabled: false,
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: () => { w['__commits'] = (w['__commits'] as number) + 1; },
      };
    });
  }
  const commits = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __commits: number }).__commits);
  /** Which apps show their corner, and any app's name on the desk. */
  const hoverNow = (page: Page): Promise<{ corners: string[]; names: string[] }> => page.evaluate((deskId) => {
    type Node = { id(): string; text(): string; findAncestor(q: string): Node };
    const stage = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): { find(q: string): Node[] } } } } }).__maDesk.camera.getStage();
    const desk = stage.findOne(`#desk-${deskId}`);
    return { corners: desk.find('.app-resize').map((n) => n.findAncestor('.app-tile').id()), names: desk.find('Text').map((n) => n.text()).filter((t) => ['Chat', 'Notebook', 'Browser', 'Agent'].includes(t)) };
  }, PERSONAL);

  test('moving an app: no app takes hover, and React doesn\'t render at all, until the drop', async ({ page, request }) => {
    await countCommits(page);
    await seeded(page, request);
    const none = { corners: [], names: [] };
    const c = await centerOf(page, AGENT);
    const s = await scale(page);
    // The counter works: hovering an app renders.
    const idle = await commits(page);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(100);
    expect(await commits(page)).toBeGreaterThan(idle);
    expect((await hoverNow(page)).corners).toEqual([`tile-${AGENT}`]);

    await page.mouse.down();
    await page.mouse.move(c.x - 12 * s, c.y, { steps: 3 }); // the drag has started
    await page.waitForTimeout(100);
    expect(await hoverNow(page)).toEqual(none);
    const started = await commits(page);

    // Agent goes over the Browser, 74 units along, and out the other side.
    await page.mouse.move(c.x - 150 * s, c.y, { steps: 20 });
    await page.waitForTimeout(100);
    expect((await placeOf(page, AGENT)).x).toBe(650); // nothing is stored yet
    expect(await hoverNow(page)).toEqual(none);
    await page.mouse.move(c.x - 260 * s, c.y, { steps: 20 });
    await page.waitForTimeout(100);
    expect(await hoverNow(page)).toEqual(none);
    // And back onto the app being dragged, which is where its own hover used to come back.
    await page.mouse.move(c.x - 90 * s, c.y, { steps: 20 });
    await page.waitForTimeout(100);
    expect(await hoverNow(page)).toEqual(none);
    expect(await commits(page) - started).toBe(0);

    // The pointer is on the app at the drop, so its hover is back.
    await page.mouse.up();
    await page.waitForTimeout(100);
    near((await placeOf(page, AGENT)).x, 560);
    expect((await hoverNow(page)).corners).toEqual([`tile-${AGENT}`]);
    // And it isn't stale: moving off clears it, and onto the Browser gives the Browser its own.
    const b = await centerOf(page, BROWSER);
    await page.mouse.move(b.x, b.y, { steps: 3 });
    await page.waitForTimeout(100);
    expect((await hoverNow(page)).corners).toEqual([`tile-${BROWSER}`]);
  });

  // ----- the stacked look (ADR 0064): a tile over one below it, or in hand. A bitmap holds no look to read, so the tile's shape says what it drew.
  const looks = (page: Page): Promise<Record<string, boolean>> => page.evaluate((deskId) => {
    type N = { id(): string; find(q: string): N[]; findOne(q: string): N; getAttr(k: string): unknown };
    const stage = (window as unknown as { __maDesk: { camera: { getStage(): N } } }).__maDesk.camera.getStage();
    return Object.fromEntries(stage.findOne(`#desk-${deskId}`).find('.app-tile').map((n) => [n.id().slice('tile-'.length), n.findOne('Shape').getAttr('stacked') as boolean]));
  }, PERSONAL);
  const OVER_CHAT = { x: 60, y: 50, w: 76, h: 76 };

  test('the stacked look goes by the stack, and updates at a raise, a drop and a cleanup', async ({ page, request }) => {
    const errors = watchConsole(page);
    await seeded(page, request, { [NOTEBOOK]: OVER_CHAT });
    expect(await looks(page)).toEqual({ [CHAT]: false, [NOTEBOOK]: true, [BROWSER]: false, [AGENT]: false });

    // Pressing Chat raises it, so it's the one over the other now. A small move, so it doesn't open.
    const c = await centerOf(page, CHAT);
    const s = await scale(page);
    const corner = { x: c.x - 30 * s, y: c.y - 30 * s };
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x - 8 * s, corner.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await looks(page)).toMatchObject({ [CHAT]: true, [NOTEBOOK]: false });

    // A drop that clears it goes back to the resting look.
    await dragApp(page, CHAT, 0, 200);
    await page.waitForTimeout(100);
    expect(await looks(page)).toEqual({ [CHAT]: false, [NOTEBOOK]: false, [BROWSER]: false, [AGENT]: false });

    // A drop onto another takes it, and cleanup takes it away.
    await dragApp(page, BROWSER, -400, 30);
    await page.waitForTimeout(100);
    expect(await looks(page)).toMatchObject({ [BROWSER]: true, [NOTEBOOK]: false });
    await page.getByRole('button', { name: /^Clean up/ }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    expect(await looks(page)).toEqual({ [CHAT]: false, [NOTEBOOK]: false, [BROWSER]: false, [AGENT]: false });
    expect(errors).toEqual([]);
  });

  test('a drag takes the stacked look as it starts, with no render until the drop, and an overlap is judged at the drop', async ({ page, request }) => {
    await countCommits(page);
    await seeded(page, request);
    const c = await centerOf(page, AGENT);
    const s = await scale(page);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(100);
    expect((await looks(page))[AGENT]).toBe(false);
    await page.mouse.down();
    await page.mouse.move(c.x - 12 * s, c.y, { steps: 3 });
    await page.waitForTimeout(100);
    expect((await looks(page))[AGENT]).toBe(true);
    const started = await commits(page);
    // Over the Browser: nothing else changes until it lands, and that's the one being passed.
    await page.mouse.move(c.x - 120 * s, c.y, { steps: 20 });
    await page.waitForTimeout(100);
    expect(await looks(page)).toMatchObject({ [AGENT]: true, [BROWSER]: false });
    expect(await commits(page) - started).toBe(0);
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect((await looks(page))[AGENT]).toBe(true); // it landed on the Browser
    await dragApp(page, AGENT, 0, 200); // and this one lands clear
    await page.waitForTimeout(100);
    expect((await looks(page))[AGENT]).toBe(false);
  });

  test('a corner in hand wears the stacked look too, and gives it back at the drop', async ({ page, request }) => {
    await seeded(page, request);
    const b = (await page.locator(`[id="proxy-${CHAT}"]`).boundingBox())!;
    const s = await scale(page);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(100);
    const from = { x: b.x + b.width - 4 * s, y: b.y + b.height - 4 * s };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20 * s, from.y, { steps: 4 });
    await page.waitForTimeout(100);
    expect((await looks(page))[CHAT]).toBe(true);
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect((await looks(page))[CHAT]).toBe(false);
  });

  test('a phone stacks nothing at rest, and only the tile in hand wears the look', async ({ page, request }) => {
    await page.setViewportSize(PHONE_SIZE);
    await seeded(page, request, { [NOTEBOOK]: OVER_CHAT });
    expect(Object.values(await looks(page))).toEqual([false, false, false, false]);
    const c = await centerOf(page, CHAT);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 12, c.y + 12, { steps: 4 });
    await page.waitForTimeout(100);
    expect(await looks(page)).toEqual({ [CHAT]: true, [NOTEBOOK]: false, [BROWSER]: false, [AGENT]: false });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(Object.values(await looks(page))).toEqual([false, false, false, false]);
  });

  // The shadow draws at its token's strength, on the canvas: filling with the shadow's own translucent color applied its alpha twice,
  // so Light's .10 drew as .01. A unit under a tile's bottom edge that takes about 15 levels off Light's panel (it was 1 or 2), and 6 off Dark's (it was 2 or 3).
  for (const [theme, least] of [['light', 8], ['dark', 4]] as [ThemeId, number][]) {
    test(`a resting tile's shadow draws at its token's strength in ${theme}`, async ({ page, request }) => {
      await setTheme(page, theme);
      await seeded(page, request);
      const shade = await page.evaluate(({ deskId, tile }) => {
        type N = { x(): number; y(): number };
        const { camera } = (window as unknown as { __maDesk: { camera: { cam: { x: number; y: number; s: number }; dpr(): number; getStage(): { findOne(q: string): N; getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[] } } } }).__maDesk;
        const { cam } = camera;
        const k = cam.s * camera.dpr();
        const stage = camera.getStage();
        const desk = stage.findOne(`#desk-${deskId}`);
        const at = stage.findOne(`#tile-${tile}`);
        const ctx = stage.getLayers()[0]!.getCanvas().getContext()._context;
        const read = (x: number, y: number): number => ctx.getImageData(Math.round((desk.x() + x) * k + cam.x * camera.dpr()), Math.round((desk.y() + y) * k + cam.y * camera.dpr()), 1, 1).data[0]!;
        const midX = at.x() + 38;
        return read(midX, at.y() + 300) - read(midX, at.y() + 76 + 1);
      }, { deskId: PERSONAL, tile: CHAT });
      expect(shade).toBeGreaterThanOrEqual(least);
    });
  }

  test('resizing an app: only its own corner shows, and React renders only at a detail threshold', async ({ page, request }) => {
    await countCommits(page);
    await seeded(page, request);
    const b = (await page.locator(`[id="proxy-${CHAT}"]`).boundingBox())!;
    const s = await scale(page);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(100);
    const from = { x: b.x + b.width - 4 * s, y: b.y + b.height - 4 * s };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 12 * s, from.y, { steps: 3 });
    await page.waitForTimeout(100);
    const started = await commits(page);

    // Across the gap and over the Notebook. Chat stays an icon: it isn't tall enough for more.
    await page.mouse.move(from.x + 260 * s, from.y, { steps: 30 });
    await page.waitForTimeout(100);
    expect(await hoverNow(page)).toEqual({ corners: [`tile-${CHAT}`], names: [] });
    expect(await commits(page) - started).toBe(0);

    // Tall enough for a widget: that one threshold is the one render.
    await page.mouse.move(from.x + 180 * s, from.y + 110 * s, { steps: 10 });
    await page.waitForTimeout(100);
    const atThreshold = await commits(page) - started;
    expect(atThreshold).toBeGreaterThan(0);
    expect(atThreshold).toBeLessThanOrEqual(2); // the level changing, and nothing per frame
    await page.mouse.up();
  });

  test('panning and dragging a desk take no hover either', async ({ page, request }) => {
    await countCommits(page);
    await seeded(page, request);
    const box = (await proxyOf(page, 'Personal').boundingBox())!;
    const s = await scale(page);
    const c = await centerOf(page, CHAT);
    // Press the panel under the Chat tile and drag up, so the desk's apps pass nothing, and the pointer stays on the desk.
    const at = { x: c.x, y: box.y + box.height - 60 * s };
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.mouse.move(at.x + 12, at.y, { steps: 3 });
    await page.waitForTimeout(100);
    const started = await commits(page);
    await page.mouse.move(at.x + 120, at.y, { steps: 20 });
    await page.waitForTimeout(100);
    expect(await hoverNow(page)).toEqual({ corners: [], names: [] });
    expect(await commits(page) - started).toBe(0);
    await page.mouse.up();
  });

  test('it stops at the desk\'s edges, and can reach the strip but not enter it', async ({ page, request }) => {
    await seeded(page, request);
    await dragApp(page, CHAT, -300, -300);
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 8, y: 8 });
    await dragApp(page, CHAT, -10, 900);
    const low = await placeOf(page, CHAT);
    expect(low.y + low.h).toBeCloseTo(500 - 44, 0);
    await page.screenshot({ path: 'test-results/shots/apps-at-strip.png' });
  });

  test('resizing: any size, a minimum of 56, and it goes over what it meets', async ({ page, request }) => {
    await seeded(page, request);
    await resizeApp(page, CHAT, 37, 22);
    let p = await placeOf(page, CHAT);
    near(p.w, 76 + 37);
    near(p.h, 76 + 22);

    await resizeApp(page, CHAT, -300, -300);
    p = await placeOf(page, CHAT);
    expect(p).toMatchObject({ w: 56, h: 56 });

    await resizeApp(page, CHAT, 350, 20); // over the Notebook, with the pointer still on the corner
    p = await placeOf(page, CHAT);
    near(p.w, 56 + 350);
    near(p.h, 56 + 20);
    expect(clear(p, await placeOf(page, NOTEBOOK))).toBe(false);
    expect(await placeOf(page, NOTEBOOK)).toEqual({ x: 300, y: 24, w: 76, h: 76 });
    expect(await onTop(page)).toBe(CHAT);
    await page.screenshot({ path: 'test-results/shots/apps-resized.png' });

    await resizeApp(page, CHAT, 5000, 5000, 2); // stopped only by the desk
    p = await placeOf(page, CHAT);
    expect(p.x + p.w).toBeCloseTo(800 - 8, 1);
    expect(p.y + p.h).toBeCloseTo(500 - 44, 1);
  });

  test('resizing a corner doesn\'t move or open the app, and the detail follows the size', async ({ page, request }) => {
    await seeded(page, request);
    const texts = async (): Promise<string[]> => (await surfaceOf(page, PERSONAL)).texts;
    expect(await texts()).not.toContain('Chat');

    await resizeApp(page, CHAT, 168 - 76 + 3, 168 - 76 + 3);
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 24, y: 24 });
    await expect(page.getByRole('dialog', { name: /Chat/ })).toHaveCount(0);
    expect(await texts()).toContain('Chat'); // small, from 168 x 168
    await page.screenshot({ path: 'test-results/shots/apps-small.png' });

    await resizeApp(page, CHAT, 0, -24); // too short for small
    await page.mouse.move(5, 450); // off the app, since an icon names itself on hover
    await page.waitForTimeout(100);
    expect(await texts()).not.toContain('Chat');
  });

  test('the corner shows on hover, and the old size chip is gone', async ({ page, request }) => {
    await seeded(page, request);
    const count = (q: string): Promise<number> => page.evaluate((sel) => (window as unknown as { __maDesk: { camera: { getStage(): { find(q: string): unknown[] } } } }).__maDesk.camera.getStage().find(sel).length, q);
    expect(await count('.app-resize')).toBe(0);
    const c = await centerOf(page, NOTEBOOK);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(100);
    expect(await count('.app-resize')).toBe(1);
    expect(await count('.size-toggle')).toBe(0);
    await page.screenshot({ path: 'test-results/shots/apps-hover.png' });
  });

  // A desk nobody has sized (ADR 0062, item 7). At 144 tall, an app had only 16 units of vertical room.
  test.describe('a new desk, by mouse', () => {
    /** Nothing saved, so the layout comes from the desk list, as for a new member: one desk at the world's origin. */
    async function fresh(page: Page, request: APIRequestContext): Promise<void> {
      await harness(request, { fleet: [personal('running')] });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(800);
    }
    // placeOf is for a desk at y 36. This one's at 0.
    const at = async (page: Page, id: string): Promise<Box> => {
      const p = await placeOf(page, id);
      return { ...p, y: p.y + 36 };
    };
    const expectOthersStill = async (page: Page, ids: readonly (readonly [string, number])[]): Promise<void> => {
      for (const [id, x] of ids) expect(await at(page, id)).toEqual({ x, y: 24, w: 76, h: 76 });
    };

    test('it is 584 x 236, with its apps in a row at the top, and it saves as that', async ({ page, request }) => {
      await fresh(page, request);
      const size = await page.locator(`[id="proxy-${PERSONAL}"]`).evaluate((el: HTMLElement) => ({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
      expect(size).toEqual({ w: 584, h: 236 });
      await expectOthersStill(page, [[CHAT, 24], [NOTEBOOK, 116], [BROWSER, 208], [AGENT, 300]]);
      await page.screenshot({ path: 'test-results/shots/new-desk.png' });
      await page.waitForTimeout(1_200); // the mirror is debounced by 1 s
      const doc = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? 'null') as { desks: Record<string, { w: number; h: number }> });
      expect(doc.desks[PERSONAL]).toMatchObject({ w: 584, h: 236 });
    });

    test('an app moves vertically, passes the others under the row, and comes back up beyond them', async ({ page, request }) => {
      const errors = watchConsole(page);
      await fresh(page, request);
      await dragApp(page, CHAT, 0, 92);
      const down = await at(page, CHAT);
      near(down.x, 24);
      near(down.y, 116);
      await page.screenshot({ path: 'test-results/shots/new-desk-app-at-strip.png' }); // its name on hover, right above the etched name

      await dragApp(page, CHAT, 400, 0);
      const along = await at(page, CHAT);
      near(along.x, 424);
      near(along.y, 116);

      await dragApp(page, CHAT, 0, -92);
      const up = await at(page, CHAT);
      near(up.x, 424);
      near(up.y, 24);
      expect(up.x).toBeGreaterThan(300 + 76); // past the Agent, the last of them
      await expectOthersStill(page, [[NOTEBOOK, 116], [BROWSER, 208], [AGENT, 300]]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.screenshot({ path: 'test-results/shots/new-desk-app-passed.png' });
      expect(errors).toEqual([]);
    });

    test('an app resizes to widget height, stops at the strip, and shows its widget', async ({ page, request }) => {
      const errors = watchConsole(page);
      await fresh(page, request);
      const texts = async (): Promise<string[]> => (await surfaceOf(page, PERSONAL)).texts;
      expect(await texts()).not.toContain('Agent');

      await resizeApp(page, AGENT, 100, 120); // more than there's room for, downward
      const agent = await at(page, AGENT);
      expect(agent).toMatchObject({ x: 300, y: 24, h: 168 });
      near(agent.w, 176);
      await page.mouse.move(5, 450); // off the app, since an icon names itself on hover
      await page.waitForTimeout(100);
      expect(await texts()).toContain('Agent'); // small, from 168 x 168
      await page.screenshot({ path: 'test-results/shots/new-desk-widget.png' });

      // The Notebook is beside the Chat, and the Chat goes over it, to the same height.
      await resizeApp(page, CHAT, 300, 92);
      const chat = await at(page, CHAT);
      expect(chat).toMatchObject({ x: 24, y: 24 });
      near(chat.w, 376);
      near(chat.h, 168);
      expect(errors).toEqual([]);
    });
  });

  test('in a wild session nothing leaves the desk, and Cleanup takes whatever it left apart', async ({ page, request }) => {
    await seeded(page, request);
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 24; i += 1) {
      const id = ALL_APPS[Math.floor(rnd() * ALL_APPS.length)]!;
      if (rnd() < 0.7) await dragApp(page, id, -500 + rnd() * 1000, -350 + rnd() * 700, 1 + Math.floor(rnd() * 8));
      else await resizeApp(page, id, -150 + rnd() * 400, -150 + rnd() * 400, 1 + Math.floor(rnd() * 8));
      await expectOnDesk(page);
    }
    const clean = page.getByRole('button', { name: 'Clean up Personal desk', exact: true });
    await clean.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const box = await proxyOf(page, 'Personal').evaluate((el: HTMLElement) => ({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
    await expectAllClear(page, box.w, box.h);
  });

  test('keyboard: m moves, Enter keeps, Esc restores, and each step is announced', async ({ page, request }) => {
    await seeded(page, request);
    const tile = page.locator(`[id="proxy-${CHAT}"]`);
    const said = page.getByRole('status').first();
    await tile.focus();

    await page.keyboard.press('m');
    await expect(said).toContainText('Moving Chat');
    await expect(tile).toHaveClass(/editing/);
    await page.keyboard.press('ArrowRight');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 32, y: 24 });
    await expect(said).toHaveText('Chat at 32, 24');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 32, y: 64 });
    await expect(said).toHaveText('Chat at 32, 64');
    await page.screenshot({ path: 'test-results/shots/apps-keyboard.png' });

    await page.keyboard.press('Escape');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 24, y: 24 });
    await expect(said).toHaveText('Restored');
    await expect(tile).not.toHaveClass(/editing/);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.keyboard.press('m');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Enter');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 64, y: 24 });
    await expect(said).toHaveText('Kept');
    await expect(page.getByRole('dialog')).toHaveCount(0); // Enter kept it, and didn't open it
    await expect(tile).toBeFocused();
    await page.waitForTimeout(100);
    await expect(tile).toBeFocused();

    // Out of the mode, Enter opens as it always did, and arrows move the focus.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(`[id="proxy-${NOTEBOOK}"]`)).toBeFocused();
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 64, y: 24 });
  });

  test('keyboard: arrows go straight over another app, one step at a time, and stop only at the edge', async ({ page, request }) => {
    await seeded(page, request, { [CHAT]: { x: 200, y: 24, w: 76, h: 76 } });
    const tile = page.locator(`[id="proxy-${CHAT}"]`);
    const said = page.getByRole('status').first();
    await tile.focus();
    await page.keyboard.press('m');
    await page.keyboard.press('ArrowRight');
    expect((await placeOf(page, CHAT)).x).toBe(208);
    await page.keyboard.press('Shift+ArrowRight'); // 248, which reaches the Notebook at 300
    expect((await placeOf(page, CHAT)).x).toBe(248);
    await page.keyboard.press('Shift+ArrowRight'); // over it
    expect((await placeOf(page, CHAT)).x).toBe(288);
    await expect(said).toHaveText('Chat at 288, 24');
    expect(clear(await placeOf(page, CHAT), await placeOf(page, NOTEBOOK))).toBe(false);
    expect(await placeOf(page, NOTEBOOK)).toEqual({ x: 300, y: 24, w: 76, h: 76 });
    expect(await onTop(page)).toBe(CHAT);
    await expect(tile).toBeFocused(); // its place in reading order changed, and the button held still

    await page.keyboard.press('Shift+ArrowUp');
    expect((await placeOf(page, CHAT)).y).toBe(8);
    await page.keyboard.press('ArrowUp');
    await expect(said).toContainText("Can't go further");
    await page.keyboard.press('ArrowUp');
    await expect(said).toContainText("Can't go further");
    expect((await placeOf(page, CHAT)).y).toBe(8);
    await page.keyboard.press('Escape');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 200, y: 24 });
    await expect(tile).toBeFocused();

    // Kept, over the Notebook: it stays, on top, and the buttons take up the new reading order.
    await page.keyboard.press('m');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
    expect((await placeOf(page, CHAT)).x).toBe(320);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    expect(await domOrder(page)).toEqual([NOTEBOOK, CHAT, BROWSER, AGENT]);
    await expect(tile).toBeFocused();
    near((await placeOf(page, CHAT)).x, 320);
  });

  test('keyboard: focus brings an app to the front, even one fully covered, and the keyboard still goes by place', async ({ page, request }) => {
    const sameSpot = { x: 300, y: 100, w: 120, h: 120 };
    await seeded(page, request, { [CHAT]: sameSpot, [NOTEBOOK]: sameSpot, [BROWSER]: { x: 24, y: 24, w: 76, h: 76 } }, [CHAT, NOTEBOOK, BROWSER, AGENT]);
    const proxy = (id: string): Locator => page.locator(`[id="proxy-${id}"]`);
    const reading = [BROWSER, AGENT, CHAT, NOTEBOOK];
    expect(await domOrder(page)).toEqual(reading);

    // Chat is entirely under the Notebook, and the arrows reach it.
    await proxy(BROWSER).focus();
    expect(await onTop(page)).toBe(BROWSER);
    await page.keyboard.press('ArrowRight');
    await expect(proxy(AGENT)).toBeFocused();
    expect(await onTop(page)).toBe(AGENT);
    await page.keyboard.press('ArrowRight');
    await expect(proxy(CHAT)).toBeFocused();
    expect(await onTop(page)).toBe(CHAT);
    await page.screenshot({ path: 'test-results/shots/apps-covered-focused.png' });
    await page.keyboard.press('ArrowRight');
    await expect(proxy(NOTEBOOK)).toBeFocused();
    expect(await onTop(page)).toBe(NOTEBOOK);
    await page.keyboard.press('ArrowLeft');
    await expect(proxy(CHAT)).toBeFocused();
    expect(await onTop(page)).toBe(CHAT);

    // None of that changed the order the keyboard goes in, with two apps at one place.
    expect(await domOrder(page)).toEqual(reading);

    // Enter opens the app that's focused.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: /Chat/ })).toBeVisible();
  });

  test('the menu: Bring to front and Send to back, by mouse and by keyboard', async ({ page, request }) => {
    const said = page.getByRole('status').first();
    await seeded(page, request, { [CHAT]: CHAT_UNDER }, [CHAT, NOTEBOOK, BROWSER, AGENT]);
    const menu = page.getByRole('menu');
    const front = menu.getByRole('menuitem', { name: 'Bring to front' });
    const back = menu.getByRole('menuitem', { name: 'Send to back' });

    // A right press doesn't raise: the menu is what can send it down.
    const visible = await onDesk(page, 386, 70);
    await page.mouse.click(visible.x, visible.y, { button: 'right' });
    await expect(menu.getByRole('menuitem')).toHaveCount(4);
    expect((await drawOrder(page))[0]).toBe(CHAT);
    await expect(back).toBeDisabled(); // it's at the back already
    await front.click();
    await expect(menu).toHaveCount(0);
    expect(await onTop(page)).toBe(CHAT);
    await expect(said).toHaveText('Chat brought to front');

    await page.mouse.click(visible.x, visible.y, { button: 'right' });
    await expect(front).toBeDisabled();
    await back.click();
    expect((await drawOrder(page))[0]).toBe(CHAT);
    await expect(said).toHaveText('Chat sent to back');
    const both = await onDesk(page, 350, 70);
    await page.mouse.move(both.x, both.y);
    // A move in the same frame as a reorder can read the hit map before it redraws. A real pointer's next move
    // corrects it, so move again a frame later.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.mouse.move(both.x + 1, both.y);
    await page.waitForTimeout(120);
    expect((await hoverNow(page)).corners).toEqual([`tile-${NOTEBOOK}`]);
    await page.waitForTimeout(1_200);
    expect((await savedStack(page))[0]).toBe(CHAT); // saved like any other change
    expect(await savedList(page)).toEqual(ALL_APPS);

    // From the keyboard: focus raised it, and sending it back stays sent, with the focus still there.
    const tile = page.locator(`[id="proxy-${CHAT}"]`);
    await tile.focus();
    expect(await onTop(page)).toBe(CHAT);
    await page.keyboard.press('.');
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(tile).toBeFocused();
    expect((await drawOrder(page))[0]).toBe(CHAT);
    // Esc from the menu changes nothing either.
    await page.keyboard.press('.');
    await expect(front).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(tile).toBeFocused();
    expect((await drawOrder(page))[0]).toBe(CHAT);
    // Moving on and back is focus taken again.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(tile).toBeFocused();
    expect(await onTop(page)).toBe(CHAT);
  });

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`screenshot of apps over each other at 1x and 2x, ${theme}`, async ({ browser }) => {
      for (const dpr of [1, 2]) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, baseURL: test.info().project.use.baseURL });
        const page = await ctx.newPage();
        await page.request.post('/__harness', { data: { reset: true } });
        await setTheme(page, theme);
        await seeded(page, page.request, {
          [CHAT]: { x: 60, y: 60, w: 240, h: 200 }, // two widgets
          [NOTEBOOK]: { x: 200, y: 150, w: 240, h: 200 },
          [BROWSER]: { x: 520, y: 80, w: 76, h: 76 }, // two icons
          [AGENT]: { x: 560, y: 110, w: 76, h: 76 },
        });
        const d = (await proxyOf(page, 'Personal').boundingBox())!;
        await page.mouse.move(5, 5);
        await page.waitForTimeout(150);
        await page.screenshot({ path: `test-results/shots/stack-${theme}-${dpr}x.png`, clip: { x: d.x, y: d.y, width: d.width, height: d.height } });
        await ctx.close();
      }
    });
  }

  test('keyboard: r resizes, with the same rules', async ({ page, request }) => {
    await seeded(page, request);
    const tile = page.locator(`[id="proxy-${CHAT}"]`);
    const said = page.getByRole('status').first();
    await tile.focus();
    await page.keyboard.press('r');
    await expect(said).toContainText('Resizing Chat');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await placeOf(page, CHAT)).toMatchObject({ w: 84, h: 116 });
    await expect(said).toHaveText('Chat, 84 by 116');

    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    expect((await placeOf(page, CHAT)).w).toBe(56);
    await expect(said).toContainText("Can't go further");
    await page.keyboard.press('Enter');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 24, y: 24, w: 56, h: 116 });
    await expect(tile).toBeFocused();
  });

  test('keyboard: a desk moves and resizes the same way, and can\'t shrink past what it holds', async ({ page, request }) => {
    await seeded(page, request);
    const deskButton = page.locator(`[id="proxy-${PERSONAL}"]`);
    const said = page.getByRole('status').first();
    const deskPlace = (): Promise<Box> => deskButton.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
    await deskButton.focus();

    await page.keyboard.press('r');
    await page.keyboard.press('ArrowRight');
    expect((await deskPlace()).w).toBe(808);
    await expect(said).toHaveText('Personal desk, 808 by 500');
    for (let i = 0; i < 30; i += 1) await page.keyboard.press('Shift+ArrowUp');
    expect((await deskPlace()).h).toBe(100 + 44); // the apps' bottom edge, and the strip
    await expect(said).toContainText("Can't go further");
    await page.keyboard.press('Escape');
    expect(await deskPlace()).toMatchObject({ w: 800, h: 500 });

    await page.keyboard.press('m');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowDown');
    expect(await deskPlace()).toMatchObject({ x: 40, y: 44 });
    await page.keyboard.press('Escape');
    expect(await deskPlace()).toMatchObject({ x: 0, y: 36 });
  });

  // ----- cleanup (ADR 0062, 0064)
  test.describe('cleaning up', () => {
    const cameraNow = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...(window as unknown as { __maDesk: { camera: { cam: { x: number; y: number; s: number } } } }).__maDesk.camera.cam }));
    const nodes = (page: Page, q: string): Promise<number> => page.evaluate((sel) => (window as unknown as { __maDesk: { camera: { getStage(): { find(q: string): unknown[] } } } }).__maDesk.camera.getStage().find(sel).length, q);
    const cleanButton = (page: Page, name = 'Personal') => page.getByRole('button', { name: `Clean up ${name} desk`, exact: true });
    const undoButton = (page: Page, name = 'Personal') => page.getByRole('button', { name: `Undo clean up ${name} desk`, exact: true });
    const allPlaces = async (page: Page): Promise<Record<string, Box>> => Object.fromEntries(await Promise.all([CHAT, NOTEBOOK, BROWSER, AGENT].map(async (id) => [id, await placeOf(page, id)] as const)));
    /** Click a strip control with the real mouse, where its proxy says it is. */
    async function clickProxy(page: Page, proxy: Locator): Promise<void> {
      const b = (await proxy.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(80);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    }
    const SCATTERED = {
      [CHAT]: { x: 300, y: 200, w: 200, h: 180 },
      [NOTEBOOK]: { x: 40, y: 300, w: 76, h: 76 },
      [BROWSER]: { x: 600, y: 30, w: 90, h: 60 },
      [AGENT]: { x: 420, y: 40, w: 76, h: 76 },
    };

    test('apps line up in reading order, sizes kept, 16 apart, the camera still, and undo restores it all', async ({ page, request }) => {
      const errors = watchConsole(page);
      await seeded(page, request, SCATTERED);
      const before = await allPlaces(page);
      const cam = await cameraNow(page);
      const said = page.getByRole('status').first();
      await page.screenshot({ path: 'test-results/shots/cleanup-before.png' });

      await clickProxy(page, cleanButton(page));
      await expect(said).toHaveText('Desk cleaned up');
      expect(await allPlaces(page)).toEqual({
        [AGENT]: { x: 24, y: 24, w: 76, h: 76 },
        [BROWSER]: { x: 116, y: 24, w: 90, h: 60 },
        [CHAT]: { x: 222, y: 24, w: 200, h: 180 },
        [NOTEBOOK]: { x: 438, y: 24, w: 76, h: 76 },
      });
      expect(await cameraNow(page)).toEqual(cam);
      await page.waitForTimeout(400);
      expect(await cameraNow(page)).toEqual(cam);
      await expectAllClear(page);
      expect(await nodes(page, '.desk-undo')).toBe(1);
      expect(await nodes(page, '.desk-cleanup')).toBe(0);
      await expect(cleanButton(page)).toHaveCount(0); // a tidy desk has nothing to offer: running it twice is no change
      await page.screenshot({ path: 'test-results/shots/cleanup-after.png' });

      await clickProxy(page, undoButton(page));
      await expect(said).toHaveText('Clean up undone');
      expect(await allPlaces(page)).toEqual(before);
      expect(await cameraNow(page)).toEqual(cam);
      await expect(cleanButton(page)).toHaveCount(1);
      expect(await nodes(page, '.desk-undo')).toBe(0);
      await page.waitForTimeout(400);
      expect(await allPlaces(page)).toEqual(before);
      expect(errors).toEqual([]);
    });

    for (const [what, size, deskH] of [['the same size', { w: 76, h: 76 }, 500], ['too big to fit, so the desk grows', { w: 300, h: 300 }, 684]] as const) {
      test(`a desk stacked into one pile, ${what}: no overlap, no shrinking, the stack reset, and undo restores all of it`, async ({ page, request }) => {
        const errors = watchConsole(page);
        const pile = { x: 100, y: 100, ...size };
        await seeded(page, request, { [CHAT]: pile, [NOTEBOOK]: pile, [BROWSER]: pile, [AGENT]: pile }, [NOTEBOOK, AGENT, CHAT, BROWSER]);
        const before = await allPlaces(page);
        const deskSize = (): Promise<{ w: number; h: number }> => proxyOf(page, 'Personal').evaluate((el: HTMLElement) => ({ w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
        const stack = await drawOrder(page);
        expect(stack).toEqual([NOTEBOOK, AGENT, CHAT, BROWSER]);
        expect(await deskSize()).toEqual({ w: 800, h: 500 });

        await clickProxy(page, cleanButton(page));
        await page.waitForTimeout(400);
        const after = await allPlaces(page);
        await expectAllClear(page, 800, deskH);
        for (const id of ALL_APPS) expect(after[id]).toMatchObject(size); // never shrinks
        expect(await deskSize()).toEqual({ w: 800, h: deskH });
        // The stack is now reading order. Ties among a pile went by id: agent, browser, chat, notebook.
        expect(await drawOrder(page)).toEqual([AGENT, BROWSER, CHAT, NOTEBOOK]);
        expect(await domOrder(page)).toEqual([AGENT, BROWSER, CHAT, NOTEBOOK]);
        await expect(cleanButton(page)).toHaveCount(0); // running it twice is no change
        await page.waitForTimeout(1_200);
        expect(await savedStack(page)).toEqual([AGENT, BROWSER, CHAT, NOTEBOOK]);
        expect(await savedList(page)).toEqual(ALL_APPS); // a phone's grid doesn't hear of it

        // By keyboard: a desk that grew can have its strip off the screen, since the camera doesn't move.
        await undoButton(page).focus();
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        expect(await allPlaces(page)).toEqual(before);
        expect(await deskSize()).toEqual({ w: 800, h: 500 });
        expect(await drawOrder(page)).toEqual(stack);
        await expect(cleanButton(page)).toHaveCount(1);
        await page.waitForTimeout(1_200);
        expect(await savedStack(page)).toEqual(stack);
        expect(await savedList(page)).toEqual(ALL_APPS);
        expect(errors).toEqual([]);
      });
    }

    test('any overlap offers it. A tidy desk doesn\'t, whatever its stacking', async ({ page, request }) => {
      const tidy = { [CHAT]: { x: 24, y: 24, w: 76, h: 76 }, [NOTEBOOK]: { x: 116, y: 24, w: 76, h: 76 }, [BROWSER]: { x: 208, y: 24, w: 76, h: 76 }, [AGENT]: { x: 300, y: 24, w: 76, h: 76 } };
      await seeded(page, request, tidy);
      await expect(cleanButton(page)).toHaveCount(0);
      const c = await centerOf(page, CHAT);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.waitForTimeout(50);
      expect(await onTop(page)).toBe(CHAT);
      await page.mouse.up(); // a raise alone is no mess
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.waitForTimeout(300);
      await expect(cleanButton(page)).toHaveCount(0);
      await dragApp(page, CHAT, 10, 0); // onto nothing, but out of line
      await expect(cleanButton(page)).toHaveCount(1);
    });

    test('a click on an app after a cleanup leaves its undo alone, and undo brings back the stack from before', async ({ page, request }) => {
      await seeded(page, request, SCATTERED, [AGENT, BROWSER, NOTEBOOK, CHAT]);
      const before = await allPlaces(page);
      await clickProxy(page, cleanButton(page));
      await page.waitForTimeout(400);
      const c = await centerOf(page, AGENT);
      await page.mouse.click(c.x, c.y);
      await expect(page.getByRole('dialog', { name: /Agent/ })).toBeVisible();
      expect(await onTop(page)).toBe(AGENT);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.waitForTimeout(300);
      await expect(undoButton(page)).toHaveCount(1);
      await clickProxy(page, undoButton(page));
      await page.waitForTimeout(400);
      expect(await allPlaces(page)).toEqual(before);
      expect(await drawOrder(page)).toEqual([AGENT, BROWSER, NOTEBOOK, CHAT]);
    });

    test('the button shows only on a desk with something to clean up, while the pointer is on it or it has focus', async ({ page, request }) => {
      const scattered = (id: string, x: number): Record<string, unknown> => ({ id, x, y: 0, w: 500, h: 400, items: [{ id: `${id}:chat`, app: 'chat', x: 200, y: 100, w: 76, h: 76 }] });
      const tidy = { id: GUILD, x: 1100, y: 0, w: 500, h: 400, items: [{ id: `${GUILD}:chat`, app: 'chat', x: 24, y: 24, w: 76, h: 76 }] };
      await page.addInitScript((doc) => {
        if (localStorage.getItem('test.seeded')) return;
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v2', JSON.stringify(doc));
      }, { desks: { [PERSONAL]: scattered(PERSONAL, 0), [WORK]: scattered(WORK, 550), [GUILD]: tidy }, z: [PERSONAL, WORK, GUILD] });
      await harness(request, { fleet: [personal('running'), work('running'), desk(GUILD, 'Guild', 'guild', 'running')] });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(600);
      const inDesk = (id: string, q: string): Promise<number> => page.evaluate(({ deskId, sel }) => {
        type N = { find(q: string): unknown[]; findOne(q: string): N };
        return (window as unknown as { __maDesk: { camera: { getStage(): N } } }).__maDesk.camera.getStage().findOne(`#desk-${deskId}`).find(sel).length;
      }, { deskId: id, sel: q });

      // Personal has the ring. Work needs the pointer. The tidy one never shows it, and its proxy isn't there.
      expect(await inDesk(PERSONAL, '.desk-cleanup')).toBe(1);
      expect(await inDesk(WORK, '.desk-cleanup')).toBe(0);
      await expect(cleanButton(page, 'Guild')).toHaveCount(0);
      const box = (await proxyOf(page, 'Work').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(120);
      expect(await inDesk(WORK, '.desk-cleanup')).toBe(1);
      const tidyBox = (await proxyOf(page, 'Guild').boundingBox())!;
      await page.mouse.move(tidyBox.x + tidyBox.width / 2, tidyBox.y + tidyBox.height / 2);
      await page.waitForTimeout(120);
      expect(await inDesk(WORK, '.desk-cleanup')).toBe(0);
      expect(await inDesk(GUILD, '.desk-cleanup')).toBe(0);

      // From the overview it cleans up where it is: no zoom, and no focus moving.
      const cam = await cameraNow(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(120);
      await page.screenshot({ path: 'test-results/shots/cleanup-hover.png' });
      await clickProxy(page, cleanButton(page, 'Work'));
      await page.waitForTimeout(400);
      expect(await cameraNow(page)).toEqual(cam);
      await expect(page.locator('.desk-nav-label')).toContainText('Personal');
    });

    for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
      test(`screenshot of the button, Undo and the menu at 2x, ${theme}`, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
        const page = await ctx.newPage();
        await page.request.post('/__harness', { data: { reset: true } });
        await setTheme(page, theme);
        await seeded(page, page.request, SCATTERED);
        const clip = async (name: string): Promise<void> => {
          const d = (await proxyOf(page, 'Personal').boundingBox())!;
          await page.screenshot({ path: `test-results/shots/${theme}-cleanup-${name}-2x.png`, clip: { x: d.x + d.width - 300, y: d.y + d.height - 120, width: 310, height: 130 } });
        };
        await clip('button');
        const b = (await cleanButton(page).boundingBox())!;
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(150);
        await clip('hover');
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(400);
        await clip('undo');
        const d = (await proxyOf(page, 'Personal').boundingBox())!;
        await page.mouse.click(d.x + d.width - 200, d.y + d.height - 200, { button: 'right' });
        await page.waitForTimeout(100);
        await page.screenshot({ path: `test-results/shots/${theme}-cleanup-menu-2x.png` });
        await ctx.close();
      });
    }

    test('a press on the button doesn\'t drag the desk', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      const b = (await cleanButton(page).boundingBox())!;
      const deskBefore = await proxyOf(page, 'Personal').boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(80);
      await page.mouse.down();
      await page.mouse.move(b.x + 80, b.y + 60, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      expect(await proxyOf(page, 'Personal').boundingBox()).toEqual(deskBefore);
    });

    test('they all move together over 240 ms, and at once under reduced motion', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      const watch = (): Promise<void> => page.evaluate((ids) => {
        type N = { x(): number; y(): number };
        const stage = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): N } } } }).__maDesk.camera.getStage();
        const log: { t: number; at: number[] }[] = [];
        (window as unknown as { __glide: typeof log }).__glide = log;
        const loop = (t: number): void => {
          log.push({ t, at: ids.map((id) => stage.findOne(`#tile-${id}`).x()) });
          if (log.length < 90) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }, [CHAT, NOTEBOOK]);
      const log = (): Promise<{ t: number; at: number[] }[]> => page.evaluate(() => (window as unknown as { __glide: { t: number; at: number[] }[] }).__glide);

      await watch();
      await cleanButton(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_000);
      const moves = await log();
      const changed = (f: { at: number[] }, i: number): boolean => f.at[i] !== moves[0]!.at[i];
      const first = moves.findIndex((f) => changed(f, 0));
      expect(moves.findIndex((f) => changed(f, 1))).toBe(first); // the same frame
      const last = moves[moves.length - 1]!;
      const done = moves.findIndex((f) => f.at[0] === last.at[0] && f.at[1] === last.at[1]);
      const ms = moves[done]!.t - moves[first]!.t;
      expect(ms).toBeGreaterThan(150);
      expect(ms).toBeLessThan(400);
      expect(done - first).toBeGreaterThan(4);

      // Back, under reduced motion: there's no frame in between.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await watch();
      await undoButton(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      const jump = await log();
      const seen = new Set(jump.map((f) => f.at.join()));
      expect(seen.size).toBeLessThanOrEqual(2);
    });

    test('a desk too small grows downward by what it needs, keeps its width and camera, and undo shrinks it back', async ({ page, request }) => {
      const id = PERSONAL;
      await page.addInitScript((doc) => {
        if (localStorage.getItem('test.seeded')) return;
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v2', JSON.stringify(doc));
      }, { desks: { [id]: { id, x: 0, y: 36, w: 400, h: 300, items: [
        { id: `${id}:chat`, app: 'chat', x: 8, y: 8, w: 180, h: 130 },
        { id: `${id}:notebook`, app: 'notebook', x: 200, y: 8, w: 180, h: 130 },
        { id: `${id}:browser`, app: 'browser', x: 8, y: 146, w: 372, h: 110 },
      ] } }, z: [id] });
      await harness(request, { fleet: [personal('running')] });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(800);
      const deskBox = (): Promise<Box> => proxyOf(page, 'Personal').evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
      const cam = await cameraNow(page);
      expect(await deskBox()).toMatchObject({ w: 400, h: 300 });
      await cleanButton(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      // With 24 at the edges the two no longer fit side by side, so they stack: 24 + 130 + 16 + 130 + 16 + 110 + 44.
      expect(await deskBox()).toMatchObject({ w: 400, h: 470 });
      expect(await cameraNow(page)).toEqual(cam);
      await page.screenshot({ path: 'test-results/shots/cleanup-grown.png' });
      await undoButton(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      expect(await deskBox()).toMatchObject({ w: 400, h: 300 });
      expect(await cameraNow(page)).toEqual(cam);
    });

    test('"Undo" leaves the button after 10 s, and stays in the menu until the next change on that desk', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      await cleanButton(page).focus();
      await page.keyboard.press('Enter');
      await expect(undoButton(page)).toHaveCount(1);
      await page.waitForTimeout(10_500);
      expect(await nodes(page, '.desk-undo')).toBe(0);
      await expect(undoButton(page)).toHaveCount(0);
      await expect(page.locator(`[id="proxy-${PERSONAL}"]`)).toBeFocused(); // the keyboard isn't left with nothing

      // It's still there in the menu.
      const box = (await proxyOf(page, 'Personal').boundingBox())!;
      const empty = { x: box.x + box.width - 120, y: box.y + box.height / 2 };
      await page.mouse.click(empty.x, empty.y, { button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: 'Undo clean up' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Clean up', exact: true })).toBeDisabled();
      await page.screenshot({ path: 'test-results/shots/cleanup-menu.png' });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      // Any change ends it.
      await dragApp(page, NOTEBOOK, 10, 200);
      await page.mouse.click(empty.x, empty.y, { button: 'right' });
      await expect(menu.getByRole('menuitem', { name: 'Undo clean up' })).toHaveCount(0);
      await expect(menu.getByRole('menuitem', { name: 'Clean up', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
    });

    test('a reload keeps the tidy layout, and forgets the undo', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      await cleanButton(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_400); // the glide, and the mirror's debounce
      const after = await allPlaces(page);
      await page.reload();
      await canvasPainted(page);
      await page.waitForTimeout(600);
      expect(await allPlaces(page)).toEqual(after);
      await expect(undoButton(page)).toHaveCount(0);
      await expect(cleanButton(page)).toHaveCount(0);
    });

    test('keyboard: the arrows reach it after the apps, Enter runs it, and Enter again undoes it, with focus kept', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      const before = await allPlaces(page);
      await page.locator(`[id="proxy-${CHAT}"]`).focus();
      for (let i = 0; i < 4; i += 1) {
        const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
        if (focused.startsWith('Clean up')) break;
        await page.keyboard.press('ArrowRight');
      }
      await expect(cleanButton(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(undoButton(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(cleanButton(page)).toBeFocused();
      expect(await allPlaces(page)).toEqual(before);
    });

    test('the context menu: `.` opens it, arrows move, Enter runs, Esc closes, and Move starts a keyboard move', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      const before = await allPlaces(page);
      const deskProxy = page.locator(`[id="proxy-${PERSONAL}"]`);
      const menu = page.getByRole('menu');
      await deskProxy.focus();
      await page.keyboard.press('.');
      await expect(menu.getByRole('menuitem', { name: 'Clean up', exact: true })).toBeFocused();
      await expect(menu.getByRole('menuitem')).toHaveCount(3); // Clean up, Move, Resize
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(deskProxy).toBeFocused();
      expect(await allPlaces(page)).toEqual(before);
      expect(await cameraNow(page)).toBeTruthy();

      await page.keyboard.press('.');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('status').first()).toHaveText('Desk cleaned up');
      await expect(deskProxy).toBeFocused();
      await page.keyboard.press('.');
      await expect(menu.getByRole('menuitem', { name: 'Clean up', exact: true })).toBeDisabled();
      await expect(menu.getByRole('menuitem', { name: 'Undo clean up' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(deskProxy).toBeFocused();
      expect(await allPlaces(page)).toEqual(before);

      // On an app it's that app's own, and Move is the same keyboard move as `m`.
      const tile = page.locator(`[id="proxy-${NOTEBOOK}"]`);
      await tile.focus();
      await page.keyboard.press('.');
      await expect(menu.getByRole('menuitem')).toHaveCount(4);
      await expect(menu.getByRole('menuitem', { name: 'Bring to front' })).toBeDisabled(); // focus already brought it there
      await expect(menu.getByRole('menuitem', { name: 'Send to back' })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem', { name: 'Move' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(tile).toHaveClass(/editing/);
      await expect(tile).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      expect((await placeOf(page, NOTEBOOK)).x).toBe(before[NOTEBOOK]!.x + 8);
    });

    test('right click: on a desk its menu, on an app its own, and on the empty canvas nothing of ours', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      const menu = page.getByRole('menu');
      const c = await centerOf(page, AGENT);
      await page.mouse.click(c.x, c.y, { button: 'right' });
      await expect(menu.getByRole('menuitem')).toHaveCount(4);
      await menu.getByRole('menuitem', { name: 'Resize' }).click();
      await expect(menu).toHaveCount(0);
      await expect(page.locator(`[id="proxy-${AGENT}"]`)).toHaveClass(/editing/);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      expect((await placeOf(page, AGENT)).w).toBe(84);

      await page.mouse.click(4, 450, { button: 'right' });
      await expect(menu).toHaveCount(0);
      // A click elsewhere closes it, and takes the camera with it no further than a click would.
      const box = (await proxyOf(page, 'Personal').boundingBox())!;
      await page.mouse.click(box.x + box.width - 120, box.y + box.height / 2, { button: 'right' });
      await expect(menu).toBeVisible();
      await page.mouse.wheel(0, 120);
      await expect(menu).toHaveCount(0);
    });

    test('a click away from the menu only dismisses it: no zoom out, no app opening, and the next click is ordinary', async ({ page, request }) => {
      await seeded(page, request, SCATTERED);
      const menu = page.getByRole('menu');
      const cam = await cameraNow(page);
      const box = (await proxyOf(page, 'Personal').boundingBox())!;
      const openMenu = async (): Promise<void> => {
        await page.mouse.click(box.x + box.width - 120, box.y + box.height / 2, { button: 'right' });
        await expect(menu).toBeVisible();
      };

      await openMenu();
      await page.mouse.click(4, 450); // bare canvas
      await expect(menu).toHaveCount(0);
      await page.waitForTimeout(600);
      expect(await cameraNow(page)).toEqual(cam);

      await openMenu();
      const c = await centerOf(page, NOTEBOOK);
      await page.mouse.click(c.x, c.y); // an app
      await expect(menu).toHaveCount(0);
      await page.waitForTimeout(300);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await cameraNow(page)).toEqual(cam);

      // From the keyboard, the keyboard gets its place back.
      const deskProxy = page.locator(`[id="proxy-${PERSONAL}"]`);
      await deskProxy.focus();
      await page.keyboard.press('.');
      await expect(menu).toBeVisible();
      await page.mouse.click(4, 450);
      await expect(menu).toHaveCount(0);
      await expect(deskProxy).toBeFocused();
      await page.waitForTimeout(300);
      expect(await cameraNow(page)).toEqual(cam);

      // And with the menu gone, a click on the canvas is what it always was: nothing from a desk the office focused
      // on arrival, the overview from one the member focused (ADR 0003). Enter on its proxy focuses it without a click.
      await page.mouse.click(4, 450);
      await page.waitForTimeout(800);
      expect(await cameraNow(page)).toEqual(cam);
      await deskProxy.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      expect(await cameraNow(page)).toEqual(cam);
      await page.mouse.click(4, 450);
      await page.waitForTimeout(800);
      expect((await cameraNow(page)).s).toBeLessThan(cam.s);
    });

    test('an app\'s hover name hides while its menu is open', async ({ page, request }) => {
      await seeded(page, request); // all icons: a widget's name is always there
      const menu = page.getByRole('menu');
      const c = await centerOf(page, AGENT);
      await page.mouse.move(c.x, c.y);
      await page.waitForTimeout(120);
      expect((await hoverNow(page)).names).toEqual(['Agent']);
      await page.mouse.click(c.x, c.y, { button: 'right' });
      await expect(menu).toBeVisible();
      // The menu's backdrop takes the hover away too, a moment later and only if the browser re-checks what's under
      // a still pointer. So let the pointer through, and hold the app under it: its name must stay hidden regardless.
      await page.evaluate(() => { document.querySelector<HTMLElement>('.desk-menu-away')!.style.pointerEvents = 'none'; });
      await page.mouse.move(c.x + 1, c.y + 1);
      await page.waitForTimeout(120);
      expect((await hoverNow(page)).corners).toEqual([`tile-${AGENT}`]); // it does have the hover
      expect((await hoverNow(page)).names).toEqual([]);
      await page.screenshot({ path: 'test-results/shots/cleanup-app-menu.png' });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await page.mouse.move(c.x + 2, c.y + 2);
      await page.waitForTimeout(120);
      expect((await hoverNow(page)).names).toEqual(['Agent']);
    });

    test('a phone has no cleanup and no menu', async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, baseURL: test.info().project.use.baseURL });
      const page = await ctx.newPage();
      await page.request.post('/__harness', { data: { reset: true } });
      await page.request.post('/__harness', { data: { fleet: [personal('running')] } });
      await page.addInitScript((doc) => {
        if (localStorage.getItem('test.seeded')) return;
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v2', JSON.stringify(doc));
      }, { desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 0, w: 800, h: 500, items: [{ id: CHAT, app: 'chat', x: 300, y: 200, w: 76, h: 76 }] } }, z: [PERSONAL] });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(800);
      await expect(cleanButton(page)).toHaveCount(0);
      expect(await nodes(page, '.desk-cleanup')).toBe(0);
      await page.locator(`[id="proxy-${PERSONAL}"]`).focus();
      await page.keyboard.press('.');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await ctx.close();
    });
  });

  // ----- Platform's copy of the layout (contract desks.md).
  test.describe('layout on Platform', () => {
    type Saved = { schemaVersion: number; desks: Record<string, Box & { items: (Box & { id: string })[] }>; z: string[] };
    type Harness = { layoutDocs: Record<string, { version: number; layout: Saved | null } | undefined>; layoutPuts: { status: number; ifMatch: string | null; bytes: number; at: number; user: string }[]; layoutGets: { status: number; ifNoneMatch: string | null }[] };
    const server = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
    const saved = async (request: APIRequestContext): Promise<{ version: number; layout: Saved | null } | undefined> => (await server(request)).layoutDocs['u-test'];
    const putsOf = async (request: APIRequestContext): Promise<Harness['layoutPuts']> => (await server(request)).layoutPuts;
    /** What this desk is at on Platform, in that document's own numbers. */
    const appOnServer = async (request: APIRequestContext, id: string): Promise<(Box & { id: string }) | undefined> => (await saved(request))?.layout?.desks[PERSONAL]?.items.find((i) => i.id === id);
    const serverDoc = (version: number, chatX: number, deskX = 0, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      version,
      updatedAt: '2026-11-05T10:00:00Z',
      layout: {
        schemaVersion: 2,
        desks: {
          [PERSONAL]: {
            x: deskX, y: 36, w: 800, h: 500,
            items: [
              { id: CHAT, app: 'chat', x: chatX, y: 24, w: 76, h: 76 },
              { id: NOTEBOOK, app: 'notebook', x: 300, y: 24, w: 76, h: 76 },
              { id: BROWSER, app: 'browser', x: 500, y: 24, w: 76, h: 76 },
              { id: AGENT, app: 'agent', x: 650, y: 24, w: 76, h: 76 },
            ],
          },
        },
        z: [PERSONAL],
        ...extra,
      },
    });
    /** The app's own console errors. A browser logs a failed request by itself, and no app code can stop that. */
    const ownErrors = (errors: string[]): string[] => errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_'));
    /** A desk with Chat alone, in a document's own terms. */
    const bareDesk = (id: string, x: number, chatY = 24): Record<string, unknown> => ({ x, y: 0, w: 584, h: 300, items: [{ id: `${id}:chat`, app: 'chat', x: 24, y: chatY, w: 76, h: 76 }] });
    const chatY = (p: Page, id: string): Promise<number> => p.locator(`[id="proxy-${id}:chat"]`).evaluate((el: HTMLElement) => parseFloat(el.style.top));
    const dragIn = async (p: Page, id: string, dy: number): Promise<void> => {
      const box = (await p.locator(`[id="proxy-${id}:chat"]`).boundingBox())!;
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 5 });
      await p.mouse.up();
      await p.waitForTimeout(200);
    };

    test('the first load after this ships: what\'s only in this browser is uploaded, not wiped', async ({ page, request }) => {
      const errors = watchConsole(page);
      await seeded(page, request, { [CHAT]: { x: 111.5, y: 222.25, w: 200, h: 180 } });
      await expect.poll(() => saved(request).then((d) => d?.version)).toBe(1);
      const puts = await putsOf(request);
      expect(puts[0]).toMatchObject({ ifMatch: '"0"', status: 200 });
      expect(await appOnServer(request, CHAT)).toMatchObject({ x: 111.5, y: 222.25, w: 200, h: 180 });
      expect(await placeOf(page, CHAT)).toMatchObject({ x: 111.5, y: 222.25, w: 200, h: 180 });
      expect(errors).toEqual([]);
    });

    test('the first load, with a real version-1 layout: migrated, uploaded, and version 1 untouched', async ({ page, request }) => {
      const ids = { personal: 'd-test5i2qpxd', work: 'd-test9w4kzt7', guild: 'd-test3hqr8xb' };
      const v1 = '{"desks":{"d-test5i2qpxd":{"id":"d-test5i2qpxd","x":0,"y":36,"cols":7,"rows":3,"items":[{"id":"d-test5i2qpxd:chat","app":"chat","size":"small"},{"id":"d-test5i2qpxd:notebook","app":"notebook","size":"icon"},{"id":"d-test5i2qpxd:browser","app":"browser","size":"icon"},{"id":"d-test5i2qpxd:agent","app":"agent","size":"icon"}]},"d-test9w4kzt7":{"id":"d-test9w4kzt7","x":728,"y":128,"cols":6,"rows":1,"items":[{"id":"d-test9w4kzt7:chat","app":"chat","size":"icon"},{"id":"d-test9w4kzt7:notebook","app":"notebook","size":"icon"},{"id":"d-test9w4kzt7:browser","app":"browser","size":"icon"},{"id":"d-test9w4kzt7:agent","app":"agent","size":"icon"}]},"d-test3hqr8xb":{"id":"d-test3hqr8xb","x":1312,"y":36,"cols":6,"rows":1,"items":[{"id":"d-test3hqr8xb:agent","app":"agent","size":"icon"},{"id":"d-test3hqr8xb:chat","app":"chat","size":"icon"},{"id":"d-test3hqr8xb:notebook","app":"notebook","size":"icon"},{"id":"d-test3hqr8xb:browser","app":"browser","size":"icon"}]}},"z":["d-test3hqr8xb","d-test9w4kzt7","d-test5i2qpxd"]}';
      await page.addInitScript((doc) => {
        if (localStorage.getItem('test.seeded')) return;
        localStorage.setItem('test.seeded', '1');
        localStorage.setItem('ma.layout.v1', doc);
      }, v1);
      await harness(request, { fleet: [desk(ids.personal, 'Personal', 'personal', 'running'), desk(ids.work, 'Work', 'work', 'running'), desk(ids.guild, 'Guild', 'guild', 'running')] });
      await signIn(page);
      await canvasPainted(page);
      await expect.poll(() => saved(request).then((d) => d?.version)).toBe(1);
      const layout = (await saved(request))!.layout!;
      expect(layout.schemaVersion).toBe(2);
      expect(layout.desks[ids.work]).toMatchObject({ x: 728, y: 128, w: 584, h: 144 });
      expect(layout.desks[ids.personal]).toMatchObject({ x: 0, y: 36, w: 676, h: 328 });
      expect(layout.desks[ids.personal]!.items[0]).toMatchObject({ id: `${ids.personal}:chat`, w: 168, h: 168 });
      expect(layout.desks[ids.guild]!.items.map((i) => i.id.split(':')[1])).toEqual(['agent', 'chat', 'notebook', 'browser']);
      expect(layout.z).toEqual([ids.guild, ids.work, ids.personal]);
      expect(await page.evaluate(() => localStorage.getItem('ma.layout.v1'))).toBe(v1);
    });

    test('with a document on Platform and an older copy here, Platform\'s wins, nothing is saved back, and version 1 is untouched', async ({ page, request }) => {
      await page.addInitScript(() => localStorage.setItem('ma.layout.v1', '{"untouched":true}'));
      await harness(request, { layoutDocs: { 'u-test': serverDoc(7, 400) } });
      await seeded(page, request, { [CHAT]: { x: 24, y: 300, w: 76, h: 76 } });
      await expect.poll(() => placeOf(page, CHAT).then((p) => p.x)).toBe(400);
      expect((await placeOf(page, CHAT)).y).toBe(24);
      await page.waitForTimeout(2_600); // past a save's debounce
      expect(await putsOf(request)).toEqual([]);
      expect((await saved(request))!.version).toBe(7);
      await page.waitForTimeout(0);
      expect(await page.evaluate(() => localStorage.getItem('ma.layout.v1'))).toBe('{"untouched":true}');
      const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2')!) as { desks: Record<string, { items: Box[] }> });
      expect(mirror.desks[PERSONAL]!.items.some((i) => i.x === 400)).toBe(true);
    });

    test('the same document moves nothing and renders nothing, and the canvas never waits for it', async ({ page, request }) => {
      await countCommits(page);
      const same = serverDoc(3, 24);
      // Along with a desk that's gone from the account, which is no reason to render either.
      (same['layout'] as { desks: Record<string, unknown> }).desks['d-destroyed0000'] = bareDesk('d-destroyed0000', 1400);
      await harness(request, { layoutDocs: { 'u-test': same }, layoutDelayMs: 1_500 });
      await seeded(page, request); // the same layout, with the document held back past first paint
      const before = await commits(page);
      await expect.poll(async () => (await server(request)).layoutGets.length).toBeGreaterThan(0);
      await page.waitForTimeout(600);
      expect(await commits(page)).toBe(before);
      await page.waitForTimeout(2_200);
      expect(await putsOf(request)).toEqual([]);
    });

    test('quick changes coalesce into one save, and a held drag saves nothing until it\'s dropped', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, CHAT, 5, 40, 3);
      await dragApp(page, CHAT, 5, 40, 3);
      await dragApp(page, CHAT, 5, 40, 3);
      await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
      await page.waitForTimeout(2_500);
      expect(await putsOf(request)).toHaveLength(1);
      expect((await appOnServer(request, CHAT))!.y).toBeCloseTo(24 + 120, -1);

      // A change is still waiting when the next drag starts, and that drag outlasts the debounce.
      await dragApp(page, BROWSER, 0, 120, 3);
      const c = await centerOf(page, NOTEBOOK);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + 40, c.y + 200, { steps: 6 });
      await page.waitForTimeout(3_000);
      expect(await putsOf(request)).toHaveLength(1);
      await page.mouse.up();
      await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(2);
    });

    test('a change is flushed as the page goes away, with no next load to carry it, and a stationary layout is never saved', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await page.goto('about:blank'); // well inside the debounce
      await expect.poll(() => appOnServer(request, NOTEBOOK).then((a) => a?.y), { timeout: 3_000 }).toBeGreaterThan(150);
      await page.goto('/');
      await canvasPainted(page);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150);
      const after = (await putsOf(request)).length;
      await page.waitForTimeout(2_500);
      expect((await putsOf(request)).length).toBe(after);
    });

    test('a change Platform never heard about is kept, and goes when it next can, across a reload', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) }, layoutFail: { status: 503, method: 'PUT' } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await page.waitForTimeout(2_600);
      expect((await appOnServer(request, NOTEBOOK))!.y).toBe(24);
      await page.reload(); // its save on the way out is refused too
      await canvasPainted(page);
      await expect.poll(async () => (await server(request)).layoutGets.length).toBeGreaterThan(1);
      await page.waitForTimeout(300); // Platform's copy has landed
      expect((await appOnServer(request, NOTEBOOK))!.y).toBe(24);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150); // not wiped by what Platform still says
      await harness(request, { layoutFail: null });
      await expect.poll(() => appOnServer(request, NOTEBOOK).then((a) => a?.y), { timeout: 8_000 }).toBeGreaterThan(150);
    });

    test('a document arriving under a drag waits for the drop, and the dragged desk stays the member\'s', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      const c = await centerOf(page, CHAT);
      const s = await scale(page);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + 30 * s, c.y + 200 * s, { steps: 6 });
      await harness(request, { layoutDocs: { 'u-test': serverDoc(2, 600, 90) } });
      await page.waitForTimeout(5_100); // past the gap between reads
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForTimeout(800);
      // Nothing moved under the pointer.
      const under = await page.evaluate((id) => {
        const st = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): { x(): number } } } } }).__maDesk.camera.getStage();
        return { tile: st.findOne(`#tile-${id}`).x(), desk: st.findOne(`#desk-${'d-personal00001'}`).x() };
      }, CHAT);
      expect(Math.abs(under.tile - 54)).toBeLessThan(2);
      expect(under.desk).toBe(0);
      await page.mouse.up();
      // The desk's own layout is the last writer's, and that's this drop.
      await expect.poll(() => appOnServer(request, CHAT).then((a) => Math.round(a?.y ?? 0)), { timeout: 8_000 }).toBeGreaterThan(200);
      expect((await putsOf(request)).at(-1)!.status).toBe(200);
      await expectAllClear(page);
    });

    test('a browser where nothing was ever arranged uploads nothing, so it can\'t replace an arrangement still to come', async ({ page, request }) => {
      await harness(request, { fleet: [personal('running'), work('running')] });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(2_800);
      expect(await putsOf(request)).toEqual([]);
      await page.reload(); // now from its own mirror
      await canvasPainted(page);
      await page.waitForTimeout(2_800);
      expect(await putsOf(request)).toEqual([]);
      expect(await saved(request)).toBeUndefined();
      // Its first change is the first save.
      await dragIn(page, WORK, 60);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.ifMatch)), { timeout: 6_000 }).toEqual(['"0"']);
    });

    test('an answer older than what this browser knows changes nothing', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(4_400); // past the gap between reads
      let answered = false;
      await page.route('**/v1/me/desk-layout', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const headers = { ...route.request().headers() };
        delete headers['if-none-match'];
        const res = await route.fetch({ headers }); // version 1, as it is now, and it's slow getting back
        await new Promise((done) => setTimeout(done, 3_200));
        await route.fulfill({ response: res });
        answered = true;
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 3_000 }).toBe(2);
      await expect.poll(() => answered, { timeout: 4_000 }).toBe(true);
      await page.waitForTimeout(200);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150);
      await page.unroute('**/v1/me/desk-layout');
      await dragApp(page, BROWSER, 0, 200, 3);
      await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 5_000 }).toBe(2);
      expect((await putsOf(request)).map((p) => p.status)).toEqual([200, 200]); // still knows it's at version 2
    });

    test('a read landing while a save is on its way doesn\'t undo the change', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(4_400); // past the gap between reads
      await page.route('**/v1/me/desk-layout', async (route) => {
        if (route.request().method() === 'PUT') await new Promise((done) => setTimeout(done, 1_500));
        await route.continue();
      });
      const putting = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/v1/me/desk-layout'));
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await putting;
      await harness(request, { layoutDocs: { 'u-test': serverDoc(2, 24, 90) } }); // from another browser
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(async () => (await server(request)).layoutGets.at(-1)?.ifNoneMatch).toBe('"1"');
      await page.waitForTimeout(200);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150);
      // That save meets a 412, and the next one still carries the change.
      await expect.poll(() => appOnServer(request, NOTEBOOK).then((a) => a?.y), { timeout: 8_000 }).toBeGreaterThan(150);
    });

    test('leaving with a document still held back for a drag sends what that document said as well', async ({ page, request }) => {
      const doc = (version: number, workChatY: number): Record<string, unknown> => ({ version, updatedAt: null, layout: { schemaVersion: 2, desks: { [PERSONAL]: bareDesk(PERSONAL, 0), [WORK]: bareDesk(WORK, 656, workChatY) }, z: [PERSONAL, WORK] } });
      await harness(request, { fleet: [personal('running'), work('running')], layoutDocs: { 'u-test': doc(1, 24) } });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(5_200); // past the gap between reads
      await dragIn(page, PERSONAL, 60);
      const box = (await page.locator(`[id="proxy-${PERSONAL}:chat"]`).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20, { steps: 4 });
      await harness(request, { layoutDocs: { 'u-test': doc(2, 200) } }); // another browser moved Chat on Work
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(async () => (await server(request)).layoutGets.at(-1)?.status).toBe(200);
      await page.waitForTimeout(100);
      await page.goto('about:blank'); // with the mouse still down
      await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 3_000 }).toBe(3);
      const layout = (await saved(request))!.layout!;
      expect(layout.desks[WORK]!.items[0]!.y).toBe(200);
      expect(layout.desks[PERSONAL]!.items[0]!.y).toBeGreaterThan(50);
    });

    test('two browsers converge, each keeping what it changed last', async ({ browser, request }) => {
      const open = async (): Promise<Page> => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
        return ctx.newPage();
      };
      await harness(request, {
        fleet: [personal('running'), work('running')],
        layoutDocs: { 'u-test': { version: 1, updatedAt: null, layout: { schemaVersion: 2, desks: { [PERSONAL]: bareDesk(PERSONAL, 0), [WORK]: bareDesk(WORK, 656) }, z: [PERSONAL, WORK] } } },
      });
      const [a, b] = [await open(), await open()];
      for (const p of [a, b]) {
        await signIn(p);
        await canvasPainted(p);
        await p.waitForTimeout(500);
      }
      // Each changes its own desk, with neither having heard of the other yet: the second save meets a 412.
      await dragIn(a, PERSONAL, 80);
      await dragIn(b, WORK, 100);
      await expect.poll(async () => (await putsOf(request)).filter((p) => p.status === 200).length, { timeout: 8_000 }).toBe(2);
      expect((await putsOf(request)).some((p) => p.status === 412)).toBe(true);
      const layout = (await saved(request))!.layout!;
      expect(layout.desks[PERSONAL]!.items[0]!.y).toBeGreaterThan(50);
      expect(layout.desks[WORK]!.items[0]!.y).toBeGreaterThan(50);

      // Each hears of the other's when it comes back to the page.
      await a.waitForTimeout(5_100);
      for (const p of [a, b]) await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(async () => [await chatY(a, PERSONAL), await chatY(a, WORK)].join()).toBe([await chatY(b, PERSONAL), await chatY(b, WORK)].join());
      expect(await chatY(a, WORK)).toBeGreaterThan(50);
      expect(await chatY(b, PERSONAL)).toBeGreaterThan(50);
      await a.context().close();
      await b.context().close();
    });

    test('two tabs of one browser converge at once, with no network', async ({ context, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      const a = await context.newPage();
      await seeded(a, request);
      const b = await context.newPage();
      await b.goto('/');
      await canvasPainted(b);
      await b.waitForTimeout(500);
      const getsBefore = (await server(request)).layoutGets.length;
      await dragApp(a, NOTEBOOK, 0, 180, 3);
      await expect.poll(() => placeOf(b, NOTEBOOK).then((p) => p.y), { timeout: 3_000 }).toBeGreaterThan(150);
      expect((await server(request)).layoutGets.length).toBe(getsBefore);
    });

    test('a conflict that won\'t go away tries a few times, then waits, and keeps the change', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await harness(request, { layoutFail: { status: 412, code: 'version_mismatch', method: 'PUT' } });
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await page.waitForTimeout(4_500);
      const tries = (await putsOf(request)).length;
      expect(tries).toBeGreaterThanOrEqual(2);
      expect(tries).toBeLessThanOrEqual(5);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150);
      await harness(request, { layoutFail: null });
      await expect.poll(() => appOnServer(request, NOTEBOOK).then((a) => a?.y), { timeout: 15_000 }).toBeGreaterThan(150);
    });

    test('"too large" anyway: it sends less and goes again', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await harness(request, { layoutFail: { status: 413, code: 'invalid_request', method: 'PUT', times: 1 } });
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 6_000 }).toEqual([413, 200]);
      expect((await appOnServer(request, NOTEBOOK))!.y).toBeGreaterThan(150);
    });

    test('rate limited: it waits for as long as Retry-After says, and not much longer', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await harness(request, { layoutFail: { status: 429, code: 'rate_limited', method: 'PUT', times: 1, retryAfter: 3 } });
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 8_000 }).toEqual([429, 200]);
      const [first, second] = await putsOf(request);
      expect(second!.at - first!.at).toBeGreaterThanOrEqual(2_900);
      expect(second!.at - first!.at).toBeLessThan(4_500);
      await expect(page.locator('.notice')).toHaveCount(0);
      expect(ownErrors(errors)).toEqual([]);
    });

    test('offline: it goes on working, with no notice and no error of its own, and saves when it\'s back', async ({ page, request, context }) => {
      const errors = watchConsole(page);
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await context.setOffline(true);
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await page.waitForTimeout(2_800);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150);
      await expect(page.locator('.notice')).toHaveCount(0);
      expect((await appOnServer(request, NOTEBOOK))!.y).toBe(24);
      await context.setOffline(false);
      await expect.poll(() => appOnServer(request, NOTEBOOK).then((a) => a?.y), { timeout: 12_000 }).toBeGreaterThan(150);
      await expect(page.locator('.notice')).toHaveCount(0);
      expect(ownErrors(errors)).toEqual([]);
    });

    test('when Platform has no such route yet, it stays local, says nothing, and doesn\'t keep trying to save', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { layoutFail: { status: 404, code: 'not_found' } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, CHAT, 40, 200, 3);
      await page.waitForTimeout(2_800);
      expect(await putsOf(request)).toEqual([]);
      expect((await placeOf(page, CHAT)).y).toBeGreaterThan(150);
      await expect(page.locator('.notice')).toHaveCount(0);
      expect(ownErrors(errors)).toEqual([]);

      // And when the route appears, what's here goes up by itself.
      await harness(request, { layoutFail: null });
      await page.reload();
      await canvasPainted(page);
      await expect.poll(() => appOnServer(request, CHAT).then((a) => a?.y), { timeout: 6_000 }).toBeGreaterThan(150);
    });

    test('a document from a newer build is left alone, and nothing here is lost', async ({ page, request }) => {
      const newer = { version: 9, updatedAt: null, layout: { schemaVersion: 99, whatever: { future: true } } };
      await harness(request, { layoutDocs: { 'u-test': newer } });
      await seeded(page, request, { [CHAT]: { x: 111, y: 222, w: 76, h: 76 } });
      await page.waitForTimeout(600);
      expect(await placeOf(page, CHAT)).toMatchObject({ x: 111, y: 222 });
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await page.waitForTimeout(2_800);
      expect(await putsOf(request)).toEqual([]);
      expect((await saved(request))!).toMatchObject(newer);
      expect((await placeOf(page, NOTEBOOK)).y).toBeGreaterThan(150);
    });

    test('a bad document loses nothing here, and this browser\'s copy replaces it', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { layoutDocs: { 'u-test': { version: 4, updatedAt: null, layout: { schemaVersion: 2, desks: 'not desks' } } } });
      await seeded(page, request, { [CHAT]: { x: 111, y: 222, w: 76, h: 76 } });
      expect(await placeOf(page, CHAT)).toMatchObject({ x: 111, y: 222 });
      await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(5);
      expect((await putsOf(request))[0]!.ifMatch).toBe('"4"');
      expect(await appOnServer(request, CHAT)).toMatchObject({ x: 111, y: 222 });
      expect(errors).toEqual([]);
    });

    test('a hostile number of desks stays under the limit, and all of them stay here', async ({ page, request }) => {
      test.setTimeout(90_000);
      const fleet = Array.from({ length: 260 }, (_, i) => desk(`d-hostile${String(i).padStart(5, '0')}`, `Desk ${i}`, 'custom', 'stopped'));
      await harness(request, { fleet });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(800);
      await expect(page.locator('.proxy-layer [id^="proxy-d-hostile"]')).not.toHaveCount(0);
      // A change on the desk at the top of the stack, with a key, since a canvas this full is small on screen.
      const id = fleet.at(-1)!.deskId;
      await page.locator(`[id="proxy-${id}"]`).focus();
      await page.keyboard.press('m');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Enter');
      await expect.poll(() => putsOf(request).then((p) => p.filter((x) => x.status === 200).length), { timeout: 10_000 }).toBeGreaterThan(0);
      const puts = await putsOf(request);
      expect(puts.every((p) => p.status === 200)).toBe(true);
      expect(Math.max(...puts.map((p) => p.bytes))).toBeLessThanOrEqual(60 * 1024);
      const kept = Object.keys((await saved(request))!.layout!.desks);
      expect(kept.length).toBeGreaterThan(40);
      expect(kept.length).toBeLessThan(260);
      expect(kept).toContain(id); // the top of the stack is among those that go
      expect(kept).not.toContain(fleet[0]!.deskId); // and the bottom isn't
      const mirror = await page.evaluate(() => Object.keys((JSON.parse(localStorage.getItem('ma.layout.v2')!) as { desks: Record<string, unknown> }).desks).length);
      expect(mirror).toBe(260);
      // And coming back, the ones that didn't fit are where they were.
      await page.reload();
      await canvasPainted(page);
      await page.waitForTimeout(500);
      expect(await page.locator('.proxy-layer [id^="proxy-d-hostile"]').count()).toBeGreaterThanOrEqual(260);
    });

    test('a desk gone elsewhere takes only its own entry, and a new one finds a place without moving the rest', async ({ page, request }) => {
      const two = (id: string, x: number): Record<string, unknown> => ({ ...bareDesk(id, x), items: [{ id: `${id}:chat`, app: 'chat', x: 123, y: 45, w: 76, h: 76 }] });
      await harness(request, {
        fleet: [personal('running'), work('running')],
        layoutDocs: { 'u-test': { version: 1, updatedAt: null, layout: { schemaVersion: 2, desks: { [PERSONAL]: two(PERSONAL, 0), [WORK]: two(WORK, 700), 'd-destroyed0000': two('d-destroyed0000', 1400) }, z: [] } } },
      });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(600);
      const placed = (id: string): Promise<number> => page.locator(`[id="proxy-${id}:chat"]`).evaluate((el: HTMLElement) => parseFloat(el.style.left));
      expect(await placed(PERSONAL)).toBe(123);
      expect(await placed(WORK)).toBe(700 + 123);
      await expect(page.locator(`[id="proxy-d-destroyed0000"]`)).toHaveCount(0);

      // Work is destroyed elsewhere: its entry goes, and Personal stays exactly where it was.
      await harness(request, { fleet: [personal('running')] });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(page.locator(`[id="proxy-${WORK}"]`)).toHaveCount(0);
      expect(await placed(PERSONAL)).toBe(123);

      // Nothing changed by the member, so nothing is saved for this alone. The next real change tidies the document.
      await page.waitForTimeout(2_500);
      expect(await putsOf(request)).toEqual([]);
      const box = (await page.locator(`[id="proxy-${PERSONAL}:chat"]`).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 20, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
      const left = Object.keys((await saved(request))!.layout!.desks);
      expect(left).toEqual([PERSONAL]);
    });

    test('another member on this browser never sends the last one\'s unsaved changes', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) }, layoutFail: { status: 503, method: 'PUT' } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, NOTEBOOK, 0, 200, 3); // never reaches Platform
      await page.waitForTimeout(2_400);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.sync.v1')!) as { dirty: string[] });
      expect(stored.dirty).toEqual([PERSONAL]);

      // Signed in afresh as someone else, with desks of their own. Saves still fail: the last member's page tries
      // once more as it goes, as any page going away does, under its own token, and its change stays on record here.
      await harness(request, { userId: 'u-other', fleet: [work('running')] });
      await page.evaluate(() => {
        localStorage.removeItem('ma-desk-web-refresh');
        sessionStorage.removeItem('ma-desk-web-refresh');
        return indexedDB.databases().then((all) => Promise.all(all.map((d) => new Promise((done) => {
          const del = indexedDB.deleteDatabase(d.name!);
          del.onsuccess = del.onerror = del.onblocked = (): void => done(null);
        }))));
      });
      // The list takes longer than a save's debounce, and it's what says these aren't their desks.
      await page.route((url) => url.pathname === '/v1/desks', async (route) => {
        await new Promise((done) => setTimeout(done, 3_000));
        await route.continue();
      });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(4_500);
      const { layoutDocs: docs, layoutPuts } = await server(request);
      expect(layoutPuts.filter((p) => p.user !== 'u-test')).toEqual([]); // nothing of theirs has changed, and nothing of the last member's goes
      expect(docs['u-other']).toBeUndefined();
      expect(docs['u-test']!.version).toBe(1);
    });

    /** Two desks, in a document's own terms. Work's Chat is at `workChatY`. */
    const twoDesks = (version: number, workX: number, workChatY = 24): Record<string, unknown> => ({
      version,
      updatedAt: '2026-11-05T10:00:00Z',
      layout: { schemaVersion: 2, desks: { [PERSONAL]: bareDesk(PERSONAL, 0), [WORK]: bareDesk(WORK, workX, workChatY) }, z: [PERSONAL, WORK] },
    });
    type Mirror = { desks: Record<string, Box & { stack?: string[] }> } | null;
    const mirrorOf = (p: Page): Promise<Mirror> => p.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? 'null') as Mirror);
    const gapBetween = (a: Box, b: Box): number => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

    test('a document with a stack comes through whole, saves nothing by itself, and the next save carries it', async ({ page, request }) => {
      const doc = serverDoc(2, 24);
      ((doc['layout'] as Saved).desks[PERSONAL] as Record<string, unknown>)['stack'] = [AGENT, BROWSER, NOTEBOOK, CHAT];
      await harness(request, { layoutDocs: { 'u-test': doc } });
      await seeded(page, request); // the same places here, with no stack
      await expect.poll(() => mirrorOf(page).then((m) => m?.desks[PERSONAL]?.stack), { timeout: 4_000 }).toEqual([AGENT, BROWSER, NOTEBOOK, CHAT]);
      await page.waitForTimeout(2_400);
      expect(await putsOf(request)).toEqual([]);
      await dragApp(page, NOTEBOOK, 0, 200, 3); // pressing it raises it
      await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
      expect(((await saved(request))!.layout!.desks[PERSONAL] as unknown as { stack: string[] }).stack).toEqual([AGENT, BROWSER, CHAT, NOTEBOOK]);
    });

    test('a document whose desks overlap loads clear, as a local one does, with no save and no loop', async ({ page, request }) => {
      await harness(request, { fleet: [personal('running'), work('running')], layoutDocs: { 'u-test': twoDesks(4, 100) } });
      await signIn(page);
      await canvasPainted(page);
      const gap = async (): Promise<number> => {
        const m = await mirrorOf(page);
        const a = m?.desks[PERSONAL];
        const b = m?.desks[WORK];
        return a && b && a.w === 584 && b.w === 584 ? gapBetween(a, b) : -1;
      };
      await expect.poll(gap, { timeout: 5_000 }).toBeGreaterThanOrEqual(23.9);
      await page.waitForTimeout(2_600); // past a save's debounce
      expect(await putsOf(request)).toEqual([]);
      const placed = await mirrorOf(page);
      // The same overlapping document on the next read: nothing moves, and still nothing goes.
      const reads = (await server(request)).layoutGets.length;
      await page.waitForTimeout(2_800);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(async () => (await server(request)).layoutGets.length, { timeout: 3_000 }).toBeGreaterThan(reads);
      await page.waitForTimeout(1_300);
      expect(await mirrorOf(page)).toEqual(placed);
      expect(await putsOf(request)).toEqual([]);
      // The member's next real change saves once, and what goes up is clear.
      await dragIn(page, WORK, 60);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 6_000 }).toEqual([200]);
      const up = (await saved(request))!.layout!.desks;
      expect(gapBetween(up[PERSONAL]!, up[WORK]!)).toBeGreaterThanOrEqual(23.9);
      await page.waitForTimeout(2_500);
      expect((await putsOf(request)).length).toBe(1);
    });

    test('Platform has no 304: a read with the same ETag writes nothing, renders nothing and moves nothing', async ({ page, request }) => {
      await countCommits(page);
      await harness(request, { layoutDocs: { 'u-test': serverDoc(3, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(1_400); // past the mirror's debounce
      await page.evaluate(() => {
        const w = window as unknown as { __layoutWrites: string[] };
        w.__layoutWrites = [];
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k: string, v: string) {
          if (k.startsWith('ma.layout')) w.__layoutWrites.push(k);
          set.call(this, k, v);
        };
      });
      const cam = (): Promise<string> => page.evaluate(() => JSON.stringify((window as unknown as { __maDesk: { camera: { cam: unknown } } }).__maDesk.camera.cam));
      const before = { commits: await commits(page), cam: await cam() };
      for (let n = 0; n < 2; n += 1) {
        const reads = (await server(request)).layoutGets.length;
        await page.waitForTimeout(5_100); // past the gap between reads
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(async () => (await server(request)).layoutGets.length, { timeout: 3_000 }).toBeGreaterThan(reads);
      }
      await page.waitForTimeout(1_200); // past the mirror's debounce, if it had been told anything
      const gets = (await server(request)).layoutGets;
      expect(gets.every((g) => g.status === 200)).toBe(true); // the document, every time
      expect(gets[gets.length - 1]!.ifNoneMatch).toBe('"3"');
      expect(await page.evaluate(() => (window as unknown as { __layoutWrites: string[] }).__layoutWrites)).toEqual([]);
      expect(await commits(page)).toBe(before.commits);
      expect(await cam()).toBe(before.cam);
      expect(await putsOf(request)).toEqual([]);
    });

    test('ETag and If-Match are exact strings, quotes included, and whatever Platform sends goes back as it came', async ({ page, request }) => {
      await harness(request, { layoutTagPrefix: 'v-', layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.ifMatch)), { timeout: 6_000 }).toEqual(['"v-1"']);
      await dragApp(page, BROWSER, 0, 200, 3);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.ifMatch)), { timeout: 6_000 }).toEqual(['"v-1"', '"v-2"']);
      expect((await putsOf(request)).map((p) => p.status)).toEqual([200, 200]);
      await page.waitForTimeout(5_100);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(async () => (await server(request)).layoutGets.at(-1)!.ifNoneMatch, { timeout: 3_000 }).toBe('"v-3"');
    });

    test('a real 412: it takes what another browser saved, keeps this change, saves once more and stops', async ({ page, request }) => {
      const errors = watchConsole(page);
      await harness(request, { fleet: [personal('running'), work('running')], layoutDocs: { 'u-test': twoDesks(1, 700) } });
      await signIn(page);
      await canvasPainted(page);
      await page.waitForTimeout(800);
      await dragIn(page, PERSONAL, 60);
      await harness(request, { layoutDocs: { 'u-test': twoDesks(5, 700, 120) } }); // another browser, inside the debounce
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 6_000 }).toEqual([412, 200]);
      expect((await putsOf(request)).map((p) => p.ifMatch)).toEqual(['"1"', '"5"']);
      const doc = (await saved(request))!;
      expect(doc.version).toBe(6);
      expect(doc.layout!.desks[PERSONAL]!.items[0]!.y).toBeGreaterThan(30); // this browser's
      expect(doc.layout!.desks[WORK]!.items[0]!.y).toBe(120); // the other's
      expect(await chatY(page, WORK)).toBe(120);
      await page.waitForTimeout(2_500);
      expect((await putsOf(request)).length).toBe(2);
      await expect(page.locator('.notice')).toHaveCount(0);
      expect(ownErrors(errors)).toEqual([]);
    });

    test('a change during Retry-After doesn\'t bring the next save forward', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await harness(request, { layoutFail: { status: 429, code: 'rate_limited', method: 'PUT', times: 1, retryAfter: 6 } });
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 6_000 }).toEqual([429]);
      await dragApp(page, BROWSER, 0, 200, 3); // its own debounce would end well inside the wait
      await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 10_000 }).toEqual([429, 200]);
      const [first, second] = await putsOf(request);
      expect(second!.at - first!.at).toBeGreaterThanOrEqual(5_900);
      expect((await appOnServer(request, NOTEBOOK))!.y).toBeGreaterThan(150);
      expect((await appOnServer(request, BROWSER))!.y).toBeGreaterThan(150);
      await expect(page.locator('.notice')).toHaveCount(0);
    });

    test('a fresh browser at its defaults takes the saved document and writes nothing back', async ({ page, request }) => {
      await harness(request, { fleet: [personal('running')], layoutDocs: { 'u-test': serverDoc(3, 400) } });
      await signIn(page);
      await canvasPainted(page);
      await expect.poll(() => placeOf(page, CHAT).then((p) => p.x), { timeout: 4_000 }).toBe(400);
      await page.waitForTimeout(2_600);
      expect(await putsOf(request)).toEqual([]);
      expect((await saved(request))!.version).toBe(3);
    });

    test('a fixture build never calls the layout route, even after a change', async ({ page, request }) => {
      await signIn(page); // a real session, whose own read goes first: the helper's first page isn't the fixture
      await expect.poll(async () => (await server(request)).layoutGets.length).toBeGreaterThan(0);
      await page.goto('/?fixture=three');
      await canvasPainted(page);
      const reads = (await server(request)).layoutGets.length;
      const proxy = page.getByRole('button', { name: /^Personal desk/ });
      await proxy.focus();
      await page.keyboard.press('m');
      await page.keyboard.press('Shift+ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2_800);
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await page.waitForTimeout(200);
      const seen = await server(request);
      expect(seen.layoutGets.length).toBe(reads);
      expect(seen.layoutPuts).toEqual([]);
    });

    test('sign-out sends what\'s still waiting first', async ({ page, request }) => {
      await harness(request, { layoutDocs: { 'u-test': serverDoc(1, 24) } });
      await seeded(page, request);
      await page.waitForTimeout(600);
      await dragApp(page, NOTEBOOK, 0, 200, 3);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByTestId('sign-in')).toBeVisible();
      expect((await appOnServer(request, NOTEBOOK))!.y).toBeGreaterThan(150);
      // Signed out, nothing more goes, even as the page hides or comes back.
      const seen = await server(request);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('online'));
      });
      await page.waitForTimeout(2_500);
      const after = await server(request);
      expect(after.layoutPuts.length).toBe(seen.layoutPuts.length);
      expect(after.layoutGets.length).toBe(seen.layoutGets.length);
    });
  });

  test('keys only act on the canvas: not in an app window, and not with nothing focused there', async ({ page, request }) => {
    await seeded(page, request);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('m');
    await page.keyboard.press('ArrowRight');
    expect(await placeOf(page, CHAT)).toMatchObject({ x: 24, y: 24 });
    await expect(page.locator('.proxy.editing')).toHaveCount(0);

    await page.locator(`[id="proxy-${CHAT}"]`).focus();
    await page.keyboard.press('Enter');
    const win = page.getByRole('dialog', { name: /Chat/ });
    await expect(win).toBeVisible();
    await page.keyboard.press('m');
    await page.keyboard.press('r');
    await expect(page.locator('.proxy.editing')).toHaveCount(0);
  });

  test('a click during a keyboard edit keeps it and ends it', async ({ page, request }) => {
    await seeded(page, request);
    await page.locator(`[id="proxy-${CHAT}"]`).focus();
    await page.keyboard.press('m');
    await page.keyboard.press('ArrowRight');
    await page.mouse.click(5, 450);
    await expect(page.locator('.proxy.editing')).toHaveCount(0);
    expect((await placeOf(page, CHAT)).x).toBe(32);
  });

  test('a phone keeps the grid: apps stored over each other come apart in its cells, and nothing stacks', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await page.request.post('/__harness', { data: { reset: true } });
    const pile = { x: 100, y: 100, w: 76, h: 76 };
    const list = [AGENT, CHAT, BROWSER, NOTEBOOK];
    const items = [{ id: AGENT, app: 'agent', ...pile }, { id: CHAT, app: 'chat', ...pile }, { id: BROWSER, app: 'browser', ...pile }, { id: NOTEBOOK, app: 'notebook', ...pile }];
    await page.addInitScript((doc) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', JSON.stringify(doc));
    }, { desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 800, h: 500, items } }, z: [PERSONAL] });
    await page.request.post('/__harness', { data: { fleet: [personal('running')] } });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(800);

    // Four cells across, in the list's order, which the keyboard follows too.
    const lefts = await Promise.all(list.map((id) => page.locator(`[id="proxy-${id}"]`).evaluate((el: HTMLElement) => parseFloat(el.style.left))));
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(new Set(lefts).size).toBe(4);
    expect(await domOrder(page)).toEqual(list);

    // A press and a keyboard focus leave the list alone.
    const c = await centerOf(page, BROWSER);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.up();
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.locator(`[id="proxy-${CHAT}"]`).focus();
    await page.waitForTimeout(1_200);
    expect(await drawOrder(page)).toEqual(list);
    await ctx.close();
  });

  test('a phone keeps the grid: a drag reorders, an app has its chip and no free corner, and m does nothing', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    const count = (q: string): Promise<number> => page.evaluate((sel) => (window as unknown as { __maDesk: { camera: { getStage(): { find(q: string): unknown[] } } } }).__maDesk.camera.getStage().find(sel).length, q);
    expect(await count('.app-resize')).toBe(0);
    expect(await count('.size-toggle')).toBe(4);
    const first = page.getByRole('button', { name: /^Chat/ });
    await first.focus();
    await page.keyboard.press('m');
    await expect(page.locator('.proxy.editing')).toHaveCount(0);

    // Drag Agent onto Chat: it takes Chat's cell, and nothing is free-floating.
    const chatAt = (await page.locator('[id="proxy-d-personal:chat"]').evaluate((el: HTMLElement) => el.style.left));
    const from = (await page.locator('[id="proxy-d-personal:agent"]').boundingBox())!;
    const to = (await first.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect(await page.locator('[id="proxy-d-personal:agent"]').evaluate((el: HTMLElement) => el.style.left)).toBe(chatAt);
    await ctx.close();
  });
});

// ----- a click on the canvas outside the desks goes back to the overview, from a desk in focus only (design 3.1, ADR 0003).
test.describe('a click outside the desk', () => {
  const viewMode = (page: Page): Promise<string> => page.evaluate(() => (JSON.parse(localStorage.getItem('ma.view.v1') ?? '{}') as { mode: string }).mode);
  const zoom = (page: Page): Locator => page.locator('.zoom-label');
  const allDesks = (page: Page): Locator => page.getByRole('button', { name: 'Your office, show all desks' });
  const settled = (page: Page): Promise<void> => page.waitForTimeout(800);

  /** A spot on the empty canvas, left of this desk. */
  async function emptySpot(page: Page, name: string): Promise<{ x: number; y: number }> {
    const box = await proxyOf(page, name).boundingBox();
    if (!box || box.x < 60) throw new Error(`no room left of ${name}`);
    return { x: box.x - 50, y: box.y + box.height / 2 };
  }

  /** Three desks, with Personal in focus. */
  async function onPersonal(page: Page): Promise<{ x: number; y: number }> {
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await focusCanvas(page);
    await page.keyboard.press('1');
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(zoom(page)).toHaveText('175%');
    return emptySpot(page, 'Personal');
  }

  async function expectOverview(page: Page): Promise<void> {
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    await expect(zoom(page)).toHaveText('100%');
    await expect(allDesks(page)).toHaveCount(0);
  }

  test('a click returns to the overview', async ({ page }) => {
    const errors = watchConsole(page);
    const spot = await onPersonal(page);
    await page.mouse.click(spot.x, spot.y);
    await expectOverview(page);
    expect(errors).toEqual([]);
  });

  test('movement under the drag threshold is still a click', async ({ page }) => {
    const spot = await onPersonal(page);
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.down();
    await page.mouse.move(spot.x + 3, spot.y);
    await page.mouse.up();
    await expectOverview(page);
  });

  test('a drag is a pan, from the threshold up', async ({ page }) => {
    const spot = await onPersonal(page);
    for (const distance of [4, 80]) {
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.down();
      await page.mouse.move(spot.x + distance, spot.y, { steps: 4 });
      await page.mouse.up();
      await settled(page);
      expect(await viewMode(page)).toBe('free');
      await expect(zoom(page)).toHaveText('175%');
      await expect(allDesks(page)).toBeVisible();
    }
  });

  test('a wheel is not a click; after a zoom out or a pan by hand, a click leaves the view be', async ({ page }) => {
    const spot = await onPersonal(page);
    await page.mouse.move(spot.x, spot.y);
    await page.mouse.wheel(0, 120);
    await settled(page);
    expect(await viewMode(page)).toBe('free');
    await expect(allDesks(page)).toBeVisible();
    const zoomed = await zoom(page).textContent();
    const at = (await proxyOf(page, 'Personal').boundingBox())!;
    await page.mouse.click(spot.x, spot.y);
    await settled(page);
    expect(await viewMode(page)).toBe('free');
    await expect(zoom(page)).toHaveText(zoomed!);
    expect((await proxyOf(page, 'Personal').boundingBox())!.x).toBeCloseTo(at.x, 0);

    // Focused again, then panned: the pan made the view the member's too.
    await page.keyboard.press('1');
    await settled(page);
    const from = await emptySpot(page, 'Personal');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 60, from.y + 20, { steps: 4 });
    await page.mouse.up();
    await settled(page);
    expect(await viewMode(page)).toBe('free');
    const panned = (await proxyOf(page, 'Personal').boundingBox())!;
    const again = await emptySpot(page, 'Personal');
    await page.mouse.click(again.x, again.y);
    await settled(page);
    expect(await viewMode(page)).toBe('free');
    await expect(zoom(page)).toHaveText('175%');
    expect((await proxyOf(page, 'Personal').boundingBox())!.x).toBeCloseTo(panned.x, 0);
  });

  test('zoomed in by hand past the focus, the desk is in focus and a click returns', async ({ page }) => {
    await onPersonal(page);
    await page.keyboard.press('+'); // 1.25x at the middle of the screen
    await settled(page);
    expect(await viewMode(page)).toBe('free');
    await expect(zoom(page)).toHaveText('219%');
    const box = (await proxyOf(page, 'Personal').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y - 40); // above it
    await expectOverview(page);
  });

  test('other mouse buttons do nothing', async ({ page }) => {
    const spot = await onPersonal(page);
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    await page.mouse.click(spot.x, spot.y, { button: 'middle' });
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
  });

  test('a click on a desk keeps its own meaning', async ({ page }) => {
    await onPersonal(page);
    const desk = (await proxyOf(page, 'Personal').boundingBox())!;
    await page.mouse.click(desk.x + desk.width - 60, desk.y + desk.height / 2); // its own empty panel
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(page.locator('.desk-nav-label')).toContainText('Personal');

    const work = (await proxyOf(page, 'Work').boundingBox())!;
    await page.mouse.click(work.x + 20, work.y + work.height / 2); // a neighbor focuses the neighbor
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(page.locator('.desk-nav-label')).toContainText('Work');
  });

  test('a second click while the camera is still moving is not a click outside', async ({ page }) => {
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    const desk = (await proxyOf(page, 'Personal').boundingBox())!;
    await page.mouse.dblclick(desk.x + desk.width - 60, desk.y + desk.height / 2);
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(page.locator('.desk-nav-label')).toContainText('Personal');
  });

  test('clicks on the top bar, the bottom bar and an app window do not count', async ({ page }) => {
    await onPersonal(page);
    await page.getByRole('button', { name: 'Privacy shield' }).click();
    await page.getByRole('button', { name: 'Privacy shield' }).click();
    await page.locator('.desk-nav-label').click();
    await settled(page);
    expect(await viewMode(page)).toBe('desk');

    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
    await tile.focus();
    await page.keyboard.press('Enter');
    const win = page.getByRole('dialog', { name: /Notebook/ });
    await expect(win).toBeVisible();
    await win.locator('.window-head').click({ position: { x: 200, y: 20 } });
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
  });

  test('an open window holds the view; once it closes, a click returns', async ({ page }) => {
    const spot = await onPersonal(page);
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
    await tile.focus();
    await page.keyboard.press('Enter');
    const win = page.getByRole('dialog', { name: /Notebook/ });
    await expect(win).toBeVisible();
    await page.waitForTimeout(300); // the open animation

    await page.mouse.click(spot.x, spot.y); // the canvas, beside the window
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(zoom(page)).toHaveText('175%');
    await expect(win).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(win).toHaveCount(0);
    await page.mouse.click(spot.x, spot.y);
    await expectOverview(page);
  });

  test('one desk: arriving, a click outside leaves it be; once the member clicks the desk, a click zooms out and it stays out', async ({ page }) => {
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(zoom(page)).toHaveText('175%');
    const spot = await emptySpot(page, 'Personal');
    // The office focused it for the member, who didn't: the click changes nothing (the owner, Nov 9).
    await page.mouse.click(spot.x, spot.y);
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(zoom(page)).toHaveText('175%');

    const own = (await proxyOf(page, 'Personal').boundingBox())!;
    await page.mouse.click(own.x + own.width - 60, own.y + own.height / 2); // the member focuses it
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await page.mouse.click(spot.x, spot.y);
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    await expect(zoom(page)).toHaveText('100%');

    await page.setViewportSize({ width: 1200, height: 800 }); // a later refit
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    await expect(zoom(page)).toHaveText('100%');

    const desk = (await proxyOf(page, 'Personal').boundingBox())!;
    await page.mouse.click(desk.x + desk.width - 60, desk.y + desk.height / 2);
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(zoom(page)).toHaveText('175%');
  });

  test('one desk: Esc zooms out too, and the Fit button fills the screen with it again', async ({ page }) => {
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.keyboard.press('Escape');
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    await expect(zoom(page)).toHaveText('100%');
    await page.getByRole('button', { name: 'Fit the desk' }).click();
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await expect(zoom(page)).toHaveText('175%');
  });

  test('one stopped desk: zooming out and a later refit send no wake; arriving again counts as focus', async ({ page, request }) => {
    await harness(request, { fleet: [personal()], refuseWake: { status: 409, code: 'downtime_active' } });
    await signIn(page, REAL_LINK);
    await expect.poll(async () => (await connects(request)).map((c) => c.start)).toEqual([false, true, false]);
    await canvasPainted(page);
    await settled(page);
    await harness(request, { refuseWake: null });

    const spot = await emptySpot(page, 'Personal');
    await page.mouse.click(spot.x, spot.y); // arriving isn't the member focusing it: this leaves the view be
    await settled(page);
    expect(await viewMode(page)).toBe('desk');
    await page.keyboard.press('Escape');
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(1_500);
    expect(await viewMode(page)).toBe('overview');
    expect(await connects(request)).toHaveLength(3);
    expect(await wakes(request)).toHaveLength(1);

    await page.goto(REAL_LINK);
    await expect.poll(() => wakes(request)).toHaveLength(2);
    await expect(proxyOf(page, 'Personal')).toHaveAccessibleName(/, waking · 1 of 4$/);
    expect(await viewMode(page)).toBe('desk');
  });

  test('a tap counts; a pinch does not', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const spot = await onPersonal(page);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: { x: number; y: number; id: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const a = { x: spot.x, y: spot.y, id: 0 };
    const b = { x: spot.x + 40, y: spot.y + 40, id: 1 };
    await touch('touchStart', [a]);
    await touch('touchStart', [a, b]);
    await touch('touchMove', [{ ...a, x: a.x - 5 }, { ...b, x: b.x + 5 }]);
    await touch('touchMove', [{ ...a, x: a.x - 10 }, { ...b, x: b.x + 10 }]);
    await touch('touchEnd', [{ ...b, x: b.x + 10 }]);
    await touch('touchEnd', []);
    await settled(page);
    expect(await viewMode(page)).not.toBe('overview');
    await expect(allDesks(page)).toBeVisible();

    // Two fingers that never move are no click either.
    await touch('touchStart', [a]);
    await touch('touchStart', [a, b]);
    await touch('touchEnd', [b]);
    await touch('touchEnd', []);
    await settled(page);
    expect(await viewMode(page)).not.toBe('overview');

    await page.touchscreen.tap(spot.x, spot.y);
    await settled(page);
    expect(await viewMode(page)).toBe('overview');
    await ctx.close();
  });
});

// ----- no desks: what the account's membership says, and nothing until it has said it.
test.describe('no desks', () => {
  const noBilling = async (page: Page): Promise<void> => {
    await expect(page.getByRole('link', { name: 'Open billing' })).toHaveCount(0);
    await expect(page.getByText(/not connected/i)).toHaveCount(0);
  };

  /** Every `desks-*` notice that is ever in the page, however briefly. */
  async function recordNotices(page: Page): Promise<() => Promise<string[]>> {
    await page.addInitScript(() => {
      const seen = new Set<string>();
      (window as unknown as { __notices: Set<string> }).__notices = seen;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-testid^="desks-"]')) seen.add(el.getAttribute('data-testid') ?? '');
      }).observe(document, { childList: true, subtree: true });
    });
    return () => page.evaluate(() => [...(window as unknown as { __notices: Set<string> }).__notices]);
  }

  // The cards themselves are in membership.shell.spec.ts.
  for (const [status, card] of [['unpaid', 'welcome'], ['waitlisted', 'waitlist']] as const) {
    test(`${status} sees its membership card, with no link to billing before billing opens`, async ({ page, request }, info) => {
      await harness(request, { desks: 'empty', membership: { status, billingUrl: `${info.project.use.baseURL}/billing` } });
      await signIn(page);
      await expect(page.getByTestId(`desks-${card}`)).toBeVisible();
      await expect(page.getByTestId('desks-empty')).toHaveCount(0);
      await noBilling(page);
    });
  }

  for (const membership of [{ status: 'active', tier: 'officer' }, { status: 'active', tier: 'lead', comped: true }]) {
    test(`${membership.comped ? 'comped' : 'active'} sees that the desk is on its way`, async ({ page, request }) => {
      await harness(request, { desks: 'empty', membership });
      await signIn(page);
      await expect(page.getByTestId('desks-empty')).toContainText('Your desk is on its way');
      await expect(page.locator('[data-card]')).toHaveCount(0);
      await noBilling(page);
    });
  }

  test('nothing shows before /v1/me answers, so the wrong notice never flashes', async ({ page, request }) => {
    await harness(request, { desks: 'empty', membership: { status: 'unpaid' } });
    const seen = await recordNotices(page);
    let answer = (): void => {};
    const held = new Promise<void>((done) => {
      answer = done;
    });
    await page.route('**/v1/me', async (route) => {
      await held;
      await route.continue();
    });
    await signIn(page);
    await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { log: string[] }).log).toContain('GET /v1/desks');
    await page.waitForTimeout(500);
    expect(await seen()).toEqual([]);

    answer();
    await expect(page.getByTestId('desks-welcome')).toBeVisible();
    expect(await seen()).toEqual(['desks-welcome']);
  });

  test('if /v1/me fails, the calm error state, and Try again finds out', async ({ page, request }) => {
    await harness(request, { desks: 'empty' });
    const seen = await recordNotices(page);
    await page.route('**/v1/me', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable","message":"Try again.","retryable":true}}' }));
    await signIn(page);
    await expect(page.getByTestId('desks-error')).toBeVisible();
    await page.unroute('**/v1/me');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('desks-empty')).toBeVisible();
    expect(await seen()).toEqual(['desks-error', 'desks-empty']);
  });

  test('the desk list saying unpaid shows nothing until /v1/me has answered', async ({ page, request }) => {
    await harness(request, { desks: 'unpaid', membership: { status: 'unpaid' } });
    const seen = await recordNotices(page);
    let answer = (): void => {};
    const held = new Promise<void>((done) => {
      answer = done;
    });
    await page.route('**/v1/me', async (route) => {
      await held;
      await route.continue();
    });
    await signIn(page);
    await expect.poll(async () => ((await (await request.get('/__harness')).json()) as { log: string[] }).log).toContain('GET /v1/desks');
    await page.waitForTimeout(500);
    expect(await seen()).toEqual([]);
    answer();
    await expect(page.getByTestId('desks-welcome')).toBeVisible();
    await noBilling(page);
  });

});
