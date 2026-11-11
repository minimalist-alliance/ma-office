// Tab view (design 5.2): notebooks and a tab's pages on the left, binder tabs on the paper's edge,
// the page in the middle. Paging runs on across tab boundaries.
import type { Editor as TipTapEditor } from '@tiptap/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { NotebookBackend, PageSession } from '../model/backend.ts';
import { formatWhen } from '../model/days.ts';
import { stepPage } from '../model/tree.ts';
import { TAB_COLORS, type PageRec, type TabRec, type Tree } from '../model/types.ts';
import { pageColors } from './colorCommands.ts';
import { InlineName, Menu, type MenuItem } from './controls.tsx';
import { PageEditor } from './Editor.tsx';
import { paletteItems, SWATCH_COLUMNS } from './editorMenu.ts';
import { exportHtml, exportMarkdown } from './exporting.ts';
import { HistoryPane } from './History.tsx';
import { Icon } from './icons.tsx';
import type { MenuAnchor } from './menu/Menu.tsx';
import { rectOf, type Rect } from './menu/placement.ts';
import { useMenuTrigger, type MenuRequest } from './menu/useMenuTrigger.ts';
import { applyView, isFiltered, labelCounts, labelOf, toggleLabel, usePageListView, type PageListView } from './pageView.ts';
import { exportPalette, PALETTE, paletteName, type PaletteId } from './palette.ts';
import { restoreRefusal } from './refusals.ts';
import type { Resolved, Selection } from './state.ts';

/** The open page's first line while it's typed, so its row in the list keeps up without re-rendering the list. */
function createLiveTitles() {
  let pageId: string | null = null;
  let title = '';
  const subs = new Set<() => void>();
  return {
    set(id: string, t: string) {
      if (id === pageId && t === title) return;
      pageId = id;
      title = t;
      for (const s of subs) s();
    },
    get: (id: string): string | null => (id === pageId ? title : null),
    subscribe(cb: () => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
type LiveTitles = ReturnType<typeof createLiveTitles>;

function usePageSession(backend: NotebookBackend, pageId: string | undefined): PageSession | null {
  const [state, setState] = useState<{ session: PageSession; ready: boolean } | null>(null);
  useEffect(() => {
    if (!pageId) {
      setState(null);
      return undefined;
    }
    const session = backend.openPage(pageId);
    let live = true;
    setState({ session, ready: false });
    void session.ready.then(() => {
      if (live) setState({ session, ready: true });
    });
    return () => {
      live = false;
      session.close();
    };
  }, [backend, pageId]);
  return state?.ready && state.session.pageId === pageId ? state.session : null;
}

const PAGE_MIME = 'application/x-ma-notebook-page';

/** What a filter shows, in words: "Blue, Rose, No label". */
const filterNames = (v: PageListView): string => [...v.labels.map(paletteName), ...(v.none ? ['No label'] : [])].join(', ');

/** A desk can be away. The host says so, from what its backend reports, and nothing here goes on as if it had worked. */
/** What a member without the grant is told when a notebook or tab change is refused. */
const SPACES_REFUSED = 'Only the Founder and Officers who manage spaces can change notebooks and tabs.';
const quietly = (work: Promise<unknown>): void => void work.catch(() => {});

/** A finger drags nothing: a long press on a row opens its menu instead. */
const COARSE = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

const PageItem = memo(function PageItem({
  page,
  on,
  live,
  onSelect,
  onDropBefore,
  onMenu,
  reorder,
}: {
  page: PageRec;
  on: boolean;
  live: LiveTitles;
  onSelect: (id: string) => void;
  onDropBefore: (draggedId: string, beforeId: string) => void;
  /** With the title the row shows, which for the open page is its first line as it's typed. */
  onMenu: (page: PageRec, req: MenuRequest, title: string) => void;
  /** Dropping a page before this one reorders the list; off while it's sorted by label. */
  reorder: boolean;
}) {
  const liveTitle = useSyncExternalStore(live.subscribe, () => (on ? live.get(page.id) : null));
  const title = (on && liveTitle !== null ? liveTitle : page.title) || 'New note';
  const [over, setOver] = useState(false);
  const label = labelOf(page);
  const trigger = useMenuTrigger((req) => onMenu(page, req, title));
  return (
    <li
      onDragOver={(e) => {
        if (reorder && e.dataTransfer.types.includes(PAGE_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(PAGE_MIME);
        if (id && id !== page.id) onDropBefore(id, page.id);
      }}
      className={over ? 'nb-drop-before' : undefined}
    >
      <button
        type="button"
        className={`nb-page-btn${on ? ' on' : ''}`}
        aria-current={on || undefined}
        draggable={!COARSE}
        onDragStart={(e) => {
          e.dataTransfer.setData(PAGE_MIME, page.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        {...trigger}
        onClick={() => onSelect(page.id)}
        data-page-id={page.id}
        data-label={label ?? undefined}
      >
        <span className="nb-page-line">
          <span className="nb-page-title">{title}</span>
          {label && <span className="nb-label-dot" data-pal={label} aria-hidden="true" />}
        </span>
        <span className="nb-page-meta">
          {formatWhen(page.updatedAt)}
          <span className="nb-page-snip">{page.snippet}</span>
        </span>
        {label && <span className="nb-sr">, {paletteName(label)} label</span>}
      </button>
    </li>
  );
});

function BinderTab({
  tab,
  on,
  onSelect,
  onRename,
  onMenu,
  onDropPage,
  renaming,
  onRenamed,
  readOnly,
}: {
  tab: TabRec;
  on: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onMenu: (el: HTMLElement) => void;
  onDropPage: (pageId: string) => void;
  renaming: boolean;
  onRenamed: () => void;
  /** No grant for tabs: the name can't be edited. */
  readOnly: boolean;
}) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useMenuTrigger((req) => {
    if (req.via === 'keyboard' && req.target !== ref.current) return false;
    if (ref.current) onMenu(ref.current);
    return true;
  });
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(PAGE_MIME)) {
      e.preventDefault();
      setOver(true);
    }
  };
  return (
    <div
      ref={ref}
      role="tab"
      tabIndex={on ? 0 : -1}
      aria-selected={on}
      className={`nb-tab${on ? ' on' : ''}${over ? ' drop' : ''}`}
      data-color={tab.color}
      data-tab-id={tab.id}
      {...trigger}
      onClick={onSelect}
      onKeyDown={(e) => {
        trigger.onKeyDown(e);
        if (e.defaultPrevented || e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(PAGE_MIME);
        if (id) onDropPage(id);
      }}
    >
      <InlineName value={tab.title} label="Tab name" onCommit={onRename} editing={renaming} onDone={onRenamed} readOnly={readOnly} />
    </div>
  );
}

export function TabView({
  backend,
  tree,
  resolved,
  select,
  onOpenLink,
  onPrint,
  focusPageId,
  stateKey,
  lastColor,
  onLastColor,
  manageSpaces,
}: {
  backend: NotebookBackend;
  tree: Tree;
  resolved: Resolved;
  select: (sel: Selection) => void;
  onOpenLink?: (href: string) => void;
  onPrint: (pageId: string) => void;
  /** Put the cursor in this page when it opens. */
  focusPageId?: string | null;
  /** The host's localStorage key: the page list's filter and sort are kept beside it, per notebook. */
  stateKey: string;
  /** The color this member last used (`Notebook`'s `lastColor`), and where a new one goes. */
  lastColor: PaletteId;
  onLastColor: (id: PaletteId) => void;
  /** May create, rename and recolor notebooks and tabs (a Guild Desk's Founder, or an Officer with manage_spaces; always on a member's own desk). */
  manageSpaces: boolean;
}) {
  const { notebook, tab, page } = resolved;
  const live = useMemo(createLiveTitles, []);
  const session = usePageSession(backend, page?.id);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Built when it renders, so a menu left open (the filter) shows what it changes.
  const [menu, setMenu] = useState<{ build: () => MenuItem[]; anchor: MenuAnchor; label: string; avoid?: Rect | null; touch?: boolean; fallback?: HTMLElement | null } | null>(null);
  /** The page whose footer asks "Delete this page?". */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** Rename from the page list: the page whose first line gets selected once it opens. */
  const [renameTitle, setRenameTitle] = useState<string | null>(null);
  const [view, setView] = usePageListView(stateKey, notebook?.id);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [history, setHistory] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  const editorRef = useRef<TipTapEditor | null>(null);
  const tablist = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHistory(false);
  }, [page?.id]);
  const titleSelected = useCallback(() => setRenameTitle(null), []);
  // Asked from a menu, the safe answer takes focus, so a keyboard member is right there.
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmDelete && confirmDelete === page?.id) keepRef.current?.focus();
  }, [confirmDelete, page?.id]);
  // A quiet line under the page list: a desk too old for labels or Duplicate says so here, and nothing else changes.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  /** Like `quietly`, but a desk that doesn't know the call (`not_found`) gets the update line. */
  /** A notebook or tab change the desk refused (the grant changed since this loaded): one plain line. */
  const spaceRefused = useCallback((work: Promise<unknown>): void => {
    void work.catch((err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'forbidden') setNotice(SPACES_REFUSED);
      else if (code === 'not_found') setNotice('Update your desk to use this.');
    });
  }, []);
  const needsDesk = useCallback((work: Promise<unknown>): void => {
    void work.catch((err: unknown) => {
      if ((err as { code?: unknown } | null)?.code === 'not_found') setNotice('Update your desk to use this.');
    });
  }, []);

  const onTitle = useCallback((t: string) => {
    if (page) live.set(page.id, t);
  }, [live, page]);
  const onEditor = useCallback((e: TipTapEditor | null) => {
    editorRef.current = e;
  }, []);

  if (!notebook || !tab) return <div className="nb-empty-state">No notebooks yet.</div>;

  const tabs = tree.tabs[notebook.id] ?? [];
  const pages = tree.pages[tab.id] ?? [];
  const shown = applyView(pages, view);
  const colors = pageColors(backend);
  // The filter shows once a page in this notebook has a label, or while one is set: nothing new until colors are used.
  const labelsInUse = tabs.some((t) => (tree.pages[t.id] ?? []).some((p) => labelOf(p))) || isFiltered(view) || view.sort !== 'manual';
  const prev = page ? stepPage(tree, page.id, -1) : null;
  const next = page ? stepPage(tree, page.id, 1) : null;

  const addNotebook = async () => {
    const { notebook: n, page: p } = await backend.createNotebook();
    setRenaming(n.id);
    select({ pageId: p.id });
  };
  const addTab = async () => {
    const { tab: t, page: p } = await backend.createTab(notebook.id);
    setRenaming(t.id);
    select({ pageId: p.id });
  };
  const addPage = async () => {
    const p = await backend.createPage(tab.id);
    setFocusNew(p.id);
    select({ pageId: p.id });
  };
  const trash = async () => {
    if (!page) return;
    const seq = pages;
    const i = seq.findIndex((p) => p.id === page.id);
    const after = seq[i + 1] ?? seq[i - 1];
    await backend.trashPage(page.id);
    select(after ? { pageId: after.id } : { notebookId: notebook.id, tabId: tab.id });
  };
  const onDropBefore = (dragged: string, before: string) => {
    const list = pages.filter((p) => p.id !== dragged);
    quietly(backend.movePage(dragged, tab.id, Math.max(0, list.findIndex((p) => p.id === before))));
  };

  const tabMenu = (t: TabRec, el: HTMLElement) =>
    setMenu({
      anchor: el,
      label: `Tab ${t.title}`,
      build: () => [
        { label: 'Rename', onSelect: () => setRenaming(t.id) },
        { label: 'Color', heading: true },
        ...TAB_COLORS.map((c): MenuItem => ({ label: c[0]?.toUpperCase() + c.slice(1), swatch: c, checked: t.color === c, onSelect: () => spaceRefused(backend.recolorTab(t.id, c)) })),
      ],
    });

  /** Label, Rename, Duplicate and Delete: a page row's own menu, and the start of the page's ⋯ menu. */
  const labelItem = (p: PageRec): MenuItem => ({
    label: 'Label',
    columns: SWATCH_COLUMNS,
    submenu: paletteItems(
      labelOf(p),
      'No label',
      (id) => {
        needsDesk(colors.setPageLabel(p.id, id));
        if (id && id !== lastColor) onLastColor(id);
      },
      { last: lastColor, testPrefix: 'label' },
    ),
  });
  const duplicate = (p: PageRec) => needsDesk(colors.duplicatePage(p.id).then((id) => select({ pageId: id })));
  const askDelete = (p: PageRec) => {
    select({ pageId: p.id });
    setHistory(false);
    setConfirmDelete(p.id);
  };
  const rowMenu = (p: PageRec, req: MenuRequest, title: string) => {
    const row = req.target.closest<HTMLElement>('.nb-page-btn');
    setMenu({
      anchor: req.via === 'keyboard' && row ? row : { x: req.x, y: req.y },
      avoid: row ? rectOf(row.getBoundingClientRect()) : null,
      touch: req.via === 'touch',
      fallback: row,
      label: `Page ${title}`,
      build: () => [
        labelItem(p),
        {
          label: 'Rename',
          onSelect: () => {
            select({ pageId: p.id });
            setHistory(false);
            setRenameTitle(p.id);
          },
        },
        { label: 'Duplicate', onSelect: () => duplicate(p) },
        { label: '', separator: true },
        { label: 'Delete page', danger: true, onSelect: () => askDelete(p) },
      ],
    });
  };

  const counts = labelCounts(pages);
  const filterMenu = (el: HTMLElement) =>
    setMenu({
      anchor: el,
      label: 'Filter and sort pages',
      build: () => {
        // Read at render, from the latest view, as the menu stays open while it's changed.
        const v = viewRef.current;
        const set = (next: PageListView) => setView(next);
        return [
          { label: 'Show', heading: true },
          { label: 'All pages', checked: !isFiltered(v), keepOpen: true, onSelect: () => set({ ...v, labels: [], none: false }) },
          ...PALETTE.map(
            (c): MenuItem => ({
              label: c.name,
              pal: c.id,
              checkbox: true,
              checked: v.labels.includes(c.id),
              keepOpen: true,
              hint: String(counts[c.id]),
              onSelect: () => set(toggleLabel(v, c.id)),
            }),
          ),
          { label: 'No label', pal: null, checkbox: true, checked: v.none, keepOpen: true, hint: String(counts.none), onSelect: () => set(toggleLabel(v, 'none')) },
          { label: '', separator: true },
          { label: 'Sort', heading: true },
          { label: 'Manual order', checked: v.sort === 'manual', keepOpen: true, onSelect: () => set({ ...v, sort: 'manual' }) },
          { label: 'By label', checked: v.sort === 'label', keepOpen: true, onSelect: () => set({ ...v, sort: 'label' }) },
        ];
      },
    });

  const pageMenu = (el: HTMLElement) => {
    if (!page) return;
    const otherTabs = tabs.filter((t) => t.id !== tab.id);
    setMenu({
      anchor: el,
      label: 'Page actions',
      build: () => [
        labelItem(page),
        { label: 'Duplicate page', onSelect: () => duplicate(page) },
        { label: '', separator: true },
        { label: 'Save a version now', onSelect: () => quietly(backend.saveVersion(page.id)) },
        { label: 'History…', onSelect: () => setHistory(true) },
        ...(manageSpaces ? [{ label: 'Add tab at this page', onSelect: () => spaceRefused(backend.addTabAtPage(page.id).then((t) => setRenaming(t.id))) }] : []),
        ...(otherTabs.length
          ? [{ label: 'Move to tab', heading: true }, ...otherTabs.map((t): MenuItem => ({ label: t.title, swatch: t.color, onSelect: () => quietly(backend.movePage(page.id, t.id)) }))]
          : []),
        { label: 'Export', heading: true },
        { label: 'Markdown (.md)', onSelect: () => quietly(exportMarkdown(backend, page.id, exportPalette())) },
        { label: 'Web page (.html)', onSelect: () => quietly(exportHtml(backend, page.id, exportPalette())) },
        { label: 'Print or save as PDF', onSelect: () => onPrint(page.id) },
        { label: 'Delete page', danger: true, onSelect: () => setConfirmDelete(page.id) },
      ],
    });
  };

  const onTabsKey = (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir || (e.target as HTMLElement).getAttribute('role') !== 'tab') return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab.id);
    const nextTab = tabs[(i + dir + tabs.length) % tabs.length];
    if (!nextTab) return;
    select({ notebookId: notebook.id, tabId: nextTab.id });
    requestAnimationFrame(() => tablist.current?.querySelector<HTMLElement>(`[data-tab-id="${nextTab.id}"]`)?.focus());
  };

  return (
    <div className="nb-tabview">
      <aside className="nb-side" aria-label="Notebooks and pages">
        <div className="nb-side-head">
          <h3 id="nb-list-label">Notebooks</h3>
          {manageSpaces && (
            <button type="button" className="nb-icon-btn" onClick={() => spaceRefused(addNotebook())} aria-label="New notebook" title="New notebook">
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
        <ul className="nb-list" aria-labelledby="nb-list-label">
          {tree.notebooks.map((n) => {
            const count = (tree.tabs[n.id] ?? []).reduce((sum, t) => sum + (tree.pages[t.id]?.length ?? 0), 0);
            return (
              <li key={n.id}>
                <div
                  role="button"
                  tabIndex={0}
                  className={`nb-list-btn${n.id === notebook.id ? ' on' : ''}`}
                  aria-current={n.id === notebook.id || undefined}
                  onClick={() => select({ notebookId: n.id })}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      select({ notebookId: n.id });
                    }
                  }}
                >
                  <span className="nb-spine" aria-hidden="true" />
                  <InlineName value={n.title} label="Notebook name" onCommit={(t) => spaceRefused(backend.renameNotebook(n.id, t))} editing={renaming === n.id} onDone={() => setRenaming(null)} readOnly={!manageSpaces} />
                  <span className="nb-count">{count}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="nb-side-head">
          <h3 id="pg-list-label">Pages in {tab.title}</h3>
          <span className="nb-side-actions">
            {labelsInUse && (
              <button
                type="button"
                className={`nb-icon-btn${isFiltered(view) || view.sort !== 'manual' ? ' on' : ''}`}
                onClick={(e) => filterMenu(e.currentTarget)}
                aria-label="Filter and sort pages"
                aria-haspopup="menu"
                title="Filter and sort pages"
                data-testid="page-filter"
              >
                <Icon name="filter" size={16} />
              </button>
            )}
            <button type="button" className="nb-icon-btn" onClick={() => quietly(addPage())} aria-label="New page" title="New page" data-testid="new-page">
              <Icon name="plus" size={16} />
            </button>
          </span>
        </div>
        <ul className="nb-pages" aria-labelledby="pg-list-label">
          {shown.map((p) => (
            <PageItem
              key={p.id}
              page={p}
              on={p.id === page?.id}
              live={live}
              onSelect={(id) => select({ pageId: id })}
              onDropBefore={onDropBefore}
              onMenu={rowMenu}
              reorder={view.sort === 'manual'}
            />
          ))}
          {!pages.length && <li className="nb-hint">No pages in this tab yet.</li>}
          {pages.length > 0 && isFiltered(view) && (
            <li className="nb-hint nb-filter-hint" data-testid="page-filter-hint">
              {shown.length ? `Showing: ${filterNames(view)}` : 'No pages match in this tab.'}
              <button type="button" className="nb-text-btn" onClick={() => setView({ ...view, labels: [], none: false })}>
                Show all
              </button>
            </li>
          )}
        </ul>
        {notice && (
          <p className="nb-hint nb-side-notice" role="status" data-testid="notebook-notice">
            {notice}
          </p>
        )}
        {tree.trash.length > 0 && (
          <div className="nb-trash">
            <button type="button" className="nb-text-btn" aria-expanded={showTrash} onClick={() => setShowTrash((v) => !v)}>
              <Icon name="trash" size={15} /> Trash · {tree.trash.length}
            </button>
            {showTrash && (
              <ul className="nb-pages">
                {tree.trash.map((p) => (
                  <li key={p.id} className="nb-trash-row">
                    <span className="nb-page-title">{p.title || 'New note'}</span>
                    <button type="button" className="nb-text-btn" onClick={() => void backend.restorePage(p.id).then(() => select({ pageId: p.id }), (err: unknown) => { const line = restoreRefusal(err); if (line) setNotice(line); })}>
                      Restore
                    </button>
                  </li>
                ))}
                <li className="nb-hint">Pages stay in Trash for 30 days.</li>
              </ul>
            )}
          </div>
        )}
      </aside>

      <section className="nb-main">
        <div className="nb-tabs" onKeyDown={onTabsKey}>
          <div className="nb-tablist" role="tablist" aria-label={`Tabs in ${notebook.title}`} ref={tablist}>
            {tabs.map((t) => (
              <BinderTab
                key={t.id}
                tab={t}
                on={t.id === tab.id}
                onSelect={() => select({ notebookId: notebook.id, tabId: t.id })}
                onRename={(name) => spaceRefused(backend.renameTab(t.id, name))}
                onMenu={(el) => (manageSpaces ? tabMenu(t, el) : undefined)}
                readOnly={!manageSpaces}
                onDropPage={(id) => quietly(backend.movePage(id, t.id))}
                renaming={renaming === t.id}
                onRenamed={() => setRenaming(null)}
              />
            ))}
          </div>
          {manageSpaces && (
            <button type="button" className="nb-tab add" onClick={() => spaceRefused(addTab())} aria-label="New tab" title="New tab" data-testid="new-tab">
              <Icon name="plus" size={15} />
            </button>
          )}
        </div>
        <div className="nb-paper" data-color={tab.color} role="tabpanel">
          {!page ? (
            <div className="nb-paper-empty">
              <p>This tab has no pages.</p>
              <button type="button" className="nb-btn" onClick={() => quietly(addPage())}>
                <Icon name="plus" size={16} /> New page
              </button>
            </div>
          ) : history ? (
            <HistoryPane backend={backend} page={page} onClose={() => setHistory(false)} />
          ) : (
            <>
              {session ? (
                <PageEditor
                  key={session.pageId}
                  session={session}
                  onTitle={onTitle}
                  onOpenLink={onOpenLink}
                  autofocus={focusNew === page.id || focusPageId === page.id}
                  onEditor={onEditor}
                  selectTitle={renameTitle === page.id}
                  onTitleSelected={titleSelected}
                  lastColor={lastColor}
                  onLastColor={onLastColor}
                />
              ) : (
                <div className="nb-editor nb-loading" aria-busy="true" />
              )}
              <footer className="nb-foot">
                <span className="nb-foot-meta">
                  Created {formatWhen(page.createdAt)} · Edited {formatWhen(page.updatedAt)} · {page.wordCount} {page.wordCount === 1 ? 'word' : 'words'}
                </span>
                {confirmDelete === page.id ? (
                  <span className="nb-confirm" role="group" aria-label="Delete this page?">
                    Delete this page?
                    <button type="button" className="nb-text-btn danger" onClick={() => quietly(trash())}>Delete</button>
                    <button type="button" className="nb-text-btn" ref={keepRef} onClick={() => setConfirmDelete(null)}>Keep</button>
                  </span>
                ) : (
                  <span className="nb-foot-actions">
                    <button type="button" className="nb-icon-btn" disabled={!prev} onClick={() => prev && select({ pageId: prev.id })} aria-label="Previous page" title="Previous page">
                      <Icon name="chevronLeft" size={16} />
                    </button>
                    <button type="button" className="nb-icon-btn" disabled={!next} onClick={() => next && select({ pageId: next.id })} aria-label="Next page" title="Next page">
                      <Icon name="chevronRight" size={16} />
                    </button>
                    <button type="button" className="nb-icon-btn" onClick={() => setHistory(true)} aria-label="History" title="History">
                      <Icon name="history" size={16} />
                    </button>
                    <button type="button" className="nb-icon-btn" onClick={(e) => pageMenu(e.currentTarget)} aria-label="Page actions" title="Page actions" aria-haspopup="menu">
                      <Icon name="more" size={16} />
                    </button>
                  </span>
                )}
              </footer>
            </>
          )}
        </div>
      </section>
      {menu && (
        <Menu
          items={menu.build()}
          anchor={menu.anchor}
          avoid={menu.avoid}
          touch={menu.touch}
          fallbackFocus={menu.fallback}
          label={menu.label}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
