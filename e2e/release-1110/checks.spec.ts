// Release checks for deskd + desk-agent on the staging test desk, as the e2e test account, against staging's current Desk app.
// Run after the gate (`npx playwright test` in e2e/) and never beside it. No secret, no file name or content is printed.
//   npx playwright test -c release-1110
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, DESK_ID, apiToken, deskTruth, focusTestDesk, loadUser, onDesk, signInApp, watch, assertTestDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[release] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

test('Notebook text survives a deskd restart', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  assertTestDesk(); // the staging test desk only
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
  await focusTestDesk(page, w);
  const open = async (p: Page) => {
    const tile = p.getByRole('group', { name: /^test-desk/ }).getByRole('button', { name: /^Notebook/ });
    await tile.evaluate((el) => (el as HTMLButtonElement).click());
    await expect(p.getByRole('dialog', { name: /Notebook/ })).toBeVisible();
    await expect(p.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 });
  };
  await open(page);
  const text = `release1110 ${randomBytes(4).toString('hex')}`;
  await page.getByTestId('note-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(` ${text}`);
  await expect(page.getByTestId('note-editor')).toContainText(text);
  await sleep(8000); // saved to desk-notebook's disk
  const before = await onDesk(`systemctl show -p MainPID deskd | cut -d= -f2; ps -o lstart= -p $(systemctl show -p MainPID deskd | cut -d= -f2)`);
  await onDesk('systemctl restart deskd', 120);
  await sleep(15000);
  const after = await onDesk(`curl -s --unix-socket /run/desk/deskd-admin.sock http://desk/health | head -c 300`);
  note('notebook: health after restart', after.includes('"status":"ok"') ? 'ok' : after);
  note('notebook: deskd pid before', before.trim().split('\n')[0]);
  await page.reload();
  await page.locator('.ma-shell').waitFor({ timeout: 60_000 });
  await open(page);
  await expect(page.getByTestId('note-editor')).toContainText(text, { timeout: 60_000 });
  note('notebook', 'text present after the deskd restart and a reload');
  note('console errors', w.errors);
  await context.close();
});

test.describe('over an RPC session', () => {
  let context: BrowserContext;
  let page: Page;
  let client: DeskClient;
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    const bearer = await apiToken(context, loadUser('desk-1'));
    page = await context.newPage();
    await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
    await page.goto(`${APP}${FIXTURE_PATH}`);
    client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
    await client.init();
    let opened: OpenResult = { ok: false };
    for (let i = 0; i < 8 && !opened.ok; i++) {
      opened = await client.open(false);
      if (!opened.ok) await sleep(5000);
    }
    if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code })}`);
  });
  test.afterAll(async () => {
    await client?.finish().catch(() => {});
    await context?.close();
  });

  test('desk truth, and the agent app: a second agent is created, listed and removed', async () => {
    const truth = await deskTruth();
    expect(truth.deskId).toBe(DESK_ID);
    note('versions', { deskd: truth.deskdVersion, rtc: truth.rtcVersion, agent: truth.health.agent });
    expect(truth.health.agent).toBe('connected');
    const providers = await client.rpc<{ providers: unknown[] }>('agent.providers');
    expect(providers.providers.length).toBeGreaterThan(0);
    const before = await client.rpc<{ agents: { id: string; name: string }[] }>('agent.list');
    note('agents before', before.agents.map((a) => a.name));
    const name = `zzcheck${randomBytes(2).toString('hex')}`;
    const made = await client.rpcTry('agent.create', { name }, { idem: true });
    note('agent.create', { ok: made.ok, code: made.code, details: made.details });
    expect(made.ok, JSON.stringify(made.details)).toBe(true);
    const agentId = ((made as unknown as { result?: { agent?: { id: string } } }).result ?? (made as unknown as { agent: { id: string } })).agent?.id;
    expect(agentId).toBeTruthy();
    const listed = await client.rpc<{ agents: { id: string }[] }>('agent.list');
    expect(listed.agents.some((a) => a.id === agentId)).toBe(true);
    await client.rpc('agent.delete', { agentId }, { idem: true });
    const after = await client.rpc<{ agents: { id: string }[] }>('agent.list');
    expect(after.agents.some((a) => a.id === agentId)).toBe(false);
    note('agents', `created ${before.agents.length} to ${before.agents.length + 1}, removed back to ${after.agents.length}`);
  });

  test('files.usage and files.mkdir over the session, and /data/files is 1100:1100 0700', async () => {
    const stat = (await onDesk('stat -c "%u:%g %a" /data/files')).trim();
    note('/data/files', stat);
    expect(stat).toBe('1100:1100 700');
    const u = await client.rpc<{ drive: { totalBytes: number }; uploadableBytes: number }>('files.usage');
    note('files.usage', { totalBytes: u.drive.totalBytes, uploadableBytes: u.uploadableBytes });
    const dir = `release-check-${randomBytes(3).toString('hex')}`;
    const made = await client.rpc<{ created: boolean }>('files.mkdir', { path: dir }, { idem: true });
    expect(made.created).toBe(true);
    const list = await client.rpc<{ entries: { name: string; type: string }[] }>('files.list', { path: '' });
    expect(list.entries.some((e) => e.name === dir && e.type === 'dir')).toBe(true);
    const del = await client.rpc<{ results: { ok: boolean }[] }>('files.delete', { paths: [dir] }, { idem: true });
    expect(del.results[0].ok).toBe(true);
    const log = await onDesk(`journalctl -t deskd --since -3min --no-pager | grep -c '${dir}'`).catch(() => '0');
    note('journal mentions of the folder name', log.trim());
  });

  test('the simplified view on a Wikipedia page', async () => {
    test.setTimeout(4 * 60_000);
    await client.ensureLive();
    const opened = await client.rpc<{ tabId: string }>('browser.tab.open', { url: 'https://en.wikipedia.org/wiki/Cat' }, { idem: true });
    const tabId = opened.tabId;
    let last: { view?: string; fallback?: unknown; mdoc?: unknown } = {};
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000) {
      const r = await client.rpcTry('browser.minified.get', { tabId });
      last = (r.ok ? (r as unknown as { result?: typeof last }).result ?? (r as unknown as typeof last) : { view: `error ${r.code}` }) as typeof last;
      if (last.view === 'simplified') break;
      await sleep(2000);
    }
    note('minified', { view: last.view, fallback: last.fallback, ms: Date.now() - t0, mdocBytes: last.mdoc ? JSON.stringify(last.mdoc).length : 0 });
    await client.rpc('browser.tab.close', { tabId }, { idem: true }).catch(() => {});
    expect(last.view).toBe('simplified');
  });

  test('the gateway link stays up through 3 minutes idle', async () => {
    test.setTimeout(8 * 60_000);
    const since = (await onDesk('date -u +"%Y-%m-%d %H:%M:%S"')).trim();
    await sleep(190_000);
    const st = await client.rpcTry('desk.status.get');
    note('desk.status.get after 190 s', { ok: st.ok, code: st.code });
    expect(st.ok).toBe(true);
    const j = await onDesk(`echo "DOWN=$(journalctl -t deskd --since '${since}' --no-pager | grep -c 'gateway link down')"; echo "UP=$(journalctl -t deskd --since '${since}' --no-pager | grep -c 'gateway link up')"; echo "PING=$(journalctl -t deskd --since '${since}' --no-pager | grep -i -c ping)"; journalctl -t deskd --since '${since}' --no-pager | grep -i -E "gateway|ping" | tail -4 | cut -c1-200`);
    note('journal over the idle', j.replace(/\n/g, ' | '));
    expect(j).toContain('DOWN=0');
  });
});
