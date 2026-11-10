// The real Browser window, in the shipped app on staging's test host, on the real test desk: the gate before it reaches
// the owner's desk. Unlike stream.spec.ts there is no test client. Everything goes through the window a member sees, and a page's
// report (document.title, as in streamlib.ts) is read back from the window's own tab strip.
//
// One test, not `serial`: Playwright skips what follows a failed test, and a known input bug shouldn't hide whether closing
// the window stops the stream. So click, typing and wheel are soft, and only what later steps can't do without is hard.
// Don't run this alongside stream.spec.ts (same page server), and another viewer's stream on the desk fails step 5.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { DESK_ID, deskTruth, focusTestDesk, loadUser, signInApp, watch, type Watch, assertTestDesk } from './lib';
import { deployPages, deskUnits, pageUrl, removePages, sleep, titleState } from './streamlib';

const REPORT = 'screenshots/browser-window-report.json';
const SHOT = 'screenshots/browser-window.png';
const FAILURE_SHOT = 'screenshots/browser-window-failure.png';
const DESK_W = 1920;
const DESK_H = 1080;

type BarsState = { n: string; sw: number; sh: number; vis: string };
type InputState = { c: Record<string, number>; l: [string, number, number, number] | null; v: string; sy: number };

const report: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  report[k] = v;
  console.log(`[browser-window] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
};

let context: BrowserContext;
let page: Page;
let w: Watch;
let pagesUp = false;
/** We opened a tab on a shared desk, and it's still there. */
let tabToClose: Locator | null = null;

test.setTimeout(5 * 60_000);

test.beforeAll(async ({ browser }) => {
  mkdirSync('screenshots', { recursive: true });
  assertTestDesk(); // the staging test desk only
  const truth = await deskTruth();
  expect(truth.deskId).toBe(DESK_ID);
  note('desk', { deskId: truth.deskId, deskdVersion: truth.deskdVersion, rtcVersion: truth.rtcVersion });
  await deployPages();
  pagesUp = true;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  const panel = await page.getByTestId('browser-panel').getAttribute('data-panel', { timeout: 2000 }).catch(() => null);
  note('at the failure', { panel, text: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400) });
  await page.screenshot({ path: FAILURE_SHOT }).catch(() => {});
});

test.afterAll(async () => {
  note('console errors', w?.errors ?? []);
  await tabToClose?.click({ timeout: 5000 }).catch(() => {});
  await context?.close();
  if (pagesUp) await removePages().catch((e: Error) => note('removePages failed', e.message.slice(0, 200)));
});

test('the Browser window on the real desk: opens, plays, navigates, takes input, stops, with no console errors', async () => {
  const win = page.getByRole('dialog', { name: /Browser/ });
  const video = win.getByLabel("The page in this desk's browser", { exact: true });
  const keys = win.getByLabel("Keyboard for the page in this desk's browser", { exact: true });
  const address = win.getByRole('textbox', { name: 'Address' });
  const tabs = win.getByTestId('browser-tab');
  const activeTab = win.getByRole('tab', { selected: true });

  /** The newest report from the page on screen, from the window's tab strip. The last one seen if `ok` never holds. */
  async function pageReport<T>(tag: string, ok: (s: T) => boolean = () => true, ms = 8000): Promise<T | null> {
    const t0 = Date.now();
    let last: T | null = null;
    while (Date.now() - t0 < ms) {
      const s = titleState<T>((await activeTab.getAttribute('title', { timeout: 2000 }).catch(() => null)) ?? undefined, tag);
      if (s) { last = s; if (ok(s)) return s; }
      await sleep(120);
    }
    return last;
  }

  async function go(path: string): Promise<void> {
    await address.click();
    await address.fill(pageUrl(path));
    await address.press('Enter');
  }

  await test.step('1 clicking the Browser tile on the test desk opens the window', async () => {
    const deskName = await focusTestDesk(page, w);
    note('1 desk name', deskName);
    // Through the keyboard, as skeleton.spec.ts: with the focus on a proxy its position follows the camera during the move.
    const deskProxy = page.locator(`#proxy-${DESK_ID}`);
    await deskProxy.focus();
    await page.keyboard.press('Enter');
    // Proxies sit under the canvas at each tile's place, so the box says where the tile is and the click really hits the canvas.
    const tile = deskProxy.locator('..').getByRole('button', { name: /^Browser/ });
    let box = await tile.boundingBox();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const now = await tile.boundingBox();
      if (now && JSON.stringify(now) === JSON.stringify(box)) break;
      box = now;
    }
    if (!box) throw new Error('no Browser tile on the test desk');
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await sleep(150);
    await page.mouse.click(x, y);
    await expect(win, 'the window opened').toBeVisible({ timeout: 15_000 });
    await expect(win.getByRole('heading', { name: /^Browser/ }), "it's the test desk's").toContainText(deskName);
  });

  await test.step('2a a picture at the desk size', async () => {
    // A first `live` starts Chromium, which can take 35 s, and a retry after that.
    await expect(win.getByTestId('browser-panel'), 'no panel left over the picture').toHaveCount(0, { timeout: 90_000 });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]), { timeout: 15_000 }).toEqual([DESK_W, DESK_H]);
  });

  const nonce = randomBytes(3).toString('hex');

  // Before 2b, because a picture only has to change when something on the page does.
  await test.step('3 the address bar takes a new tab to a page on the desk, and the chrome shows it', async () => {
    // Its tabs arriving means Chromium is up. The tabs a shared desk already has stay as they are: this works in its own.
    await expect.poll(() => tabs.count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const before = await tabs.count();
    await win.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(tabs, 'the new tab').toHaveCount(before + 1, { timeout: 20_000 });
    // Only ever a tab on screen whose title is one of these pages' reports, so never a tab someone else left on this desk.
    tabToClose = tabs.filter({ has: page.getByRole('tab', { selected: true }) }).getByRole('button', { name: /^Close [RI]\{/ });
    const url = `bars.html?n=${nonce}`;
    await go(url);
    // Only the page can write this nonce in the title. The address bar on its own could still be the text we typed.
    const seen = await pageReport<BarsState>('R', (s) => s.n === nonce, 30_000);
    note('3 the page, as the tab strip shows it', seen);
    expect(seen?.n, "the page's title, in the window's tab strip").toBe(nonce);
    await expect(address, "the page's URL, in the window's address bar").toHaveValue(pageUrl(url), { timeout: 10_000 });
  });

  await test.step('2b a real video: frames advance, and they are this page', async () => {
    const seen = await pageReport<BarsState>('R', (s) => s.n === nonce && s.vis === 'visible');
    expect(seen?.vis, 'the new tab is the one on screen').toBe('visible');
    expect([seen?.sw, seen?.sh], "the desk's own screen, as its Chromium reports it, against the video's size").toEqual([DESK_W, DESK_H]);

    const quality = () => video.evaluate((v: HTMLVideoElement) => {
      const q = v.getVideoPlaybackQuality();
      return { frames: q.totalVideoFrames, dropped: q.droppedVideoFrames, time: v.currentTime, paused: v.paused, muted: v.muted };
    });
    const q0 = await quality();
    await sleep(3000);
    const q1 = await quality();
    note('2 playback over 3 s', { ...q1, framesInWindow: q1.frames - q0.frames, fps: +((q1.frames - q0.frames) / 3).toFixed(1), droppedInWindow: q1.dropped - q0.dropped });
    expect(q1.paused, 'playing').toBe(false);
    expect(q1.frames, 'frames advance').toBeGreaterThan(q0.frames);

    // Known colors at known places, as stream.spec.ts test 1: frames that advance could still be black.
    const quadrants = () => video.evaluate((v: HTMLVideoElement) => {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const x = c.getContext('2d')!;
      x.drawImage(v, 0, 0);
      return [[480, 270], [1440, 270], [480, 810], [1440, 810]].map(([px, py]) => [...x.getImageData(px, py, 1, 1).data].slice(0, 3));
    });
    const looksRight = (p: number[][] | null) => !!p && p[0][0] > 150 && p[0][1] < 70 && p[0][2] < 70 && p[1][1] > 130 && p[1][0] < 70 && p[1][2] < 70 && p[2][2] > 150 && p[2][0] < 70 && p[2][1] < 70 && p[3].every((c) => c > 200);
    let pixels: number[][] | null = null;
    for (let i = 0; i < 100 && !looksRight(pixels); i++) { pixels = await quadrants(); if (!looksRight(pixels)) await sleep(100); }
    note('2 decoded pixels at the four quadrants (RGB)', pixels);
    await page.screenshot({ path: SHOT });
    expect(looksRight(pixels), 'red, green, blue, white where the page has them').toBe(true);
  });

  await test.step('4 a click lands where aimed, typing reaches the page, a wheel scroll moves it', async () => {
    await go('input.html');
    expect(await pageReport<InputState>('I', () => true, 30_000), 'the input page loaded').not.toBeNull();

    // Desk pixels to viewport pixels, worked out here and not with the app's code: the picture is letterboxed in the element.
    const b = await video.evaluate((v: HTMLVideoElement) => {
      const r = v.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, vw: v.videoWidth, vh: v.videoHeight };
    });
    const scale = Math.min(b.width / b.vw, b.height / b.vh);
    const toViewport = (x: number, y: number) => ({ x: b.left + (b.width - b.vw * scale) / 2 + x * scale, y: b.top + (b.height - b.vh * scale) / 2 + y * scale });
    const slack = Math.ceil(1 / scale) + 1; // one viewport pixel is this many desk pixels
    note('4 picture on screen', { scale: +scale.toFixed(3), slackDeskPx: slack });
    const clickAt = async (x: number, y: number) => {
      const c = toViewport(x, y);
      await page.mouse.move(c.x, c.y);
      await page.mouse.click(c.x, c.y);
    };

    // Small targets in the corners and the middle, as stream.spec.ts test 5, so a scale or offset error lands somewhere else.
    const clicks: Record<string, unknown> = {};
    for (const [id, x, y] of [['tl', 80, 60], ['tr', 1840, 60], ['bl', 80, 1020], ['br', 1840, 1020], ['mid', 960, 340]] as const) {
      await clickAt(x, y);
      const got = await pageReport<InputState>('I', (s) => s.c[id] === 1);
      clicks[id] = { aimed: [x, y], landed: got?.l };
      expect.soft(got?.c[id], `click aimed at #${id}`).toBe(1);
      expect.soft(got?.l?.[0], `the click's target, aimed at #${id}`).toBe(id);
      expect.soft(Math.abs((got?.l?.[1] ?? -99) - x), `x off by, aimed at #${id}`).toBeLessThanOrEqual(slack);
      expect.soft(Math.abs((got?.l?.[2] ?? -99) - y), `y off by, aimed at #${id}`).toBeLessThanOrEqual(slack);
    }
    note('4 clicks', clicks);

    await clickAt(960, 64); // the text input
    const focused = await pageReport<InputState>('I', (s) => s.c.text >= 1);
    expect.soft(focused?.c.text, 'the click reached the text input').toBeGreaterThanOrEqual(1);
    await expect.soft(keys, 'the stream has the keyboard').toBeFocused();
    await page.keyboard.type('Hello1', { delay: 40 });
    const typed = await pageReport<InputState>('I', (s) => s.v === 'Hello1');
    note('4 typed', typed?.v);
    expect.soft(typed?.v, "typing, as the page's input holds it").toBe('Hello1');

    const over = toViewport(960, 700);
    await page.mouse.move(over.x, over.y);
    const y0 = (await pageReport<InputState>('I'))?.sy ?? 0;
    await page.mouse.wheel(0, 600);
    const scrolled = await pageReport<InputState>('I', (s) => s.sy > y0);
    note('4 wheel', { from: y0, to: scrolled?.sy });
    expect.soft(scrolled?.sy ?? 0, "the page's scrollY after the wheel").toBeGreaterThan(y0);

    const count = await tabs.count();
    await tabToClose!.click();
    tabToClose = null;
    await expect.soft(tabs, 'our tab closed').toHaveCount(count - 1, { timeout: 10_000 });
  });

  await test.step('5 closing the window stops the stream, per /health', async () => {
    const open = await deskUnits();
    note('5 window open', { stream: open.stream, deskStream: open.units['desk-stream'] });
    // Or leaving `live` below proves nothing.
    expect.soft(open.stream?.wanted, '/health with the window open').toBe('live');
    await win.getByRole('button', { name: 'Close Browser', exact: true }).click();
    await expect(win, 'the window closed').toHaveCount(0);
    let closed = open;
    await expect.poll(async () => {
      closed = await deskUnits();
      return !!closed.stream && closed.stream.wanted !== 'live' && closed.stream.rtc !== 'live';
    }, { message: '/health leaves live', timeout: 60_000, intervals: [1000] }).toBe(true);
    note('5 window closed', { stream: closed.stream, deskStream: closed.units['desk-stream'] });
  });

  await test.step('6 no CSP or other console errors during all of it', async () => {
    expect(w.errors, 'console / CSP errors').toEqual([]);
  });
});
