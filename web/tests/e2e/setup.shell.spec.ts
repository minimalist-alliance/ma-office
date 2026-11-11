// The setup circle (S-121, the Product Designer's `design-drafts/setup-circle/README.md`): each tier's steps, a step done by
// using it, Skip and Undo, Hide and Show again (kept in the layout document's `prefs`, so it follows the account), the
// Founder with no guild yet (Found your guild first, and no Guild Desk spot or Guild scope), the after-setup
// states (What's new, the offer card, Not now for 30 days, nothing at all), a teen (no {officer} offer), the keyboard and
// what a screen reader hears, axe in Light, Dusk and Dark, reduced motion, and the bottom bar at 320, 375 and 1024 px. The harness has the circle off (`setupCircle`, as
// `files`), so every spec here turns it on. Every console error fails a test.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const MIRROR = 'ma.setup.prefs.v1';
const GUILD_APP = 'https://guild.localhost/';
const ACCOUNT = 'https://platform.localhost/account';

const LISTS = {
  free: ['Open the Browser', 'Give your Agent an AI key', 'Put a file in Files', 'Try Maia for a week'],
  alliance: ['Open the Browser', 'Give your Agent an AI key', 'Put a file in Files', 'Join a guild'],
  officer: ['Open your Work desk', 'Open the Browser', 'Give your Agent an AI key', 'Put a file in Files', 'Join a guild', 'Name your desks'],
  lead: ['Found your guild', 'Invite your first members', 'Open your Work desk', 'Open the Browser', 'Give your Agent an AI key', 'Put a file in Files', 'Name your desks'],
};
const IDS = {
  officer: ['work-desk', 'browser', 'agent-key', 'files', 'guild-join', 'name-desks'],
  alliance: ['browser', 'agent-key', 'files', 'guild-join'],
  lead: ['found-guild', 'invite', 'work-desk', 'browser', 'agent-key', 'files', 'name-desks'],
};
const PERSONAL_WORK = [
  { deskId: 'd-personal0000', kind: 'personal', name: 'Personal', state: 'running' },
  { deskId: 'd-work00000001', kind: 'work', name: 'Work', state: 'running' },
];

interface Arrive {
  tier?: 'free' | 'alliance' | 'officer' | 'lead';
  age?: string;
  /** A fixture's desks (no layout sync), or the harness's fleet (layout sync on). */
  fixture?: 'one' | 'three';
  fleet?: unknown[];
  /** What this browser already holds of the member's setup prefs (`setup/prefs.ts`'s mirror). */
  mirror?: Record<string, unknown>;
  /** What Platform's layout document already holds in `prefs`. */
  docPrefs?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  harnessExtra?: Record<string, unknown>;
  theme?: ThemeId;
  /** The mock desks' agents: `fresh` (no key) or `ready` (agents on a working key). */
  agents?: 'fresh' | 'ready';
}

async function arrive(page: Page, request: APIRequestContext, o: Arrive = {}): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await harness(request, {
    setupCircle: null,
    files: { enabled: true },
    ...(o.age ? { age: o.age } : { membership: { status: 'active', tier: o.tier ?? 'officer' } }),
    configExtra: { links: { guildAdmin: GUILD_APP }, ...(o.extra ?? {}) },
    ...(o.fleet ? { fleet: o.fleet } : {}),
    ...(o.docPrefs ? { layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-09T00:00:00Z', layout: { schemaVersion: 1, desks: {}, prefs: o.docPrefs } } } } : {}),
    ...(o.harnessExtra ?? {}),
  });
  await setTheme(page, o.theme ?? 'light');
  if (o.mirror) {
    // Once per arrival, not on every load: a reload must find what the office wrote since, not this again.
    const token = `${Date.now()}-${Math.random()}`;
    await page.addInitScript(
      ([key, prefs, t]) => {
        if (sessionStorage.getItem('setup-spec-mirror') === t) return;
        sessionStorage.setItem('setup-spec-mirror', t as string);
        localStorage.setItem(key as string, JSON.stringify({ who: 'u-test', prefs }));
      },
      [MIRROR, o.mirror, token] as const,
    );
  }
  // The mock desks' agents start with no key (`agentFixture=fresh`), so "Give your Agent an AI key" starts open.
  const agents = `agentFixture=${o.agents ?? 'fresh'}&speed=fast`;
  await signIn(page, o.fixture === undefined && o.fleet ? `/?${agents}` : `/?fixture=${o.fixture ?? 'three'}&${agents}`);
  await canvasPainted(page);
  return errors;
}

const circle = (page: Page): Locator => page.getByTestId('setup-button');
const panel = (page: Page): Locator => page.getByTestId('setup-panel');
const step = (page: Page, id: string): Locator => panel(page).locator(`[data-step="${id}"]`);

async function openPanel(page: Page): Promise<void> {
  await circle(page).click();
  await expect(panel(page)).toBeVisible();
}

async function titles(page: Page): Promise<string[]> {
  return panel(page).locator('.su-step').evaluateAll((els) => els.map((el) => (el.querySelector('.su-step-head, .su-step-title') as HTMLElement).innerText.trim()));
}

async function axe(page: Page, include: string[]): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run({ include: sel.map((s) => [s]) }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

const layoutPrefs = async (request: APIRequestContext): Promise<Record<string, unknown> | null> => {
  const s = (await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout?: { prefs?: Record<string, unknown> } }> };
  return s.layoutDocs['u-test']?.layout?.prefs ?? null;
};

test.describe('the setup circle', () => {
  test('each tier has its own steps, in order, and the ring says how far along', async ({ page, request }) => {
    for (const tier of ['alliance', 'officer', 'lead'] as const) {
      const errors = await arrive(page, request, { tier, harnessExtra: { guilds: { list: [] } } });
      await expect(circle(page)).toHaveAttribute('aria-label', /^Setup: \d of \d done$/);
      await openPanel(page);
      expect(await titles(page)).toEqual(LISTS[tier]);
      await expect(panel(page).getByText('Set up your office')).toBeVisible();
      expect(errors).toEqual([]);
    }
    // {free}: Maia's trial is a step, where she offers it.
    const errors = await arrive(page, request, { tier: 'free', harnessExtra: { maia: { enabled: false, trial: { status: 'unused', endsAt: null } } } });
    await openPanel(page);
    expect(await titles(page)).toEqual(LISTS.free);
    expect(errors).toEqual([]);
  });

  test('the first open step is open, the others show their title; pressing one opens it and closes the last', async ({ page, request }) => {
    await arrive(page, request, { tier: 'officer' });
    await openPanel(page);
    await expect(step(page, 'work-desk').getByRole('button', { name: 'Open your Work desk', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(step(page, 'work-desk').getByText('Work stays at work: its own Browser sign-ins, files and agents.')).toBeVisible();
    await expect(step(page, 'browser').getByText('Browse from your desk, in a simpler, quieter view.')).toHaveCount(0);
    await step(page, 'browser').getByRole('button', { name: 'Open the Browser', exact: true }).click();
    await expect(step(page, 'browser').getByText('Browse from your desk, in a simpler, quieter view.')).toBeVisible();
    await expect(step(page, 'work-desk').getByRole('button', { name: 'Open your Work desk', exact: true })).toHaveAttribute('aria-expanded', 'false');
  });

  test('a step is done by using it: Go to Work focuses the Work desk, and the Browser showing a page is the Browser’s', async ({ page, request }) => {
    const errors = await arrive(page, request, { tier: 'officer' });
    await expect(circle(page)).toHaveAttribute('aria-label', 'Setup: 0 of 6 done');
    await openPanel(page);
    await step(page, 'work-desk').getByRole('button', { name: 'Go to Work' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(circle(page)).toHaveAttribute('aria-label', 'Setup: 1 of 6 done');
    await openPanel(page);
    await expect(step(page, 'work-desk')).toHaveAttribute('data-state', 'done');
    await expect(step(page, 'browser').getByRole('button', { name: 'Open the Browser', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await step(page, 'browser').getByRole('button', { name: 'Open Browser' }).click();
    await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
    await expect(circle(page)).toHaveAttribute('aria-label', 'Setup: 2 of 6 done', { timeout: 15_000 });
    expect(errors).toEqual([]);
  });

  test('Give your Agent an AI key is done once an own desk’s agent works on a key', async ({ page, request }) => {
    const errors = await arrive(page, request, { tier: 'officer', agents: 'ready' });
    await expect(circle(page)).toHaveAttribute('aria-label', 'Setup: 1 of 6 done', { timeout: 15_000 });
    await openPanel(page);
    await expect(step(page, 'agent-key')).toHaveAttribute('data-state', 'done');
    expect(errors).toEqual([]);
  });

  test('Skip and Undo', async ({ page, request }) => {
    await arrive(page, request, { tier: 'officer' });
    await openPanel(page);
    await step(page, 'work-desk').getByRole('button', { name: 'Skip: Open your Work desk' }).click();
    await expect(step(page, 'work-desk')).toHaveAttribute('data-state', 'skipped');
    await expect(step(page, 'work-desk').getByText('Skipped')).toBeVisible();
    // A skipped step shows a short dash, not the check a done step has.
    await expect(step(page, 'work-desk').locator('svg.su-mark.skipped path')).toHaveAttribute('d', 'M5 8h6');
    await expect(panel(page).getByTestId('setup-count')).toHaveText('1 of 6 done');
    await expect(circle(page)).toHaveAttribute('aria-label', 'Setup: 1 of 6 done');
    // The keyboard lands on Undo, where the member is looking.
    await expect(step(page, 'work-desk').getByRole('button', { name: 'Undo: Open your Work desk' })).toBeFocused();
    await expect(step(page, 'browser').getByRole('button', { name: 'Open the Browser', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(step(page, 'work-desk')).toHaveAttribute('data-state', 'open');
    await expect(circle(page)).toHaveAttribute('aria-label', 'Setup: 0 of 6 done');
  });

  test('by keyboard, with what a screen reader hears: the ring’s name, the Tab order, Enter and Space, Esc back to the ring', async ({ page, request }) => {
    const errors = await arrive(page, request, { tier: 'officer', mirror: { setup: { done: ['work-desk'], skipped: ['files'] } } });
    const btn = circle(page);
    // The ring is a picture; the button's name says how far along, and that it opens something.
    await expect(btn).toHaveAccessibleName('Setup: 2 of 6 done');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    // Left of the usage circle on screen, so before it in the Tab order.
    const usage = page.getByTestId('bandwidth-button');
    const a = await btn.boundingBox();
    const b = await usage.boundingBox();
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
    await btn.focus();
    await page.keyboard.press('Tab');
    await expect(usage).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(btn).toBeFocused();

    // Enter opens it: a region named by its title, which the button controls.
    await page.keyboard.press('Enter');
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    const region = page.getByRole('region', { name: 'Set up your office' });
    await expect(region).toBeVisible();
    await expect(btn).toHaveAttribute('aria-controls', (await region.getAttribute('id'))!);
    await expect(region.getByTestId('setup-count')).toHaveText('2 of 6 done');

    // Into it with Tab, in reading order: the first open step's title (expanded), its button, its Skip, the next title.
    const head = (id: string, name: string): Locator => step(page, id).getByRole('button', { name, exact: true });
    await page.keyboard.press('Tab');
    await expect(head('browser', 'Open the Browser')).toBeFocused();
    await expect(head('browser', 'Open the Browser')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(step(page, 'browser').getByRole('button', { name: 'Open Browser' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(step(page, 'browser').getByRole('button', { name: 'Skip: Open the Browser' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(head('agent-key', 'Give your Agent an AI key')).toBeFocused();
    await expect(head('agent-key', 'Give your Agent an AI key')).toHaveAttribute('aria-expanded', 'false');
    // Space on a title opens that step and closes the last.
    await page.keyboard.press('Space');
    await expect(head('agent-key', 'Give your Agent an AI key')).toHaveAttribute('aria-expanded', 'true');
    await expect(head('browser', 'Open the Browser')).toHaveAttribute('aria-expanded', 'false');
    await expect(step(page, 'agent-key').getByText('Try free models with no card, or use a key of your own. Either way, the key stays on your desk.')).toBeVisible();
    // A skipped step says so, and its Undo names the step.
    await expect(step(page, 'files').getByText('Skipped')).toBeVisible();
    await expect(step(page, 'files').getByRole('button', { name: 'Undo: Put a file in Files' })).toBeVisible();
    // A done step is its title alone, with nothing to press.
    await expect(step(page, 'work-desk').getByRole('button')).toHaveCount(0);
    await expect(region.getByRole('button', { name: 'Hide this circle' })).toBeVisible();

    // Esc closes it from anywhere inside, and the keyboard goes back to the ring.
    await page.keyboard.press('Escape');
    await expect(region).toHaveCount(0);
    await expect(btn).toBeFocused();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    // Space opens it too, and Enter and Space never reach the office's own keys (no desk focused, no window opened).
    await page.keyboard.press('Space');
    await expect(region).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Hide by keyboard: the circle goes, and the keyboard lands on the usage circle beside it.
    await btn.focus();
    await page.keyboard.press('Enter');
    await region.getByRole('button', { name: 'Hide this circle' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    await expect(usage).toBeFocused();
    // The account menu's switch says what it does, and that it's off.
    await page.getByRole('button', { name: 'Account' }).click();
    const sw = page.getByRole('switch', { name: 'Show setup and what\'s new' });
    await expect(sw).not.toBeChecked();
    await sw.focus();
    await page.keyboard.press('Space');
    await expect(sw).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(circle(page)).toHaveAccessibleName('Setup: 2 of 6 done');
    expect(errors).toEqual([]);
  });

  test('Hide this circle, and Show setup and what’s new brings it back, kept for the account', async ({ page, request, browser }) => {
    const errors = await arrive(page, request, { tier: 'officer', fleet: PERSONAL_WORK });
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Hide this circle' }).click();
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    await expect.poll(async () => (await layoutPrefs(request))?.['circleHidden'], { timeout: 15_000 }).toBe(true);
    expect(errors).toEqual([]);

    // Another browser, signing in as the same member: still hidden, and the account menu brings it back.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    const errors2 = watchConsole(page2);
    await setTheme(page2, 'light');
    await signIn(page2);
    await canvasPainted(page2);
    await page2.waitForTimeout(800);
    await expect(page2.getByTestId('setup-circle')).toHaveCount(0);
    await page2.getByRole('button', { name: 'Account' }).click();
    const sw = page2.getByRole('switch', { name: 'Show setup and what\'s new' });
    await expect(sw).not.toBeChecked();
    await sw.check();
    await expect(page2.getByTestId('setup-circle')).toBeVisible();
    await expect.poll(async () => (await layoutPrefs(request))?.['circleHidden'], { timeout: 15_000 }).toBe(false);
    expect(errors2).toEqual([]);
    await other.close();
  });

  test('a Founder with no guild: Found your guild first, and no Guild Desk spot or Guild scope', async ({ page, request }) => {
    const errors = await arrive(page, request, { tier: 'lead', fleet: PERSONAL_WORK, harnessExtra: { guilds: { list: [] } } });
    await openPanel(page);
    expect(await titles(page)).toEqual(LISTS.lead);
    const found = step(page, 'found-guild').getByRole('link', { name: /Found a guild/ });
    await expect(found).toHaveAttribute('href', `${GUILD_APP}new`);
    await expect(found).toHaveAttribute('target', '_blank');
    // Invite waits for the guild.
    await step(page, 'invite').getByRole('button', { name: 'Invite your first members', exact: true }).click();
    await expect(step(page, 'invite').getByText('After you found your guild.')).toBeVisible();
    await expect(step(page, 'invite').getByRole('link')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);

    // No Guild Desk, placeholder or scope of any kind until the guild exists.
    await expect(page.getByTestId('guild-spot')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Guild' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a Founder whose guild exists: Found your guild is done, Invite links to it, and there’s no spot', async ({ page, request }) => {
    const guild = { guildId: 'gu-abcdefghijkl', name: 'Platform team', role: 'lead', grants: ['invite'], members: 1 };
    await arrive(page, request, { tier: 'lead', fleet: PERSONAL_WORK, harnessExtra: { guilds: { list: [guild] } } });
    await openPanel(page);
    await expect(step(page, 'found-guild')).toHaveAttribute('data-state', 'done');
    await expect(step(page, 'invite').getByRole('link', { name: /Invite/ })).toHaveAttribute('href', `${GUILD_APP}gu-abcdefghijkl/invites`);
    await expect(page.getByTestId('guild-spot')).toHaveCount(0);
  });

  test('after setup: What’s new, then the offer card; Got it, Not now for 30 days, then nothing', async ({ page, request }) => {
    const whatsNew = {
      items: [
        { id: 'old-1', title: 'Older news', line: 'Something from before.', action: { app: 'notebook' }, from: '2026-10-01T00:00:00Z', until: '2027-01-01T00:00:00Z' },
        { id: 'simple-1', title: 'A quieter Browser', line: 'Pages come through simpler, at your own size.', action: { app: 'browser' }, from: '2026-11-01T00:00:00Z', until: '2027-01-01T00:00:00Z' },
      ],
    };
    const errors = await arrive(page, request, { tier: 'officer', mirror: { setup: { done: IDS.officer, skipped: [] } }, extra: { whatsNew } });
    await expect(circle(page)).toHaveAttribute('aria-label', "What's new");
    await expect(circle(page).locator('.su-glyph-dot')).toHaveCount(1);
    await openPanel(page);
    await expect(panel(page).getByText('Your office', { exact: true })).toBeVisible();
    const item = panel(page).getByTestId('whats-new');
    await expect(item.getByText('A quieter Browser')).toBeVisible();
    await expect(panel(page).getByText('Older news')).toHaveCount(0);
    await expect(item.getByRole('button', { name: 'Try it' })).toBeVisible();
    const offer = panel(page).getByTestId('setup-offer');
    await expect(offer.getByText('Lead a guild of your own')).toBeVisible();
    await expect(offer.getByText('Founder includes a guild of your own, with a Guild Desk for its members.')).toBeVisible();
    await expect(offer.getByRole('link', { name: /See membership/ })).toHaveAttribute('href', ACCOUNT);
    await expect(offer.getByRole('link', { name: /See membership/ })).toHaveAttribute('target', '_blank');

    await item.getByRole('button', { name: 'Got it' }).click();
    await expect(panel(page).getByTestId('whats-new')).toHaveCount(0);
    // Older items were dropped with it, not queued.
    await expect(panel(page).getByText('Older news')).toHaveCount(0);
    await expect(circle(page)).toHaveAttribute('aria-label', 'Lead a guild of your own');
    await offer.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    // The circle went from under the keyboard: it lands on the usage circle beside it.
    await expect(page.getByTestId('bandwidth-button')).toBeFocused();
    await page.reload();
    await canvasPainted(page);
    await page.waitForTimeout(800);
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    const mirror = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as { prefs: Record<string, unknown> }, MIRROR);
    expect(mirror.prefs['whatsNewSeen']).toEqual(['simple-1', 'old-1']);
    const until = Date.parse(String(mirror.prefs['offerNotNowUntil']));
    expect(until - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(until - Date.now()).toBeLessThan(31 * 86_400_000);
    expect(errors).toEqual([]);
  });

  test('the {alliance} card names {officer} with figures from settings; the free card names {alliance}', async ({ page, request }) => {
    await arrive(page, request, { tier: 'alliance', mirror: { setup: { done: IDS.alliance, skipped: [] } }, extra: { tierAllowances: { officer: { weeklyAllowanceGb: 30 }, alliance: { driveGb: 25 } } } });
    await expect(circle(page)).toHaveAttribute('aria-label', 'Room for a Work desk');
    await openPanel(page);
    const offer = panel(page).getByTestId('setup-offer');
    await expect(offer.locator('li')).toHaveText(['Officer adds a Work desk, private and walled off from this one.', '30 GB of bandwidth a week', 'Desks you can name']);

    await arrive(page, request, { tier: 'free', mirror: { setup: { done: ['browser', 'agent-key', 'files'], skipped: [] } }, extra: { tierAllowances: { alliance: { driveGb: 25 } } } });
    await expect(circle(page)).toHaveAttribute('aria-label', 'More room with Alliance Member');
    await openPanel(page);
    await expect(panel(page).getByTestId('setup-offer').locator('li')).toHaveText(['No daily Browser limit', 'A 25 GB drive', 'Maia included']);
  });

  test('nothing to show after setup is no circle; so is the after-setup kill switch', async ({ page, request }) => {
    await arrive(page, request, { tier: 'lead', fleet: PERSONAL_WORK, mirror: { setup: { done: IDS.lead, skipped: [] } }, harnessExtra: { guilds: { list: [{ guildId: 'gu-abcdefghijkl', name: 'G', role: 'lead', members: 3 }] } } });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    await arrive(page, request, { tier: 'officer', mirror: { setup: { done: IDS.officer, skipped: [] } }, extra: { whatsNew: { enabled: false } } });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    // The whole circle's own switch.
    await arrive(page, request, { tier: 'officer', harnessExtra: { setupCircle: { enabled: false } } });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('switch', { name: 'Show setup and what\'s new' })).toHaveCount(0);
  });

  test('the last step settling while the panel is open says so; at close the circle turns into the offer', async ({ page, request }) => {
    await arrive(page, request, { tier: 'officer', mirror: { setup: { done: IDS.officer.slice(0, -1), skipped: [] } } });
    await openPanel(page);
    await step(page, 'name-desks').getByRole('button', { name: 'Skip: Name your desks' }).click();
    await expect(panel(page).getByTestId('setup-all-set')).toHaveText('Your office is set up.');
    await page.keyboard.press('Escape');
    await expect(circle(page)).toHaveAttribute('aria-label', 'Lead a guild of your own');
  });

  test('a teen: no Agent step, and after setup no {officer} card, so no circle', async ({ page, request }) => {
    await arrive(page, request, { age: 'teen', fixture: 'one' });
    await openPanel(page);
    expect(await titles(page)).toEqual(['Open the Browser', 'Put a file in Files', 'Join a guild']);
    await arrive(page, request, { age: 'teen', fixture: 'one', mirror: { setup: { done: ['browser', 'files', 'guild-join'], skipped: [] } } });
    await page.waitForTimeout(800);
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
  });

  for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
    test(`axe finds nothing in ${theme}: the panel in setup and after, the menu’s switch`, async ({ page, request }) => {
      await arrive(page, request, { tier: 'lead', theme, fleet: PERSONAL_WORK, harnessExtra: { guilds: { list: [] } } });
      await openPanel(page);
      expect(await axe(page, ['.setup-circle'])).toEqual([]);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Account' }).click();
      expect(await axe(page, ['#account-panel'])).toEqual([]);

      const whatsNew = { items: [{ id: 'n1', title: 'A quieter Browser', line: 'Pages come through simpler.', action: { app: 'browser' }, from: '2026-11-01T00:00:00Z', until: '2027-01-01T00:00:00Z' }] };
      await arrive(page, request, { tier: 'officer', theme, mirror: { setup: { done: IDS.officer, skipped: [] } }, extra: { whatsNew } });
      await openPanel(page);
      expect(await axe(page, ['.setup-circle'])).toEqual([]);
    });
  }

  test('a step fills its segment over 300 ms, and at once under reduced motion', async ({ page, request }) => {
    await arrive(page, request, { tier: 'officer' });
    const duration = (): Promise<string> => page.locator('.su-seg').first().evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(await duration()).toBe('0.3s');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await duration()).toBe('0s');
  });

  test('the bottom bar fits it at 375 and 1024 px, with Maia on too; at 320 px it moves into the account menu', async ({ page, request }) => {
    for (const width of [1024, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await arrive(page, request, { tier: 'officer' });
      const btn = await circle(page).boundingBox();
      const zoom = await page.getByRole('group', { name: 'Zoom' }).boundingBox();
      expect(btn && zoom).toBeTruthy();
      expect(btn!.x + btn!.width).toBeLessThanOrEqual(width);
      // Clear of the zoom control, beside it.
      expect(zoom!.x + zoom!.width).toBeLessThanOrEqual(btn!.x + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await openPanel(page);
      const box = await panel(page).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    // With Maia on: from 1200 px her bubble takes the right-most corner, the usage circle beside it, then the ring; narrower,
    // she sits above the circle. Nothing overlaps, and all of it is on screen.
    for (const width of [1280, 1024, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await arrive(page, request, { tier: 'officer', harnessExtra: { maia: { enabled: true } } });
      await expect(page.locator('.maia-launcher')).toBeVisible();
      const boxes = await Promise.all([circle(page), page.getByTestId('bandwidth-button'), page.locator('.maia-launcher'), page.getByRole('group', { name: 'Zoom' })].map((l) => l.boundingBox()));
      for (const b of boxes) expect(b && b.x >= 0 && b.x + b.width <= width).toBe(true);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i]!, boxes[j]!];
          const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
          expect(apart, `controls ${i} and ${j} at ${width} px`).toBe(true);
        }
      }
      const [ringBox, usageBox] = boxes;
      expect(ringBox!.x + ringBox!.width).toBeLessThanOrEqual(usageBox!.x + 0.5);
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await arrive(page, request, { tier: 'officer' });
    await expect(page.getByTestId('setup-circle')).toHaveCount(0);
    await page.getByRole('button', { name: 'Account' }).click();
    const row = page.getByTestId('menu-setup');
    await expect(row).toHaveText('Set up your office');
    await row.click();
    await expect(panel(page)).toBeVisible();
    expect(await titles(page)).toEqual(LISTS.officer);
    // The row already says the words, so the panel's own title is for screen readers only.
    expect((await panel(page).locator('.su-title').boundingBox())!.height).toBeLessThanOrEqual(1);
    await expect(panel(page)).toHaveAccessibleName('Set up your office');
    await expect(panel(page).getByTestId('setup-count')).toBeVisible();
    const box = await panel(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  });
});
