// What a tile draws when it isn't live (the owner, Nov 11: "the page is zoomed out too much to show the real app but the
// icon doesn't show big and instead its like a blank page with the tiny icon on the top left"). A tile never draws a card
// with nothing readable on it: past icon size, with no title or text to read at this zoom, it wears the icon's look, its
// glyph large and centred (`tileFace` and `faceGlyphSize` in canvas/layout.ts). Read from the Konva nodes and the canvas's
// own pixels, on MockDeskLink; `?widgets=none` is a desk that sends no widget words.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const OPEN = { w: span(6), h: span(5) }; // 536 x 444
const LARGE = { w: span(4), h: span(4) };
const WIDE = { w: span(4), h: span(2) };
const MEDIUM = { w: span(2), h: span(2) };
const ICON = { w: 76, h: 76 };
/** As `faceGlyphSize`: min(63% of the shorter side, max(128, 45% of it), 256). */
const glyphFor = (s: { w: number; h: number }): number => {
  const short = Math.min(s.w, s.h);
  return Math.min(Math.round((short * 48) / 76), Math.max(128, Math.round(short * 0.45)), 256);
};

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[] }
interface Probe { visible: boolean; face: string | null; glyph: number; texts: string[]; ink: number }
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };

const item = (deskId: string, app: string, x: number, y: number, size: { w: number; h: number }): Item => ({ id: `${deskId}:${app}`, app, x, y, ...size });
const deskOf = (x: number, items: Item[]): Desk => ({
  x,
  y: 0,
  w: Math.max(...items.map((i) => i.x + i.w)) + 24,
  h: Math.max(...items.map((i) => i.y + i.h)) + 44 + 16,
  items,
});
/** Every size on one desk: Files open, the Browser large, the Notebook wide, Courier medium, the Agent an icon. */
const PERSONAL_ITEMS = [
  item(PERSONAL, 'files', 24, 24, OPEN),
  item(PERSONAL, 'browser', 24 + OPEN.w + 16, 24, LARGE),
  item(PERSONAL, 'notebook', 24, 24 + OPEN.h + 16, WIDE),
  item(PERSONAL, 'courier', 24 + WIDE.w + 16, 24 + OPEN.h + 16, MEDIUM),
  item(PERSONAL, 'agent', 24 + WIDE.w + 16 + MEDIUM.w + 16, 24 + OPEN.h + 16, ICON),
];
/** Each app's tile size, as the probe reads it: the layout's, or a phone grid's (set by its test, and put back). */
const SIZE: Record<string, { w: number; h: number }> = Object.fromEntries(PERSONAL_ITEMS.map((i) => [i.app, { w: i.w, h: i.h }]));
const personal = (): Desk => deskOf(0, PERSONAL_ITEMS);
/** A second desk, so the office has an overview. */
const work = (): Desk => deskOf(1600, [item(WORK, 'notebook', 24, 24, ICON), item(WORK, 'files', 116, 24, ICON)]);
const docOf = (desks: Record<string, Desk>) => ({ version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks, z: Object.keys(desks) } });

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

// One harness serves every spec in this Playwright process: each test starts from its fresh state, so an earlier spec's
// setting (a teen, whose desk has no Agent) never carries in.
test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

async function arrive(page: Page, request: APIRequestContext, opts: { words?: boolean; theme?: ThemeId } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, opts.theme ?? 'light');
  await harness(request, {
    fleet: [
      { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
    ],
    files: { enabled: true },
    layoutDocs: { [ME]: docOf({ [PERSONAL]: personal(), [WORK]: work() }) },
  });
  await signIn(page, opts.words === false ? '/?widgets=none' : '/');
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  return errors;
}

/** The Personal desk's middle at the middle of the screen, at scale `s`. */
async function zoomTo(page: Page, s: number): Promise<void> {
  const d = personal();
  await page.evaluate(({ s, cx, cy }) => {
    const c = (window as unknown as Hook).__maDesk.camera;
    c.set({ s, x: window.innerWidth / 2 - cx * s, y: window.innerHeight / 2 - cy * s });
  }, { s, cx: d.x + d.w / 2, cy: d.y + d.h / 2 });
  await settled(page);
}

/**
 * A tile as the canvas has it: shown or not, the face its last draw chose, its glyph's size, its text that shows, and how much
 * of a box in its middle (70% of its glyph's size) isn't the tile's own fill: the glyph's ink, nothing on a blank card.
 */
function probe(page: Page, app: string, deskId = PERSONAL): Promise<Probe> {
  const size = SIZE[app] ?? ICON;
  return page.evaluate(({ id, w, h, g }) => {
    type KNode = {
      visible(): boolean; getAttr(k: string): unknown; text(): string; isVisible(): boolean;
      findOne(q: string): KNode; find(q: string): KNode[];
      getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } };
      getLayer(): { getCanvas(): { _canvas: HTMLCanvasElement; getPixelRatio(): number } };
    };
    const stage = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): KNode } } } }).__maDesk.camera.getStage();
    const node = stage.findOne(`#tile-${id}`);
    const shape = node.findOne('Shape');
    const texts = node.find('Text').filter((t) => t.isVisible()).map((t) => t.text());
    const lc = node.getLayer().getCanvas();
    const ctx = lc._canvas.getContext('2d')!;
    const pr = lc.getPixelRatio();
    const tr = node.getAbsoluteTransform();
    const at = (x: number, y: number): { x: number; y: number } => {
      const p = tr.point({ x, y });
      return { x: Math.round(p.x * pr), y: Math.round(p.y * pr) };
    };
    const ref = at(10, h / 2);
    const fill = ctx.getImageData(ref.x, ref.y, 1, 1).data;
    const a = at(w / 2 - g * 0.35, h / 2 - g * 0.35);
    const b = at(w / 2 + g * 0.35, h / 2 + g * 0.35);
    const bw = Math.max(1, b.x - a.x);
    const bh = Math.max(1, b.y - a.y);
    const px = ctx.getImageData(a.x, a.y, bw, bh).data;
    let inked = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.max(Math.abs(px[i]! - fill[0]!), Math.abs(px[i + 1]! - fill[1]!), Math.abs(px[i + 2]! - fill[2]!)) > 40) inked += 1;
    }
    return { visible: node.visible(), face: (shape.getAttr('face') as string | undefined) ?? null, glyph: (shape.getAttr('glyphSize') as number | undefined) ?? 0, texts, ink: inked / (bw * bh) };
  }, { id: `${deskId}:${app}`, w: size.w, h: size.h, g: glyphFor(size) });
}

async function expectGlyph(page: Page, app: string, why: string): Promise<void> {
  const p = await probe(page, app);
  expect(p.visible, `${app} ${why}`).toBe(true);
  expect(p.face, `${app} ${why}`).toBe('glyph');
  expect(p.glyph, `${app} ${why}`).toBe(glyphFor(SIZE[app]!));
  expect(p.texts, `${app} ${why}: no label row, no lines`).toEqual([]);
  expect(p.ink, `${app} ${why}: its glyph is drawn in the middle`).toBeGreaterThan(0.04);
}

test('with no words to read, a medium, wide, large and open (not live) tile shows its glyph, large and centred', async ({ page, request }) => {
  const errors = await arrive(page, request, { words: false });
  // 75%: text shows, and the open tile is 402 px wide, under the 480 it needs to be live.
  await zoomTo(page, 0.75);
  await expect(page.locator('.open-tile')).toHaveCount(0);
  for (const app of ['files', 'browser', 'notebook', 'courier']) await expectGlyph(page, app, 'at 75%');
  // An icon is as it always was.
  expect((await probe(page, 'agent')).face).toBe('glyph');
  // 50% (text hidden) and 25% (the farthest zoom): still the glyph, never a blank card. An icon at 25% is a plain card.
  for (const s of [0.5, 0.25]) {
    await zoomTo(page, s);
    for (const app of ['files', 'browser', 'notebook', 'courier']) await expectGlyph(page, app, `at ${s * 100}%`);
  }
  // The control: the probe reads no ink on a plain card.
  const icon = await probe(page, 'agent');
  expect(icon.face).toBe('plain');
  expect(icon.ink).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('with words to read at a zoom that shows them, it\'s the widget; zoomed out past them, the glyph, at once', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await zoomTo(page, 0.75);
  // The mock desk's words: the Browser's page and the Notebook's note. Files has none, and Courier, which comes later, shows none
  // of the mock's (courierlater.shell.spec.ts).
  for (const [app, title] of [['browser', 'Mock page title'], ['notebook', 'Trip notes']] as const) {
    const p = await probe(page, app);
    expect(p.face, app).toBe('widget');
    expect(p.glyph, app).toBe(0);
    expect(p.texts, app).toContain(title);
  }
  await expectGlyph(page, 'files', 'with no words, beside widgets that have them');
  await expectGlyph(page, 'courier', 'coming later, the mock desk\'s words or not');
  await zoomTo(page, 0.5);
  for (const app of ['browser', 'notebook', 'courier', 'files']) await expectGlyph(page, app, 'at 50%, its words hidden');
  await zoomTo(page, 1);
  expect((await probe(page, 'notebook')).face).toBe('widget');
  expect(errors).toEqual([]);
});

test('an open tile going live and back: live it\'s the app, and the canvas draws its glyph the moment it isn\'t, never a blank card', async ({ page, request }) => {
  const errors = await arrive(page, request, { words: false });
  const files = page.getByTestId('open-tile-files');
  await expect(files).toBeVisible();
  expect((await probe(page, 'files')).visible).toBe(false);
  // Every frame from here: whenever the canvas shows the tile, what its last draw was.
  await page.evaluate(() => {
    const w = window as unknown as { __faces: string[]; __facesOn: boolean } & Hook;
    w.__faces = [];
    w.__facesOn = true;
    const stage = (w.__maDesk.camera as unknown as { getStage(): { findOne(q: string): { visible(): boolean; findOne(q: string): { getAttr(k: string): unknown } } } }).getStage();
    const loop = (): void => {
      const n = stage.findOne('#tile-d-personal00001:files');
      if (n.visible()) w.__faces.push(String(n.findOne('Shape').getAttr('face')));
      if (w.__facesOn) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const before = await page.evaluate(() => (window as unknown as Hook).__maDesk.camera.cam);
  await focusCanvas(page);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await settled(page);
  await expect(files).toHaveCount(0);
  await expectGlyph(page, 'files', 'zoomed out of live');
  await page.evaluate((c) => (window as unknown as Hook).__maDesk.camera.set(c), before);
  await settled(page);
  await expect(files).toBeVisible();
  await expect.poll(async () => (await probe(page, 'files')).visible).toBe(false);
  const faces = await page.evaluate(() => {
    const w = window as unknown as { __faces: string[]; __facesOn: boolean };
    w.__facesOn = false;
    return w.__faces;
  });
  expect(faces.length).toBeGreaterThan(0);
  expect([...new Set(faces)]).toEqual(['glyph']);
  expect(errors).toEqual([]);
});

test('an open tile with its app in its window: the glyph, and "Open in its window" under it', async ({ page, request }) => {
  const errors = await arrive(page, request, { words: false });
  const files = page.getByTestId('open-tile-files');
  await expect(files).toBeVisible();
  await files.getByRole('button', { name: 'Open in its window' }).click();
  await expect(page.getByRole('dialog', { name: /Files/ })).toBeVisible();
  await expect.poll(async () => (await probe(page, 'files')).visible).toBe(true);
  const p = await probe(page, 'files');
  expect(p.face).toBe('glyph');
  expect(p.texts).toEqual(['Open in its window']);
  expect(errors).toEqual([]);
});

/** A tile's size in world units on a phone's grid, from its proxy's box and the camera's scale. */
async function gridSize(page: Page, label: RegExp): Promise<{ w: number; h: number }> {
  const box = (await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: label }).boundingBox())!;
  const { s } = await page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }));
  return { w: Math.round(box.width / s), h: Math.round(box.height / s) };
}

for (const words of [false, true]) {
  test(`on a 390 px phone's grid, the same rule: ${words ? 'with words, the widget; Files, with none, its glyph' : 'with no words, every larger tile shows its glyph'}`, async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await arrive(page, request, { words });
    await page.waitForTimeout(400);
    // The grid draws an open tile as a large one, 4 x 4.
    for (const [app, label] of [['courier', /^Courier/], ['files', /^Files/], ['browser', /^Browser/], ['notebook', /^Notebook/]] as const) {
      SIZE[app] = await gridSize(page, label);
      expect(SIZE[app]!.w, app).toBeGreaterThanOrEqual(168);
      const p = await probe(page, app);
      const wordy = words && app !== 'files' && app !== 'courier';
      expect(p.face, app).toBe(wordy ? 'widget' : 'glyph');
      if (!wordy) {
        expect(p.texts, app).toEqual([]);
        expect(p.glyph, app).toBe(glyphFor(SIZE[app]!));
        expect(p.ink, app).toBeGreaterThan(0.04);
      }
    }
    for (const i of PERSONAL_ITEMS) SIZE[i.app] = { w: i.w, h: i.h };
    expect(errors).toEqual([]);
  });
}
