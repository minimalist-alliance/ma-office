// A phone's keyboard and the desk's phone view (#12 part 2; the Product Designer's spec (f) section 3; deskd API.md section
// 10, "On a phone"). The page row's Keyboard raises it; the key row takes the row's place; typing goes as the run
// (Backspaces and new text, so autocorrect, predictions and dictation work); Enter, sticky Ctrl, the arrows and Hide. With
// a deskd that serves the phone view, the window sends its box as the device, shows only the phone's region, sends a
// finger as the primary button, raises the keyboard when a field takes focus, and Desktop site takes the view back; a
// desktop watching hears that the phone has it. At 390 x 844 with touch, on MockDeskLink, in Light, Zen and Dark.
// `TOUCH_SHOTS=<dir>` keeps stills of typing and of the phone view.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const SHOTS = process.env['TOUCH_SHOTS'];
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const DESK = 'd-personal00001';
const fleet = [
  { deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
];
const GUARD = '​';
const K = { BackSpace: 0xff08, Return: 0xff0d, Left: 0xff51, Right: 0xff53, Control: 0xffe3 };

interface Sent {
  channel: 'input' | 'keys';
  bytes: number[];
}
interface Event {
  type: number;
  down: number;
  button: number;
  x: number;
  y: number;
  keysym: number;
}
interface View {
  mode: string;
  region?: { x: number; y: number; width: number; height: number };
  screen?: { width: number; height: number };
}
type Mock = {
  __maDeskMock: {
    input: Sent[];
    rpc: { m: string; p: Record<string, unknown> }[];
    phoneView: boolean;
    view: Record<string, View>;
    deviceLog: { deskId: string; device: { width: number; height: number } | null }[];
    setField(deskId: string, field: unknown): void;
    setView(deskId: string, view: unknown): void;
  };
};

const MOVE = 1;
const BUTTON = 2;
const WHEEL = 3;
const KEY = 4;
const decode = ({ bytes }: Sent): Event => {
  const v = new DataView(new Uint8Array(bytes).buffer);
  return { type: v.getUint8(0), down: v.getUint8(1), button: v.getUint8(2), x: v.getUint16(8), y: v.getUint16(10), keysym: v.getUint32(12) };
};
const sent = async (page: Page): Promise<Event[]> => (await page.evaluate(() => (window as unknown as Mock).__maDeskMock.input)).map(decode);
const clear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as Mock).__maDeskMock.input.length = 0;
    (window as unknown as Mock).__maDeskMock.rpc.length = 0;
  });
/** The keys the desk got, as the keysyms of each press (down events). */
const pressed = async (page: Page): Promise<number[]> => (await sent(page)).filter((e) => e.type === KEY && e.down === 1).map((e) => e.keysym);
const keyEvents = async (page: Page): Promise<[number, number][]> => (await sent(page)).filter((e) => e.type === KEY).map((e) => [e.down, e.keysym]);
const inserts = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as Mock).__maDeskMock.rpc.filter((r) => r.m === 'browser.text.insert').map((r) => r.p['text'] as string));
const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as Mock).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

const video = (page: Page): Locator => page.getByTestId('browser-video');
const keys = (page: Page): Locator => page.getByTestId('browser-keys');
const pageRow = (page: Page): Locator => page.getByRole('toolbar', { name: 'Page controls' });
const keyRow = (page: Page): Locator => page.getByRole('toolbar', { name: 'Keys for the page' });
const slide = (page: Page): Locator => page.locator('.carousel-slide:not(.leaving)');

async function press(page: Page, l: Locator): Promise<void> {
  const b = (await l.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
}

/** What a phone keyboard does to `keys`: its whole value now, and the `input` event that says so. */
async function typeAs(page: Page, value: string, inputType = 'insertText'): Promise<void> {
  await keys(page).evaluate(
    (el: HTMLTextAreaElement, a) => {
      el.value = a.value;
      el.setSelectionRange(a.value.length, a.value.length);
      el.dispatchEvent(new InputEvent('input', { inputType: a.inputType, bubbles: true }));
    },
    { value, inputType },
  );
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

async function openBrowser(page: Page, request: APIRequestContext, theme: ThemeId, phoneView = false): Promise<CDPSession> {
  await setTheme(page, theme);
  await harness(request, { fleet });
  await signIn(page);
  await canvasPainted(page);
  if (phoneView)
    await page.evaluate(() => {
      (window as unknown as Mock).__maDeskMock.phoneView = true;
    });
  await focusCanvas(page);
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __maDesk: { camera: { isMoving(): boolean } } }).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(250);
  await press(page, page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }));
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, \d of \d$/);
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await page.waitForTimeout(400);
  await clear(page);
  return page.context().newCDPSession(page);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('a phone held upright', () => {
  // A phone's screen is its own size: Playwright's stays a desktop's unless it's said.
  test.use({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const theme of THEMES) {
    test(`${theme}: Keyboard raises it; typing goes as the run; Enter, sticky Ctrl, the arrows and Hide`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await openBrowser(page, request, theme);
      // A deskd before the phone view: no Desktop site, and the picture is the desk's.
      await expect(pageRow(page).getByRole('button', { name: 'Desktop site' })).toHaveCount(0);
      await expect(video(page)).not.toHaveAttribute('data-view', 'phone');

      // Keyboard, in the tap: the keys take the focus, with nothing corrected or learned before the field signal.
      await press(page, pageRow(page).getByRole('button', { name: 'Keyboard' }));
      await expect(keys(page)).toBeFocused();
      expect(await keys(page).evaluate((el: HTMLTextAreaElement) => [el.getAttribute('inputmode'), el.getAttribute('autocorrect'), el.spellcheck, el.getAttribute('autocapitalize'), el.getAttribute('autocomplete'), el.value])).toEqual(['text', 'off', false, 'off', 'off', GUARD]);
      await expect(keyRow(page)).toBeVisible();
      await expect(pageRow(page)).toHaveCount(0);
      for (const name of ['Esc', 'Tab', 'Ctrl', 'Left', 'Right', 'Up', 'Down', 'Page up', 'Delete', 'Hide the keyboard']) await expect(keyRow(page).getByRole('button', { name, exact: true })).toHaveCount(1);
      await expect(keyRow(page).getByRole('button', { name: 'Paste', exact: true })).toHaveCount(1); // `browser.touchpaste.shell.spec.ts` has what it reads
      // The page gets the screen: the head, the tabs and the bar step aside.
      await expect(page.locator('.br-bar')).toBeHidden();
      await expect(page.locator('.br-tabs')).toBeHidden();
      expect(await axe(page, ['.br-keyrow'])).toEqual([]);
      if (SHOTS) {
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${SHOTS}/keyboard-${theme}.png` });
      }

      // Letters as they come; autocorrect fixes the word before; a prediction finishes one.
      await typeAs(page, `${GUARD}h`);
      await typeAs(page, `${GUARD}hi`);
      expect(await pressed(page)).toEqual([0x68, 0x69]);
      await clear(page);
      await typeAs(page, `${GUARD}hi teh `);
      await clear(page);
      await typeAs(page, `${GUARD}hi the `, 'insertReplacementText');
      expect(await pressed(page)).toEqual([K.Left, K.BackSpace, K.BackSpace, 0x68, 0x65, K.Right]);
      // Every press has its release.
      expect((await keyEvents(page)).filter(([d]) => d === 0).length).toBe(6);
      // Backspace at the run's start still deletes, and the guard comes back.
      await clear(page);
      await typeAs(page, GUARD);
      await typeAs(page, '', 'deleteContentBackward');
      expect(await pressed(page)).toEqual(Array(8).fill(K.BackSpace));
      expect(await keys(page).inputValue()).toBe(GUARD);

      // Dictation: a sentence at once goes by browser.text.insert.
      await clear(page);
      const said = 'Thanks so much, I will be there at noon on Thursday.';
      await typeAs(page, GUARD + said);
      await expect.poll(() => inserts(page)).toEqual([said]);
      expect(await pressed(page)).toEqual([]);

      // Enter is Return and a new run; the newline never stays.
      await clear(page);
      const enter = await keys(page).evaluate((el) => !el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertLineBreak', cancelable: true, bubbles: true })));
      expect(enter).toBe(true); // prevented
      expect(await pressed(page)).toEqual([K.Return]);
      expect(await keys(page).inputValue()).toBe(GUARD);

      // Ctrl sticks for one key, from the phone's keyboard too, and never enters the run; two quick taps lock it.
      await clear(page);
      const ctrl = keyRow(page).getByRole('button', { name: 'Ctrl' });
      await press(page, ctrl);
      await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
      await expect(keys(page)).toBeFocused(); // a key never takes the focus
      await typeAs(page, `${GUARD}a`);
      expect(await keyEvents(page)).toEqual([[1, K.Control], [1, 0x61], [0, 0x61], [0, K.Control]]);
      await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
      expect(await keys(page).inputValue()).toBe(GUARD);
      await press(page, ctrl);
      await press(page, ctrl);
      await expect(ctrl).toHaveClass(/locked/);
      await clear(page);
      await press(page, keyRow(page).getByRole('button', { name: 'Left', exact: true }));
      expect(await keyEvents(page)).toEqual([[1, K.Control], [1, K.Left], [0, K.Left], [0, K.Control]]);
      await press(page, ctrl);
      await expect(ctrl).toHaveAttribute('aria-pressed', 'false');

      // The key row scrolls sideways itself: a swipe along it is never the carousel's.
      const kr = (await keyRow(page).boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: kr.y + 26 }] });
      for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300 - 30 * i, y: kr.y + 26 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(400);
      await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, /);

      // Hide: the keys let go, and the page row is back.
      await press(page, keyRow(page).getByRole('button', { name: 'Hide the keyboard' }));
      await expect(keys(page)).not.toBeFocused();
      await expect(pageRow(page)).toBeVisible();
      await expect(page.locator('.br-bar')).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("a deskd with the phone view: the device, only the region, a finger as it is, the field's keyboard, and Desktop site", async ({ page, request }) => {
    const errors = watchConsole(page);
    const cdp = await openBrowser(page, request, 'light', true);
    // The box the picture fills goes as the device, and the desk lays the page out for it.
    const surface = (await page.locator('.br-surface').boundingBox())!;
    await expect.poll(() => page.evaluate(() => (window as unknown as Mock).__maDeskMock.deviceLog.filter((d) => d.device).at(-1)?.device ?? null)).toEqual({ kind: 'phone', width: Math.round(surface.width), height: Math.round(surface.height) });
    await expect(video(page)).toHaveAttribute('data-view', 'phone');
    const v = (await page.evaluate((d) => (window as unknown as Mock).__maDeskMock.view[d], DESK))!;
    // Only the region shows, filling the box: the element is the whole picture, larger than the box, at its corner.
    const el = (await video(page).boundingBox())!;
    expect(el.x).toBeCloseTo(surface.x, 0);
    expect(el.y).toBeCloseTo(surface.y, 0);
    expect(el.width).toBeGreaterThan(surface.width * 1.5);
    // A tap: BUTTON 1 at its place in the region, normalized to the whole picture, as deskd asks. Never WHEEL.
    await clear(page);
    const k = Math.min(surface.width / v.region!.width, surface.height / v.region!.height);
    const at = { x: surface.x + v.region!.width * k * 0.5, y: surface.y + v.region!.height * k * 0.25 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await sent(page)).filter((e) => e.type === BUTTON).length).toBe(2);
    const tap = (await sent(page)).filter((e) => e.type === BUTTON);
    expect(tap.map((e) => [e.down, e.button])).toEqual([[1, 1], [0, 1]]);
    expect(Math.abs(tap[0]!.x - (65535 * (v.region!.x + 0.5 * v.region!.width)) / v.screen!.width)).toBeLessThan(65535 * 0.003);
    expect(Math.abs(tap[0]!.y - (65535 * (v.region!.y + 0.25 * v.region!.height)) / v.screen!.height)).toBeLessThan(65535 * 0.003);
    // A drag is the press following the finger: the page scrolls itself.
    await page.waitForTimeout(400);
    await clear(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y + 150 }] });
    for (let i = 1; i <= 5; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y + 150 - 20 * i }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await sent(page)).filter((e) => e.type === BUTTON).length).toBe(2);
    const drag = await sent(page);
    expect(drag.some((e) => e.type === WHEEL)).toBe(false);
    expect(drag.filter((e) => e.type === MOVE).length).toBeGreaterThan(1);
    // The hint speaks of a phone's page.
    await expect(page.getByTestId('browser-touch-hint')).toContainText('Tap and scroll as on any site. Pinch to zoom.');
    if (SHOTS) {
      await page.getByTestId('browser-touch-hint').getByRole('button', { name: 'Got it' }).click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${SHOTS}/phone-view-light.png` });
    }

    // A field takes focus in the page: the keyboard comes up for it (not on iOS), and goes with it.
    await page.evaluate((d) => (window as unknown as Mock).__maDeskMock.setField(d, { tabId: 't1', kind: 'email_address', enterKey: 'next', box: { x: 100, y: 200, width: 9000, height: 2000 } }), DESK);
    await expect(keys(page)).toBeFocused();
    expect(await keys(page).evaluate((e) => [e.getAttribute('inputmode'), e.getAttribute('enterkeyhint'), e.getAttribute('autocorrect')])).toEqual(['email', 'next', 'off']);
    await expect(keyRow(page)).toBeVisible();
    await page.evaluate((d) => (window as unknown as Mock).__maDeskMock.setField(d, null), DESK);
    await expect(keys(page)).not.toBeFocused();
    await expect(pageRow(page)).toBeVisible();
    // As a member does: a tap on the page is what takes a field's focus. (Chromium's emulation drops the click of the first
    // tap after a field's keyboard goes, and the page's input is pointer events, so this tap still reaches the page.)
    await clear(page);
    await page.touchscreen.tap(at.x, at.y + 60);
    await expect.poll(async () => (await sent(page)).filter((e) => e.type === BUTTON).length).toBe(2);
    await page.waitForTimeout(400);

    // Desktop site: the device goes, and the desk's own view comes back.
    const desktop = pageRow(page).getByRole('button', { name: 'Desktop site' });
    await expect(desktop).toHaveAttribute('aria-pressed', 'false');
    await press(page, desktop);
    await expect(desktop).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (window as unknown as Mock).__maDeskMock.deviceLog.at(-1)?.device ?? null)).toBeNull();
    await expect(video(page)).toHaveAttribute('data-view', 'desk');
    expect(await axe(page, ['.br-row'])).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('a desktop watching', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("another session's phone has the page: the bar says so, and how to have it back", async ({ page, request }) => {
    await harness(request, { fleet });
    await signIn(page);
    await canvasPainted(page);
    await page.evaluate(() => {
      (window as unknown as Mock).__maDeskMock.phoneView = true;
    });
    await focusCanvas(page);
    await page.keyboard.press('1');
    await page.waitForTimeout(800);
    await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
    // A desktop sends no device.
    expect(await page.evaluate(() => (window as unknown as Mock).__maDeskMock.deviceLog.some((d) => d.device))).toBe(false);
    await page.evaluate(
      (d) =>
        (window as unknown as Mock).__maDeskMock.setView(d, { mode: 'phone', sessionId: 'cs-someone-else', width: 390, height: 537, scale: 1.34, region: { x: 0, y: 0, width: 523, height: 720 }, screen: { width: 1280, height: 720 }, field: null }),
      DESK,
    );
    await expect(page.getByTestId('browser-notice')).toHaveText('Your phone has this page. Click it to bring it back here.');
    await expect(video(page)).not.toHaveAttribute('data-view', 'phone');
  });
});
