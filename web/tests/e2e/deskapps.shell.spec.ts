// Desk apps (ADR 0054, S-97's Desk app half): the Apps row and sheet, Add to desk and the tile, the window with its checks, its
// sandboxed frame and its bridge, Remove keeping data, a Guild Desk member, a tampered view, the kill switches, the frame
// budget, a phone, the carousel, and axe in three themes. The mock desk serves the sample app, Tally, as a catalog app signed
// with a test review key (`src/desk/mockDeskApps.ts`), and the Bible's row as a bundled first-party app.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const PERSONAL = 'd-personal00001';
const TALLY = 'com.minimalistalliance.sample.tally';
const BIBLE = 'com.minimalistalliance.bible';
const TALLY_ITEM = `${PERSONAL}:app:${TALLY}`;
const fleet = [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }];

interface MockInit {
  available?: boolean;
  reason?: string;
  noCatalog?: boolean;
  installMs?: number;
  preinstalled?: Record<string, string[]>;
  tamper?: Record<string, string>;
}
type Hook = {
  __maDeskMock: { apps: { fail(d: string, a: string, p: string): void; tamper: Record<string, string>; calls: { m: string; p: Record<string, unknown> }[] }; rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[] };
  __maDesk: { appWidget(deskId: string, app: string): { title: string; text?: string; foot?: string } | null; camera: { isMoving(): boolean } };
};

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/**
 * The office with apps on, the frame's CSP addition on, and one personal desk. `seedLayout`: its layout already holds the
 * Notebook's tile and Tally's, as a desk whose app was added before (on another device, say) comes up.
 */
async function office(page: Page, request: APIRequestContext, opts: { mock?: MockInit; theme?: ThemeId; harness?: Record<string, unknown>; seedLayout?: boolean } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  if (opts.seedLayout) {
    const items = [
      { id: `${PERSONAL}:notebook`, app: 'notebook', x: 24, y: 24, w: 76, h: 76 },
      { id: TALLY_ITEM, app: `app:${TALLY}`, x: 116, y: 24, w: 76, h: 76 },
    ];
    await page.addInitScript((d) => {
      // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
      if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', d);
    }, JSON.stringify({ desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 700, h: 540, items } }, z: [PERSONAL] }));
  }
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 300, ...opts.mock });
  if (opts.theme) await setTheme(page, opts.theme);
  await harness(request, { fleet, appFrames: true, ...opts.harness });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(400);
  return errors;
}

const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const deskMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Desk' });
const sheet = (page: Page): Locator => page.getByRole('dialog', { name: /Apps/ });
const row = (page: Page, id: string): Locator => page.getByTestId(`dapp-row-${id}`);
const view = (page: Page): FrameLocator => page.frameLocator('[data-testid="deskapp-frame"]');

/** A tile's proxy, pressed as the keyboard and a screen reader do: the canvas over it takes the pointer. */
async function openTile(page: Page, id: string): Promise<void> {
  await proxy(page, id).evaluate((el) => (el as HTMLButtonElement).click());
}

/** The camera at rest: a menu closes when it moves. */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
  await page.waitForTimeout(200);
}

async function openDeskMenu(page: Page, deskId = PERSONAL): Promise<void> {
  await settled(page);
  await proxy(page, deskId).focus();
  await page.keyboard.press('.');
  await expect(deskMenu(page)).toBeVisible();
}

async function openSheet(page: Page, deskId = PERSONAL): Promise<void> {
  await openDeskMenu(page, deskId);
  await deskMenu(page).getByRole('menuitem', { name: 'Apps', exact: true }).click();
  await expect(sheet(page)).toBeVisible();
}

async function addTally(page: Page): Promise<void> {
  await openSheet(page);
  await expect(row(page, TALLY)).toBeVisible();
  await page.getByTestId(`dapp-add-${TALLY}`).click();
  await expect(page.getByTestId(`dapp-add-${TALLY}`)).toHaveText('Adding…');
  await expect(page.getByTestId(`dapp-open-${TALLY}`)).toBeVisible();
}

async function openTally(page: Page): Promise<void> {
  await page.getByTestId(`dapp-open-${TALLY}`).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
}

test('the Apps row opens the sheet: Tally and the Bible, Free, Add to desk; a row opens its detail', async ({ page, request }) => {
  const errors = await office(page, request);
  await openSheet(page);
  await expect(sheet(page)).toContainText('Personal');
  await expect(row(page, BIBLE)).toContainText('Bible');
  await expect(row(page, BIBLE)).toContainText('Read, search and keep notes in four translations.');
  await expect(row(page, BIBLE)).toContainText('Free');
  await expect(row(page, TALLY)).toContainText('Tally');
  await expect(page.getByTestId(`dapp-add-${BIBLE}`)).toHaveText('Add to desk');
  // No ratings, counts or badges.
  await expect(sheet(page).getByText(/★|rating|installs|downloads/i)).toHaveCount(0);

  await row(page, BIBLE).getByRole('button', { name: /^Bible\./ }).click();
  const detail = page.getByTestId(`dapp-detail-${BIBLE}`);
  await expect(detail).toContainText('Read the Bible on your desk in the Berean Standard Bible');
  await expect(detail).toContainText('By Minimalist Alliance');
  await expect(detail).not.toContainText('Reviewed by Minimalist Alliance');
  await expect(detail).toContainText('It asks for nothing else: no internet, no files, no Browser.');
  await expect(detail).toContainText('Size: 7.2 MB');
  await expect(detail).toContainText('King James Version (KJV), the 1769 text. Public domain in the United States.');
  await page.getByTestId('dapp-back').click();
  await row(page, TALLY).getByRole('button', { name: /^Tally\./ }).click();
  await expect(page.getByTestId(`dapp-detail-${TALLY}`)).toContainText('Reviewed by Minimalist Alliance');
  await expect(page.getByTestId(`dapp-detail-${TALLY}`)).toContainText('By Minimalist Alliance');
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Add to desk is one tap: grants are the version permissions, the tile comes, and the window counts through the bridge', async ({ page, request }) => {
  const errors = await office(page, request);
  await addTally(page);
  const install = await page.evaluate(() => (window as unknown as Hook).__maDeskMock.rpc.find((r) => r.m === 'apps.install'));
  expect(install?.p).toEqual({ id: 'com.minimalistalliance.sample.tally', version: '0.1.0', packageSha256: 'c'.repeat(64), grants: [] });
  expect(install?.options?.idem).toMatch(/^[0-9a-f-]{36}$/);
  await expect(proxy(page, TALLY_ITEM)).toHaveAccessibleName('Tally');

  await openTally(page);
  await expect(view(page).locator('#count')).toHaveText('0');
  for (let i = 0; i < 3; i += 1) {
    await view(page).getByRole('button', { name: 'Count one more' }).click();
    await expect(view(page).locator('#count')).toHaveText(String(i + 1));
  }
  // Each + is `apps.mutate`, with the view's own key; the read is `apps.call`.
  const calls = await page.evaluate(() => (window as unknown as Hook).__maDeskMock.rpc.filter((r) => r.m === 'apps.mutate' || r.m === 'apps.call'));
  expect(calls.filter((c) => c.m === 'apps.mutate')).toHaveLength(3);
  for (const c of calls.filter((x) => x.m === 'apps.mutate')) {
    expect(c.p).toEqual({ id: TALLY, m: 'tally.add', p: { by: 1 } });
    expect(c.options?.idem).toMatch(/^[0-9a-f]{8}-/);
  }
  expect(calls.some((c) => c.m === 'apps.call' && c.p['m'] === 'tally.get')).toBe(true);
  // The widget draws from the summary.
  await expect.poll(() => page.evaluate((a) => (window as unknown as Hook).__maDesk.appWidget('d-personal00001', a)?.title, `app:${TALLY}`)).toBe('3');
  expect(errors).toEqual([]);
});

test('Remove keeps the app data: re-adding shows the old count, and the tile comes and goes', async ({ page, request }) => {
  const errors = await office(page, request);
  await addTally(page);
  await openTally(page);
  for (let i = 1; i <= 3; i += 1) {
    await view(page).getByRole('button', { name: 'Count one more' }).click();
    await expect(view(page).locator('#count')).toHaveText(String(i));
  }
  await page.keyboard.press('Shift+Escape');
  await openSheet(page);
  await page.getByTestId(`dapp-remove-${TALLY}`).click();
  await expect(page.getByTestId(`dapp-add-${TALLY}`)).toHaveText('Add to desk');
  await expect(proxy(page, TALLY_ITEM)).toHaveCount(0);
  // No question asked, and the data isn't asked to go: `apps.remove` with only the id.
  const removed = await page.evaluate(() => (window as unknown as Hook).__maDeskMock.rpc.filter((r) => r.m === 'apps.remove').map((r) => r.p));
  expect(removed).toEqual([{ id: TALLY }]);
  await page.getByTestId(`dapp-add-${TALLY}`).click();
  await expect(page.getByTestId(`dapp-open-${TALLY}`)).toBeVisible();
  await openTally(page);
  await expect(view(page).locator('#count')).toHaveText('3');
  expect(errors).toEqual([]);
});

test("a failed app's tile says why in the contract's words, and Restart starts it", async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } } });
  await expect(proxy(page, TALLY_ITEM)).toHaveAccessibleName('Tally');
  await page.evaluate((a) => (window as unknown as Hook).__maDeskMock.apps.fail('d-personal00001', a, 'memory'), TALLY);
  await expect(proxy(page, TALLY_ITEM)).toHaveAccessibleName('Tally, Stopped: used too much memory');
  await expect.poll(() => page.evaluate((a) => (window as unknown as Hook).__maDesk.appWidget('d-personal00001', a)?.text, `app:${TALLY}`)).toBe('Stopped: used too much memory');
  await openTile(page, TALLY_ITEM);
  const panel = page.locator('[data-testid="deskapp-panel"][data-panel="stopped"]');
  await expect(panel).toContainText('Stopped: used too much memory');
  await page.getByTestId('deskapp-restart').click();
  await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await expect(view(page).locator('#count')).toHaveText('0');
  const starts = await page.evaluate(() => (window as unknown as Hook).__maDeskMock.rpc.filter((r) => r.m === 'apps.start').map((r) => r.p));
  expect(starts).toEqual([{ id: TALLY }]);
  await expect(proxy(page, TALLY_ITEM)).toHaveAccessibleName('Tally');
  expect(errors).toEqual([]);
});

test('a view file changed after it was signed: "This app couldn\'t be opened safely." and nothing is built', async ({ page, request }) => {
  // Changed from the start, so even the idle prefetch only ever sees the changed file.
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] }, tamper: { [TALLY]: 'view/view.js' } } });
  await openTile(page, TALLY_ITEM);
  await expect(page.locator('[data-testid="deskapp-panel"][data-panel="unsafe"]')).toHaveText("This app couldn't be opened safely.");
  await expect(page.locator('[data-testid="deskapp-frame"]')).toHaveCount(0);
  // Nothing reached the app: no call, no subscription.
  const relayed = await page.evaluate(() => (window as unknown as Hook).__maDeskMock.rpc.filter((r) => r.m === 'apps.call' || r.m === 'apps.mutate').length);
  expect(relayed).toBe(0);
  expect(errors).toEqual([]);
});

test("today's office policy (no blob: in script-src): the frame says it couldn't start, and the view never runs", async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } }, harness: { appFrames: false } });
  await openTile(page, TALLY_ITEM);
  await expect(page.locator('[data-testid="deskapp-panel"][data-panel="failed"]')).toContainText("This app's window couldn't start.");
  const relayed = await page.evaluate(() => (window as unknown as Hook).__maDeskMock.rpc.filter((r) => r.m === 'apps.call').length);
  expect(relayed).toBe(0);
  // The browser says why: the office's policy blocked the view's script. That line, and only that, is expected here.
  expect(errors.filter((e) => !/Loading the script 'blob:/.test(e))).toEqual([]);
});

test('a Guild Desk member sees the installed app to open, and no Add or Remove', async ({ page, request }) => {
  const errors = watchConsole(page);
  const GUILD = 'gu-designreview';
  const PANEL = `guild-${GUILD}`;
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, preinstalled: { [PANEL]: [TALLY] } });
  await harness(request, { guilds: { wakeMs: 300, list: [{ guildId: GUILD, name: 'Design review', role: 'member', grants: [] }] }, appFrames: true });
  await signIn(page, '/?fixture=one&speed=fast');
  await canvasPainted(page);
  // Opening one of its apps wakes the Guild Desk; then it says what's installed, and the app's tile comes.
  await page.getByRole('group', { name: 'Design review desk' }).getByRole('button', { name: /^Notebook/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(proxy(page, `${PANEL}:app:${TALLY}`)).toBeAttached({ timeout: 15_000 });
  await page.keyboard.press('Shift+Escape');
  await openSheet(page, PANEL);
  await expect(page.getByTestId(`dapp-open-${TALLY}`)).toBeVisible();
  await expect(page.getByTestId(`dapp-remove-${TALLY}`)).toHaveCount(0);
  // Nothing to add: the catalog's other app isn't offered to a member.
  await expect(row(page, BIBLE)).toHaveCount(0);
  await page.getByTestId(`dapp-open-${TALLY}`).click();
  await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await view(page).getByRole('button', { name: 'Count one more' }).click();
  await expect(view(page).locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('the kill switch hides the Apps row and leaves the tile its widget, with no window', async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } }, harness: { deskApps: { enabled: false } } });
  await expect(proxy(page, TALLY_ITEM)).toBeAttached();
  await openDeskMenu(page);
  await expect(deskMenu(page).getByRole('menuitem', { name: 'Apps', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openTile(page, TALLY_ITEM);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-testid="deskapp-view"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate((a) => (window as unknown as Hook).__maDesk.appWidget('d-personal00001', a)?.title, `app:${TALLY}`)).toBe('0');
  expect(errors).toEqual([]);
});

test("deskd's switch (available: false) hides the Apps row too, and no window opens", async ({ page, request }) => {
  // The host's chunk loads for a desk that says apps are available, or a layout with an app's tile: here, the tile.
  const errors = await office(page, request, { mock: { available: false, reason: 'switched_off', preinstalled: { [PERSONAL]: [TALLY] } }, seedLayout: true });
  await expect(proxy(page, TALLY_ITEM)).toBeAttached();
  await expect(proxy(page, TALLY_ITEM)).toHaveAccessibleName(/^Tally/);
  await openDeskMenu(page);
  await expect(deskMenu(page).getByRole('menuitem', { name: 'Apps', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openTile(page, TALLY_ITEM);
  await page.waitForTimeout(500);
  await expect(page.locator('[data-testid="deskapp-view"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the frame budget: three long frames in 10 s while a view shows and the office is idle pause it; Resume brings it back', async ({ page, request }) => {
  const errors = await office(page, request);
  await addTally(page);
  await openTally(page);
  await view(page).getByRole('button', { name: 'Count one more' }).click();
  await expect(view(page).locator('#count')).toHaveText('1');
  await page.waitForTimeout(1300); // the office idle: no input for a second
  for (let i = 0; i < 3; i += 1) {
    // A long animation frame, as a view holding the office's main thread makes one.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => {
      document.body.dataset['frame'] = String(Math.random());
      const end = performance.now() + 90;
      while (performance.now() < end) { /* the frame runs long */ }
      done();
    })));
    await page.waitForTimeout(150);
  }
  await expect(page.locator('[data-testid="deskapp-panel"][data-panel="paused"]')).toContainText('Paused to keep your desk smooth');
  await expect(page.locator('[data-testid="deskapp-frame"]')).toHaveCount(0);
  await page.getByTestId('deskapp-resume').click();
  await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await expect(view(page).locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('a theme switch reaches the view as tokens, and the UI font is loaded in its frame', async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } } });
  await openTile(page, TALLY_ITEM);
  await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  const bg = () => view(page).locator('body').evaluate((b) => getComputedStyle(b).backgroundColor);
  const light = await bg();
  await expect.poll(() => view(page).locator('body').evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(bg).not.toBe(light);
  expect(errors).toEqual([]);
});

test("a 390 px phone: the thumb row's Apps button opens the sheet over the whole screen, and an app added there opens in the carousel", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } } });
  await expect(proxy(page, TALLY_ITEM)).toBeAttached();
  await openTile(page, TALLY_ITEM);
  await expect(page.locator('.carousel-stage [data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await view(page).getByRole('button', { name: 'Count one more' }).click();
  await expect(view(page).locator('#count')).toHaveText('1');
  // A phone has no desk menu: the Apps button ends the thumbs, before the way back to the desk.
  const apps = page.getByTestId('thumb-apps');
  await expect(apps).toHaveAttribute('aria-label', 'Apps');
  const order = await page.locator('[data-testid="carousel-thumbs"] > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? el.className));
  expect(order).toEqual(['thumb-tabs', 'thumb-apps', 'thumb-sep', 'thumb-desk']);
  await apps.click();
  await expect.poll(async () => (await page.getByTestId('apps-sheet').boundingBox())?.width).toBe(390);
  expect((await page.getByTestId('apps-sheet').boundingBox())!.height).toBe(844);
  await page.getByTestId(`dapp-add-${BIBLE}`).click();
  await page.getByTestId(`dapp-open-${BIBLE}`).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByTestId('carousel-stage')).toHaveAttribute('data-app', `app:${BIBLE}`);
  const bible = `[data-testid="carousel-slide-app:${BIBLE}"] [data-testid="deskapp-frame"]`;
  await expect(page.locator(`${bible}[data-state="ready"]`)).toBeVisible();
  await expect(page.frameLocator(bible).locator('#t')).toHaveText('The reading view comes with the app.');
  expect(errors).toEqual([]);
});

test("with apps switched off, a phone's thumb row has no Apps button", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } }, harness: { deskApps: { enabled: false } }, seedLayout: true });
  // Tally opens no window with apps off, so the Notebook's opens the carousel.
  await openTile(page, `${PERSONAL}:notebook`);
  await expect(page.getByTestId('carousel-stage')).toBeVisible();
  await expect(page.getByTestId('carousel-thumbs')).toBeVisible();
  await expect(page.getByTestId('thumb-apps')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the Bible's ink (Lapis) reaches its view in its window, in each theme, and Tally's view keeps the office's", async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY, BIBLE] } } });
  // As the view sets them from its tokens (lower case: the window's properties as the browser gives them).
  const frameOf = (id: string): FrameLocator => page.frameLocator(`[data-testid="window-app:${id}"] [data-testid="deskapp-frame"]`);
  const prop = (id: string, name: string) => (): Promise<string> => frameOf(id).locator('html').evaluate((h, n) => getComputedStyle(h).getPropertyValue(n).trim().toUpperCase(), name);
  // The stand-in Bible view sets its tokens as `--bible-*`, the sample as `--ma-*`.
  const accent = prop(BIBLE, '--bible-accent-default');
  const windowBg = prop(BIBLE, '--bible-surface-window');
  await openTile(page, `${PERSONAL}:app:${BIBLE}`);
  await expect(page.locator('.ma-window [data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await expect.poll(accent).toBe('#2C51B6');
  expect(await windowBg()).toBe('#FDFDFE');
  // The window around it wears the same ink (themes.css), so the head and the view match.
  expect(await page.locator(`.ma-window[data-app="app:${BIBLE}"]`).evaluate((w) => getComputedStyle(w).getPropertyValue('--ma-accent').trim().toUpperCase())).toBe('#2C51B6');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(accent).toBe('#759BF2');
  expect(await windowBg()).toBe('#22242A');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Zen', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect.poll(accent).toBe('#9FBDFE');
  await openTile(page, TALLY_ITEM);
  await expect(page.locator(`[data-testid="window-app:${TALLY}"] [data-testid="deskapp-frame"][data-state="ready"]`)).toBeVisible();
  const officeAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ma-accent').trim().toUpperCase());
  await expect.poll(prop(TALLY, '--ma-accent-default')).toBe(officeAccent);
  expect(errors).toEqual([]);
});

test('the frame may write the clipboard inside its own tap, and never read it', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } } });
  await openTile(page, TALLY_ITEM);
  await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await expect(page.getByTestId('deskapp-frame')).toHaveAttribute('allow', 'clipboard-write');
  const policy = await view(page).locator('html').evaluate(() => {
    const fp = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
    return { write: fp?.allowsFeature('clipboard-write'), read: fp?.allowsFeature('clipboard-read') };
  });
  expect(policy).toEqual({ write: true, read: false });
  // A Copy button of the view's own (made here as a view would), pressed by the member.
  await view(page).locator('html').evaluate(() => {
    const b = document.createElement('button');
    b.id = 'copy';
    b.textContent = 'Copy';
    b.onclick = () => {
      navigator.clipboard.writeText('John 3:16').then(() => (b.dataset['done'] = 'ok'), (e: unknown) => (b.dataset['done'] = String(e)));
    };
    document.body.append(b);
  });
  await view(page).locator('#copy').click();
  await expect(view(page).locator('#copy')).toHaveAttribute('data-done', 'ok');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('John 3:16');
  // Reading is refused in the frame, tap or not.
  await view(page).locator('html').evaluate(() => {
    const b = document.getElementById('copy')!;
    b.onclick = () => {
      navigator.clipboard.readText().then(() => (b.dataset['read'] = 'read'), () => (b.dataset['read'] = 'refused'));
    };
  });
  await view(page).locator('#copy').click();
  await expect(view(page).locator('#copy')).toHaveAttribute('data-read', 'refused');
  expect(errors.filter((e) => !/clipboard|permissions policy/i.test(e))).toEqual([]);
});

test('the shortcuts list has a Bible group where the Bible is installed, and none where it isn\'t', async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } } });
  const list = async (): Promise<Locator> => {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const disclosure = page.getByRole('button', { name: 'Keyboard shortcuts' });
    if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
    await expect(page.getByTestId('shortcuts')).toBeVisible();
    return page.getByTestId('shortcuts-app-Bible');
  };
  expect(await (await list()).count()).toBe(0);
  await page.keyboard.press('Escape');
  await openSheet(page);
  await page.getByTestId(`dapp-add-${BIBLE}`).click();
  await expect(page.getByTestId(`dapp-open-${BIBLE}`)).toBeVisible();
  await page.keyboard.press('Escape');
  const bible = await list();
  await expect(bible).toBeVisible();
  await expect(bible.locator('dt')).toHaveText(['← →', '/', 'g', 'Esc']);
  await expect(bible.locator('dd')).toHaveText(['Previous or next chapter', 'Search', 'Go to', 'Close the top panel, or clear the selection']);
  await expect(page.getByTestId('shortcuts').getByText('Bible', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('in carousel mode the app is a slide, its own window component: its window is handed to the carousel', async ({ page, request }) => {
  const errors = await office(page, request, { mock: { preinstalled: { [PERSONAL]: [TALLY] } } });
  await openTile(page, TALLY_ITEM);
  await expect(page.locator('.ma-window [data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await view(page).getByRole('button', { name: 'Count one more' }).click();
  await expect(view(page).locator('#count')).toHaveText('1');
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^(Carousel|Back to the desk)$/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('carousel-stage')).toBeVisible();
  await expect(page.locator('.carousel-slide [data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
  await expect(page.locator('[data-testid="deskapp-frame"]')).toHaveCount(1);
  await view(page).getByRole('button', { name: 'Count one more' }).click();
  await expect(view(page).locator('#count')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('as an open tile, enlarged on its desk, the app is live there', async ({ page, request }) => {
  const errors = watchConsole(page);
  const items = [
    { id: `${PERSONAL}:notebook`, app: 'notebook', x: 24, y: 24, w: 76, h: 76 },
    { id: TALLY_ITEM, app: `app:${TALLY}`, x: 116, y: 24, w: 536, h: 444 },
  ];
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 700, h: 540, items } }, z: [PERSONAL] }));
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, preinstalled: { [PERSONAL]: [TALLY] } });
  await harness(request, { fleet, appFrames: true });
  await signIn(page);
  await canvasPainted(page);
  await openTile(page, PERSONAL);
  await expect(page.locator('.open-layer [data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible({ timeout: 10_000 });
  await view(page).getByRole('button', { name: 'Count one more' }).click();
  await expect(view(page).locator('#count')).toHaveText('1');
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`axe, ${theme}: the Apps sheet, a detail, and the window`, async ({ page, request }) => {
    const errors = await office(page, request, { theme });
    const run = async (include: string): Promise<string[]> => {
      await page.evaluate((src) => { (0, eval)(src); }, AXE);
      return page.evaluate(async (inc) => {
        const r = await (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run({ include: [inc] }, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] });
        return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      }, include);
    };
    await openSheet(page);
    expect(await run('[data-testid="apps-sheet"]')).toEqual([]);
    await row(page, BIBLE).getByRole('button', { name: /^Bible\./ }).click();
    expect(await run('[data-testid="apps-sheet"]')).toEqual([]);
    await page.getByTestId('dapp-back').click();
    await page.getByTestId(`dapp-add-${TALLY}`).click();
    await openTally(page);
    // The window at rest: measured while it still grows in, its buttons are smaller than they are (axe's target-size).
    await page.locator('.ma-window').evaluate((w) => Promise.all(w.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
    expect(await run('.ma-window')).toEqual([]);
    expect(errors).toEqual([]);
  });
}
