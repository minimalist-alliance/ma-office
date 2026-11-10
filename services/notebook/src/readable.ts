// /data/notebook/readable/<notebook>/<tab>/<title>.md: plain Markdown of every live page, so a member's export reads
// without SQLite. It's only ever a copy of what the database holds, so a failure here logs one line and changes nothing
// about the notes. Each file goes through a temporary name and a rename. It's behind if `readable_rev` isn't the tree's
// rev, and then it's rebuilt, a page at a time, after the socket is up.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Db } from './db.ts';
import { errName, log } from './log.ts';
import { fileName, toMarkdown, type PMNode } from './model.ts';

const MAX_NAME_BYTES = 180;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A name safe on any filesystem a member unpacks this on: no path characters, no leading dot, not reserved. */
export function safeName(title: string, fallback: string): string {
  let s = fileName(title || fallback, 'x').slice(0, -2);
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  while (Buffer.byteLength(s) > MAX_NAME_BYTES) s = [...s].slice(0, -1).join('');
  return s;
}

/** Names unique within one directory, compared ignoring case. The oldest keeps the plain name; others add their id. */
function assign<T extends { id: string; title: string; created_at: number }>(items: T[], fallback: string): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const it of [...items].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))) {
    const base = safeName(it.title, fallback);
    const key = base.toLowerCase();
    const name = taken.has(key) ? `${base} (${it.id})` : base;
    taken.add(name.toLowerCase());
    out.set(it.id, name);
  }
  return out;
}

export interface ReadableOptions {
  debounceMs: number;
  /** The tree's rev now. */
  rev: () => number;
}

export class Readable {
  private readonly root: string;
  /** Page id to where its file is, relative to root. */
  private current = new Map<string, string>();
  private dirtyPages = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failing = false;
  private stopped = false;
  private rebuilding: Promise<void> | null = null;

  constructor(
    dataDir: string,
    private readonly db: Db,
    private readonly opts: ReadableOptions,
  ) {
    this.root = join(dataDir, 'readable');
  }

  /** At start: if it's behind or missing, rebuild it in the background. Never throws. */
  start(): void {
    try {
      const behind = this.db.setting('readable_rev') !== String(this.opts.rev()) || !this.rootExists();
      if (behind) {
        this.rebuilding = this.rebuild().finally(() => {
          this.rebuilding = null;
          if (!this.stopped && !this.db.closed && this.db.setting('readable_rev') !== String(this.opts.rev())) this.treeChanged();
        });
      } else {
        this.current = this.desired();
      }
    } catch (e) {
      this.fail(e);
    }
  }

  private rootExists(): boolean {
    try {
      return statSync(this.root).isDirectory();
    } catch {
      return false;
    }
  }

  /** A page's text changed. */
  pageChanged(pageId: string): void {
    this.dirtyPages.add(pageId);
    this.schedule();
  }

  /** A name, a move or a trash changed where files belong. */
  treeChanged(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, this.opts.debounceMs);
    this.timer.unref();
  }

  /** For tests and SIGTERM: everything now, synchronously. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Waits for a rebuild that's running, for tests. */
  async settled(): Promise<void> {
    await this.rebuilding;
  }

  private tick(): void {
    if (this.rebuilding) {
      this.schedule();
      return;
    }
    try {
      const dirty = this.dirtyPages;
      this.dirtyPages = new Set();
      const rev = this.opts.rev();
      const want = this.desired();
      for (const [id, rel] of this.current) {
        if (want.get(id) !== rel) {
          this.remove(rel);
          this.current.delete(id);
        }
      }
      for (const [id, rel] of want) {
        if (this.current.get(id) === rel && !dirty.has(id)) continue;
        this.writePage(id, rel);
        this.current.set(id, rel);
      }
      this.db.setSetting('readable_rev', String(rev));
      if (this.failing) {
        this.failing = false;
        log('INFO', 'readable export works again');
      }
    } catch (e) {
      this.fail(e);
      this.schedule();
    }
  }

  private fail(e: unknown): void {
    if (this.failing) return;
    this.failing = true;
    log('WARN', `readable export failed, notes are unaffected ${errName(e)}`);
  }

  /** Where every live page belongs, from the database. Deterministic, so the same tree gives the same paths. */
  private desired(): Map<string, string> {
    const notebooks = this.db.all<{ id: string; title: string; created_at: number }>('SELECT id, title, created_at FROM notebooks WHERE deleted_at IS NULL');
    const tabs = this.db.all<{ id: string; notebook_id: string; title: string; created_at: number }>('SELECT id, notebook_id, title, created_at FROM tabs');
    const pages = this.db.all<{ id: string; tab_id: string; title: string; created_at: number }>('SELECT id, tab_id, title, created_at FROM pages WHERE deleted_at IS NULL');
    const notebookNames = assign(notebooks, 'Notebook');
    const tabDirs = new Map<string, string>();
    const tabsByNotebook = new Map<string, typeof tabs>();
    for (const t of tabs) (tabsByNotebook.get(t.notebook_id) ?? tabsByNotebook.set(t.notebook_id, []).get(t.notebook_id))?.push(t);
    for (const [notebookId, list] of tabsByNotebook) {
      const nb = notebookNames.get(notebookId);
      if (!nb) continue;
      for (const [tabId, name] of assign(list, 'Tab')) tabDirs.set(tabId, join(nb, name));
    }
    const pagesByTab = new Map<string, typeof pages>();
    for (const p of pages) (pagesByTab.get(p.tab_id) ?? pagesByTab.set(p.tab_id, []).get(p.tab_id))?.push(p);
    const out = new Map<string, string>();
    for (const [tabId, list] of pagesByTab) {
      const dir = tabDirs.get(tabId);
      if (!dir) continue;
      for (const [pageId, name] of assign(list, 'Note')) out.set(pageId, join(dir, `${name}.md`));
    }
    return out;
  }

  private markdownOf(pageId: string): string | null {
    const row = this.db.get<{ pm_json: string }>('SELECT pm_json FROM pages WHERE id = ?', pageId);
    return row ? toMarkdown(JSON.parse(row.pm_json) as PMNode) : null;
  }

  private writePage(pageId: string, rel: string): void {
    const text = this.markdownOf(pageId);
    if (text === null) return;
    this.writeFile(rel, text);
  }

  private writeFile(rel: string, text: string): void {
    const target = join(this.root, rel);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.tmp-${process.pid}.md`);
    const fd = openSync(tmp, 'w', 0o640);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  }

  private remove(rel: string): void {
    rmSync(join(this.root, rel), { force: true });
    let dir = dirname(rel);
    while (dir !== '.') {
      try {
        rmdirSync(join(this.root, dir));
      } catch {
        return; // Not empty, or gone.
      }
      dir = dirname(dir);
    }
  }

  /** Makes the directory match the database: writes what differs and removes what shouldn't be there. */
  private async rebuild(): Promise<void> {
    try {
      const rev = this.opts.rev();
      const want = this.desired();
      mkdirSync(this.root, { recursive: true });
      const keep = new Set(want.values());
      for (const rel of this.listFiles('')) if (!keep.has(rel)) this.remove(rel);
      for (const [id, rel] of want) {
        if (this.stopped) return;
        const text = this.markdownOf(id);
        if (text !== null && this.existing(rel) !== text) this.writeFile(rel, text);
        this.current.set(id, rel);
        // A page at a time, so merging goes on meanwhile.
        await new Promise((r) => setImmediate(r));
      }
      this.removeEmptyDirs('');
      this.db.setSetting('readable_rev', String(rev));
      log('INFO', `readable export rebuilt pages=${want.size}`);
    } catch (e) {
      this.fail(e);
    }
  }

  private existing(rel: string): string | null {
    try {
      return readFileSync(join(this.root, rel), 'utf8');
    } catch {
      return null;
    }
  }

  private listFiles(rel: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(join(this.root, rel), { withFileTypes: true })) {
      const child = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) out.push(...this.listFiles(child));
      else out.push(child);
    }
    return out;
  }

  private removeEmptyDirs(rel: string): void {
    for (const e of readdirSync(join(this.root, rel), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const child = rel ? join(rel, e.name) : e.name;
      this.removeEmptyDirs(child);
      try {
        rmdirSync(join(this.root, child));
      } catch {
        // Not empty.
      }
    }
  }
}
