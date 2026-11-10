// The simplified view (task 47) in the bundle exactly as it ships: real loader, default CSP, the real link. No desk
// answers here, so this stops at the chunk and its stylesheet's fonts; `simple.shell.spec.ts` runs the view on the mock.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const DESK = 'd-personal00001';
const fleet = [{ deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' }];

/** A browser's own line for a failed request isn't the app's, and the harness has no real desk behind `connect`. */
const ownErrors = (errors: string[]): string[] => errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_'));

async function openBrowser(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('the kill switch, simpleView: { enabled: false }: neither the chunk nor its stylesheet is ever fetched', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet, simpleView: { enabled: false } });
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('SimpleLayer') || /\/assets\/simple-[\w-]+\.css$/.test(r.url())) chunks.push(r.url());
  });
  await signIn(page);
  await canvasPainted(page);
  const config = await page.evaluate(async () => (await fetch('/v1/client-config?app=desk-web')).json());
  expect(config).toHaveProperty('simpleView', { enabled: false });
  await openBrowser(page);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('browser-simple')).toHaveCount(0);
  expect(chunks).toEqual([]);
  // The app's stylesheet doesn't carry the view's rules either, and the loader's manifest lists the app's alone.
  const sheets = await page.evaluate(() => [...document.styleSheets].map((s) => s.href ?? ''));
  expect(sheets.filter((h) => /simple-/.test(h))).toEqual([]);
  expect(ownErrors(errors)).toEqual([]);
});

test('on, as on prod with no simpleView block: opening the Browser loads its own chunk and stylesheet under the default CSP, with no violation', async ({ page, request }) => {
  const errors = watchConsole(page);
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await harness(request, { fleet });
  const chunks: string[] = [];
  const sheets: string[] = [];
  page.on('request', (r) => {
    if (/\/assets\/SimpleLayer-[\w-]+\.js$/.test(r.url())) chunks.push(r.url());
    if (/\/assets\/simple-[\w-]+\.css$/.test(r.url())) sheets.push(r.url());
  });
  await signIn(page);
  await canvasPainted(page);
  expect(await page.evaluate(async () => (await fetch('/v1/client-config?app=desk-web')).json())).not.toHaveProperty('simpleView');
  expect(chunks).toEqual([]); // the office never loads it
  expect(sheets).toEqual([]);
  await openBrowser(page);
  await expect.poll(() => chunks.length).toBe(1);
  // Its stylesheet comes with it, as a file of its own: the chunk asks for it as it arrives, and resolves once it has loaded.
  await expect.poll(() => sheets.length).toBe(1);
  await expect.poll(() => page.evaluate(() => [...document.styleSheets].some((s) => /\/simple-[\w-]+\.css$/.test(s.href ?? '')))).toBe(true);
  // The chunk's code runs under the CSP: it can be imported and its parts are there (the bundler names its exports, as
  // the window and the bar import them by name).
  const loaded = await page.evaluate(async (url) => Object.values(await import(url)).filter((v) => typeof v === 'function').length, chunks[0] as string);
  expect(loaded).toBeGreaterThanOrEqual(2);
  expect(violations).toEqual([]);
  expect(ownErrors(errors)).toEqual([]);
});
