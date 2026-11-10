// A desk from ADR 0043, where the whole desk's day, month and time zone follow the account unless the desk sets its own. The form
// leads with them, says where each comes from, and sends only what the member changed; the zone is set once from this browser.
import { expect, open, test } from './watch';
import type { Page } from '@playwright/test';

test.use({ timezoneId: 'America/Denver' });

type Call = { method: string; params: Record<string, unknown> };
const sets = (page: Page): Promise<Call[]> =>
  page.evaluate(() => (window as unknown as { __maAgentMock: { calls: Call[] } }).__maAgentMock.calls.filter((c) => c.method === 'agent.limits.set'));
const lastSet = async (page: Page): Promise<Record<string, unknown>> => {
  const all = await sets(page);
  const rest = { ...(all[all.length - 1]?.params ?? {}) };
  delete rest['idem'];
  delete rest['agentId'];
  return rest;
};

test('the zone is set once from this browser, with no question, and resets read in it', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1' });
  await expect.poll(() => sets(page)).toHaveLength(1);
  expect(await lastSet(page)).toEqual({ timeZone: 'America/Denver' });
  await page.getByTestId('tab-usage').click();
  const panel = page.getByTestId('limits-panel');
  await expect(panel.locator('[data-scope="agent_day"]').getByTestId('usage-reset')).toHaveText('Resets at midnight');
  await expect(panel.locator('[data-scope="desk_month"]').getByTestId('usage-reset')).toHaveText(/^Resets [A-Z][a-z]{2} 1$/);
  await expect(panel.getByTestId('prices-as-of')).toHaveText(' Prices as of Nov 6, 2026.');
  await page.waitForTimeout(300);
  expect(await sets(page)).toHaveLength(1); // once
  // Activity names it, rather than a change of limits the member didn't make.
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-action="limits.set"]')).toHaveCount(1);
  await expect(page.locator('[data-action="limits.set"] .ag-audit-what')).toHaveText('Time zone set to America/Denver');
});

test('a desk that audits the zone as limits.timezone has Activity say so, with the zone on this page', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1', zoneAudit: '1' });
  await expect.poll(() => sets(page)).toHaveLength(1);
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-action="limits.timezone"]')).toHaveCount(1);
  await expect(page.locator('[data-action="limits.set"]')).toHaveCount(0);
  await expect(page.locator('[data-action="limits.timezone"] .ag-audit-what')).toHaveText('Time zone set to America/Denver');
});

test('where the account has a zone, the desk follows it and nothing is set', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1', accountZone: 'Asia/Tokyo' });
  await page.getByTestId('tab-usage').click();
  await expect(page.getByTestId('usage-reset').first()).toHaveText('Resets at midnight (Asia/Tokyo)');
  expect(await sets(page)).toHaveLength(0);
  await page.getByTestId('limits-edit').click();
  await expect(page.getByTestId('limit-timeZone')).toHaveValue('Asia/Tokyo');
  await expect(page.getByTestId('limit-timeZone-source')).toHaveText('From your account');
});

test('the form leads with the whole desk, says where each comes from, and sends only what changed', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1', accountMonth: '50' });
  await expect.poll(() => sets(page)).toHaveLength(1); // the zone
  await page.getByTestId('tab-usage').click();
  const panel = page.getByTestId('limits-panel');
  await panel.getByTestId('limits-edit').click();
  const form = panel.getByTestId('limits-form');
  // The whole desk's fieldset comes first, with the day, the month and the zone.
  await expect(form.locator('fieldset').first()).toHaveAttribute('data-testid', 'limits-desk');
  await expect(form.getByTestId('limit-deskDay')).toHaveValue('');
  await expect(form.getByTestId('limit-deskDay-source')).toHaveText('No limit');
  await expect(form.getByTestId('limit-deskMonth')).toHaveValue('50');
  await expect(form.getByTestId('limit-deskMonth-source')).toHaveText('From your account');
  await expect(form.getByTestId('limit-timeZone')).toHaveValue('America/Denver');
  await expect(form.getByTestId('limit-timeZone-follow')).toHaveCount(0); // the account has no zone to go back to

  // Only the agent's own: the desk's day and month aren't sent, so it keeps following the account.
  await form.getByTestId('limit-agentDay').fill('7');
  await form.getByTestId('limits-save').click();
  await expect(form).toHaveCount(0);
  const agentOnly = await lastSet(page);
  expect(Object.keys(agentOnly)).toEqual(['policy']);
  expect(Object.keys(agentOnly['policy'] as object).sort()).toEqual(['agentDay', 'agentMonth', 'agentWeek', 'keyMonth', 'run', 'runMaxSteps']);

  // Nothing changed: nothing sent.
  const before = (await sets(page)).length;
  await panel.getByTestId('limits-edit').click();
  await form.getByTestId('limit-deskMonth').fill('50.00');
  await form.getByTestId('limits-save').click();
  await expect(form).toHaveCount(0);
  expect(await sets(page)).toHaveLength(before);

  // This desk's own month: sent alone among the desk's, and then offered back to the account.
  await panel.getByTestId('limits-edit').click();
  await form.getByTestId('limit-deskMonth').fill('30');
  await expect(form.getByTestId('limit-deskMonth-follow')).toHaveText('Use my account’s');
  await form.getByTestId('limits-save').click();
  await expect(form).toHaveCount(0);
  expect((await lastSet(page))['policy']).toMatchObject({ deskMonth: { maxMicroUsd: 30_000_000, maxTokens: null } });
  expect(Object.keys((await lastSet(page))['policy'] as object)).not.toContain('deskDay');
  await expect(panel.locator('[data-scope="desk_month"]')).toContainText('of $30');

  await panel.getByTestId('limits-edit').click();
  await expect(form.getByTestId('limit-deskMonth-source')).toHaveCount(0);
  await form.getByTestId('limit-deskMonth-follow').click();
  await expect(form.getByTestId('limit-deskMonth')).toHaveValue('50');
  await expect(form.getByTestId('limit-deskMonth-source')).toHaveText('From your account');
  await form.getByTestId('limits-save').click();
  await expect(form).toHaveCount(0);
  expect((await lastSet(page))['policy']).toMatchObject({ deskMonth: null });
  await expect(panel.locator('[data-scope="desk_month"]')).toContainText('of $50');

  // The day, blank to $4: this desk's own, and the month untouched.
  await panel.getByTestId('limits-edit').click();
  await form.getByTestId('limit-deskDay').fill('4');
  await form.getByTestId('limits-save').click();
  await expect(form).toHaveCount(0);
  const day = (await lastSet(page))['policy'] as Record<string, unknown>;
  expect(day['deskDay']).toEqual({ maxMicroUsd: 4_000_000, maxTokens: null });
  expect(Object.keys(day)).not.toContain('deskMonth');
  await expect(panel.locator('[data-scope="desk_day"]')).toContainText('of $4');

  // Removed again: the day had no limit, and that's what the way back says.
  await panel.getByTestId('limits-edit').click();
  await expect(form.getByTestId('limit-deskDay-follow')).toHaveText('Remove the limit');
  await form.getByTestId('limit-deskDay-follow').click();
  await expect(form.getByTestId('limit-deskDay')).toHaveValue('');
  await expect(form.getByTestId('limit-deskDay-source')).toHaveText('No limit');
  await form.getByTestId('limits-save').click();
  await expect(form).toHaveCount(0);
  expect((await lastSet(page))['policy']).toMatchObject({ deskDay: null });

  // Activity: the member's changes are changes of limits, and the zone the window set says so.
  await page.getByTestId('tab-activity').click();
  await expect(page.locator('[data-action="limits.set"] .ag-audit-what').last()).toHaveText('Time zone set to America/Denver');
  await expect(page.locator('[data-action="limits.set"] .ag-audit-what').first()).toHaveText('Changed limits');
});

test('where the account sets no month, the desk\'s built-in one is named, and offered back', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1' });
  await expect.poll(() => sets(page)).toHaveLength(1); // the zone
  await page.getByTestId('tab-usage').click();
  const panel = page.getByTestId('limits-panel');
  await panel.getByTestId('limits-edit').click();
  const form = panel.getByTestId('limits-form');
  await expect(form.getByTestId('limit-deskMonth')).toHaveValue('20');
  await expect(form.getByTestId('limit-deskMonth-source')).toHaveText('$20 · built in');
  await form.getByTestId('limit-deskMonth').fill('35');
  await expect(form.getByTestId('limit-deskMonth-follow')).toHaveText('Use the built-in $20');
  await form.getByTestId('limit-deskMonth-follow').click();
  await expect(form.getByTestId('limit-deskMonth')).toHaveValue('20');
  await expect(form.getByTestId('limit-deskMonth-source')).toHaveText('$20 · built in');
});

test('a zone the desk doesn\'t know is named in plain words, and a good one moves the resets', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1' });
  await expect.poll(() => sets(page)).toHaveLength(1);
  await page.getByTestId('tab-usage').click();
  const panel = page.getByTestId('limits-panel');
  await panel.getByTestId('limits-edit').click();
  const zone = panel.getByTestId('limit-timeZone');
  await zone.fill('Mars/Olympus');
  await panel.getByTestId('limits-save').click();
  await expect(panel.getByTestId('limit-timeZone-error')).toHaveText('That isn’t a time zone your desk knows. Pick one from the list, like Europe/Paris.');
  await expect(zone).toHaveAttribute('aria-invalid', 'true');
  expect(await sets(page)).toHaveLength(1);

  await zone.fill('europe/paris');
  await panel.getByTestId('limits-save').click();
  await expect(panel.getByTestId('limits-form')).toHaveCount(0);
  expect(await lastSet(page)).toEqual({ timeZone: 'Europe/Paris' });
  await expect(panel.locator('[data-scope="agent_day"]').getByTestId('usage-reset')).toHaveText('Resets at midnight (Europe/Paris)');
});

test('a model with no listed price says it counts at the provider\'s highest', async ({ page }) => {
  await open(page, 'ready', { keysLast: '1' });
  await page.getByTestId('tab-keys').click();
  await expect(page.getByTestId('model-unpriced')).toHaveCount(0);
  await page.getByTestId('bind-model').selectOption('claude-preview');
  await expect(page.getByTestId('model-unpriced')).toHaveText('No listed price, so it counts at this provider’s highest.');
});
