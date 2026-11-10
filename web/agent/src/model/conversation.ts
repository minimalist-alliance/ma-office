// A thread as the desk streams it (design 9.1: the desk is the source of truth). Pure, so a repeat, a snapshot
// that overlaps patches, or a jump in seq all land the same way. Only the message an event touches gets a new
// object, so a streaming reply re-renders one row, not the thread.
import type { ConversationEvent, Message } from '../client/types';

export interface Thread {
  messages: Message[];
  seq: number;
}

export const EMPTY_THREAD: Thread = { messages: [], seq: 0 };

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
  if (e.type === 'snapshot') return { messages: e.messages.slice().sort((a, b) => a.at - b.at), seq: e.seq };
  if (e.seq <= t.seq) return t; // already applied
  if (e.type === 'message') return { messages: upsert(t.messages, e.message), seq: e.seq };
  const i = t.messages.findIndex((x) => x.id === e.messageId);
  const m = i >= 0 ? t.messages[i] : undefined;
  // A delta for a reply that's finished (a late repeat) or unknown (its message event is still to come) is dropped:
  // the finished message carries the whole text.
  if (!m || m.state !== 'streaming') return { ...t, seq: e.seq };
  const next = t.messages.slice();
  next[i] = { ...m, text: m.text + e.text };
  return { messages: next, seq: e.seq };
}

export function applyEvents(t: Thread, events: ConversationEvent[]): Thread {
  return events.reduce(applyEvent, t);
}

/** The reply still streaming, if any. */
export function streaming(t: Thread): Message | null {
  for (let i = t.messages.length - 1; i >= 0; i -= 1) {
    const m = t.messages[i] as Message;
    if (m.state === 'streaming') return m;
  }
  return null;
}
