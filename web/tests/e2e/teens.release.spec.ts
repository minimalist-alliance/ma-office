// Teens in the bundle exactly as it ships (task 40): real loader, default CSP, real auth, the real link. With none of the
// new fields, as in prod until the Alliance tier opens, the office is what it was. With them, a teen has no Agent, the
// cards are a teen's, and the report row goes to the Platform app.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const ACCOUNT = 'https://platform.localhost/account';
const REPORT = 'https://platform.localhost/report';
const ALLIANCE_OPEN = { enabled: true, memberMonthlyUsd: 100, allianceMonthlyUsd: 5 };
const DESK = 'd-personal00001';
const fleet = [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'stopped' }];

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

const card = (page: Page): Locator => page.locator('.desk-notice');
const reportRow = (page: Page): Locator => page.getByRole('link', { name: 'Report a safety concern', exact: true });
const appNames = async (page: Page): Promise<string[]> => {
  const names = await page.getByRole('group', { name: 'Personal desk' }).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return ['Chat', 'Notebook', 'Browser', 'Agent'].filter((app) => names.some((n) => n.startsWith(app)));
};

/** A browser's own line for a failed request isn't the app's, and the harness has no real desk behind `connect`. */
const ownErrors = (errors: string[]): string[] => errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_'));

test("prod's defaults: no ageRules and no band, so every app and no report row", async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet });
  await signIn(page);
  await canvasPainted(page);
  const config = await page.evaluate(async () => (await fetch('/v1/client-config?app=desk-web')).json());
  expect(config).not.toHaveProperty('ageRules');
  expect(await appNames(page)).toEqual(['Chat', 'Notebook', 'Browser', 'Agent']);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(reportRow(page)).toHaveCount(0);
  expect(ownErrors(errors)).toEqual([]);
});

test('a teen on the shipping bundle: no Agent, under the default CSP, and the report row', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { age: 'teen', fleet });
  await signIn(page);
  await canvasPainted(page);
  expect(await appNames(page)).toEqual(['Chat', 'Notebook', 'Browser']);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(reportRow(page)).toHaveAttribute('href', REPORT);
  await expect(reportRow(page)).toHaveAttribute('target', '_blank');
  const said = await page.evaluate(() => document.body.innerText);
  expect(said).not.toMatch(/\bagents?\b|claude/i);
  expect(await page.evaluate(() => localStorage.getItem('ma.layout.v2') ?? '')).not.toMatch(/agent/);
  expect(ownErrors(errors)).toEqual([]);
});

test('a teen on the shipping bundle, by address: /agent is the office, with no window', async ({ page, request }) => {
  await harness(request, { age: 'teen', fleet });
  await signIn(page, '/agent');
  await canvasPainted(page);
  await expect(page.locator('.ma-window')).toHaveCount(0);
  expect(await appNames(page)).toEqual(['Chat', 'Notebook', 'Browser']);
});

test('the shipping bundle ignores the mock\'s and dev\'s own switches', async ({ page, request }) => {
  await harness(request, { fleet });
  await signIn(page, '/?age=teen&agent=needs-you');
  await canvasPainted(page);
  expect(await appNames(page)).toEqual(['Chat', 'Notebook', 'Browser', 'Agent']);
});

test('a teen waiting on a parent on the shipping bundle: the calm card and its link', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { age: 'teen-parent-pending' });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'P');
  await expect(card(page).getByRole('link', { name: 'Send the email again', exact: true })).toHaveAttribute('href', ACCOUNT);
  expect(await card(page).innerText()).not.toMatch(/\bpay|billing|membership|\$/i);
  expect(ownErrors(errors)).toEqual([]);
});

test('an unpaid teen on the shipping bundle: one small desk, and Platform\'s own config asked under the CSP', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { age: 'teen-unpaid', platformBilling: ALLIANCE_OPEN });
  await signIn(page);
  await expect(card(page)).toHaveAttribute('data-card', 'T');
  await expect(card(page).locator('.desk-notice-etch')).toHaveText(['Personal']);
  await expect(card(page).getByRole('link', { name: 'How joining works', exact: true })).toHaveAttribute('href', ACCOUNT);
  expect(await card(page).innerText()).not.toMatch(/\bPro\b|officer|\$|\bwork\b/i);
  expect(ownErrors(errors)).toEqual([]);
});

test('an adult on the shipping bundle: every app, card A, and the report row', async ({ page, request }) => {
  await harness(request, { age: 'adult', fleet });
  await signIn(page);
  await canvasPainted(page);
  expect(await appNames(page)).toEqual(['Chat', 'Notebook', 'Browser', 'Agent']);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(reportRow(page)).toHaveAttribute('href', REPORT);
});

test('a slow /v1/me on a new browser, on the shipping bundle: the Agent never reaches the page', async ({ page, request }) => {
  await harness(request, { age: 'teen', fleet });
  await page.addInitScript(() => {
    const w = window as unknown as { __agentSeen: boolean };
    w.__agentSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[aria-label^="Agent"]')) w.__agentSeen = true;
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
  });
  await page.route('**/v1/me', async (route) => {
    await new Promise((done) => setTimeout(done, 1_500));
    await route.continue();
  });
  await signIn(page);
  await expect(page.getByRole('group', { name: 'Personal desk' })).toHaveCount(1, { timeout: 8_000 });
  expect(await appNames(page)).toEqual(['Chat', 'Notebook', 'Browser']);
  expect(await page.evaluate(() => (window as unknown as { __agentSeen: boolean }).__agentSeen)).toBe(false);
});
