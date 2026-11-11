// The accessibility pass of Nov 10, Account settings: it's modal for the keyboard too, so Tab never leaves it for the
// office hidden behind it (WCAG 2.4.3 and 2.4.11), and "Your data" adds no second banner landmark.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** The account page, standing in, with a control of its own, so Tab goes into the frame and out the other side. */
async function standIn(page: Page): Promise<void> {
  await page.context().route('https://platform.localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Platform</title><h1>Platform account</h1><button>Change</button><script>
        parent.postMessage({ type: 'ma-account', state: 'ready' }, '*');
        addEventListener('keydown', (e) => { if (e.key === 'Escape') parent.postMessage({ type: 'ma-account', state: 'escape' }, '*'); });
      </script>`,
    }),
  );
}

/**
 * Where focus is: inside Account settings (its frame included), or somewhere else, said as a short name. Past the modal's
 * last control Tab goes to the page itself (in a real window, the browser's own bar) and on round to its first, as a
 * <dialog> opened with showModal() does: that's 'settings' too. Never anything in the office.
 */
const where = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return document.querySelector('[data-testid="account-settings"]') ? 'settings' : 'body';
    if (el.closest('[data-testid="account-settings"]')) return 'settings';
    return `${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40)}"`;
  });

/** The shell's own children that are inert now. */
const inert = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('.ma-shell > [inert]')).map((el) => el.className || el.tagName));

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function openByKeyboard(page: Page): Promise<void> {
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await account.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Account' }).getByRole('button', { name: 'Account settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Account settings', exact: true })).toBeVisible();
  await expect(page.getByTestId('account-section')).toHaveAttribute('data-frame', 'ready');
}

test('Tab and Shift+Tab stay inside Account settings, frame and all, and the office comes back when it closes', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { accountFrame: true, export: { enabled: true, moves: false } });
  await standIn(page);
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await openByKeyboard(page);
  expect(await where(page)).toBe('settings');
  // Everything beside it in the shell is out of reach: the top bar, the desks and their bars, the windows, Maia.
  expect(await inert(page)).toEqual(expect.arrayContaining(['topbar', 'desks-main']));

  const seen = new Set<string>();
  let wentIntoFrame = false;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    const at = await where(page);
    expect(at, `Tab ${i + 1}`).toBe('settings');
    seen.add(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? ''));
    if (await page.evaluate(() => document.activeElement?.tagName === 'IFRAME')) wentIntoFrame = true;
  }
  expect(wentIntoFrame, 'Tab reached the account page in the frame').toBe(true);
  expect(seen.size).toBeGreaterThan(1); // it went round, not stuck on one control
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await where(page), `Shift+Tab ${i + 1}`).toBe('settings');
  }
  expect(await axe(page)).toEqual([]);

  // Esc closes it, focus is back on the Account button, and nothing in the office is inert any more.
  await page.getByTestId('account-settings-close').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Account settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeFocused();
  expect(await inert(page)).toEqual([]);
  await page.keyboard.press('Tab');
  expect(await where(page)).not.toBe('settings');

  // And the same by its Close button.
  await openByKeyboard(page);
  await page.getByTestId('account-settings-close').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeFocused();
  expect(await inert(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('something that mounts in the office while Account settings is open is out of reach too, and comes back after', async ({ page, request }) => {
  await harness(request, { accountFrame: true });
  await standIn(page);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await openByKeyboard(page);
  // A layer the shell adds while it's open (as a menu or a list would be).
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'late';
    b.textContent = 'Late';
    document.querySelector('.ma-shell')!.appendChild(b);
  });
  await expect.poll(() => page.evaluate(() => (document.getElementById('late') as HTMLElement & { inert: boolean }).inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Account settings', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (document.getElementById('late') as HTMLElement & { inert: boolean }).inert)).toBe(false);
});

test('"Your data" in Account settings has no banner of its own; the page on its own keeps its header', async ({ page, request }) => {
  await harness(request, { accountFrame: true, export: { enabled: true, moves: false } });
  await standIn(page);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await openByKeyboard(page);
  await page.getByRole('tab', { name: 'Your data' }).click();
  await expect(page.getByTestId('export-panel')).toBeVisible();
  // The office's top bar is the one banner; inert, it's out of the tree while the modal is open, and Your data adds none.
  await expect(page.locator('header')).toHaveCount(1);
  expect((await axe(page)).filter((v) => /^landmark/.test(v))).toEqual([]);
  await page.keyboard.press('Escape');

  // The page on its own keeps its header (inside its <main>, as before).
  await page.goto('/export');
  await expect(page.getByRole('heading', { level: 1, name: 'Your data' })).toBeVisible();
  await expect(page.locator('header.xp-head')).toHaveCount(1);
});
