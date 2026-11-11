// The regression set's cross-app sweep: every app a member has, opened and closed on one running desk, in each theme,
// with no console error. On the Personal desk: Browser, Files (on through the harness's kill switch), Notebook, Chat
// (its "on its way" card), Agent, and Maia (on in the harness). On a running Guild Desk (`harness/guilds.mjs`):
// Commons. Each window closes by its Close button, then, opened again, by Esc: Shift+Esc in the Browser, whose plain
// Esc is the web page's (the account menu's list of keys says so). What each app does once open is its own spec's.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const GUILD = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'] };

const group = (page: Page, desk: string): Locator => page.getByRole('group', { name: `${desk} desk` });
const tile = (page: Page, desk: string, app: string): Locator => group(page, desk).getByRole('button', { name: new RegExp(`^${app}`) });
const windowOf = (page: Page, app: string): Locator => page.getByRole('dialog', { name: new RegExp(app) });

/** The window is open and the app in it has arrived, not just its frame. */
async function ready(page: Page, win: Locator, app: string): Promise<void> {
  await expect(win).toBeVisible();
  switch (app) {
    case 'Browser':
      await expect(win.getByTestId('browser-video')).toBeVisible();
      break;
    case 'Files':
      await expect(page.getByRole('listbox', { name: /^Files in/ })).toBeVisible();
      break;
    case 'Notebook':
      await expect(win.getByTestId('note-editor')).toBeVisible();
      break;
    case 'Chat':
      await expect(win.getByText('Chat is on its way')).toBeVisible();
      break;
    case 'Agent':
      await expect(win.getByTestId('key-setup')).toBeVisible();
      break;
    case 'Commons':
      await expect(page.getByTestId('commons-app')).toBeVisible();
      break;
  }
}

/** Opens from the tile with the keyboard, as `shell.spec.ts` does, so Esc's return of focus can be checked. */
async function openByKeyboard(page: Page, desk: string, app: string): Promise<Locator> {
  const t = tile(page, desk, app);
  await t.focus();
  await page.keyboard.press('Enter');
  const win = windowOf(page, app);
  await ready(page, win, app);
  return win;
}

/** Close by the button, open again, close by Esc (Shift+Esc in the Browser), the tile having focus again. */
async function openAndCloseBothWays(page: Page, desk: string, app: string): Promise<void> {
  const win = await openByKeyboard(page, desk, app);
  await win.getByRole('button', { name: `Close ${app}` }).click();
  await expect(win).toHaveCount(0);
  await openByKeyboard(page, desk, app);
  await page.keyboard.press(app === 'Browser' ? 'Shift+Escape' : 'Escape');
  await expect(win).toHaveCount(0);
  await expect(tile(page, desk, app)).toBeFocused();
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, patch: Record<string, unknown>, path: string): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, patch);
  await setTheme(page, theme);
  await signIn(page, path);
  await canvasPainted(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return errors;
}

for (const theme of THEMES) {
  test(`${theme}: the Personal desk's Browser, Files, Notebook, Chat and Agent, and Maia, each opened and closed both ways`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme, { files: { enabled: true }, maia: { enabled: true } }, '/?fixture=one');
    for (const app of ['Browser', 'Files', 'Notebook', 'Chat', 'Agent']) await openAndCloseBothWays(page, 'Personal', app);

    // Maia is the office's, not a desk's: her bubble opens her panel, Hide Maia and Esc put it away, the bubble has focus again.
    const launcher = page.locator('.maia-launcher');
    const panel = page.getByRole('dialog', { name: 'Maia' });
    const composer = page.getByRole('textbox', { name: 'Message to Maia' });
    await launcher.click();
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();
    await panel.getByRole('button', { name: 'Hide Maia' }).click();
    await expect(panel).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await launcher.press('Enter');
    await expect(composer).toBeFocused();
    await composer.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(launcher).toBeFocused();
    expect(errors).toEqual([]);
  });

  test(`${theme}: Commons on a running Guild Desk, opened and closed both ways`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme, { guilds: { list: [GUILD], desks: { [GUILD.guildId]: { deskId: 'd-gplatform', state: 'running' } } } }, '/?fixture=one&speed=fast');
    await expect(group(page, GUILD.name)).toBeAttached();
    await openAndCloseBothWays(page, GUILD.name, 'Commons');
    expect(errors).toEqual([]);
  });
}
