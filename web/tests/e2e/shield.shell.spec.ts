// What reaches the member, in the desk view (the focus shield; `src/maiamode/shield/`, deskd API.md §23): on the mock desk with
// `?shield`, where `maiamode/mockSource.ts`'s `startMockReach` stands in for the home desk. The held line beside the account menu,
// still and DOM only; a card sliding from under it, its one thing first; the one thing opening its window on the desk; "Back to …"
// in the line's place; a tap restoring the windows as they were, with the ready-to-resume line; Hold everything; What reaches you;
// To-do as a sheet with All held; a phone with no sideways scroll. No console error throughout.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const PATH = '/?fixture=one&shield=1';

const group = (page: Page, desk: string): Locator => page.getByRole('group', { name: `${desk} desk` });
const tile = (page: Page, desk: string, app: string): Locator => group(page, desk).getByRole('button', { name: new RegExp(`^${app}`) });
const windowOf = (page: Page, app: string): Locator => page.getByRole('dialog', { name: new RegExp(app) });
const mock = (page: Page, call: string): Promise<void> => page.evaluate((c) => (window as unknown as Record<string, Record<string, () => void>>)['__maShieldMock']![c]!(), call);
const log = (page: Page): Promise<{ method: string; params: Record<string, unknown> }[]> =>
  page.evaluate(() => (window as unknown as { __maShieldMock: { log: { method: string; params: Record<string, unknown> }[] } }).__maShieldMock.log);

async function arrive(page: Page, request: Parameters<typeof harness>[0]): Promise<string[]> {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  await signIn(page, PATH);
  await canvasPainted(page);
  await expect(page.getByTestId('shield-line')).toBeVisible();
  return errors;
}

test('the held line, a card, its one thing, and Back to the windows as they were', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const line = page.getByTestId('shield-line');
  await expect(line).toContainText('6 held · nothing urgent');
  // Still: no animation on the line, and its dot only when the desk says so.
  expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await expect(line.locator('.sh-dot')).toHaveCount(0);

  // The member is working in Notebook.
  await tile(page, 'Personal', 'Notebook').focus();
  await page.keyboard.press('Enter');
  const notebook = windowOf(page, 'Notebook');
  await expect(notebook).toBeVisible();

  // A card slides from under the line: the one thing first, at most 360 px wide, said politely.
  await mock(page, 'card');
  const card = page.getByTestId('shield-card');
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.width).toBeLessThanOrEqual(360);
  await expect(card).toContainText('Writer needs your OK to send the newsletter.');
  await expect(card.getByRole('button').filter({ hasText: /^Review$/ })).toHaveClass(/primary/);
  await expect(card.locator('[role="status"][aria-live="polite"]')).toHaveCount(1);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);

  // Its one thing opens where it lives: the desk's Agent window.
  await card.getByRole('button', { name: /^Review:/ }).click();
  await expect(card).toHaveCount(0);
  await expect(windowOf(page, 'Agent')).toBeVisible();
  expect((await log(page)).some((c) => c.method === 'agent.maia.reach.answer' && c.params['answer'] === 'go')).toBe(true);

  // The desk says it's done: "Back to …" in the line's place; a tap puts the windows back and says where the member was.
  await expect(line).toHaveAttribute('data-kind', 'back', { timeout: 5_000 });
  await expect(line).toContainText('Back to Q3 plan');
  await line.getByRole('button', { name: /Back to Q3 plan/ }).click();
  await expect(windowOf(page, 'Agent')).toHaveCount(0);
  await expect(notebook).toBeVisible();
  await expect(page.getByTestId('shield-resume')).toContainText('You were on Q3 plan in Notebook');
  expect((await log(page)).find((c) => c.method === 'agent.maia.reach.back')?.params).toMatchObject({ taken: true });
  await expect(line).toContainText('6 held · nothing urgent');
  await expect(page.getByTestId('shield-resume')).toHaveCount(0, { timeout: 7_000 });
  expect(errors).toEqual([]);
});

test('Hold everything, What reaches you, and To-do as a sheet with All held', async ({ page, request }) => {
  const errors = await arrive(page, request);
  const line = page.getByTestId('shield-line');

  // The menu, by keyboard: Hold everything for 30 min.
  await page.getByRole('button', { name: 'Held line options' }).click();
  await expect(page.getByRole('menu', { name: 'Held line options' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'For 30 min' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(line).toContainText('Holding until');
  await expect(line).toContainText('your list still gets through');
  expect((await log(page)).find((c) => c.method === 'agent.maia.reach.hold')?.params).toEqual({ minutes: 30 });

  // What reaches you: the list, and a change goes to the home desk.
  await page.getByRole('button', { name: 'Held line options' }).click();
  await page.getByRole('menuitem', { name: 'What reaches you' }).click();
  const settings = page.getByRole('dialog', { name: 'What reaches you' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('switch', { name: 'Anything due today' })).toBeChecked();
  await expect(settings.getByText('Rosa')).toBeVisible();
  await settings.getByRole('switch', { name: 'Family' }).click({ force: true });
  await expect.poll(async () => (await log(page)).filter((c) => c.method === 'agent.maia.reach.set').length).toBe(1);
  const set = (await log(page)).find((c) => c.method === 'agent.maia.reach.set')!.params as { letThrough: { kind: string; group?: string }[] };
  expect(set.letThrough.some((r) => r.kind === 'group' && r.group === 'family')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // To-do as a sheet: what's in it, then All held, newest first by desk, and "Open Maia's room" at its foot.
  await line.getByRole('button', { name: /What’s held for you/ }).click();
  const sheet = page.getByTestId('shield-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Writer wants to send the newsletter');
  await expect(sheet.getByRole('button', { name: 'Open Maia’s room' })).toBeVisible();
  await sheet.getByRole('tab', { name: 'All held' }).click();
  await expect(sheet).toContainText('Scout’s laptop comparison is ready');
  await expect(sheet.getByRole('combobox', { name: 'Desk' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a catch-up under the line, and a phone with no sideways scroll', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await arrive(page, request);
  await mock(page, 'catchup');
  const panel = page.getByTestId('shield-catchup');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Needs you');
  await expect(panel).toContainText('That’s all for now.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(15);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 15);
  // A phone's targets are 44 px.
  for (const b of await panel.getByRole('button').all()) expect(Math.round((await b.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await panel.getByRole('button', { name: /It stays in To-do/ }).click();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('tile badges are still and neutral while it holds things, and keep the accent only where something may break through', async ({ page, request }) => {
  const errors = await arrive(page, request);
  // Each tile's badge look, as the tile drew it (`badgeTone`: plain, calm or accent), by its app.
  const tones = (): Promise<Record<string, string>> =>
    page.evaluate(() => {
      type KNode = { id(): string; findOne(q: string): { getAttr(k: string): unknown } | undefined };
      const stage = (window as unknown as { __maDesk: { camera: { getStage(): { find(q: string): KNode[] } } } }).__maDesk.camera.getStage();
      const out: Record<string, string> = {};
      for (const g of stage.find('Group')) {
        const id = g.id();
        if (!id.startsWith('tile-')) continue;
        const tone = g.findOne('Shape')?.getAttr('badgeTone');
        if (typeof tone === 'string') out[id] = tone;
      }
      return out;
    });
  await expect.poll(async () => Object.keys(await tones()).length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(Object.values(await tones())).not.toContain('plain');
  expect(Object.values(await tones())).not.toContain('accent');
  // Something that may break through waits on Personal's agents: that tile keeps the accent, every other badge stays calm.
  await mock(page, 'accent');
  await expect.poll(async () => (await tones())['tile-d-personal:agent'], { timeout: 10_000 }).toBe('accent');
  expect(Object.entries(await tones()).filter(([k, t]) => t === 'accent' && k !== 'tile-d-personal:agent')).toEqual([]);
  expect(errors).toEqual([]);
});

// The decision tray (deskd API.md §23 "The tray", the tray spec §8): the catch-up's Needs you is the stack, gone through one paper
// at a time; her pick the one primary; a send with no primary until its confirm strip, whose button sleeps 600 ms; Ask for changes
// takes a note and sends it back; Later only where the deadline allows; the tally after the last; a phone with no sideways scroll.
test('the decision tray: Needs you as a stack, answered one paper at a time', async ({ page, request }) => {
  const errors = await arrive(page, request);
  await mock(page, 'tray');
  const panel = page.getByTestId('shield-catchup');
  await expect(panel).toBeVisible();
  const stack = panel.getByTestId('tray-stack');
  await expect(stack).toContainText('Needs you');
  await expect(stack).toContainText('1 of 3');
  let paper = stack.getByTestId('tray-paper');
  await expect(paper).toContainText('Pick a laptop for Dana’s team');
  await expect(paper).toContainText('Maia’s summary');
  await expect(paper.getByRole('button', { name: 'X1 Carbon', exact: true })).toHaveClass(/primary/);
  await expect(paper.locator('.sh-btn.primary')).toHaveCount(1);
  await expect(paper.getByPlaceholder('Reply to Scout…')).toBeVisible();
  // A material opens beside it, inside the office (never another app), and closes with Esc.
  await paper.getByRole('button', { name: 'Comparison' }).click();
  await expect(page.getByTestId('tray-material')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tray-material')).toHaveCount(0);

  await paper.getByRole('button', { name: 'X1 Carbon', exact: true }).click();
  await expect(stack.getByTestId('tray-filed').first()).toContainText('X1 Carbon');
  await expect(stack).toContainText('2 of 3');
  expect((await log(page)).find((c) => c.method === 'agent.maia.tray.answer')?.params).toMatchObject({ answerId: 'a1' });

  // Writer's send: no primary on its first tap. Ask for changes takes a note and sends it back.
  paper = stack.getByTestId('tray-paper');
  await expect(paper).toContainText('Send the Acme proposal to Sam Lee');
  await expect(paper).toContainText('Sends outside your desk');
  await expect(paper.locator('.sh-btn.primary')).toHaveCount(0);
  // A paper that just rose waits a moment before it takes a tap (§5).
  await expect(paper.getByRole('button', { name: 'Ask for changes' })).not.toHaveAttribute('aria-disabled', 'true');
  await paper.getByRole('button', { name: 'Ask for changes' }).click();
  await paper.getByLabel('Note for Writer').fill('Keep the v2 intro.');
  await paper.getByRole('button', { name: 'Send back to Writer' }).click();
  await expect(stack).toContainText('3 of 3');
  expect((await log(page)).filter((c) => c.method === 'agent.maia.tray.answer')[1]?.params).toMatchObject({ answerId: 'revise', text: 'Keep the v2 intro.' });

  // The newsletter: no Later (its deadline doesn't allow one); Approve… turns into the confirm strip, asleep for 600 ms.
  paper = stack.getByTestId('tray-paper');
  await expect(paper).toContainText('Send the November newsletter');
  await expect(paper.getByRole('button', { name: 'Later' })).toHaveCount(0);
  await expect(paper.getByRole('button', { name: 'Approve…' })).not.toHaveAttribute('aria-disabled', 'true');
  await paper.getByRole('button', { name: 'Approve…' }).click();
  const confirm = paper.getByTestId('tray-confirm');
  await expect(confirm).toHaveText('Send it');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await confirm.click({ force: true });
  expect((await log(page)).filter((c) => c.method === 'agent.maia.tray.answer')).toHaveLength(2);
  await expect(confirm).toHaveAttribute('aria-disabled', 'false');
  await expect(confirm).toBeFocused();
  await confirm.click();
  await expect(stack).toContainText('3 answered');
  // Approve names the payload it showed: its hash, from the work desk's approval (Security's TRAY-M1).
  expect((await log(page)).filter((c) => c.method === 'agent.maia.tray.answer')[2]?.params).toMatchObject({ answerId: 'approve', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(errors).toEqual([]);
});

test('the decision tray: Later, To-do’s Needs you, and a phone with no sideways scroll', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await arrive(page, request);
  await mock(page, 'tray');
  const stack = page.getByTestId('shield-catchup').getByTestId('tray-stack');
  await expect(stack).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const paper = stack.getByTestId('tray-paper');
  const pick = paper.getByRole('button', { name: 'X1 Carbon', exact: true });
  expect((await pick.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await paper.getByRole('button', { name: 'Later' }).click();
  await expect(stack).toContainText('Send the Acme proposal to Sam Lee');
  expect((await log(page)).find((c) => c.method === 'agent.maia.tray.later')).toBeTruthy();
  // A material on a phone rises as a sheet with the paper's answers docked in its foot.
  await stack.getByTestId('tray-paper').getByRole('button', { name: 'Proposal v3', exact: true }).click();
  const sheet = page.getByTestId('tray-material');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Ask for changes' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await sheet.getByRole('button', { name: 'Close' }).first().click();
  await expect(sheet).toHaveCount(0);
  // To-do as a sheet starts with Needs you: one row a paper, and a row's tap opens that paper there.
  await page.getByTestId('shield-catchup').getByRole('button', { name: /It stays in To-do/ }).click();
  await page.getByTestId('shield-line').getByRole('button', { name: /What’s held for you/ }).click();
  const needs = page.getByTestId('shield-sheet').getByTestId('tray-needs');
  await expect(needs).toContainText('Needs you');
  await expect(needs).toContainText('Send the Acme proposal to Sam Lee');
  await needs.getByRole('button', { name: /Send the Acme proposal/ }).click();
  await expect(page.getByTestId('shield-sheet').getByTestId('tray-paper')).toContainText('Sends outside your desk');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

// Quick reply (the owner, Nov 15): a person's message, answered right where it is. The reply arrow is the way in ("Reply to …"),
// R on a focused card and a drag down are shortcuts; the field opens focused with their last message quoted; Cmd/Ctrl+Enter
// sends; no second confirm, but 5 s of "Sent to … · Undo" first, and an Undo sends nothing. It goes through that desk's Courier.
const courierRpc = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __maDeskMock: { rpc: { m: string }[] } }).__maDeskMock.rpc.map((r) => r.m).filter((m) => m.startsWith('courier.draft.save') || m === 'courier.send'));

async function arriveCourier(page: Page, request: Parameters<typeof harness>[0]): Promise<string[]> {
  const errors = watchConsole(page);
  // A reset takes nothing else with it: Courier's switch comes after.
  await harness(request, { reset: true });
  await harness(request, { configExtra: { courier: { enabled: true } } });
  await signIn(page, PATH);
  await canvasPainted(page);
  await expect(page.getByTestId('shield-line')).toBeVisible();
  return errors;
}

test('quick reply on a card: the reply arrow, the quoted message, Undo, and a send through Courier with no Back', async ({ page, request }) => {
  const errors = await arriveCourier(page, request);
  await mock(page, 'message');
  const card = page.getByTestId('shield-card');
  await expect(card).toBeVisible();
  const arrow = card.getByRole('button', { name: /^Reply to / });
  await expect(arrow).toBeVisible();
  await arrow.click();
  const qr = card.getByTestId('quick-reply');
  await expect(qr).toBeVisible();
  await expect(qr.locator('.sh-qr-quote')).not.toBeEmpty();
  const box = qr.getByRole('textbox');
  await expect(box).toBeFocused();
  // Esc closes it; R on the focused card opens it again.
  await page.keyboard.press('Escape');
  await expect(qr).toHaveCount(0);
  await card.getByRole('button', { name: 'Open' }).focus();
  await page.keyboard.press('r');
  await expect(card.getByTestId('quick-reply').getByRole('textbox')).toBeFocused();
  // Send, then Undo inside the 5 s: nothing goes, and the words are back to edit.
  await page.keyboard.type('Raised beds are perfect, thank you.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(card.getByTestId('quick-reply-held')).toContainText('Sent to');
  await card.getByTestId('quick-reply-held').getByRole('button', { name: 'Undo' }).click();
  await expect(card.getByTestId('quick-reply').getByRole('textbox')).toHaveValue('Raised beds are perfect, thank you.');
  expect(await courierRpc(page)).toEqual([]);
  // Send for real: after the hold it goes through that desk's Courier, the card goes, and no Back.
  await card.getByTestId('quick-reply-send').click();
  await expect(card.getByTestId('quick-reply-held')).toBeVisible();
  await expect.poll(() => courierRpc(page), { timeout: 9_000 }).toEqual(['courier.draft.save', 'courier.send']);
  await expect(page.getByTestId('shield-card')).toHaveCount(0);
  expect((await log(page)).find((c) => c.method === 'agent.maia.reach.answer' && c.params['answer'] === 'replied')).toBeTruthy();
  await expect(page.getByTestId('shield-line')).not.toHaveAttribute('data-kind', 'back');
  expect(errors).toEqual([]);
});

test('quick reply on a person’s paper and a held row; a drag down opens it too', async ({ page, request }) => {
  const errors = await arriveCourier(page, request);
  await mock(page, 'tray');
  const stack = page.getByTestId('shield-catchup').getByTestId('tray-stack');
  await expect(stack).toContainText('1 of 4');
  // Go through to the person's paper (each paper that rises waits a moment before it takes a tap).
  const paper = stack.getByTestId('tray-paper');
  const tapWhenAwake = async (title: string, button: string): Promise<void> => {
    await expect(paper).toContainText(title);
    const b = paper.getByRole('button', { name: button, exact: true });
    await expect(b).not.toHaveAttribute('aria-disabled', 'true');
    await b.click();
  };
  await tapWhenAwake('Pick a laptop', 'Later');
  await tapWhenAwake('Send the Acme proposal', 'Later');
  await tapWhenAwake('Send the November newsletter', 'Decline');
  await expect(paper).toContainText('is waiting on your reply');
  // A drag down on the paper's head opens the reply (a shortcut; the arrow is the way in).
  const head = paper.locator('.sh-paper-head');
  const b = (await head.boundingBox())!;
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2 + 30, { steps: 4 });
  await page.mouse.move(b.x + 40, b.y + b.height / 2 + 80, { steps: 6 });
  await page.mouse.up();
  const qr = paper.getByTestId('quick-reply');
  await expect(qr).toBeVisible();
  await qr.getByRole('textbox').fill('Yes, Friday works.');
  await qr.getByTestId('quick-reply-send').click();
  await expect(paper.getByTestId('quick-reply-held')).toContainText('Sent to');
  await expect.poll(() => courierRpc(page), { timeout: 9_000 }).toEqual(['courier.draft.save', 'courier.send']);
  await expect(stack).toContainText(/2 answered/);
  expect((await log(page)).filter((c) => c.method === 'agent.maia.tray.answer').map((c) => c.params['answerId'])).toContain('reply');

  // A held row in All held: its own reply arrow.
  await page.getByTestId('shield-catchup').getByRole('button', { name: /It stays in To-do/ }).click();
  await page.getByTestId('shield-line').getByRole('button', { name: /What’s held for you/ }).click();
  const sheet = page.getByTestId('shield-sheet');
  await sheet.getByRole('tab', { name: 'All held' }).click();
  await sheet.getByRole('button', { name: /^Reply to / }).click();
  await expect(sheet.getByTestId('quick-reply').getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet.getByTestId('quick-reply')).toHaveCount(0);
  expect(errors).toEqual([]);
});
