// Notebook labels (ADR 0091) and the Browser's downloads and kept tab order (ADR 0092) on the staging test desk, as the e2e test
// account, over a desk RPC session (the staging Desk app may not carry either UI yet). Run after the gate, never beside it,
// under ~/work/.test-desk.lock:  npx playwright test -c release-1110 notebook-ls.spec.ts
// Logged: method names, ids, counts, orders by short hash. No page text beyond a random marker, no file contents.
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, apiToken, loadUser, onDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[ls] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const h8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const HEALTH = `curl -s --unix-socket /run/desk/deskd-admin.sock http://desk/health`;

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

type Page_ = { id: string; tabId: string; title: string; label?: string | null; deletedAt: number | null };
const tree = () => client.rpc<{ tabs: { id: string; notebookId: string }[]; pages: Page_[] }>('notebook.tree');
const pageOf = async (id: string) => (await tree()).pages.find((p) => p.id === id);

test('Notebook: a page label is set, read back, kept through a desk-notebook restart, found by search, duplicated and cleared', async () => {
  test.setTimeout(8 * 60_000);
  const t = await tree();
  const tabId = t.tabs[0].id;
  const marker = `lblmark${randomBytes(4).toString('hex')}`;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `${marker} release check` }] }] };
  const made = await client.rpc<{ page: Page_ }>('notebook.page.import', { tabId, doc }, { idem: true });
  const id = made.page.id;
  note('imported a page', { label: made.page.label ?? null });
  let dupId = '';
  try {
    const set = await client.rpcTry('notebook.page.label', { pageId: id, label: 'rose' }, { idem: true });
    note('notebook.page.label rose', { ok: set.ok, code: set.code });
    expect(set.ok).toBe(true);
    expect((await pageOf(id))?.label).toBe('rose');
    note('read back from notebook.tree', 'rose');

    const before = (await onDesk('systemctl show -p MainPID desk-notebook | cut -d= -f2')).trim();
    await onDesk('systemctl restart desk-notebook', 120);
    const after = (await onDesk('systemctl show -p MainPID desk-notebook | cut -d= -f2')).trim();
    note('desk-notebook restarted', { pidChanged: before !== after });
    expect(before).not.toBe(after);
    let back: Page_ | undefined;
    for (let i = 0; i < 20 && !back; i++) {
      await sleep(2000);
      const r = await client.rpcTry('notebook.tree');
      const pages = r.ok ? ((r as unknown as { result?: { pages: Page_[] } }).result?.pages ?? (r as unknown as { pages: Page_[] }).pages) : undefined;
      back = pages?.find((p) => p.id === id);
    }
    note('label after the restart', back?.label ?? null);
    expect(back?.label).toBe('rose');

    const hits = await client.rpc<{ hits: { pageId: string; label?: string | null }[] }>('notebook.search', { query: marker, labels: ['rose'] });
    note('search by label rose', { hits: hits.hits.length, found: hits.hits.some((h) => h.pageId === id), hitLabel: hits.hits.find((h) => h.pageId === id)?.label });
    expect(hits.hits.some((h) => h.pageId === id)).toBe(true);
    const other = await client.rpc<{ hits: { pageId: string }[] }>('notebook.search', { query: marker, labels: ['blue'] });
    note('search by label blue (should miss)', other.hits.some((h) => h.pageId === id));
    expect(other.hits.some((h) => h.pageId === id)).toBe(false);

    const dup = await client.rpc<{ page: Page_ }>('notebook.page.duplicate', { pageId: id }, { idem: true });
    dupId = dup.page.id;
    note('duplicate', { differentId: dupId !== id, label: dup.page.label ?? null });
    expect(dupId).not.toBe(id);
    expect(dup.page.label).toBe('rose');
    const dupHits = await client.rpc<{ hits: { pageId: string }[] }>('notebook.search', { query: marker });
    note('search finds both pages', dupHits.hits.filter((h) => h.pageId === id || h.pageId === dupId).length);

    const bad = await client.rpcTry('notebook.page.label', { pageId: id, label: 'chartreuse' }, { idem: true });
    note('an unknown label name is refused', { ok: bad.ok, code: bad.code });
    expect(bad.ok).toBe(false);

    const clr = await client.rpcTry('notebook.page.label', { pageId: id, label: null }, { idem: true });
    expect(clr.ok).toBe(true);
    const cleared = await pageOf(id);
    note('label after clearing', cleared?.label ?? null);
    expect(cleared?.label ?? null).toBeNull();
  } finally {
    for (const p of [id, dupId].filter(Boolean)) await client.rpcTry('notebook.page.trash', { pageId: p }, { idem: true });
  }
  const j = await onDesk(`journalctl -t deskd --since -10min --no-pager | grep -c '${marker}' || true`);
  note('journal mentions of the page text marker', j.trim());
  expect(j.trim()).toBe('0');
});

test('Browser downloads (LS-31): deskd reports a start and an end over browser.downloads', async () => {
  test.setTimeout(5 * 60_000);
  await client.ensureLive();
  const sub = await client.c<{ ok: boolean; code?: string }>('subscribeDownloads');
  note('SUB browser.downloads', { ok: sub.ok, code: sub.code });
  expect(sub.ok).toBe(true);
  const name = `ma-ls31-${randomBytes(3).toString('hex')}.txt`;
  const url = `https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3D${name}&Content-Type=text/plain`;
  const t0 = Date.now();
  const opened = await client.rpc<{ tabId: string }>('browser.tab.open', { url }, { idem: true });
  type Dl = { id: string; name: string; state: string; receivedBytes: number; totalBytes: number; filesPath?: string };
  let seen: { at: number; d: Dl }[] = [];
  let last: Dl | undefined;
  while (Date.now() - t0 < 60_000) {
    const evs = await client.c<{ t: number; downloads: Dl[] }[]>('downloadEvents');
    seen = evs.flatMap((e) => e.downloads.filter((d) => d.name.startsWith('ma-ls31-')).map((d) => ({ at: e.t, d })));
    last = seen.at(-1)?.d;
    if (last?.state === 'completed' || last?.state === 'canceled') break;
    await sleep(300);
  }
  const states = [...new Set(seen.map((s) => s.d.state))];
  note('states seen', states);
  note('download', { state: last?.state, receivedBytes: last?.receivedBytes, totalBytes: last?.totalBytes, filesPath: last?.filesPath ?? null, sawAnAddress: JSON.stringify(last ?? {}).includes('httpbin'), ms: Date.now() - t0 });
  const h = (await onDesk(HEALTH)).match(/"downloads":(\d+)/)?.[1];
  note('/health browser.downloads', h ?? 'absent');
  const ondisk = await onDesk(`ls -l /data/browser/downloads 2>&1 | grep -c '${name}' || true; stat -c '%s' /data/browser/downloads/${name} 2>&1; rm -f /data/browser/downloads/${name}`);
  note('on the desk (count, bytes)', ondisk.trim().replace(/\n/g, ' '));
  await client.rpc('browser.tab.close', { tabId: opened.tabId }, { idem: true }).catch(() => {});
  expect(last?.state).toBe('completed');
  expect(last?.receivedBytes).toBe(last?.totalBytes);
  const jn = await onDesk(`journalctl -t deskd --since -10min --no-pager | grep -c '${name}' || true`);
  note('journal mentions of the file name', jn.trim());
  expect(jn.trim()).toBe('0');
});

test('Browser tab order (LS-36): three tabs keep their order across a Browser stop and start', async () => {
  test.setTimeout(8 * 60_000);
  await client.ensureLive();
  for (const t of await client.tabs()) if (t.url.includes('ls36=')) await client.rpcTry('browser.tab.close', { tabId: t.tabId }, { idem: true }); // left by an earlier run
  const n = randomBytes(2).toString('hex');
  const urls = [`https://example.com/?ls36=${n}-1`, `https://example.org/?ls36=${n}-2`, `https://www.iana.org/?ls36=${n}-3`];
  const ids: string[] = [];
  for (const u of urls) {
    ids.push((await client.rpc<{ tabId: string }>('browser.tab.open', { url: u }, { idem: true })).tabId);
    await sleep(1500);
  }
  // Most recently used differs from the strip: use the first tab last.
  await client.rpc('browser.tab.activate', { tabId: ids[2] }, { idem: true });
  await sleep(800);
  await client.rpc('browser.tab.activate', { tabId: ids[0] }, { idem: true });
  await sleep(3000); // deskd writes the order file
  const order = async () => (await client.tabs()).map((t) => t.url);
  const before = await order();
  note('tabs before (hashes of addresses, in strip order)', before.map(h8));
  note('the order file', (await onDesk('stat -c "%U %a %s bytes" /data/desk/browser-tab-order.json; grep -o "\\"id\\"" /data/desk/browser-tab-order.json | wc -l')).trim().replace(/\n/g, ' | '));
  const since = (await onDesk('date -u +"%Y-%m-%d %H:%M:%S"')).trim();
  // As an idle desk does: the stream off first (with it on, deskd starts Chromium again under a plain `systemctl stop`), then the
  // unit stopped, then a wake the way a member's press does it, the stream live, which has deskd start the unit through units.sock.
  const off = await client.rpcTry('browser.stream.set', { state: 'off' }, { deadlineMs: 40_000, timeoutMs: 45_000 });
  note('browser.stream.set off', { ok: off.ok, code: off.code });
  await onDesk('systemctl stop desk-browser', 150);
  note('desk-browser after the stop', (await onDesk('systemctl is-active desk-browser || true')).trim());
  await sleep(5000);
  await client.ensureLive().catch((e) => note('ensureLive', String(e).slice(0, 160)));
  let after: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await sleep(3000);
    const r = await client.rpcTry('browser.tab.list');
    if (r.ok) {
      after = ((r as unknown as { tabs?: { url: string }[] }).tabs ?? (r as unknown as { result?: { tabs: { url: string }[] } }).result?.tabs ?? []).map((t) => t.url);
      if (after.length >= before.length && urls.every((u) => after.includes(u))) break;
    }
  }
  note('tabs after (hashes, in strip order)', after.map(h8));
  note('seconds to the tabs being back', Math.round((Date.now() - t0) / 1000));
  note('same order', JSON.stringify(before) === JSON.stringify(after));
  note('deskd log lines about the order since the stop', (await onDesk(`journalctl -t deskd --since '${since}' --no-pager | grep -i -c 'tab order' || true`)).trim());
  for (const id of ids) await client.rpcTry('browser.tab.close', { tabId: id }, { idem: true });
  expect(after).toEqual(before);
});

test('the Agent window opens', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const { signInApp, focusTestDesk, watch } = await import('../tests/lib');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const w = watch(p);
  await signInApp(ctx, p, loadUser('desk-1'));
  await focusTestDesk(p, w);
  const tile = p.getByRole('group', { name: /^test-desk/ }).getByRole('button', { name: /^Agent/ });
  await tile.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(p.getByRole('dialog', { name: /Agent/ })).toBeVisible({ timeout: 60_000 });
  note('Agent window', 'open');
  note('console errors', w.errors);
  await ctx.close();
});
