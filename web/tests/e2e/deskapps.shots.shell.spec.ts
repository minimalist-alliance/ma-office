// The desk app host's shots for the Designer's review (ADR 0054), at 1280 x 800 in Light, Zen and Dark: the menu row, the Apps
// sheet with Tally and the Bible's row, a detail, adding, Tally's window, its tile's widget, a failed tile, the refused view,
// a 390 px phone's thumb row with its Apps button and the sheet from it, the Bible's window in its ink, and its shortcuts.
// Skipped unless APPS_SHOTS names a folder for them.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const OUT = process.env['APPS_SHOTS'];
const PERSONAL = 'd-personal00001';
const TALLY = 'com.minimalistalliance.sample.tally';
const BIBLE = 'com.minimalistalliance.bible';
const TALLY_ITEM = `${PERSONAL}:app:${TALLY}`;
const NAMES: Record<ThemeId, string> = { light: 'light', dusk: 'zen', dark: 'dark' };

type Hook = { __maDeskMock: { apps: { fail(d: string, a: string, p: string): void; tamper: Record<string, string> } }; __maDesk: { camera: { isMoving(): boolean } } };

test.skip(!OUT, 'APPS_SHOTS is not set');
test.use({ viewport: { width: 1280, height: 800 } });

const shot = (page: Page, theme: ThemeId, name: string): Promise<Buffer> => page.screenshot({ path: `${OUT}/${name}-${NAMES[theme]}.png` });
const settle = async (page: Page): Promise<void> => {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
  await page.waitForTimeout(300);
};

async function office(page: Page, theme: ThemeId, preinstalled: string[], widgetTile = false, tamper: Record<string, string> = {}): Promise<void> {
  if (widgetTile) {
    const items = [
      { id: `${PERSONAL}:chat`, app: 'chat', x: 24, y: 24, w: 76, h: 76 },
      { id: `${PERSONAL}:notebook`, app: 'notebook', x: 116, y: 24, w: 76, h: 76 },
      { id: `${PERSONAL}:browser`, app: 'browser', x: 208, y: 24, w: 76, h: 76 },
      { id: `${PERSONAL}:agent`, app: 'agent', x: 300, y: 24, w: 76, h: 76 },
      { id: TALLY_ITEM, app: `app:${TALLY}`, x: 24, y: 116, w: 168, h: 168 },
      { id: `${PERSONAL}:app:${BIBLE}`, app: `app:${BIBLE}`, x: 208, y: 116, w: 260, h: 168 },
    ];
    await page.addInitScript((d) => {
      // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
      if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', d);
    }, JSON.stringify({ desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 584, h: 344, items } }, z: [PERSONAL] }));
  }
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 60_000, preinstalled: { [PERSONAL]: preinstalled }, tamper });
  await setTheme(page, theme);
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }], appFrames: true });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600);
}

async function menu(page: Page): Promise<void> {
  await settle(page);
  await page.locator(`[id="proxy-${PERSONAL}"]`).focus();
  await page.keyboard.press('.');
  await expect(page.getByRole('menu', { name: 'Desk' })).toBeVisible();
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the menu row, the sheet, a detail and adding`, async ({ page }) => {
    await office(page, theme, []);
    await menu(page);
    await page.getByTestId('desk-menu-apps').focus();
    await shot(page, theme, '01-menu-row');
    await page.getByTestId('desk-menu-apps').click();
    await expect(page.getByTestId(`dapp-row-${BIBLE}`)).toBeVisible();
    await page.mouse.move(0, 0);
    await shot(page, theme, '02-apps-sheet');
    await page.getByTestId(`dapp-row-${BIBLE}`).getByRole('button', { name: /^Bible\./ }).click();
    await expect(page.getByTestId(`dapp-detail-${BIBLE}`)).toBeVisible();
    await shot(page, theme, '03-detail-bible');
    await page.getByTestId('dapp-back').click();
    await page.getByTestId(`dapp-row-${TALLY}`).getByRole('button', { name: /^Tally\./ }).click();
    await shot(page, theme, '04-detail-tally');
    await page.getByTestId('dapp-back').click();
    await page.getByTestId(`dapp-add-${TALLY}`).click();
    await expect(page.getByTestId(`dapp-add-${TALLY}`)).toHaveText('Adding…');
    await page.mouse.move(0, 0);
    await shot(page, theme, '05-adding');
  });

  test(`${theme}: Tally's window, the widgets, a failed tile and the refused view`, async ({ page }) => {
    await office(page, theme, [TALLY, BIBLE], true);
    await page.locator(`[id="proxy-${PERSONAL}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await settle(page);
    await page.locator(`[id="proxy-${TALLY_ITEM}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    const frame = page.frameLocator('[data-testid="deskapp-frame"]');
    await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
    for (let i = 0; i < 3; i += 1) await frame.getByRole('button', { name: 'Count one more' }).click();
    await expect(frame.locator('#count')).toHaveText('3');
    await page.waitForTimeout(400);
    await shot(page, theme, '06-tally-window');
    // Keys inside the view are the view's, so the window's own Close button.
    await page.locator('.ma-window').getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(600);
    await shot(page, theme, '07-tile-widgets');
    await page.evaluate((a) => (window as unknown as Hook).__maDeskMock.apps.fail('d-personal00001', a, 'memory'), TALLY);
    await page.waitForTimeout(600);
    await shot(page, theme, '08-failed-tile');
    await page.locator(`[id="proxy-${TALLY_ITEM}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.locator('[data-panel="stopped"]')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, theme, '09-failed-window');
  });

  test(`${theme}: the refused view`, async ({ page }) => {
    await office(page, theme, [TALLY], false, { [TALLY]: 'view/view.js' });
    await page.locator(`[id="proxy-${TALLY_ITEM}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.locator('[data-panel="unsafe"]')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, theme, '10-refused-view');
  });

  test(`${theme}: a 390 px phone, the thumb row's Apps button and the sheet it opens`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await office(page, theme, [TALLY]);
    await page.locator(`[id="proxy-${TALLY_ITEM}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    const frame = page.frameLocator('[data-testid="deskapp-frame"]');
    await expect(page.locator('.carousel-stage [data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
    for (let i = 0; i < 3; i += 1) await frame.getByRole('button', { name: 'Count one more' }).click();
    await page.getByTestId('thumb-apps').focus();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/11-phone-thumbs-${NAMES[theme]}.png` });
    await page.getByTestId('thumb-apps').click();
    await expect(page.getByTestId(`dapp-row-${BIBLE}`)).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/12-phone-sheet-${NAMES[theme]}.png` });
  });

  test(`${theme}: the Bible's window in its ink (Lapis), and the shortcuts list's Bible group`, async ({ page }) => {
    await office(page, theme, [TALLY, BIBLE], true);
    await page.locator(`[id="proxy-${PERSONAL}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await settle(page);
    await page.locator(`[id="proxy-${PERSONAL}:app:${BIBLE}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.locator('[data-testid="deskapp-frame"][data-state="ready"]')).toBeVisible();
    await page.waitForTimeout(500);
    await shot(page, theme, '13-bible-window');
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await page.getByTestId('shortcuts-app-Bible').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, theme, '14-shortcuts-bible');
  });
}
