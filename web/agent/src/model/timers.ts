// Timers (multi-agent.md section 6) as the member reads and writes them: the schedule in words, the next run, and the
// checks the desk makes, so a form says what's wrong before anything is sent. Times are in the member's zone, the one
// the limits use, never this browser's unless they're the same. The mock uses the same rules, so the demo behaves as
// a desk does. Pure, and tested in timers.test.ts.
import type { AgentCaps, Timer, TimerInput } from '../client/types';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** A one-shot timer is at most a year out. */
export const ONCE_MAX_MS = 366 * DAY;
/** Labels are short: they're a list's row. */
export const LABEL_MAX = 60;
/** A repeat every so many minutes goes up to a week. */
export const EVERY_MAX_MINUTES = 7 * 24 * 60;

/** 1 Monday to 7 Sunday, as the wire has them. */
export const DAYS: readonly { n: number; short: string; long: string }[] = [
  { n: 1, short: 'Mon', long: 'Monday' },
  { n: 2, short: 'Tue', long: 'Tuesday' },
  { n: 3, short: 'Wed', long: 'Wednesday' },
  { n: 4, short: 'Thu', long: 'Thursday' },
  { n: 5, short: 'Fri', long: 'Friday' },
  { n: 6, short: 'Sat', long: 'Saturday' },
  { n: 7, short: 'Sun', long: 'Sunday' },
];

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** A wall clock in `zone`: year, month from 0, day, hour, minute, second, and the weekday 1 Monday to 7 Sunday. */
export interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  wd: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    formats.set(zone, f);
  }
  return f;
}

/** The wall clock at `ms` in `zone`. A zone the browser doesn't know reads as UTC. */
export function wallAt(ms: number, zone: string | null): Wall {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(zone ?? 'UTC').formatToParts(ms);
  } catch {
    parts = format('UTC').formatToParts(ms);
  }
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  return { y: Number(p['year']), mo: Number(p['month']) - 1, d: Number(p['day']), h: Number(p['hour']) % 24, mi: Number(p['minute']), s: Number(p['second']), wd: WEEKDAY[p['weekday'] ?? ''] ?? 1 };
}

/** How far `zone`'s clock is ahead of UTC at `ms`, in ms. */
export function offsetAt(ms: number, zone: string | null): number {
  const w = wallAt(ms, zone);
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

const sameWall = (w: Wall, y: number, mo: number, d: number, h: number, mi: number): boolean => w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;

/**
 * The instant a wall clock in `zone` reads this date and time. Where a clock change repeats it, the first; where one skips it,
 * the first instant after the gap, as the desk runs a timer then (multi-agent.md section 6). `mo` from 0.
 */
export function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, zone: string | null): number {
  const asUtc = Date.UTC(y, mo, d, h, mi);
  const before = offsetAt(asUtc - DAY, zone);
  const after = offsetAt(asUtc + DAY, zone);
  const candidates = [asUtc - before, asUtc - after].sort((a, b) => a - b);
  for (const t of candidates) if (sameWall(wallAt(t, zone), y, mo, d, h, mi)) return t;
  // Skipped: find the change between the two readings, to the minute, and run at it.
  let lo = candidates[0]!;
  let hi = candidates[1]!;
  const was = offsetAt(lo, zone);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (mid === lo) break;
    if (offsetAt(mid, zone) === was) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** `HH:MM`, 24-hour. */
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(time: string): { h: number; mi: number } | null {
  const m = TIME_RE.exec(time);
  return m ? { h: Number(m[1]), mi: Number(m[2]) } : null;
}

/**
 * When a timer runs next, after `now`, in its zone. Null when it won't again: a one-shot timer whose time is past, a disabled
 * one, or a schedule that can't run. A repeat every so many minutes counts from its last run, or from when it was made.
 */
export function nextRun(t: Pick<Timer, 'kind' | 'days' | 'time' | 'everyMinutes' | 'at' | 'enabled' | 'lastAt' | 'createdAt'>, now: number, zone: string | null): number | null {
  if (!t.enabled) return null;
  if (t.kind === 'once') return t.at != null && t.at > now && t.lastAt == null ? t.at : null;
  if (t.everyMinutes != null) {
    const step = t.everyMinutes * MINUTE;
    if (!(step > 0)) return null;
    const from = t.lastAt ?? t.createdAt;
    if (from + step > now) return from + step;
    return from + (Math.floor((now - from) / step) + 1) * step;
  }
  const at = t.time ? parseTime(t.time) : null;
  const days = new Set(t.days ?? []);
  if (!at || !days.size) return null;
  const today = wallAt(now, zone);
  for (let i = 0; i < 9; i += 1) {
    const date = new Date(Date.UTC(today.y, today.mo, today.d + i));
    const wd = ((date.getUTCDay() + 6) % 7) + 1;
    if (!days.has(wd)) continue;
    const when = wallToEpoch(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), at.h, at.mi, zone);
    if (when > now) return when;
  }
  return null;
}

/** `8:00 AM`, as a member reads a clock. */
function clock(h: number, mi: number): string {
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The days in words: "every day", "weekdays", "weekends", or "Mon, Wed and Fri". */
export function daysText(days: readonly number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const key = set.join('');
  if (!set.length) return 'no days';
  if (key === '1234567') return 'every day';
  if (key === '12345') return 'weekdays';
  if (key === '67') return 'weekends';
  if (!set.length) return 'no days';
  const names = set.map((d) => DAYS[d - 1]!.short);
  if (names.length === 1) return `${DAYS[set[0]! - 1]!.long}s`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A schedule in words: "Weekdays at 8:00 AM", "Every 30 minutes", "Once, Mon, Nov 9, 8:00 AM". */
export function scheduleText(t: Pick<Timer, 'kind' | 'days' | 'time' | 'everyMinutes' | 'at'>, zone: string | null): string {
  if (t.kind === 'once') return t.at != null ? `Once, ${whenText(t.at, zone)}` : 'Once';
  if (t.everyMinutes != null) return `Every ${durationText(t.everyMinutes)}`;
  const at = t.time ? parseTime(t.time) : null;
  const days = daysText(t.days ?? []);
  return `${days[0]!.toUpperCase()}${days.slice(1)}${at ? ` at ${clock(at.h, at.mi)}` : ''}`;
}

/** `30 minutes`, `2 hours`, `1 hour 30 minutes`, `1 day`. */
export function durationText(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const part = (n: number, word: string): string => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  return [part(d, 'day'), part(h, 'hour'), part(m, 'minute')].filter(Boolean).join(' ') || '0 minutes';
}

/** A time in the member's zone, with the day: `Mon, Nov 9, 8:00 AM`. */
export function whenText(ms: number, zone: string | null): string {
  const w = wallAt(ms, zone);
  const month = new Date(Date.UTC(w.y, w.mo, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${DAYS[w.wd - 1]!.short}, ${month} ${w.d}, ${clock(w.h, w.mi)}`;
}

/** A timer's last run in words, and what to do next where there is something to do. */
export function lastStateText(state: string | null): string {
  switch (state) {
    case null:
    case undefined:
      return 'Not run yet';
    case 'ok':
      return 'Ran';
    case 'busy':
      return 'Ran a little late: it was busy';
    case 'no_key':
      return 'Skipped: no key. Pick one in Key and model.';
    case 'limit_reached':
      return 'Skipped: a spending limit was reached. See Usage and limits.';
    case 'missed':
      return 'Missed while the desk was off';
    case 'failed':
      return 'Didn’t finish. Its thread says why.';
    case 'paused':
      return 'Paused: agents can’t run on this account right now.';
    case 'over_cap':
      return 'Skipped: more timers than the plan allows. Delete one to start it again.';
    default:
      return state.replace(/_/g, ' ');
  }
}

/** A one-shot timer that has run: it has nothing left to switch on, only a new time to give it. */
export const isFinished = (t: Pick<Timer, 'kind' | 'lastAt'>): boolean => t.kind === 'once' && t.lastAt != null;

/** A zone as a member says it: "Mountain Time" for `America/Denver`, "UTC" for none. The zone's own name where the browser has no word for it. */
export function zoneName(zone: string | null | undefined, at: number = Date.now()): string {
  if (!zone || zone === 'UTC') return 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone.replace(/_/g, ' ');
  } catch {
    return zone.replace(/_/g, ' ');
  }
}

/**
 * The first field the desk would refuse, as its `detail`, or null. The same checks as desk-agent's (multi-agent.md section 6):
 * a label and a prompt; `once` at a time in the next year or in so many minutes; `repeat` on days at a time, or every so many
 * minutes, at least the tier's minimum.
 */
export function timerProblem(t: TimerInput, caps: Pick<AgentCaps, 'promptMax' | 'timerMinMinutes'>, now: number): string | null {
  const label = (t.label ?? '').trim();
  if (!label || label.length > LABEL_MAX) return 'label';
  const prompt = (t.prompt ?? '').trim();
  if (!prompt || prompt.length > caps.promptMax) return 'prompt';
  if (t.kind === 'once') {
    if (t.inMinutes != null) return Number.isInteger(t.inMinutes) && t.inMinutes >= 1 && t.inMinutes * MINUTE <= ONCE_MAX_MS ? null : 'inMinutes';
    if (t.at == null || !Number.isFinite(t.at) || t.at <= now || t.at - now > ONCE_MAX_MS) return 'at';
    return null;
  }
  if (t.kind !== 'repeat') return 'kind';
  const hasEvery = t.everyMinutes != null;
  const hasDays = (t.days?.length ?? 0) > 0 || (t.time ?? '') !== '';
  if (hasEvery === hasDays) return hasEvery ? 'everyMinutes' : 'days';
  if (hasEvery) {
    const n = t.everyMinutes as number;
    return Number.isInteger(n) && n >= caps.timerMinMinutes && n <= EVERY_MAX_MINUTES ? null : 'everyMinutes';
  }
  const days = t.days ?? [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(days).size !== days.length) return 'days';
  if (!parseTime(t.time ?? '')) return 'time';
  return null;
}

/** What the form says for a field the desk (or the form) refused. */
export function timerProblemText(detail: string | null, caps: Pick<AgentCaps, 'promptMax' | 'timerMinMinutes'>): string {
  switch (detail) {
    case 'label':
      return `Give it a name, up to ${LABEL_MAX} characters.`;
    case 'prompt':
      return `Say what it should do, up to ${caps.promptMax} characters.`;
    case 'inMinutes':
      return 'Pick a time from a minute to a year from now.';
    case 'at':
      return 'Pick a time in the future, within a year.';
    case 'everyMinutes':
      return `Every ${caps.timerMinMinutes} minutes is the most often, and once a week the least.`;
    case 'days':
      return 'Pick at least one day.';
    case 'time':
      return 'Pick a time of day.';
    case 'timer_cap':
      return 'This agent has as many timers as it can have.';
    case 'hidden_chars':
      return 'The name or what it asks has hidden characters in it. Remove them and try again.';
    default:
      return 'The desk couldn’t save this timer. Try again.';
  }
}
