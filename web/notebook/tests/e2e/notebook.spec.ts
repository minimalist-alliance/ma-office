// The demo page in headless Chromium, with the Desk harness's CSP. Each test gets a fresh browser
// context, so a fresh IndexedDB, which the demo seeds with its fake notes.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { NOTEBOOK_SCHEME } from '../../src/ui/palette.ts';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Fails the test on any console error or warning, page error, CSP report or request off this host. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['blob:', 'data:'].includes(u.protocol) && u.hostname !== '127.0.0.1') problems.push(`request off this host: ${r.url()}`);
  });
  return problems;
}

async function open(page: Page, query = ''): Promise<string[]> {
  const problems = watch(page);
  await page.goto(`/${query}`);
  await expect(page.getByTestId('note-editor')).toBeVisible();
  return problems;
}

const editor = (page: Page) => page.getByTestId('note-editor');

/** Waits until the backend's store has run, so derived titles and the database are up to date. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __nb: { flush(): Promise<void> } }).__nb.flush());
}

test('loads under the CSP with no errors and no network beyond this page', async ({ page }) => {
  const res = await page.request.get('/');
  expect(res.headers()['content-security-policy']).toContain("default-src 'self'");
  const problems = await open(page);
  await expect(page.getByRole('tab', { name: 'Trips' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.nb-prose h1')).toHaveText('Lake weekend');
  await page.getByRole('radio', { name: 'By day' }).click();
  await page.getByRole('radio', { name: 'By tab' }).click();
  expect(problems).toEqual([]);
});

test('typing formats text, keeps the title live, and survives a reload', async ({ page }) => {
  const problems = await open(page);
  await page.getByTestId('new-page').click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Grocery run');
  await expect(page.locator('.nb-page-btn.on .nb-page-title')).toHaveText('Grocery run');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Buy ');
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type('oat milk');
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type(' today.');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Shift+l`);
  await page.keyboard.type('Apples');
  await expect(page.locator('.nb-prose strong')).toHaveText('oat milk');
  await expect(page.locator('.nb-prose li[data-checked="false"] > div')).toHaveText('Apples');
  // Ticking the box is an edit like any other.
  await page.locator('.nb-prose li[data-checked] input').click();
  await expect(page.locator('.nb-prose li[data-checked="true"] > div')).toHaveText('Apples');
  await settle(page);
  await expect(page.locator('.nb-foot-meta')).toContainText('7 words');

  await page.reload();
  await expect(page.locator('.nb-prose h1')).toHaveText('Grocery run');
  await expect(page.locator('.nb-prose strong')).toHaveText('oat milk');
  await expect(page.locator('.nb-prose li[data-checked="true"] > div')).toHaveText('Apples');
  expect(problems).toEqual([]);
});

test('undo and redo use the Yjs history', async ({ page }) => {
  await open(page);
  await page.getByTestId('new-page').click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Draft');
  await page.waitForTimeout(600); // the UndoManager groups edits made within 500 ms
  await page.keyboard.type(' two');
  await expect(page.locator('.nb-prose h1')).toHaveText('Draft two');
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator('.nb-prose h1')).toHaveText('Draft');
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(page.locator('.nb-prose h1')).toHaveText('Draft two');
});

test('binder tabs: switch, page across tab boundaries, add a tab at a page, drag a page to a tab', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: 'Recipes' }).click();
  await expect(page.locator('.nb-prose h1')).toHaveText('Weeknight lentil soup');
  // The last page of Trips, then on into Recipes.
  await page.getByRole('tab', { name: 'Trips' }).click();
  await page.getByRole('button', { name: 'City break ideas' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByRole('tab', { name: 'Recipes' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.nb-prose h1')).toHaveText('Weeknight lentil soup');
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.locator('.nb-prose h1')).toHaveText('City break ideas');

  // "Add tab at this page" (design 5.2) on Lake weekend takes it and City break ideas.
  await page.getByRole('button', { name: 'Lake weekend' }).click();
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Add tab at this page' }).click();
  const renamed = page.getByRole('textbox', { name: 'Tab name' });
  await renamed.fill('Summer');
  await renamed.press('Enter');
  await expect(page.getByRole('tab')).toHaveText(['Trips', 'Summer', 'Recipes', 'Reading']);
  await page.getByRole('tab', { name: 'Summer' }).click();
  await expect(page.locator('.nb-page-title')).toHaveText(['Lake weekend', 'City break ideas']);

  await page.getByRole('button', { name: 'City break ideas' }).dragTo(page.getByRole('tab', { name: 'Reading' }));
  await expect(page.locator('.nb-page-title')).toHaveText(['Lake weekend']);
  await page.getByRole('tab', { name: 'Reading' }).click();
  await expect(page.locator('.nb-page-title')).toHaveText(['Books for winter', 'City break ideas']);

  // Recolor from the tab's own menu.
  await page.getByRole('tab', { name: 'Reading' }).click({ button: 'right' });
  await page.getByRole('menuitemradio', { name: 'Violet' }).click();
  await expect(page.getByRole('tab', { name: 'Reading' })).toHaveAttribute('data-color', 'violet');
});

test('every unselected binder tab has the same cool fill, whatever its color; the dot carries the color', async ({ page }) => {
  await open(page);
  const lum = (c: number[]) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const nums = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  for (const [name, id] of [['Light', 'light'], ['Zen', 'dusk'], ['Dark', 'dark']] as const) {
    await page.getByRole('radio', { name }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    const tabs = await page.locator('.nb-tab:not(.on):not(.add)').evaluateAll((els) =>
      els.map((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color, dot: getComputedStyle(el, '::before').backgroundColor, color: el.getAttribute('data-color') })),
    );
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tabs.map((t) => t.color)).size).toBe(tabs.length); // different tab colors
    expect(new Set(tabs.map((t) => t.dot)).size).toBe(tabs.length); // the dots differ
    expect(new Set(tabs.map((t) => t.bg)).size).toBe(1); // the fills don't
    const w = NOTEBOOK_SCHEME[id].window;
    expect(tabs[0]!.bg).toBe(`rgb(${[1, 3, 5].map((i) => parseInt(w.slice(i, i + 2), 16)).join(', ')})`);
    const [a, b] = [lum(nums(tabs[0]!.fg)), lum(nums(tabs[0]!.bg))];
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (process.env['NB_SHOTS']) console.log(`TABCONTRAST ${id} ${ratio.toFixed(2)} ${tabs[0]!.bg}`);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    if (process.env['NB_SHOTS']) {
      mkdirSync(`${process.env['NB_SHOTS']}/tabs`, { recursive: true });
      const bx = (await page.locator('.nb-tab.on').boundingBox())!;
      await page.screenshot({ clip: { x: Math.max(0, bx.x - 24), y: bx.y - 12, width: 460, height: bx.height + 24 }, path: `${process.env['NB_SHOTS']}/tabs/tabs-${id}.png`, animations: 'disabled' });
    }
  }
});

test('Light, Zen and Dark each restyle the page from tokens', async ({ page }) => {
  const problems = await open(page);
  const look = () =>
    page.evaluate(() => {
      const paper = getComputedStyle(document.querySelector('.nb-paper') as Element);
      const tab = getComputedStyle(document.querySelector('.nb-tab.on') as Element, '::before');
      const text = getComputedStyle(document.querySelector('.nb-prose') as Element);
      return { paper: paper.backgroundColor, tab: tab.backgroundColor, text: text.color, font: text.fontFamily };
    });
  const seen = new Set<string>();
  // The picker says Zen; the id is still `dusk` (ADR 0093).
  for (const [name, id] of [['Light', 'light'], ['Zen', 'dusk'], ['Dark', 'dark']] as const) {
    await page.getByRole('radio', { name }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    const l = await look();
    expect(l.font).toContain('Nunito Variable');
    expect(l.tab).not.toBe('rgba(0, 0, 0, 0)');
    seen.add(`${l.paper}|${l.text}`);
  }
  expect(seen.size).toBe(3);
  // The paper is the brand kit's surface.tile. In Zen (id `dusk`) that's #474D5B, ADR 0093's cool slate
  // (addendum, Nov 10); #4D5461 was Dusk's before Zen.
  await page.getByRole('radio', { name: 'Zen' }).click();
  expect((await look()).paper).toBe('rgb(71, 77, 91)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
  expect(problems).toEqual([]);
});

test('search with Ctrl/Cmd+K finds pages by word prefix and opens them', async ({ page }) => {
  await open(page);
  await editor(page).click();
  await page.keyboard.press(`${MOD}+k`);
  const input = page.getByTestId('search-input');
  await expect(input).toBeFocused();
  await input.fill('lent');
  await expect(page.locator('.nb-search-hit').first()).toContainText('Weeknight lentil soup');
  await expect(page.locator('.nb-search-hit mark').first()).toHaveText(/lent/i);
  await input.fill('has:checklist seed');
  await expect(page.locator('.nb-search-hit')).toHaveCount(1);
  await expect(page.locator('.nb-search-hit')).toContainText('Spring planting');
  await input.press('Enter');
  await expect(page.locator('.nb-prose h1')).toHaveText('Spring planting');
  // The page opens with the cursor in it.
  await expect(editor(page)).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Garden' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(`${MOD}+k`);
  await page.getByTestId('search-input').fill('zzzz');
  await expect(page.locator('.nb-search-results')).toContainText('Nothing matches');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-input')).toHaveCount(0);
});

test('history lists versions and restores one without losing the current text', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'History' }).click();
  const items = page.locator('.nb-history-item');
  await expect(items.first()).toBeVisible();
  // The oldest seeded version is the first half of the page.
  await items.last().click();
  await expect(page.locator('.nb-history-preview .nb-prose h2')).toHaveText(['Packing']);
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await expect(page.getByTestId('history')).toHaveCount(0);
  await expect(page.locator('.nb-prose h2')).toHaveText(['Packing']);
  await settle(page);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('.nb-history-why').first()).toHaveText('Restored');
  await expect(page.locator('.nb-history-preview .nb-prose h2')).toHaveText(['Packing']);
  await page.getByRole('button', { name: 'Back to the page' }).click();
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Save a version now' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('.nb-history-why').first()).toHaveText('Saved by you');
});

test('temporal view: days with notes, open a page, step days, and view a page as of a day', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: 'By day' }).click();
  await expect(page.locator('.nb-tl-title')).toHaveCount(2);
  await expect(page.locator('.nb-tl-entries')).toContainText('Spring planting');
  await expect(page.locator('.nb-tl-entries')).toContainText('Small app ideas');
  await page.getByRole('button', { name: 'Previous day with notes' }).click();
  await expect(page.locator('.nb-tl-entry').first()).toContainText('Books for winter');
  // ← and → step between active days.
  await page.locator('.nb-tl-main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.nb-tl-entries')).toContainText('Spring planting');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  // Lake weekend was edited 2 days ago; its version from that day has the whole page.
  const lake = page.locator('.nb-tl-entry', { hasText: 'Lake weekend' });
  await expect(lake).toHaveCount(1);
  await lake.getByRole('button', { name: 'As of this day' }).click();
  await expect(page.getByTestId('as-of')).toContainText('Lake weekend');
  await expect(page.locator('.nb-asof .nb-prose h2')).toHaveText(['Packing', 'Plan']);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('temporal-search').fill('soup');
  await expect(page.locator('.nb-day-list .nb-list-btn')).toHaveCount(2);
  await page.locator('.nb-tl-open', { hasText: 'lentil' }).click();
  await expect(page.getByRole('radio', { name: 'By tab' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.nb-prose h1')).toHaveText('Weeknight lentil soup');
});

test('export: Markdown and HTML files, and print shows the page alone', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Page actions' }).click();
  const [md] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Markdown (.md)' }).click()]);
  expect(md.suggestedFilename()).toBe('Lake weekend.md');
  const mdText = readFileSync((await md.path()) as string, 'utf8');
  expect(mdText.startsWith('# Lake weekend\n')).toBe(true);
  expect(mdText).toContain('- [x] Rain jacket');
  expect(mdText).toContain('**wood stove**');

  await page.getByRole('button', { name: 'Page actions' }).click();
  const [html] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Web page (.html)' }).click()]);
  const htmlText = readFileSync((await html.path()) as string, 'utf8');
  expect(htmlText).toContain('<h1>Lake weekend</h1>');
  expect(htmlText).not.toMatch(/<script|<link/);

  await page.evaluate(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('print-view').locator('h1')).toHaveText('Lake weekend');
  await expect(page.getByTestId('notebook')).toBeHidden();
});

test('trash and restore a page', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'City break ideas' }).click();
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.nb-page-title')).toHaveText(['Lake weekend']);
  await page.getByRole('button', { name: /Trash · 1/ }).click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.nb-prose h1')).toHaveText('City break ideas');
  await expect(page.locator('.nb-page-title')).toHaveText(['Lake weekend', 'City break ideas']);
});

test('a long page: keys land where the caret is, near and far', async ({ page }) => {
  const problems = await open(page, '?fixture=long&fresh=1&words=30000&pages=5');
  await expect(page.locator('.nb-prose h1')).toContainText('Long document');
  const paras = page.locator('.nb-prose > p');
  const mid = paras.nth(Math.floor((await paras.count()) / 2));
  await mid.click();
  await page.waitForTimeout(50);
  await page.keyboard.press('End');
  await page.waitForTimeout(50);
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${MOD}+Shift+l`);
  await page.keyboard.type('Middle task');
  await expect(page.locator('.nb-prose h1')).toContainText('Long document');
  await expect(page.locator('.nb-prose li[data-checked] > div', { hasText: 'Middle task' })).toHaveCount(1);
  // Far away. The browser moves the caret for clicks, End, Ctrl+End and Home, and ProseMirror hears
  // of it on the next selectionchange, so the test keeps a person's pause after each (a command key
  // sent 1 ms later can still act on the old selection: ProseMirror's behaviour, not this module's).
  await page.keyboard.press(`${MOD}+End`);
  await page.waitForTimeout(50);
  await page.keyboard.press('Enter');
  await page.keyboard.type('The very end');
  await expect(page.locator('.nb-prose > :last-child')).toHaveText('The very end');
  await page.keyboard.press(`${MOD}+Home`);
  await page.waitForTimeout(50);
  await page.keyboard.type('Top: ');
  await expect(page.locator('.nb-prose h1')).toContainText('Top: Long document');
  expect(problems).toEqual([]);
});
