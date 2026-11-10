// Free Maia (ma-platform ADR 0104): past their allowance, a member keeps her on a free model until it resets. The office
// shows a small line while that lasts, in the member's own time. Pure: the widget passes the clock in. Never names a model.

/** While a turn on free Maia waits for her first words, which can take a while (the eval: about 16 s, up to 2 minutes in a burst). */
export const FREE_WAIT = 'Free Maia is thinking. This can take a minute.';

/** The status line a turn's `start` sets: the wait line on free Maia before any text, otherwise nothing. */
export function startStatus(free: { until: string } | null, textSoFar: string): string | null {
  return free && !textSoFar ? FREE_WAIT : null;
}

/** How often the line is checked while it shows: its words can move from "Tue 5:00 pm" to "5:00 pm", and it goes at the end. */
export const FREE_TICK_MS = 60_000;

/** The reset time while it's still ahead, or null once it has passed or doesn't parse. */
export function freeUntil(until: string | null | undefined, now: number): Date | null {
  if (!until) return null;
  const at = Date.parse(until);
  return Number.isFinite(at) && at > now ? new Date(at) : null;
}

// ICU puts a narrow no-break space before AM and PM; the line itself never wraps (maia.css), so a plain space reads the same.
const time = (d: Date, locale?: string): string => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');
const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * "Free Maia until 5:00 pm" today, "until Tue 5:00 pm" within the week, and "until Dec 1" further out, in local time.
 * Null when there's nothing to show.
 */
export function freeLabel(until: string | null | undefined, now: number, locale?: string): string | null {
  const at = freeUntil(until, now);
  if (!at) return null;
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `Free Maia until ${time(at, locale)}`;
  if (days < 7) return `Free Maia until ${at.toLocaleDateString(locale, { weekday: 'short' })} ${time(at, locale)}`;
  return `Free Maia until ${at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`;
}
