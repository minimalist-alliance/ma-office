// Page text: what's open, what's committed, and the store. The durability rule lives here.
//
//   onChange      every update goes on a queue, and the queue is committed to page_updates within about 150 ms.
//   load          ydoc, then page_updates.
//   store         ydoc, pm_json, plain_text, FTS, page_activity and any version, in one transaction that clears the log.
//   start         pages with log rows (the last process died) are folded in before anything listens.
//
// Versions by design 5.3, ported from LocalBackend's store and endSession.
import { randomUUID } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { Node } from '@tiptap/pm/model';
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { type Db } from './db.ts';
import { notFound } from './errors.ts';
import { errName, log } from './log.ts';
import {
  derive,
  DOC_FIELD,
  INTERVAL_MS,
  notebookSchema,
  SESSION_IDLE_MS,
  TRASH_KEEP_MS,
  versionAt,
  versionsToPrune,
  type ActivityRow,
  type Derived,
  type PMNode,
  type VersionMeta,
  type VersionReason,
} from './model.ts';
import { OWNER_ACTOR, type Notebook } from './notebook.ts';

/** Past this much Yjs state a new client can't get the page inside DATA's 4 MiB, so the page takes no more. */
export const PAGE_FULL_BYTES = Math.floor(3.5 * 1024 * 1024);
/** A derived title is the first line, however long. A tree row or a hit has to fit a reply. */
const TITLE_MAX = 500;
const SLOW_STORE_MS = 100;
/** While storage fails, the retry waits this long, doubling to the larger. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** What may wait in memory while the disk refuses writes, per page and over all. Past it, new edits are refused. */
export const BACKLOG_PAGE_BYTES = 1024 * 1024;
export const BACKLOG_TOTAL_BYTES = 8 * 1024 * 1024;
/** After this long of failing storage with edits waiting, new edits are refused whatever the size, so the member sees it. */
export const REFUSE_AFTER_MS = 60_000;

/** Updates waiting for the log: an open page's, or a page's that left memory before they were written. */
interface Queued {
  pageId: string;
  queue: Uint8Array[];
  queueActors: Set<string>;
}

export interface StorageState {
  /** `degraded` from the first failed write to the log or a store until all the waiting edits are written. */
  state: 'ok' | 'degraded';
  /** Edits waiting in memory: pages with some, and their size. */
  unsavedPages: number;
  unsavedBytes: number;
  /** Whether new edits are being refused (`storage_full`). */
  refusing: boolean;
  /** How long it has been failing, in seconds; 0 when it isn't. */
  degradedSeconds: number;
}

interface DayEdits {
  count: number;
  firstAt: number;
  lastAt: number;
  /** Who made them: `user` on the owner's desks, member ids on a guild's. */
  actors: Set<string>;
}

interface OpenPage {
  pageId: string;
  doc: Y.Doc;
  /** Updates applied, not yet committed to the log. */
  queue: Uint8Array[];
  /** Who made the updates in the queue. */
  queueActors: Set<string>;
  /** Who made the last edit: the actor of a version the desk writes by itself. */
  lastActor: string;
  /** Rows the log holds for this page, as far as this process knows. */
  logged: boolean;
  /** Edits not yet derived, by local day. */
  edits: Map<string, DayEdits>;
  dirtySinceVersion: boolean;
  lastVersionAt: number;
  lastEditAt: number;
  textLength: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** A day_end snapshot taken at the first edit after midnight, waiting to be written. */
  dayEnd: { doc: PMNode; at: number; actor: string } | null;
  /** Yjs state, exact after a load or a store, and an upper bound in between. */
  stateBytes: number;
  /** Set once the page is left: a late timer does nothing. */
  gone: boolean;
}

export interface PagesOptions {
  now: () => number;
  commitMs: number;
  sessionIdleMs: number;
  intervalMs: number;
  pageFullBytes: number;
  backlogPageBytes: number;
  backlogTotalBytes: number;
  refuseAfterMs: number;
  debugStores: boolean;
  onStored: (pageId: string, ms: number) => void;
  onContentChange: (pageId: string) => void;
}

export const DEFAULT_PAGES_OPTIONS = {
  now: (): number => Date.now(),
  commitMs: 150,
  sessionIdleMs: SESSION_IDLE_MS,
  intervalMs: INTERVAL_MS,
  pageFullBytes: PAGE_FULL_BYTES,
  backlogPageBytes: BACKLOG_PAGE_BYTES,
  backlogTotalBytes: BACKLOG_TOTAL_BYTES,
  refuseAfterMs: REFUSE_AFTER_MS,
  debugStores: false,
};

/** A title cut to length, not through the middle of a character. */
function capTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  const end = (title.charCodeAt(TITLE_MAX - 1) & 0xfc00) === 0xd800 ? TITLE_MAX - 1 : TITLE_MAX;
  return title.slice(0, end);
}

function jsonOf(doc: Y.Doc): PMNode {
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(DOC_FIELD)) as PMNode;
}

/** A log row's actors. A row from before they were kept is the owner's, as every edit was then. */
function actorsOf(json: string | null): string[] {
  if (!json) return [OWNER_ACTOR];
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v) && v.length && v.every((a) => typeof a === 'string')) return v as string[];
  } catch {
    // A damaged cell is the owner's, as before.
  }
  return [OWNER_ACTOR];
}

/** The body as the search index has it: the text after the title line. */
function bodyOf(text: string, title: string): string {
  if (!title) return text;
  const at = text.indexOf(title);
  return at < 0 ? text : text.slice(at + title.length).replace(/^\n+/, '');
}

export class Pages {
  readonly open = new Map<string, OpenPage>();
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private commitFailing = false;
  /** Pages whose store failed and will be tried again. */
  private readonly failedStores = new Set<string>();
  /** Updates of pages that left memory before they were written to the log. They are kept and retried. */
  private readonly stranded = new Map<string, Queued>();
  /** When storage began failing, or 0. */
  private degradedSince = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_MIN_MS;
  private refusalLogged = false;
  closed = false;

  constructor(
    private readonly db: Db,
    private readonly notebook: Notebook,
    private readonly opts: PagesOptions,
  ) {}

  // ---------------------------------------------------------------- load

  /** Hocuspocus's onLoadDocument. Throws rather than serve an empty page over a stored one. */
  load(pageId: string, doc: Y.Doc): void {
    const row = this.db.get<{ ydoc: Uint8Array; text_length: number; updated_by: string }>('SELECT ydoc, length(plain_text) AS text_length, updated_by FROM pages WHERE id = ?', pageId);
    if (!row) throw Object.assign(new Error('no such page'), { reason: 'not_found' });
    try {
      Y.applyUpdate(doc, row.ydoc);
    } catch (e) {
      log('ERROR', `load refused page=${pageId} ydoc=${row.ydoc.length} ${errName(e)}`);
      throw Object.assign(new Error('page damaged'), { reason: 'unavailable' });
    }
    let stateBytes = row.ydoc.length;
    let logged = false;
    for (const r of this.db.all<{ update_bytes: Uint8Array }>('SELECT update_bytes FROM page_updates WHERE page_id = ? ORDER BY seq', pageId)) {
      logged = true;
      stateBytes += r.update_bytes.length;
      try {
        Y.applyUpdate(doc, r.update_bytes);
      } catch (e) {
        log('ERROR', `log row skipped page=${pageId} bytes=${r.update_bytes.length} ${errName(e)}`);
      }
    }
    const now = this.opts.now();
    const entry: OpenPage = {
      pageId,
      doc,
      queue: [],
      queueActors: new Set(),
      lastActor: row.updated_by,
      logged,
      edits: new Map(),
      dirtySinceVersion: false,
      lastVersionAt: now,
      lastEditAt: 0,
      textLength: row.text_length,
      idleTimer: null,
      dayEnd: null,
      stateBytes,
      gone: false,
    };
    // Updates a closed page left unwritten (the disk was failing) come back with it, and are written when it can.
    const left = this.stranded.get(pageId);
    if (left) {
      for (const u of left.queue) {
        try {
          Y.applyUpdate(doc, u);
        } catch (e) {
          log('ERROR', `stranded update skipped page=${pageId} bytes=${u.length} ${errName(e)}`);
        }
        entry.stateBytes += u.length;
      }
      entry.queue = left.queue;
      entry.queueActors = left.queueActors;
      entry.dirtySinceVersion = true;
      entry.lastEditAt = now;
      this.stranded.delete(pageId);
    }
    doc.on('beforeTransaction', () => this.beforeEdit(entry));
    this.open.set(pageId, entry);
    if (left) this.commitTimer ??= setTimeout(() => this.commit(), this.opts.commitMs);
  }

  /** The first edit after local midnight snapshots the page as the day left it (design 5.3, day_end). */
  private beforeEdit(o: OpenPage): void {
    if (!o.dirtySinceVersion || !o.lastEditAt || o.dayEnd) return;
    if (this.notebook.dayOf(this.opts.now()) === this.notebook.dayOf(o.lastEditAt)) return;
    try {
      o.dayEnd = { doc: jsonOf(o.doc), at: o.lastEditAt, actor: o.lastActor };
    } catch (e) {
      log('WARN', `day_end snapshot skipped page=${o.pageId} ${errName(e)}`);
    }
  }

  // ---------------------------------------------------------------- the queue

  /** Hocuspocus's onChange. It never throws: a rejected hook there is an unhandled rejection. */
  change(pageId: string, update: Uint8Array, actor: string = OWNER_ACTOR): void {
    const o = this.open.get(pageId);
    if (!o) return;
    const now = this.opts.now();
    o.queue.push(update);
    o.queueActors.add(actor);
    o.lastActor = actor;
    o.stateBytes += update.length;
    this.commitTimer ??= setTimeout(() => this.commit(), this.opts.commitMs);

    let day: string;
    try {
      day = this.notebook.dayOf(now);
    } catch {
      day = new Date(now).toISOString().slice(0, 10);
    }
    const e = o.edits.get(day);
    if (e) {
      e.count += 1;
      e.lastAt = now;
      e.actors.add(actor);
    } else o.edits.set(day, { count: 1, firstAt: now, lastAt: now, actors: new Set([actor]) });
    o.lastEditAt = now;
    o.dirtySinceVersion = true;

    if (o.idleTimer) clearTimeout(o.idleTimer);
    o.idleTimer = setTimeout(() => {
      o.idleTimer = null;
      this.endSessionQuietly(o);
    }, this.opts.sessionIdleMs);
    o.idleTimer.unref();
  }

  /**
   * Commits every waiting queue in one transaction. A failure keeps the queues (merged, so they stay small), says so
   * once, and tries again with a growing wait. The degraded state ends when everything waiting has been written.
   */
  commit(): void {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    if (this.closed) return;
    const dirty: Queued[] = [...[...this.open.values()].filter((o) => o.queue.length), ...[...this.stranded.values()].filter((q) => q.queue.length)];
    if (!dirty.length) {
      if (this.commitFailing) {
        this.commitFailing = false;
        this.checkRecovered();
      }
      return;
    }
    const merged = dirty.map((o) => (o.queue.length === 1 ? o.queue[0] as Uint8Array : Y.mergeUpdates(o.queue)));
    const now = this.opts.now();
    try {
      this.db.tx(() => {
        dirty.forEach((o, i) => {
          this.db.run(
            'INSERT INTO page_updates (page_id, update_bytes, at, edits, actors) VALUES (?, ?, ?, ?, ?)',
            o.pageId,
            merged[i] as Uint8Array,
            now,
            o.queue.length,
            JSON.stringify([...o.queueActors]),
          );
        });
      });
    } catch (e) {
      this.commitFailing = true;
      dirty.forEach((o, i) => {
        o.queue = [merged[i] as Uint8Array];
      });
      this.storageFailed('commit', e);
      return;
    }
    for (const o of dirty) {
      o.queue = [];
      o.queueActors = new Set();
      if ('logged' in o) (o as OpenPage).logged = true;
      this.stranded.delete(o.pageId);
    }
    this.commitFailing = false;
    this.checkRecovered();
  }

  // ---------------------------------------------------------------- storage failing

  /** The first failure of a run is logged, with the error's code and no content; the retry is scheduled every time. */
  private storageFailed(what: 'commit' | 'store', e: unknown): void {
    if (!this.degradedSince) {
      this.degradedSince = this.opts.now();
      this.retryMs = RETRY_MIN_MS;
      log('ERROR', `storage failing, keeping edits in memory and retrying ${what} ${errName(e)}`);
    }
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => this.retry(), this.retryMs);
      this.retryTimer.unref();
    }
  }

  private retry(): void {
    this.retryTimer = null;
    if (this.closed) return;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.commit();
    for (const id of [...this.failedStores]) {
      const o = this.open.get(id);
      if (o && !this.commitFailing) this.storeQuietly(id);
      else if (!o) this.failedStores.delete(id);
    }
    this.checkRecovered();
    // commit() and storeQuietly() schedule the next try on a failure; if only a store is outstanding and nothing else
    // asked, this does.
    if (this.degradedSince && !this.retryTimer && !this.closed) {
      this.retryTimer = setTimeout(() => this.retry(), this.retryMs);
      this.retryTimer.unref();
    }
  }

  private checkRecovered(): void {
    if (!this.degradedSince || this.commitFailing || this.failedStores.size) return;
    const secs = Math.round((this.opts.now() - this.degradedSince) / 1000);
    this.degradedSince = 0;
    this.refusalLogged = false;
    this.retryMs = RETRY_MIN_MS;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    log('INFO', `storage works again after ${secs} s, everything waiting is written`);
  }

  private backlog(pageId?: string): { pages: number; bytes: number; page: number; max: number } {
    let pages = 0;
    let bytes = 0;
    let page = 0;
    let max = 0;
    const add = (q: Queued): void => {
      if (!q.queue.length) return;
      const n = q.queue.reduce((t, u) => t + u.length, 0);
      pages += 1;
      bytes += n;
      if (q.pageId === pageId) page = n;
      max = Math.max(max, n);
    };
    for (const o of this.open.values()) add(o);
    for (const q of this.stranded.values()) add(q);
    return { pages, bytes, page, max };
  }

  /**
   * Whether an update to this page is refused now: storage is failing, edits are waiting, and they have waited past
   * the grace period or are over the page's or the total cap.
   */
  refuses(pageId: string): boolean {
    if (!this.degradedSince) return false;
    const b = this.backlog(pageId);
    if (!b.bytes) return false;
    const refuse = this.overLimit(b.page, b.bytes);
    if (refuse && !this.refusalLogged) {
      this.refusalLogged = true;
      log('ERROR', `refusing new edits while storage fails pages=${b.pages} bytes=${b.bytes}`);
    }
    return refuse;
  }

  private overLimit(page: number, total: number): boolean {
    return this.opts.now() - this.degradedSince >= this.opts.refuseAfterMs || page >= this.opts.backlogPageBytes || total >= this.opts.backlogTotalBytes;
  }

  /** For health: never throws. */
  storage(): StorageState {
    const b = this.backlog();
    return {
      state: this.degradedSince ? 'degraded' : 'ok',
      unsavedPages: b.pages,
      unsavedBytes: b.bytes,
      refusing: !!this.degradedSince && b.bytes > 0 && this.overLimit(b.max, b.bytes),
      degradedSeconds: this.degradedSince ? Math.round((this.opts.now() - this.degradedSince) / 1000) : 0,
    };
  }

  /** Hocuspocus's onStoreDocument: a failed store is kept for the retry, not thrown into Hocuspocus. */
  storeQuietly(pageId: string): void {
    const o = this.open.get(pageId);
    if (!o) return;
    this.guarded(o, undefined);
  }

  private guarded(o: OpenPage, reason: VersionReason | undefined): void {
    try {
      this.storeOpen(o, reason);
      this.failedStores.delete(o.pageId);
      this.checkRecovered();
    } catch (e) {
      this.failedStores.add(o.pageId);
      this.storageFailed('store', e);
    }
  }

  // ---------------------------------------------------------------- page_full

  /** Whether a new page of this much Yjs state could be synced to a new client (a duplicate, an import). */
  fitsNewPage(stateBytes: number): boolean {
    return stateBytes <= this.opts.pageFullBytes;
  }

  /** Would this update take the page past what a new client can sync? Delete-only updates and repeats never can. */
  wouldOverflow(pageId: string, update: Uint8Array): boolean {
    const o = this.open.get(pageId);
    if (!o || o.stateBytes + update.length <= this.opts.pageFullBytes) return false;
    // The running figure is only an upper bound, so get the real one before refusing anything.
    o.stateBytes = Y.encodeStateAsUpdate(o.doc).length;
    if (o.stateBytes + update.length <= this.opts.pageFullBytes) return false;
    return this.addsStructs(o.doc, update);
  }

  private addsStructs(doc: Y.Doc, update: Uint8Array): boolean {
    let meta: { to: Map<number, number> };
    try {
      meta = Y.parseUpdateMeta(update);
    } catch {
      return false; // Damaged: the normal path throws on it, and that path handles it.
    }
    const have = Y.encodeStateVector(doc);
    const known = Y.decodeStateVector(have);
    for (const [client, clock] of meta.to) if (clock > (known.get(client) ?? 0)) return true;
    return false;
  }

  // ---------------------------------------------------------------- the store

  /**
   * Hocuspocus's onStoreDocument, and everything below. Synchronous: it blocks the loop while it runs. `actor` is who
   * asked for the version (a save or a restore); a version the desk writes by itself is the last editor's.
   */
  store(pageId: string, versionReason?: VersionReason, actor?: string): boolean {
    const o = this.open.get(pageId);
    return o ? this.storeOpen(o, versionReason, actor) : false;
  }

  private storeOpen(o: OpenPage, versionReason?: VersionReason, actor?: string): boolean {
    if (this.closed) return false;
    const edited = o.edits.size > 0;
    if (!edited && !versionReason && !o.logged && !o.queue.length) return false;
    const rec = this.notebook.page(o.pageId);
    const pk = this.db.get<{ pk: number }>('SELECT pk FROM pages WHERE id = ?', o.pageId)?.pk;
    if (!rec || pk === undefined) return false;

    const t0 = performance.now();
    const now = this.opts.now();
    const state = Y.encodeStateAsUpdate(o.doc);
    const t1 = performance.now();
    // Damage that Yjs absorbed can leave a document ProseMirror can't read. The text is still kept in ydoc.
    let doc: PMNode | null = null;
    let d: Derived | null = null;
    let pmJson: string | null = null;
    try {
      doc = jsonOf(o.doc);
      d = derive(doc);
      pmJson = JSON.stringify(doc);
    } catch (e) {
      log('WARN', `derive failed, keeping the last text page=${o.pageId} ${errName(e)}`);
    }
    const t2 = performance.now();

    const title = d ? capTitle(d.title) : rec.title;
    const delta = d ? d.text.length - o.textLength : 0;
    const rows = this.activityRows(o, delta);
    const versions: { meta: VersionMeta; doc: PMNode }[] = [];
    if (o.dayEnd) {
      const end = derive(o.dayEnd.doc);
      versions.push({ meta: this.versionMeta(o.pageId, o.dayEnd.at, 'day_end', capTitle(end.title), end.wordCount, o.dayEnd.actor), doc: o.dayEnd.doc });
    }
    const reason = versionReason ?? (edited && now - o.lastVersionAt >= this.opts.intervalMs ? 'interval' : undefined);
    if (reason && doc && d) {
      // Two versions in one millisecond (a restore right after a save) still sort in the order written.
      const last = this.db.get<{ at: number | null }>('SELECT MAX(created_at) AS at FROM page_versions WHERE page_id = ?', o.pageId)?.at ?? 0;
      versions.push({ meta: this.versionMeta(o.pageId, Math.max(now, last + 1), reason, title, d.wordCount, actor ?? o.lastActor), doc });
    }
    const compressed = versions.map((v) => zstdCompressSync(JSON.stringify(v.doc)));
    const lastEditAt = o.lastEditAt;
    const updatedBy = edited ? o.lastActor : rec.updated_by;

    this.db.tx(() => {
      const changed = edited && (rec.title !== title || rec.snippet !== (d?.snippet ?? rec.snippet) || rec.word_count !== (d?.wordCount ?? rec.word_count) || !!rec.has_checklist !== (d?.hasChecklist ?? !!rec.has_checklist) || lastEditAt > rec.updated_at);
      if (d && pmJson) {
        this.db.run(
          `UPDATE pages SET ydoc = ?, pm_json = ?, plain_text = ?, title = ?, snippet = ?, word_count = ?, has_checklist = ?, updated_at = ?, updated_by = ?, row_version = row_version + ?
           WHERE pk = ?`,
          state,
          pmJson,
          d.text,
          title,
          d.snippet,
          d.wordCount,
          d.hasChecklist ? 1 : 0,
          Math.max(rec.updated_at, lastEditAt),
          updatedBy,
          changed ? 1 : 0,
          pk,
        );
        this.db.run('DELETE FROM pages_fts WHERE rowid = ?', pk);
        this.db.run('INSERT INTO pages_fts (rowid, title, body) VALUES (?, ?, ?)', pk, title, bodyOf(d.text, title));
      } else {
        this.db.run('UPDATE pages SET ydoc = ?, updated_at = ?, row_version = row_version + ? WHERE pk = ?', state, Math.max(rec.updated_at, lastEditAt), changed ? 1 : 0, pk);
      }
      for (const r of rows) {
        this.db.run(
          `INSERT INTO page_activity (page_id, day, created, first_at, last_at, edits, added, removed, actors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (page_id, day) DO UPDATE SET first_at = excluded.first_at, last_at = excluded.last_at, edits = excluded.edits, added = excluded.added, removed = excluded.removed, actors = excluded.actors`,
          r.pageId,
          r.day,
          r.created ? 1 : 0,
          r.firstAt,
          r.lastAt,
          r.edits,
          r.added,
          r.removed,
          JSON.stringify(r.actors),
        );
      }
      versions.forEach((v, i) => {
        this.db.run(
          'INSERT INTO page_versions (id, page_id, created_at, reason, actor, title, word_count, pm_json_zstd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          v.meta.id,
          v.meta.pageId,
          v.meta.createdAt,
          v.meta.reason,
          v.meta.actor,
          v.meta.title,
          v.meta.wordCount,
          compressed[i] as Uint8Array,
        );
      });
      this.db.run('DELETE FROM page_updates WHERE page_id = ?', o.pageId);
      if (changed) this.notebook.bumpRev();
    });

    // Only now, so a store that failed changes nothing: the queue, the edits and the log are all still there.
    o.queue = [];
    o.queueActors = new Set();
    o.logged = false;
    o.edits = new Map();
    o.dayEnd = null;
    o.stateBytes = state.length;
    if (d) o.textLength = d.text.length;
    if (reason && doc && d) {
      o.dirtySinceVersion = false;
      o.lastVersionAt = now;
    }
    this.notebook.announce();
    this.opts.onContentChange(o.pageId);
    const ms = performance.now() - t0;
    this.opts.onStored(o.pageId, ms);
    if (this.opts.debugStores || ms > SLOW_STORE_MS) {
      log('INFO', `store page=${o.pageId} ms=${ms.toFixed(1)} encodeMs=${(t1 - t0).toFixed(1)} deriveMs=${(t2 - t1).toFixed(1)} writeMs=${(performance.now() - t2).toFixed(1)} ydoc=${state.length} json=${pmJson?.length ?? 0} versions=${versions.length}`);
    }
    return true;
  }

  private activityRows(o: OpenPage, delta: number): ActivityRow[] {
    const rows: ActivityRow[] = [];
    const lastDay = [...o.edits.keys()].sort().pop();
    for (const [day, e] of o.edits) {
      const prev = this.db.get<{ created: number; first_at: number; last_at: number; edits: number; added: number; removed: number; actors: string }>(
        'SELECT created, first_at, last_at, edits, added, removed, actors FROM page_activity WHERE page_id = ? AND day = ?',
        o.pageId,
        day,
      );
      const row: ActivityRow = prev
        ? {
            pageId: o.pageId,
            day,
            created: !!prev.created,
            firstAt: Math.min(prev.first_at, e.firstAt),
            lastAt: Math.max(prev.last_at, e.lastAt),
            edits: prev.edits + e.count,
            added: prev.added,
            removed: prev.removed,
            actors: JSON.parse(prev.actors) as string[],
          }
        : { pageId: o.pageId, day, created: false, firstAt: e.firstAt, lastAt: e.lastAt, edits: e.count, added: 0, removed: 0, actors: [] };
      if (day === lastDay) {
        if (delta > 0) row.added += delta;
        else row.removed -= delta;
      }
      for (const actor of e.actors.size ? e.actors : [OWNER_ACTOR]) if (!row.actors.includes(actor)) row.actors = [...row.actors, actor];
      rows.push(row);
    }
    return rows;
  }

  private versionMeta(pageId: string, createdAt: number, reason: VersionReason, title: string, wordCount: number, actor: string): VersionMeta {
    return { id: randomUUID(), pageId, createdAt, reason, actor, title, wordCount };
  }

  // ---------------------------------------------------------------- sessions

  /** The end of an editing session (design 5.3): 5 minutes idle, a page switch or the window closing. */
  endSession(pageId: string): void {
    const o = this.open.get(pageId);
    if (o) this.endSessionQuietly(o);
  }

  private endSessionQuietly(o: OpenPage): void {
    if (o.gone) return;
    this.guarded(o, o.dirtySinceVersion ? 'session' : undefined);
  }

  /** The document left memory. */
  forget(pageId: string): void {
    const o = this.open.get(pageId);
    if (!o) return;
    o.gone = true;
    if (o.idleTimer) clearTimeout(o.idleTimer);
    this.open.delete(pageId);
    this.failedStores.delete(pageId);
    // Unwritten updates don't go with the page: they wait, and are written (or come back if it opens again).
    if (o.queue.length) {
      this.stranded.set(pageId, { pageId, queue: o.queue, queueActors: o.queueActors });
      this.commitTimer ??= setTimeout(() => this.commit(), this.opts.commitMs);
    }
  }

  /** SIGTERM: every open page stored, as a session that ended. */
  storeAll(): void {
    for (const o of [...this.open.values()]) this.endSessionQuietly(o);
    this.commit();
    const left = this.backlog();
    if (left.bytes) log('ERROR', `stopping with edits not written pages=${left.pages} bytes=${left.bytes}`);
  }

  /** At start: pages with log rows, which the last process didn't get to store, are folded in and kept as a session. */
  recover(): number {
    const ids = this.db.all<{ page_id: string }>('SELECT DISTINCT page_id FROM page_updates').map((r) => r.page_id);
    let done = 0;
    for (const pageId of ids) {
      if (!this.notebook.page(pageId)) {
        this.db.run('DELETE FROM page_updates WHERE page_id = ?', pageId);
        continue;
      }
      const doc = new Y.Doc({ gc: true });
      try {
        this.load(pageId, doc);
        const o = this.open.get(pageId) as OpenPage;
        for (const r of this.db.all<{ at: number; edits: number; actors: string | null }>('SELECT at, edits, actors FROM page_updates WHERE page_id = ? ORDER BY seq', pageId)) {
          const day = this.notebook.dayOf(r.at);
          const actors = actorsOf(r.actors);
          const e = o.edits.get(day);
          if (e) {
            e.count += r.edits;
            e.lastAt = r.at;
            for (const a of actors) e.actors.add(a);
          } else o.edits.set(day, { count: r.edits, firstAt: r.at, lastAt: r.at, actors: new Set(actors) });
          o.lastEditAt = r.at;
          o.lastActor = actors[actors.length - 1] as string;
        }
        o.dirtySinceVersion = true;
        this.storeOpen(o, 'session');
        done += 1;
      } catch (e) {
        log('ERROR', `recovery skipped page=${pageId} ${errName(e)}`);
      } finally {
        this.forget(pageId);
        doc.destroy();
      }
    }
    return done;
  }

  // ---------------------------------------------------------------- reads

  /** A page nobody has open, as a load would make it, into a document of the caller's that nothing else sees. */
  readInto(pageId: string, doc: Y.Doc): void {
    const row = this.db.get<{ ydoc: Uint8Array }>('SELECT ydoc FROM pages WHERE id = ?', pageId);
    if (!row) throw notFound();
    Y.applyUpdate(doc, row.ydoc);
    for (const r of this.db.all<{ update_bytes: Uint8Array }>('SELECT update_bytes FROM page_updates WHERE page_id = ? ORDER BY seq', pageId)) {
      try {
        Y.applyUpdate(doc, r.update_bytes);
      } catch {
        // As in load: a row that can't be applied is skipped.
      }
    }
  }

  /** ProseMirror JSON as text: from the live document if the page is open, or as of the last store. */
  contentText(pageId: string): string {
    const row = this.db.get<{ pm_json: string }>('SELECT pm_json FROM pages WHERE id = ?', pageId);
    if (!row) throw notFound();
    const o = this.open.get(pageId);
    if (o) {
      try {
        return JSON.stringify(jsonOf(o.doc));
      } catch (e) {
        log('WARN', `live read failed, giving the last stored page=${pageId} ${errName(e)}`);
      }
    }
    return row.pm_json;
  }

  versions(pageId: string): VersionMeta[] {
    if (!this.notebook.page(pageId)) throw notFound();
    return this.db
      .all<{ id: string; page_id: string; created_at: number; reason: string; actor: string; title: string; word_count: number }>(
        'SELECT id, page_id, created_at, reason, actor, title, word_count FROM page_versions WHERE page_id = ? ORDER BY created_at DESC',
        pageId,
      )
      .map((r) => ({ id: r.id, pageId: r.page_id, createdAt: r.created_at, reason: r.reason as VersionReason, actor: r.actor, title: r.title, wordCount: r.word_count }));
  }

  versionText(versionId: string): { meta: VersionMeta; text: string } | null {
    const r = this.db.get<{ id: string; page_id: string; created_at: number; reason: string; actor: string; title: string; word_count: number; pm_json_zstd: Uint8Array }>(
      'SELECT id, page_id, created_at, reason, actor, title, word_count, pm_json_zstd FROM page_versions WHERE id = ?',
      versionId,
    );
    if (!r) return null;
    return {
      meta: { id: r.id, pageId: r.page_id, createdAt: r.created_at, reason: r.reason as VersionReason, actor: r.actor, title: r.title, wordCount: r.word_count },
      text: zstdDecompressSync(r.pm_json_zstd).toString('utf8'),
    };
  }

  versionMetaById(versionId: string): VersionMeta | null {
    const r = this.db.get<{ id: string; page_id: string; created_at: number; reason: string; actor: string; title: string; word_count: number }>(
      'SELECT id, page_id, created_at, reason, actor, title, word_count FROM page_versions WHERE id = ?',
      versionId,
    );
    return r ? { id: r.id, pageId: r.page_id, createdAt: r.created_at, reason: r.reason as VersionReason, actor: r.actor, title: r.title, wordCount: r.word_count } : null;
  }

  /** The page as it stood at the end of that local day: the newest version written that day or before. */
  versionAsOf(pageId: string, day: string): string | null {
    const candidates = this.versions(pageId).filter((v) => this.notebook.dayOf(v.createdAt) <= day);
    return versionAt(candidates, Number.POSITIVE_INFINITY)?.id ?? null;
  }

  // ---------------------------------------------------------------- restore

  /**
   * Would restoring this text overflow the page? Tried on a copy, so the page is untouched if so. A page's JSON is longer
   * than the Yjs state its text makes, so a restore that plainly fits doesn't pay for the copy.
   */
  restoreWouldOverflow(pageId: string, node: Node, jsonLength: number): boolean {
    const o = this.open.get(pageId);
    if (!o) return false;
    const state = Y.encodeStateAsUpdate(o.doc);
    if (state.length + jsonLength <= this.opts.pageFullBytes) return false;
    const copy = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(copy, state);
      copy.transact(() => prosemirrorToYXmlFragment(node, copy.getXmlFragment(DOC_FIELD)));
      return Y.encodeStateAsUpdate(copy).length > this.opts.pageFullBytes;
    } finally {
      copy.destroy();
    }
  }

  nodeOf(versionText: string): Node {
    return Node.fromJSON(notebookSchema(), JSON.parse(versionText) as PMNode);
  }

  /** Whether the page has unversioned edits, for a restore that must keep them first. */
  dirty(pageId: string): boolean {
    return this.open.get(pageId)?.dirtySinceVersion ?? false;
  }

  // ---------------------------------------------------------------- housekeeping

  /** Trash older than 30 days is purged and old versions thinned (design 5.2, 5.3). */
  housekeeping(): { purged: number; pruned: number } {
    const now = this.opts.now();
    const expired = this.db
      .all<{ id: string }>('SELECT id FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - TRASH_KEEP_MS)
      .map((r) => r.id)
      .filter((id) => !this.open.has(id));
    const metas = this.db
      .all<{ id: string; page_id: string; created_at: number }>('SELECT id, page_id, created_at FROM page_versions')
      .map((r) => ({ id: r.id, pageId: r.page_id, createdAt: r.created_at, reason: 'session' as const, actor: '', title: '', wordCount: 0 }));
    const drop = versionsToPrune(metas, now, (ts) => this.notebook.dayOf(ts));
    if (!expired.length && !drop.length) return { purged: 0, pruned: 0 };
    this.db.tx(() => {
      for (const id of expired) this.notebook.purgePage(id);
      for (const id of drop) this.db.run('DELETE FROM page_versions WHERE id = ?', id);
      if (expired.length) this.notebook.bumpRev();
    });
    if (expired.length) this.notebook.announce();
    return { purged: expired.length, pruned: drop.length };
  }
}
