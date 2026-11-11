// Every sentence the free tier shows a member (the Product Designer's draft, `~/ma-coord/design-drafts/free-tier/`), word
// for word, and pure, so each has a test. Tier names come from the setting and stand on their own, with no article,
// plural or possessive (tiers.md section 2). No counts, prices, dates or dollars here but the meter's own numbers.
import { formatReset, keepsWorking, type Clock } from '../bandwidth/meter';
import type { BrowserTime, Trial } from './wire';

/** The heads-up comes this many minutes before the day's Browser time is used up (the draft's 10, the Designer's review: "time to wrap up" at any dial setting). */
export const HEADS_UP_MINUTES = 10;

const minutes = (seconds: number): number => Math.floor(seconds / 60);

/**
 * "midnight" when the reset is the coming midnight in this browser's zone, which is the member's own; otherwise the time
 * as the meter writes it ("Tue 1:00 AM"), so a member in another zone than their account's never reads a wrong midnight.
 */
export function resetWord(iso: string, c: Clock): string {
  const at = Date.parse(iso);
  const opts = c.timeZone ? { timeZone: c.timeZone } : {};
  const fmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts });
  const parts = (t: number): Record<string, string> => Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));
  const r = parts(at);
  const midnight = r['hour'] === '00' && r['minute'] === '00';
  // The coming midnight: the reset is a midnight, and no more than a day away.
  return midnight && at > c.now && at - c.now <= 86_400_000 + 3_600_000 ? 'midnight' : formatReset(iso, c);
}

/** The meter's accessible name, which carries the numbers. */
export function meterLabel(t: BrowserTime, c: Clock): string {
  return `Browser time today: ${minutes(t.usedSeconds)} of ${minutes(t.limitSeconds)} minutes used. Resets at ${resetWord(t.resetsAt, c)}.`;
}

/** The panel's numbers: "19 of 45 minutes used". The ring shows what's left, so without "used" it read as time left (the free walk's L12). */
export const meterNumbers = (t: BrowserTime): string => `${minutes(t.usedSeconds)} of ${minutes(t.limitSeconds)} minutes used`;

/** The panel's and the pause's one line about the next tier: the smallest step that removes the day's limit. */
export const noDailyLimit = (alliance: string): string => `${alliance} has no daily limit`;

/**
 * The heads-up (row 6): information, not a pitch, so no link. It says the minutes really left, so a member who arrives
 * with less than 10 hears how many; at 10 it's the draft's words.
 */
export function headsUpText(t: BrowserTime, c: Clock): string {
  const left = Math.ceil(Math.max(0, t.limitSeconds - t.usedSeconds) / 60);
  return `${left} ${left === 1 ? 'minute' : 'minutes'} of Browser time left today. Resets at ${resetWord(t.resetsAt, c)}.`;
}

/** The paused Browser (row 7), in the window, in place of the picture. Only apps the member has are named. */
export function pausedWords(resetsAt: string, c: Clock): { title: string; body: string } {
  return {
    title: `The Browser is paused until ${resetWord(resetsAt, c)}`,
    body: `That's today's free Browser time. ${keepsWorking()}, and your tabs are safe.`,
  };
}

/** A busy time (row 8), once a day, only when the desk itself says it's held back. */
export const BUSY_LINE = 'Free desks share more, so busy times can be slower.';

export const SEE_MEMBERSHIP = 'See membership';
/** Said with every link that opens the membership page, which opens in its own tab so no window is lost. */
export const NEW_TAB = ' (opens in a new tab)';

/** Maia asleep with her trial (row 3), and its end (row 9). Never money but the trial's own "$1", never a date. */
export const TRIAL_OFFER = 'Maia knows your office and can help with it. Try her free for a week, or up to $1 of her time, whichever ends first.';
export const TRIAL_START = 'Start the week';
export const TRIAL_NOT_NOW = 'Not now';
export const TRIAL_ENDED = "That was Maia's week. She comes with every membership.";

/** The one notice when a membership starts (the upgrade), which names no tier. */
export const UPGRADED = 'Your membership has started. Your desk keeps everything, with more room now.';
export const UPGRADED_WORK = 'Your membership has started. This desk keeps everything, and your Work desk is on its way.';

/**
 * The usage panel's one line about Maia's trial, under the numbers (the Designer's Nov 9 note: the trial's setup step moved,
 * the line stays here). Unused, active with its date, ended; none where she isn't open to the member (`off`, or no trial block).
 */
export function trialLine(t: Trial | null, c: Clock): string | null {
  if (!t || t.status === 'off') return null;
  if (t.status === 'unused') return 'Maia: free for a week or up to $1, starting with your first message';
  if (t.status === 'ended') return 'Maia: trial ended';
  if (!t.endsAt) return 'Maia: free trial';
  const opts = c.timeZone ? { timeZone: c.timeZone } : {};
  return `Maia: free trial until ${new Intl.DateTimeFormat(c.locale, { month: 'short', day: 'numeric', ...opts }).format(Date.parse(t.endsAt))}`;
}
