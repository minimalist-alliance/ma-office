// The Apps sheet (ADR 0054): the marketplace's first form, per desk, from that desk's own `apps.catalog.get` (deskd's checked
// copy; never the CDN). One row per app: its glyph on a 40 px tile, its name, its one line, "Free", then Add to desk, or Open with
// a quiet Remove. A row opens the app's detail: its words, who made it, "Reviewed by Minimalist Alliance" (or "By Minimalist
// Alliance" for a first-party app bundled in deskd's image), each permission in plain words, the size, and the same Add to desk.
// Add to desk is the member's tap: `apps.install` with grants equal to the version's permissions, no confirm and no step-up (C6).
// Remove keeps the app's data (decision 10), and asks nothing. No ratings, counts or badges. On a Guild Desk only the Founder
// adds and removes; a member sees what's installed, to open. Phones: the sheet is the whole screen.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../chrome/icons';
import { DeskGlyph } from './glyph';
import { deskApp } from './ids';
import { uuidv7 } from '../../desk/idem';
import { useDeskLink, useLive, wakeDesk } from '../../desk/liveStore';
import { tierNamesNow } from '../../platform/useTiers';
import { announce } from '../../shell/announce';
import { focusBack, openItem } from '../../shell/actions';
import { useDeskStore } from '../../state/deskStore';
import { useLayoutStore } from '../../state/layoutStore';
import { openWindow } from '../../state/windowStore';
import { mayManageApps } from './manage';
import { closeAppsSheet, glyphFor, noteApps, openAppsSheet, useDeskAppsStore, type AppRecord } from './store';
import { noteRevoked } from './cache';
import { liveDeskLink } from './link';
import { appItemId, rowAction, sheetState } from './fit';
import { codeOf, parseCatalog, type CatalogApp, type Catalog } from './wire';
import { installRefusalWords, notInstallableWords, PERMISSION_WORDS, REMOVE_FAILED, sizeWords, W } from './words';
import './deskapps.css';

/** One app as the sheet shows it: the catalog's entry, and what the desk says is installed. */
interface Row {
  id: string;
  name: string;
  line: string;
  cat: CatalogApp | null;
  installed: AppRecord | null;
}

type Busy = Record<string, 'adding' | 'removing' | undefined>;

function rowsOf(cat: Catalog | null, installed: readonly AppRecord[], manage: boolean): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const c of cat?.apps ?? []) {
    const inst = installed.find((a) => a.id === c.id) ?? null;
    seen.add(c.id);
    // A guild member opens what the Founder added, and sees nothing to add.
    if (!manage && !inst) continue;
    rows.push({ id: c.id, name: c.name, line: c.line, cat: c, installed: inst });
  }
  // Installed, and no longer in the catalog: still the member's to open or remove.
  for (const a of installed) if (!seen.has(a.id)) rows.push({ id: a.id, name: a.name, line: a.description, cat: null, installed: a });
  return rows;
}

/** Esc puts the sheet away wherever focus is, before the office's own Esc hears it. */
function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}

function Tile({ id, size }: { id: string; size: 40 | 64 }) {
  return (
    <span className={`dapp-tile s${size}`} aria-hidden="true">
      <DeskGlyph glyph={glyphFor(id)} size={size === 40 ? 28 : 44} />
    </span>
  );
}

/** The row's or the detail's actions: Add to desk, or Open and Remove, or why it can't be added. */
function Actions({ row, manage, busy, primary, onAdd, onOpen, onRemove }: { row: Row; manage: boolean; busy: Busy[string]; primary: boolean; onAdd: () => void; onOpen: () => void; onRemove: () => void }) {
  const v = row.cat?.version ?? null;
  const act = rowAction({ installed: !!row.installed, installable: v ? v.installable : null, reason: v?.reason ?? null }, manage);
  if (act.kind === 'none') return null;
  if (act.kind === 'why') return <p className="dapp-why">{notInstallableWords(act.reason)}</p>;
  if (act.kind === 'open') {
    return (
      <div className="dapp-actions">
        <button type="button" className={`btn${primary ? ' primary' : ''}`} onClick={onOpen} disabled={!!busy} data-testid={`dapp-open-${row.id}`}>
          {W.open}
        </button>
        {act.remove && (
          <button type="button" className="dapp-quiet" onClick={onRemove} disabled={!!busy} aria-busy={busy === 'removing'} data-testid={`dapp-remove-${row.id}`} aria-label={`${W.remove} ${row.name}`}>
            {busy === 'removing' ? W.removing : W.remove}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="dapp-actions">
      <button type="button" className={`btn${primary ? ' primary' : ''}`} onClick={onAdd} disabled={!!busy} aria-busy={busy === 'adding'} data-testid={`dapp-add-${row.id}`} aria-label={busy === 'adding' ? `${W.adding} ${row.name}` : `${W.add}: ${row.name}`}>
        {busy === 'adding' ? W.adding : W.add}
      </button>
    </div>
  );
}

function Detail({ row, children }: { row: Row; children: ReactNode }) {
  const v = row.cat?.version ?? null;
  const publisher = row.cat?.publisher || row.installed?.publisher || '';
  const perms = v?.permissions ?? row.installed?.permissions ?? [];
  const size = v ? sizeWords(v.bytes) : '';
  const about = (row.cat?.about ?? row.installed?.description ?? '').split(/\n{2,}/).filter(Boolean);
  const bundled = row.cat?.bundled === true;
  return (
    <div className="dapp-detail" data-testid={`dapp-detail-${row.id}`}>
      <div className="dapp-detail-head">
        <Tile id={row.id} size={64} />
        <div>
          <h3 id="dapp-detail-name">{row.name}</h3>
          <p className="dapp-free">{W.free}</p>
        </div>
      </div>
      {about.map((p, i) => (
        <p key={i} className="dapp-about">{p}</p>
      ))}
      <div className="dapp-facts">
        {bundled ? <p>{W.byMa}</p> : (
          <>
            {publisher && <p>{W.by(publisher)}</p>}
            <p>{W.reviewed}</p>
          </>
        )}
        {perms.length ? (
          <ul className="dapp-perms">
            {perms.map((p) => (
              <li key={p}>
                {PERMISSION_WORDS[p] ?? p}
                {p === 'net' && v?.net.length ? (
                  <ul>
                    {v.net.map((n) => (
                      <li key={n.host}>
                        {n.host}: {n.why}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>{W.asksNothing}</p>
        )}
        {size && <p>{W.size(size)}</p>}
      </div>
      <div className="dapp-detail-foot">{children}</div>
      {row.cat?.credits.length ? (
        <div className="dapp-credits">
          {row.cat.credits.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function AppsSheet({ deskId, appId }: { deskId: string; appId: string | null }) {
  const link = useDeskLink(deskId);
  const live = useLive(deskId);
  const name = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.name) ?? 'Desk';
  const vm = useDeskStore((s) => s.desks.find((d) => d.id === deskId)?.vm);
  const info = useDeskAppsStore((s) => s.desks[deskId]);
  const manage = mayManageApps(deskId);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [load, setLoad] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [busy, setBusy] = useState<Busy>({});
  const [lines, setLines] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const open = live.link === 'open' && !!link;

  const close = useCallback((): void => {
    closeAppsSheet();
    focusBack(deskId);
  }, [deskId]);
  useEscape(close);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [appId]);

  useEffect(() => {
    if (!open) return undefined;
    let gone = false;
    setLoad((l) => (l === 'ready' ? l : 'loading'));
    liveDeskLink(deskId)
      ?.call('apps.catalog.get')
      .then(
        (res) => {
          if (gone) return;
          const c = parseCatalog(res);
          noteRevoked(deskId, c.revokedKeys, c.revokedManifests);
          setCat(c);
          setLoad('ready');
        },
        () => {
          if (!gone) setLoad('failed');
        },
      );
    return () => {
      gone = true;
    };
  }, [open, deskId, ask]);

  /** What's installed, asked again after a change so the row and the tile don't wait for the topic. */
  const refresh = (): void => {
    void liveDeskLink(deskId)
      ?.call('apps.list')
      .then((res) => noteApps(deskId, res), () => undefined);
  };

  const add = (row: Row): void => {
    const v = row.cat?.version;
    const l = liveDeskLink(deskId);
    if (!v || !l || busy[row.id]) return;
    setBusy((b) => ({ ...b, [row.id]: 'adding' }));
    setLines((x) => ({ ...x, [row.id]: '' }));
    l.call('apps.install', { id: row.id, version: v.version, packageSha256: v.packageSha256, grants: v.permissions }, { idem: uuidv7() }).then(
      () => {
        setBusy((b) => ({ ...b, [row.id]: undefined }));
        announce(`${row.name} added to ${name}`);
        refresh();
      },
      (err: unknown) => {
        const { code, reason } = codeOf(err);
        setBusy((b) => ({ ...b, [row.id]: undefined }));
        setLines((x) => ({ ...x, [row.id]: installRefusalWords(code, reason, tierNamesNow().lead) }));
        if (code === 'precondition_failed' && reason === 'catalog_changed') setAsk((n) => n + 1);
        refresh(); // a reply lost on the way may still have added it: the row follows what the desk says
      },
    );
  };

  const remove = (row: Row): void => {
    const l = liveDeskLink(deskId);
    if (!l || busy[row.id]) return;
    setBusy((b) => ({ ...b, [row.id]: 'removing' }));
    setLines((x) => ({ ...x, [row.id]: '' }));
    l.call('apps.remove', { id: row.id }, { idem: uuidv7() }).then(
      () => {
        setBusy((b) => ({ ...b, [row.id]: undefined }));
        announce(`${row.name} removed from ${name}`);
        refresh();
      },
      () => {
        setBusy((b) => ({ ...b, [row.id]: undefined }));
        setLines((x) => ({ ...x, [row.id]: REMOVE_FAILED }));
        refresh();
      },
    );
  };

  const openApp = (row: Row): void => {
    closeAppsSheet();
    const app = deskApp(row.id);
    const itemId = appItemId(deskId, row.id);
    const placed = useLayoutStore.getState().desks[deskId]?.items.some((i) => i.id === itemId);
    if (placed) openItem(deskId, itemId);
    else openWindow(deskId, app, itemId);
  };

  const rows = rowsOf(cat, info?.apps ?? [], manage);
  const shown = appId ? rows.find((r) => r.id === appId) ?? null : null;

  const state = sheetState({ open, asleep: vm === 'stopped', available: info ? info.available : null, load, rows: rows.length, detail: !!shown });
  const calm = (line: string, button?: ReactNode, delayed = false): ReactNode => (
    <div className={`dapp-empty${delayed ? ' delayed' : ''}`} role="status" data-testid="dapp-empty" data-state={state}>
      <p>{line}</p>
      {button}
    </div>
  );
  let body: ReactNode;
  if (state === 'asleep') {
    body = calm(W.asleep, <button type="button" className="btn" onClick={() => wakeDesk(deskId)}>{W.wake}</button>);
  } else if (state === 'connecting') body = calm(W.connecting, undefined, true);
  else if (state === 'off') body = calm(W.off);
  else if (state === 'failed') body = calm(W.didntLoad, <button type="button" className="btn" onClick={() => setAsk((n) => n + 1)}>{W.tryAgain}</button>);
  else if (state === 'loading') body = calm(W.loading, undefined, true);
  else if (state === 'none') body = calm(W.none);
  else if (state === 'detail' && shown) {
    body = (
      <Detail row={shown}>
        <Actions row={shown} manage={manage} busy={busy[shown.id]} primary onAdd={() => add(shown)} onOpen={() => openApp(shown)} onRemove={() => remove(shown)} />
        {lines[shown.id] && <p className="dapp-line" role="status">{lines[shown.id]}</p>}
      </Detail>
    );
  } else {
    body = (
      <ul className="dapp-rows" aria-label={`Apps for ${name}`}>
        {rows.map((row) => (
          <li key={row.id} className="dapp-row" data-testid={`dapp-row-${row.id}`} data-installed={row.installed ? 'yes' : 'no'}>
            <button type="button" className="dapp-row-main" onClick={() => openAppsSheet(deskId, row.id)} aria-label={`${row.name}. ${row.line}`}>
              <Tile id={row.id} size={40} />
              <span className="dapp-row-text">
                <span className="dapp-name">{row.name}</span>
                {row.line && <span className="dapp-line1">{row.line}</span>}
              </span>
            </button>
            <span className="dapp-price">{W.free}</span>
            <Actions row={row} manage={manage} busy={busy[row.id]} primary={false} onAdd={() => add(row)} onOpen={() => openApp(row)} onRemove={() => remove(row)} />
            {lines[row.id] && <p className="dapp-line" role="status">{lines[row.id]}</p>}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="dapp-away" onClick={close}>
      <div
        ref={ref}
        tabIndex={-1}
        className="dapp-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dapp-sheet-title"
        data-testid="apps-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dapp-head">
          {shown ? (
            <button type="button" className="icon-btn sm" aria-label={W.back} title={W.back} onClick={() => openAppsSheet(deskId, null)} data-testid="dapp-back">
              <Icon name="chevronLeft" size={16} />
            </button>
          ) : null}
          <h2 id="dapp-sheet-title">
            <span className="dapp-kicker">{name}</span>
            <span>{W.sheetTitle}</span>
          </h2>
          <button type="button" className="icon-btn sm" aria-label={W.close} title={W.close} onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="dapp-body">{body}</div>
      </div>
    </div>
  );
}
