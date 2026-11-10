// The hidden count (ADR 0064), by real mouse and keyboard. An app with nothing left to press shows as a number
// at the desk's bottom right, cut into its surface, and a click lists what's under there.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const PERSONAL = 'd-personal00001';
const CHAT = `${PERSONAL}:chat`;
const NOTEBOOK = `${PERSONAL}:notebook`;
const BROWSER = `${PERSONAL}:browser`;
const AGENT = `${PERSONAL}:agent`;
const fleet = [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }];

type Box = { x: number; y: number; w: number; h: number };
type Item = Box & { id: string; app: string };
type KNode = { id(): string; x(): number; y(): number; getAttr(k: string): unknown; find(q: string): KNode[]; findOne(q: string): KNode; findAncestor(q: string, self?: boolean): KNode | null; getIntersection(p: { x: number; y: number }): KNode | null; getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[] };
declare const __maDesk: {
  camera: { cam: { x: number; y: number; s: number }; vp: { w: number; h: number }; dpr(): number; isMoving(): boolean; animateTo(c: { x: number; y: number; s: number }, duration?: number): number; getStage(): KNode };
  etchRasters(): number;
};

const item = (id: string, app: string, x: number, y: number, w = 76, h = 76): Item => ({ id, app, x, y, w, h });
const SPREAD = [item(CHAT, 'chat', 40, 40), item(NOTEBOOK, 'notebook', 300, 24), item(BROWSER, 'browser', 500, 100, 200, 200), item(AGENT, 'agent', 650, 24)];

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** One desk, 800 x 500. Only the first load seeds it, so a reload shows what was saved. */
async function seeded(page: Page, request: APIRequestContext, items: Item[] = SPREAD, stack?: string[]): Promise<void> {
  const desk = { id: PERSONAL, x: 0, y: 36, w: 800, h: 500, items, ...(stack ? { stack } : {}) };
  await page.addInitScript((d) => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: { [PERSONAL]: desk }, z: [PERSONAL] }));
  await harness(request, { fleet });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(800);
}

const countButton = (page: Page, n: number, name = 'Personal'): Locator => page.getByRole('button', { name: `${n} hidden ${n === 1 ? 'app' : 'apps'} on the ${name} desk`, exact: true });
const anyCount = (page: Page): Locator => page.locator(`[id="proxy-hidden:${PERSONAL}"]`);
const list = (page: Page): Locator => page.getByRole('menu', { name: 'Hidden apps on the Personal desk' });
const said = (page: Page): Locator => page.getByRole('status').first();

const scale = (page: Page): Promise<number> => page.evaluate(() => __maDesk.camera.cam.s);
const centerOf = async (page: Page, id: string): Promise<{ x: number; y: number }> => {
  const b = (await page.locator(`[id="proxy-${id}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
async function dragApp(page: Page, id: string, dxUnits: number, dyUnits: number): Promise<void> {
  const c = await centerOf(page, id);
  const s = await scale(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + dxUnits * s, c.y + dyUnits * s, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}
/** The number the strip drew last, which a bitmap can't tell a test. */
const drawnCount = (page: Page): Promise<string> => page.evaluate((id) => __maDesk.camera.getStage().findOne(`#desk-${id}`).findOne('.desk-name').getAttr('drawnCount') as string, PERSONAL);
const hitAt = (page: Page, x: number, y: number): Promise<string> => page.evaluate((p) => {
  const hit = __maDesk.camera.getStage().getIntersection(p);
  return hit?.findAncestor('.desk-hidden, .desk-cleanup, .desk-undo, .resize-handle, .app-tile', true)?.getAttr('name') as string ?? 'none';
}, { x, y });
const topApp = (page: Page): Promise<string> => page.evaluate((id) => __maDesk.camera.getStage().findOne(`#desk-${id}`).find('.app-tile').map((n) => n.id().slice('tile-'.length)).at(-1)!, PERSONAL);
/** How many pixels in this box differ from its first, in CSS pixels on the screen. */
const inkIn = (page: Page, box: Box): Promise<number> => page.evaluate((b) => {
  const { camera } = __maDesk;
  const d = camera.dpr();
  const { data } = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context.getImageData(Math.round(b.x * d), Math.round(b.y * d), Math.round(b.w * d), Math.round(b.h * d));
  let count = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i]! - data[0]!) + Math.abs(data[i + 1]! - data[1]!) + Math.abs(data[i + 2]! - data[2]!) > 12) count += 1;
  return count;
}, box);
const deskRect = async (page: Page): Promise<{ right: number; bottom: number; left: number; top: number }> => {
  const b = (await page.locator(`[id="proxy-${PERSONAL}"]`).boundingBox())!;
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
};
// From the right: the grip's target is 6 to 34 and cleanup's 42 to 70. A desk with a hidden app has an overlap, so cleanup's slot
// is held, and the count is 78 to 124.
const countSlot = (r: { right: number; bottom: number }): Box => ({ x: r.right - 124, y: r.bottom - 34, w: 46, h: 24 });
async function clickProxy(page: Page, proxy: Locator): Promise<void> {
  const b = (await proxy.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(80);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

test('an app wholly under another shows the icon with 1, and moved away it goes', async ({ page, request }) => {
  const errors = watchConsole(page);
  await seeded(page, request);
  const r = await deskRect(page);
  await expect(anyCount(page)).toHaveCount(0);
  expect(await drawnCount(page)).toBe('');
  expect(await inkIn(page, countSlot(r))).toBe(0);

  // The big one, dropped over Chat. It's pressed, so it's on top, and Chat has nothing left to press.
  await dragApp(page, BROWSER, -460, -60);
  await expect(countButton(page, 1)).toHaveCount(1);
  expect(await drawnCount(page)).toBe('1');
  await page.mouse.move(5, 500);
  await page.waitForTimeout(150);
  expect(await inkIn(page, countSlot(r))).toBeGreaterThan(30); // at rest, with the pointer away
  await expect(said(page)).toHaveText('1 hidden app on the Personal desk');

  // And away again.
  await dragApp(page, BROWSER, 300, 60);
  await expect(anyCount(page)).toHaveCount(0);
  expect(await drawnCount(page)).toBe('');
  await page.mouse.move(5, 500);
  await page.waitForTimeout(150);
  expect(await inkIn(page, countSlot(r))).toBe(0);
  await expect(said(page)).toHaveText('No hidden apps on the Personal desk');
  expect(errors).toEqual([]);
});

test('the count sits past the sparkle, beside it, nothing slides, and it has its target and tooltip', async ({ page, request }) => {
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  const r = await deskRect(page);
  await expect(countButton(page, 1)).toHaveCount(1);
  const away = async (): Promise<void> => { await page.mouse.move(5, 600); await page.waitForTimeout(150); };
  await away();
  const atRest = await inkIn(page, countSlot(r));
  expect(atRest).toBeGreaterThan(30);
  // From the right: the grip's target ends 34 in, cleanup's is 42 to 70, and the count fills 78 to 124.
  expect(await hitAt(page, r.right - 79, r.bottom - 22)).toBe('desk-hidden');
  expect(await hitAt(page, r.right - 123, r.bottom - 22)).toBe('desk-hidden');
  expect(await hitAt(page, r.right - 101, r.bottom - 22 - 13)).toBe('desk-hidden');
  expect(await hitAt(page, r.right - 101, r.bottom - 22 - 15)).toBe('none');
  expect(await hitAt(page, r.right - 74, r.bottom - 22)).toBe('none'); // the gap between cleanup's and the count
  expect(await hitAt(page, r.right - 20, r.bottom - 22)).toBe('resize-handle');
  // The pointer on the desk brings the grip and the sparkle, and the count stays exactly where it was.
  await page.mouse.move(r.left + 400, r.top + 300);
  await page.waitForTimeout(150);
  expect(await inkIn(page, countSlot(r))).toBe(atRest);
  expect(await hitAt(page, r.right - 56, r.bottom - 22)).toBe('desk-cleanup');
  // The three are evenly spaced: the gaps between their ink are within a pixel of each other.
  const inkCols = await page.evaluate((b) => {
    const { camera } = __maDesk;
    const d = camera.dpr();
    const { data } = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context.getImageData(Math.round(b.x * d), Math.round(b.y * d), Math.round(b.w * d), Math.round(b.h * d));
    const w = Math.round(b.w * d);
    const cols: boolean[] = [];
    for (let x = 0; x < w; x += 1) {
      let ink = false;
      for (let y = 0; y < data.length / 4 / w; y += 1) {
        const i = (y * w + x) * 4;
        if (Math.abs(data[i]! - data[0]!) + Math.abs(data[i + 1]! - data[1]!) + Math.abs(data[i + 2]! - data[2]!) > 40) ink = true;
      }
      cols.push(ink);
    }
    return cols;
  }, { x: r.right - 130, y: r.bottom - 32, w: 126, h: 20 });
  const runs: [number, number][] = [];
  inkCols.forEach((ink, x) => {
    if (!ink) return;
    const last = runs.at(-1);
    if (last && x - last[1] <= 10) last[1] = x; // the icon and its number, or a glyph's own seams, are one run
    else runs.push([x, x]);
  });
  expect(runs).toHaveLength(3); // the count, the sparkle and the grip, from the left
  const gapCount = runs[1]![0] - runs[0]![1];
  const gapGrip = runs[2]![0] - runs[1]![1];
  expect(Math.abs(gapCount - gapGrip), `${gapCount} and ${gapGrip}`).toBeLessThanOrEqual(2);
  await page.screenshot({ path: 'test-results/shots/hidden-row-even.png', clip: { x: r.right - 140, y: r.bottom - 44, width: 140, height: 44 } });
  // Hovering it: the pointer's cursor, the tooltip, and surface.fill behind it.
  await page.mouse.move(r.right - 101, r.bottom - 22);
  await page.waitForTimeout(150);
  const box = page.locator('.konvajs-content').locator('..');
  await expect(box).toHaveAttribute('title', '1 hidden');
  await page.mouse.move(r.left + 400, r.top + 300);
  await page.waitForTimeout(150);
  await expect(box).not.toHaveAttribute('title', '1 hidden');
});

test('a click opens the list above the icon, and choosing brings the app to the front, closes it, rings it and drops the count', async ({ page, request }) => {
  const errors = watchConsole(page);
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(AGENT, 'agent', 110, 110, 56, 56), item(BROWSER, 'browser', 80, 80, 200, 200), item(NOTEBOOK, 'notebook', 650, 24)]);
  await expect(countButton(page, 2)).toHaveCount(1);
  const cam = await page.evaluate(() => ({ ...__maDesk.camera.cam }));
  const b = (await countButton(page, 2).boundingBox())!;
  await clickProxy(page, countButton(page, 2));
  await expect(list(page)).toBeVisible();
  const rows = list(page).getByRole('menuitem');
  await expect(rows).toHaveText(['Chat', 'Agent']); // reading order
  await expect(rows.first().locator('canvas')).toHaveCount(1); // its icon
  const box = (await list(page).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(b.y);
  expect(Math.abs(box.x + box.width - (b.x + b.width))).toBeLessThanOrEqual(1);

  await rows.filter({ hasText: 'Chat' }).click();
  await expect(list(page)).toHaveCount(0);
  expect(await topApp(page)).toBe(CHAT);
  await expect(said(page)).toHaveText('Chat brought to front');
  await expect(page.locator('.hidden-ring')).toHaveCount(1);
  await expect(page.locator('.hidden-ring')).toHaveAttribute('data-item', CHAT);
  await expect(countButton(page, 1)).toHaveCount(1); // Agent, which is still under there
  await expect(page.locator('.hidden-ring')).toHaveCount(0, { timeout: 1500 });
  await expect(said(page)).toHaveText('1 hidden app on the Personal desk');
  expect(await page.evaluate(() => ({ ...__maDesk.camera.cam }))).toEqual(cam);
  expect(errors).toEqual([]);
});

test('the list opens even for one app. A click away only closes it, and Esc does too', async ({ page, request }) => {
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  await clickProxy(page, countButton(page, 1));
  await expect(list(page).getByRole('menuitem')).toHaveText(['Chat']);
  expect(await topApp(page)).not.toBe(CHAT);
  await page.mouse.click(5, 300);
  await expect(list(page)).toHaveCount(0);
  await expect(countButton(page, 1)).toHaveCount(1);
  await clickProxy(page, countButton(page, 1));
  await expect(list(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list(page)).toHaveCount(0);
  await expect(countButton(page, 1)).toHaveCount(1);
});

test('the keyboard: arrows reach the icon, Enter opens, arrows move, Enter chooses, Esc closes', async ({ page, request }) => {
  const errors = watchConsole(page);
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(AGENT, 'agent', 200, 200, 56, 56), item(BROWSER, 'browser', 80, 80, 200, 200), item(NOTEBOOK, 'notebook', 650, 24)]);
  const count = countButton(page, 2);
  // Arrows go through the desk's apps by place and then on to the strip, left to right as drawn: this, then cleanup's button.
  await page.locator(`[id="proxy-${NOTEBOOK}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await expect(count).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Clean up Personal desk', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(count).toBeFocused();

  // Esc takes the keyboard back to the icon.
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeVisible();
  const rows = list(page).getByRole('menuitem');
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list(page)).toHaveCount(0);
  await expect(count).toBeFocused();
  const view = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.view.v1')!) as { mode: string });
  expect(view.mode).not.toBe('overview'); // Esc was the list's

  // Enter chooses, and the chosen app takes the keyboard, already on top.
  await page.keyboard.press('Enter');
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list(page)).toHaveCount(0);
  expect(await topApp(page)).toBe(AGENT);
  await expect(page.locator(`[id="proxy-${AGENT}"]`)).toBeFocused();
  await expect(countButton(page, 1)).toHaveCount(1);
  await expect(page.locator('.hidden-ring')).toHaveAttribute('data-item', AGENT);

  // Down to the last one: the icon goes, and the keyboard goes to the app it chose rather than nowhere.
  const last = countButton(page, 1);
  await last.focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['Chat']);
  await page.keyboard.press('Enter');
  await expect(anyCount(page)).toHaveCount(0);
  await expect(page.locator(`[id="proxy-${CHAT}"]`)).toBeFocused();
  expect(errors).toEqual([]);
});

test('Cleanup takes the count to zero, and Undo brings it back', async ({ page, request }) => {
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  const r = await deskRect(page);
  await expect(countButton(page, 1)).toHaveCount(1);
  await clickProxy(page, page.getByRole('button', { name: 'Clean up Personal desk', exact: true }));
  await expect(anyCount(page)).toHaveCount(0);
  expect(await drawnCount(page)).toBe('');
  await expect(page.locator('.hidden-ring')).toHaveCount(0);
  await page.waitForTimeout(300);
  // "Undo" holds cleanup's slot, 42 to 88 in, and there's nothing past it where a count would go.
  expect(await inkIn(page, { x: r.right - 142, y: r.bottom - 34, w: 46, h: 24 })).toBe(0);
  await clickProxy(page, page.getByRole('button', { name: 'Undo clean up Personal desk', exact: true }));
  await expect(countButton(page, 1)).toHaveCount(1);
  expect(await drawnCount(page)).toBe('1');
  await page.mouse.move(5, 600);
  await page.waitForTimeout(350);
  expect(await inkIn(page, countSlot(r))).toBeGreaterThan(30);
});

test('a raise, a reload and a corner drag all keep it right', async ({ page, request }) => {
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  await expect(countButton(page, 1)).toHaveCount(1);
  await page.waitForTimeout(1200); // the mirror is debounced by 1 s
  await page.reload();
  await canvasPainted(page);
  await page.waitForTimeout(800);
  await expect(countButton(page, 1)).toHaveCount(1);
  expect(await drawnCount(page)).toBe('1');

  // Dragging the desk's corner moves the count with it: it hangs from the same edge.
  const r = await deskRect(page);
  await page.mouse.move(r.left + 400, r.top + 300);
  await page.waitForTimeout(100);
  await page.mouse.move(r.right - 20, r.bottom - 22);
  await page.mouse.down();
  await page.mouse.move(r.right + 20, r.bottom + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await deskRect(page);
  expect(after.right).toBeGreaterThan(r.right + 30);
  expect(await hitAt(page, after.right - 101, after.bottom - 22)).toBe('desk-hidden');
  await expect(countButton(page, 1)).toHaveCount(1);
});

test('at most six rows and then it scrolls, and the keyboard scrolls it', async ({ page, request }) => {
  const apps = ['chat', 'notebook', 'browser', 'agent'];
  const pile = Array.from({ length: 8 }, (_, i) => item(`${PERSONAL}:x${i}`, apps[i % 4]!, 100 + i, 100 + i));
  await seeded(page, request, [...pile, item(BROWSER, 'browser', 80, 80, 200, 200)]);
  await expect(countButton(page, 8)).toHaveCount(1);
  await clickProxy(page, countButton(page, 8));
  const rows = list(page).getByRole('menuitem');
  await expect(rows).toHaveCount(8);
  const box = (await list(page).boundingBox())!;
  const row = (await rows.first().boundingBox())!;
  expect(Math.round(row.height)).toBe(40);
  expect(box.height).toBeLessThanOrEqual(6 * 40 + 14);
  expect(box.height).toBeGreaterThanOrEqual(6 * 40);
  expect(await list(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await expect(rows.last()).toBeInViewport();
  expect(await list(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
});

test('a phone keeps its grid, so a stored pile shows no count', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  await expect(anyCount(page)).toHaveCount(0);
  expect(await page.getByRole('button', { name: /hidden/ }).count()).toBe(0);
  expect(await drawnCount(page)).toBe('');
  await context.close();
});

test('never sluggish: a drag renders nothing and rasters nothing until the drop, a new number is one bitmap, and a move draws what\'s held', async ({ page, request }) => {
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
  const commits = (): Promise<number> => page.evaluate(() => (window as unknown as { __commits: number }).__commits);
  const rasters = (): Promise<number> => page.evaluate(() => __maDesk.etchRasters());
  await seeded(page, request);
  const s = await scale(page);

  // Over Chat, through the air: the drag itself renders once as it starts and then nothing, and the count waits for the drop.
  const c = await centerOf(page, BROWSER);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x - 40 * s, c.y - 10 * s, { steps: 4 });
  await page.waitForTimeout(100);
  const during = await commits();
  const bitmaps = await rasters();
  await page.mouse.move(c.x - 460 * s, c.y - 60 * s, { steps: 30 });
  await page.waitForTimeout(100);
  expect(await commits()).toBe(during);
  expect(await rasters()).toBe(bitmaps);
  await expect(anyCount(page)).toHaveCount(0); // not yet, though it's right over it
  await page.mouse.up();
  await expect(countButton(page, 1)).toHaveCount(1);
  await page.mouse.move(5, 500);
  await page.waitForTimeout(150);
  const withOne = await rasters();
  expect(withOne - bitmaps).toBeLessThanOrEqual(1); // the new number, and at most that

  // A camera move draws what's held: no render of the desk, no new bitmap.
  const before = await rasters();
  const beforeCommits = await commits();
  await page.evaluate(() => {
    const { camera } = __maDesk;
    const { x, y, s: z } = camera.cam;
    camera.animateTo({ x: x + 80, y: y + 30, s: z * 0.9 }, 300);
  });
  await page.waitForTimeout(150);
  expect(await commits()).toBe(beforeCommits);
  await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
  await page.waitForTimeout(100);
  expect(await rasters()).toBe(before);

  // The same number again is the same bitmap.
  await page.waitForTimeout(100);
  const c2 = await centerOf(page, BROWSER);
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.move(c2.x + 300 * (await scale(page)), c2.y + 60 * (await scale(page)), { steps: 8 });
  await page.mouse.up();
  await expect(anyCount(page)).toHaveCount(0);
  const none = await rasters();
  const c3 = await centerOf(page, BROWSER);
  await page.mouse.move(c3.x, c3.y);
  await page.mouse.down();
  await page.mouse.move(c3.x - 300 * (await scale(page)), c3.y - 60 * (await scale(page)), { steps: 8 });
  await page.mouse.up();
  await expect(countButton(page, 1)).toHaveCount(1);
  await page.waitForTimeout(100);
  expect(await rasters()).toBe(none);
});

test('under reduced motion the ring is static, and still goes after 600 ms', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  await clickProxy(page, countButton(page, 1));
  await list(page).getByRole('menuitem').first().click();
  const ring = page.locator('.hidden-ring');
  await expect(ring).toHaveCount(1);
  expect(await ring.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await ring.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(ring).toHaveCount(0, { timeout: 1500 });
});

// What it looks like, in each theme, at 1x and 2x.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  for (const dpr of [1, 2]) {
    test(`how it looks: ${theme} at ${dpr}x`, async ({ browser, request }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      await setTheme(page, theme);
      await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(AGENT, 'agent', 110, 110, 56, 56), item(NOTEBOOK, 'notebook', 90, 90), item(BROWSER, 'browser', 80, 80, 200, 200), item(`${PERSONAL}:free`, 'agent', 500, 24)]);
      await expect(countButton(page, 3)).toHaveCount(1);
      const r = await deskRect(page);
      await page.mouse.move(5, 600);
      await page.waitForTimeout(200);
      const strip = { x: r.right - 260, y: r.bottom - 60, width: 260, height: 66 };
      await page.screenshot({ path: `test-results/shots/hidden-${theme}-${dpr}x-rest.png`, clip: strip });
      await page.mouse.move(r.left + 400, r.top + 300);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `test-results/shots/hidden-${theme}-${dpr}x-hover.png`, clip: strip });
      // Zoomed out and in, the corner is the same size on screen. The desk's bottom right is kept in view.
      for (const zoom of [0.6, 2]) {
        await page.evaluate((z) => {
          const { camera } = __maDesk;
          camera.animateTo({ s: z, x: camera.vp.w - 200 - 800 * z, y: camera.vp.h - 150 - 536 * z }, 0);
        }, zoom);
        await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
        const z = await deskRect(page);
        await page.mouse.move(z.right - 220, z.bottom - 100);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `test-results/shots/hidden-${theme}-${dpr}x-zoom${zoom}-hover.png`, clip: { x: z.right - 260, y: z.bottom - 60, width: 260, height: 66 } });
      }
      await page.evaluate(() => {
        const { camera } = __maDesk;
        camera.animateTo({ s: 1, x: camera.vp.w / 2 - 400, y: camera.vp.h / 2 - 286 }, 0);
      });
      await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
      if (dpr === 1) {
        await clickProxy(page, countButton(page, 3));
        await expect(list(page)).toBeVisible();
        await page.waitForTimeout(100);
        await page.screenshot({ path: `test-results/shots/hidden-${theme}-list.png` });
        await list(page).getByRole('menuitem').first().click();
        await page.waitForTimeout(250); // the ring at its full strength
        await page.screenshot({ path: `test-results/shots/hidden-${theme}-ring.png` });
      }
      await context.close();
    });
  }
}

test('on touch the count has a 44 px tall target with room for its number, and a tap opens the list and a tap chooses', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  const b = (await countButton(page, 1).boundingBox())!;
  expect(Math.round(b.height)).toBe(44);
  expect(Math.round(b.width)).toBe(62);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  const row = list(page).getByRole('menuitem');
  await expect(row).toHaveText(['Chat']);
  await page.waitForTimeout(400); // a browser's late click would have landed by now, and closed it
  await expect(list(page)).toBeVisible();
  const r = (await row.boundingBox())!;
  await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
  await expect(anyCount(page)).toHaveCount(0);
  expect(await topApp(page)).toBe(CHAT);
  await context.close();
});

test('the same size on screen at every zoom, and when the desk is too small it hides with the other icons and stays in the proxy', async ({ page, request }) => {
  await seeded(page, request, [item(CHAT, 'chat', 100, 100), item(BROWSER, 'browser', 80, 80, 200, 200), item(AGENT, 'agent', 500, 24), item(NOTEBOOK, 'notebook', 650, 24)]);
  const aim = async (zoom: number): Promise<void> => {
    await page.evaluate((z) => {
      const { camera } = __maDesk;
      camera.animateTo({ s: z, x: camera.vp.w / 2 - 400 * z + 0.37, y: camera.vp.h / 2 - 286 * z + 0.19 }, 0);
    }, zoom);
    await expect.poll(() => page.evaluate(() => __maDesk.camera.isMoving())).toBe(false);
    await page.mouse.move(2, 500);
    await page.waitForTimeout(200);
  };
  await aim(1);
  const r1 = await deskRect(page);
  const ink = await inkIn(page, countSlot(r1));
  expect(ink).toBeGreaterThan(30);
  const bitmaps = await page.evaluate(() => __maDesk.etchRasters());
  for (const zoom of [0.6, 1.4]) {
    await aim(zoom);
    const r = await deskRect(page);
    expect(await inkIn(page, countSlot(r)), `at ${zoom}`).toBe(ink);
    expect(await hitAt(page, r.right - 101, r.bottom - 22), `at ${zoom}`).toBe('desk-hidden');
    expect(await drawnCount(page)).toBe('1');
  }
  expect(await page.evaluate(() => __maDesk.etchRasters())).toBe(bitmaps);

  // 800 x 0.3 is 240 on screen, under the 290 where icons go.
  await aim(0.3);
  expect(await drawnCount(page)).toBe('');
  const small = await deskRect(page);
  expect(await hitAt(page, small.right - 101, small.bottom - 22)).not.toBe('desk-hidden');
  await expect(countButton(page, 1)).toHaveCount(1);
});
