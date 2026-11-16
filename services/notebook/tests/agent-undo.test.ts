// Undo of an agent's edit (src/agent.ts; draft ADR "the Agent's tools and approvals" §15 and §17: "every write the
// member can undo in one step; nothing deletes for good"): exactly what the agent put there comes out, and only while
// it's as the agent left it; otherwise the answer says so, with the pre_agent version to go back to. Then deskd's key
// (an edit done once, whatever happens to its answer), the list of a page's agent edits and what versions say of them,
// trash only, and a guild desk's rule for whose undo it is. Fake members and fake text only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, synced, until, type RpcError } from './helpers/deskd.ts';
import { doc, h1, p, setBody, textOf } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { DOC_FIELD, type PMNode } from '../src/model.ts';

let h: Harness;
let s: DeskdSession;
const sessions: DeskdSession[] = [];
const clients: Client[] = [];

const member = (memberId: string, name: string, grants: string[] = [], role = 'member') => ({ kind: 'guild_member', memberId, role, grants, name, badge: null, teen: false });
const ANA = member('gm-ana1', 'Ana', ['manage_spaces']);
const CAL = member('gm-cal5', 'Cal');
const MO = member('gm-mo3', 'Mo', ['moderate'], 'officer');
const as = (caller: unknown): DeskdSession => {
  const x = new DeskdSession(h.socket, { t: 'hello', sessionId: `undo-${sessions.length}`, sub: (caller as { memberId: string }).memberId, caller });
  sessions.push(x);
  return x;
};
const client = (): Client => {
  const c = new Client(h.socket);
  clients.push(c);
  return c;
};

async function fails(promise: Promise<unknown>, code: string, reason?: string): Promise<RpcError> {
  const e = (await promise.then(
    () => null,
    (err: RpcError) => err,
  )) as RpcError | null;
  expect(e?.code).toBe(code);
  if (reason) expect((e?.details as { reason?: string } | undefined)?.reason).toBe(reason);
  return e as RpcError;
}

const body = async (x: DeskdSession, pageId: string): Promise<PMNode> => JSON.parse((await x.rpc('notebook.page.content', { pageId })).part) as PMNode;
const md = async (x: DeskdSession, pageId: string): Promise<string> => (await x.rpc('notebook.page.markdown', { pageId })).markdown as string;
const edit = (x: DeskdSession, params: Record<string, unknown>): Promise<any> => x.rpc('notebook.page.agentEdit', { agentName: 'ag-1', ...params });
const undo = (x: DeskdSession, params: Record<string, unknown>): Promise<any> => x.rpc('notebook.page.agentUndo', params);

/** A page with this body, written as an editor would, and left to unload. */
async function pageWith(x: DeskdSession, b: PMNode): Promise<{ tabId: string; pageId: string }> {
  const { tabId, pageId } = await makeNotebook(x);
  const c = client();
  const provider = c.open(pageId);
  await synced(provider);
  setBody(provider.document, b);
  await until('ack', () => !provider.hasUnsyncedChanges);
  c.destroy();
  clients.splice(clients.indexOf(c), 1);
  await until('the page to unload', () => !h.service.pages.open.has(pageId));
  return { tabId, pageId };
}

/** Text typed at the end of one block, as a member's caret in it does. */
function typeAt(y: Y.Doc, blockIndex: number, text: string): void {
  y.transact(() => {
    const el = y.getXmlFragment(DOC_FIELD).get(blockIndex) as Y.XmlElement;
    let t = el.length ? el.get(el.length - 1) : null;
    if (!(t instanceof Y.XmlText)) {
      t = new Y.XmlText();
      el.insert(el.length, [t]);
    }
    (t as Y.XmlText).insert((t as Y.XmlText).length, text);
  });
}

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100 });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const x of sessions.splice(0)) x.close();
  await h.clean();
});

describe('undo of an append', () => {
  it('takes out exactly the blocks it added, and keeps what the member typed meanwhile', async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes'), p('first thought')));
    const before = await md(s, pageId);
    const provider = client().open(pageId);
    await synced(provider);
    const r = await edit(s, { op: 'append', pageId, markdown: '## Later\n\nSecond **thought**.\n\n- [ ] a task' });
    expect(r.editId).toMatch(/^ae-/);
    await until('the editor to see it', () => textOf(provider.document).includes('Second thought.'));
    // The member types in their own paragraph meanwhile.
    typeAt(provider.document, 1, ' and more');
    await until('ack', () => !provider.hasUnsyncedChanges);
    expect(await undo(s, { editId: r.editId })).toEqual({ editId: r.editId, pageId, op: 'append', undone: true });
    await until('the editor to see the undo', () => !textOf(provider.document).includes('Second thought.'));
    expect(await md(s, pageId)).toBe(before.replace('first thought', 'first thought and more'));
    // Once is enough.
    await fails(undo(s, { editId: r.editId }), 'conflict', 'undone');
  });

  it("an appended block the member has changed isn't taken: the answer says so, with the version to go back to", async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes'), p('first')));
    const provider = client().open(pageId);
    await synced(provider);
    const r = await edit(s, { op: 'append', pageId, markdown: 'the agent wrote this' });
    await until('the editor to see it', () => textOf(provider.document).includes('the agent wrote this'));
    const blocks = provider.document.getXmlFragment(DOC_FIELD).toArray();
    const at = blocks.findIndex((b) => b instanceof Y.XmlElement && b.toString().includes('the agent wrote this'));
    typeAt(provider.document, at, ', and the member added this');
    await until('ack', () => !provider.hasUnsyncedChanges);
    const e = await fails(undo(s, { editId: r.editId }), 'conflict', 'changed');
    expect(e.details).toEqual({ reason: 'changed', versionId: r.versionId });
    expect(await md(s, pageId)).toContain('the agent wrote this, and the member added this');
    // The version before is there, and restoring it is the way back.
    await s.rpc('notebook.version.restore', { pageId, versionId: r.versionId });
    await until('the restore', async () => !(await md(s, pageId)).includes('agent wrote'));
  });

  it('goes before an empty last line, which the editor keeps at the end, so no editor adds another', async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes'), p('text'), p('')));
    await edit(s, { op: 'append', pageId, markdown: 'appended' });
    const b = await body(s, pageId);
    expect(b.content?.map((n) => n.content?.[0]?.text ?? '')).toEqual(['Notes', 'text', 'appended', '']);
  });
});

describe('undo of replace_text', () => {
  it('in a paragraph: the old text comes back with its formatting, and typing elsewhere in it stays', async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan'), { type: 'paragraph', content: [{ type: 'text', text: 'Meet on ' }, { type: 'text', text: 'Monday', marks: [{ type: 'highlight', attrs: { color: 'rose' } }] }, { type: 'text', text: ' at noon' }] }));
    const before = await body(s, pageId);
    const provider = client().open(pageId);
    await synced(provider);
    const r = await edit(s, { op: 'replace_text', pageId, find: 'Monday', markdown: 'Tuesday' });
    await until('the editor to see it', () => textOf(provider.document).includes('Tuesday'));
    // The highlight's color is the text's own and stays (not the Markdown's default).
    expect((await body(s, pageId)).content?.[1]?.content?.[1]).toMatchObject({ text: 'Tuesday', marks: [{ type: 'highlight', attrs: { color: 'rose' } }] });
    typeAt(provider.document, 1, '!');
    await until('ack', () => !provider.hasUnsyncedChanges);
    await undo(s, { editId: r.editId });
    await until('the undo', async () => JSON.stringify((await body(s, pageId)).content?.[1]?.content?.[1]) === JSON.stringify(before.content?.[1]?.content?.[1]));
    expect((await body(s, pageId)).content?.[1]?.content?.map((n) => n.text).join('')).toBe('Meet on Monday at noon!');
  });

  it('of a heading by a heading: in place, its color kept; undo puts the old text back', async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan'), { type: 'heading', attrs: { level: 2, color: 'blue' }, content: [{ type: 'text', text: 'This week' }] }, p('body')));
    const r = await edit(s, { op: 'replace_text', pageId, find: '## This week', markdown: '## Next *week*' });
    expect(await md(s, pageId)).toBe('# Plan\n\n{color=blue}\n## Next *week*\n\nbody\n');
    await undo(s, { editId: r.editId });
    expect(await md(s, pageId)).toBe('# Plan\n\n{color=blue}\n## This week\n\nbody\n');
  });

  it('of a block by others (a paragraph by a list): undo takes the list out and puts the paragraph back', async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan'), { type: 'paragraph', attrs: { color: 'amber' }, content: [{ type: 'text', text: 'TODO here' }] }, p('after')));
    const before = await md(s, pageId);
    const r = await edit(s, { op: 'replace_text', pageId, find: 'TODO here', markdown: '- [ ] a\n- [x] b' });
    expect(await md(s, pageId)).toBe('# Plan\n\n- [ ] a\n- [x] b\n\nafter\n');
    await undo(s, { editId: r.editId });
    expect(await md(s, pageId)).toBe(before);
  });

  it('text the member changed after the agent is not put back', async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan'), p('one two three')));
    const provider = client().open(pageId);
    await synced(provider);
    const r = await edit(s, { op: 'replace_text', pageId, find: 'two', markdown: 'TWO' });
    await until('the editor to see it', () => textOf(provider.document).includes('TWO'));
    // The member deletes a letter of what the agent wrote.
    provider.document.transact(() => ((provider.document.getXmlFragment(DOC_FIELD).get(1) as Y.XmlElement).get(0) as Y.XmlText).delete(5, 1));
    await until('ack', () => !provider.hasUnsyncedChanges);
    await fails(undo(s, { editId: r.editId }), 'conflict', 'changed');
    expect(await md(s, pageId)).toBe('# Plan\n\none TO three\n');
  });
});

describe('the newest agent write is undone first (the test desk, Nov 13)', () => {
  it('an append, then a replace on the same page: Undo takes the replace, then the append, each back to its pre_agent page', async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan'), p('pack the tent')));
    const original = await md(s, pageId);
    const appended = await edit(s, { pageId, op: 'append', markdown: 'book the train', key: 'ap-newest-1' });
    const afterAppend = await md(s, pageId);
    await edit(s, { pageId, op: 'replace_text', find: 'the tent', markdown: 'the stove', key: 'ap-newest-2' });
    expect(await md(s, pageId)).toContain('pack the stove');
    // The release's bug: the foot offered the older append's Undo, and the newer replace stayed. Now the older one waits.
    const e = await fails(undo(s, { editId: appended.editId }), 'conflict', 'newer');
    expect((e.details as { editId?: string }).editId).toBeTruthy();
    expect(await md(s, pageId)).toContain('book the train');
    // The page's newest edit not undone is the replace; Undo once: the page as it was before the replace, exactly.
    const edits = (await s.rpc('notebook.page.agentEdits', { pageId })).edits as { editId: string; op: string; undone: boolean }[];
    expect(edits.find((x) => !x.undone)?.op).toBe('replace_text');
    await undo(s, { editId: edits.find((x) => !x.undone)!.editId });
    expect(await md(s, pageId)).toBe(afterAppend);
    // Undo twice: the append, and the page as it was before any agent wrote, exactly.
    const next = ((await s.rpc('notebook.page.agentEdits', { pageId })).edits as { editId: string; op: string; undone: boolean }[]).find((x) => !x.undone);
    expect(next?.op).toBe('append');
    await undo(s, { editId: next!.editId });
    expect(await md(s, pageId)).toBe(original);
  });

  it('two appends from one run: the later first, by key as deskd sends them', async () => {
    const { pageId } = await pageWith(s, doc(h1('Log'), p('start')));
    const original = await md(s, pageId);
    await edit(s, { pageId, op: 'append', markdown: 'one', key: 'auto:ap-aaaaaaaaaaaaaaaaaaab' });
    await edit(s, { pageId, op: 'append', markdown: 'two', key: 'auto:ap-aaaaaaaaaaaaaaaaaaac' });
    await fails(undo(s, { key: 'auto:ap-aaaaaaaaaaaaaaaaaaab' }), 'conflict', 'newer');
    await undo(s, { key: 'auto:ap-aaaaaaaaaaaaaaaaaaac' });
    await undo(s, { key: 'auto:ap-aaaaaaaaaaaaaaaaaaab' });
    expect(await md(s, pageId)).toBe(original);
  });
});

describe('undo of a new page', () => {
  it('goes to the Trash, from where the member can bring it back; never deleted for good', async () => {
    const { tabId } = await makeNotebook(s);
    const r = await edit(s, { op: 'create', new: { tabId, title: 'Trip' }, markdown: '- [ ] pack' });
    await undo(s, { editId: r.editId });
    const row = h.service.notebook.page(r.pageId);
    expect(row?.deleted_at).not.toBeNull();
    expect((await s.rpc('notebook.tree')).pages.find((x: any) => x.id === r.pageId)).toMatchObject({ deletedAt: expect.any(Number) });
    await s.rpc('notebook.page.restore', { pageId: r.pageId });
    expect(await md(s, r.pageId)).toBe('# Trip\n\n- [ ] pack\n');
  });

  it("a page the member has written in since isn't moved", async () => {
    const { tabId } = await makeNotebook(s);
    const r = await edit(s, { op: 'create', new: { tabId, title: 'Trip' }, markdown: 'start' });
    const provider = client().open(r.pageId);
    await synced(provider);
    typeAt(provider.document, 1, ' and more');
    await until('ack', () => !provider.hasUnsyncedChanges);
    await until('the store', async () => (await md(s, r.pageId)).includes('start and more'));
    await fails(undo(s, { editId: r.editId }), 'conflict', 'changed');
    expect(h.service.notebook.page(r.pageId)?.deleted_at).toBeNull();
  });

  it('a page an agent wrote in again since: that write is undone first', async () => {
    const { tabId } = await makeNotebook(s);
    const r = await edit(s, { op: 'create', new: { tabId, title: 'Trip' }, markdown: 'start' });
    const more = await edit(s, { op: 'append', pageId: r.pageId, markdown: 'and more' });
    const e = await fails(undo(s, { editId: r.editId }), 'conflict', 'newer');
    expect(e.details).toEqual({ reason: 'newer', editId: more.editId });
    expect(h.service.notebook.page(r.pageId)?.deleted_at).toBeNull();
    await undo(s, { editId: more.editId });
    await undo(s, { editId: r.editId });
    expect(h.service.notebook.page(r.pageId)?.deleted_at).not.toBeNull();
  });
});

describe("deskd's key, the list, and what versions say", () => {
  it('an edit with a key deskd sent before is done once: the same answer, nothing more', async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes')));
    const first = await edit(s, { op: 'append', pageId, markdown: 'once', key: 'ap-k1' });
    const again = await edit(s, { op: 'append', pageId, markdown: 'once', key: 'ap-k1' });
    expect(again).toEqual({ ...first, repeated: true });
    expect((await md(s, pageId)).match(/once/g)).toHaveLength(1);
    // Undo finds it by its key, as deskd's undo of an approval does.
    expect(await undo(s, { key: 'ap-k1' })).toMatchObject({ editId: first.editId, undone: true });
    await fails(undo(s, { key: 'ap-none' }), 'not_found');
    await fails(undo(s, { editId: 'ae-none' }), 'not_found');
    await fails(undo(s, {}), 'bad_request', 'editId');
    await fails(undo(s, { editId: first.editId, key: 'ap-k1' }), 'bad_request', 'key');
    await fails(edit(s, { op: 'append', pageId, markdown: 'x', key: 'has space' }), 'bad_request', 'key');
  });

  it("a page's agent edits, newest first; its pre_agent versions name the agent and the edit", async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes')));
    const a = await edit(s, { op: 'append', pageId, markdown: 'one', agentName: 'ag-a' });
    const b = await edit(s, { op: 'append', pageId, markdown: 'two', agentName: 'ag-b' });
    await undo(s, { editId: b.editId });
    const list = (await s.rpc('notebook.page.agentEdits', { pageId })).edits;
    expect(list.map((e: any) => [e.editId, e.agent, e.op, e.undone])).toEqual([
      [b.editId, 'ag-b', 'append', true],
      [a.editId, 'ag-a', 'append', false],
    ]);
    const versions: any[] = (await s.rpc('notebook.version.list', { pageId })).versions;
    expect(versions.find((v) => v.id === a.versionId)).toMatchObject({ reason: 'pre_agent', agent: 'ag-a', editId: a.editId, undone: false });
    expect(versions.find((v) => v.id === b.versionId)).toMatchObject({ reason: 'pre_agent', agent: 'ag-b', editId: b.editId, undone: true });
    expect((await s.rpc('notebook.version.get', { versionId: b.versionId })).meta).toMatchObject({ agent: 'ag-b', editId: b.editId });
    await fails(s.rpc('notebook.page.agentEdits', { pageId: 'no-such' }), 'not_found');
  });
});

describe('on a guild desk', () => {
  it("only the member whose agent it was, or a moderator, undoes it; it's charged as their own edit", async () => {
    const ana = as(ANA);
    const { tabId } = await makeNotebook(ana);
    const r = await edit(ana, { op: 'create', new: { tabId, title: 'Shared' }, markdown: 'start', agentName: 'gm-ana1' });
    const appended = await edit(ana, { op: 'append', pageId: r.pageId, markdown: 'by Ana\'s agent', agentName: 'gm-ana1' });
    const cal = as(CAL);
    await fails(undo(cal, { editId: appended.editId }), 'forbidden', 'grant');
    const mo = as(MO);
    expect(await undo(mo, { editId: appended.editId })).toMatchObject({ undone: true });
    expect(await md(ana, r.pageId)).toBe('# Shared\n\nstart\n');
    // Ana's own undo of the page she made: it goes to the Trash, under authz-5's rule for her own page.
    expect(await undo(ana, { editId: r.editId })).toMatchObject({ undone: true });
    expect(h.service.notebook.page(r.pageId)?.deleted_by).toBe('gm-ana1');
  });
});

describe('the newest first, on a guild desk (Security AAB-I4)', () => {
  it("a member who may not undo an edit hears that, not that a newer one stands", async () => {
    const ana = as(ANA);
    const { tabId } = await makeNotebook(ana);
    const r = await edit(ana, { op: 'create', new: { tabId, title: 'Shared' }, markdown: 'start', agentName: 'gm-ana1' });
    const first = await edit(ana, { op: 'append', pageId: r.pageId, markdown: 'one', agentName: 'gm-ana1' });
    await edit(ana, { op: 'append', pageId: r.pageId, markdown: 'two', agentName: 'gm-ana1' });
    await fails(undo(as(CAL), { editId: first.editId }), 'forbidden', 'grant');
    await fails(undo(ana, { editId: first.editId }), 'conflict', 'newer');
  });

  it('a page in the Trash says so first', async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes')));
    const first = await edit(s, { op: 'append', pageId, markdown: 'one' });
    await edit(s, { op: 'append', pageId, markdown: 'two' });
    await s.rpc('notebook.page.trash', { pageId });
    await fails(undo(s, { editId: first.editId }), 'conflict', 'trashed');
  });
});

describe('Trash only', () => {
  it('an agent never deletes for good: there is no such method, and the Trash keeps the page for its 30 days', async () => {
    const { pageId } = await pageWith(s, doc(h1('Keep me')));
    expect(await s.rpc('notebook.page.trash', { pageId })).toEqual({});
    expect(h.service.notebook.page(pageId)).toMatchObject({ title: 'Keep me', deleted_at: expect.any(Number) });
    for (const m of ['notebook.page.delete', 'notebook.page.purge', 'notebook.trash.empty']) await fails(s.rpc(m, { pageId }), 'not_found');
    await s.rpc('notebook.page.restore', { pageId });
    expect(h.service.notebook.page(pageId)?.deleted_at).toBeNull();
  });
});
