// Links in and out (#9, S-141), the Browser window's side, on the mock desk: Open on this device at the address's end (the
// first-use card, then the bar's note), the desk's hand-off card on `browser.links` (`__maDeskMock.linkOut`, deskd's
// `linkOut` as API.md section 10 has it), a finished download's "Download on this device" (`BrowserDownload.url`, asked of
// the Desk Engineer), and Picture quality folded into More under 720 px of bar. Light, Zen and Dark, and a 390 px phone.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

type Win = {
  __maDeskMock: {
    linkOut(url: string, extra?: Record<string, unknown>): void;
    refuse: Record<string, string>;
    setTabs(tabs: unknown[]): void;
    tabs: Array<Record<string, unknown>>;
    setDownloads(list: unknown[]): void;
    protectedFailed(tabId: string): void;
  };
  __handed: string[];
};

const FIRST_USE = "Opened on this device, where you may need to sign in. Your desk's sign-ins stay on your desk.";
const card = (page: Page) => page.getByTestId('browser-handoff');
const openHere = (page: Page) => page.getByRole('button', { name: 'Open on this device', exact: true }).and(page.getByTestId('browser-open-here'));
const setUrl = (page: Page, url: string): Promise<void> =>
  page.evaluate((u) => {
    const m = (window as unknown as Win).__maDeskMock;
    m.setTabs(m.tabs.map((t) => ({ ...t, url: u })));
  }, url);
const protectedFailed = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as Win).__maDeskMock.protectedFailed('t1'));
const setDownloads = (page: Page, list: unknown[]): Promise<void> => page.evaluate((l) => (window as unknown as Win).__maDeskMock.setDownloads(l), list);
const linkOut = (page: Page, url: string): Promise<void> => page.evaluate((u) => (window as unknown as Win).__maDeskMock.linkOut(u), url);

/** A press on the page in the stream: input from this device, so a hand-off right after is this device's. */
async function pressPage(page: Page): Promise<void> {
  const v = (await page.getByTestId('browser-video').boundingBox())!;
  await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
}

/** Every `<a href>` this device was handed, instead of the device's own app opening it. */
async function catchHandoffs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    w.__handed = [];
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      w.__handed.push(this.href);
    };
  });
}
const handed = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as Win).__handed);

async function openBrowser(page: Page, path = '/?fixture=one'): Promise<void> {
  await signIn(page, path);
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-app')).toBeVisible();
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(300);
}

async function phone(context: BrowserContext | null, browser: import('@playwright/test').Browser, theme: ThemeId): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = context ?? (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL }));
  const page = await ctx.newPage();
  await setTheme(page, theme);
  return { ctx, page };
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('Open on this device', () => {
  test('the address’s button opens the page here; the first time a card says so, after that the bar’s note', async ({ page, context }) => {
    const errors = watchConsole(page);
    await context.route('https://example.org/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>x</title>' }));
    await openBrowser(page);
    await expect(openHere(page)).toBeVisible();
    // In the Tab order right after the address.
    await page.getByTestId('browser-address').focus();
    await page.keyboard.press('Tab');
    await expect(openHere(page)).toBeFocused();
    const [popup] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Enter')]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    expect(popup.url()).toBe('https://example.org/');
    await popup.close();
    await expect(page.getByTestId('browser-opened')).toHaveText(FIRST_USE);
    await page.getByTestId('browser-opened').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('browser-opened')).toHaveCount(0);
    // Each later time: the bar's note, for 3 s.
    const [again] = await Promise.all([context.waitForEvent('page'), openHere(page).click()]);
    await again.close();
    await expect(page.getByTestId('browser-opened')).toHaveCount(0);
    await expect(page.getByTestId('browser-opened-note')).toHaveText('Opened on this device');
    await expect(page.getByTestId('browser-opened-note')).toHaveCount(0, { timeout: 5000 });
    expect(errors).toEqual([]);
  });

  test('it isn’t there while a new address is typed, nor on the start page, nor for an address that isn’t a web page', async ({ page }) => {
    await openBrowser(page);
    await page.getByTestId('browser-address').fill('example.net');
    await expect(page.getByTestId('browser-open-here')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('browser-open-here')).toBeVisible();
    for (const url of ['', 'about:blank', 'chrome://settings/']) {
      await setUrl(page, url);
      await expect(page.getByTestId('browser-open-here')).toHaveCount(0);
    }
  });

  test('the protected-video note has the Designer’s words, and its link the button’s name', async ({ page }) => {
    await openBrowser(page);
    await protectedFailed(page);
    await expect(page.getByTestId('browser-protected')).toHaveText('This video is protected, so it can’t play on a desk.Open on this device');
  });
});

test.describe('the desk hands over a link', () => {
  test('a mailto from a press here: the card, Open on this device hands it over, then Copy the address', async ({ page, context }) => {
    const errors = watchConsole(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await catchHandoffs(page);
    await openBrowser(page);
    await pressPage(page);
    await linkOut(page, 'mailto:hello@example.com?subject=Hi%20there');
    await expect(card(page)).toHaveAttribute('data-stage', 'ask');
    await expect(card(page)).toContainText('This page wants to start an email.');
    await expect(page.getByTestId('browser-handoff-address')).toHaveText('mailto:hello@example.com?subject=Hi there');
    await expect(page.getByTestId('live-region')).toHaveText('This page wants to start an email. Open on this device, or Not now.');
    // It never took focus: the page still has the keyboard.
    await expect(page.getByTestId('browser-keys')).toBeFocused();
    expect(await handed(page)).toEqual([]);
    await card(page).getByRole('button', { name: 'Open on this device' }).click();
    expect(await handed(page)).toEqual(['mailto:hello@example.com?subject=Hi%20there']);
    await expect(card(page)).toHaveAttribute('data-stage', 'after');
    await expect(card(page)).toContainText('If nothing opened, this device may not have an app for it.');
    await card(page).getByRole('button', { name: 'Copy the address' }).click();
    await expect(card(page).getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('mailto:hello@example.com?subject=Hi%20there');
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(card(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Not now puts it away; the newest wins; it takes the protected note’s place and gives it back', async ({ page }) => {
    await catchHandoffs(page);
    await openBrowser(page);
    await protectedFailed(page);
    await expect(page.getByTestId('browser-protected')).toBeVisible();
    await pressPage(page);
    await linkOut(page, 'mailto:a@example.com');
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId('browser-protected')).toHaveCount(0);
    await linkOut(page, 'tel:+15550100');
    await expect(card(page)).toHaveAttribute('data-scheme', 'tel');
    await expect(card(page)).toContainText('This page wants to make a call.');
    await card(page).getByRole('button', { name: 'Not now' }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByTestId('browser-protected')).toBeVisible();
    expect(await handed(page)).toEqual([]);
  });

  test('each scheme has its own sentence; any other scheme never shows', async ({ page }) => {
    await openBrowser(page);
    const say: Array<[string, string]> = [
      ['sms:+15550100', 'This page wants to send a text.'],
      ['zoommtg://zoom.us/join?confno=123', 'This page wants to open Zoom.'],
      ['msteams:/l/meetup-join/x', 'This page wants to open Microsoft Teams.'],
      ['webcal://cal.example.com/a.ics', 'This page wants to add a calendar.'],
    ];
    for (const [url, words] of say) {
      await pressPage(page);
      await linkOut(page, url);
      await expect(card(page)).toContainText(words);
      await card(page).getByRole('button', { name: 'Not now' }).click();
    }
    for (const url of ['facetime:+15550100', 'https://example.net/', 'javascript:alert(1)']) {
      await pressPage(page);
      await linkOut(page, url);
    }
    await page.waitForTimeout(300);
    await expect(card(page)).toHaveCount(0);
  });

  test('another device’s hand-off shows nothing here: no input on this stream just now', async ({ page }) => {
    await openBrowser(page);
    await linkOut(page, 'mailto:a@example.com');
    await page.waitForTimeout(300);
    await expect(card(page)).toHaveCount(0);
    await pressPage(page);
    await page.waitForTimeout(3300);
    await linkOut(page, 'mailto:a@example.com');
    await page.waitForTimeout(300);
    await expect(card(page)).toHaveCount(0);
  });

  test('a desk before Links out, and the kill switch: never a card, and no error', async ({ page, request }) => {
    const errors = watchConsole(page);
    await page.addInitScript(() => {
      const w = window as unknown as { __maDeskMock?: Win['__maDeskMock'] };
      const t = setInterval(() => {
        if (w.__maDeskMock) {
          w.__maDeskMock.refuse['browser.links'] = 'not_found';
          clearInterval(t);
        }
      }, 1);
    });
    await openBrowser(page);
    await pressPage(page);
    await linkOut(page, 'mailto:a@example.com');
    await page.waitForTimeout(300);
    await expect(card(page)).toHaveCount(0);
    expect(errors).toEqual([]);

    await harness(request, { configExtra: { browserLinks: { enabled: false } } });
    const page2 = await page.context().newPage();
    await openBrowser(page2);
    await pressPage(page2);
    await linkOut(page2, 'mailto:a@example.com');
    await page2.waitForTimeout(300);
    await expect(card(page2)).toHaveCount(0);
    // Open on this device needs nothing from anyone, so it stays.
    await expect(page2.getByTestId('browser-open-here')).toBeVisible();
  });
});

test.describe('a finished download', () => {
  const dl = (over: Record<string, unknown>) => ({ id: 'g1', name: 'report.pdf', state: 'inProgress', receivedBytes: 1, totalBytes: 4, ...over });
  test('offers Download on this device when the desk says its address, and not otherwise', async ({ page, context }) => {
    await context.route('https://files.example.com/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'x' }));
    await openBrowser(page);
    await setDownloads(page, [dl({})]);
    await expect(page.getByTestId('browser-download')).toHaveAttribute('data-kind', 'going');
    await setDownloads(page, [dl({ state: 'completed', receivedBytes: 4, url: 'https://files.example.com/report.pdf' })]);
    await expect(page.getByTestId('browser-download')).toContainText('Saved report.pdf on your desk');
    const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Download on this device' }).click()]);
    expect(popup.url()).toContain('files.example.com/report.pdf');
    await popup.close();
    // Without the address (every deskd today), or with a blob: one, no button.
    await setDownloads(page, [dl({ id: 'g2', state: 'inProgress' })]);
    await setDownloads(page, [dl({ id: 'g2', state: 'completed', receivedBytes: 4, url: 'blob:https://x.example/1' })]);
    await expect(page.getByTestId('browser-download')).toContainText('Saved report.pdf on your desk');
    await expect(page.getByTestId('browser-download-here')).toHaveCount(0);
  });
});

test.describe('More under 720 px of bar', () => {
  test('a 640 px window: Picture quality is in More, and More turns to its pages and back', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await openBrowser(page);
    await expect(page.getByTestId('quality-button')).toBeHidden();
    const more = page.getByRole('button', { name: 'More', exact: true });
    await more.click();
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu.getByRole('menuitem', { name: 'Picture quality: High' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const pq = page.getByRole('menu', { name: 'Picture quality', exact: true });
    await expect(pq).toBeVisible();
    await expect(pq.getByRole('menuitemradio', { checked: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu.getByRole('menuitem', { name: /^Picture quality/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await pq.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
    await expect(pq).toHaveCount(0);
    await more.click();
    await expect(page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Picture quality: Low' })).toBeVisible();
    // Esc gives focus back where it was before the menu, as the quality menu always has.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'More' })).toHaveCount(0);
    // Wide again: the bar's own button, and no More.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('quality-button')).toBeVisible();
    await expect(more).toBeHidden();
  });

  test('the menu’s click-away layer still covers the picture in a narrow bar', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await openBrowser(page);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const away = (await page.locator('.qm-away').boundingBox())!;
    const v = (await page.getByTestId('browser-video').boundingBox())!;
    expect(away.y + away.height).toBeGreaterThanOrEqual(v.y + v.height - 1);
  });
});

// The stills beside the spec's: the bar, the hand-off, the first-use card and More, in each theme, and on a phone.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`shots, ${theme}: the bar with Open on this device, a hand-off, and the first-use card`, async ({ page, context }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await catchHandoffs(page);
    await context.route('https://example.org/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>x</title>' }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await openBrowser(page);
    await openHere(page).hover();
    await page.waitForTimeout(700);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-bar.png` });
    await pressPage(page);
    await linkOut(page, 'mailto:hello@example.com?subject=Hello');
    await expect(card(page)).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-handoff.png` });
    await card(page).getByRole('button', { name: 'Open on this device' }).click();
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-handoff-after.png` });
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
    const [popup] = await Promise.all([context.waitForEvent('page'), openHere(page).click()]);
    await popup.close();
    await expect(page.getByTestId('browser-opened')).toBeVisible();
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-first-use.png` });
    expect(errors).toEqual([]);
  });

  test(`a phone, ${theme}: ↗ on the first row, More with Picture quality, and a call handed over`, async ({ browser }) => {
    const { ctx, page } = await phone(null, browser, theme);
    const errors = watchConsole(page);
    await catchHandoffs(page);
    await openBrowser(page);
    const out = (await page.getByTestId('browser-open-here').boundingBox())!;
    const back = (await page.getByRole('button', { name: 'Back', exact: true }).first().boundingBox())!;
    expect(Math.abs(out.y + out.height / 2 - (back.y + back.height / 2))).toBeLessThan(4);
    expect(out.x + out.width).toBeLessThanOrEqual(390);
    expect(out.width).toBeGreaterThanOrEqual(40);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-phone-bar.png` });
    await page.getByRole('button', { name: 'More', exact: true }).tap();
    await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-phone-more.png` });
    await page.getByTestId('more-quality').tap();
    await expect(page.getByRole('menu', { name: 'Picture quality', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Back' }).tap();
    await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
    await page.keyboard.press('Escape');
    // A phone can't drive the page yet (#12), so the device rule is met by a desk input stood in for here.
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="browser-video"]')!;
      v.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 100, clientY: 400, bubbles: true }));
    });
    await linkOut(page, 'tel:+15550100');
    await expect(card(page)).toBeVisible();
    const c = (await card(page).boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(7);
    expect(c.x + c.width).toBeLessThanOrEqual(383);
    const go = (await card(page).getByRole('button', { name: 'Open on this device' }).boundingBox())!;
    expect(go.height).toBeGreaterThanOrEqual(44);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-phone-handoff.png` });
    await card(page).getByRole('button', { name: 'Open on this device' }).tap();
    expect(await handed(page)).toEqual(['tel:+15550100']);
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
