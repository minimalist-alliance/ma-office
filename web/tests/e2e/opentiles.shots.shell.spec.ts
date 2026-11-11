// Screenshots of open tiles (ADR 0053) for the Designer, in Light, Zen and Dark at 1280 x 800: the Notebook and the Browser
// open side by side, the corner's grip at rest and under the pointer, Files and the Agent open, the widget zoomed out, "Open in
// its window" while the Notebook's window is open, and a Notebook tile under 640 px wide with its column behind the toggle and
// over the page. On MockDeskLink: nobody's real data. Skipped unless OPEN_TILE_SHOTS names the folder to write to, so it never
// runs in the suite:
//   OPEN_TILE_SHOTS=/abs/dir MA_PW_PORT=4941 npx playwright test --project=shell opentiles.shots
import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['OPEN_TILE_SHOTS'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const OPEN = { w: span(6), h: span(5) };
const BROWSER = { w: span(7), h: span(5) };

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[] }
type Hook = { __maDesk: { camera: { cam: { s: number }; isMoving(): boolean; getStage(): { findOne(q: string): { visible(): boolean } | undefined } } } };

test.skip(!OUT, 'OPEN_TILE_SHOTS names the folder for the screenshots');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

const item = (deskId: string, app: string, x: number, y: number, size = { w: 76, h: 76 }): Item => ({ id: `${deskId}:${app}`, app, x, y, ...size });
const deskOf = (x: number, items: Item[]): Desk => ({
  x,
  y: 0,
  w: Math.max(...items.map((i) => i.x + i.w)) + 24,
  h: Math.max(...items.map((i) => i.y + i.h)) + 44 + 16,
  items,
});
const desks = (): Record<string, Desk> => ({
  [PERSONAL]: deskOf(0, [
    item(PERSONAL, 'notebook', 24, 24, OPEN),
    item(PERSONAL, 'browser', 24 + OPEN.w + 16, 24, BROWSER),
    item(PERSONAL, 'chat', 24, 24 + OPEN.h + 16),
    item(PERSONAL, 'files', 116, 24 + OPEN.h + 16),
    item(PERSONAL, 'agent', 208, 24 + OPEN.h + 16),
  ]),
  [WORK]: deskOf(1400, [
    item(WORK, 'files', 24, 24, OPEN),
    item(WORK, 'agent', 24 + OPEN.w + 16, 24, OPEN),
    item(WORK, 'chat', 24, 24 + OPEN.h + 16),
    item(WORK, 'notebook', 116, 24 + OPEN.h + 16),
    item(WORK, 'browser', 208, 24 + OPEN.h + 16),
  ]),
});

const tile = (page: Page, app: string): Locator => page.getByTestId(`open-tile-${app}`);
const shown = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((i) => !!(window as unknown as Hook).__maDesk.camera.getStage().findOne(`#tile-${i}`)?.visible(), id);

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

/** Every live tile's ground is opaque, and the canvas's own tile under it is hidden. */
async function nothingUnder(page: Page): Promise<void> {
  const tiles = await page.locator('.open-tile').evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset['item']!, bg: getComputedStyle(e).backgroundColor })));
  expect(tiles.length).toBeGreaterThan(0);
  for (const t of tiles) {
    expect(t.bg, t.id).toMatch(/^rgb\(/);
    expect(await shown(page, t.id), t.id).toBe(false);
  }
}

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await setTheme(page, theme);
  await harness(request, {
    fleet: [
      { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
    ],
    files: { enabled: true },
    layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks: desks(), z: [PERSONAL, WORK] } } },
  });
  await signIn(page);
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  return errors;
}

for (const theme of THEMES) {
  const name = theme === 'dusk' ? 'zen' : theme;
  test(`${name}: open tiles at 1280 x 800`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme);
    const nbTile = tile(page, 'notebook');
    await expect(nbTile.getByTestId('note-editor')).toBeVisible();
    await expect(tile(page, 'browser')).toBeVisible();
    await expect.poll(() => tile(page, 'browser').getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
    await nothingUnder(page);

    // 1. The Notebook and the Browser side by side, the pointer off both. The Notebook is under 640 px wide: its column is
    //    behind the toggle.
    const nb = (await nbTile.boundingBox())!;
    expect(nb.width).toBeLessThan(640);
    await expect(nbTile.locator('.nb-side')).toBeHidden();
    const park = { x: nb.x + nb.width - 100, y: nb.y + nb.height + 60 }; // the desk's own ground, right of the icons
    await page.mouse.move(park.x, park.y);
    await shot(page, `${name}-1-notebook-browser`);

    // 2 and 3. The corner's grip: at rest (the pointer on the tile) and under the pointer.
    const corner = { x: nb.x + nb.width - 150, y: nb.y + nb.height - 100, width: 180, height: 120 };
    await page.mouse.move(nb.x + nb.width - 90, nb.y + nb.height - 60);
    await expect.poll(() => nbTile.locator('.window-edge.se').evaluate((e) => getComputedStyle(e, '::after').opacity)).toBe('1');
    await shot(page, `${name}-2-grip-at-rest`, corner);
    const grip = (await nbTile.locator('.window-edge.se').boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.waitForTimeout(200);
    await shot(page, `${name}-3-grip-under-pointer`, corner);
    await shot(page, `${name}-3b-grip-under-pointer-full`);

    // 4. The Notebook tile's column over the page, from its toggle.
    await page.mouse.move(park.x, park.y);
    await nbTile.getByRole('button', { name: 'Notebooks and pages' }).click();
    await expect(nbTile.locator('.nb-side')).toBeVisible();
    await shot(page, `${name}-4-notebook-column-open`, { x: nb.x - 20, y: nb.y - 20, width: nb.width + 40, height: nb.height + 40 });
    await page.keyboard.press('Escape');
    await expect(nbTile.locator('.nb-side')).toBeHidden();

    // 5. Files and the Agent, open on the Work desk.
    await focusCanvas(page);
    await page.keyboard.press('2');
    await settled(page);
    await expect(tile(page, 'files').locator('[data-testid="files-row"]').first()).toBeVisible();
    await expect(tile(page, 'agent').getByTestId('key-input')).toBeVisible();
    await nothingUnder(page);
    await page.mouse.move(40, 780);
    await shot(page, `${name}-5-files-agent`);

    // 6. Zoomed out until the tiles are under 480 px wide: the widgets, drawn by the canvas.
    await focusCanvas(page);
    await page.keyboard.press('1');
    await settled(page);
    for (let n = 0; n < 4 && OPEN.w * (await page.evaluate(() => (window as unknown as Hook).__maDesk.camera.cam.s)) >= 480; n += 1) {
      await page.keyboard.press('-');
      await settled(page);
    }
    await expect(page.locator('.open-tile')).toHaveCount(0);
    expect(await shown(page, `${PERSONAL}:notebook`)).toBe(true);
    await shot(page, `${name}-6-widget-zoomed-out`);

    // 7. The Notebook in its window: its tile is the widget, with "Open in its window".
    await page.keyboard.press('1');
    await settled(page);
    await nbTile.getByRole('button', { name: 'Open in its window' }).click();
    const win = page.getByRole('dialog', { name: /Notebook/ });
    await expect(win).toBeVisible();
    await expect(nbTile).toHaveCount(0);
    // Moved right, whole on screen, clear of the widget's foot where the note is.
    const wb = (await win.boundingBox())!;
    const wh = (await win.locator('.window-head').boundingBox())!;
    const dx = Math.max(nb.x + 280, 1280 - 16 - wb.width) - wb.x;
    await page.mouse.move(wh.x + 200, wh.y + wh.height / 2);
    await page.mouse.down();
    for (let n = 1; n <= 6; n += 1) await page.mouse.move(wh.x + 200 + (dx * n) / 6, wh.y + wh.height / 2);
    await page.mouse.up();
    await page.mouse.move(park.x, park.y);
    await shot(page, `${name}-7-open-in-its-window`);
    expect(errors).toEqual([]);
  });
}
