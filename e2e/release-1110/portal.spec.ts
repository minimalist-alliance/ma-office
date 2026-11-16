// The office's portal in the member's Browser (deskd release 2026.11.12-46f4e78, services/deskd/docs/API.md section 10, "The office in
// the Browser"), on the staging test desk through staging's real Desk app, as the e2e test account. Over the member RPCs only:
//   1. browser.tab.navigate and browser.tab.open to the office end on the staging portal (deskd's own navigations go straight there);
//   2. a page that links to the office, clicked through the input path (BUTTON events), ends on the portal too (Chromium's blocked
//      page, replaced by deskd);
//   3. api. stays Chromium's blocked page (forbidden, never the portal);
//   4. the Forums still open.
// The portal page may or may not be served on staging: a tab that ends on the portal's address, with or without an error page of
// its own, proves the redirect, so this reads only the tab's address from deskd's tab model.
// Run after the gate, never beside it:  npx playwright test -c release-1110 portal.spec.ts
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { APP, apiToken, loadUser } from '../tests/lib';
import { DeskClient, FIXTURE_HTML, FIXTURE_PATH, PAGES_DIR, deployPages, deskRun, nx, ny, removePages, sleep, type OpenResult, type Tab } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[portal] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const OFFICE = 'https://office.minimalistalliance.com/';
const PORTAL_HOST = 'portal.staging.minimalistalliance.com';
const LINK_PAGE = `<!doctype html><meta charset="utf-8"><title>portal link</title><style>html,body{margin:0;background:#fff}a{position:fixed;inset:0;display:block;font:48px sans-serif}</style><a id="go" href="${OFFICE}">to the office</a>`;

const host = (u: string): string => { try { return new URL(u).hostname; } catch { return ''; } };

let client: DeskClient;
let page: import('@playwright/test').Page;
let context: import('@playwright/test').BrowserContext;
const extraTabs: string[] = [];

/** Polls the tab model until `ok` holds for the tab; returns the last tab seen. */
async function waitTab(tabId: string, ok: (t: Tab) => boolean, timeoutMs = 30_000): Promise<Tab | undefined> {
  const t0 = Date.now();
  let last: Tab | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = (await client.tabs()).find((t) => t.tabId === tabId);
    if (last && ok(last)) return last;
    await sleep(300);
  }
  return last;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  context = await browser.newContext();
  const bearer = await apiToken(context, loadUser('desk-1'));
  page = await context.newPage();
  await page.route(`${APP}${FIXTURE_PATH}`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }));
  await page.goto(`${APP}${FIXTURE_PATH}`);
  client = new DeskClient(page, bearer, randomBytes(3).toString('hex'));
  await client.init();
  let opened: OpenResult = { ok: false };
  for (let i = 0; i < 8 && !opened.ok; i++) { opened = await client.open(false); if (!opened.ok) await sleep(5000); }
  expect(opened.ok, 'a session opened').toBe(true);
  await client.ensureLive();
  await deployPages();
  const body = Buffer.from(LINK_PAGE).toString('base64');
  await deskRun(`echo ${body} | base64 -d > ${PAGES_DIR}/portal-link.html && chmod 644 ${PAGES_DIR}/portal-link.html && echo ok`);
});

test.afterAll(async () => {
  for (const tabId of extraTabs) await client?.rpcTry('browser.tab.close', { tabId }, { idem: true, timeoutMs: 15_000 }).catch(() => {});
  await client?.finish().catch(() => {});
  await removePages().catch(() => {});
  await context?.close().catch(() => {});
});

test('1 deskd navigate and a new tab to the office go straight to the portal', async () => {
  test.setTimeout(3 * 60_000);
  const { tabId } = await client.show('title.html');
  const nav = await client.rpcTry('browser.tab.navigate', { url: OFFICE, tabId }, { idem: true });
  note('1 navigate', { ok: nav.ok, code: nav.code, result: nav.result });
  expect(nav.ok, 'navigate to the office is answered, not refused').toBe(true);
  const tab = await waitTab(tabId, (t) => host(t.url) === PORTAL_HOST);
  note('1 tab after navigate', { host: host(tab?.url ?? ''), url: tab?.url });
  expect(host(tab?.url ?? ''), 'the tab is on the staging portal').toBe(PORTAL_HOST);

  const opened = await client.rpcTry('browser.tab.open', { url: OFFICE }, { idem: true });
  note('1 open', { ok: opened.ok, code: opened.code });
  expect(opened.ok, 'a new tab on the office is answered').toBe(true);
  const newId = (opened.result as unknown as { tabId: string }).tabId;
  extraTabs.push(newId);
  const t2 = await waitTab(newId, (t) => host(t.url) === PORTAL_HOST);
  note('1 new tab', { host: host(t2?.url ?? '') });
  expect(host(t2?.url ?? ''), 'the new tab is on the staging portal').toBe(PORTAL_HOST);
});

test('2 a link to the office, clicked in the page, ends on the portal', async () => {
  test.setTimeout(3 * 60_000);
  await client.ensureLive();
  const { tabId } = await client.show('portal-link.html');
  const ready = await waitTab(tabId, (t) => t.url.includes('portal-link.html') && !t.loading, 20_000);
  expect(ready?.url, 'the link page is showing').toContain('portal-link.html');
  const centre = { x: nx(960), y: ny(540) };
  await client.c('event', { type: 'MOVE', ...centre });
  await sleep(150);
  await client.c('event', { type: 'BUTTON', down: true, button: 1, ...centre });
  await sleep(40);
  await client.c('event', { type: 'BUTTON', down: false, button: 1, ...centre });
  const tab = await waitTab(tabId, (t) => host(t.url) === PORTAL_HOST, 30_000);
  note('2 tab after the click', { host: host(tab?.url ?? ''), canGoBack: tab?.canGoBack });
  expect(host(tab?.url ?? ''), 'the click ended on the staging portal').toBe(PORTAL_HOST);
  expect(host(tab?.url ?? ''), 'never left on the office').not.toBe('office.minimalistalliance.com');
});

test('3 api. stays Chromium\'s blocked page', async () => {
  test.setTimeout(3 * 60_000);
  const { tabId } = await client.show('title.html');
  const nav = await client.rpcTry('browser.tab.navigate', { url: 'https://api.minimalistalliance.com/', tabId }, { idem: true });
  note('3 navigate', { ok: nav.ok, code: nav.code, details: nav.details, netError: (nav.result as unknown as { netError?: string } | undefined)?.netError });
  const refused = !nav.ok && nav.code === 'forbidden';
  const netError = (nav.result as unknown as { netError?: string } | undefined)?.netError;
  expect(refused || !!netError, 'api. is refused as blocked').toBe(true);
  await sleep(2000);
  const tab = (await client.tabs()).find((t) => t.tabId === tabId);
  note('3 tab', { host: host(tab?.url ?? '') });
  expect(host(tab?.url ?? ''), 'api. is not the portal').not.toBe(PORTAL_HOST);
});

test('4 the Forums still open', async () => {
  test.setTimeout(3 * 60_000);
  const { tabId } = await client.show('title.html');
  const nav = await client.rpcTry('browser.tab.navigate', { url: 'https://forums.minimalistalliance.com/', tabId }, { idem: true });
  const netError = (nav.result as unknown as { netError?: string } | undefined)?.netError;
  note('4 navigate', { ok: nav.ok, code: nav.code, netError });
  expect(nav.ok, 'navigate to the Forums is answered').toBe(true);
  expect(netError, 'no network error').toBeUndefined();
  const tab = await waitTab(tabId, (t) => host(t.url).endsWith('minimalistalliance.com') && !t.url.includes('127.0.0.1') && !t.loading, 30_000);
  note('4 tab', { host: host(tab?.url ?? ''), title: tab?.title });
  expect(host(tab?.url ?? ''), 'on the Forums, not the portal or a block').toMatch(/^forums\./);
});
