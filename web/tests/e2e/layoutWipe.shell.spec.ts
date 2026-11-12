// ISS-67: the saved layout's mirror in this browser goes on every signed-out state, every key of it, whichever scope the
// view was on, and a sign-in as anyone else never reads the last account's. Sign out (with a change on its way, and with
// the logout held), a dead session, a 401 a refresh can't mend, another tab's sign-out, a browser left with nobody signed
// in, and another tab's sign-in as someone else. `platform/session.signedOut.test.ts` has the same paths in unit form.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const A = 'd-personal00001';
const B = 'd-work000000001';
const C = 'd-guild00000001';
const D = 'd-bakery0000001';
const DESKS = [A, B, C];
const fleet = (ids: string[]): Record<string, string>[] =>
  ids.map((deskId) => ({ deskId, name: { [A]: 'Personal', [B]: 'Work', [C]: 'Guild', [D]: 'Bakery' }[deskId]!, kind: { [A]: 'personal', [B]: 'work', [C]: 'guild', [D]: 'personal' }[deskId]!, state: 'running' }));

/** Every key the saved layout's mirror is kept under (`LAYOUT_MIRROR_KEYS` in `state/layoutStore.ts`). */
const KEYS = ['ma.layout.v2', 'ma.layout.v1', 'ma.layout.sync.v1', 'ma.free.prefs.v1', 'ma.setup.prefs.v1', 'ma.prefs.background', 'ma.layout.owner.v1'];
const NONE = Object.fromEntries(KEYS.map((k) => [k, null]));
const SCOPES = ['personal', 'work', 'guild', 'all'] as const;

/** What this browser holds of the mirror, read from a page on the same site. */
const mirror = (page: Page): Promise<Record<string, string | null>> =>
  page.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), KEYS);
const proxy = (page: Page, id: string) => page.locator(`[id="proxy-${id}"]`);
/** What in the mirror is the last account's (`arrive`'s): its desk ids, its background, its id, wherever it shows. */
const lastAccounts = (held: Record<string, string | null>): string[] =>
  Object.entries(held).flatMap(([key, value]) => [...DESKS, 'misty-forest', 'u-test'].filter((x) => value?.includes(x)).map((x) => `${key}: ${x}`));

/** A change the member makes from the keyboard: the mirror is written a second later, and the save two. */
async function keyEdit(page: Page, id: string): Promise<void> {
  await proxy(page, id).focus();
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
}

/** Signed in with Personal, Work and Guild desks, the view on `scope`, and every key of the mirror there. */
async function arrive(page: Page, request: APIRequestContext, scope: (typeof SCOPES)[number] = 'all'): Promise<void> {
  await page.addInitScript((s) => {
    if (!localStorage.getItem('ma.view.v1')) localStorage.setItem('ma.view.v1', JSON.stringify({ scope: s, activeDesk: null, mode: 'overview' }));
  }, scope);
  await harness(request, { fleet: fleet(DESKS) });
  await signIn(page);
  await canvasPainted(page);
  await keyEdit(page, scope === 'work' ? B : scope === 'guild' ? C : A);
  // Its mirror's write and its save have both landed, so nothing of this page's is still on its way.
  const settled = async (): Promise<boolean> => {
    const r = JSON.parse((await mirror(page))['ma.layout.sync.v1'] ?? '{}') as { dirty?: string[]; version?: number; member?: string };
    return r.member === 'u-test' && r.dirty?.length === 0 && (r.version ?? 0) >= 1;
  };
  await expect.poll(settled, { timeout: 8_000 }).toBe(true);
  // What the lazy chunks and a build before keep beside it: the free tier's and the setup circle's prefs, the background, the old layout.
  await page.evaluate(() => {
    localStorage.setItem('ma.free.prefs.v1', JSON.stringify({ who: 'u-test', prefs: { freeSaidOn: '2026-11-10' } }));
    localStorage.setItem('ma.setup.prefs.v1', JSON.stringify({ who: 'u-test', prefs: { circleHidden: true } }));
    localStorage.setItem('ma.prefs.background', JSON.stringify({ id: 'misty-forest', theme: 'light' }));
    localStorage.setItem('ma.layout.v1', JSON.stringify({ desks: {} }));
  });
  await expect.poll(async () => Object.values(await mirror(page)).every((v) => v !== null), { timeout: 6_000 }).toBe(true);
  const held = await mirror(page);
  for (const id of DESKS) expect(held['ma.layout.v2']).toContain(id);
  expect(held['ma.layout.owner.v1']).toBe('u-test');
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}

for (const scope of SCOPES) {
  test(`Sign out takes every key, for Personal, Work and Guild desks alike, with the view on ${scope}`, async ({ page, request }) => {
    await arrive(page, request, scope);
    await signOut(page);
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    expect(await mirror(page)).toEqual(NONE);
    // The device's own view state isn't the account's layout (ADR 0005), and stays.
    expect(await page.evaluate(() => localStorage.getItem('ma.view.v1'))).toContain(scope);
  });
}

test('Sign out with a change still on its way: the last words save it, the mirror is gone before the logout, and nothing writes it back while the logout waits', async ({ page, context, request }) => {
  await arrive(page, request);
  const other = await context.newPage();
  await other.goto('/__harness');
  const version = async (): Promise<number> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { version: number }> }).layoutDocs['u-test']!.version;
  const saved = await version();
  // Hold the logout, so the page that signed out is still there, after everything else Sign out does. It's read from
  // the other page: a frame on its way to another page answers nothing.
  let release = (): void => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  let atLogout = false;
  await page.route((url) => url.pathname === '/fake-auth/logout', async (route) => {
    atLogout = true;
    await held;
    await route.continue();
  });
  await keyEdit(page, A); // the mirror's write and the save are both on their way
  await signOut(page);
  await expect.poll(() => atLogout, { timeout: 8_000 }).toBe(true);
  expect(await version()).toBeGreaterThan(saved);
  expect(await mirror(other)).toEqual(NONE);
  await other.waitForTimeout(1_200); // past the mirror's 1 s debounce
  expect(await mirror(other)).toEqual(NONE);
  release();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect(await mirror(page)).toEqual(NONE);
});

test('a dead session (a refused refresh) takes every key', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await arrive(page, request);
  // Within the loop guard's 30 s of signing in, so the card says it.
  await harness(request, { refreshFails: true });
  await page.reload();
  await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
  expect(await mirror(page)).toEqual(NONE);
});

test("a 401 a refresh can't mend takes every key, though the refresh token stays, and nothing writes it again", async ({ page, request }) => {
  await arrive(page, request);
  await harness(request, { desksUnauthorized: true });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.', { timeout: 20_000 });
  expect(await mirror(page)).toEqual(NONE);
  expect(await page.evaluate(() => localStorage.getItem('ma-desk-web-refresh'))).not.toBeNull();
  await page.waitForTimeout(1_200);
  expect(await mirror(page)).toEqual(NONE);
});

test("another tab's sign-out takes it here at once, and this tab's own changes and leaving write nothing back", async ({ page, context, request }) => {
  await arrive(page, request);
  const two = await context.newPage();
  await two.goto('/');
  await expect(two.locator('.ma-shell')).toBeVisible();
  await signOut(two);
  await expect(two.getByTestId('sign-in')).toContainText("You're signed out.");

  // The first tab still shows the office on the access token it holds, until its next call: its mirror is gone already.
  await page.bringToFront();
  await expect.poll(() => mirror(page), { timeout: 4_000 }).toEqual(NONE);
  await expect(page.locator('.ma-shell')).toBeVisible();
  await keyEdit(page, A);
  await page.waitForTimeout(1_200); // past the mirror's debounce
  expect(await mirror(page)).toEqual(NONE);
  await page.close({ runBeforeUnload: true }); // a page going away flushes the mirror and sends what's waiting
  await two.bringToFront();
  await two.waitForTimeout(300);
  expect(await mirror(two)).toEqual(NONE);
});

test('a browser left with nobody signed in (the session gone with the browser) wipes it on the next start', async ({ page, request }) => {
  await harness(request, { signInPath: null });
  await arrive(page, request);
  // "Until you close the browser" ends with the browser: the token is gone, and what was beside it in localStorage isn't.
  await page.evaluate(() => {
    localStorage.removeItem('ma-desk-web-refresh');
    sessionStorage.removeItem('ma-desk-web-refresh');
  });
  await page.goto('about:blank');
  // Whoever's next: the start goes to sign in, or to the card inside the loop guard's 30 s, and stays there.
  await harness(request, { authorizeHolds: true });
  await page.goto('/');
  const other = await page.context().newPage();
  await other.goto('/__harness');
  await expect.poll(() => mirror(other), { timeout: 8_000 }).toEqual(NONE);
});

test("another tab's sign-in as someone else: that tab never reads the last account's mirror, before its list has answered or after", async ({ page, context, request }) => {
  await arrive(page, request);
  // The refresh token this browser keeps becomes someone else's, as a sign-in over a stored session leaves it. Their
  // list is slow, so what the new tab holds before it answers is what it read for itself.
  await harness(request, { userId: 'u-other', fleet: fleet([D]) });
  const two = await context.newPage();
  let listed = (): void => {};
  const slow = new Promise<void>((done) => {
    listed = done;
  });
  await two.route((url) => url.pathname === '/v1/desks', async (route) => {
    await slow;
    await route.continue();
  });
  await two.goto('/');
  await expect.poll(() => two.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  // Nothing of the last account's: its desks, its background, its prefs, its id. The new one's own (its default background, say) may be there.
  expect(lastAccounts(await mirror(two))).toEqual([]);
  for (const id of DESKS) await expect(proxy(two, id)).toHaveCount(0);

  listed();
  await expect(proxy(two, D)).toBeAttached({ timeout: 8_000 });
  await keyEdit(two, D);
  await expect.poll(() => two.evaluate(() => localStorage.getItem('ma.layout.v2') ?? ''), { timeout: 4_000 }).toContain(D);
  const after = await mirror(two);
  expect(lastAccounts(after)).toEqual([]);
  expect(after['ma.layout.owner.v1']).toBe('u-other');
  await two.unrouteAll({ behavior: 'wait' });
});
