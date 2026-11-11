// Support Maia in the office (src/maia/, contract maia.md), against the harness's fake Maia on this same origin.
// The gate, opening and hiding her, a whole turn with a card, her memory, a stop, her Markdown, and her avatar.
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, themeRadio, watchConsole, type ThemeId } from './helpers';

const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

interface Turn {
  conversationId: string | null;
  message: string;
  clientContext: Record<string, unknown>;
}
interface Harness {
  log: string[];
  maiaTurns: Turn[];
  maiaDecisions: { proposalId: string; decision: string; result: string | null; errorCode: string | null }[];
  maiaMemories: { memoryId: string; kind: string; text: string }[];
}
interface Stats {
  frames: number;
  steps: number;
  state: string;
  paused: boolean;
  scores: number;
}

const read = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const maiaLog = async (request: APIRequestContext): Promise<string[]> => (await read(request)).log.filter((l) => l.includes('/v1/maia'));
const stats = (page: Page): Promise<Stats> => page.evaluate(() => (window as unknown as { __maMaia: { stats: () => Stats } }).__maMaia.stats());

const launcher = (page: Page): Locator => page.locator('.maia-launcher');
const panel = (page: Page): Locator => page.getByRole('dialog', { name: /^(Maia|What Maia remembers|Your chats)$/ });
const composer = (page: Page): Locator => page.getByRole('textbox', { name: 'Message to Maia' });

/** Signed in, with Maia on, her bubble showing. */
async function arrive(page: Page, request: APIRequestContext, path = '/?fixture=three', maia: Record<string, unknown> = { enabled: true }): Promise<void> {
  await harness(request, { maia });
  await signIn(page, path);
  await canvasPainted(page);
  await expect(launcher(page)).toBeVisible();
}

async function openPanel(page: Page): Promise<void> {
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(composer(page)).toBeFocused();
}

/** Sends, and waits for her answer to finish. */
async function ask(page: Page, text: string): Promise<void> {
  // Her stub can answer faster than a poll sees Send's disabled state, so wait on what stays: her message is in, then the turn is done.
  const sent = (await page.locator('.maia-me').count()) + 1;
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(page.locator('.maia-me')).toHaveCount(sent);
  await expect(page.locator('.maia-msg[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'false', { timeout: 10_000 });
}

const lastReply = (page: Page): Locator => page.locator('.maia-her').last();

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('the gate', () => {
  test("no maia block, as in prod: nothing of her, and no request to any Maia route, in the test build too", async ({ page, request }) => {
    const chunks: string[] = [];
    page.on('request', (r) => {
      if (/maia/i.test(r.url())) chunks.push(r.url());
    });
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-testid="maia"]')).toHaveCount(0);
    expect(chunks).toEqual([]);
    expect(await maiaLog(request)).toEqual([]);
  });

  test('a block, but her state says enabled: false: no widget, and her chunk never loads', async ({ page, request }) => {
    const chunks: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('MaiaWidget')) chunks.push(r.url());
    });
    await harness(request, { maia: { enabled: false } });
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await expect.poll(async () => (await maiaLog(request)).length).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(new Set(await maiaLog(request))).toEqual(new Set(['GET /v1/maia/state']));
    await expect(page.locator('[data-testid="maia"]')).toHaveCount(0);
    expect(chunks).toEqual([]);
  });

  test('her state failing means no widget either', async ({ page, request }) => {
    await harness(request, { maia: { enabled: true, stateStatus: 503 } });
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    await expect.poll(async () => (await maiaLog(request)).length).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(new Set(await maiaLog(request))).toEqual(new Set(['GET /v1/maia/state']));
    await expect(page.locator('[data-testid="maia"]')).toHaveCount(0);
  });
});

test('open, hide and open again: focus moves in and back, Esc hides, and the office keeps its view', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await expect(launcher(page)).toHaveAccessibleName('Maia, AI assistant');
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
  // Only her state was asked for (once per page load: signing in loads two), until she's opened.
  expect(new Set(await maiaLog(request))).toEqual(new Set(['GET /v1/maia/state']));

  await openPanel(page);
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'true');
  // Two lines, no more (the owner, Nov 9), and the days are the server's.
  await expect(panel(page).locator('.maia-head .maia-sub')).toHaveText([
    'Ask about your desks, your account, or your office. I can be wrong.',
    'Chats are kept 30 days and pass through us, so keep private things with your desk agents.',
  ]);
  await expect(panel(page)).not.toContainText('She can be wrong');
  await expect(panel(page)).not.toContainText('how your office works');
  await expect(panel(page).locator('.maia-model')).toHaveText('Claude Opus 5.5');

  // The hide control.
  await panel(page).getByRole('button', { name: 'Hide Maia' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(launcher(page)).toBeFocused();

  // From the keyboard: Enter opens, Esc hides, and the office's own Esc (back to the overview) doesn't fire.
  const zoomBefore = await page.locator('.zoom-label').textContent();
  await launcher(page).press('Enter');
  await expect(composer(page)).toBeFocused();
  await composer(page).type(']0[');
  await composer(page).press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(launcher(page)).toBeFocused();
  expect(await page.locator('.zoom-label').textContent()).toBe(zoomBefore);

  // A draft outlasts hiding her.
  await launcher(page).click();
  await composer(page).fill('half a thought');
  await panel(page).getByRole('button', { name: 'Hide Maia' }).click();
  await launcher(page).click();
  await expect(composer(page)).toHaveValue('half a thought');
  await composer(page).fill('');

  // Open is remembered in this tab.
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  expect(errors).toEqual([]);
});

test('the info circle after "pass through us": a press, a tap or keyboard focus opens it, Esc closes it alone (the owner, Nov 10)', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);
  const circle = panel(page).getByRole('button', { name: 'How Maia keeps chats' });
  const tip = panel(page).getByTestId('maia-kept-tip');
  // In the line, right after "pass through us", and the line's words are as they were.
  await expect(panel(page).getByTestId('maia-kept')).toHaveText('Chats are kept 30 days and pass through us, so keep private things with your desk agents.');
  expect(await panel(page).getByTestId('maia-kept').evaluate((p) => p.firstChild?.textContent)).toBe('Chats are kept 30 days and pass through us');
  await expect(circle).toHaveAttribute('aria-expanded', 'false');
  await expect(tip).toBeHidden();

  // A press opens it: the server's days, what's kept and why, and nothing trains a model.
  await circle.click();
  await expect(circle).toHaveAttribute('aria-expanded', 'true');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveAttribute('role', 'status');
  await expect(tip).toContainText('Nothing you send through Maia is used to train AI models.');
  await expect(tip).toContainText('We keep chats for 30 days');
  await expect(tip).toContainText('We never keep files you attach: your chat keeps only their names.');
  expect(await circle.getAttribute('aria-controls')).toBe(await tip.getAttribute('id'));
  // It sits inside the panel.
  const [pb, tb] = await Promise.all([panel(page).boundingBox(), tip.boundingBox()]);
  expect(tb!.x).toBeGreaterThanOrEqual(pb!.x);
  expect(tb!.x + tb!.width).toBeLessThanOrEqual(pb!.x + pb!.width + 0.5);
  expect(tb!.y + tb!.height).toBeLessThanOrEqual(pb!.y + pb!.height + 0.5);

  // Esc closes the tip and leaves Maia open; a second Esc hides her as before.
  await circle.press('Escape');
  await expect(tip).toBeHidden();
  await expect(circle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page)).toBeVisible();

  // A press again toggles it; a press elsewhere closes it.
  await circle.click();
  await expect(tip).toBeVisible();
  await circle.click();
  await expect(tip).toBeHidden();
  await circle.click();
  await expect(tip).toBeVisible();
  await composer(page).click();
  await expect(tip).toBeHidden();

  // From the keyboard: focus opens it, and moving on closes it.
  await composer(page).focus();
  await circle.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(circle).toBeFocused();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(tip).toBeHidden();
  expect(errors).toEqual([]);
});

test("Your chats: every chat listed, newest first; open one to go back to it; delete one, or the open one, for good (Security's maia-2)", async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);
  await ask(page, 'What is a desk?');
  await panel(page).getByRole('button', { name: 'New chat' }).click();
  await ask(page, 'How do guilds work?');

  const chatsButton = panel(page).getByRole('button', { name: 'Your chats' });
  await chatsButton.click();
  await expect(panel(page).getByRole('heading', { name: 'Your chats' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Back to the chat' })).toBeFocused();
  await expect(panel(page).locator('.maia-head .maia-sub')).toHaveText('Chats are kept 30 days. Open one to go back to it, or delete it sooner.');
  const rows = panel(page).locator('.maia-chat-open');
  await expect(rows).toHaveCount(2);
  // Newest first, and the open one says so.
  await expect(rows.nth(0)).toContainText('How do guilds work?');
  await expect(rows.nth(0)).toContainText('Open now');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(rows.nth(1)).toContainText('What is a desk?');

  // Back returns to the control that opened it.
  await panel(page).getByRole('button', { name: 'Back to the chat' }).click();
  await expect(chatsButton).toBeFocused();

  // Open the older chat: it's the chat now, as she kept it, and the composer has focus.
  await chatsButton.click();
  await rows.nth(1).click();
  await expect(panel(page).getByRole('heading', { name: 'Maia' })).toBeVisible();
  await expect(composer(page)).toBeFocused();
  await expect(page.locator('.maia-me')).toHaveText(['What is a desk?']);
  // The next message goes on in that chat.
  const before = (await read(request)).maiaTurns.length;
  await ask(page, 'And a guild desk?');
  const turns = (await read(request)).maiaTurns;
  expect(turns.length).toBe(before + 1);
  const kept = (await (await request.get('/__harness')).json()).maiaConversations as Record<string, { title: string }>;
  const deskChat = Object.entries(kept).find(([, c]) => c.title === 'What is a desk?')?.[0];
  expect(deskChat).toBeTruthy();
  expect(turns.at(-1)!.conversationId).toBe(deskChat);

  // Delete the other one: it's gone from the list and the server, and focus moves on.
  await chatsButton.click();
  await expect(rows).toHaveCount(2);
  await panel(page).getByRole('button', { name: 'Delete "How do guilds work?"' }).click();
  await expect(rows).toHaveCount(1);
  await expect(panel(page).getByRole('button', { name: 'Delete "What is a desk?"' })).toBeFocused();
  expect(Object.values((await (await request.get('/__harness')).json()).maiaConversations ?? {}).length).toBe(1);

  // Delete the open one: the chat empties and the list says there's nothing.
  await panel(page).getByRole('button', { name: 'Delete "What is a desk?"' }).click();
  await expect(panel(page)).toContainText('No chats yet.');
  await panel(page).getByRole('button', { name: 'Back to the chat' }).click();
  await expect(page.locator('.maia-me')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a whole turn: she thinks, speaks, plays her score, offers a card, and the card does what the office does', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request, '/?fixture=three', { enabled: true, slow: 60 });
  await openPanel(page);

  await composer(page).fill('Can you open my work desk? [stub:status] [stub:desk:d-work]');
  await composer(page).press('Enter');
  // The composer won't send again while she answers.
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.maia-status')).toHaveText('Looking that up…');
  await expect.poll(async () => (await stats(page)).state).toMatch(/thinking|speaking/);
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'false', { timeout: 10_000 });

  const reply = lastReply(page);
  await expect(reply.locator('strong')).toHaveText('a short answer');
  // Her score, for this reply, after done.
  await expect.poll(async () => (await stats(page)).scores).toBe(1);
  // The live region heard her.
  await expect(page.locator('.maia [role="status"][aria-live="polite"]')).toContainText('a short answer');

  const card = reply.getByRole('group', { name: 'Open your Work desk' });
  await expect(card).toContainText("This starts it if it's stopped.");
  await card.getByRole('button', { name: 'Open' }).click();
  await expect(card).toContainText('Opening it.');
  await expect(page.locator('.desk-nav-label')).toContainText('Work');
  await expect.poll(async () => (await read(request)).maiaDecisions).toEqual([expect.objectContaining({ decision: 'confirmed', result: 'ok', errorCode: null })]);

  // The privacy promise: exactly what the contract lists, and the route now says desk.
  await ask(page, 'And now?');
  const turns = (await read(request)).maiaTurns;
  expect(turns).toHaveLength(2);
  for (const t of turns) {
    expect(Object.keys(t).sort()).toEqual(['clientContext', 'conversationId', 'message']);
    expect(Object.keys(t.clientContext).sort()).toEqual(['appVersion', 'lastErrorCode', 'route', 'surface']);
    expect(t.clientContext['surface']).toBe('office');
    expect(t.clientContext['appVersion']).toMatch(/^[0-9A-Za-z._-]{1,40}$/);
    expect(t.clientContext['lastErrorCode']).toBeNull();
  }
  expect(turns[0]!.conversationId).toBeNull();
  expect(turns[0]!.clientContext['route']).toBe('home');
  expect(turns[1]!.conversationId).toBe('c_harness1');
  expect(turns[1]!.clientContext['route']).toBe('desk');

  // Declining reports that, and nothing else happens.
  await ask(page, 'Show me my account [stub:page:account]');
  const pageCard = lastReply(page).getByRole('group', { name: 'Open your account page' });
  await expect(pageCard.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://platform.localhost/account');
  await expect(pageCard.getByRole('link', { name: 'Open' })).toHaveAttribute('target', '_blank');
  await pageCard.getByRole('button', { name: 'Not now' }).click();
  await expect(pageCard).toContainText('Not now.');
  await expect.poll(async () => (await read(request)).maiaDecisions.at(-1)).toMatchObject({ decision: 'declined', result: null, errorCode: null });

  // A new chat starts with no conversation.
  await panel(page).getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.maia-her')).toHaveCount(0);
  await ask(page, 'Hello again');
  expect((await read(request)).maiaTurns.at(-1)!.conversationId).toBeNull();
  expect(errors).toEqual([]);
});

test('remember: confirmed, then in What Maia remembers, then deleted; and forget everything', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);

  await ask(page, 'I like short answers [stub:remember:preference]');
  const card = lastReply(page).getByRole('group', { name: 'Remember this?' });
  await expect(card.locator('.maia-card-label')).toHaveText('How you like answers');
  await expect(card.locator('blockquote')).toHaveText('Short answers, with the steps in a list.');
  await card.getByRole('button', { name: 'Remember' }).click();
  await expect(card).toContainText('Remembered.');
  // The decision is the save: no other call.
  const after = await read(request);
  expect(after.maiaMemories).toHaveLength(1);
  expect(after.maiaDecisions).toEqual([expect.objectContaining({ decision: 'confirmed', result: null, errorCode: null })]);
  expect(after.log.filter((l) => l.startsWith('POST /v1/maia/') && !l.endsWith('/turn'))).toHaveLength(1);
  // Pressing again says it was answered.
  await expect(card.getByRole('button', { name: 'Remember' })).toHaveCount(0);

  await panel(page).getByRole('button', { name: 'What Maia remembers' }).click();
  await expect(panel(page)).toHaveAccessibleName('What Maia remembers');
  await expect(panel(page).getByRole('button', { name: 'Back to the chat' })).toBeFocused();
  const item = page.locator('.maia-mem');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('How you like answers');
  await expect(item).toContainText('Short answers, with the steps in a list.');
  await item.getByRole('button', { name: /^Delete/ }).click();
  await expect(item).toHaveCount(0);
  await expect(panel(page)).toContainText('Nothing yet.');
  expect((await read(request)).maiaMemories).toEqual([]);

  // Two more, then forget everything, with a confirm first.
  await panel(page).getByRole('button', { name: 'Back to the chat' }).click();
  for (const kind of ['setup', 'how_to_help']) {
    await ask(page, `Remember [stub:remember:${kind}]`);
    await lastReply(page).getByRole('button', { name: 'Remember' }).click();
    await expect(lastReply(page)).toContainText('Remembered.');
  }
  // A forget card shows the text from the app's own list, not hers.
  const [first] = (await read(request)).maiaMemories;
  await ask(page, `Forget that [stub:forget:${first!.memoryId}] [stub:forget:mem_gone]`);
  await expect(lastReply(page).getByRole('group', { name: 'Forget this?' }).locator('blockquote')).toHaveText('Short answers, with the steps in a list.');
  await expect(lastReply(page).getByRole('group', { name: "That's already gone." }).getByRole('button')).toHaveCount(0);

  await panel(page).getByRole('button', { name: 'What Maia remembers' }).click();
  await expect(page.locator('.maia-mem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Forget everything' }).click();
  await expect(panel(page)).toContainText("Forget everything Maia remembers? This can't be undone.");
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.maia-mem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Forget everything' }).click();
  await page.locator('.maia-confirm').getByRole('button', { name: 'Forget everything' }).click();
  await expect(page.locator('.maia-mem')).toHaveCount(0);
  expect((await read(request)).maiaMemories).toEqual([]);
  expect((await read(request)).log).toContain('DELETE /v1/maia/memories');
  expect(errors).toEqual([]);
});

test("memory cards say each refusal plainly, and an expired card offers nothing", async ({ page, request }) => {
  await arrive(page, request, '/?fixture=three', { enabled: true, rememberText: 'My password is hunter2' });
  await openPanel(page);
  await ask(page, 'Remember this [stub:remember:setup]');
  await lastReply(page).getByRole('button', { name: 'Remember' }).click();
  await expect(lastReply(page)).toContainText("That looks private, so it wasn't saved. Keep private things with your desk agents.");

  await harness(request, { maia: { enabled: true, memory: false } });
  await ask(page, 'Remember [stub:remember:preference]');
  await lastReply(page).getByRole('button', { name: 'Remember' }).click();
  await expect(lastReply(page)).toContainText('Memory is off now, so nothing changed.');

  await harness(request, { maia: { enabled: true, maxItems: 0 } });
  await ask(page, 'Remember [stub:remember:preference]');
  await lastReply(page).getByRole('button', { name: 'Remember' }).click();
  await expect(lastReply(page)).toContainText("Maia's memory is full.");

  await ask(page, 'Too late [stub:expired]');
  await expect(lastReply(page)).toContainText('This suggestion has expired.');
  await expect(lastReply(page).getByRole('group', { name: 'Remember this?' }).getByRole('button')).toHaveCount(0);
});

test('a stop: her text shown exactly as it came, never as Markdown or markup, and she looks unavailable', async ({ page, request }) => {
  await arrive(page, request);
  await openPanel(page);
  await ask(page, 'Do something you won\'t [stub:refusal]');
  const stop = lastReply(page).locator('.maia-stop');
  await expect(stop).toHaveText("I can't help with that one. <b>Not bold</b> **not Markdown** [not a link](https://minimalistalliance.com/)");
  await expect(lastReply(page).locator('b, strong, a')).toHaveCount(0);
  await expect.poll(async () => (await stats(page)).state).toBe('unavailable');
  // The composer opens again on stop.
  await expect(page.locator('.maia-send')).toHaveAttribute('aria-disabled', 'false');
});

test('free Maia (ma-platform ADR 0104): the notice once, with Upgrade; a quiet line while it lasts; busy as it came; and back again', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);
  const free = page.getByTestId('maia-free');
  await expect(free).toHaveCount(0);
  await expect(page.locator('.maia-model')).toBeVisible();

  await ask(page, 'Help me with my desk [stub:free]');
  const note = page.locator('.maia-note');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("you're on free Maia until it resets in about 3 hours. It's a bit slower and simpler.");
  const upgrade = note.getByRole('link', { name: 'Upgrade' });
  await expect(upgrade).toHaveAttribute('href', 'https://platform.localhost/account');
  await expect(upgrade).toHaveAttribute('target', '_blank');
  await expect(free).toHaveText(/^Free Maia until \S/);
  // Nothing in the panel names what answers while she's on it.
  await expect(page.locator('.maia-model')).toHaveCount(0);
  await expect(panel(page)).not.toContainText(/Claude|Opus|Gemma|Qwen|llama/i);

  // The next turn stays on it, with no second notice.
  await ask(page, 'And one more thing');
  await expect(note).toHaveCount(1);
  await expect(free).toBeVisible();
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await page.screenshot({ path: `test-results/shots/maia-free-${theme}.png` });
  }

  // Busy: her stop text, exactly as it came; the line stays, since she's still on it.
  await ask(page, 'Again [stub:free-busy]');
  await expect(lastReply(page).locator('.maia-stop')).toHaveText('Free Maia is busy right now. Try again in a minute.');
  await expect(free).toBeVisible();

  // Back on her usual model: the line goes, and a note says so.
  await ask(page, 'Next day [stub:free-ended]');
  await expect(free).toHaveCount(0);
  await expect(note.last()).toHaveText("Your Maia allowance has reset, so you're back to full Maia.");
  await expect(note.last().getByRole('link')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('free Maia is slow to start: a calm thinking line until her first words, then her answer, and she thinks meanwhile', async ({ page, request }) => {
  await arrive(page, request, '/?fixture=three', { enabled: true, freeFirstMs: 2500 });
  await openPanel(page);
  await composer(page).fill('Help me [stub:free]');
  await composer(page).press('Enter');
  const waiting = page.locator('.maia-msg[aria-busy="true"] .maia-status');
  await expect(waiting).toHaveText('Free Maia is thinking. This can take a minute.');
  await expect(page.locator('.maia-dots')).toHaveCount(0);
  await expect.poll(async () => (await stats(page)).state).toBe('thinking');
  await expect(lastReply(page).locator('.maia-md')).toContainText('You asked: Help me.', { timeout: 10_000 });
  await expect(page.locator('.maia-status')).toHaveCount(0);
  await expect(page.locator('.maia-msg[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(panel(page)).not.toContainText(/Gemma|Qwen|llama/i);
});

test('free Maia on arrival: her state says it is on, so the line shows before any turn', async ({ page, request }) => {
  await arrive(page, request, '/?fixture=three', { enabled: true, freeUntil: new Date(Date.now() + 5 * 3_600_000).toISOString() });
  await openPanel(page);
  await expect(page.getByTestId('maia-free')).toHaveText(/^Free Maia until \S/);
  await expect(page.locator('.maia-model')).toHaveCount(0);
});

test('free Maia with no higher tier: the notice offers no Upgrade', async ({ page, request }) => {
  await arrive(page, request, '/?fixture=three', { enabled: true, freeUpgrade: false });
  await openPanel(page);
  await ask(page, 'Help [stub:free]');
  await expect(page.locator('.maia-note')).toContainText("you're on free Maia");
  await expect(page.locator('.maia-note').getByRole('link')).toHaveCount(0);
});

test('her Markdown: the subset renders, and raw HTML, images and other sites never do', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);
  await ask(page, 'Show me everything [stub:markdown]');
  const reply = lastReply(page).locator('.maia-md');
  await expect(reply.locator('h4')).toHaveText('Getting started');
  await expect(reply.locator('strong').first()).toHaveText('bold');
  await expect(reply.locator('em').first()).toHaveText('italic');
  await expect(reply.locator('p code')).toHaveText('inline code');
  await expect(reply.locator('ol > li > ul > li')).toHaveText('then the Browser');
  await expect(reply.locator('pre code')).toHaveText('ssh desk <b>not bold</b>');
  await expect(reply.locator('img, script, b, iframe')).toHaveCount(0);
  await expect(reply).toContainText('<b>raw bold</b>');
  await expect(reply).toContainText('tracking pixel');
  // Links: ours, in a new tab; theirs as plain text.
  const links = reply.locator('a');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', 'https://minimalistalliance.com/privacy');
  await expect(links.nth(0)).toHaveAttribute('target', '_blank');
  await expect(links.nth(1)).toHaveAttribute('href', 'https://minimalistalliance.com/terms');
  await expect(reply).toContainText('Click me (https://evil.example/phish)');
  await page.waitForTimeout(300);
  expect((await read(request)).log.filter((l) => l.includes('__pixel'))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __maiaPwned?: boolean }).__maiaPwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('refusals before a turn starts: a plain line, and her words go back in the composer', async ({ page, request }) => {
  await arrive(page, request);
  await openPanel(page);
  for (const [status, code, line] of [
    [409, 'turn_in_progress', 'Maia is still answering your last message.'],
    [429, 'rate_limited', "That's a lot of messages at once."],
    [503, 'busy', 'Maia is busy right now.'],
  ] as const) {
    await harness(request, { maiaTurnFail: { status, code, times: 1 } });
    await composer(page).fill(`Hello ${code}`);
    await composer(page).press('Enter');
    await expect(page.locator('.maia-line')).toContainText(line);
    await expect(composer(page)).toHaveValue(`Hello ${code}`);
    await expect(page.locator('.maia-me')).toHaveCount(0);
  }
  // An expired chat: the same words start a new one.
  await ask(page, 'First');
  await harness(request, { maiaConversations: {} });
  await ask(page, 'Second');
  await expect(page.locator('.maia-note')).toHaveText('That chat had ended, so this is a new one.');
  const turns = (await read(request)).maiaTurns.slice(-2);
  expect(turns.map((t) => t.conversationId)).toEqual(['c_harness1', null]);
});

test.describe('file attachments', () => {
  const ON = { enabled: true, attachments: true };
  const pdf = (name: string, size = 1200): { name: string; mimeType: string; buffer: Buffer } => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(size, 7) });
  const chips = (page: Page): Locator => page.getByRole('list', { name: 'Attached files' }).first().getByRole('listitem');

  test('off by default: no button, and a drop or paste does nothing', async ({ page, request }) => {
    await arrive(page, request);
    await openPanel(page);
    await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  });

  test('pick, remove, over the caps, send: chips above the box, the files in the turn, then none kept', async ({ page, request }) => {
    await arrive(page, request, '/?fixture=three', ON);
    await openPanel(page);
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
    const input = page.locator('input[type=file]');
    await input.setInputFiles([pdf('report.pdf'), pdf('notes.pdf'), { name: 'bad.exe', mimeType: 'application/x-msdownload', buffer: Buffer.alloc(10) }]);
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).first()).toContainText('report.pdf');
    await expect(page.locator('.maia-attach-line')).toContainText("can't read .exe");
    await expect(composer(page)).toHaveAttribute('placeholder', 'Ask about your file');
    await page.getByRole('button', { name: 'Remove notes.pdf' }).click();
    await expect(chips(page)).toHaveCount(1);
    await input.setInputFiles([pdf('big.pdf', 2_500_000)]);
    await expect(page.locator('.maia-attach-line')).toContainText('big.pdf is over 2 MB.');
    await expect(chips(page)).toHaveCount(1);
    await page.screenshot({ path: 'test-results/shots/maia-attach-chips.png' });
    await ask(page, 'What is this?');
    await expect(page.locator('.maia-me').last()).toContainText('report.pdf');
    await expect(page.locator('.maia-compose .maia-chip')).toHaveCount(0);
    const turns = (await read(request)).maiaTurns as unknown as { attachments?: { name: string; bytes: number }[] }[];
    expect(turns.at(-1)!.attachments).toEqual([{ name: 'report.pdf', type: 'application/pdf', bytes: 1200 }]);
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(stored).not.toContain('report.pdf');
    await expect(page.locator('.maia-attach-line')).toContainText("Maia can't see earlier files");
  });

  test('a rejection puts the words and the files back, and shows the server\'s line', async ({ page, request }) => {
    await arrive(page, request, '/?fixture=three', ON);
    await openPanel(page);
    await page.locator('input[type=file]').setInputFiles([pdf('a.pdf')]);
    await composer(page).fill('Read it [stub:attach-400]');
    await composer(page).press('Enter');
    await expect(page.locator('.maia-line[role=status]').first()).toContainText('That PDF is locked');
    await expect(composer(page)).toHaveValue('Read it [stub:attach-400]');
    await expect(chips(page)).toHaveCount(1);
    await expect(page.locator('.maia-me')).toHaveCount(0);
    await composer(page).fill('Read it [stub:attach-stop]');
    await composer(page).press('Enter');
    await expect(page.locator('.maia-line[role=status]').first()).toContainText('too large');
    await expect(composer(page)).toHaveValue('Read it [stub:attach-stop]');
    await expect(chips(page)).toHaveCount(1);
    await expect(page.locator('.maia-me')).toHaveCount(0);
  });

  test('history shows an Attached line as a chip, and free Maia refuses an image', async ({ page, request }) => {
    await arrive(page, request, '/?fixture=three', ON);
    await openPanel(page);
    await page.locator('input[type=file]').setInputFiles([pdf('a.pdf')]);
    await ask(page, 'Hi');
    await page.reload();
    await canvasPainted(page);
    await expect(panel(page)).toBeVisible();
    await expect(page.locator('.maia-me .maia-chip')).toContainText('a.pdf');
    await expect(page.locator('.maia-me')).not.toContainText('[Attached');
    await ask(page, 'again [stub:free]');
    await page.locator('input[type=file]').setInputFiles([{ name: 'p.png', mimeType: 'image/png', buffer: Buffer.alloc(20, 1) }]);
    await expect(page.locator('.maia-attach-line')).toContainText("Free Maia can't read images.");
    await expect(page.locator('.maia-compose .maia-chip')).toHaveCount(0);
  });
});

test('her avatar: live in her bubble, drawing, hidden from screen readers, and her motion can be paused', async ({ page, request }) => {
  await arrive(page, request);
  const canvas = page.locator('.maia-bubble canvas').first();
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  const box = await canvas.boundingBox();
  expect(box && Math.round(box.width)).toBe(64);
  const a = await stats(page);
  await page.waitForTimeout(1000);
  const b = await stats(page);
  expect(b.frames - a.frames).toBeGreaterThan(20);
  expect(b.state).toBe('score');
  // Her canvas has her on it: some pixels drawn, the rest left clear for the bubble.
  const drawn = await canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n += 1;
    return n / (d.length / 4);
  });
  expect(drawn).toBeGreaterThan(0.05);
  expect(drawn).toBeLessThan(0.8);

  await openPanel(page);
  const pause = panel(page).getByRole('button', { name: "Pause Maia's motion" });
  await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  const c = await stats(page);
  await page.waitForTimeout(800);
  const d = await stats(page);
  expect(d.paused).toBe(true);
  expect(d.frames).toBe(c.frames);
  // It holds across a reload, as a preference.
  await page.reload();
  await expect(launcher(page)).toBeVisible();
  await expect.poll(async () => (await stats(page)).paused).toBe(true);
  await panel(page).getByRole('button', { name: "Pause Maia's motion" }).click();
  await expect.poll(async () => (await stats(page)).paused).toBe(false);
});

test("her dance: a score with routine party dances first, and a routine she doesn't know is ignored", async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);

  // One the contract doesn't name, and one it names that her package doesn't dance yet: each plays as a plain score.
  let played = 0;
  for (const name of ['moonwalk', 'groove']) {
    await ask(page, `Something cheerful [stub:routine:${name}]`);
    played += 1;
    await expect.poll(async () => (await stats(page)).scores).toBe(played);
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      seen.push((await stats(page)).state);
      await page.waitForTimeout(150);
    }
    expect(seen, name).not.toContain('routine');
  }

  // Party, as the server sends it for the owner only: she dances, drawing all the while.
  await ask(page, 'Something cheerful [stub:routine:party]');
  await expect.poll(async () => (await stats(page)).scores).toBe(played + 1);
  await expect.poll(async () => (await stats(page)).state).toBe('routine');
  const a = await stats(page);
  await page.waitForTimeout(1000);
  const b = await stats(page);
  expect(b.state).toBe('routine');
  expect(b.frames - a.frames).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('office activity keeps her awake, and she sleeps only once the whole office is idle (the owner: "Her eyes cannot be closed the whole time!")', async ({ page, request }) => {
  // Real time, at her shortest sleep (30 s): her idle clock and the office's first paint both run on real timers.
  test.setTimeout(150_000);
  await arrive(page, request, '/?fixture=three', { enabled: true, sleepAfterSec: 30 });
  const awake = /^(score|thinking|speaking|waking)$/;
  // Work in the office, never touching her: the pointer moves over the desks every 5 s, for well past her 30 s.
  for (let i = 0; i < 8; i++) {
    await page.mouse.move(700 + i * 7, 420 + (i % 2) * 9);
    await page.waitForTimeout(5_000);
  }
  // A key counts too.
  await page.keyboard.press('Shift');
  await page.waitForTimeout(5_000);
  expect((await stats(page)).state).toMatch(awake);
  // Nobody does anything anywhere: she falls asleep.
  await expect.poll(async () => (await stats(page)).state, { timeout: 45_000, intervals: [2_000] }).toMatch(/^(falling|sleeping)$/);
  // And the office's next input wakes her, without going near her.
  await page.mouse.move(520, 380);
  await expect.poll(async () => (await stats(page)).state, { timeout: 10_000 }).toMatch(/^(waking|score)$/);
});

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const rectOf = (loc: Locator): Promise<Rect> =>
  loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
const apart = (a: Rect, b: Rect): boolean => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
const onScreen = (r: Rect, v: { width: number; height: number }): boolean => r.left >= 0 && r.top >= 0 && r.right <= v.width && r.bottom <= v.height;

/** Everything else on the bottom of the screen that is showing, in screen pixels. */
const NEIGHBOURS = ['.hints', '.desk-nav', '.zoom-ctl', '[data-testid="bandwidth-button"]', '.notice', '.desk-notice', '.office-notice', '.topbar button'];

/**
 * Where she sits: on screen, in the right-most corner, to the right of the bandwidth circle at 1200 px and up (above it
 * on a narrower screen, in the same corner), with the circle absent or there, and nothing of the office under her.
 * Open, her panel is wholly on screen and clear of the circle, the zoom and the desk switch.
 */
async function expectSits(page: Page, v: { width: number; height: number }, open = false): Promise<void> {
  const her = await rectOf(launcher(page));
  expect(onScreen(her, v), 'her bubble is on screen').toBe(true);
  expect(Math.abs(v.width - her.right - (v.width >= 600 ? 32 : 16)), 'in the right-most corner').toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no side scroll').toBe(true);
  const circle = page.getByTestId('bandwidth-button');
  const hasCircle = await circle.isVisible();
  for (const sel of NEIGHBOURS) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      expect(apart(her, await rectOf(el)), `${sel} overlaps Maia`).toBe(true);
    }
  }
  if (hasCircle) {
    const c = await rectOf(circle);
    expect(onScreen(c, v), 'the circle is on screen').toBe(true);
    if (v.width >= 1200) {
      expect(c.right, 'right of the circle').toBeLessThanOrEqual(her.left);
      expect(Math.abs((c.top + c.bottom) / 2 - (her.top + her.bottom) / 2), 'level with the circle').toBeLessThanOrEqual(24);
    } else {
      expect(her.bottom, 'above the circle on a narrower screen').toBeLessThanOrEqual(c.top);
    }
  }
  if (!open) return;
  const sheet = await rectOf(panel(page));
  expect(onScreen(sheet, v), 'her panel is on screen').toBe(true);
  expect(sheet.bottom, 'her panel is above her bubble').toBeLessThanOrEqual(her.top);
  for (const sel of ['.zoom-ctl', '.desk-nav', '[data-testid="bandwidth-button"]']) {
    for (const el of await page.locator(sel).all()) {
      if (!(await el.isVisible())) continue;
      expect(apart(sheet, await rectOf(el)), `her panel overlaps ${sel}`).toBe(true);
    }
  }
}

const THEME_LABEL: Record<ThemeId, string> = { light: 'Light', dusk: 'Zen', dark: 'Dark' };

/** Through the account menu, as a member does, so she has to follow the change live. */
async function pickTheme(page: Page, theme: ThemeId): Promise<void> {
  await page.getByRole('button', { name: 'Account' }).click();
  await themeRadio(page, THEME_LABEL[theme]).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#account-panel')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // At phone width the top bar is wider than the screen, and opening the account menu scrolls the office sideways
  // (it does without Maia too). Put it back, so the picture shows what a member sees.
  await page.evaluate(() => {
    document.querySelector('.ma-shell')!.scrollLeft = 0;
  });
  await page.waitForTimeout(300);
}

async function shootAll(browser: Browser, request: APIRequestContext, name: string, viewport: { width: number; height: number }, path: string, desks?: string, bandwidth?: 404): Promise<void> {
  const context = await browser.newContext({ viewport, baseURL: test.info().project.use.baseURL, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = watchConsole(page);
  try {
    await harness(request, { reset: true });
    await harness(request, { maia: { enabled: true }, ...(desks ? { desks } : {}), ...(bandwidth ? { bandwidth } : {}) });
    await signIn(page, path);
    if (desks !== 'empty') await canvasPainted(page);
    await expect(launcher(page)).toBeVisible();
    for (const theme of THEMES) {
      await pickTheme(page, theme);
      await expectSits(page, viewport);
      await page.screenshot({ path: `test-results/shots/maia-${name}-collapsed-${theme}.png` });
    }
    await launcher(page).click();
    await ask(page, 'How do I wake my desk? [stub:desk:d-personal] [stub:remember:preference]');
    for (const theme of THEMES) {
      // On a phone her panel is a sheet over the top bar, so it's hidden while the theme changes, then opened again.
      const sheet = viewport.width < 600;
      if (sheet) await panel(page).getByRole('button', { name: 'Hide Maia' }).click();
      await pickTheme(page, theme);
      if (sheet) await launcher(page).click();
      await expect(panel(page).locator('.maia-card')).toHaveCount(2);
      await page.waitForTimeout(300); // her panel's fade in
      await expectSits(page, viewport, true);
      await page.screenshot({ path: `test-results/shots/maia-${name}-open-${theme}.png` });
    }
    // A Platform with no meter answers the bandwidth call with a 404, and a browser logs that by itself.
    expect(bandwidth ? errors.filter((e) => !e.includes('Failed to load resource')) : errors).toEqual([]);
  } finally {
    await context.close();
  }
}

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: 'tablet', width: 820, height: 1000 },
  { name: '375', width: 375, height: 812 },
  { name: '320', width: 320, height: 640 },
];
const CASES = [
  { name: 'one', path: '/?fixture=one', desks: undefined },
  { name: 'three', path: '/?fixture=three', desks: undefined },
  { name: 'none', path: '/', desks: 'empty' },
];

// The right-most corner, to the right of the bandwidth circle, at each size, with one desk, several (the two-row bar on
// a phone) and none (the welcome card), in all three themes, collapsed and open.
test.describe('where she sits, in Light, Zen and Dark', () => {
  test.setTimeout(120_000);
  for (const size of SIZES) {
    for (const c of CASES) {
      test(`${size.name} px, ${c.name} desks`, async ({ browser, request }) =>
        shootAll(browser, request, `${size.name}-${c.name}`, { width: size.width, height: size.height }, c.path, c.desks));
    }
  }
  test('1100 px laptop with three desks', async ({ browser, request }) => shootAll(browser, request, 'laptop-3', { width: 1100, height: 760 }, '/?fixture=three'));
  test('1200 px with three desks, the first width with her in the bar', async ({ browser, request }) => shootAll(browser, request, '1200-3', { width: 1200, height: 800 }, '/?fixture=three'));
  // The circle may be absent (a Platform without a meter): she keeps the corner.
  test('1440 px with no circle', async ({ browser, request }) => shootAll(browser, request, 'nocircle-1440', { width: 1440, height: 900 }, '/?fixture=three', undefined, 404));
  test('375 px with no circle', async ({ browser, request }) => shootAll(browser, request, 'nocircle-375', { width: 375, height: 812 }, '/?fixture=three', undefined, 404));
});

test.describe('how she sits with the rest of the office', () => {
  test('the keyboard reaches her after the circle, where she is on screen, and back', async ({ page, request }) => {
    await arrive(page, request, '/?fixture=three');
    await page.getByTestId('bandwidth-button').focus();
    await page.keyboard.press('Tab');
    await expect(launcher(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('bandwidth-button')).toBeFocused();
  });

  test('the account menu is over her bubble, and a window is over both', async ({ page, request }) => {
    await page.setViewportSize({ width: 375, height: 640 });
    await arrive(page, request, '/');
    const z = (sel: string): Promise<number> => page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).zIndex));
    const bubble = await z('[data-testid="maia"]');
    expect(await z('.topbar'), 'the top bar, which holds the account menu').toBeGreaterThan(bubble);
    await page.getByRole('button', { name: 'Account' }).click();
    const menu = await rectOf(page.locator('#account-panel'));
    const her = await rectOf(launcher(page));
    // Where the menu reaches down to her, it is what is on top of her.
    if (!apart(menu, her)) {
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('#account-panel') !== null, [(Math.max(menu.left, her.left) + Math.min(menu.right, her.right)) / 2, (Math.max(menu.top, her.top) + Math.min(menu.bottom, her.bottom)) / 2]);
      expect(hit).toBe(true);
    }
    await page.keyboard.press('Escape');
    // And over her open panel, which is on the same side: the menu's items are what a click on them reaches.
    await page.setViewportSize({ width: 1024, height: 768 });
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    await page.getByRole('button', { name: 'Account' }).click();
    for (const name of ['System', 'Light', 'Zen', 'Dark']) {
      const r = await rectOf(themeRadio(page, name));
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('#account-panel') !== null, [(r.left + r.right) / 2, (r.top + r.bottom) / 2]);
      expect(top, `${name} is on top of her panel`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await panel(page).getByRole('button', { name: 'Hide Maia' }).click();
    await page.setViewportSize({ width: 375, height: 640 });
    // An open Browser is above her collapsed bubble, as it always was, and on a phone it covers her. On a phone an app opens
    // full screen in its desk's carousel (carousel.phone.shell.spec.ts), which is the window there.
    await page.getByRole('button', { name: /^Browser/ }).first().evaluate((el) => (el as HTMLButtonElement).click());
    await expect(page.getByTestId('browser-chrome')).toBeVisible();
    await page.waitForTimeout(300);
    const sheet = '.carousel-stage.phone';
    expect(await z(sheet), 'a window is above her').toBeGreaterThan(bubble);
    const covered = await page.evaluate(([x, y, sel]) => document.elementFromPoint(Number(x), Number(y))?.closest(String(sel)) !== null, [(her.left + her.right) / 2, (her.top + her.bottom) / 2, sheet]);
    expect(covered, 'the full-screen window covers her bubble').toBe(true);
    await page.screenshot({ path: 'test-results/shots/maia-window-375.png' });
  });
});

test('the first asks: three quiet buttons while the chat is empty, one sends as a turn, and they go; a new chat brings them back', async ({ page, request }) => {
  const errors = watchConsole(page);
  await arrive(page, request);
  await openPanel(page);
  const asks = panel(page).getByTestId('maia-asks');
  await expect(asks).toHaveAccessibleName('Things to ask');
  // Three desks: the Work desk is there, and the adult has an Agent.
  await expect(asks.getByRole('button')).toHaveText(['Show me around my office', 'Open my Work desk', 'How do I give my Agent a key?']);

  await asks.getByRole('button', { name: 'Open my Work desk' }).click();
  await expect(page.locator('.maia-me')).toHaveCount(1);
  await expect(page.locator('.maia-me')).toContainText('Open my Work desk');
  await expect(asks).toHaveCount(0);
  await expect(page.locator('.maia-msg[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(asks).toHaveCount(0);

  await panel(page).getByRole('button', { name: 'New chat' }).click();
  await expect(asks.getByRole('button')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('the first asks on one desk: no Work desk, so no ask to open it', async ({ page, request }) => {
  await arrive(page, request, '/?fixture=one');
  await openPanel(page);
  await expect(panel(page).getByTestId('maia-asks').getByRole('button')).toHaveText(['Show me around my office', 'How do I give my Agent a key?']);
});
