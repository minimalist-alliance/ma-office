// Dev and test only, through mockDeskLink.ts (never in a production bundle). A small desk's files for the export
// page, served as deskd serves `data.*` (draft ADR "data export and transfer", section 7): parts, paged manifests,
// and `data.read` as CHUNK frames on a `bulk` that honours CREDIT, ending in the real trailer.
import type { BulkChannel, CreditMessage, DataEntry, DataPart } from './deskLink';

export type MockNode =
  | { type: 'dir'; mtimeMs: number }
  | { type: 'file'; bytes: Uint8Array; mtimeMs: number; mode?: number }
  | { type: 'link'; target: string; mtimeMs: number };
export type MockParts = Record<string, Record<string, MockNode>>;

export interface MockDataControl {
  /** Every part's files by path. Change them in a test to change what a desk holds. */
  parts: MockParts;
  /** Every `data.read`, in order. A resumed one has an `offset` past 0. */
  reads: { deskId: string; part: string; path: string; offset: number; scope: string; id: number }[];
  /** Every CREDIT the page granted. */
  credits: { id: number; bytes: number }[];
  /** Drop the session once a read of `path` has sent this many bytes, once. */
  dropAfter: { path: string; bytes: number } | null;
  /** Sessions dropped by `dropAfter`. */
  drops: number;
  manifestPage: number;
  /** `data.parts.list` answers `unavailable` with `reason: "helper"`, as a desk without `desk-data` does. */
  noHelper: boolean;
  /** CHUNK frames per tick: the mock's line speed. */
  chunksPerTick: number;
  /** How long a tick waits, for a download slow enough to interrupt. */
  tickMs: number;
}

const CHUNK = 16372;
const FIRST_WINDOW = 1024 * 1024;
const DAY = Date.UTC(2026, 10, 5, 9, 30);

/** The same bytes every run, so a test can know what it should get. */
export function mockBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const file = (bytes: Uint8Array, mode = 0o600): MockNode => ({ type: 'file', bytes, mtimeMs: DAY, mode });
const dir = (): MockNode => ({ type: 'dir', mtimeMs: DAY });

export function sampleParts(): MockParts {
  return {
    browser: {
      profile: dir(),
      'profile/Default': dir(),
      'profile/Default/Bookmarks': file(text(JSON.stringify({ roots: { bookmark_bar: { children: [{ name: 'Example', url: 'https://example.org/' }] } } }))),
      'profile/Default/History': file(mockBytes(96 * 1024, 7)),
      'profile/Default/Cookies': file(mockBytes(40 * 1024, 11)),
      'profile/Local State': file(text('{"browser":{"enabled_labs_experiments":[]}}')),
    },
    'browser-readable': {
      Default: dir(),
      'Default/bookmarks.html': file(text('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p><DT><A HREF="https://example.org/">Example</A></DL>\n'), 0o644),
      'Default/history.csv': file(text('visited_at,title,url\n2026-11-05T09:30:00Z,Example,https://example.org/\n'), 0o644),
    },
    desk: {
      'settings.json': file(text('{"theme":"system"}')),
      notebook: dir(),
      'notebook/Café notes.json': file(text('{"title":"Café notes"}')),
    },
    files: {
      Photos: dir(),
      'Photos/harbor.jpg': file(mockBytes(3 * 1024 * 1024 + 4321, 23), 0o644),
      'Empty folder': dir(),
      'notes.txt': file(text('Pick up the film on Friday.\n'), 0o644),
      latest: { type: 'link', target: 'Photos/harbor.jpg', mtimeMs: DAY },
    },
  };
}

export function newDataControl(): MockDataControl {
  return { parts: sampleParts(), reads: [], credits: [], dropAfter: null, drops: 0, manifestPage: 2000, noHelper: false, chunksPerTick: 24, tickMs: 0 };
}

const refusal = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock ${code}`), { code, details });

interface Transfer {
  id: number;
  path: string;
  whole: Uint8Array;
  /** The bytes from `offset` on. */
  bytes: Uint8Array;
  at: number;
  granted: number;
  seq: number;
  scheduled: boolean;
  ended: boolean;
}

/** One session's `bulk`. `close` ends its transfers, as a session ending does. */
export class MockBulk implements BulkChannel {
  onChunk: BulkChannel['onChunk'] = null;
  onCredit: BulkChannel['onCredit'] = null;
  /** The Files desk's side of an upload: frames the page sends, by transfer id (`mockDeskFiles.ts`). */
  private readonly uploads = new Map<number, (seq: number, payload: Uint8Array) => void>();
  private readonly control: MockDataControl;
  private readonly onDrop: () => void;
  private readonly transfers = new Map<number, Transfer>();
  private nextId = 1;
  private closed = false;

  constructor(control: MockDataControl, onDrop: () => void) {
    this.control = control;
    this.onDrop = onDrop;
  }

  send(id: number, seq: number, payload: Uint8Array): boolean {
    if (this.closed) return false;
    this.uploads.get(id)?.(seq, payload.slice());
    return true;
  }

  drained(): Promise<void> {
    return Promise.resolve();
  }

  /** A transfer id from this session's counter, for an upload. */
  newTransferId(): number {
    return this.nextId++;
  }

  /** The desk takes upload frames for `id` until `detachUpload`. */
  attachUpload(id: number, onFrame: (seq: number, payload: Uint8Array) => void): void {
    this.uploads.set(id, onFrame);
  }

  detachUpload(id: number): void {
    this.uploads.delete(id);
  }

  /** The desk's CREDIT to the page. */
  emitCredit(id: number, msg: CreditMessage): void {
    if (!this.closed) this.onCredit?.(id, msg);
  }

  private emitChunk(id: number, seq: number, end: boolean, payload: Uint8Array): void {
    this.onChunk?.(id, seq, end, payload);
  }

  credit(id: number, bytes: number): void {
    this.control.credits.push({ id, bytes });
    const t = this.transfers.get(id);
    if (!t) return;
    t.granted += bytes;
    this.schedule(t);
  }

  close(): void {
    this.closed = true;
    this.transfers.clear();
    this.uploads.clear();
  }

  read(path: string, whole: Uint8Array, offset: number): number {
    const t: Transfer = { id: this.nextId++, path, whole, bytes: whole.subarray(Math.min(offset, whole.length)), at: 0, granted: FIRST_WINDOW, seq: 0, scheduled: false, ended: false };
    this.transfers.set(t.id, t);
    this.schedule(t);
    return t.id;
  }

  stop(id: number): void {
    this.transfers.delete(id);
  }

  private schedule(t: Transfer): void {
    if (t.scheduled || t.ended || this.closed) return;
    t.scheduled = true;
    window.setTimeout(() => {
      t.scheduled = false;
      this.pump(t);
    }, this.control.tickMs);
  }

  private pump(t: Transfer): void {
    if (this.closed || !this.transfers.has(t.id)) return;
    for (let n = 0; n < this.control.chunksPerTick && t.at < t.bytes.length && t.at < t.granted; n += 1) {
      const end = Math.min(t.at + CHUNK, t.bytes.length, t.granted);
      this.emitChunk(t.id, t.seq++, false, t.bytes.slice(t.at, end));
      t.at = end;
      const drop = this.control.dropAfter;
      if (drop && drop.path === t.path && t.whole.length - t.bytes.length + t.at >= drop.bytes) {
        this.control.dropAfter = null;
        this.control.drops += 1;
        this.onDrop();
        return;
      }
      if (this.closed) return;
    }
    if (t.at >= t.bytes.length) {
      t.ended = true;
      // The trailer: SHA-256 of the whole file from byte 0, then u64be size, as deskd sends it after a resume too.
      void crypto.subtle.digest('SHA-256', t.whole as Uint8Array<ArrayBuffer>).then((digest) => {
        if (this.closed || !this.transfers.delete(t.id)) return;
        const trailer = new Uint8Array(40);
        trailer.set(new Uint8Array(digest));
        new DataView(trailer.buffer).setBigUint64(32, BigInt(t.whole.length));
        this.emitChunk(t.id, t.seq++, true, trailer);
      });
      return;
    }
    if (t.at < t.granted) this.schedule(t);
  }
}

/** `data.*` as deskd answers them, on a small scale. */
export function answerData(control: MockDataControl, bulk: MockBulk | null, method: string, params: Record<string, unknown>, who: { deskId: string; scope: string }): Promise<unknown> {
  const parts = control.parts;
  const part = typeof params['part'] === 'string' ? (params['part'] as string) : '';
  if (method === 'data.parts.list') {
    if (control.noHelper) return Promise.reject(refusal('unavailable', { reason: 'helper' }));
    const list: DataPart[] = Object.entries(parts).map(([name, nodes]) => {
      const files = Object.values(nodes).filter((n) => n.type === 'file') as { bytes: Uint8Array }[];
      return { part: name, label: name, files: files.length, bytes: files.reduce((s, f) => s + f.bytes.length, 0) };
    });
    return Promise.resolve({ parts: list, helperVersion: 'mock' });
  }
  if (method === 'data.manifest') {
    const nodes = parts[part];
    if (!nodes) return Promise.reject(refusal('not_found'));
    const cursor = typeof params['cursor'] === 'string' ? (params['cursor'] as string) : null;
    const paths = Object.keys(nodes).sort();
    const from = cursor === null ? 0 : paths.findIndex((p) => p > cursor);
    const page = from < 0 ? [] : paths.slice(from, from + control.manifestPage);
    const entries: DataEntry[] = page.map((path) => {
      const n = nodes[path] as MockNode;
      if (n.type === 'file') return { path, type: 'file', size: n.bytes.length, mtimeMs: n.mtimeMs, mode: n.mode ?? 0o600 };
      if (n.type === 'link') return { path, type: 'link', size: 0, mtimeMs: n.mtimeMs, mode: 0o777, target: n.target };
      return { path, type: 'dir', size: 0, mtimeMs: n.mtimeMs, mode: 0o700 };
    });
    const last = page[page.length - 1];
    return Promise.resolve({ entries, next: from >= 0 && from + page.length < paths.length && last !== undefined ? last : null });
  }
  if (method === 'data.read') {
    const path = String(params['path'] ?? '');
    const n = parts[part]?.[path];
    if (!n) return Promise.reject(refusal('not_found'));
    if (n.type !== 'file') return Promise.reject(refusal('invalid'));
    if (!bulk) return Promise.reject(refusal('unavailable'));
    const offset = Math.max(0, Number(params['offset']) || 0);
    const transferId = bulk.read(path, n.bytes, offset);
    control.reads.push({ deskId: who.deskId, part, path, offset, scope: who.scope, id: transferId });
    return Promise.resolve({ transferId, size: n.bytes.length, mtimeMs: n.mtimeMs });
  }
  if (method === 'data.read.stop') {
    bulk?.stop(Number(params['transferId']));
    return Promise.resolve({});
  }
  return Promise.reject(refusal('not_found'));
}
