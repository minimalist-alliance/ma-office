// The words on a Work desk a step down stopped (the Product Designer's billing spec, still 15). Pure: the panel and its
// tests share them. A tier is named as settings name it, on its own with no article (`platform/tiers.ts`).

const day = (iso: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(Date.parse(iso));
const dayYear = (iso: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(Date.parse(iso));

export interface EndedWords {
  title: string;
  body: string;
}

/**
 * `tier` is the member's tier now, by name, or null while it isn't known. With a `retainedUntil` the snapshot path's
 * words, verbatim from the spec; without one (contract `notInPlan`: the desk is kept, data and Browser session, until
 * the member moves back up) the spec's alternative, for Sales.
 */
export function endedWords(e: { stoppedAt: string | null; retainedUntil: string | null }, tier: string | null): EndedWords {
  const title = e.stoppedAt ? `Your Work desk stopped on ${day(e.stoppedAt)}` : 'Your Work desk has stopped';
  const part = tier ? `It isn't part of ${tier}.` : "It isn't part of your membership now.";
  const body = e.retainedUntil
    ? `${part} We keep a snapshot of it until ${dayYear(e.retainedUntil)}, and you can download everything on it until then.`
    : `${part} It's kept, with its files, tabs and sign-ins, until you move back up, and you can download everything on it.`;
  return { title, body };
}

export const DOWNLOAD_LINK = 'Download your data';
export const MOVE_UP_LINK = 'Move back up';
