// The Agent's Notebook tools on the desk's side (src/agent.ts): a page as Markdown, and an agent's edit of the live page,
// as deskd calls them with the member's caller. On a guild desk every rule is the member's own (Z26/R4, authz-5, the edit
// budget). Fake members and fake text only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Client, DeskdSession, sleep, synced, until, type RpcError } from './helpers/deskd.ts';
import { doc, h1, p, setBody, textOf, typeInto } from './helpers/docs.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';
import { AGENT_NAME_MAX, MAX_MARKDOWN, READ_CHARS } from '../src/agent.ts';
import { DOC_FIELD, type PMNode } from '../src/model.ts';
import { BLOCK_MIN } from '../src/owners.ts';

const member = (memberId: string, name: string, grants: string[] = [], role = 'member') => ({ kind: 'guild_member', memberId, role, grants, name, badge: null, teen: false });
const ANA = member('gm-ana1', 'Ana', ['manage_spaces']);
const CAL = member('gm-cal5', 'Cal');
const MO = member('gm-mo3', 'Mo', ['moderate'], 'officer');
const hello = (caller: unknown, settings?: unknown) => ({ t: 'hello', sessionId: 'tools-1', sub: (caller as { memberId: string }).memberId, caller, ...(settings ? { settings } : {}) });

let h: Harness;
let s: DeskdSession;
const sessions: DeskdSession[] = [];
const clients: Client[] = [];
const as = (caller: unknown, settings?: unknown): DeskdSession => {
  const x = new DeskdSession(h.socket, hello(caller, settings));
  sessions.push(x);
  return x;
};
const client = (caller?: unknown): Client => {
  const c = new Client(h.socket, caller ? hello(caller) : true);
  clients.push(c);
  return c;
};

async function fails(promise: Promise<unknown>, code: string, reason?: string): Promise<void> {
  const e = (await promise.then(
    () => null,
    (err: RpcError) => err,
  )) as RpcError | null;
  expect(e?.code).toBe(code);
  if (reason) expect(e?.details).toEqual({ reason });
}

/** The page as the desk has it now, as text, blocks apart. */
async function deskText(x: DeskdSession, pageId: string): Promise<string> {
  const r: any = await x.rpc('notebook.page.content', { pageId });
  const walk = (n: PMNode): string => (n.text ?? '') + (n.content ?? []).map(walk).join('|');
  return walk(JSON.parse(r.part) as PMNode);
}
async function deskDoc(x: DeskdSession, pageId: string): Promise<PMNode> {
  return JSON.parse((await x.rpc('notebook.page.content', { pageId })).part) as PMNode;
}

/** A page with this body, written as an editor would, and left to unload. */
async function pageWith(x: DeskdSession, body: PMNode, caller?: unknown): Promise<{ tabId: string; pageId: string }> {
  const { tabId, pageId } = await makeNotebook(x);
  const c = client(caller);
  const provider = c.open(pageId);
  await synced(provider);
  setBody(provider.document, body);
  await until('ack', () => !provider.hasUnsyncedChanges);
  c.destroy();
  clients.splice(clients.indexOf(c), 1);
  await until('the page to unload', () => !h.service.pages.open.has(pageId));
  return { tabId, pageId };
}

const edit = (x: DeskdSession, params: Record<string, unknown>): Promise<any> => x.rpc('notebook.page.agentEdit', { agentName: 'ag-1', ...params });
const activityOf = async (x: DeskdSession, pageId: string): Promise<any> =>
  ((await x.rpc('notebook.activity', { fromDay: '2000-01-01', toDay: '2100-01-01' })).rows as any[]).find((r) => r.pageId === pageId);

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100 });
  s = h.session();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const x of sessions.splice(0)) x.close();
  await h.clean();
});

describe('notebook.page.markdown', () => {
  it('reads a page as Markdown: headings, marks, links, lists, tasks, quotes, code, rules', async () => {
    const { pageId } = await pageWith(
      s,
      doc(
        h1('Groceries'),
        { type: 'paragraph', content: [{ type: 'text', text: 'Buy ' }, { type: 'text', text: 'oat', marks: [{ type: 'bold' }] }, { type: 'text', text: ' milk from ' }, { type: 'text', text: 'the shop', marks: [{ type: 'link', attrs: { href: 'https://example.com/shop' } }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [p('apples')] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p('bread')] }] },
        { type: 'blockquote', content: [p('cash only')] },
        { type: 'codeBlock', attrs: { language: 'txt' }, content: [{ type: 'text', text: 'aisle 4' }] },
        { type: 'horizontalRule' },
      ),
    );
    const r = await s.rpc('notebook.page.markdown', { pageId });
    expect(r).toMatchObject({ pageId, title: 'Groceries', from: 0, next: null, trashed: false });
    expect(r.markdown).toBe('# Groceries\n\nBuy **oat** milk from [the shop](https://example.com/shop)\n\n- apples\n\n- [x] bread\n\n> cash only\n\n```txt\naisle 4\n```\n\n---\n');
    expect(r.length).toBe(r.markdown.length);
  });

  it(`comes ${READ_CHARS} characters at a time, cut at a line's end, and the parts make the whole`, async () => {
    const lines = Array.from({ length: 900 }, (_, i) => p(`Line ${i} of a long page, written to be read in parts by an agent.`));
    const { pageId } = await pageWith(s, doc(h1('Long'), ...lines));
    let from: number | null = 0;
    let whole = '';
    let reads = 0;
    let length = 0;
    while (from !== null) {
      const r: any = await s.rpc('notebook.page.markdown', { pageId, from });
      expect(r.from).toBe(from);
      expect(r.markdown.length).toBeLessThanOrEqual(READ_CHARS);
      if (r.next !== null) expect(r.markdown.endsWith('\n')).toBe(true);
      whole += r.markdown;
      length = r.length;
      from = r.next;
      reads += 1;
    }
    expect(reads).toBeGreaterThan(2);
    expect(whole.length).toBe(length);
    expect(whole).toContain('Line 899 of a long page');
    await fails(s.rpc('notebook.page.markdown', { pageId, from: length + 1 }), 'bad_request', 'from');
    await fails(s.rpc('notebook.page.markdown', { pageId, max: READ_CHARS + 1 }), 'bad_request', 'max');
    // max 0 is the title and the rest of what's known, with no text.
    expect(await s.rpc('notebook.page.markdown', { pageId, max: 0 })).toMatchObject({ title: 'Long', markdown: '', next: 0 });
  });

  it("an open page is read live, and a missing one isn't found", async () => {
    const { pageId } = await makeNotebook(s);
    const provider = client().open(pageId);
    await synced(provider);
    setBody(provider.document, doc(h1('Live'), p('typed just now')));
    await until('ack', () => !provider.hasUnsyncedChanges);
    expect((await s.rpc('notebook.page.markdown', { pageId })).markdown).toBe('# Live\n\ntyped just now\n');
    await fails(s.rpc('notebook.page.markdown', { pageId: 'no-such-page' }), 'not_found');
  });
});

describe('notebook.page.agentEdit on an owner desk', () => {
  it('create: a new page in the tab, its title first, the Markdown after; activity says the agent', async () => {
    const { tabId } = await makeNotebook(s);
    const r = await edit(s, { op: 'create', new: { tabId, title: 'Trip' }, markdown: '# Trip\n\n- [ ] book train\n- [ ] pack' });
    expect(r).toMatchObject({ title: 'Trip', op: 'create', versionId: null });
    const tree: any = await s.rpc('notebook.tree');
    expect(tree.pages.find((x: any) => x.id === r.pageId)).toMatchObject({ tabId, title: 'Trip', hasChecklist: true });
    expect((await s.rpc('notebook.page.markdown', { pageId: r.pageId })).markdown).toBe('# Trip\n\n- [ ] book train\n- [ ] pack\n');
    expect(h.service.notebook.page(r.pageId)).toMatchObject({ created_by: 'user' });
    expect((await activityOf(s, r.pageId)).actors).toEqual(['user', 'agent:ag-1']);
    // Search finds it at once.
    expect((await s.rpc('notebook.search', { query: 'train' })).hits.map((x: any) => x.pageId)).toContain(r.pageId);
  });

  it('append: open editors see it at once, a pre_agent version of the page as it was comes first', async () => {
    const { pageId } = await pageWith(s, doc(h1('Notes'), p('first thought')));
    const provider = client().open(pageId);
    await synced(provider);
    const r = await edit(s, { op: 'append', pageId, markdown: '## Later\n\nSecond **thought**.' });
    expect(r).toMatchObject({ pageId, title: 'Notes', op: 'append' });
    await until('the editor to see it', () => textOf(provider.document).includes('Second thought.'));
    // Text nodes come apart at the bold: Second |thought|.
    expect(await deskText(s, pageId)).toBe('Notes|first thought|Later|Second |thought|.');
    const versions: any[] = (await s.rpc('notebook.version.list', { pageId })).versions;
    const pre = versions.find((v) => v.reason === 'pre_agent');
    expect(pre).toMatchObject({ id: r.versionId, actor: 'user' });
    const got: any = await s.rpc('notebook.version.get', { versionId: r.versionId });
    expect(got.part).toContain('first thought');
    expect(got.part).not.toContain('Second');
    // The editor's own typing goes on as before, after it.
    typeInto(provider.document, ' and mine');
    await until('ack', () => !provider.hasUnsyncedChanges);
    await until('the store', async () => (await deskText(s, pageId)).endsWith('and mine'));
    expect((await activityOf(s, pageId)).actors).toEqual(['user', 'agent:ag-1']);
    // Undo is the member's: restoring the pre_agent version takes the page back.
    expect(await s.rpc('notebook.version.restore', { pageId, versionId: r.versionId })).toEqual({});
    await until('the restore', async () => (await deskText(s, pageId)) === 'Notes|first thought');
  });

  it('replace_text: one place, in place, keeping its formatting; missing and ambiguous are refused', async () => {
    const { pageId } = await pageWith(
      s,
      doc(h1('Plan'), { type: 'paragraph', content: [{ type: 'text', text: 'Meet on ' }, { type: 'text', text: 'Monday', marks: [{ type: 'bold' }] }, { type: 'text', text: ' at noon.' }] }, p('noon is lunch; noon again')),
    );
    await edit(s, { op: 'replace_text', pageId, find: 'Monday', markdown: 'Tuesday' });
    let body = await deskDoc(s, pageId);
    // The page's JSON as y-tiptap writes it, a mark's attributes always there.
    expect(body.content?.[1]?.content).toEqual([{ type: 'text', text: 'Meet on ' }, { type: 'text', text: 'Tuesday', marks: [{ type: 'bold', attrs: {} }] }, { type: 'text', text: ' at noon.' }]);
    // Markdown in the replacement adds its own marks to what's there.
    await edit(s, { op: 'replace_text', pageId, find: 'at noon.', markdown: 'at _one_.' });
    body = await deskDoc(s, pageId);
    expect(body.content?.[1]?.content).toEqual([
      { type: 'text', text: 'Meet on ' },
      { type: 'text', text: 'Tuesday', marks: [{ type: 'bold', attrs: {} }] },
      { type: 'text', text: ' at ' },
      { type: 'text', text: 'one', marks: [{ type: 'italic', attrs: {} }] },
      { type: 'text', text: '.' },
    ]);
    await fails(edit(s, { op: 'replace_text', pageId, find: 'Wednesday', markdown: 'x' }), 'conflict', 'not_found');
    await fails(edit(s, { op: 'replace_text', pageId, find: 'noon', markdown: 'x' }), 'conflict', 'ambiguous');
    // A find written as Markdown, as the agent read it, finds the text.
    await edit(s, { op: 'replace_text', pageId, find: '**Tuesday**', markdown: 'Friday' });
    expect(await deskText(s, pageId)).toBe('Plan|Meet on |Friday| at |one|.|noon is lunch; noon again');
    // Empty Markdown deletes it.
    await edit(s, { op: 'replace_text', pageId, find: '; noon again', markdown: '' });
    expect(await deskText(s, pageId)).toBe('Plan|Meet on |Friday| at |one|.|noon is lunch');
    // None of the refused ones left a version.
    const versions: any[] = (await s.rpc('notebook.version.list', { pageId })).versions;
    expect(versions.filter((v) => v.reason === 'pre_agent')).toHaveLength(4);
  });

  it('replace_text with blocks takes the place of a whole block, and only a whole one', async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan'), p('TODO list here'), p('after')));
    await fails(edit(s, { op: 'replace_text', pageId, find: 'list', markdown: '- a\n- b' }), 'bad_request', 'whole_block');
    await edit(s, { op: 'replace_text', pageId, find: 'TODO list here', markdown: '- [ ] a\n- [x] b' });
    const body = await deskDoc(s, pageId);
    expect(body.content?.map((b) => b.type)).toEqual(['heading', 'taskList', 'paragraph']);
    expect((await s.rpc('notebook.page.markdown', { pageId })).markdown).toBe('# Plan\n\n- [ ] a\n- [x] b\n\nafter\n');
  });

  it('dryRun changes nothing and says what the edit would meet', async () => {
    const { tabId, pageId } = await pageWith(s, doc(h1('Plan'), p('one two')));
    expect(await edit(s, { op: 'append', pageId, markdown: 'more', dryRun: true })).toEqual({ pageId, title: 'Plan', op: 'append', dryRun: true });
    expect(await edit(s, { op: 'create', new: { tabId, title: 'New' }, markdown: 'x', dryRun: true })).toEqual({ pageId: null, title: 'New', op: 'create', dryRun: true });
    await fails(edit(s, { op: 'replace_text', pageId, find: 'three', markdown: 'x', dryRun: true }), 'conflict', 'not_found');
    expect(await deskText(s, pageId)).toBe('Plan|one two');
    expect((await s.rpc('notebook.version.list', { pageId })).versions.filter((v: any) => v.reason === 'pre_agent')).toEqual([]);
    expect((await s.rpc('notebook.tree')).pages).toHaveLength(1);
  });

  it("the agent's name is plain text, cut, with hidden and bidi characters gone", async () => {
    const { pageId } = await pageWith(s, doc(h1('Plan')));
    await edit(s, { op: 'append', pageId, markdown: 'x', agentName: 'Re‮Search​\nbot' });
    expect((await activityOf(s, pageId)).actors).toContain('agent:ReSearch bot');
    await edit(s, { op: 'append', pageId, markdown: 'y', agentName: 'n'.repeat(200) });
    expect((await activityOf(s, pageId)).actors).toContain(`agent:${'n'.repeat(AGENT_NAME_MAX)}`);
    await fails(edit(s, { op: 'append', pageId, markdown: 'z', agentName: '​‮ ' }), 'bad_request', 'agentName');
  });

  it('refuses what it is not: a trashed page, too much Markdown, a malformed call', async () => {
    const { tabId, pageId } = await pageWith(s, doc(h1('Plan')));
    await fails(edit(s, { op: 'append', pageId, markdown: 'x'.repeat(MAX_MARKDOWN + 1) }), 'too_large', 'markdown');
    await fails(edit(s, { op: 'append', pageId, markdown: '  \n' }), 'bad_request', 'markdown');
    await fails(edit(s, { op: 'move', pageId, markdown: 'x' }), 'bad_request', 'op');
    await fails(edit(s, { op: 'append', pageId, new: { tabId, title: 'x' }, markdown: 'x' }), 'bad_request', 'new');
    await fails(edit(s, { op: 'create', new: { tabId, title: '​' }, markdown: 'x' }), 'bad_request', 'title');
    await fails(edit(s, { op: 'create', new: { tabId: 'no-such-tab', title: 'T' }, markdown: 'x' }), 'not_found');
    await fails(edit(s, { op: 'append', pageId: 'no-such-page', markdown: 'x' }), 'not_found');
    await fails(edit(s, { op: 'append', pageId, markdown: 'x', find: 'y' }), 'bad_request', 'find');
    expect(await s.rpc('notebook.page.trash', { pageId })).toEqual({});
    await fails(edit(s, { op: 'append', pageId, markdown: 'x' }), 'conflict', 'trashed');
    // The owner still reads a page in the Trash, as page.content does, and is told it's there.
    expect(await s.rpc('notebook.page.markdown', { pageId })).toMatchObject({ trashed: true, title: 'Plan' });
  });
});

describe('page_full with a low ceiling', () => {
  beforeEach(async () => {
    await h.clean();
    h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100, pageFullBytes: 20_000 });
    s = h.session();
  });

  it('an edit past it is refused before anything is written', async () => {
    const { tabId, pageId } = await pageWith(s, doc(h1('Plan'), p('kept')));
    const big = Array.from({ length: 1000 }, (_, i) => `Paragraph ${i} with some words in it.`).join('\n\n');
    await fails(edit(s, { op: 'append', pageId, markdown: big }), 'bad_request', 'page_full');
    await fails(edit(s, { op: 'create', new: { tabId, title: 'Big' }, markdown: big }), 'bad_request', 'page_full');
    expect(await deskText(s, pageId)).toBe('Plan|kept');
    expect((await s.rpc('notebook.version.list', { pageId })).versions.filter((v: any) => v.reason === 'pre_agent')).toEqual([]);
  });
});

describe('on a guild desk, as the member the agent works for', () => {
  /** Ana's page with a paragraph of hers. */
  async function anasPage(text: string): Promise<{ tabId: string; pageId: string }> {
    return pageWith(as(ANA), doc(h1('Shared'), p(text)), ANA);
  }

  it("what the agent writes is the member's: their page, their client id, their name in activity", async () => {
    const cal = as(CAL);
    const { tabId } = await anasPage('Ana wrote this.');
    const made = await edit(cal, { op: 'create', new: { tabId, title: 'Cal notes' }, markdown: 'hello', agentName: 'gm-cal5' });
    expect(h.service.notebook.page(made.pageId)).toMatchObject({ created_by: 'gm-cal5' });
    const clientsOf = (pageId: string): string[] => h.service.db.all<{ member_id: string }>('SELECT member_id FROM page_clients WHERE page_id = ?', pageId).map((r) => r.member_id);
    expect(clientsOf(made.pageId)).toEqual(['gm-cal5']);
    const row = await activityOf(cal, made.pageId);
    expect(row.actors).toEqual(['gm-cal5', 'agent:gm-cal5']);
    expect(row.actorNames[0]).toBe('Cal');
    // An append to a page of Ana's is Cal's text, kept as Cal's.
    const { pageId } = await anasPage('Ana again.');
    await edit(cal, { op: 'append', pageId, markdown: 'Cal adds.' });
    expect(clientsOf(pageId).sort()).toEqual(['gm-ana1', 'gm-cal5']);
    expect(h.service.notebook.page(pageId)).toMatchObject({ updated_by: 'gm-cal5' });
    const versions: any[] = (await cal.rpc('notebook.version.list', { pageId })).versions;
    expect(versions.find((v) => v.reason === 'pre_agent')).toMatchObject({ actor: 'gm-cal5', actorName: 'Cal' });
  });

  it("removing another member's text is charged to the member's edit budget, and past it is refused", async () => {
    const cal = as(CAL);
    const { pageId } = await anasPage('Ana wrote a sentence here.');
    // A word of hers: charged as a typo fix would be.
    await edit(cal, { op: 'replace_text', pageId, find: 'sentence', markdown: 'line' });
    expect(h.service.removals.used(pageId, 'gm-cal5')).toBeGreaterThan(0);
    expect(h.service.removals.used(pageId, 'gm-cal5')).toBeLessThanOrEqual('sentence'.length);
    // All of a long paragraph of hers: past the 500 in 10 minutes.
    const { pageId: second } = await anasPage('A'.repeat(600) + ' end.');
    await edit(cal, { op: 'replace_text', pageId: second, find: 'end.', markdown: 'fin.' });
    await fails(edit(cal, { op: 'replace_text', pageId: second, find: 'A'.repeat(600), markdown: 'short' }), 'forbidden', 'budget');
    await fails(edit(cal, { op: 'replace_text', pageId: second, find: 'A'.repeat(600), markdown: 'short', dryRun: true }), 'forbidden', 'budget');
    expect(await deskText(cal, second)).toBe(`Shared|${'A'.repeat(600)} fin.`);
    expect((await cal.rpc('notebook.version.list', { pageId: second })).versions.filter((v: any) => v.reason === 'pre_agent')).toHaveLength(1);
    // A moderator has no budget.
    expect(await edit(as(MO), { op: 'replace_text', pageId: second, find: 'A'.repeat(600), markdown: 'short' })).toMatchObject({ pageId: second });
    expect(await deskText(cal, second)).toBe('Shared|short fin.');
    // Text the member wrote themselves costs nothing.
    const before = h.service.removals.used(second, 'gm-cal5');
    await edit(cal, { op: 'append', pageId: second, markdown: 'Cal wrote this whole line.' });
    await edit(cal, { op: 'replace_text', pageId: second, find: 'Cal wrote this whole line.', markdown: 'Cal, shorter.' });
    expect(h.service.removals.used(second, 'gm-cal5')).toBe(before);
  });

  it("the budget is the connection's setting, as for the member's own edits", async () => {
    const { pageId } = await anasPage('Ana wrote this.');
    const strict = as(CAL, { editBudget: { chars: 0, windowMinutes: 10 } });
    await fails(edit(strict, { op: 'replace_text', pageId, find: 'this', markdown: 'that' }), 'forbidden', 'budget');
    // Adding is never a removal.
    expect(await edit(strict, { op: 'append', pageId, markdown: 'An addition.' })).toMatchObject({ pageId });
  });

  it("a member's own edits in the editor are judged as before", async () => {
    const { pageId } = await anasPage('Ana wrote this.');
    const cal = as(CAL);
    await edit(cal, { op: 'append', pageId, markdown: 'From the agent.' });
    const provider = client(CAL).open(pageId);
    await synced(provider);
    await until('the text', () => textOf(provider.document).includes('From the agent.'));
    const seen: string[] = [];
    provider.on('close', ({ event }: { event: { reason: string } }) => seen.push(event.reason));
    // Deleting Ana's paragraph whole is a block of hers: BLOCK_MIN, within the budget.
    provider.document.transact(() => provider.document.getXmlFragment(DOC_FIELD).delete(1, 1));
    await until('ack', () => !provider.hasUnsyncedChanges);
    expect(seen).toEqual([]);
    expect(h.service.removals.used(pageId, 'gm-cal5')).toBe(BLOCK_MIN);
  });

  it('authz-5: a trashed page is read only by a moderator, edited by no agent, and trash holds against a plain member', async () => {
    const ana = as(ANA);
    const cal = as(CAL);
    const mo = as(MO);
    const { pageId } = await anasPage('Ana wrote this.');
    // A plain member may not trash another member's page, through the agent or not.
    await fails(cal.rpc('notebook.page.trash', { pageId }), 'forbidden', 'grant');
    expect(await mo.rpc('notebook.page.trash', { pageId })).toEqual({});
    await fails(cal.rpc('notebook.page.markdown', { pageId }), 'forbidden', 'grant');
    expect(await mo.rpc('notebook.page.markdown', { pageId })).toMatchObject({ trashed: true });
    await fails(edit(cal, { op: 'append', pageId, markdown: 'x' }), 'conflict', 'trashed');
    await fails(edit(mo, { op: 'append', pageId, markdown: 'x' }), 'conflict', 'trashed');
    await fails(ana.rpc('notebook.page.restore', { pageId }), 'forbidden', 'grant');
    // A member's own page they trashed is theirs to bring back.
    const own = await edit(cal, { op: 'create', new: { tabId: (await makeNotebook(ana)).tabId, title: 'Mine' }, markdown: 'mine' });
    expect(await cal.rpc('notebook.page.trash', { pageId: own.pageId })).toEqual({});
    expect(await cal.rpc('notebook.page.restore', { pageId: own.pageId })).toEqual({});
  });

  it("an agent edit through the direct connection reaches every member's open editor", async () => {
    const { pageId } = await anasPage('Ana wrote this.');
    const pa = client(ANA).open(pageId, new Y.Doc());
    await synced(pa);
    await edit(as(CAL), { op: 'append', pageId, markdown: '- [ ] Cal will check' });
    await until('Ana sees it', () => textOf(pa.document).includes('Cal will check'));
    await sleep(50);
    expect(await deskText(as(ANA), pageId)).toBe('Shared|Ana wrote this.|Cal will check');
  });
});
