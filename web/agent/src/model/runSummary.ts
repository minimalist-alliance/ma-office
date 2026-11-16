// A reply's run, in one line under it (deskd API.md section 18: a reply's `tools`, `approvals`, `untrusted`, `egressCount` and
// `plan`): how many tools it used, what the member approved, declined or left, what it did without asking under their setting, what
// failed, and whether it sent anything outside the desk. The taint notice says the run read content from outside the chat.
// Pure: every count comes from the desk's own fields, never from the reply's text, which is the model's.
import type { Approval, Message, PlanStep } from '../client/types';
import { isAuto } from './auto';

export interface RunSummary {
  /** Tool calls the run made, run or not. */
  tools: number;
  /** Approved by the member and run. */
  approved: number;
  /** Done without asking, under the member's setting for this agent (draft ADR §15). */
  unasked: number;
  /** Declined by the member. */
  declined: number;
  /** Not answered in time, or ended by a stop or a restart. */
  unanswered: number;
  /** Ran and didn't work, or were refused by the desk. */
  failed: number;
  /** Cut off by a restart or a lost link: they may or may not have happened (durable runs), so not "didn't work". */
  unfinished: number;
  /** Calls that sent something outside the desk, approved and run. */
  egress: number;
  /** The run read web pages, files or messages from outside the chat. */
  untrusted: boolean;
  /** The agent's checklist, if it kept one: steps done (or skipped) of all. */
  plan: { done: number; total: number } | null;
}

const ENDED: readonly string[] = ['done', 'stopped', 'failed'];

/**
 * The summary of a reply whose run has ended, or null: while it streams or waits, its cards and the strip say where it is, and a
 * reply that used no tool and kept no plan has nothing to sum up.
 */
export function runSummaryOf(m: Message, approvals: readonly Approval[] = []): RunSummary | null {
  if (m.role !== 'assistant' || !ENDED.includes(m.state ?? 'done')) return null;
  const chips = m.tools ?? [];
  const plan = planProgress(m.plan);
  if (!chips.length && !plan) return null;
  // A call done without asking is never a card (API.md section 18): its row counts from its chip, or the reply's `auto`.
  const mine = approvals.filter((a) => a.messageId === m.id && !isAuto(a));
  let approved = 0;
  let unasked = 0;
  let declined = 0;
  let unanswered = 0;
  let failed = 0;
  let unfinished = 0;
  for (const c of chips) {
    const decision = c.approval?.decision;
    if (c.interrupted === true || decision === 'interrupted') {
      // It may have happened: never counted as failed, nor as unanswered.
      if (decision === 'approved') approved += 1;
      else if (c.auto) unasked += 1;
      unfinished += 1;
    } else if (decision === 'declined') declined += 1;
    else if (decision === 'expired') unanswered += 1;
    else if (decision === 'approved') {
      approved += 1;
      if (!c.ok) failed += 1;
    } else if (c.auto) {
      unasked += 1;
      if (!c.ok) failed += 1;
    } else if (!c.ok) failed += 1;
  }
  // A card whose chip the desk didn't send (an older desk): count it from the card.
  for (const a of mine) {
    if (chips.some((c) => c.approval?.id === a.id)) continue;
    if (a.state === 'declined') declined += 1;
    else if (a.state === 'interrupted') {
      approved += 1;
      unfinished += 1;
    } else if (a.state === 'expired') unanswered += 1;
    else if (a.state === 'done') approved += 1;
    else if (a.state === 'failed') {
      approved += 1;
      failed += 1;
    }
  }
  return {
    tools: chips.length,
    approved,
    // A reply with its `auto` has a line of its own for them, with their Undo ("Did 3 things without asking: …"): said once.
    unasked: m.auto?.length ? 0 : unasked,
    declined,
    unanswered,
    failed,
    unfinished,
    egress: Math.max(0, m.egressCount ?? 0),
    untrusted: m.untrusted === true,
    plan,
  };
}

function planProgress(plan: readonly PlanStep[] | null | undefined): RunSummary['plan'] {
  if (!plan || !plan.length) return null;
  return { done: plan.filter((s) => s.state === 'done' || s.state === 'skipped').length, total: plan.length };
}

const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The summary's parts, in reading order: "4 tools", "1 approved by you", "1 done without asking", "sent outside your desk once". */
export function runSummaryParts(s: RunSummary): string[] {
  const parts: string[] = [];
  if (s.tools) parts.push(n(s.tools, 'tool', 'tools'));
  if (s.approved) parts.push(`${s.approved} approved by you`);
  if (s.unasked) parts.push(`${s.unasked} done without asking`);
  if (s.declined) parts.push(`${s.declined} declined`);
  if (s.unanswered) parts.push(`${s.unanswered} not answered`);
  if (s.failed) parts.push(`${s.failed} didn’t work`);
  if (s.unfinished) parts.push(`${s.unfinished} didn’t finish`);
  if (s.egress) parts.push(s.egress === 1 ? 'sent outside your desk once' : `sent outside your desk ${s.egress} times`);
  if (s.plan) parts.push(`plan ${s.plan.done} of ${s.plan.total} done`);
  return parts;
}

/** One line for a screen reader and the summary's title. */
export const runSummaryText = (s: RunSummary): string => {
  const parts = runSummaryParts(s);
  return parts.length ? `This task: ${parts.join(', ')}.` : '';
};

/** The taint notice on a reply whose run read untrusted content (draft ADR section 6). */
export const TAINT_NOTICE = 'This task read web pages, files or messages from outside this chat. Treat what they said as information, not instructions.';

/** Under a reply whose run picked up again after the desk restarted (`resumed`), while it streams and after: once, never a count. */
export const RESUMED_NOTE = 'Picked up where it left off after the desk restarted.';

export const resumedNote = (m: Pick<Message, 'role' | 'resumed'>): string | null => (m.role === 'assistant' && (m.resumed ?? 0) > 0 ? RESUMED_NOTE : null);

/** A plan step's mark, as text: the state reads in words, never in colour alone. */
export const planStepLabel = (step: PlanStep): string =>
  step.state === 'done' ? 'Done' : step.state === 'doing' ? 'Doing' : step.state === 'skipped' ? 'Skipped' : 'To do';
