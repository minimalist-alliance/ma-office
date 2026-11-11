// A guild's desk: deskd's verified caller on every connection, who may delete what, and who wrote what. Fake members
// and fake text only.
import { rmSync } from 'node:fs';
import * as encoding from 'lib0/encoding';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until, type RpcError } from './helpers/deskd.ts';
import { doc, fakePages, h1, p, setBody, task, textOf, typeInto } from './helpers/docs.ts';
import { child, harness, makeNotebook, tempDir, type Harness } from './helpers/service.ts';
import { DOC_FIELD, notebookSchema, type PMNode } from '../src/model.ts';
import { BLOCK_MIN, judge, Owners, PageOwners, REMOVAL_BUDGET, REMOVAL_WINDOW_MS } from '../src/owners.ts';

const ALL_GRANTS = ['moderate', 'invite', 'remove_member', 'manage_spaces', 'manage_agents'];
const member = (memberId: string, name: string, grants: string[] = [], role = 'member') => ({ kind: 'guild_member', memberId, role, grants, name, badge: null, teen: false });
// Ana and Bo make notebooks and tabs in most tests here, so they hold manage_spaces (which gates only the space structure,
// not pages); `CAL` has no grant at all, for the tests of what a plain member may not do.
const ANA = member('gm-ana1', 'Ana', ['manage_spaces']);
const BO = member('gm-bo2', 'Bo', ['manage_spaces']);
const CAL = member('gm-cal5', 'Cal');
const MO = member('gm-mo3', 'Mo', ['moderate'], 'officer');
const LEE = member('gm-lee4', 'Lee', ALL_GRANTS, 'lead');
const hello = (caller: unknown) => ({ t: 'hello', sessionId: 'cs-1', sub: (caller as { memberId: string }).memberId, caller });

let h: Harness;
/** The desk's clock runs from the real one, and a test may move it on. */
let skew = 0;
const advance = (ms: number): void => {
  skew += ms;
};
/** Text of a given length, varied enough to read as text. */
const essay = (n: number, seed = 'Ana wrote this. '): string => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const sessions: DeskdSession[] = [];
const clients: Client[] = [];
const as = (caller: unknown): DeskdSession => {
  const s = new DeskdSession(h.socket, hello(caller));
  sessions.push(s);
  return s;
};
const clientAs = (caller: unknown): Client => {
  const c = new Client(h.socket, hello(caller));
  clients.push(c);
  return c;
};

async function fails(p: Promise<unknown>, code: string, reason?: string): Promise<void> {
  const e = (await p.then(
    () => null,
    (err: RpcError) => err,
  )) as RpcError | null;
  expect(e?.code).toBe(code);
  if (reason) expect(e?.details).toEqual({ reason });
}

function closes(provider: ReturnType<Client['open']>): string[] {
  const out: string[] = [];
  provider.on('close', ({ event }: { event: { reason: string } }) => out.push(event.reason));
  return out;
}

/** The page as the desk has it now, as text. */
async function deskText(s: DeskdSession, pageId: string): Promise<string> {
  const r: any = await s.rpc('notebook.page.content', { pageId });
  const walk = (n: PMNode): string => (n.text ?? '') + (n.content ?? []).map(walk).join('|');
  return walk(JSON.parse(r.part) as PMNode);
}

/** Deletes text from one paragraph's text node, as the editor does for a selection inside it. */
function deleteIn(y: Y.Doc, block: number, from: number, len: number): void {
  const el = y.getXmlFragment(DOC_FIELD).get(block) as Y.XmlElement;
  y.transact(() => (el.get(0) as Y.XmlText).delete(from, len));
}

beforeEach(async () => {
  skew = 0;
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100, now: () => Date.now() + skew });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of sessions.splice(0)) s.close();
  await h.clean();
});

describe('the caller', () => {
  it('from the hello: what a member makes is theirs, shown with their name', async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    expect(h.service.notebook.page(pageId)).toMatchObject({ created_by: 'gm-ana1', updated_by: 'gm-ana1' });
    const tree: any = await ana.rpc('notebook.tree');
    expect(tree.pages[0]).toMatchObject({ id: pageId, createdBy: 'gm-ana1', createdByName: 'Ana' });
    const today = new Date().toISOString().slice(0, 10);
    const activity: any = await ana.rpc('notebook.activity', { fromDay: '2000-01-01', toDay: '2100-01-01' });
    expect(activity.rows).toEqual([expect.objectContaining({ pageId, day: today, created: true, actors: ['gm-ana1'], actorNames: ['Ana'] })]);
    // Only what's in caller is kept: the name, by member id. No token, session or role.
    expect(h.service.db.all('SELECT * FROM members')).toEqual([expect.objectContaining({ member_id: 'gm-ana1', name: 'Ana' })]);
  });

  it('no caller is the owner, exactly as before', async () => {
    const legacy = h.session();
    const explicit = as({ kind: 'owner', memberId: null, role: null, grants: [], name: null, badge: null, teen: false });
    const { pageId } = await makeNotebook(legacy);
    const second = await makeNotebook(explicit);
    expect(h.service.notebook.page(pageId)).toMatchObject({ created_by: 'user' });
    expect(h.service.notebook.page(second.pageId)).toMatchObject({ created_by: 'user' });
    const tree: any = await legacy.rpc('notebook.tree');
    expect(Object.keys(tree.pages[0]).sort()).toEqual(['createdAt', 'deletedAt', 'hasChecklist', 'id', 'rowVersion', 'snippet', 'sortKey', 'tabId', 'title', 'updatedAt', 'wordCount']);
    const activity: any = await explicit.rpc('notebook.activity', { fromDay: '2000-01-01', toDay: '2100-01-01' });
    for (const r of activity.rows) expect(r).not.toHaveProperty('actorNames');
    expect(activity.rows.map((r: any) => r.actors)).toEqual([['user'], ['user']]);
    // The owner may trash anything on their own desk, a page a member made included.
    const ana = as(ANA);
    const theirs = await makeNotebook(ana);
    expect(await legacy.rpc('notebook.page.trash', { pageId: theirs.pageId })).toEqual({});
    expect(h.service.db.all('SELECT * FROM page_clients')).toEqual([]);
  });

  it('a caller frame applies to the frames after it, and to none before', async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const bo = as(BO);
    // Sent together: the trash goes as Bo was, without moderate, and the trash after the frame goes with it.
    const before = bo.rpc('notebook.page.trash', { pageId });
    bo.sendJson({ t: 'caller', caller: { ...BO, role: 'officer', grants: ['moderate', 'manage_spaces'], name: 'Bo B' } });
    const after = bo.rpc('notebook.page.trash', { pageId });
    await fails(before, 'forbidden', 'grant');
    expect(await after).toEqual({});
    expect(h.service.notebook.page(pageId)?.deleted_at).not.toBeNull();
    // A new name shows wherever Bo is named.
    const mine = await makeNotebook(bo);
    const tree: any = await bo.rpc('notebook.tree');
    expect(tree.pages.find((x: any) => x.id === mine.pageId)).toMatchObject({ createdBy: 'gm-bo2', createdByName: 'Bo B' });
    // A frame that changes nothing is harmless.
    bo.sendJson({ t: 'caller', caller: { ...BO, role: 'officer', grants: ['moderate', 'manage_spaces'], name: 'Bo B' } });
    expect((await bo.rpc('notebook.tree')).rev).toBeGreaterThan(0);
  });

  it('a caller frame that changes memberId or kind drops the connection, and nothing else', async () => {
    const bo = as(BO);
    const other = as(ANA);
    await bo.rpc('notebook.tree');
    bo.sendJson({ t: 'caller', caller: { ...BO, memberId: 'gm-someone-else' } });
    await bo.whenClosed();

    const legacy = h.session();
    await legacy.rpc('notebook.tree');
    legacy.sendJson({ t: 'caller', caller: BO });
    await legacy.whenClosed();

    const third = as(BO);
    third.sendJson({ t: 'caller', caller: { kind: 'owner', memberId: null, role: null, grants: [], name: null } });
    await third.whenClosed();

    const fourth = as(BO);
    fourth.sendJson({ t: 'caller' });
    await fourth.whenClosed();

    expect(other.closed).toBe(false);
    expect((await other.rpc('notebook.tree')).next).toBeNull();
  });

  it('a hello with a caller that is not one drops the connection', async () => {
    for (const bad of [{ ...BO, memberId: '' }, { ...BO, role: 'king' }, { ...BO, grants: 'moderate' }, { kind: 'guest' }, { kind: 'owner', memberId: 'gm-x' }, 'Ana']) {
      const s = as(bad);
      await s.whenClosed();
    }
  });
});

describe('Trash on a guild desk', () => {
  it("without moderate: another member's page is refused, one's own is fine", async () => {
    const ana = as(ANA);
    const bo = as(BO);
    const { tabId, pageId } = await makeNotebook(ana);
    await fails(bo.rpc('notebook.page.trash', { pageId }), 'forbidden', 'grant');
    expect(h.service.notebook.page(pageId)?.deleted_at).toBeNull();
    const own = (await bo.rpc('notebook.page.create', { tabId })).page.id;
    expect(await bo.rpc('notebook.page.trash', { pageId: own })).toEqual({});
    // The one who trashed a page may bring it back, and editing, renaming and moving stay open to all.
    expect(await bo.rpc('notebook.page.restore', { pageId: own })).toEqual({});
    expect(await bo.rpc('notebook.page.move', { pageId, tabId, index: 1 })).toEqual({});
    expect(await bo.rpc('notebook.tab.rename', { id: tabId, title: 'Renamed by Bo' })).toEqual({});
  });

  it('with moderate, and as lead, it is fine', async () => {
    const ana = as(ANA);
    const { tabId, pageId } = await makeNotebook(ana);
    const second = (await ana.rpc('notebook.page.create', { tabId })).page.id;
    expect(await as(MO).rpc('notebook.page.trash', { pageId })).toEqual({});
    expect(await as(LEE).rpc('notebook.page.trash', { pageId: second })).toEqual({});
  });

  it("one's own page holding another member's text is refused, open or not", async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const bo = clientAs(BO).open(pageId);
    await synced(bo);
    setBody(bo.document, doc(p("Bo's line")));
    await until('ack', () => !bo.hasUnsyncedChanges);
    await fails(ana.rpc('notebook.page.trash', { pageId }), 'forbidden', 'grant');
    clients.splice(0).forEach((c) => c.destroy());
    await until('the page to unload', () => h.service.pages.open.size === 0);
    await fails(ana.rpc('notebook.page.trash', { pageId }), 'forbidden', 'grant');
    expect(await as(MO).rpc('notebook.page.trash', { pageId })).toEqual({});
  });

  it("authz-5: a moderator's trash holds against a plain member: no restore, no read, no collab open", async () => {
    const ana = as(ANA);
    const bo = as(BO);
    const lee = as(LEE);
    const { pageId } = await makeNotebook(ana);
    const pa = clientAs(ANA).open(pageId);
    await synced(pa);
    setBody(pa.document, doc(p('Ana wrote something unsuitable')));
    await until('ack', () => !pa.hasUnsyncedChanges);
    clients.splice(0).forEach((c) => c.destroy());
    await until('the page to unload', () => h.service.pages.open.size === 0);
    expect(await lee.rpc('notebook.page.trash', { pageId })).toEqual({});
    // Bo is told it's in Trash, as everyone is, and that is all Bo gets of it.
    const tree: any = await bo.rpc('notebook.tree');
    expect(tree.pages.find((x: any) => x.id === pageId).deletedAt).not.toBeNull();
    await fails(bo.rpc('notebook.page.restore', { pageId }), 'forbidden', 'grant');
    expect(h.service.notebook.page(pageId)?.deleted_at).not.toBeNull();
    await fails(bo.rpc('notebook.page.content', { pageId }), 'forbidden', 'grant');
    await fails(bo.rpc('notebook.version.list', { pageId }), 'forbidden', 'grant');
    await fails(bo.rpc('notebook.version.save', { pageId }), 'forbidden', 'grant');
    const denied: string[] = [];
    clientAs(BO).open(pageId, new Y.Doc(), { onAuthenticationFailed: ({ reason }: { reason: string }) => denied.push(reason) });
    await until('the refusal', () => denied.includes('forbidden'));
    // Nor may Ana, who made the page but didn't trash it.
    await fails(ana.rpc('notebook.page.restore', { pageId }), 'forbidden', 'grant');
    // A moderator still reads it and brings it back.
    const mo = as(MO);
    expect((await mo.rpc('notebook.page.content', { pageId })).part).toContain('Ana wrote something unsuitable');
    expect(await mo.rpc('notebook.page.restore', { pageId })).toEqual({});
    expect(h.service.notebook.page(pageId)?.deleted_at).toBeNull();
    expect(await deskText(bo, pageId)).toContain('Ana wrote something unsuitable');
  });

  it('authz-5: a member brings back a page they trashed themselves, and the owner restores anything on their own desk', async () => {
    const bo = as(BO);
    const { tabId, pageId } = await makeNotebook(bo);
    expect(await bo.rpc('notebook.page.trash', { pageId })).toEqual({});
    expect(h.service.notebook.page(pageId)).toMatchObject({ deleted_by: 'gm-bo2' });
    await fails(as(ANA).rpc('notebook.page.restore', { pageId }), 'forbidden', 'grant');
    expect(await bo.rpc('notebook.page.restore', { pageId })).toEqual({});
    expect(h.service.notebook.page(pageId)).toMatchObject({ deleted_at: null, deleted_by: null });
    // A page trashed before the desk kept who did it is a moderator's to bring back.
    const second = (await bo.rpc('notebook.page.create', { tabId })).page.id;
    expect(await bo.rpc('notebook.page.trash', { pageId: second })).toEqual({});
    h.service.db.run('UPDATE pages SET deleted_by = NULL WHERE id = ?', second);
    await fails(bo.rpc('notebook.page.restore', { pageId: second }), 'forbidden', 'grant');
    expect(await as(MO).rpc('notebook.page.restore', { pageId: second })).toEqual({});
    // The owner's own desk: exactly as before.
    const owner = h.session();
    const mine = await makeNotebook(owner);
    expect(await owner.rpc('notebook.page.trash', { pageId: mine.pageId })).toEqual({});
    expect(await owner.rpc('notebook.page.restore', { pageId: mine.pageId })).toEqual({});
  });

  it('settings need lead or manage_spaces, here as in deskd', async () => {
    await fails(as(CAL).rpc('notebook.settings.set', { timeZone: 'Europe/Paris' }), 'forbidden', 'grant');
    expect(await as(LEE).rpc('notebook.settings.set', { timeZone: 'Europe/Paris' })).toEqual({});
    expect(await as(member('gm-sp5', 'Sam', ['manage_spaces'], 'officer')).rpc('notebook.settings.set', { timeZone: 'UTC' })).toEqual({});
  });
});

describe('the space structure on a guild desk (notebooks and tabs need manage_spaces; pages stay open)', () => {
  const OFFICER_SPACES = member('gm-sp6', 'Sam', ['manage_spaces'], 'officer');
  const OFFICER_MOD = member('gm-md7', 'Max', ['moderate'], 'officer');

  it('a member without the grant is refused on every notebook and tab call, and the desk is unchanged', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(as(LEE));
    const cal = as(CAL);
    const before = JSON.stringify(await cal.rpc('notebook.tree'));
    const calls: [string, Record<string, unknown>][] = [
      ['notebook.notebook.create', { title: 'Mine' }],
      ['notebook.notebook.rename', { id: notebookId, title: 'Renamed' }],
      ['notebook.tab.create', { notebookId, title: 'Tab' }],
      ['notebook.tab.rename', { id: tabId, title: 'Renamed' }],
      ['notebook.tab.recolor', { id: tabId, color: 'blue' }],
      ['notebook.tab.addAtPage', { pageId }],
    ];
    for (const [method, params] of calls) await fails(cal.rpc(method, params), 'forbidden', 'grant');
    // An officer with only moderate has no more say over spaces than a member.
    await fails(as(OFFICER_MOD).rpc('notebook.tab.rename', { id: tabId, title: 'No' }), 'forbidden', 'grant');
    expect(JSON.stringify(await cal.rpc('notebook.tree'))).toBe(before);
  });

  it('the Founder and an Officer with manage_spaces are allowed', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(as(LEE));
    for (const who of [LEE, OFFICER_SPACES]) {
      const s = as(who);
      const made: any = await s.rpc('notebook.notebook.create', { title: 'Another' });
      expect(made.notebook.id).toBeTruthy();
      expect(await s.rpc('notebook.notebook.rename', { id: notebookId, title: 'Work 2' })).toEqual({});
      expect((await s.rpc('notebook.tab.create', { notebookId, title: 'Tab' })).tab.id).toBeTruthy();
      expect(await s.rpc('notebook.tab.rename', { id: tabId, title: 'First' })).toEqual({});
      expect(await s.rpc('notebook.tab.recolor', { id: tabId, color: 'blue' })).toEqual({});
      expect((await s.rpc('notebook.tab.addAtPage', { pageId })).tab.id).toBeTruthy();
    }
  });

  it('pages stay open to a member without the grant: create, edit, move and trash their own', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(as(LEE));
    const other: any = await as(LEE).rpc('notebook.tab.create', { notebookId, title: 'Second' });
    const cal = as(CAL);
    const mine = (await cal.rpc('notebook.page.create', { tabId })).page.id;
    expect(await cal.rpc('notebook.page.move', { pageId: mine, tabId: other.tab.id })).toEqual({});
    expect(await cal.rpc('notebook.page.move', { pageId, tabId: other.tab.id, index: 0 })).toEqual({});
    expect(await cal.rpc('notebook.page.trash', { pageId: mine })).toEqual({});
    expect(await cal.rpc('notebook.page.restore', { pageId: mine })).toEqual({});
    const c = clientAs(CAL).open(pageId);
    await synced(c);
    setBody(c.document, doc(p('Cal was here')));
    await until('ack', () => !c.hasUnsyncedChanges);
    expect(await deskText(cal, pageId)).toContain('Cal was here');
  });

  it("a member's own desk (the owner, no guild caller) is unchanged", async () => {
    const legacy = h.session();
    const { notebookId, tabId, pageId } = await makeNotebook(legacy);
    expect(await legacy.rpc('notebook.notebook.rename', { id: notebookId, title: 'Mine' })).toEqual({});
    expect(await legacy.rpc('notebook.tab.rename', { id: tabId, title: 'Tab' })).toEqual({});
    expect(await legacy.rpc('notebook.tab.recolor', { id: tabId, color: 'blue' })).toEqual({});
    expect((await legacy.rpc('notebook.tab.create', { notebookId })).tab.id).toBeTruthy();
    expect((await legacy.rpc('notebook.tab.addAtPage', { pageId })).tab.id).toBeTruthy();
  });
});

describe('inside a page', () => {
  let pageId: string;
  let ana: ReturnType<Client['open']>;
  let s: DeskdSession;

  beforeEach(async () => {
    s = as(ANA);
    pageId = (await makeNotebook(s)).pageId;
    ana = clientAs(ANA).open(pageId);
    await synced(ana);
    setBody(ana.document, doc(p('Ana one'), p('Ana two')));
    await until('ack', () => !ana.hasUnsyncedChanges);
  });

  async function openAs(caller: unknown, waitFor = 'Ana two'): Promise<{ provider: ReturnType<Client['open']>; seen: string[]; client: Client }> {
    const client = clientAs(caller);
    const provider = client.open(pageId);
    const seen = closes(provider);
    await synced(provider);
    await until('the text', () => textOf(provider.document).includes(waitFor));
    return { provider, seen, client };
  }

  const used = (memberId = 'gm-bo2'): number => h.service.removals.used(pageId, memberId);

  it("a typo fix in another member's text is fine, and so is deleting a short paragraph of theirs", async () => {
    const { provider: bo, seen } = await openAs(BO);
    // "Ana one" to "Ana One": one character of Ana's out, one of Bo's in.
    const first = (bo.document.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    bo.document.transact(() => {
      first.delete(4, 1);
      first.insert(4, 'O');
    });
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(1);
    // A whole block of hers costs at least BLOCK_MIN.
    setBody(bo.document, doc(p('Ana One')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(1 + BLOCK_MIN);
    expect(seen).toEqual([]);
    expect(await deskText(s, pageId)).toBe('Ana One');
    // Ana's own is never charged to anyone.
    expect(used('gm-ana1')).toBe(0);
  });

  it('an update that would pass the budget is refused whole, the desk keeps it, and a fresh Y.Doc recovers', async () => {
    setBody(ana.document, doc(p('Ana one'), p('Ana two'), p(essay(600))));
    await until('ack', () => !ana.hasUnsyncedChanges);
    const { provider: bo, seen } = await openAs(BO);
    // Ana's 600-character paragraph and a word of Bo's elsewhere, in one update: refused, Bo's word and all.
    bo.document.transact(() => {
      ((bo.document.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'Bo: ');
      bo.document.getXmlFragment(DOC_FIELD).delete(2, 1);
    });
    await until('the refusal', () => seen.includes('forbidden'));
    expect(await deskText(s, pageId)).toBe(`Ana one|Ana two|${essay(600)}`);
    expect(bo.hasUnsyncedChanges).toBe(true);
    expect(used()).toBe(0);
    // What the app does: drop that provider and open the page on a fresh Y.Doc. It gets the page as the desk has it.
    const { provider: fresh, seen: seen2 } = await openAs(BO);
    expect(textOf(fresh.document)).toBe(`Ana oneAna two${essay(600)}`);
    typeInto(fresh.document, ' and Bo');
    await until('ack', () => !fresh.hasUnsyncedChanges);
    expect(seen2).toEqual([]);
    expect(await deskText(s, pageId)).toBe(`Ana one|Ana two|${essay(600)} and Bo`);
  });

  it('500 in ten minutes is fine, 501 is refused, and the budget comes back as the window rolls', async () => {
    expect(REMOVAL_BUDGET).toBe(500);
    expect(REMOVAL_WINDOW_MS).toBe(10 * 60_000);
    setBody(ana.document, doc(p('Ana one'), p('Ana two'), p(essay(2000))));
    await until('ack', () => !ana.hasUnsyncedChanges);
    const left = async (): Promise<number> => (await deskText(s, pageId)).length - 'Ana one|Ana two|'.length;
    const { provider: bo, seen } = await openAs(BO);
    deleteIn(bo.document, 2, 0, 300);
    await until('ack', () => !bo.hasUnsyncedChanges);
    advance(6 * 60_000);
    deleteIn(bo.document, 2, 0, 200);
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(500);
    expect(seen).toEqual([]);
    deleteIn(bo.document, 2, 0, 1);
    await until('the refusal', () => seen.includes('forbidden'));
    expect(await left()).toBe(1500);
    // Ten minutes after the first 300, they're back; the 200 from six minutes later aren't yet.
    advance(4 * 60_000 + 1);
    expect(used()).toBe(200);
    const second = await openAs(BO);
    deleteIn(second.provider.document, 2, 0, 301);
    await until('the refusal', () => second.seen.includes('forbidden'));
    const third = await openAs(BO);
    deleteIn(third.provider.document, 2, 0, 300);
    await until('ack', () => !third.provider.hasUnsyncedChanges);
    expect(third.seen).toEqual([]);
    expect(used()).toBe(500);
    // And after a whole window, all of it.
    advance(REMOVAL_WINDOW_MS + 1);
    expect(used()).toBe(0);
    deleteIn(third.provider.document, 2, 0, 500);
    await until('ack', () => !third.provider.hasUnsyncedChanges);
    expect(third.seen).toEqual([]);
    expect(await left()).toBe(700);
    // The budget is per page.
    expect(h.service.removals.used('another-page', 'gm-bo2')).toBe(0);
  });

  it('whole blocks cost at least 50 each: ten short ones is the budget', async () => {
    setBody(ana.document, doc(...Array.from({ length: 11 }, (_, i) => p(`Ana ${i + 1}`))));
    await until('ack', () => !ana.hasUnsyncedChanges);
    const { provider: bo, seen } = await openAs(BO, 'Ana 11');
    setBody(bo.document, doc(p('Ana 11')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(10 * BLOCK_MIN);
    expect(seen).toEqual([]);
    setBody(bo.document, doc(p('')));
    await until('the refusal', () => seen.includes('forbidden'));
    expect(await deskText(s, pageId)).toBe('Ana 11');
  });

  it('with moderate, or as lead, there is no budget', async () => {
    setBody(ana.document, doc(p('Ana one'), p('Ana two'), p(essay(1500)), p(essay(1500, 'More of it. '))));
    await until('ack', () => !ana.hasUnsyncedChanges);
    const { provider: mo, seen } = await openAs(MO);
    setBody(mo.document, doc(p('Ana one'), p('Ana two'), p(essay(1500, 'More of it. '))));
    await until('ack', () => !mo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    const { provider: lee, seen: seenLee } = await openAs(LEE, 'More of it');
    setBody(lee.document, doc(p('')));
    await until('ack', () => !lee.hasUnsyncedChanges);
    expect(seenLee).toEqual([]);
    expect(await deskText(s, pageId)).toBe('');
    expect(used('gm-mo3')).toBe(0);
    expect(used('gm-lee4')).toBe(0);
  });

  it("deleting one's own is fine, inside another member's paragraph too", async () => {
    const { provider: bo, seen } = await openAs(BO);
    setBody(bo.document, doc(p('Ana one'), p('Ana two'), p('Bo here')));
    typeInto(bo.document, ' and more');
    await until('ack', () => !bo.hasUnsyncedChanges);
    setBody(bo.document, doc(p('Ana one'), p('Ana two')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    // Bo types into Ana's first paragraph, then takes it out again.
    const first = (bo.document.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    bo.document.transact(() => first.insert(3, ' (Bo)'));
    await until('ack', () => !bo.hasUnsyncedChanges);
    bo.document.transact(() => first.delete(3, 5));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(await deskText(s, pageId)).toBe('Ana one|Ana two');
    expect(used()).toBe(0);
  });

  it("moving another member's text is free, and moved text stays theirs", async () => {
    const { provider: bo, seen } = await openAs(BO);
    // Enter in the middle of Ana's paragraph: the editor deletes the tail and writes it again in a new paragraph.
    setBody(bo.document, doc(p('Ana '), p('one'), p('Ana two')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    // A new block type: the editor deletes the paragraph and writes a heading with the same text.
    setBody(bo.document, doc(p('Ana '), h1('one'), p('Ana two')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(await deskText(s, pageId)).toBe('Ana |one|Ana two');
    expect(h.service.db.get<{ n: number }>('SELECT count(*) AS n FROM page_credits')?.n).toBeGreaterThan(0);
    expect(used()).toBe(0);
    // The heading's text is in Bo's structs now, but it's still Ana's: deleting it is charged as hers.
    setBody(bo.document, doc(p('Ana '), p('Ana two')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(BLOCK_MIN);
    // Ana may delete her own, wherever it went, free.
    setBody(ana.document, doc(p('Ana two')));
    await until('ack', () => !ana.hasUnsyncedChanges);
    expect(await deskText(s, pageId)).toBe('Ana two');
    expect(used('gm-ana1')).toBe(0);
  });

  it("joining, wrapping in a list and dragging another member's blocks are moves too", async () => {
    const { provider: bo, seen } = await openAs(BO);
    const list = (...items: PMNode[]): PMNode => ({ type: 'bulletList', content: items.map((x) => ({ type: 'listItem', content: [x] })) });
    // Backspace at the start of Ana's second paragraph.
    setBody(bo.document, doc(p('Ana oneAna two')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    // Enter again, then both into a list, then the list's items swapped by a drag.
    setBody(bo.document, doc(p('Ana one'), p('Ana two')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    setBody(bo.document, doc(list(p('Ana one'), p('Ana two'))));
    await until('ack', () => !bo.hasUnsyncedChanges);
    setBody(bo.document, doc(list(p('Ana two'), p('Ana one'))));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(await deskText(s, pageId)).toBe('Ana two|Ana one');
    expect(used()).toBe(0);
    // And it's all still Ana's.
    setBody(bo.document, doc(list(p('Ana two'))));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(used()).toBe(BLOCK_MIN);
  });

  it('formatting and attributes are edits, not deletions', async () => {
    const { provider: bo, seen } = await openAs(BO);
    setBody(bo.document, doc(p('Ana one'), { type: 'paragraph', content: [{ type: 'text', text: 'Ana', marks: [{ type: 'bold' }] }, { type: 'text', text: ' two' }] }));
    await until('ack', () => !bo.hasUnsyncedChanges);
    setBody(ana.document, doc(p('Ana one'), p('Ana two'), task('Ana task')));
    await until('the task', () => textOf(bo.document).includes('Ana task'));
    await until('ack', () => !ana.hasUnsyncedChanges);
    setBody(bo.document, doc(p('Ana one'), p('Ana two'), task('Ana task', true)));
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    const content: any = await s.rpc('notebook.page.content', { pageId });
    expect(content.part).toContain('"checked":true');
    expect(used()).toBe(0);
  });

  it('two members typing at once merge, with nothing refused', async () => {
    const { provider: bo, seen } = await openAs(BO);
    const seenAna = closes(ana);
    setBody(bo.document, doc(p('Ana one'), p('Ana two'), p('Bo:')));
    await until('ack', () => !bo.hasUnsyncedChanges);
    await until('Bo at Ana', () => textOf(ana.document).includes('Bo:'));
    const anaFirst = (ana.document.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    for (let i = 0; i < 40; i += 1) {
      ana.document.transact(() => anaFirst.insert(anaFirst.length, ` a${i}`));
      typeInto(bo.document, ` b${i}`);
      // Each deletes some of their own as they go.
      if (i % 10 === 9) {
        ana.document.transact(() => anaFirst.delete(anaFirst.length - 3, 3));
        deleteIn(bo.document, 2, 3, 2);
      }
    }
    await until('both to converge', () => textOf(ana.document) === textOf(bo.document) && textOf(ana.document).includes('b39') && textOf(ana.document).includes('a38'));
    await until('both acknowledged', () => !ana.hasUnsyncedChanges && !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(seenAna).toEqual([]);
  });

  it("undo of one's own typing is fine", async () => {
    const { provider: bo, seen } = await openAs(BO);
    const undo = new Y.UndoManager(bo.document.getXmlFragment(DOC_FIELD), { captureTimeout: 0 });
    typeInto(bo.document, ' typed by Bo');
    await until('ack', () => !bo.hasUnsyncedChanges);
    undo.undo();
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(await deskText(s, pageId)).toBe('Ana one|Ana two');
    undo.redo();
    await until('ack', () => !bo.hasUnsyncedChanges);
    expect(await deskText(s, pageId)).toBe('Ana one|Ana two typed by Bo');
    undo.destroy();
  });

  it("writing as another member's client id is refused, even with moderate", async () => {
    const forged = new Y.Doc();
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(ana.document));
    forged.clientID = ana.document.clientID;
    typeInto(forged, ' not by Ana');
    const provider = clientAs(MO).open(pageId, forged);
    const seen = closes(provider);
    await until('the refusal', () => seen.includes('forbidden'));
    expect(await deskText(s, pageId)).toBe('Ana one|Ana two');
  });

  it("deleting another member's structs the desk hasn't seen yet is refused", async () => {
    const { seen, client } = await openAs(BO);
    // A delete set for Ana's next 50 clocks, which Yjs would keep and apply when her next update arrives.
    const anaClient = ana.document.clientID;
    const next = Y.getState(ana.document.store, anaClient);
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 0);
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, anaClient);
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, next);
    encoding.writeVarUint(update, 50);
    const message = encoding.createEncoder();
    encoding.writeVarString(message, pageId);
    encoding.writeVarUint(message, 0);
    encoding.writeVarUint(message, 2);
    encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
    client.session?.sendCollab(encoding.toUint8Array(message));
    await until('the refusal', () => seen.includes('forbidden'));
    typeInto(ana.document, ' still here');
    await until('ack', () => !ana.hasUnsyncedChanges);
    expect(await deskText(s, pageId)).toBe('Ana one|Ana two still here');
  });
});

describe('attribution', () => {
  it('versions and activity say who, by member id, with names', async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const pa = clientAs(ANA).open(pageId);
    await synced(pa);
    setBody(pa.document, doc(h1('Plan'), p('Ana wrote this')));
    await until('ack', () => !pa.hasUnsyncedChanges);
    await sleep(30);
    const bo = as(BO);
    const saved: any = await bo.rpc('notebook.version.save', { pageId });
    expect(saved.version).toMatchObject({ reason: 'manual', actor: 'gm-bo2', actorName: 'Bo' });

    const pb = clientAs(BO).open(pageId);
    await synced(pb);
    typeInto(pb.document, ', and Bo too');
    await until('ack', () => !pb.hasUnsyncedChanges);
    await until('the store', () => h.service.notebook.page(pageId)?.updated_by === 'gm-bo2', 5000);
    // The last connection leaving ends the session: its version is the last editor's.
    clients.splice(0).forEach((c) => c.destroy());
    await until('the page to unload', () => h.service.pages.open.size === 0);
    const list: any = await ana.rpc('notebook.version.list', { pageId });
    expect(list.versions[0]).toMatchObject({ reason: 'session', actor: 'gm-bo2', actorName: 'Bo' });
    const got: any = await ana.rpc('notebook.version.get', { versionId: saved.version.id });
    expect(got.meta).toMatchObject({ actor: 'gm-bo2', actorName: 'Bo' });
    const activity: any = await ana.rpc('notebook.activity', { fromDay: '2000-01-01', toDay: '2100-01-01' });
    expect(activity.rows).toHaveLength(1);
    expect(activity.rows[0].actors).toEqual(['gm-ana1', 'gm-bo2']);
    expect(activity.rows[0].actorNames).toEqual(['Ana', 'Bo']);
    // The log row keeps who, so a crash between commit and store keeps it too.
    expect(h.service.db.all("SELECT member_id FROM page_clients WHERE page_id = ? ORDER BY member_id", pageId).map((r: any) => r.member_id)).toEqual(['gm-ana1', 'gm-bo2']);
  });

  it("a restore is charged as an edit: past the budget needs moderate; within it, or only one's own, is fine", async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const bo = as(BO);
    const pb = clientAs(BO).open(pageId);
    await synced(pb);
    setBody(pb.document, doc(p('Bo first')));
    await until('ack', () => !pb.hasUnsyncedChanges);
    await sleep(30);
    const v1: any = await bo.rpc('notebook.version.save', { pageId });
    const pa = clientAs(ANA).open(pageId);
    await synced(pa);
    setBody(pa.document, doc(p('Bo first'), p(essay(600))));
    await until('ack', () => !pa.hasUnsyncedChanges);
    await fails(bo.rpc('notebook.version.restore', { pageId, versionId: v1.version.id }), 'forbidden', 'grant');
    expect(await deskText(bo, pageId)).toBe(`Bo first|${essay(600)}`);
    expect(h.service.removals.used(pageId, 'gm-bo2')).toBe(0);
    // Ana may: the only text it removes is her own.
    expect(await ana.rpc('notebook.version.restore', { pageId, versionId: v1.version.id })).toEqual({});
    await until('the restore to reach Bo', () => textOf(pb.document) === 'Bo first');
    let list: any = await bo.rpc('notebook.version.list', { pageId });
    expect(list.versions[0]).toMatchObject({ reason: 'restore', actor: 'gm-ana1', actorName: 'Ana' });
    // Bo may when it's within his budget: a short paragraph of hers is a block, BLOCK_MIN.
    setBody(pa.document, doc(p('Bo first'), p('Ana later')));
    await until('ack', () => !pa.hasUnsyncedChanges);
    expect(await bo.rpc('notebook.version.restore', { pageId, versionId: v1.version.id })).toEqual({});
    await until('the restore', async () => (await deskText(bo, pageId)) === 'Bo first');
    expect(h.service.removals.used(pageId, 'gm-bo2')).toBe(BLOCK_MIN);
    list = await bo.rpc('notebook.version.list', { pageId });
    expect(list.versions[0]).toMatchObject({ reason: 'restore', actor: 'gm-bo2', actorName: 'Bo' });
    // And a moderator may restore over anyone's, however much.
    setBody(pa.document, doc(p('Bo first'), p(essay(600))));
    await until('ack', () => !pa.hasUnsyncedChanges);
    expect(await as(MO).rpc('notebook.version.restore', { pageId, versionId: v1.version.id })).toEqual({});
    await until('the restore', async () => (await deskText(bo, pageId)) === 'Bo first');
  });
});

describe('who wrote what, across a restart and a crash', () => {
  it("survives a restart: Ana's text is still charged as hers", async () => {
    const ana = as(ANA);
    const { pageId } = await makeNotebook(ana);
    const pa = clientAs(ANA).open(pageId);
    await synced(pa);
    setBody(pa.document, doc(p('Ana one'), p('Ana two')));
    await until('ack', () => !pa.hasUnsyncedChanges);
    clients.splice(0).forEach((c) => c.destroy());
    sessions.splice(0).forEach((x) => x.close());
    await h.restart();
    const pb = clientAs(BO).open(pageId);
    const seen = closes(pb);
    await synced(pb);
    await until('the text', () => textOf(pb.document).includes('Ana two'));
    setBody(pb.document, doc(p('Ana one')));
    await until('ack', () => !pb.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(h.service.removals.used(pageId, 'gm-bo2')).toBe(BLOCK_MIN);
  });

  it('a SIGKILL between commit and store keeps who made the edits', async () => {
    const dir = tempDir();
    const running = child(dir, { DESK_NOTEBOOK_STORE_DEBOUNCE_MS: '60000', DESK_NOTEBOOK_STORE_MAX_MS: '60000' });
    try {
      await running.ready;
      const ana = new DeskdSession(running.socket, hello(ANA));
      const { pageId } = await makeNotebook(ana);
      const c = new Client(running.socket, hello(BO));
      const pb = c.open(pageId);
      await synced(pb);
      typeInto(pb.document, 'Bo typed this');
      await until('ack', () => !pb.hasUnsyncedChanges);
      await sleep(300); // past the 150 ms commit
      c.destroy();
      ana.close();
      await running.kill('SIGKILL');
      const again = child(dir);
      try {
        await again.ready;
        expect(again.logs.join('\n')).toContain('recovered pages=1');
        const s2 = new DeskdSession(again.socket, hello(ANA));
        const versions = (await s2.rpc('notebook.version.list', { pageId })).versions;
        expect(versions).toEqual([expect.objectContaining({ reason: 'session', actor: 'gm-bo2', actorName: 'Bo' })]);
        const activity: any = await s2.rpc('notebook.activity', { fromDay: '2000-01-01', toDay: '2100-01-01' });
        expect(activity.rows[0].actors).toEqual(['gm-ana1', 'gm-bo2']);
        // And what Bo wrote is still Bo's: Ana can't trash her own page with it in.
        await fails(s2.rpc('notebook.page.trash', { pageId }), 'forbidden', 'grant');
        s2.close();
      } finally {
        await again.kill('SIGTERM');
      }
    } finally {
      if (running.proc.exitCode === null && running.proc.signalCode === null) await running.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('judge, on documents directly', () => {
  /** A page Ana wrote, as the desk holds it, and a copy of it for Bo to edit under his own client id. */
  function page(body: PMNode, gc = true): { desk: Y.Doc; owners: PageOwners; bo: Y.Doc; before: Uint8Array } {
    const written = prosemirrorJSONToYDoc(notebookSchema(), body, DOC_FIELD);
    const desk = new Y.Doc({ gc: true });
    Y.applyUpdate(desk, Y.encodeStateAsUpdate(written));
    const owners = new PageOwners();
    owners.clients.set(written.clientID, 'gm-ana1');
    const bo = new Y.Doc({ gc });
    Y.applyUpdate(bo, Y.encodeStateAsUpdate(desk));
    written.destroy();
    return { desk, owners, bo, before: Y.encodeStateVector(bo) };
  }
  const changes = (bo: Y.Doc, before: Uint8Array): Uint8Array => Y.encodeStateAsUpdate(bo, before);

  it('deleting only an element, with its text left out of the delete set, still counts the text', () => {
    const { desk, owners } = page(doc(p('Ana one'), p('Ana two')));
    const el = desk.getXmlFragment(DOC_FIELD).get(1) as Y.XmlElement;
    const id = (el as unknown as { _item: Y.Item })._item.id;
    const u = encoding.createEncoder();
    encoding.writeVarUint(u, 0);
    encoding.writeVarUint(u, 1);
    encoding.writeVarUint(u, id.client);
    encoding.writeVarUint(u, 1);
    encoding.writeVarUint(u, id.clock);
    encoding.writeVarUint(u, 1);
    const v = judge(desk, encoding.toUint8Array(u), 'gm-bo2', owners);
    // A whole block, with its text: at least BLOCK_MIN.
    expect(v.cost).toBe(BLOCK_MIN);
  });

  it('text put back where it is not shown does not count as put back', () => {
    // Into an attribute.
    {
      const { desk, owners, bo, before } = page(doc(p('Ana one'), p('Ana two')));
      bo.transact(() => {
        const frag = bo.getXmlFragment(DOC_FIELD);
        const first = frag.get(0) as Y.XmlElement;
        frag.delete(1, 1);
        first.setAttribute('hidden', new Y.XmlText('Ana two') as unknown as string);
      });
      expect(judge(desk, changes(bo, before), 'gm-bo2', owners).cost).toBe(BLOCK_MIN);
    }
    // Into an element deleted in the same update, with nothing collected.
    {
      const { desk, owners, bo, before } = page(doc(p('Ana one'), p('Ana two')), false);
      bo.transact(() => {
        const frag = bo.getXmlFragment(DOC_FIELD);
        frag.delete(1, 1);
        const el = new Y.XmlElement('paragraph');
        el.insert(0, [new Y.XmlText('Ana two')]);
        frag.insert(1, [el]);
        frag.delete(1, 1);
      });
      expect(judge(desk, changes(bo, before), 'gm-bo2', owners).cost).toBe(BLOCK_MIN);
    }
    // Under the root, outside any text node.
    {
      const { desk, owners, bo, before } = page(doc(p('Ana one'), p('Ana two')));
      bo.transact(() => {
        const frag = bo.getXmlFragment(DOC_FIELD);
        frag.delete(1, 1);
        frag.insert(1, [new Y.XmlText('Ana two')]);
      });
      // The editor never writes text there, and can't show it.
      expect(judge(desk, changes(bo, before), 'gm-bo2', owners).cost).toBe(BLOCK_MIN);
    }
  });

  it('a move is credited exactly; a replacement is not a move', () => {
    const { desk, owners, bo, before } = page(doc(p('Ana one'), p('Ana two')));
    bo.transact(() => {
      const frag = bo.getXmlFragment(DOC_FIELD);
      frag.delete(0, 1);
      const el = new Y.XmlElement('heading');
      el.setAttribute('level', 1 as unknown as string);
      el.insert(0, [new Y.XmlText('Ana one')]);
      frag.insert(1, [el]);
    });
    const v = judge(desk, changes(bo, before), 'gm-bo2', owners);
    expect(v.cost).toBe(0);
    expect(v.credits.reduce((n, c) => n + c.len, 0)).toBe(7);
    expect(v.credits.every((c) => c.member === 'gm-ana1' && c.client === bo.clientID)).toBe(true);
    expect(v.newClients).toEqual([bo.clientID]);

    const second = page(doc(p('Ana one'), p('Ana two')));
    second.bo.transact(() => {
      const t = (second.bo.getXmlFragment(DOC_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlText;
      t.delete(4, 3);
      t.insert(4, 'six');
    });
    // Inside a block that stays, a character each.
    expect(judge(second.desk, changes(second.bo, second.before), 'gm-bo2', second.owners).cost).toBe(3);
  });

  it('a leaf block (a rule) costs BLOCK_MIN, and moving it is free', () => {
    const rule = { type: 'horizontalRule' } as PMNode;
    const removed = page(doc(p('Ana one'), rule, p('Ana two')));
    setBody(removed.bo, doc(p('Ana one'), p('Ana two')));
    expect(judge(removed.desk, changes(removed.bo, removed.before), 'gm-bo2', removed.owners).cost).toBe(BLOCK_MIN);
    const moved = page(doc(p('Ana one'), rule, p('Ana two')));
    setBody(moved.bo, doc(p('Ana one'), p('Ana two'), rule));
    expect(judge(moved.desk, changes(moved.bo, moved.before), 'gm-bo2', moved.owners).cost).toBe(0);
  });

  it('a big page: refusing a delete of all of it and crediting a move of half of it are quick', () => {
    const body = fakePages(60);
    const { desk, owners, bo, before } = page(body);
    const blocks = body.content as PMNode[];
    const half = Math.floor(blocks.length / 2);
    setBody(bo, doc(...blocks.slice(half), ...blocks.slice(0, half)));
    let t0 = performance.now();
    const moved = judge(desk, changes(bo, before), 'gm-bo2', owners);
    const moveMs = performance.now() - t0;
    expect(moved.cost).toBe(0);
    expect(moved.credits.length).toBeGreaterThan(0);

    const all = page(body);
    setBody(all.bo, doc(p('')));
    t0 = performance.now();
    const gone = judge(all.desk, changes(all.bo, all.before), 'gm-bo2', all.owners);
    const deleteMs = performance.now() - t0;
    expect(gone.cost).toBeGreaterThan(100_000);
    // Generous for a loaded box; on this machine both are well under 100 ms.
    expect(moveMs).toBeLessThan(2000);
    expect(deleteMs).toBeLessThan(2000);
    console.info(`judge: move of half of 60 pages ${moveMs.toFixed(1)} ms, delete of all ${deleteMs.toFixed(1)} ms`);
  });
});

describe('damage from a guild member', () => {
  it("damaged updates drop only that member's connection; the page and everyone else go on", async () => {
    const ana = as(ANA);
    const { tabId, pageId } = await makeNotebook(ana);
    const other = (await ana.rpc('notebook.page.create', { tabId })).page.id as string;
    const pa = clientAs(ANA).open(pageId);
    await synced(pa);
    setBody(pa.document, doc(p('Ana one'), p('Ana two'), p(essay(2000))));
    await until('ack', () => !pa.hasUnsyncedChanges);
    const good = clientAs(ANA).open(other);
    await synced(good);
    /** Live characters the desk has as Ana's. Bo can make there fewer only by what he's charged. */
    const anas = (): number => {
      const live = h.service.pages.open.get(pageId)?.doc as Y.Doc;
      const owners = new Owners(h.service.db).read(pageId);
      let n = 0;
      for (const [client, list] of live.store.clients) {
        for (const s of list) {
          if (!(s instanceof Y.Item) || s.deleted || !(s.content instanceof Y.ContentString)) continue;
          for (const seg of owners.segments(client, s.id.clock, s.id.clock + s.length)) if (seg.member === 'gm-ana1') n += seg.b - seg.a;
        }
      }
      return n;
    };
    const before = anas();
    expect(before).toBe('Ana oneAna two'.length + 2000);

    // Real updates of Bo's, deleting and moving Ana's text, to damage.
    const source = new Y.Doc();
    Y.applyUpdate(source, Y.encodeStateAsUpdate(pa.document));
    const updates: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => updates.push(u));
    setBody(source, doc(p('Ana '), p('one'), p('Ana two'), p(essay(2000))));
    setBody(source, doc(p('Ana two'), p(essay(2000))));
    typeInto(source, ' and Bo');
    setBody(source, doc(p('Ana two')));
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const wrap = (update: Uint8Array): Uint8Array => {
      const e = encoding.createEncoder();
      encoding.writeVarString(e, pageId);
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, update);
      return encoding.toUint8Array(e);
    };
    const authFor = (): Uint8Array => {
      const e = encoding.createEncoder();
      encoding.writeVarString(e, pageId);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint(e, 0);
      encoding.writeVarString(e, 'x');
      return encoding.toUint8Array(e);
    };
    let session = as(BO);
    session.sendCollab(authFor());
    let drops = 0;
    for (let i = 0; i < 600; i += 1) {
      const b = Uint8Array.from(updates[rnd(updates.length)] as Uint8Array);
      const at = rnd(b.length);
      b[at] = rnd(2) ? rnd(256) : (b[at] as number) ^ (1 << rnd(8));
      session.sendCollab(wrap(b));
      try {
        await session.rpc('notebook.activity.days');
      } catch {
        drops += 1;
        session = as(BO);
        session.sendCollab(authFor());
      }
      if (i % 100 === 0) {
        typeInto(good.document, ` g${i}`);
      }
    }
    await until('the good page acknowledged', () => !good.hasUnsyncedChanges);
    expect(textOf(good.document)).toContain('g500');
    // Whatever got through, damage removed no more of Ana's text than it was charged for, and that's within the budget.
    const charged = h.service.removals.used(pageId, 'gm-bo2');
    expect(charged).toBeLessThanOrEqual(REMOVAL_BUDGET);
    expect(anas()).toBeGreaterThanOrEqual(before - charged);
    expect(anas()).toBeGreaterThanOrEqual(before - REMOVAL_BUDGET);
    // Some damage is refused at once and some is taken as an edit: both happen.
    expect(drops).toBeGreaterThan(0);
    // The page still opens. (Damage can leave Yjs holding structs it's waiting on, which a new client may take where the
    // desk's own document doesn't; that's Yjs with damaged clocks on any desk, not this rule.)
    const fresh = clientAs(ANA).open(pageId);
    await synced(fresh);
    expect(textOf(fresh.document).length).toBeGreaterThan(1000);
  });
});

describe('presence names', () => {
  const others = (p: ReturnType<Client['open']>, mine: ReturnType<Client['open']>) =>
    [...(p.awareness?.getStates().entries() ?? [])].filter(([id]) => id !== (mine.awareness as any).clientID).map(([, v]) => v);

  it("a client claiming another name is shown to the others with its roster name, and its identity fields are dropped", async () => {
    const { pageId } = await makeNotebook(as(LEE));
    const ana = clientAs(ANA).open(pageId);
    const bo = clientAs(BO).open(pageId);
    await Promise.all([synced(ana), synced(bo)]);
    ana.setAwarenessField('user', { name: 'Lee the Founder', memberId: 'gm-lee4', color: '#abc', email: 'x@y.z', avatarUrl: 'u', cursorColor: '#def' });
    await until('Bo to see Ana', () => others(bo, bo).some((v) => v['user']));
    const user = others(bo, bo).find((v) => v['user'])!['user'];
    expect(user).toEqual({ name: 'Ana', memberId: 'gm-ana1', color: '#abc', cursorColor: '#def' });
    // A client that sets no user at all is named too.
    bo.setAwarenessField('cursor', { anchor: 1, head: 2 });
    await until('Ana to see Bo', () => others(ana, ana).some((v) => (v['user'] as any)?.name === 'Bo'));
    expect(others(ana, ana).find((v) => v['cursor'])!['cursor']).toEqual({ anchor: 1, head: 2 });
    // A late joiner is told the rewritten state too.
    const late = clientAs(LEE).open(pageId);
    await synced(late);
    await until('the late joiner to see Ana', () => others(late, late).some((v) => (v['user'] as any)?.name === 'Ana'));
    expect(others(late, late).map((v) => (v['user'] as any)?.name).sort()).toEqual(['Ana', 'Bo']);
  });

  it('a caller frame renames the member for everyone', async () => {
    const { pageId } = await makeNotebook(as(LEE));
    const anaClient = clientAs(ANA);
    const ana = anaClient.open(pageId);
    const bo = clientAs(BO).open(pageId);
    await Promise.all([synced(ana), synced(bo)]);
    ana.setAwarenessField('user', { name: 'Ana', color: '#abc' });
    await until('Bo to see Ana', () => others(bo, bo).some((v) => (v['user'] as any)?.name === 'Ana'));
    anaClient.session!.sendJson({ t: 'caller', caller: { ...ANA, name: 'Ana Q' } });
    await until('Bo to see the new name', () => others(bo, bo).some((v) => (v['user'] as any)?.name === 'Ana Q'));
    expect(others(bo, bo).find((v) => v['user'])!['user']).toEqual({ name: 'Ana Q', memberId: 'gm-ana1', color: '#abc' });
    // And her next update is named by the new caller as well.
    ana.setAwarenessField('user', { name: 'Spoof', color: '#111' });
    ana.setAwarenessField('user', { name: 'Spoof', color: '#222' });
    await until('the next update', () => (others(bo, bo)[0]!['user'] as any)?.color === '#222');
    expect((others(bo, bo)[0]!['user'] as any).name).toBe('Ana Q');
  });

  it("an owner's desk is unchanged", async () => {
    const s = h.session();
    const { pageId } = await makeNotebook(s);
    const a = new Client(h.socket);
    clients.push(a);
    const b = new Client(h.socket);
    clients.push(b);
    const pa = a.open(pageId);
    const pb = b.open(pageId);
    await Promise.all([synced(pa), synced(pb)]);
    pa.setAwarenessField('user', { name: 'Whatever', memberId: 'x', email: 'e', color: '#abc' });
    await until('B to see A', () => others(pb, pb).some((v) => v['user']));
    expect(others(pb, pb).find((v) => v['user'])!['user']).toEqual({ name: 'Whatever', memberId: 'x', email: 'e', color: '#abc' });
  });
});
