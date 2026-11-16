// What the room reads and asks of Desk Maia on the member's home desk (CONCEPT.md §1: her thread is the home desk's, reached
// over that desk's data channel, never the platform). The room talks only to a `RoomSource`, so the mock (`mockSource.ts`,
// dev and the shell specs) and the desk (`deskSource.ts`, the runtime's `maia.*` methods) are the same to it. Everything a
// desk sends is read leniently and treated as plain text; urgency and kinds are code's (`model.ts`), never a model's words.
import { isAgentApp, isDeskApp, type AppId } from '../canvas/layout';

export type LinkState = 'connecting' | 'ready' | 'offline';

/** The apps the viewport may show: a closed enum (§2, "never a URL, never a new frame origin"), plus an agent's or a desk app's id. */
export const VIEW_APPS = ['notebook', 'files', 'agent', 'browser', 'todo', 'documents'] as const;
export type ViewApp = (typeof VIEW_APPS)[number] | `agent:${string}` | `app:${string}`;

export function viewApp(raw: unknown): ViewApp | null {
  if (typeof raw !== 'string' || raw.length > 120) return null;
  if ((VIEW_APPS as readonly string[]).includes(raw)) return raw as ViewApp;
  // An agent's own app or an installed app, by the office's own rules for their ids (`canvas/layout.ts`), so `appDef` knows it.
  return isAgentApp(raw) || isDeskApp(raw) ? (raw as ViewApp) : null;
}

/** "Noted for Work · Undo" (use case A): the line is the desk's template; Undo is the note's approval's (§23, "Notes"). */
export interface NoteChip {
  id: string;
  line: string;
  state: 'filed' | 'pending' | 'held' | 'failed' | 'undone';
  /** What Undo undoes (the note's approval id), or null where there's nothing to undo. */
  undo: string | null;
}

/** A pointer at a desk's own approval card: never the record, and never approved here (§8.2, defence 7). */
export interface CardPointer {
  id: string;
  deskId: string;
  /** "Sends outside your desk", "Spends money", "Changes your things": from the kind, in code. */
  level: 'send' | 'spend' | 'write' | 'delete' | 'egress';
  agentName: string;
  title: string;
}

export type ChoiceAnswer = { kind: 'option'; id: string } | { kind: 'other'; text: string } | { kind: 'ignored' };

/** Her multiple-choice reply (the owner's ESSENTIAL requirement, Nov 12): 2 to 4 short answers, the first her pick, and "Other". */
export interface ChoiceSet {
  id: string;
  options: { id: string; label: string }[];
  answered: ChoiceAnswer | null;
  /** Whether "Other" is offered: hers always; code's own question about held notes never (§23). Absent means yes. */
  other?: boolean;
  /** Whether the first option is her pick (`recommended`); code's own question has none. Absent means yes. */
  pick?: boolean;
}

export interface RoomMessage {
  id: string;
  from: 'member' | 'maia';
  text: string;
  at: number;
  notes?: NoteChip[];
  card?: CardPointer;
  choices?: ChoiceSet;
  /** Her offer to show something, as a "Show me" button (an `office_show` she may not open by herself). */
  show?: ShowRequest;
  /**
   * Her handover (deskd API.md §24 `docs_handover`): a pointer only, `{deskId, docId}`. The room draws the card from that desk
   * (`docs.get`: its title, reason and her summary line), so nothing of the document rides her message.
   */
  doc?: DocPointer;
  /** Her reply didn't finish: the reason's words, from code. */
  failed?: string;
  /** Code's card for a held brief: its estimate line, in code's words ("About $1.20 · usually $0.20 · Work Lead"). */
  cost?: string;
  /** It arrived while the room was open (not with the thread it opened on): its words glide in (`glide.ts`). */
  live?: boolean;
}

export type AttentionKind = 'approval' | 'result' | 'todos' | 'notes' | 'limit' | 'desk_failed' | 'desk_asleep' | 'cap' | 'account';

/** What tapping an item does, as data (§23 `action`): the viewport, a line of her chat, the office's own wake, or nothing. */
export type Go = { kind: 'view'; app: ViewApp; ref: string | null } | { kind: 'chat'; messageId: string } | { kind: 'wake' } | { kind: 'none' };

/** One thing the runtime's attention rules (code on the home desk) bring to the member: kinds and urgency are code's. */
export interface AttentionItem {
  id: string;
  kind: AttentionKind | 'notes_unsure';
  deskId: string;
  urgency: 'now' | 'next' | 'later';
  title: string;
  meta: string | null;
  go: Go;
  at: number;
}

/** A document on one of the member's own desks: ids only. */
export interface DocPointer {
  deskId: string;
  docId: string;
}

export interface ShowRequest {
  deskId: string;
  app: ViewApp;
  ref: string | null;
}

/**
 * What her briefs cost the member today and this month (§23 `briefs`): their own agents on their own keys, so dollars (their
 * provider's bill), against the day's budget for her briefs, in all and per desk. Never Maia's own usage.
 */
export interface BriefSpend {
  todayUsd: number;
  monthUsd: number;
  budgetUsd: number;
  desks: { deskId: string; name: string; todayUsd: number; monthUsd: number }[];
}

/** Where her last answer's credits came from (ma-platform `desk-maia.md` 0.4.8 `drawingFrom`): pace only, never a lockout. */
export type DrawingFrom = 'day' | 'week' | 'month' | 'starting' | 'topUp' | 'lighter' | 'none';

/**
 * Maia's allowance as her service last reported it (deskd §23 topic `agent.maia` `allowance`), and her credits on this desk today.
 * Never money (the owner, Nov 15: members never see dollar amounts for Maia). `fraction` and `resetsAt` are null before any
 * answer; `credits` is null for a tier that shares its Maia allowance (or an older Platform).
 */
export interface MaiaAllowance {
  /** The share left, 0 to 1 (with credits: the month's). */
  fraction: number | null;
  /** When it resets (with credits: the month's renewal), ISO. Shown as a date, never a countdown. */
  resetsAt: string | null;
  /** Her service refused her (`limit`): her reply says so. */
  usedUp: boolean;
  /** The month's credits and top-ups are used up: she keeps working on a lighter model. */
  lighter: boolean;
  /**
   * The credits. With `left` (contract 0.4.10, the coordinator's decision of Nov 15) they're the member's one wallet, shared
   * with their agents on MA's credits: the monthly part (`month`, `monthLeft`; 0 for a tier without one), the starting credits
   * and top-ups, spent in that order. Without it, Desk Maia's own (0.4.8).
   */
  credits: { month: number; monthLeft: number; topUpLeft: number; drawingFrom: DrawingFrom | null; left?: number | null; starting?: number; lighterLeft?: number | null } | null;
  /** What her calls drew on this desk today, in credits. */
  today: number;
  /** The member's own day cap on her, in whole credits, or null for none. */
  cap: number | null;
}

export interface RoomState {
  link: LinkState;
  messages: RoomMessage[];
  /** She's answering. */
  busy: boolean;
  status: { desks: number; agents: number | null; working: number | null } | null;
  foot: { onIt: number; doneToday: number; briefs?: BriefSpend | null } | null;
  /** Her credits (or her shared allowance's share): the foot's lines. Null until the desk says. */
  allowance: MaiaAllowance | null;
  attention: AttentionItem[];
  /** What waits under Later, when the desk counts it (§23 `todo.later`); null where the room counts its own. */
  later: { count: number; lines: string[] } | null;
  /** Her latest `office_show`, numbered so the same thing shown twice opens twice. */
  show: (ShowRequest & { seq: number }) | null;
  /** A new Now's interrupt (§23 `notice`): her `noticing` beat plays once per new value. */
  noticeAt: number | null;
  /** Something the member can put right in the room (a sleeping home desk), or a plain line, in code's words, with the button's words if any. */
  problem: { line: string; action: string | null } | null;
  /** The home desk says Maia Mode is off there, and this page didn't just turn it on: the room follows the desk (MR-M1). */
  deskOff: boolean;
  /**
   * The home desk holds an older disclosure than this page's (a send refused `disclosure`, deskd §23): the room shows the current
   * one over itself until the member accepts it and the desk answers (`setOn(true)` settles), or leaves.
   */
  disclosure: boolean;
}

export interface RoomSource {
  get(): RoomState;
  subscribe(fn: () => void): () => void;
  /** A member's line. `answering`: the choices it leaves unanswered (`ignored`) or answers as "Other". */
  send(text: string, answering?: { choices: string; as: 'ignored' | 'other' }): void;
  /** A tap on one of her choices. */
  choose(messageId: string, optionId: string): void;
  undoNote(noteId: string): void;
  /** "Not now" on a card pointer or an item: it waits under Later. */
  snooze(id: string): void;
  /**
   * Maia Mode switched on or off for this member (the home desk's log; off revokes every grant). Resolves true once the home
   * desk has it (it waits for the desk's link, and tries again), false if the desk refuses for good.
   */
  setOn(on: boolean): Promise<boolean>;
  /** "Delete Maia Mode history" (§23 `agent.maia.forget`): her thread, her note log and her choice counts. */
  forget(): Promise<boolean>;
  /** The member is typing in her chat, or stopped: nothing new appears meanwhile (§23 `agent.maia.typing`). */
  typing(on: boolean): void;
  /** The member looked at the list; `back` after five minutes away (§23 `agent.maia.seen`). */
  seen(back: boolean): void;
  /** The problem's button. */
  fix(): void;
  close(): void;
}

export const EMPTY_ROOM: RoomState = { link: 'connecting', messages: [], busy: false, status: null, foot: null, allowance: null, attention: [], later: null, show: null, noticeAt: null, problem: null, deskOff: false, disclosure: false };

/** A source that never connects: the room's honest state until the home desk answers. */
export function waitingSource(link: LinkState = 'connecting'): RoomSource {
  const state: RoomState = { ...EMPTY_ROOM, link };
  const none = (): void => undefined;
  const no = (): Promise<boolean> => Promise.resolve(false);
  return { get: () => state, subscribe: () => () => undefined, send: none, choose: none, undoNote: none, snooze: none, setOn: no, forget: no, typing: none, seen: none, fix: none, close: none };
}

export type { AppId };
