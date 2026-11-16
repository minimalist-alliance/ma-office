import { describe, expect, it } from 'vitest';
import type { Approval, AuditEntry, Message, ToolChip } from '../client/types';
import { toolRow } from '../ui/Activity';
import { TAINT_NOTICE, planStepLabel, runSummaryOf, runSummaryParts, runSummaryText } from './runSummary';

const reply = (over: Partial<Message> = {}): Message => ({ id: 'm1', role: 'assistant', text: 'Done.', at: 1, state: 'done', ...over });
const chip = (over: Partial<ToolChip>): ToolChip => ({ name: 'files_write', summary: 'Saved a file in your Files', ok: true, risk: 'write', ...over });
const card = (over: Partial<Approval>): Approval =>
  ({
    id: 'ap-1',
    agentId: 'scout',
    runId: 'r1',
    messageId: 'm1',
    tool: 'files_write',
    risk: 'write',
    title: 'Save “a.md” in your Files',
    context: 'agent',
    target: { kind: 'file', path: 'a.md' },
    payload: { path: 'a.md', text: 'x', replace: false },
    before: null,
    sha256: '0'.repeat(64),
    untrusted: false,
    origin: { kind: 'member' },
    state: 'done',
    detail: null,
    createdAt: 1,
    expiresAt: 2,
    decidedAt: 1,
    decidedBy: 'owner',
    note: null,
    result: { ok: true },
    ...over,
  }) as Approval;

describe('a reply’s run summary (API.md section 18)', () => {
  it('counts every outcome from the desk’s own chips, never the reply’s text', () => {
    const s = runSummaryOf(
      reply({
        text: 'I approved 40 things and sent nothing.',
        egressCount: 2,
        tools: [
          chip({ name: 'files_read', risk: 'read' }),
          chip({ approval: { id: 'ap-1', decision: 'approved' } }),
          chip({ approval: { id: 'ap-2', decision: 'approved' }, ok: false }),
          chip({ approval: { id: 'ap-3', decision: 'declined' }, ok: false }),
          chip({ approval: { id: 'ap-4', decision: 'expired' }, ok: false }),
          chip({ approval: { id: 'ap-5', decision: 'interrupted' }, ok: false }),
          chip({ auto: 'files' }),
          chip({ name: 'files_list', risk: 'read', ok: false }),
        ],
      }),
    )!;
    // An interrupted call may have happened: "didn’t finish", never "not answered" or "didn’t work" (durable runs).
    expect(s).toEqual({ tools: 8, approved: 2, unasked: 1, declined: 1, unanswered: 1, failed: 2, unfinished: 1, egress: 2, untrusted: false, plan: null });
    expect(runSummaryParts(s)).toEqual(['8 tools', '2 approved by you', '1 done without asking', '1 declined', '1 not answered', '2 didn’t work', '1 didn’t finish', 'sent outside your desk 2 times']);
    expect(runSummaryText(s)).toBe('This task: 8 tools, 2 approved by you, 1 done without asking, 1 declined, 1 not answered, 2 didn’t work, 1 didn’t finish, sent outside your desk 2 times.');
  });

  it('counts a call a restart cut off as didn’t finish, approved or unasked, never as didn’t work', () => {
    const s = runSummaryOf(
      reply({
        tools: [
          chip({ approval: { id: 'ap-1', decision: 'approved' }, ok: false, interrupted: true }),
          chip({ auto: 'files', ok: false, interrupted: true }),
          chip({ name: 'workspace_write', risk: 'own', ok: false, interrupted: true }),
        ],
      }),
    )!;
    expect(s).toMatchObject({ approved: 1, unasked: 1, failed: 0, unanswered: 0, unfinished: 3 });
    expect(runSummaryParts(s)).toContain('3 didn’t finish');
  });

  it('says one in the singular and leaves out what didn’t happen', () => {
    const s = runSummaryOf(reply({ tools: [chip({ approval: { id: 'ap-1', decision: 'approved' } })], egressCount: 1 }))!;
    expect(runSummaryParts(s)).toEqual(['1 tool', '1 approved by you', 'sent outside your desk once']);
  });

  it('has nothing while the run streams or waits, nor for a reply that used no tool and kept no plan', () => {
    const tools = [chip({})];
    expect(runSummaryOf(reply({ state: 'streaming', tools }))).toBeNull();
    expect(runSummaryOf(reply({ state: 'awaiting_approval', tools }))).toBeNull();
    expect(runSummaryOf(reply({ tools: [] }))).toBeNull();
    expect(runSummaryOf(reply({}))).toBeNull();
    expect(runSummaryOf({ id: 'u', role: 'user', text: 'Hi', at: 1 })).toBeNull();
    // A stopped or failed run still says what it did; a reply with no state is a done one.
    expect(runSummaryOf(reply({ state: 'stopped', tools }))).not.toBeNull();
    expect(runSummaryOf(reply({ state: 'failed', tools }))).not.toBeNull();
    expect(runSummaryOf(reply({ state: undefined, tools }))).not.toBeNull();
  });

  it('counts a card the desk sent no chip for, and never a card twice', () => {
    const cards = [
      card({ id: 'ap-1', state: 'done' }),
      card({ id: 'ap-2', state: 'declined' }),
      card({ id: 'ap-3', state: 'expired' }),
      card({ id: 'ap-4', state: 'failed' }),
      card({ id: 'ap-5', messageId: 'other', state: 'declined' }),
    ];
    const s = runSummaryOf(reply({ tools: [chip({ approval: { id: 'ap-1', decision: 'approved' } })] }), cards)!;
    expect(s.approved).toBe(2);
    expect(s.declined).toBe(1);
    expect(s.unanswered).toBe(1);
    expect(s.failed).toBe(1);
  });

  it('carries the plan’s progress, a skipped step counting as dealt with', () => {
    const s = runSummaryOf(
      reply({
        plan: [
          { text: 'Read the note', state: 'done' },
          { text: 'Compare prices', state: 'skipped' },
          { text: 'Save the list', state: 'doing' },
          { text: 'Tell the member', state: 'todo' },
        ],
      }),
    )!;
    expect(s.plan).toEqual({ done: 2, total: 4 });
    expect(runSummaryParts(s)).toEqual(['plan 2 of 4 done']);
    expect(['done', 'doing', 'todo', 'skipped'].map((state) => planStepLabel({ text: '', state: state as 'done' }))).toEqual(['Done', 'Doing', 'To do', 'Skipped']);
  });

  it('marks an untrusted run, and the notice says what that means without alarm', () => {
    const s = runSummaryOf(reply({ untrusted: true, tools: [chip({ name: 'browser_read', risk: 'read', untrusted: true })] }))!;
    expect(s.untrusted).toBe(true);
    expect(TAINT_NOTICE).toMatch(/web pages, files or messages/);
    expect(TAINT_NOTICE).not.toMatch(/!/);
    // A negative egress count from a confused desk reads as none.
    expect(runSummaryOf(reply({ egressCount: -3, tools: [chip({})] }))!.egress).toBe(0);
  });
});

describe('Activity’s row for a call done without asking (draft ADR §15)', () => {
  const entry = (target: string, decision = 'ok'): AuditEntry => ({ seq: 1, atMs: 1, actor: 'agent:scout', action: 'tool.call', target, payloadSha256: null, decision, costMicroUsd: null, hash: '' });

  it('says it was done without asking, never “Approved by you”, from desk-agent’s `auto:` part', () => {
    const row = toolRow(entry('tool:files_write run:r1 auto:files'), [{ id: 'scout', name: 'Scout' }])!;
    expect(row.letBy).toEqual({ text: 'Done without asking, under your setting', by: 'rule' });
    const approved = toolRow(entry('tool:files_write run:r1 approval:ap-1'), [{ id: 'scout', name: 'Scout' }])!;
    expect(approved.letBy).toEqual({ text: 'Approved by you', by: 'member' });
  });
});
