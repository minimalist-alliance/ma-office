// Dev and test only, through mockDeskLink.ts (never in a production bundle). One desk's To-do store held in memory and served as
// deskd serves the member's `todo.*` methods and the `todo` topic (services/deskd/docs/API.md §22, `sub/mm-todo-store`'s
// contract): the item's shape, the desk-wide `rev`, the views with deskd's `group`, Needs you's membership, order, five and
// footer, the filters, `todo.changes`, `idem` kept per mutation, `precondition_failed` and the `conflict` reasons, Undo by event,
// and the export over `bulk`. It has no knowledge of the app: the app is tested against it, and it against §22.
import { uuidv7 } from './idem';
import type { MockBulk } from './mockDeskData';
import type { TodoDue, TodoEvent, TodoGroup, TodoItem, TodoOp, TodoSource, TodoSuggestion } from '../apps/todo/types';

export const refusal = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock ${code}`), { code, details });

const DAY_MS = 24 * 3600 * 1000;
const NEEDS_YOU_MAX = 5;
/** Control, format (bidi, zero-width) and other hidden characters: taken out of a title or note (§22). */
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ue000-\uf8ff]/gu;

/** `YYYY-MM-DD` of `ms` in `zone`. */
export function dayIn(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export interface MockTodoControl {
  /** The desk's clock and zone. */
  now: () => number;
  zone: string;
  /** Every method asked, in order. */
  calls: { m: string; p: Record<string, unknown>; idem?: string }[];
  /** The next call of this method refuses with this code (and details), once. */
  failNext: Record<string, string | { code: string; details?: Record<string, unknown> }>;
  /** Every call of this method refuses with this code until it is deleted. */
  refuse: Record<string, string>;
  /** Replies wait this long. */
  delayMs: number;
}

interface Row extends Omit<TodoItem, 'group'> {
  /** When it was pinned: Needs you's order is the latest pin first. */
  pinnedAt: number | null;
  byName: string | null;
}

type Listener = (msg: { type: string; op?: string; id?: string; rev: number }) => void;

const strip = (s: string): string => s.replace(HIDDEN, '');

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw refusal('bad_request', { reason: 'title' });
  const t = strip(raw.replace(/[\r\n\t]+/g, ' ')).trim().replace(/ {2,}/g, ' ');
  const n = [...t].length;
  if (n < 1 || n > 200) throw refusal('bad_request', { reason: 'title' });
  return t;
}

function cleanNote(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw refusal('bad_request', { reason: 'note' });
  const t = strip(raw.replace(/\r\n?/g, '\n')).trim();
  if ([...t].length > 2000) throw refusal('bad_request', { reason: 'note' });
  return t || null;
}

function cleanDue(raw: unknown, by: string): TodoDue | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw refusal('bad_request', { reason: 'due' });
  const { date, time } = raw as { date?: unknown; time?: unknown };
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw refusal('bad_request', { reason: 'due' });
  if (time !== undefined && time !== null && (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw refusal('bad_request', { reason: 'due' });
  return { date, time: typeof time === 'string' ? time : null, by };
}

type Field = 'title' | 'note' | 'due' | 'snoozedUntil' | 'pinned' | 'pinnedAt' | 'state' | 'closed' | 'suggestion' | 'trashedAt' | 'seen' | 'untrusted';
type Patch = Partial<Pick<Row, Field>>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class MockTodoDesk {
  readonly control: MockTodoControl;
  private readonly rows = new Map<string, Row>();
  private readonly events: (TodoEvent & { itemId: string })[] = [];
  private readonly log: { rev: number; id: string; op: string }[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly idems = new Map<string, { key: string; result: unknown }>();
  private rev = 0;

  constructor(readonly deskId: string, control?: Partial<MockTodoControl>) {
    this.control = { now: () => Date.now(), zone: 'America/Denver', calls: [], failNext: {}, refuse: {}, delayMs: 0, ...control };
  }

  today(): string {
    return dayIn(this.control.now(), this.control.zone);
  }

  /** The desk-wide counter's latest. */
  get currentRev(): number {
    return this.rev;
  }

  private bump(row: Row, op: string): void {
    this.rev += 1;
    row.rev = this.rev;
    this.log.push({ rev: this.rev, id: row.id, op });
    for (const fn of [...this.listeners]) fn({ type: 'changed', op, id: row.id, rev: this.rev });
  }

  private event(row: Row, op: TodoOp, actor: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
    this.events.push({ id: uuidv7(this.control.now()), itemId: row.id, at: this.control.now(), actor, op, before, after });
  }

  /** A row put straight in, for the seed and for tests: an `add` event and a change, as deskd records one. */
  put(p: Partial<Row> & { title: string }): TodoItem {
    const at = p.createdAt ?? this.control.now();
    const row: Row = {
      id: p.id ?? uuidv7(at),
      rev: 0,
      title: p.title,
      note: p.note ?? null,
      due: p.due ?? null,
      state: p.state ?? 'open',
      closed: p.closed ?? null,
      snoozedUntil: p.snoozedUntil ?? null,
      pinned: p.pinned ?? false,
      pinnedAt: p.pinned ? (p.pinnedAt ?? at) : null,
      by: p.by ?? 'member',
      byName: p.byName ?? null,
      source: p.source ?? { kind: 'member', ref: null, label: '' },
      alsoFrom: p.alsoFrom ?? [],
      mergeCount: p.mergeCount ?? 0,
      untrusted: p.untrusted ?? false,
      suggestion: p.suggestion ?? null,
      seen: p.seen ?? true,
      createdAt: at,
      updatedAt: p.updatedAt ?? at,
      trashedAt: p.trashedAt ?? null,
    };
    this.rows.set(row.id, row);
    this.event(row, 'add', row.by, null, { title: row.title });
    this.bump(row, 'add');
    return this.wire(row);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private snoozed(row: Row): boolean {
    return row.snoozedUntil !== null && row.snoozedUntil > this.control.now();
  }

  private group(row: Row, today: string): TodoGroup | null {
    if (row.state !== 'open' || row.trashedAt !== null) return null;
    if (this.snoozed(row)) return 'snoozed';
    if (row.due && row.due.date < today) return 'overdue';
    if (row.due?.date === today) return 'today';
    if (row.due) return 'upcoming';
    return 'no_date';
  }

  private wire(row: Row): TodoItem {
    const { pinnedAt: _p, byName: _b, ...item } = row;
    void _p;
    void _b;
    return {
      ...item,
      due: row.due ? { ...row.due } : null,
      closed: row.closed ? { ...row.closed } : null,
      source: { ...row.source },
      alsoFrom: row.alsoFrom.map((s) => ({ ...s })),
      suggestion: row.suggestion ? { ...row.suggestion } : null,
      group: this.group(row, this.today()),
    };
  }

  private row(id: unknown): Row {
    if (typeof id !== 'string' || !UUID.test(id)) throw refusal('bad_request', { reason: 'id' });
    const row = this.rows.get(id);
    if (!row) throw refusal('not_found', { reason: 'item' });
    return row;
  }

  /** Changes `row` by `patch`, records the event (changed fields only), moves `rev`, tells the topic. */
  private change(row: Row, op: TodoOp, patch: Patch, actor = 'member'): Row {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of Object.keys(patch) as Field[]) {
      if (same(row[k], patch[k])) continue;
      before[k] = row[k];
      after[k] = patch[k];
    }
    if (!Object.keys(after).length) return row;
    Object.assign(row, patch);
    row.updatedAt = this.control.now();
    if (actor === 'member' && ('title' in after || 'note' in after)) row.untrusted = false;
    this.event(row, op, actor, before, after);
    this.bump(row, op);
    return row;
  }

  private open(row: Row): boolean {
    return row.state === 'open' && row.trashedAt === null;
  }

  private needsYou(row: Row, today: string): boolean {
    if (!this.open(row) || this.snoozed(row)) return false;
    return (row.due !== null && row.due.date <= today) || row.pinned;
  }

  /** Overdue (oldest first), today with a time (earliest), today, pinned (latest pin first). */
  private needsYouOrder(today: string): (a: Row, b: Row) => number {
    const rank = (r: Row): number => (r.due && r.due.date < today ? 0 : r.due?.date === today ? (r.due.time ? 1 : 2) : 3);
    return (a, b) => {
      const d = rank(a) - rank(b);
      if (d) return d;
      if (rank(a) === 0) return `${a.due!.date} ${a.due!.time ?? ''}`.localeCompare(`${b.due!.date} ${b.due!.time ?? ''}`) || a.createdAt - b.createdAt;
      if (rank(a) === 1) return a.due!.time!.localeCompare(b.due!.time!) || a.createdAt - b.createdAt;
      if (rank(a) === 2) return a.createdAt - b.createdAt;
      return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    };
  }

  private footer(shown: ReadonlySet<string>): { newFromAgents: number; toConfirm: number } {
    const open = [...this.rows.values()].filter((r) => this.open(r));
    return { newFromAgents: open.filter((r) => r.by !== 'member' && !r.seen && !this.snoozed(r) && !shown.has(r.id)).length, toConfirm: open.filter((r) => r.suggestion).length };
  }

  summary(): Record<string, unknown> {
    const today = this.today();
    let open = 0;
    let needsYou = 0;
    let overdue = 0;
    let dueToday = 0;
    for (const r of this.rows.values()) {
      if (!this.open(r)) continue;
      open += 1;
      if (this.needsYou(r, today)) needsYou += 1;
      if (this.snoozed(r)) continue;
      if (r.due && r.due.date < today) overdue += 1;
      else if (r.due?.date === today) dueToday += 1;
    }
    const shown = new Set((this.list({ view: 'needs_you' })['items'] as TodoItem[]).map((i) => i.id));
    return { open, needsYou, overdue, dueToday, ...this.footer(shown), badge: overdue + dueToday, rev: this.rev, today, zone: this.control.zone };
  }

  list(p: Record<string, unknown>): Record<string, unknown> {
    const today = this.today();
    const view = p['view'];
    if (view !== 'needs_you' && view !== 'open' && view !== 'done' && view !== 'trash') throw refusal('bad_request', { reason: 'view' });
    let rows = [...this.rows.values()];
    const order: Record<TodoGroup, number> = { overdue: 0, today: 1, upcoming: 2, no_date: 3, snoozed: 4 };
    if (view === 'trash') rows = rows.filter((r) => r.trashedAt !== null).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
    else if (view === 'done') rows = rows.filter((r) => r.trashedAt === null && r.state !== 'open').sort((a, b) => (b.closed?.at ?? 0) - (a.closed?.at ?? 0));
    else if (view === 'open')
      rows = rows
        .filter((r) => this.open(r))
        .sort((a, b) => {
          const ga = this.group(a, today)!;
          const gb = this.group(b, today)!;
          if (ga !== gb) return order[ga] - order[gb];
          if (ga === 'upcoming') return `${a.due!.date} ${a.due!.time ?? '99'}`.localeCompare(`${b.due!.date} ${b.due!.time ?? '99'}`) || a.createdAt - b.createdAt;
          return a.createdAt - b.createdAt;
        });
    else rows = rows.filter((r) => this.needsYou(r, today)).sort(this.needsYouOrder(today));
    if (view === 'needs_you') {
      const shown = rows.slice(0, NEEDS_YOU_MAX);
      return { items: shown.map((r) => this.wire(r)), next: null, rev: this.rev, today, zone: this.control.zone, more: Math.max(0, rows.length - NEEDS_YOU_MAX), footer: this.footer(new Set(shown.map((r) => r.id))) };
    }
    const by = p['by'];
    if (by !== undefined) {
      if (typeof by !== 'string' || !(by === 'member' || by === 'agents' || /^agent:.+/.test(by))) throw refusal('bad_request', { reason: 'by' });
      rows = rows.filter((r) => (by === 'agents' ? r.by !== 'member' : r.by === by));
    }
    const source = p['source'];
    if (typeof source === 'string') rows = rows.filter((r) => r.source.kind === source);
    const q = p['q'];
    if (q !== undefined) {
      if (typeof q !== 'string' || q.length > 100) throw refusal('bad_request', { reason: 'q' });
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      rows = rows.filter((r) => {
        const have = `${r.title} ${r.note ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
        return words.every((w) => have.some((h) => h.startsWith(w)));
      });
    }
    const limit = p['limit'] === undefined ? 50 : Number(p['limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw refusal('bad_request', { reason: 'limit' });
    const from = p['cursor'] === undefined ? 0 : Number(String(p['cursor']).replace(/^c/, ''));
    if (!Number.isInteger(from) || from < 0) throw refusal('bad_request', { reason: 'cursor' });
    const page = rows.slice(from, from + limit);
    return { items: page.map((r) => this.wire(r)), next: from + limit < rows.length ? `c${from + limit}` : null, rev: this.rev, today, zone: this.control.zone };
  }

  async answer(method: string, params: Record<string, unknown>, idem?: string, bulk?: MockBulk | null): Promise<unknown> {
    this.control.calls.push({ m: method, p: params, ...(idem ? { idem } : {}) });
    if (this.control.delayMs) await new Promise((r) => setTimeout(r, this.control.delayMs));
    const once = this.control.failNext[method];
    if (once) {
      delete this.control.failNext[method];
      throw typeof once === 'string' ? refusal(once) : refusal(once.code, once.details);
    }
    const always = this.control.refuse[method];
    if (always) throw refusal(always);
    const reads = ['todo.list', 'todo.get', 'todo.summary', 'todo.changes', 'todo.export'];
    if (!reads.includes(method)) {
      if (!idem) throw refusal('bad_request', { reason: 'idem' });
      const key = `${method}|${JSON.stringify(params)}`;
      const kept = this.idems.get(idem);
      if (kept) {
        if (kept.key !== key) throw refusal('conflict', { reason: 'idem' });
        return kept.result;
      }
      const result = this.run(method, params, bulk ?? null);
      this.idems.set(idem, { key, result });
      return result;
    }
    return this.run(method, params, bulk ?? null);
  }

  private live(row: Row, method: string): void {
    if (row.trashedAt !== null && method !== 'todo.restore') throw refusal('conflict', { reason: 'trashed' });
  }

  private run(method: string, p: Record<string, unknown>, bulk: MockBulk | null): unknown {
    const now = this.control.now();
    switch (method) {
      case 'todo.list':
        return this.list(p);
      case 'todo.summary':
        return this.summary();
      case 'todo.changes': {
        const since = Number(p['since'] ?? 0);
        const oldest = this.log[0]?.rev ?? this.rev + 1;
        if (since < oldest - 1) return { changes: [], rev: this.rev, reset: true };
        return { changes: this.log.filter((c) => c.rev > since).slice(0, 500), rev: this.rev, reset: false };
      }
      case 'todo.get': {
        const row = this.row(p['id']);
        const events = this.events
          .filter((e) => e.itemId === row.id)
          .slice(-50)
          .reverse()
          .map(({ itemId: _i, ...e }) => (void _i, e));
        return { item: this.wire(row), events };
      }
      case 'todo.add': {
        const open = [...this.rows.values()].filter((r) => this.open(r)).length;
        if (open >= 2000) throw refusal('conflict', { reason: 'cap', which: 'open' });
        const item = this.put({ title: cleanTitle(p['title']), note: cleanNote(p['note']), due: p['due'] === undefined ? null : cleanDue(p['due'], 'member'), pinned: p['pinned'] === true, createdAt: now });
        return { item };
      }
      case 'todo.update': {
        const row = this.row(p['id']);
        this.live(row, method);
        if (row.state !== 'open') throw refusal('conflict', { reason: 'closed' });
        if (p['rev'] !== row.rev) throw refusal('precondition_failed', { reason: 'rev', rev: row.rev });
        const patch: Patch = {};
        if ('title' in p) patch.title = cleanTitle(p['title']);
        if ('note' in p) patch.note = cleanNote(p['note']);
        if ('due' in p) patch.due = cleanDue(p['due'], 'member');
        return { item: this.wire(this.change(row, 'edit', patch)) };
      }
      case 'todo.close': {
        const row = this.row(p['id']);
        this.live(row, method);
        const as = p['as'] === 'not_needed' ? 'not_needed' : p['as'] === 'done' ? 'done' : null;
        if (!as) throw refusal('bad_request', { reason: 'as' });
        if (row.state !== 'open') return { item: this.wire(row) };
        return { item: this.wire(this.change(row, 'close', { state: as, closed: { at: now, by: 'member' }, suggestion: null })) };
      }
      case 'todo.reopen': {
        const row = this.row(p['id']);
        this.live(row, method);
        if (row.state === 'open') return { item: this.wire(row) };
        return { item: this.wire(this.change(row, 'reopen', { state: 'open', closed: null })) };
      }
      case 'todo.snooze': {
        const row = this.row(p['id']);
        this.live(row, method);
        if (row.state !== 'open') throw refusal('conflict', { reason: 'closed' });
        const until = p['until'];
        if (until !== null && (typeof until !== 'number' || until <= now || until > now + 400 * DAY_MS)) throw refusal('bad_request', { reason: 'until' });
        return { item: this.wire(this.change(row, 'snooze', { snoozedUntil: until as number | null })) };
      }
      case 'todo.pin': {
        const row = this.row(p['id']);
        this.live(row, method);
        const on = p['on'] === true;
        return { item: this.wire(this.change(row, 'pin', { pinned: on, pinnedAt: on ? now : null })) };
      }
      case 'todo.answer': {
        const row = this.row(p['id']);
        this.live(row, method);
        if (!row.suggestion) throw refusal('conflict', { reason: 'no_suggestion' });
        const patch: Patch = p['accept'] === true && row.state === 'open' ? { state: row.suggestion.as, closed: { at: now, by: 'member' }, suggestion: null } : { suggestion: null };
        return { item: this.wire(this.change(row, 'answer', patch)) };
      }
      case 'todo.trash': {
        const row = this.row(p['id']);
        this.live(row, method);
        return { item: this.wire(this.change(row, 'trash', { trashedAt: now })) };
      }
      case 'todo.restore': {
        const row = this.row(p['id']);
        return { item: this.wire(this.change(row, 'restore', { trashedAt: null })) };
      }
      case 'todo.undo': {
        const ev = this.events.find((e) => e.id === p['eventId']);
        if (!ev) throw refusal('not_found', { reason: 'event' });
        const row = this.row(ev.itemId);
        if (ev.op === 'add') return { item: this.wire(this.change(row, 'undo', { state: 'not_needed', closed: { at: now, by: 'member' } })) };
        const after = ev.after ?? {};
        for (const [k, v] of Object.entries(after)) if (!same(row[k as Field], v)) throw refusal('conflict', { reason: 'changed' });
        return { item: this.wire(this.change(row, 'undo', (ev.before ?? {}) as Patch)) };
      }
      case 'todo.seen': {
        const ids = p['ids'];
        if (!Array.isArray(ids) || ids.length > 200) throw refusal('bad_request', { reason: 'ids' });
        for (const id of ids) {
          const row = typeof id === 'string' ? this.rows.get(id) : undefined;
          if (row && !row.seen) {
            row.seen = true;
            this.bump(row, 'seen');
          }
        }
        return {};
      }
      case 'todo.export': {
        const format = p['format'];
        if (format !== 'md' && format !== 'json') throw refusal('bad_request', { reason: 'format' });
        const rows = [...this.rows.values()].filter((r) => r.trashedAt === null);
        const text =
          format === 'json'
            ? JSON.stringify({ items: rows.map((r) => ({ ...this.wire(r), events: this.events.filter((e) => e.itemId === r.id).map(({ itemId: _i, ...e }) => (void _i, e)) })) }, null, 2)
            : ['# To-do', '', ...rows.filter((r) => r.state === 'open').map((r) => `- [ ] ${r.title}${r.due ? ` (due ${r.due.date}${r.due.time ? ` ${r.due.time}` : ''})` : ''}`), ...rows.filter((r) => r.state !== 'open').map((r) => `- [x] ${r.title}`), ''].join('\n');
        const bytes = new TextEncoder().encode(text);
        const name = `todo.${format}`;
        if (!bulk) throw refusal('unavailable', { reason: 'bulk' });
        const transferId = bulk.read(name, bytes, 0);
        return { transferId, size: bytes.length, mtimeMs: now, name };
      }
      default:
        throw refusal('not_found');
    }
  }

  /** An agent's "Looks done?", as `todo_close` records one when it may only ask. */
  suggest(id: string, as: 'done' | 'not_needed', by: string, reason: string, untrusted = false): void {
    const row = this.rows.get(id);
    if (!row) return;
    const s: TodoSuggestion = { as, by, reason, at: this.control.now(), untrusted };
    // From a run holding U it marks the item untrusted too (§22).
    this.change(row, 'suggest', untrusted ? { suggestion: s, untrusted: true } : { suggestion: s }, by);
  }

  /** An agent's add, as `todo_add` makes one: stamped, sourced, unseen. */
  agentAdd(p: { title: string; by: string; byName?: string; source: TodoSource; due?: { date: string; time?: string | null } | null; untrusted?: boolean; note?: string }): TodoItem {
    return this.put({ title: cleanTitle(p.title), by: p.by, byName: p.byName ?? null, source: p.source, due: p.due ? { date: p.due.date, time: p.due.time ?? null, by: p.by } : null, untrusted: p.untrusted ?? false, note: p.note ?? null, seen: false });
  }

  /** An agent's change of its own item, as `todo_update` makes one. */
  agentEdit(id: string, by: string, patch: { title?: string; due?: { date: string; time?: string | null } | null }): void {
    const row = this.rows.get(id);
    if (!row) return;
    const p: Patch = {};
    if (patch.title !== undefined) p.title = cleanTitle(patch.title);
    if (patch.due !== undefined) p.due = patch.due ? { date: patch.due.date, time: patch.due.time ?? null, by } : null;
    this.change(row, 'edit', p, by);
  }

  /**
   * The demo desk: the pick sheet's items in Needs you, from its sources, and a few more. The makers are the mock desk's own
   * agents (`manager`, the Lead, and `researcher`), so the window names them from the desk's roster as it does on a real desk:
   * §22 sends `by: "agent:<id>"`, never a name.
   */
  seed(kind: 'personal' | 'work' | 'other'): void {
    const now = this.control.now();
    const today = this.today();
    const at = (h: number): number => now - h * 3600 * 1000;
    if (kind === 'work') {
      this.put({ title: 'Renew the team site’s domain', by: 'agent:researcher', due: { date: addDays(today, -2), time: null, by: 'agent:researcher' }, source: { kind: 'browser', ref: { url: 'https://example.com/renewal' }, label: 'Page on example.com · Renewal notice' }, untrusted: true, createdAt: at(50) });
      this.put({ title: 'Send Sam the Q4 budget numbers', by: 'agent:manager', due: { date: today, time: '15:00', by: 'member' }, source: { kind: 'notebook', ref: { pageId: 'p-q4' }, label: 'Notebook · Q4 planning' }, createdAt: at(20) });
      this.put({ title: 'Book flights for the March offsite', due: { date: addDays(today, 1), time: null, by: 'member' }, createdAt: at(30) });
      this.put({ title: 'Draft the hiring plan', by: 'agent:manager', source: { kind: 'agent_chat', ref: { agentId: 'manager', threadId: 'manager', messageId: 'm-1' }, label: 'Your message to the agent' }, seen: false, createdAt: at(2) });
      this.put({ title: 'Read the vendor contract', by: 'agent:researcher', source: { kind: 'files', ref: { path: 'Contracts/vendor.pdf' }, label: 'vendor.pdf' }, untrusted: true, createdAt: at(5) });
      this.put({ title: 'Archive last year’s invoices', state: 'done', closed: { at: at(26), by: 'member' }, createdAt: at(80) });
      return;
    }
    if (kind === 'personal') {
      this.put({ title: 'Sign and return the lease renewal', by: 'agent:researcher', due: { date: today, time: null, by: 'agent:researcher' }, source: { kind: 'courier', ref: { messageId: 'msg-1', channelId: 'email' }, label: 'Email from Dana Ortiz · Lease renewal for 2027' }, untrusted: true, note: 'Dana needs it back today. The form is attached to the email.', createdAt: at(4) });
      const bill = this.put({ title: 'Pay the October water bill', by: 'agent:researcher', due: { date: addDays(today, 2), time: null, by: 'agent:researcher' }, source: { kind: 'courier', ref: { messageId: 'msg-2', channelId: 'email' }, label: 'Email from City Water · Your October bill' }, untrusted: true, createdAt: at(40) });
      this.suggest(bill.id, 'done', 'agent:researcher', 'found a receipt from City Water, today 7:58', true);
      this.put({ title: 'Confirm the dentist check-up', by: 'agent:researcher', due: { date: addDays(today, 4), time: null, by: 'agent:researcher' }, source: { kind: 'courier', ref: { messageId: 'msg-3', channelId: 'email' }, label: 'Email from Lakeside Dental · Check-up reminder' }, untrusted: true, seen: false, createdAt: at(1) });
      this.put({ title: 'Renew the passport', pinned: true, pinnedAt: at(10), createdAt: at(100) });
      this.put({ title: 'Pick up the framed print', createdAt: at(60) });
      this.put({ title: 'Call the bank about the new card', snoozedUntil: now + DAY_MS, createdAt: at(70) });
      this.put({ title: 'Book the car service', state: 'done', closed: { at: at(22), by: 'member' }, createdAt: at(90) });
      return;
    }
    this.put({ title: 'Look over this week’s notes', due: { date: today, time: null, by: 'member' }, createdAt: at(3) });
  }
}

const desks = new Map<string, MockTodoDesk>();

/** One desk's store, made and seeded the first time it's asked: `d-personal…` and `d-work…` as the pick sheet's, any other with one item. */
export function mockTodo(deskId: string): MockTodoDesk {
  let desk = desks.get(deskId);
  if (!desk) {
    // `window.__maTodoMockInit = { refuse: { 'todo.list': 'not_found' } }` before load: a desk as a deskd before §22 answers.
    const init = (globalThis as { __maTodoMockInit?: { refuse?: Record<string, string> } }).__maTodoMockInit;
    desk = new MockTodoDesk(deskId, init?.refuse ? { refuse: { ...init.refuse } } : {});
    desk.seed(deskId.startsWith('d-personal') ? 'personal' : deskId.startsWith('d-work') ? 'work' : 'other');
    desks.set(deskId, desk);
  }
  return desk;
}

/** `__maDeskMock.todo`: each desk's store, for a test to steer. `empty` puts an empty store on a desk (no seed). */
export const todoControl = {
  desk: (deskId: string): MockTodoDesk => mockTodo(deskId),
  empty: (deskId: string): MockTodoDesk => {
    const desk = new MockTodoDesk(deskId);
    desks.set(deskId, desk);
    return desk;
  },
  all: (): ReadonlyMap<string, MockTodoDesk> => desks,
};
