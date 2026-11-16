// The built avatar (acct-avatar): GET /v1/me carries `avatar: { kind: 'built', config }` and the account button draws it
// with the real vendored kit, as an <img> in the avatar's cut-out, filling the 38 px button; in the menu's header at 40
// px. Both take the kit's full artwork, framed a little closer (1.14 times). When the kit's chunk can't load, the initials
// stay. Light and dark. And the button is its avatar (the owner, Nov 16): its neighbours' size and edge, no ring round it.
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
    // Seeded on the first load that's signed in: a start with nobody signed in wipes the layout's mirror (ISS-67).
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
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
      expect(Math.round(box!.width)).toBe(38);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
      expect(decodeURIComponent((await img.getAttribute('src'))!.split(',')[1]!)).toMatch(/^<svg[^>]*width="40"/);
      await expect(img).toHaveClass(/avatar-built/);
      expect(await img.evaluate((el) => getComputedStyle(el).transform)).toBe('matrix(1.14, 0, 0, 1.14, 0, 0)');
      await account(page).click();
      const big = page.getByRole('dialog', { name: 'Account' }).locator('.menu-me .avatar-face img');
      await expect(big).toBeVisible();
      expect(decodeURIComponent((await big.getAttribute('src'))!.split(',')[1]!)).toMatch(/^<svg[^>]*width="40"/);
    });

    test('the account button is its avatar: the bell\'s size and edge, with no ring of its own, at 38 and 36 px', async ({ page, request }) => {
      await open(page, request, { kind: 'built', config: RECIPE, setAt: '2026-11-09T10:00:00Z' }, theme);
      const bell = page.locator('.topbar .icon-btn.bell-btn');
      const look = async () => {
        const [a, b] = [(await account(page).boundingBox())!, (await bell.boundingBox())!];
        const avatar = (await account(page).locator('.avatar').boundingBox())!;
        const edge = await page.evaluate(() => {
          const face = getComputedStyle(document.querySelector('.account-btn .avatar-face')!);
          const btn = getComputedStyle(document.querySelector('.account-btn')!);
          const bellBtn = getComputedStyle(document.querySelector('.topbar .bell-btn')!);
          return { face: [face.borderTopWidth, face.borderTopColor], bell: [bellBtn.borderTopWidth, bellBtn.borderTopColor], btn: btn.borderTopWidth };
        });
        return { button: [Math.round(a.width), Math.round(a.height)], bell: [Math.round(b.width), Math.round(b.height)], avatar: Math.round(avatar.width), level: Math.round(a.y + a.height / 2) === Math.round(b.y + b.height / 2), edge };
      };
      let l = await look();
      expect(l.button).toEqual([38, 38]);
      expect(l.button).toEqual(l.bell);
      expect(l.avatar).toBe(38);
      expect(l.level).toBe(true);
      expect(l.edge.face).toEqual(l.edge.bell);
      expect(l.edge.btn).toBe('0px');
      // Short-viewport mode: 36 px, the avatar with them.
      await page.setViewportSize({ width: 844, height: 390 });
      await expect.poll(async () => (await look()).button).toEqual([36, 36]);
      l = await look();
      expect(l.bell).toEqual([36, 36]);
      expect(l.avatar).toBe(36);
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
