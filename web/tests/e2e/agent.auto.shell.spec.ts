// Done without asking, in the Agent window (deskd API.md section 18, "Done without asking"; draft ADR "the Agent's tools and
// approvals", section 15): a call an agent made under the member's setting is a chip, "Done without asking · Undo", never a
// card; the line under its reply counts what's still there, "Did 3 things without asking: … · Undo all · See them"; Undo is
// `agent.approval.undo`, one call per row, and says what happened in plain words; and a waiting card's "Don't ask again" turns
// the switch on through `agent.access.set` from the member's own session first, then approves the card as Approve does, never
// with the switch on the decision. On `MockDeskLink` with `?agentFixture=tools`, whose agent mock sends what a desk sends
// (`unasked`, `changeUnasked`, `ask`). Light, Zen and Dark with axe, a 390 px phone, and the owner's colour rule.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

type Client = Record<string, (...a: unknown[]) => unknown>;
interface MockControl {
  rpc: { m: string; p: Record<string, unknown> }[];
  refuse: Record<string, string>;
  agent: { desks: Record<string, { client: Client }> };
}
type W = { __maDeskMock: MockControl };

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const lastReply = (page: Page): Locator => agentWindow(page).getByTestId('msg-agent').last();
const card = (page: Page): Locator => agentWindow(page).getByTestId('approval').last();

/** One of the agent mock's hooks, awaited. */
async function mock<T = unknown>(page: Page, hook: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([name, list]) => {
      const client = Object.values((window as unknown as W).__maDeskMock.agent.desks)[0]!.client;
      return (await client[name as string]!(...(list as unknown[]))) as unknown;
    },
    [hook, args] as const,
  ) as Promise<T>;
}

const rpcs = (page: Page, method: string): Promise<Record<string, unknown>[]> =>
  page.evaluate((m) => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === m).map((r) => r.p), method);
const rpcOrder = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as W).__maDeskMock.rpc.map((r) => r.m).filter((m) => m.startsWith('agent.')));

const NOTE = (pageId: string, title: string) => ({ tool: 'notebook_write', payload: { op: 'append', pageId, markdown: 'A line.' }, target: { kind: 'page', pageId, title }, group: 'notebook' });
const FILE = (path: string, more: Record<string, unknown> = {}) => ({ tool: 'files_write', payload: { path, text: 'Notes.', replace: false }, target: { kind: 'file', path }, group: 'files', place: { folder: 'Research' }, ...more });

async function openAgent(page: Page, agentId = 'writer', theme?: ThemeId): Promise<void> {
  if (theme) await setTheme(page, theme);
  await signIn(page, '/?fixture=one&speed=fast&agentFixture=tools');
  await canvasPainted(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
  await pick(page, agentId);
}

async function pick(page: Page, agentId: string): Promise<void> {
  const row = page.getByTestId(`agent-${agentId}`);
  const toggle = page.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => (await row.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await row.isVisible())) await toggle.click();
  await row.click();
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

/**
 * The owner's colour rule (Nov 12): no green, brown or warm tints. Every colour drawn here (text, fills, borders, outlines)
 * that carries any colour at all is a blue to violet one, or a grey.
 */
async function tints(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const out: string[] = [];
    const hueOf = (c: string): { h: number; s: number } | null => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
      if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
      const [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0 };
      const s = d / (1 - Math.abs(2 * l - 1));
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return { h, s };
    };
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const cs = getComputedStyle(node);
      for (const prop of ['color', 'background-color', 'border-top-color', 'outline-color']) {
        const value = cs.getPropertyValue(prop);
        const hs = hueOf(value);
        if (hs && hs.s > 0.18 && !(hs.h >= 190 && hs.h <= 290)) out.push(`${node.tagName.toLowerCase()}.${(node as HTMLElement).className} ${prop} ${value}`);
      }
    }
    return [...new Set(out)];
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: chips, the line, Undo, Undo all with one kept, and See them, clean and calm`, async ({ page }) => {
    const errors = watchConsole(page);
    await openAgent(page, 'writer', theme);
    // The member changed the file since: its undo is refused `changed`, and it stays.
    await mock(page, 'unasked', 'writer', [NOTE('p-lamps', 'Lamps'), NOTE('p-desks', 'Desks'), FILE('Research/notes.md', { undo: { reason: 'changed' } })], { text: 'I kept notes on lamps and desks.' });

    const reply = lastReply(page);
    await expect(reply).toContainText('I kept notes on lamps and desks.');
    // Never a card for a call done without asking; a chip each, and one line.
    await expect(reply.getByTestId('approval')).toHaveCount(0);
    const chips = reply.getByTestId('auto-chip');
    await expect(chips).toHaveCount(3);
    await expect(reply.getByTestId('tool-chip').nth(0)).toContainText('Added to a page“Lamps”');
    await expect(chips.nth(0)).toHaveText('Done without asking · Undo');
    await expect(reply.getByTestId('auto-chip-undo').nth(2)).toHaveAccessibleName('Undo: Saved a file, Research/notes.md');
    const line = reply.getByTestId('auto-line-text');
    await expect(line).toHaveText('Did 3 things without asking: 2 notes and a file in Research');
    await expect(reply.getByTestId('auto-undo-all')).toHaveText('Undo all');
    await expect(reply.getByTestId('auto-see')).toHaveAttribute('aria-expanded', 'false');
    // The run summary doesn't count them a second time.
    await expect(reply.getByTestId('run-summary')).toHaveText('This task: 3 tools');
    expect(await axe(page)).toEqual([]);
    expect(await tints(reply)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-auto-${theme}-line.png` });

    // Undo from a chip, by the keyboard: the chip says so, the line counts one fewer, and the reply says what happened.
    await reply.getByTestId('auto-chip-undo').nth(0).focus();
    await page.keyboard.press('Enter');
    await expect(reply.getByTestId('tool-chip').nth(0).getByTestId('auto-chip-state')).toHaveText('Undone');
    await expect(reply.getByTestId('auto-said')).toHaveText('“Lamps”: Undone. What it added is gone from the page.');
    await expect(line).toHaveText('Did 2 things without asking: a note and a file in Research');
    // The keyboard stays on the chip, never dropped on the page.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('auto-chip-state');

    // Undo all: one call per row still there; the file is kept, and the list opens to say why.
    await reply.getByTestId('auto-undo-all').click();
    await expect(reply.getByTestId('auto-said')).toHaveText('Undid 1 of 2. Research/notes.md: It’s been changed since, so it stays.');
    await expect(line).toHaveText('Did 1 thing without asking: a file in Research');
    await expect(reply.getByTestId('auto-undo-all')).toHaveCount(0);
    await expect(reply.getByTestId('auto-see')).toHaveAttribute('aria-expanded', 'true');
    const rows = reply.getByTestId('auto-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByTestId('auto-row-state')).toHaveText('Undone');
    await expect(rows.nth(1).getByTestId('auto-row-state')).toHaveText('Undone');
    await expect(rows.nth(2).getByTestId('auto-row-state')).toHaveText('Kept');
    await expect(rows.nth(2).getByTestId('auto-row-said')).toHaveText('It’s been changed since, so it stays.');
    await expect(reply.getByTestId('tool-chip').nth(2).getByTestId('auto-chip-state')).toHaveText('Kept');
    const undos = await rpcs(page, 'agent.approval.undo');
    expect(undos).toHaveLength(3);
    for (const p of undos) expect(Object.keys(p)).toEqual(['approvalId']);
    // See them hides the list again.
    await reply.getByTestId('auto-see').click();
    await expect(reply.getByTestId('auto-rows')).toBeHidden();
    await reply.getByTestId('auto-see').click();
    expect(await axe(page)).toEqual([]);
    expect(await tints(reply)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-auto-${theme}-undone.png` });
    expect(errors).toEqual([]);
  });

  test(`${theme}: Don't ask again turns the switch on first, then approves the card as Approve does`, async ({ page }) => {
    const errors = watchConsole(page);
    await openAgent(page, 'writer', theme);
    await mock(page, 'ask', 'writer', 'saveNotes', 'I’d like to keep my notes on the lamps in Research.');
    const c = card(page);
    await expect(c.getByTestId('approval-title')).toHaveText('Save “Research/lamp-notes.md” in your Files');
    const offer = c.getByTestId('approval-dont-ask-btn');
    await expect(offer).toHaveText('Save new files in Research without asking');
    await expect(offer).toHaveAccessibleDescription('It approves this one too. You can turn it off in Writer’s settings.');
    await expect(c.getByTestId('approval-approve')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await tints(c)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-auto-${theme}-dont-ask.png` });

    // As Approve: a press within 500 ms of the offer appearing, which moves the card's buttons, does nothing.
    await offer.click();
    expect(await rpcs(page, 'agent.access.set')).toEqual([]);
    await expect(c).toHaveAttribute('data-state', 'pending');
    await page.waitForTimeout(600);
    await offer.click();
    await expect(c.getByTestId('approval-state')).toContainText('Approved by you');
    // The switch went on by the member's own call, with only that switch, and only then the usual yes, with no switch on it.
    expect(await rpcs(page, 'agent.access.set')).toEqual([{ agentId: 'writer', auto: { files: { folder: 'Research' } } }]);
    const decides = await rpcs(page, 'agent.approval.decide');
    expect(decides).toHaveLength(1);
    expect(Object.keys(decides[0]!).sort()).toEqual(['approvalId', 'approve', 'sha256']);
    expect(decides[0]!['approve']).toBe(true);
    const order = await rpcOrder(page);
    expect(order.indexOf('agent.access.set')).toBeLessThan(order.indexOf('agent.approval.decide'));

    // From now on that agent saves new notes there without asking: a chip and the line, no card.
    await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 10_000 });
    await expect(lastReply(page)).toContainText('Saved. Your lamp notes are in Research.');
    await page.getByTestId('composer-input').fill('Keep notes on desks too');
    await page.keyboard.press('Enter');
    await expect(lastReply(page).getByTestId('auto-line-text')).toHaveText('Did 1 thing without asking: a file in Research', { timeout: 10_000 });
    await expect(lastReply(page).getByTestId('approval')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('a switch that doesn’t go on leaves the card waiting, and nothing is approved', async ({ page }) => {
  await openAgent(page);
  await mock(page, 'ask', 'writer', 'saveNotes');
  await page.evaluate(() => {
    (window as unknown as W).__maDeskMock.refuse['agent.access.set'] = 'unavailable';
  });
  const c = card(page);
  await expect(c.getByTestId('approval-dont-ask-btn')).toBeVisible();
  await page.waitForTimeout(600);
  await c.getByTestId('approval-dont-ask-btn').click();
  await expect(c.getByTestId('approval-error')).toHaveText('That setting couldn’t be turned on just now, so this still waits for your answer.');
  await expect(c).toHaveAttribute('data-state', 'pending');
  await expect(c.getByTestId('approval-approve')).toBeEnabled();
  await expect(c.getByTestId('approval-dont-ask-btn')).toHaveText('Save new files in Research without asking');
  expect(await rpcs(page, 'agent.approval.decide')).toEqual([]);
  // Approve still works by itself, with no switch.
  await page.evaluate(() => {
    delete (window as unknown as W).__maDeskMock.refuse['agent.access.set'];
  });
  await c.getByTestId('approval-approve').click();
  await expect(c.getByTestId('approval-state')).toContainText('Approved by you');
  expect((await rpcs(page, 'agent.access.set')).length).toBe(1);
});

test('no offer outside the class: after untrusted content, a replace, a file at the top, a Send, or a switch already on', async ({ page }) => {
  await openAgent(page);
  const offers = (): Locator => agentWindow(page).getByTestId('approval-dont-ask-btn');
  const answer = async (): Promise<void> => {
    await expect(card(page)).toHaveAttribute('data-state', 'pending');
    await expect(card(page).getByTestId('approval-approve')).toBeVisible();
    await expect(offers()).toHaveCount(0);
    await card(page).getByTestId('approval-decline').click();
    await expect(card(page).getByTestId('approval-state')).toContainText('Declined by you');
    await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 10_000 });
  };
  await mock(page, 'ask', 'writer', 'saveNotes', 'Untrusted.', { untrusted: true });
  await answer();
  await mock(page, 'ask', 'writer', 'saveNotes', 'A replace.', { payload: { path: 'Research/lamp-notes.md', text: 'x', replace: true } });
  await answer();
  await mock(page, 'ask', 'writer', 'saveNotes', 'At the top.', { payload: { path: 'lamp-notes.md', text: 'x', replace: false } });
  await answer();
  await mock(page, 'ask', 'writer', 'shop', 'A Send.');
  await answer();
  // The same card in the class is offered while the switch is off; once it's on, for another folder, it isn't.
  await mock(page, 'ask', 'writer', 'saveNotes', 'In the class.');
  await expect(offers()).toHaveText('Save new files in Research without asking');
  await card(page).getByTestId('approval-decline').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 10_000 });
  await page.evaluate(async () => {
    const client = Object.values((window as unknown as W).__maDeskMock.agent.desks)[0]!.client;
    await client['setAccess']!('writer', { auto: { files: { folder: 'Trips' } } }, { idem: 'test-access-1' });
  });
  const reads = (await rpcs(page, 'agent.access.get')).length;
  await mock(page, 'ask', 'writer', 'saveNotes', 'Switch on elsewhere.');
  // The card's agent's switches are read afresh for it before it's judged.
  await expect.poll(async () => (await rpcs(page, 'agent.access.get')).length).toBeGreaterThan(reads);
  await answer();
  expect(await rpcs(page, 'agent.access.set')).toEqual([]);
});

test('a Notebook card names its tab by its title, and the line names it too', async ({ page }) => {
  await openAgent(page);
  // Make a tab the agent's way: settings, its Notebook switch on a new tab named after it, saved; then off again.
  await page.getByTestId('tab-settings').click();
  const section = page.getByTestId('settings-access');
  await section.getByTestId('access-auto-notebook').getByRole('switch').click({ force: true });
  await section.getByTestId('access-save').click();
  await expect(section.getByText('Saved', { exact: true })).toBeVisible();
  const made = (await rpcs(page, 'agent.access.set'))[0]!['auto'] as { notebook: { tabId: string } };
  const tabId = made.notebook.tabId;
  expect(tabId).toBeTruthy();
  await section.getByTestId('access-auto-notebook').getByRole('switch').click({ force: true });
  await section.getByTestId('access-save').click();
  await expect(section.getByTestId('access-save')).toBeDisabled();
  await page.getByRole('button', { name: 'Close panel' }).click();

  // Its line names the tab it knows; a tab it can't name isn't named.
  await mock(page, 'unasked', 'writer', [
    { tool: 'notebook_write', payload: { op: 'create', new: { tabId, title: 'Lamps' }, markdown: 'x' }, target: { kind: 'page', pageId: null, title: 'Lamps' }, group: 'notebook', place: { tabId } },
    { tool: 'notebook_write', payload: { op: 'create', new: { tabId, title: 'Desks' }, markdown: 'x' }, target: { kind: 'page', pageId: null, title: 'Desks' }, group: 'notebook', place: { tabId } },
  ]);
  await expect(lastReply(page).getByTestId('auto-line-text')).toHaveText('Did 2 things without asking: 2 new pages in Writer');
  await expect(lastReply(page).getByTestId('auto-undo-all')).toHaveText('Undo all');

  // An append to a page in a tab the office doesn't list: no name, so no offer, never an id on a button.
  const reads = (await rpcs(page, 'agent.access.get')).length;
  await mock(page, 'ask', 'writer', 'newPage', 'Add to it?', { payload: { op: 'append', pageId: 'p-x', markdown: 'x' }, target: { kind: 'page', pageId: 'p-x', title: 'Elsewhere', tabId: 'tab-unknown' } });
  await expect(card(page).getByTestId('approval-approve')).toBeVisible();
  await expect.poll(async () => (await rpcs(page, 'agent.access.get')).length).toBeGreaterThan(reads);
  await expect(card(page).getByTestId('approval-dont-ask-btn')).toHaveCount(0);
  await expect(card(page)).not.toContainText('tab-unknown');
  await card(page).getByTestId('approval-decline').click();
  await expect(page.getByTestId('composer-input')).toBeEnabled({ timeout: 10_000 });

  // A new page in the tab it knows: offered by the tab's title, and the switch goes on with the tab's id.
  await mock(page, 'ask', 'writer', 'newPage', 'A page for the notes?', { payload: { op: 'create', new: { tabId, title: 'Lamp notes' }, markdown: '# Lamp notes' } });
  const offer = card(page).getByTestId('approval-dont-ask-btn');
  await expect(offer).toHaveText('Add pages and notes in Writer without asking');
  await page.waitForTimeout(600);
  await offer.click();
  await expect(card(page).getByTestId('approval-state')).toContainText('Approved by you');
  expect((await rpcs(page, 'agent.access.set')).at(-1)).toEqual({ agentId: 'writer', auto: { notebook: { tabId } } });
});

test('a run the member didn’t start counts in the rail until its thread is seen', async ({ page }) => {
  await openAgent(page, 'writer');
  await mock(page, 'unasked', 'manager', [FILE('Research/brief.md'), FILE('Research/brief-2.md')], { origin: { kind: 'timer', timerId: 't-1', label: 'Evening brief' } });
  const count = page.getByTestId('agent-manager').getByTestId('agent-count');
  await expect(count).toHaveText('3');
  await expect(count).toHaveAttribute('aria-label', '1 new reply, 2 done without asking');
  await pick(page, 'manager');
  await expect(lastReply(page).getByTestId('auto-line-text')).toHaveText('Did 2 things without asking: 2 files in Research');
  await expect(page.getByTestId('agent-manager').getByTestId('agent-count')).toHaveCount(0);
  await pick(page, 'writer');
  await expect(page.getByTestId('agent-manager').getByTestId('agent-count')).toHaveCount(0);
});

test('on a 390 px phone the chips, the line, the list and the offer wrap inside the thread with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAgent(page);
  await mock(page, 'unasked', 'writer', [NOTE('p-lamps', 'Lamps with a much longer title than fits on a phone'), FILE('Research/a-long-folder-name/notes-about-every-lamp.md', { place: { folder: 'Research/a-long-folder-name' } })]);
  const reply = lastReply(page);
  await expect(reply.getByTestId('auto-line-text')).toHaveText('Did 2 things without asking: a note and a file in Research/a-long-folder-name');
  await reply.getByTestId('auto-see').click();
  await expect(reply.getByTestId('auto-rows')).toBeVisible();
  for (const el of [reply.getByTestId('auto-line'), reply.getByTestId('tool-chips'), reply.getByTestId('auto-rows')]) {
    const box = await el.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, (await el.getAttribute('data-testid')) ?? '').toBeLessThanOrEqual(390);
  }
  // Every Undo is a whole target, 24 px at least.
  for (const b of await reply.locator('button').all()) {
    const box = await b.boundingBox();
    if (box) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
  }
  await mock(page, 'ask', 'writer', 'saveNotes');
  const offer = card(page).getByTestId('approval-dont-ask-btn');
  await offer.scrollIntoViewIfNeeded();
  const ob = await offer.boundingBox();
  expect(ob!.x + ob!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: 'test-results/shots/agent-auto-phone.png' });
});
