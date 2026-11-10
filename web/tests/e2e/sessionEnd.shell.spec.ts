// What a session that ends leaves for whoever signs in next on this computer: none of the last member's desk names or
// kept pictures, never the last member's name on someone else's session, and a Back that doesn't go round again.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { harness, signIn } from './helpers';

const A_DESK = { deskId: 'd-aaaaaaaaaaaa', name: 'Divorce papers', kind: 'personal', state: 'running' };
const B_DESK = { deskId: 'd-bbbbbbbbbbbb', name: 'Bakery', kind: 'personal', state: 'running' };
const GUARD_KEY = 'ma.auth.leftForSignIn';

/** The kept pictures' database, as the Browser window makes it, so a test can see it go. */
const keepPicture = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        const r = indexedDB.open('ma-last-screen', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('screens');
        r.onsuccess = () => {
          r.result.close();
          done();
        };
      }),
  );

/** What this browser holds of a member, read from a page on the same site. */
const held = (page: Page): Promise<{ mirror: string | null; pictures: boolean }> =>
  page.evaluate(async () => ({
    mirror: localStorage.getItem('ma.desks.v1'),
    pictures: (await indexedDB.databases()).some((d) => d.name === 'ma-last-screen'),
  }));

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test("a dead session that goes off to sign in leaves no desk names or kept pictures for whoever's next", async ({ page, context, request }) => {
  await harness(request, { signInPath: null, fleet: [A_DESK] });
  await signIn(page);
  await expect.poll(async () => (await held(page)).mirror).toContain('Divorce papers');
  await keepPicture(page);
  // A's session is refused, and sign-in waits for whoever's next. Past the loop guard, so it goes there by itself.
  await harness(request, { refreshFails: true, authorizeHolds: true });
  await page.evaluate((k) => sessionStorage.removeItem(k), GUARD_KEY);
  const leaving = page.waitForRequest(/\/oauth2\/authorize/);
  await page.reload();
  await leaving;
  const other = await context.newPage();
  await other.goto('/__harness');
  expect(await held(other)).toEqual({ mirror: null, pictures: false });
});

test('a dead session that ends on the card leaves no desk names or kept pictures either', async ({ page, request }) => {
  await harness(request, { signInPath: null, fleet: [A_DESK] });
  await signIn(page);
  await expect.poll(async () => (await held(page)).mirror).toContain('Divorce papers');
  await keepPicture(page);
  // Within the loop guard's 30 s of signing in, so the card says it.
  await harness(request, { refreshFails: true });
  await page.reload();
  await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
  await expect.poll(() => held(page)).toEqual({ mirror: null, pictures: false });
  await expect(page.getByText('Divorce papers')).toHaveCount(0);
});

/** Per member, as Platform is: the harness's own `/v1/me` is one account for everyone. A's `sid` is refused once revoked. */
async function perMember(context: BrowserContext, revoked: { a: boolean }): Promise<void> {
  const subOf = (auth: string | undefined): string | null => {
    const t = auth?.split(' ')[1];
    try {
      return t ? (JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub : null;
    } catch {
      return null;
    }
  };
  await context.route('**/v1/me', (route) => {
    const sub = subOf(route.request().headers()['authorization']);
    if (sub === 'u-member-A' && revoked.a) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Unauthorized"}' });
    const a = sub === 'u-member-A';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ userId: sub, email: a ? 'a@example.org' : 'b@example.org', displayName: a ? 'Member A' : 'Member B', membership: { status: 'active', tier: 'member' } }) });
  });
  await context.route('**/v1/desks', (route) => {
    if (subOf(route.request().headers()['authorization']) === 'u-member-A' && revoked.a) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"Unauthorized"}' });
    return route.continue();
  });
}

test("a tab whose tokens become another member's shows that member, never the last one's name", async ({ page, context, request }) => {
  test.setTimeout(60_000);
  const revoked = { a: false };
  await perMember(context, revoked);
  await harness(request, { signInPath: null, userId: 'u-member-A', fleet: [A_DESK] });
  await signIn(page);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.locator('.menu-who')).toHaveText('Member A');
  await page.keyboard.press('Escape');

  // A signs out in a second tab, and B signs in there.
  const two = await context.newPage();
  await two.goto('/');
  await expect(two.locator('.ma-shell')).toBeVisible();
  await two.getByRole('button', { name: 'Account', exact: true }).click();
  await two.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(two.getByTestId('sign-in')).toContainText("You're signed out.");
  revoked.a = true;
  await harness(request, { userId: 'u-member-B', fleet: [B_DESK] });
  await two.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(two.locator('.ma-shell')).toBeVisible();

  // The first tab is looked at again: its call is refused, and its refresh finds B's token.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('group', { name: 'Bakery desk' })).toBeAttached({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.locator('.menu-who')).toHaveText('Member B');
});

test('Back from our own sign-in pages goes back where the member came from, not round again', async ({ page, request }) => {
  await harness(request, { signInPath: '/_signin/', signInHolds: true });
  await page.goto('/__harness');
  await page.goto('/');
  await page.waitForURL(/\/_signin\//);
  await page.goBack();
  await expect(page).toHaveURL(/\/__harness$/);
});
