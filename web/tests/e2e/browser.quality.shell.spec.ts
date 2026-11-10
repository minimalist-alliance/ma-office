// The Browser's picture quality menu (ADR 0039, phase 1): its button at the end of the bar, the five choices and
// their words, the keyboard, that a choice is the desk's alone and never goes to Platform (the owner's rule: the
// account sets a default, a desk overrides it; harness/streamQuality.mjs answers the account's as ma-platform's
// contract stream-quality.md does), a reload, the stream's focus, and a phone. No fixture, so the store reaches the
// harness: the desk list is the harness's, on the mock link.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const ME = 'u-test';
/** The harness's one desk. */
const DESK = 'd-testk3m7q2x';
const DESK_KEY = 'ma.streamQuality.desks.v1';

interface Put { user: string; body: string; status: number }
interface Doc { default: string; apps: Record<string, string>; updatedAt: string | null }
interface Harness { streamQualityPuts?: Put[]; streamQualityDocs?: Record<string, Doc> }
type Win = { __maDeskMock: { input: { channel: string; bytes: number[] }[] } };

const server = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const puts = async (request: APIRequestContext): Promise<Put[]> => (await server(request)).streamQualityPuts ?? [];
/** The app's own console errors. A browser logs a failed request by itself, and no app code can stop that. */
const ownErrors = (errors: string[]): string[] => errors.filter((e) => !e.includes('Failed to load resource'));

const button = (page: Page): Locator => page.getByRole('button', { name: /^Picture quality/ });
const menu = (page: Page): Locator => page.getByRole('menu', { name: 'Picture quality' });
const choice = (page: Page, name: string): Locator => menu(page).getByRole('menuitemradio', { name, exact: true });
const accountLink = (page: Page): Locator => menu(page).getByRole('menuitem', { name: 'Change your default' });
const notice = (page: Page): Locator => page.getByTestId('quality-notice');
const kept = (page: Page): Promise<unknown> => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), DESK_KEY);

async function openBrowser(page: Page): Promise<void> {
  await canvasPainted(page);
  await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-chrome')).toBeVisible();
  await expect(page.getByTestId('browser-panel')).toHaveCount(0);
  await page.waitForTimeout(300); // the window's opening move
}

async function open(page: Page): Promise<void> {
  await signIn(page);
  await openBrowser(page);
}

async function pick(page: Page, name: string): Promise<void> {
  await button(page).click();
  await choice(page, name).click();
  await expect(menu(page)).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the button, the five choices with their words and data, the footer, and a screenshot`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // At the end of the bar, after the address.
    const last = await page.locator('.br-bar > :last-child button').first().getAttribute('aria-label');
    expect(last).toBe('Picture quality: High');
    await expect(button(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button(page)).toHaveAttribute('aria-expanded', 'false');

    await button(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
    const items = menu(page).getByRole('menuitemradio');
    await expect(items).toHaveCount(5);
    const names = await items.evaluateAll((els) => els.map((el) => el.getAttribute('aria-labelledby')!.split(' ').map((id) => document.getElementById(id)!.textContent).join(' ')));
    expect(names).toEqual(['Use my default (High)', 'Low', 'Medium', 'High', 'Max']);
    await expect(choice(page, 'Use my default (High)')).toHaveAttribute('aria-checked', 'true');
    for (const name of ['Low', 'Medium', 'High', 'Max']) await expect(choice(page, name)).toHaveAttribute('aria-checked', 'false');
    await expect(choice(page, 'Low')).toHaveAccessibleDescription('Uses the least data. Text and video look softer. Up to 1.2 GB an hour');
    await expect(choice(page, 'Medium')).toHaveAccessibleDescription('Sharp text, softer video. About half the data of High. Up to 1.8 GB an hour');
    await expect(choice(page, 'High')).toHaveAccessibleDescription('Sharp text and clear video. Up to 3.6 GB an hour');
    await expect(choice(page, 'Max')).toHaveAccessibleDescription('The sharpest picture, for photos and fine detail. Uses the most data and needs a fast connection. Up to 5.4 GB an hour');
    await expect(menu(page)).toHaveAccessibleDescription('Every level is just as smooth and quick.');
    await expect(menu(page).getByText('Every level is just as smooth and quick.')).toBeVisible();
    // Account settings, over the office (ADR 0052), so this tab keeps the member's windows. No "(opens in a new tab)".
    await expect(accountLink(page)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(accountLink(page)).toHaveText('Change your default');
    // The menu's colors are the theme's tokens.
    const [bg, overlay] = await menu(page).evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--ma-surface-overlay').trim()]);
    const probe = await page.evaluate((c) => {
      const el = document.createElement('div');
      el.style.color = c;
      document.body.append(el);
      const out = getComputedStyle(el).color;
      el.remove();
      return out;
    }, overlay);
    expect(bg).toBe(probe);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-quality.png` });
    expect(errors).toEqual([]);
  });
}

test('choosing Low is this desk\'s alone: kept in this browser, nothing goes to Platform, and Use my default follows the account again', async ({ page, request }) => {
  const errors = watchConsole(page);
  await open(page);
  await pick(page, 'Low');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: { [DESK]: { browser: 'low' } } });

  await button(page).click();
  await expect(choice(page, 'Low')).toHaveAttribute('aria-checked', 'true');
  await expect(choice(page, 'Use my default (High)')).toHaveAttribute('aria-checked', 'false');
  await choice(page, 'Use my default (High)').click();
  await expect(button(page)).toHaveAccessibleName('Picture quality: High');
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: {} });
  await pick(page, 'Use my default (High)');
  await page.waitForTimeout(300);
  // The account's document is the member's on every desk: no desk's menu changes it.
  expect(await puts(request)).toEqual([]);
  expect((await server(request)).streamQualityDocs?.[ME]).toBeUndefined();
  await expect(notice(page)).toBeEmpty();
  expect(errors).toEqual([]);
});

test('finding 5: Low chosen on Personal stays on Personal, and Work follows the account', async ({ page, request }) => {
  const errors = watchConsole(page);
  const PERSONAL = 'd-personal00001';
  const WORK = 'd-work000000001';
  await harness(request, {
    fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }],
    streamQualityDocs: { [ME]: { default: 'medium', apps: {}, updatedAt: '2026-11-06T10:00:00.000Z' } },
  });
  await signIn(page);
  await canvasPainted(page);
  const browserOn = async (desk: string, deskId: string): Promise<Locator> => {
    await page.getByRole('group', { name: `${desk} desk` }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
    const win = page.locator(`[data-testid="window-browser"][data-desk="${deskId}"]`);
    await expect(win).toBeVisible();
    await page.waitForTimeout(300); // the window's opening move
    return win;
  };
  const personal = await browserOn('Personal', PERSONAL);
  const personalButton = personal.getByRole('button', { name: /^Picture quality/ });
  await expect(personalButton).toHaveAccessibleName('Picture quality: Medium');
  await personalButton.click();
  await choice(page, 'Low').click();
  await expect(personalButton).toHaveAccessibleName('Picture quality: Low');
  await personal.getByRole('button', { name: 'Close Browser' }).click();

  const work = await browserOn('Work', WORK);
  const workButton = work.getByRole('button', { name: /^Picture quality/ });
  await expect(workButton).toHaveAccessibleName('Picture quality: Medium');
  await workButton.click();
  await expect(choice(page, 'Use my default (Medium)')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  expect(await kept(page)).toEqual({ sub: ME, desks: { [PERSONAL]: { browser: 'low' } } });
  expect(await puts(request)).toEqual([]);
  await work.getByRole('button', { name: 'Close Browser' }).click();

  // The account's level moves Work, and not Personal, which has its own.
  await harness(request, { streamQualityDocs: { [ME]: { default: 'max', apps: {}, updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  await page.reload();
  await canvasPainted(page);
  await expect((await browserOn('Work', WORK)).getByRole('button', { name: /^Picture quality/ })).toHaveAccessibleName('Picture quality: Max');
  await work.getByRole('button', { name: 'Close Browser' }).click();
  await expect((await browserOn('Personal', PERSONAL)).getByRole('button', { name: /^Picture quality/ })).toHaveAccessibleName('Picture quality: Low');
  await page.screenshot({ path: 'test-results/shots/light-browser-quality-per-desk.png' });
  expect(errors).toEqual([]);
});

test("the default's name follows the member's account default", async ({ page, request }) => {
  await harness(request, { streamQualityDocs: { [ME]: { default: 'medium', apps: {}, updatedAt: '2026-11-06T10:00:00.000Z' } } });
  await open(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Medium');
  await button(page).click();
  await expect(choice(page, 'Use my default (Medium)')).toHaveAttribute('aria-checked', 'true');
});

test('by keyboard: Enter opens on the checked item, arrows, Home and End move, Space chooses, Esc gives the button back', async ({ page, request }) => {
  const errors = watchConsole(page);
  await open(page);
  await button(page).focus();
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeVisible();
  await expect(choice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, 'Low')).toBeFocused();
  await page.keyboard.press('End');
  await expect(accountLink(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(accountLink(page)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(choice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(button(page)).toBeFocused();
  // The shell never heard that Esc: the window is still open, on the desk.
  await expect(page.getByTestId('window-browser')).toBeVisible();

  // ArrowUp on the button opens on the last item, Tab leaves for the button.
  await page.keyboard.press('ArrowUp');
  await expect(accountLink(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu(page)).toHaveCount(0);
  await expect(button(page)).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(choice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, 'Medium')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(menu(page)).toHaveCount(0);
  await expect(button(page)).toBeFocused();
  await expect(button(page)).toHaveAccessibleName('Picture quality: Medium');

  // Enter opens on what's checked now, and Enter chooses.
  await page.keyboard.press('Enter');
  await expect(choice(page, 'Medium')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(button(page)).toHaveAccessibleName('Picture quality: High');
  await expect(button(page)).toBeFocused();
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: { [DESK]: { browser: 'high' } } });
  expect(await puts(request)).toEqual([]);
  expect(errors).toEqual([]);
});

test("a desk's choice never waits on Platform: with the account's route failing or missing, it holds and nothing is said", async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { streamQualityFail: { status: 503 }, streamQualityDelayMs: 500 });
  await open(page);
  await pick(page, 'Max');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max');
  await page.waitForTimeout(1_000);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max');
  await expect(notice(page)).toBeEmpty();
  await harness(request, { streamQualityFail: null, streamQualityDelayMs: 0, streamQualityMissing: true });
  await pick(page, 'Low');
  await page.waitForTimeout(500);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect(notice(page)).toBeEmpty();
  expect(await puts(request)).toEqual([]);
  expect(ownErrors(errors)).toEqual([]);
});

test("a reload keeps the desk's choice from this browser, before and after Platform answers, over the account's", async ({ page, request }) => {
  await open(page);
  await pick(page, 'Low');
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: { [DESK]: { browser: 'low' } } });

  // Platform held back: only this browser's copy can say.
  let release = (): void => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  const going: Promise<void>[] = [];
  await page.route('**/v1/me', (route) => {
    going.push(held.then(() => route.continue()));
  });
  await page.reload();
  await openBrowser(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  expect(going.length).toBeGreaterThan(0); // the reads it painted ahead of
  release();
  await Promise.all(going);
  await page.unroute('**/v1/me');

  // Another device set Max for the Browser on the account: this desk keeps its own, and its default names the account's.
  await harness(request, { streamQualityDocs: { [ME]: { default: 'high', apps: { browser: 'max' }, updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  await page.reload();
  await openBrowser(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await pick(page, 'Use my default (Max)');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max');
});

test("another member's copy in this browser is never used", async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ma.streamQuality.v1', JSON.stringify({ sub: 'u-someone-else', doc: { default: 'low', apps: { browser: 'low' }, updatedAt: '2026-11-06T10:00:00.000Z' } }));
    localStorage.setItem('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-someone-else', desks: { 'd-testk3m7q2x': { browser: 'max' } } }));
  });
  await harness(request, { streamQualityMissing: true }); // Platform says nothing, so only the copy could
  await open(page);
  await page.waitForTimeout(500);
  await expect(button(page)).toHaveAccessibleName('Picture quality: High');
});

test('from the stream and back: a choice gives the keyboard back to the page, and a click away never reaches it', async ({ page }) => {
  const errors = watchConsole(page);
  await open(page);
  const video = page.getByTestId('browser-video');
  const v = (await video.boundingBox())!;
  await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
  await expect(page.getByTestId('browser-keys')).toBeFocused();

  await pick(page, 'Low');
  await expect(page.getByTestId('browser-keys')).toBeFocused();
  await expect(page.getByTestId('browser-focus-hint')).toBeVisible();
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: { [DESK]: { browser: 'low' } } });

  // Opening it and clicking on the picture only closes it: no button reaches the desk.
  const buttons = (): Promise<number> => page.evaluate(() => (window as unknown as Win).__maDeskMock.input.filter((e) => e.channel === 'input' && e.bytes[0] === 2).length);
  const before = await buttons();
  await button(page).click();
  await expect(menu(page)).toBeVisible();
  await page.mouse.click(v.x + 40, v.y + v.height - 40);
  await expect(menu(page)).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await buttons()).toBe(before);
  await expect(page.getByTestId('browser-keys')).toBeFocused();
  expect(errors).toEqual([]);
});

test('a phone: the menu fits inside the window, and a finger chooses', async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  const errors = watchConsole(page);
  await open(page);
  await button(page).tap();
  await expect(menu(page)).toBeVisible();
  const win = (await page.getByTestId('window-browser').boundingBox())!;
  expect(win.width).toBe(390); // a full-screen sheet
  const box = (await menu(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(win.x);
  expect(box.x + box.width).toBeLessThanOrEqual(win.x + win.width);
  expect(box.y + box.height).toBeLessThanOrEqual(win.y + win.height);
  await expect(choice(page, 'Max')).toBeInViewport();
  await page.screenshot({ path: 'test-results/shots/phone-browser-quality.png' });
  await choice(page, 'Low').tap();
  await expect(menu(page)).toHaveCount(0);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  expect(await puts(request)).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
