// The mock's calls done without asking behave as API.md section 18 says ("Done without asking"), so the demo and the shell specs
// see what a desk sends: approval rows with `decidedBy: "auto"` and their events, chips and the reply's `auto`, an undo that
// takes back once and refuses `changed` (with the page from before), `undone` and `not_done`, and "keep notes" asking on a card
// until the member switches it on, and then going without asking.
import { describe, expect, it } from 'vitest';
import { newIdem } from '../client/agentClient';
import type { Approval, ConversationEvent } from '../client/types';
import { foldAsks, toolRow } from '../ui/Activity';
import { MockAgentClient, type UnaskedSpec } from './mockAgentClient';

const m = () => ({ idem: newIdem() });
const tools = () => new MockAgentClient({ fixture: 'tools', latencyMs: 0, streamMs: 0 });

const FILE: UnaskedSpec = { tool: 'files_write', payload: { path: 'Research/notes.md', text: 'x', replace: false }, target: { kind: 'file', path: 'Research/notes.md' }, group: 'files', place: { folder: 'Research' } };
const NOTE: UnaskedSpec = { tool: 'notebook_write', payload: { op: 'append', pageId: 'p1', markdown: 'x' }, target: { kind: 'page', pageId: 'p1', title: 'Lamps', tabId: 'tab-1' }, group: 'notebook', place: { tabId: 'tab-1' } };

describe('mock: done without asking (API.md section 18)', () => {
  it('a run’s unasked calls are approval rows, chips and the reply’s auto, never pending', async () => {
    const c = tools();
    const events: ConversationEvent[] = [];
    c.watchConversation('writer', (e) => events.push(e));
    const { messageId, approvalIds } = await c.unasked('writer', [NOTE, FILE, { ...FILE, fails: 'exists' }]);
    await new Promise((r) => setTimeout(r, 5));
    const thread = await c.getThread('writer');
    const reply = thread.messages.find((x) => x.id === messageId)!;
    expect(reply.auto?.map((r) => [r.tool, r.group, r.state])).toEqual([
      ['notebook_write', 'notebook', 'done'],
      ['files_write', 'files', 'done'],
      ['files_write', 'files', 'failed'],
    ]);
    expect(reply.tools?.map((t) => [t.auto, t.approval?.decision, t.ok])).toEqual([
      ['notebook', 'auto', true],
      ['files', 'auto', true],
      ['files', 'auto', false],
    ]);
    const rows = thread.approvals!.filter((a) => approvalIds.includes(a.id));
    expect(rows.every((a) => a.decidedBy === 'auto' && a.state !== 'pending' && a.undoneAt === null)).toBe(true);
    expect(rows[1]).toMatchObject({ auto: { group: 'files', folder: 'Research' }, result: { ok: true } });
    expect(rows[2]).toMatchObject({ state: 'failed', result: { ok: false, error: 'exists' } });
    expect(events.filter((e) => e.type === 'approval')).toHaveLength(3);
    // None waits on the member.
    expect((await c.listApprovals({ agentId: 'writer' })).approvals).toEqual([]);
    expect((await c.listAgents()).find((a) => a.id === 'writer')?.approvalsPending ?? 0).toBe(0);
  });

  it('undo takes it back once, the same key answers the same, and a second undo is refused undone', async () => {
    const c = tools();
    const { approvalIds } = await c.unasked('writer', [FILE]);
    const id = approvalIds[0]!;
    const events: ConversationEvent[] = [];
    c.watchConversation('writer', (e) => events.push(e));
    const key = m();
    const undone = await c.undoApproval(id, key);
    expect(undone).toMatchObject({ id, undoneBy: 'owner' });
    expect(undone.undoneAt).toBeGreaterThan(0);
    expect((await c.undoApproval(id, key)).undoneAt).toBe(undone.undoneAt);
    await expect(c.undoApproval(id, m())).rejects.toMatchObject({ code: 'conflict', reason: 'undone' });
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.type === 'approval' && e.approval.id === id && e.approval.undoneAt)).toBe(true);
    // The reply's row has it on the next read.
    const reply = (await c.getThread('writer')).messages.find((x) => x.auto?.some((r) => r.approvalId === id));
    expect(reply?.auto?.[0]?.undoneAt).toBe(undone.undoneAt);
  });

  it('refuses changed (with the page from before for a Notebook edit), not_done, and an id that isn’t one', async () => {
    const c = tools();
    const { approvalIds } = await c.unasked('writer', [NOTE, FILE, { ...FILE, fails: 'exists' }]);
    c.changeUnasked(approvalIds[0]!, 'v-pre-agent');
    c.changeUnasked(approvalIds[1]!);
    await expect(c.undoApproval(approvalIds[0]!, m())).rejects.toMatchObject({ code: 'conflict', reason: 'changed', versionId: 'v-pre-agent' });
    await expect(c.undoApproval(approvalIds[1]!, m())).rejects.toMatchObject({ code: 'conflict', reason: 'changed', versionId: null });
    await expect(c.undoApproval(approvalIds[2]!, m())).rejects.toMatchObject({ code: 'conflict', reason: 'not_done' });
    await expect(c.undoApproval('ap-nope', m())).rejects.toMatchObject({ code: 'not_found', detail: 'approval' });
    // A member's own approval is never undone this way.
    const asked = (await c.listApprovals({ agentId: 'scout' })).approvals[0] as Approval;
    await expect(c.undoApproval(asked.id, m())).rejects.toMatchObject({ code: 'not_found' });
    // Nothing changed for any of them.
    expect((await c.getApproval(approvalIds[0]!)).undoneAt).toBeNull();
  });

  it('audits each unasked call once in Activity, and each undo in words, by ids only', async () => {
    const c = tools();
    const { approvalIds } = await c.unasked('writer', [FILE, FILE]);
    await c.undoApproval(approvalIds[0]!, m());
    c.changeUnasked(approvalIds[1]!);
    await c.undoApproval(approvalIds[1]!, m()).catch(() => undefined);
    const entries = (await c.listAudit({ limit: 50 })).entries;
    expect(entries.filter((e) => e.action === 'approval.auto')).toHaveLength(2);
    const shown = foldAsks(entries).filter((e) => e.target.includes('tool:files_write'));
    expect(shown.some((e) => e.action === 'approval.auto')).toBe(false);
    const rows = shown.map((e) => toolRow(e, [{ id: 'writer', name: 'Writer' }])!);
    expect(rows.map((r) => [r.what, r.letBy?.text ?? null])).toEqual([
      ['Couldn’t undo: saved a file', 'It had changed since, so it stays'],
      ['Undid: saved a file', null],
      ['Saved a file', 'Done without asking, under your setting'],
      ['Saved a file', 'Done without asking, under your setting'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('Research/notes.md');
  });

  it('a run the member didn’t start counts on the agent until its thread is seen', async () => {
    const c = tools();
    await c.unasked('writer', [FILE, NOTE, { ...FILE, fails: 'exists' }], { origin: { kind: 'timer', timerId: 't1', label: 'Evening notes' } });
    expect((await c.listAgents()).find((a) => a.id === 'writer')?.autoUnseen).toBe(2);
    const rows = (await c.getThread('writer')).approvals!.filter((a) => a.decidedBy === 'auto');
    expect(rows[0]?.origin).toEqual({ kind: 'timer', agentId: 'writer', timerId: 't1', label: 'Evening notes' });
    await c.markSeen('writer');
    expect((await c.listAgents()).find((a) => a.id === 'writer')?.autoUnseen).toBe(0);
  });

  it('“keep notes” asks on a card until the switch is on, then goes without asking', async () => {
    const c = tools();
    const lead = 'writer';
    await c.sendMessage(lead, 'Look at lamps and keep notes', m());
    let card: Approval | undefined;
    for (let i = 0; i < 100 && !card; i += 1) {
      card = (await c.listApprovals({ agentId: lead })).approvals[0];
      if (!card) await new Promise((r) => setTimeout(r, 5));
    }
    expect(card).toMatchObject({ tool: 'files_write', payload: { path: 'Research/lamp-notes.md', replace: false }, untrusted: false, state: 'pending' });
    // "Don't ask again": the switch first, by the member's own call, then the usual yes.
    await c.setAccess(lead, { auto: { files: { folder: 'Research' } } }, m());
    await c.decideApproval(card!.id, { approve: true, sha256: card!.sha256 }, m());
    await new Promise((r) => setTimeout(r, 800));
    await c.sendMessage(lead, 'Now keep notes on desks too', m());
    let rows: Approval[] = [];
    for (let i = 0; i < 100 && !rows.length; i += 1) {
      rows = (await c.getThread(lead)).approvals!.filter((a) => a.decidedBy === 'auto');
      if (!rows.length) await new Promise((r) => setTimeout(r, 5));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'files_write', state: 'done', auto: { group: 'files', folder: 'Research' } });
    const reply = (await c.getThread(lead)).messages.at(-1)!;
    expect(reply.auto?.[0]).toMatchObject({ approvalId: rows[0]!.id, state: 'done' });
    expect((await c.listApprovals({ agentId: lead })).approvals).toEqual([]);
  });
});
