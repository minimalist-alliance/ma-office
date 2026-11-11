// The Notebook's records, shaped after design 5.4's tables so a desk-side backend can fill them
// from notebook.db without translation. Times are epoch milliseconds. Days are local calendar
// days, 'YYYY-MM-DD' (design 5.3: bucketed in the desk's time zone).

/** Tab colors are stored as names and mapped per theme (design 3.12). */
export const TAB_COLORS = ['blue', 'green', 'amber', 'rose', 'violet', 'slate'] as const;
export type TabColor = (typeof TAB_COLORS)[number];

export interface NotebookRec {
  id: string;
  title: string;
  sortKey: number;
  createdAt: number;
  updatedAt: number;
  rowVersion: number;
}

export interface TabRec {
  id: string;
  notebookId: string;
  title: string;
  color: TabColor;
  sortKey: number;
  createdAt: number;
  updatedAt: number;
  rowVersion: number;
}

/** A page's metadata. Its text lives in its Y.Doc; title, snippet and counts are derived from it. */
export interface PageRec {
  id: string;
  tabId: string;
  sortKey: number;
  /** The first line, as in Apple Notes (design 5.1). Empty until something is typed. */
  title: string;
  /** About 200 characters of text after the title, for lists. */
  snippet: string;
  wordCount: number;
  hasChecklist: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set when the page is in Trash (design 5.2: kept for 30 days). */
  deletedAt: number | null;
  rowVersion: number;
  /**
   * The page's label (ADR 0091): a color's name, the tabs' six, for organizing. Absent or null is none; a desk sends it only
   * when set, and a desk older than labels never does. Read it through `labelOf`, which treats a name it doesn't know as none.
   */
  label?: TabColor | null;
}

/** Everything the Tab view draws, in order. Built by the backend; never mutated in place. */
export interface Tree {
  notebooks: NotebookRec[];
  /** Tabs by notebook id, in order. */
  tabs: Record<string, TabRec[]>;
  /** Live pages by tab id, in order. Trashed pages aren't here. */
  pages: Record<string, PageRec[]>;
  /** Every page by id, trashed ones included. */
  byId: Record<string, PageRec>;
  /** Trashed pages, newest first. */
  trash: PageRec[];
}

/** Why a version was written (design 5.3). `pre_agent` comes from the desk's agent tools. */
export type VersionReason = 'session' | 'interval' | 'day_end' | 'pre_agent' | 'restore' | 'manual';

export interface VersionMeta {
  id: string;
  pageId: string;
  createdAt: number;
  reason: VersionReason;
  actor: string;
  title: string;
  wordCount: number;
}

export interface Version extends VersionMeta {
  /** ProseMirror JSON of the page body at that moment. */
  doc: import('./schema.ts').PMNode;
}

/** One row per page per local day (design 5.3, `page_activity`). */
export interface ActivityRow {
  pageId: string;
  day: string;
  created: boolean;
  firstAt: number;
  lastAt: number;
  edits: number;
  added: number;
  removed: number;
  actors: string[];
}

export interface SearchOptions {
  notebookId?: string;
  tabId?: string;
  /** Inclusive local days. A page matches if it has activity in the range. */
  fromDay?: string;
  toDay?: string;
  /** Only pages with one of these labels. With no words, lists them by title, as `has:checklist` alone does. */
  labels?: TabColor[];
  limit?: number;
}

/** A [start, end) range of characters to mark in a snippet or title. */
export type MatchRange = [number, number];

export interface SearchHit {
  pageId: string;
  score: number;
  title: string;
  titleMatches: MatchRange[];
  snippet: string;
  snippetMatches: MatchRange[];
  /** The page's label, when it has one. */
  label?: TabColor | null;
}
