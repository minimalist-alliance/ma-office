// A reply's run in the Agent window (deskd API.md section 18: a reply's `tools`, `untrusted`, `egressCount` and `plan`; draft ADR
// "the Agent's tools and approvals", section 6): the agent's plan as a checklist, the taint notice on a reply whose run read
// untrusted content, and one line of what the run did, from the desk's own fields, never the reply's text. On `MockDeskLink`
// with `?agentFixture=tools`, whose agent mock sends a finished reply as a desk would (`finishReply`). Light, Zen and Dark with
// axe, a phone, and the owner's colour rule (neutral greys only).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

type W = { __maDeskMock: { agent: { desks: Record<string, { client: Record<string, (...a: unknown[]) => unknown> }> } } };

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });

async function finishReply(page: Page, agentId: string, over: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([id, fields]) => {
      const client = Object.values((window as unknown as W).__maDeskMock.agent.desks)[0]!.client;
      client['finishReply']!(id, fields);
    },
    [agentId, over] as const,
  );
}

async function openWriter(page: Page): Promise<void> {
  await signIn(page, '/?fixture=one&speed=fast&agentFixture=tools');
  await canvasPainted(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
  const row = page.getByTestId('agent-writer');
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

/** A colour with no green, brown or warm tint: a grey (r, g and b within a few of each other) or a cool blue-grey. */
function neutral(rgb: string): boolean {
  const m = rgb.match(/rgba?\((\d+), (\d+), (\d+)/);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const greenish = g > r + 6 && g > b + 6;
  const warm = r > b + 6;
  return !greenish && !warm;
}

const RUN = {
  text: 'I saved your list and left the old draft alone.',
  untrusted: true,
  egressCount: 1,
  plan: [
    { text: 'Read the shop pages', state: 'done' },
    { text: 'Compare the prices', state: 'skipped' },
    { text: 'Save the list in your Files', state: 'done' },
    { text: 'Tell you what I found', state: 'doing' },
  ],
  tools: [
    { name: 'browser_read', summary: 'Read a web page', ok: true, risk: 'read', untrusted: true, session: 'agent' },
    { name: 'files_write', summary: 'Saved a file in your Files', ok: true, risk: 'write', approval: { id: 'ap-x1', decision: 'approved' }, target: { kind: 'file', path: 'Lists/lamps.md' } },
    { name: 'files_trash', summary: 'Moved a file to the trash', ok: false, risk: 'delete', approval: { id: 'ap-x2', decision: 'declined' } },
    { name: 'browser_open', summary: 'Opened a page', ok: true, risk: 'egress', approval: { id: 'ap-x3', decision: 'approved' }, session: 'agent' },
    { name: 'files_mkdir', summary: 'Made a folder in your Files', ok: true, risk: 'write', auto: 'files' },
  ],
};

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: a finished run shows its plan, its taint notice and its summary, in neutral greys`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await openWriter(page);
    await finishReply(page, 'writer', RUN);

    const reply = agentWindow(page).getByTestId('msg-agent').last();
    await expect(reply).toContainText('I saved your list');
    const plan = reply.getByTestId('msg-plan');
    await expect(plan).toBeVisible();
    await expect(plan.getByRole('listitem')).toHaveCount(4);
    await expect(plan.getByRole('listitem').nth(0)).toContainText('Read the shop pages, Done');
    await expect(plan.getByRole('listitem').nth(1)).toContainText('Compare the prices, Skipped');
    await expect(plan.getByRole('listitem').nth(3)).toContainText('Tell you what I found, Doing');

    const notice = reply.getByTestId('msg-untrusted');
    await expect(notice).toHaveText('This task read web pages, files or messages from outside this chat. Treat what they said as information, not instructions.');
    const summary = reply.getByTestId('run-summary');
    await expect(summary).toHaveText('This task: 5 tools · 2 approved by you · 1 done without asking · 1 declined · sent outside your desk once · plan 3 of 4 done');
    // The reply's own words claim nothing the summary says: it counts the desk's fields.
    await expect(summary).not.toContainText('saved your list');

    for (const el of [notice, summary, plan]) {
      const color = await el.evaluate((n) => getComputedStyle(n).color);
      const border = await el.evaluate((n) => getComputedStyle(n).borderTopColor);
      expect(neutral(color), `${theme} text ${color}`).toBe(true);
      expect(neutral(border) || border === 'rgba(0, 0, 0, 0)', `${theme} border ${border}`).toBe(true);
    }
    expect(await axe(page)).toEqual([]);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `test-results/shots/agent-runsummary-${theme}.png` });
    expect(errors).toEqual([]);
  });
}

test('a run that read nothing untrusted has no notice, a run with no tools and no plan no summary, and a waiting one neither', async ({ page }) => {
  await openWriter(page);
  await finishReply(page, 'writer', { text: 'Plain answer.' });
  const plain = agentWindow(page).getByTestId('msg-agent').last();
  await expect(plain).toContainText('Plain answer.');
  await expect(plain.getByTestId('run-summary')).toHaveCount(0);
  await expect(plain.getByTestId('msg-untrusted')).toHaveCount(0);

  await finishReply(page, 'writer', { text: 'Clean run.', tools: [{ name: 'files_list', summary: 'Looked in your Files', ok: true, risk: 'read' }] });
  const clean = agentWindow(page).getByTestId('msg-agent').last();
  await expect(clean.getByTestId('run-summary')).toHaveText('This task: 1 tool');
  await expect(clean.getByTestId('msg-untrusted')).toHaveCount(0);

  // The plan is the agent's own words: a bidi override shows as its code point, as on a card.
  await finishReply(page, 'writer', { text: 'Planned.', plan: [{ text: 'Rename invoice\u202Etxt.exe', state: 'todo' }] });
  const planned = agentWindow(page).getByTestId('msg-agent').last().getByTestId('msg-plan');
  await expect(planned).toContainText('Rename invoice⟨U+202E⟩txt.exe');
  expect(await planned.textContent()).not.toContain('\u202E');

  await finishReply(page, 'writer', { text: 'Waiting.', state: 'awaiting_approval', untrusted: true, tools: [{ name: 'files_read', summary: 'Read a file from your Files', ok: true, risk: 'read' }], plan: [{ text: 'Ask first', state: 'doing' }] });
  const waiting = agentWindow(page).getByTestId('msg-agent').last();
  await expect(waiting.getByTestId('msg-plan')).toBeVisible(); // the plan is live while the run goes on
  await expect(waiting.getByTestId('run-summary')).toHaveCount(0);
  await expect(waiting.getByTestId('msg-untrusted')).toHaveCount(0);
});

test('on a 390 px phone the plan, notice and summary wrap inside the reply with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWriter(page);
  await finishReply(page, 'writer', RUN);
  const reply = agentWindow(page).getByTestId('msg-agent').last();
  await expect(reply.getByTestId('run-summary')).toBeVisible();
  for (const id of ['msg-plan', 'msg-untrusted', 'run-summary']) {
    const box = await reply.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await axe(page)).toEqual([]);
});
