// "Sign out everywhere" in the account menu (Security's signin-mfa-5, contract auth.md section 6): every session the
// member has ends, for a lost laptop, and then this browser signs out as Sign out does. It has to hear yes from Platform
// first: if it doesn't, nothing ends, and the menu says so.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, storedRefreshToken, watchConsole } from './helpers';

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
