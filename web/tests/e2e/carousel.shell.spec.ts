// Carousel mode (the owner, Nov 9): a switch at each desk's bottom right turns the desk into a stage for one app at a
// time, the full live app, moved by a swipe (touch or trackpad), the arrow keys or the head's buttons, and the same switch
// goes back. Remembered per desk in the layout document. By real mouse, keyboard, wheel and CDP touch, on MockDeskLink.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const ME = 'u-test';
const fleet = [
  { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
];

interface MockControl { rpc: { m: string; p: Record<string, unknown> }[] }
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean; getStage(): { findOne(q: string): { getAttr(k: string): unknown } | undefined } } } };
interface Saved { layout: { desks: Record<string, { carousel?: { on: boolean; app: string } }> } | null }

const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __maDeskMock: MockControl }).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));
const desk = (page: Page, name: string): Locator => page.getByRole('group', { name: `${name} desk` });
const toggle = (page: Page, name = 'Personal'): Locator => desk(page, name).getByRole('button', { name: /^(Carousel|Back to the desk)$/ });
const stage = (page: Page): Locator => page.getByTestId('carousel-stage');
const slide = (page: Page): Locator => page.locator('.carousel-slide:not(.leaving)');
const saved = async (request: APIRequestContext): Promise<Saved | undefined> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, Saved | undefined> }).layoutDocs[ME];

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(250);
}

/** Two desks from the harness's list, the usual row of apps on each, and the Personal desk in front. */
async function arrive(page: Page, request: APIRequestContext, theme: ThemeId = 'light', path = '/'): Promise<void> {
  await setTheme(page, theme);
  await harness(request, { fleet });
  await signIn(page, path);
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
}

/** A real press where the proxy says the control is, on the canvas, as a mouse does it. */
async function press(page: Page, proxy: Locator): Promise<void> {
  const b = (await proxy.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(80);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

/**
 * The switch's place from the desk's bottom right corner, in desk units (the etched row scales with the desk). The same in
 * both modes.
 */
async function switchFromCorner(page: Page, name = 'Personal'): Promise<{ right: number; bottom: number }> {
  const d = (await desk(page, name).getByRole('button', { name: new RegExp(`^${name} desk`) }).boundingBox())!;
  const s = (await toggle(page, name).boundingBox())!;
  const zoom = await page.evaluate(() => (window as unknown as Hook).__maDesk.camera.cam.s);
  return { right: Math.round((d.x + d.width - (s.x + s.width)) / zoom), bottom: Math.round((d.y + d.height - (s.y + s.height)) / zoom) };
}

/** A trackpad's gesture as the browser sends it: `n` wheel events a frame or less apart, all at once here. */
async function trackpad(page: Page, at: { x: number; y: number }, deltaX: number, deltaY: number, n: number): Promise<void> {
  await page.evaluate(({ at, deltaX, deltaY, n }) => {
    const el = document.elementFromPoint(at.x, at.y)!;
    for (let i = 0; i < n; i += 1) el.dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, composed: true }));
  }, { at, deltaX, deltaY, n });
}

async function axe(page: Page, rules: Record<string, { enabled: boolean }> = {}): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (r) => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const res = await w.axe.run({ include: ['.carousel-stage', '.proxy-layer'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
      rules: r,
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, rules);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the switch at the desk\'s bottom right turns it into a stage for one app and back, from the same place', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await expect(toggle(page)).toHaveAccessibleName('Carousel');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(desk(page, 'Personal').getByRole('button', { name: /^Notebook/ })).toHaveCount(1);
  const before = await switchFromCorner(page);
  // It's beside the resize corner, a gap from the grip's slot (6 from the edge, 28 wide), never on it.
  expect(before).toEqual({ right: 6 + 28 + 8, bottom: 22 - 14 });

  await press(page, toggle(page));
  await settled(page);
  await expect(toggle(page)).toHaveAccessibleName('Back to the desk');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(stage(page)).toBeVisible();
  await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
  // The apps are on the stage now, not on the desk to press.
  await expect(desk(page, 'Personal').getByRole('button', { name: /^Notebook/ })).toHaveCount(0);
  // Most of the desk: the stage leaves only the strip and a margin.
  const d = (await desk(page, 'Personal').getByRole('button', { name: /^Personal desk/ }).boundingBox())!;
  const st = (await stage(page).boundingBox())!;
  expect(st.width / d.width).toBeGreaterThan(0.94);
  expect(st.height / d.height).toBeGreaterThan(0.75); // the etched row scales with the desk, so its strip does too
  // The way back is where the way in was, on the desk.
  expect(await switchFromCorner(page)).toEqual(before);
  // And the other desk is as it was.
  await expect(toggle(page, 'Work')).toHaveAttribute('aria-pressed', 'false');
  // A click on the empty canvas leaves the app where it is, as an open window does.
  const top = (await stage(page).boundingBox())!;
  await page.mouse.click(top.x + top.width / 2, Math.max(80, top.y - 40));
  await settled(page);
  await expect(stage(page)).toBeVisible();

  await press(page, toggle(page));
  await settled(page);
  await expect(stage(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAccessibleName('Carousel');
  await expect(desk(page, 'Personal').getByRole('button', { name: /^Notebook/ })).toHaveCount(1);
  expect(await switchFromCorner(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('keys, the head\'s buttons and a trackpad move one app at a time, and stop at the ends', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await settled(page);
  // The stage has the keyboard, as a window does when it opens, so the arrows work at once.
  await expect(stage(page)).toBeFocused();
  await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
  await page.keyboard.press('ArrowLeft');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/); // no wrap
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await stage(page).getByRole('button', { name: 'Next app' }).click();
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
  await stage(page).getByRole('button', { name: 'Previous app' }).click();
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);

  // Typing in the app keeps its arrows.
  await page.locator('.carousel-slide .ProseMirror').first().click();
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);

  // A two-finger swipe: a run of wheel events with deltaX, its momentum included, is one step.
  const box = (await stage(page).boundingBox())!;
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(middle.x, middle.y);
  await trackpad(page, middle, 24, 0, 30);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
  await page.waitForTimeout(400);
  await trackpad(page, middle, -24, 2, 6);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await page.waitForTimeout(400);
  // And through the real input path, one event of a mouse's sideways wheel.
  await page.mouse.wheel(120, 0);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
  await page.waitForTimeout(400);
  await page.mouse.wheel(-120, 0);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await page.waitForTimeout(400);
  // Up and down is the app's, and the office's camera doesn't move for it.
  const cam = await page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }));
  await trackpad(page, middle, 2, 40, 6);
  await page.waitForTimeout(400);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  expect(await page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }))).toEqual(cam);
  expect(errors).toEqual([]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a finger\'s swipe moves it too, and a finger on the Browser\'s picture stays the page\'s', async ({ page, request }) => {
    const errors = watchConsole(page);
    await arrive(page, request);
    await press(page, toggle(page));
    await settled(page);
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (from: { x: number; y: number }, dx: number): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
      for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 6, y: from.y + i }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const box = (await stage(page).boundingBox())!;
    const head = { x: box.x + box.width / 2, y: box.y + 20 };
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await swipe(middle, -160);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
    await swipe(head, -160);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
    await expect(page.getByTestId('browser-video')).toBeVisible();
    await page.waitForTimeout(300);
    const video = (await page.getByTestId('browser-video').boundingBox())!;
    await swipe({ x: video.x + video.width / 2, y: video.y + video.height / 2 }, -160);
    await page.waitForTimeout(300);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
    await swipe(head, 160);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
    expect(errors).toEqual([]);
  });
});

test('only the app on show is live: the Browser streams while it shows, and asks off when swiped away', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  // A Browser window open before the switch is handed to the carousel: one Browser, never two.
  const tile = desk(page, 'Personal').getByRole('button', { name: /^Browser/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
  // The Browser's window fills the screen over the desk, so the switch is reached from the keyboard here.
  await toggle(page).focus();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(page.getByRole('dialog', { name: /Browser/ })).toHaveCount(0);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
  await expect(page.getByTestId('browser-app')).toHaveCount(1);
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
  await expect(page.getByTestId('browser-video')).toBeVisible();
  // Nothing else is mounted: the other apps' code isn't running at all.
  await expect(page.locator('.carousel-slide')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Agent, 4 of \d$/);
  await expect(page.getByTestId('browser-app')).toHaveCount(0);
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('off');
  await expect(page.locator('.carousel-slide')).toHaveCount(1);
  // Back to it, and it streams again.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
  // The overview looks at no desk, so the Browser goes as a parked window's would: the stage is the canvas's card.
  // Shift+Esc leaves from inside the page, where plain Esc is the page's, as from a window.
  await page.getByTestId('browser-keys').focus();
  await page.keyboard.press('Shift+Escape');
  await settled(page);
  await expect(stage(page)).toHaveCount(0);
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('off');
  expect(errors).toEqual([]);
});

test('with the Browser on stage there is one typing ring, around the picture only, not the head', async ({ page, request }) => {
  await arrive(page, request);
  await press(page, toggle(page));
  await settled(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
  await expect(page.getByTestId('browser-video')).toBeVisible();
  const ring = (l: Locator): Promise<string> => l.evaluate((el) => getComputedStyle(el).outlineStyle);
  // The stage itself holds the keyboard, as it does after the switch or an arrow key: no ring around the head.
  await stage(page).focus();
  expect(await ring(stage(page))).toBe('none');
  // Typing goes to the page: the picture has the ring, and still the stage has none.
  await page.getByTestId('browser-keys').focus();
  expect(await ring(page.locator('.carousel-stage .br-surface'))).toBe('solid');
  expect(await ring(stage(page))).toBe('none');
  expect(await page.locator('.carousel-stage *:focus-visible, .carousel-stage:focus-visible').count()).toBeLessThanOrEqual(1);
});

test('zoomed out, the desk shows the app\'s card, and a press on it zooms back to the desk', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await press(page, toggle(page));
  await settled(page);
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await page.keyboard.press('Escape');
  await settled(page);
  await expect(stage(page)).toHaveCount(0);
  const drawn = await page.evaluate(() => (window as unknown as Hook).__maDesk.camera.getStage().findOne('.carousel-card-face')?.getAttr('drawnApp'));
  expect(drawn).toBe('notebook');
  const d = (await desk(page, 'Personal').getByRole('button', { name: /^Personal desk/ }).boundingBox())!;
  await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2);
  await settled(page);
  await expect(stage(page)).toBeVisible();
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  expect(errors).toEqual([]);
});

test('remembered per desk, across a reload and on Platform, and never on another desk', async ({ page, request, browser, baseURL }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await press(page, toggle(page));
  await settled(page);
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await expect.poll(async () => (await saved(request))?.layout?.desks[PERSONAL]?.carousel, { timeout: 15_000 }).toEqual({ on: true, app: 'notebook' });
  expect((await saved(request))?.layout?.desks[WORK]?.carousel).toBeUndefined();
  await page.reload();
  await canvasPainted(page);
  await settled(page);
  await expect(stage(page)).toBeVisible();
  await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await expect(toggle(page, 'Work')).toHaveAttribute('aria-pressed', 'false');
  // The other desk, focused, is a desk.
  await focusCanvas(page);
  await page.keyboard.press('2');
  await settled(page);
  await expect(stage(page)).toHaveCount(0);
  await expect(desk(page, 'Work').getByRole('button', { name: /^Notebook/ })).toHaveCount(1);
  // A fresh browser takes it from Platform.
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const other = await context.newPage();
  await setTheme(other, 'light');
  await signIn(other);
  await canvasPainted(other);
  await focusCanvas(other);
  await other.keyboard.press('1');
  await settled(other);
  await expect(toggle(other)).toHaveAttribute('aria-pressed', 'true');
  await expect(slide(other)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
  await context.close();
  expect(errors).toEqual([]);
});

test('under reduced motion the change is instant; otherwise the apps slide', async ({ page, request }) => {
  await arrive(page, request, 'light', '/?slideMs=3000');
  await press(page, toggle(page));
  await settled(page);
  await page.keyboard.press('ArrowRight');
  // Mid-slide: the one leaving is still there, inert, beside the one coming in.
  await expect(page.locator('.carousel-slide.leaving')).toHaveCount(1);
  await expect(page.locator('.carousel-slide.leaving')).toHaveAttribute('inert', '');
  await expect(page.locator('.carousel-slide.leaving')).toHaveCount(0, { timeout: 6_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('ArrowRight');
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
  await expect(page.locator('.carousel-slide')).toHaveCount(1);
});

for (const theme of ['light', 'dark'] as ThemeId[]) {
  test(`axe at WCAG 2.2 AA on the stage and the switch, ${theme}`, async ({ page, request }) => {
    await arrive(page, request, theme);
    expect(await axe(page)).toEqual([]);
    await press(page, toggle(page));
    await settled(page);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press('ArrowRight');
    await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
    await page.waitForTimeout(600);
    // An empty title in the editor is where the title goes, with its placeholder (as in notebook.shell.spec.ts).
    expect(await axe(page, { 'empty-heading': { enabled: false } })).toEqual([]);
  });
}
