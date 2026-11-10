// The Notebook app: Tab view and Temporal view (design 5), on any NotebookBackend. It fills its
// container. The host draws the window around it and may put things at either end of its header.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { NotebookBackend } from '../model/backend.ts';
import type { PMNode } from '../model/schema.ts';
import { Segmented } from './controls.tsx';
import { ReadOnlyDoc } from './Editor.tsx';
import { Icon } from './icons.tsx';
import { SearchOverlay } from './Search.tsx';
import { resolve, useTree, useUiState, type Selection, type View } from './state.ts';
import { TabView } from './TabView.tsx';
import { TemporalView } from './TemporalView.tsx';

export interface NotebookProps {
  backend: NotebookBackend;
  /** localStorage key for this browser's view and last page. One per desk. */
  stateKey?: string;
  initialView?: View;
  /** Mod-click on a link in a note. Nothing in the Notebook ever fetches a link. */
  onOpenLink?: (href: string) => void;
  /** Before the view switch in the header: the window title, when the host has no title bar of its own. */
  headerStart?: ReactNode;
  /** After the search button: a close button, say. */
  headerEnd?: ReactNode;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** One at a time per backend, however many times this mounts, as React's strict mode and a reopened window do. */
const firstNotebook = new WeakMap<NotebookBackend, Promise<unknown>>();
function ensureNotebook(backend: NotebookBackend): Promise<unknown> {
  if (backend.tree().notebooks.length) return Promise.resolve();
  let making = firstNotebook.get(backend);
  if (!making) {
    making = backend.createNotebook('Notebook').finally(() => firstNotebook.delete(backend));
    firstNotebook.set(backend, making);
  }
  return making;
}

/** The browser's print, of one page alone: notebook.css hides everything else under @media print. */
function PrintHost({ doc, onDone }: { doc: PMNode; onDone: () => void }) {
  useEffect(() => {
    const after = () => onDone();
    window.addEventListener('afterprint', after);
    // Two frames: the read-only page has to be laid out before the print snapshot is taken.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('afterprint', after);
    };
  }, [onDone]);
  return createPortal(
    <div className="nb-print ma-nb-portal" data-testid="print-view">
      <ReadOnlyDoc doc={doc} />
    </div>,
    document.body,
  );
}

export function Notebook({ backend, stateKey = 'ma.notebook.ui', initialView = 'tabs', onOpenLink, headerStart, headerEnd }: NotebookProps) {
  const tree = useTree(backend);
  const [ready, setReady] = useState(false);
  const [ui, setUi] = useUiState(stateKey, initialView);
  const [searching, setSearching] = useState(false);
  const [printing, setPrinting] = useState<PMNode | null>(null);
  // A page opened from search or the Temporal view takes the cursor; one picked in a list doesn't.
  const [focusPage, setFocusPage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    backend
      .ready()
      .then(async () => {
        // A first visit gets one notebook to write in, rather than an empty screen.
        await ensureNotebook(backend);
        if (live) setReady(true);
      })
      .catch(() => {}); // the host says why
    return () => {
      live = false;
    };
  }, [backend]);

  const resolved = resolve(tree, ui.sel);
  const select = useCallback((sel: Selection) => setUi({ sel }), [setUi]);
  const openPage = useCallback(
    (pageId: string) => {
      setFocusPage(pageId);
      setUi({ view: 'tabs', sel: { pageId } });
    },
    [setUi],
  );
  const print = useCallback((pageId: string) => void backend.pageContent(pageId).then(setPrinting, () => {}), [backend]);
  const endPrint = useCallback(() => setPrinting(null), []);

  return (
    <div
      className="ma-nb"
      data-testid="notebook"
      onKeyDown={(e) => {
        if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          setSearching(true);
        }
      }}
    >
      <div className="nb-head">
        {headerStart}
        <div className="nb-head-controls">
          <Segmented<View>
            label="Notebook view"
            value={ui.view}
            onChange={(view) => setUi({ view })}
            options={[
              { value: 'tabs', label: 'Tab view', icon: <Icon name="tabs" size={15} /> },
              { value: 'temporal', label: 'Temporal view', icon: <Icon name="calendar" size={15} /> },
            ]}
          />
          <button type="button" className="nb-search-btn" onClick={() => setSearching(true)} aria-label="Search notes" aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>
            <Icon name="search" size={16} />
            <span>Search</span>
            <kbd data-keys={isMac ? '⌘K' : 'Ctrl K'} aria-hidden="true" />
          </button>
        </div>
        {headerEnd}
      </div>
      <div className="nb-body">
        {!ready ? null : ui.view === 'tabs' ? (
          <TabView backend={backend} tree={tree} resolved={resolved} select={select} onOpenLink={onOpenLink} onPrint={print} focusPageId={focusPage} />
        ) : (
          <TemporalView backend={backend} tree={tree} onOpen={openPage} />
        )}
      </div>
      {searching && <SearchOverlay backend={backend} tree={tree} notebookId={resolved.notebook?.id ?? null} onOpen={openPage} onClose={() => setSearching(false)} />}
      {printing && <PrintHost doc={printing} onDone={endPrint} />}
    </div>
  );
}
