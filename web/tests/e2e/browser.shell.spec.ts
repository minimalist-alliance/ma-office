// The Browser window with MockDeskLink's generated test picture, and its stopped, waking and stopping states
// with the real link against the harness's own `connect`. `browser.rtc.spec.ts` runs it against real media.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

interface MockControl {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string; deadlineMs?: number } }[];
  noVideo: boolean;
  refuse: Record<string, string>;
  refuseDetails: Record<string, unknown>;
  streamDelayMs: number;
  browserStartMs: number;
  noFrames: boolean;
  framesDrawn: number;
}

const mock = <T>(page: Page, fn: (c: MockControl) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.__maDeskMock)`) as Promise<T>;
const streamCalls = (page: Page): Promise<string[]> => mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

const browserWindow = (page: Page) => page.getByRole('dialog', { name: /Browser/ });
const video = (page: Page) => page.getByTestId('browser-video');
const panel = (page: Page) => page.getByTestId('browser-panel');

async function openBrowser(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(browserWindow(page)).toBeVisible();
}

async function arrive(page: Page, fixture = 'one'): Promise<void> {
  await signIn(page, `/?fixture=${fixture}`);
  await canvasPainted(page);
}

/** The picture is really moving: the element has a size and its frames keep arriving. */
async function expectPlaying(page: Page): Promise<void> {
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  const frames = (): Promise<number> => video(page).evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  const before = await frames();
  await expect.poll(frames).toBeGreaterThan(before);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a first live that takes 75 s, as on a fresh root: it says it is starting, an address waits, and the picture comes with no click', async ({ page }) => {
  test.setTimeout(130_000);
  const errors = watchConsole(page);
  const address = page.getByTestId('browser-address');
  const notice = page.getByTestId('browser-notice');
  await arrive(page);
  await mock(page, (c) => {
    c.browserStartMs = 75_000;
  });
  const started = Date.now();
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'starting');
  await expect(panel(page)).toContainText('Starting the browser');

  await address.click();
  await address.fill('example.com/typed');
  await page.keyboard.press('Enter');

  // Past the 35 s deadline, and the 40 s an address used to wait: nothing has gone wrong.
  await page.waitForTimeout(50_000);
  await expect(panel(page)).toHaveAttribute('data-panel', 'starting');
  await expect(panel(page)).toContainText('Still starting');
  await expect(notice).toHaveCount(0);
  await page.screenshot({ path: 'test-results/shots/browser-slow-first-start.png' });

  await expect(panel(page)).toHaveCount(0, { timeout: 40_000 });
  expect(Date.now() - started).toBeGreaterThan(70_000);
  await expectPlaying(page);
  await expect(address).toHaveValue('https://example.com/typed', { timeout: 10_000 });
  await expect(notice).toHaveCount(0);

  expect(new Set(await streamCalls(page))).toEqual(new Set(['live']));
  const keys = await page.evaluate(() => (window as unknown as { __maDeskMock: MockControl }).__maDeskMock.rpc.filter((r) => r.m === 'browser.tab.navigate').map((r) => r.options?.idem));
  expect(keys.length).toBeGreaterThan(1);
  expect(new Set(keys).size).toBe(1);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the Browser icon opens a real window, with a picture`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openBrowser(page);
    await expectPlaying(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/${theme}-browser.png` });
    expect(await streamCalls(page)).toEqual(['live']);
    expect(errors).toEqual([]);
  });

  test(`${theme}: screenshots of what the window says when it has no picture`, async ({ page }) => {
    await setTheme(page, theme);
    await arrive(page);
    await mock(page, (c) => {
      c.noVideo = true;
    });
    await openBrowser(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'unplayable');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-unplayable.png` });
  });

  test(`${theme}: screenshot of a desk that won't start an older browser on the member's profile`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await mock(page, (c) => {
      c.refuse['browser.stream.set'] = 'unavailable';
      c.refuseDetails = { unit: 'desk-browser', code: 'failed', reason: 'chromium_older_than_profile' };
    });
    await openBrowser(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'outdated');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-outdated.png` });
    expect(errors).toEqual([]);
  });
}

test('the desk hears live, with a deadline of at least 35 s and no idem, then off on close', async ({ page }) => {
  await arrive(page);
  await openBrowser(page);
  await expectPlaying(page);
  const first = await mock(page, (c) => c.rpc.find((r) => r.m === 'browser.stream.set'));
  expect(first?.p).toEqual({ state: 'live' });
  expect(first?.options?.deadlineMs).toBeGreaterThanOrEqual(35_000);
  expect(first?.options?.idem).toBeUndefined();
  await page.keyboard.press('Shift+Escape');
  await expect(browserWindow(page)).toHaveCount(0);
  await expect.poll(() => streamCalls(page)).toEqual(['live', 'off']);
});

test('parking the window on a desk before desk.attention sends off, and coming back sends live, with no fresh wait', async ({ page }) => {
  await arrive(page, 'three');
  await mock(page, (c) => {
    c.refuse['desk.attention.set'] = 'not_found';
  });
  await page.evaluate(() => (window as unknown as { __maDeskMock: { dropLink(): void; restoreLink(): void } }).__maDeskMock.dropLink());
  await page.evaluate(() => (window as unknown as { __maDeskMock: { dropLink(): void; restoreLink(): void } }).__maDeskMock.restoreLink());
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await openBrowser(page);
  await expectPlaying(page);
  await page.getByRole('button', { name: /show all desks/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect.poll(() => streamCalls(page)).toEqual(['live', 'off']);
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect.poll(() => streamCalls(page)).toEqual(['live', 'off', 'live']);
  await expect(panel(page)).toHaveCount(0);
});

test('parking the window on a desk that knows desk.attention keeps live, and coming back asks nothing (deskd API.md section 10)', async ({ page }) => {
  await arrive(page, 'three');
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await openBrowser(page);
  await expectPlaying(page);
  await page.getByRole('button', { name: /show all desks/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expectPlaying(page);
  expect(await streamCalls(page)).toEqual(['live']);
  await expect(panel(page)).toHaveCount(0);
});

test('the picture is a video in a window: no frame writes to the DOM or to React', async ({ page }) => {
  await arrive(page);
  await openBrowser(page);
  await expectPlaying(page);
  const writes = await page.evaluate(async () => {
    let n = 0;
    const seen = new MutationObserver((list) => {
      n += list.length;
    });
    seen.observe(document.querySelector('[data-testid="window-browser"]') as Node, { subtree: true, attributes: true, childList: true, characterData: true });
    await new Promise((done) => setTimeout(done, 1_000));
    seen.disconnect();
    return n;
  });
  expect(writes).toBe(0);
});

test('waiting for picture is calm and ends at the first frame', async ({ page }) => {
  await arrive(page);
  await mock(page, (c) => {
    c.noFrames = true;
  });
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'starting');
  await expect(panel(page)).toHaveText(/Starting the browser/);
  await mock(page, (c) => {
    c.noFrames = false;
  });
  await expectPlaying(page);
});

test('a browser that cannot play H.264 is told so, with no video element and no live', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await mock(page, (c) => {
    c.noVideo = true;
  });
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'unplayable');
  await expect(browserWindow(page).getByText("This browser can't play the desk's video")).toBeVisible();
  await expect(video(page)).toHaveCount(0);
  expect(await streamCalls(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('unavailable while Chromium starts: retries by itself until the picture comes', async ({ page }) => {
  await arrive(page);
  await mock(page, (c) => {
    c.refuse['browser.stream.set'] = 'unavailable';
  });
  await openBrowser(page);
  await expect.poll(async () => (await streamCalls(page)).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await expect(panel(page)).toHaveAttribute('data-panel', 'starting');
  await mock(page, (c) => {
    delete c.refuse['browser.stream.set'];
  });
  await expectPlaying(page);
});

test("chromium_older_than_profile: the window says sign-ins are safe, never asks again by itself, and a press is one try", async ({ page }) => {
  await arrive(page);
  await mock(page, (c) => {
    c.refuse['browser.stream.set'] = 'unavailable';
    c.refuseDetails = { unit: 'desk-browser', code: 'failed', reason: 'chromium_older_than_profile' };
  });
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'outdated');
  await expect(panel(page)).toContainText('Your sign-ins, tabs and history are safe.');
  await page.waitForTimeout(2_500); // past the first two steps of the backoff that a plain `unavailable` gets
  expect(await streamCalls(page)).toEqual(['live']);

  const retry = page.getByTestId('browser-retry');
  await retry.click();
  await expect.poll(() => streamCalls(page)).toEqual(['live', 'live']);
  await expect(panel(page)).toHaveAttribute('data-panel', 'outdated');
  await expect(retry).toBeEnabled();

  // Fixed on the desk: the next press finds it.
  await mock(page, (c) => {
    delete c.refuse['browser.stream.set'];
    c.refuseDetails = {};
  });
  await retry.click();
  await expectPlaying(page);
});

test('a desk without browser.stream.set says it is not ready, and stops asking', async ({ page }) => {
  await arrive(page);
  await mock(page, (c) => {
    c.refuse['browser.stream.set'] = 'not_found';
  });
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'unsupported');
  await page.waitForTimeout(1_500);
  expect(await streamCalls(page)).toEqual(['live']);
});

test('sound refused: plays muted, shows it quietly, and the first click anywhere brings sound in', async ({ page }) => {
  const errors = watchConsole(page);
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function refuseSound(this: HTMLMediaElement) {
      const w = window as unknown as { __soundAllowed?: boolean };
      if (!this.muted && !w.__soundAllowed) return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
      return play.call(this);
    };
  });
  await arrive(page);
  await openBrowser(page);
  await expectPlaying(page);
  await expect(page.getByTestId('browser-muted')).toBeVisible();
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await page.evaluate(() => {
    (window as unknown as { __soundAllowed: boolean }).__soundAllowed = true;
  });
  await page.locator('.window-title').click();
  await expect(page.getByTestId('browser-muted')).toHaveCount(0);
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
  expect(errors).toEqual([]);
});

test('the same, with a key instead of a click', async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function refuseSound(this: HTMLMediaElement) {
      const w = window as unknown as { __soundAllowed?: boolean };
      if (!this.muted && !w.__soundAllowed) return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
      return play.call(this);
    };
  });
  await arrive(page);
  await openBrowser(page);
  await expect(page.getByTestId('browser-muted')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __soundAllowed: boolean }).__soundAllowed = true;
  });
  await page.keyboard.press('Shift');
  await expect(page.getByTestId('browser-muted')).toHaveCount(0);
});

// ----- stopped, waking and stopping, with the real link against the harness's `connect`.

const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const desk = (deskId: string, name: string, kind: string, state: string) => ({ deskId, name, kind, state });
const personal = (state: string) => desk(PERSONAL, 'Personal', 'personal', state);
const wakes = async (request: APIRequestContext): Promise<number> =>
  ((await (await request.get('/__harness')).json()) as { connects: { start: unknown }[] }).connects.filter((c) => c.start === true).length;

async function openOnRealLink(page: Page): Promise<void> {
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await openBrowser(page);
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: asleep, then Wake, then waking`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    // Two desks, so arriving wakes nothing. A refused wake rests asleep, which is how a window sees it.
    await harness(request, { fleet: [personal('stopped'), desk(WORK, 'Work', 'work', 'stopped')], refuseWake: { status: 409, code: 'downtime_active' } });
    await openOnRealLink(page);
    await expect(panel(page)).toHaveAttribute('data-panel', 'asleep');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-asleep.png` });
    const before = await wakes(request);
    await harness(request, { refuseWake: null });
    await page.getByRole('button', { name: 'Wake', exact: true }).click();
    await expect(panel(page)).toHaveAttribute('data-panel', 'waking');
    await expect(browserWindow(page).getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Starting, step 1 of 4');
    await expect.poll(() => wakes(request)).toBe(before + 1);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-waking.png` });
    expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
  });
}

test('opening the window on a stopped desk asks to wake it, once, and nothing else does', async ({ page, request }) => {
  await harness(request, { fleet: [personal('stopped'), desk(WORK, 'Work', 'work', 'stopped')] });
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  expect(await wakes(request)).toBe(0);
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await openBrowser(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'waking');
  await page.waitForTimeout(3_500);
  expect(await wakes(request)).toBe(1);
});

test('a waking desk: the window opens at once, into the steps', async ({ page, request }) => {
  await harness(request, { fleet: [personal('starting')] });
  await openOnRealLink(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'waking');
  await expect(panel(page)).toContainText('Waking this desk…');
  await expect(panel(page)).toContainText('step 1 of 4');
  await expect(panel(page)).not.toContainText(/seconds|usual/i); // no promise we haven't measured
});

test('a desk going to sleep says so', async ({ page, request }) => {
  await harness(request, { fleet: [personal('stopping')] });
  await openOnRealLink(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'stopping');
  await expect(panel(page)).toHaveText(/going to sleep/);
});

test('input the app handles itself goes to the desk as ACTIVITY, once a minute; input on the stream is left to desk-rtc', async ({ page }) => {
  const activity = (): Promise<number> => mock(page, (c) => (c as unknown as { activity: number }).activity);
  await arrive(page);
  await openBrowser(page);
  await expectPlaying(page);
  const b = (await video(page).boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('a');
  expect(await activity()).toBe(0);
  await page.locator('.window-title').click();
  expect(await activity()).toBe(1);
  await page.locator('.window-title').click();
  expect(await activity()).toBe(1);
});

test('in the overview, input counts for the desk it landed on, and the empty canvas counts for nothing', async ({ page }) => {
  const activity = (): Promise<number> => mock(page, (c) => (c as unknown as { activity: number }).activity);
  await arrive(page, 'three');
  await page.mouse.click(4, 450); // off every desk
  expect(await activity()).toBe(0);
  const box = (await page.getByRole('button', { name: /^Work desk/ }).boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
  expect(await activity()).toBe(1);
});

test('the idle rule at rest: a mock desk reopens on input, and the panel says so without a dot', async ({ page }) => {
  await page.clock.install(); // before the page starts its timers; it fakes `performance` too, so no canvasPainted
  await signIn(page, '/?fixture=one');
  await page.waitForTimeout(800);
  await openBrowser(page);
  await expectPlaying(page);
  await page.clock.fastForward('24:02:00');
  await expect(panel(page)).toHaveAttribute('data-panel', 'resting');
  await expect(panel(page)).toContainText('Paused');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/shots/browser-resting.png' });
  expect(await mock(page, (c) => (c as unknown as { idle: string[] }).idle)).toEqual(['rest']);
  await panel(page).click();
  await expect.poll(() => mock(page, (c) => (c as unknown as { idle: string[] }).idle)).toEqual(['rest', 'reopen']);
  await expectPlaying(page);
});
