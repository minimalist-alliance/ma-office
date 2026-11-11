// Touch control on a phone (#12, the Product Designer's spec (f), `browser/touchInput.ts`): a finger on the Browser's
// picture, read back as the bytes it would put on channels 6 and 7. A tap is a click at the lift (MOVE and BUTTON 1 down
// and up), a double tap a double click at one point, a drag WHEEL on one axis, a hold the right button at the lift, a hold
// and drag a left-button drag, and two fingers or the page row's buttons zoom the picture here, sending nothing, with a
// tap landing through that zoom. The hint card shows on a member's first touch in this browser. A sideways swipe from the
// screen's edge is still the carousel's. At 390 x 844 and 844 x 390 with touch, by CDP touch as a phone's screen sends it,
// on MockDeskLink, in Light, Zen and Dark. `TOUCH_SHOTS=<dir>` keeps stills of the hint, a hold, a zoom and landscape.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['TOUCH_SHOTS'];
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const HINT = 'Tap to click, drag to scroll, pinch to zoom.';
const HINT_MORE = "Hold for the page's menu, or hold and drag to select.";
const fleet = [
  { deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
];

interface Sent {
  channel: 'input' | 'keys';
  bytes: number[];
}
interface Event {
  channel: string;
  type: number;
  down: number;
  button: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}
type Mock = { __maDeskMock: { input: Sent[]; rpc: { m: string; p: Record<string, unknown> }[] } };

const MOVE = 1;
const BUTTON = 2;
const WHEEL = 3;
const U16 = 65535;

const decode = ({ channel, bytes }: Sent): Event => {
  const v = new DataView(new Uint8Array(bytes).buffer);
  return { channel, type: v.getUint8(0), down: v.getUint8(1), button: v.getUint8(2), x: v.getUint16(8), y: v.getUint16(10), dx: v.getInt16(12), dy: v.getInt16(14) };
};
const sent = async (page: Page): Promise<Event[]> => (await page.evaluate(() => (window as unknown as Mock).__maDeskMock.input)).map(decode);
const clear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as Mock).__maDeskMock.input.length = 0;
  });
const buttons = async (page: Page): Promise<Event[]> => (await sent(page)).filter((e) => e.type === BUTTON);
const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as Mock).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

const video = (page: Page): Locator => page.getByTestId('browser-video');
const hint = (page: Page): Locator => page.getByTestId('browser-touch-hint');
const row = (page: Page): Locator => page.getByRole('toolbar', { name: 'Page controls' });
const rowButton = (page: Page, name: string): Locator => row(page).getByRole('button', { name, exact: true });
const slide = (page: Page): Locator => page.locator('.carousel-slide:not(.leaving)');
const zoom = (page: Page): Promise<string | undefined> => video(page).evaluate((v: HTMLVideoElement) => v.dataset['zoom']);

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page): Promise<Box> => (await video(page).boundingBox())!;
/** A point at fractions of a box. */
const at = (b: Box, fx: number, fy: number): { x: number; y: number } => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });

// ----- a finger, through CDP as a touch screen sends it

const start = (cdp: CDPSession, ...pts: { x: number; y: number }[]): Promise<unknown> => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts.map((p, id) => ({ ...p, id })) });
const moveTo = (cdp: CDPSession, ...pts: { x: number; y: number }[]): Promise<unknown> => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts.map((p, id) => ({ ...p, id })) });
const end = (cdp: CDPSession): Promise<unknown> => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

async function tap(cdp: CDPSession, p: { x: number; y: number }): Promise<void> {
  await start(cdp, p);
  await end(cdp);
}

/** A slow drag, resting before it lifts, so nothing carries on after it. */
async function drag(page: Page, cdp: CDPSession, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await start(cdp, from);
  for (let i = 1; i <= 8; i += 1) {
    await moveTo(cdp, { x: from.x + (dx * i) / 8, y: from.y + (dy * i) / 8 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(200);
  await end(cdp);
}

/** A quick sideways swipe, as `carousel.phone.shell.spec.ts` sends one. */
async function swipe(cdp: CDPSession, from: { x: number; y: number }, dx: number): Promise<void> {
  await start(cdp, from);
  for (let i = 1; i <= 6; i += 1) await moveTo(cdp, { x: from.x + (dx * i) / 6, y: from.y + i / 2 });
  await end(cdp);
}

/** A finger's tap in the middle of what the locator covers. */
async function press(page: Page, l: Locator): Promise<void> {
  const b = (await l.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
}

async function axe(page: Page, include: string[]): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (inc) => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const res = await w.axe.run({ include: inc }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __maDesk: { camera: { isMoving(): boolean } } }).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(250);
}

/** The Personal desk on a phone, its Browser opened from its tile into the carousel, full screen, and streaming. */
async function openBrowser(page: Page, request: APIRequestContext, theme: ThemeId): Promise<CDPSession> {
  await setTheme(page, theme);
  await harness(request, { fleet });
  await signIn(page);
  return openFromTile(page);
}

async function openFromTile(page: Page): Promise<CDPSession> {
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ });
  const t = (await tile.boundingBox())!;
  await page.touchscreen.tap(t.x + t.width / 2, t.y + t.height / 2);
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, \d of \d$/);
  return streaming(page);
}

async function streaming(page: Page): Promise<CDPSession> {
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await page.waitForTimeout(400); // the slide
  await clear(page);
  return page.context().newCDPSession(page);
}

const near = (n: number, want: number, by = 0.01): void => {
  expect(n).toBeGreaterThan(U16 * (want - by));
  expect(n).toBeLessThan(U16 * (want + by));
};

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('a phone held upright', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const theme of THEMES) {
    test(`${theme}: a tap clicks at the lift, a drag scrolls on one axis, a hold is the right button, a hold and drag a left drag, a double tap a double click, and the row zooms`, async ({ page, request }) => {
      const errors = watchConsole(page);
      const cdp = await openBrowser(page, request, theme);
      // Touch control is on: the member's own browser doesn't scroll or zoom the office on the surface.
      expect(await video(page).evaluate((v) => [getComputedStyle(v).touchAction, getComputedStyle(v.parentElement!).touchAction])).toEqual(['none', 'none']);
      const b = await box(page);
      expect(b.x).toBe(0);
      expect(b.width).toBe(390);
      // The page row: the zoom, under the surface, with nothing to zoom out of yet and no Fit.
      await expect(row(page)).toBeVisible();
      await expect(rowButton(page, 'Zoom out')).toHaveAttribute('aria-disabled', 'true');
      await expect(rowButton(page, 'Zoom in')).toHaveAttribute('aria-disabled', 'false');
      await expect(rowButton(page, 'Fit the page')).toHaveCount(0);
      const r = (await row(page).boundingBox())!;
      expect(r.height).toBe(52);
      expect(r.width).toBe(390);

      // A tap: nothing while the finger is down; at the lift, MOVE, then BUTTON 1 down and up at its place in the picture.
      // It never takes the keys (no phone keyboard).
      await start(cdp, at(b, 0.25, 0.5));
      await page.waitForTimeout(150);
      expect(await sent(page)).toEqual([]);
      await expect(page.locator('.br-dot')).toHaveCount(1); // the dot shows at once
      await end(cdp);
      await expect.poll(async () => (await sent(page)).length).toBe(3);
      const click = await sent(page);
      expect(click.map((e) => [e.channel, e.type, e.down, e.button])).toEqual([['input', MOVE, 0, 0], ['keys', BUTTON, 1, 1], ['keys', BUTTON, 0, 1]]);
      for (const e of click) {
        near(e.x, 0.25);
        near(e.y, 0.5);
      }
      await expect(page.getByTestId('browser-keys')).not.toBeFocused();

      // The hint card, on the first touch: at the foot of the surface, over the row, said once, politely.
      await expect(hint(page)).toContainText(HINT);
      await expect(hint(page)).toContainText(HINT_MORE);
      await expect(hint(page)).toHaveAttribute('role', 'note');
      await expect(hint(page).getByRole('button', { name: 'Got it' })).toBeVisible();
      await expect(page.getByTestId('live-region')).toHaveText(`${HINT} ${HINT_MORE}`);
      const h = (await hint(page).boundingBox())!;
      expect(h.y).toBeGreaterThanOrEqual(b.y + b.height);
      expect(h.y + h.height).toBeLessThanOrEqual(r.y);
      expect(h.x).toBeGreaterThanOrEqual(12);
      expect(h.x + h.width).toBeLessThanOrEqual(390 - 12);
      await expect(page.getByTestId('browser-notice')).toHaveCount(0);
      expect(await axe(page, ['.br-row', '.br-touch-hint'])).toEqual([]);
      if (SHOTS) {
        await page.waitForTimeout(300); // the dot's fade and the card's
        await page.screenshot({ path: `${SHOTS}/hint-${theme}.png` });
      }

      // A drag up the picture, drifting sideways a little, scrolls the page down only: WHEEL, as far as the finger went.
      await page.waitForTimeout(400); // past a double tap
      await clear(page);
      await drag(page, cdp, at(b, 0.5, 0.8), 14, -120);
      await expect.poll(async () => (await sent(page)).filter((e) => e.type === WHEEL).length).toBeGreaterThan(0);
      const scroll = await sent(page);
      expect(scroll.every((e) => e.type === WHEEL && e.channel === 'keys' && e.dx === 0 && e.dy > 0)).toBe(true);
      const total = scroll.reduce((n, e) => n + e.dy, 0);
      expect(total).toBeGreaterThan((120 - 16) * (1280 / 390) - 2);
      expect(total).toBeLessThan(120 * (1280 / 390) + 2);

      // A hold sends nothing while the finger is down, and its ring fills; at the lift, the right button, BUTTON 3.
      await clear(page);
      const hold = at(b, 0.6, 0.4);
      await start(cdp, hold);
      await page.waitForTimeout(650);
      expect(await sent(page)).toEqual([]);
      await expect(page.locator('.br-press.held')).toHaveCount(1);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/held-${theme}.png` });
      await end(cdp);
      await expect.poll(async () => (await sent(page)).length).toBe(3);
      const held = await sent(page);
      expect(held.map((e) => [e.type, e.down, e.button])).toEqual([[MOVE, 0, 0], [BUTTON, 1, 3], [BUTTON, 0, 3]]);
      near(held[1]!.x, 0.6);
      near(held[1]!.y, 0.4);
      // That was the third gesture: the hint has gone.
      await expect(hint(page)).toHaveCount(0);

      // A hold, then a drag: BUTTON 1 down where it was held, MOVE with the finger, BUTTON 1 up at the lift.
      await clear(page);
      const from = at(b, 0.2, 0.3);
      await start(cdp, from);
      await page.waitForTimeout(650);
      for (let i = 1; i <= 4; i += 1) {
        await moveTo(cdp, { x: from.x + 20 * i, y: from.y });
        await page.waitForTimeout(40);
      }
      await end(cdp);
      await expect.poll(async () => (await buttons(page)).length).toBe(2);
      const sel = await sent(page);
      expect(sel[0]?.type).toBe(MOVE);
      expect(sel.filter((e) => e.type === BUTTON).map((e) => [e.down, e.button])).toEqual([[1, 1], [0, 1]]);
      near(sel[1]!.x, 0.2);
      near(sel.at(-1)!.x, 0.2 + 80 / 390);
      expect(sel.filter((e) => e.type === MOVE).length).toBeGreaterThan(1);
      expect(sel.some((e) => e.button === 3)).toBe(false);

      // A double tap is a double click, both at the first tap's point; the picture doesn't zoom.
      await page.waitForTimeout(400);
      await clear(page);
      const q = at(b, 0.3, 0.2);
      await tap(cdp, q);
      await tap(cdp, { x: q.x + 4, y: q.y + 3 });
      await expect.poll(async () => (await buttons(page)).length).toBe(4);
      const dbl = await buttons(page);
      expect(dbl.map((e) => [e.down, e.button])).toEqual([[1, 1], [0, 1], [1, 1], [0, 1]]);
      expect(new Set(dbl.map((e) => `${e.x},${e.y}`)).size).toBe(1);
      expect(await zoom(page)).toBeUndefined();

      // The row's Zoom in: 1.5x about the middle of what shows, here. Fit comes, and Zoom out may go.
      await page.waitForTimeout(400);
      await clear(page);
      await press(page, rowButton(page, 'Zoom in'));
      await expect.poll(() => zoom(page)).toBe('1.5');
      await expect(rowButton(page, 'Fit the page')).toBeVisible();
      await expect(rowButton(page, 'Zoom out')).toHaveAttribute('aria-disabled', 'false');
      expect(await sent(page)).toEqual([]);
      // A tap through the zoom lands on the desk pixel that shows under it.
      const zr = (await video(page).evaluate((v) => v.getBoundingClientRect().toJSON())) as { x: number; y: number; width: number; height: number };
      const p = { x: 140, y: b.y + 60 };
      await tap(cdp, p);
      await expect.poll(async () => (await buttons(page)).length).toBe(2);
      const through = (await buttons(page))[0]!;
      near(through.x, (p.x - zr.x) / zr.width, 0.003);
      near(through.y, (p.y - zr.y) / zr.height, 0.003);
      await press(page, rowButton(page, 'Zoom in'));
      await expect.poll(() => zoom(page)).toBe('2.25');
      expect(await axe(page, ['.br-row'])).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/zoomed-${theme}.png` });
      // Fit goes back, and goes.
      await rowButton(page, 'Fit the page').click();
      await expect.poll(() => zoom(page)).toBe('1');
      await expect(rowButton(page, 'Fit the page')).toHaveCount(0);
      expect(await video(page).evaluate((v) => v.style.transform)).toBe('');
      expect(errors).toEqual([]);
    });
  }

  test('two fingers zoom and move the picture here, filling the surface and never the row, and send nothing', async ({ page, request }) => {
    const errors = watchConsole(page);
    const cdp = await openBrowser(page, request, 'light');
    const b = await box(page);
    const surface = (await page.locator('.br-surface').boundingBox())!;
    const mid = at(b, 0.5, 0.5);
    await start(cdp, { x: mid.x - 40, y: mid.y }, { x: mid.x + 40, y: mid.y });
    for (let i = 1; i <= 6; i += 1) {
      await moveTo(cdp, { x: mid.x - 40 - 10 * i, y: mid.y }, { x: mid.x + 40 + 10 * i, y: mid.y });
      await page.waitForTimeout(20);
    }
    await end(cdp);
    await page.waitForTimeout(600); // past a hold
    expect(Number(await zoom(page))).toBeCloseTo(200 / 80, 1);
    expect(await sent(page)).toEqual([]);
    // Zoomed past the surface's height, it fills it, from the bar down to the row; the row stays on top and works.
    const rect = (await video(page).evaluate((v) => v.getBoundingClientRect().toJSON())) as Box;
    expect(rect.x).toBeLessThanOrEqual(0);
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(390 - 0.5);
    expect(rect.y).toBeLessThanOrEqual(surface.y + 0.5);
    expect(rect.y + rect.height).toBeGreaterThanOrEqual(surface.y + surface.height - 0.5);
    const zin = (await rowButton(page, 'Zoom out').boundingBox())!;
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[aria-label="Zoom out"]') !== null, [zin.x + zin.width / 2, zin.y + zin.height / 2])).toBe(true);
    // One finger then scrolls the page, as at fit, rather than moving the picture.
    await drag(page, cdp, at(b, 0.5, 0.7), 0, -60);
    await expect.poll(async () => (await sent(page)).filter((e) => e.type === WHEEL).length).toBeGreaterThan(0);
    expect(Number(await zoom(page))).toBeCloseTo(200 / 80, 1);
    expect(errors).toEqual([]);
  });

  test('the hint goes on Got it, and not again for the member in this browser', async ({ page, request }) => {
    const cdp = await openBrowser(page, request, 'light');
    const b = await box(page);
    await tap(cdp, at(b, 0.5, 0.5));
    await expect(hint(page)).toBeVisible();
    await page.waitForTimeout(10_000);
    await expect(hint(page)).toBeVisible(); // no timer a member can miss
    await hint(page).getByRole('button', { name: 'Got it' }).click();
    await expect(hint(page)).toHaveCount(0);
    // A new visit in the same browser: no hint for the same member.
    await page.reload();
    await expect(page.locator('.ma-shell')).toBeVisible();
    const cdp2 = await openFromTile(page);
    await tap(cdp2, at(await box(page), 0.5, 0.5));
    await expect.poll(async () => (await buttons(page)).length).toBe(2);
    await expect(hint(page)).toHaveCount(0);
  });

  test('a sideways swipe from the screen’s edge still moves the carousel; up and down from there, or sideways inside, scrolls the page', async ({ page, request }) => {
    const errors = watchConsole(page);
    const cdp = await openBrowser(page, request, 'light');
    const b = await box(page);
    // Inside the picture, sideways: the page scrolls right (the finger went left), and the Browser stays.
    await swipe(cdp, at(b, 0.6, 0.5), -160);
    await page.waitForTimeout(400);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, /);
    const inside = await sent(page);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((e) => e.type === WHEEL && e.dx >= 0 && e.dy === 0)).toBe(true);
    expect(inside.reduce((n, e) => n + e.dx, 0)).toBeGreaterThan(300);
    // From the left edge, up the screen: a scroll, as anywhere.
    await page.waitForTimeout(1_200); // past any fling
    await clear(page);
    await drag(page, cdp, { x: 6, y: b.y + b.height * 0.8 }, 2, -100);
    await expect.poll(async () => (await sent(page)).filter((e) => e.type === WHEEL).length).toBeGreaterThan(0);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, /);
    // From the left edge, sideways, over the picture: the carousel's. The previous app, and nothing to the page.
    await page.waitForTimeout(400);
    await clear(page);
    await swipe(cdp, { x: 6, y: b.y + b.height / 2 }, 160);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, /);
    expect(await sent(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('a phone on its side', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('the page row is a column at the surface’s right, in the letterbox, and zooms', async ({ page, request }) => {
    const errors = watchConsole(page);
    await harness(request, { fleet });
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId('browser-panel')).toHaveCount(0);
    const cdp = await streaming(page);
    const r = (await row(page).boundingBox())!;
    expect(r.width).toBe(52);
    expect(r.height).toBeGreaterThan(r.width);
    expect(r.x + r.width).toBeGreaterThan(844 - 16);
    // The picture keeps the surface's height: the column doesn't take any of it.
    const surface = (await page.locator('.br-surface').boundingBox())!;
    const view = (await page.locator('.br-view').boundingBox())!;
    expect(surface.height).toBe(view.height);
    await press(page, rowButton(page, 'Zoom in'));
    await expect.poll(() => zoom(page)).toBe('1.5');
    await tap(cdp, at(await box(page), 0.5, 0.5));
    await expect.poll(async () => (await buttons(page)).length).toBe(2);
    expect(await axe(page, ['.br-row'])).toEqual([]);
    if (SHOTS) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/landscape-light.png` });
    }
    expect(errors).toEqual([]);
  });
});
