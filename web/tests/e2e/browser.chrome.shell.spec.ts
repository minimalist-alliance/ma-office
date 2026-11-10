// The Browser window's own chrome: tabs, back, forward, reload, the address bar. With the mock link, whose RPCs
// insist on `idem` as deskd does. Waking, with the real link against the harness's `connect`.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

interface Tab {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  active: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface Control {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  refuse: Record<string, string>;
  refuseDetails: Record<string, unknown>;
  tabs: Tab[];
  setTabs(tabs: Tab[]): void;
  tabsError(code: string): void;
  refuseDelayMs: number;
  lostSession: Record<string, boolean>;
  topicDelayMs: number;
  sendSnapshot(tabs: Tab[]): void;
  input: { channel: string; bytes: number[] }[];
}

type Win = { __maDeskMock: Control };

const tab = (over: Partial<Tab>): Tab => ({ tabId: 't1', url: 'https://example.org/', title: 'Example page', loading: false, active: true, canGoBack: false, canGoForward: false, ...over });
const setTabs = (page: Page, tabs: Tab[]): Promise<void> => page.evaluate((t) => (window as unknown as Win).__maDeskMock.setTabs(t), tabs);
const calls = (page: Page, m: string): Promise<{ p: Record<string, unknown>; idem: string | undefined }[]> =>
  page.evaluate((method) => (window as unknown as Win).__maDeskMock.rpc.filter((r) => r.m === method).map((r) => ({ p: r.p, idem: r.options?.idem })), m);
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
const keyEvents = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Win).__maDeskMock.input.filter((e) => e.bytes[0] === 4).length);

const address = (page: Page) => page.getByTestId('browser-address');
const keys = (page: Page) => page.getByTestId('browser-keys');
/** A paste on a desk with no clipboard yet, which is what these rules of `browser.text.insert` are for. */
const paste = (page: Page, text: string): Promise<void> =>
  keys(page).evaluate((el, t) => {
    (window as unknown as Win).__maDeskMock.refuse['browser.clipboard.write'] = 'not_found';
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
const tabs = (page: Page) => page.getByTestId('browser-tab');
const button = (page: Page, name: string) => page.getByRole('dialog', { name: /Browser/ }).getByRole('button', { name, exact: true });

async function open(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  await page.waitForTimeout(300);
}

async function go(page: Page, typed: string): Promise<void> {
  await address(page).click();
  await address(page).fill(typed);
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: screenshot of the chrome over the picture, with a focused stream`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await open(page);
    await setTabs(page, [
      tab({ canGoBack: true, title: 'A page with rather a long title that will not fit in the tab at all, not even close' }),
      tab({ tabId: 't2', title: 'Another page', url: 'https://example.net/', active: false, loading: true }),
      tab({ tabId: 't3', title: '', url: 'https://example.com/only-a-url', active: false }),
    ]);
    const v = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
    await expect(page.getByTestId('browser-focus-hint')).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-chrome.png` });
    expect(errors).toEqual([]);
  });
}

/** WCAG's contrast ratio of two `rgb()` colors, as getComputedStyle gives them. */
function contrast(a: string, b: string): number {
  const lum = (c: string): number => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => Number(v) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
  return (hi! + 0.05) / (lo! + 0.05);
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the selected tab has an edge of 3:1 or more on the window, and the others none, all one size`, async ({ page }) => {
    await setTheme(page, theme);
    await open(page);
    await setTabs(page, [tab({ active: false }), tab({ tabId: 't2', title: 'Second', url: 'https://example.net/', active: true }), tab({ tabId: 't3', title: 'Third', active: false })]);
    await expect(page.getByRole('tab', { name: 'Second' })).toHaveAttribute('aria-selected', 'true');
    const look = await tabs(page).evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        // What the tab sits on: the first ancestor that paints, which must be opaque for the ratio to mean anything.
        let under = el.parentElement;
        while (under && getComputedStyle(under).backgroundColor === 'rgba(0, 0, 0, 0)') under = under.parentElement;
        return { edge: cs.borderTopColor, width: cs.borderTopWidth, style: cs.borderTopStyle, height: el.getBoundingClientRect().height, under: under ? getComputedStyle(under).backgroundColor : '' };
      }),
    );
    const [first, selected, third] = look;
    expect(selected!.style).toBe('solid');
    expect(selected!.width).toBe('1px');
    expect(selected!.under).toMatch(/^rgb\(/);
    expect(contrast(selected!.edge, selected!.under)).toBeGreaterThanOrEqual(3);
    for (const other of [first!, third!]) {
      expect(other.edge).toBe('rgba(0, 0, 0, 0)');
      expect(other.height).toBe(selected!.height);
    }
    const strip = page.locator('.br-tabs');
    await strip.screenshot({ path: `test-results/shots/${theme}-browser-selected-tab.png` });
  });
}

test('tabs come from browser.tabs, and every snapshot replaces them', async ({ page }) => {
  await open(page);
  await expect(tabs(page)).toHaveText(['Example page']);
  await expect(address(page)).toHaveValue('https://example.org/');
  await setTabs(page, [tab({ active: false }), tab({ tabId: 't2', title: 'Second', url: 'https://example.net/', active: true })]);
  await expect(tabs(page)).toHaveCount(2);
  await expect(address(page)).toHaveValue('https://example.net/');
  // A link clicked inside the page: same tab, new URL, with no call from here.
  await setTabs(page, [tab({ url: 'https://example.org/next', title: 'Next' })]);
  await expect(tabs(page)).toHaveText(['Next']);
  await expect(address(page)).toHaveValue('https://example.org/next');
});

test('titles and URLs are untrusted: text only, and no bidi tricks', async ({ page }) => {
  const errors = watchConsole(page);
  await open(page);
  await page.evaluate(() => {
    (window as unknown as { __xss: boolean }).__xss = false;
  });
  const hostile = '<img src=x onerror="window.__xss=true"><script>window.__xss=true</script>';
  await setTabs(page, [tab({ title: hostile, url: `https://good.example/\u202eevil\u202c` })]);
  await expect(tabs(page).first()).toContainText('<img src=x');
  expect(await page.getByRole('dialog', { name: /Browser/ }).locator('img, script').count()).toBe(0);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { __xss: boolean }).__xss)).toBe(false);
  await expect(address(page)).toHaveValue('https://good.example/evil');
  expect(errors).toEqual([]);
});

test('an address goes to browser.tab.navigate with an idem, and focus goes to the page', async ({ page }) => {
  await open(page);
  await go(page, 'example.com/path');
  await expect.poll(() => calls(page, 'browser.tab.navigate')).toHaveLength(1);
  const [first] = await calls(page, 'browser.tab.navigate');
  expect(first?.p).toEqual({ url: 'https://example.com/path' });
  expect(first?.idem).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  await expect(keys(page)).toBeFocused();
  await expect(address(page)).toHaveValue('https://example.com/path');
});

test('words are a search, and nothing but http(s) ever goes out', async ({ page }) => {
  await open(page);
  await go(page, 'how tall is a giraffe');
  await go(page, 'javascript:alert(1)');
  await go(page, 'file:///etc/passwd');
  await expect.poll(() => calls(page, 'browser.tab.navigate')).toHaveLength(3);
  for (const { p } of await calls(page, 'browser.tab.navigate')) {
    expect(String(p['url'])).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/);
  }
});

test('the same address again: the typed text gives way as soon as the tab is loading', async ({ page }) => {
  await open(page);
  await go(page, 'example.org');
  await expect(address(page)).toHaveValue('https://example.org/');
  await go(page, 'example.org');
  await expect(address(page)).toHaveValue('https://example.org/');
});

test('typing and then clicking away shows where the page really is', async ({ page }) => {
  await open(page);
  await address(page).click();
  await address(page).fill('never mind');
  await page.locator('.window-title').click();
  await expect(address(page)).toHaveValue('https://example.org/');
});

test('Enter with nothing typed goes nowhere', async ({ page }) => {
  await open(page);
  await address(page).click();
  await address(page).fill('   ');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  expect(await calls(page, 'browser.tab.navigate')).toEqual([]);
});

test('back, forward and reload follow the active tab, and send an idem', async ({ page }) => {
  await open(page);
  await expect(button(page, 'Back')).toBeDisabled();
  await expect(button(page, 'Forward')).toBeDisabled();
  await setTabs(page, [tab({ canGoBack: true })]);
  await expect(button(page, 'Back')).toBeEnabled();
  await button(page, 'Back').click();
  await expect.poll(() => calls(page, 'browser.tab.back')).toHaveLength(1);
  await expect(button(page, 'Forward')).toBeEnabled();
  await button(page, 'Forward').click();
  await button(page, 'Reload').click();
  await expect.poll(() => calls(page, 'browser.tab.reload')).toHaveLength(1);
  for (const m of ['browser.tab.back', 'browser.tab.forward', 'browser.tab.reload']) {
    const [c] = await calls(page, m);
    expect(c?.p).toEqual({}); // no tabId means the active tab
    expect(c?.idem).toBeTruthy();
  }
});

test('tabs: switch, close, new. It answers at once, and the snapshot has the last word', async ({ page }) => {
  await open(page);
  await setTabs(page, [tab({}), tab({ tabId: 't2', title: 'Second', url: 'https://example.net/', active: false })]);
  await expect(tabs(page)).toHaveCount(2);
  await page.getByRole('tab', { name: 'Second' }).click();
  await expect(page.getByRole('tab', { name: 'Second' })).toHaveAttribute('aria-selected', 'true');
  await expect(address(page)).toHaveValue('https://example.net/');
  expect((await calls(page, 'browser.tab.activate'))[0]?.p).toEqual({ tabId: 't2' });

  await page.getByRole('button', { name: 'Close Example page' }).click();
  await expect(tabs(page)).toHaveCount(1);
  expect((await calls(page, 'browser.tab.close'))[0]?.p).toEqual({ tabId: 't1' });
  await expect(page.getByRole('button', { name: 'Close Second' })).toHaveCount(0); // the last tab stays

  await button(page, 'New tab').click();
  await expect(tabs(page)).toHaveCount(2);
  expect((await calls(page, 'browser.tab.open'))[0]?.p).toEqual({});
});

test('a new tab: the bar empties and takes focus, so the member can type right away', async ({ page }) => {
  await open(page);
  await button(page, 'New tab').click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(address(page)).toBeFocused();
  await expect(address(page)).toHaveValue('');
  await expect(address(page)).toHaveAttribute('placeholder', 'Search or type an address');
});

test('a dead tabId is not a problem: the list is read again', async ({ page }) => {
  await open(page);
  await setTabs(page, [tab({}), tab({ tabId: 't2', title: 'Second', active: false })]);
  await expect(tabs(page)).toHaveCount(2);
  // Chromium restarted, so the ids changed, and this click still has the old one. Refused, with no noise.
  await page.evaluate(() => {
    const c = (window as unknown as Win).__maDeskMock;
    c.tabs = [{ ...(c.tabs[0] as Tab), tabId: 'new-1' }];
  });
  await page.getByRole('tab', { name: 'Second' }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByTestId('browser-notice')).toHaveCount(0);
});

test.describe('what the desk can say to an address', () => {
  for (const [name, code, details, text] of [
    ['a scheme it refuses', 'bad_request', { reason: 'scheme' }, 'Only web addresses open here.'],
    ['an address it blocks', 'forbidden', { reason: 'blocked' }, 'This desk blocks that address.'],
    ['an address that is not one', 'bad_request', { reason: 'url' }, "That isn't a web address."],
    ['a session that may only watch', 'forbidden', { reason: 'permission' }, "This session can't control the browser."],
    ['no such method yet', 'not_found', {}, "This desk's Browser can't do that yet."],
  ] as const) {
    test(`${name} is said plainly and calmly`, async ({ page }) => {
      const errors = watchConsole(page);
      await open(page);
      await refuse(page, 'browser.tab.navigate', code, details);
      await go(page, 'example.com');
      await expect(page.getByTestId('browser-notice')).toHaveText(text);
      expect(errors).toEqual([]);
    });
  }

  test('unavailable with no flag, while Chromium starts: retries on its one idem, and gets there', async ({ page }) => {
    await open(page);
    await refuse(page, 'browser.tab.navigate', 'unavailable');
    await go(page, 'example.com');
    await expect.poll(async () => (await calls(page, 'browser.tab.navigate')).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
    await allow(page, 'browser.tab.navigate');
    await expect(address(page)).toHaveValue('https://example.com/', { timeout: 10_000 });
    const keysSent = (await calls(page, 'browser.tab.navigate')).map((c) => c.idem);
    expect(keysSent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keysSent).size).toBe(1);
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
  });

  test('netError is a normal result: Chromium shows its own page, so nothing here', async ({ page }) => {
    await open(page);
    await go(page, 'nowhere.example');
    await page.waitForTimeout(100);
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
  });
});

test.describe('when deskd cannot tell which tab is on screen', () => {
  const PICK = "This page can't take that from here. Pick a tab.";

  test('an address: one try, the calm line, the list read again, and what was typed stays through picking a tab', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await setTabs(page, [tab({}), tab({ tabId: 't2', title: 'Second', url: 'https://example.net/', active: false })]);
    await expect(tabs(page)).toHaveCount(2);
    const listsBefore = (await calls(page, 'browser.tab.list')).length;
    await refuse(page, 'browser.tab.navigate', 'unavailable', { reason: 'active_tab' });
    await go(page, 'example.com/typed');
    await expect(page.getByTestId('browser-notice')).toHaveText(PICK);
    await page.waitForTimeout(1_500);
    expect(await calls(page, 'browser.tab.navigate')).toHaveLength(1);
    expect((await calls(page, 'browser.tab.list')).length).toBe(listsBefore + 1);
    await expect(address(page)).toHaveValue('example.com/typed');

    await page.getByRole('tab', { name: 'Second' }).click();
    await expect(page.getByRole('tab', { name: 'Second' })).toHaveAttribute('aria-selected', 'true');
    await expect(address(page)).toHaveValue('example.com/typed');

    // And it goes once things are right, then gives way to where the page really is.
    await allow(page, 'browser.tab.navigate');
    await address(page).click();
    await page.keyboard.press('Enter');
    await expect(address(page)).toHaveValue('https://example.com/typed');
    expect(errors).toEqual([]);
  });

  test('pasted text: one try, held, sent again only by the member, with no tabId', async ({ page }) => {
    await open(page);
    await refuse(page, 'browser.text.insert', 'unavailable', { reason: 'active_tab' });
    await paste(page, 'pasted text');
    await expect(page.getByTestId('browser-notice')).toHaveText(PICK);
    await page.waitForTimeout(1_500);
    expect(await calls(page, 'browser.text.insert')).toHaveLength(1);

    await allow(page, 'browser.text.insert');
    await page.getByTestId('browser-held-send').click();
    await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
    const sent = await calls(page, 'browser.text.insert');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.p).toEqual({ text: 'pasted text' });
    expect(sent[1]?.idem).not.toBe(sent[0]?.idem);
  });

  test('held text can be dropped', async ({ page }) => {
    await open(page);
    await refuse(page, 'browser.text.insert', 'unavailable', { reason: 'active_tab' });
    await paste(page, 'never mind');
    await page.getByTestId('browser-held-drop').click();
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
    await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
    expect(await calls(page, 'browser.text.insert')).toHaveLength(1);
  });
});

test.describe('when the page may have taken it and did not answer', () => {
  const LINE = "The page didn't answer. Check it before trying again.";
  const MAY = { reason: 'chromium', mayHaveApplied: true };

  test('an address: one try, the calm line, what was typed stays, and Enter again is a new key', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await refuse(page, 'browser.tab.navigate', 'unavailable', MAY);
    await go(page, 'example.com/typed');
    await expect(page.getByTestId('browser-notice')).toHaveText(LINE);
    await page.waitForTimeout(1_500);
    expect(await calls(page, 'browser.tab.navigate')).toHaveLength(1);
    await expect(address(page)).toHaveValue('example.com/typed');

    await allow(page, 'browser.tab.navigate');
    await address(page).click();
    await page.keyboard.press('Enter');
    await expect(address(page)).toHaveValue('https://example.com/typed');
    const sent = await calls(page, 'browser.tab.navigate');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.idem).not.toBe(sent[0]?.idem);
    expect(errors).toEqual([]);
  });

  test('an address the tab moved past before the answer came: it comes back, as the address it became', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      (window as unknown as Win).__maDeskMock.refuseDelayMs = 500;
    });
    await refuse(page, 'browser.tab.navigate', 'unavailable', MAY);
    await go(page, 'example.com/typed');
    await setTabs(page, [tab({ url: 'https://example.org/moved' })]);
    await expect(address(page)).toHaveValue('https://example.org/moved');
    await expect(page.getByTestId('browser-notice')).toHaveText(LINE);
    await expect(address(page)).toHaveValue('https://example.com/typed');
  });

  test('back, from a server error with the flag: one try, and pressing again is a new key', async ({ page }) => {
    await open(page);
    await setTabs(page, [tab({ canGoBack: true })]);
    await refuse(page, 'browser.tab.back', 'internal', { mayHaveApplied: true });
    await button(page, 'Back').click();
    await expect(page.getByTestId('browser-notice')).toHaveText(LINE);
    await page.waitForTimeout(1_500);
    expect(await calls(page, 'browser.tab.back')).toHaveLength(1);

    await allow(page, 'browser.tab.back');
    await button(page, 'Back').click();
    await expect.poll(async () => (await calls(page, 'browser.tab.back')).length).toBe(2);
    const sent = await calls(page, 'browser.tab.back');
    expect(sent[1]?.idem).not.toBe(sent[0]?.idem);
  });

  test('a tab switch: one try, and the strip goes back to what the desk says', async ({ page }) => {
    await open(page);
    await setTabs(page, [tab({}), tab({ tabId: 't2', title: 'Second', url: 'https://example.net/', active: false })]);
    await expect(tabs(page)).toHaveCount(2);
    await refuse(page, 'browser.tab.activate', 'unavailable', MAY);
    await page.getByRole('tab', { name: 'Second' }).click();
    await expect(page.getByTestId('browser-notice')).toHaveText(LINE);
    await expect(page.getByRole('tab', { name: 'Example page' })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(1_500);
    expect(await calls(page, 'browser.tab.activate')).toHaveLength(1);
  });

  test('pasted text: never sent again by itself. It waits, and goes only by the member, with a new key and no tabId', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await refuse(page, 'browser.text.insert', 'unavailable', MAY);
    await paste(page, 'pasted text');
    await expect(page.getByTestId('browser-notice')).toHaveText(LINE);
    await page.waitForTimeout(6_000); // past any notice's time, and any retry's
    await expect(page.getByTestId('browser-notice')).toHaveText(LINE);
    expect(await calls(page, 'browser.text.insert')).toHaveLength(1);
    await page.screenshot({ path: 'test-results/shots/browser-page-did-not-answer.png' });

    await allow(page, 'browser.text.insert');
    await page.getByTestId('browser-held-send').click();
    await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
    await expect(page.getByTestId('browser-notice')).toHaveCount(0);
    const sent = await calls(page, 'browser.text.insert');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.p).toEqual({ text: 'pasted text' });
    expect(sent[1]?.idem).not.toBe(sent[0]?.idem);
    expect(errors).toEqual([]);
  });
});

test.describe('pasted text when the session drops', () => {
  const lose = (page: Page, inFlight: boolean): Promise<void> =>
    page.evaluate((f) => {
      (window as unknown as Win).__maDeskMock.lostSession['browser.text.insert'] = f;
    }, inFlight);

  test('while waiting for the answer: it may have typed, so the same line and hold, never resent', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    await lose(page, true);
    await paste(page, 'pasted text');
    await expect(page.getByTestId('browser-notice')).toHaveText("The page didn't answer. Check it before trying again.");
    await page.waitForTimeout(1_500);
    expect(await calls(page, 'browser.text.insert')).toHaveLength(1);

    await page.evaluate(() => {
      delete (window as unknown as Win).__maDeskMock.lostSession['browser.text.insert'];
    });
    await page.getByTestId('browser-held-send').click();
    await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
    const sent = await calls(page, 'browser.text.insert');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.p).toEqual({ text: 'pasted text' });
    expect(sent[1]?.idem).not.toBe(sent[0]?.idem);
    expect(errors).toEqual([]);
  });

  test('before it could leave: certain, so it says so, and nothing waits', async ({ page }) => {
    await open(page);
    await lose(page, false);
    await paste(page, 'pasted text');
    await expect(page.getByTestId('browser-notice')).toHaveText("That text didn't reach the page.");
    await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
  });
});

test.describe('permission', () => {
  test('text from a session that may only watch: said plainly, once, and not held', async ({ page }) => {
    await open(page);
    await refuse(page, 'browser.text.insert', 'forbidden', { reason: 'permission' });
    await paste(page, 'hello');
    await expect(page.getByTestId('browser-notice')).toHaveText("This session can't control the browser.");
    await expect(page.getByTestId('browser-held-send')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    expect(await calls(page, 'browser.text.insert')).toHaveLength(1);
  });

  test('a browser.tabs error with forbidden leaves the window calm, and it stops asking', async ({ page }) => {
    const errors = watchConsole(page);
    await open(page);
    const stream = (): Promise<number> => calls(page, 'browser.stream.set').then((c) => c.length);
    const before = await stream();
    await page.evaluate(() => (window as unknown as Win).__maDeskMock.tabsError('forbidden'));
    await expect(page.getByTestId('browser-panel')).toHaveAttribute('data-panel', 'forbidden');
    await expect(page.getByTestId('browser-panel')).toHaveText("This session can't view the desk's Browser");
    await page.waitForTimeout(1_500);
    expect(await stream()).toBe(before);
    await expect(tabs(page)).toHaveCount(1); // the last list stays
    expect(errors).toEqual([]);
  });
});

test.describe('a tab change the topic has not caught up with', () => {
  const two = [tab({}), tab({ tabId: 't2', title: 'Second', url: 'https://example.net/', active: false })];
  const second = (page: Page) => page.getByRole('tab', { name: 'Second' });
  const slowTopic = (page: Page, ms: number): Promise<void> =>
    page.evaluate((delay) => {
      (window as unknown as Win).__maDeskMock.topicDelayMs = delay;
    }, ms);
  const staleSnapshot = (page: Page): Promise<void> =>
    page.evaluate((list) => {
      (window as unknown as Win).__maDeskMock.sendSnapshot(list);
    }, two);

  test('a stale snapshot does not flip the strip back, and the one that agrees changes nothing', async ({ page }) => {
    await open(page);
    await setTabs(page, two);
    await expect(tabs(page)).toHaveCount(2);
    await slowTopic(page, 800);
    await second(page).click();
    await expect(second(page)).toHaveAttribute('aria-selected', 'true');
    await staleSnapshot(page);
    await page.waitForTimeout(300);
    await expect(second(page)).toHaveAttribute('aria-selected', 'true');
    await expect(address(page)).toHaveValue('https://example.net/');
    await page.waitForTimeout(800);
    await expect(second(page)).toHaveAttribute('aria-selected', 'true');
  });

  test('if nothing ever agrees, past the hold the desk is asked, and it has the last word', async ({ page }) => {
    await open(page);
    await setTabs(page, two);
    await expect(tabs(page)).toHaveCount(2);
    await slowTopic(page, 60_000);
    await second(page).click();
    await page.evaluate((list) => {
      (window as unknown as Win).__maDeskMock.tabs = list; // the page took it back, and the topic hasn't said
    }, two);
    await page.waitForTimeout(1_000);
    await expect(second(page)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Example page' })).toHaveAttribute('aria-selected', 'true', { timeout: 4_000 });
  });

  test('a closed tab stays closed through a stale snapshot', async ({ page }) => {
    await open(page);
    await setTabs(page, two);
    await expect(tabs(page)).toHaveCount(2);
    await slowTopic(page, 800);
    await page.getByRole('button', { name: 'Close Second' }).click();
    await expect(tabs(page)).toHaveCount(1);
    await staleSnapshot(page);
    await page.waitForTimeout(300);
    await expect(tabs(page)).toHaveCount(1);
    await page.waitForTimeout(800);
    await expect(tabs(page)).toHaveCount(1);
  });
});

test.describe('focus', () => {
  test('typing in the address bar never reaches the stream', async ({ page }) => {
    await open(page);
    await address(page).click();
    await page.keyboard.type('hello');
    await page.keyboard.press('Backspace');
    expect(await keyEvents(page)).toBe(0);
    await expect(address(page)).toHaveValue('hell');
  });

  test('Ctrl+L from the stream goes to the address bar, with the URL selected, and lets go of held keys', async ({ page }) => {
    await open(page);
    const v = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
    await expect(keys(page)).toBeFocused();
    await expect(page.getByTestId('browser-focus-hint')).toBeVisible();
    await page.keyboard.press('Control+l');
    await expect(address(page)).toBeFocused();
    await expect(page.getByTestId('browser-focus-hint')).toHaveCount(0);
    const selected = await address(page).evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0));
    expect(selected).toBe('https://example.org/');
    expect(await page.evaluate(() => (window as unknown as Win).__maDeskMock.input.at(-1)?.bytes[0])).toBe(5); // RELEASE_ALL
  });

  test('Alt+D does the same, and Ctrl+L works from the window itself', async ({ page }) => {
    await open(page);
    await page.locator('.window-title').click();
    await page.keyboard.press('Control+l');
    await expect(address(page)).toBeFocused();
    const v = (await page.getByTestId('browser-video').boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
    await page.keyboard.press('Alt+d');
    await expect(address(page)).toBeFocused();
  });

  test('Esc in the address bar puts the URL back and returns to the page, and leaves the window open', async ({ page }) => {
    await open(page);
    await address(page).click();
    await address(page).fill('something else');
    await page.keyboard.press('Escape');
    await expect(address(page)).toHaveValue('https://example.org/');
    await expect(keys(page)).toBeFocused();
    await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
  });

  test('a snapshot does not overwrite what is being typed', async ({ page }) => {
    await open(page);
    await address(page).click();
    await address(page).fill('half typed');
    await setTabs(page, [tab({ url: 'https://example.org/moved', loading: true })]);
    await page.waitForTimeout(50);
    await expect(address(page)).toHaveValue('half typed');
    await expect(address(page)).toBeFocused();
  });

  test('Shift+Esc in the address bar still leaves', async ({ page }) => {
    await open(page);
    await address(page).click();
    await page.keyboard.press('Shift+Escape');
    await expect(page.getByRole('dialog', { name: /Browser/ })).toHaveCount(0);
  });

  test('a finger on the picture gets a quiet word, and nothing else', async ({ page }) => {
    await open(page);
    await page.getByTestId('browser-video').evaluate((v: HTMLVideoElement) => {
      v.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 300, clientY: 300, bubbles: true }));
    });
    await expect(page.getByTestId('browser-notice')).toHaveText("Touch control isn't here yet. You can watch.");
  });
});

// ----- waking, with the real link against the harness's own `connect`.

const PERSONAL = 'd-personal00001';
const personal = (state: string) => ({ deskId: PERSONAL, name: 'Personal', kind: 'personal', state });
const WORK = { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'stopped' };

async function openOnRealLink(page: Page, request: APIRequestContext, fleet: object[]): Promise<void> {
  await harness(request, { fleet });
  await signIn(page, '/?link=real');
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.waitForTimeout(300);
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
}

test('while waking, an address can be typed, says it waits, and the buttons say why they are off', async ({ page, request }) => {
  await openOnRealLink(page, request, [personal('starting')]);
  await expect(page.getByTestId('browser-panel')).toHaveAttribute('data-panel', 'waking');
  await expect(button(page, 'Reload')).toBeDisabled();
  await expect(button(page, 'Reload')).toHaveAttribute('title', 'Not connected to this desk right now');
  await address(page).click();
  await address(page).fill('example.com');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('browser-pending')).toHaveText('Opens when the desk is ready');
  await expect(address(page)).toHaveValue('example.com');
});

test('while waking, what is typed stays when focus moves on, as a draft', async ({ page, request }) => {
  await openOnRealLink(page, request, [personal('starting')]);
  await address(page).click();
  await address(page).fill('half typed');
  await page.locator('.window-title').click();
  await expect(address(page)).toHaveValue('half typed');
});

test('asleep, the address bar is off too: Wake is the one thing to do', async ({ page, request }) => {
  await harness(request, { refuseWake: { status: 409, code: 'downtime_active' } });
  await openOnRealLink(page, request, [personal('stopped'), WORK]);
  await expect(page.getByTestId('browser-panel')).toHaveAttribute('data-panel', 'asleep');
  await expect(address(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Wake', exact: true })).toBeVisible();
});
