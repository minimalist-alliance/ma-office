// The local backend's half of ADR 0091, on fake-indexeddb: page labels kept with the page, a duplicate with its text, colors
// and label, a notebook file brought in, and search by label. Fake text only.
import { IDBFactory } from 'fake-indexeddb';
import { Node } from '@tiptap/pm/model';
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBackend } from '../../src/local/localBackend.ts';
import { parseNotebookFile, toNotebookFile } from '../../src/model/notebookFile.ts';
import { DOC_FIELD, notebookSchema, type PMNode } from '../../src/model/schema.ts';
import { labelOf } from '../../src/model/tree.ts';

const t = (text: string, ...marks: { type: string; attrs?: Record<string, unknown> }[]): PMNode => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const doc = (...content: PMNode[]): PMNode => ({ type: 'doc', content });
const h1 = (text: string): PMNode => ({ type: 'heading', attrs: { level: 1 }, content: [t(text)] });
const p = (...content: PMNode[]): PMNode => ({ type: 'paragraph', content });

const COLORED = doc(h1('Garden'), { type: 'paragraph', attrs: { color: 'violet' }, content: [t('water '), t('daily', { type: 'highlight', attrs: { color: 'green' } }), t(' now', { type: 'textColor', attrs: { color: 'blue' } })] });

let clock = new Date(2026, 10, 10, 9, 0, 0).getTime();
const backends: LocalBackend[] = [];
function make(idb = new IDBFactory()) {
  const b = new LocalBackend({ idb, now: () => clock, storeDebounceMs: 0, writeBatchMs: 0 });
  backends.push(b);
  return { b, idb };
}

afterEach(async () => {
  for (const b of backends.splice(0)) await b.close().catch(() => undefined);
});

async function pageWith(b: LocalBackend, body: PMNode): Promise<{ tabId: string; pageId: string }> {
  const { tab, page } = await b.createNotebook('Home');
  const s = b.openPage(page.id);
  await s.ready;
  prosemirrorToYXmlFragment(Node.fromJSON(notebookSchema(), body), s.doc.getXmlFragment(DOC_FIELD));
  s.close();
  await b.flush();
  return { tabId: tab.id, pageId: page.id };
}

describe('page labels', () => {
  it('are kept with the page, survive a reopen, and change neither updatedAt nor the text', async () => {
    const { b, idb } = make();
    await b.ready();
    const { pageId } = await pageWith(b, COLORED);
    const before = b.tree().byId[pageId];
    clock += 60_000;
    await b.setPageLabel(pageId, 'rose');
    expect(b.tree().byId[pageId]).toMatchObject({ label: 'rose', updatedAt: before?.updatedAt, title: 'Garden' });
    await b.close();

    const again = make(idb).b;
    await again.ready();
    expect(labelOf(again.tree().byId[pageId] ?? {})).toBe('rose');
    await again.setPageLabel(pageId, null);
    expect(again.tree().byId[pageId]).not.toHaveProperty('label');
    await expect(again.setPageLabel(pageId, '#ff0000' as never)).rejects.toThrow();
  });

  it('a page from before labels has none', async () => {
    const { b } = make();
    await b.ready();
    const { notebook, tab } = await b.createNotebook('Old');
    const rec = { id: 'old-page', tabId: tab.id, sortKey: 5, title: '', snippet: '', wordCount: 0, hasChecklist: false, createdAt: clock, updatedAt: clock, deletedAt: null, rowVersion: 1 };
    await b.importData({ notebooks: [notebook], tabs: [tab], pages: [{ rec, doc: doc(h1('Before colors'), p(t('plain', { type: 'highlight', attrs: { color: 'yellow' } }))) }] });
    expect(b.tree().byId['old-page']).toMatchObject({ title: 'Before colors' });
    expect(labelOf(b.tree().byId['old-page'] ?? {})).toBeNull();
    expect(JSON.stringify(await b.pageContent('old-page'))).toContain('"color":"yellow"');
  });
});

describe('duplicatePage', () => {
  it('copies the text, colors and label right after the original, with a fresh history', async () => {
    const { b } = make();
    await b.ready();
    const { tabId, pageId } = await pageWith(b, COLORED);
    const other = await b.createPage(tabId, { after: pageId });
    await b.setPageLabel(pageId, 'slate');
    const copy = await b.duplicatePage(pageId);
    expect(b.tree().pages[tabId]?.map((x) => x.id)).toEqual([pageId, copy.id, other.id]);
    expect(copy).toMatchObject({ title: 'Garden', label: 'slate', wordCount: 4, deletedAt: null });
    expect(await b.pageContent(copy.id)).toEqual(await b.pageContent(pageId));
    expect(await b.versions(copy.id)).toEqual([]);
    expect((await b.search('daily')).map((h) => h.pageId).sort()).toEqual([pageId, copy.id].sort());
    // An open page is copied as it is on screen.
    const s = b.openPage(pageId);
    await s.ready;
    const live = await b.duplicatePage(pageId);
    s.close();
    expect(await b.pageContent(live.id)).toEqual(await b.pageContent(pageId));
    await b.trashPage(pageId);
    await expect(b.duplicatePage(pageId)).rejects.toThrow();
  });
});

describe('importPage and the notebook file', () => {
  it('exports pages and brings them back with their colors and labels, in order', async () => {
    const { b } = make();
    await b.ready();
    const { tabId, pageId } = await pageWith(b, COLORED);
    await b.setPageLabel(pageId, 'amber');
    const file = toNotebookFile([{ rec: b.tree().byId[pageId] as never, doc: await b.pageContent(pageId) }]);

    const target = make().b;
    await target.ready();
    const { tab } = await target.createNotebook('Elsewhere');
    const parsed = parseNotebookFile(file);
    const made = await target.importPage(tab.id, parsed.pages[0] as never);
    expect(made).toMatchObject({ title: 'Garden', label: 'amber' });
    expect(await target.pageContent(made.id)).toEqual(await b.pageContent(pageId));
    expect(target.tree().pages[tab.id]?.[0]?.id).toBe(made.id);
    void tabId;
    await expect(target.importPage(tab.id, { title: '', label: null, doc: { type: 'doc', content: [{ type: 'bulletList', content: [p(t('x'))] }] } })).rejects.toThrow();
  });
});

describe('search by label', () => {
  it('filters hits to the labels asked for, says each hit\'s label, and lists them with no words', async () => {
    const { b } = make();
    await b.ready();
    const first = await pageWith(b, doc(h1('Beans'), p(t('sow beans'))));
    const second = await b.createPage(first.tabId);
    const s = b.openPage(second.id);
    await s.ready;
    prosemirrorToYXmlFragment(Node.fromJSON(notebookSchema(), doc(h1('Peas'), p(t('sow peas')))), s.doc.getXmlFragment(DOC_FIELD));
    s.close();
    await b.flush();
    await b.setPageLabel(first.pageId, 'blue');
    expect((await b.search('sow')).map((h) => [h.title, h.label ?? null])).toEqual(
      expect.arrayContaining([
        ['Beans', 'blue'],
        ['Peas', null],
      ]),
    );
    expect((await b.search('sow', { labels: ['blue'] })).map((h) => h.title)).toEqual(['Beans']);
    expect((await b.search('', { labels: ['blue'] })).map((h) => h.title)).toEqual(['Beans']);
    expect(await b.search('', { labels: ['green'] })).toEqual([]);
  });
});
