// The Notebook in the shipping bundle: the real link and the real CSP, through gateway-shim and desk-rtc to fake-deskd, over real
// data channels. fake-deskd answers `not_found` to `notebook.*`, which is the real `not_found` path. For the rest, `notebookDesk.ts`
// stands in for the desk's answers, and nothing else: see there for where that line is.
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { harness, signIn, watchConsole } from './helpers';
import { notebookDeskIn, watchChannels } from './notebookDesk';
import { buildTools, DESK_ID, Stack } from './rtcStack';

const EVIDENCE = resolve('test-results/rtc-notebook');
const ONLINE = /^Personal desk, 4 apps, online · dev · up /;
const MiB = 1024 * 1024;
const stack = new Stack(EVIDENCE);

const proxy = (page: Page): Locator => page.getByRole('button', { name: /^Personal desk, 4 apps, / });
const editor = (page: Page): Locator => page.getByTestId('note-editor');
const panel = (page: Page): Locator => page.getByTestId('notebook-panel');
const line = (page: Page): Locator => page.getByTestId('notebook-line');
const currentPage = (page: Page): Locator => page.locator('.nb-page-btn[aria-current="true"]');
const pageIdNow = (page: Page): Promise<string> => currentPage(page).getAttribute('data-page-id') as Promise<string>;

async function online(page: Page): Promise<void> {
  await signIn(page);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
}

async function openNotebook(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
}

async function typeTitle(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(text);
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async () => {
  test.setTimeout(600_000);
  rmSync(EVIDENCE, { recursive: true, force: true });
  mkdirSync(EVIDENCE, { recursive: true });
  buildTools();
  await stack.start();
});

test.afterAll(async () => {
  await stack.stop();
});

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
  await harness(request, { shim: stack.api });
});

test("a desk without it answers not_found: the calm line, nothing to type into, one question, and nothing on collab", async ({ page }) => {
  const errors = watchConsole(page);
  const seen = await watchChannels(page);
  await online(page);
  await openNotebook(page);
  await expect(panel(page)).toHaveAttribute('data-panel', 'missing');
  await expect(panel(page)).toContainText("Notebook isn't on this desk yet");
  await expect(page.getByRole('dialog', { name: /Notebook/ }).locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await page.waitForTimeout(3_000);
  expect(await seen.asked('notebook.tree')).toBe(1);
  expect(await seen.collabFrames()).toBe(0);
  expect(await seen.csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('typed on the real channels, under the real CSP: frames as the contract says, and still there after a reload', async ({ page }) => {
  const errors = watchConsole(page);
  const { stats, desk, csp } = await notebookDeskIn(page, DESK_ID);
  await online(page);
  await openNotebook(page);
  await expect(editor(page)).toBeVisible();
  await typeTitle(page, 'Over the real link');
  const pageId = await pageIdNow(page);
  const onDesk = async (): Promise<string> => (await desk.page(pageId)).doc.getXmlFragment('default').toString();
  await expect.poll(onDesk).toContain('Over the real link');
  await expect(line(page)).toHaveCount(0);

  expect(stats.frames.length).toBeGreaterThan(0);
  expect(stats.frames.every((f) => f.bin && f.size <= 16 * 1024)).toBe(true);
  expect(await csp()).toEqual([]);

  // No note text in this browser: the shipping bundle has no database for it.
  const stored = await page.evaluate(async () => ({ local: JSON.stringify(Object.entries(localStorage)), dbs: (await indexedDB.databases()).map((d) => d.name) }));
  expect(stored.local).not.toContain('Over the real link');
  expect(stored.dbs.filter((d) => /notebook/i.test(d ?? ''))).toEqual([]);

  await desk.flush();
  await page.reload();
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 20_000 });
  await openNotebook(page);
  await expect(editor(page)).toContainText('Over the real link');
  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('the session really ending while typing: nothing lost, the provider comes back on the next session by itself', async ({ page }) => {
  const errors = watchConsole(page);
  const { desk, csp } = await notebookDeskIn(page, DESK_ID);
  await online(page);
  await openNotebook(page);
  await expect(editor(page)).toBeVisible();
  await typeTitle(page, 'Before the drop');
  const pageId = await pageIdNow(page);
  const onDesk = async (): Promise<string> => (await desk.page(pageId)).doc.getXmlFragment('default').toString();
  await expect.poll(onDesk).toContain('Before the drop');

  await stack.killDesk();
  // Once the link knows. Until then what's typed goes on the real channel and is lost with it, and only a desk's silence says so,
  // which the stand-in can't do: it hears a copy of every frame. `deskBackend.test.ts` has that case.
  await expect(proxy(page)).toHaveAccessibleName(/reconnecting…$/, { timeout: 20_000 });
  await page.keyboard.type(' and after it');
  await expect(editor(page)).toContainText('Before the drop and after it');
  await expect(line(page)).toContainText('Not saved yet.', { timeout: 20_000 });
  expect(await onDesk()).not.toContain('after it');

  await stack.startDesk();
  await expect(proxy(page)).toHaveAccessibleName(ONLINE, { timeout: 40_000 });
  await expect.poll(onDesk, { timeout: 30_000 }).toContain('Before the drop and after it');
  await expect(line(page)).toHaveCount(0, { timeout: 20_000 });
  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('{"t":"reset"} from deskd: DATA with no BIN, and the provider starts again on the same session', async ({ page }) => {
  const errors = watchConsole(page);
  const { desk, reset, csp } = await notebookDeskIn(page, DESK_ID);
  await online(page);
  await openNotebook(page);
  await expect(editor(page)).toBeVisible();
  await typeTitle(page, 'Survives a restart of the service');
  const pageId = await pageIdNow(page);
  const onDesk = async (): Promise<string> => (await desk.page(pageId)).doc.getXmlFragment('default').toString();
  await expect.poll(onDesk).toContain('Survives a restart');
  await reset();
  await page.keyboard.type(' and carries on');
  await expect.poll(onDesk, { timeout: 15_000 }).toContain('and carries on');
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});

test('a very large paste on the real channels: several messages, none near the limit, and the session stays up', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const { desk, stats, csp } = await notebookDeskIn(page, DESK_ID);
  await online(page);
  await openNotebook(page);
  await expect(editor(page)).toBeVisible();
  await typeTitle(page, 'Long');
  await page.keyboard.press('Enter');
  const pageId = await pageIdNow(page);
  const pasted = await page.evaluate(() => {
    const lines: string[] = [];
    for (let i = 0; i < 2600; i += 1) lines.push(`Line ${i} ${'lorem ipsum dolor sit amet '.repeat(75)}`);
    const data = new DataTransfer();
    data.setData('text/plain', lines.join('\n'));
    document.querySelector('[data-testid="note-editor"]')?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return lines.at(-1)?.slice(0, 40) as string;
  });
  await expect(editor(page)).toContainText(pasted, { timeout: 60_000 });
  await expect.poll(async () => (await desk.page(pageId)).doc.getXmlFragment('default').toString().includes(pasted), { timeout: 120_000 }).toBe(true);
  const big = stats.messages.filter((n) => n > 1024);
  expect(big.length).toBeGreaterThanOrEqual(5);
  expect(Math.max(...stats.messages)).toBeLessThan(MiB);
  expect(stats.frames.every((f) => f.size <= 16 * 1024)).toBe(true);
  await expect(proxy(page)).toHaveAccessibleName(ONLINE);
  expect(await csp()).toEqual([]);
  expect(errors).toEqual([]);
});
