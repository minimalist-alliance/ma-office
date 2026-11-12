// ISS-89: the member's other caches in this browser go with the saved layout's mirror (ISS-67) on every signed-out
// state, and a sign-in as anyone else never finds the last account's: stream quality and its desk levels, the boots
// told, the bandwidth heads-up, the Guild Desk's privacy line, the touch hint's members, the connect-time cap, the
// owner's About, and this tab's own Maia conversation and open panel. Sign out; another tab's sign-out, with the stale
// tab's own writes after it; a dead session; and another account's sign-in, in a tab that stays open and in one that
// reloads. `src/state/memberCaches.test.ts` and `src/platform/session.signedOut.test.ts` have the same in unit form.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const PERSONAL = 'd-personal00001';
const HOME = 'd-home000000001';
const BAKERY = 'd-bakery0000001';
const hourAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
/** A's office: a cloud desk, and a desk on A's own computer whose new boot the office tells A about. */
const fleetA = () => [
  { deskId: PERSONAL, name: 'Atelier', kind: 'personal', state: 'running' },
  { deskId: HOME, name: 'Home desk', kind: 'personal', state: 'running', hosting: 'self', bootFirstSeenAt: hourAgo(1), previousBootFirstSeenAt: hourAgo(30), bootRefusedAt: null },
];
const fleetB = [{ deskId: BAKERY, name: 'Bakery', kind: 'personal', state: 'running' }];

/** Every key of the member's other caches (`MEMBER_CACHE_KEYS` in `state/layoutStore.ts`), and this tab's (`MEMBER_TAB_KEYS`). */
const CACHES = ['ma.streamQuality.v1', 'ma.streamQuality.desks.v1', 'ma.boots.seen.v1', 'ma.bandwidth.notice.v1', 'ma.guild.privacy.v1', 'ma.browser.touchHint.v1', 'ma.rttCapped.v1', 'ma.menu.about.v1'];
const TAB = ['ma.maia.conversation.v1', 'ma.maia.open.v1', 'ma.layout.owner.v1'];
const nulls = (keys: string[]): Record<string, null> => Object.fromEntries(keys.map((k) => [k, null]));
const NONE = { local: nulls(CACHES), tab: nulls(TAB) };

interface Held {
  local: Record<string, string | null>;
  tab: Record<string, string | null>;
}
/** What this browser holds of them, and this page's own tab, read from a page on the same site. */
const held = (page: Page): Promise<Held> =>
  page.evaluate(
    ([c, t]) => ({ local: Object.fromEntries(c.map((k) => [k, localStorage.getItem(k)])), tab: Object.fromEntries(t.map((k) => [k, sessionStorage.getItem(k)])) }),
    [CACHES, TAB] as const,
  );
/** Anything of member A's anywhere in this page's localStorage or sessionStorage: their id, their conversation, a desk's name. */
const anyOfA = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const [where, s] of [['local', localStorage], ['tab', sessionStorage]] as const) {
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i)!;
        const v = s.getItem(k) ?? '';
        for (const x of ['u-test', 'c_harness', 'Home desk', 'Atelier']) if (v.includes(x)) out.push(`${where} ${k}: ${x}`);
      }
    }
    return out;
  });

const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const launcher = (page: Page): Locator => page.locator('.maia-launcher');
const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message to Maia' });
const bootLine = (page: Page): Locator => page.getByTestId('boot-notice');

/** Opens Maia's panel and asks her once: her conversation, and the open panel, are kept in this tab. */
async function askMaia(page: Page, text: string): Promise<void> {
  if (!(await composer(page).isVisible())) await launcher(page).click();
  await expect(composer(page)).toBeFocused();
  const sent = (await page.locator('.maia-me').count()) + 1;
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(page.locator('.maia-me')).toHaveCount(sent);
  await expect(page.locator('.maia-msg[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Signed in as A (`u-test`) with Maia on and a new boot of A's own desk told. What the office writes itself: the boots
 * told, Maia's conversation and open panel. What lazy chunks and other screens write is put in as they write it.
 */
async function arrive(page: Page, request: APIRequestContext, patch: Record<string, unknown> = {}): Promise<void> {
  await harness(request, { fleet: fleetA(), maia: { enabled: true }, ...patch });
  await signIn(page);
  await canvasPainted(page);
  await expect(bootLine(page)).toContainText('Home desk started at');
  await expect(launcher(page)).toBeVisible();
  await askMaia(page, 'How do I move a desk?');
  await page.evaluate(({ home, personal }) => {
    localStorage.setItem('ma.streamQuality.v1', JSON.stringify({ sub: 'u-test', doc: { default: 'low', apps: {}, desks: { [personal]: { level: 'max', apps: {} } }, updatedAt: '2026-11-11T10:00:00.000Z' }, layered: true }));
    localStorage.setItem('ma.streamQuality.desks.v1', JSON.stringify({ sub: 'u-test', desks: { [home]: { browser: 'low' } } }));
    localStorage.setItem('ma.bandwidth.notice.v1', 'warn:2026-11-09T00:00:00.000Z');
    localStorage.setItem('ma.guild.privacy.v1', '1');
    localStorage.setItem('ma.browser.touchHint.v1', JSON.stringify(['u-test']));
    localStorage.setItem('ma.rttCapped.v1', JSON.stringify({ sub: 'u-test', until: Date.now() + 3_600_000 }));
    localStorage.setItem('ma.menu.about.v1', 'true');
  }, { home: HOME, personal: PERSONAL });
  const now = await held(page);
  for (const k of CACHES) expect(now.local[k], k).not.toBeNull();
  expect(now.local['ma.boots.seen.v1']).toContain(HOME);
  expect(now.tab['ma.maia.conversation.v1']).toMatch(/^c_harness/);
  expect(now.tab['ma.maia.open.v1']).toBe('1');
  expect(now.tab['ma.layout.owner.v1']).toBe('u-test');
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test("Sign out takes every cache, and this tab's Maia conversation", async ({ page, request }) => {
  await arrive(page, request);
  await signOut(page);
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect(await held(page)).toEqual(NONE);
  expect(await anyOfA(page)).toEqual([]);
});

test("another tab's sign-out takes them here at once, this tab's own sessionStorage included, and nothing this stale tab does writes them back", async ({ page, context, request }) => {
  await arrive(page, request);
  const two = await context.newPage();
  await two.goto('/');
  await expect(two.locator('.ma-shell')).toBeVisible();
  await signOut(two);
  await expect(two.getByTestId('sign-in')).toContainText("You're signed out.");

  // The first tab still shows the office on the access token it holds, until its next call; its caches are gone already.
  await page.bringToFront();
  await expect.poll(() => held(page), { timeout: 4_000 }).toEqual(NONE);
  await expect(page.locator('.ma-shell')).toBeVisible();
  // Maia's panel shut and opened again, and another turn: her conversation goes on in memory, and isn't kept.
  await page.locator('.maia-tool[aria-label="Hide Maia"]').click();
  await expect(composer(page)).toHaveCount(0);
  await askMaia(page, 'And how do I rename one?');
  // The desk list asked again (its boots told, its names) on the token it still holds.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1_200);
  const after = await held(page);
  expect(after).toEqual(NONE);
  expect(await page.evaluate(() => localStorage.getItem('ma.desks.v1'))).toBeNull();
  expect(await anyOfA(page)).toEqual([]);
  await page.close({ runBeforeUnload: true });
  await two.bringToFront();
  await two.waitForTimeout(300);
  expect((await held(two)).local).toEqual(NONE.local);
  expect(await anyOfA(two)).toEqual([]);
});

test("another tab's sign-out, then a sign-in there as someone else: the stale tab, still drawing A on its access token, writes nothing of A's beside the new token", async ({ page, context, request }) => {
  await arrive(page, request);
  const two = await context.newPage();
  await two.goto('/');
  await expect(two.locator('.ma-shell')).toBeVisible();
  await signOut(two);
  await expect(two.getByTestId('sign-in')).toContainText("You're signed out.");
  await expect.poll(() => held(page), { timeout: 4_000 }).toEqual(NONE);
  // B signs in there: B's refresh token is kept in this browser again, and the mirror is named B's.
  await harness(request, { userId: 'u-other', fleet: fleetB });
  await signIn(two);
  await expect(two.locator(`[id="proxy-${BAKERY}"]`)).toBeAttached({ timeout: 8_000 });
  await expect.poll(() => two.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');

  // The stale tab is A's still: a Maia turn, the desk list asked again (A's names, A's boots), a layout change, leaving.
  await page.bringToFront();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await askMaia(page, 'And how do I rename one?');
  await page.locator(`[id="proxy-${PERSONAL}"]`).focus();
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1_500); // past the mirror's debounce
  // The harness's list is one for everyone, so this reads B's desks on A's token; what's tried is the writes after it.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1_200);
  expect(await anyOfA(page)).toEqual([]);
  expect((await held(page)).tab).toEqual(NONE.tab);
  await page.close({ runBeforeUnload: true });
  await two.bringToFront();
  await two.waitForTimeout(300);
  expect(await anyOfA(two)).toEqual([]);
  const layout = (await two.evaluate(() => localStorage.getItem('ma.layout.v2'))) ?? '';
  expect(layout).not.toContain(PERSONAL);
  expect(layout).not.toContain(HOME);
  expect((await two.evaluate(() => localStorage.getItem('ma.desks.v1'))) ?? '').not.toContain(PERSONAL);
});

test('a dead session (a refused refresh) takes every cache, and this tab’s Maia keys', async ({ page, request }) => {
  await arrive(page, request, { signInPath: null });
  // Within the loop guard's 30 s of signing in, so the card says it.
  await harness(request, { refreshFails: true });
  await page.reload();
  await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
  expect(await held(page)).toEqual(NONE);
  expect(await anyOfA(page)).toEqual([]);
});

test("a tab whose tokens become another account's (a sign-in elsewhere): A's caches go from storage, and A's Maia chat, boot notice and keys from the tab, at once", async ({ page, request }) => {
  // Short access tokens, so the tab's next call refreshes and gets whoever's token this browser keeps now.
  await arrive(page, request, { expiresIn: 60 });
  await harness(request, { userId: 'u-other', fleet: fleetB });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  const now = await held(page);
  expect(now.local).toEqual(NONE.local);
  expect(now.tab).toEqual({ ...NONE.tab, 'ma.layout.owner.v1': 'u-other' });
  await expect(bootLine(page)).toHaveCount(0);
  // Her widget is the new account's: shut, and with nothing of A's chat in it.
  await expect(launcher(page)).toBeVisible({ timeout: 8_000 });
  await expect(composer(page)).toHaveCount(0);
  await launcher(page).click();
  await expect(composer(page)).toBeFocused();
  await expect(page.locator('.maia-me')).toHaveCount(0);
  await expect(page.locator(`[id="proxy-${BAKERY}"]`)).toBeAttached({ timeout: 8_000 });
  await expect(bootLine(page)).toHaveCount(0);
  expect(await anyOfA(page)).toEqual([]);
});

test("a tab whose tokens become another account's shows none of the last member's desks, not even while the new member's list is on its way", async ({ page, request }) => {
  await arrive(page, request, { expiresIn: 60 });
  for (const id of [PERSONAL, HOME]) await expect(proxy(page, id)).toBeAttached();
  await harness(request, { userId: 'u-other', fleet: fleetB });
  // The new member's list is slow, so what this tab shows meanwhile is what it kept of the last member.
  let listed = (): void => {};
  const slow = new Promise<void>((done) => {
    listed = done;
  });
  await page.route((url) => url.pathname === '/v1/desks', async (route) => {
    await slow;
    await route.continue();
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  for (const id of [PERSONAL, HOME]) await expect(proxy(page, id)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Atelier');
  await expect(page.locator('body')).not.toContainText('Home desk');

  listed();
  await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
  for (const id of [PERSONAL, HOME]) await expect(proxy(page, id)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Atelier');
  await page.unrouteAll({ behavior: 'wait' });
});

test("a reload of A's tab after another account signed in elsewhere: storage is that account's, and this tab's own Maia keys of A's go", async ({ page, context, request }) => {
  await arrive(page, request);
  // The refresh token this browser keeps becomes someone else's, as a sign-in over a stored session leaves it.
  await harness(request, { userId: 'u-other', fleet: fleetB });
  const two = await context.newPage();
  await two.goto('/');
  await expect.poll(() => two.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  expect((await held(two)).local).toEqual(NONE.local);
  expect(await anyOfA(two)).toEqual([]);
  await two.close();

  // A's tab still holds A's conversation in its own sessionStorage, which no other tab can reach.
  expect((await held(page)).tab['ma.maia.conversation.v1']).toMatch(/^c_harness/);
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  const now = await held(page);
  expect(now.tab).toEqual({ ...NONE.tab, 'ma.layout.owner.v1': 'u-other' });
  expect(now.local).toEqual(NONE.local);
  await expect(launcher(page)).toBeVisible({ timeout: 8_000 });
  await expect(composer(page)).toHaveCount(0);
  expect(await anyOfA(page)).toEqual([]);
});
