// Every sentence Documents says, in one place: the documents concept's §20 words, exactly, and code's few of its own. Calm: no
// exclamation marks, never "Maia Mode", "shield" or a price. A document's title, reason, sender, file name, the reader's line and
// every toast are the desk's words and are shown as plain text, never through these.
import type { Place } from './types';

export const W = {
  name: 'Documents',
  needs: 'Needs you',
  maybe: 'Maybe',
  read: 'Read later',
  records: 'Records',
  working: 'Working on',
  people: 'People',
  week: 'This week',
  // Asking is the desk's own agent's (the owner, Nov 15): its lead by default, by the name the member gave it.
  search: (agent: string): string => `Find a document, or ask ${agent}`,
  searchNoAgent: 'Find a document',
  lookInside: 'Look inside documents',
  askAgent: (agent: string): string => `Ask ${agent}`,
  askAnother: 'Ask another agent',
  findEmpty: 'Nothing like that on your desks.',
  matchedInside: 'Found inside',
  end: 'That’s all for now.',
  emptyNeeds: 'Nothing needs you.',
  emptyRecords: 'Receipts, statements and confirmations go here. Nothing yet.',
  emptyOther: 'Nothing here yet.',
  thisDesk: 'This desk',
  allDesks: 'All desks',
  more: 'More',
  rules: 'Your rules',
  noRules: 'No rules yet. Not important and Sooner next time make them.',
  remove: 'Remove',
  tidy: 'Tidy up',
  tidyNothing: 'Nothing to tidy up.',
  notNow: 'Not now',
  notImportant: 'Not important',
  sooner: 'Sooner next time',
  done: 'Done',
  undo: 'Undo',
  close: 'Close',
  back: 'Documents',
  // The viewer (§20.4).
  fileName: 'File name',
  page: (n: number, of: number): string => `Page ${n} of ${of}`,
  readAsText: 'Read as text',
  showPages: 'Show pages',
  whatChanged: 'What changed',
  changedSince: (list: string): string => `${list} changed since you last looked.`,
  showChanges: 'Show changes',
  versions: 'Versions',
  copies: 'Copies',
  alsoIn: 'Also in',
  whatsThis: 'What’s this?',
  reading: 'Reading it now.',
  readFailed: 'Maia can’t read this one now.',
  askAbout: (agent: string): string => `Ask ${agent} about this`,
  askFirst: (agent: string): string => `To answer, ${agent} sends this document and your question to its AI, on ${agent}’s key or your credits.`,
  askNoWindow: 'Put the Agent back on this desk to ask.',
  ask: 'Ask',
  askAboutDraft: (title: string): string => `About “${title}”: `,
  download: 'Download',
  restore: 'Restore',
  restoreAsk: 'Restore this version?',
  cancel: 'Cancel',
  current: 'Now',
  summaryFirst: 'My one-line notes can miss things. The document is always one tap away.',
  gotIt: 'Got it',
  maiaNote: 'Maia’s note. Open the document to check.',
  danger: 'Maia won’t open this.',
  sandbox: 'Open this when your desk can draw it.',
  offline: 'Open this when you’re back online.',
  gone: 'This document isn’t on your desk any more.',
  noText: 'There’s no text in this one to read.',
  failed: 'That didn’t work. Try again in a moment.',
  waiting: 'Your documents wait on your desk.',
  oldDesk: 'This desk’s Documents comes with the next desk update.',
  switchedOff: 'Documents is off on this desk.',
  asleep: (desk: string): string => `${desk} is asleep`,
  openIt: 'Open it',
  onDesk: (desk: string): string => `On ${desk}`,
  pages: 'Pages',
  tryAgain: 'Try again',
  changedHere: 'Changed on this page.',
} as const;

export const PLACES: { key: Place; label: string }[] = [
  { key: 'needs', label: W.needs },
  { key: 'read', label: W.read },
  { key: 'records', label: W.records },
  { key: 'working', label: W.working },
];

export const placeLabel = (p: Place): string => PLACES.find((x) => x.key === p)?.label ?? W.records;

/** The empty line of a place (§20.1). */
export const emptyWords = (p: Place): string => (p === 'needs' ? W.emptyNeeds : p === 'records' ? W.emptyRecords : W.emptyOther);

/** "3", "3 and 7", "2, 4 and 9": a list of pages, as code's own lines say them. */
export function pageList(pages: readonly number[]): string {
  if (pages.length <= 1) return `Page ${pages[0] ?? 1}`;
  const head = pages.slice(0, -1).join(', ');
  return `Pages ${head} and ${pages[pages.length - 1]}`;
}

/** A version's date, in the member's own words and time ("12 Nov, 4:10 pm"). */
export function versionDate(at: number): string {
  try {
    const d = new Date(at);
    const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
    return `${day}, ${time}`;
  } catch {
    return '';
  }
}
