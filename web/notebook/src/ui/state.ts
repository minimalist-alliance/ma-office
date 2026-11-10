// UI state that isn't the backend's: which view and page are showing. Kept per browser, like the
// Desk app's layout (ADR 0005), under one localStorage key the host chooses.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { NotebookBackend } from '../model/backend.ts';
import type { NotebookRec, PageRec, TabRec, Tree } from '../model/types.ts';

export type View = 'tabs' | 'temporal';

export interface Selection {
  notebookId?: string;
  tabId?: string;
  pageId?: string;
}

export interface UiState {
  view: View;
  sel: Selection;
}

export function useTree(backend: NotebookBackend): Tree {
  return useSyncExternalStore(
    useCallback((cb: () => void) => backend.subscribe(cb), [backend]),
    () => backend.tree(),
  );
}

function read(key: string): UiState | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<UiState>;
    return { view: v.view === 'temporal' ? 'temporal' : 'tabs', sel: typeof v.sel === 'object' && v.sel ? v.sel : {} };
  } catch {
    return null;
  }
}

export function useUiState(key: string, initialView: View): [UiState, (patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => void] {
  const [state, setState] = useState<UiState>(() => read(key) ?? { view: initialView, sel: {} });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Private mode or storage off: the Notebook still works, it just won't remember the page.
    }
  }, [key, state]);
  const update = useCallback((patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => {
    setState((s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  }, []);
  return [state, update];
}

export interface Resolved {
  notebook: NotebookRec | null;
  tab: TabRec | null;
  page: PageRec | null;
}

/** The selection, made valid against the tree: a missing notebook, tab or page falls back to the first. */
export function resolve(tree: Tree, sel: Selection): Resolved {
  const page = sel.pageId ? tree.byId[sel.pageId] : undefined;
  const livePage = page && page.deletedAt == null ? page : undefined;
  // A page wins: it says which tab and notebook it's in.
  if (livePage) {
    for (const nb of tree.notebooks) {
      const tab = (tree.tabs[nb.id] ?? []).find((t) => t.id === livePage.tabId);
      if (tab) return { notebook: nb, tab, page: livePage };
    }
  }
  const notebook = tree.notebooks.find((n) => n.id === sel.notebookId) ?? tree.notebooks[0] ?? null;
  const tabs = notebook ? (tree.tabs[notebook.id] ?? []) : [];
  const tab = tabs.find((t) => t.id === sel.tabId) ?? tabs[0] ?? null;
  const pageInTab = tab ? (tree.pages[tab.id] ?? [])[0] : undefined;
  return { notebook, tab, page: pageInTab ?? null };
}
