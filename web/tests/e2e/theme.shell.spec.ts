// Themes the way a member sets them: the account menu's Theme radios (`chrome/AccountMenu.tsx`, `theme/themeStore.ts`).
// `data-theme` on the document, the canvas and the page's theme-color follow each pick; the choice outlives a reload;
// System follows the OS as it flips, Dusk standing in for dark when that switch is on; and the loader's blocking
// theme.js paints the next load in the chosen theme before the app runs (`/_loader/theme.js` in `harness/serve.mjs`,
// as the Platform loader's). The middle theme is `dusk` by id whatever its label (Dusk today, Zen when that lands), so
// its radio is found by either name. `maia.shell.spec.ts` has its own small `pickTheme`; this is the themes' own spec.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { THEMES } from '../../src/theme/tokens';
import type { ThemeMode } from '../../src/theme/resolve';
import { canvasPainted, harness, signIn, watchConsole, type ThemeId } from './helpers';

/** The shell's debug handle (`shell/Shell.tsx`), as `hidden.shell.spec.ts` reads it. */
declare const __maDesk: { camera: { dpr(): number; getStage(): { getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[] } } };

const LABEL: Record<ThemeMode, string | RegExp> = { system: 'System', light: 'Light', dusk: /^(Dusk|Zen)$/, dark: 'Dark' };
const PREF_KEY = 'ma.prefs.theme';
const RESOLVED_KEY = 'ma.theme.resolved';

const menu = (page: Page): Locator => page.getByRole('dialog', { name: 'Account' });
const radioFor = (page: Page, mode: ThemeMode): Locator => menu(page).getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: LABEL[mode] });

async function openMenu(page: Page): Promise<void> {
  if (await menu(page).count()) return;
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(menu(page)).toBeVisible();
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
}

/** As a member does: the menu, the radio, the menu away again. */
async function pick(page: Page, mode: ThemeMode): Promise<void> {
  await openMenu(page);
  await radioFor(page, mode).click();
  await expect(radioFor(page, mode)).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
}

/**
 * The Personal desk's surface on the canvas, as a brightness: the mean of a box in its open middle, under the apps' row,
 * as `deskStyle.shell.spec.ts` samples it. The ground behind the desks is CSS; the desks are what the canvas paints.
 */
const deskSurface = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const { camera } = __maDesk;
    const el = document.getElementById('proxy-d-personal')!.getBoundingClientRect();
    const stageBox = document.querySelector('.konvajs-content')!.getBoundingClientRect();
    const d = camera.dpr();
    const x = Math.round((el.left - stageBox.left + el.width * 0.25) * d);
    const y = Math.round((el.top - stageBox.top + el.height * 0.62) * d);
    const w = Math.round(el.width * 0.5 * d);
    const h = Math.round(Math.min(40, el.height * 0.12) * d);
    const { data } = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context.getImageData(x, y, w, h);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i]! + data[i + 1]! + data[i + 2]!;
    return Math.round(sum / (data.length / 4));
  });

const resolved = (page: Page): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), RESOLVED_KEY);
const prefMode = (page: Page): Promise<string | undefined> => page.evaluate((k) => (JSON.parse(localStorage.getItem(k) ?? '{}') as { mode?: string }).mode, PREF_KEY);
const themeColor = (page: Page): Promise<string | null> => page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content.toLowerCase() ?? null);

/** Everything that should agree once `theme` is the one applied. */
async function expectTheme(page: Page, theme: ThemeId): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  expect(await resolved(page)).toBe(theme);
  expect(await themeColor(page)).toBe(THEMES[theme].surface.worldBase.toLowerCase());
}

interface Boot { theme: string | null; scheme: string | null; background: string | null }

/**
 * What the loader's theme.js paints on `<html>` before the app runs: the first `data-theme`, inline color-scheme and
 * background seen on this load. The app clears the inline styles once its stylesheet applies, so only an observer
 * set up before any script can see them.
 */
async function watchBoot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Boot = { theme: null, scheme: null, background: null };
    (window as unknown as { __maBoot: Boot }).__maBoot = seen;
    new MutationObserver(() => {
      const d = document.documentElement;
      seen.theme ??= d.getAttribute('data-theme');
      seen.scheme ||= d.style.colorScheme || null;
      seen.background ||= d.style.backgroundColor || null;
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['style', 'data-theme'] });
  });
}
const booted = (page: Page): Promise<Boot> => page.evaluate(() => (window as unknown as { __maBoot: Boot }).__maBoot);

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('Light, the middle theme and Dark from the radios: the document, the canvas and theme-color follow, each pick at once', async ({ page }) => {
  const errors = watchConsole(page);
  await page.emulateMedia({ colorScheme: 'light' }); // System, the default, resolves to Light
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await expectTheme(page, 'light');
  await openMenu(page);
  await expect(radioFor(page, 'system')).toHaveAttribute('aria-checked', 'true');
  await expect(menu(page).getByRole('radiogroup', { name: 'Theme' }).getByRole('radio')).toHaveCount(4);
  await closeMenu(page);

  const seen: Record<ThemeId, number> = { light: await deskSurface(page), dusk: 0, dark: 0 };
  for (const theme of ['dusk', 'dark', 'light', 'dusk'] as const) {
    const before = await deskSurface(page);
    const switches = await page.evaluate(() => performance.getEntriesByName('ma:theme-switch').length);
    await pick(page, theme);
    await expectTheme(page, theme);
    expect(await prefMode(page)).toBe(theme);
    // The store measures each switch; the canvas redraws in the same update.
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('ma:theme-switch').length)).toBe(switches + 1);
    await expect.poll(() => deskSurface(page)).not.toBe(before);
    seen[theme] = await deskSurface(page);
  }
  // Light's desk is the brightest, Dark's the darkest, the middle theme's between them.
  expect(seen.light).toBeGreaterThan(seen.dusk + 60);
  expect(seen.dusk).toBeGreaterThan(seen.dark + 60);
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme} outlives a reload, and the loader paints the next load in it before the app runs`, async ({ page }) => {
    const errors = watchConsole(page);
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' }); // the OS says otherwise, so only the choice can explain the result
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await pick(page, theme);
    await expectTheme(page, theme);

    await watchBoot(page);
    await page.reload();
    await expect(page.locator('.ma-shell')).toBeVisible();
    await canvasPainted(page);
    await expectTheme(page, theme);
    await openMenu(page);
    await expect(radioFor(page, theme)).toHaveAttribute('aria-checked', 'true');
    await closeMenu(page);

    // The loader's inline boot color, from `ma.theme.resolved`, was this theme's: no flash of another on the way in.
    const boot = await booted(page);
    expect(boot.theme).toBe(theme);
    expect(boot.scheme).toBe(theme === 'light' ? 'light' : 'dark');
    expect(boot.background?.toLowerCase()).toBe(theme === 'light' ? 'canvas' : 'canvastext');
    // And the app took over: the inline styles are gone, the stylesheet's colors stand.
    await page.waitForFunction(() => document.documentElement.style.backgroundColor === '' && document.documentElement.style.colorScheme === '');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme === 'light' ? 'light' : 'dark');
    expect(errors).toEqual([]);
  });
}

test('System follows the OS as it flips, Dusk standing in for Dark when that switch is on, and the choice holds over a reload', async ({ page }) => {
  const errors = watchConsole(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await pick(page, 'dark');
  await expectTheme(page, 'dark');

  await pick(page, 'system');
  await expectTheme(page, 'light');
  expect(await prefMode(page)).toBe('system');
  const lightSurface = await deskSurface(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dark');
  await expect.poll(() => deskSurface(page)).toBeLessThan(lightSurface - 60);
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  await expect.poll(() => deskSurface(page)).toBe(lightSurface);

  // "Use Zen when the system is dark" shows only under System, and makes a dark OS mean the middle theme.
  await openMenu(page);
  const duskWhenDark = menu(page).getByRole('switch', { name: 'Use Zen when the system is dark' });
  await expect(duskWhenDark).not.toBeChecked();
  await duskWhenDark.check();
  await closeMenu(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dusk');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  await openMenu(page);
  await radioFor(page, 'light').click();
  await expect(menu(page).getByRole('switch', { name: 'Use Zen when the system is dark' })).toHaveCount(0);
  await radioFor(page, 'system').click();
  await expect(menu(page).getByRole('switch', { name: 'Use Zen when the system is dark' })).toBeChecked();
  await closeMenu(page);

  // System is what's kept: a reload under a dark OS comes up in the middle theme, and the radios say System.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme(page, 'dusk');
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  await expectTheme(page, 'dusk');
  await openMenu(page);
  await expect(radioFor(page, 'system')).toHaveAttribute('aria-checked', 'true');
  await closeMenu(page);
  expect(errors).toEqual([]);
});
