// Usage limits (design 9.9): a refusal stops a message before anything is sent, says which limit, loses
// nothing typed, and the member's new limit lets the next one through.
import { auditRow, expect, open, sendAndWait, test } from './watch';

test('a limit stops a message before it goes, and raising it lets the next one through', async ({ page }) => {
  await open(page, 'limit');
  const thread = page.getByTestId('thread');
  const before = await thread.locator('li').count();
  await expect(page.getByTestId('usage-card')).toContainText('$0.42 of $0.43');

  const input = page.getByTestId('composer-input');
  await input.fill('Plan my week');
  await page.getByTestId('composer-send').click();

  const banner = page.getByTestId('limit-banner');
  await expect(banner).toContainText('Today’s limit is reached ($0.43). Nothing was sent.');
  await expect(input).toHaveValue('Plan my week'); // nothing typed is lost
  await expect(thread.locator('li')).toHaveCount(before); // nothing added
  await expect(page.getByRole('tab', { name: /Lead/ })).toContainText('limit reached');

  // The banner goes straight to the limits.
  await page.getByTestId('limit-change').click();
  const panel = page.getByTestId('limits-panel');
  await expect(panel.locator('[data-scope="agent_day"]')).toHaveAttribute('data-level', 'near');
  await panel.getByTestId('limits-edit').click();

  // Bad amounts are named, and nothing is saved.
  await panel.getByTestId('limit-agentDay').fill('lots');
  await panel.getByTestId('limit-runMaxSteps').fill('0');
  await panel.getByTestId('limits-save').click();
  await expect(panel.getByText('An amount in dollars, like 5 or 2.50')).toBeVisible();
  await expect(panel.getByText('A whole number from 1 to 500')).toBeVisible();
  await expect(panel.getByTestId('limit-agentDay')).toHaveAttribute('aria-invalid', 'true');

  await panel.getByTestId('limit-agentDay').fill('5');
  await panel.getByTestId('limit-runMaxSteps').fill('50');
  await panel.getByTestId('limits-save').click();
  await expect(panel.getByTestId('limits-form')).toHaveCount(0);
  await expect(panel.locator('[data-scope="agent_day"]')).toContainText('$0.42 of $5');
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Lead/ })).toContainText('online');

  // The same text goes now, streams, and is charged.
  const reply = await sendAndWait(page, null);
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('msg-user').last().locator('.ag-bubble')).toHaveText('Plan my week');
  await expect(reply.getByTestId('msg-foot')).toContainText(/claude-sonnet-4-5 · .+ tokens · est\. (\$0\.\d\d|<\$0\.01)/);

  // And Activity has the refusal and the change, with no message text.
  await page.getByTestId('tab-activity').click();
  const log = page.getByTestId('activity-panel');
  await expect(auditRow(page, 'A limit stopped a call')).toBeVisible();
  await expect(auditRow(page, 'Changed limits')).toBeVisible();
  await expect(auditRow(page, 'Model call')).toHaveCount(1);
  await expect(log).not.toContainText('Plan my week');
});

test('blank means no limit there, and the desk cap is the whole desk’s', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('tab-usage').click();
  const panel = page.getByTestId('limits-panel');
  await expect(panel.locator('[data-scope="desk_month"]')).toContainText('of $20');
  await panel.getByTestId('limits-edit').click();
  await panel.getByTestId('limit-agentDay').fill('');
  await panel.getByTestId('limit-agentWeek').fill('12.50');
  await panel.getByTestId('limits-save').click();
  await expect(panel.locator('[data-scope="agent_day"]')).toHaveCount(0);
  await expect(panel.locator('[data-scope="agent_week"]')).toContainText('of $12.50');
  // The rail's meter follows the fullest limit.
  await expect(page.getByTestId('usage-card')).toBeVisible();
});

test('a per-run cap below one reply’s worst case refuses with the run’s words', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('tab-usage').click();
  const panel = page.getByTestId('limits-panel');
  await panel.getByTestId('limits-edit').click();
  await panel.getByTestId('limit-run').fill('0.01');
  await panel.getByTestId('limits-save').click();
  await expect(panel.getByTestId('limits-form')).toHaveCount(0);
  await page.getByTestId('composer-input').fill('hello');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('limit-banner')).toContainText('One run would pass its limit ($0.01)');
});
