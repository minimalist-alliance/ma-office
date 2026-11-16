// ISS-89's follow-up, the office half: a tab whose tokens become another account's (a sign-in in another tab of the same
// browser) closes every window the last member had open, a full-screen Browser with its tabs among them, and forgets what
// each app kept of them, so the next person at the screen sees none of it: the pictures kept of their desks go, and the
// bell's count and list go and the new member's count is asked at once. ISS-89 already drops the desk list, layout and
// caches (`memberCaches.shell.spec.ts`); the Guild Desks' half is `guild.accountChange.shell.spec.ts`. The stores' own
// resets are in unit form: `src/state/accountChange.test.ts`, `src/notebook/deskBackend.test.ts`,
// `src/apps/files/engines.test.ts`, `src/browser/protectedPlayback.test.ts`, `src/browser/lastScreen.store.test.ts`.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const ATELIER = 'd-atelier000001';
const BAKERY = 'd-bakery0000001';
/** A's desk starts with the office, so its Browser keeps a picture of its screen in this browser (`browser/lastScreen.ts`). */
const fleetA = [{ deskId: ATELIER, name: 'Atelier', kind: 'personal', state: 'running', startsWithOffice: true }];
const fleetB = [{ deskId: BAKERY, name: 'Bakery', kind: 'personal', state: 'running' }];

/** What A had on screen: their desk's name, their two tabs' titles and addresses, their Notebook page's title, a notification's. */
const OF_A = ['Atelier', 'Harbour ledger', 'harbour.example', 'Quince orchard', 'quince.example', 'Marrow Isle ferry', 'Harbour invoice due'];
const TABS = [
  { tabId: 't1', url: 'https://harbour.example/ledger', title: 'Harbour ledger, March', loading: false, active: false, canGoBack: false, canGoForward: false },
  { tabId: 't2', url: 'https://quince.example/plans', title: 'Quince orchard plans', loading: false, active: true, canGoBack: false, canGoForward: false },
];

declare const __maDeskMock: { setTabs(tabs: typeof TABS): void };

const group = (page: Page, name: string): Locator => page.getByRole('group', { name: `${name} desk` });
const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const windows = (page: Page): Locator => page.locator('[data-testid^="window-"]');
const win = (page: Page, app: string): Locator => page.getByTestId(`window-${app}`);
const bell = (page: Page): Locator => page.getByTestId('bell');

async function openApp(page: Page, desk: string, app: string): Promise<void> {
  await group(page, desk).getByRole('button', { name: new RegExp(`^${app}`) }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page, app.toLowerCase())).toBeVisible();
  await page.waitForTimeout(400); // the camera's focus settles
}

/** Each of A's words found in the page's markup (text, names, titles, attributes) or its accessibility tree. */
async function anyOfA(page: Page): Promise<string[]> {
  const dom = await page.content();
  const tree = await page.locator('body').ariaSnapshot();
  return OF_A.flatMap((x) => [...(dom.includes(x) ? [`dom: ${x}`] : []), ...(tree.includes(x) ? [`tree: ${x}`] : [])]);
}

/** The desks with a kept picture of their screen, read without the app, so reading deletes nothing. */
const keptFor = (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === 'ma-last-screen')) return [];
    return new Promise<string[]>((done) => {
      const req = indexedDB.open('ma-last-screen', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('screens');
      req.onerror = () => done([]);
      req.onsuccess = () => {
        const all = req.result.transaction('screens').objectStore('screens').getAllKeys();
        all.onsuccess = () => (req.result.close(), done(all.result.map(String).sort()));
      };
    });
  });

/** A picture of a desk's screen kept the way `lastScreen.ts` keeps one, as the Browser's own timer would have by now. */
async function keepPicture(page: Page, deskId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 800;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#3a7d44';
    ctx.fillRect(0, 0, 1280, 800);
    const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), 'image/jpeg', 0.7));
    await new Promise<void>((done, fail) => {
      const req = indexedDB.open('ma-last-screen', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('screens');
      req.onerror = () => fail(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('screens', 'readwrite');
        tx.objectStore('screens').put({ blob, savedAt: Date.now() }, id);
        tx.oncomplete = () => (req.result.close(), done());
      };
    });
  }, deskId);
}

/** As A, with a Notebook window on a page of theirs, an Agent window, and the Browser full screen on two tabs. */
async function arriveAsA(page: Page, request: APIRequestContext): Promise<void> {
  // Short access tokens, so the tab's next call refreshes and gets whoever's token this browser keeps by then.
  await harness(request, { fleet: fleetA, expiresIn: 60 });
  await signIn(page);
  await canvasPainted(page);
  await openApp(page, 'Atelier', 'Notebook');
  const editor = page.getByTestId('note-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Marrow Isle ferry');
  await expect(page.locator('.nb-page-btn[aria-current="true"] .nb-page-title')).toHaveText('Marrow Isle ferry');
  await openApp(page, 'Atelier', 'Agent');
  await openApp(page, 'Atelier', 'Browser');
  await page.evaluate((tabs) => __maDeskMock.setTabs(tabs), TABS);
  await expect(win(page, 'browser')).toContainText('Quince orchard plans');
  await expect(win(page, 'browser')).toContainText('Harbour ledger, March');
  const video = page.getByTestId('browser-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(windows(page)).toHaveCount(3);
  // A picture of A's screen is kept in this browser, as the Browser's own timer keeps one every 30 s.
  await keepPicture(page, ATELIER);
  expect(await keptFor(page)).toEqual([ATELIER]);
}

/** The refresh token this browser keeps becomes B's, as a sign-in in another tab leaves it, and this tab's next call finds out. */
async function becomeB(page: Page, request: APIRequestContext): Promise<void> {
  await harness(request, { userId: 'u-other', fleet: fleetB });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test("another account's sign-in closes every window the last member had open, and nothing of theirs is left in the page; the new member's office works", async ({ page, request }) => {
  const errors = watchConsole(page);
  await arriveAsA(page, request);
  expect(await anyOfA(page)).not.toEqual([]); // the check finds them while they're there

  await becomeB(page, request);
  // At once: no window, not the full-screen Browser, and focus isn't left in one.
  await expect(windows(page)).toHaveCount(0);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.window-layer'))).toBe(false);
  expect(await anyOfA(page)).toEqual([]);
  // The picture kept of A's screen goes with the rest of A's storage.
  await expect.poll(() => keptFor(page), { timeout: 5_000 }).toEqual([]);

  // B's list lands, and their office opens their own desk's windows.
  await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
  await openApp(page, 'Bakery', 'Notebook');
  await expect(page.getByTestId('note-editor')).toBeVisible();
  await expect(windows(page)).toHaveCount(1);
  await page.waitForTimeout(1_000); // anything of A's still on its way (a session's last frame, a read) has landed
  expect(await anyOfA(page)).toEqual([]);
  // And their Browser closing, and their desk's session ending, kept none again beside B's tokens.
  expect(await keptFor(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("while the new member's list is on its way, the office shows none of the last member's windows or words", async ({ page, request }) => {
  await arriveAsA(page, request);
  let go = (): void => {};
  const held = new Promise<void>((done) => {
    go = done;
  });
  await page.route((url) => url.pathname === '/v1/desks', async (route) => {
    await held;
    await route.continue();
  });
  await becomeB(page, request);
  await expect(windows(page)).toHaveCount(0);
  await page.waitForTimeout(1_500);
  await expect(windows(page)).toHaveCount(0);
  expect(await anyOfA(page)).toEqual([]);
  go();
  await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
  expect(await anyOfA(page)).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
});

test("the bell: the last member's count and open list go at once, and the new member's count is asked as soon as they're known", async ({ page, request, baseURL }) => {
  const errors = watchConsole(page);
  const at = new Date().toISOString();
  const item = { id: 'nt-a1', type: 'billing.card_expiring', title: 'Harbour invoice due', body: 'Settle it by Friday.', link: `${baseURL}/billing`, count: 1, critical: false, createdAt: at, updatedAt: at, readAt: null };
  await harness(request, { fleet: fleetA, expiresIn: 60, notifications: { items: [item], unreadExtra: 6 } });
  await signIn(page);
  await canvasPainted(page);
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 7 unread');
  await bell(page).click();
  await expect(page.getByText('Harbour invoice due')).toBeVisible();
  // B's `/v1/me` is slow, so what the bell shows meanwhile is whatever it kept of A.
  let go = (): void => {};
  const held = new Promise<void>((done) => {
    go = done;
  });
  await page.route((url) => url.pathname === '/v1/me', async (route) => {
    await held;
    await route.continue();
  });
  await harness(request, { userId: 'u-other', fleet: fleetB, notifications: { items: [], unreadExtra: 2 } });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  await expect(bell(page)).toHaveCount(0); // hidden while it's not known whose count it would be
  await expect(page.getByTestId('bell-count')).toHaveCount(0);
  expect(await anyOfA(page)).toEqual([]);
  go();
  // Asked at once, not at the minute's poll.
  await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications, 2 unread', { timeout: 5_000 });
  expect(await anyOfA(page)).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
  expect(errors).toEqual([]);
});

// For the review: the last member's windows, and the new member's office once their list is in, in each theme.
for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`in ${theme}: the last member's windows, then the new member's office with nothing of theirs`, async ({ page, request }) => {
    await setTheme(page, theme);
    await arriveAsA(page, request);
    await page.screenshot({ path: `test-results/shots/account-change-${theme}-before.png` });
    await becomeB(page, request);
    await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
    await page.waitForTimeout(800); // the camera frames the new desk
    await page.screenshot({ path: `test-results/shots/account-change-${theme}-after.png` });
    await expect(windows(page)).toHaveCount(0);
    expect(await anyOfA(page)).toEqual([]);
  });
}
