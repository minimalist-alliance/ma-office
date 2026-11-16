// Calls done without asking, under the member's setting for an agent (draft ADR "the Agent's tools and approvals", section 15;
// deskd API.md section 18, "Done without asking"): the chip's Undo, the line under a reply ("Did 3 things without asking: 2
// notes and a file in Research · Undo all · See them"), what an undo answered, and a card's "Don't ask again". Pure: the wire's
// rows and access in, the words out. Every place a row names came from the member's setting; every target from a model, a page
// or a file, so it renders as text with hidden characters shown (`shown`), as on a card.
import type { AccessChange, AgentAccess, Approval, ApprovalTarget, AutoDone, Message } from '../client/types';
import { doneWord, shown } from './approvals';
import { wordTarget } from './tools';

/** Done without asking: never a card, never Approve or Decline (API.md section 18). */
export const isAuto = (a: Pick<Approval, 'decidedBy'>): boolean => a.decidedBy === 'auto';

// ------------------------------------------------------------------ the words

/** The chip's words, before its Undo. */
export const AUTO_CHIP = 'Done without asking';
/** A call cut off by a restart, which deskd may have finished: its Undo finds out, and says "It didn’t happen" if it didn't. */
export const MAYBE_CHIP = 'May have been done without asking';
export const MAYBE_ROW = 'May have been done';
/** A call without asking that failed, or that its undo found never happened: never "Done". */
export const TRIED_CHIP = 'Tried without asking';
export const UNDO = 'Undo';
export const UNDO_ALL = 'Undo all';
export const UNDOING = 'Undoing…';
export const TRY_AGAIN = 'Try again';
export const SEE_THEM = 'See them';
export const HIDE_THEM = 'Hide them';
/** The line once everything the run did without asking has been undone. */
export const ALL_UNDONE = 'Undid everything it did without asking';
/** "See them"'s list, for a screen reader. */
export const SEE_THEM_LABEL = 'Done without asking';

// ------------------------------------------------------------------ a row

/** What an undo answered, in the member's terms. */
export type UndoOutcome = 'undone' | 'already' | 'changed' | 'newer' | 'unknown' | 'not_done' | 'trashed' | 'gone' | 'forbidden' | 'failed';

export interface UndoResult {
  outcome: UndoOutcome;
  /** `changed` on a Notebook edit: the page from before it, in its History. */
  versionId?: string | null;
}

/** An undo's refusal (an `AgentError`, or anything with its fields) as an outcome. Anything unknown can be tried again. */
export function undoOutcomeOf(err: unknown): UndoResult {
  const e = (err ?? {}) as { code?: unknown; reason?: unknown; versionId?: unknown };
  if (e.code === 'conflict') {
    if (e.reason === 'changed') return { outcome: 'changed', versionId: typeof e.versionId === 'string' ? e.versionId : null };
    if (e.reason === 'undone') return { outcome: 'already' };
    // A later agent edit to the same page stands: that one is undone first, then this can be.
    if (e.reason === 'newer') return { outcome: 'newer' };
    // Cut off with no end recorded: it may have happened, and the desk can't take it back (Security's AAB-I6).
    if (e.reason === 'unknown') return { outcome: 'unknown' };
    if (e.reason === 'not_done') return { outcome: 'not_done' };
    if (e.reason === 'trashed') return { outcome: 'trashed' };
  }
  if (e.code === 'not_found') return { outcome: 'gone' };
  if (e.code === 'forbidden') return { outcome: 'forbidden' };
  return { outcome: 'failed' };
}

/** A row's undo here: running, or what it answered. */
export type LocalUndo = { kind: 'working' } | { kind: 'answered'; result: UndoResult };

/**
 * Where a row stands: `running` (not finished yet), `undoable`, `working` (its undo is on the way), `undone`, `kept` (it stays:
 * changed since, or it can't be undone here), `retry` (the undo didn't get through), `not_done` (it didn't happen), `maybe`
 * (cut off by a restart: deskd may have finished it, so it can be undone, and its undo says if it didn't happen; Security's
 * AAB-I2).
 */
export type RowState = 'running' | 'undoable' | 'working' | 'undone' | 'kept' | 'retry' | 'not_done' | 'maybe';

export function rowStateOf(row: Pick<AutoDone, 'state' | 'undoneAt'>, approval: Pick<Approval, 'state' | 'undoneAt'> | null | undefined, local: LocalUndo | null | undefined): RowState {
  if (local?.kind === 'working') return 'working';
  const outcome = local?.kind === 'answered' ? local.result.outcome : null;
  if (outcome === 'undone' || outcome === 'already' || row.undoneAt != null || approval?.undoneAt != null) return 'undone';
  if (outcome === 'not_done') return 'not_done';
  if (outcome && outcome !== 'failed' && outcome !== 'newer') return 'kept';
  // The approval's own events are newer than the reply's copy of its state.
  const state = approval?.state ?? row.state;
  if (state === 'done') return outcome === 'failed' ? 'retry' : 'undoable';
  if (state === 'interrupted') return 'maybe';
  if (state === 'approved' || state === 'pending') return 'running';
  return 'not_done';
}

/** Whether a row counts as done: it ran, and nothing took it back. A change kept after a refused undo still counts. */
export const countsAsDone = (s: RowState): boolean => s === 'undoable' || s === 'working' || s === 'kept' || s === 'retry';
/**
 * Undo all's order: the newest first, as a page's own undo goes (desk-notebook undoes an agent's edits to a page newest
 * first, each back to exactly the page before it), so a run's later write to a page is taken back before its earlier one.
 */
export const undoOrder = <T>(rows: readonly T[]): T[] => [...rows].reverse();

/** Whether Undo, or Undo all, can try it. */
export const mayUndo = (s: RowState): boolean => s === 'undoable' || s === 'retry' || s === 'maybe';

type Op = 'create' | 'append' | null;

/** A Notebook call's op: the approval's payload, else the target (a page it makes has no id yet). */
function opOf(row: Pick<AutoDone, 'tool' | 'target'>, approval: Pick<Approval, 'payload'> | null | undefined): Op {
  if (row.tool !== 'notebook_write') return null;
  const op = approval?.payload?.['op'];
  if (op === 'create' || op === 'append') return op;
  return row.target?.kind === 'page' && !row.target.pageId ? 'create' : 'append';
}

const AUTO_DONE: Record<string, string> = {
  files_write: 'Saved a file',
  files_mkdir: 'Made a folder',
  todo_create: 'Added a to-do',
  todo_complete: 'Ticked off a to-do',
  todo_update: 'Changed a to-do',
};

/** What an unasked call did, in the past tense: "Made a page", "Added to a page", "Saved a file". */
export function autoWord(row: Pick<AutoDone, 'tool' | 'target'>, approval?: Pick<Approval, 'payload'> | null): string {
  const op = opOf(row, approval);
  if (op === 'create') return 'Made a page';
  if (op === 'append') return 'Added to a page';
  return AUTO_DONE[row.tool] ?? doneWord(row.tool);
}

/** What it acted on, in a few words: a file's path, a page's title. Null when the desk didn't say. */
export const rowTarget = (target: ApprovalTarget | null | undefined): string | null => wordTarget(target ?? null);

/**
 * A reply's calls done without asking: its `auto`, in order, else (a desk that sends only chips) its chips that carry their
 * approval id for an Undo.
 */
export function autoRowsOf(m: Pick<Message, 'auto' | 'tools'>): AutoDone[] {
  if (m.auto?.length) return m.auto;
  return (m.tools ?? []).flatMap((c) =>
    c.auto && c.approval?.decision === 'auto' && c.approval.id ? [{ approvalId: c.approval.id, tool: c.name, target: c.target ?? null, group: c.auto, state: c.ok ? ('done' as const) : ('failed' as const), undoneAt: null }] : [],
  );
}

// ------------------------------------------------------------------ the line under a reply

type Kind = 'page' | 'note' | 'file' | 'folder' | 'todo' | 'change';
const KIND_ORDER: readonly Kind[] = ['page', 'note', 'file', 'folder', 'todo', 'change'];
const KIND_WORDS: Record<Kind, [string, string]> = {
  page: ['a new page', 'new pages'],
  note: ['a note', 'notes'],
  file: ['a file', 'files'],
  folder: ['a folder', 'folders'],
  todo: ['a to-do', 'to-dos'],
  change: ['a change', 'changes'],
};

function kindOf(row: Pick<AutoDone, 'tool' | 'target'>, approval: Pick<Approval, 'payload'> | null | undefined): Kind {
  const op = opOf(row, approval);
  if (op === 'create') return 'page';
  if (op === 'append') return 'note';
  if (row.tool === 'files_write') return 'file';
  if (row.tool === 'files_mkdir') return 'folder';
  if (row.tool.startsWith('todo_')) return 'todo';
  return 'change';
}

const counted = (kind: Kind, n: number): string => (n === 1 ? KIND_WORDS[kind][0] : `${n} ${KIND_WORDS[kind][1]}`);

/** "a, b and c". */
export function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface AutoRowView {
  row: AutoDone;
  state: RowState;
  /** "Saved a file". */
  word: string;
  /** "Research/notes.md", "“Lamp notes”", or null. */
  target: string | null;
  /** What its undo answered, in a sentence, once it has. */
  said: string | null;
}

export interface AutoLineView {
  rows: AutoRowView[];
  /** Rows that ran and are still there. */
  done: number;
  /** "Did 3 things without asking: 2 notes and a file in Research", or `ALL_UNDONE`; null for no line. */
  text: string | null;
  /** Ids Undo all tries, in order. */
  undoable: string[];
}

/**
 * The line under a finished reply (API.md section 18): how many things its run did without asking, counting only those done and
 * not undone, in words per group with the place when every row of the group shares one. `tabName` names a Notebook tab where
 * the app knows it; a tab it can't name isn't named.
 */
export function autoLineOf(
  rows: readonly AutoDone[],
  approvals: ReadonlyMap<string, Approval>,
  local: Readonly<Record<string, LocalUndo>>,
  tabName: (tabId: string) => string | null,
): AutoLineView {
  const views: AutoRowView[] = rows.map((row) => {
    const approval = approvals.get(row.approvalId);
    const l = local[row.approvalId];
    return { row, state: rowStateOf(row, approval, l), word: autoWord(row, approval), target: rowTarget(row.target), said: l?.kind === 'answered' ? undoSentence(row, l.result, approval) : null };
  });
  const live = views.filter((v) => countsAsDone(v.state));
  // Groups in the order the run first touched them; in each, its kinds in a fixed order.
  const groups: { group: string; rows: AutoRowView[] }[] = [];
  for (const v of live) {
    const g = groups.find((x) => x.group === v.row.group);
    if (g) g.rows.push(v);
    else groups.push({ group: v.row.group, rows: [v] });
  }
  const phrases = groups.map(({ group, rows: inGroup }) => {
    const kinds = new Map<Kind, number>();
    for (const v of inGroup) {
      const k = kindOf(v.row, approvals.get(v.row.approvalId));
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const words = joinWords(KIND_ORDER.filter((k) => kinds.has(k)).map((k) => counted(k, kinds.get(k)!)));
    const place = placeOf(group, inGroup, approvals, tabName);
    return place ? `${words} in ${place}` : words;
  });
  const undone = views.some((v) => v.state === 'undone');
  // Cut off by a restart: not counted as done, but said, with Undo (AAB-I2).
  const maybe = views.filter((v) => v.state === 'maybe').length;
  const did = live.length ? `Did ${live.length} ${live.length === 1 ? 'thing' : 'things'} without asking: ${joinWords(phrases)}` : null;
  const text = did
    ? maybe
      ? `${did}. ${maybe === 1 ? 'One more' : `${maybe} more`} may have been done`
      : did
    : maybe
      ? `${maybe === 1 ? 'One thing' : `${maybe} things`} may have been done without asking`
      : undone
        ? ALL_UNDONE
        : null;
  return { rows: views, done: live.length, text, undoable: views.filter((v) => mayUndo(v.state)).map((v) => v.row.approvalId) };
}

/** The place every row of a group shares, by its switch: the folder, or the tab by name. Null when they differ or it's unknown. */
function placeOf(group: string, rows: readonly AutoRowView[], approvals: ReadonlyMap<string, Approval>, tabName: (tabId: string) => string | null): string | null {
  const places = rows.map((v) => {
    const a = approvals.get(v.row.approvalId)?.auto;
    if (group === 'files') return a?.folder ?? null;
    if (group === 'notebook') return a?.tabId ?? (v.row.target?.kind === 'page' ? (v.row.target.tabId ?? null) : null);
    return null;
  });
  const first = places[0];
  if (!first || places.some((p) => p !== first)) return null;
  if (group === 'files') return shown(first);
  const name = tabName(first);
  return name ? shown(name) : null;
}

// ------------------------------------------------------------------ what an undo answered

/** What an undo answered, in a sentence (API.md section 18's errors). */
export function undoSentence(row: Pick<AutoDone, 'tool' | 'target'>, r: UndoResult, approval?: Pick<Approval, 'payload'> | null): string {
  const op = opOf(row, approval);
  switch (r.outcome) {
    case 'undone':
      if (row.tool === 'files_write') return 'Undone. The file is in the Trash in Files.';
      if (row.tool === 'files_mkdir') return 'Undone. The folder is in the Trash in Files.';
      if (op === 'create') return 'Undone. The page is in Notebook’s Trash.';
      if (op === 'append') return 'Undone. What it added is gone from the page.';
      return 'Undone.';
    case 'already':
      return 'This was undone already.';
    case 'newer':
      return 'An agent changed this page again since. Undo the later change first.';
    case 'unknown':
      return 'It may have happened, and it can’t be undone from here. If it did, it’s still there.';
    case 'changed':
      return r.versionId ? 'It’s been changed since, so it stays. The page as it was before is in its History.' : 'It’s been changed since, so it stays.';
    case 'not_done':
      return 'It didn’t happen, so there’s nothing to undo.';
    case 'trashed':
      return 'The page is in Notebook’s Trash already.';
    case 'gone':
      return 'This can’t be undone any more.';
    case 'forbidden':
      return 'Only the desk’s owner can undo this.';
    default:
      return 'Couldn’t undo it just now. Try again.';
  }
}

/** A chip's state after its Undo, in a word or two. Null while it can still be undone. */
export function chipStateWord(s: RowState): string | null {
  switch (s) {
    case 'working':
      return UNDOING;
    case 'undone':
      return 'Undone';
    case 'kept':
      return 'Kept';
    case 'retry':
      return 'Couldn’t undo';
    case 'not_done':
      return 'Not done';
    default:
      return null;
  }
}

/** One row's undo, for the line's status: "Research/notes.md: Undone. The file is in the Trash in Files." */
export const rowSaid = (v: Pick<AutoRowView, 'word' | 'target'>, sentence: string): string => `${v.target ?? v.word}: ${sentence}`;

/** Undo all's report: how many it took back, and what it couldn't, one by one when it's one. */
export function undoAllText(results: readonly { view: Pick<AutoRowView, 'word' | 'target'>; ok: boolean; sentence: string }[]): string {
  const n = results.length;
  const ok = results.filter((r) => r.ok).length;
  if (ok === n) return n === 1 ? 'Undone.' : `Undid all ${n}.`;
  const kept = results.filter((r) => !r.ok);
  if (kept.length === 1) return `Undid ${ok} of ${n}. ${rowSaid(kept[0]!.view, kept[0]!.sentence)}`;
  return `Undid ${ok} of ${n}. ${kept.length} couldn’t be undone, and each says why below.`;
}

/** An Undo button's accessible name: what it takes back. */
export const undoName = (v: Pick<AutoRowView, 'word' | 'target'>): string => `${UNDO}: ${v.word}${v.target ? `, ${v.target}` : ''}`;
/** The same, once an undo didn't get through. */
export const retryName = (v: Pick<AutoRowView, 'word' | 'target'>): string => `${TRY_AGAIN}: ${v.word}${v.target ? `, ${v.target}` : ''}`;

// ------------------------------------------------------------------ "Don't ask again" on a card

export interface DontAsk {
  group: 'files' | 'notebook';
  /** The button's words, naming the place. */
  words: string;
  /** The place in words, for what's said after. */
  place: string;
  /** Exactly what `agent.access.set` gets: this one switch, with the card's place. */
  change: AccessChange;
}

/** A Notebook tab as the office lists it: its title, and its notebook's. */
export interface NotebookTab {
  id: string;
  title: string;
  /** Its notebook's title, where the office knows it. */
  notebook?: string | null;
}

const sameTitle = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * A tab's name for the member: its title, and its notebook's too ("Work › Inbox", as Notebook's own Search names a tab) when
 * another tab has the same title, so a switch is never put on the wrong notebook's Inbox (Security's AAB-I3). Null for a tab
 * with no title, or one not listed.
 */
export function tabLabel(tabs: readonly NotebookTab[], tabId: string): string | null {
  const tab = tabs.find((t) => t.id === tabId);
  const title = tab?.title?.trim();
  if (!tab || !title) return null;
  const notebook = tab.notebook?.trim();
  return notebook && tabs.some((t) => t.id !== tab.id && sameTitle(t.title ?? '', title)) ? `${notebook} › ${title}` : title;
}

/** A path's folder, by Files' path parts; null for a path at the top of Files (a switch can't be the whole of Files) or one that isn't clean. */
export function parentFolder(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts.slice(0, -1).join('/');
}

/**
 * "Don't ask again" for a waiting card (API.md section 18): only for a call in the class done without asking (a `notebook_write`
 * that makes a page or adds to one, a `files_write` that doesn't replace, a `files_mkdir`), in the agent's own context and still
 * `write`, in a run that read nothing untrusted, for an agent whose switch for that group is off and whose app is on. The folder
 * is the file's; the tab is the new page's, or the page's, named by its title. No name, no offer: never an id on a button.
 */
export function dontAskOf(a: Approval, access: AgentAccess | null | undefined, tabs: readonly NotebookTab[] | null | undefined): DontAsk | null {
  if (!access?.chosen || a.state !== 'pending' || isAuto(a) || a.untrusted || a.risk !== 'write' || a.context !== 'agent') return null;
  const p = (a.payload ?? null) as Record<string, unknown> | null;
  if (!p) return null;
  if ((a.tool === 'files_write' && p['replace'] === false) || a.tool === 'files_mkdir') {
    if (!access.apps.files || access.auto.files !== null) return null;
    const folder = parentFolder(p['path']);
    if (!folder) return null;
    const place = shown(folder);
    return { group: 'files', words: `Save new files in ${place} without asking`, place, change: { auto: { files: { folder } } } };
  }
  if (a.tool === 'notebook_write') {
    if (!access.apps.notebook || access.auto.notebook !== null) return null;
    const op = p['op'];
    const made = p['new'] && typeof p['new'] === 'object' ? (p['new'] as Record<string, unknown>)['tabId'] : null;
    const tabId = op === 'create' ? made : op === 'append' && a.target?.kind === 'page' ? a.target.tabId : null;
    if (typeof tabId !== 'string' || !tabId) return null;
    const title = tabLabel(tabs ?? [], tabId);
    if (!title) return null;
    const place = shown(title);
    return { group: 'notebook', words: `Add pages and notes in ${place} without asking`, place, change: { auto: { notebook: { tabId } } } };
  }
  return null;
}

/** Under the button: what else it does. */
export const dontAskNote = (agentName: string): string => `It approves this one too. You can turn it off in ${agentName}’s settings.`;

/** Said once the switch is on and the card approved. */
export const dontAskDone = (agentName: string, d: Pick<DontAsk, 'group' | 'place'>): string =>
  d.group === 'files' ? `Approved. ${agentName} now saves new files in ${d.place} without asking.` : `Approved. ${agentName} now adds pages and notes in ${d.place} without asking.`;

/** The switch didn't go on: nothing was approved. */
export const DONT_ASK_FAILED = 'That setting couldn’t be turned on just now, so this still waits for your answer.';
/** The button while the switch goes on and the card is approved. */
export const DONT_ASK_BUSY = 'Turning it on…';

/** A waiting card that may want "Don't ask again": the cheap test before the agent's access is read. */
export function mayOfferDontAsk(a: Approval): 'files' | 'notebook' | null {
  if (a.state !== 'pending' || isAuto(a) || a.untrusted || a.risk !== 'write') return null;
  if (a.tool === 'files_write' || a.tool === 'files_mkdir') return 'files';
  if (a.tool === 'notebook_write') return 'notebook';
  return null;
}

// ------------------------------------------------------------------ Activity

/** Activity's words for an unasked call (desk-agent's `tool.call` with `auto:<group>`, and its `approval.auto`). */
export const ACTIVITY_UNASKED = 'Done without asking, under your setting';

/** Activity's row for `approval.undo`: the member took back a call done without asking, or the desk said why not. */
export function undoActivity(decision: string, done: string): { what: string; why: string | null } {
  const thing = done ? done.charAt(0).toLowerCase() + done.slice(1) : 'something it did';
  if (decision === 'ok') return { what: `Undid: ${thing}`, why: null };
  const word = decision.replace(/^refused:/, '');
  const why =
    word === 'changed'
      ? 'It had changed since, so it stays'
      : word === 'undone'
        ? 'It was undone already'
        : word === 'not_done'
          ? 'It hadn’t happened, so there was nothing to undo'
          : word === 'trashed'
            ? 'The page was in the Trash already'
            : word === 'newer'
              ? 'An agent had changed the page again since'
              : word === 'unknown'
                ? 'It may have happened, and couldn’t be undone from here'
                : 'Not undone';
  return { what: `Couldn’t undo: ${thing}`, why };
}
