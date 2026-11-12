// The Browser's picture quality menu (ADR 0039, S-83): its button at the end of the bar, the five choices and their
// words, "This desk" and its page, the keyboard, the layers (the owner's rule: the account sets a default, a desk
// overrides it, an app on the desk overrides the desk), each saved to Platform for that desk alone
// (harness/streamQuality.mjs answers as ma-platform's contract stream-quality.md 0.3.70 does), a Platform from before
// the desk layer, moving this browser's old copy over, a reload, the stream's focus, and a phone in three themes. No
// fixture, so the store reaches the harness: the desk list is the harness's, on the mock link.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const ME = 'u-test';
/** The harness's one desk. */
const DESK = 'd-testk3m7q2x';
const DESK_KEY = 'ma.streamQuality.desks.v1';

interface Put { user: string; body: string; status: number }
interface Doc { default: string | null; apps: Record<string, string>; desks?: Record<string, { level: string | null; apps: Record<string, string> }>; updatedAt: string | null }
interface Harness { streamQualityPuts?: Put[]; streamQualityDocs?: Record<string, Doc> }
type Win = { __maDeskMock: { input: { channel: string; bytes: number[] }[] } };

const server = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const puts = async (request: APIRequestContext): Promise<Put[]> => (await server(request)).streamQualityPuts ?? [];
/** The bodies Platform took, in order. */
const sent = async (request: APIRequestContext): Promise<unknown[]> => (await puts(request)).map((p) => JSON.parse(p.body) as unknown);
/** The member's document as Platform has it. */
const onPlatform = async (request: APIRequestContext): Promise<Doc | undefined> => (await server(request)).streamQualityDocs?.[ME];
/** The app's own console errors. A browser logs a failed request by itself, and no app code can stop that. */
const ownErrors = (errors: string[]): string[] => errors.filter((e) => !e.includes('Failed to load resource'));

const button = (page: Page): Locator => page.getByRole('button', { name: /^Picture quality/ });
const menu = (page: Page): Locator => page.getByRole('menu', { name: 'Picture quality', exact: true });
const choice = (page: Page, name: string): Locator => menu(page).getByRole('menuitemradio', { name, exact: true });
const accountLink = (page: Page): Locator => menu(page).getByRole('menuitem', { name: 'Change your default' });
const deskMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Picture quality for this desk' });
const deskRow = (page: Page): Locator => page.getByTestId('quality-desk-row');
const deskChoice = (page: Page, name: string): Locator => deskMenu(page).getByRole('menuitemradio', { name, exact: true });
const notice = (page: Page): Locator => page.getByTestId('quality-notice');
/** Under 720 px of bar (#9): the Browser's More, and its Picture quality row. */
const more = (page: Page): Locator => page.getByRole('button', { name: 'More', exact: true });
const moreRow = (page: Page): Locator => page.getByTestId('more-quality');
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

/** Opens "This desk" and picks a level there. */
async function pickForDesk(page: Page, name: string): Promise<void> {
  await button(page).click();
  await deskRow(page).click();
  await deskChoice(page, name).click();
  await expect(menu(page)).toHaveCount(0);
  await expect(deskMenu(page)).toHaveCount(0);
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: the button, the five choices with their words and data, This desk, the footer, and screenshots`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // At the end of the bar, after the address: the last of the bar's tools on a wide bar (#11's key and Extensions come first).
    const last = await page.locator('.br-bar > :last-child > .br-wide > button').last().getAttribute('aria-label');
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
    // This desk: what it follows, and a way into its own page.
    await expect(deskRow(page)).toHaveAccessibleName('This desk: My default');
    await expect(deskRow(page)).toHaveAttribute('role', 'menuitem');
    await expect(deskRow(page)).toHaveAttribute('aria-haspopup', 'menu');
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

    // This desk's own page.
    await deskRow(page).click();
    await expect(deskMenu(page)).toBeVisible();
    await expect(deskMenu(page).getByRole('menuitemradio')).toHaveCount(5);
    await expect(deskChoice(page, 'Use my default (High)')).toHaveAttribute('aria-checked', 'true');
    await expect(deskChoice(page, 'Use my default (High)')).toBeFocused();
    await expect(deskMenu(page)).toHaveAccessibleDescription('For every app on this desk, unless the app has its own level.');
    await expect(deskMenu(page).getByRole('menuitem', { name: 'Back' })).toBeVisible();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/shots/${theme}-browser-quality-desk.png` });
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeVisible();
    await expect(deskRow(page)).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("choosing Low is this desk's Browser's own, saved to Platform for this desk only, and Use my default follows again", async ({ page, request }) => {
  const errors = watchConsole(page);
  await open(page);
  await pick(page, 'Low');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect.poll(() => sent(request)).toEqual([{ desks: { [DESK]: { apps: { browser: 'low' } } } }]);
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: null, apps: { browser: 'low' } } });
  expect((await onPlatform(request))?.default ?? null, 'the account is untouched').toBeNull();
  expect(await kept(page), 'nothing kept in this browser alone').toBeNull();

  await button(page).click();
  await expect(choice(page, 'Low')).toHaveAttribute('aria-checked', 'true');
  await expect(choice(page, 'Use my default (High)')).toHaveAttribute('aria-checked', 'false');
  await choice(page, 'Use my default (High)').click();
  await expect(button(page)).toHaveAccessibleName('Picture quality: High');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({});
  await expect(notice(page)).toBeEmpty();
  expect(errors).toEqual([]);
});

test('This desk: its own level for every app on it, under the Browser\'s own there, each cleared back to the layer above', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { streamQualityDocs: { [ME]: { default: 'medium', apps: {}, desks: {}, updatedAt: '2026-11-06T10:00:00.000Z' } } });
  await open(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Medium');
  await pickForDesk(page, 'Low');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: 'low', apps: {} } });

  // The Browser follows the desk now, and says so; its own level goes over it.
  await button(page).click();
  await expect(choice(page, "Use this desk's level (Low)")).toHaveAttribute('aria-checked', 'true');
  await expect(deskRow(page)).toHaveAccessibleName('This desk: Low');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/shots/light-browser-quality-desk-set.png' });
  await choice(page, 'Max').click();
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: 'low', apps: { browser: 'max' } } });
  // A desk's own under the Browser's: the button still says the Browser's.
  await pickForDesk(page, 'Medium');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: 'medium', apps: { browser: 'max' } } });
  await pick(page, "Use this desk's level (Medium)");
  await expect(button(page)).toHaveAccessibleName('Picture quality: Medium');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: 'medium', apps: {} } });
  await pickForDesk(page, 'Use my default (Medium)');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Medium');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({});
  expect(await sent(request)).toEqual([
    { desks: { [DESK]: { level: 'low' } } },
    { desks: { [DESK]: { apps: { browser: 'max' } } } },
    { desks: { [DESK]: { level: 'medium' } } },
    { desks: { [DESK]: { apps: { browser: null } } } },
    { desks: { [DESK]: { level: null } } },
  ]);
  expect(errors).toEqual([]);
});

test('finding 5: Low chosen on Personal stays on Personal, and Work follows the account', async ({ page, request }) => {
  const errors = watchConsole(page);
  const PERSONAL = 'd-personal00001';
  const WORK = 'd-work000000001';
  await harness(request, {
    fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }, { deskId: WORK, name: 'Work', kind: 'work', state: 'running' }],
    streamQualityDocs: { [ME]: { default: 'medium', apps: {}, desks: {}, updatedAt: '2026-11-06T10:00:00.000Z' } },
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
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [PERSONAL]: { level: null, apps: { browser: 'low' } } });
  await work.getByRole('button', { name: 'Close Browser' }).click();

  // The account's level moves Work, and not Personal, which has its own; read from Platform, so any browser sees it.
  await harness(request, { streamQualityDocs: { [ME]: { ...(await onPlatform(request))!, default: 'max', updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  await page.evaluate(() => localStorage.removeItem('ma.streamQuality.v1')); // nothing of it in this browser: Platform's word only
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

test('by keyboard: Enter opens on the checked item, arrows, Home and End move, Right into This desk and Left back, Space chooses, Esc gives the button back', async ({ page, request }) => {
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
  await page.keyboard.press('ArrowUp');
  await expect(deskRow(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(choice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(accountLink(page)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(choice(page, 'Use my default (High)')).toBeFocused();

  // Into This desk and out again, by Right and Left, then Enter and Esc.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect(deskChoice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(deskRow(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(deskChoice(page, 'Use my default (High)')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(deskMenu(page).getByRole('menuitem', { name: 'Back' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(deskRow(page)).toBeFocused();
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
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: null, apps: { browser: 'high' } } });
  expect(errors).toEqual([]);
});

test('a failed save puts the choice back and says so, and the next choice goes', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { streamQualityFail: { status: 503, times: 1 }, streamQualityDelayMs: 300 });
  await open(page);
  await pick(page, 'Max');
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max'); // at once
  await expect(notice(page)).toHaveText("That didn't save. Try again in a moment.");
  await expect(button(page)).toHaveAccessibleName('Picture quality: High');
  await pick(page, 'Low');
  await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: null, apps: { browser: 'low' } } });
  await expect(notice(page)).toBeEmpty();
  expect(ownErrors(errors)).toEqual([]);
});

test('a Platform from before the desk layer: the choice holds in this browser, nothing is sent, and This desk isn\'t offered', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { streamQualityBefore: true });
  await open(page);
  await button(page).click();
  await expect(deskRow(page)).toHaveCount(0);
  await expect(menu(page).getByRole('menuitemradio')).toHaveCount(5);
  await choice(page, 'Low').click();
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: { [DESK]: { browser: 'low' } } });
  await page.waitForTimeout(300);
  expect(await puts(request)).toEqual([]);
  await page.reload();
  await openBrowser(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect(notice(page)).toBeEmpty();
  expect(ownErrors(errors)).toEqual([]);
});

test("once Platform has the desk layer, this browser's old copy moves over, once and quietly, and its level holds throughout", async ({ page, request }) => {
  const errors = watchConsole(page);
  await page.addInitScript(([key, sub, desk]) => {
    // What the member's earlier visit left: on the first load that's signed in or finishing a sign-in, since a start with
    // nobody signed in wipes the member's caches (ISS-89), as it does the layout's mirror.
    if (sessionStorage.getItem('moved-once') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    sessionStorage.setItem('moved-once', '1');
    localStorage.setItem(key, JSON.stringify({ sub, desks: { [desk]: { browser: 'low' } } }));
  }, [DESK_KEY, ME, DESK] as const);
  await open(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await expect.poll(() => sent(request)).toEqual([{ desks: { [DESK]: { apps: { browser: 'low' } } } }]);
  await expect.poll(() => kept(page)).toEqual({ sub: ME, desks: {} });
  await expect(notice(page)).toBeEmpty();
  await page.reload();
  await openBrowser(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Low');
  await page.waitForTimeout(300);
  expect(await puts(request), 'moved once').toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a reload paints the desk's choice from this browser's mirror before Platform answers, and another device's change arrives", async ({ page, request }) => {
  await open(page);
  await pick(page, 'Low');
  await expect.poll(async () => (await onPlatform(request))?.desks?.[DESK]?.apps).toEqual({ browser: 'low' });
  // Platform's answer is in this browser's mirror.
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('ma.streamQuality.v1') ?? 'null') as { doc?: Doc } | null)?.doc?.desks)).toEqual({ [DESK]: { level: null, apps: { browser: 'low' } } });

  // Platform held back: only this browser's mirror can say.
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

  // Another device set this desk's own level to Max and cleared the Browser's: Platform's word wins at the next read.
  await harness(request, { streamQualityDocs: { [ME]: { default: null, apps: {}, desks: { [DESK]: { level: 'max', apps: {} } }, updatedAt: new Date(Date.now() + 1000).toISOString() } } });
  await page.reload();
  await openBrowser(page);
  await expect(button(page)).toHaveAccessibleName('Picture quality: Max');
  await button(page).click();
  await expect(choice(page, "Use this desk's level (Max)")).toHaveAttribute('aria-checked', 'true');
});

test("another member's copy in this browser is never used", async ({ page, request }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ma.streamQuality.v1', JSON.stringify({ sub: 'u-someone-else', doc: { default: 'low', apps: { browser: 'low' }, desks: {}, updatedAt: '2026-11-06T10:00:00.000Z' }, layered: true }));
    localStorage.setItem('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-someone-else', desks: { 'd-testk3m7q2x': { browser: 'max' } } }));
  });
  await harness(request, { streamQualityMissing: true }); // Platform says nothing, so only the copy could
  await open(page);
  await page.waitForTimeout(500);
  await expect(button(page)).toHaveAccessibleName('Picture quality: High');
});

test('from the stream and back: a choice gives the keyboard back to the page, and a click away never reaches it', async ({ page, request }) => {
  const errors = watchConsole(page);
  await open(page);
  const video = page.getByTestId('browser-video');
  const v = (await video.boundingBox())!;
  await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
  await expect(page.getByTestId('browser-keys')).toBeFocused();

  await pick(page, 'Low');
  await expect(page.getByTestId('browser-keys')).toBeFocused();
  await expect(page.getByTestId('browser-focus-hint')).toBeVisible();
  await expect.poll(async () => (await onPlatform(request))?.desks?.[DESK]?.apps).toEqual({ browser: 'low' });

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

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`a phone, ${theme}: Picture quality is in More (#9), the menu and This desk fit inside the window, and a finger chooses`, async ({ browser, request }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const page = await ctx.newPage();
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await open(page);
    // Under 720 px of bar the bar's own button folds into More, whose first row turns to these pages.
    await expect(button(page)).toBeHidden();
    await more(page).tap();
    await expect(moreRow(page)).toHaveAccessibleName('Picture quality: High');
    await moreRow(page).tap();
    await expect(menu(page)).toBeVisible();
    // A full-screen sheet: the desk's carousel on a phone (carousel.phone.shell.spec.ts), named by its app as a window is.
    const win = (await page.getByRole('dialog', { name: /Browser/ }).boundingBox())!;
    expect(win.width).toBe(390);
    const inWindow = async (m: Locator): Promise<void> => {
      const box = (await m.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(win.x);
      expect(box.x + box.width).toBeLessThanOrEqual(win.x + win.width);
      expect(box.y + box.height).toBeLessThanOrEqual(win.y + win.height);
    };
    await inWindow(menu(page));
    await expect(choice(page, 'Max')).toBeInViewport();
    await page.screenshot({ path: `test-results/shots/${theme}-phone-browser-quality.png` });
    await deskRow(page).tap();
    await expect(deskMenu(page)).toBeVisible();
    await inWindow(deskMenu(page));
    await page.screenshot({ path: `test-results/shots/${theme}-phone-browser-quality-desk.png` });
    await deskChoice(page, 'Medium').tap();
    await expect(deskMenu(page)).toHaveCount(0);
    await more(page).tap();
    await expect(moreRow(page)).toHaveAccessibleName('Picture quality: Medium');
    await moreRow(page).tap();
    await choice(page, 'Low').tap();
    await expect(menu(page)).toHaveCount(0);
    await more(page).tap();
    await expect(moreRow(page)).toHaveAccessibleName('Picture quality: Low');
    await expect.poll(async () => (await onPlatform(request))?.desks).toEqual({ [DESK]: { level: 'medium', apps: { browser: 'low' } } });
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
