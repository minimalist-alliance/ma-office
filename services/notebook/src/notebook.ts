// The tree: notebooks, tabs and pages as rows, and the changes the member makes to them. Ported from LocalBackend's
// structure half, with the same rules. Every change is one transaction and bumps `rev`, which survives a restart.
import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { type Db } from './db.ts';
import { badRequest, notFound } from './errors.ts';
import { BLANK_PAGE, DOC_FIELD, keyAt, notebookSchema, TAB_COLORS, type ActivityRow, type NotebookRec, type PageRec, type TabColor, type TabRec } from './model.ts';
import { dayIn } from './zones.ts';

/** Who the owner's own sessions are in `actor` columns: a desk has one owner, and this stays true after a move. */
export const OWNER_ACTOR = 'user';
/** A title longer than this is refused, as a tree row has to fit a reply. */
export const MAX_NAME = 1024;
/** Pages per `notebook.tree` reply. */
export const TREE_PAGE = 1000;
/** A reply stays under REQ/RES's 1 MiB, however long its titles. */
const TREE_BYTES = 900 * 1024;

interface NotebookRow {
  id: string;
  title: string;
  sort_key: number;
  created_at: number;
  updated_at: number;
  row_version: number;
}
interface TabRow extends NotebookRow {
  notebook_id: string;
  color: string;
}
export interface PageRow {
  id: string;
  tab_id: string;
  sort_key: number;
  title: string;
  snippet: string;
  word_count: number;
  has_checklist: number;
  created_at: number;
  created_by: string;
  updated_at: number;
  updated_by: string;
  deleted_at: number | null;
  row_version: number;
}

const PAGE_COLUMNS = 'id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, deleted_at, row_version';

const notebookRec = (r: NotebookRow): NotebookRec => ({ id: r.id, title: r.title, sortKey: r.sort_key, createdAt: r.created_at, updatedAt: r.updated_at, rowVersion: r.row_version });
const tabRec = (r: TabRow): TabRec => ({
  id: r.id,
  notebookId: r.notebook_id,
  title: r.title,
  color: r.color as TabColor,
  sortKey: r.sort_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  rowVersion: r.row_version,
});
export const pageRec = (r: PageRow): PageRec => ({
  id: r.id,
  tabId: r.tab_id,
  sortKey: r.sort_key,
  title: r.title,
  snippet: r.snippet,
  wordCount: r.word_count,
  hasChecklist: !!r.has_checklist,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rowVersion: r.row_version,
});

export interface NotebookHooks {
  now: () => number;
  /** A page or a name changed, so the readable copy is behind. Called inside no transaction. */
  onTreeChange: (rev: number) => void;
}

export class Notebook {
  private revision: number;
  private zone: string;

  constructor(
    private readonly db: Db,
    private readonly hooks: NotebookHooks,
  ) {
    this.revision = Number(db.setting('rev') ?? 0);
    this.zone = db.setting('time_zone') ?? 'UTC';
  }

  get rev(): number {
    return this.revision;
  }

  get timeZone(): string {
    return this.zone;
  }

  dayOf(ts: number): string {
    return dayIn(ts, this.zone);
  }

  setTimeZone(zone: string): void {
    if (zone === this.zone) return;
    this.db.setSetting('time_zone', zone);
    this.zone = zone;
  }

  /** Inside a transaction: the tree changed. */
  bumpRev(): void {
    this.db.setSetting('rev', String(this.revision + 1));
    this.revision += 1;
  }

  private commit<T>(fn: () => T): T {
    const before = this.revision;
    let out: T;
    try {
      out = this.db.tx(() => {
        const r = fn();
        this.bumpRev();
        return r;
      });
    } catch (e) {
      this.revision = before;
      throw e;
    }
    this.hooks.onTreeChange(this.revision);
    return out;
  }

  // ---------------------------------------------------------------- reads

  /**
   * One reply of `notebook.tree`. Notebooks, then tabs, then pages, resuming after the cursor's id. `more` adds fields to
   * each page (who made it, on a guild desk), inside the reply's budget.
   */
  tree(cursor?: string, more?: (row: PageRow) => Record<string, unknown>): { notebooks: NotebookRec[]; tabs: TabRec[]; pages: PageRec[]; rev: number; next: string | null } {
    let stage = 'n';
    let after = '';
    if (cursor !== undefined) {
      const m = /^([ntp]):(.{0,200})$/s.exec(cursor);
      if (!m) throw badRequest('cursor');
      stage = m[1] as string;
      after = m[2] as string;
    }
    const out = { notebooks: [] as NotebookRec[], tabs: [] as TabRec[], pages: [] as PageRec[], rev: this.revision, next: null as string | null };
    let budget = TREE_BYTES;
    const fits = (rec: unknown): boolean => {
      const size = Buffer.byteLength(JSON.stringify(rec));
      if (size > budget) return false;
      budget -= size;
      return true;
    };
    if (stage === 'n') {
      for (const r of this.db.all<NotebookRow>('SELECT id, title, sort_key, created_at, updated_at, row_version FROM notebooks WHERE id > ? AND deleted_at IS NULL ORDER BY id', after)) {
        const rec = notebookRec(r);
        if (!fits(rec)) {
          out.next = `n:${after}`;
          return out;
        }
        out.notebooks.push(rec);
        after = r.id;
      }
      stage = 't';
      after = '';
    }
    if (stage === 't') {
      for (const r of this.db.all<TabRow>('SELECT id, notebook_id, title, color, sort_key, created_at, updated_at, row_version FROM tabs WHERE id > ? ORDER BY id', after)) {
        const rec = tabRec(r);
        if (!fits(rec)) {
          out.next = `t:${after}`;
          return out;
        }
        out.tabs.push(rec);
        after = r.id;
      }
      after = '';
    }
    const rows = this.db.all<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id > ? ORDER BY id LIMIT ${TREE_PAGE + 1}`, after);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] as PageRow;
      const rec = more ? { ...pageRec(row), ...more(row) } : pageRec(row);
      if (i === TREE_PAGE || !fits(rec)) {
        out.next = `p:${after}`;
        return out;
      }
      out.pages.push(rec);
      after = rec.id;
    }
    return out;
  }

  page(id: string): PageRow | undefined {
    return this.db.get<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id = ?`, id);
  }

  mustPage(id: string): PageRow {
    const p = this.page(id);
    if (!p) throw notFound();
    return p;
  }

  private tab(id: string): TabRow | undefined {
    return this.db.get<TabRow>('SELECT id, notebook_id, title, color, sort_key, created_at, updated_at, row_version FROM tabs WHERE id = ?', id);
  }

  private notebook(id: string): NotebookRow | undefined {
    return this.db.get<NotebookRow>('SELECT id, title, sort_key, created_at, updated_at, row_version FROM notebooks WHERE id = ? AND deleted_at IS NULL', id);
  }

  private tabsOf(notebookId: string): TabRow[] {
    return this.db.all<TabRow>('SELECT id, notebook_id, title, color, sort_key, created_at, updated_at, row_version FROM tabs WHERE notebook_id = ? ORDER BY sort_key, created_at', notebookId);
  }

  private livePagesOf(tabId: string): PageRow[] {
    return this.db.all<PageRow>(`SELECT ${PAGE_COLUMNS} FROM pages WHERE tab_id = ? AND deleted_at IS NULL ORDER BY sort_key, created_at`, tabId);
  }

  // ---------------------------------------------------------------- writes, in LocalBackend's order

  /** Inside a transaction: a new, blank page and its first activity row. */
  private insertBlankPage(tabId: string, sortKey: number, actor: string): PageRec {
    const now = this.hooks.now();
    const id = randomUUID();
    const seed = prosemirrorJSONToYDoc(notebookSchema(), BLANK_PAGE, DOC_FIELD);
    const state = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    const inserted = this.db.q(
      `INSERT INTO pages (id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, deleted_at, row_version, ydoc, pm_json, plain_text)
       VALUES (?, ?, ?, '', '', 0, 0, ?, ?, ?, ?, NULL, 1, ?, ?, '')`,
    ).run(id, tabId, sortKey, now, actor, now, actor, state, JSON.stringify(BLANK_PAGE));
    this.db.run(`INSERT INTO pages_fts (rowid, title, body) VALUES (?, '', '')`, inserted.lastInsertRowid);
    const row: ActivityRow = { pageId: id, day: this.dayOf(now), created: true, firstAt: now, lastAt: now, edits: 0, added: 0, removed: 0, actors: [actor] };
    this.db.run(
      'INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, ?, 1, ?, ?, 0, 0, 0, ?)',
      row.pageId,
      row.day,
      row.firstAt,
      row.lastAt,
      JSON.stringify(row.actors),
    );
    return { id, tabId, sortKey, title: '', snippet: '', wordCount: 0, hasChecklist: false, createdAt: now, updatedAt: now, deletedAt: null, rowVersion: 1 };
  }

  createNotebook(title = 'New notebook', actor = OWNER_ACTOR): { notebook: NotebookRec; tab: TabRec; page: PageRec } {
    return this.commit(() => {
      const now = this.hooks.now();
      const keys = this.db.all<{ sort_key: number }>('SELECT sort_key FROM notebooks WHERE deleted_at IS NULL ORDER BY sort_key, created_at').map((r) => r.sort_key);
      const notebook: NotebookRec = { id: randomUUID(), title, sortKey: keyAt(keys, keys.length), createdAt: now, updatedAt: now, rowVersion: 1 };
      this.db.run(
        'INSERT INTO notebooks (id, title, sort_key, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, 1)',
        notebook.id,
        notebook.title,
        notebook.sortKey,
        now,
        now,
      );
      const tab: TabRec = { id: randomUUID(), notebookId: notebook.id, title: 'General', color: 'blue', sortKey: 0, createdAt: now, updatedAt: now, rowVersion: 1 };
      this.insertTab(tab);
      return { notebook, tab, page: this.insertBlankPage(tab.id, 0, actor) };
    });
  }

  private insertTab(tab: TabRec): void {
    this.db.run(
      'INSERT INTO tabs (id, notebook_id, title, color, sort_key, created_at, updated_at, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      tab.id,
      tab.notebookId,
      tab.title,
      tab.color,
      tab.sortKey,
      tab.createdAt,
      tab.updatedAt,
      tab.rowVersion,
    );
  }

  /** A blank title changes nothing, as in LocalBackend. */
  renameNotebook(id: string, title: string): void {
    const n = this.notebook(id);
    if (!n) throw notFound();
    const clean = title.trim();
    if (!clean) return;
    this.commit(() => this.db.run('UPDATE notebooks SET title = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?', clean, this.hooks.now(), id));
  }

  createTab(notebookId: string, o: { title?: string; color?: TabColor } = {}, actor = OWNER_ACTOR): { tab: TabRec; page: PageRec } {
    if (!this.notebook(notebookId)) throw notFound();
    return this.commit(() => {
      const existing = this.tabsOf(notebookId);
      const now = this.hooks.now();
      const tab: TabRec = {
        id: randomUUID(),
        notebookId,
        title: o.title ?? 'New tab',
        color: o.color ?? TAB_COLORS[existing.length % TAB_COLORS.length] ?? 'blue',
        sortKey: keyAt(existing.map((t) => t.sort_key), existing.length),
        createdAt: now,
        updatedAt: now,
        rowVersion: 1,
      };
      this.insertTab(tab);
      return { tab, page: this.insertBlankPage(tab.id, 0, actor) };
    });
  }

  renameTab(id: string, title: string): void {
    if (!this.tab(id)) throw notFound();
    const clean = title.trim();
    if (!clean) return;
    this.commit(() => this.db.run('UPDATE tabs SET title = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?', clean, this.hooks.now(), id));
  }

  recolorTab(id: string, color: TabColor): void {
    if (!this.tab(id)) throw notFound();
    this.commit(() => this.db.run('UPDATE tabs SET color = ?, updated_at = ?, row_version = row_version + 1 WHERE id = ?', color, this.hooks.now(), id));
  }

  /** Design 5.2: a new tab right after this page's, taking this page and those after it. A move isn't an edit, so updatedAt stays. */
  addTabAtPage(pageId: string, title?: string): TabRec {
    const page = this.page(pageId);
    const from = page ? this.tab(page.tab_id) : undefined;
    if (!page || !from) throw notFound();
    return this.commit(() => {
      const siblings = this.tabsOf(from.notebook_id);
      const at = siblings.findIndex((t) => t.id === from.id) + 1;
      const now = this.hooks.now();
      const tab: TabRec = {
        id: randomUUID(),
        notebookId: from.notebook_id,
        title: title?.trim() || page.title.slice(0, 40) || 'New tab',
        color: TAB_COLORS[(TAB_COLORS.indexOf(from.color as TabColor) + 1) % TAB_COLORS.length] ?? 'blue',
        sortKey: keyAt(siblings.map((t) => t.sort_key), at),
        createdAt: now,
        updatedAt: now,
        rowVersion: 1,
      };
      this.insertTab(tab);
      const list = this.livePagesOf(from.id);
      const i = list.findIndex((p) => p.id === pageId);
      for (const p of i < 0 ? [] : list.slice(i)) this.db.run('UPDATE pages SET tab_id = ?, row_version = row_version + 1 WHERE id = ?', tab.id, p.id);
      return tab;
    });
  }

  createPage(tabId: string, o: { after?: string } = {}, actor = OWNER_ACTOR): PageRec {
    if (!this.tab(tabId)) throw notFound();
    return this.commit(() => {
      const list = this.livePagesOf(tabId);
      const afterIdx = o.after ? list.findIndex((p) => p.id === o.after) : -1;
      return this.insertBlankPage(tabId, keyAt(list.map((p) => p.sort_key), afterIdx + 1), actor);
    });
  }

  movePage(pageId: string, tabId: string, index?: number): void {
    const page = this.page(pageId);
    if (!page || !this.tab(tabId)) throw notFound();
    this.commit(() => {
      const others = this.livePagesOf(tabId).filter((p) => p.id !== pageId);
      const sortKey = keyAt(others.map((p) => p.sort_key), index ?? others.length);
      this.db.run('UPDATE pages SET tab_id = ?, sort_key = ?, row_version = row_version + 1 WHERE id = ?', tabId, sortKey, pageId);
    });
  }

  trashPage(pageId: string): void {
    const page = this.mustPage(pageId);
    if (page.deleted_at != null) return;
    this.commit(() => this.db.run('UPDATE pages SET deleted_at = ?, row_version = row_version + 1 WHERE id = ?', this.hooks.now(), pageId));
  }

  restorePage(pageId: string): void {
    const page = this.mustPage(pageId);
    if (page.deleted_at == null) return;
    let tabId = page.tab_id;
    if (!this.tab(tabId)) {
      // Its tab went while it was in Trash: back to the first tab there is.
      const first = this.db.get<{ id: string }>('SELECT t.id FROM tabs t JOIN notebooks n ON n.id = t.notebook_id ORDER BY n.sort_key, n.created_at, t.sort_key, t.created_at LIMIT 1');
      if (!first) return;
      tabId = first.id;
    }
    this.commit(() => this.db.run('UPDATE pages SET tab_id = ?, deleted_at = NULL, row_version = row_version + 1 WHERE id = ?', tabId, pageId));
  }

  /** Inside a transaction: everything about a page goes (design 5.2's Trash, after 30 days). */
  purgePage(pageId: string): void {
    const row = this.db.get<{ pk: number }>('SELECT pk FROM pages WHERE id = ?', pageId);
    if (!row) return;
    this.db.run('DELETE FROM pages_fts WHERE rowid = ?', row.pk);
    this.db.run('DELETE FROM page_updates WHERE page_id = ?', pageId);
    this.db.run('DELETE FROM page_versions WHERE page_id = ?', pageId);
    this.db.run('DELETE FROM page_activity WHERE page_id = ?', pageId);
    this.db.run('DELETE FROM page_clients WHERE page_id = ?', pageId);
    this.db.run('DELETE FROM page_credits WHERE page_id = ?', pageId);
    this.db.run('DELETE FROM pages WHERE pk = ?', row.pk);
  }

  /** After a transaction that called bumpRev itself. */
  announce(): void {
    this.hooks.onTreeChange(this.revision);
  }

  // ---------------------------------------------------------------- temporal

  /** Rows for live pages in [fromDay, toDay]. */
  activity(fromDay: string, toDay: string): ActivityRow[] {
    return this.db
      .all<{ page_id: string; day: string; created: number; first_at: number; last_at: number; edits: number; added: number; removed: number; actors: string }>(
        `SELECT a.page_id, a.day, a.created, a.first_at, a.last_at, a.edits, a.added, a.removed, a.actors
         FROM page_activity a JOIN pages p ON p.id = a.page_id
         WHERE a.day >= ? AND a.day <= ? AND p.deleted_at IS NULL`,
        fromDay,
        toDay,
      )
      .map((r) => ({
        pageId: r.page_id,
        day: r.day,
        created: !!r.created,
        firstAt: r.first_at,
        lastAt: r.last_at,
        edits: r.edits,
        added: r.added,
        removed: r.removed,
        actors: JSON.parse(r.actors) as string[],
      }));
  }

  /** Every day with activity on a live page, newest first. */
  activeDays(): string[] {
    return this.db.all<{ day: string }>('SELECT DISTINCT a.day FROM page_activity a JOIN pages p ON p.id = a.page_id WHERE p.deleted_at IS NULL ORDER BY a.day DESC').map((r) => r.day);
  }
}
