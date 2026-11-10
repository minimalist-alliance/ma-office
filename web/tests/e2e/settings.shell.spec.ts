// Account settings (ADR 0052): a full-screen modal over the office, never a new tab or page, with the Platform app's
// account page framed in it once Platform allows that (ma-platform contract hostnames.md, 0.3.49), the page on its own
// until then, and "Your data" beside it.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const ACCOUNT = 'https://platform.localhost/account';

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** The account page, standing in: it says `state` to the office as Platform's does, and sends its Esc on. */
async function standIn(page: Page, state: 'ready' | 'signed-out' | null): Promise<void> {
  await page.context().unrouteAll();
  await page.context().route('https://platform.localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Platform</title><h1>Platform account</h1><script>
        ${state ? `parent.postMessage({ type: 'ma-account', state: '${state}' }, '*');` : ''}
        addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage({ type: 'ma-account', state: 'escape' }, '*'); });
      </script>`,
    }),
  );
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Account settings', exact: true });
  await expect(settings).toBeVisible();
  return settings;
}

test('full screen over the office: the account page shows once it says it\'s ready, and Esc in it closes', async ({ page, request }) => {
  await harness(request, { accountFrame: true });
  await standIn(page, 'ready');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const view = await page.evaluate(() => localStorage.getItem('ma.view.v1'));
  const settings = await openSettings(page);
  await expect(page.getByTestId('account-section')).toHaveAttribute('data-frame', 'ready');
  const frame = page.getByTestId('account-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', `${ACCOUNT}?embed=office`);
  await expect(page.frameLocator('[data-testid="account-frame"]').getByRole('heading', { name: 'Platform account' })).toBeVisible();
  // The whole screen, but for the office's own small margin.
  const box = (await settings.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.width).toBeGreaterThanOrEqual(vp.width - 24);
  expect(box.height).toBeGreaterThanOrEqual(vp.height - 24);
  await expect(settings).not.toContainText('opens in a new tab');

  // Esc pressed inside the frame comes over as a message, and closes it.
  await page.frameLocator('[data-testid="account-frame"]').getByRole('heading', { name: 'Platform account' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeFocused();
  // The office is as it was.
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => localStorage.getItem('ma.view.v1'))).toBe(view);
});

test('refused by the office\'s own CSP, as in prod until Platform ships: the account page on its own, at once', async ({ page }) => {
  await standIn(page, 'ready');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const settings = await openSettings(page);
  const fallback = page.getByTestId('account-fallback');
  await expect(fallback).toBeVisible({ timeout: 3000 }); // well before the wait for a silent frame
  await expect(fallback).toContainText('Test Member');
  const open = settings.getByRole('link', { name: 'Open account settings', exact: true });
  await expect(open).toHaveAttribute('href', ACCOUNT);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(page.getByTestId('account-frame')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
});

test('a frame that never says it\'s ready gives way to the account page on its own', async ({ page, request }) => {
  await harness(request, { accountFrame: true });
  await standIn(page, null);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await openSettings(page);
  await expect(page.getByTestId('account-frame')).toBeHidden(); // never the browser's error, never a blank page
  await expect(page.getByTestId('account-fallback')).toBeVisible({ timeout: 15_000 });
});

test('signed out on Platform: a way to sign in there, and the frame tries again on the way back', async ({ page, request }) => {
  await harness(request, { accountFrame: true });
  await standIn(page, 'signed-out');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const settings = await openSettings(page);
  await expect(page.getByTestId('account-signed-out')).toBeVisible();
  const signInLink = settings.getByRole('link', { name: 'Sign in', exact: true });
  await expect(signInLink).toHaveAttribute('href', ACCOUNT);
  await expect(signInLink).toHaveAttribute('target', '_blank');
  await standIn(page, 'ready');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByTestId('account-section')).toHaveAttribute('data-frame', 'ready');
  await expect(page.getByTestId('account-frame')).toBeVisible();
});

test('only from that frame: a message from anywhere else changes nothing', async ({ page, request }) => {
  await harness(request, { accountFrame: true });
  await standIn(page, null);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const settings = await openSettings(page);
  await page.evaluate(() => window.postMessage({ type: 'ma-account', state: 'escape' }, '*'));
  await page.evaluate(() => window.postMessage({ type: 'ma-account', state: 'ready' }, '*'));
  await page.waitForTimeout(300);
  await expect(settings).toBeVisible();
  await expect(page.getByTestId('account-section')).toHaveAttribute('data-frame', 'loading');
});

test('Your data sits beside the account page, and the tabs work from the keyboard', async ({ page, request }) => {
  await harness(request, { export: { enabled: true, moves: false } });
  await standIn(page, 'ready');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const settings = await openSettings(page);
  const account = settings.getByRole('tab', { name: 'Account' });
  const data = settings.getByRole('tab', { name: 'Your data' });
  await expect(account).toHaveAttribute('aria-selected', 'true');
  await data.focus();
  await page.keyboard.press('Enter');
  await expect(data).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByTestId('export-panel')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Download your data' })).toBeVisible();
  await expect(page.getByTestId('account-section')).toBeHidden();
});

test('a phone gets the whole screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const settings = await openSettings(page);
  await expect(page.getByTestId('account-fallback')).toBeVisible();
  expect(await settings.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noScroll).toBe(true);
  await ctx.close();
});
