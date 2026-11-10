// The export page's two save moments, as a member meets them (launch sweep LS-15 and LS-16): a save window that never
// comes back leaves the page saying it waits for it, and the finished archive's Save is a button, by role and by Space.
import { expect, test } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, { export: { enabled: true, moves: false } });
});

test('while the browser’s save window is open, the page says so and Download waits', async ({ page }) => {
  const errors = watchConsole(page);
  await page.addInitScript(() => {
    // A save window that sits behind the page, or that the browser blocked: it never answers.
    (window as unknown as { showSaveFilePicker: () => Promise<never> }).showSaveFilePicker = () => new Promise<never>(() => {});
  });
  await signIn(page);
  await page.goto('/export');
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-picking')).toHaveText('Choose where to save it in the window your browser opened.');
  await expect(page.getByTestId('export-start')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('"Save the ZIP" is a button, and Space saves it', async ({ page }) => {
  const errors = watchConsole(page);
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await signIn(page);
  await page.goto('/export');
  await page.getByTestId('export-start').click();
  const save = page.getByRole('button', { name: 'Save the ZIP' });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await save.focus();
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Space')]);
  expect(download.suggestedFilename()).toMatch(/^minimalist-alliance-export-.*\.zip$/);
  await page.getByRole('button', { name: 'Done' }).click();
  expect(errors).toEqual([]);
});
