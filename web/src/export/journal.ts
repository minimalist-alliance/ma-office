// The download's journal, so a reload or a closed tab can carry on rather than start again: what the download is
// (the desks, their folders, where it's saved), every finished entry with what the central directory and the manifest
// need, and the entry being written with the hash of as much of it as is in the archive. It's written only once the
// archive holds everything it describes, so carrying on cuts the archive back to `pos` and goes on from there.
import { dropExport, EXPORT_DB, markExportProgress } from '../platform/exportSweep';
import type { ManifestDesk } from './archive';
import { DOMAIN_JOURNAL, openBytes, sealBytes, type Nonces } from './seal';
import type { Sha256State } from './sha256';
import type { EntryRecord, OpenEntry } from './zip';

export interface JournalDesk {
  deskId: string;
  name: string;
  folder: string;
  /** Finished, however it ended, with its row and manifest numbers. */
  done?: {
    phase: string;
    files: number;
    bytes: number;
    notCopied: number;
    note?: string;
    parts: ManifestDesk['parts'];
    links: { path: string; target: string }[];
    notCopiedList: { path: string; reason: string }[];
  };
}

export interface JournalMeta {
  /** One download: a new one starts a new journal. */
  id: string;
  madeAt: string;
  /** The member's name for the file. */
  fileName: string;
  /** Saved into a file the member chose (`handle`), or offered from this browser at the end. */
  target: 'file' | 'browser';
  handle?: FileSystemFileHandle;
  /** A closed account's download, over export-only sessions. */
  ended: boolean;
  /** Protected with a passphrase (`passphrase.ts`): the member types it again before the archive is saved, as it is never kept. */
  encrypted?: boolean;
  desks: JournalDesk[];
  /** The archive holds everything up to here. */
  pos: number;
  /** The entry being written, its part and path on the desk, and the hash of its `size` bytes. */
  open: (OpenEntry & { part: string; path: string; sha: Sha256State }) | null;
  doneBytes: number;
  totalBytes: number;
}

/** A new download's journal, before anything is written. */
export function freshMeta(m: Pick<JournalMeta, 'id' | 'madeAt' | 'fileName' | 'target' | 'handle' | 'ended'> & { encrypted?: boolean } & { desks: { deskId: string; name: string; folder: string }[] }): JournalMeta {
  return { ...m, desks: m.desks.map((d) => ({ deskId: d.deskId, name: d.name, folder: d.folder })), pos: 0, open: null, doneBytes: 0, totalBytes: 0 };
}

/** A finished entry, with its SHA-256 if it's a file. */
export interface JournalEntry extends EntryRecord {
  sha256?: string;
}

export interface JournalStore {
  load(): Promise<{ meta: JournalMeta; entries: JournalEntry[] } | null>;
  /** Writes `meta` and adds `entries`, all at once or not at all. */
  save(meta: JournalMeta, entries: readonly JournalEntry[]): Promise<void>;
  clear(): Promise<void>;
}

/** For tests, and where IndexedDB can't be used: a download then can't outlive the page. */
export class MemoryJournal implements JournalStore {
  meta: JournalMeta | null = null;
  entries: JournalEntry[] = [];
  saves = 0;
  async load(): Promise<{ meta: JournalMeta; entries: JournalEntry[] } | null> {
    return this.meta ? { meta: structuredClone(this.meta), entries: this.entries.map((e) => ({ ...e })) } : null;
  }
  async save(meta: JournalMeta, entries: readonly JournalEntry[]): Promise<void> {
    this.saves += 1;
    this.meta = structuredClone(meta);
    this.entries.push(...entries.map((e) => ({ ...e })));
  }
  async clear(): Promise<void> {
    this.meta = null;
    this.entries = [];
  }
}

/** What stays outside the sealed journal: the key itself, the epoch, the last progress time, whose it is, and the chosen file. */
export interface Secret {
  key: CryptoKey;
  epoch: number;
  /** When the download last moved on: it goes after 6 hours without (`exportSweep.ts`). */
  at: number;
  /** The member who started it, as `exportOwnerTag` gives it: a hash, never the id itself. Nobody else may carry it on. */
  owner?: string;
  handle?: FileSystemFileHandle;
}

/** Where the journal is kept. Its values are only ever sealed bytes, the secret apart. */
export interface JournalKv {
  getSecret(): Promise<Secret | null>;
  putSecret(s: Secret): Promise<void>;
  getMeta(): Promise<Uint8Array | null>;
  getEntries(): Promise<Uint8Array[]>;
  /** The meta, a batch of entries and the secret, all at once or not at all. */
  write(meta: Uint8Array, batch: Uint8Array | null, secret: Secret): Promise<void>;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const AAD_META = utf8.encode('ma-export meta');
const AAD_ENTRIES = utf8.encode('ma-export entries');

/**
 * The journal sealed under the download's key: names, hashes, desks, the hash state, all of it. Only the secret
 * record is in the clear, and it holds nothing of the member's.
 */
export class SealedJournal implements JournalStore {
  private last: { done: number; pos: number } | null = null;

  constructor(
    private readonly kv: JournalKv,
    private secret: Secret,
    private readonly nonces: Nonces | null,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<{ meta: JournalMeta; entries: JournalEntry[] } | null> {
    const sealed = await this.kv.getMeta();
    if (!sealed) return null;
    const meta = JSON.parse(fromUtf8.decode(await openBytes(this.secret.key, sealed, AAD_META))) as JournalMeta;
    if (this.secret.handle) meta.handle = this.secret.handle;
    const entries: JournalEntry[] = [];
    for (const b of await this.kv.getEntries()) entries.push(...(JSON.parse(fromUtf8.decode(await openBytes(this.secret.key, b, AAD_ENTRIES))) as JournalEntry[]));
    return { meta, entries };
  }

  async save(meta: JournalMeta, entries: readonly JournalEntry[]): Promise<void> {
    if (!this.nonces) throw new Error('this journal was opened to read');
    const { handle, ...plain } = meta;
    const sealedMeta = await sealBytes(this.secret.key, this.nonces.next(DOMAIN_JOURNAL), utf8.encode(JSON.stringify(plain)), AAD_META);
    const batch = entries.length ? await sealBytes(this.secret.key, this.nonces.next(DOMAIN_JOURNAL), utf8.encode(JSON.stringify(entries)), AAD_ENTRIES) : null;
    // The 6 hours count from the last time the download moved on, not from the last save.
    const moved = !this.last || meta.doneBytes > this.last.done || meta.pos !== this.last.pos;
    const secret: Secret = { ...this.secret, ...(handle ? { handle } : {}), at: moved ? this.now() : this.secret.at };
    await this.kv.write(sealedMeta, batch, secret);
    this.secret = secret;
    this.last = { done: meta.doneBytes, pos: meta.pos };
    if (moved) markExportProgress(secret.at);
  }

  async clear(): Promise<void> {
    await dropExport();
  }
}

/** For tests: everything it was handed, as it was handed, so a test can look for plaintext. */
export class MemoryKv implements JournalKv {
  secret: Secret | null = null;
  meta: Uint8Array | null = null;
  entries: Uint8Array[] = [];
  async getSecret(): Promise<Secret | null> {
    return this.secret;
  }
  async putSecret(s: Secret): Promise<void> {
    this.secret = s;
  }
  async getMeta(): Promise<Uint8Array | null> {
    return this.meta;
  }
  async getEntries(): Promise<Uint8Array[]> {
    return this.entries;
  }
  async write(meta: Uint8Array, batch: Uint8Array | null, secret: Secret): Promise<void> {
    this.meta = meta;
    if (batch) this.entries.push(batch);
    this.secret = secret;
  }
}

const SECRET = 'secret';
const META = 'meta';
const ENTRIES = 'entries';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * IndexedDB `ma-export`, version 2. Version 1 kept the journal in the clear, so its stores go. Its connection closes
 * when anything asks to delete the database, so `dropExport` from any tab goes through, and says so (`onGone`).
 */
export class IdbKv implements JournalKv {
  /** Something is deleting the journal: a sign-out, a Discard or the 6 hours, maybe in another tab. */
  onGone: (() => void) | null = null;

  private constructor(private readonly db: IDBDatabase) {
    db.onversionchange = () => {
      db.close();
      this.onGone?.();
    };
  }

  static open(): Promise<IdbKv> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(EXPORT_DB, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        db.createObjectStore(SECRET);
        db.createObjectStore(META);
        db.createObjectStore(ENTRIES, { autoIncrement: true });
      };
      r.onsuccess = () => resolve(new IdbKv(r.result));
      r.onerror = () => reject(r.error ?? new Error('IndexedDB would not open'));
      r.onblocked = () => reject(new DOMException('another tab holds the journal', 'InvalidStateError'));
    });
  }

  close(): void {
    this.db.close();
  }

  async getSecret(): Promise<Secret | null> {
    return ((await request(this.db.transaction(SECRET).objectStore(SECRET).get('current'))) as Secret | undefined) ?? null;
  }

  async putSecret(s: Secret): Promise<void> {
    const tx = this.db.transaction(SECRET, 'readwrite');
    tx.objectStore(SECRET).put(s, 'current');
    await done(tx);
  }

  async getMeta(): Promise<Uint8Array | null> {
    return ((await request(this.db.transaction(META).objectStore(META).get('current'))) as Uint8Array | undefined) ?? null;
  }

  async getEntries(): Promise<Uint8Array[]> {
    return (await request(this.db.transaction(ENTRIES).objectStore(ENTRIES).getAll())) as Uint8Array[];
  }

  async write(meta: Uint8Array, batch: Uint8Array | null, secret: Secret): Promise<void> {
    const tx = this.db.transaction([SECRET, META, ENTRIES], 'readwrite');
    tx.objectStore(META).put(meta, 'current');
    if (batch) tx.objectStore(ENTRIES).add(batch);
    tx.objectStore(SECRET).put(secret, 'current');
    await done(tx);
  }
}
