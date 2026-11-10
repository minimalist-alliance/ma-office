// deskd's relay of agent.* (API.md section 11) on the test desk, as desk-1, through Platform's real API and gateway with
// streamlib's test client. With no desk-agent on the desk, as on every image so far: every call is unavailable with
// reason unavailable, and a write says nothing changed (no mayHaveApplied, task 33 item 2), a malformed key is refused in
// deskd before anything is sent, /health says agent: waiting, and the test key never reaches the journal. A desk with a
// desk-agent connected skips it and runs the second test instead (task 37): the same calls answered by desk-agent. The weekend's integration check
// (int-15c), made part of the gate by task 33.
//
//   npx playwright test tests/agent-relay.spec.ts --output test-results-agent
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, DESK_ID, apiToken, deskTruth, loadUser, onDesk } from './lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from './streamlib';

let context: BrowserContext;
let page: Page;
let client: DeskClient;

test.setTimeout(5 * 60_000);

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  const bearer = await apiToken(context, loadUser('desk-1'));
  page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 6 && !opened.ok; i++) {
    opened = await client.open(false);
    if (!opened.ok) await sleep(5000);
  }
  if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code })}`);
});

test.afterAll(async () => {
  await client?.finish().catch(() => {});
  await context?.close();
});

test('agent.* with no desk-agent: unavailable, writes say nothing changed, a malformed key refused in deskd, health waiting, nothing logged', async () => {
  const truth = await deskTruth();
  expect(truth.deskId).toBe(DESK_ID);
  console.log(`[agent] desk: ${JSON.stringify({ deskdVersion: truth.deskdVersion, rtcVersion: truth.rtcVersion, agent: truth.health.agent })}`);
  test.skip(truth.health.agent === 'connected', 'desk-agent runs on this desk');
  expect(truth.health.agent, '/health').toBe('waiting');

  for (const m of ['agent.list', 'agent.providers', 'agent.key.list']) {
    const r = await client.rpcTry(m, {});
    console.log(`[agent] ${m}: ${JSON.stringify({ ok: r.ok, code: r.code, details: r.details })}`);
    expect(r.code, m).toBe('unavailable');
    expect(r.details, m).toEqual({ reason: 'unavailable' });
  }
  const create = await client.rpcTry('agent.create', { name: 'x' }, { idem: true });
  console.log(`[agent] agent.create: ${JSON.stringify({ code: create.code, details: create.details })}`);
  expect(create.code).toBe('unavailable');
  expect(create.details, 'agent.create: nothing changed, so no mayHaveApplied').toEqual({ reason: 'unavailable' });

  const marker = `zz${randomBytes(4).toString('hex')}`;
  const unsent = await client.rpcTry('agent.key.add', { provider: 'anthropic', label: 'check', secret: `sk-ant-${marker}-not-a-key` }, { idem: true });
  console.log(`[agent] agent.key.add, well formed: ${JSON.stringify({ code: unsent.code, details: unsent.details })}`);
  expect(unsent.code).toBe('unavailable');
  expect(unsent.details, 'agent.key.add: nothing changed, so no mayHaveApplied').toEqual({ reason: 'unavailable' });
  const malformed = await client.rpcTry('agent.key.add', { provider: 'anthropic', label: 'check', secret: `sk ${marker}` }, { idem: true });
  console.log(`[agent] agent.key.add, malformed: ${JSON.stringify({ code: malformed.code, details: malformed.details })}`);
  expect(malformed.code).toBe('bad_request');
  expect(malformed.details).toEqual({ reason: 'key_malformed', detail: 'format' });

  const out = await onDesk(`echo "KEY=$(journalctl --since -15min --no-pager | grep -c '${marker}')"; echo "WAITING=$(journalctl -t deskd --since -30min --no-pager | grep -c 'agent link: waiting')"; echo "DIR=$(stat -c '%U:%G %a' /run/desk-agent 2>&1)"`);
  console.log(`[agent] desk: ${out.replace(/\n/g, ' ')}`);
  expect(out).toContain('KEY=0');
});

// From image 0.2.6 the test desk runs desk-agent (task 37), so the test above skips. This one runs instead: the same
// calls answered by desk-agent itself through deskd's relay. It only reads: no agent, key or limit is made, nothing goes
// to a provider, and a malformed key is still refused in deskd before anything is sent.
test('agent.* with desk-agent connected: answered by desk-agent, a malformed key refused in deskd, nothing logged', async () => {
  const truth = await deskTruth();
  expect(truth.deskId).toBe(DESK_ID);
  test.skip(truth.health.agent !== 'connected', 'no desk-agent on this desk');

  const providers = await client.rpcTry('agent.providers', {});
  const ids = (((providers.result as { providers?: { id: string }[] } | undefined)?.providers) ?? []).map((p) => p.id).sort();
  console.log(`[agent] agent.providers: ${JSON.stringify({ ok: providers.ok, code: providers.code, ids })}`);
  expect(providers.ok, 'agent.providers').toBe(true);
  expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'xai']));
  for (const [m, field] of [['agent.list', 'agents'], ['agent.key.list', 'keys'], ['agent.audit.list', 'entries']] as const) {
    const r = await client.rpcTry(m, {});
    const list = (r.result as Record<string, unknown> | undefined)?.[field];
    console.log(`[agent] ${m}: ${JSON.stringify({ ok: r.ok, code: r.code, details: r.details, [field]: Array.isArray(list) ? list.length : typeof list })}`);
    expect(r.ok, m).toBe(true);
    expect(Array.isArray(list), `${m} ${field}`).toBe(true);
  }

  const marker = `zz${randomBytes(4).toString('hex')}`;
  const malformed = await client.rpcTry('agent.key.add', { provider: 'anthropic', label: 'check', secret: `sk ${marker}` }, { idem: true });
  console.log(`[agent] agent.key.add, malformed: ${JSON.stringify({ code: malformed.code, details: malformed.details })}`);
  expect(malformed.code).toBe('bad_request');
  expect(malformed.details).toEqual({ reason: 'key_malformed', detail: 'format' });

  const out = await onDesk(`echo "KEY=$(journalctl --since -15min --no-pager | grep -c '${marker}')"; echo "ACTIVE=$(systemctl is-active desk-agent)"; ` +
    `/opt/ma/desk-agent/current/health && echo HEALTH=ok || echo HEALTH=bad; echo "VERSION=$(basename "$(readlink /opt/ma/desk-agent/current)")"`);
  console.log(`[agent] desk: ${out.replace(/\n/g, ' ')}`);
  expect(out).toContain('KEY=0');
  expect(out).toContain('ACTIVE=active');
  expect(out).toContain('HEALTH=ok');
});
