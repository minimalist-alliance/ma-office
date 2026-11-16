// Shots of the owner's final app icons (the MA mark's 3D finish, variant B; Courier the raven; the Bible in Lapis; Files in
// Silver), for the UI/UX Engineer and the Product Designer to read against design-drafts/app-icons/final-3d/sheet-final-3d.png:
// a desk with all seven apps at 100 % and 50 % (with a desk of larger tiles under it), an enlarged tile zoomed out (its big centred glyph), the hidden list (the 24 px
// cuts), the phone's thumb row, the Apps sheet with the Bible, Files' window, in Light, Zen and Dark. Commons sits on a member's
// desk here only so all seven show together. On MockDeskLink: nobody's real data. Skipped unless ICONS3D_SHOTS names the folder:
//   ICONS3D_SHOTS=/abs/dir MA_PW_PORT=5181 npx playwright test --project=shell icons3d.shots --workers=1
// The same desk in WebKit and Firefox: tests/glyphs/playwright.xb.config.ts runs the first test there.
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['ICONS3D_SHOTS'] ?? '';
const NAMES: Record<ThemeId, string> = { light: 'light', dusk: 'zen', dark: 'dark' };
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const STUDIO = 'd-studio0000001';
const BIBLE = 'com.minimalistalliance.bible';

test.skip(!OUT, 'ICONS3D_SHOTS names the folder for the screenshots');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
test.setTimeout(180_000);

type Hook = { __maDesk: { camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };
const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons', `app:${BIBLE}`];
const item = (deskId: string, app: string, x: number, y: number, w = 76, h = 76) => ({ id: `${deskId}:${app}`, app, x, y, w, h });
// Personal: all seven as icons. Studio: Files large, the Bible, Courier ("Coming later" at 100 %) and the Notebook medium.
const personal = APPS.map((a, k) => item(PERSONAL, a, 24 + k * 92, 24));
const studio = [
  item(STUDIO, 'files', 24, 24, span(4), span(4)),
  item(STUDIO, `app:${BIBLE}`, 24 + span(4) + 16, 24, span(2), span(2)),
  item(STUDIO, 'courier', 24 + span(4) + 16 + span(2) + 16, 24, span(2), span(2)),
  item(STUDIO, 'notebook', 24 + span(4) + 16, 24 + span(2) + 16, span(2), span(2)),
];
// Six icons under one large Browser tile: the hidden count, and its list of 24 px cuts.
const work = [...['files', 'notebook', 'agent', 'courier', 'commons', `app:${BIBLE}`].map((a, k) => item(WORK, a, 40 + (k % 3) * 92, 40 + Math.floor(k / 3) * 92)), item(WORK, 'browser', 24, 24, span(4), span(3))];
const DESKS: Record<string, { id: string; x: number; y: number; w: number; h: number; items: ReturnType<typeof item>[] }> = {
  [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 24 + 7 * 92 - 16 + 24, h: 24 + 76 + 60, items: personal },
  [STUDIO]: { id: STUDIO, x: 0, y: 260, w: 24 + span(4) + 16 + 2 * (span(2) + 16) + 8, h: 24 + span(4) + 60, items: studio },
  [WORK]: { id: WORK, x: 900, y: 36, w: 24 + span(4) + 24, h: 24 + span(3) + 60, items: work },
};

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(400);
}

async function arrive(page: Page, theme: ThemeId, path = '/'): Promise<string[]> {
  const errors = watchConsole(page);
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: DESKS, z: [PERSONAL, STUDIO, WORK] }));
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 60_000, preinstalled: { [PERSONAL]: [BIBLE], [STUDIO]: [BIBLE], [WORK]: [BIBLE] }, tamper: {} });
  await setTheme(page, theme);
  await harness(page.request, { reset: true });
  await harness(page.request, {
    fleet: [
      { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: STUDIO, name: 'Studio', kind: 'work', state: 'running' },
      { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
    ],
    files: { enabled: true },
    appFrames: true,
  });
  await signIn(page, path);
  await canvasPainted(page);
  await page.waitForTimeout(800);
  return errors;
}

/** A desk's top-left `at` px from the screen's, at scale s. */
async function look(page: Page, deskId: string, s: number, at = 40): Promise<void> {
  const d = DESKS[deskId]!;
  await page.evaluate(({ s, x, y, at }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: at - x * s, y: at + 40 - y * s }), { s, x: d.x, y: d.y, at });
  await settled(page);
  await page.mouse.move(2, 790);
}

const file = (name: string, theme: ThemeId, browser = 'chromium'): string => `${OUT}/${name}-${NAMES[theme]}${browser === 'chromium' ? '' : `-${browser}`}.png`;

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${NAMES[theme]}: all seven apps at 100 % and 50 %, an enlarged tile zoomed out, the hidden list's cuts`, async ({ page, browserName }) => {
    mkdirSync(OUT, { recursive: true });
    const errors = await arrive(page, theme);
    // Both desks, Personal's seven icons over Studio's larger tiles.
    await look(page, PERSONAL, 1);
    await page.screenshot({ path: file('01-desk-100', theme, browserName) });
    if (browserName !== 'chromium') return;
    await look(page, PERSONAL, 0.5);
    await page.screenshot({ path: file('02-desk-50', theme) });
    // The enlarged tile zoomed out: Studio's large Files tile at 40 % and 25 % (`card`), its glyph big and centred.
    for (const s of [0.4, 0.25]) {
      await look(page, STUDIO, s, 200);
      const d = DESKS[STUDIO]!;
      await page.screenshot({ path: file(`03-enlarged-${s * 100}`, theme), clip: { x: 170, y: 210, width: d.w * s + 60, height: d.h * s + 60 } });
    }
    // The hidden list: six apps under the Work desk's Browser, their rows' 24 px cuts.
    await look(page, WORK, 1);
    await page.locator(`[id="proxy-hidden:${WORK}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    const list = page.getByRole('menu', { name: 'Hidden apps on the Work desk' });
    await expect(list).toBeVisible();
    await expect(list.locator('canvas.hidden-list-glyph')).toHaveCount(6);
    await page.waitForTimeout(300);
    const box = (await list.boundingBox())!;
    await page.screenshot({ path: file('04-hidden-list', theme), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 120 } });
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test(`${NAMES[theme]}: the Apps sheet with the Bible, Files' window, window heads`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium');
    mkdirSync(OUT, { recursive: true });
    const errors = await arrive(page, theme);
    await look(page, PERSONAL, 1);
    await page.locator(`[id="proxy-${PERSONAL}"]`).focus();
    await page.keyboard.press('.');
    await expect(page.getByRole('menu', { name: 'Desk' })).toBeVisible();
    await page.getByTestId('desk-menu-apps').click();
    await expect(page.getByTestId(`dapp-row-${BIBLE}`)).toBeVisible();
    await expect(page.getByTestId(`dapp-row-${BIBLE}`).locator('canvas.app-glyph')).toHaveCount(1);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: file('05-apps-sheet', theme) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // Files' window over the desk, its head's glyph the canvas's.
    await page.locator(`[id="proxy-${PERSONAL}:files"]`).evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.getByRole('dialog', { name: /Files/ });
    await expect(win).toBeVisible();
    await expect(page.getByRole('listbox', { name: /^Files in/ })).toBeVisible();
    await expect(win.locator('canvas.app-glyph')).toHaveCount(1);
    // A selected row, in Files' own accentSubtle.
    await page.locator('[data-testid="files-row"][data-name="Documents"]').click();
    await page.mouse.move(2, 790);
    await page.waitForTimeout(500);
    await page.screenshot({ path: file('06-files-window', theme) });
    const head = (await win.locator('.window-head').boundingBox())!;
    await page.screenshot({ path: file('07-window-head', theme), clip: { x: head.x, y: head.y, width: Math.min(320, head.width), height: head.height } });
    expect(errors).toEqual([]);
  });

  test(`${NAMES[theme]}: a 390 px phone's thumb row`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium');
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, theme);
    await page.locator(`[id="proxy-${PERSONAL}:notebook"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId('carousel-thumbs')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: file('08-phone-thumbs', theme) });
    const row = (await page.getByTestId('carousel-thumbs').boundingBox())!;
    await page.screenshot({ path: file('09-phone-thumb-row', theme), clip: { x: 0, y: row.y - 8, width: 390, height: row.height + 8 } });
    expect(errors).toEqual([]);
  });
}
