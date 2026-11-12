// ISS-89's follow-up, the Guild half: a tab whose tokens become another member's (a sign-in in another tab) keeps nothing of
// the last member's guilds. A Guild Desk's panel id is the guild's (`guild-<guildId>`), the same for every member in it, so a
// link kept by its id would go on as the last member: the session they opened with their own guild token, deskd's `guild.hello`
// on it (who they are there, and what they may do), and what it said, such as a data guard that's theirs. Nor do their Guild
// Desks, their guilds' names or a "no longer in" notice show while the new member's lists are on their way. The new member's
// own list is held back here, as a slow `/v1/desks` would, since that's when a kept link stays. UI/UX's half, the windows, is
// theirs; `src/guild/guildStore.test.ts` has the store's side in unit form.
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn } from './helpers';

const PERSONAL = 'd-personal00001';
const BAKERY = 'd-bakery0000001';
const fleetA = [{ deskId: PERSONAL, name: 'Atelier', kind: 'personal', state: 'running' }];
const fleetB = [{ deskId: BAKERY, name: 'Bakery', kind: 'personal', state: 'running' }];

/** A is the Founder of Platform team and a member of Design review. B is in Platform team alone, as a plain member. */
const ONE = { guildId: 'gu-platformteam', name: 'Platform team', role: 'lead', grants: ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'] };
const TWO = { guildId: 'gu-designreview', name: 'Design review', role: 'member', grants: [] };
const ONE_FOR_B = { ...ONE, role: 'member', grants: [] };
const RUNNING = { [ONE.guildId]: { deskId: 'd-gplatform', state: 'running' }, [TWO.guildId]: { deskId: 'd-gdesign', state: 'running' } };
const PANEL_ONE = `guild-${ONE.guildId}`;
const PANEL_TWO = `guild-${TWO.guildId}`;
const GUILD_WORDS =
  'Your guild sessions are paused because the data you used this month went well past what your plan includes. The guild carries on without you. Email support@minimalistalliance.com and we will turn them back on, or they come back by themselves on your next billing day.';

type Hello = { name: string; deskId: string };
type Mocked = { __maDeskMock: { guild: { calls: { m: string; as?: Hello }[] } } };

const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const group = (page: Page, name: string): Locator => page.getByRole('group', { name: `${name} desk` });
const log = async (request: APIRequestContext): Promise<string[]> => ((await (await request.get('/__harness')).json()) as { log: string[] }).log;
const count = async (request: APIRequestContext, line: string): Promise<number> => (await log(request)).filter((x) => x === line).length;
const TOKEN_ONE = `POST /v1/guilds/${ONE.guildId}/desk/token`;
/** Every `guild.hello`, with who the session it came on was opened for (the mock reads it from the guild token, as deskd does). */
const hellos = (page: Page): Promise<Hello[]> =>
  page.evaluate(() => (window as unknown as Mocked).__maDeskMock.guild.calls.filter((c) => c.m === 'guild.hello').map((c) => c.as ?? { name: '?', deskId: '?' }));
/** A's guilds' names, or anything else of A's, anywhere in this page's storage. */
const anyOfA = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const [where, s] of [['local', localStorage], ['tab', sessionStorage]] as const) {
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i)!;
        const v = s.getItem(k) ?? '';
        for (const x of ['u-test', 'Design review', 'gu-designreview', 'Atelier', 'Dana Whitfield']) if (v.includes(x)) out.push(`${where} ${k}: ${x}`);
      }
    }
    return out;
  });

async function openApp(page: Page, desk: string, app: string): Promise<void> {
  await group(page, desk).getByRole('button', { name: new RegExp(`^${app}`) }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: new RegExp(app) })).toBeVisible();
  await page.waitForTimeout(600); // the camera's focus settles
}

/** The new member's own desk list waits until the returned function is called, as a slow `/v1/desks` would. */
async function holdDeskList(page: Page): Promise<() => void> {
  let go = (): void => {};
  const held = new Promise<void>((done) => {
    go = done;
  });
  await page.route((url) => url.pathname === '/v1/desks', async (route) => {
    await held;
    await route.continue();
  });
  return go;
}

/**
 * The refresh token this browser keeps becomes B's, as a sign-in in another tab leaves it, and this tab's next call refreshes
 * (its access tokens are short) and gets B's. B's guild list is asked once `/v1/me` has said who.
 */
async function becomeB(page: Page, request: APIRequestContext, guilds: Record<string, unknown>): Promise<void> {
  const lists = await count(request, 'GET /v1/guilds');
  await harness(request, { userId: 'u-other', displayName: 'Robin Vale', fleet: fleetB, guilds });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 8_000 }).toBe('u-other');
  await expect.poll(() => count(request, 'GET /v1/guilds'), { timeout: 8_000 }).toBeGreaterThan(lists);
  await page.waitForTimeout(500); // the list lands
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test("in a guild both are in, the new member's Guild Desk session is their own: a guild token of theirs, and deskd's word on who they are", async ({ page, request }) => {
  await harness(request, { fleet: fleetA, guilds: { list: [ONE, TWO], desks: RUNNING }, displayName: 'Dana Whitfield', expiresIn: 60 });
  await signIn(page);
  await canvasPainted(page);
  // A's sessions on both Guild Desks, each on a guild token asked for as A.
  await expect.poll(() => hellos(page), { timeout: 8_000 }).toEqual(expect.arrayContaining([{ name: 'Dana Whitfield', deskId: PANEL_ONE }, { name: 'Dana Whitfield', deskId: PANEL_TWO }]));
  expect(await count(request, TOKEN_ONE)).toBe(1);
  const helloBefore = (await hellos(page)).length;

  const release = await holdDeskList(page);
  await becomeB(page, request, { list: [ONE_FOR_B], desks: RUNNING });
  release();
  await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
  await expect(proxy(page, PANEL_ONE)).toBeAttached();
  // Platform team's session is B's own, on a guild token asked for as B, and the only `guild.hello` since is on it.
  await expect.poll(() => count(request, TOKEN_ONE), { timeout: 8_000 }).toBe(2);
  await expect.poll(async () => (await hellos(page)).slice(helloBefore), { timeout: 8_000 }).toEqual([{ name: 'Robin Vale', deskId: PANEL_ONE }]);
  // And the office acts on B's word: a plain member has no "Guild limits" on the Agent's line.
  await openApp(page, 'Platform team', 'Agent');
  await expect(page.getByTestId('guild-agent-line')).toBeVisible();
  await expect(page.getByTestId('guild-agent-line').getByRole('button')).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect((await hellos(page)).slice(helloBefore).filter((x) => x.name !== 'Robin Vale')).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
});

test("none of the last member's Guild Desks, guilds' names or a notice that they left one show, while the new member's lists are on their way or after", async ({ page, request }) => {
  await harness(request, { fleet: fleetA, guilds: { list: [ONE, TWO], desks: RUNNING }, displayName: 'Dana Whitfield', expiresIn: 60 });
  await signIn(page);
  await canvasPainted(page);
  await expect(proxy(page, PANEL_TWO)).toBeAttached();

  const release = await holdDeskList(page);
  await becomeB(page, request, { list: [ONE_FOR_B], desks: RUNNING });
  // B's guild list has answered; B's own list hasn't.
  await expect(proxy(page, PANEL_TWO)).toHaveCount(0);
  await expect(proxy(page, PERSONAL)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Design review');
  await expect(page.getByTestId('guild-removed-notice')).toHaveCount(0);
  expect(await anyOfA(page)).toEqual([]);

  release();
  await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
  await expect(proxy(page, PANEL_ONE)).toBeAttached();
  await page.waitForTimeout(1_000);
  await expect(proxy(page, PANEL_TWO)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Design review');
  await expect(page.getByTestId('guild-removed-notice')).toHaveCount(0);
  expect(await anyOfA(page)).toEqual([]);
  await page.unrouteAll({ behavior: 'wait' });
});

test("a data guard on the last member's Guild Desk sessions isn't the new member's: their Guild Desk opens", async ({ page, request }) => {
  const resumesAt = new Date(Date.now() + 8 * 86_400_000).toISOString();
  await harness(request, { fleet: fleetA, guilds: { list: [ONE], desks: RUNNING, guard: { [ONE.guildId]: { message: GUILD_WORDS, resumesAt } } }, displayName: 'Dana Whitfield', expiresIn: 60 });
  await signIn(page);
  await canvasPainted(page);
  await group(page, 'Platform team').getByRole('button', { name: /^Commons/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('data-guard-message').first()).toHaveText(GUILD_WORDS);

  // B isn't held. A refused mock desk stays refused on a recheck (a real one asks `connect` again within 15 s or so), so here
  // only what the change itself does can bring the Guild Desk back for B.
  const release = await holdDeskList(page);
  await becomeB(page, request, { list: [ONE_FOR_B], desks: RUNNING });
  release();
  await expect(proxy(page, BAKERY)).toBeAttached({ timeout: 8_000 });
  await expect(page.getByTestId('data-guard-message')).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator('body')).not.toContainText('Your guild sessions are paused');
  await page.unrouteAll({ behavior: 'wait' });
});
