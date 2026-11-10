// Screenshots of the Guild Desk for the guild demo (task 48), in Light, Dusk and Dark: the office with a Guild Desk open
// (Commons, the shared Notebook and the Agent side by side), the agent limits and usage sheet, and the waking screen. The
// content is the mock's demo for an engineering team (`desk/mockGuild.ts`): nobody's real data. Skipped unless GUILD_SHOTS
// names the folder to write to, so it never runs in the suite:
//   GUILD_SHOTS=/abs/dir MA_PW_PORT=4473 npx playwright test --project=shell guild.shots
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['GUILD_SHOTS'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const W = 1680;
const H = 1050;

const LEAD = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'], members: 18 };
const OSS = { guildId: 'gu-ossmaintain', name: 'Open source maintainers', role: 'member', grants: [], members: 64 };
const PANEL = `guild-${LEAD.guildId}`;

test.skip(!OUT, 'GUILD_SHOTS names the folder for the screenshots');
test.use({ viewport: { width: W, height: H }, deviceScaleFactor: 2, timezoneId: 'America/Denver' });

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, desks: Record<string, unknown>, wakeMs = 900, rects = true): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, { guilds: { list: [LEAD, OSS], desks, wakeMs }, displayName: 'Dana Whitfield' });
  await setTheme(page, theme);
  await page.addInitScript(([panel, w, h, place]) => {
    localStorage.setItem('ma.view.v1', JSON.stringify({ scope: 'guild', activeDesk: panel, mode: 'desk' }));
    if (!place) return;
    // As a member would arrange them: Commons across the top, wide enough for its channels, board and chat at once (its own
    // layout folds the chat over the board under 1040 px), and the Notebook and the Agent side by side under it, each wide
    // enough for its tabs and its lines.
    const top = 72;
    const tall = h - top - 12;
    const upper = 470;
    const lowerY = top + upper + 12;
    const half = Math.floor((w - 36) / 2);
    const rect = (x: number, y: number, width: number, height: number) => ({ rect: { x, y, w: width, h: height }, mode: 'window' });
    localStorage.setItem('ma.windows.v1', JSON.stringify({
      [`${panel}:commons`]: rect(12, top, w - 24, upper),
      [`${panel}:notebook`]: rect(12, lowerY, half, tall - upper - 12),
      [`${panel}:agent`]: rect(24 + half, lowerY, w - 36 - half, tall - upper - 12),
    }));
  }, [PANEL, W, H, rects] as const);
  await signIn(page, '/?fixture=one&speed=fast');
  await canvasPainted(page);
  return errors;
}

async function open(page: Page, app: string): Promise<void> {
  const tile = page.getByRole('group', { name: 'Platform team desk' }).getByRole('button', { name: new RegExp(`^${app}`) });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: new RegExp(app) })).toBeVisible();
}

const shot = (page: Page, name: string, theme: ThemeId): Promise<Buffer> => {
  mkdirSync(OUT, { recursive: true });
  return page.screenshot({ path: join(OUT, `${name}-${theme}.png`), animations: 'disabled', caret: 'hide' });
};

for (const theme of THEMES) {
  test(`office with a Guild Desk open, ${theme}`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme, { [LEAD.guildId]: { deskId: 'd-gplatform', state: 'running', connected: 7 } });
    await open(page, 'Commons');
    await expect(page.locator('.ma-cm-chip-name')).toHaveText('Sprint 42 planning');
    await expect(page.getByTestId('commons-app').getByRole('log')).toContainText('Sprint review in here at 3.');
    await open(page, 'Notebook');
    await expect(page.getByTestId('notebook-here')).toBeVisible({ timeout: 10_000 });
    await open(page, 'Agent');
    await expect(page.getByTestId('guild-agent-line')).toBeVisible();
    await expect(page.getByText('Since Monday: the cart cache task is done').first()).toBeVisible({ timeout: 10_000 });
    // For the guild demo deck: no provider's badge (its words rules), and the privacy line dismissed, as it's said once.
    // The rail with the switch folds away at this width: the switch itself, as the member's press.
    await page.locator('#ag-show-badges').evaluate((el) => {
      if ((el as HTMLInputElement).checked) (el as HTMLInputElement).click();
    });
    await expect(page.getByTestId('provider-badge')).toHaveCount(0);
    await page.getByTestId('guild-privacy').getByRole('button', { name: 'Dismiss' }).click();
    await page.mouse.move(W / 2, 8);
    await page.waitForTimeout(900);
    await shot(page, 'office-guild-desk', theme);
    expect(errors).toEqual([]);
  });

  test(`agent limits and usage, ${theme}`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme, { [LEAD.guildId]: { deskId: 'd-gplatform', state: 'running', connected: 7 } });
    await open(page, 'Commons');
    await expect(page.locator('.ma-cm-chip-name')).toHaveText('Sprint 42 planning');
    await page.getByTestId('guild-privacy').getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForTimeout(600);
    await page.locator(`[id="proxy-${PANEL}"]`).focus();
    await page.keyboard.press('.');
    await page.getByRole('menu', { name: 'Desk' }).getByRole('menuitem', { name: 'Guild limits' }).click();
    await expect(page.getByTestId('gs-perMember-runsPerDay')).toHaveValue('20');
    await page.getByTestId('gs-perMember-usdPerDay').fill('2');
    await page.waitForTimeout(300);
    await shot(page, 'guild-agent-limits', theme);
    await page.getByTestId('guild-tab-usage').click();
    await expect(page.getByTestId('guild-usage-table')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, 'guild-agent-usage', theme);
    expect(errors).toEqual([]);
  });

  test(`the waking screen, ${theme}`, async ({ page, request }) => {
    const errors = await arrive(page, request, theme, { [LEAD.guildId]: { deskId: 'd-gplatform', state: 'stopped' } }, 600_000, false);
    await open(page, 'Commons');
    await expect(page.getByTestId('commons-panel')).toContainText('The Guild Desk is waking, about a minute');
    await page.mouse.move(W / 2, 8);
    await page.waitForTimeout(700);
    await shot(page, 'guild-desk-waking', theme);
    expect(errors).toEqual([]);
  });
}
