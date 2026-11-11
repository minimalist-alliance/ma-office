// S-14: the Agent's tools, approvals, memory and audit (the Product Designer's spec, `design-drafts/agent-tools/README.md`), on
// `MockDeskLink`, whose agent mock answers deskd API.md section 18's approvals, the spec's `agent.tools` and desk-agent's
// `agent.memory.*` in their wire shapes, so the real `RpcAgentClient` and the window run as on a desk. `?agentFixture=tools` is
// Scout waiting on a Send outside, Writer idle, and what Scout remembers. Every screen in Light, Zen and Dark with axe, a phone,
// and the rules that keep a yes the member's own: Enter never approves, Approve arms after 500 ms, a card that doesn't hash to
// what it shows has no Approve, and focus never jumps into a card.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface ToolsMock {
  runTool(agentId: string, c: { tool: string; doing: string; target: string; risk?: string; stoppable?: boolean; ms?: number; agoMs?: number }): string;
  expireApprovals(): void;
  ask(agentId: string, name: string, text?: string): void;
  tamperApproval(agentId: string): void;
}
interface MockControl {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  refuse: Record<string, string>;
  agent: { desks: Record<string, { client: ToolsMock }> };
}
/** The page's mock, as this spec reads it (other specs declare `(window as unknown as W).__maDeskMock` their own way). */
type W = { __maDeskMock: MockControl };

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const card = (page: Page): Locator => page.getByTestId('approval');
const status = (page: Page): Locator => agentWindow(page).locator('.ag-sr[role="status"]');
const decides = (page: Page): Promise<{ approve: unknown; note: unknown; sha256: unknown }[]> =>
  page.evaluate(() => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === 'agent.approval.decide').map((r) => ({ approve: r.p['approve'], note: r.p['note'], sha256: r.p['sha256'] })));
/** One of the mock's S-14 hooks, on the first desk's agent mock. */
const mock = <K extends keyof ToolsMock>(page: Page, hook: K, ...args: Parameters<ToolsMock[K]>): Promise<void> =>
  page.evaluate(
    ([name, list]) => {
      const client = Object.values((window as unknown as W).__maDeskMock.agent.desks)[0]!.client as unknown as Record<string, (...a: unknown[]) => unknown>;
      client[name as string]!(...(list as unknown[]));
    },
    [hook, args] as const,
  );

async function arrive(page: Page, query = ''): Promise<void> {
  await signIn(page, `/?fixture=one&speed=fast&agentFixture=tools${query}`);
  await canvasPainted(page);
}

/** The Agent window, filling the screen as the spec's stills do, so the rail shows beside the thread. */
async function openAgent(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
  const fill = agentWindow(page).getByRole('button', { name: 'Fill the screen' });
  if (await fill.isVisible()) {
    await fill.click();
    await expect.poll(() => agentWindow(page).evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(page.viewportSize()!.width - 40);
    await page.waitForTimeout(300); // the window's own grow, then the rail
  }
}

/** An agent in the rail; where the rail is folded away (a phone), through its button. */
async function pick(page: Page, agentId: string): Promise<void> {
  const row = page.getByTestId(`agent-${agentId}`);
  const toggle = page.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => (await row.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await row.isVisible())) await toggle.click();
  await row.click();
}

async function openScout(page: Page): Promise<void> {
  await openAgent(page);
  await pick(page, 'scout');
  await expect(card(page)).toBeVisible();
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run({ include: ['.ma-window .window-body'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `test-results/shots/agent-tools-${name}.png` });
}

async function twoOfScoutsAndWritersElsewhere(page: Page): Promise<void> {
  await mock(page, 'runTool', 'scout', { tool: 'browser_read', doing: 'Reading a web page', target: 'reviews.example.org/lamps/2026', agoMs: 42_000 });
  await mock(page, 'runTool', 'scout', { tool: 'notebook_search', doing: 'Searching your Notebook', target: '“lamp”', agoMs: 3_000 });
  await mock(page, 'runTool', 'writer', { tool: 'notebook_read', doing: 'Reading your note', target: '“Home office”', agoMs: 10_000 });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: the four screens, clean and readable`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await openScout(page);

    // 1. A Send outside, waiting: the chip, the desk's template, the exact address, what it tells the site, the agent's words
    // labelled as its own, why it asks, and the foot. The composer waits; the rail says Scout needs you.
    const c = card(page);
    await expect(c).toHaveAttribute('data-level', 'send');
    await expect(c.getByTestId('approval-level')).toHaveText('Sends outside your desk');
    await expect(c.getByTestId('approval-title')).toHaveText('Open a page on shop.example.com');
    await expect(c.getByTestId('approval-rows')).toContainText('Browser · Open a page');
    await expect(c.getByTestId('approval-rows')).toContainText('https://shop.example.com/compare?item=lumen-arc&width=120cm&budget=80');
    await expect(c.getByTestId('approval-leaves')).toContainText('What this address tells shop.example.com');
    await expect(c.getByTestId('approval-says')).toHaveText('Scout says: I want today’s price for the Lumen Arc, in the size your note gives.');
    await expect(c.getByTestId('approval-why')).toHaveText('It asks because this task has read your notes and pages from other sites, and an address can carry what it read.');
    await expect(c.getByTestId('approval-foot')).toContainText('Nothing happens until you do.');
    await expect(c.getByTestId('approval-approve')).toHaveText('Approve');
    await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', 'Waiting for your answer');
    await expect(page.getByTestId('composer-stop')).toBeVisible();
    await expect(page.getByTestId('agent-scout')).toContainText('needs you');
    await expect(page.getByTestId('agent-scout').getByTestId('agent-count')).toHaveAttribute('aria-label', '1 request waiting');
    await expect(page.getByTestId('tool-chips').first()).toContainText('Read your note');
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-send-waiting`);

    // 2. Running tools: two of Scout's, and Writer's elsewhere.
    await twoOfScoutsAndWritersElsewhere(page);
    const strip = page.getByTestId('running');
    await expect(strip.getByTestId('running-row')).toHaveCount(2);
    await expect(strip.getByTestId('running-row').first()).toContainText('Reading a web page');
    await expect(strip.getByTestId('running-also')).toContainText('Also running: Writer, 1 tool');
    await expect(strip.getByTestId('running-stop').first()).toHaveAttribute('aria-label', 'Stop reading a web page, reviews.example.org/lamps/2026');
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-running`);

    // 3. What Scout remembers, with Forget everything open.
    await page.getByTestId('tab-memory').click();
    const drawer = page.getByTestId('drawer');
    await expect(drawer).toHaveAttribute('aria-label', 'What Scout remembers');
    await expect(drawer.getByTestId('memory-count')).toHaveText('6 memories · up to 50');
    await expect(drawer.getByTestId('memory-line').first()).toContainText('Alex’s desk is 120 cm wide and faces a window.');
    await drawer.getByTestId('memory-forget').click();
    await expect(drawer.getByTestId('memory-forget-box')).toContainText('Forget all 6 things Scout remembers?');
    await expect(drawer.getByTestId('memory-forget-cancel')).toBeFocused();
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-memory`);

    // 4. Activity: tools, approvals and memory, in three lines each.
    await page.getByTestId('tab-activity').click();
    await expect(drawer.getByTestId('audit-tool-row').first()).toBeVisible();
    await expect(drawer).toContainText('Every tool, approval, memory, key change, model call and limit, on this desk only.');
    await expect(drawer).toContainText('Declined: move a page to Trash');
    await expect(drawer).toContainText('No approval needed: it only reads');
    expect(await axe(page)).toEqual([]);
    await shot(page, `${theme}-activity`);
    expect(errors).toEqual([]);
  });
}

test('Approve: arms after 500 ms, never on Enter, carries the hash, then says what happened', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await openAgent(page);
  await pick(page, 'writer');
  await expect(page.getByTestId('msg-agent')).toHaveCount(1); // Writer's thread is here before its card comes
  await page.getByTestId('composer-input').fill('half a thought');
  await page.getByTestId('composer-input').focus();

  // A card arrives while the member types: it's announced, and focus stays in the composer.
  await mock(page, 'ask', 'writer', 'trash', 'I found 3 pages with “draft” in the title that haven’t changed in over a year.');
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(status(page)).toHaveText('Writer is asking to move “Old drafts, spring” to Trash. It’s in the thread.');
  await expect(page.getByTestId('composer-input')).toBeFocused();
  await expect(c.getByTestId('approval-level')).toHaveText('Changes your desk');
  await expect(c.getByTestId('approval-why')).toHaveText('You can bring it back from Notebook’s Trash.');
  await expect(c).toHaveAttribute('role', 'group');

  // Enter in the composer answers nothing, and a press within 500 ms of the card appearing does nothing.
  await page.keyboard.press('Enter');
  await c.getByTestId('approval-approve').click();
  expect(await decides(page)).toEqual([]);
  await expect(c).toHaveAttribute('data-state', 'pending');

  await page.waitForTimeout(600);
  await c.getByTestId('approval-approve').click();
  await expect(c.getByTestId('approval-state')).toContainText('Approved by you');
  const [d] = await decides(page);
  expect(d?.approve).toBe(true);
  expect(String(d?.sha256)).toMatch(/^[0-9a-f]{64}$/);
  await expect(c.getByTestId('approval-state')).toBeFocused();
  await expect(status(page)).toHaveText('Approved.');
  await expect(c.getByTestId('approval-state')).toContainText(/Done in \d+ s/);
  await expect(c.getByTestId('approval-sub')).toHaveText('Moved a page to Trash');
  await expect(page.getByTestId('msg-agent').last()).toContainText('Moved it to the Trash.');
  await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', 'Ask Writer');
  await shot(page, 'light-approved');
  expect(errors).toEqual([]);
});

test('Decline and say why: Esc cancels and keeps the window; the note goes with the no', async ({ page }) => {
  await arrive(page);
  await openScout(page);
  const c = card(page);
  await c.getByTestId('approval-why-open').click();
  const field = c.getByTestId('approval-why-input');
  await expect(field).toBeFocused();
  await expect(c).toContainText('Tell Scout why (it reads this with your no)');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(agentWindow(page)).toBeVisible();

  await c.getByTestId('approval-why-open').click();
  await c.getByTestId('approval-why-input').fill('Not that shop, please.');
  await expect(c).toContainText('22 of 500');
  await shot(page, 'light-decline-note');
  await c.getByTestId('approval-why-send').click();
  await expect(c.getByTestId('approval-state')).toContainText('Declined by you');
  await expect(c.getByTestId('approval-sub')).toHaveText('Open a page on shop.example.com. Scout was told not to do it, or try another way, unless you ask.');
  await expect(c.getByTestId('approval-note')).toHaveText('Your note: Not that shop, please.');
  expect(await decides(page)).toEqual([{ approve: false, note: 'Not that shop, please.', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  await expect(page.getByTestId('agent-scout')).not.toContainText('needs you');
  await shot(page, 'light-declined');
});

test('Spend: its amount is on Approve, and the foot says nothing is spent until you answer', async ({ page }) => {
  await arrive(page);
  await openAgent(page);
  await pick(page, 'writer');
  await expect(page.getByTestId('msg-agent')).toHaveCount(1);
  await mock(page, 'ask', 'writer', 'pictures', 'I can make four pictures of that.');
  const c = card(page);
  await expect(c).toHaveAttribute('data-level', 'spend');
  await expect(c.getByTestId('approval-level')).toHaveText('Spends money');
  await expect(c.getByTestId('approval-title')).toHaveText('Make 4 pictures of a reading corner');
  await expect(c.getByTestId('approval-approve')).toHaveText('Approve $0.32');
  await expect(c.getByTestId('approval-foot')).toContainText('Nothing is spent until you do.');
  expect(await axe(page)).toEqual([]);
  await shot(page, 'light-spend-waiting');
});

test('a card that doesn’t match what it shows has no Approve; one left past its time says so', async ({ page }) => {
  await arrive(page);
  await openScout(page);
  await mock(page, 'tamperApproval', 'scout');
  const c = card(page);
  await expect(c.getByTestId('approval-mismatch')).toHaveText('This card doesn’t match what Scout asked for, so it can’t be approved here. Ask Scout again.');
  await expect(c.getByTestId('approval-approve')).toHaveCount(0);
  await expect(c.getByTestId('approval-decline')).toBeEnabled();

  await mock(page, 'expireApprovals');
  await expect(c.getByTestId('approval-state')).toContainText('Not answered');
  await expect(c.getByTestId('approval-sub')).toHaveText('Nothing was done. Scout was told no one answered.');
});

test('Stop on a running tool: Stopping…, then it goes, and the status says so', async ({ page }) => {
  await arrive(page);
  await openScout(page);
  await twoOfScoutsAndWritersElsewhere(page);
  const strip = page.getByTestId('running');
  await expect(strip.getByTestId('running-time').first()).toHaveText(/^0:4\d$/);
  await strip.getByTestId('running-stop').first().click();
  await expect(strip.getByTestId('running-row')).toHaveCount(1);
  await expect(status(page)).toHaveText('Stopped reading a web page.');
  expect(await page.evaluate(() => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === 'agent.tool.stop').length)).toBe(1);
  // Writer's own window opens from its line.
  await strip.getByRole('button', { name: 'Open Writer' }).click();
  await expect(page.getByRole('dialog', { name: /Writer/ })).toBeVisible();
});

test('no running-tools topic (every desk today): no strip, nothing said', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  await page.evaluate(() => {
    (window as unknown as W).__maDeskMock.refuse['agent.tools'] = 'not_found';
  });
  await openScout(page);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('running')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Memory: search marks and Esc clears; delete one at once; forget everything', async ({ page }) => {
  await arrive(page);
  await openScout(page);
  await page.getByTestId('tab-memory').click();
  const drawer = page.getByTestId('drawer');
  const search = drawer.getByTestId('memory-search');
  await expect(search).toHaveAttribute('placeholder', 'Search 6 memories');
  await search.fill('desk');
  await expect(drawer.getByTestId('memory-line')).toHaveCount(1);
  await expect(drawer.locator('mark')).toHaveText('desk');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(drawer).toBeVisible();
  await search.fill('nothing like it');
  await expect(drawer.getByTestId('memory-none')).toHaveText('Nothing Scout remembers matches “nothing like it”.');
  await search.fill('');

  await expect(drawer.getByTestId('memory-line').nth(3)).toContainText('Saved after you approved');
  await drawer.getByTestId('memory-delete').first().click();
  await expect(drawer.getByTestId('memory-count')).toHaveText('5 memories · up to 50');
  await expect(status(page)).toHaveText('Deleted. Scout won’t recall it again.');
  await expect(drawer.getByTestId('memory-delete').first()).toBeFocused();

  await drawer.getByTestId('memory-forget').click();
  await drawer.getByTestId('memory-forget-all').click();
  await expect(drawer.getByTestId('memory-empty')).toHaveText('Scout doesn’t remember anything yet. Tell it “remember …” in the chat, or it saves what helps as you talk.');
  await expect(status(page)).toHaveText('Scout forgot everything it remembered.');
  const calls = await page.evaluate(() => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m.startsWith('agent.memory.')).map((r) => r.m));
  expect(calls).toEqual(expect.arrayContaining(['agent.memory.list', 'agent.memory.delete', 'agent.memory.clear']));
});

test('Activity: the filters, and one row per call with its approval', async ({ page }) => {
  await arrive(page);
  await openScout(page);
  await page.waitForTimeout(600);
  await card(page).getByTestId('approval-approve').click();
  await expect(card(page).getByTestId('approval-state')).toContainText(/Done/);
  await page.getByTestId('tab-activity').click();
  const drawer = page.getByTestId('drawer');
  await drawer.getByTestId('activity-show').selectOption('tools');
  await expect(drawer.getByText('Opened a web page')).toHaveCount(1);
  await expect(drawer.locator('li[data-action="approval.ask"], li[data-action="approval.decide"]')).toHaveCount(0);
  await expect(drawer.getByTestId('audit-let-by').first()).toHaveText('Approved by you');
  await drawer.getByTestId('activity-show').selectOption('memory');
  await expect(drawer.getByText('Saved a memory')).toBeVisible();
  await drawer.getByTestId('activity-agent').selectOption({ label: 'Writer' });
  await expect(drawer.getByTestId('activity-none')).toHaveText('Nothing like that in this stretch of the log.');
});

test('the window closed: the Agent tile says the team needs you, with the count', async ({ page }) => {
  await arrive(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await expect(tile).toHaveAccessibleName(/1 need you/);
  // Scout's own tile says its request is waiting.
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Scout/ })).toHaveAccessibleName('Scout, 1 request waiting');
});

test.describe('on a phone, 390 px', () => {
  for (const theme of THEMES) {
    test(`${theme}: Send waiting, running, memory and Activity fit, clean`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await arrive(page);
      await openScout(page);
      const approve = card(page).getByTestId('approval-approve');
      expect((await approve.boundingBox())?.height).toBeGreaterThanOrEqual(43.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-send-waiting`);
      await twoOfScoutsAndWritersElsewhere(page);
      await expect(page.getByTestId('running-row')).toHaveCount(2);
      await shot(page, `phone-${theme}-running`);
      await page.getByTestId('tab-memory').click();
      await page.getByTestId('memory-forget').click();
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-memory`);
      await page.getByTestId('tab-activity').click();
      await expect(page.getByTestId('audit-tool-row').first()).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}-activity`);
      expect(errors).toEqual([]);
    });
  }
});
