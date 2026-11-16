// Maia Mode's pure rules (CONCEPT.md §2, §3; the owner's multiple-choice requirement): what the To-do column shows (at most
// three things, at most one "Now", the rest under Later), which To-do items need the member now, what a choice set says and
// how an answer reads, the layout's breakpoints. No model and no desk-written word decides any of it.
import type { AttentionItem, ChoiceAnswer, ChoiceSet, Go, MaiaAllowance, RoomMessage } from './source';
import { CREDITS, creditsWords, dueWords } from './words';

/**
 * Format characters (bidi controls and isolates, ALM, zero-width spaces, soft hyphens, the BOM, tag characters), controls, the
 * Hangul fillers and the variation selectors: To-do's rule (`apps/todo/wire.ts`, Security's TDA-L1 and TDA-I6), which keeps only
 * the joiners scripts and emoji need (U+200C, U+200D) and the emoji's own selectors (U+FE0E, U+FE0F).
 */
const HIDDEN = /(?![\u200c\u200d])[\p{Cf}\p{Cc}\u115f\u1160\u3164\uffa0\ufe00-\ufe0d\u{e0100}-\u{e01ef}]/gu;

const DAY_MS = 86_400_000;

/** The member's calendar day of `at` in `timeZone`, as a day count, so two instants compare by day there. */
export function dayOf(at: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at);
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(n('year'), n('month') - 1, n('day')) / DAY_MS);
}

/**
 * When the month's Maia credits renew, as a date in the member's own zone and locale, never a countdown: "December 1", or
 * "tomorrow"; later today it's the time ("5:00 PM"), with `at` for the words that need it. Null for one it can't read or that's
 * past.
 */
export function renewWhen(resetsAt: unknown, now: number, locale?: string, timeZone?: string): { date: string; today: boolean } | null {
  const at = typeof resetsAt === 'string' && resetsAt.length <= 40 ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  try {
    const days = dayOf(at, timeZone) - dayOf(now, timeZone);
    if (days <= 0) return { date: new Intl.DateTimeFormat(locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(at).replace(/\s+/g, '\u00a0'), today: true };
    if (days === 1) return { date: 'tomorrow', today: false };
    return { date: new Intl.DateTimeFormat(locale, { timeZone, month: 'long', day: 'numeric' }).format(at), today: false };
  } catch {
    return null;
  }
}

/**
 * The column foot's lines for Maia's allowance (the owner, Nov 15): never money, never a countdown. With credits: what's left of
 * the month's and when they renew; then one line, the lighter model's when she's on it, else where she's drawing from when today's
 * share is used (pace only). A tier that shares its allowance: the share left. The member's own day cap, when they set one.
 */
export function allowanceLines(a: MaiaAllowance | null, now: number, locale?: string, timeZone?: string): { left: string | null; detail?: string | null; note: string | null; cap: string | null } {
  if (!a) return { left: null, note: null, cap: null };
  const n = (v: number): string => creditsWords(v, locale);
  const renews = renewWhen(a.resetsAt, now, locale, timeZone);
  let left: string | null = null;
  let note: string | null = null;
  const c = a.credits;
  if (c && c.left !== undefined && c.left !== null) {
    // The member's one wallet (0.4.10): what's left and its renewal, then its parts, then one line of pace or the lighter model.
    const parts = [c.month > 0 ? CREDITS.walletMonth(n(c.monthLeft), n(c.month)) : null, (c.starting ?? 0) > 0 ? CREDITS.walletStarting(n(c.starting ?? 0)) : null, c.topUpLeft > 0 ? CREDITS.walletTopUp(n(c.topUpLeft)) : null].filter((x): x is string => !!x);
    left = CREDITS.wallet(n(c.left)) + (renews && c.month > 0 ? ` · ${CREDITS.renews(renews.today ? `at ${renews.date}` : renews.date)}` : '');
    if (c.drawingFrom === 'none') note = CREDITS.walletNone;
    else if (a.lighter) note = CREDITS.walletLighter(renews && c.month > 0 ? renews.date : null);
    else if (c.drawingFrom === 'week') note = CREDITS.walletWeek;
    else if (c.drawingFrom === 'month') note = CREDITS.walletMonthNote;
    else if (c.drawingFrom === 'starting') note = CREDITS.walletFromStarting(n(c.starting ?? 0));
    else if (c.drawingFrom === 'topUp') note = CREDITS.walletFromTopUp(n(c.topUpLeft));
    return { left, detail: parts.length ? parts.join(' · ') : null, note, cap: a.cap !== null ? CREDITS.cap(n(a.today), n(a.cap)) : null };
  }
  if (a.credits) {
    left = CREDITS.left(n(a.credits.monthLeft), n(a.credits.month)) + (renews ? ` · ${CREDITS.renews(renews.today ? `at ${renews.date}` : renews.date)}` : '');
    if (a.lighter) note = CREDITS.lighter(renews ? renews.date : 'your credits renew');
    else if (a.credits.drawingFrom === 'week') note = CREDITS.week;
    else if (a.credits.drawingFrom === 'month') note = CREDITS.month;
    else if (a.credits.drawingFrom === 'topUp') note = CREDITS.topUp(n(a.credits.topUpLeft));
  } else if (a.fraction !== null) {
    left = CREDITS.share(a.usedUp ? 0 : Math.floor(a.fraction * 100));
  }
  return { left, note, cap: a.cap !== null ? CREDITS.cap(n(a.today), n(a.cap)) : null };
}

/** Desk-written text as the room shows it: plain, one line, nothing hidden, at most `max` characters (CONCEPT.md §3). */
export function plain(raw: unknown, max = 60): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/\s+/g, ' ').replace(HIDDEN, '').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** One line of the column, whoever it came from: the runtime's attention rules, or a desk's To-do. */
export interface ColumnItem {
  id: string;
  urgency: 'now' | 'next' | 'later';
  deskId: string;
  deskName: string;
  title: string;
  meta: string | null;
  /** What its one button does: the viewport, a line of her chat, the desk's own wake, or nothing (no button). */
  go: Go;
  label: 'Review' | 'Show me' | 'Wake' | null;
  /** For order within an urgency: what's due or asked first, first. */
  at: number;
}

export interface Column {
  now: ColumnItem | null;
  next: ColumnItem[];
  later: ColumnItem[];
}

/**
 * At most `visible` items (the setting's 3, CONCEPT.md §3), only one of them Now: the earliest. A second Now waits as Next, the
 * first of them; whatever doesn't fit goes under Later. Later items are never shown as lines, only counted.
 */
export function arrange(items: readonly ColumnItem[], visible = 3): Column {
  const byAt = (a: ColumnItem, b: ColumnItem): number => a.at - b.at || a.id.localeCompare(b.id);
  const nows = items.filter((i) => i.urgency === 'now').sort(byAt);
  const now = nows[0] ?? null;
  const nexts = [...nows.slice(1), ...items.filter((i) => i.urgency === 'next').sort(byAt)];
  const room = Math.max(0, Math.min(5, visible) - (now ? 1 : 0));
  return { now, next: nexts.slice(0, room), later: [...nexts.slice(room), ...items.filter((i) => i.urgency === 'later').sort(byAt)] };
}

/** What the collapsed edge counts: the open items, Now plus Next (§2). */
export const openCount = (c: Column): number => (c.now ? 1 : 0) + c.next.length;

/** The Later line's quiet words: "Later · 2", and what waits, by title (the desk's count and lines where it gives them). */
export function laterLine(c: Column, desk: { count: number; lines: string[] } | null): { count: string; lines: string[] } | null {
  const count = (desk?.count ?? 0) + c.later.length;
  if (!count) return null;
  return { count: `Later · ${count}`, lines: [...(desk?.lines ?? []).map((l) => plain(l, 60)), ...c.later.map((i) => i.title)].slice(0, 2) };
}

const APPROVAL_KINDS = new Set(['approval', 'limit', 'cap', 'desk_failed']);

/** The runtime's attention items as column lines, with the desk's name from the office's own list. */
export function fromAttention(items: readonly AttentionItem[], deskName: (id: string) => string | null): ColumnItem[] {
  return items.flatMap((a) => {
    const name = deskName(a.deskId);
    if (name === null) return []; // not a desk this office lists: nothing shows
    return [{
      id: `a:${a.id}`, urgency: a.urgency, deskId: a.deskId, deskName: name, title: plain(a.title), meta: a.meta === null ? null : plain(a.meta, 80),
      go: a.go, label: a.go.kind === 'none' ? null : a.go.kind === 'wake' ? 'Wake' : APPROVAL_KINDS.has(a.kind) ? 'Review' : 'Show me', at: a.at,
    }];
  });
}

/** The pieces of a To-do item the column reads (`apps/todo/types.ts`). */
export interface TodoLike {
  id: string;
  title: string;
  due: { date: string; time: string | null } | null;
  pinned: boolean;
}

/** Minutes from `now` until `date` `time` in the desk's zone, or null with no time. */
export function minutesUntil(due: { date: string; time: string | null }, now: number, zone: string): number | null {
  if (!due.time) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const today = `${parts['year']}-${parts['month']}-${parts['day']}`;
  const days = Math.round((Date.parse(`${due.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  const [h = 0, m = 0] = due.time.split(':').map(Number);
  return days * 1440 + h * 60 + m - (Number(parts['hour']) * 60 + Number(parts['minute']));
}

/** Within this many minutes of its time, a to-do is the member's one Now (CONCEPT.md §6, VISION §5): code, from `due`. */
export const NOW_WITHIN_MIN = 120;

/**
 * One desk's To-do in the column (To-do's Needs you, the app's short list): the item due within two hours, if any, as a Now
 * (its own title); everything else that needs the member there as one Next line ("3 to-dos on Work"), or new items from agents
 * ("2 new to-dos on Work"). Titles are untrusted plain text; words like "URGENT" change nothing.
 */
export function todoItems(desk: { id: string; name: string }, needs: readonly TodoLike[], fresh: number, now: number, zone: string): ColumnItem[] {
  const out: ColumnItem[] = [];
  let soonest: { item: TodoLike; mins: number } | null = null;
  for (const item of needs) {
    const mins = item.due ? minutesUntil(item.due, now, zone) : null;
    if (mins !== null && mins >= 0 && mins <= NOW_WITHIN_MIN && (!soonest || mins < soonest.mins)) soonest = { item, mins };
  }
  if (soonest) {
    out.push({
      id: `t:${desk.id}:${soonest.item.id}`, urgency: 'now', deskId: desk.id, deskName: desk.name, title: plain(soonest.item.title), meta: dueWords(soonest.mins),
      go: { kind: 'view', app: 'todo', ref: soonest.item.id }, label: 'Show me', at: now + soonest.mins * 60_000,
    });
  }
  const rest = needs.filter((i) => i.id !== soonest?.item.id);
  if (rest.length === 1 && rest[0]) {
    out.push({ id: `t:${desk.id}`, urgency: 'next', deskId: desk.id, deskName: desk.name, title: plain(rest[0].title), meta: `To-do on ${desk.name}`, go: { kind: 'view', app: 'todo', ref: null }, label: 'Show me', at: now });
  } else if (rest.length > 1) {
    out.push({ id: `t:${desk.id}`, urgency: 'next', deskId: desk.id, deskName: desk.name, title: `${rest.length} to-dos need you on ${desk.name}`, meta: plain(rest[0]?.title, 60) || null, go: { kind: 'view', app: 'todo', ref: null }, label: 'Show me', at: now });
  } else if (fresh > 0) {
    out.push({ id: `t:${desk.id}`, urgency: 'next', deskId: desk.id, deskName: desk.name, title: `${fresh} new ${fresh === 1 ? 'to-do' : 'to-dos'} on ${desk.name}`, meta: 'From your desk agents', go: { kind: 'view', app: 'todo', ref: null }, label: 'Show me', at: now });
  }
  return out;
}

// ----- her choices

/** The set a member can still answer: the latest message of hers, if it has choices nobody answered and nothing came after. */
export function openChoices(messages: readonly RoomMessage[]): { message: RoomMessage; set: ChoiceSet } | null {
  const last = messages[messages.length - 1];
  if (!last || last.from !== 'maia' || !last.choices || last.choices.answered) return null;
  const options = last.choices.options.filter((o) => plain(o.label, 40) !== '').slice(0, 4);
  if (options.length < 2) return null; // fewer than two isn't a choice
  return { message: last, set: { ...last.choices, options } };
}

/** How a member's answer reads in the chat's record of the set. */
export function answerWords(set: ChoiceSet, a: ChoiceAnswer | null): string | null {
  if (!a) return null;
  if (a.kind === 'option') return plain(set.options.find((o) => o.id === a.id)?.label, 40) || null;
  if (a.kind === 'other') return plain(a.text, 120) || null;
  return null;
}

/** An option's accessible name: the first is her pick (her recommendation, the owner's rule). */
export const optionName = (label: string, first: boolean): string => (first ? `${plain(label, 40)}, her pick` : plain(label, 40));

// ----- layout

export type RoomLayout = 'phone' | 'narrow' | 'wide';

/** Phones (under 600 px) have one column; under 1200 px the viewport covers the width; wider, it slides over the right (§2). */
export const layoutFor = (width: number): RoomLayout => (width < 600 ? 'phone' : width < 1200 ? 'narrow' : 'wide');

/** Maia's canvas: about 3x her 64 px bubble on a desktop, smaller with the viewport open, 150 px on a phone (§2, "The `lg` tier"). */
export function maiaSize(layout: RoomLayout, viewport: boolean): number {
  if (layout === 'phone') return 150;
  if (viewport) return layout === 'wide' ? 170 : 96;
  return 214;
}
