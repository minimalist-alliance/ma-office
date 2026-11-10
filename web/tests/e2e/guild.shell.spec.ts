// Guild Desks in the office (task 48): the member's guilds from `GET /v1/guilds`, each guild's one shared Guild Desk as a panel
// in the Guild scope, opened with its state, a wake and a guild token from the harness's API (`harness/guilds.mjs`), and a
// mock session (`desk/mockGuild.ts`): Commons, the shared Notebook and the Agent, the settings and usage sheet, the privacy
// line, removal, and `?guild=` from the guild app. The REST calls are the real code's, against the harness; the session's
// channels are the mock's. Every console error fails a test.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

const ONE = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'] };
const TWO = { guildId: 'gu-designreview', name: 'Design review', role: 'member', grants: [] };
const PANEL = `guild-${ONE.guildId}`;
const PANEL_TWO = `guild-${TWO.guildId}`;

interface GuildMock {
  calls: { m: string; p: Record<string, unknown> }[];
  settings: Record<string, { perMember: { runsPerDay: number } }>;
  kick(deskId: string): void;
}
/** The mock desk's controls, as this spec reads them (`desk/mockDeskLink.ts`, `desk/mockGuild.ts`). */
type Mocked = { __maDeskMock: { guild: GuildMock; rpc: { m: string; p: Record<string, unknown> }[] } };
const mock = (): Mocked['__maDeskMock'] => (window as unknown as Mocked).__maDeskMock;
void mock;

const group = (page: Page, name: string): Locator => page.getByRole('group', { name: `${name} desk` });
const tile = (page: Page, desk: string, app: string): Locator => group(page, desk).getByRole('button', { name: new RegExp(`^${app}`) });
const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const deskMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Desk' });
const windowOf = (page: Page, app: string): Locator => page.getByRole('dialog', { name: new RegExp(app) });

async function arrive(page: Page, request: APIRequestContext, guilds: Record<string, unknown>, query = '', theme: ThemeId = 'light'): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, { guilds: { wakeMs: 900, ...guilds }, displayName: 'Dana Whitfield' });
  await setTheme(page, theme);
  await signIn(page, `/?fixture=one&speed=fast${query}`);
  await canvasPainted(page);
  return errors;
}

async function openApp(page: Page, desk: string, app: string): Promise<void> {
  await tile(page, desk, app).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(windowOf(page, app)).toBeVisible();
  await page.waitForTimeout(600); // the camera's focus settles: a menu closes when it moves
}

async function openDeskMenu(page: Page, id: string): Promise<void> {
  await proxy(page, id).focus();
  await page.keyboard.press('.');
  await expect(deskMenu(page)).toBeVisible();
}

const log = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log;
const guildCalls = async (page: Page, method: string): Promise<number> => page.evaluate((m) => (window as unknown as Mocked).__maDeskMock.guild.calls.filter((c) => c.m === m).length, method);

async function axe(page: Page, include: string): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run({ include: [sel] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

test.describe('the member’s guilds in the office', () => {
  test('each guild’s Guild Desk is a panel named for it, in the Guild scope', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE, TWO], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await expect(group(page, 'Platform team')).toBeAttached();
    await expect(group(page, 'Design review')).toBeAttached();
    await page.getByRole('radio', { name: 'Guild' }).click();
    await expect(page.getByRole('radio', { name: 'Guild' })).toBeChecked();
    await expect(group(page, 'Platform team')).toBeAttached();
    expect(await log(request)).toContain('GET /v1/guilds');
    expect(errors).toEqual([]);
  });

  test('at most three, as a member is in at most three guilds', async ({ page, request }) => {
    const more = [3, 4].map((n) => ({ ...TWO, guildId: `gu-extra${n}`, name: `Guild ${n}` }));
    const errors = await arrive(page, request, { list: [ONE, TWO, ...more] });
    for (const name of ['Personal', 'Platform team', 'Design review', 'Guild 3']) await expect(group(page, name)).toBeAttached();
    await expect(group(page, 'Guild 4')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a Guild Desk has Commons, Notebook and Agent, and never a Browser', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE] });
    const names = await group(page, 'Platform team').getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    expect(names.some((n) => n.startsWith('Commons'))).toBe(true);
    expect(names.some((n) => n.startsWith('Notebook'))).toBe(true);
    expect(names.some((n) => n.startsWith('Agent'))).toBe(true);
    expect(names.some((n) => n.startsWith('Browser'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('no guilds, or a Platform before guild routes: the office as it was', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [], listStatus: 404 });
    await expect(group(page, 'Personal')).toBeAttached();
    await expect(page.getByRole('radio', { name: 'Guild' })).toHaveCount(0);
    expect(errors.filter((e) => !e.includes('404'))).toEqual([]); // the browser's own line for the missing route
  });
});

test.describe('opening a Guild Desk', () => {
  test('a running one: its state, a guild token with this tab’s fingerprint, then Commons on its channel', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    await expect(page.getByTestId('commons-app')).toBeVisible();
    await expect(page.locator('.ma-cm')).toHaveAttribute('aria-label', 'Platform team');
    await expect(page.locator('.ma-cm-chip-name')).toHaveText('Sprint 42 planning');
    const l = await log(request);
    expect(l).toContain(`GET /v1/guilds/${ONE.guildId}/desk`);
    expect(l).toContain(`POST /v1/guilds/${ONE.guildId}/desk/token`);
    expect(l).not.toContain(`POST /v1/guilds/${ONE.guildId}/desk/wake`);
    expect(l.some((x) => x.startsWith(`POST /v1/desks/${PANEL}`))).toBe(false);
    const bodies = ((await (await request.get('/__harness')).json()) as { guildTokenBodies: { fingerprint: string }[] }).guildTokenBodies;
    expect(bodies[0]?.fingerprint).toMatch(/^sha-256 /);
    await expect.poll(() => guildCalls(page, 'guild.hello')).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a sleeping one: rendering asks only its state, and the member’s open wakes it, once, with the waking screen', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'stopped' } }, wakeMs: 2500 });
    await page.waitForTimeout(800);
    expect((await log(request)).filter((x) => x.includes('/desk/wake'))).toEqual([]);
    await openApp(page, 'Platform team', 'Commons');
    await expect(page.getByTestId('commons-panel')).toContainText('The Guild Desk is waking, about a minute');
    await expect(page.getByTestId('commons-app')).toBeVisible({ timeout: 15_000 });
    expect((await log(request)).filter((x) => x === `POST /v1/guilds/${ONE.guildId}/desk/wake`)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a desk never opened provisions on the first open, through the same wake', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE] });
    await openApp(page, 'Platform team', 'Notebook');
    await expect(page.getByTestId('notebook-panel')).toContainText('The Guild Desk is waking');
    await expect(page.getByTestId('notebook-app').getByText('Sprint 42 plan').first()).toBeVisible({ timeout: 15_000 });
    expect((await log(request)).filter((x) => x.endsWith('/desk/wake'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('a dropped session comes back with a fresh token, and Commons says hello again', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    await expect(page.getByTestId('commons-app')).toBeVisible();
    const tokens = (await log(request)).filter((x) => x.endsWith('/desk/token')).length;
    await page.evaluate((id) => (window as unknown as Mocked).__maDeskMock.guild.kick(id), PANEL);
    await expect.poll(async () => (await log(request)).filter((x) => x.endsWith('/desk/token')).length).toBe(tokens + 1);
    await expect(page.getByTestId('commons-window')).toHaveAttribute('data-open', 'true');
    await expect.poll(() => guildCalls(page, 'guild.hello')).toBe(2);
    expect(errors).toEqual([]);
  });
});

test.describe('apps on a Guild Desk', () => {
  test('Commons, the shared Notebook with who’s here, and the Agent with its private line, side by side', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    await openApp(page, 'Platform team', 'Notebook');
    await openApp(page, 'Platform team', 'Agent');
    await expect(page.getByTestId('notebook-here')).toContainText('Here now: Marcus Lee, Priya Raman');
    await expect(page.getByTestId('guild-agent-line')).toHaveText(/Your conversations here are private to you\. The guild's limits apply\./);
    await expect(page.getByTestId('guild-agent-line').getByRole('button', { name: 'Guild limits' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Commons is the room itself: channels, chat and a message sent through the Guild Desk', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    const room = page.getByTestId('commons-app');
    await expect(room.getByRole('navigation', { name: 'Channels' })).toContainText('Incidents');
    const chat = room.getByRole('log');
    await expect(chat).toContainText('Sprint review in here at 3.');
    await room.getByRole('textbox', { name: 'Message #General' }).fill('Taking the queue-depth alert.');
    await page.keyboard.press('Enter');
    await expect(chat.locator('.ma-cm-msg').last()).toContainText('Taking the queue-depth alert.');
    await expect(chat.locator('.ma-cm-msg').last()).toHaveAttribute('data-pending', '0');
    await room.getByRole('button', { name: /^Incidents/ }).click();
    await expect(chat).toContainText('Root cause was the payments queue backing up.');
    await expect(room.locator('.ma-cm-chip-name')).toHaveText('Checkout latency, Tuesday');
    expect(errors).toEqual([]);
  });

  test('the Agent there has no Keys tab and no desk limits; the Founder gets the guild’s key and limits in their place', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Agent');
    const agent = page.getByTestId('agent-app');
    await expect(agent.getByTestId('tab-usage')).toHaveAttribute('aria-label', 'Guild limits');
    await expect(agent.getByTestId('tab-keys')).toHaveCount(0);
    await expect(agent.getByTestId('tab-activity')).toBeVisible();
    await expect(agent.getByText('Usage and limits')).toHaveCount(0);
    // Finding 7: one member's agent, not a desk's team.
    await expect(agent.locator('.ag-rail .ag-side-head h3')).toHaveText('Your agent'); // the rail folds away at this width
    await expect(agent.getByText('Desk team')).toHaveCount(0);
    await expect(agent.locator('.ag-head-text')).toContainText('Your agent · online · standard · on this Guild Desk only');
    // Finding 3: the meter is against the guild's caps on each member ($1 a day), not the desk's own agent limit ($5).
    await expect(agent.getByTestId('usage-card')).toContainText(/\$\d+\.\d\d of \$1(?![\d.])/);
    await expect(agent.getByTestId('usage-card')).not.toContainText('of $5');
    await expect(agent.getByTestId('usage-card')).toContainText("stops at the guild's limit.");
    await agent.getByTestId('tab-usage').click();
    const drawer = agent.getByTestId('drawer');
    // Finding 2: the guild's key, by its name and last 4, with Replace and Remove.
    await expect(drawer.getByTestId('guild-key-row')).toContainText('Guild key');
    await expect(drawer.getByTestId('guild-key-row')).toContainText('····7Hq2');
    await expect(drawer.getByTestId('guild-key-replace')).toBeVisible();
    await expect(drawer.getByTestId('guild-key-remove')).toBeVisible();
    await expect(drawer.getByTestId('gs-perMember-runsPerDay')).toHaveValue('20');
    await expect(drawer.getByTestId('guild-limits-save')).toBeDisabled();
    await expect(drawer.getByTestId('limits-panel')).toHaveCount(0);
    // Findings 1 and 4: switches deskd keeps but doesn't act on yet aren't shown.
    await expect(drawer.getByTestId('gs-own-keys')).toHaveCount(0);
    await expect(drawer.getByTestId('gs-tool-post')).toHaveCount(0);
    await expect(drawer.getByText('Anything that deletes always asks the member first.')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the Founder replaces the guild’s key, then removes it; every member’s agent waits on the next', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Agent');
    const agent = page.getByTestId('agent-app');
    await agent.getByTestId('tab-usage').click();
    const key = agent.getByTestId('guild-key');
    await key.getByTestId('guild-key-replace').click();
    await expect(key).toContainText('For now, the guild’s key stays only until the Guild Desk sleeps or restarts.');
    await key.getByTestId('key-input').fill('sk-ant-TEST-not-a-real-key-canary-0000-abcd');
    await key.getByTestId('key-submit').click();
    await expect(key.getByTestId('guild-key-row')).toContainText('····abcd');
    await expect(key.getByTestId('guild-key-row')).not.toContainText('7Hq2');
    const rpc = async (m: string): Promise<number> => page.evaluate((x) => (window as unknown as Mocked).__maDeskMock.rpc.filter((r) => r.m === x).length, m);
    expect(await rpc('agent.key.add')).toBe(1);
    expect(await rpc('agent.bind')).toBe(1);
    expect(await rpc('agent.key.delete')).toBe(1);
    await key.getByTestId('guild-key-remove').click();
    await expect(key.getByRole('alert')).toContainText('Remove the guild’s key? Every member’s agent stops until a key is added again.');
    await key.getByTestId('guild-key-remove-confirm').click();
    await expect(key.getByTestId('guild-key-removed')).toContainText('Removed from the Guild Desk.');
    await expect(key.getByTestId('guild-key-none')).toBeVisible();
    expect(await rpc('agent.key.delete')).toBe(2);
    // The key screen, in the guild's words, for the one who can act.
    const setup = agent.getByTestId('key-setup');
    await expect(setup.getByRole('heading', { name: "Add the guild's key" })).toBeVisible();
    await expect(setup.getByTestId('key-restart-line')).toHaveText('For now, the guild’s key stays only until the Guild Desk sleeps or restarts. You’d add it again after that.');
    expect(errors).toEqual([]);
  });

  test('the guild’s key gone with a restart: the Founder’s key screen says to add it again, and how long it stays', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Agent');
    const agent = page.getByTestId('agent-app');
    await expect(agent.getByTestId('composer-input')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __maDeskMock: { agent: { restart(): void } } }).__maDeskMock.agent.restart());
    const setup = agent.getByTestId('key-setup');
    await expect(setup.getByRole('heading', { name: "Add the guild's key again" })).toBeVisible();
    await expect(setup.getByTestId('key-gone')).toHaveText("Every member's agent waits until it's back. Their threads and the guild's limits are all still here.");
    await expect(setup.getByTestId('key-restart-line')).toHaveText('For now, the guild’s key stays only until the Guild Desk sleeps or restarts. You’d add it again after that.');
    expect(errors).toEqual([]);
  });

  test('“Guild limits” on the Agent’s line opens the Agent’s own drawer, and the desk menu and sheet use the same name', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Agent');
    const agent = page.getByTestId('agent-app');
    await expect(agent.getByTestId('tab-usage')).toBeVisible();
    await page.getByTestId('guild-agent-line').getByRole('button', { name: 'Guild limits' }).click();
    await expect(agent.getByTestId('drawer')).toHaveAttribute('aria-label', 'Guild limits');
    await expect(agent.getByTestId('drawer').getByTestId('guild-key')).toBeVisible();
    await expect(page.getByTestId('guild-sheet')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a member’s Agent there has neither, and waits calmly on the guild’s key', async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as unknown as { __maGuildMockInit: { seed: boolean } }).__maGuildMockInit = { seed: false };
    });
    const errors = await arrive(page, request, { list: [TWO], desks: { [TWO.guildId]: { deskId: 'd-gdesign', state: 'running' } } });
    await openApp(page, 'Design review', 'Agent');
    const agent = page.getByTestId('agent-app');
    await expect(agent.getByTestId('guild-no-key')).toContainText("Your agent here runs on the guild's key. It starts once the Founder, or an Officer who manages agents, adds it.");
    await expect(agent.getByTestId('guild-key')).toHaveCount(0);
    await expect(agent.getByTestId('key-setup')).toHaveCount(0);
    for (const tab of ['usage', 'keys', 'activity']) await expect(agent.getByTestId(`tab-${tab}`)).toHaveCount(0);
    await expect(agent.getByText(/Usage and limits|Guild limits/)).toHaveCount(0);
    await expect(page.getByTestId('guild-agent-line').getByRole('button')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the guild’s key gone with a restart: a member is told plainly, and who can add it back; the Founder gets the key screen', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [TWO], desks: { [TWO.guildId]: { deskId: 'd-gdesign', state: 'running' } } });
    await harness(request, { tierNames: { alliance: 'Alliance Member', officer: 'Steward', lead: 'Captain' } });
    await page.reload();
    await canvasPainted(page);
    await openApp(page, 'Design review', 'Agent');
    const agent = page.getByTestId('agent-app');
    await expect(agent.getByTestId('composer-input')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __maDeskMock: { agent: { restart(): void } } }).__maDeskMock.agent.restart());
    const line = agent.getByTestId('guild-no-key');
    await expect(line).toContainText("The guild's key isn't on the Guild Desk right now. Your agent starts again once the Captain, or a Steward who manages agents, adds it back.");
    await expect(agent.getByTestId('key-setup')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the Founder’s key screen there says the key is the guild’s, for every member’s agent', async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as unknown as { __maGuildMockInit: { seed: boolean } }).__maGuildMockInit = { seed: false };
    });
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Agent');
    const setup = page.getByTestId('agent-app').getByTestId('key-setup');
    await expect(setup.getByRole('heading', { name: "Add the guild's key" })).toBeVisible();
    await expect(setup).toContainText("Every member's agent here runs on this key, within the guild's limits.");
    await expect(setup).not.toContainText('Give Manager a key');
    await expect(setup.getByTestId('key-restart-line')).toHaveText('For now, the guild’s key stays only until the Guild Desk sleeps or restarts. You’d add it again after that.');
    expect(errors).toEqual([]);
  });

  test('a link in a guild page offers the member’s own desk, never a Browser here', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Notebook');
    const link = page.getByTestId('notebook-app').locator('a[href="https://grafana.example.com/d/checkout"]');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click({ modifiers: ['ControlOrMeta'] });
    const choice = page.getByTestId('guild-link-choice');
    await expect(choice).toContainText('https://grafana.example.com/d/checkout');
    await expect(choice.getByRole('button', { name: 'Open on Personal' })).toBeVisible();
    await expect(choice.getByRole('button', { name: /Browser/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Mocked).__maDeskMock.rpc.filter((r) => r.m === 'browser.tab.open').length)).toBe(0);
    await choice.getByRole('button', { name: 'Open on Personal' }).click();
    await expect(choice).toHaveCount(0);
    // The member's own desk opens it, in its own Browser: only now, and only there.
    await expect.poll(() => page.evaluate(() => (window as unknown as Mocked).__maDeskMock.rpc.filter((r) => r.m === 'browser.tab.open').map((r) => r.p['url']))).toEqual(['https://grafana.example.com/d/checkout']);
    expect(errors).toEqual([]);
  });

  test('a teen’s Guild Desk has no Agent, and no screen shows anything of their age', async ({ page, request }) => {
    await harness(request, { reset: true });
    const errors = watchConsole(page);
    await harness(request, { age: 'teen', guilds: { list: [{ ...TWO, guildId: 'gu-allages', name: 'Robotics club' }] } });
    await signIn(page, '/?fixture=one&speed=fast');
    await canvasPainted(page);
    await expect(group(page, 'Robotics club')).toBeAttached();
    const names = await group(page, 'Robotics club').getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    expect(names.some((n) => n.startsWith('Agent'))).toBe(false);
    expect(names.some((n) => n.startsWith('Commons'))).toBe(true);
    await expect(page.getByText(/teen/i)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('the guild settings and usage', () => {
  test('the Founder sets agent limits; the whole object goes, as deskd takes it, with what changed', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    await expect(page.getByTestId('commons-app')).toBeVisible();
    await openDeskMenu(page, PANEL);
    await expect(deskMenu(page).getByRole('menuitem')).toHaveText(['Clean up', 'Move', 'Resize', 'Guild limits', 'Agent usage']);
    await deskMenu(page).getByRole('menuitem', { name: 'Guild limits' }).click();
    const sheet = page.getByTestId('guild-sheet');
    await expect(sheet).toHaveAttribute('data-view', 'limits');
    await expect(sheet.getByRole('heading', { level: 2 })).toContainText('Guild limits');
    const runsDay = sheet.getByTestId('gs-perMember-runsPerDay');
    await expect(runsDay).toHaveValue('20');
    await expect(sheet.getByTestId('guild-limits-save')).toBeDisabled();
    await runsDay.fill('2.5');
    await expect(sheet.getByText('Use a whole number.')).toBeVisible();
    await expect(sheet.getByTestId('guild-limits-save')).toBeDisabled();
    await runsDay.fill('30');
    await sheet.getByTestId('guild-limits-save').click();
    await expect(sheet.getByTestId('guild-limits-line')).toHaveText('Saved.');
    const set = await page.evaluate(() => (window as unknown as Mocked).__maDeskMock.rpc.filter((r) => r.m === 'guild.settings.set').map((r) => r.p));
    expect(set).toEqual([{ agents: { perMember: { runsPerDay: 30, usdPerDay: 1, usdPerMonth: 10 }, perGuild: { usdPerMonth: 50, runsAtOnce: 2 }, tools: { read: true, search: true, edit: true, post: true, boards: true }, ownKeys: false } }]);
    expect(await page.evaluate((g) => (window as unknown as Mocked).__maDeskMock.guild.settings[g]?.perMember.runsPerDay, ONE.guildId)).toBe(30);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('usage: runs and dollars per member by name, today and this month, never content', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    await openDeskMenu(page, PANEL);
    await deskMenu(page).getByRole('menuitem', { name: 'Agent usage' }).click();
    const table = page.getByTestId('guild-usage-table');
    await expect(table.getByRole('row')).toHaveCount(6);
    await expect(table.getByRole('row').nth(1)).toContainText('Priya Raman');
    await expect(table.getByRole('row').nth(1)).toContainText('$7.92');
    await expect(page.getByTestId('guild-sheet')).toContainText('Counts only. Nobody sees what a member asked their agent.');
    expect(errors).toEqual([]);
  });

  test('an Officer without manage_agents sees usage only; a member sees neither', async ({ page, request }) => {
    const officer = { ...ONE, role: 'officer', grants: ['moderate', 'invite'] };
    const errors = await arrive(page, request, { list: [officer, TWO], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openDeskMenu(page, PANEL);
    await expect(deskMenu(page).getByRole('menuitem')).toHaveText(['Clean up', 'Move', 'Resize', 'Agent usage']);
    await page.keyboard.press('Escape');
    await openDeskMenu(page, PANEL_TWO);
    await expect(deskMenu(page).getByRole('menuitem')).toHaveText(['Clean up', 'Move', 'Resize']);
    expect(errors).toEqual([]);
  });

  for (const theme of THEMES) {
    test(`the sheet passes axe in ${theme}`, async ({ page, request }) => {
      const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } }, '', theme);
      await openApp(page, 'Platform team', 'Commons');
      await openDeskMenu(page, PANEL);
      await deskMenu(page).getByRole('menuitem', { name: 'Guild limits' }).click();
      await expect(page.getByTestId('gs-perMember-runsPerDay')).toHaveValue('20');
      expect(await axe(page, '[data-testid="guild-sheet"]')).toEqual([]);
      await page.getByTestId('guild-tab-usage').click();
      await expect(page.getByTestId('guild-usage-table')).toBeVisible();
      expect(await axe(page, '[data-testid="guild-sheet"]')).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('the privacy line', () => {
  test('once, on the first Guild Desk opened, with the tiers’ names from the setting; put away for good', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await harness(request, { tierNames: { alliance: 'Alliance Member', officer: 'Steward', lead: 'Captain' } });
    await page.reload();
    await canvasPainted(page);
    await expect(page.getByTestId('guild-privacy')).toHaveCount(0);
    await openApp(page, 'Platform team', 'Commons');
    const line = page.getByTestId('guild-privacy');
    await expect(line).toHaveText(/The Guild Desk sees your connection's address, like any server\. No member sees it, Captain and Steward included, and your agent conversations stay yours\./);
    await line.getByRole('button', { name: 'Dismiss' }).click();
    await expect(line).toHaveCount(0);
    await page.reload();
    await canvasPainted(page);
    await openApp(page, 'Platform team', 'Commons');
    await page.waitForTimeout(300);
    await expect(page.getByTestId('guild-privacy')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('removal', () => {
  test('removed while it’s open: a calm state in each window, a notice, and the member puts it away', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE, TWO], desks: { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' } } });
    await openApp(page, 'Platform team', 'Commons');
    await expect(page.getByTestId('commons-app')).toBeVisible();
    await harness(request, { guilds: { list: [TWO], refuse: { [ONE.guildId]: 403 } } });
    await page.evaluate((id) => (window as unknown as Mocked).__maDeskMock.guild.kick(id), PANEL);
    await expect(page.getByTestId('guild-removed')).toContainText("You're no longer in this guild", { timeout: 15_000 });
    await expect(page.getByTestId('guild-removed-notice')).toContainText("You're no longer in Platform team.");
    await page.getByTestId('guild-removed-notice').getByRole('button', { name: 'Put it away' }).click();
    await expect(group(page, 'Platform team')).toHaveCount(0);
    await expect(page.getByTestId('guild-removed-notice')).toHaveCount(0);
    await expect(group(page, 'Design review')).toBeAttached();
    expect(errors.filter((e) => !e.includes('403'))).toEqual([]); // the browser's own line for the refused token
  });
});

test.describe('?guild= from the guild app', () => {
  test('selects the Guild scope and opens that Guild Desk, and the address loses it', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE, TWO], desks: { [TWO.guildId]: { deskId: 'd-gdesign', state: 'stopped' } } }, `&guild=${TWO.guildId}`);
    await expect(page.getByRole('radio', { name: 'Guild' })).toBeChecked();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('ma.view.v1') ?? '{}').activeDesk)).toBe(PANEL_TWO);
    await expect.poll(async () => (await log(request)).filter((x) => x === `POST /v1/guilds/${TWO.guildId}/desk/wake`).length).toBe(1);
    expect(new URL(page.url()).searchParams.get('guild')).toBeNull();
    expect(errors).toEqual([]);
  });

  test('a guild that isn’t theirs opens nothing', async ({ page, request }) => {
    const errors = await arrive(page, request, { list: [ONE] }, '&guild=gu-notmine00000');
    await page.waitForTimeout(500);
    expect(new URL(page.url()).searchParams.get('guild')).toBeNull();
    expect((await log(request)).some((x) => x.includes('/desk/wake'))).toBe(false);
    expect(errors).toEqual([]);
  });
});
