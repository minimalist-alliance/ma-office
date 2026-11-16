// Sign out in the account menu (contract auth.md section 6): one plain row at the menu's foot, one press, no confirm (the
// owner, Nov 16, on 6.10's split button: "This is weird and unnecessary. Just let me sign out"). It ends this browser's
// session only (`{"everywhere": false}`): Sign out everywhere is the account's own, in Account settings (the Platform app's
// Account menu), and the office menu no longer has it. While it runs the row says "Signing out…" and a second press does
// nothing; with Platform not answering it still ends here after its wait; and the member's other tab ends up signed out too.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, refreshTokenPlaces, signIn, storedRefreshToken, watchConsole } from './helpers';

interface Harness { log: string[]; signOuts: unknown[]; revoked: string[] }
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
}
const signOutRow = (page: Page) => page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Sign out', exact: true });

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('one row at the foot, no Sign out everywhere: it says this browser only to Platform, then the revoke and the logout', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  const token = await storedRefreshToken(page);
  await openMenu(page);
  const menu = page.getByRole('dialog', { name: 'Account' });
  // The last control in the menu, a row like Account settings: no chevron, no second part, no line under it.
  const names = await menu.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''));
  expect(names.at(-1)).toBe('Sign out');
  await expect(menu.getByText(/everywhere/i)).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'More ways to sign out' })).toHaveCount(0);
  await expect(signOutRow(page)).toHaveClass(/\bmenu-item\b/);
  await expect(signOutRow(page)).not.toHaveAttribute('aria-expanded', /.*/);
  await signOutRow(page).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  const { log, signOuts, revoked } = await read(request);
  expect(signOuts).toEqual([{ everywhere: false }]);
  const at = (line: string): number => log.indexOf(line);
  expect(at('POST /fake-auth/oauth2/revoke')).toBeGreaterThan(at('POST /v1/me/sign-out'));
  expect(at('GET /fake-auth/logout')).toBeGreaterThan(at('POST /fake-auth/oauth2/revoke'));
  expect(revoked).toEqual([token]);
  expect(await storedRefreshToken(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('while Platform answers: "Signing out…", the row waits, and a second press starts nothing', async ({ page, request }) => {
  await signIn(page);
  await harness(request, { signOutDelayMs: 1_500 });
  await openMenu(page);
  const row = signOutRow(page);
  await row.click();
  await expect(page.getByTestId('menu-sign-out')).toHaveText('Signing out…');
  await expect(page.getByTestId('menu-sign-out')).toBeDisabled();
  await page.getByTestId('menu-sign-out').click({ force: true });
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  const { log, signOuts } = await read(request);
  expect(signOuts).toEqual([{ everywhere: false }]);
  expect(log.filter((l) => l === 'GET /fake-auth/logout')).toHaveLength(1);
});

// ----- the regression set: no answer from Platform, and the member's other tab
test.describe('with no answer from Platform', () => {
  test('Sign out past its 3 s wait still ends the session here: the card, the revoke and the logout, the token gone', async ({ page, request }) => {
    const errors = watchConsole(page);
    await signIn(page);
    await canvasPainted(page);
    const token = await storedRefreshToken(page);
    await harness(request, { signOutDelayMs: 20_000 }); // longer than SIGN_OUT_WAIT_MS (3 s): the call is never cancelled, only not waited for
    await openMenu(page);
    await signOutRow(page).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.", { timeout: 10_000 });
    const { log, signOuts, revoked } = await read(request);
    expect(signOuts).toEqual([{ everywhere: false }]);
    expect(log).toContain('POST /fake-auth/oauth2/revoke');
    expect(log).toContain('GET /fake-auth/logout');
    expect(revoked).toEqual([token]);
    expect(await storedRefreshToken(page)).toBeNull();
    expect(errors).toEqual([]);
  });
});

test('a second tab on the same origin ends up signed out too: its token is gone with the first, and its next call is refused', async ({ page, context, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  const two = await context.newPage();
  const errorsTwo = watchConsole(two);
  await two.goto('/');
  await expect(two.locator('.ma-shell')).toBeVisible();
  await expect(two.getByRole('group', { name: /desk$/ }).first()).toBeAttached();

  await page.bringToFront();
  await openMenu(page);
  await signOutRow(page).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  // The one refresh token this browser held is gone from the other tab's view too.
  expect(await refreshTokenPlaces(two)).toEqual([null, null]);

  // This browser's session has ended (both tabs held it), so Platform refuses the other tab's access token from now on; its next look at the list
  // finds no token to refresh with, and it shows the card rather than going round to sign-in by itself.
  await harness(request, { desksUnauthorized: true });
  await two.bringToFront();
  await two.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(two.getByTestId('sign-in')).toContainText('Please sign in again.', { timeout: 20_000 });
  await expect(two.getByRole('group', { name: /desk$/ })).toHaveCount(0);
  expect(await refreshTokenPlaces(two)).toEqual([null, null]);
  expect(errors).toEqual([]);
  expect(errorsTwo.filter((e) => !e.includes('401'))).toEqual([]); // the refused call's own 401 is the browser's line
});
