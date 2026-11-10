// What every spec checks: no console errors, no request that isn't a same-origin GET for the bundle, and
// helpers to search everything the page could have kept for a string that mustn't be there.
import { expect, test as base, type Page } from '@playwright/test';

export interface Watched {
  console: { type: string; text: string }[];
  errors: string[];
  requests: { url: string; method: string; body: string | null }[];
}

export const test = base.extend<{ watched: Watched }>({
  watched: [async ({ page, baseURL }, use) => {
    const w: Watched = { console: [], errors: [], requests: [] };
    page.on('console', (m) => w.console.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => w.errors.push(String(e)));
    page.on('request', (r) => w.requests.push({ url: r.url(), method: r.method(), body: r.postData() }));
    await use(w);
    // After each test: nothing but the bundle's own files, and nothing that went wrong.
    const origin = new URL(baseURL ?? 'http://127.0.0.1').origin;
    const strays = w.requests.filter((r) => r.method !== 'GET' || !(r.url.startsWith(`${origin}/`) || r.url.startsWith('blob:') || r.url.startsWith('data:')));
    expect(strays, 'requests that are not same-origin GETs').toEqual([]);
    expect(w.requests.filter((r) => r.body), 'requests with a body').toEqual([]);
    expect(w.errors, 'page errors').toEqual([]);
    expect(w.console.filter((m) => m.type === 'error' || m.type === 'warning'), 'console errors and warnings').toEqual([]);
  }, { auto: true }],
});

export { expect };

/** Everything the page can keep: Web Storage, cookies, IndexedDB, Cache Storage, and the mock's own state. */
export async function everythingKept(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: Record<string, unknown> = {};
    const dumpStorage = (s: Storage): Record<string, string | null> => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)).map((k) => [k, k && s.getItem(k)]));
    out['local'] = dumpStorage(localStorage);
    out['session'] = dumpStorage(sessionStorage);
    out['cookie'] = document.cookie;
    const dbs = await indexedDB.databases();
    const idb: Record<string, unknown> = {};
    for (const info of dbs) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((ok, no) => {
        const r = indexedDB.open(info.name as string);
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        idb[`${info.name}/${store}`] = await new Promise((ok) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => ok(r.result);
        });
      }
      db.close();
    }
    out['indexedDB'] = idb;
    const caches: Record<string, string[]> = {};
    for (const name of await window.caches.keys()) caches[name] = (await (await window.caches.open(name)).keys()).map((r) => r.url);
    out['caches'] = caches;
    out['mock'] = (window as unknown as { __maAgentMock: { dump(): string } }).__maAgentMock.dump();
    out['dom'] = document.documentElement.outerHTML;
    out['inputs'] = Array.from(document.querySelectorAll('input, textarea')).map((el) => (el as HTMLInputElement).value);
    out['history'] = [location.href, history.length];
    return JSON.stringify(out);
  });
}

/** Opens the demo on a fixture, fast, in a theme. */
export async function open(page: Page, fixture: 'fresh' | 'ready' | 'limit', extra: Record<string, string> = {}): Promise<void> {
  const q = new URLSearchParams({ fixture, speed: 'fast', theme: 'light', ...extra });
  await page.goto(`/?${q}`);
  await expect(page.getByTestId('agent-app')).toBeVisible();
  await expect(page.getByText('Opening the desk team…')).toHaveCount(0);
}

/** Sends from the composer and waits for that message's own reply (not an older one) to finish. */
export async function sendAndWait(page: Page, text: string | null, opts: { timeout?: number } = {}) {
  const replies = page.getByTestId('msg-agent');
  const before = await replies.count();
  if (text !== null) await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-send').click();
  await expect(replies).toHaveCount(before + 1);
  const reply = replies.nth(before);
  await expect(reply).toHaveAttribute('data-state', 'done', { timeout: opts.timeout ?? 10_000 });
  return reply;
}

/** One row of the Activity panel, by its words exactly. */
export function auditRow(page: Page, words: string) {
  return page.getByTestId('activity-panel').locator('.ag-audit-what').getByText(words, { exact: true });
}
