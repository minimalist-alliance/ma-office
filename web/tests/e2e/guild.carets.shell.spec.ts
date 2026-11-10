// Two members on one Guild Desk's shared Notebook page (task 48): each sees the other's caret, selection and name label, never
// their own. Two tabs of one browser stand in for two members' browsers: the mock desk relays awareness between them (and names each
// by its verified caller, as deskd does), and the harness's `displayName` at each sign-in says who each tab is.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const ONE = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: [] };

const tile = (page: Page, app: string): Locator => page.getByRole('group', { name: 'Platform team desk' }).getByRole('button', { name: new RegExp(`^${app}`) });

async function member(page: Page, request: APIRequestContext, displayName: string, theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { guilds: { wakeMs: 0, list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } }, displayName });
  await setTheme(page, theme);
  await signIn(page, '/?fixture=one&speed=fast');
  await canvasPainted(page);
  await tile(page, 'Notebook').evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
  const editor = page.getByTestId('note-editor');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  return errors;
}

const carets = (page: Page): Locator => page.getByTestId('remote-caret');

for (const theme of ['light', 'dark'] as ThemeId[]) {
  test(`each member sees the other's caret, selection and name, and not their own (${theme})`, async ({ browser, request, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await harness(request, { reset: true });
    const errorsA = await member(a, request, 'Dana Whitfield', theme);
    const errorsB = await member(b, request, 'Bo Rivera', theme);
    const editorA = a.getByTestId('note-editor');
    const editorB = b.getByTestId('note-editor');

    // Both open the same first page; A types, so B has text to put a caret in.
    await editorA.click();
    await a.keyboard.press('Control+End');
    await a.keyboard.type(' Carets are shown.');
    await expect(editorB).toContainText('Carets are shown.');

    // B clicks into the text: A sees B's caret with B's name, B sees nothing of its own.
    await editorB.getByText('Carets are shown.').first().click();
    await expect(carets(a)).toHaveCount(1);
    await expect(carets(a).locator('.nb-caret-label')).toHaveText('Bo Rivera');
    await expect(carets(b).filter({ hasText: 'Bo Rivera' })).toHaveCount(0);

    // And A's caret, with A's name, is in B's.
    await editorA.click();
    await a.keyboard.press('Control+End');
    await expect(carets(b).locator('.nb-caret-label')).toHaveText('Dana Whitfield');
    await expect(carets(a).filter({ hasText: 'Dana Whitfield' })).toHaveCount(0);

    // A selection shows as a tinted range.
    await a.keyboard.press('Shift+Control+ArrowLeft');
    await expect(b.locator('.nb-remote-sel').first()).toBeVisible();
    await expect(b.locator('.nb-remote-sel').first()).toHaveText(/\S/);

    // The two are different colours (by member, from the tab tokens), and the label is readable on the window's own surface.
    const colour = (p: Page) => carets(p).first().evaluate((el) => getComputedStyle(el).borderLeftColor);
    expect(await colour(a)).not.toBe(await colour(b));
    await expect(carets(b).locator('.nb-caret-label')).toHaveCSS('opacity', '1');
    await b.screenshot({ path: `test-results/carets-${theme}.png`, animations: 'allow' });

    // Idle labels fade after a few seconds; the caret stays.
    await expect(carets(b).locator('.nb-caret-label')).toHaveCSS('opacity', '0', { timeout: 9_000 });
    await expect(carets(b)).toHaveCount(1);

    // A tab that leaves the text takes its caret with it.
    await editorA.evaluate((el) => (el as HTMLElement).blur());
    await expect(carets(b)).toHaveCount(0);

    expect(errorsA).toEqual([]);
    expect(errorsB).toEqual([]);
    await ctx.close();
  });
}

test('a member alone on the desk sees no carets and the page is unchanged', async ({ page, request }) => {
  await harness(request, { reset: true });
  const errors = await member(page, request, 'Dana Whitfield');
  const editor = page.getByTestId('note-editor');
  await editor.click();
  await page.keyboard.type(' Alone.');
  await expect(editor).toContainText('Alone.');
  await expect(carets(page)).toHaveCount(0);
  await expect(page.locator('.nb-remote-sel')).toHaveCount(0);
  expect(errors).toEqual([]);
});
