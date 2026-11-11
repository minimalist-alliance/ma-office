// The built avatar (acct-avatar): GET /v1/me carries `avatar: { kind: 'built', config }` and the account button draws it
// with the real vendored kit, as an <img> in the avatar's cut-out, at 32 px; in the menu's header at 40 px. When the kit's
// chunk can't load, the initials stay. Light and dark.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const RECIPE = { kind: 'built', kit: 1, skin: 4, face: 'smile', hair: 'wavy', bg: 3 };
const A = 'd-personal00001';
const layout = { desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 360, items: [] } }, z: [A] };
const account = (page: Page) => page.getByRole('button', { name: 'Account', exact: true });

async function open(page: Page, request: Parameters<typeof harness>[0], avatar: unknown, theme: ThemeId): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await page.addInitScript((d) => {
    if (localStorage.getItem('test.seeded')) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify(layout));
  await harness(request, { reset: true });
  await harness(request, { fleet: [{ deskId: A, name: 'Personal', kind: 'personal', state: 'running', allowedActions: ['connect', 'stop', 'rename'] }], avatar });
  await signIn(page);
  await canvasPainted(page);
  return errors;
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`built avatar, ${theme}`, () => {
    test('the account button draws it at 32 px and the menu at 40 px', async ({ page, request }) => {
      await open(page, request, { kind: 'built', config: RECIPE, setAt: '2026-11-09T10:00:00Z' }, theme);
      const img = account(page).locator('.avatar-face img.avatar-picture');
      await expect(img).toBeVisible();
      await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml;charset=utf-8,/);
      await expect(account(page).locator('.avatar-face')).toHaveAttribute('data-initials', '');
      const box = await account(page).locator('.avatar').boundingBox();
      expect(Math.round(box!.width)).toBe(32);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      expect(decodeURIComponent((await img.getAttribute('src'))!.split(',')[1]!)).toMatch(/^<svg[^>]*width="32"/);
      await account(page).click();
      const big = page.getByRole('dialog', { name: 'Account' }).locator('.menu-me .avatar-face img');
      await expect(big).toBeVisible();
      expect(decodeURIComponent((await big.getAttribute('src'))!.split(',')[1]!)).toMatch(/^<svg[^>]*width="40"/);
    });

    test('a recipe the check refuses, or no avatar, is the initials', async ({ page, request }) => {
      await open(page, request, { kind: 'built', config: { ...RECIPE, kit: 2 }, setAt: '2026-11-09T10:00:00Z' }, theme);
      await expect(account(page).locator('.avatar')).toBeVisible();
      await expect(account(page).locator('.avatar-face')).toHaveAttribute('data-initials', 'TM');
      await expect(account(page).locator('img')).toHaveCount(0);
    });

    test('the initials stay when the kit fails to load', async ({ page, request }) => {
      await page.route(/avatar-kit[^/]*\.js/, (route) => route.abort());
      await open(page, request, { kind: 'built', config: RECIPE, setAt: '2026-11-09T10:00:00Z' }, theme);
      await expect(account(page).locator('.avatar')).toBeVisible();
      await page.waitForTimeout(800);
      await expect(account(page).locator('.avatar-face')).toHaveAttribute('data-initials', 'TM');
      await expect(account(page).locator('img')).toHaveCount(0);
    });
  });
}
