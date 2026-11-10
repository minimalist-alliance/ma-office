// notebook.db: design 5.4's tables without attachments, plus page_updates, the log that makes a restart lose nothing.
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';

/** This release's schema. A higher number on disk is refused, and nothing is touched. */
export const SCHEMA_VERSION = 1;

export class NewerSchemaError extends Error {
  override name = 'NewerSchemaError';
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`notebook.db has schema ${found}, and this release knows up to ${supported}`);
  }
}

const MIGRATIONS: string[] = [
  // 1
  `
  CREATE TABLE notebooks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    color TEXT,
    sort_key REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    row_version INTEGER NOT NULL
  );
  CREATE TABLE tabs (
    id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id),
    title TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_key REAL NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    row_version INTEGER NOT NULL
  );
  CREATE INDEX tabs_by_notebook ON tabs(notebook_id, sort_key);
  -- The small columns come first, so reading the tree never touches the overflow pages of the last three.
  CREATE TABLE pages (
    pk INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    sort_key REAL NOT NULL,
    title TEXT NOT NULL,
    snippet TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL,
    has_checklist INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    deleted_at INTEGER,
    row_version INTEGER NOT NULL,
    ydoc BLOB NOT NULL,
    pm_json TEXT NOT NULL,
    plain_text TEXT NOT NULL
  );
  CREATE INDEX pages_by_tab ON pages(tab_id, sort_key);
  CREATE INDEX pages_by_deleted ON pages(deleted_at) WHERE deleted_at IS NOT NULL;
  -- Client updates not yet in pages.ydoc. Load is ydoc plus these; a store folds them in and clears them.
  CREATE TABLE page_updates (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id TEXT NOT NULL,
    update_bytes BLOB NOT NULL,
    at INTEGER NOT NULL,
    edits INTEGER NOT NULL
  );
  CREATE INDEX page_updates_by_page ON page_updates(page_id, seq);
  CREATE TABLE page_versions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('session', 'interval', 'day_end', 'pre_agent', 'restore', 'manual')),
    actor TEXT NOT NULL,
    title TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    pm_json_zstd BLOB NOT NULL
  );
  CREATE INDEX page_versions_by_page ON page_versions(page_id, created_at);
  CREATE TABLE page_activity (
    page_id TEXT NOT NULL,
    day TEXT NOT NULL,
    created INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    edits INTEGER NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    actors TEXT NOT NULL,
    PRIMARY KEY (page_id, day)
  ) WITHOUT ROWID;
  CREATE INDEX page_activity_by_day ON page_activity(day);
  CREATE VIRTUAL TABLE pages_fts USING fts5(title, body, tokenize = "unicode61 remove_diacritics 2", prefix = '2 3');
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  INSERT INTO settings (key, value) VALUES ('rev', '0'), ('readable_rev', '-1'), ('time_zone', 'UTC');
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private depth = 0;
  closed = false;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    // Before anything that could write: a newer schema is refused with the file exactly as it was.
    const found = this.schemaVersion();
    if (found > SCHEMA_VERSION) {
      this.raw.close();
      this.closed = true;
      throw new NewerSchemaError(found, SCHEMA_VERSION);
    }
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 2000;
      PRAGMA temp_store = MEMORY;
      PRAGMA journal_size_limit = 16777216;
    `);
    this.migrate();
    this.additive();
  }

  /**
   * Guild desks' writers and names. Created if missing at every start, without a schema bump, because a build without
   * them ignores them: a rollback still opens the file. Personal and Work desks get them empty.
   */
  private additive(): void {
    this.tx(() => {
      this.raw.exec(`
        CREATE TABLE IF NOT EXISTS page_clients (page_id TEXT NOT NULL, client INTEGER NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (page_id, client)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS page_credits (page_id TEXT NOT NULL, client INTEGER NOT NULL, clock INTEGER NOT NULL, len INTEGER NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (page_id, client, clock)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS members (member_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
      `);
      const cols = this.raw.prepare('PRAGMA table_info(page_updates)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'actors')) this.raw.exec('ALTER TABLE page_updates ADD COLUMN actors TEXT');
    });
  }

  private schemaVersion(): number {
    return (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  private migrate(): void {
    for (let v = this.schemaVersion(); v < SCHEMA_VERSION; v += 1) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v] as string);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** A cached prepared statement. */
  q(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.q(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.q(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.q(sql).run(...params);
  }

  /** One transaction, IMMEDIATE so a write never fails half way on a lock. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // SQLite may have rolled back by itself (disk full): nothing left to undo.
      }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  setting(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  checkpointAndClose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // A reader held it past busy_timeout. The WAL is still durable; the next start replays it.
    }
    this.statements.clear();
    this.raw.close();
  }
}
