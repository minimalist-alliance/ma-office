// The tree: notebooks, tabs and pages as rows, and the changes the member makes to them. Ported from LocalBackend's
// structure half, with the same rules. Every change is one transaction and bumps `rev`, which survives a restart.
import { randomUUID } from 'node:crypto';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { type Db } from './db.ts';
import { badRequest, notFound } from './errors.ts';
import {
  BLANK_PAGE,
  derive,
  DOC_FIELD,
  isPaletteId,
  keyAt,
  notebookSchema,
  TAB_COLORS,
  type ActivityRow,
  type NotebookRec,
  type PageRec,
  type PaletteId,
  type PMNode,
  type TabColor,
  type TabRec,
} from './model.ts';
import { dayIn } from './zones.ts';

/** Who the owner's own sessions are in `actor` columns: a desk has one owner, and this stays true after a move. */
export const OWNER_ACTOR = 'user';
/** A title longer than this is refused, as a tree row has to fit a reply. */
export const MAX_NAME = 1024;
/** Pages per `notebook.tree` reply. */
export const TREE_PAGE = 1000;
/** A reply stays under REQ/RES's 1 MiB, however long its titles. */
const TREE_BYTES = 900 * 1024;
/** Rows per `notebook.activity` reply, at most. Real rows reach {@link ACTIVITY_BYTES} first, at about 5,700. */
export const ACTIVITY_PAGE = 10_000;
/**
 * The rows' JSON per `notebook.activity` reply, at most. Before paging a reply was all the rows or `too_large`, at REQ/RES's
 * 1 MiB, so this is as close to that as leaves room for `next`: a client that sends no cursor still gets everything it got.
 */
export const ACTIVITY_BYTES = 1024 * 1024 - 4096;
const ACTIVITY_CURSOR = /^a:(\d{4}-\d{2}-\d{2}):(.{1,200})$/s;
/**
 * `notebook.activity`'s read, from the first row or from after a cursor's: (fromDay, toDay), then the cursor's (day, pageId).
 * page_activity_by_day holds (day, page_id), as a WITHOUT ROWID table's key is appended to its indexes, so this reads that
 * index backwards and sorts nothing. SQLite bounds the range by the days only, so after a cursor `toDay` is the cursor's day
 * at the latest, and a page skips no more than the rest of that day.
 */
export const activitySql = (afterCursor: boolean): string =>
  `SELECT a.page_id, a.day, a.created, a.first_at, a.last_at, a.edits, a.added, a.removed, a.actors
   FROM page_activity a JOIN pages p ON p.id = a.page_id
   WHERE a.day >= ? AND a.day <= ?${afterCursor ? ' AND (a.day, a.page_id) < (?, ?)' : ''} AND p.deleted_at IS NULL
   ORDER BY a.day DESC, a.page_id DESC LIMIT ${ACTIVITY_PAGE + 1}`;

interface ActivityDbRow {
  page_id: string;
  day: string;
  created: number;
  first_at: number;
  last_at: number;
  edits: number;
  added: number;
  removed: number;
  actors: string;
}

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
  /** Who trashed it (authz-5): an actor while `deleted_at` is set, else null. Null too for a trash from an older build. */
  deleted_by: string | null;
  row_version: number;
  /** ADR 0091: a palette id, or null. Kept as stored; a value this build doesn't know is sent as none. */
  label: string | null;
}

const PAGE_COLUMNS = 'id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, row_version, label';

/** A new page's body: its Yjs state, its JSON, and its label. */
export interface PageBody {
  state: Uint8Array;
  doc: PMNode;
  label: PaletteId | null;
}

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
  // Only when set, so a page without one reads exactly as before labels.
  ...(isPaletteId(r.label) ? { label: r.label } : {}),
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

  /** Inside a transaction: a new page and its first activity row. Blank, or with a body (a duplicate, an import). */
  private insertPage(tabId: string, sortKey: number, actor: string, body?: PageBody): PageRec {
    const now = this.hooks.now();
    const id = randomUUID();
    let state: Uint8Array;
    let json: PMNode;
    if (body) {
      state = body.state;
      json = body.doc;
    } else {
      const seed = prosemirrorJSONToYDoc(notebookSchema(), BLANK_PAGE, DOC_FIELD);
      state = Y.encodeStateAsUpdate(seed);
      seed.destroy();
      json = BLANK_PAGE;
    }
    const d = body ? derive(json) : { title: '', snippet: '', wordCount: 0, hasChecklist: false, text: '' };
    // As a store would: the title cut at 500 (not through a character), and the index's body the text after it.
    const cut = d.title.length > 500 && (d.title.charCodeAt(499) & 0xfc00) === 0xd800 ? 499 : 500;
    const title = d.title.slice(0, cut);
    const label = body?.label ?? null;
    const inserted = this.db.q(
      `INSERT INTO pages (id, tab_id, sort_key, title, snippet, word_count, has_checklist, created_at, created_by, updated_at, updated_by, deleted_at, row_version, ydoc, pm_json, plain_text, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
    ).run(id, tabId, sortKey, title, d.snippet, d.wordCount, d.hasChecklist ? 1 : 0, now, actor, now, actor, state, JSON.stringify(json), d.text, label);
    const at = title ? d.text.indexOf(title) : -1;
    const ftsBody = at < 0 ? d.text : d.text.slice(at + title.length).replace(/^\n+/, '');
    this.db.run(`INSERT INTO pages_fts (rowid, title, body) VALUES (?, ?, ?)`, inserted.lastInsertRowid, title, ftsBody);
    const row: ActivityRow = { pageId: id, day: this.dayOf(now), created: true, firstAt: now, lastAt: now, edits: 0, added: 0, removed: 0, actors: [actor] };
    this.db.run(
      'INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, ?, 1, ?, ?, 0, 0, 0, ?)',
      row.pageId,
      row.day,
      row.firstAt,
      row.lastAt,
      JSON.stringify(row.actors),
    );
    return {
      id,
      tabId,
      sortKey,
      title,
      snippet: d.snippet,
      wordCount: d.wordCount,
      hasChecklist: d.hasChecklist,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      rowVersion: 1,
      ...(label ? { label } : {}),
    };
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
      return { notebook, tab, page: this.insertPage(tab.id, 0, actor) };
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
      return { tab, page: this.insertPage(tab.id, 0, actor) };
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
      return this.insertPage(tabId, keyAt(list.map((p) => p.sort_key), afterIdx + 1), actor);
    });
  }

  /**
   * A page with a body, right after `after` in the tab, or first (ADR 0091: a duplicate, or a page from a notebook file).
   * `client` is the Yjs client id the body is written under: on a guild's desk, `onCreated` says whose it is, inside the
   * same transaction, so nothing of a member's is ever on a page without its writer.
   */
  addPage(tabId: string, after: string | null, body: PageBody, actor = OWNER_ACTOR, onCreated?: (page: PageRec) => void): PageRec {
    if (!this.tab(tabId)) throw notFound();
    return this.commit(() => {
      const list = this.livePagesOf(tabId);
      const afterIdx = after ? list.findIndex((p) => p.id === after) : -1;
      const page = this.insertPage(tabId, keyAt(list.map((p) => p.sort_key), afterIdx + 1), actor, body);
      onCreated?.(page);
      return page;
    });
  }

  /** ADR 0091: metadata, as a tab's color is. A label isn't an edit, so updatedAt stays; the tree's rev says it changed. */
  setPageLabel(pageId: string, label: PaletteId | null): void {
    const page = this.mustPage(pageId);
    if ((page.label ?? null) === label) return;
    this.commit(() => this.db.run('UPDATE pages SET label = ?, row_version = row_version + 1 WHERE id = ?', label, pageId));
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

  /** `actor` is who trashed it, kept so a guild desk knows who may bring it back (authz-5). */
  trashPage(pageId: string, actor: string = OWNER_ACTOR): void {
    const page = this.mustPage(pageId);
    if (page.deleted_at != null) return;
    this.commit(() => this.db.run('UPDATE pages SET deleted_at = ?, deleted_by = ?, row_version = row_version + 1 WHERE id = ?', this.hooks.now(), actor, pageId));
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
    this.commit(() => this.db.run('UPDATE pages SET tab_id = ?, deleted_at = NULL, deleted_by = NULL, row_version = row_version + 1 WHERE id = ?', tabId, pageId));
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

  /**
   * Rows for live pages in [fromDay, toDay], newest day first and then by page id, from just after `cursor`: a page of them,
   * with `next` to ask for the one after it, or null. The order is the table's key, so a row is never sent twice or skipped,
   * whatever else is written meanwhile; a row added behind the cursor shows on the next read, which the topic asks for.
   * `more` shapes each row as it's sent (a guild desk's names), inside the reply's budget.
   */
  activity(fromDay: string, toDay: string, cursor?: string, more?: (row: ActivityRow) => ActivityRow): { rows: ActivityRow[]; next: string | null } {
    const params: string[] = [fromDay, toDay];
    if (cursor !== undefined) {
      const m = ACTIVITY_CURSOR.exec(cursor);
      if (!m) throw badRequest('cursor');
      const day = m[1] as string;
      if (day < toDay) params[1] = day;
      params.push(day, m[2] as string);
    }
    const out = { rows: [] as ActivityRow[], next: null as string | null };
    let budget = ACTIVITY_BYTES;
    let last: ActivityRow | undefined;
    for (const r of this.db.iterate<ActivityDbRow>(activitySql(cursor !== undefined), ...params)) {
      const plain: ActivityRow = {
        pageId: r.page_id,
        day: r.day,
        created: !!r.created,
        firstAt: r.first_at,
        lastAt: r.last_at,
        edits: r.edits,
        added: r.added,
        removed: r.removed,
        actors: JSON.parse(r.actors) as string[],
      };
      const row = more ? more(plain) : plain;
      // The comma before it, after the first.
      const size = Buffer.byteLength(JSON.stringify(row)) + (out.rows.length ? 1 : 0);
      // One row always goes, so a reader always moves on.
      if (last && (out.rows.length === ACTIVITY_PAGE || size > budget)) {
        out.next = `a:${last.day}:${last.pageId}`;
        break;
      }
      budget -= size;
      out.rows.push(row);
      last = plain;
    }
    return out;
  }

  /** Every day with activity on a live page, newest first. */
  activeDays(): string[] {
    return this.db.all<{ day: string }>('SELECT DISTINCT a.day FROM page_activity a JOIN pages p ON p.id = a.page_id WHERE p.deleted_at IS NULL ORDER BY a.day DESC').map((r) => r.day);
  }
}
