// One desk's Documents as the window holds it: the place being looked at (with its view), the counts, and the one question
// the desk would ask. A whole read on each new session; then the `docs` topic (§25: ids and counts only, never a title) says
// something changed, and the list and questions are read again a moment later (its events are merged on the desk to at most
// two a second). Nothing here wakes a desk: it reads only over a session that's already open.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeskLink } from '../../desk/deskLink';
import { rpcDocsClient, toDocsError, type DocsClient } from './client';
import type { Counts, Doc, ListView, Place, Question } from './types';

export type FeedState = 'idle' | 'loading' | 'ready' | 'error' | 'old' | 'off';

export interface Feed {
  deskId: string;
  client: DocsClient | null;
  state: FeedState;
  items: Doc[] | null;
  counts: Counts | null;
  end: string | null;
  more: boolean;
  question: Question | null;
  /** The ids the desk last said changed (null: everything), and a counter that moves each time it says so. */
  changed: { ids: string[] | null; n: number };
  /** Reads the list and the questions again now (after the member's own tap), on the same session. */
  refresh(): void;
  /** Starts again from nothing: a new subscription and a whole read. */
  reload(): void;
}

export interface Want {
  place: Place;
  view: ListView | null;
}

export function useDocsFeed(deskId: string, link: DeskLink | null, open: boolean, idem: () => string, want: Want): Feed {
  const [data, setData] = useState<Omit<Feed, 'deskId' | 'client' | 'reload' | 'refresh'>>({ state: 'idle', items: null, counts: null, end: null, more: false, question: null, changed: { ids: null, n: 0 } });
  const [client, setClient] = useState<DocsClient | null>(null);
  const [epoch, setEpoch] = useState(0);
  const wantRef = useRef(want);
  wantRef.current = want;
  const readRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!link || !open) {
      setClient(null);
      return;
    }
    const c = rpcDocsClient(link, idem);
    setClient(c);
    let gone = false;
    let timer: number | null = null;
    let reading = 0;
    let snapshots = 0;

    const readAll = async (): Promise<void> => {
      const mine = (reading += 1);
      const w = wantRef.current;
      setData((d) => ({ ...d, state: d.state === 'ready' ? 'ready' : 'loading' }));
      try {
        const [list, questions] = await Promise.all([c.list({ place: w.place, view: w.view }), c.questions().catch(() => [] as Question[])]);
        if (gone || mine !== reading) return;
        setData((d) => ({ ...d, state: 'ready', items: list.items, counts: list.counts, end: list.end, more: list.more, question: questions[0] ?? null }));
      } catch (e) {
        if (gone || mine !== reading) return;
        const code = toDocsError(e).code;
        if (code === 'offline') return;
        setData((d) => ({ ...d, state: code === 'old' ? 'old' : code === 'switched_off' || code === 'forbidden' ? 'off' : 'error' }));
      }
    };
    readRef.current = () => void readAll();

    const soon = (): void => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void readAll();
      }, 250);
    };

    void readAll();
    const off = c.watch(
      (e) => {
        if (e.type === 'snapshot') {
          snapshots += 1;
          if (e.counts) setData((d) => ({ ...d, counts: e.counts }));
          // The first comes with the subscription; a later one (a new session) may have missed changes.
          if (snapshots > 1) soon();
          return;
        }
        setData((d) => ({ ...d, ...(e.counts ? { counts: e.counts } : {}), changed: { ids: e.ids, n: d.changed.n + 1 } }));
        soon();
      },
      () => undefined,
    );
    return () => {
      gone = true;
      readRef.current = null;
      if (timer !== null) window.clearTimeout(timer);
      off();
    };
  }, [link, open, idem, epoch]);

  // A new place or view: read it now (the session's own first read has the first one).
  const asked = useRef(`${want.place}|${want.view}`);
  useEffect(() => {
    const key = `${want.place}|${want.view}`;
    if (key === asked.current) return;
    asked.current = key;
    readRef.current?.();
  }, [want.place, want.view]);

  const reload = useCallback(() => setEpoch((n) => n + 1), []);
  const refresh = useCallback(() => readRef.current?.(), []);
  return { deskId, client, reload, refresh, ...data };
}
