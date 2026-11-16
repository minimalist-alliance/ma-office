// The Agent's Notebook tools at size (draft ADR "the Agent's tools and approvals" §17, Notebook): a 100-printed-page
// page read whole in parts and exactly, edited and undone; a 10,000-page notebook searched and outlined; and the
// latencies the bar names, through the real socket as deskd calls: search 200 ms over 10,000 pages, a read 150 ms, and
// an append showing in an open page within 500 ms (p95 each). Each prints a PERF line; the figures in the README are
// these, from the box named there. Fake text only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { doc, fakePages, h1, p, setBody, textOf } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { fromMarkdown } from '../src/markdown.ts';
import { cleanDoc, docState, notebookSchema, type PMNode } from '../src/model.ts';
import { pageMarkdown } from '../src/pageMarkdown.ts';
import { Node } from '@tiptap/pm/model';
import { OUTLINE_PAGES, READ_CHARS } from '../src/agent.ts';

const PAGES = 10_000;
const TABS = 10;
const PER_TAB = PAGES / TABS;
const ROUNDS = 30;

let h: Harness;
let s: DeskdSession;
const clients: Client[] = [];
const norm = (d: PMNode): unknown => Node.fromJSON(notebookSchema(), cleanDoc(d)?.doc).toJSON();

function percentile(xs: number[], q: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
}
async function timed(n: number, fn: (i: number) => Promise<unknown>): Promise<{ p50: number; p95: number }> {
  const ms: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    await fn(i);
    ms.push(performance.now() - t0);
  }
  return { p50: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
}
const report = (name: string, r: { p50: number; p95: number }): void => {
  console.log(`PERF ${name} p50=${r.p50.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms`);
};

/** The whole page as Markdown, part by part, as an agent reads it. */
async function readAll(pageId: string): Promise<{ markdown: string; parts: number }> {
  let markdown = '';
  let from: number | null = 0;
  let parts = 0;
  while (from !== null) {
    const r: any = await s.rpc('notebook.page.markdown', { pageId, from });
    expect(r.markdown.length).toBeLessThanOrEqual(READ_CHARS);
    markdown += r.markdown;
    from = r.next;
    parts += 1;
  }
  return { markdown, parts };
}

let bigPage = '';
let bigTab = '';

beforeAll(async () => {
  // The Markdown copies (readable/) stay out of the way: they're timed elsewhere.
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100, readableDebounceMs: 600_000 });
  s = h.session();
  const { tabId, pageId } = await makeNotebook(s);
  bigTab = tabId;
  bigPage = pageId;
  const c = new Client(h.socket);
  clients.push(c);
  const provider = c.open(pageId);
  await synced(provider);
  setBody(provider.document, { ...fakePages(100), content: [h1('The big page'), ...(fakePages(100).content ?? [])] });
  await until('ack', () => !provider.hasUnsyncedChanges, 30_000);
  c.destroy();
  clients.splice(0);
  await until('the page to unload', () => !h.service.pages.open.has(pageId), 30_000);
  // 10,000 more pages in ten tabs of their own, written as one transaction. (A page goes into its tab's order, which
  // reads the tab's pages, so one tab of 10,000 would make this setup quadratic: 116 s, against a tenth of that.)
  const notebookId = (await s.rpc('notebook.tree')).notebooks[0].id;
  const archives: string[] = [];
  for (let t = 0; t < TABS; t += 1) archives.push((await s.rpc('notebook.tab.create', { notebookId, title: `Archive ${t}` })).tab.id);
  const t0 = performance.now();
  const words = ['harbor', 'lantern', 'meadow', 'quartz', 'ember', 'willow', 'saffron', 'glacier', 'orchid', 'cobalt'];
  h.service.db.tx(() => {
    for (let i = 0; i < PAGES; i += 1) {
      const body: PMNode = doc(h1(`Archive note ${i}`), p(`${words[i % 10]} ${words[(i * 7) % 10]} entry number ${i} of the archive, with a few more words`), p(`unique${i}marker`));
      const made = docState(body);
      h.service.notebook.addPage(archives[i % TABS] as string, null, { state: made.state, doc: body, label: null });
    }
  });
  console.log(`SETUP ${PAGES} pages in ${(performance.now() - t0).toFixed(0)}ms`);
}, 300_000);

afterAll(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

describe('a 100-printed-page page', () => {
  it('reads whole in parts of at most 20,000 characters, and the parts are exactly the page', async () => {
    const { markdown, parts } = await readAll(bigPage);
    expect(parts).toBeGreaterThan(10);
    // page.content comes in parts of 512 KiB too.
    let json = '';
    let cursor: string | null = null;
    do {
      const r: any = await s.rpc('notebook.page.content', { pageId: bigPage, ...(cursor ? { cursor } : {}) });
      json += r.part;
      cursor = r.next;
    } while (cursor);
    const stored = JSON.parse(json) as PMNode;
    expect(markdown).toBe(pageMarkdown(stored));
    expect(norm(fromMarkdown(markdown))).toEqual(norm(stored));
    report('read.part.100pages', await timed(ROUNDS, () => s.rpc('notebook.page.markdown', { pageId: bigPage })));
    const whole = await timed(5, () => readAll(bigPage));
    report('read.whole.100pages', whole);
  }, 120_000);

  it('takes an append, a replacement and their undo, exactly', async () => {
    const before = (await readAll(bigPage)).markdown;
    const a = await s.rpc('notebook.page.agentEdit', { op: 'append', pageId: bigPage, markdown: '## Summary\n\n- one\n- two', agentName: 'ag-1' });
    const r = await s.rpc('notebook.page.agentEdit', { op: 'replace_text', pageId: bigPage, find: 'end-100', markdown: 'the end', agentName: 'ag-1' });
    expect((await readAll(bigPage)).markdown).toBe(`${before.replace('end-100', 'the end')}\n## Summary\n\n- one\n- two\n`);
    await s.rpc('notebook.page.agentUndo', { editId: r.editId });
    await s.rpc('notebook.page.agentUndo', { editId: a.editId });
    expect((await readAll(bigPage)).markdown).toBe(before);
  }, 120_000);
});

describe('latency, through the socket as deskd calls', () => {
  it('a read of a page: 150 ms p95', async () => {
    const r = await timed(ROUNDS, (i) => s.rpc('notebook.page.markdown', { pageId: (h.service.db.get<{ id: string }>('SELECT id FROM pages WHERE title = ?', `Archive note ${i * 97}`) as { id: string }).id }));
    report('read.page.in10000', r);
    expect(r.p95).toBeLessThan(150);
    const big = await timed(ROUNDS, () => s.rpc('notebook.page.markdown', { pageId: bigPage }));
    report('read.page.100pages', big);
    expect(big.p95).toBeLessThan(150);
  }, 120_000);

  it('search over 10,000 pages: 200 ms p95', async () => {
    const r = await timed(ROUNDS, (i) => s.rpc('notebook.search', { query: i % 2 ? `unique${i * 31}marker` : 'harbor entry', limit: 20 }));
    report('search.10000pages', r);
    expect(r.p95).toBeLessThan(200);
    expect((await s.rpc('notebook.search', { query: 'unique4242marker' })).hits).toHaveLength(1);
  }, 120_000);

  it('an append, and the same append showing in an open page: 500 ms p95', async () => {
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    const calls: number[] = [];
    const shown = await timed(ROUNDS, async (i) => {
      const t0 = performance.now();
      const done = s.rpc('notebook.page.agentEdit', { op: 'append', pageId, markdown: `line ${i} from the agent`, agentName: 'ag-1' });
      await until('the editor to show it', () => textOf(provider.document).includes(`line ${i} from the agent`), 5000, 1);
      await done;
      calls.push(performance.now() - t0);
    });
    report('append.shown.open', shown);
    report('append.call', { p50: percentile(calls, 0.5), p95: percentile(calls, 0.95) });
    expect(shown.p95).toBeLessThan(500);
    const onBig = await timed(10, (i) => s.rpc('notebook.page.agentEdit', { op: 'append', pageId: bigPage, markdown: `big ${i}`, agentName: 'ag-1' }));
    report('append.call.100pages', onBig);
    expect(onBig.p95).toBeLessThan(500);
  }, 120_000);
});

describe('a notebook of 10,000 pages', () => {
  it('outlines its notebooks and tabs, and a tab of 1,001 pages 100 at a time', async () => {
    const outline = await s.rpc('notebook.outline', {});
    const tabs = outline.notebooks.flatMap((n: any) => n.tabs);
    const archive = tabs.find((t: any) => t.title === 'Archive 3');
    // Its own first page, and its share of the 10,000.
    const count = PER_TAB + 1;
    expect(archive.pages).toBe(count);
    expect(tabs.filter((t: any) => t.title.startsWith('Archive ')).reduce((n: number, t: any) => n + t.pages, 0)).toBe(PAGES + TABS);
    const first = await s.rpc('notebook.outline', { tabId: archive.tabId });
    expect(first.pages).toHaveLength(OUTLINE_PAGES);
    expect(first.next).toBe(OUTLINE_PAGES);
    const last = await s.rpc('notebook.outline', { tabId: archive.tabId, from: count - 50 });
    expect(last.pages).toHaveLength(50);
    expect(last.next).toBeNull();
    report('outline.tab.1001', await timed(ROUNDS, (i) => s.rpc('notebook.outline', { tabId: archive.tabId, from: (i * 37) % count })));
    report('outline.all', await timed(ROUNDS, () => s.rpc('notebook.outline', {})));
    expect(tabs.find((t: any) => t.tabId === bigTab).pages).toBe(1);
    expect(outline.more).toBe(false);
  }, 120_000);
});
