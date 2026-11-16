// "Edited by {agent}" in the Notebook window (draft ADR "the Agent's tools and approvals" §2 and §15), on the mock desk
// (`desk/mockNotebook.ts`): an agent's append as the desk makes one reaches the open page, the page's foot says who and
// offers Undo, History names the version before it, and Undo takes it out. In all three themes, with axe.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface NotebookControl {
  flush(deskId: string): Promise<void>;
  pageText(deskId: string, pageId: string): Promise<string>;
  agentEdit(deskId: string, pageId: string, agentId: string, text: string): Promise<{ editId: string }>;
}
declare const __maDeskMock: { notebook: Promise<NotebookControl> };

const editor = (page: Page): Locator => page.getByTestId('note-editor');
const currentPage = (page: Page): Locator => page.locator('.nb-page-btn[aria-current="true"]');
const win = (page: Page): Locator => page.locator('[data-testid="window-notebook"]').filter({ hasNot: page.locator('.parked') }).first();

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked)'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
      rules: { 'empty-heading': { enabled: false } },
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test(`${theme}: an agent's edit shows who made it, History names the version before it, and Undo takes it out`, async ({ page }) => {
    const errors = watchConsole(page);
    await setTheme(page, theme);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
    await tile.evaluate((el) => (el as HTMLButtonElement).click());
    await expect(editor(page)).toBeVisible();
    await expect(currentPage(page)).toBeVisible();
    await editor(page).click();
    await page.keyboard.type('My own line');
    const deskId = (await win(page).getAttribute('data-desk')) as string;
    const pageId = (await currentPage(page).getAttribute('data-page-id')) as string;
    await expect.poll(() => page.evaluate(async ([d, p]) => (await __maDeskMock.notebook).pageText(d as string, p as string), [deskId, pageId])).toContain('My own line');
    await page.evaluate(async (d) => (await __maDeskMock.notebook).flush(d), deskId);

    // The desk's agent appends, as notebook_write does: the open page has it at once.
    await page.evaluate(async ([d, p]) => (await __maDeskMock.notebook).agentEdit(d as string, p as string, 'ag-notknown', 'Added by the agent'), [deskId, pageId]);
    await expect(editor(page)).toContainText('Added by the agent');
    const foot = page.getByTestId('agent-edit');
    await expect(foot).toContainText(/^Edited by an agent, Today/);
    await expect(foot.getByRole('button', { name: "Undo the agent's edit" })).toBeVisible();
    expect(await axe(page)).toEqual([]);

    // History names the version from before it, and can undo it there too.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const before = page.locator('.nb-history-item').filter({ hasText: 'Before an agent edit' });
    await expect(before).toHaveCount(1);
    await before.click();
    await expect(page.getByRole('button', { name: "Undo the agent's edit" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Back to the page' }).click();

    // Undo from the foot: the agent's paragraph goes, the member's stays, and the line goes with it.
    await foot.getByRole('button', { name: "Undo the agent's edit" }).click();
    await expect(editor(page)).not.toContainText('Added by the agent');
    await expect(editor(page)).toContainText('My own line');
    await expect(page.getByTestId('agent-edit')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

// The test desk's release check (Nov 13): two agent edits on one page, and the foot's Undo twice. Each takes back the newest
// still there, so the page goes back step by step to the member's own.
test('light: two agent edits on a page are undone newest first, one Undo each', async ({ page }) => {
  const errors = watchConsole(page);
  await setTheme(page, 'light');
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(editor(page)).toBeVisible();
  await expect(currentPage(page)).toBeVisible();
  await editor(page).click();
  await page.keyboard.type('My own line');
  const deskId = (await win(page).getAttribute('data-desk')) as string;
  const pageId = (await currentPage(page).getAttribute('data-page-id')) as string;
  await expect.poll(() => page.evaluate(async ([d, p]) => (await __maDeskMock.notebook).pageText(d as string, p as string), [deskId, pageId])).toContain('My own line');
  await page.evaluate(async (d) => (await __maDeskMock.notebook).flush(d), deskId);

  await page.evaluate(async ([d, p]) => (await __maDeskMock.notebook).agentEdit(d as string, p as string, 'ag-notknown', 'First by the agent'), [deskId, pageId]);
  await expect(editor(page)).toContainText('First by the agent');
  await page.evaluate(async ([d, p]) => (await __maDeskMock.notebook).agentEdit(d as string, p as string, 'ag-notknown', 'Second by the agent'), [deskId, pageId]);
  await expect(editor(page)).toContainText('Second by the agent');
  const foot = page.getByTestId('agent-edit');
  const undo = foot.getByRole('button', { name: "Undo the agent's edit" });

  // Undo once: the newer edit goes, the older stays, and the foot offers that one next.
  await undo.click();
  await expect(editor(page)).not.toContainText('Second by the agent');
  await expect(editor(page)).toContainText('First by the agent');
  await expect(undo).toBeVisible();
  // Undo twice: the member's own page.
  await undo.click();
  await expect(editor(page)).not.toContainText('First by the agent');
  await expect(editor(page)).toContainText('My own line');
  await expect(page.getByTestId('agent-edit')).toHaveCount(0);
  expect(errors).toEqual([]);
});
