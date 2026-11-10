// NotebookBackend on this browser's IndexedDB. No network, no account.
//
// It plays both halves of design 5.4/5.5 in this tab: the client's page cache (Yjs updates kept
// as they're typed, like y-indexeddb) and deskd's `onStoreDocument` work (titles, search text,
// `page_activity`, versions), debounced 2 s with a 10 s ceiling as the design has it. A desk
// backend replaces all of this with a sync provider on the same Y.Doc plus RPCs.
//
// Two tabs of the same browser each keep their own copy of an open page. Nothing is lost (both
// write Yjs updates, which merge), but one doesn't see the other's typing until the page reopens.
import { Node } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import type { NotebookBackend, PageSession } from '../model/backend.ts';
import { dayKey, endOfDay } from '../model/days.ts';
import { derive, type Derived } from '../model/derive.ts';
import { SESSION_IDLE_MS, INTERVAL_MS, TRASH_KEEP_MS, versionAt, versionsToPrune } from '../model/history.ts';
import { BLANK_PAGE, DOC_FIELD, notebookSchema, type PMNode } from '../model/schema.ts';
import { parseQuery, SearchIndex } from '../model/search.ts';
import { buildTree, keyAt, pagesFrom } from '../model/tree.ts';
import {
  TAB_COLORS,
  type ActivityRow,
  type NotebookRec,
  type PageRec,
  type SearchHit,
  type SearchOptions,
  type TabColor,
  type TabRec,
  type Tree,
  type Version,
  type VersionMeta,
  type VersionReason,
} from '../model/types.ts';
import { getAll, getAllByIndex, get, openDb, req, STORES, write } from './idb.ts';

export interface LocalBackendOptions {
  /** IndexedDB database name. One per desk when the Desk app adopts this. */
  dbName?: string;
  /** For tests: fake-indexeddb's factory. */
  idb?: IDBFactory;
  now?: () => number;
  /** Design 5.4: the store runs 2 s after typing stops, and at least every 10 s while it goes on. */
  storeDebounceMs?: number;
  storeMaxWaitMs?: number;
  /** Typed updates are batched this long before they're written to IndexedDB. */
  writeBatchMs?: number;
  sessionIdleMs?: number;
  intervalMs?: number;
  actor?: string;
}

/** For seeding fixtures and imports: a page with its body and history, written in one go. */
export interface ImportPage {
  rec: PageRec;
  doc: PMNode;
  activity?: ActivityRow[];
  versions?: { id: string; createdAt: number; reason: VersionReason; doc: PMNode }[];
}

const LOAD = Symbol('notebook-load');
const RESTORE = Symbol('notebook-restore');
const COMPACT_AFTER = 20;

interface UpdateRow {
  pageId: string;
  update: Uint8Array;
}
interface TextRow {
  id: string;
  text: string;
}
interface DayEdits {
  count: number;
  firstAt: number;
  lastAt: number;
}

interface Open {
  pageId: string;
  doc: Y.Doc;
  refs: number;
  ready: Promise<void>;
  pending: Uint8Array[];
  writeTimer: ReturnType<typeof setTimeout> | null;
  deriveTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Edits not yet derived, by local day. */
  edits: Map<string, DayEdits>;
  firstUnderivedAt: number | null;
  dirtySinceVersion: boolean;
  lastVersionAt: number;
  lastEditAt: number;
  textLength: number;
  /** A day_end snapshot taken at the first edit after midnight, waiting to be written. */
  dayEnd: { doc: PMNode; at: number } | null;
}

export const uid = (): string => crypto.randomUUID();

export class LocalBackend implements NotebookBackend {
  private readonly opts: Required<Omit<LocalBackendOptions, 'idb'>> & { idb: IDBFactory | undefined };
  private db: IDBDatabase | null = null;
  private loading: Promise<void> | null = null;
  private notebooks = new Map<string, NotebookRec>();
  private tabs = new Map<string, TabRec>();
  private pages = new Map<string, PageRec>();
  private activityRows = new Map<string, ActivityRow>();
  private current: Tree = buildTree([], [], []);
  private listeners = new Set<() => void>();
  private open = new Map<string, Open>();
  private index: SearchIndex | null = null;
  private indexLoading: Promise<SearchIndex> | null = null;
  private inflight = new Set<Promise<unknown>>();
  private lastVersionAt = new Map<string, number>();

  constructor(options: LocalBackendOptions = {}) {
    this.opts = {
      dbName: options.dbName ?? 'ma-notebook-local',
      idb: options.idb,
      now: options.now ?? (() => Date.now()),
      storeDebounceMs: options.storeDebounceMs ?? 2000,
      storeMaxWaitMs: options.storeMaxWaitMs ?? 10_000,
      writeBatchMs: options.writeBatchMs ?? 150,
      sessionIdleMs: options.sessionIdleMs ?? SESSION_IDLE_MS,
      intervalMs: options.intervalMs ?? INTERVAL_MS,
      actor: options.actor ?? 'user',
    };
  }

  // ---------------------------------------------------------------- lifecycle

  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    this.db = await openDb(this.opts.dbName, this.opts.idb ?? indexedDB);
    const [nbs, tabs, pages, activity] = await Promise.all([
      getAll<NotebookRec>(this.db, STORES.notebooks),
      getAll<TabRec>(this.db, STORES.tabs),
      getAll<PageRec>(this.db, STORES.pages),
      getAll<ActivityRow>(this.db, STORES.activity),
    ]);
    for (const n of nbs) this.notebooks.set(n.id, n);
    for (const t of tabs) this.tabs.set(t.id, t);
    for (const p of pages) this.pages.set(p.id, p);
    for (const a of activity) this.activityRows.set(`${a.pageId}|${a.day}`, a);
    await this.housekeeping();
    this.emit();
  }

  /** Empties Trash older than 30 days and thins old versions (design 5.2, 5.3). */
  private async housekeeping(): Promise<void> {
    const db = this.mustDb();
    const now = this.opts.now();
    const expired = [...this.pages.values()].filter((p) => p.deletedAt != null && now - p.deletedAt > TRASH_KEEP_MS);
    for (const p of expired) await this.purgePage(p.id);
    const metas = await getAll<VersionMeta>(db, STORES.versions);
    const drop = versionsToPrune(metas, now);
    if (drop.length) {
      await write(db, [STORES.versions, STORES.versionDocs], (tx) => {
        for (const id of drop) {
          tx.objectStore(STORES.versions).delete(id);
          tx.objectStore(STORES.versionDocs).delete(id);
        }
      });
    }
  }

  private async purgePage(pageId: string): Promise<void> {
    const db = this.mustDb();
    const versionIds = (await getAllByIndex<VersionMeta>(db, STORES.versions, 'byPage', pageId)).map((v) => v.id);
    const updateKeys = await req(db.transaction(STORES.updates).objectStore(STORES.updates).index('byPage').getAllKeys(pageId));
    const days = [...this.activityRows.values()].filter((a) => a.pageId === pageId).map((a) => a.day);
    await write(db, [STORES.pages, STORES.texts, STORES.updates, STORES.versions, STORES.versionDocs, STORES.activity], (tx) => {
      tx.objectStore(STORES.pages).delete(pageId);
      tx.objectStore(STORES.texts).delete(pageId);
      for (const k of updateKeys) tx.objectStore(STORES.updates).delete(k);
      for (const id of versionIds) {
        tx.objectStore(STORES.versions).delete(id);
        tx.objectStore(STORES.versionDocs).delete(id);
      }
      for (const day of days) tx.objectStore(STORES.activity).delete([pageId, day]);
    });
    this.pages.delete(pageId);
    for (const day of days) this.activityRows.delete(`${pageId}|${day}`);
    this.index?.delete(pageId);
  }

  /** Writes everything typed so far and runs the store for every open page. For tests and `pagehide`. */
  async flush(): Promise<void> {
    await Promise.all([...this.open.values()].map((o) => this.flushOpen(o)));
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** Ends every editing session, as closing the window does. */
  async close(): Promise<void> {
    for (const o of [...this.open.values()]) {
      o.refs = 1;
      this.release(o);
    }
    await this.flush();
    this.db?.close();
    this.db = null;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  private mustDb(): IDBDatabase {
    if (!this.db) throw new Error('LocalBackend: call ready() first');
    return this.db;
  }

  // ---------------------------------------------------------------- tree

  tree(): Tree {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.current = buildTree([...this.notebooks.values()], [...this.tabs.values()], [...this.pages.values()]);
    for (const l of [...this.listeners]) l();
  }

  private bump<T extends { rowVersion: number; updatedAt: number }>(rec: T, patch: Partial<T>): T {
    return { ...rec, ...patch, rowVersion: rec.rowVersion + 1, updatedAt: this.opts.now() };
  }

  private blankPage(tabId: string, sortKey: number): { rec: PageRec; update: Uint8Array } {
    const now = this.opts.now();
    const rec: PageRec = {
      id: uid(),
      tabId,
      sortKey,
      title: '',
      snippet: '',
      wordCount: 0,
      hasChecklist: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      rowVersion: 1,
    };
    const update = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(notebookSchema(), BLANK_PAGE, DOC_FIELD));
    return { rec, update };
  }

  private createdRow(rec: PageRec): ActivityRow {
    return {
      pageId: rec.id,
      day: dayKey(rec.createdAt),
      created: true,
      firstAt: rec.createdAt,
      lastAt: rec.createdAt,
      edits: 0,
      added: 0,
      removed: 0,
      actors: [this.opts.actor],
    };
  }

  /** Puts records and a new page (if any) in one transaction, then updates memory and tells listeners. */
  private async commit(opts: {
    notebooks?: NotebookRec[];
    tabs?: TabRec[];
    pages?: PageRec[];
    newPage?: { rec: PageRec; update: Uint8Array };
  }): Promise<void> {
    const db = this.mustDb();
    const newRow = opts.newPage ? this.createdRow(opts.newPage.rec) : null;
    await write(db, [STORES.notebooks, STORES.tabs, STORES.pages, STORES.updates, STORES.activity], (tx) => {
      for (const n of opts.notebooks ?? []) tx.objectStore(STORES.notebooks).put(n);
      for (const t of opts.tabs ?? []) tx.objectStore(STORES.tabs).put(t);
      for (const p of opts.pages ?? []) tx.objectStore(STORES.pages).put(p);
      if (opts.newPage && newRow) {
        tx.objectStore(STORES.pages).put(opts.newPage.rec);
        tx.objectStore(STORES.updates).add({ pageId: opts.newPage.rec.id, update: opts.newPage.update } satisfies UpdateRow);
        tx.objectStore(STORES.activity).put(newRow);
      }
    });
    for (const n of opts.notebooks ?? []) this.notebooks.set(n.id, n);
    for (const t of opts.tabs ?? []) this.tabs.set(t.id, t);
    for (const p of opts.pages ?? []) this.pages.set(p.id, p);
    if (opts.newPage && newRow) {
      this.pages.set(opts.newPage.rec.id, opts.newPage.rec);
      this.activityRows.set(`${newRow.pageId}|${newRow.day}`, newRow);
      this.index?.set(opts.newPage.rec.id, '', '');
    }
    this.emit();
  }

  private tabsOf(notebookId: string): TabRec[] {
    return this.current.tabs[notebookId] ?? [];
  }

  async createNotebook(title = 'New notebook'): Promise<{ notebook: NotebookRec; tab: TabRec; page: PageRec }> {
    const now = this.opts.now();
    const notebook: NotebookRec = {
      id: uid(),
      title,
      sortKey: keyAt(this.current.notebooks.map((n) => n.sortKey), this.current.notebooks.length),
      createdAt: now,
      updatedAt: now,
      rowVersion: 1,
    };
    const tab: TabRec = { id: uid(), notebookId: notebook.id, title: 'General', color: 'blue', sortKey: 0, createdAt: now, updatedAt: now, rowVersion: 1 };
    const page = this.blankPage(tab.id, 0);
    await this.commit({ notebooks: [notebook], tabs: [tab], newPage: page });
    return { notebook, tab, page: page.rec };
  }

  async renameNotebook(id: string, title: string): Promise<void> {
    const n = this.notebooks.get(id);
    if (n && title.trim()) await this.commit({ notebooks: [this.bump(n, { title: title.trim() })] });
  }

  async createTab(notebookId: string, o: { title?: string; color?: TabColor } = {}): Promise<{ tab: TabRec; page: PageRec }> {
    const existing = this.tabsOf(notebookId);
    const now = this.opts.now();
    const tab: TabRec = {
      id: uid(),
      notebookId,
      title: o.title ?? 'New tab',
      color: o.color ?? TAB_COLORS[existing.length % TAB_COLORS.length] ?? 'blue',
      sortKey: keyAt(existing.map((t) => t.sortKey), existing.length),
      createdAt: now,
      updatedAt: now,
      rowVersion: 1,
    };
    const page = this.blankPage(tab.id, 0);
    await this.commit({ tabs: [tab], newPage: page });
    return { tab, page: page.rec };
  }

  async renameTab(id: string, title: string): Promise<void> {
    const t = this.tabs.get(id);
    if (t && title.trim()) await this.commit({ tabs: [this.bump(t, { title: title.trim() })] });
  }

  async recolorTab(id: string, color: TabColor): Promise<void> {
    const t = this.tabs.get(id);
    if (t) await this.commit({ tabs: [this.bump(t, { color })] });
  }

  async addTabAtPage(pageId: string, title?: string): Promise<TabRec> {
    const page = this.pages.get(pageId);
    const from = page ? this.tabs.get(page.tabId) : undefined;
    if (!page || !from) throw new Error('addTabAtPage: no such page');
    const siblings = this.tabsOf(from.notebookId);
    const at = siblings.findIndex((t) => t.id === from.id) + 1;
    const now = this.opts.now();
    const tab: TabRec = {
      id: uid(),
      notebookId: from.notebookId,
      title: title?.trim() || page.title.slice(0, 40) || 'New tab',
      color: TAB_COLORS[(TAB_COLORS.indexOf(from.color) + 1) % TAB_COLORS.length] ?? 'blue',
      sortKey: keyAt(siblings.map((t) => t.sortKey), at),
      createdAt: now,
      updatedAt: now,
      rowVersion: 1,
    };
    // Sort keys travel with the pages, so they keep their order in the new tab.
    // A move isn't an edit, so updatedAt stays.
    const moved = pagesFrom(this.current, pageId).map((p) => ({ ...p, tabId: tab.id, rowVersion: p.rowVersion + 1 }));
    await this.commit({ tabs: [tab], pages: moved });
    return tab;
  }

  async createPage(tabId: string, o: { after?: string } = {}): Promise<PageRec> {
    const list = this.current.pages[tabId] ?? [];
    const keys = list.map((p) => p.sortKey);
    const afterIdx = o.after ? list.findIndex((p) => p.id === o.after) : -1;
    const page = this.blankPage(tabId, keyAt(keys, afterIdx + 1));
    await this.commit({ newPage: page });
    return page.rec;
  }

  async movePage(pageId: string, tabId: string, index?: number): Promise<void> {
    const page = this.pages.get(pageId);
    if (!page || !this.tabs.has(tabId)) return;
    const others = (this.current.pages[tabId] ?? []).filter((p) => p.id !== pageId);
    const sortKey = keyAt(others.map((p) => p.sortKey), index ?? others.length);
    await this.commit({ pages: [{ ...page, tabId, sortKey, rowVersion: page.rowVersion + 1 }] });
  }

  async trashPage(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (page && page.deletedAt == null) await this.commit({ pages: [{ ...page, deletedAt: this.opts.now(), rowVersion: page.rowVersion + 1 }] });
  }

  async restorePage(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (!page || page.deletedAt == null) return;
    let tabId = page.tabId;
    if (!this.tabs.has(tabId)) {
      // Its tab went while it was in Trash: back to the first tab there is.
      const firstNb = this.current.notebooks[0];
      const first = firstNb ? this.tabsOf(firstNb.id)[0] : undefined;
      if (!first) return;
      tabId = first.id;
    }
    await this.commit({ pages: [{ ...page, tabId, deletedAt: null, rowVersion: page.rowVersion + 1 }] });
  }

  // ---------------------------------------------------------------- text

  openPage(pageId: string): PageSession {
    let o = this.open.get(pageId);
    if (!o) {
      const doc = new Y.Doc({ gc: true });
      const entry: Open = {
        pageId,
        doc,
        refs: 0,
        ready: Promise.resolve(),
        pending: [],
        writeTimer: null,
        deriveTimer: null,
        idleTimer: null,
        edits: new Map(),
        firstUnderivedAt: null,
        dirtySinceVersion: false,
        lastVersionAt: this.opts.now(),
        lastEditAt: 0,
        textLength: 0,
        dayEnd: null,
      };
      entry.ready = this.track(this.loadInto(entry));
      this.open.set(pageId, entry);
      o = entry;
    }
    o.refs += 1;
    const entry = o;
    let closed = false;
    return {
      pageId,
      doc: entry.doc,
      ready: entry.ready,
      close: () => {
        if (closed) return;
        closed = true;
        this.release(entry);
      },
    };
  }

  private async loadInto(o: Open): Promise<void> {
    const db = this.mustDb();
    const tx = db.transaction([STORES.updates, STORES.texts], 'readonly');
    const idx = tx.objectStore(STORES.updates).index('byPage');
    const [keys, rows, text] = await Promise.all([
      req(idx.getAllKeys(o.pageId)),
      req(idx.getAll(o.pageId) as IDBRequest<UpdateRow[]>),
      req(tx.objectStore(STORES.texts).get(o.pageId) as IDBRequest<TextRow | undefined>),
    ]);
    if (rows.length) Y.applyUpdate(o.doc, rows.length === 1 ? (rows[0] as UpdateRow).update : Y.mergeUpdates(rows.map((r) => r.update)), LOAD);
    o.textLength = text?.text.length ?? 0;
    o.doc.on('beforeTransaction', (tr: Y.Transaction) => this.beforeEdit(o, tr));
    o.doc.on('update', (update: Uint8Array, origin: unknown) => this.onUpdate(o, update, origin));
    if (rows.length > COMPACT_AFTER) {
      const merged = Y.encodeStateAsUpdate(o.doc);
      await this.track(
        write(db, [STORES.updates], (wtx) => {
          const s = wtx.objectStore(STORES.updates);
          for (const k of keys) s.delete(k);
          s.add({ pageId: o.pageId, update: merged } satisfies UpdateRow);
        }),
      );
    }
  }

  /** The first edit after local midnight snapshots the page as the day left it (design 5.3, day_end). */
  private beforeEdit(o: Open, tr: Y.Transaction): void {
    if (tr.origin === LOAD || !o.dirtySinceVersion || !o.lastEditAt || o.dayEnd) return;
    if (dayKey(this.opts.now()) !== dayKey(o.lastEditAt)) o.dayEnd = { doc: this.json(o), at: o.lastEditAt };
  }

  private onUpdate(o: Open, update: Uint8Array, origin: unknown): void {
    if (origin === LOAD) return;
    const now = this.opts.now();
    o.pending.push(update);
    o.writeTimer ??= setTimeout(() => {
      o.writeTimer = null;
      void this.track(this.writePending(o));
    }, this.opts.writeBatchMs);

    const day = dayKey(now);
    const e = o.edits.get(day);
    if (e) {
      e.count += 1;
      e.lastAt = now;
    } else o.edits.set(day, { count: 1, firstAt: now, lastAt: now });
    o.lastEditAt = now;
    o.dirtySinceVersion = true;
    o.firstUnderivedAt ??= now;

    if (o.deriveTimer) clearTimeout(o.deriveTimer);
    const wait = Math.max(0, Math.min(this.opts.storeDebounceMs, o.firstUnderivedAt + this.opts.storeMaxWaitMs - now));
    o.deriveTimer = setTimeout(() => {
      o.deriveTimer = null;
      void this.track(this.store(o));
    }, wait);

    if (o.idleTimer) clearTimeout(o.idleTimer);
    o.idleTimer = setTimeout(() => {
      o.idleTimer = null;
      void this.track(this.endSession(o));
    }, this.opts.sessionIdleMs);
  }

  private async writePending(o: Open): Promise<void> {
    if (!o.pending.length) return;
    const update = o.pending.length === 1 ? (o.pending[0] as Uint8Array) : Y.mergeUpdates(o.pending);
    o.pending = [];
    await write(this.mustDb(), [STORES.updates], (tx) => {
      tx.objectStore(STORES.updates).add({ pageId: o.pageId, update } satisfies UpdateRow);
    });
  }

  private json(o: Open): PMNode {
    return yXmlFragmentToProsemirrorJSON(o.doc.getXmlFragment(DOC_FIELD)) as PMNode;
  }

  /** deskd's onStoreDocument, in this tab: derived fields, search text, activity, interval versions. */
  private async store(o: Open, versionReason?: VersionReason): Promise<void> {
    if (o.deriveTimer) {
      clearTimeout(o.deriveTimer);
      o.deriveTimer = null;
    }
    const rec = this.pages.get(o.pageId);
    if (!rec) return;
    const edited = o.edits.size > 0;
    if (!edited && !versionReason) return;
    const now = this.opts.now();
    const doc = this.json(o);
    const d = derive(doc);
    const edits = o.edits;
    o.edits = new Map();
    o.firstUnderivedAt = null;

    const delta = d.text.length - o.textLength;
    o.textLength = d.text.length;
    const rows: ActivityRow[] = [];
    const lastDay = [...edits.keys()].sort().pop();
    for (const [day, e] of edits) {
      const key = `${o.pageId}|${day}`;
      const prev = this.activityRows.get(key);
      const row: ActivityRow = prev
        ? { ...prev, firstAt: Math.min(prev.firstAt, e.firstAt), lastAt: Math.max(prev.lastAt, e.lastAt), edits: prev.edits + e.count }
        : { pageId: o.pageId, day, created: false, firstAt: e.firstAt, lastAt: e.lastAt, edits: e.count, added: 0, removed: 0, actors: [] };
      if (day === lastDay) {
        if (delta > 0) row.added += delta;
        else row.removed -= delta;
      }
      if (!row.actors.includes(this.opts.actor)) row.actors = [...row.actors, this.opts.actor];
      rows.push(row);
    }

    const versions: { meta: VersionMeta; doc: PMNode }[] = [];
    if (o.dayEnd) {
      versions.push({ meta: this.versionMeta(o.pageId, o.dayEnd.at, 'day_end', derive(o.dayEnd.doc)), doc: o.dayEnd.doc });
      o.dayEnd = null;
    }
    const reason = versionReason ?? (edited && now - o.lastVersionAt >= this.opts.intervalMs ? 'interval' : undefined);
    if (reason) {
      // Two versions in one millisecond (a restore right after a save) still sort in the order written.
      const at = Math.max(now, (this.lastVersionAt.get(o.pageId) ?? 0) + 1);
      this.lastVersionAt.set(o.pageId, at);
      versions.push({ meta: this.versionMeta(o.pageId, at, reason, d), doc });
      o.dirtySinceVersion = false;
      o.lastVersionAt = now;
    }

    const changed =
      edited && (rec.title !== d.title || rec.snippet !== d.snippet || rec.wordCount !== d.wordCount || rec.hasChecklist !== d.hasChecklist || o.lastEditAt > rec.updatedAt);
    const next: PageRec = changed
      ? { ...rec, title: d.title, snippet: d.snippet, wordCount: d.wordCount, hasChecklist: d.hasChecklist, updatedAt: Math.max(rec.updatedAt, o.lastEditAt), rowVersion: rec.rowVersion + 1 }
      : rec;

    await write(this.mustDb(), [STORES.pages, STORES.texts, STORES.activity, STORES.versions, STORES.versionDocs], (tx) => {
      if (changed) tx.objectStore(STORES.pages).put(next);
      if (edited) tx.objectStore(STORES.texts).put({ id: o.pageId, text: d.text } satisfies TextRow);
      for (const r of rows) tx.objectStore(STORES.activity).put(r);
      for (const v of versions) {
        tx.objectStore(STORES.versions).put(v.meta);
        tx.objectStore(STORES.versionDocs).put({ id: v.meta.id, doc: v.doc });
      }
    });
    for (const r of rows) this.activityRows.set(`${r.pageId}|${r.day}`, r);
    if (edited) this.index?.set(o.pageId, d.title, d.text);
    if (changed) {
      this.pages.set(o.pageId, next);
      this.emit();
    }
  }

  private versionMeta(pageId: string, createdAt: number, reason: VersionReason, d: Derived): VersionMeta {
    return { id: uid(), pageId, createdAt, reason, actor: this.opts.actor, title: d.title, wordCount: d.wordCount };
  }

  private async flushOpen(o: Open): Promise<void> {
    await o.ready;
    if (o.writeTimer) {
      clearTimeout(o.writeTimer);
      o.writeTimer = null;
    }
    await this.writePending(o);
    await this.store(o);
  }

  /** The end of an editing session (design 5.3): 5 minutes idle, a page switch or the window closing. */
  private async endSession(o: Open): Promise<void> {
    await this.flushOpen(o);
    if (o.dirtySinceVersion) await this.store(o, 'session');
  }

  private release(o: Open): void {
    o.refs -= 1;
    if (o.refs > 0) return;
    if (o.idleTimer) clearTimeout(o.idleTimer);
    o.idleTimer = null;
    this.open.delete(o.pageId);
    void this.track(
      this.endSession(o).finally(() => {
        if (o.deriveTimer) clearTimeout(o.deriveTimer);
        o.doc.destroy();
      }),
    );
  }

  /** A page's body, from its open doc or from storage, without starting a session. */
  async pageContent(pageId: string): Promise<PMNode> {
    const o = this.open.get(pageId);
    if (o) {
      await o.ready;
      return this.json(o);
    }
    const rows = await getAllByIndex<UpdateRow>(this.mustDb(), STORES.updates, 'byPage', pageId);
    const doc = new Y.Doc();
    if (rows.length) Y.applyUpdate(doc, Y.mergeUpdates(rows.map((r) => r.update)));
    const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(DOC_FIELD)) as PMNode;
    doc.destroy();
    return json;
  }

  // ---------------------------------------------------------------- history

  async versions(pageId: string): Promise<VersionMeta[]> {
    const metas = await getAllByIndex<VersionMeta>(this.mustDb(), STORES.versions, 'byPage', pageId);
    return metas.sort((a, b) => b.createdAt - a.createdAt);
  }

  async version(versionId: string): Promise<Version | null> {
    const db = this.mustDb();
    const [meta, body] = await Promise.all([
      get<VersionMeta>(db, STORES.versions, versionId),
      get<{ id: string; doc: PMNode }>(db, STORES.versionDocs, versionId),
    ]);
    return meta && body ? { ...meta, doc: body.doc } : null;
  }

  async saveVersion(pageId: string, reason: 'manual' | 'pre_agent' = 'manual'): Promise<VersionMeta | null> {
    if (!this.pages.has(pageId)) return null;
    const s = this.openPage(pageId);
    try {
      await s.ready;
      const o = this.open.get(pageId) as Open;
      await this.flushOpen(o);
      await this.store(o, reason);
      return (await this.versions(pageId))[0] ?? null;
    } finally {
      s.close();
    }
  }

  async restoreVersion(pageId: string, versionId: string): Promise<void> {
    const v = await this.version(versionId);
    if (!v || v.pageId !== pageId) throw new Error('restoreVersion: no such version for this page');
    const s = this.openPage(pageId);
    try {
      await s.ready;
      const o = this.open.get(pageId) as Open;
      // What's on the page now gets a version first, so a restore never loses text.
      await this.flushOpen(o);
      if (o.dirtySinceVersion) await this.store(o, 'session');
      const node = Node.fromJSON(notebookSchema(), v.doc);
      o.doc.transact(() => {
        prosemirrorToYXmlFragment(node, o.doc.getXmlFragment(DOC_FIELD));
      }, RESTORE);
      await this.flushOpen(o);
      await this.store(o, 'restore');
    } finally {
      s.close();
    }
  }

  async versionAsOf(pageId: string, day: string): Promise<Version | null> {
    const v = versionAt(await this.versions(pageId), endOfDay(day));
    return v ? this.version(v.id) : null;
  }

  // ---------------------------------------------------------------- temporal and search

  private live(pageId: string): boolean {
    const p = this.pages.get(pageId);
    return !!p && p.deletedAt == null;
  }

  async activity(fromDay: string, toDay: string): Promise<ActivityRow[]> {
    return [...this.activityRows.values()].filter((a) => a.day >= fromDay && a.day <= toDay && this.live(a.pageId));
  }

  async activeDays(): Promise<string[]> {
    const days = new Set<string>();
    for (const a of this.activityRows.values()) if (this.live(a.pageId)) days.add(a.day);
    return [...days].sort().reverse();
  }

  private searchIndex(): Promise<SearchIndex> {
    this.indexLoading ??= (async () => {
      const index = new SearchIndex();
      for (const t of await getAll<TextRow>(this.mustDb(), STORES.texts)) {
        const rec = this.pages.get(t.id);
        if (rec) index.set(t.id, rec.title, t.text);
      }
      for (const p of this.pages.values()) if (!index.has(p.id)) index.set(p.id, p.title, p.title);
      this.index = index;
      return index;
    })();
    return this.indexLoading;
  }

  async search(query: string, o: SearchOptions = {}): Promise<SearchHit[]> {
    const parsed = parseQuery(query);
    const index = await this.searchIndex();
    const inRange = (pageId: string): boolean => {
      if (!o.fromDay && !o.toDay) return true;
      const from = o.fromDay ?? '0000-00-00';
      const to = o.toDay ?? '9999-99-99';
      for (const a of this.activityRows.values()) if (a.pageId === pageId && a.day >= from && a.day <= to) return true;
      return false;
    };
    return index.query(
      parsed,
      (pageId) => {
        const p = this.pages.get(pageId);
        if (!p || p.deletedAt != null) return false;
        if (o.tabId && p.tabId !== o.tabId) return false;
        if (o.notebookId && this.tabs.get(p.tabId)?.notebookId !== o.notebookId) return false;
        if (parsed.hasChecklist && !p.hasChecklist) return false;
        return inRange(pageId);
      },
      o.limit ?? 50,
    );
  }

  // ---------------------------------------------------------------- fixtures

  /** Writes notebooks, tabs and pages with bodies and history in one transaction. Not part of NotebookBackend. */
  async importData(data: { notebooks?: NotebookRec[]; tabs?: TabRec[]; pages?: ImportPage[] }): Promise<void> {
    const db = this.mustDb();
    const schema = notebookSchema();
    const prepared = (data.pages ?? []).map((p) => {
      const d = derive(p.doc);
      const rec: PageRec = { ...p.rec, title: d.title, snippet: d.snippet, wordCount: d.wordCount, hasChecklist: d.hasChecklist };
      const update = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(schema, p.doc, DOC_FIELD));
      return { p, rec, d, update };
    });
    await write(db, Object.values(STORES), (tx) => {
      for (const n of data.notebooks ?? []) tx.objectStore(STORES.notebooks).put(n);
      for (const t of data.tabs ?? []) tx.objectStore(STORES.tabs).put(t);
      for (const { p, rec, d, update } of prepared) {
        tx.objectStore(STORES.pages).put(rec);
        tx.objectStore(STORES.texts).put({ id: rec.id, text: d.text } satisfies TextRow);
        tx.objectStore(STORES.updates).add({ pageId: rec.id, update } satisfies UpdateRow);
        for (const a of p.activity ?? [this.createdRow(rec)]) tx.objectStore(STORES.activity).put(a);
        for (const v of p.versions ?? []) {
          tx.objectStore(STORES.versions).put({ ...this.versionMeta(rec.id, v.createdAt, v.reason, derive(v.doc)), id: v.id });
          tx.objectStore(STORES.versionDocs).put({ id: v.id, doc: v.doc });
        }
      }
    });
    for (const n of data.notebooks ?? []) this.notebooks.set(n.id, n);
    for (const t of data.tabs ?? []) this.tabs.set(t.id, t);
    for (const { p, rec, d } of prepared) {
      this.pages.set(rec.id, rec);
      for (const a of p.activity ?? [this.createdRow(rec)]) this.activityRows.set(`${a.pageId}|${a.day}`, a);
      this.index?.set(rec.id, d.title, d.text);
    }
    this.emit();
  }
}
