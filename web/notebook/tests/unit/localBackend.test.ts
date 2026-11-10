// The local backend against fake-indexeddb: structure, persistence, derived fields, activity,
// versions and search. Timers are real but short (store debounce 0), and flush() settles them.
import { IDBFactory } from 'fake-indexeddb';
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { Node } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBackend } from '../../src/local/localBackend.ts';
import { DOC_FIELD, notebookSchema, type PMNode } from '../../src/model/schema.ts';
import { binderSequence, stepPage } from '../../src/model/tree.ts';

const doc = (...blocks: PMNode[]): PMNode => ({ type: 'doc', content: blocks });
const h1 = (text: string): PMNode => ({ type: 'heading', attrs: { level: 1 }, content: text ? [{ type: 'text', text }] : [] });
const p = (text: string): PMNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

/** Replaces a page body the way an editor would, through the page's Y.Doc. */
function setBody(y: import('yjs').Doc, json: PMNode): void {
  prosemirrorToYXmlFragment(Node.fromJSON(notebookSchema(), json), y.getXmlFragment(DOC_FIELD));
}

let clock = new Date(2026, 10, 6, 10, 0, 0).getTime();
const backends: LocalBackend[] = [];
function make(idb = new IDBFactory(), extra: Partial<ConstructorParameters<typeof LocalBackend>[0]> = {}) {
  const b = new LocalBackend({ idb, now: () => clock, storeDebounceMs: 0, writeBatchMs: 0, ...extra });
  backends.push(b);
  return { b, idb };
}

afterEach(async () => {
  for (const b of backends.splice(0)) await b.close().catch(() => undefined);
});

describe('structure', () => {
  it('creates a notebook with a General tab and a blank Title page', async () => {
    const { b } = make();
    await b.ready();
    const { notebook, tab, page } = await b.createNotebook('Trips');
    const t = b.tree();
    expect(t.notebooks.map((n) => n.title)).toEqual(['Trips']);
    expect(t.tabs[notebook.id]?.map((x) => x.title)).toEqual(['General']);
    expect(t.pages[tab.id]?.map((x) => x.id)).toEqual([page.id]);
    expect(await b.pageContent(page.id)).toEqual(doc({ type: 'heading', attrs: { level: 1 } }));
  });

  it('adds pages first, or after a given page, and moves them between tabs', async () => {
    const { b } = make();
    await b.ready();
    const { notebook, tab, page: first } = await b.createNotebook();
    const top = await b.createPage(tab.id);
    const mid = await b.createPage(tab.id, { after: top.id });
    expect(b.tree().pages[tab.id]?.map((x) => x.id)).toEqual([top.id, mid.id, first.id]);
    const { tab: other } = await b.createTab(notebook.id, { title: 'Ideas' });
    await b.movePage(mid.id, other.id, 0);
    expect(b.tree().pages[tab.id]?.map((x) => x.id)).toEqual([top.id, first.id]);
    expect(b.tree().pages[other.id]?.[0]?.id).toBe(mid.id);
  });

  it('"Add tab at this page" moves that page and the ones after it into a new tab after this one', async () => {
    const { b } = make();
    await b.ready();
    const { notebook, tab, page: c } = await b.createNotebook();
    const bPage = await b.createPage(tab.id);
    const a = await b.createPage(tab.id);
    const { tab: last } = await b.createTab(notebook.id, { title: 'Last' });
    const split = await b.addTabAtPage(bPage.id, 'Part two');
    const t = b.tree();
    expect(t.tabs[notebook.id]?.map((x) => x.title)).toEqual(['General', 'Part two', 'Last']);
    expect(t.pages[tab.id]?.map((x) => x.id)).toEqual([a.id]);
    expect(t.pages[split.id]?.map((x) => x.id)).toEqual([bPage.id, c.id]);
    // Paging runs across the tab boundary, in binder order.
    expect(binderSequence(t, notebook.id).map((x) => x.id)).toEqual([a.id, bPage.id, c.id, (t.pages[last.id] ?? [])[0]?.id]);
    expect(stepPage(t, a.id, 1)?.id).toBe(bPage.id);
    expect(stepPage(t, bPage.id, -1)?.id).toBe(a.id);
    expect(stepPage(t, a.id, -1)).toBeNull();
  });

  it('trash hides a page and restore brings it back', async () => {
    const { b } = make();
    await b.ready();
    const { tab, page } = await b.createNotebook();
    await b.trashPage(page.id);
    expect(b.tree().pages[tab.id] ?? []).toEqual([]);
    expect(b.tree().trash.map((x) => x.id)).toEqual([page.id]);
    await b.restorePage(page.id);
    expect(b.tree().pages[tab.id]?.map((x) => x.id)).toEqual([page.id]);
  });

  it('keeps everything across a reload, and empties Trash after 30 days', async () => {
    const { b, idb } = make();
    await b.ready();
    const { notebook, tab, page } = await b.createNotebook('Kept');
    await b.renameTab(tab.id, 'Renamed');
    await b.recolorTab(tab.id, 'rose');
    const gone = await b.createPage(tab.id);
    await b.trashPage(gone.id);
    await b.close();

    clock += 31 * 86_400_000;
    const { b: again } = make(idb);
    await again.ready();
    const t = again.tree();
    expect(t.notebooks.map((n) => n.title)).toEqual(['Kept']);
    expect(t.tabs[notebook.id]?.[0]).toMatchObject({ title: 'Renamed', color: 'rose' });
    expect(t.pages[tab.id]?.map((x) => x.id)).toEqual([page.id]);
    expect(t.byId[gone.id]).toBeUndefined();
  });
});

describe('text', () => {
  it('persists typing through the Y.Doc and derives title, snippet and counts', async () => {
    const { b, idb } = make();
    await b.ready();
    const { page } = await b.createNotebook();
    const s = b.openPage(page.id);
    await s.ready;
    setBody(s.doc, doc(h1('Packing list'), p('Passport, charger and two good books.'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('Tickets')] }] }));
    await b.flush();
    expect(b.tree().byId[page.id]).toMatchObject({ title: 'Packing list', wordCount: 9, hasChecklist: true });
    expect(b.tree().byId[page.id]?.snippet).toBe('Passport, charger and two good books. · Tickets');
    s.close();
    await b.close();

    const { b: again } = make(idb);
    await again.ready();
    const s2 = again.openPage(page.id);
    await s2.ready;
    const json = yXmlFragmentToProsemirrorJSON(s2.doc.getXmlFragment(DOC_FIELD)) as PMNode;
    expect(json.content?.[0]).toEqual(h1('Packing list'));
    s2.close();
  });

  it('compacts many stored updates into one when a page opens', async () => {
    const { b, idb } = make();
    await b.ready();
    const { page } = await b.createNotebook();
    const s = b.openPage(page.id);
    await s.ready;
    for (let i = 0; i < 30; i += 1) {
      setBody(s.doc, doc(h1(`Draft ${i}`)));
      await b.flush();
    }
    s.close();
    await b.close();
    const { b: again } = make(idb);
    await again.ready();
    const s2 = again.openPage(page.id);
    await s2.ready;
    await again.flush();
    const count = await new Promise<number>((resolve) => {
      const open = idb.open('ma-notebook-local');
      open.onsuccess = () => {
        const r = open.result.transaction('updates').objectStore('updates').count();
        r.onsuccess = () => {
          resolve(r.result);
          open.result.close();
        };
      };
    });
    expect(count).toBe(1);
    expect(await again.pageContent(page.id)).toEqual(doc(h1('Draft 29')));
    s2.close();
  });
});

describe('activity and versions', () => {
  it('records created and edited days, with times and counts', async () => {
    clock = new Date(2026, 10, 3, 9, 0).getTime();
    const { b } = make();
    await b.ready();
    const { page } = await b.createNotebook();
    clock = new Date(2026, 10, 5, 14, 30).getTime();
    const s = b.openPage(page.id);
    await s.ready;
    setBody(s.doc, doc(h1('Hello'), p('world')));
    await b.flush();
    s.close();
    await b.flush();
    const rows = await b.activity('2026-11-01', '2026-11-30');
    const byDay = Object.fromEntries(rows.map((r) => [r.day, r]));
    expect(byDay['2026-11-03']).toMatchObject({ created: true, edits: 0 });
    expect(byDay['2026-11-05']).toMatchObject({ created: false, edits: 1, firstAt: clock, lastAt: clock });
    expect(byDay['2026-11-05']?.added).toBeGreaterThan(0);
    expect(await b.activeDays()).toEqual(['2026-11-05', '2026-11-03']);
  });

  it('writes a session version when the page closes, and restores without losing text', async () => {
    clock = new Date(2026, 10, 6, 10, 0).getTime();
    const { b } = make();
    await b.ready();
    const { page } = await b.createNotebook();
    let s = b.openPage(page.id);
    await s.ready;
    setBody(s.doc, doc(h1('First draft')));
    s.close();
    await b.flush();
    const [v1] = await b.versions(page.id);
    expect(v1).toMatchObject({ reason: 'session', title: 'First draft' });

    clock += 60_000;
    s = b.openPage(page.id);
    await s.ready;
    setBody(s.doc, doc(h1('Second draft')));
    await b.flush();
    await b.restoreVersion(page.id, v1?.id ?? '');
    expect(await b.pageContent(page.id)).toEqual(doc(h1('First draft')));
    // The open session sees the restore, as an editor bound to it would.
    expect((yXmlFragmentToProsemirrorJSON(s.doc.getXmlFragment(DOC_FIELD)) as PMNode).content?.[0]).toEqual(h1('First draft'));
    const reasons = (await b.versions(page.id)).map((v) => [v.reason, v.title]);
    expect(reasons).toEqual([
      ['restore', 'First draft'],
      ['session', 'Second draft'],
      ['session', 'First draft'],
    ]);
    expect(b.tree().byId[page.id]?.title).toBe('First draft');
    s.close();
  });

  it('writes an interval version every 30 minutes of continuous editing', async () => {
    clock = new Date(2026, 10, 6, 9, 0).getTime();
    const { b } = make(undefined, { intervalMs: 30 * 60_000 });
    await b.ready();
    const { page } = await b.createNotebook();
    const s = b.openPage(page.id);
    await s.ready;
    for (let m = 0; m <= 40; m += 4) {
      clock += 4 * 60_000;
      setBody(s.doc, doc(h1('Long'), p(`minute ${m}`)));
      await b.flush();
    }
    expect((await b.versions(page.id)).map((v) => v.reason)).toEqual(['interval']);
    s.close();
  });

  it('writes a day_end version when a session runs past midnight', async () => {
    clock = new Date(2026, 10, 6, 23, 0).getTime();
    const { b } = make(undefined, { intervalMs: 3 * 3_600_000 });
    await b.ready();
    const { page } = await b.createNotebook();
    const s = b.openPage(page.id);
    await s.ready;
    setBody(s.doc, doc(h1('Late'), p('one')));
    await b.flush();
    clock += 40 * 60_000;
    setBody(s.doc, doc(h1('Late'), p('one two')));
    await b.flush();
    clock = new Date(2026, 10, 7, 0, 10).getTime();
    setBody(s.doc, doc(h1('Late'), p('one two three')));
    await b.flush();
    const vs = await b.versions(page.id);
    expect(vs.map((v) => v.reason)).toEqual(['day_end']);
    const dayEnd = await b.version(vs[0]?.id ?? '');
    expect(dayEnd?.createdAt).toBe(new Date(2026, 10, 6, 23, 40).getTime());
    expect(dayEnd?.doc).toEqual(doc(h1('Late'), p('one two')));
    expect((await b.versionAsOf(page.id, '2026-11-06'))?.id).toBe(dayEnd?.id);
    expect(await b.versionAsOf(page.id, '2026-11-05')).toBeNull();
    const days = (await b.activity('2026-11-06', '2026-11-07')).map((r) => [r.day, r.edits]);
    expect(days.sort()).toEqual([['2026-11-06', 2], ['2026-11-07', 1]]);
    s.close();
  });

  it('a manual version can be saved on a page that is not open', async () => {
    const { b } = make();
    await b.ready();
    const { page } = await b.createNotebook();
    const v = await b.saveVersion(page.id);
    expect(v).toMatchObject({ reason: 'manual', pageId: page.id });
    expect((await b.version(v?.id ?? ''))?.doc).toEqual(doc({ type: 'heading', attrs: { level: 1 } }));
  });
});

describe('search', () => {
  it('finds pages by prefix, ignores accents and case, weights titles, and skips Trash', async () => {
    const { b } = make();
    await b.ready();
    const { notebook, tab } = await b.createNotebook();
    const mk = async (title: string, body: string) => {
      const pg = await b.createPage(tab.id);
      const s = b.openPage(pg.id);
      await s.ready;
      setBody(s.doc, doc(h1(title), p(body)));
      await b.flush();
      s.close();
      return pg;
    };
    const cafe = await mk('Café list', 'Where to get coffee near the office');
    const notes = await mk('Meeting notes', 'We talked about the café on Main and coffee budgets');
    const old = await mk('Coffee archive', 'old');
    await b.trashPage(old.id);
    await b.flush();

    const hits = await b.search('CAFE');
    expect(hits.map((h) => h.pageId)).toEqual([cafe.id, notes.id]);
    expect(hits[0]?.titleMatches).toEqual([[0, 4]]);
    expect(hits[1]?.snippet.slice(...(hits[1]?.snippetMatches[0] ?? [0, 0]))).toBe('café');
    expect((await b.search('cof bud')).map((h) => h.pageId)).toEqual([notes.id]);
    expect(await b.search('offee')).toEqual([]);
    expect((await b.search('coffee', { notebookId: notebook.id })).length).toBe(2);
    expect((await b.search('coffee', { notebookId: 'elsewhere' })).length).toBe(0);
  });
});
