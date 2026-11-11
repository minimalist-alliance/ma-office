// Release checks for desk-notebook (disk-full fix D6, Guild Desk manage_spaces, authz-5 trash) on the staging test desk, a non-guild
// desk, as the e2e test account, over a desk RPC session. Run after the gate, never beside it, under ~/work/.test-desk.lock:
//   npx playwright test -c release-1110 notebook-disk.spec.ts
// Logged: method names, counts, booleans. No page text beyond a random marker.
import { randomBytes } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { APP, apiToken, loadUser, onDesk } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, sleep, type OpenResult } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[nb] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const HEALTH = `curl -s --unix-socket /run/desk/deskd-admin.sock http://desk/health`;

let context: BrowserContext;
let page: Page;
let client: DeskClient;
let bearer: string;

async function openSession(): Promise<void> {
  page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 12 && !opened.ok; i++) {
    opened = await client.open(false);
    if (!opened.ok) await sleep(5000);
  }
  if (!opened.ok) throw new Error(`no session: ${JSON.stringify({ step: opened.step, code: opened.code })}`);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  bearer = await apiToken(context, loadUser('desk-1'));
  await openSession();
});
test.afterAll(async () => {
  await client?.finish().catch(() => {});
  await context?.close();
});

type Page_ = { id: string; tabId: string; deletedAt: number | null };
const tree = () => client.rpc<{ notebooks: { id: string }[]; tabs: { id: string; notebookId: string }[]; pages: Page_[] }>('notebook.tree');
const treeRetry = async () => {
  for (let i = 0; i < 25; i++) {
    const r = await client.rpcTry('notebook.tree');
    if (r.ok) return r.result as unknown as Awaited<ReturnType<typeof tree>>;
    await sleep(2000);
  }
  throw new Error('no tree');
};
const hasText = async (id: string, marker: string) => {
  const r = await client.rpcTry('notebook.page.content', { pageId: id });
  return r.ok && JSON.stringify(r.result).includes(marker);
};

test('a notebook and a tab are created, a page holds text, trash and restore work for the desk owner, text survives both restarts', async () => {
  test.setTimeout(12 * 60_000);
  const marker = `nbdisk${randomBytes(4).toString('hex')}`;

  const nb = await client.rpc<{ notebook: { id: string }; tab: { id: string }; page: Page_ }>('notebook.notebook.create', { title: 'release check' }, { idem: true });
  note('notebook.notebook.create', { ok: !!nb.notebook?.id, tab: !!nb.tab?.id, page: !!nb.page?.id });
  const tab = await client.rpc<{ tab: { id: string }; page: Page_ }>('notebook.tab.create', { notebookId: nb.notebook.id, title: 'second' }, { idem: true });
  note('notebook.tab.create', { ok: !!tab.tab?.id, page: !!tab.page?.id });
  expect(tab.tab.id).not.toBe(nb.tab.id);

  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `${marker} release check` }] }] };
  const made = await client.rpc<{ page: Page_ }>('notebook.page.import', { tabId: tab.tab.id, doc }, { idem: true });
  const id = made.page.id;
  expect(await hasText(id, marker)).toBe(true);
  note('page text before', 'present');

  // trash and restore by the desk's owner
  const trash = await client.rpcTry('notebook.page.trash', { pageId: id }, { idem: true });
  note('notebook.page.trash', { ok: trash.ok, code: trash.code });
  expect(trash.ok).toBe(true);
  expect((await treeRetry()).pages.find((p) => p.id === id)?.deletedAt).toBeTruthy();
  const restore = await client.rpcTry('notebook.page.restore', { pageId: id }, { idem: true });
  note('notebook.page.restore', { ok: restore.ok, code: restore.code });
  expect(restore.ok).toBe(true);
  expect((await treeRetry()).pages.find((p) => p.id === id)?.deletedAt ?? null).toBeNull();
  note('trash then restore', 'page back, deletedAt cleared');
  expect(await hasText(id, marker)).toBe(true);
  await sleep(8000); // saved to desk-notebook's disk

  // a desk-notebook restart
  const nbBefore = (await onDesk('systemctl show -p MainPID desk-notebook | cut -d= -f2')).trim();
  await onDesk('systemctl restart desk-notebook', 120);
  const nbAfter = (await onDesk('systemctl show -p MainPID desk-notebook | cut -d= -f2')).trim();
  expect(nbBefore).not.toBe(nbAfter);
  let ok = false;
  for (let i = 0; i < 25 && !ok; i++) {
    await sleep(2000);
    ok = await hasText(id, marker);
  }
  note('text after the desk-notebook restart', ok);
  expect(ok).toBe(true);

  // a deskd restart, then a new session
  await client.finish().catch(() => {});
  await page.close().catch(() => {});
  const dBefore = (await onDesk('systemctl show -p MainPID deskd | cut -d= -f2')).trim();
  await onDesk('systemctl restart deskd', 120);
  const dAfter = (await onDesk('systemctl show -p MainPID deskd | cut -d= -f2')).trim();
  expect(dBefore).not.toBe(dAfter);
  await sleep(15000);
  await openSession();
  ok = false;
  for (let i = 0; i < 25 && !ok; i++) {
    ok = await hasText(id, marker);
    if (!ok) await sleep(2000);
  }
  note('text after the deskd restart', ok);
  expect(ok).toBe(true);
  const t = await treeRetry();
  expect(t.tabs.some((x) => x.id === tab.tab.id)).toBe(true);
  expect(t.notebooks.some((x) => x.id === nb.notebook.id)).toBe(true);
  note('notebook and both tabs still listed', true);

  await client.rpcTry('notebook.page.trash', { pageId: id }, { idem: true });
  const h = await onDesk(HEALTH);
  note('health after', h.includes('"status":"ok"') ? 'ok' : h.slice(0, 200));
  const j = await onDesk(`journalctl -t deskd -u deskd -u desk-notebook --since -10min --no-pager | grep -c '${marker}' || true`);
  note('journal mentions of the page text marker', j.trim());
  expect(j.trim()).toBe('0');
});
