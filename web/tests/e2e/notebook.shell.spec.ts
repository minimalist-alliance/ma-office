// The Notebook window on the mock desk (`desk/mockNotebook.ts`): the app's real `DeskBackend` and the real provider, against a
// server of Hocuspocus's protocol over a loopback of `collab`, and `notebook.*` on the editor's own LocalBackend. In all three
// themes, with axe. `notebook.rtc.spec.ts` runs the shipping bundle over real data channels, and `rt-notebook.mjs` the real desk.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const SUPPORT = 'support@minimalistalliance.com';
const MiB = 1024 * 1024;

interface NotebookControl {
  treePage: number;
  partChars: number;
  zones: string[];
  sizes: number[];
  oversize: number;
  silent: boolean;
  fullPages: string[];
  cutOff: Record<string, boolean>;
  applied: string[];
  flush(deskId: string): Promise<void>;
  pageText(deskId: string, pageId: string): Promise<string>;
}
interface Mock {
  rpc: { m: string; p: Record<string, unknown>; options?: { idem?: string } }[];
  refuse: Record<string, string>;
  refuseDetails: Record<string, unknown>;
  dropLink(deskId?: string): void;
  restoreLink(deskId?: string): void;
  resetCollab(): void;
  notebook: Promise<NotebookControl>;
}
declare const __maDeskMock: Mock;

const win = (page: Page): Locator => page.getByRole('dialog', { name: /Notebook/ });
const editor = (page: Page): Locator => page.getByTestId('note-editor');
const line = (page: Page): Locator => page.getByTestId('notebook-line');
const panel = (page: Page): Locator => page.getByTestId('notebook-panel');
const currentPage = (page: Page): Locator => page.locator('.nb-page-btn[aria-current="true"]');
const pageIdNow = (page: Page): Promise<string> => currentPage(page).getAttribute('data-page-id') as Promise<string>;
const deskOf = (page: Page): Promise<string> => win(page).getAttribute('data-desk') as Promise<string>;

async function arrive(page: Page, theme: ThemeId, fixture = 'one'): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await signIn(page, `/?fixture=${fixture}`);
  await canvasPainted(page);
  return errors;
}

async function openNotebook(page: Page, desk = 'Personal'): Promise<void> {
  const tile = page.getByRole('group', { name: `${desk} desk` }).getByRole('button', { name: /^Notebook/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.locator(`[data-testid="window-notebook"]`).filter({ hasNot: page.locator('.parked') }).first()).toBeVisible();
}

/** The window open, with a page ready to type on. */
async function openToType(page: Page, desk = 'Personal'): Promise<void> {
  await openNotebook(page, desk);
  await expect(editor(page)).toBeVisible();
  await expect(currentPage(page)).toBeVisible();
}

/** On an empty page, in its title. Otherwise at the end of what's there. */
async function typeInto(page: Page, text: string): Promise<void> {
  await editor(page).click();
  await page.keyboard.press((await page.locator('.nb-prose .nb-empty-title').count()) ? 'Control+Home' : 'Control+End');
  await page.keyboard.type(text);
}

/**
 * The text in ProseMirror's own selection. It hears of a selection the keys moved (Shift+End) on the next `selectionchange`, and a
 * script's next key can beat that by milliseconds, which a member's can't. A key ProseMirror handles itself, such as Backspace,
 * would then act on the old caret, so the test waits for this first (as `rt-notebook.mjs` does).
 */
const selectedText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    interface PM { state: { selection: { from: number; to: number }; doc: { textBetween(from: number, to: number): string } } }
    const ed = (document.querySelector('[data-testid="note-editor"]') as (HTMLElement & { editor?: PM }) | null)?.editor;
    return ed ? ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to) : '';
  });

const onDesk = (page: Page, deskId: string, pageId: string): Promise<string> =>
  page.evaluate(async ([d, p]) => (await __maDeskMock.notebook).pageText(d as string, p as string), [deskId, pageId]);

const flush = (page: Page, deskId: string): Promise<void> => page.evaluate(async (d) => (await __maDeskMock.notebook).flush(d), deskId);
const rpcOf = (page: Page, method: string): Promise<number> => page.evaluate((m) => __maDeskMock.rpc.filter((r) => r.m === m).length, method);

/** axe on the window, at WCAG 2.2 AA and best practice. Through devtools, so the page's CSP doesn't apply. */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked)'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
      // An empty title in an editor is where the title goes, and it has its placeholder. Nothing else here has an empty heading.
      rules: { 'empty-heading': { enabled: false } },
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function shot(page: Page, name: string, theme: ThemeId): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `test-results/shots/notebook-${name}-${theme}.png` });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const theme of THEMES) {
  test.describe(theme, () => {
    test('typing: on a page, into the list, onto the desk, and still there after a reload', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const look = await page.locator('.ma-nb').evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        window: getComputedStyle(document.documentElement).getPropertyValue('--ma-surface-window').trim(),
        tab: getComputedStyle(document.documentElement).getPropertyValue('--ma-nb-tab-blue').trim(),
        font: getComputedStyle(el).fontFamily,
      }));
      expect(look.tab).not.toBe(''); // the Notebook's own colors, per theme, are in the app's one stylesheet
      expect(look.font).toContain('Inter');

      await typeInto(page, 'Trip notes');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Book the ferry before Friday.');
      await expect(page.locator('.nb-prose h1')).toHaveText('Trip notes');
      await expect(currentPage(page).locator('.nb-page-title')).toHaveText('Trip notes');
      await expect(line(page)).toHaveCount(0); // no noise while all is well
      const deskId = await deskOf(page);
      const pageId = await pageIdNow(page);
      await expect.poll(() => onDesk(page, deskId, pageId)).toContain('Book the ferry before Friday.');

      // Only what the contract says. The time zone goes once, and there's no rowVersion anywhere.
      const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(await page.evaluate(async () => (await __maDeskMock.notebook).zones)).toEqual([zone]);
      const calls = await page.evaluate(() => __maDeskMock.rpc.filter((r) => r.m.startsWith('notebook.')));
      expect(JSON.stringify(calls)).not.toContain('rowVersion');
      expect(calls.find((r) => r.m === 'notebook.notebook.create')?.options?.idem).toBeTruthy();

      // Typing here is the member being at this desk, as far as the idle rule goes, and the desk hears of it.
      expect(await page.evaluate(() => (__maDeskMock as unknown as { activity: number }).activity)).toBeGreaterThan(0);

      await shot(page, 'typed', theme);
      expect(await axe(page)).toEqual([]);

      // A reload: the editor opens on what's stored, never empty over it.
      await flush(page, deskId);
      await page.reload();
      await canvasPainted(page);
      await openToType(page);
      await expect(page.locator('.nb-prose h1')).toHaveText('Trip notes');
      await expect(page.locator('.nb-prose')).toContainText('Book the ferry before Friday.');
      expect(await page.evaluate(async () => (await __maDeskMock.notebook).zones)).toEqual([]); // once on this desk
      expect(errors).toEqual([]);
    });

    test('the Notebook has no note text in browser storage, only ids and the zone', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'secretword typed here');
      const deskId = await deskOf(page);
      await expect.poll(async () => onDesk(page, deskId, await pageIdNow(page))).toContain('secretword');
      const stored = await page.evaluate(async () => ({
        local: JSON.stringify(Object.entries(localStorage)),
        session: JSON.stringify(Object.entries(sessionStorage)),
        keys: Object.keys(localStorage).filter((k) => k.startsWith('ma.notebook')),
        dbs: (await indexedDB.databases()).map((d) => d.name ?? ''),
      }));
      expect(stored.local).not.toContain('secretword');
      expect(stored.session).not.toContain('secretword');
      expect(stored.keys.sort()).toEqual([`ma.notebook.tz.${deskId}`, `ma.notebook.ui.${deskId}`]);
      // The only database with a note in it is the mock desk's own, which stands in for the desk.
      expect(stored.dbs.filter((d) => /notebook/i.test(d))).toEqual([`ma-mock-notebook:${deskId}`]);
      expect(errors).toEqual([]);
    });

    test('two windows of the same page converge, and nothing is lost', async ({ page, context }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'Shared');
      await expect(currentPage(page).locator('.nb-page-title')).toHaveText('Shared');
      const deskId = await deskOf(page);
      await flush(page, deskId);

      const other = await context.newPage();
      const otherErrors = watchConsole(other);
      await setTheme(other, theme);
      await signIn(other, '/?fixture=one');
      await canvasPainted(other);
      await openToType(other);
      await expect(other.locator('.nb-prose h1')).toHaveText('Shared');

      await page.bringToFront();
      await editor(page).click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('from the first');
      await other.bringToFront();
      await editor(other).click();
      await other.keyboard.press('Control+Home');
      await other.keyboard.press('End');
      await other.keyboard.press('Enter');
      await other.keyboard.type('from the second');

      for (const p of [page, other]) {
        await expect(editor(p)).toContainText('from the first');
        await expect(editor(p)).toContainText('from the second');
      }
      expect(await editor(page).innerText()).toBe(await editor(other).innerText());
      expect(errors).toEqual([]);
      expect(otherErrors).toEqual([]);
      await other.close();
    });

    test('the link dropping while typing: the text stays, a quiet line says so, leaving warns, and it arrives when the link returns', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'before');
      const deskId = await deskOf(page);
      const pageId = await pageIdNow(page);
      await expect.poll(() => onDesk(page, deskId, pageId)).toContain('before');

      await page.evaluate(() => __maDeskMock.dropLink());
      await expect(line(page)).toHaveText('Reconnecting…');
      await page.keyboard.type(' during');
      await expect(editor(page)).toContainText('before during');
      await expect(line(page)).toHaveText('Not saved yet. Reconnecting…');
      await expect(editor(page)).toBeEditable(); // nothing took the page away
      expect(await onDesk(page, deskId, pageId)).not.toContain('during');
      await shot(page, 'not-saved', theme);
      expect(await axe(page)).toEqual([]);

      // Leaving the page asks first, in the browser's own words.
      const prompts: string[] = [];
      page.on('dialog', (d) => {
        prompts.push(d.type());
        void d.dismiss();
      });
      await page.close({ runBeforeUnload: true });
      await expect.poll(() => prompts).toEqual(['beforeunload']);
      expect(page.isClosed()).toBe(false);

      await page.evaluate(() => __maDeskMock.restoreLink());
      await expect.poll(() => onDesk(page, deskId, pageId)).toContain('before during');
      await expect(line(page)).toHaveCount(0);
      await expect(editor(page)).toContainText('before during');

      // Saved, so a reload asks nothing. (The mock desk lives in this page, so its own store has to finish first.)
      await flush(page, deskId);
      await page.reload();
      await canvasPainted(page);
      await openToType(page);
      await expect(editor(page)).toContainText('before during');
      expect(prompts).toEqual(['beforeunload']);
      expect(errors).toEqual([]);
    });

    test('leaving a page or closing the window while the link is down loses nothing', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'First page');
      await expect(currentPage(page).locator('.nb-page-title')).toHaveText('First page');
      const deskId = await deskOf(page);
      const first = await pageIdNow(page);
      await page.getByTestId('new-page').click();
      await expect.poll(() => pageIdNow(page)).not.toBe(first);
      await expect(editor(page)).toBeFocused();
      const second = await pageIdNow(page);
      await page.keyboard.type('Second page');
      await expect.poll(() => onDesk(page, deskId, second)).toContain('Second page');

      await page.evaluate(() => __maDeskMock.dropLink());
      await page.keyboard.type(' typed offline');
      await page.locator(`.nb-page-btn[data-page-id="${first}"]`).click();
      // A page never opened since the link went waits: never an empty editor over real text.
      await expect(page.locator('.nb-loading[aria-busy="true"]').or(editor(page))).toBeVisible();
      await page.locator(`.nb-page-btn[data-page-id="${second}"]`).click();
      await expect(editor(page)).toContainText('Second page typed offline');

      await page.keyboard.press('Escape');
      await expect(win(page)).toHaveCount(0);
      await openToType(page);
      await expect(editor(page)).toContainText('Second page typed offline');

      await page.evaluate(() => __maDeskMock.restoreLink());
      await expect.poll(() => onDesk(page, deskId, second)).toContain('Second page typed offline');
      await expect(line(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('{"t":"reset"}, and a desk that says nothing: not saved yet, then saved', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await page.evaluate(async () => {
        (await __maDeskMock.notebook).silent = true;
      });
      await typeInto(page, 'waiting on the service');
      await expect(line(page)).toHaveText('Not saved yet.');
      const deskId = await deskOf(page);
      const pageId = await pageIdNow(page);
      await page.evaluate(async () => {
        (await __maDeskMock.notebook).silent = false;
        __maDeskMock.resetCollab();
      });
      await expect.poll(() => onDesk(page, deskId, pageId), { timeout: 15_000 }).toContain('waiting on the service');
      await expect(line(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('versions: saved, listed, shown read-only, and restored without losing what was there', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await page.evaluate(async () => {
        (await __maDeskMock.notebook).partChars = 16; // a version comes in parts: joined until `next` is null
      });
      await typeInto(page, 'First draft');
      const deskId = await deskOf(page);
      const pageId = await pageIdNow(page);
      await expect.poll(() => onDesk(page, deskId, pageId)).toContain('First draft');
      await page.getByRole('button', { name: 'Page actions' }).click();
      await page.getByRole('menuitem', { name: 'Save a version now' }).click();
      await expect.poll(() => page.evaluate(async () => (await __maDeskMock.notebook).applied.filter((m) => m === 'notebook.version.save').length)).toBe(1);

      await typeInto(page, ' and more');
      await expect.poll(() => onDesk(page, deskId, pageId)).toContain('and more');

      await page.getByRole('button', { name: 'History', exact: true }).click();
      const history = page.getByTestId('history');
      await expect(history.getByRole('list', { name: 'Versions' }).getByRole('button')).toHaveCount(1);
      await expect(history.locator('.nb-prose')).toHaveText('First draft');
      await shot(page, 'history', theme);
      expect(await axe(page)).toEqual([]);
      await page.getByRole('button', { name: 'Restore this version' }).click();
      await expect(history).toHaveCount(0);
      await expect(editor(page)).toHaveText('First draft');
      await expect.poll(() => onDesk(page, deskId, pageId)).toBe('First draft');
      expect(errors).toEqual([]);
    });

    test('search: finds across pages from the desk, and opens the page', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'Harbor');
      await page.keyboard.press('Enter');
      await page.keyboard.type('the lighthouse keeper');
      const deskId = await deskOf(page);
      const wanted = await pageIdNow(page);
      await expect.poll(() => onDesk(page, deskId, wanted)).toContain('lighthouse');
      await page.getByTestId('new-page').click();
      await expect.poll(() => pageIdNow(page)).not.toBe(wanted);
      await expect(editor(page)).toBeFocused();
      await page.keyboard.type('Something else');
      await flush(page, deskId);

      await page.keyboard.press('Control+K');
      const input = page.getByTestId('search-input');
      await input.fill('lighth');
      const hit = page.getByRole('option').filter({ hasText: 'Harbor' });
      await expect(hit).toBeVisible();
      await expect(hit).toContainText('lighthouse');
      expect(await page.evaluate(() => __maDeskMock.rpc.filter((r) => r.m === 'notebook.search').at(-1)?.p['query'])).toBe('lighth');
      await shot(page, 'search', theme);
      await input.fill('nothing like this');
      await expect(page.getByRole('option')).toHaveCount(0);
      await expect(page.getByText('Nothing matches “nothing like this”.')).toBeVisible();
      await input.fill('lighth');
      await hit.click();
      await expect.poll(() => pageIdNow(page)).toBe(wanted);
      await expect(editor(page)).toContainText('the lighthouse keeper');
      expect(errors).toEqual([]);
    });

    test('the Temporal view reads its days from the desk', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'Today in the log');
      await flush(page, await deskOf(page));
      await page.getByRole('radio', { name: 'By day' }).click();
      await expect(page.getByText('Today in the log').first()).toBeVisible();
      await shot(page, 'temporal', theme);
      expect(await axe(page)).toEqual([]);
      expect(await rpcOf(page, 'notebook.activity')).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    });

    test('binder tabs and pages go by RPC, and the tree follows', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await page.getByTestId('new-tab').click();
      await expect(page.getByRole('tab')).toHaveCount(2);
      await page.keyboard.type('Ideas');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('tab', { name: 'Ideas' })).toHaveAttribute('aria-selected', 'true');
      await page.getByTestId('new-page').click();
      await expect(page.locator('.nb-pages .nb-page-btn')).toHaveCount(2);
      // A tree read in pages: asked for again with `next`, however small they are.
      await page.evaluate(async () => {
        (await __maDeskMock.notebook).treePage = 1;
      });
      await page.getByTestId('new-page').click();
      await expect(page.locator('.nb-pages .nb-page-btn')).toHaveCount(3);
      await expect.poll(() => page.evaluate(() => __maDeskMock.rpc.some((r) => r.m === 'notebook.tree' && r.p['cursor']))).toBe(true);
      expect(errors).toEqual([]);
    });

    test("not_found: \"Notebook isn't on this desk yet\", with nothing to type into and nothing asked again", async ({ page }) => {
      const errors = await arrive(page, theme);
      await page.evaluate(() => {
        __maDeskMock.refuse['notebook.tree'] = 'not_found';
      });
      await openNotebook(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'missing');
      await expect(panel(page)).toContainText("Notebook isn't on this desk yet");
      await expect(panel(page)).toContainText('It arrives with an update to the desk.');
      await expect(win(page).locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
      await shot(page, 'missing', theme);
      expect(await axe(page)).toEqual([]);
      const asked = await rpcOf(page, 'notebook.tree');
      await page.waitForTimeout(3_000);
      expect(await rpcOf(page, 'notebook.tree')).toBe(asked);
      expect(asked).toBe(1);
      expect(errors).toEqual([]);
    });

    test('unavailable: calm, a few slow tries and no storm, and it opens by itself', async ({ page }) => {
      const errors = await arrive(page, theme);
      await page.evaluate(() => {
        __maDeskMock.refuse['notebook.tree'] = 'unavailable';
        __maDeskMock.refuseDetails = { reason: 'notebook' };
      });
      await openNotebook(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'unavailable');
      await expect(panel(page)).toContainText("Notebook isn't answering");
      await expect(panel(page)).toContainText("Your notes are safe on this desk. This opens by itself when it's back.");
      await expect(win(page).locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
      await shot(page, 'unavailable', theme);
      expect(await axe(page)).toEqual([]);
      await page.waitForTimeout(5_000);
      expect(await rpcOf(page, 'notebook.tree')).toBeLessThanOrEqual(3);
      await page.evaluate(() => {
        delete __maDeskMock.refuse['notebook.tree'];
      });
      await expect(editor(page)).toBeVisible({ timeout: 15_000 });
      expect(errors).toEqual([]);
    });

    test('a page the desk says is full: plainly, it stops taking text, and other pages carry on', async ({ page }) => {
      const errors = await arrive(page, theme);
      await openToType(page);
      await typeInto(page, 'Kept');
      const deskId = await deskOf(page);
      const full = await pageIdNow(page);
      await expect.poll(() => onDesk(page, deskId, full)).toContain('Kept');
      await page.evaluate(async (p) => {
        (await __maDeskMock.notebook).fullPages = [p];
      }, full);
      await page.keyboard.type('!');
      await expect(line(page)).toHaveText("This page is full, so what you typed last isn't saved. Copy it to a new page.");
      await expect(editor(page)).not.toBeEditable();
      await expect(editor(page)).toContainText('Kept!'); // still there to copy
      expect(await onDesk(page, deskId, full)).toBe('Kept');
      await shot(page, 'page-full', theme);
      expect(await axe(page)).toEqual([]);

      await page.getByTestId('new-page').click();
      await expect.poll(() => pageIdNow(page)).not.toBe(full);
      await expect(editor(page)).toBeEditable();
      await page.keyboard.type('Fresh page');
      await expect.poll(async () => onDesk(page, deskId, await pageIdNow(page))).toContain('Fresh page');
      await expect(line(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('a desk asleep says so, offers Wake, and rendering wakes nothing', async ({ page, request }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await harness(request, { fleet: [fleetDesk(PERSONAL, 'Personal', 'personal', 'stopped'), fleetDesk(WORK, 'Work', 'work', 'stopped')], refuseWake: { status: 409, code: 'downtime_active' } });
      await signIn(page, '/?link=real');
      await canvasPainted(page);
      expect(await wakes(request)).toBe(0);
      await page.getByRole('button', { name: /^Personal desk/ }).evaluate((el) => (el as HTMLButtonElement).click());
      await page.waitForTimeout(300);
      await openNotebook(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'asleep');
      await expect(panel(page)).toContainText('This desk is asleep');
      await expect(panel(page)).toContainText('Your notes are safe. They come back when it wakes.');
      await expect(win(page).locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
      await shot(page, 'asleep', theme);
      expect(await axe(page)).toEqual([]);
      await harness(request, { refuseWake: null });
      const before = await wakes(request);
      await panel(page).getByRole('button', { name: 'Wake this desk', exact: true }).click();
      await expect(panel(page)).toHaveAttribute('data-panel', 'waking');
      await expect.poll(() => wakes(request)).toBe(before + 1);
      await shot(page, 'waking', theme);
      expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
    });

    test('a desk still being set up, held, or refused says what EmptyApp says, and nothing else', async ({ page, request }) => {
      const errors = watchConsole(page);
      await setTheme(page, theme);
      await harness(request, { fleet: [fleetDesk(PERSONAL, 'Personal', 'personal', 'provisioning')] });
      await signIn(page, '/?link=real');
      await canvasPainted(page);
      await openNotebook(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'settingUp');
      await expect(panel(page)).toHaveText('This desk is still being set up');
      await expect(win(page).locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
      await shot(page, 'setting-up', theme);
      expect((await readHarness(request)).connects).toEqual([]);

      // Held, or refused for the membership, with the window already open: the link's next check hears it.
      await harness(request, { fleet: [fleetDesk(PERSONAL, 'Personal', 'personal', 'running')] });
      await page.reload();
      await canvasPainted(page);
      await openNotebook(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'opening');
      await harness(request, { fleet: [fleetDesk(PERSONAL, 'Personal', 'personal', 'running', { refuse: 'desk_unavailable' })] });
      await expect(panel(page)).toHaveAttribute('data-panel', 'support', { timeout: 15_000 });
      await expect(panel(page)).toHaveText(SUPPORT);
      await shot(page, 'held', theme);
      expect(await axe(page)).toEqual([]);

      await harness(request, { fleet: [fleetDesk(PERSONAL, 'Personal', 'personal', 'running')] });
      await page.reload();
      await canvasPainted(page);
      await openNotebook(page);
      await expect(panel(page)).toHaveAttribute('data-panel', 'opening');
      await harness(request, { refuseConnect: { code: 'account_suspended', details: { billingUrl: 'https://platform.localhost/billing' } }, membership: { status: 'suspended', tier: 'member' } });
      await expect(panel(page)).toHaveAttribute('data-panel', 'membership', { timeout: 15_000 });
      await expect(panel(page)).toContainText('Your membership is not active');
      await expect(panel(page).getByRole('link', { name: 'Billing' })).toBeVisible();
      await shot(page, 'membership', theme);
      expect(errors.filter((e) => !e.includes('403'))).toEqual([]);
    });

    test('a window parked behind another desk stays as it was, asks nothing, and catches up when it comes back', async ({ page }) => {
      const errors = await arrive(page, theme, 'three');
      await openToType(page, 'Personal');
      await typeInto(page, 'On the personal desk');
      const deskId = await deskOf(page);
      const pageId = await pageIdNow(page);
      await expect.poll(() => onDesk(page, deskId, pageId)).toContain('On the personal desk');
      const window_ = page.locator(`[data-testid="window-notebook"][data-desk="${deskId}"]`);

      await page.getByRole('button', { name: 'Next desk' }).click();
      await expect(window_).toBeHidden();
      await expect(window_).toHaveClass(/parked/);
      // What the desk's store says next goes unread while nobody can see it: nothing asks the desk anything.
      await page.waitForTimeout(600);
      const asked = await rpcOf(page, 'notebook.tree');
      await flush(page, deskId);
      await page.waitForTimeout(1_200);
      expect(await rpcOf(page, 'notebook.tree')).toBe(asked);

      await page.getByRole('button', { name: 'Previous desk' }).click();
      await expect(window_).toBeVisible();
      await expect(editor(page)).toContainText('On the personal desk');
      expect(errors).toEqual([]);
    });
  });
}

function fleetDesk(deskId: string, name: string, kind: string, state: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { deskId, name, kind, state, ...more };
}
interface HarnessState { connects: { deskId: string; start: unknown }[] }
const readHarness = async (request: APIRequestContext): Promise<HarnessState> => (await (await request.get('/__harness')).json()) as HarnessState;
const wakes = async (request: APIRequestContext): Promise<number> => (await readHarness(request)).connects.filter((c) => c.start === true).length;

test('each desk has its own notes, and nothing crosses', async ({ page }) => {
  const errors = await arrive(page, 'light', 'three');
  await openToType(page, 'Personal');
  await typeInto(page, 'Only on personal');
  const personal = await deskOf(page);
  const personalPage = await pageIdNow(page);
  await expect.poll(() => onDesk(page, personal, personalPage)).toContain('Only on personal');
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-testid="window-notebook"]`)).toHaveCount(0);
  await page.keyboard.press('Escape'); // back to the overview
  await openToType(page, 'Work');
  await expect(editor(page)).not.toContainText('Only on personal');
  await typeInto(page, 'Only on work');
  const work = await deskOf(page);
  const workPage = await pageIdNow(page);
  expect(work).not.toBe(personal);
  expect(workPage).not.toBe(personalPage);
  await expect.poll(() => onDesk(page, work, workPage)).toContain('Only on work');
  expect(await onDesk(page, personal, personalPage)).not.toContain('Only on work');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ma.notebook.ui.')).sort());
  expect(keys).toEqual([`ma.notebook.ui.${personal}`, `ma.notebook.ui.${work}`].sort());
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? '').filter((n) => n.includes('notebook')).sort());
  expect(dbs).toEqual([`ma-mock-notebook:${personal}`, `ma-mock-notebook:${work}`].sort());
  expect(errors).toEqual([]);
});

test('Esc and Shift+Esc leave from inside the editor, as anywhere else, and the text stays', async ({ page }) => {
  const errors = await arrive(page, 'light');
  await openToType(page);
  await typeInto(page, 'Still here');
  const deskId = await deskOf(page);
  const pageId = await pageIdNow(page);
  await expect.poll(() => onDesk(page, deskId, pageId)).toContain('Still here');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(win(page)).toHaveCount(0);
  await openToType(page);
  await expect(editor(page)).toContainText('Still here');
  await editor(page).click();
  await page.keyboard.press('Shift+Escape');
  await expect(win(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a link in a note opens in this desk\'s Browser on a Ctrl+click, http and https only', async ({ page }) => {
  const errors = await arrive(page, 'light');
  await openToType(page);
  await typeInto(page, 'See https://example.org/ferry today');
  const link = editor(page).getByRole('link', { name: 'https://example.org/ferry' });
  await expect(link).toBeVisible();
  await link.click({ modifiers: ['Control'] });
  await expect(page.getByRole('dialog', { name: /Browser/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => __maDeskMock.rpc.find((r) => r.m === 'browser.tab.open')?.p['url'])).toBe('https://example.org/ferry');
  const opened = await page.evaluate(() => __maDeskMock.rpc.find((r) => r.m === 'browser.tab.open'));
  expect(opened?.options?.idem).toBeTruthy();
  expect(errors).toEqual([]);
});

test("a change cut off by a restart isn't sent again: it happened once, the tree shows it, and the line says so quietly", async ({ page }) => {
  const errors = await arrive(page, 'light');
  await openToType(page);
  const before = await page.locator('.nb-pages .nb-page-btn').count();
  await page.evaluate(async () => {
    (await __maDeskMock.notebook).cutOff['notebook.page.create'] = true;
  });
  await page.getByTestId('new-page').click();
  // deskd replays `mayHaveApplied` on the same key, and a new key could make a second page, so neither is tried.
  await expect(page.locator('.nb-pages .nb-page-btn')).toHaveCount(before + 1);
  await expect(line(page)).toHaveText("This desk didn't confirm that. Try again if it isn't there.");
  const creates = await page.evaluate(() => __maDeskMock.rpc.filter((r) => r.m === 'notebook.page.create').length);
  expect(creates).toBe(1);
  expect(await page.evaluate(async () => (await __maDeskMock.notebook).applied.filter((m) => m === 'notebook.page.create').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('a change the desk never confirms says so quietly, and nothing throws', async ({ page }) => {
  const errors = await arrive(page, 'light');
  await openToType(page);
  await page.evaluate(() => {
    __maDeskMock.refuse['notebook.page.create'] = 'internal';
  });
  await page.getByTestId('new-page').click();
  await expect(line(page)).toHaveText("This desk didn't confirm that. Try again if it isn't there.");
  await page.evaluate(() => {
    delete __maDeskMock.refuse['notebook.page.create'];
  });
  const before = await page.locator('.nb-pages .nb-page-btn').count();
  await page.getByTestId('new-page').click();
  await expect(page.locator('.nb-pages .nb-page-btn')).toHaveCount(before + 1);
  await expect(line(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a paste over about 1 MiB goes in several transactions, no message nears the limit, the session stays up and all of it arrives', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await arrive(page, 'light');
  await openToType(page);
  const deskId = await deskOf(page);
  const pageId = await pageIdNow(page);
  await typeInto(page, 'Title');
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    (await __maDeskMock.notebook).sizes.length = 0;
  });
  // About 5 MB, which as one transaction would be one update over 4 MiB, and would close the whole session on a real desk.
  const pasted = await page.evaluate(() => {
    const lines: string[] = [];
    for (let i = 0; i < 2600; i += 1) lines.push(`Line ${i} ${'lorem ipsum dolor sit amet '.repeat(75)}`);
    const text = lines.join('\n');
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const target = document.querySelector('[data-testid="note-editor"]') as HTMLElement;
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return { chars: text.length, lastLine: lines.at(-1)?.slice(0, 40) };
  });
  expect(pasted.chars).toBeGreaterThan(5_000_000);
  await expect(editor(page)).toContainText(pasted.lastLine as string, { timeout: 60_000 });
  await expect(line(page)).toHaveCount(0, { timeout: 60_000 });

  const sent = await page.evaluate(async () => {
    const c = await __maDeskMock.notebook;
    return { sizes: c.sizes.filter((s) => s > 1024), oversize: c.oversize };
  });
  expect(sent.oversize).toBe(0);
  expect(sent.sizes.length).toBeGreaterThanOrEqual(5);
  expect(Math.max(...sent.sizes)).toBeLessThan(MiB);
  expect(sent.sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(5 * 1000 * 1000);
  await expect.poll(async () => (await onDesk(page, deskId, pageId)).length, { timeout: 30_000 }).toBeGreaterThan(5_000_000);
  expect(await onDesk(page, deskId, pageId)).toContain(pasted.lastLine as string);
  expect(await page.evaluate(() => document.querySelector('[data-testid="window-notebook"]')?.getAttribute('data-desk'))).toBe(deskId);
  // The link never moved: a session closed with 4001 would have dropped it.
  await expect(page.getByRole('button', { name: /^Personal desk, 4 apps/ })).not.toHaveAccessibleName(/reconnecting/);
  expect(errors).toEqual([]);
});

test('a page whose Title line is empty is named in the list by its first line with text, as the desk names it (LS-29)', async ({ page }) => {
  const errors = await arrive(page, 'light');
  await openToType(page);
  await typeInto(page, 'Draft');
  await page.keyboard.press('Enter');
  await page.keyboard.type('RGN sweep note');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body line one.');
  // Empty the Title line, so the name is in the body, as a member who starts typing below it has it.
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+End');
  await expect.poll(() => selectedText(page)).toBe('Draft');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.nb-prose .nb-empty-title')).toHaveCount(1);
  // An empty heading says what it is (a11y pass O6).
  await expect(page.locator('.nb-prose .nb-empty-title')).toHaveAttribute('aria-label', 'Title');
  await expect(currentPage(page).locator('.nb-page-title')).toHaveText('RGN sweep note');
  const deskId = await deskOf(page);
  const first = await pageIdNow(page);
  await expect.poll(() => onDesk(page, deskId, first)).toContain('Body line one.');
  // Another page open: the first one's row is the desk's own title now, and it says the same.
  await page.getByTestId('new-page').click();
  await expect.poll(() => pageIdNow(page)).not.toBe(first);
  await expect(page.locator(`.nb-page-btn[data-page-id="${first}"] .nb-page-title`)).toHaveText('RGN sweep note');
  expect(errors).toEqual([]);
});
