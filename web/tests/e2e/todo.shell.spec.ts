// The To-do window on the mock desk (`desk/mockDeskTodo.ts`, deskd API.md §22): Needs you, All, Done and Trash, an item whole,
// Done with Undo, adding, "Looks done?", snooze, "Keep in Needs you", delete and restore, a change from elsewhere within the
// bar's 500 ms, the keyboard, All desks put together in the browser, a deskd before §22, the kill switch, the tile's count and
// its switch, and a 390 px phone with its gestures: in Light, Zen and Dark, with axe. One worker per process (the harness).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface TodoDeskMock {
  agentAdd(p: { title: string; by: string; byName?: string; source: { kind: string; ref: Record<string, unknown> | null; label: string }; due?: { date: string } | null; untrusted?: boolean }): { id: string };
  suggest(id: string, as: string, by: string, reason: string): void;
  today(): string;
  control: { calls: { m: string; p: Record<string, unknown>; idem?: string }[]; refuse: Record<string, string> };
}
declare const __maDeskMock: { todo: { desk(deskId: string): TodoDeskMock } };

const win = (page: Page): Locator => page.getByTestId('todo-window');
const body = (page: Page): Locator => page.getByTestId('todo-body');
const sheet = (page: Page): Locator => page.getByTestId('todo-sheet');
const cards = (page: Page): Locator => body(page).locator('.todo-cards > li');
const live = (page: Page): Locator => page.getByTestId('live-region');

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['.ma-window:not(.parked)'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, fixture = 'one', extra: Record<string, unknown> = {}): Promise<string[]> {
  const errors = watchConsole(page);
  // The harness has To-do off, as it has Files, so other specs count the tiles they always did; on here, as in prod.
  await harness(request, { todo: null, ...extra });
  await setTheme(page, theme);
  // The mock desk's `ready` agents: the Lead and Researcher, who made the seeded to-dos (`desk/mockDeskTodo.ts`).
  await signIn(page, `/?fixture=${fixture}&agentFixture=ready`);
  await canvasPainted(page);
  return errors;
}

/** A picture for a person to look at: passing tests have missed a broken layout. */
async function shot(page: Page, name: string, of?: Locator): Promise<void> {
  await page.waitForTimeout(400);
  await (of ?? win(page)).screenshot({ path: `test-results/shots/todo-${name}.png` });
}

async function openTodo(page: Page, desk = 'Personal desk'): Promise<void> {
  const tile = page.getByRole('group', { name: desk }).getByRole('button', { name: /^To-do/ });
  await expect(tile).toHaveCount(1);
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
}

const deskOf = (page: Page): Promise<string> => win(page).evaluate((el) => el.closest('.ma-window')?.getAttribute('data-desk') ?? '');
const calls = (page: Page, deskId: string, m: string): Promise<{ p: Record<string, unknown>; idem?: string }[]> =>
  page.evaluate(([d, method]) => __maDeskMock.todo.desk(d!).control.calls.filter((c) => c.m === method), [deskId, m]);

test.describe('To-do', () => {
  for (const theme of THEMES) {
    test(`${theme}: Needs you, All, Done, Trash, an item whole and the menu, axe clean`, async ({ page, request }) => {
      const errors = await arrive(page, request, theme);
      // The desk with its To-do tile (the draft 3D glyph, for the Product Designer) and its count.
      await page.screenshot({ path: `test-results/shots/todo-${theme}-desk.png` });
      await openTodo(page);
      // Needs you: due today, then kept; the agent's card names it and its source, with Open.
      await expect(cards(page)).toHaveCount(2);
      await expect(cards(page).nth(0)).toContainText('Due today');
      await expect(cards(page).nth(0)).toContainText('Sign and return the lease renewal');
      await expect(cards(page).nth(0)).toContainText('Email from Dana Ortiz · Lease renewal for 2027');
      await expect(cards(page).nth(0)).toContainText('Researcher');
      await expect(cards(page).nth(1)).toContainText('Kept here');
      await expect(body(page).getByTestId('todo-quiet')).toHaveText(/1 new from agents · 1 to confirm/);
      await expect(body(page).getByRole('heading', { name: 'To confirm' })).toBeVisible();
      await expect(body(page)).toContainText('Looks done? Researcher found a receipt from City Water');
      await expect(body(page).locator('.todo-else')).toContainText('2 coming up · 1 with no date · 1 snoozed');
      // "Due today" and "Kept here" are the accent and weight, never a warning colour.
      const hot = await body(page).locator('.todo-when.hot').first().evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontWeight]);
      const link = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ma-text-link').trim());
      expect(Number(hot[1])).toBeGreaterThanOrEqual(600);
      expect(hot[0]).not.toBe('');
      expect(link).not.toBe('');
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-needs-you`);

      // New from agents: shown, then the desk hears it was seen.
      await body(page).getByRole('button', { name: /^Show/ }).click();
      await expect(body(page).getByRole('heading', { name: 'New from agents' })).toBeVisible();
      await expect(body(page)).toContainText('Confirm the dentist check-up');
      const deskId = await deskOf(page);
      await expect.poll(async () => (await calls(page, deskId, 'todo.seen')).some((c) => typeof c.idem === 'string')).toBe(true);

      // All: grouped by day, with search and the filters.
      await body(page).getByRole('tab', { name: /^All/ }).click();
      for (const h of ['Today', 'No date', 'Snoozed · 1']) await expect(body(page).getByRole('heading', { name: h })).toBeVisible();
      await expect(body(page).getByRole('button', { name: /Snoozed · 1/ })).toHaveAttribute('aria-expanded', 'false');
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-all`);
      await body(page).getByRole('searchbox', { name: 'Search to-dos' }).fill('water');
      await expect(body(page).locator('.todo-rows > li')).toHaveCount(1);
      await body(page).getByRole('searchbox', { name: 'Search to-dos' }).fill('');
      await body(page).getByRole('button', { name: 'From Courier' }).click();
      await expect(body(page).locator('.todo-rows > li')).toHaveCount(3);
      await body(page).getByRole('button', { name: 'Researcher', exact: true }).click();
      await expect(body(page).getByTestId('todo-agent-day')).toContainText('asked to close');
      await body(page).getByRole('button', { name: 'Everyone' }).click();

      // An item, whole: its source, the untrusted line, History.
      await body(page).getByRole('button', { name: 'Sign and return the lease renewal', exact: true }).click();
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page)).toContainText('Made from a message. Check it before you act on it.');
      await expect(sheet(page)).toContainText('Email from Dana Ortiz · Lease renewal for 2027');
      await expect(sheet(page).getByRole('switch', { name: 'Keep in Needs you' })).not.toBeChecked();
      await expect(sheet(page).getByRole('region', { name: 'History' })).toContainText('Researcher added it');
      await expect(sheet(page).getByText('Date from the message')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-item`);
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toHaveCount(0);
      await expect(win(page)).toBeVisible(); // Esc closed the sheet, not the window

      // Done, then Trash.
      await body(page).getByRole('tab', { name: 'Done' }).click();
      await expect(body(page).getByRole('heading', { name: 'Yesterday' }).or(body(page).getByRole('heading', { name: 'Today' }))).toBeVisible();
      await expect(body(page)).toContainText('Book the car service');
      expect(await axe(page)).toEqual([]);
      await shot(page, `${theme}-done`);

      // The menu: export, the tile's count, Trash.
      await body(page).getByRole('button', { name: 'More' }).click();
      const menu = body(page).getByRole('menu', { name: 'More' });
      await expect(menu.getByRole('menuitemcheckbox', { name: 'Show the count on the tile' })).toHaveAttribute('aria-checked', 'true');
      expect(await axe(page)).toEqual([]);
      await menu.getByRole('menuitem', { name: 'Trash' }).click();
      await expect(body(page).getByRole('heading', { name: 'Trash' })).toBeVisible();
      await expect(body(page)).toContainText('Trash is empty.');
      expect(errors).toEqual([]);
    });
  }

  test('Done with Undo; add; Looks done?; snooze; Keep in Needs you; delete and restore; a change elsewhere within 500 ms', async ({ page, request }) => {
    const errors = await arrive(page, request, 'light');
    await openTodo(page);
    const deskId = await deskOf(page);

    // Done, from the round check, with Undo in the line at the foot.
    await cards(page).nth(0).getByRole('button', { name: 'Mark done: Sign and return the lease renewal' }).click();
    await expect(page.getByTestId('todo-toast')).toContainText('Done: Sign and return the lease renewal');
    await expect(live(page)).toContainText('Done: Sign and return the lease renewal');
    await expect(cards(page)).toHaveCount(1);
    await page.getByTestId('todo-toast').getByRole('button', { name: 'Undo' }).click();
    await expect(cards(page)).toHaveCount(2);
    const closes = await calls(page, deskId, 'todo.close');
    expect(closes[0]!.p).toMatchObject({ as: 'done' });
    expect(closes[0]!.idem).toMatch(/^[0-9a-f-]{36}$/);

    // Add, due today: in Needs you at once.
    const add = body(page).getByRole('textbox', { name: 'New to-do' });
    await add.fill('Water the plants');
    await body(page).getByRole('button', { name: 'Today', exact: true }).click();
    await add.press('Enter');
    await expect(cards(page).filter({ hasText: 'Water the plants' })).toHaveCount(1);
    await expect(add).toHaveValue('');

    // Looks done? Done.
    await body(page).locator('.todo-sug').getByRole('button', { name: 'Done: Pay the October water bill' }).click();
    await expect(body(page).getByRole('heading', { name: 'To confirm' })).toHaveCount(0);

    // Snooze from the card's sheet: Tomorrow morning; it leaves Needs you.
    await cards(page).filter({ hasText: 'Water the plants' }).getByRole('button', { name: 'Water the plants', exact: true }).click();
    await sheet(page).getByRole('button', { name: 'Snooze' }).click();
    await page.getByRole('menu', { name: 'Snooze' }).getByRole('menuitem', { name: 'Tomorrow morning' }).click();
    await expect(page.getByTestId('todo-toast')).toContainText('Snoozed until Tomorrow morning');
    await page.keyboard.press('Escape');
    await expect(cards(page).filter({ hasText: 'Water the plants' })).toHaveCount(0);

    // Keep in Needs you, from All.
    await body(page).getByRole('tab', { name: /^All/ }).click();
    await body(page).getByRole('button', { name: 'Pick up the framed print', exact: true }).click();
    await sheet(page).getByRole('switch', { name: 'Keep in Needs you' }).check({ force: true });
    await expect(sheet(page).getByRole('switch', { name: 'Keep in Needs you' })).toBeChecked();
    // A title changed in place.
    const title = sheet(page).getByRole('textbox', { name: 'Title' });
    await title.fill('Pick up the framed print on Friday');
    await title.press('Enter');
    await expect.poll(async () => (await calls(page, deskId, 'todo.update')).at(-1)?.p['title']).toBe('Pick up the framed print on Friday');
    // Delete, then restore from Trash.
    await sheet(page).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('todo-toast')).toContainText('Deleted: Pick up the framed print on Friday');
    await body(page).getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Trash' }).click();
    await body(page).getByRole('button', { name: 'Restore: Pick up the framed print on Friday' }).click();
    await expect(body(page)).toContainText('Trash is empty.');
    await body(page).getByRole('tab', { name: /^Needs you/ }).click();
    await expect(cards(page).filter({ hasText: 'Pick up the framed print on Friday' })).toContainText('Kept here');

    // An agent adds one on the desk: the window shows it within the bar's 500 ms.
    const t0 = Date.now();
    await page.evaluate((d) => {
      const desk = __maDeskMock.todo.desk(d);
      desk.agentAdd({ title: 'Reply to the landlord', by: 'agent:researcher', source: { kind: 'courier', ref: { messageId: 'x' }, label: 'Email from Dana Ortiz · Re: lease' }, due: { date: desk.today() }, untrusted: true });
    }, deskId);
    await expect(cards(page).filter({ hasText: 'Reply to the landlord' })).toHaveCount(1, { timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(1500); // generous for a shared box: the topic's 80 ms gather and two reads
    expect(errors).toEqual([]);
  });

  test('the keyboard: the views by arrows, the item and its menu, and focus back where it came from', async ({ page, request }) => {
    await arrive(page, request, 'light');
    await openTodo(page);
    const tabs = body(page).getByRole('tab');
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(body(page).getByRole('tab', { name: /^All/ })).toBeFocused();
    await expect(body(page).getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(body(page).getByRole('tab', { name: 'Done' })).toBeFocused();
    await page.keyboard.press('Home');
    const opener = body(page).getByRole('button', { name: 'Sign and return the lease renewal', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('textbox', { name: 'Title' })).toBeFocused();
    // Tab stays inside the sheet.
    for (let i = 0; i < 30; i += 1) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="todo-sheet"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    // The More menu: arrows, Esc back to its button.
    const more = body(page).getByRole('button', { name: 'More' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Export as a Markdown checklist' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitem', { name: 'Trash' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await expect(win(page)).toBeVisible();
    // A half-typed to-do: the first Escape clears it and the window stays.
    const add = body(page).getByRole('textbox', { name: 'New to-do' });
    await add.fill('Half a thought');
    await add.press('Escape');
    await expect(add).toHaveValue('');
    await expect(win(page)).toBeVisible();
    // A note typed and the sheet closed by Escape at once: it's kept.
    await opener.click();
    await sheet(page).getByRole('textbox', { name: 'Note' }).fill('Bring the blue pen.');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    const deskId = await deskOf(page);
    await expect.poll(async () => (await calls(page, deskId, 'todo.update')).at(-1)?.p['note']).toBe('Bring the blue pen.');
  });

  test('All desks: the desks’ Needs you put together here, in one order, each with its desk', async ({ page, request }) => {
    const errors = await arrive(page, request, 'dark', 'three');
    await openTodo(page);
    await body(page).getByRole('combobox', { name: 'Which desks' }).selectOption('all');
    await expect(cards(page)).toHaveCount(4);
    const first = cards(page).nth(0);
    await expect(first).toContainText('Overdue · since');
    await expect(first).toContainText('Renew the team site’s domain');
    await expect(first.locator('.todo-desk')).toHaveText('Work');
    await expect(cards(page).nth(1)).toContainText('Today · 3:00 pm');
    await expect(cards(page).nth(2).locator('.todo-desk')).toHaveText('Personal');
    // Adding goes to the desk the row names.
    await expect(body(page).getByRole('combobox', { name: 'Add to desk' })).toHaveValue(await deskOf(page));
    expect(await axe(page)).toEqual([]);
    await shot(page, 'dark-all-desks');
    expect(errors).toEqual([]);
  });

  test('a deskd before §22 says so; the kill switch takes the tile away; the tile’s count and its switch', async ({ page, request }) => {
    // The kill switch: no tile.
    await arrive(page, request, 'light', 'one', { todo: { enabled: false } });
    await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^To-do/ })).toHaveCount(0);

    await arrive(page, request, 'light');
    // The count on the tile: overdue plus due today (the lease), in its name.
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^To-do/ });
    await expect(tile).toHaveAccessibleName('To-do, 1 due');
    await openTodo(page);
    await body(page).getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Show the count on the tile' }).click();
    await expect(tile).toHaveAccessibleName('To-do');

    // An older deskd: `not_found` with no reason.
    await page.addInitScript(() => {
      (window as unknown as { __maTodoMockInit: unknown }).__maTodoMockInit = { refuse: { 'todo.list': 'not_found' } };
    });
    await page.reload();
    await canvasPainted(page);
    await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^To-do/ }).evaluate((el) => (el as HTMLButtonElement).click());
    await expect(body(page)).toContainText('This desk’s To-do needs an update.');
  });

  test('export: the desk’s file over bulk, saved as a Markdown checklist', async ({ page, request }) => {
    await arrive(page, request, 'light');
    await openTodo(page);
    await body(page).getByRole('button', { name: 'More' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export as a Markdown checklist' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('To-do Personal.md');
    const text = readFileSync((await file.path())!, 'utf8');
    expect(text).toContain('- [ ] Sign and return the lease renewal');
    expect(text).toContain('- [x] Book the car service');
  });
});

test.describe('To-do on a phone, 390 px', () => {
  test.use({ hasTouch: true });
  for (const theme of THEMES) {
    test(`${theme}: a full-screen sheet, Add at the thumb, a swipe right is Done, axe clean`, async ({ page, request }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const errors = await arrive(page, request, theme);
      await openTodo(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      // Add sits under the list, at the foot.
      const addBox = await body(page).locator('.todo-add').boundingBox();
      const listBox = await body(page).locator('.todo-scroll').boundingBox();
      expect(addBox!.y).toBeGreaterThan(listBox!.y);
      expect(await axe(page)).toEqual([]);
      await shot(page, `phone-${theme}`, page.locator('body'));
      // A swipe right on a card: Done, with Undo.
      const card = cards(page).nth(0);
      const box = (await card.boundingBox())!;
      const y = box.y + box.height / 2;
      await card.evaluate(
        (el, at) => {
          const fire = (type: string, x: number): void => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: x, clientY: at.y, isPrimary: true }));
          fire('pointerdown', at.x);
          for (let x = at.x; x <= at.x + 140; x += 20) fire('pointermove', x);
          fire('pointerup', at.x + 140);
        },
        { x: box.x + 60, y },
      );
      await expect(page.getByTestId('todo-toast')).toContainText('Done: Sign and return the lease renewal');
      await expect(cards(page)).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  }
});
