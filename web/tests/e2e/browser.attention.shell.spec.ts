// One live picture per member (task 46, lever 2): which desk hears `desk.attention.set {seen: true}`, the still an unseen
// desk's Browser shows, and the switch back, on the mock, which keeps deskd's rule (API.md section 10, "Nobody looking"):
// nobody looking for `attentionGraceMs` cuts the media, nobody viewing the Browser for `freezeAfterMs` freezes it, and a
// look thaws it in `thawMs`, "Resuming…" meanwhile. The switch times are printed as `SWITCH` lines for the System Engineer.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

interface MockControl {
  rpc: { m: string; p: Record<string, unknown> }[];
  refuse: Record<string, string>;
  noFrames: boolean;
  framesDrawn: number;
  attention: Record<string, { seen: boolean; frozen: boolean }>;
  attentionGraceMs: number;
  thawMs: number;
  attentionLog: { deskId: string; seen: boolean; at: number }[];
  setKeepThawed(deskId: string, on: boolean): void;
  setSound(deskId: string, on: boolean): void;
  dropLink(deskId?: string): void;
  restoreLink(deskId?: string): void;
}

const GRACE_MS = 400;
/** The mock's stand-in for deskd's 60 s without anyone viewing the Browser. */
const FREEZE_MS = 1_200;
const PERSONAL = 'd-personal';
const WORK = 'd-work';
const GUILD = 'd-guild';

const mock = <T>(page: Page, fn: (c: MockControl, arg: unknown) => T, arg: unknown = null): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__maDeskMock, ${JSON.stringify(arg)})`) as Promise<T>;
/** What each desk last heard from this office. */
const lastSaid = (page: Page): Promise<Record<string, boolean>> =>
  mock(page, (c) => Object.fromEntries(c.attentionLog.map((e) => [e.deskId, e.seen])));
const saidTo = (page: Page, deskId: string): Promise<boolean[]> =>
  mock(page, (c, id) => c.attentionLog.filter((e) => e.deskId === id).map((e) => e.seen), deskId);
const frozen = (page: Page, deskId: string): Promise<boolean | undefined> => mock(page, (c, id) => c.attention[id as string]?.frozen, deskId);
const streamCalls = (page: Page): Promise<string[]> => mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

const browserWindow = (page: Page) => page.getByRole('dialog', { name: /Browser/ });
const video = (page: Page) => page.getByTestId('browser-video');
const held = (page: Page) => page.getByTestId('browser-held');
const panel = (page: Page) => page.getByTestId('browser-panel');
/** A panel on screen: one still inside its delay is in the DOM at opacity 0. */
const panelShown = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="browser-panel"]');
    return el && Number(getComputedStyle(el).opacity) > 0.01 ? el.dataset['panel'] ?? '' : null;
  });
const attached = (page: Page): Promise<boolean> => video(page).evaluate((v: HTMLVideoElement) => v.srcObject !== null);
const frames = (page: Page): Promise<number> => mock(page, (c) => c.framesDrawn);

async function arrive(page: Page): Promise<void> {
  await signIn(page, `/?fixture=three&attentionGraceMs=${GRACE_MS}&freezeAfterMs=${FREEZE_MS}`);
  await canvasPainted(page);
}

async function focusDesk(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${name} desk`) }).evaluate((el) => (el as HTMLButtonElement).click());
}

async function overview(page: Page): Promise<void> {
  await page.getByRole('button', { name: /show all desks/ }).evaluate((el) => (el as HTMLButtonElement).click());
}

async function openBrowser(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(browserWindow(page)).toBeVisible();
}

async function expectPlaying(page: Page): Promise<void> {
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  const shown = (): Promise<number> => video(page).evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  const before = await shown();
  await expect.poll(shown).toBeGreaterThan(before);
  await expect(held(page)).toBeHidden();
}

/** Personal focused, its Browser playing, and a page of its own in the tab strip. */
async function personalPlaying(page: Page): Promise<void> {
  await arrive(page);
  await focusDesk(page, 'Personal');
  await page.waitForTimeout(300);
  await openBrowser(page);
  await expectPlaying(page);
  const address = page.getByTestId('browser-address');
  await address.click();
  await address.fill('example.com/kept');
  await page.keyboard.press('Enter');
  await expect(address).toHaveValue('https://example.com/kept');
}

/** `document.hidden` and `visibilitychange`, as the other specs do it: headless Chromium never hides a page. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    const w = window as unknown as { __hide?: boolean };
    if (w.__hide === undefined) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__hide === true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (w.__hide ? 'hidden' : 'visible') });
    }
    w.__hide = h;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

interface Switch {
  /** From the click to `desk.attention.set {seen: true}` reaching the desk. */
  seenMs: number;
  /** From the click to the first real frame. */
  frameMs: number;
  /** The driver's own measure: the element taking the stream back to that frame. */
  backMs: number;
  /** Every display frame from the click until the first real one had a picture on it: the still or the stream. */
  blank: number;
  /** Display frames with a panel showing over the window, past its delay. */
  panels: number;
  samples: number;
}

/**
 * Personal again, from wherever the camera is, timed in the page: the click, the signal at the desk, the first real frame.
 * Every display frame in between is looked at: something must be painted in the window, the still or the stream.
 */
async function switchBack(page: Page): Promise<Switch> {
  const result = await page.getByRole('button', { name: /^Personal desk/ }).evaluate(async (button: HTMLElement, deskId: string) => {
    const mockControl = (window as unknown as { __maDeskMock: { attentionLog: { deskId: string; seen: boolean; at: number }[] } }).__maDeskMock;
    performance.clearMeasures('ma:browser-back');
    const firstFrameMarks = performance.getEntriesByName('ma:browser-first-frame').length;
    const samples: { visible: boolean; still: boolean; stream: boolean; panel: boolean }[] = [];
    const t0 = performance.now();
    button.click();
    const sample = (): void => {
      const win = document.querySelector('[data-testid="window-browser"]') as HTMLElement | null;
      const canvas = document.querySelector('[data-testid="browser-held"]') as HTMLCanvasElement | null;
      const v = document.querySelector('[data-testid="browser-video"]') as HTMLVideoElement | null;
      const p = document.querySelector<HTMLElement>('[data-testid="browser-panel"]');
      samples.push({
        visible: !!win && win.offsetParent !== null,
        still: !!canvas && !canvas.hidden && canvas.width > 0,
        stream: !!v && v.srcObject !== null && v.readyState >= 2 && v.videoWidth > 0,
        panel: !!p && Number(getComputedStyle(p).opacity) > 0.01,
      });
    };
    await new Promise<void>((done) => {
      const end = performance.now() + 5_000;
      const tick = (): void => {
        sample();
        if (performance.getEntriesByName('ma:browser-first-frame').length > firstFrameMarks || performance.now() > end) {
          // A few more, to see the stream holding after the still went.
          let more = 5;
          const after = (): void => {
            sample();
            if (--more > 0) requestAnimationFrame(after);
            else done();
          };
          requestAnimationFrame(after);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const seenAt = mockControl.attentionLog.filter((e) => e.deskId === deskId && e.seen && e.at >= t0)[0]?.at ?? NaN;
    const frameAt = performance.getEntriesByName('ma:browser-first-frame').at(-1)?.startTime ?? NaN;
    const back = performance.getEntriesByName('ma:browser-back').at(-1)?.duration ?? NaN;
    const shown = samples.filter((s) => s.visible);
    return {
      seenMs: Math.round(seenAt - t0),
      frameMs: Math.round(frameAt - t0),
      backMs: Math.round(back),
      blank: shown.filter((s) => !s.still && !s.stream).length,
      panels: shown.filter((s) => s.panel).length,
      samples: shown.length,
    };
  }, PERSONAL);
  return result;
}

/** Anything on the page scrolled from where it starts, which would move the still off the picture's place. */
const scrolled = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollTop || e.scrollLeft).map((e) => `${e.tagName}.${e.className}:${e.scrollTop},${e.scrollLeft}`));

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
  await harness(request, { reset: true });
});

test('one desk at a time hears it is looked at, the moment that changes; the rest lose their picture, then freeze', async ({ page }) => {
  const errors = watchConsole(page);
  await personalPlaying(page);
  await expect.poll(() => lastSaid(page)).toEqual({ [PERSONAL]: true, [WORK]: false, [GUILD]: false });
  await expect.poll(() => frozen(page, WORK)).toBe(true);
  expect(await frozen(page, GUILD)).toBe(true);
  expect(await frozen(page, PERSONAL)).toBe(false); // viewed: looked at, with its Browser open

  const at = await page.evaluate(() => performance.now());
  await focusDesk(page, 'Work');
  await expect.poll(() => lastSaid(page)).toEqual({ [PERSONAL]: false, [WORK]: true, [GUILD]: false });
  const changed = await mock(page, (c, since) => c.attentionLog.filter((e) => e.at >= (since as number)).map((e) => ({ deskId: e.deskId, seen: e.seen, ms: Math.round(e.at - (since as number)) })), at);
  // Both in the same moment, and nothing sent twice.
  expect(changed.map((e) => `${e.deskId}=${e.seen}`).sort()).toEqual([`${PERSONAL}=false`, `${WORK}=true`]);
  expect(Math.abs((changed[0]?.ms ?? 0) - (changed[1]?.ms ?? 99))).toBeLessThan(50);
  await expect.poll(() => frozen(page, WORK)).toBe(false); // the look thaws it
  await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
  // deskd's rule, not the office's: looked at with no Browser window open, nobody views its Browser, so it freezes again.
  await expect.poll(() => frozen(page, WORK)).toBe(true);
  expect(errors).toEqual([]);
});

test('the overview looks at no desk: every desk hears unseen, and focusing one brings only that one back', async ({ page }) => {
  await personalPlaying(page);
  await overview(page);
  await expect.poll(() => lastSaid(page)).toEqual({ [PERSONAL]: false, [WORK]: false, [GUILD]: false });
  await expect(browserWindow(page)).toBeHidden(); // parked, as ever
  await page.waitForTimeout(300);
  expect(await streamCalls(page)).toEqual(['live']); // its window is open: `live` stands, and the desk holds it at `warm`'s cost
  await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
  // Moving the ring around the overview looks at nothing either.
  await focusCanvas(page);
  await page.keyboard.press(']');
  await page.keyboard.press('[');
  await page.waitForTimeout(200);
  expect(await lastSaid(page)).toEqual({ [PERSONAL]: false, [WORK]: false, [GUILD]: false });
  await focusDesk(page, 'Personal');
  await expect.poll(() => lastSaid(page)).toEqual({ [PERSONAL]: true, [WORK]: false, [GUILD]: false });
  await expectPlaying(page);
});

test('switching back: the still at once, seen first, the picture on its first real frame, no flash, nothing lost', async ({ page }) => {
  const errors = watchConsole(page);
  await personalPlaying(page);
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  const tabsBefore = await page.getByRole('group', { name: 'Tabs on this desk' }).innerText();
  const listsBefore = await mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.tab.list' || r.m === 'browser.tab.reload').length);

  const runs: Switch[] = [];
  for (let i = 0; i < 5; i += 1) {
    await focusDesk(page, 'Work');
    await expect(browserWindow(page)).toBeHidden();
    await expect.poll(() => attached(page)).toBe(false); // the element has let go: nothing decodes or plays
    await expect(held(page)).toHaveJSProperty('hidden', false);
    await expect.poll(() => frozen(page, PERSONAL)).toBe(true); // past the grace: the hardest case
    const drawn = await frames(page);
    await page.waitForTimeout(300);
    expect(await frames(page)).toBe(drawn); // a frozen desk draws nothing

    const s = await switchBack(page);
    runs.push(s);
    expect(s.blank).toBe(0);
    expect(s.panels).toBe(0); // a thaw of 150 ms is over before "Resuming…" would show
    expect(s.seenMs).toBeLessThan(100);
    await expectPlaying(page);
  }
  expect(await streamCalls(page)).toEqual(['live']); // nothing asked of the stream: the look is enough
  const line = `SWITCH mock, after the freeze, 5 runs: seen at the desk p50 ${median(runs.map((r) => r.seenMs))} ms, first real frame p50 ${median(runs.map((r) => r.frameMs))} ms (max ${Math.max(...runs.map((r) => r.frameMs))}), element to frame p50 ${median(runs.map((r) => r.backMs))} ms; ${runs.reduce((n, r) => n + r.samples, 0)} display frames looked at, ${runs.reduce((n, r) => n + r.blank, 0)} blank`;
  console.log(line);
  test.info().annotations.push({ type: 'switch', description: line });

  // Nothing lost: the same document, the same tabs and address, and nothing reloaded or listed again.
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  await expect(page.getByRole('group', { name: 'Tabs on this desk' })).toHaveText(tabsBefore);
  await expect(page.getByTestId('browser-address')).toHaveValue('https://example.com/kept');
  expect(await mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.tab.list' || r.m === 'browser.tab.reload').length)).toBe(listsBefore);
  expect(errors).toEqual([]);
});

test('switching back within the grace, before the desk froze, is the same path', async ({ page }) => {
  await personalPlaying(page);
  await focusDesk(page, 'Work');
  await expect.poll(() => attached(page)).toBe(false);
  expect(await frozen(page, PERSONAL)).toBe(false);
  const s = await switchBack(page);
  console.log(`SWITCH mock, within the grace: seen at the desk ${s.seenMs} ms, first real frame ${s.frameMs} ms, element to frame ${s.backMs} ms, ${s.blank} blank of ${s.samples}`);
  expect(s.blank).toBe(0);
  // Unseen on arrival in the overview, then looked at, away, and back.
  expect(await saidTo(page, PERSONAL)).toEqual([false, true, false, true]);
  await expectPlaying(page);
});

test('a slow thaw says "Resuming…" over the picture, only past its delay, and goes once the desk has thawed', async ({ page }) => {
  const errors = watchConsole(page);
  await personalPlaying(page);
  await focusDesk(page, 'Work');
  await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
  await mock(page, (c) => {
    c.thawMs = 2_500;
  });
  const t0 = await page.evaluate(() => performance.now());
  await focusDesk(page, 'Personal');
  await expect(browserWindow(page)).toBeVisible();
  // Not before its delay: a thaw of a tenth of a second never shows it.
  await expect(panel(page)).toHaveAttribute('data-panel', 'resuming');
  await expect.poll(() => panelShown(page)).toBe('resuming');
  const shownAfter = (await page.evaluate(() => performance.now())) - t0;
  expect(shownAfter).toBeGreaterThan(300);
  await expect(panel(page)).toHaveText('Resuming…');
  await expect(panel(page)).toHaveClass(/over-picture/); // a scrim over the picture, which keeps coming from the frozen frame
  expect(await streamCalls(page)).toEqual(['live']);
  await expect.poll(() => frozen(page, PERSONAL), { timeout: 5_000 }).toBe(false);
  await expectPlaying(page);
  expect(errors).toEqual([]);
});

test('an unseen desk sends no input, decodes nothing, and the window takes no keys', async ({ page }) => {
  await personalPlaying(page);
  await page.getByTestId('browser-video').click();
  await expect(page.getByTestId('browser-keys')).toBeFocused();
  await focusDesk(page, 'Work');
  await expect.poll(() => attached(page)).toBe(false);
  await page.waitForTimeout(200); // the hidden window's keys let go of focus, and release any held key, as they should
  const inputs = await mock(page, (c) => (c as unknown as { input: unknown[] }).input.length);
  await page.keyboard.type('xyz');
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(200);
  expect(await mock(page, (c) => (c as unknown as { input: unknown[] }).input.length)).toBe(inputs);
  // The decoder is idle: no frame reaches the element while parked.
  const shown = await video(page).evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  await page.waitForTimeout(500);
  expect(await video(page).evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBe(shown);
});

test('a hidden tab looks at nothing; the desk freezes by its own word, and coming back is the same switch', async ({ page }) => {
  await personalPlaying(page);
  await setHidden(page, true);
  await expect.poll(() => saidTo(page, PERSONAL)).toEqual([false, true, false]);
  expect(await lastSaid(page)).toEqual({ [PERSONAL]: false, [WORK]: false, [GUILD]: false });
  await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
  // Frozen by the desk's word, the element lets go too, and the still waits for the tab.
  await expect.poll(() => attached(page)).toBe(false);
  await expect(held(page)).toHaveJSProperty('hidden', false);
  expect(await streamCalls(page)).toEqual(['live']); // the 5-minute rule is the stream's, unchanged
  const at = await page.evaluate(() => performance.now());
  await setHidden(page, false);
  await expect.poll(() => saidTo(page, PERSONAL)).toEqual([false, true, false, true]);
  const seen = await mock(page, (c, since) => c.attentionLog.filter((e) => e.at >= (since as number)).map((e) => Math.round(e.at - (since as number))), at);
  expect(seen[0]).toBeLessThan(100);
  await expectPlaying(page);
});

test('a desk playing sound to a hidden tab stays looked at, so the sound keeps coming; a minute quiet, it is unseen', async ({ page }) => {
  test.setTimeout(150_000);
  await personalPlaying(page);
  await mock(page, (c, id) => c.setSound(id as string, true), PERSONAL);
  await page.waitForTimeout(200);
  await setHidden(page, true);
  await page.waitForTimeout(GRACE_MS * 3 + FREEZE_MS);
  // ADR 0038: deskd cuts sound with the picture, so the office keeps saying seen: true while the sound plays here.
  expect(await saidTo(page, PERSONAL)).toEqual([false, true]);
  expect(await frozen(page, PERSONAL)).toBe(false);
  expect(await attached(page)).toBe(true);
  await expect(held(page)).toBeHidden();
  const drawn = await frames(page);
  await expect.poll(() => frames(page)).toBeGreaterThan(drawn); // the picture, and with it the sound, keep coming
  expect(await streamCalls(page)).toEqual(['live']);
  // The sound stops: a minute later (SOUND_QUIET_MS) the tab looks at nothing, and the desk cuts and freezes.
  await mock(page, (c, id) => c.setSound(id as string, false), PERSONAL);
  await page.waitForTimeout(50_000);
  expect(await saidTo(page, PERSONAL)).toEqual([false, true]);
  await expect.poll(() => saidTo(page, PERSONAL), { timeout: 20_000 }).toEqual([false, true, false]);
  await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
  await expect.poll(() => attached(page)).toBe(false);
  await setHidden(page, false);
  await expectPlaying(page);
});

test('a new session hears it again: the desk looked at, and the ones that aren\'t', async ({ page }) => {
  await personalPlaying(page);
  await expect.poll(() => lastSaid(page)).toEqual({ [PERSONAL]: true, [WORK]: false, [GUILD]: false });
  await mock(page, (c) => c.dropLink());
  await page.waitForTimeout(200);
  await mock(page, (c) => c.restoreLink());
  await expect.poll(() => saidTo(page, PERSONAL)).toEqual([false, true, true]);
  await expect.poll(() => saidTo(page, WORK)).toEqual([false, false]);
  await expect.poll(() => saidTo(page, GUILD)).toEqual([false, false]);
  await expectPlaying(page);
});

test('a desk that doesn\'t know the method hears it once a session, and the office works as before', async ({ page }) => {
  const errors = watchConsole(page);
  // Before the first session: the mock is made as the page starts, and refused from that moment.
  await page.addInitScript(() => {
    let kept: unknown;
    Object.defineProperty(window, '__maDeskMock', {
      configurable: true,
      get: () => kept,
      set: (c: { refuse: Record<string, string> }) => {
        c.refuse['desk.attention.set'] = 'not_found';
        c.refuse['desk.attention'] = 'not_found';
        kept = c;
      },
    });
  });
  await arrive(page);
  await focusDesk(page, 'Personal');
  await page.waitForTimeout(300);
  await openBrowser(page);
  await expectPlaying(page);
  await focusDesk(page, 'Work');
  await expect.poll(() => attached(page)).toBe(false);
  const s = await switchBack(page);
  expect(s.blank).toBe(0);
  await expectPlaying(page);
  // One per desk's session, then never again in it, however often the member switched.
  expect(await mock(page, (c) => c.rpc.filter((r) => r.m === 'desk.attention.set').length)).toBe(3);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: screenshots of the still, while the desk thaws, and the picture after`, async ({ page }) => {
    await setTheme(page, theme);
    await personalPlaying(page);
    await focusDesk(page, 'Work');
    await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
    // A desk slow to thaw: the first real frame is held back from the window, so the still stays up for the picture.
    await page.evaluate(() => {
      const w = window as unknown as { __frames: (() => void)[]; __rvfc: HTMLVideoElement['requestVideoFrameCallback'] };
      w.__frames = [];
      w.__rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function held(this: HTMLVideoElement, cb: VideoFrameRequestCallback) {
        w.__frames.push(() => w.__rvfc.call(this, cb));
        return 0;
      };
    });
    await focusDesk(page, 'Personal');
    await expect(browserWindow(page)).toBeVisible();
    await page.waitForTimeout(600);
    await expect(held(page)).toHaveJSProperty('hidden', false);
    await expect(panel(page)).toHaveCount(0);
    expect(await scrolled(page)).toEqual([]); // the still sits where the picture was
    await page.screenshot({ path: `test-results/shots/${theme}-browser-still.png` });
    await page.evaluate(() => {
      const w = window as unknown as { __frames: (() => void)[]; __rvfc: HTMLVideoElement['requestVideoFrameCallback'] };
      HTMLVideoElement.prototype.requestVideoFrameCallback = w.__rvfc;
      for (const f of w.__frames.splice(0)) f();
    });
    await expectPlaying(page);
    await page.waitForTimeout(300);
    expect(await scrolled(page)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-back.png` });
    // A slow thaw: "Resuming…" over the picture.
    await focusDesk(page, 'Work');
    await expect.poll(() => frozen(page, PERSONAL)).toBe(true);
    await mock(page, (c) => {
      c.thawMs = 4_000;
    });
    await focusDesk(page, 'Personal');
    await expect.poll(() => panelShown(page)).toBe('resuming');
    await page.waitForTimeout(400); // past the fade
    await page.screenshot({ path: `test-results/shots/${theme}-browser-resuming.png` });
    await expect.poll(() => frozen(page, PERSONAL), { timeout: 8_000 }).toBe(false);
    await expectPlaying(page);
  });
}

// ----- with the real link against the harness: the signal goes only over an open session, so it never wakes a desk.

const desk = (deskId: string, name: string, kind: string, state: string) => ({ deskId, name, kind, state });
const wakes = async (request: APIRequestContext): Promise<number> =>
  ((await (await request.get('/__harness')).json()) as { connects: { start: unknown }[] }).connects.filter((c) => c.start === true).length;

test('stopped desks: the overview, a hidden tab and the ring moving wake nothing', async ({ page, request }) => {
  await harness(request, { fleet: [desk('d-personal00001', 'Personal', 'personal', 'stopped'), desk('d-work000000001', 'Work', 'work', 'stopped')] });
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  await setHidden(page, true);
  await setHidden(page, false);
  await focusCanvas(page);
  await page.keyboard.press(']');
  await page.waitForTimeout(1_500);
  expect(await wakes(request)).toBe(0);
});
