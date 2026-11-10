// Search (design 5.6): Ctrl/Cmd+K inside the Notebook. Every word must match, by prefix; title
// hits rank first; `has:checklist` filters. Results open the page.
import { useEffect, useId, useRef, useState } from 'react';
import type { NotebookBackend } from '../model/backend.ts';
import { formatWhen } from '../model/days.ts';
import { locate } from '../model/tree.ts';
import type { SearchHit, Tree } from '../model/types.ts';
import { Highlighted } from './controls.tsx';
import { Icon } from './icons.tsx';

export function SearchOverlay({
  backend,
  tree,
  notebookId,
  onOpen,
  onClose,
}: {
  backend: NotebookBackend;
  tree: Tree;
  notebookId: string | null;
  onOpen: (pageId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'notebook'>('all');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [searched, setSearched] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(null);
  const listId = useId();

  useEffect(() => {
    back.current = document.activeElement;
    input.current?.focus();
    return () => {
      if (back.current instanceof HTMLElement) back.current.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let live = true;
    const q = query.trim();
    backend.search(q, { notebookId: scope === 'notebook' && notebookId ? notebookId : undefined, limit: 30 }).then(
      (h) => {
        if (!live) return;
        setHits(h);
        setActive(0);
        setSearched(q);
      },
      () => {}, // the host says why, and "Nothing matches" would be untrue
    );
    return () => {
      live = false;
    };
  }, [backend, query, scope, notebookId]);

  const open = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpen(hit.pageId);
    onClose();
  };

  return (
    <div
      className="nb-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nb-search" role="dialog" aria-modal="true" aria-label="Search notes">
        <div className="nb-search-field">
          <Icon name="search" />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
            aria-label="Search notes"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => (hits.length ? (i + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                open(hits[active]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
            data-testid="search-input"
          />
          {notebookId && (
            <div className="nb-seg nb-seg-xs" role="radiogroup" aria-label="Where to search">
              <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
                All notebooks
              </button>
              <button type="button" role="radio" aria-checked={scope === 'notebook'} className={scope === 'notebook' ? 'on' : ''} onClick={() => setScope('notebook')}>
                This notebook
              </button>
            </div>
          )}
        </div>
        <ul className="nb-search-results" id={listId} role="listbox" aria-label="Results">
          {hits.map((h, i) => {
            const loc = locate(tree, h.pageId);
            const page = tree.byId[h.pageId];
            return (
              <li
                key={h.pageId}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`nb-search-hit${i === active ? ' on' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => open(h)}
              >
                <span className="nb-search-title">
                  <Highlighted text={h.title || 'New note'} ranges={h.title ? h.titleMatches : []} />
                </span>
                <span className="nb-search-path">
                  {loc ? `${loc.notebook.title} › ${loc.tab.title}` : ''}
                  {page ? ` · ${formatWhen(page.updatedAt)}` : ''}
                </span>
                {h.snippet && (
                  <span className="nb-search-snip">
                    <Highlighted text={h.snippet} ranges={h.snippetMatches} />
                  </span>
                )}
              </li>
            );
          })}
          {searched && !hits.length && <li className="nb-hint">Nothing matches “{searched}”.</li>}
          {!searched && <li className="nb-hint">Type words from a title or a note. Add has:checklist for pages with a checklist.</li>}
        </ul>
      </div>
    </div>
  );
}
