// Every method in the contract's table, with its errors, over the real socket.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, sleep, synced, until, type DeskdSession } from './helpers/deskd.ts';
import { doc, fakePages, h1, p, setBody } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { buildTree, stepPage, binderSequence } from '../../../web/notebook/src/model/tree.ts';

let h: Harness;
let s: DeskdSession;
const clients: Client[] = [];
let clock = Date.UTC(2026, 10, 6, 10, 0, 0);

const fails = async (call: Promise<unknown>, code: string, reason?: string): Promise<void> => {
  const e = await call.then(
    () => {
      throw new Error(`expected ${code}, and it succeeded`);
    },
    (err: { code: string; details: Record<string, unknown> }) => err,
  );
  expect(e.code).toBe(code);
  if (reason) expect(e.details['reason']).toBe(reason);
};

/** All of the tree, following `next`. */
async function wholeTree(session: DeskdSession) {
  const out = { notebooks: [] as any[], tabs: [] as any[], pages: [] as any[], rev: 0, replies: 0 };
  let cursor: string | undefined;
  do {
    const r: any = await session.rpc('notebook.tree', cursor ? { cursor } : {});
    out.notebooks.push(...r.notebooks);
    out.tabs.push(...r.tabs);
    out.pages.push(...r.pages);
    out.rev = r.rev;
    out.replies += 1;
    cursor = r.next ?? undefined;
  } while (cursor);
  return out;
}

async function parts(session: DeskdSession, method: string, params: Record<string, unknown>) {
  let text = '';
  let cursor: string | undefined;
  let replies = 0;
  let last: any;
  do {
    last = await session.rpc(method, { ...params, ...(cursor ? { cursor } : {}) });
    text += last.part;
    replies += 1;
    expect(Buffer.byteLength(last.part)).toBeLessThanOrEqual(512 * 1024);
    cursor = last.next ?? undefined;
  } while (cursor);
  return { text, replies, last };
}

beforeEach(async () => {
  clock = Date.UTC(2026, 10, 6, 10, 0, 0);
  h = await harness({ storeDebounceMs: 10, storeMaxWaitMs: 50, now: () => clock });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await h.clean();
});

describe('notebook.tree', () => {
  it('an empty desk gets an empty tree', async () => {
    expect(await s.rpc('notebook.tree')).toEqual({ notebooks: [], tabs: [], pages: [], rev: 0, next: null });
  });

  it('builds with model/tree.ts, in order', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(s);
    const second = (await s.rpc('notebook.page.create', { tabId, after: pageId })).page;
    const first = (await s.rpc('notebook.page.create', { tabId })).page;
    const t = await wholeTree(s);
    const tree = buildTree(t.notebooks, t.tabs, t.pages);
    expect(tree.notebooks.map((n) => n.id)).toEqual([notebookId]);
    expect(tree.pages[tabId]?.map((q) => q.id)).toEqual([first.id, pageId, second.id]);
    expect(stepPage(tree, pageId, 1)?.id).toBe(second.id);
    expect(binderSequence(tree, notebookId).length).toBe(3);
  });

  it('pages past 1,000 come in replies, each under 1 MiB, and all arrive once', async () => {
    const { tabId } = await makeNotebook(s);
    h.service.db.tx(() => {
      for (let i = 0; i < 2_500; i += 1) {
        h.service.db.run(
          `INSERT INTO pages (id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, row_version, ydoc, pm_json, plain_text)
           VALUES (?, ?, ?, ?, ?, 0, 0, 1, 'user', 1, 'user', 1, x'', '{"type":"doc"}', '')`,
          `bulk-${String(i).padStart(5, '0')}`,
          tabId,
          i,
          `Page ${i}`,
          'x'.repeat(200),
        );
      }
    });
    const first: any = await s.rpc('notebook.tree');
    expect(first.pages.length).toBe(1000);
    expect(first.notebooks.length).toBe(1);
    expect(first.tabs.length).toBe(1);
    expect(typeof first.next).toBe('string');
    const t = await wholeTree(s);
    expect(t.replies).toBe(3);
    expect(t.notebooks.length).toBe(1);
    expect(new Set(t.pages.map((q: any) => q.id)).size).toBe(2_501);
    expect(t.pages.length).toBe(2_501);
  });

  it('long titles shorten a reply rather than break the 1 MiB limit', async () => {
    const { tabId } = await makeNotebook(s);
    h.service.db.tx(() => {
      for (let i = 0; i < 1_500; i += 1) {
        h.service.db.run(
          `INSERT INTO pages (id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, row_version, ydoc, pm_json, plain_text)
           VALUES (?, ?, ?, ?, ?, 0, 0, 1, 'user', 1, 'user', 1, x'', '{"type":"doc"}', '')`,
          `long-${String(i).padStart(5, '0')}`,
          tabId,
          i,
          'T'.repeat(1024),
          's'.repeat(200),
        );
      }
    });
    const first: any = await s.rpc('notebook.tree');
    expect(first.pages.length).toBeLessThan(1000);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
    expect((await wholeTree(s)).pages.length).toBe(1_501);
  });

  it('a bad cursor is bad_request', async () => {
    await fails(s.rpc('notebook.tree', { cursor: 'nonsense' }), 'bad_request', 'cursor');
    await fails(s.rpc('notebook.tree', { cursor: 7 }), 'bad_request', 'cursor');
  });
});

describe('the topic', () => {
  it('starts with {rev}, then follows the tree at most 4 times a second', async () => {
    s.sendJson({ t: 'sub', sid: 'a', topic: 'notebook.tree' });
    await until('the snapshot', () => s.events.length === 1);
    expect(s.events[0]).toEqual({ sid: 'a', data: { rev: 0 } });
    const { tabId } = await makeNotebook(s);
    const start = Date.now();
    for (let i = 0; i < 40; i += 1) {
      await s.rpc('notebook.page.create', { tabId });
      await sleep(5);
    }
    const rev = (await s.rpc('notebook.tree')).rev;
    await until('the last rev', () => s.events.at(-1)?.data.rev === rev);
    const elapsed = Math.max(Date.now() - start, 1);
    expect(s.events.length - 1).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 1);
    s.sendJson({ t: 'unsub', sid: 'a' });
    const before = s.events.length;
    await s.rpc('notebook.page.create', { tabId });
    await sleep(350);
    expect(s.events.length).toBe(before);
  });

  it('an unknown topic is not_found', async () => {
    const seen: any[] = [];
    (s as any).onJson = ((orig) =>
      function (this: unknown, m: any) {
        seen.push(m);
        return orig.call(s, m);
      })((s as any).onJson);
    s.sendJson({ t: 'sub', sid: 5, topic: 'chat.channels' });
    await until('the error', () => seen.length === 1);
    expect(seen[0]).toMatchObject({ t: 'err', id: 5, code: 'not_found' });
  });
});

describe('structure', () => {
  it('notebook.notebook.create makes a notebook with a tab and a blank page', async () => {
    const r: any = await s.rpc('notebook.notebook.create', { title: 'One' });
    expect(r.notebook.title).toBe('One');
    expect(r.tab).toMatchObject({ title: 'General', color: 'blue', notebookId: r.notebook.id });
    expect(r.page).toMatchObject({ tabId: r.tab.id, title: '', deletedAt: null, rowVersion: 1 });
    expect((await s.rpc('notebook.notebook.create')).notebook.title).toBe('New notebook');
    await fails(s.rpc('notebook.notebook.create', { title: 7 }), 'bad_request', 'title');
    await fails(s.rpc('notebook.notebook.create', { title: 'x'.repeat(1025) }), 'bad_request', 'title');
  });

  it('notebook.notebook.rename', async () => {
    const { notebookId } = await makeNotebook(s);
    expect(await s.rpc('notebook.notebook.rename', { id: notebookId, title: '  Renamed ' })).toEqual({});
    let t = await wholeTree(s);
    expect(t.notebooks[0].title).toBe('Renamed');
    expect(t.notebooks[0].rowVersion).toBe(2);
    // Blank changes nothing, as in LocalBackend.
    await s.rpc('notebook.notebook.rename', { id: notebookId, title: '   ' });
    t = await wholeTree(s);
    expect(t.notebooks[0].title).toBe('Renamed');
    await fails(s.rpc('notebook.notebook.rename', { id: 'nope', title: 'x' }), 'not_found');
    await fails(s.rpc('notebook.notebook.rename', { title: 'x' }), 'bad_request', 'id');
  });

  it('notebook.tab.create', async () => {
    const { notebookId } = await makeNotebook(s);
    const r: any = await s.rpc('notebook.tab.create', { notebookId, title: 'Second', color: 'rose' });
    expect(r.tab).toMatchObject({ title: 'Second', color: 'rose' });
    expect(r.page.tabId).toBe(r.tab.id);
    const third: any = await s.rpc('notebook.tab.create', { notebookId });
    expect(third.tab.title).toBe('New tab');
    expect(third.tab.color).toBe('amber');
    expect(third.tab.sortKey).toBeGreaterThan(r.tab.sortKey);
    await fails(s.rpc('notebook.tab.create', { notebookId: 'nope' }), 'not_found');
    await fails(s.rpc('notebook.tab.create', { notebookId, color: 'mauve' }), 'bad_request', 'color');
  });

  it('notebook.tab.rename and notebook.tab.recolor', async () => {
    const { tabId } = await makeNotebook(s);
    expect(await s.rpc('notebook.tab.rename', { id: tabId, title: 'Named' })).toEqual({});
    expect(await s.rpc('notebook.tab.recolor', { id: tabId, color: 'slate' })).toEqual({});
    const t = await wholeTree(s);
    expect(t.tabs[0]).toMatchObject({ title: 'Named', color: 'slate', rowVersion: 3 });
    await fails(s.rpc('notebook.tab.rename', { id: 'nope', title: 'x' }), 'not_found');
    await fails(s.rpc('notebook.tab.recolor', { id: 'nope', color: 'blue' }), 'not_found');
    await fails(s.rpc('notebook.tab.recolor', { id: tabId, color: 'mauve' }), 'bad_request', 'color');
  });

  it('notebook.tab.addAtPage takes this page and the ones after it', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    const b = (await s.rpc('notebook.page.create', { tabId, after: pageId })).page;
    const c = (await s.rpc('notebook.page.create', { tabId, after: b.id })).page;
    const { tab }: any = await s.rpc('notebook.tab.addAtPage', { pageId: b.id });
    expect(tab.title).toBe('New tab');
    expect(tab.color).toBe('green');
    const t = await wholeTree(s);
    const tree = buildTree(t.notebooks, t.tabs, t.pages);
    expect(tree.pages[tabId]?.map((q) => q.id)).toEqual([pageId]);
    expect(tree.pages[tab.id]?.map((q) => q.id)).toEqual([b.id, c.id]);
    await fails(s.rpc('notebook.tab.addAtPage', { pageId: 'nope' }), 'not_found');
  });

  it('notebook.page.create', async () => {
    await makeNotebook(s);
    await fails(s.rpc('notebook.page.create', { tabId: 'nope' }), 'not_found');
    await fails(s.rpc('notebook.page.create', {}), 'bad_request', 'tabId');
  });

  it('notebook.page.move, within a tab and to another, and it is not an edit', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(s);
    const b = (await s.rpc('notebook.page.create', { tabId, after: pageId })).page;
    const other = (await s.rpc('notebook.tab.create', { notebookId })).tab;
    clock += 1000;
    expect(await s.rpc('notebook.page.move', { pageId, tabId, index: 1 })).toEqual({});
    let tree = buildTree(...Object.values(await pick()) as [any, any, any]);
    expect(tree.pages[tabId]?.map((q) => q.id)).toEqual([b.id, pageId]);
    await s.rpc('notebook.page.move', { pageId: b.id, tabId: other.id });
    tree = buildTree(...Object.values(await pick()) as [any, any, any]);
    expect(tree.pages[other.id]?.at(-1)?.id).toBe(b.id);
    expect(tree.byId[pageId]?.updatedAt).toBeLessThan(clock);
    await fails(s.rpc('notebook.page.move', { pageId: 'nope', tabId }), 'not_found');
    await fails(s.rpc('notebook.page.move', { pageId, tabId: 'nope' }), 'not_found');
    await fails(s.rpc('notebook.page.move', { pageId, tabId, index: -1 }), 'bad_request', 'index');

    async function pick() {
      const w = await wholeTree(s);
      return { notebooks: w.notebooks, tabs: w.tabs, pages: w.pages };
    }
  });

  it('notebook.page.trash and restore', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    expect(await s.rpc('notebook.page.trash', { pageId })).toEqual({});
    await s.rpc('notebook.page.trash', { pageId });
    let t = await wholeTree(s);
    let tree = buildTree(t.notebooks, t.tabs, t.pages);
    expect(tree.trash.map((q) => q.id)).toEqual([pageId]);
    expect(tree.pages[tabId]).toBeUndefined();
    expect(await s.rpc('notebook.page.restore', { pageId })).toEqual({});
    t = await wholeTree(s);
    tree = buildTree(t.notebooks, t.tabs, t.pages);
    expect(tree.trash).toEqual([]);
    expect(tree.pages[tabId]?.map((q) => q.id)).toEqual([pageId]);
    await fails(s.rpc('notebook.page.trash', { pageId: 'nope' }), 'not_found');
    await fails(s.rpc('notebook.page.restore', { pageId: 'nope' }), 'not_found');
  });

  it('rev goes up with every change and outlives a restart', async () => {
    const { tabId } = await makeNotebook(s);
    const a = (await s.rpc('notebook.tree')).rev;
    await s.rpc('notebook.page.create', { tabId });
    const b = (await s.rpc('notebook.tree')).rev;
    expect(b).toBeGreaterThan(a);
    await h.restart();
    const again = h.session();
    expect((await again.rpc('notebook.tree')).rev).toBe(b);
  });
});

describe('content', () => {
  it('notebook.page.content of a stored and of an open page', async () => {
    const { pageId } = await makeNotebook(s);
    expect(JSON.parse((await parts(s, 'notebook.page.content', { pageId })).text)).toEqual({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] });
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Live'), p('Text that is not stored yet')));
    await until('the server to have it', async () => JSON.parse((await parts(s, 'notebook.page.content', { pageId })).text).content.length === 2);
    await fails(s.rpc('notebook.page.content', { pageId: 'nope' }), 'not_found');
    await fails(s.rpc('notebook.page.content', { pageId, cursor: '1:1' }), 'bad_request', 'cursor');
  });

  it('a page over 1 MiB comes in parts, from one snapshot even while it changes', async () => {
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    const body = fakePages(200);
    setBody(provider.document, body);
    await until('the store', () => (h.service.notebook.page(pageId)?.word_count ?? 0) > 80_000, 20_000);
    const size = Buffer.byteLength(JSON.stringify(body));
    expect(size).toBeGreaterThan(1024 * 1024);

    const { text, replies } = await parts(s, 'notebook.page.content', { pageId });
    expect(replies).toBeGreaterThan(2);
    expect(JSON.parse(text).content.length).toBe(body.content?.length);

    // Typing between parts doesn't tear the read.
    const first: any = await s.rpc('notebook.page.content', { pageId });
    setBody(provider.document, doc(h1('Replaced while reading')));
    await until('the change', () => provider.unsyncedChanges === 0);
    let joined = first.part;
    let cursor = first.next;
    while (cursor) {
      const r: any = await s.rpc('notebook.page.content', { pageId, cursor });
      joined += r.part;
      cursor = r.next;
    }
    expect(JSON.parse(joined).content.length).toBe(body.content?.length);
  });

  it('parts count bytes, quote safely and never split a character', async () => {
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    // Emoji are surrogate pairs and 4 bytes each; quotes double when quoted again inside a reply.
    const line = '😀"\\'.repeat(2_000);
    const body = doc(h1('Awkward'), ...Array.from({ length: 300 }, () => p(line)));
    setBody(provider.document, body);
    await until('the store', () => h.service.notebook.page(pageId)?.title === 'Awkward', 30_000);
    const { text, replies } = await parts(s, 'notebook.page.content', { pageId });
    expect(replies).toBeGreaterThan(2);
    expect(JSON.parse(text)).toEqual(body);
  });
});

describe('versions', () => {
  it('save, list, get, asOf and restore', async () => {
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('First version'), p('one')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    await sleep(30);
    const saved: any = await s.rpc('notebook.version.save', { pageId });
    expect(saved.version).toMatchObject({ pageId, reason: 'manual', title: 'First version', actor: 'user', wordCount: 3 });
    const list: any = await s.rpc('notebook.version.list', { pageId });
    expect(list.versions.map((v: any) => v.id)).toEqual([saved.version.id]);
    const got = await parts(s, 'notebook.version.get', { versionId: saved.version.id });
    expect(JSON.parse(got.text)).toEqual(doc(h1('First version'), p('one')));
    expect(got.last.meta.id).toBe(saved.version.id);

    expect(await s.rpc('notebook.version.get', { versionId: 'nope' })).toEqual({ meta: null, part: '', next: null });
    expect(await s.rpc('notebook.version.save', { pageId: 'nope' })).toEqual({ version: null });
    await fails(s.rpc('notebook.version.save', { pageId, reason: 'because' }), 'bad_request', 'reason');
    await fails(s.rpc('notebook.version.list', { pageId: 'nope' }), 'not_found');

    expect(await s.rpc('notebook.version.asOf', { pageId, day: '2026-11-06' })).toEqual({ versionId: saved.version.id });
    expect(await s.rpc('notebook.version.asOf', { pageId, day: '2026-11-05' })).toEqual({ versionId: null });
    await fails(s.rpc('notebook.version.asOf', { pageId, day: 'today' }), 'bad_request', 'day');

    setBody(provider.document, doc(h1('Second state'), p('two')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    await sleep(30);
    expect(await s.rpc('notebook.version.restore', { pageId, versionId: saved.version.id })).toEqual({});
    await until('the other client to get the old text', () => provider.document.getXmlFragment('default').toString().includes('First version'));
    const after: any = await s.rpc('notebook.version.list', { pageId });
    expect(after.versions.map((v: any) => v.reason)).toEqual(['restore', 'session', 'manual']);
    expect(after.versions[1].title).toBe('Second state');
    expect(h.service.notebook.page(pageId)?.title).toBe('First version');

    await fails(s.rpc('notebook.version.restore', { pageId, versionId: 'nope' }), 'not_found');
    await fails(s.rpc('notebook.version.restore', { pageId: 'nope', versionId: saved.version.id }), 'not_found');
  });

  it('a version over 1 MiB comes in parts', async () => {
    const { pageId } = await makeNotebook(s);
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    const body = fakePages(200);
    setBody(provider.document, body);
    await until('ack', () => !provider.hasUnsyncedChanges, 20_000);
    const { version }: any = await s.rpc('notebook.version.save', { pageId });
    const { text, replies } = await parts(s, 'notebook.version.get', { versionId: version.id });
    expect(replies).toBeGreaterThan(2);
    expect(JSON.parse(text).content.length).toBe(body.content?.length);
  });
});

describe('the time zone, activity', () => {
  it('notebook.settings.set takes a real zone and refuses others, keeping the last good one', async () => {
    expect(await s.rpc('notebook.settings.set', { timeZone: 'Asia/Tokyo' })).toEqual({});
    expect(h.service.notebook.timeZone).toBe('Asia/Tokyo');
    await fails(s.rpc('notebook.settings.set', { timeZone: 'Mars/Olympus' }), 'bad_request', 'time_zone');
    await fails(s.rpc('notebook.settings.set', {}), 'bad_request', 'time_zone');
    expect(h.service.notebook.timeZone).toBe('Asia/Tokyo');
    await h.restart();
    expect(h.service.notebook.timeZone).toBe('Asia/Tokyo');
  });

  it('activity and its days follow the zone last seen', async () => {
    clock = Date.UTC(2026, 10, 6, 23, 30, 0);
    const { pageId } = await makeNotebook(s);
    expect((await s.rpc('notebook.activity.days')).days).toEqual(['2026-11-06']);
    // The same instant is already tomorrow in Tokyo.
    await s.rpc('notebook.settings.set', { timeZone: 'Asia/Tokyo' });
    const c = new Client(h.socket);
    clients.push(c);
    const provider = c.open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Typed in Tokyo'), p('words')));
    await until('the row', async () => (await s.rpc('notebook.activity', { fromDay: '2026-11-07', toDay: '2026-11-07' })).rows.length === 1);
    expect((await s.rpc('notebook.activity.days')).days).toEqual(['2026-11-07', '2026-11-06']);
    const created: any = await s.rpc('notebook.activity', { fromDay: '2026-11-06', toDay: '2026-11-06' });
    expect(created.rows[0]).toMatchObject({ pageId, day: '2026-11-06', created: true, edits: 0, actors: ['user'] });
    const edited: any = await s.rpc('notebook.activity', { fromDay: '2026-11-07', toDay: '2026-11-07' });
    expect(edited.rows[0]).toMatchObject({ pageId, day: '2026-11-07', created: false, actors: ['user'] });
    expect(edited.rows[0].edits).toBeGreaterThan(0);
    expect(edited.rows[0].added).toBeGreaterThan(0);
    await s.rpc('notebook.page.trash', { pageId });
    expect((await s.rpc('notebook.activity.days')).days).toEqual([]);
    await fails(s.rpc('notebook.activity', { fromDay: 'x', toDay: '2026-11-07' }), 'bad_request', 'fromDay');
  });
});

describe('the rest of the table', () => {
  it('an unknown method and bad params', async () => {
    await fails(s.rpc('notebook.nothing'), 'not_found', 'method');
    await fails(s.rpc('notebook.tree', [1, 2]), 'bad_request', 'params');
  });

  it('a cancelled request gets no reply from here', async () => {
    const { pageId } = await makeNotebook(s);
    s.sendJson({ t: 'cancel', id: 999 });
    // A cancel for nothing running is ignored, and the connection is fine.
    expect((await s.rpc('notebook.page.content', { pageId })).next).toBeNull();
  });
});
