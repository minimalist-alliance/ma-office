// Task 49 in the Agent app, against the mock: a new agent and the desk's cap, the lead's proposals confirmed and declined,
// links with their rules and the messages they allow, a timer, an icon picked and uploaded, the agent-message log, and one
// agent's own window. Screenshots go to test-results/shots/ for a look by eye.
import { expect, open, sendAndWait, test } from './watch';
import type { Page } from '@playwright/test';

const THEMES = ['light', 'dusk', 'dark'] as const;
// A 1 x 1 PNG, and one whose header claims 600 x 600 (its CRC fixed to match).
/** A 16 by 16 plus sign, black on transparent: a real shape for the upload's mask rules. */
const CROSS = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgwA3+o2GSwagBJBiArpBUPBwMoDgQRw2g0AAABnZvkQl1ke4AAAAASUVORK5CYII=', 'base64');
const ONE_PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function sized(px: number): Buffer {
  const b = Buffer.from(ONE_PX);
  b.writeUInt32BE(px, 16);
  b.writeUInt32BE(px, 20);
  b.writeUInt32BE(crc32(b.subarray(12, 29)), 29);
  return b;
}

const settings = (page: Page) => page.getByTestId('settings-panel');

async function openSettings(page: Page, agentId: string): Promise<void> {
  await page.getByTestId(`agent-${agentId}`).click();
  // The drawer stays as it was when another agent is picked, and the tab toggles it.
  if ((await page.getByTestId('tab-settings').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('tab-settings').click();
  await expect(settings(page).getByTestId('settings-about')).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(150);
  await page.screenshot({ path: `test-results/shots/t49-${name}.png` });
}

test('a new agent opens its settings, and the desk\'s cap stops the next, saying so', async ({ page }) => {
  await open(page, 'ready', { agentCap: '3' });
  await expect(page.getByTestId('agent-cap-note')).toHaveCount(0);
  await page.getByTestId('new-agent').click();
  await page.getByTestId('new-agent-name').fill('Scout');
  await page.getByTestId('new-agent-submit').click();
  await expect(page.locator('.ag-head-name')).toHaveText('Scout');
  await expect(page.locator('.ag-head p')).toContainText('Solo');
  await expect(settings(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scout’s settings' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Scout/ })).toBeVisible();
  // Three agents, the lead included, is this desk's cap: "New agent" is off, and says why.
  await expect(page.getByTestId('new-agent')).toBeDisabled();
  await expect(page.getByTestId('agent-cap-note')).toHaveText('This desk has 3 agents, the most it can hold. Delete one to add another.');
  await expect(page.getByTestId('new-agent')).toHaveAttribute('aria-describedby', /.+/);

  // Deleting one makes room again. The lead has no delete.
  await settings(page).getByTestId('agent-delete').click();
  await settings(page).getByTestId('agent-delete-confirm').click();
  await expect(page.getByRole('tab', { name: /Scout/ })).toHaveCount(0);
  await expect(page.getByTestId('new-agent')).toBeEnabled();
  await openSettings(page, 'manager');
  await expect(settings(page).getByTestId('agent-delete')).toHaveCount(0);
});

test('a name the desk already has is refused in words, at create and at rename', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('new-agent').click();
  await page.getByTestId('new-agent-name').fill('Scout');
  await page.getByTestId('new-agent-submit').click();
  await expect(page.locator('.ag-head-name')).toHaveText('Scout');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByTestId('new-agent').click();
  await page.getByTestId('new-agent-name').fill('scout');
  await page.getByTestId('new-agent-submit').click();
  await expect(page.getByTestId('add-agent-form').getByRole('alert')).toHaveText('Another agent on this desk has that name.');
  await page.getByTestId('new-agent-name').fill('Writer');
  await page.getByTestId('new-agent-submit').click();
  await expect(page.locator('.ag-head-name')).toHaveText('Writer');
  await settings(page).getByTestId('settings-name').fill('SCOUT');
  await settings(page).getByTestId('settings-save').click();
  await expect(settings(page).getByTestId('settings-about').getByRole('alert')).toHaveText('Another agent on this desk has that name.');
});

test('the lead proposes two agents: one confirmed and applied exactly as shown, one declined', async ({ page }) => {
  await open(page, 'ready');
  const reply = await sendAndWait(page, 'Set up two agents');
  const cards = reply.getByTestId('proposal');
  await expect(cards).toHaveCount(2);
  const [scout, writer] = [cards.nth(0), cards.nth(1)];
  // Exactly what will change: every field, the timer, and nothing applies yet.
  await expect(scout.getByRole('heading', { level: 4 })).toHaveText('Add the agent “Scout”');
  await expect(scout).toContainText('Compass');
  await expect(scout).toContainText('Teal');
  await expect(scout).toContainText('No, solo');
  await expect(scout).toContainText('50 MB');
  await expect(scout.getByTestId('proposal-timer')).toContainText('Morning brief · Weekdays at 8:00 AM');
  await expect(writer).toContainText('Plum');
  await expect(page.getByRole('tab', { name: /Scout/ })).toHaveCount(0);
  // What it costs, and how to undo it, above the buttons.
  await expect(scout.getByTestId('proposal-note')).toContainText('counts toward its limits');
  await shot(page, 'proposals-pending');

  await scout.getByTestId('proposal-confirm').click();
  await expect(scout.getByTestId('proposal-state')).toContainText('Done');
  // Answered: the card collapses to its header and state, the details under "What it was".
  await expect(scout.getByTestId('proposal-timer')).toBeHidden();
  await scout.getByText('What it was').click();
  await expect(scout.getByTestId('proposal-timer')).toBeVisible();
  await expect(scout).toHaveAttribute('data-state', 'applied');
  await expect(page.getByRole('tab', { name: /Scout/ })).toBeVisible();
  await writer.getByTestId('proposal-decline').click();
  await expect(writer.getByTestId('proposal-state')).toHaveText('Declined');
  await expect(page.getByRole('tab', { name: /Writer/ })).toHaveCount(0);
  await expect(writer.getByTestId('proposal-confirm')).toHaveCount(0);

  // The confirm sent the card's own sha256.
  const answers = await page.evaluate(() => (window as unknown as { __maAgentMock: { calls: { method: string; params: { accept?: boolean } }[] } }).__maAgentMock.calls.filter((c) => c.method === 'agent.proposal.answer').map((c) => c.params.accept));
  expect(answers).toEqual([true, false]);

  // What was made is what the card said.
  await scout.getByRole('button', { name: 'Open Scout' }).click();
  await expect(page.locator('.ag-head-name')).toHaveText('Scout');
  await page.getByTestId('tab-settings').click();
  await expect(settings(page).getByTestId('settings-name')).toHaveValue('Scout');
  await expect(settings(page).getByRole('radio', { name: 'Compass' })).toHaveAttribute('aria-checked', 'true');
  await expect(settings(page).getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
  await expect(settings(page).getByTestId('timer-row')).toContainText('Morning brief');
  await shot(page, 'proposal-applied-settings');
});

test('cards: a change shows old to new and needs its purpose opened, a removal is a danger button, a deleted agent cannot be confirmed', async ({ page }) => {
  await open(page, 'ready');
  const created = await sendAndWait(page, 'Set up two agents');
  await created.getByTestId('proposal-confirm').first().click();
  await expect(created.getByTestId('proposal').first()).toHaveAttribute('data-state', 'applied');

  // A change: the purpose as a diff that has to be opened, the size below what is used warned about, old to new.
  const change = (await sendAndWait(page, 'Change Scout')).getByTestId('proposal');
  await expect(change.getByRole('heading', { level: 4 })).toHaveText('Change Scout');
  await expect(change.getByTestId('proposal-note')).toHaveText('You can change this back in Scout’s settings.');
  await expect(change).toContainText('50 MB');
  await expect(change.getByTestId('proposal-confirm')).toBeDisabled();
  await change.getByText('Read the full change to confirm it').click();
  await expect(change.getByTestId('proposal-diff')).toContainText('keeps notes short');
  await expect(change.getByTestId('proposal-confirm')).toBeEnabled();
  await change.getByTestId('proposal-decline').click();
  await expect(change.getByTestId('proposal-state')).toHaveText('Declined');

  // A removal: the button says what it does, and the card says it cannot be undone.
  const removal = (await sendAndWait(page, 'Remove Scout')).getByTestId('proposal');
  await expect(removal.getByTestId('proposal-note')).toHaveText('This can’t be undone.');
  await expect(removal.getByTestId('proposal-confirm')).toHaveText('Remove Scout');
  await expect(removal.getByTestId('proposal-confirm')).toHaveClass(/danger/);
  await shot(page, 'proposal-removal');

  // Delete Scout by hand: the card has nobody left to remove.
  await openSettings(page, (await page.getByRole('tab', { name: /Scout/ }).getAttribute('data-testid'))!.replace('agent-', ''));
  await settings(page).getByTestId('agent-delete').click();
  await settings(page).getByTestId('agent-delete-confirm').click();
  await page.getByTestId('agent-manager').click();
  await expect(removal.getByTestId('proposal-gone')).toHaveText('Not possible now: that agent was deleted.');
  await expect(removal.getByTestId('proposal-confirm')).toHaveCount(0);
});

test('links with rules: required and counted, then a message goes with them, marked in the thread and in the log', async ({ page }) => {
  await open(page, 'ready');
  await openSettings(page, 'researcher');
  const links = settings(page).getByTestId('links-editor');
  await expect(links.getByRole('switch', { name: /Messages other agents/ })).not.toBeChecked();
  await expect(links.getByText('Off means solo: it messages no other agent. Every new agent starts solo.')).toBeVisible();
  await links.getByText('Messages other agents', { exact: true }).click();
  await links.getByTestId('link-manager').getByRole('checkbox').check();
  await links.getByTestId('links-save').click();
  await expect(links.getByRole('alert')).toHaveText('Write the rules for this pairing.');
  const rules = links.getByTestId('link-rules');
  await rules.fill('Ask only for summaries. Never pass on my notes.');
  await expect(links.getByText('47 / 500')).toBeVisible();
  await expect(rules).toHaveAttribute('maxlength', '500');
  await links.getByTestId('links-save').click();
  await expect(links.getByRole('status')).toHaveText('Saved');
  await expect(page.locator('.ag-head p')).toContainText('Linked');

  // The lead stays solo and still gets the message, and its settings show the rules that bind it, read only.
  await openSettings(page, 'manager');
  const inbound = settings(page).getByTestId('links-inbound');
  await expect(inbound).toContainText('Researcher');
  await expect(inbound).toContainText('Ask only for summaries. Never pass on my notes.');
  await expect(inbound).toContainText('Change in Researcher’s settings.');
  await expect(settings(page).getByRole('switch', { name: /Messages other agents/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Close panel' }).click();

  await page.getByTestId('agent-researcher').click();
  await sendAndWait(page, 'Ask the lead for a summary of today');
  await page.getByTestId('agent-manager').click();
  const from = page.getByTestId('msg-from');
  await expect(from).toContainText('From Researcher');
  await expect(from).toContainText('Ask the lead for a summary of today');
  await from.getByText('Rules for this pairing').click();
  await expect(from.getByTestId('msg-rules')).toContainText('Ask only for summaries. Never pass on my notes.');
  await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');
  await shot(page, 'from-agent');

  // The agent-message log: who to whom, the rules, what came of it, and its cost.
  await page.getByTestId('tab-messages').click();
  const row = page.getByTestId('a2a-row').first();
  await expect(row).toContainText('Researcher → Lead');
  await expect(row.getByTestId('a2a-state')).toContainText('Replied');
  await expect(row.getByTestId('a2a-state')).toContainText('est.');
  await row.getByText('Rules', { exact: true }).click();
  await expect(row.getByTestId('a2a-rules')).toHaveText('Ask only for summaries. Never pass on my notes.');
  await page.getByTestId('a2a-all').click();
  await expect(page.getByTestId('a2a-row')).toHaveCount(1);
  await shot(page, 'agent-messages');
});

test('a message a limit stops reads "Stopped", in plain words, with no depth count', async ({ page }) => {
  await open(page, 'ready', { a2aPerHour: '1' });
  await openSettings(page, 'researcher');
  const links = settings(page).getByTestId('links-editor');
  await links.getByText('Messages other agents', { exact: true }).click();
  await links.getByTestId('link-manager').getByRole('checkbox').check();
  await links.getByTestId('link-rules').fill('Ask only for summaries.');
  await expect(links.getByTestId('links-scope')).toContainText('its own workspace only');
  // A paste past the most is cut by the field, and the field says so.
  await links.getByTestId('link-rules').evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'x'.repeat(600));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(links.getByTestId('link-cut')).toHaveText('Cut to 500 characters.');
  await links.getByTestId('link-rules').fill('Ask only for short summaries.');
  await expect(links.getByTestId('link-cut')).toHaveCount(0);
  await links.getByTestId('links-save').click();
  await expect(links.getByRole('status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByTestId('agent-researcher').click();
  await sendAndWait(page, 'Ask the lead for a summary');
  await sendAndWait(page, 'Ask the lead for another summary');
  await page.getByTestId('tab-messages').click();
  const stopped = page.getByTestId('a2a-state').filter({ hasText: 'Stopped' });
  await expect(stopped).toHaveText('Stopped: the most messages an hour between these two');
});

test.describe('a timer zone that is not this computer\'s', () => {
  test.use({ timezoneId: 'Europe/Berlin' });
  test('timers on UTC say so once, and one press moves them to this computer\'s zone', async ({ page }) => {
    await open(page, 'ready', { keysLast: '1', accountZone: 'UTC' });
    await openSettings(page, 'researcher');
    const zone = settings(page).getByTestId('timers-zone');
    await expect(zone).toContainText('Times are in UTC. Your computer is on Central European Time.');
    await zone.getByTestId('timers-use-zone').click();
    await expect(zone).toHaveText('Times are in Central European Time.');
  });
});

test('a timer: weekdays at a time in the member\'s zone, its next run, an edit, a run that shows in the thread, and delete', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1', accountZone: 'America/Denver' });
  await openSettings(page, 'researcher');
  const timers = settings(page).getByTestId('timers');
  await timers.getByTestId('timer-add').click();
  const form = timers.getByTestId('timer-form');
  await form.getByTestId('timer-save').click();
  await expect(form.getByTestId('timer-error')).toHaveText('Give it a name, up to 60 characters.');
  await form.getByTestId('timer-label').fill('Morning brief');
  await form.getByTestId('timer-prompt').fill('Summarise yesterday’s notes.');
  await expect(timers.getByTestId('timers-zone')).toContainText('Mountain Time');
  await form.getByTestId('timer-time').fill('08:00');
  await form.getByTestId('timer-save').click();
  const row = timers.getByTestId('timer-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('timer-schedule')).toHaveText('Weekdays at 8:00 AM');
  await expect(row.getByTestId('timer-next')).toContainText('8:00 AM');
  await expect(timers.getByTestId('timers-zone')).toContainText('Times are in Mountain Time.');
  await expect(row).toContainText('Not run yet');

  // Every so many minutes: under the tier's minimum is refused with the minimum.
  await row.getByTestId('timer-edit').click();
  const edit = timers.getByTestId('timer-form');
  await edit.getByTestId('timer-every').fill('2');
  await edit.getByTestId('timer-save').click();
  await expect(edit.getByTestId('timer-error')).toContainText('Every 5 minutes is the most often');
  await edit.getByTestId('timer-every').fill('90');
  await edit.getByTestId('timer-save').click();
  await expect(timers.getByTestId('timer-schedule')).toHaveText('Every 1 hour 30 minutes');
  await timers.getByTestId('timer-edit').click();
  await timers.getByTestId('timer-every').fill('2');
  await timers.getByTestId('timer-every-unit').selectOption('hours');
  await timers.getByTestId('timer-save').click();
  await expect(timers.getByTestId('timer-schedule')).toHaveText('Every 2 hours');

  // In 2 hours, once.
  await timers.getByTestId('timer-add').click();
  const once = timers.getByTestId('timer-form');
  await once.getByTestId('timer-label').fill('Check in');
  await once.getByTestId('timer-prompt').fill('What changed?');
  await once.getByTestId('timer-kind-once').click();
  await once.getByTestId('timer-in').fill('2');
  await once.getByTestId('timer-save').click();
  await expect(timers.getByTestId('timer-row')).toHaveCount(2);
  await expect(timers.getByTestId('timer-schedule').nth(1)).toContainText('Once, ');
  await shot(page, 'timers');

  // It fires: the prompt shows in the thread, marked from the timer, then the reply; the row says it ran and what it spent.
  await page.evaluate(() => {
    const mock = (window as unknown as { __maAgentMock: { fireTimer(a: string, t: string): void; dump(): string } }).__maAgentMock;
    const t = (JSON.parse(mock.dump()) as { timers: Record<string, { id: string; label: string }[]> }).timers['researcher']!.find((x) => x.label === 'Morning brief')!;
    mock.fireTimer('researcher', t.id);
  });
  await expect(page.getByTestId('msg-from').last()).toContainText('Timer: Morning brief');
  await expect(page.getByTestId('msg-agent').last()).toHaveAttribute('data-state', 'done');
  await expect(timers.getByTestId('timer-row').first()).toContainText('Ran');
  await expect(timers.getByTestId('timer-row').first()).toContainText('spent');

  // Off, then deleted.
  await expect(timers.getByTestId('timer-row').first().getByTestId('timer-last')).toContainText(/Ran, \w{3}, \w{3} \d+, \d+:\d{2} [AP]M/);
  await timers.getByRole('switch', { name: 'Check in, on' }).click({ force: true });
  await expect(timers.getByTestId('timer-next').nth(1)).toHaveText('Off');
  await timers.getByTestId('timer-delete').nth(1).click();
  await timers.getByTestId('timer-delete-confirm').click();
  await expect(timers.getByTestId('timer-row')).toHaveCount(1);
});

test('the look: an icon and a tone from the keyboard, a PNG upload, and refusals in plain words', async ({ page }) => {
  await open(page, 'ready');
  await openSettings(page, 'researcher');
  const look = settings(page).getByTestId('look-editor');
  // Arrow keys move and choose; the save waits for the pause.
  await look.getByRole('radio', { name: 'Compass' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(look.getByRole('radio', { name: 'Book' })).toBeFocused();
  await expect(look.getByRole('radio', { name: 'Book' })).toHaveAttribute('aria-checked', 'true');
  await look.getByRole('radio', { name: 'Plum' }).click();
  await expect
    .poll(() => page.evaluate(() => (JSON.parse((window as unknown as { __maAgentMock: { dump(): string } }).__maAgentMock.dump()) as { agents: { id: string; look: unknown }[] }).agents.find((a) => a.id === 'researcher')?.look))
    .toEqual({ icon: 'book', tone: 'plum', png: null });
  const updates = await page.evaluate(() => (window as unknown as { __maAgentMock: { calls: { method: string }[] } }).__maAgentMock.calls.filter((c) => c.method === 'agent.update').length);
  expect(updates).toBe(1);

  // Refused here, before anything goes: not a PNG, too many pixels.
  const file = look.getByTestId('icon-file');
  await file.setInputFiles({ name: 'logo.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a not a png') });
  await expect(look.getByTestId('icon-error')).toHaveText('That file isn’t a PNG inside, even if its name ends in .png. Export it as PNG and try again.');
  await file.setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: sized(600) });
  await expect(look.getByTestId('icon-error')).toHaveText('That picture is over 512 by 512 pixels. Save a smaller copy and try again.');
  // A good one: the mark draws its shape in the standard color, from a blob: URL that stays in the page.
  await file.setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: CROSS });
  await expect(look.getByTestId('icon-error')).toHaveCount(0);
  await expect(page.locator('.ag-rail [data-testid="agent-researcher"] .ag-look-png')).toBeVisible();
  const mask = await page.locator('.ag-rail [data-testid="agent-researcher"] .ag-look-png').evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).getPropertyValue('-webkit-mask-image'));
  expect(mask).toMatch(/^url\("blob:/);
  await shot(page, 'look');
});

test('the desk\'s own refusal of an upload shows in the same words', async ({ page }) => {
  // A header this window reads as fine, and nothing after it: only the desk, decoding the picture, can refuse it.
  await open(page, 'ready');
  await openSettings(page, 'researcher');
  const look = settings(page).getByTestId('look-editor');
  await look.getByTestId('icon-file').setInputFiles({ name: 'cut.png', mimeType: 'image/png', buffer: ONE_PX.subarray(0, 33) });
  await expect(look.getByTestId('icon-error')).toHaveText('That PNG couldn’t be read. It may be damaged.');
  const refused = await page.evaluate(() => (window as unknown as { __maAgentMock: { calls: { method: string }[] } }).__maAgentMock.calls.filter((c) => c.method === 'agent.icon.upload').length);
  expect(refused).toBe(1);
});

test('workspace: use against the quota, a folder, a file read as text, sharing and a delete', async ({ page }) => {
  await open(page, 'ready');
  await openSettings(page, 'researcher');
  const ws = settings(page).getByTestId('workspace');
  await expect(ws.getByTestId('workspace-used')).toContainText('of 50 MB');
  await ws.getByRole('button', { name: 'Open folder notes' }).click();
  await ws.getByRole('button', { name: 'View ideas.txt' }).click();
  await expect(ws.getByTestId('workspace-file')).toContainText('Ask the member which sources they trust.');
  await ws.getByRole('button', { name: 'Delete ideas.txt' }).click();
  await ws.getByTestId('workspace-delete-confirm').click();
  await expect(ws.getByTestId('workspace-entry')).toHaveCount(1);
  await ws.getByRole('button', { name: 'Up a folder' }).click();
  await ws.getByTestId('workspace-quota').fill('5000');
  await ws.getByTestId('workspace-quota-save').click();
  await expect(ws.getByRole('alert')).toContainText('from 1 to 1024');
  await ws.getByTestId('workspace-quota').fill('20');
  await ws.getByTestId('workspace-quota-save').click();
  await expect(ws.getByTestId('workspace-used')).toContainText('of 20 MB');
  await ws.getByTestId('workspace-share').getByRole('checkbox', { name: 'Lead' }).check();
  await ws.getByTestId('workspace-share-save').click();
  await expect(ws.getByTestId('workspace-share').getByRole('checkbox', { name: 'Lead' })).toBeChecked();
  await expect(ws.getByTestId('workspace-share-save')).toHaveCount(0);
});

test('the desk-wide workspace total shows, and a raise past the desk\'s share is refused in words', async ({ page }) => {
  await open(page, 'ready', { workspaceBudgetMb: '120' });
  await openSettings(page, 'researcher');
  const ws = settings(page).getByTestId('workspace');
  await expect(ws.getByTestId('workspace-total')).toContainText('of the 120 MB this desk can give them');
  await ws.getByTestId('workspace-quota').fill('100');
  await ws.getByTestId('workspace-quota-save').click();
  await expect(ws.getByRole('alert')).toContainText('already take their share of this desk’s storage');
});

type MockHook = { writeFile(a: string, p: string, t: string): void; getWorkspace(a: string): Promise<{ quotaBytes: number; usedBytes: number }> };

test('a nearly full or full workspace says so, a save it refused shows in the thread, and a long file pages', async ({ page }) => {
  await open(page, 'ready');
  await openSettings(page, 'researcher');
  const ws = settings(page).getByTestId('workspace');
  await ws.getByTestId('workspace-quota').fill('1');
  await ws.getByTestId('workspace-quota-save').click();
  await expect(ws.getByTestId('workspace-used')).toContainText('of 1 MB');
  await expect(ws.getByTestId('workspace-fullness')).toHaveCount(0);
  await page.evaluate(async () => {
    const mock = (window as unknown as { __maAgentMock: MockHook }).__maAgentMock;
    const v = await mock.getWorkspace('researcher');
    mock.writeFile('researcher', 'fill.txt', 'z'.repeat(Math.floor((v.quotaBytes - v.usedBytes) * 0.85)));
  });
  await page.getByRole('button', { name: 'Close panel' }).click();
  await openSettings(page, 'researcher');
  await expect(settings(page).getByTestId('workspace-fullness')).toHaveText('Nearly full. Researcher can’t save more once it’s full.');
  await page.evaluate(async () => {
    const mock = (window as unknown as { __maAgentMock: MockHook }).__maAgentMock;
    const v = await mock.getWorkspace('researcher');
    mock.writeFile('researcher', 'fill2.txt', 'z'.repeat(v.quotaBytes - v.usedBytes));
  });
  await page.getByRole('button', { name: 'Close panel' }).click();
  await openSettings(page, 'researcher');
  await expect(settings(page).getByTestId('workspace-fullness')).toHaveText('Full. Researcher can’t save files until you delete some or make it bigger.');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await sendAndWait(page, 'save notes.txt');
  await expect(page.getByTestId('msg-save-refused')).toHaveText('Couldn’t save notes.txt: the workspace is full.');

  // A long file comes a page at a time.
  await page.evaluate(() => {
    const mock = (window as unknown as { __maAgentMock: MockHook }).__maAgentMock;
    mock.writeFile('manager', 'long.txt', 'p'.repeat(300_000));
    for (let i = 0; i < 501; i += 1) mock.writeFile('manager', `many/f${i}.txt`, 'x');
  });
  await openSettings(page, 'manager');
  const lead = settings(page).getByTestId('workspace');
  await lead.getByRole('button', { name: 'View long.txt' }).click();
  await expect(lead.getByTestId('workspace-file-more')).toContainText('168,928 more characters.');
  await lead.getByTestId('workspace-file-next').click();
  await expect(lead.getByTestId('workspace-file-more')).toContainText('37,856 more characters.');
  await lead.getByTestId('workspace-file-next').click();
  await expect(lead.getByTestId('workspace-file-more')).toHaveCount(0);
  await lead.getByRole('button', { name: 'Open folder many' }).click();
  await expect(lead.getByTestId('workspace-more')).toHaveText('and more: delete some to see the rest');
});

test('a run that hit the length limit or was refused says so, and an agent past the plan cap is paused', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('agent-researcher').click();
  await page.getByTestId('composer-input').fill('demo:cut_off');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('The reply was cut off at its length limit.')).toBeVisible();
  await page.getByTestId('composer-input').fill('demo:refused');
  await page.getByTestId('composer-send').click();
  await expect(page.getByText('The model declined to answer.')).toBeVisible();

  await open(page, 'ready', { agentCap: '1' });
  await page.getByTestId('agent-researcher').click();
  await expect(page.getByTestId('paused-banner')).toHaveText('Paused: this desk has more agents than its plan allows. Remove one to start the rest again.');
  await page.getByTestId('composer-input').fill('hello');
  await page.getByTestId('composer-send').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Paused:' })).toBeVisible();
});

test('one agent\'s own window: its thread and settings, no rail, and a plain line once it\'s gone', async ({ page }) => {
  await open(page, 'ready', { focus: 'researcher' });
  await expect(page.locator('.ag-rail')).toHaveCount(0);
  await expect(page.locator('.ag-head-name')).toHaveText('Researcher');
  await expect(page.getByTestId('thread')).toContainText('I’m Researcher');
  await page.getByTestId('tab-settings').click();
  await expect(settings(page)).toBeVisible();
  await shot(page, 'focus');
  await settings(page).getByTestId('agent-delete').click();
  await settings(page).getByTestId('agent-delete-confirm').click();
  await expect(page.getByTestId('agent-state')).toHaveAttribute('data-state', 'removed');
});

test('settings and cards read in every theme, and at the small size', async ({ page }) => {
  for (const theme of THEMES) {
    await open(page, 'ready', { theme });
    await sendAndWait(page, 'Set up two agents');
    await shot(page, `cards-${theme}`);
    await openSettings(page, 'researcher');
    await shot(page, `settings-${theme}`);
    await open(page, 'ready', { theme, size: 'small' });
    await page.getByTestId('tab-settings').click();
    await expect(settings(page)).toBeVisible();
    // Nothing spills sideways in a 420 px window.
    const over = await page.evaluate(() => {
      const body = document.querySelector('.ag-drawer-body') as HTMLElement;
      return body.scrollWidth - body.clientWidth;
    });
    expect(over).toBeLessThanOrEqual(1);
    await shot(page, `settings-small-${theme}`);
  }
});
