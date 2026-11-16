// To-do's adapter: the member's `todo.*` methods and the `todo` topic over one desk's link, every reply read through `wire.ts`.
// The wire is deskd's API.md §22. The window talks only to this, so the mock desk (`desk/mockDeskTodo.ts`) and a real deskd are
// the same to it. Each mutation carries one `idem` across a retry of a lost reply (§4; To-do keeps results by `idem` 30 days);
// a `precondition_failed` on `rev` re-reads the item and applies the member's fields again (§22: field by field, last writer wins).
import type { BulkChannel, DeskLink, DeskRpc } from '../../desk/deskLink';
import type { TodoChanges, TodoEvent, TodoListResult, TodoSummary, TodoTopicMessage, TodoView } from './types';
import { readChanges, readGet, readItem, readList, readSummary, type WireItem } from './wire';

export type Item = WireItem;
/** A list's answer with its items as the window reads them. */
export type Listed = Omit<TodoListResult, 'items'> & { items: Item[] };

/**
 * What the desk refused. `code` is deskd's (`bad_request`, `not_found`, `precondition_failed`, `conflict`, `unavailable`), except
 * two the window says apart: `cap` (`conflict` `{reason: "cap"}`) and `old` (a deskd before §22: `not_found` with no reason).
 */
export class TodoError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown> = {}) {
    super(`todo ${code}`);
    this.name = 'TodoError';
    this.code = code;
    this.details = details;
  }
}

export function toTodoError(e: unknown): TodoError {
  if (e instanceof TodoError) return e;
  const o = e as { code?: unknown; details?: unknown; name?: unknown } | null;
  if (o && o.name === 'DeskNotConnected') return new TodoError('offline');
  const raw = typeof o?.code === 'string' ? o.code : 'internal';
  const details = o?.details && typeof o.details === 'object' ? (o.details as Record<string, unknown>) : {};
  const reason = details['reason'];
  const code = raw === 'conflict' && reason === 'cap' ? 'cap' : raw === 'not_found' && reason === undefined ? 'old' : raw;
  return new TodoError(code, details);
}

/** A refusal's `details.reason`, when it gave one. */
export const reasonOf = (e: TodoError): string | null => (typeof e.details['reason'] === 'string' ? e.details['reason'] : null);

export interface ListQuery {
  view: TodoView;
  /** `member`, `agents`, or `agent:<id>`. */
  by?: string;
  source?: string;
  q?: string;
}

export interface Patch {
  title?: string;
  note?: string | null;
  due?: { date: string; time?: string | null } | null;
}

export interface TodoClient {
  readonly deskId: string;
  list(q: ListQuery): Promise<Listed>;
  /** Every page of a view (an open list is 2,000 at most). */
  listAll(q: ListQuery): Promise<Listed>;
  get(id: string): Promise<{ item: Item | null; events: TodoEvent[] }>;
  summary(): Promise<TodoSummary>;
  /** What changed after `since` (the desk-wide `rev`), for a client that fell behind the topic. */
  changes(since: number): Promise<TodoChanges>;
  add(title: string, due?: { date: string; time?: string | null } | null): Promise<Item>;
  /** `base` is the item as the member last saw it: on a stale `rev`, the change goes again on the desk's newest copy. */
  update(base: Item, patch: Patch): Promise<Item>;
  close(id: string, as: 'done' | 'not_needed'): Promise<Item>;
  reopen(id: string): Promise<Item>;
  snooze(id: string, until: number | null): Promise<Item>;
  pin(id: string, on: boolean): Promise<Item>;
  answer(id: string, accept: boolean): Promise<Item>;
  trash(id: string): Promise<Item>;
  restore(id: string): Promise<Item>;
  undo(eventId: string): Promise<Item>;
  seen(ids: readonly string[]): Promise<void>;
  /** The whole To-do as a Markdown checklist or a JSON file. */
  exportFile(format: 'md' | 'json'): Promise<{ name: string; type: string; bytes: Uint8Array }>;
  /** Something changed on this desk: `fn` hears each event. A refusal (an older deskd) is said once. */
  watch(fn: (msg: TodoTopicMessage) => void, onRefused?: (code: string) => void): () => void;
}

type Call = <M extends keyof DeskRpc>(method: M, params?: Record<string, unknown>, options?: { idem?: string; deadlineMs?: number }) => Promise<DeskRpc[M]>;

/** Lost replies are asked again with the same key, three tries; a refusal is final. */
async function mutate<T>(call: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let n = 0; n < 3; n += 1) {
    try {
      return await call();
    } catch (e) {
      last = e;
      const code = (e as { code?: unknown } | null)?.code;
      const lost = code === 'deadline_exceeded' || code === 'cancelled' || (code === 'unavailable' && !(e as { details?: { mayHaveApplied?: boolean } }).details?.mayHaveApplied);
      if (!lost) break;
    }
  }
  throw toTodoError(last);
}

const must = (raw: unknown): Item => {
  const item = readItem((raw as { item?: unknown } | null)?.item);
  if (!item) throw new TodoError('internal');
  return item;
};

/** What a stale write sends again: only the fields the member changed from what they saw, onto the desk's newest copy. */
export function rebase(base: Item, patch: Patch): Patch {
  const out: Patch = {};
  if (patch.title !== undefined && patch.title !== base.title) out.title = patch.title;
  if (patch.note !== undefined && (patch.note ?? null) !== (base.note ?? null)) out.note = patch.note;
  if (patch.due !== undefined) {
    const was = base.due ? `${base.due.date} ${base.due.time ?? ''}` : '';
    const now = patch.due ? `${patch.due.date} ${patch.due.time ?? ''}` : '';
    if (was !== now) out.due = patch.due;
  }
  return out;
}

export function rpcTodoClient(link: DeskLink, idem: () => string): TodoClient {
  const call: Call = (m, p, o) => link.call(m, p, o);
  const write = (method: keyof DeskRpc, params: Record<string, unknown>): Promise<Item> => {
    const key = idem();
    return mutate(() => call(method, params, { idem: key })).then(must);
  };
  const list = async (q: ListQuery, cursor?: string): Promise<Listed> => {
    const params: Record<string, unknown> = { view: q.view };
    if (q.by) params['by'] = q.by;
    if (q.source) params['source'] = q.source;
    if (q.q) params['q'] = q.q;
    if (cursor) params['cursor'] = cursor;
    if (q.view !== 'needs_you') params['limit'] = 100;
    try {
      return readList(await call('todo.list', params));
    } catch (e) {
      throw toTodoError(e);
    }
  };
  const client: TodoClient = {
    deskId: link.deskId,
    list: (q) => list(q),
    async listAll(q) {
      const first = await list(q);
      let next = first.next;
      const all = [...first.items];
      // 2,000 open items is the desk's cap: 20 pages of 100, and a little room.
      for (let pages = 0; next && pages < 30; pages += 1) {
        const page = await list(q, next);
        all.push(...page.items);
        next = page.next;
      }
      return { ...first, items: all, next: null };
    },
    async get(id) {
      try {
        return readGet(await call('todo.get', { id }));
      } catch (e) {
        throw toTodoError(e);
      }
    },
    async summary() {
      try {
        return readSummary(await call('todo.summary', {}));
      } catch (e) {
        throw toTodoError(e);
      }
    },
    async changes(since) {
      try {
        return readChanges(await call('todo.changes', { since }));
      } catch (e) {
        throw toTodoError(e);
      }
    },
    add: (title, due) => write('todo.add', due ? { title, due: { date: due.date, ...(due.time ? { time: due.time } : {}) } } : { title }),
    async update(base, patch) {
      const send = (item: Item, p: Patch): Promise<Item> => write('todo.update', { id: item.id, rev: item.rev, ...p });
      try {
        return await send(base, patch);
      } catch (e) {
        const err = toTodoError(e);
        if (err.code !== 'precondition_failed') throw err;
        const { item: latest } = await client.get(base.id);
        if (!latest) throw new TodoError('not_found');
        const again = rebase(base, patch);
        if (Object.keys(again).length === 0) return latest;
        return send(latest, again);
      }
    },
    close: (id, as) => write('todo.close', { id, as }),
    reopen: (id) => write('todo.reopen', { id }),
    snooze: (id, until) => write('todo.snooze', { id, until }),
    pin: (id, on) => write('todo.pin', { id, on }),
    answer: (id, accept) => write('todo.answer', { id, accept }),
    trash: (id) => write('todo.trash', { id }),
    restore: (id) => write('todo.restore', { id }),
    undo: (eventId) => write('todo.undo', { eventId }),
    async seen(ids) {
      if (!ids.length) return;
      // A mutation (§22), so it carries an `idem` like any other (Security's TDA-L3); a failure is quiet, and the next showing asks again.
      const key = idem();
      await mutate(() => call('todo.seen', { ids: ids.slice(0, 200) }, { idem: key })).catch(() => undefined);
    },
    async exportFile(format) {
      const type = format === 'json' ? 'application/json' : 'text/markdown';
      const name = `to-do.${format}`;
      const bulk = link.bulk();
      if (!bulk) throw new TodoError('offline');
      // Listening before asking: the desk's first CHUNKs can come before its answer does.
      const reader = await readTransfer(bulk);
      try {
        const o = ((await call('todo.export', { format }, { deadlineMs: 30_000 })) ?? {}) as { transferId?: unknown; size?: unknown };
        if (typeof o.transferId !== 'number') throw new TodoError('internal');
        return { name, type, bytes: await reader.take(o.transferId, typeof o.size === 'number' ? o.size : -1) };
      } catch (e) {
        reader.stop();
        throw toTodoError(e);
      }
    },
    watch(fn, onRefused) {
      return link.subscribe('todo', fn, onRefused);
    },
  };
  return client;
}

/**
 * One file's CHUNKs on `bulk` (files.md §5, as §22's export sends them), up to its END (whose 40-byte trailer is the hash and
 * size, not file bytes). It listens from the start and keeps what comes before the transfer's id is known; `take` then gathers
 * that one, crediting as it reads so the desk never waits.
 */
export async function readTransfer(bulk: BulkChannel): Promise<{ take(id: number, size: number): Promise<Uint8Array>; stop(): void }> {
  const { hubOf } = await import('../files/hub');
  const early: [number, boolean, Uint8Array][] = [];
  let on: ((id: number, end: boolean, payload: Uint8Array) => void) | null = null;
  const off = hubOf(bulk).listenChunks((id, _seq, end, payload) => (on ? on(id, end, payload) : early.push([id, end, payload.slice()])));
  return {
    stop: off,
    take: (id, size) =>
      new Promise((resolve, reject) => {
        const parts: Uint8Array[] = [];
        let got = 0;
        const timer = window.setTimeout(() => (off(), reject(new TodoError('deadline_exceeded'))), 60_000);
        // CREDIT in steps of at least 256 KiB past the first window (files.md §5).
        let owed = 0;
        on = (tid, end, payload) => {
          if (tid !== id) return;
          if (end) {
            window.clearTimeout(timer);
            off();
            // An empty END says the transfer failed; a whole one ends with the 40-byte trailer.
            if (payload.length === 0 || (size >= 0 && got !== size)) return reject(new TodoError('internal'));
            const out = new Uint8Array(got);
            let at = 0;
            for (const p of parts) {
              out.set(p, at);
              at += p.length;
            }
            return resolve(out);
          }
          parts.push(payload.slice());
          got += payload.length;
          owed += payload.length;
          if (owed >= 256 * 1024) {
            bulk.credit(id, owed);
            owed = 0;
          }
        };
        for (const [tid, end, payload] of early.splice(0)) on(tid, end, payload);
      }),
  };
}
