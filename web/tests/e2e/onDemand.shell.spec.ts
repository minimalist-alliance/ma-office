// What `lib/onDemand.ts` promises (`sub/desk-bundle-headroom`). The window's frame (`windows/AppWindow.tsx`) and the top bar's
// panels (`chrome/popoversChunk.ts`) are chunks fetched once the page is idle. Once they're here, a window or a panel is on
// screen before the next frame after the press that opens it, as it was from the first load: the window already growing
// out of its tile, with the keyboard in it. Pressed sooner, it shows as its chunk lands, still grown from its tile, with the
// keyboard in it and its name. `MA_MENU_SHOTS=<dir>` saves the open account menu in each theme, to compare with main's
// (`-g "account menu"` runs only that test, which needs nothing of this branch).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const WINDOWS = /\/AppWindow-[^/]*\.js$/;
const POPOVERS = /\/popovers-[^/]*\.js$/;

const deskButton = (page: Page): Locator => page.getByRole('button', { name: /^Personal desk,/ });
const tile = (page: Page, app: string): Locator => page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: new RegExp(`^${app}`) });
const windowOf = (page: Page, app: string): Locator => page.locator('.window-layer').getByRole('dialog', { name: new RegExp(app) });
const accountMenu = (page: Page): Locator => page.getByRole('dialog', { name: 'Account' });

async function arrive(page: Page, request: Parameters<typeof harness>[0], theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await setTheme(page, theme);
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  return errors;
}

/** The page's idle fetch of a chunk has finished (its resource entry is there), and a turn more for its module to run. */
async function fetched(page: Page, chunk: RegExp): Promise<void> {
  await expect.poll(() => page.evaluate((src) => performance.getEntriesByType('resource').some((e) => new RegExp(src).test(e.name)), chunk.source), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(150);
}

/** Into the desk (not the overview), where a tile's press opens its window at once rather than halfway through the camera's move. */
async function intoDesk(page: Page): Promise<void> {
  await deskButton(page).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
}

/**
 * Presses a proxy and reports, from the first animation frame after it, whether `selector` was already on screen, how many
 * frames it took if not, and whether it was animating and held the keyboard when it came.
 */
function pressAndWatch(target: Locator, selector: string): Promise<{ frames: number; animating: boolean; focused: boolean }> {
  return target.evaluate(
    (el, sel) =>
      new Promise((done) => {
        let frames = 0;
        (el as HTMLElement).focus();
        (el as HTMLElement).click();
        const look = (): void => {
          const found = document.querySelector(sel);
          if (found) done({ frames, animating: found.getAnimations().length > 0, focused: found.contains(document.activeElement) });
          else if (++frames > 600) done({ frames, animating: false, focused: false });
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
    selector,
  );
}

test('after the idle fetch, a window is on screen at the next frame after the press, growing from its tile, with the keyboard in it', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await fetched(page, WINDOWS);
  await intoDesk(page);
  const seen = await pressAndWatch(tile(page, 'Notebook'), '.window-layer [role="dialog"]');
  expect(seen).toEqual({ frames: 0, animating: true, focused: true });
  await expect(windowOf(page, 'Notebook')).toBeVisible();
  expect(errors).toEqual([]);
});

test('pressed before the windows\' chunk is here, the window shows as it lands, grown from its tile, named, with the keyboard in it', async ({ page, request }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let asked = 0;
  await page.route(WINDOWS, async (route) => {
    asked += 1;
    await held;
    await route.continue();
  });
  const errors = await arrive(page, request);
  await intoDesk(page);
  // Watch for the window's arrival from here on: when it's put in, it's already animating (the FLIP from its tile).
  await page.evaluate(() => {
    const w = window as unknown as { __arrived?: { animating: boolean; focused: boolean } };
    new MutationObserver((_, obs) => {
      const found = document.querySelector('.window-layer [role="dialog"]');
      if (!found) return;
      w.__arrived = { animating: found.getAnimations().length > 0, focused: found.contains(document.activeElement) };
      obs.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  });
  await tile(page, 'Notebook').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await expect(windowOf(page, 'Notebook')).toHaveCount(0);
  expect(asked).toBeGreaterThan(0);
  release();
  await expect(windowOf(page, 'Notebook')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __arrived?: unknown }).__arrived)).toEqual({ animating: true, focused: true });
  await expect(windowOf(page, 'Notebook')).toBeFocused();
  // Its frame names it, and Esc closes it back into the tile, as from the first load.
  await expect(windowOf(page, 'Notebook').getByRole('button', { name: 'Close Notebook' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(windowOf(page, 'Notebook')).toHaveCount(0);
  await expect(tile(page, 'Notebook')).toBeFocused();
  expect(errors).toEqual([]);
});

test('after the idle fetch, the account menu\'s panel is there at the next frame after the press; pressed sooner, it shows as its chunk lands', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await fetched(page, POPOVERS);
  const button = page.getByRole('button', { name: 'Account', exact: true });
  const seen = await pressAndWatch(button, '#account-panel');
  expect(seen.frames).toBe(0);
  await expect(accountMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(accountMenu(page)).toHaveCount(0);

  // A fresh page with the chunk held: the button says it's open, and the panel comes with the chunk.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(POPOVERS, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await canvasPainted(page);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(300);
  await expect(accountMenu(page)).toHaveCount(0);
  release();
  await expect(accountMenu(page)).toBeVisible();
  await expect(accountMenu(page).getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dusk', 'dark'] as const) {
  test(`${theme}: the account menu reads as main's, Zen's Background (in Zen only), labels and hint included`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const menu = accountMenu(page);
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio')).toHaveText(['System', 'Light', 'Zen', 'Dark']);
    // The Background picker is Zen's alone (`BACKGROUNDS_IN`).
    if (theme === 'dusk') await expect(menu.getByRole('radio', { name: 'Background: None' })).toBeVisible();
    else await expect(menu.getByRole('radio', { name: 'Background: None' })).toHaveCount(0);
    await expect(menu.getByText('No gradient or picture behind the desks. On by default on very large high-resolution screens')).toBeVisible();
    await menu.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'System', exact: true }).click();
    await expect(menu.getByText('Use Zen when the system is dark')).toBeVisible();
    await menu.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: theme === 'dusk' ? 'Zen' : theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await expect(menu.getByText('Use Zen when the system is dark')).toHaveCount(0);
    await page.waitForTimeout(800); // the swatches' placeholders and the background behind
    const dir = process.env['MA_MENU_SHOTS'];
    if (dir) {
      await page.mouse.move(2, 600);
      await page.waitForTimeout(300);
      await menu.screenshot({ path: `${dir}/menu-${theme}.png`, animations: 'disabled' });
      await page.screenshot({ path: `${dir}/office-${theme}.png`, animations: 'disabled' });
    }
    expect(errors).toEqual([]);
  });
}
