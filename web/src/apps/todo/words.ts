// Every sentence To-do says, in one place (the design's words, `design-drafts/todo-store/VISION.md`). Calm: no exclamation
// marks, no "you're behind", no streaks. An item's title, note, source label and an agent's reason are the desk's text and
// are shown as plain text, never through these.
import type { SourceKind } from './types';

export const W = {
  name: 'To-do',
  needsYou: 'Needs you',
  all: 'All',
  done: 'Done',
  trash: 'Trash',
  needsYouLine: 'only what’s due, overdue or kept here by you',
  nothing: 'Nothing needs you right now.',
  nothingOpen: 'Nothing on your list. Add a to-do any time.',
  nothingDone: 'Nothing done yet.',
  nothingTrash: 'Trash is empty.',
  nothingFound: 'No to-dos match.',
  add: 'Add a to-do',
  addLabel: 'New to-do',
  today: 'Today',
  tomorrow: 'Tomorrow',
  thisDesk: 'This desk',
  allDesks: 'All desks',
  toConfirm: 'To confirm',
  everythingElse: 'Everything else',
  newFromAgents: 'New from agents',
  show: 'Show',
  hide: 'Hide',
  search: 'Search to-dos',
  everyone: 'Everyone',
  fromCourier: 'From Courier',
  open: 'Open',
  markDone: 'Mark done',
  notNeeded: 'Not needed',
  reopen: 'Reopen',
  restore: 'Restore',
  snooze: 'Snooze',
  unsnooze: 'Wake it now',
  pickDay: 'Pick a day',
  keep: 'Keep in Needs you',
  delete: 'Delete',
  undo: 'Undo',
  notYet: 'Not yet',
  history: 'History',
  whereFrom: 'Where it came from',
  more: 'More',
  exportMd: 'Export as a Markdown checklist',
  exportJson: 'Export as a JSON file',
  tileCount: 'Show the count on the tile',
  trashNote: 'Deleted to-dos stay here for 30 days.',
  title: 'Title',
  note: 'Note',
  due: 'Due',
  time: 'Time',
  noDate: 'No date',
  clearDate: 'Clear the date',
  close: 'Close',
  saved: 'Saved',
  untrusted: (from: string): string => `Made from ${from}. Check it before you act on it.`,
  suggestUntrusted: 'Asked after reading an email or a page. Check it before you answer.',
  waiting: 'Your to-dos wait on your desk.',
  asleep: (desk: string): string => `${desk} is asleep`,
  openIt: 'Open it',
  failed: 'That didn’t save. Try again in a moment.',
  readFailed: 'Can’t read this desk’s to-dos right now.',
  tryAgain: 'Try again',
  stale: 'This to-do changed on your desk. Here it is as it is now.',
  gone: 'That to-do isn’t on your desk any more.',
  oldDesk: 'This desk’s To-do needs an update. It comes with the next desk update.',
  cap: 'This desk has 2,000 open to-dos, the most it keeps. Finish or delete some to add more.',
  tooLong: 'Use 1 to 200 characters.',
  changedSince: 'That changed again since, so nothing was undone.',
  closedNow: 'This to-do is closed now. Reopen it to change it.',
  exported: 'Exported.',
  exportFailed: 'That export didn’t finish. Try again in a moment.',
} as const;

/** What a source is, in a few words, for "Made from an email" and the source line's icon. */
export function sourceNoun(kind: SourceKind): string {
  switch (kind) {
    case 'courier':
      return 'a message';
    case 'browser':
      return 'a page';
    case 'files':
      return 'a file';
    case 'notebook':
      return 'a note';
    case 'agent_chat':
      return 'a chat';
    case 'desk':
      // "Made from a message another of your desks sent.": one "from" in the line, not two (the brand pass, Nov 13).
      return 'a message another of your desks sent';
    default:
      return 'something you typed';
  }
}

/** Where Open goes, for its accessible name: "Open in Courier". */
export function openWhere(kind: SourceKind): string {
  switch (kind) {
    case 'courier':
      return 'Courier';
    case 'browser':
      return 'the desk’s Browser';
    case 'files':
      return 'Files';
    case 'notebook':
      return 'Notebook';
    case 'agent_chat':
    case 'desk':
      return 'the Agent';
    default:
      return '';
  }
}

/** Under a date an agent set: "Date from the email". */
export function dateFrom(kind: SourceKind): string {
  const what = kind === 'courier' ? 'the message' : kind === 'browser' ? 'the page' : kind === 'files' ? 'the file' : kind === 'notebook' ? 'the note' : kind === 'desk' ? 'the message' : 'the chat';
  return `Date from ${what}`;
}

/** One count of a quiet line: the bold part (the number, or "2 new"), then the rest of its words. */
export type CountPart = readonly [bold: string, rest: string];

/** Needs you's footer, a count at a time, its counts bold as the pick sheet has them: "**2 new** from agents · **1** to confirm". */
export function footerParts(fresh: number, confirm: number): CountPart[] {
  const parts: CountPart[] = [];
  if (fresh) parts.push([`${fresh} new`, ' from agents']);
  if (confirm) parts.push([`${confirm}`, ' to confirm']);
  return parts;
}

const joined = (parts: readonly CountPart[]): string => parts.map(([b, r]) => b + r).join(' · ');

/** A count in Needs you's footer: "2 new from agents · 1 to confirm". */
export const footerWords = (fresh: number, confirm: number): string => joined(footerParts(fresh, confirm));

/** "+2 more today": what Needs you holds beyond the five shown. */
export const moreWords = (n: number): string => `+${n} more`;

/** Everything else, under Needs you, one count at a time ("**6** coming up"), so a line never breaks inside one. */
export function elseParts(s: { comingUp: number; noDate: number; snoozed: number }): CountPart[] {
  const parts: CountPart[] = [];
  if (s.comingUp) parts.push([`${s.comingUp}`, ' coming up']);
  if (s.noDate) parts.push([`${s.noDate}`, ' with no date']);
  if (s.snoozed) parts.push([`${s.snoozed}`, ' snoozed']);
  return parts;
}

/** Everything else, under Needs you: "6 coming up · 7 with no date · 2 snoozed". */
export const elseWords = (s: { comingUp: number; noDate: number; snoozed: number }): string => joined(elseParts(s));

/** A suggestion's `as` in an event's fields: "not_needed" or "done". */
const suggestedAs = (fields: Record<string, unknown> | null): unknown => {
  const s = fields?.['suggestion'];
  return s && typeof s === 'object' ? (s as Record<string, unknown>)['as'] : undefined;
};

/**
 * A History line. `who` is "You" or an agent's name. A suggestion says which it asked, as its card and the Agent's chip do
 * ("Not needed any more?", "Asked if a to-do is still needed"): `after` holds it on a suggest, `before` on an answer.
 */
export function eventWords(op: string, who: string, after: Record<string, unknown> | null, before: Record<string, unknown> | null = null): string {
  const changed = after ? Object.keys(after) : [];
  switch (op) {
    case 'add':
      return `${who} added it`;
    case 'edit':
      return `${who} changed the ${changed.includes('title') ? 'title' : changed.includes('due') ? 'date' : 'note'}`;
    case 'close':
      return after?.['state'] === 'not_needed' ? `${who} marked it not needed` : `${who} marked it done`;
    case 'reopen':
      return `${who} reopened it`;
    case 'snooze':
      return after?.['snoozedUntil'] ? `${who} snoozed it` : `${who} woke it`;
    case 'pin':
      return after?.['pinned'] ? `${who} kept it in Needs you` : `${who} took it out of Needs you`;
    case 'suggest':
      return suggestedAs(after) === 'not_needed' ? `${who} asked if it’s still needed` : `${who} asked if it’s done`;
    case 'answer':
      return suggestedAs(before) === 'not_needed' ? `${who} answered “Not needed any more?”` : `${who} answered “Looks done?”`;
    case 'merge':
      return `A reminder was merged in, not added twice`;
    case 'trash':
      return `${who} deleted it`;
    case 'restore':
      return `${who} restored it`;
    case 'undo':
      return `${who} undid a change`;
    default:
      return `${who} changed it`;
  }
}
