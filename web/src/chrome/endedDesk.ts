// The words on a desk kept for download only (the panel, `EndedDeskPanel.tsx`). A Work desk a step down stopped: the Product
// Designer's billing spec, still 15. A Personal desk that can't be the member's {Free} desk (an instance of its own when a paid
// membership ended): the live Terms 6 item "When a paid membership ends" and Sales' `business/ended-membership-copy.md` 1A
// ("Stopped, kept for you to download"): kept with its data to download until the member moves up again, nothing deleted,
// and moving up brings it back. Pure: the panel and its tests share them. A tier is named as settings name it, on its own
// with no article (`platform/tiers.ts`).

const day = (iso: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(Date.parse(iso));
const dayYear = (iso: string): string => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(Date.parse(iso));

export interface EndedWords {
  title: string;
  body: string;
}

/** Which desk: the panel names it by its kind, as its menu does ("Personal desk"). */
export type EndedKind = 'work' | 'personal';

/**
 * `tier` is the member's tier now, by name, or null while it isn't known; `onFree` says that tier is {Free}. With a
 * `retainedUntil` the snapshot path's words, verbatim from the spec; without one (contract `notInPlan`: the desk is kept, data
 * and Browser session, until the member moves back up) the spec's alternative, for Sales. A Personal desk on {Free} says why
 * it's kept in the Terms' words: it can't be the {Free} desk.
 */
export function endedWords(e: { stoppedAt: string | null; retainedUntil: string | null }, tier: string | null, kind: EndedKind = 'work', onFree = false): EndedWords {
  const name = kind === 'personal' ? 'Personal' : 'Work';
  const title = e.stoppedAt ? `Your ${name} desk stopped on ${day(e.stoppedAt)}` : `Your ${name} desk has stopped`;
  if (kind === 'personal' && onFree && tier) {
    const body = e.retainedUntil
      ? `It can't be your ${tier} desk. We keep a snapshot of it until ${dayYear(e.retainedUntil)}, and you can download everything on it until then.`
      : `It can't be your ${tier} desk, so it's kept for you to download, with its files, tabs and sign-ins. Nothing is deleted, and it returns when you move back up.`;
    return { title, body };
  }
  const part = tier ? `It isn't part of ${tier}.` : "It isn't part of your membership now.";
  const body = e.retainedUntil
    ? `${part} We keep a snapshot of it until ${dayYear(e.retainedUntil)}, and you can download everything on it until then.`
    : `${part} It's kept, with its files, tabs and sign-ins, until you move back up, and you can download everything on it.`;
  return { title, body };
}

export const DOWNLOAD_LINK = 'Download your data';
export const MOVE_UP_LINK = 'Move back up';
