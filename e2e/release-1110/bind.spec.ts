// Binds (or unbinds, with BIND=off it only reads) the test desk's Lead agent to the key already stored on that desk, over an RPC session as the test account.
// The dummy key cannot list models (the provider refuses its sign-in), so the window's own Save is disabled; agent.bind takes the model name as typed.
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { APP, apiToken, loadUser } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

test('bind the Lead agent to the key on this desk', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const context = await browser.newContext();
  const bearer = await apiToken(context, loadUser('desk-1'));
  const page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  const client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 8 && !opened.ok; i++) { opened = await client.open(false); if (!opened.ok) await sleep(5000); }
  expect(opened.ok).toBe(true);
  try {
    const keys = await client.rpc<{ keys: { keyId: string; label: string; providerId?: string; provider?: string }[] }>('agent.key.list');
    console.log('[bind] keys:', JSON.stringify(keys.keys.map((k) => ({ label: k.label }))));
    const list = await client.rpc<{ agents: { id: string; binding: unknown }[] }>('agent.list');
    const r = await client.rpcTry('agent.bind', { agentId: list.agents[0].id, keyId: keys.keys[0].keyId, model: 'fake-test-model' }, { idem: true });
    console.log('[bind] agent.bind ok:', r.ok, JSON.stringify(r.ok ? {} : r.details));
    expect(r.ok).toBe(true);
  } finally { await client.finish().catch(() => {}); await context.close(); }
});
