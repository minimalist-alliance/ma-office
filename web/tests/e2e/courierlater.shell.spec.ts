// Courier comes after the first release, as the landing says ("Coming later", ADR 0047 there). Its tile says so too: a neutral
// "Coming later" chip under its glyph, shown by the widget words' own rule (`laterShows` in canvas/layout.ts): past icon size, at
// the zoom that shows text. At icon size or a farther zoom it can't be read, so nothing shows. Its accessible name says it at any
// zoom. Courier shows none of the mock desk's words (a real desk sends it none), and no count, though the mock says 4 (the
// Designer, Nov 12: `appCount`). Read from the Konva nodes and the canvas's own pixels, on MockDeskLink.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const STUDIO = 'd-studio0000001';

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const OPEN = { w: span(6), h: span(5) };
const MEDIUM = { w: span(2), h: span(2) };
const ICON = { w: 76, h: 76 };

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[] }
interface Probe { visible: boolean; face: string | null; later: boolean; texts: string[]; chip: number; badge: boolean }
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };

const item = (deskId: string, app: string, x: number, y: number, size: { w: number; h: number }): Item => ({ id: `${deskId}:${app}`, app, x, y, ...size });
const deskOf = (x: number, items: Item[]): Desk => ({
  x,
  y: 0,
  w: Math.max(...items.map((i) => i.x + i.w)) + 24,
  h: Math.max(...items.map((i) => i.y + i.h)) + 44 + 16,
  items,
});
/** Courier medium beside a medium Notebook (which has the mock's words) and the Agent (its count, 1); Courier an icon on Work; Courier open on Studio. */
const DESKS: Record<string, Desk> = {
  [PERSONAL]: deskOf(0, [item(PERSONAL, 'courier', 24, 24, MEDIUM), item(PERSONAL, 'notebook', 24 + MEDIUM.w + 16, 24, MEDIUM), item(PERSONAL, 'agent', 24 + 2 * (MEDIUM.w + 16), 24, ICON)]),
  [WORK]: deskOf(700, [item(WORK, 'courier', 24, 24, ICON), item(WORK, 'notebook', 116, 24, ICON)]),
  [STUDIO]: deskOf(1100, [item(STUDIO, 'courier', 24, 24, OPEN)]),
};
const docOf = (desks: Record<string, Desk>) => ({ version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks, z: Object.keys(desks) } });

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await harness(request, {
    fleet: [
      { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
      { deskId: STUDIO, name: 'Studio', kind: 'work', state: 'running' },
    ],
    layoutDocs: { [ME]: docOf(DESKS) },
  });
  await signIn(page, '/');
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  return errors;
}

/** A desk's middle at the middle of the screen, at scale `s`. */
async function zoomTo(page: Page, deskId: string, s: number): Promise<void> {
  const d = DESKS[deskId]!;
  await page.evaluate(({ s, cx, cy }) => {
    const c = (window as unknown as Hook).__maDesk.camera;
    c.set({ s, x: window.innerWidth / 2 - cx * s, y: window.innerHeight / 2 - cy * s });
  }, { s, cx: d.x + d.w / 2, cy: d.y + d.h / 2 });
  await settled(page);
}

/**
 * A tile as the canvas has it: shown or not, its face, whether its last draw drew the chip, its text that shows, how much of
 * the chip's box (60 x 10 around (w / 2, `cy`) in the tile's units) isn't the tile's own fill (the chip's words, or nothing), and
 * whether its count's circle is drawn: the point 8 under the count's middle (w - 12, 10), clear of its digits.
 */
function probe(page: Page, deskId: string, app: string, cy?: number): Promise<Probe> {
  const it = DESKS[deskId]!.items.find((i) => i.app === app)!;
  return page.evaluate(({ id, w, h, cy }) => {
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
    const a = at(w / 2 - 30, cy - 5);
    const b = at(w / 2 + 30, cy + 5);
    const bw = Math.max(1, b.x - a.x);
    const bh = Math.max(1, b.y - a.y);
    const px = ctx.getImageData(a.x, a.y, bw, bh).data;
    let inked = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.max(Math.abs(px[i]! - fill[0]!), Math.abs(px[i + 1]! - fill[1]!), Math.abs(px[i + 2]! - fill[2]!)) > 40) inked += 1;
    }
    const c = at(w - 12, 18);
    const dot = ctx.getImageData(c.x, c.y, 1, 1).data;
    const badge = Math.max(Math.abs(dot[0]! - fill[0]!), Math.abs(dot[1]! - fill[1]!), Math.abs(dot[2]! - fill[2]!)) > 40;
    return { visible: node.visible(), face: (shape.getAttr('face') as string | undefined) ?? null, later: shape.getAttr('later') === true, texts, chip: inked / (bw * bh), badge };
  }, { id: it.id, w: it.w, h: it.h, cy: cy ?? it.h - 20 });
}

for (const theme of ['light', 'dusk'] as const) {
  test(`${theme}: at 100%, Courier past icon size wears its glyph and "Coming later" under it, and none of the mock's words`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme);
    await zoomTo(page, PERSONAL, 1);
    const courier = await probe(page, PERSONAL, 'courier');
    expect(courier.visible).toBe(true);
    expect(courier.face).toBe('glyph');
    expect(courier.later).toBe(true);
    expect(courier.texts, 'the chip is drawn, no label row or lines').toEqual([]);
    expect(courier.chip, 'the chip\'s words are drawn under the glyph').toBeGreaterThan(0.05);
    // The mock desk says Courier has 4; the office draws no count for it. The Agent's 1 still shows.
    expect(courier.badge, 'no count on Courier').toBe(false);
    expect((await probe(page, PERSONAL, 'agent')).badge, 'the Agent\'s count').toBe(true);
    // The Notebook beside it keeps its words, and has no chip.
    const notebook = await probe(page, PERSONAL, 'notebook');
    expect(notebook.face).toBe('widget');
    expect(notebook.later).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('at icon size, or zoomed out past words, no chip; back at a zoom that shows words, it\'s back', async ({ page, request }) => {
  const errors = await arrive(page, request);
  // An icon: too small to read at any zoom.
  for (const s of [1, 1.75]) {
    await zoomTo(page, WORK, s);
    const icon = await probe(page, WORK, 'courier', 66);
    expect(icon.later, `icon at ${s * 100}%`).toBe(false);
    expect(icon.face, `icon at ${s * 100}%`).toBe('glyph');
  }
  // The medium tile: at 75% and 175% the words' zoom, so the chip; at 50% and 25% neither.
  for (const [s, shows] of [[0.75, true], [0.5, false], [0.25, false], [1.75, true]] as const) {
    await zoomTo(page, PERSONAL, s);
    const p = await probe(page, PERSONAL, 'courier');
    expect(p.face, `${s * 100}%`).toBe('glyph');
    expect(p.later, `${s * 100}%`).toBe(shows);
    if (shows) expect(p.chip, `${s * 100}%`).toBeGreaterThan(0.05);
    else expect(p.chip, `${s * 100}%: nothing under the glyph`).toBeLessThan(0.01);
  }
  expect(errors).toEqual([]);
});

test('an open Courier tile with its window open: the chip sits above "Open in its window"', async ({ page, request }) => {
  const errors = await arrive(page, request);
  // Studio shown at 100%: the open tile is live, the app itself ("Courier is on its way"), with "Open in its window".
  await page.locator(`[id="proxy-${STUDIO}"]`).evaluate((el) => (el as HTMLButtonElement).click());
  await settled(page);
  await zoomTo(page, STUDIO, 1);
  const live = page.getByTestId('open-tile-courier');
  await expect(live).toBeVisible();
  await live.getByRole('button', { name: 'Open in its window' }).click();
  await expect(page.getByRole('dialog', { name: /Courier/ })).toBeVisible();
  // 75%: the open tile is 402 px wide, under the 480 it needs to be live, so the canvas draws it.
  await zoomTo(page, STUDIO, 0.75);
  await expect(page.locator('.open-tile')).toHaveCount(0);
  await expect.poll(async () => (await probe(page, STUDIO, 'courier', OPEN.h - 46)).texts).toEqual(['Open in its window']);
  const p = await probe(page, STUDIO, 'courier', OPEN.h - 46);
  expect(p.later).toBe(true);
  expect(p.chip).toBeGreaterThan(0.05);
  expect(errors).toEqual([]);
});

test('its accessible name says it at any zoom, and no other app\'s does', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const desk = (name: string) => page.getByRole('group', { name: `${name} desk` });
  for (const name of ['Personal', 'Work', 'Studio']) {
    // No count in it either, though the mock desk says 4.
    await expect(desk(name).getByRole('button', { name: /^Courier/ })).toHaveAttribute('aria-label', 'Courier, coming later');
  }
  await zoomTo(page, PERSONAL, 0.25);
  await expect(desk('Personal').getByRole('button', { name: /^Courier/ })).toHaveAttribute('aria-label', /^Courier, coming later/);
  for (const name of ['Personal', 'Work']) {
    await expect(desk(name).getByRole('button', { name: /^Notebook/ })).not.toHaveAttribute('aria-label', /coming later/i);
  }
  // Another app's count is still said.
  await expect(desk('Personal').getByRole('button', { name: /^Agent/ })).toHaveAttribute('aria-label', /^Agent, \d+ need you$/);
  expect(errors).toEqual([]);
});
