// "Sign out everywhere" in the account menu (Security's signin-mfa-5, contract auth.md section 6): every session the
// member has ends, for a lost laptop, and then this browser signs out as Sign out does. It has to hear yes from Platform
// first: if it doesn't, nothing ends, and the menu says so.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, refreshTokenPlaces, signIn, storedRefreshToken, watchConsole } from './helpers';

interface Harness { log: string[]; signOuts: unknown[]; revoked: string[] }
const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('it sits under Sign out, says everywhere to Platform, then signs this browser out as Sign out does', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  const token = await storedRefreshToken(page);
  await openMenu(page);
  const menu = page.getByRole('dialog', { name: 'Account' });
  const buttons = menu.getByRole('button');
  const names = await buttons.allInnerTexts();
  expect(names.indexOf('Sign out everywhere')).toBe(names.indexOf('Sign out') + 1);
  await menu.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  const { log, signOuts, revoked } = await read(request);
  expect(signOuts).toEqual([{ everywhere: true }]);
  const at = (line: string): number => log.indexOf(line);
  expect(at('POST /fake-auth/oauth2/revoke')).toBeGreaterThan(at('POST /v1/me/sign-out'));
  expect(at('GET /fake-auth/logout')).toBeGreaterThan(at('POST /fake-auth/oauth2/revoke'));
  expect(revoked).toEqual([token]);
  expect(await storedRefreshToken(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('Sign out on its own still says only this browser', async ({ page, request }) => {
  await signIn(page);
  await openMenu(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect((await read(request)).signOuts).toEqual([{ everywhere: false }]);
});

test('while Platform answers: "Signing out everywhere…", Sign out waits, and a second press starts nothing', async ({ page, request }) => {
  await signIn(page);
  await harness(request, { signOutDelayMs: 1_500 });
  await openMenu(page);
  const everywhere = page.getByTestId('sign-out-everywhere');
  await everywhere.click();
  await expect(everywhere).toHaveText('Signing out everywhere…');
  await expect(everywhere).toHaveAttribute('aria-disabled', 'true');
  await expect(everywhere).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeDisabled();
  await everywhere.click({ force: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click({ force: true });
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  const { log, signOuts } = await read(request);
  expect(signOuts).toEqual([{ everywhere: true }]);
  expect(log.filter((l) => l === 'GET /fake-auth/logout')).toHaveLength(1);
});

test("a refusal ends nothing: the office stays, the token stays, the line says so, and a second try works", async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  const token = await storedRefreshToken(page);
  await harness(request, { signOutFails: 503 });
  const lists = (await read(request)).log.filter((l) => l === 'GET /v1/desks').length;
  await openMenu(page);
  const everywhere = page.getByTestId('sign-out-everywhere');
  await everywhere.click();
  const line = page.getByTestId('sign-out-everywhere-failed');
  await expect(line).toHaveText("We couldn't sign you out everywhere. Try again.");
  await expect(line).toHaveAttribute('role', 'alert');
  await expect(everywhere).toHaveText('Sign out everywhere');
  await expect(everywhere).not.toHaveAttribute('aria-disabled', 'true');
  await expect(everywhere).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled();
  await expect(page.locator('.ma-shell')).toBeVisible();
  let state = await read(request);
  expect(state.log).not.toContain('POST /fake-auth/oauth2/revoke');
  expect(state.log.filter((l) => l.includes('/logout'))).toEqual([]);
  expect(await storedRefreshToken(page)).toBe(token);

  // The office carries on: its list's poll, stopped for the sign-out, starts again.
  await expect.poll(async () => (await read(request)).log.filter((l) => l === 'GET /v1/desks').length).toBeGreaterThan(lists);

  await harness(request, { signOutFails: null });
  await everywhere.click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  state = await read(request);
  expect(state.signOuts).toEqual([{ everywhere: true }, { everywhere: true }]);
  expect(state.revoked).toEqual([token]);
  // The failed call's own 503 is the browser's line, not ours.
  expect(errors.filter((e) => !e.includes('503'))).toEqual([]);
});

test('Sign out after a refusal clears the line and signs out here only', async ({ page, request }) => {
  await signIn(page);
  await harness(request, { signOutFails: 503 });
  await openMenu(page);
  await page.getByTestId('sign-out-everywhere').click();
  await expect(page.getByTestId('sign-out-everywhere-failed')).toBeVisible();
  await harness(request, { signOutFails: null });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('sign-out-everywhere-failed')).toBeHidden();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  expect((await read(request)).signOuts).toEqual([{ everywhere: true }, { everywhere: false }]);
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
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.", { timeout: 10_000 });
    const { log, signOuts, revoked } = await read(request);
    expect(signOuts).toEqual([{ everywhere: false }]);
    expect(log).toContain('POST /fake-auth/oauth2/revoke');
    expect(log).toContain('GET /fake-auth/logout');
    expect(revoked).toEqual([token]);
    expect(await storedRefreshToken(page)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('Sign out everywhere past its 15 s wait ends nothing: the line says so, the office and the token stay, and a try once Platform answers works', async ({ page, request }) => {
    test.setTimeout(60_000);
    const errors = watchConsole(page);
    await signIn(page);
    await canvasPainted(page);
    const token = await storedRefreshToken(page);
    await harness(request, { signOutDelayMs: 17_000 }); // past EVERYWHERE_WAIT_MS (15 s): no answer is no yes
    await openMenu(page);
    const everywhere = page.getByTestId('sign-out-everywhere');
    await everywhere.click();
    await expect(everywhere).toHaveText('Signing out everywhere…');
    const line = page.getByTestId('sign-out-everywhere-failed');
    await expect(line).toHaveText("We couldn't sign you out everywhere. Try again.", { timeout: 20_000 });
    await expect(everywhere).toHaveText('Sign out everywhere');
    await expect(page.locator('.ma-shell')).toBeVisible();
    const state = await read(request);
    expect(state.signOuts).toEqual([{ everywhere: true }]);
    expect(state.log).not.toContain('POST /fake-auth/oauth2/revoke');
    expect(state.log.filter((l) => l.includes('/logout'))).toEqual([]);
    expect(await storedRefreshToken(page)).toBe(token);

    await harness(request, { signOutDelayMs: 0 });
    await everywhere.click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    const after = await read(request);
    expect(after.signOuts).toEqual([{ everywhere: true }, { everywhere: true }]);
    expect(after.revoked).toEqual([token]);
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
  await page.getByTestId('sign-out-everywhere').click();
  await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
  // The one refresh token this browser held is gone from the other tab's view too.
  expect(await refreshTokenPlaces(two)).toEqual([null, null]);

  // Every session has ended, so Platform refuses the other tab's access token from now on; its next look at the list
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
