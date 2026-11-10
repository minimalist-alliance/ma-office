// The export page in the bundle exactly as it ships: its own chunk, loaded under the default CSP through the real
// loader path, with the real link. No desk answers here, so this stops at the page itself; `export.shell.spec.ts`
// runs the download on the mock.
import { expect, test } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('with export on, /export loads its own chunk and shows the desks and the account', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { export: { enabled: true, moves: false } });
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (/\/assets\/ExportPage-[\w-]+\.js$/.test(r.url())) chunks.push(r.url());
  });
  await signIn(page);
  expect(chunks).toEqual([]); // the office never loads it
  await page.goto('/export');
  await expect(page.getByRole('heading', { name: 'Your data', level: 1 })).toBeVisible();
  await expect(page.getByTestId('export-start')).toBeEnabled();
  await expect(page.getByLabel(/Personal/)).toBeChecked();
  expect(chunks).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('with export off, /export is the office and the chunk is never fetched', async ({ page }) => {
  const errors = watchConsole(page);
  const chunks: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('ExportPage')) chunks.push(r.url());
  });
  await signIn(page);
  await page.goto('/export');
  await expect(page.locator('.ma-shell')).toBeVisible();
  await expect(page.getByTestId('export-page')).toHaveCount(0);
  expect(chunks).toEqual([]);
  expect(errors).toEqual([]);
});
