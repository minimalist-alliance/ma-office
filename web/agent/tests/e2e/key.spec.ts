// The key flow (design 9.5 step 1, task 07): the key is typed into a hidden field, handed to the desk, and kept
// nowhere in the page. Not in the DOM, React, storage, the console, the URL or a request. Fake keys only.
import { everythingKept, expect, open, test } from './watch';

const KEY = 'sk-ant-TEST-e2e-not-a-real-key-7Hq2';

test('a key goes to the desk and is kept nowhere in the page', async ({ page, watched }) => {
  await open(page, 'fresh');
  const setup = page.getByTestId('key-setup');
  await expect(setup.getByRole('heading', { name: 'Give Lead a key' })).toBeVisible();
  const field = page.getByTestId('key-input');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('autocomplete', 'off');
  await expect(field).toHaveAttribute('spellcheck', 'false');
  await expect(field).toHaveAttribute('data-1p-ignore', 'true');
  await expect(field).toHaveAttribute('data-lpignore', 'true');
  await expect(field).not.toHaveAttribute('value', /.*/);
  await expect(page.getByTestId('key-submit')).toBeDisabled();

  await field.click();
  await page.keyboard.type(KEY);
  // Typed, the key is in the field's value only: not in any attribute, so not in the DOM's markup.
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(KEY);
  await page.keyboard.press('Enter');

  // The field empties in the same task as the submit, before the desk answers.
  await expect(field).toHaveValue('');
  // The desk took it, and the manager woke on it.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Lead/ })).toContainText('online');
  await expect(page.locator('.ag-head').getByTestId('provider-badge')).toContainText('Anthropic');

  // The last 4 are what the desk sends back, and they show in Keys.
  await page.getByTestId('tab-keys').click();
  await expect(page.getByTestId('key-row')).toContainText('····7Hq2');

  // The key itself is nowhere.
  const kept = await everythingKept(page);
  expect(kept).not.toContain(KEY);
  expect(kept).not.toContain(KEY.slice(0, -4)); // nor any long part of it
  for (const m of watched.console) expect(m.text).not.toContain(KEY);
  for (const r of watched.requests) expect(r.url).not.toContain(KEY);
  // It crossed the client interface exactly once, and the mock's own record shows it redacted.
  const calls = await page.evaluate(() => (window as unknown as { __maAgentMock: { calls: { method: string; params: { secret?: string } }[] } }).__maAgentMock.calls);
  expect(calls.filter((c) => c.method === 'agent.key.add').map((c) => c.params.secret)).toEqual(['[redacted]']);
  // Nothing was written to browser storage at all.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
});

test('a key that is plainly wrong never leaves the field', async ({ page }) => {
  await open(page, 'fresh');
  const field = page.getByTestId('key-input');
  // Another provider's key names that provider (deskd API.md §11's `provider_mismatch`, caught here first).
  await field.fill('sk-proj-TEST-0000000000-openai-style');
  await page.getByTestId('key-submit').click();
  await expect(page.getByTestId('key-error')).toHaveText('That’s a key from OpenAI. Pick OpenAI above and paste it again.');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  // A key with no known prefix says what this provider's start with.
  await field.fill('gsk_TEST-0000000000-nobodys');
  await page.getByTestId('key-submit').click();
  await expect(page.getByTestId('key-error')).toHaveText('Keys from this provider start with “sk-ant-”. Check you picked the right provider.');
  const calls = await page.evaluate(() => (window as unknown as { __maAgentMock: { calls: { method: string }[] } }).__maAgentMock.calls.map((c) => c.method));
  expect(calls).not.toContain('agent.key.add');

  await field.fill('sk-ant short');
  await page.getByTestId('key-submit').click();
  await expect(page.getByTestId('key-error')).toContainText('no spaces');
});

test('a key the provider refuses is said plainly, and nothing is kept', async ({ page }) => {
  await open(page, 'fresh');
  const revoked = 'sk-ant-TEST-revoked-e2e-0000';
  await page.getByTestId('key-input').fill(revoked);
  await page.getByTestId('key-submit').click();
  await expect(page.getByTestId('key-error')).toHaveText(/The provider refused this key/);
  await expect(page.getByTestId('key-input')).toHaveValue('');
  await expect(page.getByTestId('key-setup')).toBeVisible();
  expect(await everythingKept(page)).not.toContain(revoked);
});

test('a key typed and abandoned is gone with the form', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('tab-keys').click();
  await page.getByTestId('key-add-open').click();
  await page.getByTestId('key-input').fill(KEY);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByTestId('drawer')).toHaveCount(0);
  await page.getByTestId('tab-keys').click();
  await page.getByTestId('key-add-open').click();
  await expect(page.getByTestId('key-input')).toHaveValue('');
  expect(await everythingKept(page)).not.toContain(KEY);
});

test('OpenAI keys go the same way, and a second key can be bound to an agent', async ({ page }) => {
  await open(page, 'ready');
  await page.getByTestId('tab-keys').click();
  await page.getByTestId('key-add-open').click();
  await page.getByRole('radio', { name: 'OpenAI' }).click();
  const key = 'sk-TEST-e2e-openai-not-real-9xYz';
  await page.getByTestId('key-input').fill(key);
  await page.getByLabel('Name it (optional)').fill('Work');
  await page.getByTestId('key-submit').click();
  await expect(page.getByTestId('key-row')).toHaveCount(3);
  await expect(page.getByTestId('key-row').nth(2)).toContainText('····9xYz');
  expect(await everythingKept(page)).not.toContain(key);

  // Deleting says to revoke at the provider too.
  await page.getByRole('button', { name: 'Delete key Work' }).click();
  await page.getByTestId('key-delete-confirm').click();
  await expect(page.getByTestId('key-deleted')).toContainText('Revoke it at platform.openai.com too');
  await expect(page.getByTestId('key-row')).toHaveCount(2);
});
