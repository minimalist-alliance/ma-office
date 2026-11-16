// Each app zooms on its own (ADR 0055, the owner, Nov 12): "For every app, I need to be able to zoom in and out with a popout
// slider that shows up next to the expand button on the top of each app or command scroll (ctl scroll for windows)." A button
// beside the expand button in every head (a window's, an open tile's, the carousel's, a phone's slide) opens a slider from 50
// to 200 % in 10 % steps with the level as a button back to 100 %; Ctrl, Cmd or a pinch with the wheel over an app zoom that
// app, never the desk or the page; office apps re-lay out (CSS zoom), the desk Browser takes its desk's own zoom (deskd's
// `browser.zoom.*`, on MockDeskLink here). Remembered per app for the member in this browser. By mouse, keyboard, touch and
// CDP's own pinch.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ME = 'u-test';
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const BIBLE = 'com.minimalistalliance.bible';
const fleet = [
  { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
];

type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean } } };
interface MockControl {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  input: { channel: string; bytes: number[] }[];
  browserZoom: boolean;
  zoom: Record<string, number>;
  setZoom(deskId: string, level: number): void;
}

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const OPEN = { w: span(6), h: span(5) };
interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
const item = (deskId: string, app: string, x: number, y: number, size = { w: 76, h: 76 }): Item => ({ id: `${deskId}:${app}`, app, x, y, ...size });
const deskOf = (x: number, items: Item[]) => ({ x, y: 0, w: Math.max(...items.map((i) => i.x + i.w)) + 24, h: Math.max(...items.map((i) => i.y + i.h)) + 44 + 16, items });
const docOf = (desks: Record<string, unknown>) => ({ version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks, z: Object.keys(desks) } });

const win = (page: Page, app: string): Locator => page.getByTestId(`window-${app}`);
const zoomBtn = (scope: Locator): Locator => scope.locator('.app-zoom').getByRole('button', { name: /^Zoom, \d+%$/ });
const pop = (page: Page): Locator => page.getByRole('dialog', { name: /^Zoom / });
const slider = (page: Page): Locator => pop(page).getByRole('slider', { name: 'Zoom' });
const reset = (page: Page): Locator => pop(page).getByRole('button', { name: /back to 100%$/ });
const cam = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }));
const mock = <T>(page: Page, fn: (m: MockControl) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__maDeskMock)`) as Promise<T>;
const pageScale = (page: Page): Promise<number> => page.evaluate(() => window.visualViewport?.scale ?? 1);
/** The CSS zoom on an app's body, as its computed style has it. */
const bodyZoom = (scope: Locator): Promise<string> => scope.locator('.window-body').first().evaluate((el) => getComputedStyle(el).zoom);
const stored = (page: Page): Promise<unknown> => page.evaluate(() => JSON.parse(localStorage.getItem('ma.appZoom.v1') ?? 'null'));

/**
 * What the app's body draws: the first line of text in it (its glyphs' height on screen, which grows with the zoom), the
 * width the body lays its content out in (CSS px in its own space, which shrinks as it zooms in: it re-lays out), and that
 * no transform scales a picture of it.
 */
async function drawn(scope: Locator, sameText?: string): Promise<{ glyph: number; laidOut: number; box: { w: number; h: number }; transform: string; text: string }> {
  return scope.locator('.window-body').first().evaluate((bodyEl, want) => {
    // The same words as before where they still show: an app at another width may put something else first.
    const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent?.trim() && (!want || n.textContent.trim() === want) && (n.parentElement?.offsetParent ?? null) !== null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const node = walker.nextNode() as Text | null;
    let glyph = 0;
    if (node) {
      const r = document.createRange();
      const at = node.textContent!.search(/\S/);
      r.setStart(node, at);
      r.setEnd(node, at + 1);
      glyph = r.getBoundingClientRect().height;
    }
    const first = bodyEl.firstElementChild as HTMLElement;
    const b = bodyEl.getBoundingClientRect();
    return { glyph, laidOut: parseFloat(getComputedStyle(bodyEl).width), box: { w: Math.round(b.width), h: Math.round(b.height) }, transform: getComputedStyle(first).transform, text: node?.textContent?.trim() ?? '' };
  }, sameText);
}

/** Within `tol` of `target`: a glyph's box is whole pixels, so 16 px at 200 % can read 31. */
const near = (actual: number, target: number, what: string, tol = 0.1): void => {
  expect(Math.abs(actual - target), `${what}: ${actual} is near ${target}`).toBeLessThanOrEqual(tol * target);
};

/** The popout of the button in `scope`, open, with the keyboard on its slider (its chunk may still be on its way). */
async function openPop(page: Page, scope: Locator): Promise<void> {
  await zoomBtn(scope).click();
  await expect(slider(page)).toBeFocused();
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(250);
}

async function arrive(page: Page, request: APIRequestContext, opts: { theme?: ThemeId; layout?: Record<string, unknown>; path?: string; extra?: Record<string, unknown> } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, opts.theme ?? 'light');
  await harness(request, { fleet, files: { enabled: true }, ...(opts.layout ? { layoutDocs: { [ME]: docOf(opts.layout) } } : {}), ...opts.extra });
  await signIn(page, opts.path ?? '/');
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  return errors;
}

/** An app's window, from its tile's stop, as the keyboard and a screen reader press it. */
async function openWindow(page: Page, app: string, deskId = PERSONAL): Promise<Locator> {
  await page.locator(`[id="proxy-${deskId}:${app}"]`).evaluate((el) => (el as HTMLButtonElement).click());
  const w = win(page, app.startsWith('app:') ? app : app);
  await expect(w).toBeVisible();
  await page.waitForTimeout(300); // the window's open
  return w;
}

/** A level from the slider, by its keys: Home, End, or arrows from 100. */
async function setLevel(page: Page, scope: Locator, level: number): Promise<void> {
  if (!(await pop(page).isVisible())) await openPop(page, scope);
  else await slider(page).focus();
  if (level === 50) await page.keyboard.press('Home');
  else if (level === 200) await page.keyboard.press('End');
  else {
    await reset(page).click();
    await slider(page).focus();
    const steps = (level - 100) / 10;
    for (let n = 0; n < Math.abs(steps); n += 1) await page.keyboard.press(steps > 0 ? 'ArrowRight' : 'ArrowLeft');
  }
  await expect(slider(page)).toHaveAttribute('aria-valuetext', `${level}%`);
}

async function axe(page: Page, include: string[]): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (inc) => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const res = await w.axe.run({ include: inc }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

/** A trackpad pinch, as Chromium itself makes one from CDP: wheel events with `ctrlKey`, and no Control key. */
async function pinch(page: Page, at: Locator, scaleFactor: number): Promise<void> {
  const b = (await at.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', { x: b.x + b.width / 2, y: b.y + b.height / 2, scaleFactor, relativeSpeed: 600, gestureSourceType: 'mouse' });
  await cdp.detach();
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a window\'s head: the button before Fill the screen; the popout by mouse and keys, the slider re-lays the Notebook out, the level puts it back', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/\/ZoomPop-[^/]*\.js$/.test(r.url())) chunks.push(r.url());
  });
  const w = await openWindow(page, 'notebook');
  const btn = zoomBtn(w);
  await expect(btn).toHaveAccessibleName('Zoom, 100%');
  await expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  // Beside the expand button, before it, in the window's own controls.
  const order = await w.locator('.window-controls button').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('aria-label')));
  expect(order).toEqual(['Zoom, 100%', 'Fill the screen', 'Close Notebook']);
  // The popout is a chunk of its own, not fetched until the pointer or the keyboard reaches the button.
  expect(chunks).toEqual([]);

  const before = await drawn(w);
  await btn.click();
  await expect(pop(page)).toBeVisible();
  await expect(pop(page)).toHaveAccessibleName('Zoom Notebook');
  expect(chunks).toHaveLength(1);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(slider(page)).toBeFocused();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '100%');
  await expect(reset(page)).toHaveText('100%');
  // The arrows step 10, Home and End go to the ends.
  await page.keyboard.press('ArrowRight');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '110%');
  await expect(btn).toHaveAccessibleName('Zoom, 110%');
  await page.keyboard.press('End');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '200%');
  await page.keyboard.press('ArrowRight');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '200%');
  expect(await bodyZoom(w)).toBe('2');
  const big = await drawn(w);
  // Re-laid out, never a picture: the glyphs are twice as tall, the content laid out at half the width, no transform, and
  // the window the same size.
  near(big.glyph / before.glyph, 2, 'glyphs at 200');
  near(big.laidOut / before.laidOut, 0.5, 'laid out at 200');
  expect(big.transform).toBe('none');
  expect(big.box).toEqual(before.box);
  expect(big.text).toBe(before.text);
  await page.keyboard.press('Home');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '50%');
  const small = await drawn(w);
  near(small.glyph / before.glyph, 0.5, 'glyphs at 50');
  // The level is a button back to 100 %.
  await expect(reset(page)).toHaveAccessibleName('50%, back to 100%');
  await reset(page).click();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '100%');
  expect(await bodyZoom(w)).toBe('1');
  // Esc shuts it and gives the keyboard back to the button; the window stays.
  await slider(page).focus();
  await page.keyboard.press('Escape');
  await expect(pop(page)).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(w).toBeVisible();
  // Enter opens it again from the keyboard; a press outside shuts it.
  await page.keyboard.press('Enter');
  await expect(slider(page)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await w.locator('.window-title').click();
  await expect(pop(page)).toHaveCount(0);
  await expect(btn).toHaveAccessibleName('Zoom, 90%');
  // The head's chrome doesn't zoom with the app (ADR 0064): the title is the size it was.
  expect(await w.locator('.window-title').evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
  expect(errors).toEqual([]);
});

test('every office app re-lays out at 50, 100 and 200 %: Notebook, Files, the Agent and Courier\'s empty state', async ({ page, request }) => {
  const errors = await arrive(page, request);
  for (const app of ['notebook', 'files', 'agent', 'courier']) {
    const w = await openWindow(page, app);
    await expect(zoomBtn(w)).toBeVisible();
    await page.waitForTimeout(500); // the app's own content in
    const at100 = await drawn(w);
    expect(at100.glyph, app).toBeGreaterThan(0);
    await setLevel(page, w, 200);
    const at200 = await drawn(w, at100.text);
    await setLevel(page, w, 50);
    const at50 = await drawn(w, at100.text);
    expect(at200.text, app).toBe(at100.text);
    expect(at50.text, app).toBe(at100.text);
    near(at200.glyph / at100.glyph, 2, `${app}'s glyphs at 200`);
    near(at50.glyph / at100.glyph, 0.5, `${app}'s glyphs at 50`, 0.12);
    near(at200.laidOut / at100.laidOut, 0.5, `${app} laid out at 200`);
    near(at50.laidOut / at100.laidOut, 2, `${app} laid out at 50`);
    for (const d of [at200, at50]) {
      expect(d.transform, app).toBe('none');
      expect(d.box, app).toEqual(at100.box);
    }
    await reset(page).click();
    await page.keyboard.press('Escape');
    await w.getByRole('button', { name: /^Close / }).click();
    await expect(w).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('a desk app\'s sandboxed view re-lays out with its window: the Bible at 200 and 50 %', async ({ page, request }) => {
  const errors = watchConsole(page);
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 50, preinstalled: { [PERSONAL]: [BIBLE] } });
  await setTheme(page, 'light');
  await harness(request, { fleet, appFrames: true });
  await signIn(page);
  await canvasPainted(page);
  await page.locator(`[id="proxy-${PERSONAL}:app:${BIBLE}"]`).evaluate((el) => (el as HTMLButtonElement).click());
  const frameEl = page.locator('[data-testid="deskapp-frame"][data-state="ready"]');
  await expect(frameEl).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400); // the window's open
  const w = page.locator(`.ma-window[data-app="app:${BIBLE}"]`);
  const view = (await (await frameEl.elementHandle())!.contentFrame())!;
  const inner = (): Promise<number> => view.evaluate(() => window.innerWidth);
  const at100 = await inner();
  const box = (await frameEl.boundingBox())!;
  await setLevel(page, w, 200);
  await expect.poll(inner).toBeLessThan(at100 * 0.55);
  expect((await frameEl.boundingBox())!.width).toBeCloseTo(box.width, 0);
  await setLevel(page, w, 50);
  await expect.poll(inner).toBeGreaterThan(at100 * 1.9);
  // Kept by its app id.
  expect(await stored(page)).toEqual({ [`app:${BIBLE}`]: 50 });
  expect(errors).toEqual([]);
});

test('Ctrl, Cmd or a pinch with the wheel over a desk app\'s sandboxed view zoom its window, never the page; the view can\'t send one, and keeps one it takes', async ({ page, request }) => {
  const errors = watchConsole(page);
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 50, preinstalled: { [PERSONAL]: [BIBLE] } });
  await setTheme(page, 'light');
  await harness(request, { fleet, appFrames: true });
  await signIn(page);
  await canvasPainted(page);
  await page.locator(`[id="proxy-${PERSONAL}:app:${BIBLE}"]`).evaluate((el) => (el as HTMLButtonElement).click());
  const frameEl = page.locator('[data-testid="deskapp-frame"][data-state="ready"]');
  await expect(frameEl).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400); // the window's open
  const w = page.locator(`.ma-window[data-app="app:${BIBLE}"]`);
  const btn = zoomBtn(w);
  const view = (await (await frameEl.elementHandle())!.contentFrame())!;
  const b = (await frameEl.boundingBox())!;
  const before = await cam(page);
  const over = async (): Promise<void> => page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await over();
  // Ctrl and a mouse's notch over the view: one step each way, as over any app.
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await expect(btn).toHaveAccessibleName('Zoom, 110%');
  await page.mouse.wheel(0, -100);
  await expect(btn).toHaveAccessibleName('Zoom, 120%');
  await page.mouse.wheel(0, 100);
  await expect(btn).toHaveAccessibleName('Zoom, 110%');
  await page.keyboard.up('Control');
  // Cmd, as on a Mac.
  await page.keyboard.down('Meta');
  await page.mouse.wheel(0, -100);
  await expect(btn).toHaveAccessibleName('Zoom, 120%');
  await page.keyboard.up('Meta');
  // A trackpad's pinch over the view, from CDP: in grows it, out shrinks it.
  await pinch(page, frameEl, 1.5);
  const grown = Number((await btn.getAttribute('data-level')) ?? 0);
  expect(grown).toBeGreaterThanOrEqual(150);
  await pinch(page, frameEl, 0.6);
  const shrunk = Number((await btn.getAttribute('data-level')) ?? 0);
  expect(shrunk).toBeLessThan(grown);
  // Neither the camera nor the page moved, and the view re-laid out at its level.
  expect(await cam(page)).toEqual(before);
  expect(await pageScale(page)).toBe(1);
  expect(await view.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  // A plain wheel over the view is the view's own: no zoom.
  await over();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  await expect(btn).toHaveAttribute('data-level', String(shrunk));

  // The view can't zoom its window itself: not by a message to the office's window, nor by a wheel of its own making.
  await view.evaluate(() => {
    window.parent.postMessage({ w: -100, m: 0, k: true }, '*');
    window.parent.postMessage({ t: 'ma.zoom', w: -100, m: 0, k: true }, '*');
    window.parent.postMessage({ g: 1.5 }, '*');
    // Ports of its own, as if it were the boot: without the boot's nonce they're refused (closed), so this goes nowhere.
    for (const t of ['ma.ports', 'ma.boot']) {
      const zoom = new MessageChannel();
      window.parent.postMessage({ t, ok: true, n: '' }, '*', [new MessageChannel().port1, zoom.port1]);
      for (let i = 0; i < 5; i += 1) zoom.port2.postMessage({ w: -100, m: 0, k: true });
    }
    for (let i = 0; i < 5; i += 1) document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(400);
  await expect(btn).toHaveAttribute('data-level', String(shrunk));

  // A view that takes Ctrl and the wheel for itself (preventDefault on its document) keeps it, as an office app does.
  await view.evaluate(() => document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false }));
  await over();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  await expect(btn).toHaveAttribute('data-level', String(shrunk));
  expect(await pageScale(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('Ctrl, Cmd or a pinch with the wheel over an app zoom it, a step a notch, and neither the camera nor the page moves; off the apps, all as today', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const w = await openWindow(page, 'notebook');
  const btn = zoomBtn(w);
  const body = w.locator('.window-body');
  const b = (await body.boundingBox())!;
  const before = await cam(page);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  // Ctrl and a mouse's notch: one step each way.
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await expect(btn).toHaveAccessibleName('Zoom, 110%');
  await page.mouse.wheel(0, -100);
  await expect(btn).toHaveAccessibleName('Zoom, 120%');
  await page.mouse.wheel(0, 100);
  await expect(btn).toHaveAccessibleName('Zoom, 110%');
  await page.keyboard.up('Control');
  // Cmd, as on a Mac.
  await page.keyboard.down('Meta');
  await page.mouse.wheel(0, -100);
  await expect(btn).toHaveAccessibleName('Zoom, 120%');
  await page.keyboard.up('Meta');
  // Over its head too.
  await page.mouse.move(b.x + 40, b.y - 22);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await expect(btn).toHaveAccessibleName('Zoom, 110%');
  // A trackpad's pinch, from CDP: in grows it, out shrinks it, in about 10 % steps.
  await pinch(page, body, 1.5);
  const grown = Number((await btn.getAttribute('data-level')) ?? 0);
  expect(grown).toBeGreaterThanOrEqual(140);
  await pinch(page, body, 0.6);
  expect(Number((await btn.getAttribute('data-level')) ?? 0)).toBeLessThan(grown);
  expect(await cam(page)).toEqual(before);
  expect(await pageScale(page)).toBe(1);
  // A plain wheel over the app scrolls it, as ever: no zoom.
  const level = await btn.getAttribute('data-level');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  await expect(btn).toHaveAttribute('data-level', level!);

  // Off the apps: a pinch on the canvas zooms the camera; the real Ctrl with the wheel over the bars is the browser's own
  // page zoom (left alone here); the app's level doesn't move.
  const canvas = page.locator('.canvas-wrap');
  const cb = (await canvas.boundingBox())!;
  const spot = { x: cb.x + 30, y: cb.y + cb.height - 80 };
  expect(await page.evaluate(([x, y]) => !document.elementFromPoint(x!, y!)?.closest('[data-zoom-app]'), [spot.x, spot.y])).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', { x: spot.x, y: spot.y, scaleFactor: 1.3, relativeSpeed: 600, gestureSourceType: 'mouse' });
  await settled(page);
  expect((await cam(page)).s).toBeGreaterThan(before.s);
  await page.keyboard.down('Control');
  const overBar = await page.evaluate(() => {
    const bar = document.querySelector('.topbar')!;
    const e = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    bar.dispatchEvent(e);
    return e.defaultPrevented;
  });
  const overApp = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="window-notebook"] .window-body')!;
    const e = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  await page.keyboard.up('Control');
  expect(overBar).toBe(false);
  expect(overApp).toBe(true);
  // Cmd with the wheel off the apps is the browser's too.
  const metaOffApp = await page.evaluate(() => {
    const e = new WheelEvent('wheel', { deltaY: -100, metaKey: true, bubbles: true, cancelable: true });
    document.querySelector('.topbar')!.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(metaOffApp).toBe(false);
  expect(await pageScale(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('an open tile: the button before Open in its window; a pinch over the app zooms it, never the desk', async ({ page, request }) => {
  const layout = {
    [PERSONAL]: deskOf(0, [item(PERSONAL, 'notebook', 24, 24, OPEN), item(PERSONAL, 'files', 24, 24 + OPEN.h + 16), item(PERSONAL, 'courier', 116, 24 + OPEN.h + 16)]),
    [WORK]: deskOf(1400, [item(WORK, 'notebook', 24, 24), item(WORK, 'browser', 116, 24)]),
  };
  const errors = await arrive(page, request, { layout });
  const t = page.getByTestId('open-tile-notebook');
  await expect(t).toBeVisible();
  const btn = zoomBtn(t);
  await expect(btn).toHaveAccessibleName('Zoom, 100%');
  // Its head's buttons: the zoom, then Open in its window at the right end.
  const zb = (await btn.boundingBox())!;
  const eb = (await t.getByRole('button', { name: 'Open in its window' }).boundingBox())!;
  expect(zb.x + zb.width).toBeLessThanOrEqual(eb.x);
  expect(Math.abs(zb.y - eb.y)).toBeLessThan(1);
  await openPop(page, t);
  await page.keyboard.press('End');
  expect(await bodyZoom(t)).toBe('2');
  await page.keyboard.press('Escape');
  await expect(pop(page)).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(t).toBeVisible(); // Esc in the popout is the popout's: the tile stays, the keyboard on its button
  const before = await cam(page);
  await pinch(page, t.locator('.open-tile-app'), 0.5);
  expect(Number(await btn.getAttribute('data-level'))).toBeLessThan(200);
  expect(await cam(page)).toEqual(before);
  // The same level in its window: per app, not per frame.
  const level = await btn.getAttribute('data-level');
  await t.getByRole('button', { name: 'Open in its window' }).click();
  await expect(zoomBtn(win(page, 'notebook'))).toHaveAttribute('data-level', level!);
  expect(errors).toEqual([]);
});

test('Commons doesn\'t zoom yet (its board sizes its canvas on screen): no button in its head, and a pinch over it moves nothing', async ({ page, request }) => {
  const errors = watchConsole(page);
  const GUILD = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'] };
  const PANEL = `guild-${GUILD.guildId}`;
  await setTheme(page, 'light');
  await harness(request, {
    fleet: [fleet[0]],
    guilds: { wakeMs: 300, list: [GUILD], desks: { [GUILD.guildId]: { deskId: 'd-gplatform', state: 'running' } } },
    layoutDocs: { [ME]: docOf({ [PERSONAL]: deskOf(0, [item(PERSONAL, 'notebook', 24, 24)]), [PANEL]: deskOf(1400, [item(PANEL, 'commons', 24, 24, OPEN), item(PANEL, 'notebook', 24, 24 + OPEN.h + 16)]) }) },
  });
  await signIn(page, '/?speed=fast');
  await canvasPainted(page);
  await page.getByRole('group', { name: 'Platform team desk' }).getByRole('button', { name: /^Platform team desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await settled(page);
  const t = page.getByTestId('open-tile-commons');
  await expect(t.getByTestId('commons-app')).toBeVisible({ timeout: 15_000 });
  await expect(t.locator('.app-zoom')).toHaveCount(0);
  await expect(t).not.toHaveAttribute('data-zoom-app', /.*/);
  await expect(t.getByRole('button', { name: 'Open in its window' })).toBeVisible();
  const before = await cam(page);
  await pinch(page, t.getByTestId('commons-app'), 1.5);
  expect(await cam(page)).toEqual(before);
  expect(await pageScale(page)).toBe(1);
  expect(await bodyZoom(t)).toBe('1');
  expect(errors).toEqual([]);
});

test('the carousel on a larger screen: the button at the head\'s end zooms the app shown, and a pinch over the stage does', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: 'Carousel' }).evaluate((el) => (el as HTMLButtonElement).click());
  const stage = page.getByTestId('carousel-stage');
  await expect(stage).toBeVisible();
  await settled(page);
  const app = await stage.locator('.carousel-slide:not(.leaving)').getAttribute('data-app');
  expect(app).toBeTruthy();
  const btn = zoomBtn(stage);
  // The head: Previous, the app, the dots, Next, then the zoom.
  const last = await stage.locator('.carousel-head > *').last().getAttribute('class');
  expect(last).toContain('app-zoom');
  if (app === 'browser') return; // the mock desk's Browser has no zoom; the default first app isn't it
  await openPop(page, stage);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(btn).toHaveAccessibleName('Zoom, 120%');
  expect(await bodyZoom(stage)).toBe('1.2');
  await page.keyboard.press('Escape');
  const before = await cam(page);
  await pinch(page, stage.locator('.carousel-slide:not(.leaving) .window-body'), 1.4);
  expect(Number(await btn.getAttribute('data-level'))).toBeGreaterThan(120);
  expect(await cam(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the slide\'s head has the button at its end; a tap opens the popout, the level and a tap on it put it back', async ({ page, request }) => {
    const errors = await arrive(page, request);
    const tileBtn = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
    const tb = (await tileBtn.boundingBox())!;
    await page.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height / 2);
    const slide = page.locator('.carousel-slide:not(.leaving)');
    await expect(slide).toHaveAttribute('data-app', 'notebook');
    const btn = zoomBtn(slide.locator('.window-head'));
    await expect(btn).toBeVisible();
    // A finger's target.
    const bb = (await btn.boundingBox())!;
    expect(bb.width).toBeGreaterThanOrEqual(44);
    expect(bb.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await expect(pop(page)).toBeVisible();
    // Inside the screen.
    const pb = (await pop(page).boundingBox())!;
    expect(pb.x).toBeGreaterThanOrEqual(0);
    expect(pb.x + pb.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('End');
    await expect(btn).toHaveAccessibleName('Zoom, 200%');
    expect(await bodyZoom(slide)).toBe('2');
    const rb = (await reset(page).boundingBox())!;
    expect(rb.height).toBeGreaterThanOrEqual(44);
    await page.touchscreen.tap(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await expect(btn).toHaveAccessibleName('Zoom, 100%');
    // A tap outside shuts it, and the slide is still there.
    await page.touchscreen.tap(195, 500);
    await expect(pop(page)).toHaveCount(0);
    await expect(slide).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('nothing moves: the popout is there at once, and a new level lays the app out at once, with no animation or transition', async ({ page, request }) => {
    const errors = await arrive(page, request);
    const w = await openWindow(page, 'notebook');
    await openPop(page, w);
    // Every animation running in the head, the popout and the app's body: none.
    const moving = (): Promise<string[]> => w.evaluate((el) => el.getAnimations({ subtree: true }).map((a) => `${(a as CSSAnimation).animationName ?? 'transition'} on ${(a.effect as KeyframeEffect | null)?.target?.className ?? '?'}`));
    const timing = (sel: string): Promise<string> => page.locator(sel).first().evaluate((el) => { const s = getComputedStyle(el); return `${s.transitionDuration} ${s.animationName}`; });
    expect(await moving()).toEqual([]);
    expect(await timing('.app-zoom-pop')).toBe('0s none');
    await page.keyboard.press('End');
    // The level is the app's at once: no transition on `zoom`, nothing in flight.
    expect(await bodyZoom(w)).toBe('2');
    expect(await timing('[data-testid="window-notebook"] .window-body')).toBe('0s none');
    expect(await moving()).toEqual([]);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});

test('remembered per app for this member, in this browser, across a reload; every agent shares one level; 100 % keeps nothing', async ({ page, request }) => {
  const errors = await arrive(page, request);
  let w = await openWindow(page, 'notebook');
  await setLevel(page, w, 130);
  await page.keyboard.press('Escape');
  expect(await stored(page)).toEqual({ notebook: 130 });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  w = await openWindow(page, 'notebook');
  await expect(zoomBtn(w)).toHaveAccessibleName('Zoom, 130%');
  expect(await bodyZoom(w)).toBe('1.3');
  // Files hasn't been zoomed: 100 %.
  const f = await openWindow(page, 'files');
  await expect(zoomBtn(f)).toHaveAccessibleName('Zoom, 100%');
  await setLevel(page, w, 100);
  expect(await stored(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('signing out takes this browser\'s levels with the member\'s other caches', async ({ page, request }) => {
  await arrive(page, request);
  const w = await openWindow(page, 'notebook');
  await setLevel(page, w, 150);
  await page.keyboard.press('Escape');
  expect(await stored(page)).toEqual({ notebook: 150 });
  await page.goto('/signed-out');
  await expect.poll(() => stored(page)).toBeNull();
});

test.describe('the desk Browser', () => {
  test('on a deskd before it: no button, and Ctrl with the wheel over the picture goes to the desk as before', async ({ page, request }) => {
    const errors = await arrive(page, request);
    const w = await openWindow(page, 'browser');
    await expect.poll(() => w.getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    await expect.poll(() => mock(page, (m) => m.rpc.some((r) => r.m === 'browser.zoom.get'))).toBe(true);
    await page.waitForTimeout(300);
    await expect(w.locator('.app-zoom')).toHaveCount(0);
    await expect(w).not.toHaveAttribute('data-zoom-app', /.*/);
    const order = await w.locator('.window-controls button').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('aria-label')));
    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^(Fill the screen|Restore window)$/);
    expect(order[1]).toBe('Close Browser');
    const pic = (await w.getByTestId('browser-video').boundingBox())!;
    const before = await cam(page);
    // A wheel goes to the desk as WHEEL (type 3, `desk/rtc/input.ts`).
    const wheels = (): Promise<number> => mock(page, (m) => m.input.filter((e) => e.bytes[0] === 3).length);
    const sentBefore = await wheels();
    await page.mouse.move(pic.x + pic.width / 2, pic.y + pic.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(wheels).toBeGreaterThan(sentBefore);
    expect(await mock(page, (m) => m.rpc.filter((r) => r.m === 'browser.zoom.set').length)).toBe(0);
    expect(await cam(page)).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('on a desk that zooms its Browser: the button shows the desk\'s level, the slider and the wheel set it there, the desk\'s own change shows', async ({ page, request }) => {
    const errors = await arrive(page, request);
    await mock(page, (m) => {
      m.browserZoom = true;
      m.zoom['d-personal00001'] = 110;
    });
    const w = await openWindow(page, 'browser');
    const btn = zoomBtn(w);
    await expect(btn).toHaveAccessibleName('Zoom, 110%');
    await expect(w).toHaveAttribute('data-zoom-app', 'browser');
    // The picture is never scaled: the page re-lays out on the desk.
    expect(await bodyZoom(w)).toBe('1');
    await openPop(page, w);
    await page.keyboard.press('End');
    await expect.poll(() => mock(page, (m) => m.zoom['d-personal00001'])).toBe(200);
    const sets = await mock(page, (m) => m.rpc.filter((r) => r.m === 'browser.zoom.set'));
    expect(sets.at(-1)!.p).toEqual({ level: 200 });
    expect(sets.every((r) => typeof r.options?.idem === 'string')).toBe(true);
    await page.keyboard.press('Escape');
    // Ctrl with the wheel over the picture: the desk's zoom, not input for the page.
    const pic = (await w.getByTestId('browser-video').boundingBox())!;
    const wheels = (): Promise<number> => mock(page, (m) => m.input.filter((e) => e.bytes[0] === 3).length);
    const wheelsBefore = await wheels();
    await page.mouse.move(pic.x + pic.width / 2, pic.y + pic.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await expect.poll(() => mock(page, (m) => m.zoom['d-personal00001'])).toBe(190);
    await page.waitForTimeout(200);
    // No wheel went to the page (WHEEL, type 3 in `desk/rtc/input.ts`).
    expect(await wheels()).toBe(wheelsBefore);
    // A pinch over it, too.
    await pinch(page, w.getByTestId('browser-video'), 0.7);
    await expect.poll(() => mock(page, (m) => m.zoom['d-personal00001'])).toBeLessThan(190);
    // The desk changed it by itself (a key chord the page took): the office shows it.
    await mock(page, (m) => m.setZoom('d-personal00001', 125));
    await expect(btn).toHaveAccessibleName('Zoom, 125%');
    // Nothing of it kept in this browser: it's the desk's.
    expect(await stored(page)).toBeNull();
    expect(errors).toEqual([]);
  });
});

test.describe('the desk Browser on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function browserSlide(page: Page, request: APIRequestContext, phoneView: boolean): Promise<{ slide: Locator; errors: string[] }> {
    const errors = await arrive(page, request);
    await mock(page, (m) => {
      m.browserZoom = true;
      m.zoom['d-personal00001'] = 120;
    });
    if (phoneView) await page.evaluate(() => void ((window as unknown as { __maDeskMock: { phoneView: boolean } }).__maDeskMock.phoneView = true));
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ });
    const tb = (await tile.boundingBox())!;
    await page.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height / 2);
    const slide = page.locator('.carousel-slide:not(.leaving)');
    await expect(slide).toHaveAttribute('data-app', 'browser');
    await expect.poll(() => mock(page, (m) => m.rpc.some((r) => r.m === 'browser.zoom.get'))).toBe(true);
    return { slide, errors };
  }

  test('a desk that zooms its Browser and serves no phone view: the slide\'s head has the button, a tap sets the desk\'s level', async ({ page, request }) => {
    const { slide, errors } = await browserSlide(page, request, false);
    const btn = zoomBtn(slide.locator('.window-head'));
    await expect(btn).toHaveAccessibleName('Zoom, 120%');
    const bb = (await btn.boundingBox())!;
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await expect(pop(page)).toBeVisible();
    const rb = (await reset(page).boundingBox())!;
    await page.touchscreen.tap(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await expect.poll(() => mock(page, (m) => m.zoom['d-personal00001'])).toBe(100);
    expect(errors).toEqual([]);
  });

  test('while the desk\'s phone view has the tabs (Chromium\'s page zoom is off there), the Browser has no zoom button and no frame to pinch', async ({ page, request }) => {
    const { slide, errors } = await browserSlide(page, request, true);
    await expect(slide.getByTestId('browser-video')).toHaveAttribute('data-view', 'phone');
    await page.waitForTimeout(300);
    await expect(slide.locator('.app-zoom')).toHaveCount(0);
    await expect(slide).not.toHaveAttribute('data-zoom-app', /.*/);
    expect(await mock(page, (m) => m.rpc.filter((r) => r.m === 'browser.zoom.set').length)).toBe(0);
    expect(errors).toEqual([]);
  });
});

/** One column of the slider's own pixels (its screenshot, decoded in the page): `share` of the way across, top to bottom. */
async function column(page: Page, png: Buffer, share: number): Promise<number[][]> {
  return page.evaluate(
    async ([b64, at]) => {
      const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const x = Math.round((bmp.width - 1) * (at as number));
      const out: number[][] = [];
      for (let y = 0; y < bmp.height; y++) out.push([...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]);
      return out;
    },
    [png.toString('base64'), share] as const,
  );
}

const hexRgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const close = (a: number[], b: number[], tol = 3): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the slider is the office's own, from tokens: its track (border.strong in Light, 3:1; fillStrong in Zen and Dark), the accent's fill and thumb, never the browser's dark stripe`, async ({ page, request }) => {
    const errors = await arrive(page, request, { theme });
    const w = await openWindow(page, 'notebook');
    await openPop(page, w);
    await page.mouse.move(0, 0); // no hover on the thumb
    const s = slider(page);
    const own = await s.evaluate((el) => {
      const cs = getComputedStyle(el);
      // Light's unfilled track is the strong border (release 6: fillStrong there was 1.3:1 on the popover).
      const trackVar = document.documentElement.getAttribute('data-theme') === 'light' ? '--ma-border-strong' : '--ma-surface-fill-strong';
      return { appearance: cs.appearance, track: cs.getPropertyValue(trackVar).trim(), accent: cs.getPropertyValue('--ma-accent').trim(), at: cs.getPropertyValue('--ma-range-at').trim() };
    });
    expect(own.appearance).toBe('none');
    expect(Number(own.at)).toBeCloseTo(1 / 3, 3); // 100 % of 50 to 200
    const png = await s.screenshot(); // its own box: the focus ring sits outside it
    const track = hexRgb(own.track);
    const accent = hexRgb(own.accent);
    // Past the thumb, the empty track is its token; before it, the filled part and the thumb are the accent.
    const empty = await column(page, png, 0.9);
    expect(empty.some((p) => close(p, track)), `the empty track ${own.track} in ${JSON.stringify(empty)}`).toBe(true);
    const filled = await column(page, png, 0.1);
    expect(filled.some((p) => close(p, accent)), `the filled track ${own.accent}`).toBe(true);
    const thumb = await column(page, png, 1 / 3);
    expect(thumb.some((p) => close(p, accent)), `the thumb ${own.accent}`).toBe(true);
    // Nothing of Chromium's own dark track (its near-black fill, 59 grey) anywhere along it.
    for (const col of [empty, filled]) expect(col.some((p) => close(p, [59, 59, 59], 4)), 'the native dark track').toBe(false);
    expect(errors).toEqual([]);
  });

  test(`axe in ${theme}: a window's head and its popout open`, async ({ page, request }) => {
    const errors = await arrive(page, request, { theme });
    const w = await openWindow(page, 'notebook');
    expect(await axe(page, ['[data-testid="window-notebook"] .window-head'])).toEqual([]);
    await openPop(page, w);
    expect(await axe(page, ['[data-testid="window-notebook"] .window-head'])).toEqual([]);
    expect(errors).toEqual([]);
  });
}
