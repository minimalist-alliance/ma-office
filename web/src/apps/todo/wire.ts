// Every reply from a desk's `todo.*` (deskd API.md §22), read field by field. A field that's missing or the wrong type takes a
// safe default, and an item without an id or a title is dropped, so a desk that sends less (an older deskd) or more (a newer
// one) never breaks the window. Every string here is desk content: shown as plain text only, never as HTML or a link
// (`source.ref.url` included, which only ever goes to the desk's own Browser).
import type { SourceKind, TodoChanges, TodoDue, TodoEvent, TodoGroup, TodoItem, TodoListResult, TodoOp, TodoSource, TodoState, TodoSuggestion, TodoSummary } from './types';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const KINDS: readonly SourceKind[] = ['member', 'courier', 'notebook', 'browser', 'files', 'agent_chat', 'desk'];
const OPS: readonly TodoOp[] = ['add', 'edit', 'close', 'reopen', 'snooze', 'pin', 'suggest', 'answer', 'merge', 'trash', 'restore', 'undo', 'seen', 'remove'];
const GROUPS: readonly TodoGroup[] = ['overdue', 'today', 'upcoming', 'no_date', 'snoozed'];
const STATES: readonly TodoState[] = ['open', 'done', 'not_needed'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Format characters (bidi controls and isolates, ALM, zero-width spaces, the BOM, tag characters), controls, the Hangul fillers
 * and the variation selectors out of anything shown, as Courier's store cleans its text (API.md §21): only the joiners scripts
 * and emoji need (U+200C, U+200D) and the emoji's own selectors (U+FE0E, U+FE0F) stay, and newlines only where `lines` says (a
 * note). The office's `displayText` rule, so desk text (an email's sender and subject, an agent's reason) can't reorder the line
 * or hide what it says (Security's TDA-L1, TDA-I6).
 */
const HIDDEN = /(?![\u200c\u200d])[\p{Cf}\p{Cc}\u115f\u1160\u3164\uffa0\ufe00-\ufe0d\u{e0100}-\u{e01ef}]/gu;
export const plain = (s: string, lines = false): string => (lines ? s.split('\n').map((l) => l.replace(HIDDEN, '')).join('\n') : s.replace(HIDDEN, ''));

export function readDue(v: unknown): TodoDue | null {
  const o = obj(v);
  if (!o) return null;
  const date = str(o['date']);
  if (!DATE.test(date)) return null;
  const time = str(o['time']);
  return { date, time: TIME.test(time) ? time : null, by: str(o['by'], 'member') };
}

export function readSource(v: unknown): TodoSource {
  const o = obj(v);
  const kind = str(o?.['kind']) as SourceKind;
  const at = numOrNull(o?.['at']);
  return { kind: KINDS.includes(kind) ? kind : 'member', ref: obj(o?.['ref']), label: plain(str(o?.['label'])).slice(0, 120), ...(at !== null ? { at } : {}) };
}

function readSuggestion(v: unknown): TodoSuggestion | null {
  const o = obj(v);
  if (!o) return null;
  const as = o['as'] === 'not_needed' ? 'not_needed' : o['as'] === 'done' ? 'done' : null;
  if (!as) return null;
  return { as, by: str(o['by'], 'agent:'), reason: plain(str(o['reason'])).slice(0, 200), at: num(o['at']), untrusted: o['untrusted'] === true };
}

function readClosed(v: unknown): { at: number; by: string } | null {
  const o = obj(v);
  return o ? { at: num(o['at']), by: str(o['by'], 'member') } : null;
}

/** One item, or null if it can't be one. `byName` is read if a desk sends one (§22 doesn't yet): an agent maker that may have gone since. */
export function readItem(v: unknown): (TodoItem & { byName: string | null }) | null {
  const o = obj(v);
  const id = str(o?.['id']);
  const title = str(o?.['title']);
  if (!o || !id || !title) return null;
  const state = str(o['state']) as TodoState;
  const group = str(o['group']) as TodoGroup;
  const note = str(o['note']);
  const byName = str(o['byName']);
  return {
    id,
    rev: num(o['rev']),
    title: plain(title),
    note: note ? plain(note, true) : null,
    due: readDue(o['due']),
    state: STATES.includes(state) ? state : 'open',
    closed: readClosed(o['closed']),
    snoozedUntil: numOrNull(o['snoozedUntil']),
    pinned: o['pinned'] === true,
    by: str(o['by'], 'member'),
    byName: byName ? plain(byName).slice(0, 60) : null,
    source: readSource(o['source']),
    alsoFrom: Array.isArray(o['alsoFrom']) ? o['alsoFrom'].slice(0, 5).map(readSource) : [],
    mergeCount: num(o['mergeCount']),
    untrusted: o['untrusted'] === true,
    suggestion: readSuggestion(o['suggestion']),
    // A desk that doesn't say counts it as seen, so nothing is called new by mistake.
    seen: o['seen'] !== false,
    group: GROUPS.includes(group) ? group : null,
    createdAt: num(o['createdAt']),
    updatedAt: num(o['updatedAt']),
    trashedAt: numOrNull(o['trashedAt']),
  };
}

export type WireItem = TodoItem & { byName: string | null };
const items = (v: unknown): WireItem[] => (Array.isArray(v) ? v.map(readItem).filter((i): i is WireItem => i !== null) : []);

/** The browser's own zone, for a desk that doesn't say its own. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** A zone a desk names, if this browser knows it; else UTC, the desk's own default until it knows one (§22). */
function zone(v: unknown): string {
  const z = str(v);
  if (!z) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: z });
    return z;
  } catch {
    return 'UTC';
  }
}

export function readList(v: unknown): Omit<TodoListResult, 'items'> & { items: WireItem[] } {
  const o = obj(v) ?? {};
  const footer = obj(o['footer']) ?? {};
  const today = str(o['today']);
  return {
    items: items(o['items']),
    next: str(o['next']) || null,
    rev: num(o['rev']),
    more: Math.max(0, num(o['more'])),
    newFromAgents: Math.max(0, num(footer['newFromAgents'])),
    toConfirm: Math.max(0, num(footer['toConfirm'])),
    today: DATE.test(today) ? today : '',
    zone: zone(o['zone']),
  };
}

export function readSummary(v: unknown): TodoSummary {
  const o = obj(v) ?? {};
  const n = (k: string): number => Math.max(0, Math.floor(num(o[k])));
  const today = str(o['today']);
  return {
    open: n('open'),
    needsYou: n('needsYou'),
    overdue: n('overdue'),
    dueToday: n('dueToday'),
    newFromAgents: n('newFromAgents'),
    toConfirm: n('toConfirm'),
    badge: n('badge'),
    rev: n('rev'),
    today: DATE.test(today) ? today : '',
    zone: zone(o['zone']),
  };
}

export function readEvent(v: unknown): TodoEvent | null {
  const o = obj(v);
  const id = str(o?.['id']);
  if (!o || !id) return null;
  const op = str(o['op']) as TodoOp;
  return { id, at: num(o['at']), actor: str(o['actor'], str(o['by'], 'member')), op: OPS.includes(op) ? op : 'edit', before: obj(o['before']), after: obj(o['after']) };
}

export function readGet(v: unknown): { item: WireItem | null; events: TodoEvent[] } {
  const o = obj(v) ?? {};
  return { item: readItem(o['item']), events: Array.isArray(o['events']) ? o['events'].map(readEvent).filter((e): e is TodoEvent => e !== null) : [] };
}

export function readChanges(v: unknown): TodoChanges {
  const o = obj(v) ?? {};
  const changes = Array.isArray(o['changes'])
    ? o['changes'].flatMap((c) => {
        const x = obj(c);
        const id = str(x?.['id']);
        return x && id ? [{ rev: num(x['rev']), id, op: str(x['op']) }] : [];
      })
    : [];
  return { changes, rev: num(o['rev']), reset: o['reset'] === true };
}
