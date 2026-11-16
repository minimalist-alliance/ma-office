// Documents on the mock desk (`desk/mockDeskDocs.ts`, deskd API.md §25; the documents concept): the tile opens the window;
// Needs you with the Maybe divider and code's reasons; a chip and Undo; search, then inside the text; the viewer with its page
// images over `bulk`, a changed line marked in the accent blue, Read as text and keys; an Office file's reading view; a danger
// type refused; Files' View; Maia's handover card opening the viewer at page 3. Light, Zen and Dark at 1440 and 390, with
// axe. One worker per process (the harness). Shots in $DOCS_SHOTS (else test-results/shots).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId, openMenuSection } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const SHOTS = process.env['DOCS_SHOTS'] ?? 'test-results/shots';
const CONTRACT = 'd_01JCMA00000000000000000001';
const README = 'd_01JCMA00000000000000000010';
// Maia Mode's Phase 1 gate (as maiaMode.shell.spec.ts): the access list is on, `/v1/me` lists this member.
const MAIA_ON = { configExtra: { maiaMode: { enabled: false, listed: true } }, meMaiaMode: { enabled: true } };

const win = (page: Page): Locator => page.getByTestId('documents-window').first();
const body = (page: Page): Locator => page.getByTestId('documents-body').first();
const items = (page: Page): Locator => body(page).locator('[data-testid="docs-list"] .docs-item');
const item = (page: Page, text: string): Locator => body(page).locator('.docs-item', { hasText: text });
const viewer = (page: Page): Locator => page.getByTestId('docs-viewer').first();
const pageOf = (page: Page): Locator => viewer(page).getByTestId('docs-page-of');

async function axe(page: Page, include: string): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: [sel] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, include);
}

/** A picture for the brand review: passing tests have missed a broken layout. */
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/documents-${name}.png` });
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, extra: Record<string, unknown> = {}, path = '/?fixture=one'): Promise<string[]> {
  await harness(request, { reset: true });
  // The harness has Documents off, as it has Files and To-do, so other specs count the tiles they always did; on here, as in prod.
  await harness(request, { documents: null, ...extra });
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await signIn(page, path);
  await canvasPainted(page);
  return errors;
}

async function openDocuments(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Documents/ });
  await expect(tile).toHaveCount(1);
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(items(page).first()).toBeVisible();
}

/** Every page image that has come is a real picture the browser decoded. */
const drawn = (page: Page, n: number): Promise<boolean> =>
  viewer(page).locator(`.docs-page[data-page="${n}"] img`).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

test.describe('Documents', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const theme of THEMES) {
    test(`${theme}: Needs you with Maybe, a chip and Undo, search, the viewer with a marked change, Read as text, a reading view, a danger type refused`, async ({ page, request }) => {
      const errors = await arrive(page, request, theme);
      await openDocuments(page);
      // Needs you: the sure ones in the desk's order, then the Maybe divider, each line `{who} · {what} · {reason}`.
      await expect(body(page).getByRole('tab', { name: /^Needs you/ })).toHaveAttribute('aria-selected', 'true');
      await expect(body(page).getByRole('tab', { name: /^Needs you/ })).toContainText('4');
      await expect(items(page)).toHaveCount(4);
      await expect(items(page).nth(0)).toContainText('Rosa Ortiz · Contract · Page 3 changed');
      await expect(items(page).nth(1)).toContainText('Northwind · Invoice · Asks you to pay by 1 Dec');
      await expect(body(page).getByTestId('docs-maybe')).toHaveText('Maybe');
      const maybeTop = (await body(page).getByTestId('docs-maybe').boundingBox())!.y;
      expect((await items(page).nth(1).boundingBox())!.y).toBeLessThan(maybeTop);
      expect((await items(page).nth(2).boundingBox())!.y).toBeGreaterThan(maybeTop);
      await expect(items(page).nth(2)).toContainText('Sam Lee · Lease form · Has empty signature fields');
      // A sensitive one shows code's fixed words, never her summary, outside the viewer.
      await expect(items(page).nth(3)).toContainText('A letter from Harbor Dental. Open to read.');
      await expect(items(page).nth(3)).not.toContainText('appointment');
      // Her note on the contract: italic, hers, with her small mark.
      await expect(item(page, 'Contract').locator('.docs-her-note')).toHaveText(/^Maia’s note\. Open the document to check\. The payment date moved/);
      await expect(body(page).getByTestId('docs-question')).toContainText('I sorted 312 documents. 4 might need you.');
      await expect(body(page).locator('.docs-end')).toHaveText('That’s all for now.');
      expect(await axe(page, '[data-testid="documents-window"]')).toEqual([]);
      await shot(page, `list-${theme}-1440`);

      // A chip: Not important makes the desk's rule, says so in its words, and Undo puts it back.
      await item(page, 'Invoice').getByRole('button', { name: /^Not important: Northwind · Invoice/ }).click();
      await expect(page.getByTestId('docs-toast')).toContainText('Not important: Invoices from Northwind go to Records now.');
      await expect(item(page, 'Northwind · Invoice')).toHaveCount(0);
      await page.getByTestId('docs-toast').getByRole('button', { name: 'Undo' }).click();
      await expect(item(page, 'Northwind · Invoice')).toHaveCount(1);

      // Search: the title and file name first, then inside the text.
      const search = body(page).getByRole('searchbox', { name: 'Find a document' });
      await search.fill('payment');
      await expect(body(page).getByTestId('docs-results')).toContainText('Nothing like that on your desks.');
      await body(page).getByRole('button', { name: 'Look inside documents' }).click();
      await expect(body(page).getByTestId('docs-results').locator('.docs-item')).toHaveCount(1);
      await expect(body(page).getByTestId('docs-results')).toContainText('Found inside');
      await search.press('Escape');
      await expect(items(page)).toHaveCount(4);

      // The viewer: page images over bulk, as they come into view; the change marked in the accent blue.
      await item(page, 'Contract').locator('.docs-open').click();
      await expect(viewer(page)).toHaveAttribute('data-doc', CONTRACT);
      await expect(viewer(page).getByRole('heading', { name: /Rosa Ortiz · Contract/ })).toBeVisible();
      await expect(pageOf(page)).toHaveText('Page 1 of 6');
      await expect(viewer(page).locator('.docs-page[data-page="1"] img')).toBeVisible();
      expect(await drawn(page, 1)).toBe(true);
      // The file's real name, one tap away.
      await viewer(page).getByRole('button', { name: 'File name' }).click();
      await expect(viewer(page).locator('.docs-orig')).toHaveText('Contract v3 final (1).pdf');
      await expect(viewer(page)).toContainText('Page 3 changed since you last looked.');
      await viewer(page).getByRole('button', { name: 'Show changes' }).click();
      await expect(viewer(page).getByRole('region', { name: 'What changed' })).toContainText('Page 3 changed');
      await expect(viewer(page).getByRole('region', { name: 'What changed' })).toContainText('Rosa moved the payment date to 1 December.');
      await expect(pageOf(page)).toHaveText('Page 3 of 6');
      const marks = viewer(page).locator('.docs-page[data-page="3"] [data-testid="docs-mark"]');
      await expect(marks).toHaveCount(3);
      expect(await drawn(page, 3)).toBe(true);
      const mark = await marks.first().evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, edge: getComputedStyle(el).boxShadow }));
      expect(mark.bg).toBe('rgba(61, 111, 168, 0.2)');
      expect(mark.edge).toContain('rgb(61, 111, 168)');
      // Its text layer, for a screen reader.
      await expect(viewer(page).locator('.docs-page[data-page="3"] .sr-only').last()).toHaveText(/Page 3\. Payment\./);
      expect(await axe(page, '[data-testid="documents-window"]')).toEqual([]);
      await shot(page, `viewer-${theme}-1440`);
      // Keys: PageDown and Home move by a page.
      await viewer(page).getByTestId('docs-pages').focus();
      await page.keyboard.press('PageDown');
      await expect(pageOf(page)).toHaveText('Page 4 of 6');
      await page.keyboard.press('Home');
      await expect(pageOf(page)).toHaveText('Page 1 of 6');
      // Read as text: the same document's text, plain.
      await viewer(page).getByRole('button', { name: 'Read as text' }).click();
      await expect(viewer(page).getByRole('button', { name: 'Read as text' })).toHaveAttribute('aria-pressed', 'true');
      await expect(viewer(page).locator('.docs-reading')).toContainText('Page 3. Payment. The client pays the full amount by 1 December.');
      await expect(viewer(page).locator('.docs-page')).toHaveCount(0);
      // Esc closes the topmost thing first (What changed), then goes back to the list, and never closes the window.
      await page.keyboard.press('Escape');
      await expect(viewer(page).getByRole('region', { name: 'What changed' })).toHaveCount(0);
      await expect(viewer(page)).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(viewer(page)).toHaveCount(0);
      await expect(win(page)).toBeVisible();

      // An Office file: its reading view, plain text only.
      await body(page).getByRole('tab', { name: /^Read later/ }).click();
      await item(page, 'Trip plan').locator('.docs-open').click();
      await expect(viewer(page).locator('.docs-reading h3').first()).toHaveText('Trip plan');
      await expect(viewer(page).locator('.docs-reading td', { hasText: 'Cabin' })).toHaveCount(1);
      expect(await axe(page, '[data-testid="documents-window"]')).toEqual([]);
      await shot(page, `reading-${theme}-1440`);
      await viewer(page).getByRole('button', { name: 'Back to Documents' }).click();

      // A danger type: never drawn or read, the desk's words instead.
      await body(page).getByRole('tab', { name: /^Records/ }).click();
      await item(page, 'Invoice tool').locator('.docs-open').click();
      await expect(viewer(page).getByTestId('docs-danger')).toHaveText('Program. Maia won’t open this.');
      await expect(viewer(page).locator('img')).toHaveCount(0);
      await expect(viewer(page).getByRole('button', { name: 'Read as text' })).toHaveCount(0);
      await shot(page, `danger-${theme}-1440`);
      const calls = await page.evaluate((id) => (window as unknown as { __maDeskMock: { docs: { desk(d: string): { control: { calls: { m: string; p: Record<string, unknown> }[] } } } } }).__maDeskMock.docs.desk('d-personal').control.calls.filter((c) => c.p['id'] === id).map((c) => c.m), 'd_01JCMA00000000000000000008');
      expect(calls).toEqual(['docs.get']);
      expect(errors).toEqual([]);
    });
  }

  test('Files’ View opens Documents at that file; Download stays', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light', { files: { enabled: true } });
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Files/ });
    await tile.evaluate((el) => (el as HTMLButtonElement).click());
    const row = page.locator('[data-testid="files-row"][data-name="readme.txt"]');
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for readme.txt' });
    expect(await menu.getByRole('menuitem').allInnerTexts()).toEqual(['View', 'Download', 'Rename', 'Move to…', 'Delete']);
    await menu.getByRole('menuitem', { name: 'View' }).click();
    await expect(viewer(page)).toHaveAttribute('data-doc', README);
    await expect(viewer(page).locator('.docs-reading')).toContainText('Everything here is on your desk, and only on your desk.');
    // Its copy is in Files, so Download is offered (Files' own download).
    await expect(viewer(page).getByRole('button', { name: 'Download' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Documents on a phone, 390 px', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  for (const theme of THEMES) {
    test(`${theme}: the list, pages side by side to swipe, the bottom bar, a reading view and a danger type`, async ({ page, request }) => {
      const errors = await arrive(page, request, theme);
      await openDocuments(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, `list-${theme}-390`);
      await item(page, 'Contract').locator('.docs-open').click();
      await expect(viewer(page)).toHaveAttribute('data-phone', 'true');
      await expect(viewer(page).locator('.docs-page[data-page="1"] img')).toBeVisible();
      const bar = viewer(page).getByRole('navigation');
      // The desk's lead is asked from the bar (the owner, Nov 15); this desk has only the lead, so no arrow beside it.
      expect(await bar.getByRole('button').allInnerTexts()).toEqual(['What changed', 'Ask Lead', 'More']);
      await bar.getByRole('button', { name: 'What changed' }).click();
      await expect(pageOf(page)).toHaveText('Page 3 of 6');
      await expect(viewer(page).locator('.docs-page[data-page="3"] [data-testid="docs-mark"]')).toHaveCount(3);
      // Pages sit side by side: a swipe is the pages' own horizontal scroll.
      const flow = await viewer(page).getByTestId('docs-pages').evaluate((el) => ({ snap: getComputedStyle(el).scrollSnapType, wide: el.scrollWidth > el.clientWidth * 2 }));
      expect(flow).toEqual({ snap: 'x mandatory', wide: true });
      await shot(page, `viewer-${theme}-390`);
      await bar.getByRole('button', { name: 'More' }).click();
      expect(await viewer(page).getByRole('menu').getByRole('menuitem').allInnerTexts()).toEqual(['Download', 'Versions', 'Copies', 'Read as text', 'Not important', 'Done']);
      await page.keyboard.press('Escape');
      await viewer(page).getByRole('button', { name: 'Back to Documents' }).click();
      await body(page).getByRole('tab', { name: /^Read later/ }).click();
      await item(page, 'Trip plan').locator('.docs-open').click();
      await expect(viewer(page).locator('.docs-reading h3').first()).toHaveText('Trip plan');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, `reading-${theme}-390`);
      await viewer(page).getByRole('button', { name: 'Back to Documents' }).click();
      await body(page).getByRole('tab', { name: /^Records/ }).click();
      await item(page, 'Invoice tool').locator('.docs-open').click();
      await expect(viewer(page).getByTestId('docs-danger')).toHaveText('Program. Maia won’t open this.');
      await shot(page, `danger-${theme}-390`);
      expect(await axe(page, '[data-testid="documents-window"]')).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
});

test.describe('Maia hands over a document', () => {
  for (const theme of THEMES) {
    for (const width of [1440, 390]) {
      test(`${theme} at ${width}: her card from the desk, Open at page 3 opens the viewer there`, async ({ page, request }) => {
        await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
        const errors = await arrive(page, request, theme, MAIA_ON, '/?fixture=three');
        // The first load's one question (Desk Mode, the default), then into the room by the account menu's switch.
        await expect(page.getByRole('group', { name: 'Open your office in' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#mm-ld')).toHaveCount(0, { timeout: 3000 });
        await page.getByRole('button', { name: 'Account', exact: true }).first().click();
        await openMenuSection(page, 'menu-maia');
        await page.getByRole('switch', { name: /^Maia on my desks/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Before Maia works on your desks' });
        await dialog.getByRole('checkbox', { name: 'I’ve read this' }).check();
        await dialog.getByRole('button', { name: 'Turn on Maia' }).click();
        await expect(page.locator('.mm-layer.in')).toBeVisible({ timeout: 3000 });
        await page.evaluate(() => (window as unknown as { __maMaiaModeMock: { handover(t: string): void } }).__maMaiaModeMock.handover('Here’s the contract Rosa sent. Page 3 is the change.'));
        const card = page.getByTestId('mm-doc-card');
        await expect(card).toHaveAttribute('data-doc', CONTRACT);
        await expect(card).toContainText('Rosa Ortiz · Contract');
        await expect(card).toContainText('Page 3 changed');
        await expect(card.locator('.mm-doc-note')).toHaveText(/^Maia’s note\. Open the document to check\. The payment date moved to 1 December/);
        await expect(card.getByRole('button', { name: 'What changed' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Later' })).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await shot(page, `handover-${theme}-${width}`);
        await card.getByRole('button', { name: 'Open at page 3' }).click();
        await expect(viewer(page)).toHaveAttribute('data-doc', CONTRACT);
        await expect(pageOf(page)).toHaveText('Page 3 of 6');
        await expect(viewer(page).locator('.docs-page[data-page="3"] [data-testid="docs-mark"]')).toHaveCount(3);
        // Inside the viewer, asking is the desk's own agent's, its lead by default (the owner, Nov 15).
        await expect(viewer(page).getByRole('button', { name: width > 600 ? 'Ask Lead about this' : 'Ask Lead' })).toBeVisible();
        await shot(page, `handover-open-${theme}-${width}`);
        // Still on page 3 once her viewport has settled: the page keeps its place as the width changes.
        await expect(pageOf(page)).toHaveText('Page 3 of 6');
        const top = await viewer(page).evaluate((v) => {
          const box = v.querySelector('[data-testid="docs-pages"]')!.getBoundingClientRect();
          const p3 = v.querySelector('.docs-page[data-page="3"]')!.getBoundingClientRect();
          return { dy: Math.round(p3.top - box.top), dx: Math.round(p3.left - box.left) };
        });
        expect(width > 600 ? top.dy : top.dx).toBeGreaterThanOrEqual(0);
        expect(width > 600 ? top.dy : top.dx).toBeLessThanOrEqual(24);
        expect(errors).toEqual([]);
      });
    }
  }
});

// The owner, Nov 15: Documents' ask "should really be ask desk agent, which should default to the primary agent". The lead by
// default, another agent of the desk from the small arrow; the question and the document's text wait in that agent's composer.
test.describe('Ask Lead', () => {
  for (const theme of THEMES) {
    test(`${theme}: search and the viewer ask the desk's lead, or another agent, in its own thread`, async ({ page, request }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const errors = await arrive(page, request, theme, {}, '/?fixture=one&agentFixture=ready&speed=fast');
      await openDocuments(page);
      // Search: the box and the results offer the lead by name, and the arrow the desk's other agents.
      const search = body(page).getByRole('searchbox', { name: 'Find a document, or ask Lead' });
      await search.fill('payment');
      const results = body(page).getByTestId('docs-results');
      await expect(results.getByRole('button', { name: 'Ask Lead', exact: true })).toBeVisible();
      await results.getByRole('button', { name: 'Ask another agent' }).click();
      await expect(results.getByRole('menuitem', { name: 'Ask Researcher' })).toBeVisible();
      await shot(page, `ask-search-${theme}`);
      await page.keyboard.press('Escape');
      await search.press('Escape');

      // The viewer: the first time, one sheet says what happens; then the lead's thread opens with the question and the file.
      await item(page, 'Contract').locator('.docs-open').click();
      await expect(viewer(page)).toHaveAttribute('data-doc', CONTRACT);
      await viewer(page).getByRole('button', { name: 'Ask Lead about this' }).click();
      const sheet = viewer(page).getByRole('dialog', { name: 'Ask Lead about this' });
      await expect(sheet).toContainText('To answer, Lead sends this document and your question to its AI, on Lead’s key or your credits.');
      expect(await axe(page, '[data-testid="documents-window"]')).toEqual([]);
      await shot(page, `ask-sheet-${theme}`);
      await sheet.getByRole('button', { name: 'Ask', exact: true }).click();
      const lead = page.getByTestId('window-agent');
      await expect(lead.getByTestId('agent-app')).toBeVisible();
      await expect(lead.locator('.ag-head-name')).toHaveText('Lead');
      await expect(lead.getByTestId('composer-input')).toHaveValue(/^About “.*Contract”: $/);
      await expect(lead.getByTestId('staged-file')).toContainText('Contract.txt');
      await shot(page, `ask-lead-thread-${theme}`);
      // Nothing went by itself.
      expect(await page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string }[] } }).__maDeskMock.rpc.filter((r) => r.m === 'agent.message.send').length)).toBe(0);

      // Another agent, from the arrow: no sheet the second time, straight to its own thread.
      await viewer(page).getByRole('button', { name: 'Ask another agent' }).click();
      await viewer(page).getByRole('menuitem', { name: 'Ask Researcher about this' }).click();
      const researcher = page.getByTestId('window-agent:researcher');
      await expect(researcher.getByTestId('composer-input')).toHaveValue(/^About “.*Contract”: $/);
      await expect(researcher.getByTestId('staged-file')).toContainText('Contract.txt');
      expect(errors).toEqual([]);
    });
  }
});
