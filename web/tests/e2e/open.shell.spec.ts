// Send to my desk (#9, S-141): `/open#u=…` and `/open?u=&t=&n=` (the bookmarklet, the iOS Shortcut, and the share target
// once Platform's manifest has one) and a link pasted on the office. A sheet over the office asks which desk, the link opens
// in a new tab there without the Browser window (`browser.tab.open {url, start: true}`, one idem), and the notices stack
// says so, with Show me. Signed out, the sign-in card names the link and it waits in this tab's sessionStorage. On the mock
// desk: `__maDeskMock.sleep` (a desk asleep, then Platform's wake steps), `chromiumOff` and `tabOpenStarts` (a deskd with
// and without `start`), and `refuse` (a blocked site). Light, Zen and Dark, and a 390 px phone.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

type Rpc = { m: string; p: Record<string, unknown>; options?: { idem?: string } };
type Win = {
  __maDeskMock: {
    rpc: Rpc[];
    refuse: Record<string, string>;
    refuseDetails: Record<string, unknown>;
    chromiumOff: boolean;
    tabOpenStarts: boolean;
    sleep(deskId: string, opts?: { fails?: boolean }): void;
  };
};

const URL_A = 'https://news.example.com/2026/11/quiet-desks';
const sheet = (page: Page) => page.getByRole('dialog', { name: /Open this link on a desk|There’s no web link here/ });
const notice = (page: Page) => page.getByTestId('open-notice');
const opens = (page: Page): Promise<Rpc[]> => page.evaluate(() => (window as unknown as Win).__maDeskMock.rpc.filter((r) => r.m === 'browser.tab.open'));
const setMock = (page: Page, patch: Partial<Pick<Win['__maDeskMock'], 'chromiumOff' | 'tabOpenStarts'>> & { refuse?: Record<string, string>; refuseDetails?: Record<string, unknown> }): Promise<void> =>
  page.evaluate((p) => {
    Object.assign((window as unknown as Win).__maDeskMock, p);
  }, patch);

/** Signed in first, then the address itself, as a link from the Shortcut or the bookmarklet arrives. */
async function arrive(page: Page, path: string): Promise<void> {
  await signIn(page, path);
  await canvasPainted(page);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a link from /open#u=: the sheet names it, the address bar drops it, and it opens on the chosen desk without the window', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page, `/open?fixture=three#u=${URL_A}`);
  await expect(sheet(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(page.url()).not.toContain('news.example.com');
  await expect(page.getByTestId('open-link')).toHaveText(`news.example.com${URL_A}`);
  const rows = sheet(page).getByRole('radiogroup', { name: 'Which desk' }).getByRole('radio');
  await expect(rows).toHaveText(['PersonalAwake', 'WorkAwake']); // never the Guild Desk
  await expect(sheet(page).getByRole('radio', { name: /^Personal/ })).toBeFocused();
  await expect(sheet(page)).toContainText('It opens in a new tab in that desk’s Browser, with that desk’s sign-ins.');
  await page.keyboard.press('ArrowDown');
  await expect(sheet(page).getByRole('radio', { name: /^Work/ })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet(page).getByRole('button', { name: 'Open on Work' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toHaveCount(0);
  await expect(notice(page)).toHaveAttribute('data-phase', 'done');
  await expect(notice(page)).toHaveText('news.example.com is open in a new tab on Work.Show me');
  await expect(page.getByTestId('live-region')).toHaveText('news.example.com is open in a new tab on Work.');
  const sent = await opens(page);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.p).toEqual({ url: URL_A, start: true });
  expect(sent[0]!.options?.idem).toMatch(/^[0-9a-f-]{36}$/);
  // The Browser window never opened on this device.
  await expect(page.getByTestId('browser-app')).toHaveCount(0);
  // Show me: that desk's Browser, on that tab.
  await notice(page).getByRole('button', { name: 'Show me' }).click();
  await expect(page.getByTestId('browser-app')).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as Win).__maDeskMock.rpc.filter((r) => r.m === 'browser.tab.activate').length))).toBe(1);
  expect(errors).toEqual([]);
});

test('the sheet starts on the desk used last; Cancel, Esc and the scrim put it away and open nothing', async ({ page }) => {
  await arrive(page, `/open?fixture=three#u=${URL_A}`);
  await sheet(page).getByRole('radio', { name: /^Work/ }).click();
  await sheet(page).getByRole('button', { name: 'Open on Work' }).click();
  await expect(notice(page)).toHaveAttribute('data-phase', 'done');
  await notice(page).getByRole('button', { name: 'Dismiss' }).click();
  // A paste on the office, now: Work comes first.
  await page.locator('.canvas-wrap').focus();
  await page.evaluate((u) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', `  ${u}\n`);
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, 'https://other.example.org/x');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('radio', { name: /^Work/ })).toHaveAttribute('aria-checked', 'true');
  await sheet(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet(page)).toHaveCount(0);
  for (const how of ['esc', 'scrim'] as const) {
    await page.locator('.canvas-wrap').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://other.example.org/y');
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(sheet(page)).toBeVisible();
    if (how === 'esc') await page.keyboard.press('Escape');
    else await page.mouse.click(10, 400);
    await expect(sheet(page)).toHaveCount(0);
  }
  expect(await opens(page)).toHaveLength(1);
});

test('a paste counts only on the office itself, and only as one web link', async ({ page }) => {
  await arrive(page, '/?fixture=three');
  const paste = (text: string): Promise<void> =>
    page.evaluate((t) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', t);
      (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, text);
  await page.locator('.canvas-wrap').focus();
  for (const text of ['just words', 'see https://a.example/', 'javascript:alert(1)', 'https://a.example/ https://b.example/']) await paste(text);
  await page.waitForTimeout(300);
  await expect(sheet(page)).toHaveCount(0);
  // In a field (the Browser's address), it's the field's.
  await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  await page.getByTestId('browser-address').focus();
  await paste('https://a.example/');
  await page.waitForTimeout(300);
  await expect(sheet(page)).toHaveCount(0);
  // The account menu lists it.
  await page.keyboard.press('Escape');
});

test('one desk: no choice, just where it opens; asleep, it says it wakes, and the notice follows the wake', async ({ page }) => {
  await arrive(page, `/open?fixture=one&wakeStepMs=1500#u=${URL_A}`);
  await expect(page.getByTestId('open-one')).toHaveText('Opens on Personal.');
  await expect(sheet(page).getByRole('radiogroup')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as Win).__maDeskMock.sleep('d-personal'));
  await expect(page.getByTestId('open-one')).toHaveText('Opens on Personal, which is asleep and wakes to open it.');
  await sheet(page).getByRole('button', { name: 'Open on Personal' }).click();
  await expect(notice(page)).toHaveAttribute('data-phase', 'waking');
  await expect(notice(page)).toContainText(/^Opening news\.example\.com on Personal · waking, [12] of 4$/);
  await expect(notice(page)).toContainText('waking, 2 of 4');
  await expect(notice(page)).toContainText('waking, 3 of 4');
  await expect(notice(page)).toHaveAttribute('data-phase', 'done', { timeout: 10_000 });
  await expect(page.getByTestId('browser-app')).toHaveCount(0);
});

test('Stop ends the wait and nothing opens; a desk that never wakes says so', async ({ page }) => {
  test.setTimeout(60_000);
  await arrive(page, `/open?fixture=one#u=${URL_A}`);
  await page.evaluate(() => (window as unknown as Win).__maDeskMock.sleep('d-personal', { fails: true }));
  await sheet(page).getByRole('button', { name: 'Open on Personal' }).click();
  await expect(notice(page)).toHaveAttribute('data-phase', 'waking');
  await notice(page).getByRole('button', { name: 'Stop' }).click();
  await expect(notice(page)).toHaveCount(0);
  expect(await opens(page)).toHaveLength(0);
});

test('a deskd without start: today’s order, the window first and then the tab, with the same key; with start, no window', async ({ page }) => {
  await arrive(page, `/open?fixture=one#u=${URL_A}`);
  await setMock(page, { chromiumOff: true, tabOpenStarts: false });
  await sheet(page).getByRole('button', { name: 'Open on Personal' }).click();
  await expect(page.getByTestId('browser-app')).toBeVisible();
  await expect(notice(page)).toHaveAttribute('data-phase', 'done', { timeout: 15_000 });
  const sent = await opens(page);
  expect(sent.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sent.map((r) => r.options?.idem)).size).toBe(1);
});

test('a deskd with start opens it with Chromium asleep, and no window', async ({ page }) => {
  await arrive(page, `/open?fixture=one#u=${URL_A}`);
  await setMock(page, { chromiumOff: true, tabOpenStarts: true });
  await sheet(page).getByRole('button', { name: 'Open on Personal' }).click();
  await expect(notice(page)).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('browser-app')).toHaveCount(0);
  expect(await opens(page)).toHaveLength(1);
});

test('a site the desk’s Browser blocks, and any other failure, each with Try again', async ({ page }) => {
  await arrive(page, `/open?fixture=one#u=https://example.com/page`);
  await setMock(page, { refuse: { 'browser.tab.open': 'forbidden' }, refuseDetails: { reason: 'blocked' } });
  await sheet(page).getByRole('button', { name: 'Open on Personal' }).click();
  await expect(notice(page)).toHaveText('example.com can’t open on Personal: its Browser blocks this site.Try again');
  await setMock(page, { refuse: { 'browser.tab.open': 'internal' }, refuseDetails: {} });
  await notice(page).getByRole('button', { name: 'Try again' }).click();
  await expect(notice(page)).toHaveText('example.com didn’t open on Personal.Try again');
  await setMock(page, { refuse: {} });
  await notice(page).getByRole('button', { name: 'Try again' }).click();
  await expect(notice(page)).toHaveAttribute('data-phase', 'done');
  expect(new Set((await opens(page)).map((r) => r.options?.idem)).size).toBe(1);
});

test('no web link: the sheet says so and shows what came in; only http and https', async ({ page }) => {
  await arrive(page, '/open?fixture=one#u=javascript:alert(1)');
  await expect(sheet(page)).toHaveAttribute('data-kind', 'none');
  await expect(page.getByRole('heading', { name: 'There’s no web link here' })).toBeVisible();
  await expect(sheet(page)).toContainText('Only addresses that start with http or https can open on a desk. This is what came in:');
  await expect(sheet(page)).toContainText('javascript:alert(1)');
  await expect(sheet(page).getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toHaveCount(0);
});

test('Android’s share target: the first link in the text', async ({ page }) => {
  await arrive(page, `/open?fixture=one&t=${encodeURIComponent(`Worth a read ${URL_A}`)}&n=Quiet%20desks`);
  await expect(page.getByTestId('open-link')).toHaveText(`news.example.com${URL_A}`);
  expect(page.url()).not.toContain('news.example.com');
});

test('signed out: the card names the link, it waits in this tab only, and the sheet comes after sign-in', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto(`/open#u=${URL_A}`);
  await expect(page.getByRole('heading', { name: 'Sign in to open this link' })).toBeVisible();
  await expect(page.getByTestId('open-link')).toHaveText(`news.example.com${URL_A}`);
  await expect(page.getByTestId('sign-in')).toContainText('After you sign in, you’ll choose which desk opens it.');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(page.url()).not.toContain('news.example.com');
  const kept = await page.evaluate(() => [sessionStorage.getItem('ma-open-pending'), Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? '').includes('news.example.com'))]);
  expect(JSON.parse(kept[0] as string)).toMatchObject({ url: URL_A });
  expect(kept[1]).toEqual([]);
  const trips: string[] = [];
  page.on('request', (r) => trips.push(r.url()));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId('open-link')).toHaveText(`news.example.com${URL_A}`);
  // Read once: gone from the tab, and never in a sign-in's address.
  expect(await page.evaluate(() => sessionStorage.getItem('ma-open-pending'))).toBeNull();
  expect(trips.filter((u) => u.includes('news.example.com'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('the kill switch: /open is the office, a paste does nothing, and signed out it goes to sign in as ever', async ({ page, request }) => {
  await harness(request, { configExtra: { browserLinks: { enabled: false } } });
  await arrive(page, `/open?fixture=one#u=${URL_A}`);
  await page.waitForTimeout(400);
  await expect(sheet(page)).toHaveCount(0);
  expect(page.url()).not.toContain('news.example.com');
  await page.locator('.canvas-wrap').focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://a.example/');
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await expect(sheet(page)).toHaveCount(0);
  const out = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
  const p2 = await out.newPage();
  await p2.goto(`/open#u=${URL_A}`);
  // Off, nothing holds sign-in up: the fake sign-in answers at once, as managed login does, and the office has no sheet.
  await expect(p2.locator('.ma-shell')).toBeVisible();
  await p2.waitForTimeout(400);
  await expect(sheet(p2)).toHaveCount(0);
  expect(await p2.evaluate(() => sessionStorage.getItem('ma-open-pending'))).toBeNull();
  await out.close();
});

test('the account menu’s shortcuts list the paste', async ({ page }) => {
  await arrive(page, '/?fixture=one');
  await page.getByRole('button', { name: /^Account/ }).click();
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await expect(page.getByTestId('shortcut-paste-link')).toHaveText(/^(Ctrl\+V|⌘V)Open a copied link on a desk$/);
});

// The stills beside the spec's: the sheet with two desks, the waking and done lines, a failure, and the signed-out card.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`shots, ${theme}`, async ({ page, browser }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await arrive(page, `/open?fixture=three&wakeStepMs=1500#u=${URL_A}`);
    await page.evaluate(() => (window as unknown as Win).__maDeskMock.sleep('d-work'));
    await sheet(page).getByRole('radio', { name: /^Work/ }).click();
    await page.waitForTimeout(250);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-send-sheet.png` });
    await sheet(page).getByRole('button', { name: 'Open on Work' }).click();
    await expect(notice(page)).toContainText('waking, 2 of 4');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-send-waking.png` });
    await expect(notice(page)).toHaveAttribute('data-phase', 'done', { timeout: 15_000 });
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-send-done.png` });
    await notice(page).getByRole('button', { name: 'Dismiss' }).click();
    await setMock(page, { refuse: { 'browser.tab.open': 'forbidden' }, refuseDetails: { reason: 'blocked' } });
    await page.locator('.canvas-wrap').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'https://example.com/');
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sheet(page).getByRole('button', { name: /^Open on/ }).click();
    await expect(notice(page)).toHaveAttribute('data-phase', 'failed');
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-send-failed.png` });

    const out = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1280, height: 800 } });
    const p2 = await out.newPage();
    await setTheme(p2, theme);
    await p2.goto(`/open#u=${URL_A}`);
    await expect(p2.getByRole('heading', { name: 'Sign in to open this link' })).toBeVisible();
    await p2.waitForTimeout(300); // past the card's 160 ms arrival
    await p2.screenshot({ path: `test-results/shots/links9-${theme}-send-signed-out.png` });
    await out.close();
    expect(errors).toEqual([]);
  });

  test(`a phone, ${theme}: the bottom sheet with full-width buttons, primary on top, and the done line`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page, `/open?fixture=three#u=${URL_A}`);
    const box = (await sheet(page).boundingBox())!;
    expect(box.width).toBe(390);
    expect(Math.round(box.y + box.height)).toBe(844);
    const go = (await sheet(page).getByRole('button', { name: /^Open on/ }).boundingBox())!;
    const cancel = (await sheet(page).getByRole('button', { name: 'Cancel' }).boundingBox())!;
    expect(go.y).toBeLessThan(cancel.y);
    expect(go.height).toBe(48);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-phone-send-sheet.png` });
    await sheet(page).getByRole('button', { name: /^Open on/ }).tap();
    await expect(notice(page)).toHaveAttribute('data-phase', 'done');
    const n = (await notice(page).boundingBox())!;
    expect(n.x).toBeGreaterThanOrEqual(0);
    expect(n.x + n.width).toBeLessThanOrEqual(390);
    await page.waitForTimeout(300); // past the card's 160 ms arrival
    await page.screenshot({ path: `test-results/shots/links9-${theme}-phone-send-done.png` });
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
