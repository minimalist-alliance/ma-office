// One desk's To-do as the window holds it: Needs you, the open list, the counts, and Done or Trash when they're looked at.
// A whole read on each new session; then the `todo` topic (§22) says what changed, and only that item is read again and patched
// in, with Needs you and the counts (both small) read again with it, so the member's view follows within the bar's 500 ms. A
// later `snapshot` past what's been read (the topic coalesced) asks `todo.changes` from the last `rev` applied. Nothing here
// wakes a desk: it reads only over a session that's already open.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeskLink } from '../../desk/deskLink';
import { rpcTodoClient, toTodoError, type Item, type Listed, type TodoClient } from './client';
import type { TodoSummary } from './types';

export type FeedState = 'idle' | 'loading' | 'ready' | 'error' | 'old';

export interface Feed {
  deskId: string;
  client: TodoClient | null;
  state: FeedState;
  needs: (Listed) | null;
  open: Item[] | null;
  summary: TodoSummary | null;
  done: Item[] | null;
  trash: Item[] | null;
  /** Reads everything again now. */
  reload(): void;
}

export interface Wants {
  done: boolean;
  trash: boolean;
}

const EMPTY = { needs: null, open: null, summary: null, done: null, trash: null } as const;

/** Puts `item` where it belongs in `list` (by `keep`), or takes it out. */
function patch(list: Item[] | null, item: Item, keep: (i: Item) => boolean): Item[] | null {
  if (!list) return list;
  const rest = list.filter((i) => i.id !== item.id);
  return keep(item) ? [...rest, item] : rest;
}

export function useFeed(deskId: string, link: DeskLink | null, open: boolean, idem: () => string, wants: Wants): Feed {
  const [data, setData] = useState<Omit<Feed, 'deskId' | 'client' | 'reload'>>({ state: 'idle', ...EMPTY });
  const [client, setClient] = useState<TodoClient | null>(null);
  const [epoch, setEpoch] = useState(0);
  const wantsRef = useRef(wants);
  wantsRef.current = wants;

  useEffect(() => {
    if (!link || !open) {
      setClient(null);
      return;
    }
    const c = rpcTodoClient(link, idem);
    setClient(c);
    let gone = false;
    let timer: number | null = null;
    let full = false;
    /**
     * The desk-wide `rev` this window has read up to (§22): the topic's events at or under it are old news. Only a whole read
     * moves it to the lists' own `rev`; reading some items moves it only as far as the events it handled, so a late event for
     * another item is never thrown away (Security's TDA-L2).
     */
    let applied = 0;
    let snapshots = 0;
    /** Items to read again, with the newest `rev` an event named for each. */
    const pending = new Map<string, number>();

    const readAll = async (): Promise<void> => {
      setData((d) => ({ ...d, state: d.state === 'ready' ? 'ready' : 'loading' }));
      try {
        const w = wantsRef.current;
        const [needs, summary, openList, done, trash] = await Promise.all([
          c.list({ view: 'needs_you' }),
          c.summary(),
          c.listAll({ view: 'open' }),
          w.done ? c.listAll({ view: 'done' }) : Promise.resolve(null),
          w.trash ? c.listAll({ view: 'trash' }) : Promise.resolve(null),
        ]);
        if (gone) return;
        // As far as the oldest of the three reads: a change that landed between them is still heard (Security's TDA-I7).
        applied = Math.max(applied, Math.min(needs.rev, summary.rev, openList.rev));
        setData((d) => ({ state: 'ready', needs, summary, open: openList.items, done: done?.items ?? (w.done ? d.done : null), trash: trash?.items ?? (w.trash ? d.trash : null) }));
      } catch (e) {
        if (gone) return;
        const code = toTodoError(e).code;
        if (code === 'offline') return;
        setData((d) => ({ ...d, state: code === 'old' ? 'old' : 'error' }));
      }
    };

    const readChanged = async (): Promise<void> => {
      const batch = [...pending];
      pending.clear();
      const ids = batch.map(([id]) => id);
      try {
        // A failed read of one item leaves it as it was (`kept`); only the desk's `not_found` says it's gone.
        const [needs, summary, ...got] = await Promise.all([
          c.list({ view: 'needs_you' }),
          c.summary(),
          ...ids.map((id) => c.get(id).then((g) => g, (e: unknown) => (toTodoError(e).code === 'not_found' ? { item: null, events: [] } : ('kept' as const)))),
        ]);
        if (gone) return;
        applied = Math.max(applied, ...batch.map(([, rev]) => rev));
        setData((d) => {
          let { open: o, done: dn, trash: t } = d;
          got.forEach((g, n) => {
            if (g === 'kept') return;
            const item = g.item;
            if (!item) {
              const id = ids[n];
              o = o?.filter((i) => i.id !== id) ?? null;
              dn = dn?.filter((i) => i.id !== id) ?? null;
              t = t?.filter((i) => i.id !== id) ?? null;
              return;
            }
            o = patch(o, item, (i) => i.state === 'open' && i.trashedAt === null);
            dn = patch(dn, item, (i) => i.state !== 'open' && i.trashedAt === null);
            t = patch(t, item, (i) => i.trashedAt !== null);
          });
          return { ...d, state: 'ready', needs, summary, open: o, done: dn, trash: t };
        });
      } catch {
        // The next event, or the next session, reads again.
      }
    };

    const soon = (): void => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (full) {
          full = false;
          pending.clear();
          void readAll();
        } else if (pending.size) void readChanged();
      }, 80);
    };

    /** Fell behind the topic (a fresh `snapshot` past what's read): `todo.changes` says what moved, or to read it all again. */
    const catchUp = async (): Promise<void> => {
      try {
        const ch = await c.changes(applied);
        if (gone) return;
        if (ch.reset) full = true;
        else for (const x of ch.changes) pending.set(x.id, Math.max(pending.get(x.id) ?? 0, x.rev));
        soon();
      } catch {
        full = true;
        soon();
      }
    };

    void readAll();
    const off = c.watch(
      (msg) => {
        const rev = typeof msg.rev === 'number' ? msg.rev : 0;
        if (msg.type === 'snapshot') {
          snapshots += 1;
          if (snapshots > 1 && rev > applied) void catchUp();
          return;
        }
        if (rev && rev <= applied) return;
        if (msg.id) pending.set(msg.id, Math.max(pending.get(msg.id) ?? 0, rev));
        else full = true;
        soon();
      },
      () => undefined,
    );
    return () => {
      gone = true;
      if (timer !== null) window.clearTimeout(timer);
      off();
    };
  }, [link, open, idem, epoch]);

  // Done and Trash are read the first time they're looked at.
  useEffect(() => {
    if (!client) return;
    let gone = false;
    if (wants.done && data.done === null && data.state === 'ready') void client.listAll({ view: 'done' }).then((r) => !gone && setData((d) => ({ ...d, done: r.items })), () => undefined);
    if (wants.trash && data.trash === null && data.state === 'ready') void client.listAll({ view: 'trash' }).then((r) => !gone && setData((d) => ({ ...d, trash: r.items })), () => undefined);
    return () => {
      gone = true;
    };
  }, [client, wants.done, wants.trash, data.done, data.trash, data.state]);

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  return { deskId, client, reload, ...data };
}
