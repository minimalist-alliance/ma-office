// A thread as the desk streams it (design 9.1: the desk is the source of truth). Pure, so a repeat, a snapshot
// that overlaps patches, or a jump in seq all land the same way. Only the message an event touches gets a new
// object, so a streaming reply re-renders one row, not the thread.
import type { Approval, ConversationEvent, Message } from '../client/types';

export interface Thread {
  messages: Message[];
  /** The approvals of these messages (API.md section 18), oldest first. Each sits under the reply its `messageId` names. */
  approvals: Approval[];
  seq: number;
}

export const EMPTY_THREAD: Thread = { messages: [], approvals: [], seq: 0 };

function upsertApproval(list: Approval[], a: Approval): Approval[] {
  const i = list.findIndex((x) => x.id === a.id);
  if (i < 0) return [...list, a].sort((x, y) => x.createdAt - y.createdAt);
  const next = list.slice();
  // An event left out a payload over 32 KiB: keep the one a fetch brought, if it's the same call.
  const was = list[i] as Approval;
  next[i] = a.payloadOmitted && was.payload && was.sha256 === a.sha256 ? { ...a, payload: was.payload, payloadOmitted: false } : a;
  return next;
}

function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = m;
    return next;
  }
  // New messages come in order nearly always; place by time otherwise.
  if (!list.length || (list[list.length - 1] as Message).at <= m.at) return [...list, m];
  const at = list.findIndex((x) => x.at > m.at);
  return [...list.slice(0, at), m, ...list.slice(at)];
}

export function applyEvent(t: Thread, e: ConversationEvent): Thread {
  if (e.type === 'snapshot') return { messages: e.messages.slice().sort((a, b) => a.at - b.at), approvals: (e.approvals ?? []).slice().sort((a, b) => a.createdAt - b.createdAt), seq: e.seq };
  if (e.seq <= t.seq) return t; // already applied
  if (e.type === 'message') return { ...t, messages: upsert(t.messages, e.message), seq: e.seq };
  if (e.type === 'approval') return { ...t, approvals: upsertApproval(t.approvals, e.approval), seq: e.seq };
  const i = t.messages.findIndex((x) => x.id === e.messageId);
  const m = i >= 0 ? t.messages[i] : undefined;
  // A delta for a reply that's finished (a late repeat) or unknown (its message event is still to come) is dropped:
  // the finished message carries the whole text.
  if (!m || m.state !== 'streaming') return { ...t, seq: e.seq };
  const next = t.messages.slice();
  next[i] = { ...m, text: m.text + e.text };
  return { ...t, messages: next, seq: e.seq };
}

export function applyEvents(t: Thread, events: ConversationEvent[]): Thread {
  return events.reduce(applyEvent, t);
}

/** The reply whose run is still going, streaming or waiting on the member's answers (API.md section 18), if any. */
export function streaming(t: Pick<Thread, 'messages'>): Message | null {
  for (let i = t.messages.length - 1; i >= 0; i -= 1) {
    const m = t.messages[i] as Message;
    if (m.state === 'streaming' || m.state === 'awaiting_approval') return m;
  }
  return null;
}
