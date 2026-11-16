// An agent's edit made with no card, under the member's "without asking" switch for the Notebook (draft ADR "the Agent's
// tools and approvals" §15 and §17's Auto-approve row; src/agent.ts's `tab`): deskd sends its own record of the switch's
// tab, and desk-notebook holds the edit to it where it writes: a new page only in exactly that tab, an append only to a
// page in it as the edit is made, inside the page's queue, so a page moved out since deskd looked is outside. A renamed
// tab is the same tab; a new tab with the same title isn't. Then the undo that names its agent, and the dry run's tab.
// Fake text only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeskdSession, type RpcError } from './helpers/deskd.ts';
import { harness, makeNotebook, type Harness } from './helpers/service.ts';

let h: Harness;
let s: DeskdSession;

const edit = (params: Record<string, unknown>): Promise<any> => s.rpc('notebook.page.agentEdit', { agentName: 'ag-1', ...params });
const undo = (params: Record<string, unknown>): Promise<any> => s.rpc('notebook.page.agentUndo', params);
const md = async (pageId: string): Promise<string> => (await s.rpc('notebook.page.markdown', { pageId })).markdown as string;

async function fails(promise: Promise<unknown>, code: string, reason?: string): Promise<RpcError> {
  const e = (await promise.then(
    () => null,
    (err: RpcError) => err,
  )) as RpcError | null;
  expect(e?.code).toBe(code);
  if (reason) expect((e?.details as { reason?: string } | undefined)?.reason).toBe(reason);
  return e as RpcError;
}

beforeEach(async () => {
  h = await harness({ storeDebounceMs: 20, storeMaxWaitMs: 100 });
  s = h.session();
});
afterEach(async () => {
  await h.clean();
});

describe("an edit with no card stays in the switch's tab", () => {
  it('creates a page only in exactly that tab', async () => {
    const { notebookId, tabId } = await makeNotebook(s);
    const other = (await s.rpc('notebook.tab.create', { notebookId, title: 'Elsewhere' })).tab.id as string;
    const made = await edit({ new: { tabId, title: 'Notes' }, op: 'create', markdown: 'hello', key: 'auto:ap-aaaaaaaaaaaaaaaaaaaa', tab: tabId });
    expect(made.pageId).toBeTruthy();
    await fails(edit({ new: { tabId: other, title: 'Notes' }, op: 'create', markdown: 'x', key: 'auto:ap-bbbbbbbbbbbbbbbbbbbb', tab: tabId }), 'forbidden', 'place');
    // Nothing was made in the other tab: only the page a new tab comes with.
    const outline = await s.rpc('notebook.outline', { tabId: other });
    expect(outline.pages.map((pg: { title: string }) => pg.title)).not.toContain('Notes');
  });

  it('appends only to a page in that tab, judged as it writes: a page moved out since is outside', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(s);
    const other = (await s.rpc('notebook.tab.create', { notebookId, title: 'Elsewhere' })).tab.id as string;
    // The dry run (the card's look) says the page's tab, for desk-agent's first check.
    const dry = await edit({ pageId, op: 'append', markdown: 'x', dryRun: true });
    expect(dry.tabId).toBe(tabId);
    await edit({ pageId, op: 'append', markdown: 'in the tab', key: 'auto:ap-cccccccccccccccccccc', tab: tabId });
    expect(await md(pageId)).toContain('in the tab');
    await s.rpc('notebook.page.move', { pageId, tabId: other });
    await fails(edit({ pageId, op: 'append', markdown: 'moved out', key: 'auto:ap-dddddddddddddddddddd', tab: tabId }), 'forbidden', 'place');
    expect(await md(pageId)).not.toContain('moved out');
    // Its key wasn't used up: nothing was kept for it.
    await fails(undo({ key: 'auto:ap-dddddddddddddddddddd' }), 'not_found');
  });

  it('a renamed tab is the same tab, and a new tab with the same title is not', async () => {
    const { notebookId, tabId, pageId } = await makeNotebook(s);
    await s.rpc('notebook.tab.rename', { id: tabId, title: 'Research' });
    await edit({ pageId, op: 'append', markdown: 'after the rename', key: 'auto:ap-eeeeeeeeeeeeeeeeeeee', tab: tabId });
    expect(await md(pageId)).toContain('after the rename');
    const twin = await s.rpc('notebook.tab.create', { notebookId, title: 'Research' });
    const inTwin = twin.page.id as string;
    await fails(edit({ pageId: inTwin, op: 'append', markdown: 'twin', key: 'auto:ap-ffffffffffffffffffff', tab: tabId }), 'forbidden', 'place');
  });

  it('never replaces text, and never edits a page in the Trash', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    await fails(edit({ pageId, op: 'replace_text', find: 'x', markdown: 'y', key: 'auto:ap-gggggggggggggggggggg', tab: tabId }), 'bad_request');
    await s.rpc('notebook.page.trash', { pageId });
    await fails(edit({ pageId, op: 'append', markdown: 'z', key: 'auto:ap-hhhhhhhhhhhhhhhhhhhh', tab: tabId }), 'conflict', 'trashed');
  });

  it('a key seen before answers the first edit with repeated, and writes nothing (deskd refuses it approval_used)', async () => {
    const { tabId, pageId } = await makeNotebook(s);
    await edit({ pageId, op: 'append', markdown: 'once', key: 'auto:ap-iiiiiiiiiiiiiiiiiiii', tab: tabId });
    const again = await edit({ pageId, op: 'append', markdown: 'twice', key: 'auto:ap-iiiiiiiiiiiiiiiiiiii', tab: tabId });
    expect(again.repeated).toBe(true);
    expect(await md(pageId)).not.toContain('twice');
  });
});

describe('the undo deskd sends names its agent', () => {
  it("takes back the agent's own edit, and calls another agent's no such edit", async () => {
    const { tabId, pageId } = await makeNotebook(s);
    await edit({ pageId, op: 'append', markdown: 'agent text', key: 'auto:ap-jjjjjjjjjjjjjjjjjjjj', tab: tabId });
    await fails(undo({ key: 'auto:ap-jjjjjjjjjjjjjjjjjjjj', agent: 'ag-2' }), 'not_found');
    expect(await md(pageId)).toContain('agent text');
    const done = await undo({ key: 'auto:ap-jjjjjjjjjjjjjjjjjjjj', agent: 'ag-1' });
    expect(done.undone).toBe(true);
    expect(await md(pageId)).not.toContain('agent text');
    await fails(undo({ key: 'auto:ap-jjjjjjjjjjjjjjjjjjjj', agent: 'ag-1' }), 'conflict', 'undone');
    await fails(undo({ key: 'auto:ap-jjjjjjjjjjjjjjjjjjjj', agent: '' }), 'bad_request');
  });

  it('a page made with no card goes to the Trash on undo while it is as made', async () => {
    const { tabId } = await makeNotebook(s);
    const made = await edit({ new: { tabId, title: 'Draft' }, op: 'create', markdown: 'body', key: 'auto:ap-kkkkkkkkkkkkkkkkkkkk', tab: tabId });
    await undo({ key: 'auto:ap-kkkkkkkkkkkkkkkkkkkk', agent: 'ag-1' });
    const r = await s.rpc('notebook.page.markdown', { pageId: made.pageId });
    expect(r.trashed).toBe(true);
  });
});
