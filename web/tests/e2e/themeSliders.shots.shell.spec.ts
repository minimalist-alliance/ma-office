// Stills of the theme sliders for the brand check, skipped unless THEME_TUNE_SHOTS names a folder: the office (a Personal
// and a Work desk, Files open) in Light, Zen and Dark at the default and at the ends of both sliders, each set as the account
// setting from `/v1/me` (ma-platform contract appearance.md), and the open account menu with the sliders moved.
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId, openMenuSection } from './helpers';

const SHOTS = process.env['THEME_TUNE_SHOTS'] ?? '';
const ME = 'u-test';
const THEMES: [ThemeId, string][] = [['light', 'light'], ['dusk', 'zen'], ['dark', 'dark']];
const STOPS: [string, number, number][] = [['default', 100, 50], ['blue-0', 0, 50], ['blue-50', 50, 50], ['contrast-0', 100, 0], ['contrast-100', 100, 100], ['blue-0-contrast-100', 0, 100], ['blue-0-contrast-0', 0, 0]];
const fleet = [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' }, { deskId: 'd-work00000001', name: 'Work', kind: 'work', state: 'running' }];

test.skip(!SHOTS, 'THEME_TUNE_SHOTS names the folder for the shots');

async function office(page: Page, theme: ThemeId, blue: number, contrast: number): Promise<void> {
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet, appearanceDocs: blue === 100 && contrast === 50 ? {} : { [ME]: { blue, contrast, updatedAt: '2026-11-14T20:00:00Z' } } });
  await setTheme(page, theme);
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(600);
}

for (const [theme, name] of THEMES) {
  for (const [stop, blue, contrast] of STOPS) {
    test(`${name} ${stop}`, async ({ page }) => {
      await office(page, theme, blue, contrast);
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/office-${name}-${stop}.png` });
    });
  }
  test(`${name} menu`, async ({ page }) => {
    await office(page, theme, 30, 70);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Account' });
    await openMenuSection(page, 'menu-appearance');
    await expect(menu.getByRole('slider', { name: 'Blue' })).toBeEnabled();
    await page.waitForTimeout(300);
    mkdirSync(SHOTS, { recursive: true });
    const box = (await menu.boundingBox())!;
    await page.screenshot({ path: `${SHOTS}/menu-${name}.png`, clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: Math.min(520, box.height + 16) } });
  });
}
