// Open tiles (ADR 0053, the owner, Nov 11): "When I expand the apps enough, they are supposed to actually be viewable and usable
// right there on my desk". A tile enlarged past 6 x 5 cells (the Browser 7 x 5) is the app's own window component, live, docked
// to the tile, on the desk that's looked at, at rest and at least 480 x 320 px on screen, four at most. On MockDeskLink, by real
// mouse and keyboard.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const STUDIO = 'd-studio0000001';
const SHOTS = process.env['OPEN_TILE_SHOTS'] ?? 'test-results/shots/opentiles';

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const OPEN = { w: span(6), h: span(5) }; // 536 x 444
const BROWSER = { w: span(7), h: span(5) }; // 628 x 444

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[]; stack?: string[] }
interface Saved { layout: { desks: Record<string, Desk> } | null }
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean; getStage(): { findOne(q: string): { visible(): boolean; x(): number; y(): number; getAttr(k: string): unknown; findOne(q: string): { text(): string } | undefined } | undefined } } } };
interface MockControl { rpc: { m: string; p: Record<string, unknown> }[]; input: { channel: string; bytes: number[] }[] }

const item = (deskId: string, app: string, x: number, y: number, size: { w: number; h: number } = { w: 76, h: 76 }): Item => ({ id: `${deskId}:${app}`, app, x, y, ...size });
const deskOf = (x: number, items: Item[]): Desk => {
  const w = Math.max(...items.map((i) => i.x + i.w)) + 24;
  const h = Math.max(...items.map((i) => i.y + i.h)) + 44 + 16;
  return { x, y: 0, w, h, items };
};
/** The Personal desk: the Notebook and the Browser open side by side, the rest as icons under them. */
const personal = (x = 0): Desk => deskOf(x, [
  item(PERSONAL, 'notebook', 24, 24, OPEN),
  item(PERSONAL, 'browser', 24 + OPEN.w + 16, 24, BROWSER),
  item(PERSONAL, 'chat', 24, 24 + OPEN.h + 16),
  item(PERSONAL, 'files', 116, 24 + OPEN.h + 16),
  item(PERSONAL, 'agent', 208, 24 + OPEN.h + 16),
]);
/** The Work desk: Files and the Agent open. */
const work = (x: number): Desk => deskOf(x, [
  item(WORK, 'files', 24, 24, OPEN),
  item(WORK, 'agent', 24 + OPEN.w + 16, 24, OPEN),
  item(WORK, 'chat', 24, 24 + OPEN.h + 16),
  item(WORK, 'notebook', 116, 24 + OPEN.h + 16),
  item(WORK, 'browser', 208, 24 + OPEN.h + 16),
]);
/** The Studio desk: Chat open, with the Notebook beside it. */
const studio = (x: number): Desk => deskOf(x, [
  item(STUDIO, 'chat', 24, 24, OPEN),
  item(STUDIO, 'notebook', 24 + OPEN.w + 16, 24, OPEN),
  item(STUDIO, 'browser', 24, 24 + OPEN.h + 16),
  item(STUDIO, 'files', 116, 24 + OPEN.h + 16),
  item(STUDIO, 'agent', 208, 24 + OPEN.h + 16),
]);

const fleetOf = (ids: string[]): Record<string, string>[] =>
  ids.map((deskId) => ({ deskId, name: { [PERSONAL]: 'Personal', [WORK]: 'Work', [STUDIO]: 'Studio' }[deskId]!, kind: deskId === PERSONAL ? 'personal' : 'work', state: 'running' }));
const docOf = (desks: Record<string, Desk>) => ({ version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks, z: Object.keys(desks) } });

const tile = (page: Page, app: string): Locator => page.getByTestId(`open-tile-${app}`);
const head = (page: Page, app: string): Locator => tile(page, app).locator('.open-tile-head');
/** An app's proxy on the desk: its stop for the keyboard, live or not. */
const proxy = (page: Page, app: string, deskId = PERSONAL): Locator => page.locator(`[id="proxy-${deskId}:${app}"]`);
const inApp = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('.open-tile-app'));
/** Every live tile's ground is opaque and the canvas paints nothing under it. */
async function nothingUnder(page: Page): Promise<void> {
  const tiles = await page.locator('.open-tile').evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset['item']!, bg: getComputedStyle(e).backgroundColor, app: getComputedStyle(e.querySelector('.open-tile-app')!).backgroundColor })));
  expect(tiles.length).toBeGreaterThan(0);
  for (const t of tiles) {
    expect(t.bg, t.id).toMatch(/^rgb\(/);
    expect(t.app, t.id).toMatch(/^rgb\(/);
    expect((await canvasTile(page, t.id)).visible, t.id).toBe(false);
  }
}
const body = (page: Page, app: string): Locator => tile(page, app).locator('.open-tile-app');
const desk = (page: Page, name: string): Locator => page.getByRole('group', { name: `${name} desk` });
const saved = async (request: APIRequestContext): Promise<Saved | undefined> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, Saved | undefined> }).layoutDocs[ME];
const savedItem = async (request: APIRequestContext, deskId: string, app: string): Promise<Item | undefined> => (await saved(request))?.layout?.desks[deskId]?.items.find((i) => i.app === app);
const mounts = (page: Page, id: string): Promise<number> => page.evaluate((i) => (window as unknown as { __maOpenTileMounts?: Record<string, number> }).__maOpenTileMounts?.[i] ?? 0, id);
const cam = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }));
/** The canvas's own tile: hidden while its app is live over it. */
const canvasTile = (page: Page, id: string): Promise<{ visible: boolean; note: string | null }> =>
  page.evaluate((i) => {
    const node = (window as unknown as Hook).__maDesk.camera.getStage().findOne(`#tile-${i}`);
    return { visible: !!node?.visible(), note: node?.findOne('.open-tile-note')?.text() ?? null };
  }, id);

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

/** Signed in, at rest, on the given desks with `desks` as Platform's copy of the layout, and the first desk in front. */
async function arrive(page: Page, request: APIRequestContext, opts: { theme?: ThemeId; desks?: Record<string, Desk>; config?: Record<string, unknown> } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  const desks = opts.desks ?? { [PERSONAL]: personal() };
  await setTheme(page, opts.theme ?? 'light');
  await harness(request, { fleet: fleetOf(Object.keys(desks)), files: { enabled: true }, layoutDocs: { [ME]: docOf(desks) }, ...(opts.config ? { configExtra: opts.config } : {}) });
  await signIn(page);
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  return errors;
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const res = await w.axe.run({ include: ['.open-layer', '.proxy-layer'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** A real drag by the mouse, in steps, from one point to another. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let n = 1; n <= 6; n += 1) await page.mouse.move(from.x + (dx * n) / 6, from.y + (dy * n) / 6);
  await page.mouse.up();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('an enlarged tile is its app, live on the desk: the Notebook takes typing in place, and the canvas draws nothing under it', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await expect(tile(page, 'notebook')).toBeVisible();
  await expect(tile(page, 'browser')).toBeVisible();
  // Docked to its tile: the frame is the tile's box on screen.
  const { x, y, s } = await cam(page);
  const box = (await tile(page, 'notebook').boundingBox())!;
  expect(Math.abs(box.x - (24 * s + x))).toBeLessThan(1.5);
  expect(Math.abs(box.y - (24 * s + y))).toBeLessThan(1.5);
  expect(Math.abs(box.width - OPEN.w * s)).toBeLessThan(1.5);
  expect((await canvasTile(page, `${PERSONAL}:notebook`)).visible).toBe(false);
  expect((await canvasTile(page, `${PERSONAL}:chat`)).visible).toBe(true);
  // The Notebook, in place: a page to write on.
  const editor = tile(page, 'notebook').getByTestId('note-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Written on the desk itself.');
  await expect(tile(page, 'notebook').locator('.nb-prose')).toContainText('Written on the desk itself.');
  // No window opened for it.
  await expect(page.locator('.window-layer .ma-window')).toHaveCount(0);
  await shot(page, 'light-personal-1440');
  expect(errors).toEqual([]);
});

test('inside the app the canvas keeps out: single keys, a drag and a pinch are the app\'s; Esc comes back to the head, and Tab from it goes in', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const before = await cam(page);
  const editor = tile(page, 'notebook').getByTestId('note-editor');
  await editor.click();
  await page.keyboard.press('Control+End');
  // `\` is the privacy shield, `0` fits, `-` zooms and `[` changes desk on the canvas: here they're only typing.
  await page.keyboard.type('a\\0-[]');
  await expect(tile(page, 'notebook').locator('.nb-prose')).toContainText('a\\0-[]');
  await expect(page.locator('.open-layer.shielded')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await cam(page)).toEqual(before);
  // A drag inside the app selects there, and never moves the tile or pans the office.
  const was = await savedItem(request, PERSONAL, 'notebook');
  const b = (await body(page, 'notebook').boundingBox())!;
  await dragBy(page, { x: b.x + b.width * 0.7, y: b.y + b.height * 0.6 }, 120, 60);
  await page.waitForTimeout(600);
  expect(await savedItem(request, PERSONAL, 'notebook')).toEqual(was);
  expect(await cam(page)).toEqual(before);
  // A pinch (a ctrl wheel, as a trackpad sends it) over the app zooms nothing.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -200);
  await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)!.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: x!, clientY: y!, bubbles: true, cancelable: true })), [b.x + b.width / 2, b.y + b.height / 2]);
  await page.waitForTimeout(400);
  expect(await cam(page)).toEqual(before);
  // Esc in the editor, which uses none, comes back to the tile's stop on the desk, its proxy, whose ring the frame draws;
  // from there Tab goes into the app.
  await editor.click();
  await page.keyboard.press('Escape');
  await expect(proxy(page, 'notebook')).toBeFocused();
  await expect(tile(page, 'notebook')).toHaveClass(/\bring\b/);
  await page.keyboard.press('Tab');
  expect(await inApp(page)).toBe(true);
  await expect(tile(page, 'notebook')).not.toHaveClass(/\bring\b/);
  // Shift+Esc from anywhere in it goes back too, and closes nothing.
  await page.keyboard.press('Shift+Escape');
  await expect(proxy(page, 'notebook')).toBeFocused();
  // Arrows go on to the next app, and back, as on any app.
  await page.keyboard.press('ArrowRight');
  await expect(proxy(page, 'browser')).toBeFocused();
  await expect(tile(page, 'browser')).toHaveClass(/\bring\b/);
  await page.keyboard.press('ArrowLeft');
  await expect(proxy(page, 'notebook')).toBeFocused();
  // Enter goes in, as Tab does, and opens no window: it's open.
  await page.keyboard.press('Enter');
  expect(await inApp(page)).toBe(true);
  await expect(page.locator('.window-layer .ma-window')).toHaveCount(0);
  // Esc on the proxy itself is the desk's, as on any app: the overview.
  await page.keyboard.press('Shift+Escape');
  await page.keyboard.press('Escape');
  await settled(page);
  await expect(tile(page, 'notebook')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the head moves the tile and the grip resizes it, snapped as any tile is, and saved', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const { s } = await cam(page);
  const was = (await savedItem(request, PERSONAL, 'notebook'))!;
  // Down by the head.
  const h = (await head(page, 'notebook').boundingBox())!;
  const frame = (await tile(page, 'notebook').boundingBox())!;
  await dragBy(page, { x: h.x + 60, y: h.y + h.height / 2 }, 0, 40);
  await expect.poll(async () => (await savedItem(request, PERSONAL, 'notebook'))?.y).toBeCloseTo(was.y + 40 / s, 0);
  const moved = (await tile(page, 'notebook').boundingBox())!;
  expect(Math.abs(moved.y - (frame.y + 40))).toBeLessThan(2);
  expect(Math.abs(moved.x - frame.x)).toBeLessThan(1);
  // Still live, and the same instance: a move never remounts it.
  expect(await mounts(page, `${PERSONAL}:notebook`)).toBe(1);
  // Taller by the bottom edge, and the app reflows to it.
  const edge = (await tile(page, 'notebook').locator('.window-edge.s').boundingBox())!;
  await dragBy(page, { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 }, 0, 30);
  await expect.poll(async () => (await savedItem(request, PERSONAL, 'notebook'))?.h).toBeCloseTo(was.h + 30 / s, 0);
  expect(Math.abs((await tile(page, 'notebook').boundingBox())!.height - (frame.height + 30))).toBeLessThan(2);
  // Below the open size by the bottom-left corner: the widget, drawn on the canvas, and nothing of the app.
  const sw = (await tile(page, 'notebook').locator('.window-edge.sw').boundingBox())!;
  await dragBy(page, { x: sw.x + 4, y: sw.y + 4 }, 200, -200);
  await expect(tile(page, 'notebook')).toHaveCount(0);
  await expect.poll(async () => (await canvasTile(page, `${PERSONAL}:notebook`)).visible).toBe(true);
  await expect.poll(async () => (await savedItem(request, PERSONAL, 'notebook'))?.w).toBeLessThan(span(6));
  const small = (await savedItem(request, PERSONAL, 'notebook'))!;
  expect(small.x).toBeGreaterThan(was.x);
  expect(small.x + small.w).toBeCloseTo(was.x + was.w, 0); // the right edge stayed
  expect(errors).toEqual([]);
});

test('the Browser\'s picture, in place, takes a click and keys, and its Esc is the page\'s', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const video = tile(page, 'browser').getByTestId('browser-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  // It fits the desk's picture inside the tile, with bars as its window has when it's off the picture's shape.
  const b = (await video.boundingBox())!;
  const [w, hh] = await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]);
  const scale = Math.min(b.width / w!, b.height / hh!);
  const pic = { x: b.x + (b.width - w! * scale) / 2, y: b.y + (b.height - hh! * scale) / 2, width: w! * scale, height: hh! * scale };
  await page.evaluate(() => {
    (window as unknown as { __maDeskMock: MockControl }).__maDeskMock.input.length = 0;
  });
  await page.mouse.click(pic.x + pic.width / 4, pic.y + pic.height / 2);
  await expect(tile(page, 'browser').getByTestId('browser-keys')).toBeFocused();
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('Escape');
  const sent = await page.evaluate(() => (window as unknown as { __maDeskMock: MockControl }).__maDeskMock.input.map((e) => [e.channel, e.bytes[0]]));
  expect(sent).toContainEqual(['keys', 2]); // the click
  expect(sent.filter(([, type]) => type === 4).length).toBeGreaterThanOrEqual(4); // q and Esc, down and up
  // Esc went to the page: the picture still has the keyboard.
  await expect(tile(page, 'browser').getByTestId('browser-keys')).toBeFocused();
  // A pinch over the picture is the page's, never the office's zoom.
  const before = await cam(page);
  await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)!.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: x!, clientY: y!, bubbles: true, cancelable: true })), [pic.x + pic.width / 2, pic.y + pic.height / 2]);
  await page.waitForTimeout(300);
  expect(await cam(page)).toEqual(before);
  // Shift+Esc leaves the picture for the tile's head.
  await page.mouse.click(pic.x + pic.width / 2, pic.y + pic.height / 2);
  await page.keyboard.press('Shift+Escape');
  await expect(proxy(page, 'browser')).toBeFocused();
  // The one-live-picture rule: live while it shows.
  const calls = await page.evaluate(() => (window as unknown as { __maDeskMock: MockControl }).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state']));
  expect(calls.at(-1)).toBe('live');
  expect(errors).toEqual([]);
});

test('Files opens a folder in place, and the Agent takes a key and a message', async ({ page, request }) => {
  const errors = await arrive(page, request, { desks: { [WORK]: work(0) } });
  const files = tile(page, 'files');
  await expect(files.locator('[data-testid="files-row"][data-name="Documents"]')).toBeVisible();
  // At a tile's width a selection's own buttons stay in the bar's one row (it scrolls sideways), so nothing moves under the
  // pointer between a double click's two presses.
  const docs = files.locator('[data-testid="files-row"][data-name="Documents"]');
  const was = (await docs.boundingBox())!.y;
  await docs.click();
  await expect(docs).toHaveAttribute('aria-selected', 'true');
  expect((await docs.boundingBox())!.y).toBe(was);
  await files.locator('[data-testid="files-row"][data-name="Backups"]').dblclick();
  await expect(files.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current="location"]')).toHaveText('Backups');
  await files.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'Files' }).click();
  await docs.dblclick();
  await expect(files.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current="location"]')).toHaveText('Documents');
  const agent = tile(page, 'agent');
  await agent.getByTestId('key-input').fill('sk-ant-TEST-not-a-real-key-canary-0000-abcd');
  await agent.getByTestId('key-submit').click();
  await expect(agent.getByTestId('composer-input')).toBeVisible();
  await agent.getByTestId('composer-input').fill('Plan the week.');
  await expect(agent.getByTestId('composer-input')).toHaveValue('Plan the week.');
  expect(errors).toEqual([]);
});

test('Chat, live in its tile as its window shows it (an honest empty state, nothing to send yet), beside the Notebook', async ({ page, request }) => {
  const errors = await arrive(page, request, { desks: { [STUDIO]: studio(0) } });
  await expect(tile(page, 'chat').getByTestId('empty-chat')).toBeVisible();
  await expect(tile(page, 'notebook').getByTestId('note-editor')).toBeVisible();
  expect(errors).toEqual([]);
});

test('zoomed out below 480 px wide it\'s the widget; back in, it\'s live again, and a pan or a zoom in between never remounts it', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const id = `${PERSONAL}:notebook`;
  expect(await mounts(page, id)).toBe(1);
  // A pan by the keyboard's zoom keys and back: the layer follows by one transform, and nothing remounts.
  await focusCanvas(page);
  await page.keyboard.press('=');
  await settled(page);
  await expect(tile(page, 'notebook')).toBeVisible();
  expect(await mounts(page, id)).toBe(1);
  await page.keyboard.press('-');
  await settled(page);
  expect(await mounts(page, id)).toBe(1);
  // Out until it's under 480 px wide: the canvas draws its widget, and the app goes, as a window that closes.
  for (let n = 0; n < 2; n += 1) await page.keyboard.press('-');
  await settled(page);
  expect(OPEN.w * (await cam(page)).s).toBeLessThan(480);
  await expect(tile(page, 'notebook')).toHaveCount(0);
  expect((await canvasTile(page, id)).visible).toBe(true);
  await shot(page, 'light-widget-zoomed-out');
  // Back in: live again, once.
  await page.keyboard.press('0');
  await settled(page);
  await expect(tile(page, 'notebook')).toBeVisible();
  expect(await mounts(page, id)).toBe(2);
  expect(errors).toEqual([]);
});

test('"Open as window" opens its window and leaves the widget with its note; closing the window brings it back live, with what it showed', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const id = `${PERSONAL}:notebook`;
  const editor = tile(page, 'notebook').getByTestId('note-editor');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Carried over.');
  await expect(tile(page, 'notebook').getByRole('button', { name: 'Open in its window' })).toHaveAttribute('title', 'Open in its window');
  await tile(page, 'notebook').getByRole('button', { name: 'Open in its window' }).click();
  const win = page.getByRole('dialog', { name: /Notebook/ });
  await expect(win).toBeVisible();
  await expect(tile(page, 'notebook')).toHaveCount(0);
  // The same app: the page it showed.
  await expect(win.locator('.nb-prose')).toContainText('Carried over.');
  await expect.poll(() => canvasTile(page, id)).toEqual({ visible: true, note: 'Open in its window' });
  await win.getByRole('button', { name: 'Close Notebook' }).click();
  await expect(win).toHaveCount(0);
  await expect(tile(page, 'notebook')).toBeVisible();
  await expect(tile(page, 'notebook').locator('.nb-prose')).toContainText('Carried over.');
  // The keyboard comes back to the tile, as from any closed window.
  await expect(proxy(page, 'notebook')).toBeFocused();
  expect((await canvasTile(page, id)).visible).toBe(false);
  expect(errors).toEqual([]);
});

test('carousel mode wins: the desk is one app at a time, and its tiles are drawn as before', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await expect(tile(page, 'notebook')).toBeVisible();
  const toggle = desk(page, 'Personal').getByRole('button', { name: /^(Carousel|Back to the desk)$/ });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(page.getByTestId('carousel-stage')).toBeVisible();
  await expect(page.locator('.open-tile')).toHaveCount(0);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(page.getByTestId('carousel-stage')).toHaveCount(0);
  await expect(tile(page, 'notebook')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the kill switch, openTiles: { enabled: false }: nothing goes past large, and the layer\'s chunk never loads', async ({ page, request }) => {
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/OpenTileLayer/.test(r.url())) chunks.push(r.url());
  });
  const errors = await arrive(page, request, { config: { openTiles: { enabled: false } } });
  await page.waitForTimeout(500);
  await expect(page.locator('.open-tile')).toHaveCount(0);
  expect(chunks).toEqual([]);
  // The tiles are drawn, and pressed open their windows, as before.
  expect((await canvasTile(page, `${PERSONAL}:notebook`)).visible).toBe(true);
  await desk(page, 'Personal').getByRole('button', { name: /^Notebook/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('on a 390 px phone the grid stays, and an open tile is a large one', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await arrive(page, request);
  await page.waitForTimeout(400);
  await expect(page.locator('.open-tile')).toHaveCount(0);
  const nb = (await desk(page, 'Personal').getByRole('button', { name: /^Notebook/ }).boundingBox())!;
  const { s } = await cam(page);
  // 4 x 4 cells of the phone's grid.
  expect(Math.round(nb.width / s)).toBe(span(4));
  expect(Math.round(nb.height / s)).toBe(span(4));
  expect(errors).toEqual([]);
});

test('Commons on a Guild Desk, open on its desk: a message sent in place', async ({ page, request }) => {
  const errors = watchConsole(page);
  const GUILD = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'] };
  const PANEL = `guild-${GUILD.guildId}`;
  const panel = deskOf(1400, [
    item(PANEL, 'commons', 24, 24, OPEN),
    item(PANEL, 'notebook', 24, 24 + OPEN.h + 16),
    item(PANEL, 'agent', 116, 24 + OPEN.h + 16),
  ]);
  await setTheme(page, 'light');
  await harness(request, {
    fleet: fleetOf([PERSONAL]),
    guilds: { wakeMs: 900, list: [GUILD], desks: { [GUILD.guildId]: { deskId: 'd-gplatform', state: 'running' } } },
    layoutDocs: { [ME]: docOf({ [PERSONAL]: personal(), [PANEL]: panel }) },
  });
  await signIn(page, '/?speed=fast');
  await canvasPainted(page);
  await desk(page, 'Platform team').getByRole('button', { name: /^Platform team desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await settled(page);
  const room = tile(page, 'commons').getByTestId('commons-app');
  await expect(room).toBeVisible({ timeout: 15_000 });
  await room.getByRole('textbox', { name: 'Message #General' }).fill('Sent from the desk itself.');
  await page.keyboard.press('Enter');
  await expect(room.getByRole('log').locator('.ma-cm-msg').last()).toContainText('Sent from the desk itself.');
  // Only the shown desk's are live: the Personal desk's Notebook and Browser are its drawings now.
  await expect(page.locator('.open-tile')).toHaveCount(1);
  await shot(page, 'light-guild-commons-1440');
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`${theme}: a desk at 1280 x 800 with the Notebook and the Browser open side by side, Files and the Agent, Chat; the note; axe`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const name = theme === 'dusk' ? 'zen' : theme;
    const errors = await arrive(page, request, { theme, desks: { [PERSONAL]: personal(), [WORK]: work(1400), [STUDIO]: studio(2800) } });
    await expect(tile(page, 'notebook')).toBeVisible();
    await expect(tile(page, 'browser')).toBeVisible();
    await expect.poll(() => tile(page, 'browser').getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
    await expect(tile(page, 'notebook').getByTestId('note-editor')).toBeVisible();
    await nothingUnder(page);
    expect(await axe(page)).toEqual([]);
    // The pointer on the Notebook's tile, so its corner's grip shows.
    const nb = (await tile(page, 'notebook').boundingBox())!;
    await page.mouse.move(nb.x + nb.width - 60, nb.y + nb.height - 40);
    await expect.poll(() => tile(page, 'notebook').locator('.window-edge.se').evaluate((e) => getComputedStyle(e, '::after').opacity)).toBe('1');
    await shot(page, `${name}-notebook-browser-1280`);
    await focusCanvas(page);
    await page.keyboard.press('2');
    await settled(page);
    await expect(tile(page, 'files').locator('[data-testid="files-row"]').first()).toBeVisible();
    await expect(tile(page, 'agent').getByTestId('key-input')).toBeVisible();
    await nothingUnder(page);
    await shot(page, `${name}-files-agent-1280`);
    await focusCanvas(page);
    await page.keyboard.press('3');
    await settled(page);
    await expect(tile(page, 'chat').getByTestId('empty-chat')).toBeVisible();
    await nothingUnder(page);
    await shot(page, `${name}-chat-notebook-1280`);
    // Back on the first desk, the Notebook as a window: its tile is its widget with the note.
    await focusCanvas(page);
    await page.keyboard.press('1');
    await settled(page);
    await tile(page, 'notebook').getByRole('button', { name: 'Open in its window' }).click();
    await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
    await expect.poll(async () => (await canvasTile(page, `${PERSONAL}:notebook`)).note).toBe('Open in its window');
    // Moved to the right, over the Browser's tile, so the note shows beside it.
    const win = page.getByRole('dialog', { name: /Notebook/ });
    const wh = (await win.locator('.window-head').boundingBox())!;
    await dragBy(page, { x: wh.x + 200, y: wh.y + wh.height / 2 }, 640 - wh.x, 0);
    await shot(page, `${name}-in-its-window-1280`);
    expect(errors).toEqual([]);
  });
}

test('a desk dragged by its panel takes its live tiles with it, and nothing remounts', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const before = (await tile(page, 'notebook').boundingBox())!;
  const panel = (await desk(page, 'Personal').getByRole('button', { name: /^Personal desk/ }).boundingBox())!;
  // An empty spot on the panel: right of the icons, under the Browser.
  const from = { x: panel.x + panel.width * 0.6, y: before.y + before.height + 40 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let n = 1; n <= 6; n += 1) await page.mouse.move(from.x + (50 * n) / 6, from.y + (30 * n) / 6);
  const during = (await tile(page, 'notebook').boundingBox())!;
  expect(Math.abs(during.x - (before.x + 50))).toBeLessThan(2);
  expect(Math.abs(during.y - (before.y + 30))).toBeLessThan(2);
  await page.mouse.up();
  await settled(page);
  const after = (await tile(page, 'notebook').boundingBox())!;
  const { x, y, s } = await cam(page);
  const saved = (await saved_(request))!;
  expect(Math.abs(after.x - ((saved.x + 24) * s + x))).toBeLessThan(1.5);
  expect(Math.abs(after.y - ((saved.y + 24) * s + y))).toBeLessThan(1.5);
  expect(await mounts(page, `${PERSONAL}:notebook`)).toBe(1);
  expect(errors).toEqual([]);
});

const saved_ = async (request: APIRequestContext): Promise<Desk | undefined> => {
  await expect.poll(async () => (await saved(request))?.layout?.desks[PERSONAL]?.x ?? 0).not.toBe(0);
  return (await saved(request))?.layout?.desks[PERSONAL];
};

test('the tile\'s stop on the desk is its proxy: m and the arrows move it, as they move any app', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const was = (await savedItem(request, PERSONAL, 'notebook'))!;
  await proxy(page, 'notebook').focus();
  await page.keyboard.press('m');
  await expect(tile(page, 'notebook')).toHaveClass(/editing/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await savedItem(request, PERSONAL, 'notebook'))?.y).toBe(was.y + 16);
  await expect(proxy(page, 'notebook')).toBeFocused();
  await expect(tile(page, 'notebook')).not.toHaveClass(/editing/);
  // Enter kept it, and didn't go into the app.
  expect(await inApp(page)).toBe(false);
  expect(await mounts(page, `${PERSONAL}:notebook`)).toBe(1);
  expect(errors).toEqual([]);
});

test('from the overview, a press on an open tile brings its desk in and opens it in place; no window', async ({ page, request }) => {
  const errors = await arrive(page, request, { desks: { [PERSONAL]: personal(), [WORK]: work(1400) } });
  await page.keyboard.press('Escape');
  await settled(page);
  await expect(page.locator('.open-tile')).toHaveCount(0);
  await desk(page, 'Work').getByRole('button', { name: /^Files/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await settled(page);
  await expect(tile(page, 'files')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('.window-layer .ma-window')).toHaveCount(0);
  // A note's link, an agent, the hidden list: opening an app that's live in its tile goes to the tile.
  await expect(tile(page, 'agent')).toBeVisible();
  await focusCanvas(page);
  await desk(page, 'Work').getByRole('button', { name: /^Chat/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Chat/ })).toBeVisible(); // an icon still opens its window
  expect(errors).toEqual([]);
});

test('a tile with another app over it stays a drawing; a press brings it to the front, live, and opens no window', async ({ page, request }) => {
  const covered = deskOf(0, [
    item(PERSONAL, 'notebook', 24, 24, OPEN),
    item(PERSONAL, 'chat', 120, 120),
    item(PERSONAL, 'browser', 24, 24 + OPEN.h + 16),
    item(PERSONAL, 'files', 116, 24 + OPEN.h + 16),
    item(PERSONAL, 'agent', 208, 24 + OPEN.h + 16),
  ]);
  const errors = await arrive(page, request, { desks: { [PERSONAL]: covered } });
  await page.waitForTimeout(400);
  await expect(tile(page, 'notebook')).toHaveCount(0);
  expect((await canvasTile(page, `${PERSONAL}:notebook`)).visible).toBe(true);
  const { x, y, s } = await cam(page);
  await page.mouse.click((24 + 400) * s + x, (24 + 300) * s + y);
  // The press raised it; it's live at once, over the icon, so the release is the app's, and no window opens.
  await expect(tile(page, 'notebook')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator('.window-layer .ma-window')).toHaveCount(0);
  expect((await canvasTile(page, `${PERSONAL}:notebook`)).visible).toBe(false);
  expect(errors).toEqual([]);
});

test('the Notebook at a tile\'s width: its column steps aside behind a toggle, the page takes the width, and the toolbar fits', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = await arrive(page, request, { theme: 'dusk' });
  const nb = tile(page, 'notebook');
  const toggle = nb.getByRole('button', { name: 'Notebooks and pages' });
  await expect(nb.getByTestId('note-editor')).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(nb.locator('.nb-side')).toBeHidden();
  // The page has the tile's width, less its margins, and the toolbar isn't cut.
  const frame = (await nb.boundingBox())!;
  const paper = (await nb.locator('.nb-paper').boundingBox())!;
  expect(paper.width).toBeGreaterThan(frame.width - 40);
  for (const group of await nb.locator('.nb-tool-group').all()) {
    const g = (await group.boundingBox())!;
    expect(g.x + g.width).toBeLessThanOrEqual(paper.x + paper.width + 0.5);
  }
  // The column comes over the page, and goes when a page is chosen.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(nb.locator('.nb-side')).toBeVisible();
  await shot(page, 'zen-notebook-column-1280');
  await nb.locator('.nb-side').getByRole('button', { name: /New note/ }).first().click();
  await expect(nb.locator('.nb-side')).toBeHidden();
  // And Esc closes it, back on the toggle.
  await toggle.click();
  await expect(nb.locator('.nb-side')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nb.locator('.nb-side')).toBeHidden();
  await expect(toggle).toBeFocused();
  // A wide window is as it was: the column beside the page, no toggle.
  await nb.getByRole('button', { name: 'Open in its window' }).click();
  const win = page.getByRole('dialog', { name: /Notebook/ });
  await expect(win.locator('.nb-side')).toBeVisible();
  await expect(win.locator('.nb-side-toggle')).toBeHidden();
  expect(errors).toEqual([]);
});
