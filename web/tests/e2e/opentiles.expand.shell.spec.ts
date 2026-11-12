// Open tiles end to end (S-145, ADR 0053), the way the owner put it: "When I expand the apps enough, they are supposed to
// actually be viewable and usable right there on my desk". opentiles.shell.spec.ts starts with tiles already at the open
// size; this one starts where a member does, with a large tile, and enlarges it by the canvas's own resize corner, by real
// mouse: past 6 x 5 cells it's the app itself, live in place, its layer's chunk fetched only then; the Browser needs 7 x 5;
// the size is saved, so a reload and another browser open it live; with the kill switch off the same drag keeps the widget
// and the chunk never loads. On MockDeskLink.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole } from './helpers';

const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const LARGE = { w: span(4), h: span(4) }; // 352 x 352: the largest level before open
const OPEN = { w: span(6), h: span(5) }; // 536 x 444
const BROWSER_OPEN = { w: span(7), h: span(5) }; // 628 x 444

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[] }
interface Saved { layout: { desks: Record<string, Desk> } | null }
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean; getStage(): { findOne(q: string): { visible(): boolean } | undefined } } } };

const item = (app: string, x: number, y: number, size: { w: number; h: number } = { w: 76, h: 76 }): Item => ({ id: `${PERSONAL}:${app}`, app, x, y, ...size });
/**
 * The Personal desk as a member has it before enlarging anything: the Notebook and the Browser large, side by side with room
 * to grow (the desk is the size it takes for both open: a resize stops only at the desk's edge), the rest as icons under them.
 */
const personal = (): Desk => ({
  x: 0,
  y: 0,
  w: 24 + OPEN.w + 16 + BROWSER_OPEN.w + 24,
  h: 24 + OPEN.h + 16 + 76 + 44 + 16,
  items: [
    item('notebook', 24, 24, LARGE),
    item('browser', 24 + OPEN.w + 16, 24, LARGE),
    item('chat', 24, 24 + OPEN.h + 16),
    item('files', 116, 24 + OPEN.h + 16),
    item('agent', 208, 24 + OPEN.h + 16),
  ],
});
const docOf = (desks: Record<string, Desk>) => ({ version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks, z: Object.keys(desks) } });

const tile = (page: Page, app: string): Locator => page.getByTestId(`open-tile-${app}`);
const proxy = (page: Page, app: string): Locator => page.locator(`[id="proxy-${PERSONAL}:${app}"]`);
const saved = async (request: APIRequestContext): Promise<Saved | undefined> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, Saved | undefined> }).layoutDocs[ME];
const savedItem = async (request: APIRequestContext, app: string): Promise<Item | undefined> => (await saved(request))?.layout?.desks[PERSONAL]?.items.find((i) => i.app === app);
/** Platform's copy once the save has gone (2 s after the last change: `shell/layoutSync.ts`), with the app at least this wide. */
async function savedAtLeast(request: APIRequestContext, app: string, w: number): Promise<Item> {
  await expect.poll(async () => (await savedItem(request, app))?.w ?? 0).toBeGreaterThanOrEqual(w);
  return (await savedItem(request, app))!;
}
const scale = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.cam.s);
/** The canvas's own drawing of a tile: hidden while its app is live over it. */
const drawn = (page: Page, app: string): Promise<boolean> => page.evaluate((id) => !!(window as unknown as Hook).__maDesk.camera.getStage().findOne(`#tile-${id}`)?.visible(), `${PERSONAL}:${app}`);

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

/** Records every request for the open tiles' chunk (`OpenTileLayer`, its own lazy chunk). */
function chunkWatch(page: Page): string[] {
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/OpenTileLayer/.test(r.url())) chunks.push(r.url());
  });
  return chunks;
}

/** Signed in, at rest on the Personal desk, with Platform's copy of the layout as given. */
async function arrive(page: Page, request: APIRequestContext, opts: { config?: Record<string, unknown>; seed?: boolean } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, 'light');
  if (opts.seed !== false) {
    await harness(request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }], files: { enabled: true }, layoutDocs: { [ME]: docOf({ [PERSONAL]: personal() }) }, ...(opts.config ? { configExtra: opts.config } : {}) });
  }
  await signIn(page);
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  return errors;
}

/**
 * Enlarges a tile by the canvas's resize corner, as a member does: the pointer on the app shows the corner, a press on it and
 * a drag of so many world units right and down, in steps.
 */
async function enlarge(page: Page, app: string, dxUnits: number, dyUnits: number): Promise<void> {
  const b = (await proxy(page, app).boundingBox())!;
  const s = await scale(page);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(80); // the corner shows on hover
  const from = { x: b.x + b.width - 4 * s, y: b.y + b.height - 4 * s };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dxUnits * s, from.y + dyUnits * s, { steps: 12 });
  await page.mouse.up();
  await settled(page);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a large Notebook enlarged by its corner past 6 x 5 is the Notebook itself, live in place, and its chunk comes only then', async ({ page, request }) => {
  const chunks = chunkWatch(page);
  const errors = await arrive(page, request);
  // Large: a drawing on the canvas, nothing live, and the layer's chunk not fetched.
  await expect(page.locator('.open-tile')).toHaveCount(0);
  expect(await drawn(page, 'notebook')).toBe(true);
  expect(chunks, 'no open tile yet, no chunk').toEqual([]);

  await enlarge(page, 'notebook', OPEN.w - LARGE.w + 12, OPEN.h - LARGE.h + 12);
  await expect(tile(page, 'notebook')).toBeVisible();
  expect(chunks.length, 'the chunk, fetched once a tile reached open').toBeGreaterThan(0);
  await expect.poll(() => drawn(page, 'notebook')).toBe(false);
  const big = await savedAtLeast(request, 'notebook', OPEN.w);
  expect(big.h).toBeGreaterThanOrEqual(OPEN.h);
  // Usable right there: a page to write on, and no window opened for it.
  const editor = tile(page, 'notebook').getByTestId('note-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Enlarged into the app.');
  await expect(tile(page, 'notebook').locator('.nb-prose')).toContainText('Enlarged into the app.');
  await expect(page.locator('.window-layer .ma-window')).toHaveCount(0);
  // The Browser beside it, still large, is still its drawing.
  await expect(tile(page, 'browser')).toHaveCount(0);
  expect(await drawn(page, 'browser')).toBe(true);
  expect(errors).toEqual([]);
});

test('the Browser needs 7 x 5: at 6 x 5 it is still its widget, one column more and it is the live picture', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await enlarge(page, 'browser', OPEN.w - LARGE.w + 6, OPEN.h - LARGE.h + 6);
  const six = await savedAtLeast(request, 'browser', OPEN.w);
  expect(six.w).toBeLessThan(BROWSER_OPEN.w);
  expect(six.h).toBeGreaterThanOrEqual(OPEN.h);
  await page.waitForTimeout(400);
  await expect(tile(page, 'browser')).toHaveCount(0);
  expect(await drawn(page, 'browser')).toBe(true);

  await enlarge(page, 'browser', BROWSER_OPEN.w - six.w + 6, 0);
  await expect(tile(page, 'browser')).toBeVisible();
  const video = tile(page, 'browser').getByTestId('browser-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await savedAtLeast(request, 'browser', BROWSER_OPEN.w);
  expect(errors).toEqual([]);
});

test('the size is saved: a reload, and another browser signed in to the same account, open the app live where it was left', async ({ page, request, browser }) => {
  const errors = await arrive(page, request);
  await enlarge(page, 'notebook', OPEN.w - LARGE.w + 12, OPEN.h - LARGE.h + 12);
  await expect(tile(page, 'notebook')).toBeVisible();
  await savedAtLeast(request, 'notebook', OPEN.w);

  await page.reload();
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  await expect(tile(page, 'notebook')).toBeVisible();
  await expect(tile(page, 'notebook').getByTestId('note-editor')).toBeVisible();

  // A browser with nothing of this one's: the layout comes from Platform's copy.
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  try {
    const p2 = await other.newPage();
    const errors2 = watchConsole(p2);
    await setTheme(p2, 'light');
    await signIn(p2);
    await canvasPainted(p2);
    await focusCanvas(p2);
    await p2.keyboard.press('1');
    await settled(p2);
    await expect(tile(p2, 'notebook')).toBeVisible();
    await expect(tile(p2, 'browser')).toHaveCount(0);
    expect(errors2).toEqual([]);
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
});

test('with the kill switch off, openTiles: { enabled: false }, the same drag keeps the widget, and the chunk never loads', async ({ page, request }) => {
  const chunks = chunkWatch(page);
  const errors = await arrive(page, request, { config: { openTiles: { enabled: false } } });
  await enlarge(page, 'notebook', OPEN.w - LARGE.w + 12, OPEN.h - LARGE.h + 12);
  // The member's size is kept, as any resize is; nothing goes past large.
  await savedAtLeast(request, 'notebook', OPEN.w);
  await expect(page.locator('.open-tile')).toHaveCount(0);
  expect(await drawn(page, 'notebook')).toBe(true);
  expect(chunks).toEqual([]);
  // Pressed, it opens its window, as before open tiles.
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
  expect(errors).toEqual([]);
});
