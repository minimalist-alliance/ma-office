// Search: every word by prefix, ignoring case and accents, title weighted, has:checklist, filters. FTS5 in Node's own
// SQLite, the rules from model/search.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { doc, h1, p, setBody, task } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { type PMNode } from '../src/model.ts';

let h: Harness;
let s: DeskdSession;
let clock = 0;
const clients: Client[] = [];

async function write(tabId: string, body: PMNode): Promise<string> {
  const { page } = await s.rpc('notebook.page.create', { tabId });
  const c = new Client(h.socket);
  clients.push(c);
  const provider = c.open(page.id);
  await synced(provider);
  const title = (body.content?.[0]?.content?.[0]?.text ?? '') as string;
  setBody(provider.document, body);
  await until('the store', () => h.service.notebook.page(page.id)?.title === title, 5000);
  return page.id;
}

const find = async (query: string, extra: Record<string, unknown> = {}) => (await s.rpc('notebook.search', { query, ...extra })).hits;

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 6, 10, 0, 0);
  h = await harness({ storeDebounceMs: 5, storeMaxWaitMs: 20, now: () => clock });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

describe('notebook.search', () => {
  it('prefix, every word, case and accents', async () => {
    const { tabId } = await makeNotebook(s);
    const a = await write(tabId, doc(h1('Café crème'), p('Quarterly résumé for the Zürich office')));
    const b = await write(tabId, doc(h1('Other'), p('Nothing of interest here')));
    expect((await find('caf')).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('CREME')).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('resume zur')).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('resume nothing'))).toEqual([]);
    expect((await find('uarterly'))).toEqual([]); // Only from a word's start.
    expect((await find('interest')).map((x: any) => x.pageId)).toEqual([b]);
    expect(await find('')).toEqual([]);
    expect(await find('   ')).toEqual([]);
  });

  it('nothing typed is an FTS5 operator', async () => {
    const { tabId } = await makeNotebook(s);
    await write(tabId, doc(h1('Plain'), p('words AND more NOT here "quoted" title:x')));
    for (const q of ['"', 'NOT', 'AND OR', 'title:x', 'a*', '(', '-', 'NEAR(a b)', '^x', '"unterminated']) {
      await expect(find(q)).resolves.toBeInstanceOf(Array);
    }
    expect((await find('NOT')).length).toBe(1);
    expect((await find('title:x')).length).toBe(1);
  });

  it('a title hit ranks over a body hit, and hits say where the words are', async () => {
    const { tabId } = await makeNotebook(s);
    const body = await write(tabId, doc(h1('Elsewhere'), p('the apple falls far from the tree')));
    const title = await write(tabId, doc(h1('Apple harvest'), p('nothing about it here')));
    const hits = await find('appl');
    expect(hits.map((x: any) => x.pageId)).toEqual([title, body]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].title).toBe('Apple harvest');
    expect(hits[0].titleMatches).toEqual([[0, 4]]);
    expect(hits[1].titleMatches).toEqual([]);
    expect(hits[1].snippet).toContain('apple');
    const [from, to] = hits[1].snippetMatches[0];
    expect(hits[1].snippet.slice(from, to)).toBe('appl');
    // A snippet is from the body, not the title line.
    expect(hits[0].snippet).toBe('nothing about it here');
  });

  it('has:checklist, alone and with words', async () => {
    const { tabId } = await makeNotebook(s);
    const a = await write(tabId, doc(h1('Shopping'), task('buy pears')));
    await write(tabId, doc(h1('Pears'), p('no boxes here')));
    expect((await find('has:checklist')).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('pears has:checklist')).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('pears')).length).toBe(2);
  });

  it('filters by notebook, tab and date, and leaves Trash out', async () => {
    const { notebookId, tabId } = await makeNotebook(s);
    const other = await s.rpc('notebook.notebook.create', { title: 'Other' });
    const a = await write(tabId, doc(h1('Word here'), p('body')));
    clock += 3 * 86_400_000;
    const b = await write(other.tab.id, doc(h1('Word there'), p('body')));
    expect((await find('word')).length).toBe(2);
    expect((await find('word', { notebookId })).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('word', { tabId: other.tab.id })).map((x: any) => x.pageId)).toEqual([b]);
    expect((await find('word', { fromDay: '2026-11-08' })).map((x: any) => x.pageId)).toEqual([b]);
    expect((await find('word', { toDay: '2026-11-07' })).map((x: any) => x.pageId)).toEqual([a]);
    expect((await find('word', { limit: 1 })).length).toBe(1);
    await s.rpc('notebook.page.trash', { pageId: a });
    expect((await find('word')).map((x: any) => x.pageId)).toEqual([b]);
    await s.rpc('notebook.page.restore', { pageId: a });
    expect((await find('word')).length).toBe(2);
  });

  it('refuses bad params', async () => {
    const e = (await s.rpc('notebook.search', {}).catch((x) => x)) as { code: string; details: { reason: string } };
    expect(e.code).toBe('bad_request');
    expect(e.details.reason).toBe('query');
    expect((await s.rpc('notebook.search', { query: 'x', limit: 0 }).catch((x) => x)).details.reason).toBe('limit');
    expect((await s.rpc('notebook.search', { query: 'x', fromDay: 'soon' }).catch((x) => x)).details.reason).toBe('fromDay');
  });
});
