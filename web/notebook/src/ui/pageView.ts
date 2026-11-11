// The page list's filter and sort by color label. A view setting of this browser only, per notebook, like the Notebook's
// other UI state (state.ts): it's never sent to the desk and never syncs, so two people on a shared notebook each see the
// list their own way. The labels themselves are page data (`label` on a page, from the backend).
import { useCallback, useEffect, useState } from 'react';
import { labelOf as modelLabelOf, sortByLabel } from '../model/tree.ts';
import type { PageRec } from '../model/types.ts';
import { PALETTE, toPaletteId, type PaletteId } from './palette.ts';

/** The ids this palette colors, in its order. */
const IDS: PaletteId[] = PALETTE.map((p) => p.id);

export type PageSort = 'manual' | 'label';

export interface PageListView {
  /** Show pages with these labels. Empty, with `none` false, shows every page. */
  labels: PaletteId[];
  /** Show pages with no label. */
  none: boolean;
  sort: PageSort;
}

export const ALL_PAGES: PageListView = { labels: [], none: false, sort: 'manual' };

/** A page's label, from the read model (`model/tree.ts`): an id this palette colors, or null for none. */
export function labelOf(page: PageRec): PaletteId | null {
  return toPaletteId(modelLabelOf(page));
}

export const isFiltered = (v: PageListView): boolean => v.labels.length > 0 || v.none;

/** The pages to list, filtered and then sorted. Sorting by label keeps the manual order within a label, and puts none last. */
export function applyView(pages: PageRec[], v: PageListView): PageRec[] {
  const shown = isFiltered(v)
    ? pages.filter((p) => {
        const l = labelOf(p);
        return l ? v.labels.includes(l) : v.none;
      })
    : pages;
  return v.sort === 'label' ? sortByLabel(shown) : shown;
}

/** How many pages have each label, and none. */
export function labelCounts(pages: PageRec[]): Record<PaletteId | 'none', number> {
  const out = Object.fromEntries([...IDS, 'none'].map((k) => [k, 0])) as Record<PaletteId | 'none', number>;
  for (const p of pages) out[labelOf(p) ?? 'none'] += 1;
  return out;
}

/** Turns one label (or "no label") on or off in the filter. */
export function toggleLabel(v: PageListView, which: PaletteId | 'none'): PageListView {
  if (which === 'none') return { ...v, none: !v.none };
  const labels = v.labels.includes(which) ? v.labels.filter((l) => l !== which) : [...v.labels, which];
  // Kept in palette order, so the same filter is always stored the same way.
  return { ...v, labels: IDS.filter((id) => labels.includes(id)) };
}

/** Reads what was stored, keeping only what this build understands. */
export function readView(raw: unknown): PageListView {
  if (!raw || typeof raw !== 'object') return ALL_PAGES;
  const r = raw as Partial<Record<keyof PageListView, unknown>>;
  const labels = Array.isArray(r.labels) ? IDS.filter((id) => (r.labels as unknown[]).includes(id)) : [];
  return { labels, none: r.none === true, sort: r.sort === 'label' ? 'label' : 'manual' };
}

const isDefault = (v: PageListView): boolean => !isFiltered(v) && v.sort === 'manual';

function load(key: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The view for one notebook, remembered in this browser under `<stateKey>.pages`. */
export function usePageListView(stateKey: string, notebookId: string | undefined): [PageListView, (next: PageListView) => void] {
  const key = `${stateKey}.pages`;
  const [all, setAll] = useState<Record<string, unknown>>(() => load(key));
  useEffect(() => setAll(load(key)), [key]);
  const view = notebookId ? readView(all[notebookId]) : ALL_PAGES;
  const set = useCallback(
    (next: PageListView) => {
      if (!notebookId) return;
      setAll((prev) => {
        const out = { ...prev };
        if (isDefault(next)) delete out[notebookId];
        else out[notebookId] = next;
        try {
          if (Object.keys(out).length) window.localStorage.setItem(key, JSON.stringify(out));
          else window.localStorage.removeItem(key);
        } catch {
          // Storage off: the filter still works, it just isn't remembered.
        }
        return out;
      });
    },
    [key, notebookId],
  );
  return [view, set];
}
