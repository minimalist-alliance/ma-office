// To-do's pure rules, as the window shows them: what a date says ("Overdue · since Tue", "Today · 3:00 pm"), the All view's
// groups, Done's days, the snooze times in the desk's own zone, and the All desks merge, which happens here in the browser and
// never on a server (the design's §3). Urgency is only dates and the member's own "Keep in Needs you": no words from an item
// change it, and "hot" is the accent blue and weight, never a warning colour.
import type { TodoItem } from './types';

const DAY_MS = 24 * 3600 * 1000;

/** `YYYY-MM-DD` of `ms` in `tz`. */
export function dayIn(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);

const weekday = (date: string): string => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(Date.parse(`${date}T12:00:00Z`));
const monthDay = (date: string, withYear: boolean): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(Date.parse(`${date}T12:00:00Z`));

/** "Thursday, November 12": the heading's date. */
export const longDate = (date: string): string => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${date}T12:00:00Z`));

/** `15:00` as "3:00 pm". */
export function timeWords(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** A day near today in a word: Today, Tomorrow, Yesterday, a weekday within the week, else "Nov 20" (with the year if not this one). */
export function dayWords(date: string, today: string): string {
  const d = daysBetween(today, date);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return weekday(date);
  if (d < -1 && d > -7) return weekday(date);
  return monthDay(date, date.slice(0, 4) !== today.slice(0, 4));
}

export interface When {
  text: string;
  /** Overdue, due today or kept in Needs you: the accent and weight. */
  hot: boolean;
  /** Its group in the All view. */
  group: 'overdue' | 'today' | 'later' | 'none' | 'snoozed';
}

/** What a to-do's date line says. */
export function whenOf(item: Pick<TodoItem, 'due' | 'pinned' | 'snoozedUntil' | 'state'>, today: string, now: number, tz: string): When {
  if (item.snoozedUntil !== null && item.snoozedUntil > now) {
    const day = dayIn(item.snoozedUntil, tz);
    const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(item.snoozedUntil).toLowerCase().replace(/\s/g, ' ');
    return { text: `Snoozed until ${dayWords(day, today) === 'Today' ? at : `${dayWords(day, today)}, ${at}`}`, hot: false, group: 'snoozed' };
  }
  const due = item.due;
  if (due && due.date < today) {
    const since = daysBetween(due.date, today) < 7 ? weekday(due.date) : monthDay(due.date, due.date.slice(0, 4) !== today.slice(0, 4));
    return { text: `Overdue · since ${since}`, hot: true, group: 'overdue' };
  }
  if (due && due.date === today) return { text: due.time ? `Today · ${timeWords(due.time)}` : 'Due today', hot: true, group: 'today' };
  if (due) return { text: due.time ? `${dayWords(due.date, today)} · ${timeWords(due.time)}` : dayWords(due.date, today), hot: false, group: 'later' };
  if (item.pinned) return { text: 'Kept here', hot: true, group: 'none' };
  return { text: '', hot: false, group: 'none' };
}

export interface Group<T> {
  key: string;
  title: string;
  items: T[];
  /** Snoozed starts folded. */
  folded?: boolean;
}

/** The deskd group (§22's `group`) where it said one, else ours from the date. */
const GROUP_OF = { overdue: 'overdue', today: 'today', upcoming: 'later', no_date: 'none', snoozed: 'snoozed' } as const;

/** The All view: Overdue, Today, Coming up (a heading a day), No date, then Snoozed, folded. */
export function groupOpen<T extends Pick<TodoItem, 'due' | 'pinned' | 'snoozedUntil' | 'state' | 'createdAt' | 'group'>>(items: readonly T[], today: string, now: number, tz: string): Group<T>[] {
  const overdue: T[] = [];
  const todays: T[] = [];
  const later = new Map<string, T[]>();
  const none: T[] = [];
  const snoozed: T[] = [];
  for (const it of items) {
    const g = it.group ? GROUP_OF[it.group] : whenOf(it, today, now, tz).group;
    if (g === 'snoozed') snoozed.push(it);
    else if (g === 'overdue') overdue.push(it);
    else if (g === 'today') todays.push(it);
    else if (g === 'later' && it.due) later.set(it.due.date, [...(later.get(it.due.date) ?? []), it]);
    else none.push(it);
  }
  const byDue = (a: T, b: T): number => (a.due?.date ?? '').localeCompare(b.due?.date ?? '') || (a.due?.time ?? '99').localeCompare(b.due?.time ?? '99') || a.createdAt - b.createdAt;
  const out: Group<T>[] = [];
  if (overdue.length) out.push({ key: 'overdue', title: 'Overdue', items: overdue.sort(byDue) });
  if (todays.length) out.push({ key: 'today', title: 'Today', items: todays.sort(byDue) });
  for (const date of [...later.keys()].sort()) out.push({ key: `day:${date}`, title: comingTitle(date, today), items: later.get(date)!.sort(byDue) });
  if (none.length) out.push({ key: 'none', title: 'No date', items: none.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt) });
  if (snoozed.length) out.push({ key: 'snoozed', title: 'Snoozed', items: snoozed.sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0)), folded: true });
  return out;
}

/** A Coming up heading: "Tomorrow", "Friday", or "Thursday, November 26". */
function comingTitle(date: string, today: string): string {
  const d = daysBetween(today, date);
  if (d === 1) return 'Tomorrow';
  const long = (opts: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(Date.parse(`${date}T12:00:00Z`));
  if (d < 7) return long({ weekday: 'long' });
  return long({ weekday: 'long', month: 'long', day: 'numeric', ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
}

/** Done: a heading per day it closed on, newest first. */
export function groupDone<T extends Pick<TodoItem, 'closed'>>(items: readonly T[], today: string, tz: string): Group<T>[] {
  const days = new Map<string, T[]>();
  for (const it of [...items].sort((a, b) => (b.closed?.at ?? 0) - (a.closed?.at ?? 0))) {
    const day = it.closed ? dayIn(it.closed.at, tz) : today;
    days.set(day, [...(days.get(day) ?? []), it]);
  }
  return [...days.entries()].map(([day, list]) => ({ key: `done:${day}`, title: dayWords(day, today) === 'Today' ? 'Today' : dayWords(day, today) === 'Yesterday' ? 'Yesterday' : longDate(day), items: list }));
}

/** UTC ms of the wall time `date` `time` in `tz` (two passes, so a day that changes its offset still lands right). */
export function zonedMs(date: string, time: string, tz: string): number {
  const [y = 1970, mo = 1, d = 1] = date.split('-').map(Number);
  const [h = 0, mi = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (at: number): number => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
      const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - at;
    } catch {
      return 0;
    }
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

export interface SnoozeChoice {
  key: 'later' | 'tomorrow' | 'week';
  label: string;
  until: number;
}

/** Later today (three hours on, on the hour, until 8 pm), Tomorrow morning (9 am), Next week (Monday 9 am), in the desk's zone. */
export function snoozeChoices(now: number, tz: string): SnoozeChoice[] {
  const today = dayIn(now, tz);
  const out: SnoozeChoice[] = [];
  const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (hourNow < 18) {
    const h = Math.min(hourNow + 3, 20);
    out.push({ key: 'later', label: `Later today, ${timeWords(`${h}:00`)}`, until: zonedMs(today, `${String(h).padStart(2, '0')}:00`, tz) });
  }
  const tomorrow = addDays(today, 1);
  out.push({ key: 'tomorrow', label: 'Tomorrow morning', until: zonedMs(tomorrow, '09:00', tz) });
  const dow = new Date(Date.parse(`${today}T12:00:00Z`)).getUTCDay();
  const monday = addDays(today, ((8 - dow) % 7) || 7);
  out.push({ key: 'week', label: `Next week, ${weekday(monday)}`, until: zonedMs(monday, '09:00', tz) });
  return out;
}

/** A day the member picked, at 9 am in the desk's zone. */
export const snoozeUntilDay = (date: string, tz: string): number => zonedMs(date, '09:00', tz);

/** One desk's part of a merged list. */
export interface FromDesk<T> {
  deskId: string;
  items: readonly T[];
  more: number;
  newFromAgents: number;
  toConfirm: number;
}

/**
 * Needs you's order (§22), across desks: overdue (oldest first), today with a time (earliest), today, then kept. Each desk sends
 * its kept ones latest pin first, and that order holds: `at` is the item's place in its own desk's list.
 */
export function needsYouRank(it: Pick<TodoItem, 'due' | 'createdAt'>, today: string, at: number): [number, string, number] {
  if (it.due && it.due.date < today) return [0, `${it.due.date} ${it.due.time ?? ''}`, it.createdAt];
  if (it.due?.date === today && it.due.time) return [1, it.due.time, it.createdAt];
  if (it.due?.date === today) return [2, '', it.createdAt];
  return [3, '', at];
}

/**
 * All desks' Needs you, put together here: each desk's list in the one order, the first five shown, the rest counted. A desk
 * says its own today (its zone), so each item is ranked by its own desk's.
 */
export function mergeNeedsYou<T extends Pick<TodoItem, 'due' | 'createdAt'>>(parts: readonly (FromDesk<T> & { today: string })[], max = 5): { items: (T & { deskId: string })[]; more: number; newFromAgents: number; toConfirm: number } {
  const all = parts.flatMap((p) => p.items.map((it, n) => ({ it: { ...it, deskId: p.deskId }, rank: needsYouRank(it, p.today, n) })));
  all.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1].localeCompare(b.rank[1]) || a.rank[2] - b.rank[2]);
  const more = parts.reduce((n, p) => n + p.more, 0) + Math.max(0, all.length - max);
  return { items: all.slice(0, max).map((x) => x.it), more, newFromAgents: parts.reduce((n, p) => n + p.newFromAgents, 0), toConfirm: parts.reduce((n, p) => n + p.toConfirm, 0) };
}

/** A maker in words: "You", or the agent's name as its desk knows it, else as the item recorded it, else "An agent". */
export function makerName(by: string, rosterName: string | null, byName: string | null): string {
  if (by === 'member') return 'You';
  return rosterName ?? byName ?? 'An agent';
}

/** The agent's id in `agent:<id>`, or null. */
export const agentOf = (by: string | null): string | null => (by && by.startsWith('agent:') ? by.slice(6) || null : null);


/** A title as it's sent: one line, trimmed, at most 200 characters (the desk checks again). */
export const cleanTitle = (s: string): string => [...s.replace(/[\r\n\t]+/g, ' ').trim()].slice(0, 200).join('');
