// The clipboard, both ways (deskd API.md section 10), with real events, Chromium's real clipboard for the member's
// side, and the mock for the desk's. Text in here is made up. The bar's words are read, and nothing else is.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

interface Control {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string; deadlineMs?: number } }[];
  refuse: Record<string, string>;
  refuseDetails: Record<string, unknown>;
  lostSession: Record<string, boolean>;
  input: { channel: string; bytes: number[] }[];
  deskClipboard: string | null;
  clipboardChanged(text: string | null): void;
  hold: Record<string, boolean>;
  releaseHeld(): void;
}

interface ClipboardSpy {
  write: number;
  writeText: number;
  readText: number;
  /** Chromium's own, for the test to read the member's clipboard with. */
  read(): Promise<string>;
  set(text: string): Promise<void>;
}

type Win = { __maDeskMock: Control; __clip: ClipboardSpy };

const WRITE = 'browser.clipboard.write';
const READ = 'browser.clipboard.read';
const INSERT = 'browser.text.insert';
const TOPIC = 'browser.clipboard';

const CTRL = 0xffe3;
const SHIFT = 0xffe1;
const C = 0x63;
const V = 0x76;
const X = 0x78;
const INS = 0xff63;
const DEL = 0xffff;
const DOWN = 1;
const UP = 0;

const MEMBER_HAD = 'the member had this';

const calls = (page: Page, m: string) => page.evaluate((method) => (window as unknown as Win).__maDeskMock.rpc.filter((r) => r.m === method).map((r) => ({ p: r.p, options: r.options })), m);
const count = async (page: Page, m: string): Promise<number> => (await calls(page, m)).length;
/** The `KEY` events on the wire: [down, keysym]. */
const keyEvents = (page: Page): Promise<[number, number][]> =>
  page.evaluate(() =>
    (window as unknown as Win).__maDeskMock.input
      .filter((e) => e.bytes[0] === 4)
      .map((e): [number, number] => {
        const v = new DataView(new Uint8Array(e.bytes).buffer);
        return [v.getUint8(1), v.getUint32(12)];
      }),
  );
const vPresses = async (page: Page): Promise<number> => (await keyEvents(page)).filter(([down, sym]) => down === DOWN && sym === V).length;
const clearInput = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as Win).__maDeskMock.input.length = 0;
  });
const refuse = (page: Page, m: string, code: string, details: Record<string, unknown> = {}): Promise<void> =>
  page.evaluate(([method, c, d]) => {
    const control = (window as unknown as Win).__maDeskMock;
    control.refuse[method as string] = c as string;
    control.refuseDetails = d as Record<string, unknown>;
  }, [m, code, details] as const);
const allow = (page: Page, m: string): Promise<void> =>
  page.evaluate((method) => {
    delete (window as unknown as Win).__maDeskMock.refuse[method];
  }, m);
const hold = (page: Page, m: string, on = true): Promise<void> =>
  page.evaluate(([method, h]) => {
    (window as unknown as Win).__maDeskMock.hold[method as string] = h as boolean;
  }, [m, on] as const);
const releaseHeld = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as Win).__maDeskMock.releaseHeld());
const deskCopied = (page: Page, text: string | null): Promise<void> => page.evaluate((t) => (window as unknown as Win).__maDeskMock.clipboardChanged(t), text);

const memberClipboard = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as Win).__clip.read());
const setMemberClipboard = (page: Page, text: string): Promise<void> => page.evaluate((t) => (window as unknown as Win).__clip.set(t), text);
const spy = (page: Page): Promise<{ write: number; writeText: number; readText: number }> =>
  page.evaluate(() => {
    const { write, writeText, readText } = (window as unknown as Win).__clip;
    return { write, writeText, readText };
  });

const notice = (page: Page) => page.getByTestId('browser-notice');
const keysEl = (page: Page) => page.getByTestId('browser-keys');
const address = (page: Page) => page.getByTestId('browser-address');

/** Counts what the app asks of the member's clipboard, and keeps Chromium's own for the test. */
async function watchMemberClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const proto = Clipboard.prototype;
    const { write, writeText, readText } = proto;
    const w = window as unknown as Win;
    w.__clip = { write: 0, writeText: 0, readText: 0, read: () => readText.call(navigator.clipboard), set: (t) => writeText.call(navigator.clipboard, t) };
    proto.write = function counted(this: Clipboard, ...a: Parameters<Clipboard['write']>) {
      w.__clip.write += 1;
      return write.apply(this, a);
    };
    proto.writeText = function counted(this: Clipboard, ...a: Parameters<Clipboard['writeText']>) {
      w.__clip.writeText += 1;
      return writeText.apply(this, a);
    };
    proto.readText = function counted(this: Clipboard) {
      w.__clip.readText += 1;
      return readText.call(this);
    };
  });
}

async function openWindow(page: Page, before?: () => Promise<void>): Promise<void> {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await watchMemberClipboard(page);
  await setMemberClipboard(page, MEMBER_HAD);
  await before?.();
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await expect.poll(() => page.getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await page.waitForTimeout(300); // the FLIP
}

/** Focus with no click, as a click is itself a gesture. So a test says exactly what the member did next. */
async function focusStream(page: Page): Promise<void> {
  await keysEl(page).focus();
  await expect(keysEl(page)).toBeFocused();
  await clearInput(page);
}

/** A paste with this text, as the browser fires it. Tests that care about the keys use the real ones. */
const pasteEvent = (page: Page, text: string): Promise<void> =>
  keysEl(page).evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);

test.beforeEach(async ({ request, context }) => {
  await harness(request, { reset: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test.describe('paste', () => {
  test.beforeEach(async ({ page }) => {
    await openWindow(page);
    await focusStream(page);
  });

  test('a real Ctrl+V: the member\'s text, the write, its reply, and only then the key, with no permission asked', async ({ page }) => {
    const errors = watchConsole(page);
    await setMemberClipboard(page, 'pasted text');
    await hold(page, WRITE);
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, WRITE)).toBe(1);
    const [write] = await calls(page, WRITE);
    expect(write?.p).toEqual({ text: 'pasted text' });
    expect(write?.options?.idem).toBeUndefined(); // it isn't a mutation
    await page.waitForTimeout(100);
    // The member's own Control, and no V: it would paste the desk's old clipboard.
    expect(await keyEvents(page)).toEqual([[DOWN, CTRL], [UP, CTRL]]);
    await clearInput(page);
    await releaseHeld(page);
    await expect.poll(() => vPresses(page)).toBe(1);
    // They let go while it was on its way, so the key brings its own Control, in the right order.
    expect(await keyEvents(page)).toEqual([[DOWN, CTRL], [DOWN, V], [UP, V], [UP, CTRL]]);
    expect(await page.evaluate(() => (window as unknown as Win).__maDeskMock.deskClipboard)).toBe('pasted text');
    expect(await count(page, INSERT)).toBe(0);
    expect((await spy(page)).readText).toBe(0);
    expect(errors).toEqual([]);
  });

  test('Control still held when the reply comes: just V, and the member\'s Control stays theirs', async ({ page }) => {
    await page.keyboard.down('Control');
    await clearInput(page);
    await page.keyboard.press('v');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await keyEvents(page)).toEqual([[DOWN, V], [UP, V]]);
    await page.keyboard.up('Control');
    expect((await keyEvents(page)).at(-1)).toEqual([UP, CTRL]);
    expect((await calls(page, WRITE))[0]?.p).toEqual({ text: MEMBER_HAD });
  });

  test('Shift+Insert pastes too, and goes out as Ctrl+V with Shift still down', async ({ page }) => {
    await setMemberClipboard(page, 'by the other key');
    await page.keyboard.down('Shift');
    await clearInput(page);
    await page.keyboard.press('Insert');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await keyEvents(page)).toEqual([[DOWN, CTRL], [DOWN, V], [UP, V], [UP, CTRL]]);
    await page.keyboard.up('Shift');
    expect((await calls(page, WRITE))[0]?.p).toEqual({ text: 'by the other key' });
  });

  for (const [name, code, details, line] of [
    ['over the cap', 'too_large', { limit: 1_000_000 }, "That's too much text to paste at once."],
    ['too much as JSON', 'too_large', {}, "That's too much text to paste at once."],
    ['a token without input', 'forbidden', { reason: 'permission' }, "This session can't control the browser."],
    ['half a surrogate pair', 'bad_request', { reason: 'text' }, "That text didn't reach the page."],
    ['internal', 'internal', {}, "That text didn't reach the page."],
  ] as const) {
    test(`a refusal, ${name}: said in the bar, with no key and no retry`, async ({ page }) => {
      const errors = watchConsole(page);
      await refuse(page, WRITE, code, details);
      await page.keyboard.press('Control+v');
      await expect(notice(page)).toHaveText(line);
      await page.waitForTimeout(100);
      expect(await count(page, WRITE)).toBe(1);
      expect(await vPresses(page)).toBe(0);
      expect(await count(page, INSERT)).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  for (const [name, code, details] of [
    ['`unavailable` with `reason: "clipboard"`', 'unavailable', { reason: 'clipboard' }],
    ['`deadline_exceeded`', 'deadline_exceeded', {}],
    ['`cancelled`', 'cancelled', {}],
  ] as const) {
    test(`${name}: tried again with the same text, then said, with no key`, async ({ page }) => {
      await refuse(page, WRITE, code, details);
      await page.keyboard.press('Control+v');
      await expect(notice(page)).toHaveText("That text didn't reach the page.");
      const tries = await calls(page, WRITE);
      expect(tries).toHaveLength(3);
      expect(new Set(tries.map((t) => t.p['text']))).toEqual(new Set([MEMBER_HAD]));
      expect(await vPresses(page)).toBe(0);
      expect(await count(page, INSERT)).toBe(0);
    });
  }

  test('`display` that clears: one more try, then the key, and nothing goes through the old way', async ({ page }) => {
    await refuse(page, WRITE, 'unavailable', { reason: 'display' });
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, WRITE)).toBe(1);
    await allow(page, WRITE);
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await count(page, WRITE)).toBe(2);
    expect(await count(page, INSERT)).toBe(0);
  });

  test('`display` that keeps coming: a too-old desk-rtc, so browser.text.insert. No key, and the next paste doesn\'t wait', async ({ page }) => {
    await refuse(page, WRITE, 'unavailable', { reason: 'display' });
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, INSERT)).toBe(1);
    expect(await count(page, WRITE)).toBe(3);
    expect(await vPresses(page)).toBe(0);
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, INSERT)).toBe(2);
    expect(await count(page, WRITE)).toBe(4);
    expect(await vPresses(page)).toBe(0);
    await expect(notice(page)).toHaveCount(0);
  });

  for (const [name, inFlight] of [['before it left', false], ['while it was out', true]] as const) {
    test(`the session goes ${name}: said, with no key and no text held, since nothing can have been typed`, async ({ page }) => {
      await page.evaluate(([m, f]) => {
        (window as unknown as Win).__maDeskMock.lostSession[m as string] = f as boolean;
      }, [WRITE, inFlight] as const);
      await page.keyboard.press('Control+v');
      await expect(notice(page)).toHaveText("That text didn't reach the page.");
      expect(await vPresses(page)).toBe(0);
      expect(await count(page, INSERT)).toBe(0);
      await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
    });
  }

  test('`not_found`: exactly today\'s browser.text.insert, with its idem and no key, and no more asking', async ({ page }) => {
    const errors = watchConsole(page);
    await setMemberClipboard(page, 'on an older desk');
    await refuse(page, WRITE, 'not_found');
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, INSERT)).toBe(1);
    const [insert] = await calls(page, INSERT);
    expect(insert?.p).toEqual({ text: 'on an older desk' });
    expect(insert?.options?.idem).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, INSERT)).toBe(2);
    expect(await count(page, WRITE)).toBe(1);
    expect(await vPresses(page)).toBe(0);
    await expect(notice(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the cap: over it nothing is sent, and it says what the desk would. Exactly on it goes', async ({ page }) => {
    const line = "That's too much text to paste at once.";
    await pasteEvent(page, 'a'.repeat(1_000_001));
    await expect(notice(page)).toHaveText(line);
    await page.reload();
    await openWindow(page);
    await focusStream(page);
    await pasteEvent(page, '€'.repeat(333_334)); // 1,000,002 bytes in far fewer chars
    await expect(notice(page)).toHaveText(line);
    await page.reload();
    await openWindow(page);
    await focusStream(page);
    await pasteEvent(page, '\n'.repeat(600_000)); // under the cap, and over a REQ's 1 MiB as JSON
    await expect(notice(page)).toHaveText(line);
    expect(await count(page, WRITE)).toBe(0);
    expect(await vPresses(page)).toBe(0);
    await pasteEvent(page, 'a'.repeat(1_000_000));
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await count(page, WRITE)).toBe(1);
  });

  test('empty, or empty once NUL is gone, does nothing: no write and no key', async ({ page }) => {
    await pasteEvent(page, '\0\0');
    await pasteEvent(page, '');
    await page.waitForTimeout(100);
    expect(await count(page, WRITE)).toBe(0);
    expect(await count(page, INSERT)).toBe(0);
    expect(await keyEvents(page)).toEqual([]);
  });

  test('the paste key held: one at a time behind a slow answer, and then it can go again', async ({ page }) => {
    await hold(page, WRITE);
    await page.keyboard.down('Control');
    await page.keyboard.down('v');
    await page.keyboard.down('v');
    await page.keyboard.down('v');
    await expect.poll(() => count(page, WRITE)).toBe(1);
    await page.waitForTimeout(100);
    expect(await count(page, WRITE)).toBe(1);
    await hold(page, WRITE, false);
    await releaseHeld(page);
    await expect.poll(() => vPresses(page)).toBe(1);
    await page.keyboard.down('v'); // nothing on its way now
    await expect.poll(() => vPresses(page)).toBe(2);
    await page.keyboard.up('v');
    await page.keyboard.up('Control');
    expect(await count(page, WRITE)).toBe(2);
  });

  test('two pastes keep their order: the second write waits for the first key', async ({ page }) => {
    await hold(page, WRITE);
    await pasteEvent(page, 'first');
    await pasteEvent(page, 'second');
    await expect.poll(() => count(page, WRITE)).toBe(1);
    await page.waitForTimeout(50);
    expect((await calls(page, WRITE)).map((c) => c.p['text'])).toEqual(['first']);
    await hold(page, WRITE, false);
    await releaseHeld(page);
    await expect.poll(() => vPresses(page)).toBe(2);
    expect((await calls(page, WRITE)).map((c) => c.p['text'])).toEqual(['first', 'second']);
  });

  test('the window closed on the way: no key', async ({ page }) => {
    await hold(page, WRITE);
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, WRITE)).toBe(1);
    await page.keyboard.press('Shift+Escape');
    await expect(page.getByRole('dialog', { name: /Browser/ })).toHaveCount(0);
    await clearInput(page);
    await releaseHeld(page);
    await page.waitForTimeout(100);
    expect(await vPresses(page)).toBe(0);
  });

  test('typing doesn\'t wait for it, and the address keys and Shift+Esc still work', async ({ page }) => {
    await hold(page, WRITE);
    await page.keyboard.press('Control+v');
    await page.keyboard.press('a');
    expect((await keyEvents(page)).filter(([, sym]) => sym === 0x61)).toEqual([[DOWN, 0x61], [UP, 0x61]]);
    await page.keyboard.press('Control+l');
    await expect(address(page)).toBeFocused();
    await keysEl(page).focus();
    await page.keyboard.press('Shift+Escape');
    await expect(page.getByRole('dialog', { name: /Browser/ })).toHaveCount(0);
  });

  test('composition and an emoji picker stay browser.text.insert', async ({ page }) => {
    await keysEl(page).evaluate((el: HTMLTextAreaElement) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.value = 'こんにちは';
      el.dispatchEvent(new CompositionEvent('compositionend', { data: 'こんにちは', bubbles: true }));
      el.value = '👍';
      el.dispatchEvent(new InputEvent('input', { data: '👍', inputType: 'insertText', bubbles: true }));
    });
    await expect.poll(() => count(page, INSERT)).toBe(2);
    expect(await count(page, WRITE)).toBe(0);
  });
});

test.describe('copy and cut', () => {
  test.beforeEach(async ({ page }) => {
    await openWindow(page);
    await focusStream(page);
  });

  for (const [name, combo, sym, downs] of [
    ['Ctrl+C', 'Control+c', C, [CTRL, C]],
    ['Ctrl+X', 'Control+x', X, [CTRL, X]],
    ['Ctrl+Insert', 'Control+Insert', INS, [CTRL, INS]],
    ['Shift+Delete', 'Shift+Delete', DEL, [SHIFT, DEL]],
  ] as const) {
    test(`${name} goes to the stream as ever, and after \`changed\` and a read the member has the text`, async ({ page }) => {
      const errors = watchConsole(page);
      await page.keyboard.press(combo);
      expect((await keyEvents(page)).filter(([d]) => d === DOWN).map(([, s]) => s)).toEqual(downs);
      expect((await keyEvents(page)).filter(([, s]) => s === sym)).toEqual([[DOWN, sym], [UP, sym]]);
      expect(await count(page, READ)).toBe(0); // not before the desk has it
      await deskCopied(page, 'from the desk\n\twith its newline and tab');
      await expect.poll(() => memberClipboard(page)).toBe('from the desk\n\twith its newline and tab');
      const [read] = await calls(page, READ);
      expect(read?.options?.deadlineMs).toBeGreaterThanOrEqual(3_000);
      expect(read?.options?.idem).toBeUndefined();
      expect(await spy(page)).toMatchObject({ write: 1, writeText: 0, readText: 0 });
      await expect(notice(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test('a held reply to the read: the member\'s clipboard waits for it', async ({ page }) => {
    await hold(page, READ);
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'on its way');
    await expect.poll(() => count(page, READ)).toBe(1);
    await page.waitForTimeout(100);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    await releaseHeld(page);
    await expect.poll(() => memberClipboard(page)).toBe('on its way');
  });

  test('`changed` with no gesture: a page did that by itself. No read, and the member\'s clipboard is untouched', async ({ page }) => {
    await deskCopied(page, 'a page wrote this');
    await page.waitForTimeout(150);
    expect(await count(page, READ)).toBe(0);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    expect((await spy(page)).write).toBe(0);
    await expect(notice(page)).toHaveCount(0);
  });

  test('a gesture with no `changed`, as with nothing selected: nothing is read, nothing touched, nothing said', async ({ page }) => {
    const errors = watchConsole(page);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(2_200);
    expect(await count(page, READ)).toBe(0);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    await expect(notice(page)).toHaveCount(0);
    // Past the 2 s, a `changed` is a page's again.
    await deskCopied(page, 'a page wrote this');
    await page.waitForTimeout(100);
    expect(await count(page, READ)).toBe(0);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    expect(errors).toEqual([]);
  });

  test('one gesture, one copy: a second `changed` straight after is a page\'s', async ({ page }) => {
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'what they copied');
    await expect.poll(() => memberClipboard(page)).toBe('what they copied');
    await deskCopied(page, 'a page wrote this');
    await page.waitForTimeout(100);
    expect(await count(page, READ)).toBe(1);
    expect(await memberClipboard(page)).toBe('what they copied');
  });

  test('null text, such as an image: the member\'s clipboard stays as it was, and nothing is said', async ({ page }) => {
    const errors = watchConsole(page);
    await page.keyboard.press('Control+c');
    await deskCopied(page, null);
    await expect.poll(() => count(page, READ)).toBe(1);
    await page.waitForTimeout(100);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    await expect(notice(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  for (const [name, code, details, line] of [
    ['over the cap', 'too_large', { limit: 1_000_000 }, "That's too much text to copy at once."],
    ['too much as JSON', 'too_large', {}, "That's too much text to copy at once."],
    ['a token without both', 'forbidden', { reason: 'permission' }, "This session can't control the browser."],
    ['a hung holder, three times', 'unavailable', { reason: 'clipboard' }, "That copy didn't reach your clipboard."],
    ['no display, three times', 'unavailable', { reason: 'display' }, "That copy didn't reach your clipboard."],
  ] as const) {
    test(`a read refused, ${name}: said, with nothing touched and never a cut piece`, async ({ page }) => {
      const errors = watchConsole(page);
      await refuse(page, READ, code, details);
      await page.keyboard.press('Control+c');
      await deskCopied(page, 'some text');
      await expect(notice(page)).toHaveText(line);
      expect(await memberClipboard(page)).toBe(MEMBER_HAD);
      expect(errors).toEqual([]);
    });
  }

  test('`reason: "clipboard"` that clears: read again shortly, and it lands', async ({ page }) => {
    await refuse(page, READ, 'unavailable', { reason: 'clipboard' });
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'after a hang');
    await expect.poll(() => count(page, READ)).toBe(1);
    await allow(page, READ);
    await expect.poll(() => memberClipboard(page)).toBe('after a hang');
  });

  test('the key held: every repeat goes to the stream, and it\'s still one gesture', async ({ page }) => {
    await page.keyboard.down('Control');
    await page.keyboard.down('c');
    await page.keyboard.down('c');
    await page.keyboard.down('c');
    expect((await keyEvents(page)).filter(([d, s]) => d === DOWN && s === C)).toHaveLength(3);
    expect((await spy(page)).write).toBe(1);
    await deskCopied(page, 'copied');
    await expect.poll(() => memberClipboard(page)).toBe('copied');
    await deskCopied(page, 'copied again by a repeat');
    await page.waitForTimeout(100);
    expect(await count(page, READ)).toBe(1);
    await page.keyboard.up('c');
    await page.keyboard.up('Control');
    expect((await keyEvents(page)).at(-1)).toEqual([UP, CTRL]);
  });

  test('a new chord after that is a new gesture', async ({ page }) => {
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'first copy');
    await expect.poll(() => memberClipboard(page)).toBe('first copy');
    await page.keyboard.press('Control+x');
    await deskCopied(page, 'then a cut');
    await expect.poll(() => memberClipboard(page)).toBe('then a cut');
  });

  test('Ctrl+C then Ctrl+V, quicker than the copy gets here: the desk\'s clipboard isn\'t overwritten with the older text', async ({ page }) => {
    await hold(page, READ);
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'just copied');
    await expect.poll(() => count(page, READ)).toBe(1);
    await page.keyboard.press('Control+v');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await count(page, WRITE)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as Win).__maDeskMock.deskClipboard)).toBe('just copied');
    await releaseHeld(page);
    await expect.poll(() => memberClipboard(page)).toBe('just copied');
  });

  test('Ctrl+V before the `changed` has come: it waits to see, then the key by itself', async ({ page }) => {
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    expect(await vPresses(page)).toBe(0);
    await deskCopied(page, 'just copied');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await count(page, WRITE)).toBe(0);
    await expect.poll(() => memberClipboard(page)).toBe('just copied');
  });

  test('Ctrl+C with nothing selected, then Ctrl+V: after the window, the member\'s own text goes as ever', async ({ page }) => {
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    expect(await count(page, WRITE)).toBe(0);
    await expect.poll(() => vPresses(page), { timeout: 3_000 }).toBe(1);
    expect((await calls(page, WRITE))[0]?.p).toEqual({ text: MEMBER_HAD });
  });

  test('Ctrl+C, a click straight into another field, then Ctrl+V: the paste waits for the copy, and the member gets it too', async ({ page }) => {
    const b = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.keyboard.press('Control+c');
    await page.mouse.click(b.x + 200, b.y + 200);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    expect(await vPresses(page)).toBe(0);
    expect(await count(page, WRITE)).toBe(0);
    await deskCopied(page, 'just copied');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await count(page, WRITE)).toBe(0); // the member's older text never reached the desk
    expect(await page.evaluate(() => (window as unknown as Win).__maDeskMock.deskClipboard)).toBe('just copied');
    await expect.poll(() => memberClipboard(page)).toBe('just copied');
  });

  test('Ctrl+C with nothing selected, a click, then Ctrl+V: the member\'s own text goes when the chord\'s window ends', async ({ page }) => {
    const b = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.keyboard.press('Control+c');
    const chord = Date.now();
    await page.mouse.click(b.x + 200, b.y + 200);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(100);
    expect(await count(page, WRITE)).toBe(0);
    await expect.poll(() => vPresses(page), { timeout: 3_000 }).toBe(1);
    expect(Date.now() - chord).toBeLessThan(2_000 + 1_000); // the chord's 2 s and the write, never a hang
    expect((await calls(page, WRITE))[0]?.p).toEqual({ text: MEMBER_HAD });
  });

  test('a click on a field then Ctrl+V doesn\'t wait', async ({ page }) => {
    await hold(page, WRITE);
    const b = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(b.x + 200, b.y + 200);
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, WRITE), { timeout: 500 }).toBe(1);
  });

  test('a click counts, for a page\'s own Copy button or a menu\'s Copy', async ({ page }) => {
    const b = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(b.x + 200, b.y + 200);
    await deskCopied(page, 'from a Copy button');
    await expect.poll(() => memberClipboard(page)).toBe('from a Copy button');
    // On the release, not the press.
    await page.mouse.move(b.x + 210, b.y + 210);
    await page.mouse.down();
    await page.waitForTimeout(50);
    expect((await spy(page)).write).toBe(1);
    await page.mouse.up();
    expect((await spy(page)).write).toBe(2);
  });

  test('a right or middle click isn\'t that, and a wheel or a plain key isn\'t either', async ({ page }) => {
    const b = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(b.x + 200, b.y + 200, { button: 'right' });
    await page.mouse.click(b.x + 200, b.y + 200, { button: 'middle' });
    await page.mouse.wheel(0, 120);
    await page.keyboard.press('c');
    await page.keyboard.press('Control+a');
    await deskCopied(page, 'a page wrote this');
    await page.waitForTimeout(100);
    expect(await count(page, READ)).toBe(0);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    expect((await spy(page)).write).toBe(0);
  });

  test('the member\'s clipboard is never read: not on a copy, a click, a `changed` or a paste', async ({ page }) => {
    const b = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'copied');
    await expect.poll(() => count(page, READ)).toBe(1);
    await page.mouse.click(b.x + 200, b.y + 200);
    await deskCopied(page, 'a page wrote this');
    await page.keyboard.press('Control+v');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect((await spy(page)).readText).toBe(0);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as Win).__clip.readText)).toBe(0);
  });
});

test('nothing of the text stays: not in the console, local or session storage, or the bar', async ({ page }) => {
  const errors = watchConsole(page);
  const logged: string[] = [];
  page.on('console', (m) => logged.push(m.text()));
  await openWindow(page);
  await focusStream(page);
  await setMemberClipboard(page, 'secret one, pasted');
  await page.keyboard.press('Control+v');
  await expect.poll(() => vPresses(page)).toBe(1);
  await page.keyboard.press('Control+c');
  await deskCopied(page, 'secret two, copied');
  await expect.poll(() => memberClipboard(page)).toBe('secret two, copied');
  await refuse(page, WRITE, 'internal');
  await pasteEvent(page, 'secret three, refused');
  await expect(notice(page)).toHaveText("That text didn't reach the page.");
  const kept = await page.evaluate(() => {
    const all = (s: Storage): string => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? '')}`).join('\n');
    return `${all(localStorage)}\n${all(sessionStorage)}\n${document.body.innerText}`;
  });
  expect(kept).not.toContain('secret');
  expect(logged.filter((l) => l.includes('secret'))).toEqual([]);
  expect(errors).toEqual([]);
});

test.describe('focus outside the picture', () => {
  test.beforeEach(async ({ page }) => {
    await openWindow(page);
    await focusStream(page);
    await page.keyboard.press('Control+l');
    await expect(address(page)).toBeFocused();
    await page.waitForTimeout(50);
    await clearInput(page);
  });

  test('Ctrl+V pastes into the address bar, here, and the desk hears nothing', async ({ page }) => {
    await page.keyboard.press('Control+v');
    await expect(address(page)).toHaveValue(MEMBER_HAD);
    await page.waitForTimeout(100);
    expect(await count(page, WRITE)).toBe(0);
    expect(await count(page, INSERT)).toBe(0);
    expect(await keyEvents(page)).toEqual([]);
  });

  test('Ctrl+C there is the member\'s browser\'s own, and no gesture: a `changed` touches nothing', async ({ page }) => {
    await page.keyboard.press('Control+c');
    const after = await memberClipboard(page);
    expect(await keyEvents(page)).toEqual([]);
    expect((await spy(page)).write).toBe(0);
    await deskCopied(page, 'a page wrote this');
    await page.waitForTimeout(100);
    expect(await count(page, READ)).toBe(0);
    expect(await memberClipboard(page)).toBe(after);
  });
});

test.describe('a desk with no clipboard topic', () => {
  test('`not_found` on SUB: a paste goes straight to browser.text.insert, and a copy chord is just a key', async ({ page }) => {
    const errors = watchConsole(page);
    await openWindow(page, () => refuse(page, TOPIC, 'not_found'));
    await focusStream(page);
    await page.keyboard.press('Control+v');
    await expect.poll(() => count(page, INSERT)).toBe(1);
    expect(await count(page, WRITE)).toBe(0);
    await page.keyboard.press('Control+c');
    expect((await keyEvents(page)).filter(([d, s]) => d === DOWN && s === C)).toHaveLength(1);
    await page.mouse.click(300, 300);
    expect((await spy(page)).write).toBe(0);
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    await expect(notice(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('`forbidden` on SUB: no copy, and a paste still asks, as that needs only input', async ({ page }) => {
    await openWindow(page, () => refuse(page, TOPIC, 'forbidden', { reason: 'permission' }));
    await focusStream(page);
    await page.keyboard.press('Control+c');
    expect((await spy(page)).write).toBe(0);
    await page.keyboard.press('Control+v');
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await count(page, WRITE)).toBe(1);
  });
});

test.describe('what the member\'s browser allows', () => {
  test('no ClipboardItem: writeText once the text is known', async ({ page }) => {
    await openWindow(page, () => page.evaluate(() => {
      delete (window as unknown as { ClipboardItem?: unknown }).ClipboardItem;
    }));
    await focusStream(page);
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'by the older way');
    await expect.poll(() => memberClipboard(page)).toBe('by the older way');
    expect(await spy(page)).toMatchObject({ write: 0, writeText: 1 });
  });

  test('a write refused: writeText, and it lands', async ({ page }) => {
    await openWindow(page, () => page.evaluate(() => {
      Clipboard.prototype.write = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
    }));
    await focusStream(page);
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'second way');
    await expect.poll(() => memberClipboard(page)).toBe('second way');
    await expect(notice(page)).toHaveCount(0);
  });

  test('both refused: one calm line, nothing of the text, nothing in the console, and the member\'s clipboard as it was', async ({ page }) => {
    const errors = watchConsole(page);
    const logged: string[] = [];
    page.on('console', (m) => logged.push(m.text()));
    await openWindow(page, () => page.evaluate(() => {
      Clipboard.prototype.write = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
      Clipboard.prototype.writeText = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
    }));
    await focusStream(page);
    await page.keyboard.press('Control+c');
    await deskCopied(page, 'not for the logs');
    await expect(notice(page)).toHaveText("Your browser didn't allow that copy.");
    expect(await memberClipboard(page)).toBe(MEMBER_HAD);
    expect(errors).toEqual([]);
    expect(logged.filter((l) => l.includes('not for the logs'))).toEqual([]);
  });

  test('a gesture that came to nothing says nothing, even when the browser would have refused', async ({ page }) => {
    await openWindow(page, () => page.evaluate(() => {
      Clipboard.prototype.write = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
    }));
    await focusStream(page);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(2_200);
    await expect(notice(page)).toHaveCount(0);
  });
});

test.describe('on a Mac', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' });
    });
    await openWindow(page);
    await focusStream(page);
  });

  test('Cmd+C and Cmd+X are the chord, and Cmd goes to the desk as Control', async ({ page }) => {
    await page.keyboard.press('Meta+c');
    expect((await keyEvents(page)).filter(([d]) => d === DOWN).map(([, s]) => s)).toEqual([CTRL, C]);
    await deskCopied(page, 'by Cmd+C');
    await expect.poll(() => memberClipboard(page)).toBe('by Cmd+C');
    await clearInput(page);
    await page.keyboard.press('Meta+x');
    await deskCopied(page, 'by Cmd+X');
    await expect.poll(() => memberClipboard(page)).toBe('by Cmd+X');
  });

  test('Cmd+V: no key of its own, and the paste key is V under the Cmd they\'re holding', async ({ page }) => {
    await page.keyboard.down('Meta');
    await clearInput(page);
    await page.keyboard.down('v');
    await page.keyboard.up('v');
    await page.waitForTimeout(50);
    expect(await keyEvents(page)).toEqual([]);
    await pasteEvent(page, 'by Cmd+V'); // this machine's Chromium has no Cmd+V of its own, so the browser's part is stood in for
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await keyEvents(page)).toEqual([[DOWN, V], [UP, V]]);
    await page.keyboard.up('Meta');
    expect((await keyEvents(page)).at(-1)).toEqual([UP, CTRL]);
  });

  test('let go of Cmd first: the key brings its own Control', async ({ page }) => {
    await hold(page, WRITE);
    await pasteEvent(page, 'by Cmd+V');
    await expect.poll(() => count(page, WRITE)).toBe(1);
    await releaseHeld(page);
    await expect.poll(() => vPresses(page)).toBe(1);
    expect(await keyEvents(page)).toEqual([[DOWN, CTRL], [DOWN, V], [UP, V], [UP, CTRL]]);
  });
});
