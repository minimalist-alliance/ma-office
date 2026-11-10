// What the Files window knows: where it is (a folder, the trash, or a search), the rows there, the drive's numbers. Loads on
// demand, and again when the desk says something changed (`files.changes`) or a session comes back. Late answers to a
// place the member has already left are dropped. Rows are untrusted text, and only ever shown as text.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeskLink, FilesUsage } from '../../desk/deskLink';
import { FilesApi, cannotDoFiles, toFilesError, type FilesError } from './api';
import { baseName, compareEntries, join, listingTouched, parent } from './paths';
import { errorWords, GUILD_WORDS, OLD_DESK_WORDS } from './words';

export type Place = { kind: 'folder'; path: string } | { kind: 'trash' } | { kind: 'search'; q: string };

export interface Row {
  /** Unique in the list: the path, or `trash:<id>`. */
  key: string;
  name: string;
  type: 'file' | 'dir';
  size: number | null;
  mtimeMs: number;
  /** Where it is, from the root. */
  path: string;
  /** Trash rows only. */
  trash?: { id: string; originalPath: string; deletedAt: string; purgeAt: string };
}

export type Load = { state: 'loading' } | { state: 'ready' } | { state: 'error'; words: string; code: string } | { state: 'unsupported'; words: string };

export interface Model {
  api: FilesApi;
  place: Place;
  go(place: Place): void;
  rows: Row[];
  load: Load;
  skipped: number;
  truncated: boolean;
  usage: FilesUsage | null;
  reload(): void;
  reloadUsage(): void;
  /** Rows added by the client before the desk's list comes (an upload that landed, a folder just made). */
  note(row: Row): void;
}

const keyOf = (path: string): string => path;

export function useFilesModel(link: DeskLink, idem: () => string, session: number, onUnsupported?: () => void): Model {
  const api = useMemo(() => new FilesApi(link, idem), [link, idem]);
  const [place, setPlace] = useState<Place>({ kind: 'folder', path: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [skipped, setSkipped] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [usage, setUsage] = useState<FilesUsage | null>(null);
  const token = useRef(0);
  const placeRef = useRef(place);
  placeRef.current = place;

  const fetchPlace = useCallback(
    async (p: Place, quiet: boolean): Promise<void> => {
      const mine = ++token.current;
      if (!quiet) setLoad({ state: 'loading' });
      try {
        let next: Row[];
        let skip = 0;
        let cut = false;
        if (p.kind === 'folder') {
          const l = await api.list(p.path);
          next = l.entries.map((e) => ({ key: keyOf(join(p.path, e.name)), name: e.name, type: e.type, size: e.size, mtimeMs: e.mtimeMs, path: join(p.path, e.name) }));
          skip = l.skipped;
        } else if (p.kind === 'trash') {
          const items = await api.trashList();
          next = items.map((t) => ({ key: `trash:${t.id}`, name: t.name, type: t.type, size: t.bytes, mtimeMs: Date.parse(t.deletedAt) || 0, path: t.originalPath, trash: { id: t.id, originalPath: t.originalPath, deletedAt: t.deletedAt, purgeAt: t.purgeAt } }));
        } else {
          const r = await api.search(p.q);
          next = r.entries.map((e) => ({ key: e.path, name: e.name, type: e.type, size: e.size, mtimeMs: e.mtimeMs, path: e.path }));
          cut = r.truncated;
        }
        if (mine !== token.current) return;
        setRows(next);
        setSkipped(skip);
        setTruncated(cut);
        setLoad({ state: 'ready' });
      } catch (err) {
        if (mine !== token.current) return;
        const e: FilesError = toFilesError(err);
        if (e.offline) return; // the window says the desk is away; the list it had stays
        if (cannotDoFiles(e) && p.kind === 'folder' && p.path === '') {
          setLoad({ state: 'unsupported', words: e.code === 'forbidden' ? GUILD_WORDS : OLD_DESK_WORDS });
          onUnsupported?.();
          return;
        }
        setLoad({ state: 'error', words: errorWords(e, 'open that'), code: e.code });
      }
    },
    [api, onUnsupported],
  );

  const reloadUsage = useCallback((): void => {
    api.usage().then(setUsage, () => undefined);
  }, [api]);

  const reload = useCallback((): void => {
    void fetchPlace(placeRef.current, true);
  }, [fetchPlace]);

  // A new place, and a new session, load afresh.
  useEffect(() => {
    void fetchPlace(place, false);
  }, [place, session, fetchPlace]);

  useEffect(() => {
    reloadUsage();
  }, [session, reloadUsage]);

  // The desk says what changed.
  useEffect(() => {
    let timer = 0;
    let usageTimer = 0;
    const off = link.subscribe('files.changes', (m) => {
      if (m.type === 'snapshot') return;
      const here = placeRef.current;
      const touched = m.dirs === null || m.dirs === undefined ? true : here.kind === 'folder' ? listingTouched(m.dirs, here.path) : here.kind === 'search' ? true : false;
      const trashChanged = here.kind === 'trash' && m.trash === true;
      if (touched || trashChanged) {
        window.clearTimeout(timer);
        timer = window.setTimeout(reload, 150);
      }
      if (m.usage !== false) {
        window.clearTimeout(usageTimer);
        usageTimer = window.setTimeout(reloadUsage, 500);
      }
    });
    return () => {
      off();
      window.clearTimeout(timer);
      window.clearTimeout(usageTimer);
    };
  }, [link, session, reload, reloadUsage]);

  const go = useCallback((p: Place): void => {
    setPlace(p);
  }, []);

  const note = useCallback((row: Row): void => {
    setRows((rs) => {
      const here = placeRef.current;
      if (here.kind !== 'folder' || parent(row.path) !== here.path) return rs;
      if (rs.some((r) => r.key === row.key)) return rs;
      return [...rs, row].sort(compareEntries);
    });
  }, []);

  return { api, place, go, rows, load, skipped, truncated, usage, reload, reloadUsage, note };
}

export { baseName };
