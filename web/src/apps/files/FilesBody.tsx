// The Files app itself: its own lazy chunk, so none of it costs a member who hasn't opened the window. It browses the desk's
// own drive (`/data/files`), uploads and downloads over the desk's `bulk` channel, and never shows a byte of any file: no
// previews, only names, sizes and dates. Every action has a key and a button, every change is said in the polite live region,
// and every destructive step asks first (emptying the trash, deleting for good, replacing); moving to the trash is undone
// from the trash.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { HostShell } from '../../agent/AgentWindow';
import type { DeskLink } from '../../desk/deskLink';
import { formatBytes } from '../../export/format';
import { useFree } from '../../free/door';
import { billingUrl } from '../../platform/clientConfig';
import { useSession } from '../../platform/session';
import { chooseImageCheck } from '../../platform/imageCheckClient';
import type { ImageCheck } from '../../platform/imageCheck';
import { FilesApi, FilesError, toFilesError } from './api';
import { fromEntries, entriesOf, fromInput, type Collected } from './collect';
import { ContextMenu, type MenuAt } from './ContextMenu';
import { ConfirmDialog, MoveDialog, NameDialog } from './Dialogs';
import { TransferEngine } from './engine';
import { DRAG_TYPE, FileList, type ListActions } from './FileList';
import { menuItems, type MenuAction } from './menu';
import { baseName, crumbs, join, parent } from './paths';
import { askWhere } from './save';
import { EMPTY_SEL, follow, reconcile, type Sel } from './selection';
import { Tray } from './Tray';
import { useFilesModel, type Place, type Row } from './useFilesModel';
import { EMPTY_FOLDER, EMPTY_SEARCH, EMPTY_TRASH, errorWords, movedToTrashWords, READ_ONLY_WORDS, SKIPPED_NOTE, TRASH_NOTE, usageDetailWords, usageWords, capDetailWords, capNote, capState, capWords, NEW_TAB, SEE_MEMBERSHIP } from './words';
import { daysUntil } from './dates';
import './files.css';

interface Props {
  deskId: string;
  link: DeskLink;
  session: number;
  deskName: string;
  /** The desk can't answer now: the last list stays, dimmed and read-only. */
  offline: boolean;
  parked: boolean;
  shell: HostShell;
}

type Dialog =
  | { kind: 'newFolder' }
  | { kind: 'rename'; row: Row }
  | { kind: 'move'; rows: Row[] }
  | { kind: 'trashForGood'; rows: Row[] }
  | { kind: 'emptyTrash' }
  | { kind: 'replace'; moves: { row: Row; to: string }[] }
  | null;

function UsageLine({ model }: { model: ReturnType<typeof useFilesModel> }) {
  const u = model.usage;
  const driveOf = useFree((s) => s.drive);
  if (!u) return <div className="files-usage" aria-hidden="true" />;
  if (typeof u.capBytes === 'number' && u.capBytes > 0 && typeof u.capUsedBytes === 'number') return <CapLine usage={u} cap={u.capBytes} used={u.capUsedBytes} driveOf={driveOf} />;
  const other = Math.max(0, u.drive.usedBytes - u.files.bytes - u.trash.bytes);
  const total = Math.max(1, u.drive.totalBytes);
  const pct = (n: number): string => `${Math.min(100, (n / total) * 100)}%`;
  const detail = usageDetailWords({ total: u.drive.totalBytes, used: u.drive.usedBytes, files: u.files.bytes, trash: u.trash.bytes, uploadable: u.uploadableBytes, floor: u.floorBytes });
  return (
    <div className="files-usage" data-testid="files-usage" title={detail}>
      <div className="files-usage-bar" role="img" aria-label={detail}>
        <span className="u-files" style={{ width: pct(u.files.bytes) }} />
        <span className="u-trash" style={{ width: pct(u.trash.bytes) }} />
        <span className="u-other" style={{ width: pct(other) }} />
      </div>
      <p data-testid="files-usage-words">{usageWords(u.drive.usedBytes, u.drive.totalBytes)}</p>
    </div>
  );
}

/** A free desk's drive: the cap is the whole bar, and the line is "1.4 GB of 2 GB used" (ADR 0090). Nothing is ever deleted over it. */
function CapLine({ usage: u, cap, used, driveOf }: { usage: NonNullable<ReturnType<typeof useFilesModel>['usage']>; cap: number; used: number; driveOf: (() => { alliance: string; allianceDrive: string | null; href: string | null }) | undefined }) {
  const pct = (n: number): string => `${Math.min(100, (n / cap) * 100)}%`;
  const drive = driveOf?.() ?? null;
  // Over the cap on a free desk is just full: a paid member's is a step down's drive, and says what stays.
  const raw = capState(used, cap);
  const state = raw === 'over' && drive ? 'full' : raw;
  const cfg = useSession((s) => s.config);
  const billing = useSession((s) => s.me?.membership?.billingUrl);
  const upHref = state === 'over' ? billingUrl(cfg, billing) : null;
  const note = capNote(state, drive, { used, cap });
  const detail = capDetailWords({ cap, used, files: u.files.bytes, trash: u.trash.bytes });
  return (
    <div className="files-usage files-cap" data-testid="files-usage" data-cap={state} title={detail}>
      <div className="files-usage-bar" role="img" aria-label={detail}>
        <span className="u-files" style={{ width: pct(u.files.bytes) }} />
        <span className="u-trash" style={{ width: pct(u.trash.bytes) }} />
        <span className="u-other" style={{ width: pct(Math.max(0, used - u.files.bytes - u.trash.bytes)) }} />
      </div>
      <p data-testid="files-usage-words">{capWords(used, cap)}</p>
      {note && (
        <p className="files-cap-note" data-testid="files-cap-note">
          {note}
          {drive?.href && (
            <>
              {' '}
              <a className="files-cap-link" href={drive.href} target="_blank" rel="noopener noreferrer">
                {SEE_MEMBERSHIP}
                <span className="sr-only">{NEW_TAB}</span>
              </a>
            </>
          )}
          {upHref && (
            <>
              {' '}
              <a className="files-cap-link" href={upHref} target="_blank" rel="noopener noreferrer" data-testid="files-over-link">
                {SEE_MEMBERSHIP}
                <span className="sr-only">{NEW_TAB}</span>
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export default function FilesBody({ deskId, link, session, offline, parked, shell }: Props) {
  const { announce, browserOpen: browserOnScreen } = shell;
  const model = useFilesModel(link, shell.idem, session);
  const { api, place, rows, load } = model;
  const [sel, setSelState] = useState<Sel>(EMPTY_SEL);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const lastFolder = useRef('');
  const listRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeKey = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<(MenuAt & { keys: string[] | null }) | null>(null);

  const folder = place.kind === 'folder' ? place.path : lastFolder.current;
  if (place.kind === 'folder') lastFolder.current = place.path;
  const inFolder = place.kind === 'folder';
  const inTrash = place.kind === 'trash';

  // ---- the engine: one per link, with the image check chosen once
  const [imageCheck, setImageCheck] = useState<ImageCheck | null>(null);
  useEffect(() => {
    let live = true;
    void chooseImageCheck(shell.api).then((c) => live && setImageCheck(c));
    return () => {
      live = false;
    };
  }, [shell.api]);
  const folderRef = useRef(folder);
  folderRef.current = folder;
  // The desk's transfers outlive this window: closing it doesn't stop an upload, and opening it again shows where they are.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `shell`'s functions are the same every render; the object isn't
  const held = useMemo(() => (imageCheck ? engineFor(deskId, link, imageCheck, shell) : null), [imageCheck, deskId, link]);
  const engine = held?.engine ?? null;
  const { reload, reloadUsage } = model;
  useEffect(() => {
    if (!held) return undefined;
    held.changed = (f) => {
      // The desk will say it too (`files.changes`); this is for a desk that says nothing.
      if (f === folderRef.current) window.setTimeout(reload, 200);
      reloadUsage();
    };
    return () => {
      held.changed = null;
    };
  }, [held, reload, reloadUsage]);
  const views = useSyncExternalStore(
    useCallback((fn: () => void) => engine?.subscribe(fn) ?? (() => {}), [engine]),
    () => engine?.snapshot() ?? EMPTY_VIEWS,
  );

  // ---- selection follows the rows
  const setSel = useCallback(
    (s: Sel) => {
      setSelState(s);
      activeKey.current = rows[s.active]?.key ?? null;
    },
    [rows],
  );
  // A rename gives the row a new key: the selection and the keyboard move to it once the list shows it.
  const renamedTo = useRef<{ from: string; to: string } | null>(null);
  useEffect(() => {
    const r = renamedTo.current;
    const hasNew = r !== null && rows.some((x) => x.key === r.to);
    if (r && hasNew) {
      renamedTo.current = null;
      if (activeKey.current === r.from) activeKey.current = r.to;
    }
    setSelState((s) => reconcile(rows, hasNew && r ? follow(s, r.from, r.to) : s, activeKey.current));
  }, [rows]);
  const picked = useMemo(() => rows.filter((r) => sel.keys.includes(r.key)), [rows, sel.keys]);
  const target = picked.length ? picked : [];

  const go = useCallback(
    (p: Place): void => {
      setSelState(EMPTY_SEL);
      activeKey.current = null;
      renamedTo.current = null;
      setNotice(null);
      setMenu(null);
      if (p.kind !== 'search') setQuery('');
      model.go(p);
    },
    [model],
  );

  // Say where the member is when a place has loaded.
  const said = useRef('');
  useEffect(() => {
    if (load.state !== 'ready') return;
    const id = place.kind === 'folder' ? `f:${place.path}` : place.kind === 'trash' ? 't' : `s:${place.q}`;
    if (said.current === id) return;
    said.current = id;
    const n = rows.length;
    const count = n === 0 ? 'empty' : n === 1 ? '1 item' : `${n} items`;
    announce(place.kind === 'folder' ? `${place.path ? baseName(place.path) : 'Files'}, ${count}` : place.kind === 'trash' ? `Trash, ${count}` : `Search for ${place.q}: ${n === 0 ? 'no matches' : count}`);
  }, [load.state, place, rows.length, announce]);

  // ---- search
  useEffect(() => {
    const q = query.trim();
    const t = window.setTimeout(() => {
      if (q) model.go({ kind: 'search', q });
      else if (place.kind === 'search') model.go({ kind: 'folder', path: lastFolder.current });
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const readOnly = offline;
  const focusList = (): void => listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true });

  // ---- actions
  const fail = (err: unknown, what: string): string => {
    const words = errorWords(toFilesError(err), what);
    announce(words);
    return words;
  };

  const open = (row: Row): void => {
    if (row.type === 'dir') return go({ kind: 'folder', path: row.path });
    download(row);
  };

  const up = (): void => {
    if (place.kind === 'folder' && place.path !== '') go({ kind: 'folder', path: parent(place.path) });
    else if (place.kind !== 'folder') go({ kind: 'folder', path: lastFolder.current });
  };

  // The save picker has to be asked from the click itself, before anything is awaited.
  const download = (row: Row): void => {
    if (!engine) return;
    const isDir = row.type === 'dir';
    const pick = askWhere(isDir ? `${row.name}.zip` : row.name, isDir);
    void pick.then((handle) => {
      if (handle === null) return;
      engine.download({ path: row.path, name: row.name, folder: isDir, size: row.size ?? 0, mtimeMs: row.mtimeMs }, handle);
      announce(`Downloading ${row.name}`);
    });
  };

  const upload = (c: Collected, under: string): void => {
    if (!engine) return;
    if (c.files.length) engine.upload(c.files, under);
    for (const d of c.emptyDirs) void api.mkdir(join(under, d), { parents: true }).catch(() => undefined);
    if (c.skipped) setNotice(`${c.skipped === 1 ? '1 item was' : `${c.skipped} items were`} left out because the desk can't take its name.`);
    else if (!c.files.length && !c.emptyDirs.length) setNotice('Nothing to upload there.');
    else setNotice(null);
  };

  const trashRows = async (rs: Row[]): Promise<void> => {
    try {
      const results = await api.remove(rs.map((r) => r.path));
      const ok = results.filter((r) => r.ok).length;
      const bad = results.length - ok;
      announce(ok ? movedToTrashWords(ok, rs.length === 1 ? rs[0]!.name : undefined) + (bad ? `, ${bad} could not be` : '') : 'Nothing was moved to the trash');
      if (bad && !ok) setNotice(errorWords(new FilesError(results.find((r) => !r.ok)?.code ?? 'internal'), 'move that'));
    } catch (err) {
      setNotice(fail(err, 'move that to the trash'));
    }
    model.reload();
    model.reloadUsage();
    focusList();
  };

  const rename = async (row: Row, name: string): Promise<string | null> => {
    try {
      const to = join(parent(row.path), name);
      await api.rename(row.path, to);
      if (place.kind !== 'trash') renamedTo.current = { from: row.key, to };
      announce(`Renamed to ${name}`);
      model.reload();
      return null;
    } catch (err) {
      return errorWords(toFilesError(err), 'rename it');
    }
  };

  /** Moves rows into `dest`. Files that would be replaced are asked about once, together; folders never replace. */
  const moveRows = async (rs: Row[], dest: string): Promise<string | null> => {
    const conflicts: { row: Row; to: string }[] = [];
    let moved = 0;
    let words: string | null = null;
    for (const row of rs) {
      const to = join(dest, row.name);
      if (to === row.path) continue;
      try {
        await api.rename(row.path, to);
        moved += 1;
      } catch (err) {
        const e = toFilesError(err);
        if (e.code === 'exists' && row.type === 'file' && e.details['kind'] === 'file') conflicts.push({ row, to });
        else words = errorWords(e, 'move that');
      }
    }
    if (moved) announce(moved === 1 ? `Moved to ${dest ? baseName(dest) : 'Files'}` : `Moved ${moved} items to ${dest ? baseName(dest) : 'Files'}`);
    model.reload();
    if (conflicts.length) setTimeout(() => setDialog({ kind: 'replace', moves: conflicts }), 0);
    return words;
  };

  const restore = async (rs: Row[]): Promise<void> => {
    let done = 0;
    for (const r of rs) {
      if (!r.trash) continue;
      try {
        await api.restore(r.trash.id);
        done += 1;
      } catch (err) {
        const e = toFilesError(err);
        const suggest = e.code === 'exists' && typeof e.details['suggest'] === 'string' ? e.details['suggest'] : null;
        if (suggest) {
          try {
            await api.restore(r.trash.id, join(parent(r.trash.originalPath), suggest));
            done += 1;
            announce(`${r.name} was restored as ${suggest}`);
            continue;
          } catch (err2) {
            setNotice(fail(err2, 'restore that'));
            continue;
          }
        }
        setNotice(fail(err, 'restore that'));
      }
    }
    if (done) announce(done === 1 ? 'Restored' : `Restored ${done} items`);
    model.reload();
    model.reloadUsage();
    focusList();
  };

  const actions: ListActions = {
    open,
    up,
    rename: (row) => setDialog({ kind: 'rename', row }),
    remove: (rs) => (inTrash ? setDialog({ kind: 'trashForGood', rows: rs }) : void trashRows(rs)),
    restore: (rs) => void restore(rs),
    dropOn: (rs, to) => void moveRows(rs, to),
    menu: ({ x, y, keys, fromKeyboard }) => {
      const box = root.current;
      if (!box) return;
      const rs = keys ? rows.filter((r) => keys.includes(r.key)) : null;
      const items = menuItems({ mode: inTrash ? 'trash' : place.kind === 'search' ? 'search' : 'folder', locked: readOnly || !engine, rowCount: rows.length }, rs);
      // The browser's own menu is already suppressed in the list; with nothing to offer, ours stays shut too.
      if (!items.length) return setMenu(null);
      // Window pixels: the window can be scaled with the office, so the point is taken back through that.
      const r = box.getBoundingClientRect();
      const k = box.offsetWidth ? r.width / box.offsetWidth : 1;
      const label = !rs ? (inTrash ? 'Trash actions' : 'Folder actions') : rs.length === 1 ? `Actions for ${rs[0]!.name}` : `Actions for ${rs.length} items`;
      setMenu({ x: (x - r.left) / k, y: (y - r.top) / k, fromKeyboard, items, label, keys });
    },
  };

  const closeMenu = useCallback((back: boolean): void => {
    setMenu(null);
    if (back) {
      focusList();
      // A click away moves the keyboard to where it landed after this: once more, when it has.
      window.setTimeout(() => !document.querySelector('.files-dialog, .files-menu') && focusList(), 0);
    }
  }, []);

  /** The bar's own doing for each action, on the rows the menu was opened on. */
  const chooseMenu = (id: MenuAction): void => {
    const rs = menu?.keys ? rows.filter((r) => menu.keys!.includes(r.key)) : [];
    const one = rs.length === 1 ? rs[0]! : null;
    setMenu(null);
    focusList();
    switch (id) {
      case 'open':
        return void (one && open(one));
      case 'download':
        return void (one && download(one));
      case 'rename':
        return void (one && setDialog({ kind: 'rename', row: one }));
      case 'move':
        return setDialog({ kind: 'move', rows: rs });
      case 'delete':
        return void trashRows(rs);
      case 'restore':
        return void restore(rs);
      case 'deleteForever':
        return setDialog({ kind: 'trashForGood', rows: rs });
      case 'emptyTrash':
        return setDialog({ kind: 'emptyTrash' });
      case 'uploadFiles':
        return fileInput.current?.click();
      case 'uploadFolder':
        return folderInput.current?.click();
      case 'newFolder':
        return setDialog({ kind: 'newFolder' });
    }
  };

  // ---- drag and drop from the computer
  const dragDepth = useRef(0);
  const isFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files');
  const onDragEnter = (e: DragEvent): void => {
    if (!isFiles(e) || readOnly) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent): void => {
    if (isFiles(e) && !readOnly) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent): void => {
    dragDepth.current = 0;
    setDragging(false);
    if (!isFiles(e) || readOnly) return;
    e.preventDefault();
    if (!inFolder) return void setNotice('Open a folder to drop files into it.');
    // The entries must be asked for now; they are read afterwards.
    const got = entriesOf(e.dataTransfer.items);
    const under = folder;
    void fromEntries(got, under).then((c) => upload(c, under));
  };

  const bySelection = target.length;
  const single = target.length === 1 ? target[0]! : null;
  const locked = readOnly || !engine;

  // ---- what the list says about itself
  const listLabel = place.kind === 'trash' ? 'Trash' : place.kind === 'search' ? `Results for ${place.q}` : `Files in ${folder ? baseName(folder) : 'the top folder'}`;
  const cr = crumbs(folder);

  // A desk that can't do Files (an older deskd, or a guild's): the one line, and nothing to press.
  if (load.state === 'unsupported') {
    return (
      <div className="files-root" data-testid="files-body">
        <p className="files-empty" role="status" data-testid="files-unsupported">
          {load.words}
        </p>
      </div>
    );
  }

  return (
    <div ref={root} className={`files-root${offline ? ' offline' : ''}`} data-testid="files-body" data-offline={offline} onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="files-top">
        {inTrash ? (
          <h3 className="files-where">Trash</h3>
        ) : place.kind === 'search' ? (
          <h3 className="files-where">Search results</h3>
        ) : (
          <nav aria-label="Folder path" className="files-crumbs">
            <ol>
              {cr.map((c, i) => (
                <li key={c.path}>
                  {i === cr.length - 1 ? (
                    <span aria-current="location" className="here">
                      {c.name || 'Files'}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => go({ kind: 'folder', path: c.path })}
                      onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && !readOnly && e.preventDefault()}
                      onDrop={(e) => {
                        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                        e.preventDefault();
                        try {
                          const keys = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as string[];
                          void moveRows(
                            rows.filter((r) => keys.includes(r.key)),
                            c.path,
                          );
                        } catch {
                          /* not ours */
                        }
                      }}
                    >
                      {c.name || 'Files'}
                    </button>
                  )}
                  {i < cr.length - 1 && <span aria-hidden="true"> / </span>}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="files-search">
          <label>
            <span className="sr-only">Search by name</span>
            <input
              ref={searchInput}
              type="search"
              value={query}
              placeholder="Search by name"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery('');
                }
              }}
              disabled={offline}
              autoComplete="off"
              data-testid="files-search"
            />
          </label>
        </div>
      </div>

      <div className="files-bar-actions" role="group" aria-label="Actions">
        {!inTrash && (
          <>
            <button type="button" className="btn primary" disabled={locked || !inFolder} onClick={() => fileInput.current?.click()}>
              Upload files
            </button>
            <button type="button" className="btn" disabled={locked || !inFolder} onClick={() => folderInput.current?.click()}>
              Upload folder
            </button>
            <button type="button" className="btn" disabled={locked || !inFolder} onClick={() => setDialog({ kind: 'newFolder' })}>
              New folder
            </button>
            {bySelection > 0 && (
              <>
              <span className="files-sep" aria-hidden="true" />
              <button type="button" className="btn" disabled={locked || !single} onClick={() => single && download(single)} title={bySelection > 1 ? 'Select one item to download' : undefined}>
                Download
              </button>
              <button type="button" className="btn" disabled={locked || !single} onClick={() => single && setDialog({ kind: 'rename', row: single })}>
                Rename
              </button>
              <button type="button" className="btn" disabled={locked || !bySelection} onClick={() => setDialog({ kind: 'move', rows: target })}>
                Move to…
              </button>
              <button type="button" className="btn" disabled={locked || !bySelection} onClick={() => void trashRows(target)}>
                Delete
              </button>
              </>
            )}
          </>
        )}
        {inTrash && (
          <>
            <button type="button" className="btn primary" disabled={locked || !bySelection} onClick={() => void restore(target)}>
              Restore
            </button>
            <button type="button" className="btn" disabled={locked || !bySelection} onClick={() => setDialog({ kind: 'trashForGood', rows: target })}>
              Delete forever
            </button>
            <button type="button" className="btn" disabled={locked || rows.length === 0} onClick={() => setDialog({ kind: 'emptyTrash' })}>
              Empty trash
            </button>
          </>
        )}
        <span className="files-spacer" />
        {inTrash || place.kind === 'search' ? (
          <button type="button" className="btn" onClick={() => go({ kind: 'folder', path: lastFolder.current })}>
            Back to files
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => go({ kind: 'trash' })} disabled={offline}>
            Trash{model.usage && model.usage.trash.items > 0 ? ` (${model.usage.trash.items})` : ''}
          </button>
        )}
      </div>

      <input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-hidden="true" data-testid="files-pick-files" onChange={(e) => (upload(fromInput(e.target.files ?? [], folder), folder), (e.target.value = ''))} />
      <input
        ref={folderInput}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        data-testid="files-pick-folder"
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => (upload(fromInput(e.target.files ?? [], folder), folder), (e.target.value = ''))}
      />

      {inTrash && <p className="files-note">{TRASH_NOTE}</p>}
      {notice && (
        <p className="files-note" role="status" data-testid="files-notice">
          {notice}{' '}
          <button type="button" className="link-btn" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
      {load.state === 'ready' && model.skipped > 0 && inFolder && <p className="files-note">{SKIPPED_NOTE(model.skipped)}</p>}
      {load.state === 'ready' && model.truncated && <p className="files-note">Only the first matches are shown. Type more of the name.</p>}

      <div className="files-main" ref={listRef} inert={parked || undefined}>
        {load.state === 'loading' && rows.length === 0 && (
          <p className="files-empty" role="status">
            Loading…
          </p>
        )}
        {load.state === 'error' && (
          <div className="files-empty" role="alert">
            <p>{load.words}</p>
            <button type="button" className="btn" onClick={model.reload}>
              Try again
            </button>
          </div>
        )}
        {load.state === 'ready' && rows.length === 0 && (
          <p className="files-empty" data-testid="files-empty">
            {inTrash ? EMPTY_TRASH : place.kind === 'search' ? EMPTY_SEARCH : EMPTY_FOLDER}
          </p>
        )}
        {rows.length > 0 && <FileList rows={rows} sel={sel} setSel={setSel} actions={actions} mode={inTrash ? 'trash' : place.kind === 'search' ? 'search' : 'folder'} label={listLabel} readOnly={readOnly} />}
        {dragging && (
          <div className="files-dropzone" aria-hidden="true">
            <p>Drop to add to {folder ? baseName(folder) : 'Files'}</p>
          </div>
        )}
      </div>

      {inTrash && picked.length === 1 && picked[0]!.trash && (
        <p className="files-note">
          {picked[0]!.name} goes for good {daysUntil(picked[0]!.trash.purgeAt)}.
        </p>
      )}

      {menu && root.current && <ContextMenu at={menu} box={root.current} onClose={closeMenu} onChoose={chooseMenu} />}

      {engine && <Tray views={views} engine={engine} browserOnScreen={browserOnScreen} />}
      <UsageLine model={model} />
      {offline && (
        <p className="sr-only" role="status">
          {READ_ONLY_WORDS}
        </p>
      )}

      {dialog?.kind === 'newFolder' && (
        <NameDialog
          title="New folder"
          label="Folder name"
          initial=""
          submit="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            try {
              await api.mkdir(join(folder, name));
              announce(`Folder ${name} created`);
              model.reload();
              return null;
            } catch (err) {
              return errorWords(toFilesError(err), 'make that folder');
            }
          }}
        />
      )}
      {dialog?.kind === 'rename' && <NameDialog title="Rename" label="New name" initial={dialog.row.name} submit="Rename" toList selectStem={dialog.row.type === 'file'} onClose={() => setDialog(null)} onSubmit={(name) => rename(dialog.row, name)} />}
      {dialog?.kind === 'move' && (
        <MoveDialog
          api={api}
          paths={dialog.rows.map((r) => r.path)}
          from={folder}
          onClose={() => setDialog(null)}
          onMove={(dest) => moveRows(dialog.rows, dest)}
        />
      )}
      {dialog?.kind === 'replace' && (
        <ConfirmDialog
          title={dialog.moves.length === 1 ? 'Replace the file there?' : `Replace ${dialog.moves.length} files there?`}
          body={<p>{dialog.moves.length === 1 ? 'A file with that name is already in that folder. The old one goes to the trash, where you can get it back.' : 'Files with those names are already in that folder. The old ones go to the trash, where you can get them back.'}</p>}
          confirm="Replace"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            for (const m of dialog.moves) {
              try {
                await api.rename(m.row.path, m.to, { replace: true });
              } catch (err) {
                setNotice(fail(err, 'replace that'));
              }
            }
            announce('Replaced. The old files are in the trash.');
            setDialog(null);
            model.reload();
          }}
        />
      )}
      {dialog?.kind === 'trashForGood' && (
        <ConfirmDialog
          title={dialog.rows.length === 1 ? `Delete ${dialog.rows[0]!.name} for good?` : `Delete ${dialog.rows.length} items for good?`}
          body={<p>This can't be undone.</p>}
          confirm="Delete forever"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await api.deleteForGood(dialog.rows.flatMap((r) => (r.trash ? [r.trash.id] : [])));
              announce(dialog.rows.length === 1 ? 'Deleted for good' : `Deleted ${dialog.rows.length} items for good`);
            } catch (err) {
              setNotice(fail(err, 'delete that'));
            }
            setDialog(null);
            model.reload();
            model.reloadUsage();
          }}
        />
      )}
      {dialog?.kind === 'emptyTrash' && (
        <ConfirmDialog
          title="Empty the trash?"
          body={
            <p>
              Everything in it goes for good{model.usage && model.usage.trash.bytes > 0 ? `, freeing ${formatBytes(model.usage.trash.bytes)}` : ''}. This can't be undone.
            </p>
          }
          confirm="Empty trash"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              const r = await api.emptyTrash();
              announce(`Trash emptied, ${formatBytes(r.freedBytes)} freed`);
            } catch (err) {
              setNotice(fail(err, 'empty the trash'));
            }
            setDialog(null);
            model.reload();
            model.reloadUsage();
          }}
        />
      )}
    </div>
  );
}

const EMPTY_VIEWS: readonly never[] = [];

interface Held {
  engine: TransferEngine;
  link: DeskLink;
  /** Whoever has the window open, told when a transfer changed a folder. */
  changed: ((folder: string) => void) | null;
}
const engines = new Map<string, Held>();

/** This desk's engine, made the first time and kept while its link is the same one (the page's lifetime, in practice). */
function engineFor(deskId: string, link: DeskLink, imageCheck: ImageCheck, shell: HostShell): Held {
  const have = engines.get(deskId);
  if (have && have.link === link) return have;
  have?.engine.dispose();
  const entry: Held = { link, changed: null, engine: null as unknown as TransferEngine };
  entry.engine = new TransferEngine({
    link,
    api: new FilesApi(link, shell.idem),
    imageCheck,
    announce: shell.announce,
    setBusy: (on) => shell.setBusy(deskId, on),
    changed: (f) => entry.changed?.(f),
  });
  engines.set(deskId, entry);
  return entry;
}
