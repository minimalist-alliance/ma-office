// Real input events on the Browser window, read back as the bytes they'd put on channels 6 and 7. With the mock
// link, whose input uses the real encoder. `browser.rtc.spec.ts` sends them to a real desk-rtc.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

interface Sent {
  channel: 'input' | 'keys';
  bytes: number[];
}

interface Control {
  input: Sent[];
  inputBuffered: boolean;
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  sendCursor(bytes: number[]): void;
}

interface Event {
  channel: string;
  type: number;
  down: number;
  button: number;
  seq: number;
  x: number;
  y: number;
  keysym: number;
  dx: number;
  dy: number;
}

const decode = ({ channel, bytes }: Sent): Event => {
  const v = new DataView(new Uint8Array(bytes).buffer);
  return { channel, type: v.getUint8(0), down: v.getUint8(1), button: v.getUint8(2), seq: v.getUint32(4), x: v.getUint16(8), y: v.getUint16(10), keysym: v.getUint32(12), dx: v.getInt16(12), dy: v.getInt16(14) };
};

const MOVE = 1;
const BUTTON = 2;
const WHEEL = 3;
const KEY = 4;
const RELEASE_ALL = 5;

const sent = async (page: Page): Promise<Event[]> => (await page.evaluate(() => (window as unknown as { __maDeskMock: Control }).__maDeskMock.input)).map(decode);
const clear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __maDeskMock: Control }).__maDeskMock.input.length = 0;
  });
const inserts = (page: Page): Promise<{ p: Record<string, unknown>; idem: string | undefined }[]> =>
  page.evaluate(() => (window as unknown as { __maDeskMock: Control }).__maDeskMock.rpc.filter((r) => r.m === 'browser.text.insert').map((r) => ({ p: r.p, idem: r.options?.idem })));

const video = (page: Page) => page.getByTestId('browser-video');
const keysEl = (page: Page) => page.getByTestId('browser-keys');

async function open(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await page.waitForTimeout(300); // the FLIP
}

async function videoBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await video(page).boundingBox()) as { x: number; y: number; width: number; height: number };
}

/** Where the picture really is in the element, by its size right now. */
async function pictureBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await videoBox(page);
  const [w, h] = await video(page).evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight] as const);
  const scale = Math.min(b.width / w, b.height / h);
  const width = w * scale;
  const height = h * scale;
  return { x: b.x + (b.width - width) / 2, y: b.y + (b.height - height) / 2, width, height };
}

async function focusStream(page: Page): Promise<void> {
  const b = await videoBox(page);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(keysEl(page)).toBeFocused();
  await clear(page);
}

test.beforeEach(async ({ request, page }) => {
  await harness(request, { reset: true });
  await open(page);
});

test('a click is BUTTON down then up, on keys, at its place in the picture, not the element', async ({ page }) => {
  const errors = watchConsole(page);
  const pic = await pictureBox(page);
  await clear(page);
  await page.mouse.click(pic.x + pic.width / 4, pic.y + pic.height / 2);
  const buttons = (await sent(page)).filter((e) => e.type === BUTTON);
  expect(buttons.map((e) => [e.channel, e.down, e.button])).toEqual([['keys', 1, 1], ['keys', 0, 1]]);
  expect(buttons[0]?.x).toBeGreaterThan(65535 * 0.24);
  expect(buttons[0]?.x).toBeLessThan(65535 * 0.26);
  expect(buttons[0]?.y).toBeGreaterThan(65535 * 0.49);
  expect(buttons[0]?.y).toBeLessThan(65535 * 0.51);
  expect(errors).toEqual([]);
});

test('coordinates exclude the letterbox bars and clamp on them', async ({ page }) => {
  await page.getByRole('button', { name: 'Restore window' }).click();
  await page.waitForTimeout(100);
  // Make the window tall and narrow, so the bars are above and below.
  const box = await videoBox(page);
  const handle = page.locator('.window-edge.e');
  const edge = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.move(edge.x + 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, edge.y + edge.height / 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const b = await videoBox(page);
  const pic = await pictureBox(page);
  expect(pic.y).toBeGreaterThan(b.y + 20); // there really are bars
  await clear(page);
  await page.mouse.click(b.x + b.width / 2, b.y + 8); // on the top bar
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 8); // on the bottom bar, above the resize edge
  await page.mouse.click(b.x + b.width / 2, pic.y + pic.height / 2); // the middle of the picture
  const downs = (await sent(page)).filter((e) => e.type === BUTTON && e.down === 1);
  expect(downs[0]?.y).toBe(0);
  expect(downs[1]?.y).toBe(65535);
  expect(downs[2]?.y).toBeGreaterThan(65535 * 0.49);
  expect(downs[2]?.y).toBeLessThan(65535 * 0.51);
});

test('a 1280x800 picture, from a smaller desk: coordinates follow it, and it can change with no signaling', async ({ page }) => {
  const clickQuarter = async (): Promise<Event | undefined> => {
    const pic = await pictureBox(page);
    await clear(page);
    await page.mouse.click(pic.x + pic.width / 4, pic.y + pic.height / 2);
    return (await sent(page)).find((e) => e.type === BUTTON && e.down === 1);
  };
  const size = (): Promise<number[]> => video(page).evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]);
  await page.evaluate(() => {
    (window as unknown as { __maDeskMock: { picture: { width: number; height: number } } }).__maDeskMock.picture = { width: 1280, height: 800 };
  });
  await expect.poll(size).toEqual([1280, 800]);
  const at800 = await clickQuarter();
  expect(at800?.x).toBeGreaterThan(65535 * 0.24);
  expect(at800?.x).toBeLessThan(65535 * 0.26);
  expect(at800?.y).toBeGreaterThan(65535 * 0.49);
  expect(at800?.y).toBeLessThan(65535 * 0.51);

  // The picture's left edge moved in this element, so the old box would now be wrong.
  const before = await pictureBox(page);
  await page.evaluate(() => {
    (window as unknown as { __maDeskMock: { picture: { width: number; height: number } } }).__maDeskMock.picture = { width: 800, height: 800 };
  });
  await expect.poll(size).toEqual([800, 800]);
  const after = await pictureBox(page);
  expect(after.x).toBeGreaterThan(before.x + 20);
  const square = await clickQuarter();
  expect(square?.x).toBeGreaterThan(65535 * 0.24);
  expect(square?.x).toBeLessThan(65535 * 0.26);
});

test('an up outside the picture still arrives, by pointer capture', async ({ page }) => {
  const pic = await pictureBox(page);
  await clear(page);
  await page.mouse.move(pic.x + 50, pic.y + 50);
  await page.mouse.down();
  await page.mouse.move(pic.x - 200, pic.y - 200, { steps: 2 });
  await page.mouse.up();
  const buttons = (await sent(page)).filter((e) => e.type === BUTTON);
  expect(buttons.map((e) => e.down)).toEqual([1, 0]);
  expect(buttons[1]?.x).toBe(0); // clamped
});

test('right, middle: the right X buttons, no menu and no autoscroll on this page', async ({ page }) => {
  const pic = await pictureBox(page);
  await page.evaluate(() => {
    const w = window as unknown as { __prevented: Record<string, boolean> };
    w.__prevented = {};
    for (const t of ['contextmenu', 'mousedown', 'auxclick']) {
      window.addEventListener(t, (e) => {
        w.__prevented[`${t}:${(e as MouseEvent).button}`] = e.defaultPrevented;
      });
    }
  });
  await clear(page);
  await page.mouse.click(pic.x + 100, pic.y + 100, { button: 'right' });
  await page.mouse.click(pic.x + 100, pic.y + 100, { button: 'middle' });
  const downs = (await sent(page)).filter((e) => e.type === BUTTON && e.down === 1);
  expect(downs.map((e) => e.button)).toEqual([3, 2]);
  const prevented = await page.evaluate(() => (window as unknown as { __prevented: Record<string, boolean> }).__prevented);
  expect(prevented['contextmenu:2']).toBe(true);
  expect(prevented['mousedown:1']).toBe(true);
  expect(prevented['auxclick:1']).toBe(true);
});

test('back and forward buttons are 8 and 9, and the outer page stays where it is', async ({ page }) => {
  const pic = await pictureBox(page);
  const url = page.url();
  const cdp = await page.context().newCDPSession(page);
  await clear(page);
  const click = async (button: 'back' | 'forward', buttons: number): Promise<void> => {
    const at = { x: pic.x + 100, y: pic.y + 100, button, clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 });
  };
  await click('back', 8);
  await click('forward', 16);
  const buttons = (await sent(page)).filter((e) => e.type === BUTTON);
  expect(buttons.map((e) => [e.down, e.button])).toEqual([[1, 8], [0, 8], [1, 9], [0, 9]]);
  await page.waitForTimeout(200);
  expect(page.url()).toBe(url);
});

test('a chord: a second button while the first is down, which pointerdown never reports', async ({ page }) => {
  const pic = await pictureBox(page);
  await clear(page);
  await page.mouse.move(pic.x + 50, pic.y + 50);
  await page.mouse.down();
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.mouse.up();
  const buttons = (await sent(page)).filter((e) => e.type === BUTTON);
  expect(buttons.map((e) => [e.down, e.button])).toEqual([[1, 1], [1, 3], [0, 3], [0, 1]]);
});

test('a drag that starts outside and enters the picture presses nothing there', async ({ page }) => {
  const pic = await pictureBox(page);
  const head = (await page.locator('.window-head').boundingBox()) as { x: number; y: number; width: number; height: number };
  await clear(page);
  await page.mouse.move(head.x + 300, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(pic.x + 100, pic.y + 100, { steps: 3 });
  await page.waitForTimeout(50);
  await page.mouse.up();
  expect((await sent(page)).filter((e) => e.type === BUTTON)).toEqual([]);
});

test('MOVE goes on input, at most once per display frame, with no React and no DOM write', async ({ page }) => {
  const pic = await pictureBox(page);
  await clear(page);
  // Many moves in one task: one display frame's worth.
  const result = await video(page).evaluate(async (v: HTMLVideoElement, at) => {
    const seen = new MutationObserver(() => {});
    seen.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    for (let i = 0; i < 50; i += 1) v.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: at.x + i, clientY: at.y, bubbles: true }));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const writes = seen.takeRecords().length;
    seen.disconnect();
    return { writes };
  }, { x: pic.x + 10, y: pic.y + 10 });
  const moves = (await sent(page)).filter((e) => e.type === MOVE);
  expect(moves).toHaveLength(1);
  expect(moves[0]?.channel).toBe('input');
  expect(moves[0]?.x).toBeGreaterThan(0);
  expect(result.writes).toBe(0);
});

test('a MOVE with input buffered is dropped, not queued, and the newest goes when it clears', async ({ page }) => {
  const pic = await pictureBox(page);
  await clear(page);
  await page.evaluate(() => {
    (window as unknown as { __maDeskMock: Control }).__maDeskMock.inputBuffered = true;
  });
  await page.mouse.move(pic.x + 10, pic.y + 10);
  await page.mouse.move(pic.x + 20, pic.y + 10);
  await page.waitForTimeout(100);
  expect((await sent(page)).filter((e) => e.type === MOVE)).toHaveLength(0);
  await page.evaluate(() => {
    (window as unknown as { __maDeskMock: Control }).__maDeskMock.inputBuffered = false;
  });
  await page.waitForTimeout(100);
  const moves = (await sent(page)).filter((e) => e.type === MOVE);
  expect(moves).toHaveLength(1);
  expect(moves[0]?.x).toBeCloseTo((65535 * 20) / pic.width, -2);
});

test('WHEEL: non-passive, prevented, coalesced per frame, with its position', async ({ page }) => {
  const pic = await pictureBox(page);
  await page.evaluate(() => {
    const w = window as unknown as { __wheel: boolean[] };
    w.__wheel = [];
    window.addEventListener('wheel', (e) => w.__wheel.push(e.defaultPrevented));
  });
  await page.mouse.move(pic.x + pic.width / 2, pic.y + pic.height / 2);
  await clear(page);
  await video(page).evaluate((v: HTMLVideoElement, at) => {
    for (let i = 0; i < 5; i += 1) v.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, deltaX: 1, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    v.dispatchEvent(new WheelEvent('wheel', { deltaY: 2, deltaMode: 1, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
  }, { x: pic.x + pic.width / 2, y: pic.y + pic.height / 2 });
  await page.waitForTimeout(100);
  const wheels = (await sent(page)).filter((e) => e.type === WHEEL);
  expect(wheels).toHaveLength(1);
  expect(wheels[0]?.channel).toBe('keys');
  expect(wheels[0]?.dx).toBe(5);
  expect(wheels[0]?.dy).toBe(5 * 10 + 2 * 16);
  expect(wheels[0]?.x).toBeGreaterThan(65535 * 0.49);
  const prevented = await page.evaluate(() => (window as unknown as { __wheel: boolean[] }).__wheel);
  expect(prevented.every(Boolean)).toBe(true);
});

test('a real wheel over the picture scrolls the page there, and never the camera here', async ({ page }) => {
  const pic = await pictureBox(page);
  const zoom = (): Promise<string | null> => page.getByRole('group', { name: 'Zoom' }).locator('span').first().textContent();
  const before = await zoom();
  await page.mouse.move(pic.x + 100, pic.y + 100);
  await clear(page);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(100);
  expect((await sent(page)).filter((e) => e.type === WHEEL).reduce((n, e) => n + e.dy, 0)).toBe(120);
  expect(await zoom()).toBe(before);
});

test('keys: down and up by keysym, on keys, with every repeat', async ({ page }) => {
  const errors = watchConsole(page);
  await focusStream(page);
  await page.keyboard.press('a');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('F5');
  const keys = (await sent(page)).filter((e) => e.type === KEY);
  expect(keys.every((e) => e.channel === 'keys')).toBe(true);
  expect(keys.map((e) => [e.down, e.keysym])).toEqual([
    [1, 0x61], [0, 0x61], [1, 0xff0d], [0, 0xff0d], [1, 0xff51], [0, 0xff51], [1, 0xffc2], [0, 0xffc2],
  ]);
  await clear(page);
  await page.keyboard.down('b');
  await page.keyboard.down('b'); // auto-repeat
  await page.keyboard.down('b');
  await page.keyboard.up('b');
  expect((await sent(page)).filter((e) => e.type === KEY).map((e) => e.down)).toEqual([1, 1, 1, 0]);
  expect(errors).toEqual([]);
});

test('keyup sends what keydown sent, even if Shift changed in between; right-hand modifiers from code', async ({ page }) => {
  await focusStream(page);
  await page.keyboard.down('a');
  await page.keyboard.down('Shift');
  await page.keyboard.up('a');
  await page.keyboard.up('Shift');
  const keys = (await sent(page)).filter((e) => e.type === KEY);
  expect(keys.map((e) => [e.down, e.keysym])).toEqual([[1, 0x61], [1, 0xffe1], [0, 0x61], [0, 0xffe1]]);
  await clear(page);
  await page.keyboard.press('ShiftRight');
  await page.keyboard.press('ControlRight');
  await page.keyboard.press('AltRight');
  const right = (await sent(page)).filter((e) => e.type === KEY && e.down === 1);
  expect(right.map((e) => e.keysym)).toEqual([0xffe2, 0xffe4, 0xffea]);
});

test('astral characters and CapsLock, Dead, Process and Unidentified', async ({ page }) => {
  await focusStream(page);
  await keysEl(page).evaluate((el) => {
    const fire = (key: string, code: string): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }));
    };
    fire('😀', '');
    for (const key of ['CapsLock', 'NumLock', 'Dead', 'Process', 'Unidentified']) fire(key, 'KeyQ');
    fire('€', 'KeyE');
  });
  const keys = (await sent(page)).filter((e) => e.type === KEY);
  expect(keys.map((e) => [e.down, e.keysym])).toEqual([[1, 0x0101f600], [0, 0x0101f600], [1, 0x010020ac], [0, 0x010020ac]]);
});

test('keys go to the stream only with its focus: nothing before a click, nothing from the window head', async ({ page }) => {
  await clear(page);
  await page.keyboard.press('a');
  expect(await sent(page)).toEqual([]);
  await focusStream(page);
  await page.locator('.window-title').click();
  await expect(keysEl(page)).not.toBeFocused();
  await clear(page);
  await page.keyboard.press('a');
  expect((await sent(page)).filter((e) => e.type === KEY)).toEqual([]);
});

test('Esc and Tab belong to the page, and Shift+Esc always leaves', async ({ page }) => {
  await focusStream(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const keys = (await sent(page)).filter((e) => e.type === KEY && e.down === 1).map((e) => e.keysym);
  expect(keys).toEqual([0xff1b, 0xff09, 0xffe1, 0xff09]);
  await expect(keysEl(page)).toBeFocused();
  await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
  await page.keyboard.press('Shift+Escape');
  await expect(page.getByRole('dialog', { name: /Browser/ })).toHaveCount(0);
});

test('shell shortcuts do not fire from inside the stream', async ({ page }) => {
  const zoom = (): Promise<string | null> => page.getByRole('group', { name: 'Zoom' }).locator('span').first().textContent();
  const before = await zoom();
  await focusStream(page);
  for (const key of ['=', '-', '0', '\\', '[', ']', '1']) await page.keyboard.press(key);
  expect(await zoom()).toBe(before);
  await expect(page.getByRole('button', { name: 'Privacy shield' })).toHaveAttribute('aria-pressed', 'false');
  expect((await sent(page)).filter((e) => e.type === KEY && e.down === 1)).toHaveLength(7);
});

test.describe('keys the member\'s own browser keeps', () => {
  for (const [name, combo] of [['Ctrl+W', 'Control+w'], ['Ctrl+T', 'Control+t'], ['Ctrl+N', 'Control+n'], ['Ctrl+Tab', 'Control+Tab'], ['F11', 'F11'], ['F12', 'F12']] as const) {
    test(`${name} is not sent, and not prevented`, async ({ page }) => {
      await focusStream(page);
      await keysEl(page).evaluate((el) => {
        const w = window as unknown as { __prevented: boolean[] };
        w.__prevented = [];
        el.addEventListener('keydown', (e) => setTimeout(() => w.__prevented.push(e.defaultPrevented)));
      });
      await page.keyboard.press(combo);
      await page.waitForTimeout(50);
      const keys = (await sent(page)).filter((e) => e.type === KEY && e.down === 1).map((e) => e.keysym);
      expect(keys.filter((k) => k !== 0xffe3)).toEqual([]); // only the Control itself, if anything
      expect(await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented.at(-1))).toBe(false);
    });
  }
});

test('RELEASE_ALL on window blur and when the tab is hidden', async ({ page }) => {
  await focusStream(page);
  await page.keyboard.down('a');
  await clear(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect((await sent(page)).map((e) => e.type)).toEqual([RELEASE_ALL]);
  await clear(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect((await sent(page)).map((e) => e.type)).toEqual([RELEASE_ALL]);
});

test('focus leaving the stream releases what it held', async ({ page }) => {
  await focusStream(page);
  await page.keyboard.down('a');
  await clear(page);
  await page.locator('.window-title').click();
  expect((await sent(page)).filter((e) => e.type === RELEASE_ALL)).toHaveLength(1);
  await page.keyboard.up('a');
  expect((await sent(page)).filter((e) => e.type === KEY)).toEqual([]);
});

test('one seq across both channels, starting at 1', async ({ page }) => {
  const seqs = (await sent(page)).map((e) => e.seq);
  const pic = await pictureBox(page);
  await page.mouse.move(pic.x + 10, pic.y + 10);
  await page.waitForTimeout(50);
  await page.mouse.click(pic.x + 30, pic.y + 10);
  await page.keyboard.press('a');
  await page.mouse.move(pic.x + 40, pic.y + 10);
  await page.waitForTimeout(50);
  const all = await sent(page);
  expect(all[0]?.seq).toBe(seqs[0] ?? 1);
  expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  expect(new Set(all.map((e) => e.channel))).toEqual(new Set(['input', 'keys']));
});

test('a composed word goes through browser.text.insert, with an idem, and no KEY', async ({ page }) => {
  await focusStream(page);
  await keysEl(page).evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyN', isComposing: true, bubbles: true, cancelable: true }));
    el.value = 'こんにちは';
    el.dispatchEvent(new CompositionEvent('compositionend', { data: 'こんにちは', bubbles: true }));
  });
  await expect.poll(() => inserts(page)).toHaveLength(1);
  const [first] = await inserts(page);
  expect(first?.p).toEqual({ text: 'こんにちは' });
  expect(first?.idem).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect((await sent(page)).filter((e) => e.type === KEY)).toEqual([]);
  expect(await keysEl(page).inputValue()).toBe('');
});

test('Ctrl+V itself is not sent: the paste event brings the text, and the key follows (browser.clipboard.shell.spec.ts)', async ({ page }) => {
  await focusStream(page);
  // Whatever this browser's clipboard holds by now, its write gets no answer here, so what's left to see is the key on its own.
  await page.evaluate(() => {
    (window as unknown as { __maDeskMock: { hold: Record<string, boolean> } }).__maDeskMock.hold['browser.clipboard.write'] = true;
  });
  await page.keyboard.down('Control');
  await clear(page);
  await page.keyboard.down('v');
  await page.keyboard.up('v');
  await page.waitForTimeout(50);
  expect((await sent(page)).filter((e) => e.type === KEY)).toEqual([]);
  await page.keyboard.up('Control');
  expect(await keysEl(page).inputValue()).toBe('');
});

test('text that comes with no key at all, as from an emoji picker, goes the same way', async ({ page }) => {
  await focusStream(page);
  await keysEl(page).evaluate((el: HTMLTextAreaElement) => {
    el.value = '👍';
    el.dispatchEvent(new InputEvent('input', { data: '👍', inputType: 'insertText', bubbles: true }));
  });
  await expect.poll(() => inserts(page)).toHaveLength(1);
  expect((await inserts(page))[0]?.p).toEqual({ text: '👍' });
  expect(await keysEl(page).inputValue()).toBe('');
});

test("a finger is touch control's (`browser.touch.shell.spec.ts`): a tap clicks where it landed, and never takes the keys", async ({ page }) => {
  const pic = await pictureBox(page);
  await clear(page);
  await video(page).evaluate((v: HTMLVideoElement, at) => {
    v.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: at.x, clientY: at.y, buttons: 1, bubbles: true }));
    v.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: at.x + 5, clientY: at.y, buttons: 1, bubbles: true }));
    v.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: at.x + 5, clientY: at.y, bubbles: true }));
  }, { x: pic.x + pic.width / 4, y: pic.y + pic.height / 2 });
  await page.waitForTimeout(50);
  const events = await sent(page);
  expect(events.map((e) => [e.channel, e.type, e.down, e.button])).toEqual([['input', MOVE, 0, 0], ['keys', BUTTON, 1, 1], ['keys', BUTTON, 0, 1]]);
  expect(events[1]?.x).toBeGreaterThan(65535 * 0.24);
  expect(events[1]?.x).toBeLessThan(65535 * 0.26);
  await expect(keysEl(page)).not.toBeFocused();
});

test.describe('the cursor', () => {
  const message = (hotX: number, hotY: number, w: number, h: number, png: number[] = []): number[] => {
    const b = new Uint8Array(10 + png.length);
    const v = new DataView(b.buffer);
    b[0] = 0x81;
    v.setUint16(2, hotX);
    v.setUint16(4, hotY);
    v.setUint16(6, w);
    v.setUint16(8, h);
    b.set(png, 10);
    return [...b];
  };
  // A real 1x1 PNG, so the browser really loads it, under the harness's CSP.
  const PNG = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64')];
  const cursor = (page: Page, bytes: number[]): Promise<void> =>
    page.evaluate((b) => (window as unknown as { __maDeskMock: Control }).__maDeskMock.sendCursor(b), bytes);

  test('a CURSOR from keys becomes the video\'s cursor, by data: URL, with no CSP complaint', async ({ page }) => {
    const errors = watchConsole(page);
    await cursor(page, message(3, 4, 1, 1, PNG));
    const css = await video(page).evaluate((v: HTMLVideoElement) => v.style.cursor);
    expect(css).toMatch(/^url\("?data:image\/png;base64,[A-Za-z0-9+/=]+"?\) 3 4, auto$/);
    const pic = await pictureBox(page);
    await page.mouse.move(pic.x + 10, pic.y + 10); // the browser loads the image only when it's needed
    await page.waitForTimeout(150);
    expect(errors).toEqual([]);
  });

  test('0 by 0 means no pointer, and a shape that did not fit means auto', async ({ page }) => {
    await cursor(page, message(0, 0, 0, 0));
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.style.cursor)).toBe('none');
    await cursor(page, message(1, 1, 64, 64));
    expect(await video(page).evaluate((v: HTMLVideoElement) => v.style.cursor)).toBe('auto');
  });
});
