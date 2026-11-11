// The Notebook's context menus and colors, on the demo under the Desk harness's CSP: right click, long press (touch
// emulation) and Shift+F10, colors applied to text, blocks and pages, and the page list's filter and sort by label, in
// Light, Dusk and Dark. Screenshots go to $NB_SHOTS (outside git) when it's set.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NOTEBOOK_SCHEME } from '../../src/ui/palette.ts';

const SHOTS = process.env['NB_SHOTS'];
const THEMES = ['Light', 'Dusk', 'Dark'] as const;
const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function open(page: Page, query = ''): Promise<string[]> {
  const problems = watch(page);
  await page.goto(`/${query}`);
  await expect(page.getByTestId('note-editor')).toBeVisible();
  return problems;
}

const editor = (page: Page) => page.getByTestId('note-editor');

/** Waits until the backend's store has run, so derived titles are in the list. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __nb: { flush(): Promise<void> } }).__nb.flush());
}
const menu = (page: Page, name: string) => page.getByRole('menu', { name, exact: true });
const row = (page: Page, title: string) => page.locator('.nb-page-btn', { has: page.locator('.nb-page-title', { hasText: new RegExp(`^${title}$`) }) });

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await (target ?? page).screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function theme(page: Page, name: (typeof THEMES)[number]): Promise<void> {
  await page.getByRole('radio', { name }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', name.toLowerCase());
}

/** A new page with a title and a line of text, the caret at the end of the line. */
async function newPage(page: Page, title: string, line: string): Promise<void> {
  await page.getByTestId('new-page').click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(line);
}

/** Selects `n` characters ending `back` characters before the end of the caret's line. */
async function selectBack(page: Page, back: number, n: number): Promise<void> {
  await page.keyboard.press('End');
  for (let i = 0; i < back; i += 1) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < n; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  // ProseMirror hears of a selection the browser moved on the next selectionchange; a shortcut sent sooner acts on the old
  // one (README, "What's left"). People can't type that fast.
  await page.waitForTimeout(50);
}

const selectionBox = (page: Page) =>
  page.evaluate(() => {
    const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

/** A palette value as the page has it, as `rgb(...)`. */
const paletteRgb = (page: Page, id: string, use: 'highlight' | 'text' | 'callout' | 'label') =>
  page.evaluate(
    ([v]) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${v})`;
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    },
    [`--ma-nb-${id}-${use}`],
  );

const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe('desktop', () => {
  test('right click on a selection: highlight from the grid, focus back in the text', async ({ page }) => {
    const problems = await open(page);
    await newPage(page, 'Colors', 'Pack the tent today');
    await selectBack(page, 6, 4); // "tent"
    const box = await selectionBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    const m = menu(page, 'Selected text');
    await expect(m).toBeVisible();
    await expect(m.getByRole('menuitem', { name: 'Highlight' })).toBeFocused();
    await m.getByRole('menuitem', { name: 'Highlight' }).click();
    const grid = menu(page, 'Highlight');
    await expect(grid.getByRole('menuitemradio')).toHaveText(['', '', '', '', '', '', '']);
    await expect(grid.getByRole('menuitemradio')).toHaveCount(7);
    await expect(grid.getByRole('menuitemradio', { name: 'No highlight' })).toHaveAttribute('aria-checked', 'true');
    await grid.getByRole('menuitemradio', { name: 'Blue' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.nb-prose mark[data-color="blue"]')).toHaveText('tent');
    await expect(editor(page)).toBeFocused();
    expect(problems).toEqual([]);
  });

  test('Shift+F10 and the menu key: arrows, a letter, a grid, Enter and Esc, focus back each time', async ({ page }) => {
    const problems = await open(page);
    await newPage(page, 'Keys', 'Call the dentist');
    await selectBack(page, 0, 7); // "dentist"

    await page.keyboard.press('Shift+F10');
    const m = menu(page, 'Selected text');
    await expect(m.getByRole('menuitem', { name: 'Highlight' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(m.getByRole('menuitem', { name: 'Text color' })).toBeFocused();
    await page.keyboard.press('c'); // the next item starting with C: Clear formatting
    await expect(m.getByRole('menuitem', { name: 'Clear formatting' })).toBeFocused();
    await page.keyboard.press('c');
    await expect(m.getByRole('menuitem', { name: 'Cut' })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight'); // into the Highlight row, on the color last used (none yet: Amber, the default)
    const grid = menu(page, 'Highlight');
    await expect(grid.getByRole('menuitemradio', { name: 'No highlight' })).toHaveAttribute('aria-checked', 'true');
    await expect(grid.getByRole('menuitemradio', { name: 'Amber' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(grid.getByRole('menuitemradio', { name: 'No highlight' })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await expect(grid.getByRole('menuitemradio', { name: 'Blue' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(grid.getByRole('menuitemradio', { name: 'Amber' })).toBeFocused();
    await page.keyboard.press('ArrowLeft'); // past the row's start: back to the menu
    await expect(grid).toHaveCount(0);
    await expect(m.getByRole('menuitem', { name: 'Highlight' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await expect(grid.getByRole('menuitemradio', { name: 'Blue' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.nb-prose mark[data-color="blue"]')).toHaveText('dentist');
    await expect(editor(page)).toBeFocused();

    // Esc closes it with nothing changed, and focus is back in the text; so does Tab.
    await page.keyboard.press('ContextMenu');
    await expect(m).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    expect(problems).toEqual([]);
  });

  test('text color, clear formatting, block color, and turn into', async ({ page }) => {
    const problems = await open(page);
    await newPage(page, 'Blocks', 'Remember the passport');
    await selectBack(page, 0, 8); // "passport"
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await menu(page, 'Text color').getByRole('menuitemradio', { name: 'Rose' }).click();
    const colored = page.locator('.nb-prose [data-text-color="rose"]');
    await expect(colored).toHaveText('passport');
    expect(await colored.evaluate((el) => getComputedStyle(el).color)).toBe(await paletteRgb(page, 'rose', 'text'));

    // Clear formatting takes bold and the color, and leaves the text.
    await page.keyboard.press('Shift+F10');
    await menu(page, 'Selected text').getByRole('menuitem', { name: 'Clear formatting' }).click();
    await expect(page.locator('.nb-prose [data-text-color]')).toHaveCount(0);
    await expect(page.locator('.nb-prose strong')).toHaveCount(0);
    await expect(page.locator('.nb-prose p').first()).toHaveText('Remember the passport');

    // A caret, no selection: the block's own menu.
    await page.keyboard.press('End');
    const line = page.locator('.nb-prose p', { hasText: 'Remember the passport' });
    const lb = (await line.boundingBox())!;
    await page.mouse.click(lb.x + lb.width - 4, lb.y + lb.height / 2, { button: 'right' });
    const block = menu(page, 'Block');
    await expect(block.getByRole('menuitem', { name: 'Highlight' })).toHaveCount(0);
    await block.getByRole('menuitem', { name: 'Turn into callout' }).click();
    await menu(page, 'Turn into callout').getByRole('menuitemradio', { name: 'Green' }).click();
    await expect(line).toHaveAttribute('data-block-color', 'green');
    expect(await line.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await paletteRgb(page, 'green', 'callout'));

    await page.mouse.click(lb.x + lb.width - 4, lb.y + lb.height / 2, { button: 'right' });
    await block.getByRole('menuitem', { name: 'Block style' }).click();
    await expect(menu(page, 'Block style').getByRole('menuitemradio', { name: 'Body' })).toHaveAttribute('aria-checked', 'true');
    await menu(page, 'Block style').getByRole('menuitemradio', { name: 'Quote' }).click();
    await expect(page.locator('.nb-prose blockquote')).toContainText('Remember the passport');
    expect(problems).toEqual([]);
  });

  test('cut, copy and paste from the menu, and a quiet line when the clipboard is closed to the page', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const problems = await open(page);
    await newPage(page, 'Clipboard', 'one two');
    await selectBack(page, 0, 3); // "two"
    await page.keyboard.press('Shift+F10');
    await menu(page, 'Selected text').getByRole('menuitem', { name: 'Copy' }).click();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' ');
    await page.keyboard.press('Shift+F10');
    await menu(page, 'Block').getByRole('menuitem', { name: 'Paste' }).click();
    await expect(page.locator('.nb-prose p').first()).toHaveText('one two two');
    await selectBack(page, 0, 4); // " two"
    await page.keyboard.press('Shift+F10');
    await menu(page, 'Selected text').getByRole('menuitem', { name: 'Cut' }).click();
    await expect(page.locator('.nb-prose p').first()).toHaveText('one two');

    await context.clearPermissions();
    await page.keyboard.press('Shift+F10');
    await menu(page, 'Block').getByRole('menuitem', { name: 'Paste' }).click();
    await expect(page.getByRole('status').filter({ hasText: /to paste\.$/ })).toBeVisible();
    await expect(editor(page)).toBeFocused();
    expect(problems).toEqual([]);
  });

  test('a page row: label, rename, duplicate and delete with its confirm', async ({ page }) => {
    const problems = await open(page);
    const lake = row(page, 'Lake weekend');
    await lake.click({ button: 'right' });
    const m = menu(page, 'Page Lake weekend');
    await expect(m.getByRole('menuitem')).toHaveText(['Label', 'Rename', 'Duplicate', 'Delete page']);
    await m.getByRole('menuitem', { name: 'Label' }).click();
    await menu(page, 'Label').getByRole('menuitemradio', { name: 'Rose' }).click();
    await expect(lake.locator('.nb-label-dot')).toHaveAttribute('data-pal', 'rose');
    await expect(lake).toHaveAccessibleName(/Rose label/);
    expect(await lake.locator('.nb-label-dot').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await paletteRgb(page, 'rose', 'label'));
    await expect(lake).toBeFocused(); // focus back on the row

    // The keyboard opens the same menu on a focused row; Rename puts the title line under the caret, selected.
    await lake.focus();
    await page.keyboard.press('Shift+F10');
    await expect(m.getByRole('menuitem', { name: 'Label' })).toBeFocused();
    await page.keyboard.press('r');
    await page.keyboard.press('Enter');
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type('Lake trip');
    await expect(row(page, 'Lake trip')).toBeVisible();
    await settle(page);

    await row(page, 'Lake trip').click({ button: 'right' });
    await menu(page, 'Page Lake trip').getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(row(page, 'Lake trip')).toHaveCount(2);
    await expect(row(page, 'Lake trip').nth(1).locator('.nb-label-dot')).toHaveAttribute('data-pal', 'rose');

    // Delete keeps its confirm, with the safe answer focused.
    await row(page, 'City break ideas').click({ button: 'right' });
    await menu(page, 'Page City break ideas').getByRole('menuitem', { name: 'Delete page' }).click();
    await expect(page.locator('.nb-prose h1')).toHaveText('City break ideas');
    await expect(page.getByRole('button', { name: 'Keep' })).toBeFocused();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row(page, 'City break ideas')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Trash · 1/ })).toBeVisible();

    // A desk too old for labels answers not_found: a quiet line says so, and nothing else changes.
    await page.evaluate(() => {
      const nb = (window as unknown as { __nb: Record<string, unknown> }).__nb;
      nb['setPageLabel'] = () => Promise.reject(Object.assign(new Error('not found'), { code: 'not_found' }));
    });
    await row(page, 'Lake trip').first().click({ button: 'right' });
    await menu(page, 'Page Lake trip').getByRole('menuitem', { name: 'Label' }).click();
    await menu(page, 'Label').getByRole('menuitemradio', { name: 'Blue' }).click();
    await expect(page.getByTestId('notebook-notice')).toHaveText('Update your desk to use this.');
    await expect(row(page, 'Lake trip').first().locator('.nb-label-dot')).toHaveAttribute('data-pal', 'rose');

    // Restore refused (someone else trashed it): one quiet line, no retry, and the page stays in Trash.
    await page.evaluate(() => {
      const nb = (window as unknown as { __nb: Record<string, unknown> }).__nb;
      nb['restorePage'] = () => Promise.reject(Object.assign(new Error('refused'), { code: 'forbidden' }));
    });
    await page.getByRole('button', { name: /Trash · 1/ }).click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId('notebook-notice')).toHaveText('Only the person who deleted this page, or a moderator, can restore it.');
    await expect(page.getByRole('button', { name: /Trash · 1/ })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('the page list filters by label (several, and none) and sorts by label, remembered per notebook', async ({ page }) => {
    const problems = await open(page);
    await expect(page.getByTestId('page-filter')).toHaveCount(0); // nothing new until a page has a label
    for (const t of ['Ferry times', 'Camp list', 'Museum hours']) await newPage(page, t, 'Notes');
    await settle(page);
    const label = async (title: string, color: string) => {
      await row(page, title).click({ button: 'right' });
      await menu(page, `Page ${title}`).getByRole('menuitem', { name: 'Label' }).click();
      await menu(page, 'Label').getByRole('menuitemradio', { name: color }).click();
    };
    await label('Lake weekend', 'Rose');
    await label('Camp list', 'Blue');
    await label('City break ideas', 'Rose');
    const titles = page.locator('.nb-pages .nb-page-title');
    const before = await titles.allTextContents();

    await page.getByTestId('page-filter').click();
    const f = menu(page, 'Filter and sort pages');
    await expect(f.getByRole('menuitemradio', { name: 'All pages' })).toHaveAttribute('aria-checked', 'true');
    await f.getByRole('menuitemcheckbox', { name: 'Rose' }).click();
    await expect(f).toBeVisible(); // it stays open to pick more
    await expect(titles).toHaveText(['Lake weekend', 'City break ideas']);
    await f.getByRole('menuitemcheckbox', { name: 'Blue' }).click();
    await expect(titles).toHaveText(before.filter((t) => ['Lake weekend', 'City break ideas', 'Camp list'].includes(t)));
    await f.getByRole('menuitemcheckbox', { name: 'Rose' }).click();
    await f.getByRole('menuitemcheckbox', { name: 'Blue' }).click();
    await f.getByRole('menuitemcheckbox', { name: 'No label' }).click();
    await expect(titles).toHaveText(before.filter((t) => ['Ferry times', 'Museum hours'].includes(t)));
    await expect(page.getByTestId('page-filter-hint')).toContainText('Showing: No label');
    await expect(page.getByTestId('page-filter')).toHaveClass(/\bon\b/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-filter')).toBeFocused();

    // Sort by label: the tabs' color order (blue before rose), the unlabeled last, manual order within each.
    await page.getByTestId('page-filter').click();
    await f.getByRole('menuitemradio', { name: 'All pages' }).click();
    await f.getByRole('menuitemradio', { name: 'By label' }).click();
    await page.keyboard.press('Escape');
    const unlabeled = before.filter((t) => !['Lake weekend', 'City break ideas', 'Camp list'].includes(t));
    await expect(titles).toHaveText(['Camp list', ...before.filter((t) => ['Lake weekend', 'City break ideas'].includes(t)), ...unlabeled]);

    // A filter is remembered in this browser, per notebook.
    await page.getByTestId('page-filter').click();
    await f.getByRole('menuitemcheckbox', { name: 'Rose' }).click();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(titles).toHaveText(['Lake weekend', 'City break ideas']);
    await page.getByRole('button', { name: /^Projects/ }).click();
    await expect(page.getByTestId('page-filter-hint')).toHaveCount(0);
    await page.getByRole('button', { name: /^Personal/ }).click();
    await expect(titles).toHaveText(['Lake weekend', 'City break ideas']);
    await page.getByTestId('page-filter-hint').getByRole('button', { name: 'Show all' }).click();
    await expect(titles).toHaveCount(before.length);
    expect(problems).toEqual([]);
  });
});

test.describe('the Designer\'s menu: preview, the last color, Turn into callout', () => {
  test('a swatch under the pointer previews on the text, and nothing is written until one is chosen', async ({ page }) => {
    const problems = await open(page);
    await newPage(page, 'Preview', 'Try a color here');
    await selectBack(page, 5, 5); // "color"
    const box = await selectionBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await menu(page, 'Selected text').getByRole('menuitem', { name: 'Highlight' }).hover();
    const row = menu(page, 'Highlight');
    await row.getByRole('menuitemradio', { name: 'Rose' }).hover();
    await expect(page.locator('.nb-prose [data-preview-highlight="rose"]')).toHaveText('color');
    expect(await page.locator('.nb-prose [data-preview-highlight="rose"]').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await paletteRgb(page, 'rose', 'highlight'));
    await expect(page.locator('.nb-prose mark')).toHaveCount(0);
    await row.getByRole('menuitemradio', { name: 'Green' }).hover();
    await expect(page.locator('.nb-prose [data-preview-highlight="green"]')).toHaveText('color');
    await expect(page.locator('.nb-prose [data-preview-highlight="rose"]')).toHaveCount(0);
    // Text color and callout preview the same way.
    await menu(page, 'Selected text').getByRole('menuitem', { name: 'Text color' }).hover();
    await menu(page, 'Text color').getByRole('menuitemradio', { name: 'Violet' }).hover();
    await expect(page.locator('.nb-prose [data-preview-text="violet"]')).toHaveText('color');
    await menu(page, 'Selected text').getByRole('menuitem', { name: 'Turn into callout' }).hover();
    await expect(page.locator('.nb-prose p[data-preview-callout="amber"]')).toHaveText('Try a color here'); // the last color: amber, the default
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.nb-prose [data-preview-highlight], .nb-prose [data-preview-text], .nb-prose [data-preview-callout]')).toHaveCount(0);
    await expect(page.locator('.nb-prose mark, .nb-prose [data-text-color], .nb-prose [data-block-color]')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('the last color used: rows start on it, Turn into callout uses it at once, and it is remembered', async ({ page }) => {
    const problems = await open(page);
    await newPage(page, 'Last color', 'Pick violet here');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Then a callout');
    await page.keyboard.press('ArrowUp');
    await selectBack(page, 5, 6); // "violet"
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('Enter');
    await menu(page, 'Highlight').getByRole('menuitemradio', { name: 'Violet' }).click();
    await expect(page.locator('.nb-prose mark[data-color="violet"]')).toHaveText('violet');

    // Turn into callout: one Enter makes the block a callout in Violet, and shows the row to change it, on Violet.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+F10');
    const block = menu(page, 'Block');
    await expect(block.getByRole('menuitem', { name: 'Turn into callout' })).toBeFocused();
    await page.keyboard.press('Enter');
    const callout = page.locator('.nb-prose p', { hasText: 'Then a callout' });
    await expect(callout).toHaveAttribute('data-block-color', 'violet');
    const row = menu(page, 'Turn into callout');
    await expect(row.getByRole('menuitemradio', { name: 'Violet' })).toHaveAttribute('aria-checked', 'true');
    await expect(row.getByRole('menuitemradio', { name: 'Violet' })).toBeFocused();
    await page.keyboard.press('Escape'); // back to the menu
    await page.keyboard.press('Enter'); // the block is a callout already: Enter only opens the row
    await expect(callout).toHaveAttribute('data-block-color', 'violet');
    await row.getByRole('menuitemradio', { name: 'Green' }).click();
    await expect(callout).toHaveAttribute('data-block-color', 'green');

    // Green is now the last color; a new selection's highlight row starts there, after a reload too.
    await page.reload();
    await expect(editor(page)).toBeVisible();
    await page.locator('.nb-prose p', { hasText: 'Pick violet here' }).click();
    await selectBack(page, 0, 4); // "here"
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('Enter');
    await expect(menu(page, 'Highlight').getByRole('menuitemradio', { name: 'Green' })).toBeFocused();
    expect(problems).toEqual([]);
  });
});

test.describe('in each theme', () => {
  for (const name of THEMES) {
    test(`${name}: colors applied match the palette, and the menus and list look intended`, async ({ page }) => {
      const problems = await open(page);
      await theme(page, name);
      const id = name.toLowerCase();
      await newPage(page, `${name} colors`, 'Highlight this and color that');
      await page.keyboard.press('Enter');
      await page.keyboard.type('A callout for the key thing');
      await page.keyboard.press('ArrowUp');
      await selectBack(page, 15, 4); // "this"
      await page.keyboard.press('Shift+F10');
      await page.keyboard.press('Enter');
      await menu(page, 'Highlight').getByRole('menuitemradio', { name: 'Amber' }).click();
      await selectBack(page, 0, 4); // "that"
      await page.keyboard.press('Shift+F10');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await menu(page, 'Text color').getByRole('menuitemradio', { name: 'Blue' }).click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Shift+F10');
      await menu(page, 'Block').getByRole('menuitem', { name: 'Turn into callout' }).click();
      await menu(page, 'Turn into callout').getByRole('menuitemradio', { name: 'Green' }).click();

      const mark = page.locator('.nb-prose mark[data-color="amber"]');
      await expect(mark).toHaveText('this');
      expect(await mark.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await paletteRgb(page, 'amber', 'highlight'));
      const text = page.locator('.nb-prose [data-text-color="blue"]');
      expect(await text.evaluate((el) => getComputedStyle(el).color)).toBe(await paletteRgb(page, 'blue', 'text'));
      const callout = page.locator('.nb-prose [data-block-color="green"]');
      await expect(callout).toHaveText('A callout for the key thing');
      expect(await callout.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await paletteRgb(page, 'green', 'callout'));
      // The Notebook wears its own scheme, "Paper and ink": its window and its side column.
      const ink = NOTEBOOK_SCHEME[id as 'light' | 'dusk' | 'dark'];
      expect(await page.locator('.ma-nb').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb(ink.window));
      expect(await page.locator('.nb-side').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(rgb(ink.sidebar));

      await row(page, 'Lake weekend').click({ button: 'right' });
      await menu(page, 'Page Lake weekend').getByRole('menuitem', { name: 'Label' }).click();
      await menu(page, 'Label').getByRole('menuitemradio', { name: 'Rose' }).click();
      await row(page, `${name} colors`).click({ button: 'right' });
      await menu(page, `Page ${name} colors`).getByRole('menuitem', { name: 'Label' }).click();
      await menu(page, 'Label').getByRole('menuitemradio', { name: 'Violet' }).click();
      await shot(page, `${id}-page-and-labels`, page.locator('.demo-window'));

      // The menus open, for a look: the selection's menu with its highlight grid, and the filter.
      await page.locator('.nb-prose mark').click();
      await selectBack(page, 15, 4);
      await page.keyboard.press('Shift+F10');
      await page.keyboard.press('Enter');
      await expect(menu(page, 'Highlight')).toBeVisible();
      await shot(page, `${id}-highlight-menu`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.getByTestId('page-filter').click();
      await menu(page, 'Filter and sort pages').getByRole('menuitemcheckbox', { name: 'Rose' }).click();
      await shot(page, `${id}-filter-menu`);
      await page.keyboard.press('Escape');
      await expect(page.locator('.nb-pages .nb-page-title')).toHaveText(['Lake weekend']);
      expect(problems).toEqual([]);
    });
  }
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  async function longPress(page: Page, x: number, y: number): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  for (const name of THEMES) {
    test(`${name}: a long press on a page row opens its menu below or above the row, never over it`, async ({ page }) => {
      const problems = await open(page);
      await theme(page, name);
      const lake = row(page, 'Lake weekend');
      await lake.scrollIntoViewIfNeeded();
      const rb = (await lake.boundingBox())!;
      await longPress(page, rb.x + rb.width / 2, rb.y + rb.height / 2);
      const m = menu(page, 'Page Lake weekend');
      await expect(m).toBeVisible();
      expect(overlap((await m.boundingBox())!, rb)).toBe(false);
      // Lifting the finger chose nothing, and didn't open the page under it either.
      await page.waitForTimeout(300);
      await expect(m).toBeVisible();
      await m.getByRole('menuitem', { name: 'Label' }).tap();
      // On a phone a submenu opens in place, with Back.
      const grid = menu(page, 'Label');
      await expect(grid.getByRole('menuitem', { name: /^Back/ })).toBeVisible();
      expect(overlap((await grid.boundingBox())!, rb)).toBe(false);
      await shot(page, `${name.toLowerCase()}-phone-label-menu`);
      await grid.getByRole('menuitemradio', { name: 'Blue' }).tap();
      await expect(lake.locator('.nb-label-dot')).toHaveAttribute('data-pal', 'blue');
      expect(problems).toEqual([]);
    });
  }

  test('a long press on selected text: the menu stays clear of the selection', async ({ page }) => {
    const problems = await open(page);
    await page.getByTestId('new-page').tap();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type('Phone');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Bring the charger and the cable');
    await selectBack(page, 14, 7); // "charger"
    const sel = await selectionBox(page);
    await longPress(page, sel.x + sel.width / 2, sel.y + sel.height / 2);
    const m = menu(page, 'Selected text');
    await expect(m).toBeVisible();
    const now = await selectionBox(page); // the browser may have selected the word under the finger itself
    expect(overlap((await m.boundingBox())!, now)).toBe(false);
    expect(overlap((await m.boundingBox())!, sel)).toBe(false);
    await shot(page, 'light-phone-selection-menu');
    await m.getByRole('menuitem', { name: 'Highlight' }).tap();
    await menu(page, 'Highlight').getByRole('menuitemradio', { name: 'Green' }).tap();
    await expect(page.locator('.nb-prose mark[data-color="green"]')).toContainText('charger');
    expect(problems).toEqual([]);
  });
});
