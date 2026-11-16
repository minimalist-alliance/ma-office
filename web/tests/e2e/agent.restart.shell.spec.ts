// An open Agent window through a restart of the desk's services, catching up live with no reopen (release 3's proof on staging,
// bugs A and B in docs/sub-status/phase0-release-3.md). Against the mock desk, whose knobs play what the real desk did:
// - desk-agent killed with a call in flight: deskd subscribes again and the window gets a fresh snapshot, cut as deskd cuts a
//   long thread (`cutSnapshots`), so the window reads the whole thread (`agent.thread.get`). That read answers what the desk had
//   when it was asked; the call ending meanwhile (its `approval` event) must not be put back to "Running" by it (`holdAnswer`).
// - deskd restarted: a new session that resumes nothing, whose first SUBs deskd answers slowly (`subDelayMs`). The window's new
//   client subscribes while the old one's SUB is still on its way, and deskd gives both the same subscription (API.md section 5),
//   so the old one's late UNSUB must not end it.
// `?agentFixture=tools` is Scout waiting on a Send outside (see `agent.tools.shell.spec.ts`). One worker per process.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

interface MockAgentDesk {
  client: { finishReply(agentId: string, over?: Record<string, unknown>): string };
}
interface MockControl {
  rpc: { m: string; p: Record<string, unknown> }[];
  holdAnswer: Record<string, boolean>;
  releaseHeld(): void;
  agent: {
    cutSnapshots: number | null;
    subDelayMs: number;
    setDown(down: boolean): void;
    dropLink(ms: number): void;
    desks: Record<string, MockAgentDesk>;
  };
}
type W = { __maDeskMock: MockControl };

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const card = (page: Page): Locator => page.getByTestId('approval');
const reads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === 'agent.thread.get').length);

async function openScout(page: Page): Promise<void> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(agentWindow(page)).toBeVisible();
  const row = page.getByTestId('agent-scout');
  const toggle = page.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => (await row.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await row.isVisible())) await toggle.click();
  await row.click();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('desk-agent killed with a call in flight: the open window shows the call done, though its read of the whole thread is older', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, '/?fixture=one&speed=fast&agentFixture=tools');
  await canvasPainted(page);
  await openScout(page);
  const c = card(page);
  await expect(c).toHaveAttribute('data-state', 'pending');
  await page.waitForTimeout(600); // Approve arms after 500 ms
  await c.getByTestId('approval-approve').click();
  // Approved, and its call runs on the desk (2 s for this one).
  await expect(c).toHaveAttribute('data-state', 'approved');
  await expect(c.getByTestId('approval-state')).toContainText('Approved by you');

  // desk-agent goes down and comes back: deskd subscribes again, and the snapshot is cut, as a long thread's is. The window
  // reads the whole thread; the desk answers at once, but the answer is overtaken by the call's end.
  const before = await reads(page);
  await page.evaluate(() => {
    const m = (window as unknown as W).__maDeskMock;
    m.agent.cutSnapshots = 1;
    m.holdAnswer['agent.thread.get'] = true;
    m.agent.setDown(true);
    m.agent.setDown(false);
  });
  await expect.poll(() => reads(page)).toBeGreaterThan(before);
  // The call ends while the read is out, and the window says so, live.
  await expect(c).toHaveAttribute('data-state', 'done', { timeout: 10_000 });
  // The read lands, older than that: what an event said since stands.
  await page.evaluate(() => {
    const m = (window as unknown as W).__maDeskMock;
    m.holdAnswer = {};
    m.releaseHeld();
  });
  await page.waitForTimeout(500);
  await expect(c).toHaveAttribute('data-state', 'done');
  await expect(c.getByTestId('approval-state')).not.toContainText('Running');
  await expect(c.getByTestId('approval-approve')).toHaveCount(0);
  // The window is still live: the next reply shows with no reopen.
  await page.evaluate(() => (window as unknown as W).__maDeskMock.agent.desks['d-personal']!.client.finishReply('scout', { text: 'Opened the shop page.' }));
  await expect(agentWindow(page).getByText('Opened the shop page.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('deskd restarted with the window open: it subscribes again and catches up live, with no reopen', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, '/?fixture=one&speed=fast&agentFixture=tools');
  await canvasPainted(page);
  await openScout(page);
  await expect(card(page)).toHaveAttribute('data-state', 'pending');

  // A new session that resumes nothing, as after a restart of deskd; its first SUBs are answered slowly.
  await page.evaluate(() => {
    const m = (window as unknown as W).__maDeskMock;
    m.agent.subDelayMs = 400;
    m.agent.dropLink(1_500);
  });
  await expect(page.getByTestId('agent-blip')).toHaveText('Reconnecting…');
  await expect(page.getByTestId('agent-blip')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(1_000); // every SUB's slow reply is in
  // Something new on the desk: the open window shows it, with no reopen.
  await page.evaluate(() => (window as unknown as W).__maDeskMock.agent.desks['d-personal']!.client.finishReply('scout', { text: 'Back after the restart.' }));
  await expect(agentWindow(page).getByText('Back after the restart.')).toBeVisible({ timeout: 5_000 });
  // And the waiting card still answers, on the live subscription.
  await page.waitForTimeout(600);
  await card(page).getByTestId('approval-approve').click();
  await expect(card(page)).toHaveAttribute('data-state', 'done', { timeout: 10_000 });
  expect(errors).toEqual([]);
});
