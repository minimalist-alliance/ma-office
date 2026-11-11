// Notebook colors on the desk (ADR 0091): labels kept with the page and searched, a duplicate and an import, a database
// from before labels, and two members of a guild's shared Notebook seeing each other's colors and labels through real
// providers, with history and undo. Fake members and fake text only.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EditorState, TextSelection, type Command } from '@tiptap/pm/state';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blockColorCommand, colorMarkCommand } from '../../../web/notebook/src/model/commands.ts';
import { Client, DeskdSession, synced, until, type RpcError } from './helpers/deskd.ts';
import { bodyOf, doc, h1, p, setBody, typeInto } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { collabToken } from '../../../web/notebook/src/model/compat.ts';
import { getSchema } from '@tiptap/core';
import { schemaExtensions } from '../../../web/notebook/src/model/schema.ts';
import { SCHEMA_VERSION } from '../src/db.ts';
import { DOC_FIELD, notebookSchema, type PMNode } from '../src/model.ts';

const member = (memberId: string, name: string, grants: string[] = [], role = 'member') => ({ kind: 'guild_member', memberId, role, grants, name, badge: null, teen: false });
const ANA = member('gm-ana1', 'Ana', ['manage_spaces']); // manage_spaces: these tests make notebooks and tabs, which it gates
const BO = member('gm-bo2', 'Bo', ['manage_spaces']);
const hello = (caller: { memberId: string }) => ({ t: 'hello', sessionId: 'cs-1', sub: caller.memberId, caller });

const hl = (color: string) => ({ type: 'highlight', attrs: { color } });
const tc = (color: string) => ({ type: 'textColor', attrs: { color } });
const COLORED: PMNode = doc(h1('Garden'), {
  type: 'paragraph',
  attrs: { color: 'violet' },
  content: [{ type: 'text', text: 'water ' }, { type: 'text', text: 'daily', marks: [hl('green')] }, { type: 'text', text: ' now', marks: [tc('blue')] }],
});

let h: Harness;
const sessions: DeskdSession[] = [];
const clients: Client[] = [];
const as = (caller?: { memberId: string }): DeskdSession => {
  const s = caller ? new DeskdSession(h.socket, hello(caller)) : h.session();
  sessions.push(s);
  return s;
};
const clientAs = (caller?: { memberId: string }): Client => {
  const c = caller ? new Client(h.socket, hello(caller)) : new Client(h.socket);
  clients.push(c);
  return c;
};
/** A provider as today's Desk app opens one: its token says this build's page schema (ADR 0091's guard). */
const editor = (c: Client, pageId: string) => c.open(pageId, new Y.Doc(), { token: collabToken() });

async function fails(pr: Promise<unknown>, code: string, reason?: string): Promise<void> {
  const e = (await pr.then(
    () => null,
    (err: RpcError) => err,
  )) as RpcError | null;
  expect(e?.code).toBe(code);
  if (reason) expect(e?.details).toEqual({ reason });
}

/** A page's body as the desk has it now. */
async function content(s: DeskdSession, pageId: string): Promise<PMNode> {
  let text = '';
  let cursor: string | null | undefined;
  do {
    const r: any = await s.rpc('notebook.page.content', { pageId, ...(cursor ? { cursor } : {}) });
    text += r.part;
    cursor = r.next;
  } while (cursor);
  return JSON.parse(text) as PMNode;
}

/** What the editor's binding does with a menu's command: run it on the page as the editor has it, then reconcile into the Y.Doc. */
function edit(y: Y.Doc, command: Command, from: number, to = from): void {
  const node = yXmlFragmentToProseMirrorRootNode(y.getXmlFragment(DOC_FIELD), notebookSchema());
  const state = EditorState.create({ schema: notebookSchema(), doc: node, selection: TextSelection.create(node, from, to) });
  let next = state;
  expect(command(state, (tr) => (next = state.apply(tr)))).toBe(true);
  y.transact(() => prosemirrorToYXmlFragment(next.doc, y.getXmlFragment(DOC_FIELD)), 'editor');
}

const marksOf = (json: PMNode): string => JSON.stringify(json);

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100 });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of sessions.splice(0)) s.close();
  await h.clean();
});

describe('labels', () => {
  it('kept with the page row, sent only when set, through a restart; updatedAt stays and rev moves', async () => {
    const s = as();
    const { pageId } = await makeNotebook(s);
    const before: any = await s.rpc('notebook.tree');
    expect(before.pages[0]).not.toHaveProperty('label');
    expect(await s.rpc('notebook.page.label', { pageId, label: 'rose' })).toEqual({});
    const after: any = await s.rpc('notebook.tree');
    expect(after.rev).toBe(before.rev + 1);
    expect(after.pages[0]).toMatchObject({ id: pageId, label: 'rose', updatedAt: before.pages[0].updatedAt });
    // The same label again changes nothing.
    await s.rpc('notebook.page.label', { pageId, label: 'rose' });
    expect(((await s.rpc('notebook.tree')) as any).rev).toBe(after.rev);

    await h.restart();
    const s2 = as();
    expect(((await s2.rpc('notebook.tree')) as any).pages[0]).toMatchObject({ label: 'rose' });
    await s2.rpc('notebook.page.label', { pageId, label: null });
    expect(((await s2.rpc('notebook.tree')) as any).pages[0]).not.toHaveProperty('label');

    await fails(s2.rpc('notebook.page.label', { pageId, label: '#ff0000' }), 'bad_request', 'label');
    await fails(s2.rpc('notebook.page.label', { pageId, label: 'teal' }), 'bad_request', 'label');
    await fails(s2.rpc('notebook.page.label', { pageId: 'nope', label: 'amber' }), 'not_found');
  });

  it('searched: a filter, each hit says its label, and labels alone list those pages by title', async () => {
    const s = as();
    const { tabId, pageId } = await makeNotebook(s);
    const second = (await s.rpc('notebook.page.create', { tabId })).page.id;
    const c = clientAs();
    for (const [id, title] of [
      [pageId, 'Beans'],
      [second, 'Peas'],
    ] as const) {
      const pr = editor(c, id);
      await synced(pr);
      setBody(pr.document, doc(h1(title), p(`sow ${title.toLowerCase()}`)));
      await until('the store', () => h.service.notebook.page(id)?.title === title);
    }
    await s.rpc('notebook.page.label', { pageId, label: 'blue' });
    const all: any = await s.rpc('notebook.search', { query: 'sow' });
    expect(all.hits.map((x: any) => [x.title, x.label ?? null]).sort()).toEqual([
      ['Beans', 'blue'],
      ['Peas', null],
    ]);
    expect(((await s.rpc('notebook.search', { query: 'sow', labels: ['blue'] })) as any).hits.map((x: any) => x.title)).toEqual(['Beans']);
    expect(((await s.rpc('notebook.search', { query: '', labels: ['blue', 'green'] })) as any).hits.map((x: any) => x.title)).toEqual(['Beans']);
    expect(((await s.rpc('notebook.search', { query: '' })) as any).hits).toEqual([]);
    await fails(s.rpc('notebook.search', { query: '', labels: ['red'] }), 'bad_request', 'labels');
  });

  it('a database from before labels opens, gains the column without a schema bump, and its pages have none', async () => {
    const s = as();
    const { pageId } = await makeNotebook(s);
    await h.stop();
    // As an older desk-notebook left it: no label column.
    const raw = new DatabaseSync(join(h.dir, 'data', 'notebook.db'));
    raw.exec('ALTER TABLE pages DROP COLUMN label');
    expect((raw.prepare('PRAGMA table_info(pages)').all() as { name: string }[]).some((col) => col.name === 'label')).toBe(false);
    raw.close();
    await h.restart();
    const s2 = as();
    const tree: any = await s2.rpc('notebook.tree');
    expect(tree.pages.map((x: any) => x.id)).toEqual([pageId]);
    expect(tree.pages[0]).not.toHaveProperty('label');
    // Still the same schema number, so an older build (which refuses a newer one) still opens the file after this one has.
    expect((h.service.db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
    await s2.rpc('notebook.page.label', { pageId, label: 'amber' });
    // What an older build writes to a page row names no label, so it's left as it was.
    h.service.db.run('UPDATE pages SET title = ?, row_version = row_version + 1 WHERE id = ?', 'Renamed by an older build', pageId);
    expect(h.service.notebook.page(pageId)?.label).toBe('amber');
  });
});

describe('a page with colors on the desk', () => {
  it('is stored, versioned and read back with its colors, and restored with them', async () => {
    const s = as();
    const { pageId } = await makeNotebook(s);
    const pr = editor(clientAs(), pageId);
    await synced(pr);
    setBody(pr.document, COLORED);
    await until('the store', () => h.service.notebook.page(pageId)?.title === 'Garden');
    expect(await content(s, pageId)).toEqual(bodyOf(pr.document));
    const { version } = (await s.rpc('notebook.version.save', { pageId, reason: 'manual' })) as any;
    const saved = JSON.parse(((await s.rpc('notebook.version.get', { versionId: version.id })) as any).part) as PMNode;
    expect(marksOf(saved)).toContain('"textColor","attrs":{"color":"blue"}');
    expect(saved.content?.[1]?.attrs).toMatchObject({ color: 'violet' });
    // Colors off, then the version back: they return.
    setBody(pr.document, doc(h1('Garden'), p('water daily now')));
    await until('the plain store', () => !marksOf(JSON.parse(h.service.pages.contentText(pageId))).includes('textColor'));
    await s.rpc('notebook.version.restore', { pageId, versionId: version.id });
    await until('the colors back', () => marksOf(bodyOf(pr.document)).includes('"color":"blue"'));
    expect(bodyOf(pr.document)).toEqual(saved);
  });

  it('a page from before colors, with the old yellow highlight, opens and stores as it was', async () => {
    const s = as();
    const { pageId } = await makeNotebook(s);
    const pr = editor(clientAs(), pageId);
    await synced(pr);
    // As the editor before colors wrote it: the highlight's color is "yellow", and no block has a color.
    const old = doc(h1('Old'), { type: 'paragraph', content: [{ type: 'text', text: 'bright', marks: [hl('yellow')] }] });
    setBody(pr.document, old);
    await until('the store', () => h.service.notebook.page(pageId)?.title === 'Old');
    await h.restart();
    const s2 = as();
    const back = await content(s2, pageId);
    expect(marksOf(back)).toContain('"highlight","attrs":{"color":"yellow"}');
    yXmlFragmentToProseMirrorRootNode((() => {
      const y = new Y.Doc();
      h.service.pages.readInto(pageId, y);
      return y.getXmlFragment(DOC_FIELD);
    })(), notebookSchema()).check();
  });
});

describe('duplicate and import', () => {
  it('a duplicate has the text, colors and label, right after the original, and a history of its own', async () => {
    const s = as();
    const { tabId, pageId } = await makeNotebook(s);
    const next = (await s.rpc('notebook.page.create', { tabId, after: pageId })).page.id;
    const pr = editor(clientAs(), pageId);
    await synced(pr);
    setBody(pr.document, COLORED);
    await s.rpc('notebook.page.label', { pageId, label: 'slate' });
    // Open, and with an edit not yet stored: the copy is the page as it is now.
    const { page } = (await s.rpc('notebook.page.duplicate', { pageId })) as any;
    expect(page).toMatchObject({ tabId, title: 'Garden', label: 'slate', wordCount: 4 });
    const tree: any = await s.rpc('notebook.tree');
    const order = tree.pages.filter((x: any) => x.tabId === tabId).sort((a: any, b: any) => a.sortKey - b.sortKey).map((x: any) => x.id);
    expect(order).toEqual([pageId, page.id, next]);
    expect(await content(s, page.id)).toEqual(bodyOf(pr.document));
    expect(((await s.rpc('notebook.version.list', { pageId: page.id })) as any).versions).toEqual([]);
    // Closed, from what's stored and logged.
    clients.splice(0).forEach((c) => c.destroy());
    await until('the page closed', () => !h.service.pages.open.has(pageId));
    const again = ((await s.rpc('notebook.page.duplicate', { pageId })) as any).page;
    expect(await content(s, again.id)).toEqual(await content(s, pageId));
    expect(((await s.rpc('notebook.search', { query: 'daily' })) as any).hits).toHaveLength(3);
    // Its body opens in the editor.
    const copy = clientAs().open(again.id);
    await synced(copy);
    yXmlFragmentToProseMirrorRootNode(copy.document.getXmlFragment(DOC_FIELD), notebookSchema()).check();
    await s.rpc('notebook.page.trash', { pageId });
    await fails(s.rpc('notebook.page.duplicate', { pageId }), 'not_found');
  });

  it('an import keeps colors, its label and attributes this build does not know; it refuses what the editor could not show', async () => {
    const s = as();
    const { tabId, pageId } = await makeNotebook(s);
    const body = doc(h1('Brought in'), { type: 'paragraph', attrs: { color: 'green', indent: 2 }, content: [{ type: 'text', text: 'kept', marks: [tc('blue')] }] });
    const { page } = (await s.rpc('notebook.page.import', { tabId, after: pageId, doc: body, label: 'green' })) as any;
    expect(page).toMatchObject({ title: 'Brought in', label: 'green' });
    const back = await content(s, page.id);
    expect(back.content?.[1]).toMatchObject({ attrs: { color: 'green', indent: 2 }, content: [{ text: 'kept', marks: [tc('blue')] }] });
    const pr = clientAs().open(page.id);
    await synced(pr);
    yXmlFragmentToProseMirrorRootNode(pr.document.getXmlFragment(DOC_FIELD), notebookSchema()).check();
    await fails(s.rpc('notebook.page.import', { tabId, doc: { type: 'doc', content: [{ type: 'bulletList', content: [p('no item')] }] } }), 'bad_request', 'doc');
    await fails(s.rpc('notebook.page.import', { tabId, doc: 'nope' }), 'bad_request', 'doc');
    await fails(s.rpc('notebook.page.import', { tabId, doc: body, label: 'red' }), 'bad_request', 'label');
    await fails(s.rpc('notebook.page.import', { tabId: 'nope', doc: body }), 'not_found');
  });
});

describe("a guild's shared Notebook: two members", () => {
  it("see each other's colors and labels live, colors on another member's text are free, and undo takes them back", async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const pa = editor(clientAs(ANA), pageId);
    const pb = editor(clientAs(BO), pageId);
    await Promise.all([synced(pa), synced(pb)]);
    // Ana's text.
    setBody(pa.document, doc(h1('Shared plan'), p('first second third')));
    await until("Ana's text at Bo", () => JSON.stringify(bodyOf(pb.document)).includes('first second third'));
    const closes: string[] = [];
    pb.on('close', ({ event }: { event: { reason: string } }) => closes.push(event.reason));

    // Bo colors Ana's words and her paragraph, as his menus would.
    const undo = new Y.UndoManager(pb.document.getXmlFragment(DOC_FIELD), { trackedOrigins: new Set(['editor']), captureTimeout: 0 });
    edit(pb.document, colorMarkCommand('highlight', 'green'), 14, 19);
    edit(pb.document, colorMarkCommand('textColor', 'rose'), 20, 26);
    edit(pb.document, blockColorCommand(15, 'slate'), 15);
    await until('the colors at Ana', () => {
      const j = JSON.stringify(bodyOf(pa.document));
      return j.includes('"highlight","attrs":{"color":"green"}') && j.includes('"textColor","attrs":{"color":"rose"}') && j.includes('"color":"slate"');
    });
    // And on the desk, stored, with Ana's text untouched and nothing refused.
    await until('the store', () => h.service.pages.contentText(pageId).includes('"slate"'));
    expect(closes).toEqual([]);
    expect(h.service.removals.used(pageId, 'gm-bo2')).toBe(0);

    // Bo's label reaches Ana's session through the tree's topic.
    ana.sendJson({ t: 'sub', sid: 'tree', topic: 'notebook.tree' });
    await until('the snapshot', () => ana.events.length >= 1);
    const seen = ana.events.length;
    const bo = as(BO);
    await bo.rpc('notebook.page.label', { pageId, label: 'blue' });
    await until('a newer rev at Ana', () => ana.events.length > seen);
    expect(((await ana.rpc('notebook.tree')) as any).pages.find((x: any) => x.id === pageId)).toMatchObject({ label: 'blue' });

    // Bo's undo takes his last colors back, for Ana too.
    undo.undo();
    await until('the block color gone at Ana', () => !JSON.stringify(bodyOf(pa.document)).includes('"color":"slate"'));
    undo.undo();
    await until('the text color gone at Ana', () => !JSON.stringify(bodyOf(pa.document)).includes('textColor'));
    expect(JSON.stringify(bodyOf(pa.document))).toContain('"highlight","attrs":{"color":"green"}');
    expect(closes).toEqual([]);

    // A version Ana saves now has Bo's highlight, and says Ana saved it.
    const { version } = (await ana.rpc('notebook.version.save', { pageId, reason: 'manual' })) as any;
    expect(version).toMatchObject({ actor: 'gm-ana1', actorName: 'Ana' });
    expect(((await ana.rpc('notebook.version.get', { versionId: version.id })) as any).part).toContain('"color":"green"');
  });

  it("a member's duplicate of another's page is theirs: they may trash it", async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const pa = editor(clientAs(ANA), pageId);
    await synced(pa);
    setBody(pa.document, COLORED);
    await until('the store', () => h.service.notebook.page(pageId)?.title === 'Garden');
    const bo = as(BO);
    const { page } = (await bo.rpc('notebook.page.duplicate', { pageId })) as any;
    expect(h.service.notebook.page(page.id)).toMatchObject({ created_by: 'gm-bo2' });
    expect(h.service.db.all('SELECT member_id FROM page_clients WHERE page_id = ?', page.id)).toEqual([{ member_id: 'gm-bo2' }]);
    expect(await bo.rpc('notebook.page.trash', { pageId: page.id })).toEqual({});
    // Ana's own page is still hers: Bo may not trash it.
    await fails(bo.rpc('notebook.page.trash', { pageId }), 'forbidden', 'grant');
  });
});

describe("the guard: an editor older than the page can't strip its colors (ADR 0091)", () => {
  /** The editor's schema before colors: no `textColor`, no block `color`. Its binding drops what it doesn't know. */
  const OLD = getSchema(schemaExtensions().filter((e) => !['blockColor', 'textColor', 'notebookColors'].includes(e.name)));
  /** What an editor from before colors does when its member types: its own projection of the page, reconciled back. */
  function oldEditorTypes(y: Y.Doc, text: string, at: number): void {
    const node = yXmlFragmentToProseMirrorRootNode(y.getXmlFragment(DOC_FIELD), OLD);
    const state = EditorState.create({ schema: OLD, doc: node });
    y.transact(() => prosemirrorToYXmlFragment(state.apply(state.tr.insertText(text, at)).doc, y.getXmlFragment(DOC_FIELD)), 'editor');
  }
  const SHARED = doc(h1('Shared'), { type: 'paragraph', attrs: { color: 'slate' }, content: [{ type: 'text', text: 'colored line' }] });
  const colorOf = (y: Y.Doc): unknown => (y.getXmlFragment(DOC_FIELD).get(1) as Y.XmlElement).getAttribute('color');

  it('the premise: an old editor typing anywhere on the page drops the block colors from its copy', () => {
    const y = new Y.Doc();
    setBody(y, SHARED);
    expect(colorOf(y)).toBe('slate');
    oldEditorTypes(y, 'x', 3);
    expect(colorOf(y)).toBeUndefined();
    y.destroy();
  });

  it("on a guild's shared page: an old tab's edit is refused whole, the color stays for everyone, and the old tab is told", async () => {
    const ana = as(ANA);
    const { tabId, pageId } = await makeNotebook(ana);
    const pa = editor(clientAs(ANA), pageId);
    await synced(pa);
    setBody(pa.document, SHARED);
    await until('the store', () => h.service.pages.contentText(pageId).includes('"slate"'));

    // Bo's tab is from before the guard: its token says no schema. It opens the page and reads it.
    const boClient = clientAs(BO);
    const pb = boClient.open(pageId);
    await synced(pb);
    expect(JSON.stringify(bodyOf(pb.document))).toContain('colored line');
    const closes: string[] = [];
    pb.on('close', ({ event }: { event: { reason: string } }) => closes.push(event.reason));

    oldEditorTypes(pb.document, 'Bo was here ', 9);
    expect(colorOf(pb.document)).toBeUndefined(); // what it would have sent
    // Before the guard this reaches its only read-only path: page_full.
    await until('the refusal', () => closes.includes('page_full'));
    await new Promise((r) => setTimeout(r, 200));
    expect(colorOf(pa.document)).toBe('slate');
    expect(JSON.stringify(bodyOf(pa.document))).not.toContain('Bo was here');
    h.service.pages.store(pageId);
    expect(h.service.pages.contentText(pageId)).toContain('"color":"slate"');
    expect(h.service.pages.contentText(pageId)).not.toContain('Bo was here');
    // More from that tab is dropped, and Ana goes on editing.
    oldEditorTypes(pb.document, 'again ', 9);
    typeInto(pa.document, ' and more');
    await until("Ana's edit stored", () => h.service.pages.contentText(pageId).includes('and more'));
    expect(h.service.pages.contentText(pageId)).not.toContain('again');
    expect(colorOf(pa.document)).toBe('slate');

    // The same old tab may still edit a page with nothing on it that it would drop.
    const plain = (await as(BO).rpc('notebook.page.create', { tabId })).page.id;
    const pp = boClient.open(plain);
    await synced(pp);
    oldEditorTypes(pp.document, 'plain words', 1);
    await until('the plain page stored', () => h.service.pages.contentText(plain).includes('plain words'));
  });

  it('an editor that says an older schema is told to reload; one that says this schema may take a color off', async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const pa = editor(clientAs(ANA), pageId);
    await synced(pa);
    setBody(pa.document, SHARED);
    await until('the store', () => h.service.pages.contentText(pageId).includes('"slate"'));

    const olderSchema = 'schema=1'; // a token that says the page schema is older than this build's
    const older = clientAs(BO).open(pageId, new Y.Doc(), { token: olderSchema });
    await synced(older);
    const closes: string[] = [];
    older.on('close', ({ event }: { event: { reason: string } }) => closes.push(event.reason));
    oldEditorTypes(older.document, 'stale ', 9);
    await until('the reload', () => closes.includes('reload'));
    expect(colorOf(pa.document)).toBe('slate');

    // Today's editor removing the color on purpose is an edit like any other.
    const pb = editor(clientAs(BO), pageId);
    await synced(pb);
    edit(pb.document, blockColorCommand(10, null), 10);
    await until('the color gone at Ana', () => colorOf(pa.document) === undefined);
  });
});
