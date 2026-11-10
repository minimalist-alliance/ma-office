// Pure helpers over the notebook hierarchy (design 5.2): notebooks hold ordered tabs, tabs hold
// ordered pages. Order is a numeric sort key, so a move rewrites one row.
import type { NotebookRec, PageRec, TabRec, Tree } from './types.ts';

const bySortKey = <T extends { sortKey: number; createdAt: number }>(a: T, b: T): number =>
  a.sortKey - b.sortKey || a.createdAt - b.createdAt;

export function buildTree(notebooks: NotebookRec[], tabs: TabRec[], pages: PageRec[]): Tree {
  const tree: Tree = { notebooks: [...notebooks].sort(bySortKey), tabs: {}, pages: {}, byId: {}, trash: [] };
  for (const t of [...tabs].sort(bySortKey)) (tree.tabs[t.notebookId] ??= []).push(t);
  for (const p of [...pages].sort(bySortKey)) {
    tree.byId[p.id] = p;
    if (p.deletedAt != null) tree.trash.push(p);
    else (tree.pages[p.tabId] ??= []).push(p);
  }
  tree.trash.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  return tree;
}

/** A sort key that lands at `index` in `keys` (sorted ascending), without touching the others. */
export function keyAt(keys: number[], index: number): number {
  if (!keys.length) return 0;
  const i = Math.max(0, Math.min(index, keys.length));
  if (i === 0) return (keys[0] ?? 0) - 1;
  if (i === keys.length) return (keys[keys.length - 1] ?? 0) + 1;
  return ((keys[i - 1] ?? 0) + (keys[i] ?? 0)) / 2;
}

export interface Located {
  notebook: NotebookRec;
  tab: TabRec;
  index: number;
}

export function locate(tree: Tree, pageId: string): Located | null {
  const page = tree.byId[pageId];
  if (!page) return null;
  for (const notebook of tree.notebooks) {
    const tab = (tree.tabs[notebook.id] ?? []).find((t) => t.id === page.tabId);
    if (tab) return { notebook, tab, index: (tree.pages[tab.id] ?? []).findIndex((p) => p.id === pageId) };
  }
  return null;
}

/** A notebook's pages in binder order, across tab boundaries (design 5.2: page through continuously). */
export function binderSequence(tree: Tree, notebookId: string): PageRec[] {
  return (tree.tabs[notebookId] ?? []).flatMap((t) => tree.pages[t.id] ?? []);
}

/** The page before or after this one in its notebook, crossing tabs, or null at either end. */
export function stepPage(tree: Tree, pageId: string, dir: -1 | 1): PageRec | null {
  const loc = locate(tree, pageId);
  if (!loc) return null;
  const seq = binderSequence(tree, loc.notebook.id);
  const i = seq.findIndex((p) => p.id === pageId);
  return seq[i + dir] ?? null;
}

/** For "Add tab at this page": the pages that move into the new tab, this one and those after it. */
export function pagesFrom(tree: Tree, pageId: string): PageRec[] {
  const page = tree.byId[pageId];
  if (!page) return [];
  const list = tree.pages[page.tabId] ?? [];
  const i = list.findIndex((p) => p.id === pageId);
  return i < 0 ? [] : list.slice(i);
}
