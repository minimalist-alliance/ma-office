// Tab view (design 5.2): notebooks and a tab's pages on the left, binder tabs on the paper's edge,
// the page in the middle. Paging runs on across tab boundaries.
import type { Editor as TipTapEditor } from '@tiptap/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from 'react';
import type { NotebookBackend, PageSession } from '../model/backend.ts';
import { formatWhen } from '../model/days.ts';
import { stepPage } from '../model/tree.ts';
import { TAB_COLORS, type PageRec, type TabRec, type Tree } from '../model/types.ts';
import { InlineName, Menu, type MenuItem } from './controls.tsx';
import { PageEditor } from './Editor.tsx';
import { exportHtml, exportMarkdown } from './exporting.ts';
import { HistoryPane } from './History.tsx';
import { Icon } from './icons.tsx';
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

/** A desk can be away. The host says so, from what its backend reports, and nothing here goes on as if it had worked. */
const quietly = (work: Promise<unknown>): void => void work.catch(() => {});

const PageItem = memo(function PageItem({
  page,
  on,
  live,
  onSelect,
  onDropBefore,
}: {
  page: PageRec;
  on: boolean;
  live: LiveTitles;
  onSelect: (id: string) => void;
  onDropBefore: (draggedId: string, beforeId: string) => void;
}) {
  const liveTitle = useSyncExternalStore(live.subscribe, () => (on ? live.get(page.id) : null));
  const title = (on && liveTitle !== null ? liveTitle : page.title) || 'New note';
  const [over, setOver] = useState(false);
  return (
    <li
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(PAGE_MIME)) {
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
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PAGE_MIME, page.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => onSelect(page.id)}
        data-page-id={page.id}
      >
        <span className="nb-page-title">{title}</span>
        <span className="nb-page-meta">
          {formatWhen(page.updatedAt)}
          <span className="nb-page-snip">{page.snippet}</span>
        </span>
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
}: {
  tab: TabRec;
  on: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onMenu: (el: HTMLElement) => void;
  onDropPage: (pageId: string) => void;
  renaming: boolean;
  onRenamed: () => void;
}) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          if (ref.current) onMenu(ref.current);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (ref.current) onMenu(ref.current);
      }}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(PAGE_MIME);
        if (id) onDropPage(id);
      }}
    >
      <InlineName value={tab.title} label="Tab name" onCommit={onRename} editing={renaming} onDone={onRenamed} />
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
}: {
  backend: NotebookBackend;
  tree: Tree;
  resolved: Resolved;
  select: (sel: Selection) => void;
  onOpenLink?: (href: string) => void;
  onPrint: (pageId: string) => void;
  /** Put the cursor in this page when it opens. */
  focusPageId?: string | null;
}) {
  const { notebook, tab, page } = resolved;
  const live = useMemo(createLiveTitles, []);
  const session = usePageSession(backend, page?.id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ items: MenuItem[]; anchor: HTMLElement; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  const editorRef = useRef<TipTapEditor | null>(null);
  const tablist = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConfirmDelete(false);
    setHistory(false);
  }, [page?.id]);

  const onTitle = useCallback((t: string) => {
    if (page) live.set(page.id, t);
  }, [live, page]);
  const onEditor = useCallback((e: TipTapEditor | null) => {
    editorRef.current = e;
  }, []);

  if (!notebook || !tab) return <div className="nb-empty-state">No notebooks yet.</div>;

  const tabs = tree.tabs[notebook.id] ?? [];
  const pages = tree.pages[tab.id] ?? [];
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
      items: [
        { label: 'Rename', onSelect: () => setRenaming(t.id) },
        { label: 'Color', heading: true },
        ...TAB_COLORS.map((c): MenuItem => ({ label: c[0]?.toUpperCase() + c.slice(1), swatch: c, checked: t.color === c, onSelect: () => quietly(backend.recolorTab(t.id, c)) })),
      ],
    });

  const pageMenu = (el: HTMLElement) => {
    if (!page) return;
    const otherTabs = tabs.filter((t) => t.id !== tab.id);
    setMenu({
      anchor: el,
      label: 'Page actions',
      items: [
        { label: 'Save a version now', onSelect: () => quietly(backend.saveVersion(page.id)) },
        { label: 'History…', onSelect: () => setHistory(true) },
        { label: 'Add tab at this page', onSelect: () => quietly(backend.addTabAtPage(page.id).then((t) => setRenaming(t.id))) },
        ...(otherTabs.length
          ? [{ label: 'Move to tab', heading: true }, ...otherTabs.map((t): MenuItem => ({ label: t.title, swatch: t.color, onSelect: () => quietly(backend.movePage(page.id, t.id)) }))]
          : []),
        { label: 'Export', heading: true },
        { label: 'Markdown (.md)', onSelect: () => quietly(exportMarkdown(backend, page.id)) },
        { label: 'Web page (.html)', onSelect: () => quietly(exportHtml(backend, page.id)) },
        { label: 'Print or save as PDF', onSelect: () => onPrint(page.id) },
        { label: 'Delete page', danger: true, onSelect: () => setConfirmDelete(true) },
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
          <button type="button" className="nb-icon-btn" onClick={() => quietly(addNotebook())} aria-label="New notebook" title="New notebook">
            <Icon name="plus" size={16} />
          </button>
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
                  <InlineName value={n.title} label="Notebook name" onCommit={(t) => quietly(backend.renameNotebook(n.id, t))} editing={renaming === n.id} onDone={() => setRenaming(null)} />
                  <span className="nb-count">{count}</span>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="nb-side-head">
          <h3 id="pg-list-label">Pages in {tab.title}</h3>
          <button type="button" className="nb-icon-btn" onClick={() => quietly(addPage())} aria-label="New page" title="New page" data-testid="new-page">
            <Icon name="plus" size={16} />
          </button>
        </div>
        <ul className="nb-pages" aria-labelledby="pg-list-label">
          {pages.map((p) => (
            <PageItem key={p.id} page={p} on={p.id === page?.id} live={live} onSelect={(id) => select({ pageId: id })} onDropBefore={onDropBefore} />
          ))}
          {!pages.length && <li className="nb-hint">No pages in this tab yet.</li>}
        </ul>
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
                    <button type="button" className="nb-text-btn" onClick={() => quietly(backend.restorePage(p.id).then(() => select({ pageId: p.id })))}>
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
                onRename={(name) => quietly(backend.renameTab(t.id, name))}
                onMenu={(el) => tabMenu(t, el)}
                onDropPage={(id) => quietly(backend.movePage(id, t.id))}
                renaming={renaming === t.id}
                onRenamed={() => setRenaming(null)}
              />
            ))}
          </div>
          <button type="button" className="nb-tab add" onClick={() => quietly(addTab())} aria-label="New tab" title="New tab" data-testid="new-tab">
            <Icon name="plus" size={15} />
          </button>
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
                />
              ) : (
                <div className="nb-editor nb-loading" aria-busy="true" />
              )}
              <footer className="nb-foot">
                <span className="nb-foot-meta">
                  Created {formatWhen(page.createdAt)} · Edited {formatWhen(page.updatedAt)} · {page.wordCount} {page.wordCount === 1 ? 'word' : 'words'}
                </span>
                {confirmDelete ? (
                  <span className="nb-confirm">
                    Delete this page?
                    <button type="button" className="nb-text-btn danger" onClick={() => quietly(trash())}>Delete</button>
                    <button type="button" className="nb-text-btn" onClick={() => setConfirmDelete(false)}>Keep</button>
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
      {menu && <Menu items={menu.items} anchor={menu.anchor} label={menu.label} onClose={() => setMenu(null)} />}
    </div>
  );
}
