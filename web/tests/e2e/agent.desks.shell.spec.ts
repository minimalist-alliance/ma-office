// Messages between the member's own desks (W6; draft ADR "the Agent's tools and approvals", section 14; deskd API.md section 18,
// "Messages between the member's desks"), on `MockDeskLink`'s desks, which serve `agent.desks.*` and `agent.desks.outbox` as the
// contract says (`mockDeskAgent.ts`), so the office's real carrier (`desk/deskCarrier.ts`) carries every envelope here, and the
// real `RpcAgentClient` and the Agent app run as on a desk. The office is `?fixture=three`: Personal (A), Work (B) and a Guild
// Desk, which is never offered or carried. Pairing end to end, a message and its answer, the calm wait, Not now, Stop on B and
// its notice on A, the two cards, axe in Light, Zen and Dark, and a 390 px phone.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const LEAD = 'manager';
const TEXT = 'What did the landlord say about Tuesday?';

interface Hop {
  desk: string;
  m: string;
  at: number;
  ids?: string[];
  outcome?: string;
  refused?: string;
}
interface MockControl {
  hold: Record<string, boolean>;
  releaseHeld(): void;
  agent: {
    desksLog: Hop[];
    desks: Record<string, { client: { deskMessage(agentId: string, desk: string, text: string, opts?: { wait?: boolean; waitMs?: number }): string; ask(agentId: string, name: string, text?: string): void } }>;
  };
}
type W = { __maDeskMock: MockControl };

const shown = (page: Page): Locator => page.locator('.ma-window:not(.parked)');
const hops = (page: Page): Promise<Hop[]> => page.evaluate(() => (window as unknown as W).__maDeskMock.agent.desksLog);
/** An agent on a desk calls `desk_message`, as its run would: the envelope's id. */
const deskMessage = (page: Page, deskId: string, agentId: string, to: string, text: string, opts: { wait?: boolean; waitMs?: number } = {}): Promise<string> =>
  page.evaluate(([d, a, t, x, o]) => (window as unknown as W).__maDeskMock.agent.desks[d as string]!.client.deskMessage(a as string, t as string, x as string, o as never), [deskId, agentId, to, text, opts] as const);

async function arrive(page: Page): Promise<void> {
  await signIn(page, '/?fixture=three&speed=fast&agentFixture=ready');
  await canvasPainted(page);
}

/** That desk on screen, with its Agent window open and filling it: the window's locator. */
async function agentOn(page: Page, desk: 'Personal' | 'Work' | 'Guild'): Promise<Locator> {
  await page.getByRole('button', { name: new RegExp(`^${desk} desk`) }).evaluate((el) => (el as HTMLButtonElement).click());
  await page.getByRole('group', { name: `${desk} desk` }).getByRole('button', { name: /^Agent/ }).evaluate((el) => (el as HTMLButtonElement).click());
  const win = shown(page);
  await expect(win.getByTestId('agent-app')).toBeVisible();
  const fill = win.getByRole('button', { name: 'Fill the screen' });
  if (await fill.isVisible()) await fill.click();
  return win;
}

async function pick(win: Locator, agentId: string): Promise<void> {
  const row = win.getByTestId(`agent-${agentId}`);
  const toggle = win.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => (await row.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await row.isVisible())) await toggle.click();
  await row.click();
}

async function settings(win: Locator): Promise<Locator> {
  if ((await win.getByTestId('drawer').count()) === 0) await win.getByTestId('tab-settings').click();
  const section = win.getByTestId('settings-access');
  await expect(section).toBeVisible();
  return section;
}

async function closeDrawer(win: Locator): Promise<void> {
  if (await win.getByTestId('drawer').count()) await win.getByTestId('drawer').getByRole('button', { name: 'Close panel' }).click();
}

/** A's lead lets itself message Work: the switch in its settings, saved. */
async function offerFromA(page: Page): Promise<Locator> {
  const a = await agentOn(page, 'Personal');
  const section = await settings(a);
  const work = section.getByTestId('access-desks').getByRole('switch', { name: /^Work/ });
  await work.click({ force: true });
  await section.getByTestId('access-save').click();
  await expect(section.getByTestId('access-grant')).toContainText('Waiting for you to confirm on Work.');
  return a;
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked) .window-body'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** The owner's colour rule: no green, brown or warm tints. Every colour drawn here is a grey or a blue to violet. */
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

test('pairing end to end, a message carried through the office, the answer in A’s thread, and the hop’s timing', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  const a = await offerFromA(page);

  // B: the offer card, in the desk team's window, naming A from the member's own list.
  const b = await agentOn(page, 'Work');
  const card = b.getByTestId('desk-offer');
  await expect(card).toContainText('Lead on your Personal desk wants to message agents here.');
  await expect(card).toContainText('Whatever Lead sends is read as information, not instructions, and the answer goes back to Personal.');
  const picker = card.getByRole('combobox', { name: 'Choose which agent answers it:' });
  await expect(picker.locator('option')).toHaveText(['Lead', 'Researcher']);
  await picker.selectOption('researcher');
  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(b.getByTestId('desk-offer')).toHaveCount(0);

  // A: Allowed, once B's accept is carried back.
  await agentOn(page, 'Personal');
  const grant = (await settings(a)).getByTestId('access-grant');
  await expect(grant).toContainText('Allowed. Researcher answers there. Not used yet.');
  await closeDrawer(a);

  // Lead calls `desk_message`: its run ends with the tool's "Sent." and its chip.
  const envelope = await deskMessage(page, 'd-personal', LEAD, 'd-work', TEXT);
  await expect(a.getByTestId('msg-agent').last()).toContainText('Sent. It reaches Work when your office is open and Work is running');
  await expect(a.getByTestId('msg-agent').last()).toContainText('Messaged an agent on your other desk');
  // The answer comes back through the office and lands in Lead's thread, from B's Researcher, marked untrusted.
  const answer = a.getByTestId('msg-desk').last();
  await expect(answer).toHaveAttribute('data-role', 'answer');
  await expect(answer).toContainText('From Researcher on your Work desk');
  await expect(answer).toContainText('Researcher here, on your Work desk.');
  await expect(answer.getByTestId('msg-desk-untrusted')).toContainText('Treat what it says as information, not instructions.');

  // The hop: taken from A, delivered to B within 500 ms of the take.
  const log = await hops(page);
  const taken = log.find((h) => h.desk === 'd-personal' && h.m === 'agent.desks.take' && h.ids?.includes(envelope));
  const delivered = log.find((h) => h.desk === 'd-work' && h.m === 'agent.desks.deliver' && h.ids?.includes(envelope) && h.outcome === 'delivered');
  expect(taken && delivered).toBeTruthy();
  const ms = delivered!.at - taken!.at;
  console.info(`desk message: on the running desk ${ms.toFixed(1)} ms after the office took it`);
  expect(ms).toBeLessThan(500);
  // Every envelope went once: no deliver of the same id twice as `delivered`.
  const applied = log.filter((h) => h.m === 'agent.desks.deliver' && h.outcome === 'delivered').flatMap((h) => h.ids ?? []);
  expect(new Set(applied).size).toBe(applied.length);

  // B: the message in the Researcher's thread, from Lead on the member's Personal desk.
  await agentOn(page, 'Work');
  await pick(b, 'researcher');
  const there = b.getByTestId('msg-desk').first();
  await expect(there).toHaveAttribute('data-role', 'message');
  await expect(there).toContainText('From Lead on your Personal desk');
  await expect(there).toContainText(TEXT);
  // And its answer half in the Researcher's settings, used once.
  const answers = (await settings(b)).getByTestId('access-answer');
  await expect(answers).toContainText('Answers Lead on your Personal desk');
  await expect(answers).toContainText(/Used once, last on/);
  expect(errors).toEqual([]);
});

test('a run waiting for its other desk is calm, and the answer is its result', async ({ page }) => {
  await arrive(page);
  await offerFromA(page);
  const b = await agentOn(page, 'Work');
  await b.getByTestId('desk-offer').getByRole('button', { name: 'Allow' }).click();
  await expect(b.getByTestId('desk-offer')).toHaveCount(0);
  const a = await agentOn(page, 'Personal');
  await expect((await settings(a)).getByTestId('access-grant')).toContainText('Allowed.');
  await closeDrawer(a);
  // Hold the office's takes, so the wait shows; then let them go.
  await page.evaluate(() => ((window as unknown as W).__maDeskMock.hold['agent.desks.take'] = true));
  await deskMessage(page, 'd-personal', LEAD, 'Work', 'Is the Tuesday meeting still on?', { wait: true, waitMs: 60_000 });
  const waiting = a.getByTestId('waiting-desk');
  await expect(waiting).toHaveText('Waiting for your other desk');
  await expect(a.locator('.ag-head')).toContainText('waiting for your other desk');
  expect(await tints(waiting)).toEqual([]);
  await page.screenshot({ path: 'test-results/shots/agent-desks-light-waiting.png' });
  await page.evaluate(() => {
    const c = (window as unknown as W).__maDeskMock;
    c.hold['agent.desks.take'] = false;
    c.releaseHeld();
  });
  await expect(waiting).toHaveCount(0);
  await expect(a.getByTestId('msg-agent').last()).toContainText('Lead on your Work desk answered: Lead here, on your Work desk.');
  await expect(a.getByTestId('msg-desk')).toHaveCount(0);
});

test('a new agent’s setup screen: the offer waits there too, and Allow there makes the new agent the one that answers', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  const a = await offerFromA(page);
  const b = await agentOn(page, 'Work');
  await expect(b.getByTestId('desk-offer')).toBeVisible();
  await b.getByTestId('new-agent').click();
  await b.getByTestId('new-agent-name').fill('Scout');
  await b.getByTestId('new-agent-submit').click();
  const screen = b.getByTestId('setup-screen');
  await expect(screen.getByRole('heading', { name: 'What can Scout use?' })).toBeVisible();
  // The screen lists it itself, so the window's card steps aside.
  await expect(b.getByTestId('desk-offer')).toHaveCount(0);
  const section = screen.getByTestId('access-answers');
  await expect(screen.getByRole('group', { name: 'Answers your other desks' })).toBeVisible();
  const offer = section.getByTestId('access-offer');
  await expect(offer).toContainText('Lead on your Personal desk wants to message agents here.');
  await expect(offer).toContainText('Whatever Lead sends is read as information, not instructions, and the answer goes back to Personal.');
  expect(await axe(page)).toEqual([]);
  expect(await tints(section)).toEqual([]);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/shots/agent-desks-light-setup.png' });
  await offer.getByRole('button', { name: /^Allow/ }).click();
  await expect(section.getByTestId('access-answer')).toContainText('Answers Lead on your Personal desk');
  await expect(section.getByTestId('access-offer')).toHaveCount(0);
  await screen.getByTestId('access-save').click();
  await expect(screen).toHaveCount(0);
  await agentOn(page, 'Personal');
  await expect((await settings(a)).getByTestId('access-grant')).toContainText('Allowed. Scout answers there.');
  expect(errors).toEqual([]);
});

test('Not now: the offer is put away, nothing goes back, and it waits in the settings to be allowed later', async ({ page }) => {
  await arrive(page);
  const a = await offerFromA(page);
  const b = await agentOn(page, 'Work');
  await b.getByTestId('desk-offer').getByRole('button', { name: 'Not now' }).click();
  await expect(b.getByTestId('desk-offer')).toHaveCount(0);
  const offer = (await settings(b)).getByTestId('access-offer');
  await expect(offer).toHaveAttribute('data-state', 'declined');
  await expect(offer).toContainText('You chose Not now. Nothing has been sent.');
  expect((await hops(page)).filter((h) => h.desk === 'd-personal' && h.m === 'agent.desks.deliver')).toEqual([]);
  await agentOn(page, 'Personal');
  await expect((await settings(a)).getByTestId('access-grant')).toContainText('Waiting for you to confirm on Work.');
  // Allowed after all, from the lead's settings on B: the lead answers.
  await agentOn(page, 'Work');
  await offer.getByRole('button', { name: /^Allow/ }).click();
  await expect((await settings(b)).getByTestId('access-answer')).toContainText('Answers Lead on your Personal desk');
  await agentOn(page, 'Personal');
  await expect((await settings(a)).getByTestId('access-grant')).toContainText('Allowed. Lead answers there.');
});

test('Stop on B refuses the very next message, A’s thread says so, and A’s half goes', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  const a = await offerFromA(page);
  const b = await agentOn(page, 'Work');
  await b.getByTestId('desk-offer').getByRole('button', { name: 'Allow' }).click();
  await agentOn(page, 'Personal');
  await expect((await settings(a)).getByTestId('access-grant')).toContainText('Allowed.');
  await closeDrawer(a);

  // A message is on its way when the member stops the grant on B: the office holds its takes until both have happened.
  await page.evaluate(() => ((window as unknown as W).__maDeskMock.hold['agent.desks.take'] = true));
  await deskMessage(page, 'd-personal', LEAD, 'd-work', 'Sent just before the stop');
  await agentOn(page, 'Work');
  const answers = (await settings(b)).getByTestId('access-answer');
  await expect(answers).toContainText('Answers Lead on your Personal desk');
  await answers.getByRole('button', { name: 'Stop' }).click();
  await expect(b.getByTestId('access-answer')).toHaveCount(0);
  await page.evaluate(() => {
    const c = (window as unknown as W).__maDeskMock;
    c.hold['agent.desks.take'] = false;
    c.releaseHeld();
  });

  await agentOn(page, 'Personal');
  const notice = a.getByTestId('msg-desk-notice').last();
  await expect(notice).toHaveAttribute('data-notice', 'refused');
  await expect(notice).toHaveText(/Not delivered: your Work desk didn’t take it\. You stopped these messages there\./);
  expect(await tints(notice)).toEqual([]);
  expect(await axe(page)).toEqual([]);
  const log = await hops(page);
  expect(log.some((h) => h.desk === 'd-work' && h.m === 'agent.desks.deliver' && h.refused === 'revoked')).toBe(true);
  // B's `revoke` reached A: its half is gone, its switch off.
  const section = await settings(a);
  await expect(section.getByTestId('access-grant')).toHaveCount(0);
  await expect(section.getByTestId('access-desks').getByRole('switch', { name: /^Work/ })).not.toBeChecked();
  await closeDrawer(a);
  await notice.scrollIntoViewIfNeeded();
  // In the thread's flow, under the reply that sent it: nothing of the office's own styles lands on it.
  const sentBox = (await a.getByTestId('msg-agent').last().boundingBox())!;
  const noticeBox = (await notice.boundingBox())!;
  expect(noticeBox.y).toBeGreaterThanOrEqual(sentBox.y + sentBox.height - 1);
  expect(await notice.evaluate((el) => getComputedStyle(el).position)).toBe('static');
  await page.screenshot({ path: 'test-results/shots/agent-desks-light-notice.png' });
  expect(errors).toEqual([]);
});

test('a Guild Desk is never offered or carried', async ({ page }) => {
  await arrive(page);
  const a = await offerFromA(page);
  // Personal's "Other desks" lists Work alone.
  await expect((await settings(a)).getByTestId('access-desks').getByRole('switch')).toHaveCount(1);
  const b = await agentOn(page, 'Work');
  await b.getByTestId('desk-offer').getByRole('button', { name: 'Allow' }).click();
  await expect(b.getByTestId('desk-offer')).toHaveCount(0);
  // Work's lists Personal alone.
  await expect((await settings(b)).getByTestId('access-desks').getByRole('switch')).toHaveCount(1);
  await expect((await settings(b)).getByTestId('access-desks')).toContainText('Personal');
  await deskMessage(page, 'd-personal', LEAD, 'd-work', TEXT);
  await agentOn(page, 'Personal');
  await expect(a.getByTestId('msg-desk').last()).toHaveAttribute('data-role', 'answer');
  // The office never subscribed to the Guild Desk's outbox, nor took from it or delivered to it.
  const log = await hops(page);
  expect(log.filter((h) => h.desk === 'd-guild')).toEqual([]);
  expect(new Set(log.filter((h) => h.m === 'sub agent.desks.outbox').map((h) => h.desk))).toEqual(new Set(['d-personal', 'd-work']));
  // Its own Agent window shows no offer, and has no other desks to offer.
  const g = await agentOn(page, 'Guild');
  await expect(g.getByTestId('desk-offer')).toHaveCount(0);
});

test('the cards: desk_message on A and desk_answer on B, the contract’s words and the exact text', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page);
  const a = await agentOn(page, 'Personal');
  await page.evaluate((agent) => (window as unknown as W).__maDeskMock.agent.desks['d-personal']!.client.ask(agent, 'deskMessage'), LEAD);
  const asks = a.getByTestId('approval').last();
  await expect(asks.getByRole('heading', { name: 'Send this to Researcher on your Work desk?' })).toBeVisible();
  await expect(asks).toContainText('It may include things Lead read on this desk.');
  await expect(asks).toContainText('What did the landlord say about Tuesday? My notes here say the plumber comes at 9.');
  await expect(asks).toContainText('Sends outside your desk');
  expect(await axe(page)).toEqual([]);
  expect(await tints(asks.locator('.ag-approval-rows'))).toEqual([]);

  const b = await agentOn(page, 'Work');
  await pick(b, 'researcher');
  await page.evaluate(() => (window as unknown as W).__maDeskMock.agent.desks['d-work']!.client.ask('researcher', 'deskAnswer'));
  const answers = b.getByTestId('approval').last();
  await expect(answers.getByRole('heading', { name: 'Send this answer to Lead on your Personal desk?' })).toBeVisible();
  await expect(answers).toContainText('It includes things Researcher read here.');
  await expect(answers).toContainText('The landlord said Tuesday at 9 works, and to leave the side gate open.');
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

for (const theme of THEMES) {
  test(`${theme}: the offer card, the thread's rows and the settings, clean and calm, with axe`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await arrive(page);
    await offerFromA(page);
    const b = await agentOn(page, 'Work');
    const card = b.getByTestId('desk-offer');
    await expect(card).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await tints(card)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-desks-${theme}-offer.png` });
    await card.getByRole('button', { name: 'Allow' }).click();
    await expect(card).toHaveCount(0);

    const a = await agentOn(page, 'Personal');
    await expect((await settings(a)).getByTestId('access-grant')).toContainText('Allowed.');
    expect(await axe(page)).toEqual([]);
    await closeDrawer(a);
    await deskMessage(page, 'd-personal', LEAD, 'd-work', TEXT);
    const answer = a.getByTestId('msg-desk').last();
    await expect(answer).toHaveAttribute('data-role', 'answer');
    expect(await axe(page)).toEqual([]);
    expect(await tints(answer)).toEqual([]);
    await page.screenshot({ path: `test-results/shots/agent-desks-${theme}-answer.png` });

    await agentOn(page, 'Work');
    const answers = (await settings(b)).getByTestId('access-answers');
    await expect(answers).toContainText('Answers Lead on your Personal desk');
    expect(await axe(page)).toEqual([]);
    expect(await tints(answers)).toEqual([]);
    await answers.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/shots/agent-desks-${theme}-settings.png` });
    expect(errors).toEqual([]);
  });
}

test.describe('on a phone, 390 px', () => {
  test('the offer card fits, with nothing beside it, and Allow and the thread work', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await arrive(page);
    await offerFromA(page);
    const b = await agentOn(page, 'Work');
    const card = b.getByTestId('desk-offer');
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const box = await card.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.screenshot({ path: 'test-results/shots/agent-desks-phone-offer.png' });
    await card.getByRole('button', { name: 'Allow' }).click();
    await expect(card).toHaveCount(0);
    const a = await agentOn(page, 'Personal');
    await expect((await settings(a)).getByTestId('access-grant')).toContainText('Allowed.');
    await closeDrawer(a);
    await deskMessage(page, 'd-personal', LEAD, 'd-work', TEXT);
    await expect(a.getByTestId('msg-desk').last()).toContainText('From Lead on your Work desk');
    expect(await axe(page)).toEqual([]);
  });
});
