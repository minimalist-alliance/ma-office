// The seam between the Notebook UI and wherever notes live. The UI knows nothing else.
//
// `LocalBackend` (src/local/): IndexedDB in this browser, no network, for the demo and the Desk app's mock. The Desk app's
// `DeskBackend` (web/src/notebook/): the desk, over its link. Page text is a Y.Doc in both, so a provider attaches to the same
// doc (Hocuspocus over the `collab` data channel, design 4.2.5 and 5.5), and the UI doesn't change. Derived data (titles,
// search, activity, versions) is the desk's job there, as `onStoreDocument` (design 5.4); the local backend does the same work
// in this tab.
//
// A desk can be away, so any of these promises can reject. The UI catches them and draws nothing further: the host says what's
// wrong, from what its backend reports.
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { PaletteId } from './colors.ts';
import type { ImportedPage } from './notebookFile.ts';
import type { PMNode } from './schema.ts';
import type {
  ActivityRow,
  NotebookRec,
  PageRec,
  SearchHit,
  SearchOptions,
  TabColor,
  TabRec,
  Tree,
  Version,
  VersionMeta,
} from './types.ts';

/** An open page. Hold it while the page is on screen; `close()` ends the editing session. */
export interface PageSession {
  readonly pageId: string;
  /** The page body. Bind the editor to `doc.getXmlFragment(DOC_FIELD)`. */
  readonly doc: Y.Doc;
  /**
   * Who else is on the page, on a Guild Desk's shared Notebook only: the editor draws their carets and selections from it. Absent on a
   * member's own desk and in the local backend, where nobody else is and no awareness is sent.
   */
  readonly awareness?: Awareness;
  /** Resolves once stored content has been applied, so the editor never opens on an empty doc first. */
  readonly ready: Promise<void>;
  /** Where a page can stop taking text, as a desk does with a full page: calls back now and on each change. The editor keeps what it shows. */
  onReadOnly?(fn: (readOnly: boolean) => void): () => void;
  close(): void;
}

export interface NotebookBackend {
  /** Resolves once `tree()` holds the stored tree. */
  ready(): Promise<void>;
  /** The current tree. A new object after every change, so it works with `useSyncExternalStore`. */
  tree(): Tree;
  /** Called after any change to the tree, including derived titles and counts. */
  subscribe(listener: () => void): () => void;

  // Structure. On a desk these are RPCs, last writer wins (API.md section 13).
  createNotebook(title?: string): Promise<{ notebook: NotebookRec; tab: TabRec; page: PageRec }>;
  renameNotebook(id: string, title: string): Promise<void>;
  createTab(notebookId: string, opts?: { title?: string; color?: TabColor }): Promise<{ tab: TabRec; page: PageRec }>;
  renameTab(id: string, title: string): Promise<void>;
  recolorTab(id: string, color: TabColor): Promise<void>;
  /** Design 5.2: a new tab that starts at this page, taking it and the pages after it in its tab. */
  addTabAtPage(pageId: string, title?: string): Promise<TabRec>;
  /** A new, blank page: first in the tab, or right after the page `after` names. */
  createPage(tabId: string, opts?: { after?: string }): Promise<PageRec>;
  /** Moves a page to another tab (or within one) at `index`, or at the end. */
  movePage(pageId: string, tabId: string, index?: number): Promise<void>;
  trashPage(pageId: string): Promise<void>;
  restorePage(pageId: string): Promise<void>;
  /**
   * A page's label (ADR 0091): a color's name (the tabs' six), or null for none. Metadata, as a tab's color is: last writer wins, it reaches
   * everyone through the tree, and the page's `updatedAt` stays.
   */
  setPageLabel(pageId: string, label: PaletteId | null): Promise<void>;
  /** A copy right after the page in its tab: its text, colors and label, under the copier's name on a guild's desk. Its history starts fresh. */
  duplicatePage(pageId: string): Promise<PageRec>;
  /** A new page from a notebook file's page (`notebookFile.ts`): first in the tab, or right after the page `after` names. */
  importPage(tabId: string, page: ImportedPage, opts?: { after?: string }): Promise<PageRec>;

  // Text.
  openPage(pageId: string): PageSession;
  /** A page's body without opening an editing session: for export and read-only views. */
  pageContent(pageId: string): Promise<PMNode>;

  // History (design 5.3).
  versions(pageId: string): Promise<VersionMeta[]>;
  version(versionId: string): Promise<Version | null>;
  /** Writes a version of the page as it stands now. */
  saveVersion(pageId: string, reason?: 'manual' | 'pre_agent'): Promise<VersionMeta | null>;
  /** Non-destructive: the restored text is a new edit, with its own version. */
  restoreVersion(pageId: string, versionId: string): Promise<void>;
  /** The page as it stood at the end of that local day: the last version written that day or before, or null. */
  versionAsOf(pageId: string, day: string): Promise<Version | null>;

  // Temporal view and search.
  /** Activity rows for days in [fromDay, toDay], inclusive. */
  activity(fromDay: string, toDay: string): Promise<ActivityRow[]>;
  /** Every local day that has any activity, newest first. */
  activeDays(): Promise<string[]>;
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
}
