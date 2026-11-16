// To-do's wire shapes (the `todo.*` member methods and the `todo` topic), as the office reads them: deskd's
// `services/deskd/docs/API.md` §22, the store's contract (`sub/mm-todo-store`). Types only: the mock desk
// (`desk/mockDeskTodo.ts`) answers with them and `client.ts` reads every reply through `wire.ts`, field by field, so a desk that
// sends less (an older deskd) or more (a newer one) never breaks the window.

/** Where a to-do came from. `member` is typed by the member; the rest are an agent's, from what it read in that run. */
export type SourceKind = 'member' | 'courier' | 'notebook' | 'browser' | 'files' | 'agent_chat' | 'desk';

/** `member`, or `agent:<id>`. Stamped by the desk, never the model's. */
export type Actor = string;

export type TodoState = 'open' | 'done' | 'not_needed';

/** Where an open item sits today, judged by deskd in the desk's zone (`group`). */
export type TodoGroup = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'snoozed';

export interface TodoDue {
  /** `YYYY-MM-DD`, in the desk's time zone. */
  date: string;
  /** `HH:MM`, or null for a day alone. */
  time: string | null;
  /** Whose date it is: a member's date is never moved by a merge. */
  by: Actor;
}

export interface TodoSource {
  kind: SourceKind;
  /** The record it points at, by kind: `courier {messageId, channelId}`, `notebook {pageId}`, `browser {url}`, `files {path}`, `agent_chat {agentId, threadId, messageId}`, `desk {deskId, messageId}` (a message from another of the member's desks, §18). */
  ref: Record<string, unknown> | null;
  /** Written by the desk from its own record ("Email from Dana Ortiz · Lease renewal"), at most 80 characters. Plain text. */
  label: string;
  /** `alsoFrom` only: when it was merged in. */
  at?: number;
}

export interface TodoSuggestion {
  as: 'done' | 'not_needed';
  by: Actor;
  /** At most 140 characters, the model's words: plain text, shown as untrusted. */
  reason: string;
  at: number;
  /** Its run had read untrusted content (email, the web, files, other agents): its reason is the model's words from that. */
  untrusted: boolean;
}

export interface TodoItem {
  id: string;
  /** The last of the desk-wide counter this item got. `todo.update` names it. */
  rev: number;
  title: string;
  note: string | null;
  due: TodoDue | null;
  state: TodoState;
  /** Once closed: when, and by whom. */
  closed: { at: number; by: Actor } | null;
  /** UTC ms. Member only. */
  snoozedUntil: number | null;
  /** "Keep in Needs you". Member only. */
  pinned: boolean;
  by: Actor;
  source: TodoSource;
  /** Later sources merged into this one, at most 5. */
  alsoFrom: TodoSource[];
  mergeCount: number;
  /** Made or last changed by a run that had read something untrusted (email, the web, files, other agents). */
  untrusted: boolean;
  suggestion: TodoSuggestion | null;
  /** The member's view has shown it (`todo.seen`): an unseen agent item is "new". */
  seen: boolean;
  /** On `open`, deskd's group for today; null on `done` and `trash`. */
  group: TodoGroup | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}

export type TodoOp = 'add' | 'edit' | 'close' | 'reopen' | 'snooze' | 'pin' | 'suggest' | 'answer' | 'merge' | 'trash' | 'restore' | 'undo' | 'seen' | 'remove';

/** One line of an item's History: the fields that changed, before and after. `todo.undo` puts `before` back. */
export interface TodoEvent {
  id: string;
  at: number;
  actor: Actor;
  op: TodoOp;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export type TodoView = 'needs_you' | 'open' | 'done' | 'trash';

export interface TodoListResult {
  items: TodoItem[];
  next: string | null;
  rev: number;
  /** `needs_you` only: how many qualify beyond the five shown. */
  more: number;
  /** `needs_you` only: unseen agent items not in the list, and open suggestions. */
  newFromAgents: number;
  toConfirm: number;
  /** The desk's today and time zone, so every date reads in the desk's own zone. */
  today: string;
  zone: string;
}

/** Counts for the tile and Maia's For you (`todo.summary`). `badge` is overdue plus due today. */
export interface TodoSummary {
  open: number;
  needsYou: number;
  overdue: number;
  dueToday: number;
  newFromAgents: number;
  toConfirm: number;
  badge: number;
  rev: number;
  today: string;
  zone: string;
}

/** `todo.changes {since}`: what changed after `since`, oldest first. `reset`: too old, read everything again. */
export interface TodoChanges {
  changes: { rev: number; id: string; op: string }[];
  rev: number;
  reset: boolean;
}

/** The `todo` topic: a `snapshot` of `{rev}`, then `changed` `{op, id, rev}`. Ids only, never a title. */
export interface TodoTopicMessage {
  seq: number;
  type?: string;
  op?: string;
  id?: string;
  rev?: number;
}
