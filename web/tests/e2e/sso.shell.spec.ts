// One sign-in for every app, the office's part (ma-platform contract auth.md §2.8, 0.3.118 draft): step 1 after the
// callback and once a page load, step 3 first in Sign out (and the signed-out page's one more try), a lasting
// `session_revoked` revoking the refresh token, and the 30-day end, all only where client-config's `auth.sso` is an object
// with an https origin. The shared sign-in at `id.` is answered in this browser context (`standIn`): nothing leaves for a real one.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { harness, refreshTokenPlaces, signIn, watchConsole } from './helpers';

const ID = 'https://id.localhost';
const SSO = { origin: ID };
const KEY = 'ma-desk-web-refresh';
const GUARD_KEY = 'ma.auth.leftForSignIn';
const shell = (page: Page) => page.locator('.ma-shell');

interface Seen { path: string; headers: Record<string, string>; body: string | null; signOutsBefore: number }
interface Harness { log: string[]; signOuts: unknown[]; revoked: string[]; refreshSent: string[] }
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;

/**
 * The shared sign-in, as contract §2.8 answers: CORS for the exact origin with credentials. `hold` keeps step 1's answer
 * back until it settles; `end` is step 3's answers in turn, a status or `drop` for no answer (204 after); `wildcard` answers
 * `*`, which no credentialed request may take. Each request notes how many sign-outs Platform had heard by then.
 */
async function standIn(context: BrowserContext, request: APIRequestContext, opts: { hold?: Promise<void>; end?: (number | 'drop')[]; wildcard?: boolean } = {}): Promise<Seen[]> {
  const seen: Seen[] = [];
  await context.route(/^https:\/\/id\.localhost\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = {
      'access-control-allow-origin': opts.wildcard ? '*' : (req.headers()['origin'] ?? ''),
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'authorization, content-type',
      'cache-control': 'no-store',
      vary: 'Origin',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    seen.push({ path: `${req.method()} ${url.pathname}${url.search}`, headers: req.headers(), body: req.postData(), signOutsBefore: (await read(request)).signOuts.length });
    if (url.pathname === '/v1/sso/session') {
      await opts.hold;
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"shared":true}' });
    }
    if (url.pathname === '/v1/sso/end') {
      const status = opts.end?.shift() ?? 204;
      if (status === 'drop') return route.abort('failed');
      return route.fulfill({ status, headers: { ...cors, ...(status === 204 ? {} : { 'content-type': 'application/json' }) }, body: status === 204 ? '' : '{"error":{"code":"unavailable"}}' });
    }
    return route.fulfill({ status: 404, headers: cors });
  });
  return seen;
}

const claimsOf = (auth: string | undefined): Record<string, unknown> | null => {
  const part = auth?.split(' ')[1]?.split('.')[1];
  return part ? (JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>) : null;
};

async function signOutFromMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Sign out', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('off (no auth.sso): a sign-in, a reload and Sign out send nothing to id., and mark nothing', async ({ page, context, request }) => {
  const errors = watchConsole(page);
  const seen = await standIn(context, request);
  await signIn(page);
  await page.reload();
  await expect(shell(page)).toBeVisible();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await page.keyboard.press('Escape');
  await signOutFromMenu(page);
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  await page.waitForTimeout(500);
  expect(seen).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('ma-sso-out'))).toBeNull();
  expect(errors).toEqual([]);
});

test.describe('on', () => {
  test.beforeEach(async ({ request }) => {
    await harness(request, { sso: SSO });
  });

  test("step 1 after the callback, with the sign-in's own token, before the office is drawn; then once a page load", async ({ page, context, request }) => {
    const errors = watchConsole(page);
    let release = (): void => {};
    const seen = await standIn(context, request, { hold: new Promise((done) => (release = done)) });
    await page.goto('/');
    await expect.poll(() => seen.length).toBe(1);
    expect(page.url()).not.toContain('/auth/callback'); // the callback's address is gone, and the office waits
    await expect(shell(page)).toHaveCount(0);
    release();
    await expect(shell(page)).toBeVisible();
    const [first] = seen as [Seen];
    expect(first.path).toBe('POST /v1/sso/session');
    expect(first.body).toBe('{}');
    expect(first.headers['content-type']).toBe('application/json');
    expect(first.headers['origin']).toBe(new URL(page.url()).origin);
    expect(claimsOf(first.headers['authorization'])).toMatchObject({ token_use: 'access', sub: 'u-test' });
    await page.waitForTimeout(1_000); // the list and /v1/me answered: nothing more this load
    expect(seen).toHaveLength(1);

    await page.reload();
    await expect(shell(page)).toBeVisible();
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]!.headers['authorization']).not.toBe(first.headers['authorization']); // the refreshed token
    await page.waitForTimeout(1_000);
    expect(seen.map((s) => s.path)).toEqual(['POST /v1/sso/session', 'POST /v1/sso/session']);
    expect(errors).toEqual([]);
  });

  test('a step 1 that never answers holds the office for 4 s at most', async ({ page, context, request }) => {
    let release = (): void => {};
    await standIn(context, request, { hold: new Promise((done) => (release = done)) });
    await page.goto('/');
    await expect(shell(page)).toBeVisible({ timeout: 8_000 });
    release();
  });

  test("the request is credentialed: an answer of '*' is one the browser won't take, and the office goes on", async ({ page, context, request }) => {
    const errors = watchConsole(page);
    await standIn(context, request, { wildcard: true });
    await signIn(page);
    await expect.poll(() => errors.some((e) => e.includes("credentials mode is 'include'"))).toBe(true);
    await expect(shell(page)).toBeVisible();
  });

  test('Sign out: step 3 first, with no token, before Platform hears; then the revoke and the logout, and this tab is marked', async ({ page, context, request }) => {
    const errors = watchConsole(page);
    const seen = await standIn(context, request);
    await signIn(page);
    const at = Date.now();
    await signOutFromMenu(page);
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    const end = seen.filter((s) => s.path === 'POST /v1/sso/end');
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ body: '{}', signOutsBefore: 0 });
    expect(end[0]!.headers['authorization']).toBeUndefined();
    const { log, signOuts, revoked } = await read(request);
    expect(signOuts).toEqual([{ everywhere: false }]);
    expect(log.indexOf('GET /fake-auth/logout')).toBeGreaterThan(log.indexOf('POST /fake-auth/oauth2/revoke'));
    expect(revoked).toHaveLength(1);
    const mark = Number(await page.evaluate(() => sessionStorage.getItem('ma-sso-out')));
    expect(mark).toBeGreaterThanOrEqual(at - 1_000);
    expect(mark).toBeLessThanOrEqual(Date.now());
    expect(errors).toEqual([]);
  });

  const OTHER_APPS = "You're signed out here, but other Minimalist Alliance apps in this browser may still be signed in. On a shared computer, sign out of each of them too.";

  test('a step 3 refused with 503: the line at once, with no second try (id. cleared its cookie, so a retry would say 204)', async ({ page, context, request }) => {
    const seen = await standIn(context, request, { end: [503] });
    await signIn(page);
    await signOutFromMenu(page);
    await expect(page.getByTestId('sign-in')).toContainText(OTHER_APPS);
    await page.waitForTimeout(500);
    expect(seen.filter((s) => s.path === 'POST /v1/sso/end')).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem('ma-sso-sign-out-note'))).toBeNull(); // once
  });

  test('a step 3 with no answer: the signed-out page tries once more, and says so if that is refused', async ({ page, context, request }) => {
    const seen = await standIn(context, request, { end: ['drop', 503] });
    await signIn(page);
    await signOutFromMenu(page);
    await expect(page.getByTestId('sign-in')).toContainText(OTHER_APPS);
    expect(seen.filter((s) => s.path === 'POST /v1/sso/end')).toHaveLength(2);
  });

  test('a step 3 with no answer twice: the line', async ({ page, context, request }) => {
    const seen = await standIn(context, request, { end: ['drop', 'drop'] });
    await signIn(page);
    await signOutFromMenu(page);
    await expect(page.getByTestId('sign-in')).toContainText(OTHER_APPS);
    expect(seen.filter((s) => s.path === 'POST /v1/sso/end')).toHaveLength(2);
  });

  test('a step 3 with no answer, then its 204 on the second try: the usual line', async ({ page, context, request }) => {
    const seen = await standIn(context, request, { end: ['drop'] });
    await signIn(page);
    await signOutFromMenu(page);
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    await expect(page.getByTestId('sign-in')).not.toContainText('may still be signed in');
    expect(seen.filter((s) => s.path === 'POST /v1/sso/end')).toHaveLength(2);
  });

  test('on, Sign out is still one plain row with no line under it (the owner, Nov 16: "Just let me sign out")', async ({ page, context, request }) => {
    await standIn(context, request);
    await signIn(page);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const row = page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Sign out', exact: true });
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-describedby', /.*/);
    await expect(page.getByText('Signs you out of your office, the Forums and your account in this browser.')).toHaveCount(0);
  });

  test('signed out, the office goes to our sign-in pages as before, and asks id. nothing', async ({ page, context, request }) => {
    const seen = await standIn(context, request);
    await harness(request, { signInPath: '/_signin/', signInHolds: true });
    await page.goto('/');
    await page.waitForURL(/\/_signin\//);
    expect(seen).toEqual([]);
  });
});

test.describe('a lasting session_revoked (Sign out in another app in this browser)', () => {
  test("on, within the loop guard's 30 s: the card, in Sales' words, with the token revoked", async ({ page, context, request }) => {
    await standIn(context, request);
    await harness(request, { sso: SSO });
    await signIn(page);
    await harness(request, { sessionRevoked: true });
    await page.reload();
    await expect(page.getByTestId('sign-in')).toContainText('You were signed out. Please sign in again.');
    expect(await refreshTokenPlaces(page)).toEqual([null, null]);
    expect((await read(request)).revoked).toHaveLength(1);
  });

  for (const on of [true, false]) {
    test(on ? 'on: the refresh token is revoked and cleared, and the office goes to sign in' : 'off: the card, with the token kept, as before', async ({ page, context, request }) => {
      await standIn(context, request);
      await harness(request, { sso: on ? SSO : null });
      await signIn(page);
      await harness(request, { signInPath: '/_signin/', signInHolds: true, sessionRevoked: true });
      await page.evaluate((k) => sessionStorage.removeItem(k), GUARD_KEY); // past the loop guard, as a session revoked later is
      await page.reload();
      if (on) {
        await page.waitForURL(/\/_signin\/\?.*notice=session/);
        expect(await refreshTokenPlaces(page)).toEqual([null, null]);
        const { revoked, refreshSent } = await read(request);
        expect(revoked).toHaveLength(1);
        expect(refreshSent).not.toContain(revoked[0]); // the newest, from the refresh that didn't mend it
      } else {
        await expect(page.getByTestId('sign-in')).toContainText('Please sign in again.');
        expect((await refreshTokenPlaces(page))[0]).toMatch(/^refresh-/);
        expect((await read(request)).revoked).toEqual([]);
      }
    });
  }
});

test.describe('30 days from signedInAt, whatever the choice', () => {
  for (const on of [true, false]) {
    test(on ? 'on: nothing sent, the token revoked, and sign-in with the plain line' : 'off: refreshed as before', async ({ page, context, request }) => {
      await standIn(context, request);
      await harness(request, { sso: on ? SSO : null, signInPath: '/_signin/', signInHolds: true, staySignedIn: '30d' });
      await page.goto('/__harness');
      await page.evaluate((key) => {
        localStorage.setItem(key, 'refresh-planted');
        localStorage.setItem('ma-desk-web-signed-in-at', String(Math.floor(Date.now() / 1000) - 31 * 86_400));
        localStorage.setItem('ma-desk-web-session-choice', JSON.stringify({ staySignedIn: '30d', staySignedInSince: null }));
      }, KEY);
      await page.goto('/');
      if (on) {
        await page.waitForURL(/\/_signin\/\?.*notice=session/);
        const after = await read(request);
        expect(after.refreshSent).toEqual([]);
        expect(after.revoked).toEqual(['refresh-planted']);
        expect(await refreshTokenPlaces(page)).toEqual([null, null]);
      } else {
        await expect(shell(page)).toBeVisible();
        await expect.poll(async () => (await read(request)).refreshSent).toEqual(['refresh-planted']);
        expect((await read(request)).revoked).toEqual([]);
      }
    });
  }
});
