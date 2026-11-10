// The Alliance Member's hosted small desk (ma-platform ADR 0097, contract desks.md `startsWithOffice`): the office wakes it
// as it opens, not at the Browser's click, and the Browser shows its last screen at once from a copy kept in this browser.
// The real link against the harness's `connect`, so every wake is counted.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const REAL_LINK = '/?link=real';
const SMALL = 'd-personal00001';
const HOME = 'd-selfhost00001';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface Harness { connects: { deskId: string; start: unknown }[] }
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const startsOf = async (request: APIRequestContext, id: string): Promise<unknown[]> => (await read(request)).connects.filter((c) => c.deskId === id).map((c) => c.start);

const small = (state: string, startsWithOffice = true) => ({ deskId: SMALL, name: 'Personal', kind: 'personal', state, ...(startsWithOffice ? { startsWithOffice: true } : {}) });
/** A second desk, on the member's own computer (task 31), so the office opens on the overview, where nothing wakes by itself. */
const home = { deskId: HOME, name: 'Home', kind: 'custom', hosting: 'self', state: 'running' };

/** A 1280x800 picture with a mark in it, kept the way `lastScreen.ts` keeps one, `ageMs` ago. */
async function keepPicture(page: Page, deskId: string, ageMs = 0): Promise<void> {
  await page.evaluate(async ([id, age]) => {
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
        tx.objectStore('screens').put({ blob, savedAt: Date.now() - age }, id);
        tx.oncomplete = () => (req.result.close(), done());
      };
    });
  }, [deskId, ageMs] as const);
}
/** The desks with a kept picture, read without the app, so reading deletes nothing. */
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
const kept = (page: Page): Promise<boolean> => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'ma-last-screen'));

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the office wakes the Alliance desk as it opens, with no click, once', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: [small('stopped'), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await expect.poll(() => startsOf(request, SMALL), { timeout: 10_000 }).toContain(true);
  expect((await startsOf(request, SMALL)).filter((s) => s === true)).toHaveLength(1);
  expect(await startsOf(request, HOME)).not.toContain(true);
  // The list's next answers don't wake it again.
  await page.waitForTimeout(2_500);
  expect((await startsOf(request, SMALL)).filter((s) => s === true)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a desk that doesn\'t start with the office, on the same overview, is never woken by it opening', async ({ page, request }) => {
  await harness(request, { fleet: [small('stopped', false), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await expect.poll(() => startsOf(request, SMALL)).toContain(false);
  await page.waitForTimeout(2_000);
  expect(await startsOf(request, SMALL)).not.toContain(true);
});

test('an office opened in a background tab waits until it is looked at', async ({ page, request }) => {
  await harness(request, { fleet: [small('stopped'), home] });
  await signIn(page, '/');
  await page.addInitScript(() => {
    (window as unknown as { __hide: boolean }).__hide = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => (window as unknown as { __hide: boolean }).__hide });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ((window as unknown as { __hide: boolean }).__hide ? 'hidden' : 'visible') });
  });
  await page.goto(REAL_LINK);
  await expect.poll(() => startsOf(request, SMALL)).toContain(false);
  await page.waitForTimeout(1_500);
  expect(await startsOf(request, SMALL)).not.toContain(true);
  await page.evaluate(() => {
    (window as unknown as { __hide: boolean }).__hide = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => startsOf(request, SMALL), { timeout: 10_000 }).toContain(true);
});

test('the Browser shows the last screen at once while the desk wakes, in each theme', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: [small('stopped'), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await keepPicture(page, SMALL);
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.reload();
    await canvasPainted(page);
    const browserApp = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: 'Browser', exact: true });
    await browserApp.focus();
    await browserApp.press('Enter');
    const held = page.getByTestId('browser-held');
    await expect(held).toBeVisible();
    expect(await held.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1280, 800]);
    const panel = page.getByTestId('browser-panel');
    await expect(panel).toHaveClass(/over-picture/);
    await expect(panel).toHaveAttribute('data-panel', /^(waking|asleep|opening|starting)$/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/shots/alliance-last-screen-${theme}.png` });
  }
  expect(errors).toEqual([]);
});

test('sign-out deletes every kept picture, so the next person on this computer sees none', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: [small('running'), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await keepPicture(page, SMALL);
  expect(await kept(page)).toBe(true);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL((u) => u.search === '' && u.pathname !== '/', { timeout: 15_000 });
  await expect.poll(() => kept(page), { timeout: 10_000 }).toBe(false);
  expect(errors).toEqual([]);
});

test('a sign-out with the Browser showing and a slow revoke leaves no picture: the copy kept as the link closes never lands', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: [small('running'), home] });
  await signIn(page, '/');
  await canvasPainted(page);
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  const video = page.getByTestId('browser-video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  // A real revoke crosses the network; the harness answers in about 1 ms, which hid the race (the weekend review).
  await page.route('**/oauth2/revoke', async (r) => {
    await new Promise((d) => setTimeout(d, 300));
    await r.continue();
  });
  // Where sign-out ends, a page with no app on it: the app's own sign-out alone has to leave nothing.
  await page.route('**/fake-auth/logout**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Signed out</title><p>Signed out</p>' }));
  // Windowed, as a member would have it to reach the bar (a window filling the screen is closed by a click outside).
  await page.getByRole('button', { name: 'Restore window' }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(/\/fake-auth\/logout/, { timeout: 15_000 });
  expect(await kept(page)).toBe(false);
  await page.waitForTimeout(1_000);
  expect(await kept(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('/signed-out deletes every kept picture too', async ({ page, request }) => {
  await harness(request, { fleet: [small('running'), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await keepPicture(page, SMALL);
  expect(await kept(page)).toBe(true);
  await page.goto('/signed-out');
  await expect.poll(() => kept(page), { timeout: 10_000 }).toBe(false);
});

test('a picture past seven days is deleted when the Browser opens, not only left unshown, and a fresh one stays', async ({ page, request }) => {
  await harness(request, { fleet: [small('stopped'), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  await keepPicture(page, SMALL, 7 * 86_400_000 + 60_000);
  await keepPicture(page, HOME, 60_000);
  expect(await keptFor(page)).toEqual([SMALL, HOME].sort());
  await page.reload();
  await canvasPainted(page);
  const browserApp = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: 'Browser', exact: true });
  await browserApp.focus();
  await browserApp.press('Enter');
  await expect(page.getByTestId('browser-panel')).toBeVisible();
  await expect.poll(() => keptFor(page)).toEqual([HOME]);
  await expect(page.getByTestId('browser-panel')).not.toHaveClass(/over-picture/);
  await expect(page.getByTestId('browser-held')).toBeHidden();
});

test('without a kept picture, the waking panel is the whole view, as for any desk', async ({ page, request }) => {
  await harness(request, { fleet: [small('stopped'), home] });
  await signIn(page, REAL_LINK);
  await canvasPainted(page);
  const browserApp = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: 'Browser', exact: true });
  await browserApp.focus();
  await browserApp.press('Enter');
  await expect(page.getByTestId('browser-panel')).toBeVisible();
  await expect(page.getByTestId('browser-panel')).not.toHaveClass(/over-picture/);
  await expect(page.getByTestId('browser-held')).toBeHidden();
});
