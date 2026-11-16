// Shots of an app's zoom (ADR 0055) for the Designer's read, skipped unless APP_ZOOM_SHOTS names a folder: the button at rest
// and the popout open on a window in Light, Zen and Dark; the zoom and expand buttons side by side at 1x, 2x and a 4x crop;
// an open tile; the phone's carousel; the Notebook at 50, 100 and 200 %; the Browser's button on a desk that zooms it.
import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, type ThemeId } from './helpers';

const SHOTS = process.env['APP_ZOOM_SHOTS'] ?? '';
const THEMES: [ThemeId, string][] = [['light', 'light'], ['dusk', 'zen'], ['dark', 'dark']];
const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const OPEN = { w: span(6), h: span(5) };
const fleet = [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }];
type Hook = { __maDesk: { camera: { isMoving(): boolean } } };

test.skip(!SHOTS, 'APP_ZOOM_SHOTS names the folder for the shots');

async function office(page: Page, theme: ThemeId, layout?: Record<string, unknown>): Promise<void> {
  await harness(page.request, { reset: true });
  await setTheme(page, theme);
  await harness(page.request, { fleet, files: { enabled: true }, ...(layout ? { layoutDocs: { [ME]: { version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks: layout, z: Object.keys(layout) } } } } : {}) });
  await signIn(page);
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
  await page.waitForTimeout(300);
}

async function notebook(page: Page): Promise<Locator> {
  await page.locator(`[id="proxy-${PERSONAL}:notebook"]`).evaluate((el) => (el as HTMLButtonElement).click());
  const w = page.getByTestId('window-notebook');
  await expect(w).toBeVisible();
  await page.waitForTimeout(700);
  return w;
}

const shot = async (target: Page | Locator, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await (target as Page).screenshot({ path: `${SHOTS}/${name}.png`, ...(clip ? { clip } : {}) });
};

/** The window's controls, the zoom and expand buttons, with a little room round them. */
async function buttonsClip(w: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const a = (await w.locator('.app-zoom-btn').boundingBox())!;
  const b = (await w.getByRole('button', { name: /^(Fill the screen|Restore window)$/ }).boundingBox())!;
  return { x: a.x - 8, y: a.y - 6, width: b.x + b.width - a.x + 16, height: a.height + 12 };
}

for (const [theme, name] of THEMES) {
  test(`${name}: a window's head at rest and the popout open, the Notebook at 50, 100 and 200 %`, async ({ page }) => {
    await office(page, theme);
    const w = await notebook(page);
    await shot(page, `${name}-window-rest`);
    const head = (await w.locator('.window-head').boundingBox())!;
    await shot(page, `${name}-head-rest`, { x: head.x, y: head.y, width: head.width, height: head.height });
    await shot(page, `${name}-buttons-1x`, await buttonsClip(w));
    await w.locator('.app-zoom-btn').click();
    await expect(page.getByRole('slider', { name: 'Zoom' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await shot(page, `${name}-window-popout`);
    const pop = (await page.getByTestId('app-zoom-pop').boundingBox())!;
    await shot(page, `${name}-popout`, { x: pop.x - 260, y: head.y, width: pop.width + 280, height: pop.y + pop.height - head.y + 12 });
    if (theme === 'light') {
      for (const [key, level] of [['Home', 50], ['End', 200]] as const) {
        await page.keyboard.press(key);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await shot(page, `notebook-${level}`);
        await w.locator('.app-zoom-btn').click();
        await expect(page.getByRole('slider', { name: 'Zoom' })).toBeFocused();
      }
      await page.getByRole('button', { name: /back to 100%$/ }).click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await shot(page, 'notebook-100');
    }
  });
}

test.describe('at 2x', () => {
  test.use({ deviceScaleFactor: 2 });
  for (const [theme, name] of THEMES) {
    test(`${name}: the zoom and expand buttons side by side at 2x`, async ({ page }) => {
      await office(page, theme);
      const w = await notebook(page);
      await shot(page, `${name}-buttons-2x`, await buttonsClip(w));
    });
  }
});

test.describe('at 4x', () => {
  test.use({ deviceScaleFactor: 4, viewport: { width: 1280, height: 800 } });
  test('light: a 4x crop of the two buttons', async ({ page }) => {
    await office(page, 'light');
    const w = await notebook(page);
    await shot(page, 'light-buttons-4x', await buttonsClip(w));
  });
});

test('light: an open tile, its head and the popout', async ({ page }) => {
  await office(page, 'light', { [PERSONAL]: { x: 0, y: 0, w: 24 + OPEN.w + 24, h: 24 + OPEN.h + 16 + 76 + 60, items: [{ id: `${PERSONAL}:notebook`, app: 'notebook', x: 24, y: 24, ...OPEN }, { id: `${PERSONAL}:files`, app: 'files', x: 24, y: 24 + OPEN.h + 16, w: 76, h: 76 }] } });
  const t = page.getByTestId('open-tile-notebook');
  await expect(t).toBeVisible();
  await shot(page, 'opentile-rest');
  await t.locator('.app-zoom-btn').click();
  await expect(page.getByRole('slider', { name: 'Zoom' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await shot(page, 'opentile-popout');
});

test('light: the Browser\'s button on a desk that zooms it', async ({ page }) => {
  await office(page, 'light');
  await page.evaluate(() => {
    const m = (window as unknown as { __maDeskMock: { browserZoom: boolean; zoom: Record<string, number> } }).__maDeskMock;
    m.browserZoom = true;
    m.zoom['d-personal00001'] = 125;
  });
  await page.locator(`[id="proxy-${PERSONAL}:browser"]`).evaluate((el) => (el as HTMLButtonElement).click());
  const w = page.getByTestId('window-browser');
  await expect(w.locator('.app-zoom-btn')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'browser-button');
  await w.locator('.app-zoom-btn').click();
  await expect(page.getByRole('slider', { name: 'Zoom' })).toBeFocused();
  await page.waitForTimeout(300);
  await shot(page, 'browser-popout');
});

test('light: the Browser on a deskd before browser.zoom.*, with no zoom button', async ({ page }) => {
  await office(page, 'light');
  await page.locator(`[id="proxy-${PERSONAL}:browser"]`).evaluate((el) => (el as HTMLButtonElement).click());
  const w = page.getByTestId('window-browser');
  await expect(w).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string }[] } }).__maDeskMock.rpc.some((r) => r.m === 'browser.zoom.get'))).toBe(true);
  await page.waitForTimeout(800);
  await expect(w.locator('.app-zoom-btn')).toHaveCount(0);
  await shot(page, 'browser-nozoom');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  for (const [theme, name] of THEMES) {
    test(`${name}: the phone's carousel, the slide's head and the popout`, async ({ page }) => {
      await office(page, theme);
      const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
      const b = (await tile.boundingBox())!;
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      const slide = page.locator('.carousel-slide:not(.leaving)');
      await expect(slide).toHaveAttribute('data-app', 'notebook');
      await page.waitForTimeout(700);
      await shot(page, `${name}-phone-rest`);
      const btn = (await slide.locator('.app-zoom-btn').boundingBox())!;
      await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
      await expect(page.getByTestId('app-zoom-pop')).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, `${name}-phone-popout`);
    });
  }
});
