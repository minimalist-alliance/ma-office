// A waiting card after a reload, or after the window opens again on a fresh subscription (release 2's proof on staging: the
// Agent window never drew a waiting card after a reload or a desk-agent restart). The window draws its cards from the
// conversation snapshot (deskd API.md section 18, "Events and new fields"): the snapshot's own `approvals`, which desk-agent
// sends from this release, and each reply's own list, which is all desk-agent sent before it (release 4 and
// `2026.11.14-dce379e`; the mock's `?approvalsWire=messages`). Either way the card comes back, answerable, with its hash.
// `?agentFixture=tools` is Scout waiting on a Send outside (see `agent.tools.shell.spec.ts`).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

interface MockControl {
  rpc: { m: string; p: Record<string, unknown> }[];
}
type W = { __maDeskMock: MockControl };

const agentWindow = (page: Page): Locator => page.getByRole('dialog', { name: /Agent/ });
const card = (page: Page): Locator => page.getByTestId('approval');
const decides = (page: Page): Promise<{ approve: unknown; sha256: unknown }[]> =>
  page.evaluate(() => (window as unknown as W).__maDeskMock.rpc.filter((r) => r.m === 'agent.approval.decide').map((r) => ({ approve: r.p['approve'], sha256: r.p['sha256'] })));

/** The Agent window, opened from its tile unless it's open already (a reload brings back what was open). */
async function openAgent(page: Page): Promise<void> {
  if (!(await agentWindow(page).isVisible())) {
    const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Agent/ });
    await tile.evaluate((el) => (el as HTMLButtonElement).click());
  }
  await expect(agentWindow(page)).toBeVisible();
}

async function openScout(page: Page): Promise<void> {
  await openAgent(page);
  const row = page.getByTestId('agent-scout');
  const toggle = page.getByRole('button', { name: 'Agents', exact: true });
  await expect.poll(async () => (await row.isVisible()) || (await toggle.isVisible())).toBe(true);
  if (!(await row.isVisible())) await toggle.click();
  await row.click();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

const WIRES = [
  { name: 'this desk-agent (the snapshot’s own approvals)', query: '' },
  { name: 'desk-agent before the fix (each card only in its reply)', query: '&approvalsWire=messages' },
] as const;

for (const wire of WIRES) {
  test(`${wire.name}: a waiting card is drawn again after a reload, and Approve carries its hash`, async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, `/?fixture=one&speed=fast&agentFixture=tools${wire.query}`);
    await canvasPainted(page);
    await openScout(page);
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-state', 'pending');

    await page.reload();
    await canvasPainted(page);
    await openScout(page);
    // Nothing but the snapshot has said anything of the card since the reload: it is drawn from it, pending.
    const c = card(page);
    await expect(c).toBeVisible();
    await expect(c).toHaveAttribute('data-state', 'pending');
    await page.waitForTimeout(600); // Approve arms after 500 ms
    await c.getByTestId('approval-approve').click();
    await expect(c.getByTestId('approval-state')).toContainText('Approved by you');
    const [d] = await decides(page);
    expect(d?.approve).toBe(true);
    expect(String(d?.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(errors).toEqual([]);
  });
}

test('desk-agent before the fix: the window closed and opened again (a fresh subscription) draws the waiting card', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, '/?fixture=one&speed=fast&agentFixture=tools&approvalsWire=messages');
  await canvasPainted(page);
  await openScout(page);
  await expect(card(page)).toBeVisible();
  await agentWindow(page).getByRole('button', { name: 'Close Agent' }).click();
  await expect(agentWindow(page)).toBeHidden();
  await openScout(page);
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-state', 'pending');
  expect(errors).toEqual([]);
});
