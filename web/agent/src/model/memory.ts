// What an agent remembers, as the Memory tab says it (the Product Designer's spec, section 3), over desk-agent's real
// `agent.memory.*` (S-14, `71ea7739`): lines of at most `limits.chars`, at most `limits.items` an agent, newest first. Pure. A
// line's text is the member's data: it renders as text, and nothing here keeps it anywhere.
import type { Agent, MemoryLine, MemorySource } from '../client/types';

/** "Nov 11". */
export function dayText(at: number): string {
  const d = new Date(at);
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

/**
 * Where a line came from, and when (spec 3.2). Today's desk sends no `source`: a line it marked untrusted was saved only after
 * the member approved it (a save in an untrusted run asks), and any other line simply says when it was saved.
 */
export function sourceText(line: Pick<MemoryLine, 'createdAt' | 'untrusted' | 'source' | 'updatedAt'>, agents: readonly Pick<Agent, 'id' | 'name'>[]): string {
  const s: MemorySource | undefined = line.source;
  const day = dayText(s?.kind === 'edited' && line.updatedAt ? line.updatedAt : line.createdAt);
  if (!s) return `${line.untrusted ? 'Saved after you approved' : 'Saved'} · ${day}`;
  switch (s.kind) {
    case 'chat':
      return `From your chat · ${day}`;
    case 'member':
      return `You added it · ${day}`;
    case 'edited':
      return `You changed it · ${day}`;
    case 'timer':
      return `From the timer ${s.timerLabel || 'unnamed'} · ${day}`;
    case 'agent':
      return `From a message from ${agents.find((a) => a.id === s.fromAgentId)?.name ?? 'another agent'} · ${day}`;
    case 'approval':
      return `Saved after you approved · ${day}`;
    default:
      return `Saved · ${day}`;
  }
}

/** A line's text in runs, the ones that match `query` marked: case-insensitive, every occurrence. */
export function marked(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + q.length), hit: true });
    at = i + q.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The lines that match a search, in their order. */
export function matching<T extends Pick<MemoryLine, 'text'>>(lines: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : [...lines];
}

const memories = (n: number): string => `${n} ${n === 1 ? 'memory' : 'memories'}`;

/** The bar's words: "12 memories · up to 50", or full. */
export function barText(count: number, max: number, agentName: string): string {
  if (max > 0 && count >= max) return `${memories(count)} · full. ${agentName} saves no more until you delete some.`;
  return `${memories(count)} · up to ${max}`;
}

export const searchPlaceholder = (count: number): string => `Search ${memories(count)}`;

export const forgetQuestion = (count: number, agentName: string): string => `Forget all ${count} ${count === 1 ? 'thing' : 'things'} ${agentName} remembers?`;

/** What makes the delete honest: the desk's daily snapshots, each kept 7 days (as /privacy says). */
export const forgetBody = (agentName: string): string =>
  `${agentName} won’t recall any of them again. This can’t be undone. Your desk’s daily snapshots still hold them until each one expires, within 7 days.`;

export const MEMORY_WORDS = {
  intro: (name: string): string => `Short notes ${name} keeps between chats, on this desk only. It saves them as you talk, and asks first when a task has read a web page.`,
  empty: (name: string): string => `${name} doesn’t remember anything yet. Tell it “remember …” in the chat, or it saves what helps as you talk.`,
  none: (name: string, query: string): string => `Nothing ${name} remembers matches “${query}”.`,
  foot: (name: string): string => `Files ${name} writes are in its workspace, under Settings. Your data download includes these memories.`,
  forgotAll: (name: string): string => `${name} forgot everything it remembered.`,
  deleted: (name: string): string => `Deleted. ${name} won’t recall it again.`,
  deleteFailed: 'That one couldn’t be deleted just now. Try again.',
  switchLabel: 'Remembers between chats',
  switchHint: (name: string): string => `Off: ${name} saves none and uses none. What’s here stays until you delete it.`,
  offNone: (name: string): string => `Off. ${name} isn’t saving or using memories.`,
} as const;
