// Test only: a desk that answers `data.*` and sends `bulk` as deskd does, with knobs for what can go wrong, and sinks
// that a real unzip can open. Nothing in the app imports this.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, ftruncateSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskNotConnected, type BulkChannel, type DataEntry, type DeskLink, type LinkState } from '../desk/deskLink';
import type { Blocks } from './seal';
import type { Sink } from './zip';

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Bytes that are the same every run. */
export function bytesOf(n: number, seed: number): Uint8Array {
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

export interface FakeEntry {
  part: string;
  path: string;
  type?: 'file' | 'dir' | 'link';
  bytes?: Uint8Array;
  target?: string;
  /** Sends only this many bytes, as a file that shrank while it was read. */
  shrinkTo?: number;
}

interface Transfer {
  id: number;
  entry: FakeEntry;
  /** What goes out from `offset`. */
  out: Uint8Array;
  /** What the desk hashes for the trailer, from 0. */
  hashed: Uint8Array;
  offsetBase: number;
  at: number;
  granted: number;
  seq: number;
  bulk: FakeBulk;
  scheduled: boolean;
}

class FakeBulk implements BulkChannel {
  onChunk: BulkChannel['onChunk'] = null;
  closed = false;
  constructor(private readonly desk: FakeDesk) {}
  // The export only reads; the Files app's sender and listeners have nothing to do here.
  onCredit: BulkChannel['onCredit'] = null;
  send(): boolean {
    return false;
  }
  drained(): Promise<void> {
    return Promise.resolve();
  }
  credit(id: number, bytes: number): void {
    this.desk.credits.push({ id, bytes });
    const t = this.desk.transfers.get(id);
    if (!t || t.bulk !== this) return;
    t.granted += bytes;
    this.desk.schedule(t);
  }
}

const refused = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(code), { code, details });

export class FakeDesk {
  state: LinkState = 'open';
  bulkNow = new FakeBulk(this);
  readonly listeners = new Set<(s: LinkState) => void>();
  entries: FakeEntry[];
  readonly reads: { path: string; offset: number }[] = [];
  readonly credits: { id: number; bytes: number }[] = [];
  readonly stops: number[] = [];
  readonly transfers = new Map<number, Transfer>();
  maxActive = 0;
  private nextId = 1;

  pageSize = 2000;
  chunkSize = 16372;
  perTick = 8;
  /** `data.parts.list` says `unavailable`, `reason: "helper"`. */
  noHelper = false;
  /** The next read of these sends bytes that aren't what the desk hashes: the file changed while it was read. */
  readonly changeNext = new Set<string>();
  /** Every read of these is like that. */
  readonly changeAlways = new Set<string>();
  /** The session goes once a read of `path` has sent `bytes` from 0. */
  dropAfter: { path: string; bytes: number; reconnectMs?: number } | null = null;
  /** The next read of `path` loses one CHUNK on the way. */
  loseOne: string | null = null;
  /** The first CHUNK goes before `data.read`'s answer, as channels aren't ordered. */
  chunkFirst = false;
  /** `data.read` of these paths refuses with this code. */
  readonly refuseRead = new Map<string, string>();

  constructor(entries: FakeEntry[]) {
    this.entries = entries;
  }

  setState(s: LinkState): void {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** The session goes, as when the network does, and a new one opens `ms` later. */
  drop(ms = 30): void {
    this.bulkNow.closed = true;
    this.transfers.clear();
    this.setState('retrying');
    setTimeout(() => {
      this.bulkNow = new FakeBulk(this);
      this.setState('open');
    }, ms);
  }

  link(): DeskLink {
    return {
      deskId: 'd-fake',
      available: true,
      status: () => this.state,
      onStatus: (fn: (s: LinkState) => void) => {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },
      bulk: () => (this.state === 'open' ? this.bulkNow : null),
      call: (m: string, p: Record<string, unknown> = {}) => this.call(m, p),
    } as unknown as DeskLink;
  }

  private parts(): string[] {
    return [...new Set(this.entries.map((e) => e.part))];
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await Promise.resolve();
    if (this.state !== 'open') throw new DeskNotConnected('d-fake', false);
    const part = String(params['part'] ?? '');
    switch (method) {
      case 'data.parts.list':
        if (this.noHelper) throw refused('unavailable', { reason: 'helper' });
        return {
          parts: this.parts().map((p) => {
            const files = this.entries.filter((e) => e.part === p && (e.type ?? 'file') === 'file');
            return { part: p, label: p, files: files.length, bytes: files.reduce((s, e) => s + (e.bytes?.length ?? 0), 0) };
          }),
        };
      case 'data.manifest': {
        const all = this.entries.filter((e) => e.part === part);
        const from = typeof params['cursor'] === 'string' ? all.findIndex((e) => e.path === params['cursor']) + 1 : 0;
        const page = all.slice(from, from + this.pageSize);
        const entries: DataEntry[] = page.map((e) => ({ path: e.path, type: e.type ?? 'file', size: e.bytes?.length ?? 0, mtimeMs: Date.UTC(2026, 10, 5), mode: 0o600, ...(e.target ? { target: e.target } : {}) }));
        return { entries, next: from + page.length < all.length ? (page[page.length - 1]?.path ?? null) : null };
      }
      case 'data.read': {
        const path = String(params['path']);
        const refusal = this.refuseRead.get(path);
        if (refusal) throw refused(refusal);
        const e = this.entries.find((x) => x.part === part && x.path === path);
        if (!e) throw refused('not_found');
        if ((e.type ?? 'file') !== 'file' || !e.bytes) throw refused('invalid');
        const offset = Number(params['offset']) || 0;
        this.reads.push({ path, offset });
        const hashed = e.shrinkTo === undefined ? e.bytes : e.bytes.subarray(0, e.shrinkTo);
        let out = hashed.slice(Math.min(offset, hashed.length));
        if ((this.changeNext.delete(path) || this.changeAlways.has(path)) && out.length) {
          out = out.slice();
          out[out.length >> 1] = (out[out.length >> 1]! + 1) & 0xff;
        }
        const t: Transfer = { id: this.nextId++, entry: e, out, hashed, offsetBase: offset, at: 0, granted: 1024 * 1024, seq: 0, bulk: this.bulkNow, scheduled: false };
        this.transfers.set(t.id, t);
        this.maxActive = Math.max(this.maxActive, this.transfers.size);
        if (this.chunkFirst) {
          this.chunkFirst = false;
          this.send(t, 1);
        }
        this.schedule(t);
        return { transferId: t.id, size: e.bytes.length, mtimeMs: Date.UTC(2026, 10, 5) };
      }
      case 'data.read.stop':
        this.stops.push(Number(params['transferId']));
        this.transfers.delete(Number(params['transferId']));
        return {};
      default:
        throw refused('not_found');
    }
  }

  schedule(t: Transfer): void {
    if (t.scheduled) return;
    t.scheduled = true;
    setTimeout(() => {
      t.scheduled = false;
      this.send(t, this.perTick);
    }, 0);
  }

  private send(t: Transfer, n: number): void {
    if (t.bulk.closed || this.transfers.get(t.id) !== t) return;
    for (let i = 0; i < n && t.at < t.out.length && t.at < t.granted; i += 1) {
      const end = Math.min(t.at + this.chunkSize, t.out.length, t.granted);
      if (this.loseOne === t.entry.path && t.at > 0) {
        this.loseOne = null;
        t.seq += 1; // a frame that never arrived
      } else {
        t.bulk.onChunk?.(t.id, t.seq++, false, t.out.slice(t.at, end));
      }
      t.at = end;
      const drop = this.dropAfter;
      if (drop && drop.path === t.entry.path && t.offsetBase + t.at >= drop.bytes) {
        this.dropAfter = null;
        this.drop(drop.reconnectMs);
        return;
      }
    }
    if (t.at >= t.out.length) {
      this.transfers.delete(t.id);
      const trailer = new Uint8Array(40);
      trailer.set(createHash('sha256').update(t.hashed).digest());
      new DataView(trailer.buffer).setBigUint64(32, BigInt(t.hashed.length));
      t.bulk.onChunk?.(t.id, t.seq++, true, trailer);
      return;
    }
    if (t.at < t.granted) this.schedule(t);
  }
}

/** The archive in memory, cut back as a real file is. */
export class MemorySink implements Sink {
  private buf = new Uint8Array(1024 * 1024);
  length = 0;
  writes = 0;
  async write(bytes: Uint8Array): Promise<void> {
    this.writes += 1;
    if (this.length + bytes.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + bytes.length));
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }
  async truncate(size: number): Promise<void> {
    this.length = Math.min(this.length, size);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/**
 * A real file. With `skip`, writes of that very buffer leave a hole instead, for a sparse multi-GiB archive. With
 * `keep`, an existing file is opened as it is, as a reload finds the archive it was writing.
 */
export class FileSink implements Sink {
  readonly path: string;
  private readonly fd: number;
  private pos = 0;
  constructor(path: string, private readonly skip?: Uint8Array, keep = false) {
    this.path = path;
    this.fd = openSync(path, keep ? 'r+' : 'w+');
    if (keep) this.pos = fstatSync(this.fd).size;
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (bytes !== this.skip) writeSync(this.fd, bytes, 0, bytes.length, this.pos);
    this.pos += bytes.length;
  }
  async truncate(size: number): Promise<void> {
    ftruncateSync(this.fd, size);
    this.pos = size;
  }
  close(): void {
    ftruncateSync(this.fd, this.pos);
    closeSync(this.fd);
  }
}

export const scratchDir = (): string => mkdtempSync(join(tmpdir(), 'ma-export-test-'));

export interface Unzipped {
  bad: string | null;
  entries: { name: string; size: number; flag: number; crc: number; dir: boolean; mode: number; offset: number; sha256?: string }[];
}

const INSPECT = `
import sys, zipfile, json, hashlib
z = zipfile.ZipFile(sys.argv[1])
out = {"bad": z.testzip(), "entries": []}
for i in z.infolist():
    e = {"name": i.filename, "size": i.file_size, "flag": i.flag_bits, "crc": i.CRC, "dir": i.is_dir(), "mode": i.external_attr >> 16, "offset": i.header_offset}
    if not i.is_dir() and i.file_size < 64 * 1024 * 1024:
        e["sha256"] = hashlib.sha256(z.read(i)).hexdigest()
    out["entries"].append(e)
print(json.dumps(out))
`;

/** Python's own zipfile reads it back, CRC-checking every member. */
export function pythonUnzip(path: string): Unzipped {
  return JSON.parse(execFileSync('python3', ['-I', '-c', INSPECT, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Unzipped;
}

/** `python3 -m zipfile -t` and Info-ZIP's `unzip -t`, as a member's computer would open it. Throws if either complains. */
export function realUnzipTest(path: string): { python: string; unzip: string } {
  const python = execFileSync('python3', ['-I', '-m', 'zipfile', '-t', path], { encoding: 'utf8' });
  if (!python.includes('Done testing') || python.includes('corrupted')) throw new Error(`python zipfile -t: ${python}`);
  const unzip = execFileSync('unzip', ['-tq', path], { encoding: 'utf8' });
  return { python, unzip };
}

/** Positional storage in memory, for the sealed working copy: a test can read every byte it was handed. */
export class MemoryBlocks implements Blocks {
  buf = new Uint8Array(0);
  flushes = 0;
  size(): number {
    return this.buf.length;
  }
  async writeAt(at: number, bytes: Uint8Array): Promise<void> {
    if (at + bytes.length > this.buf.length) {
      const next = new Uint8Array(at + bytes.length);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf.set(bytes, at);
  }
  async read(at: number, len: number): Promise<Uint8Array> {
    return this.buf.slice(at, at + len);
  }
  async truncate(size: number): Promise<void> {
    this.buf = this.buf.slice(0, Math.min(size, this.buf.length));
  }
  async flush(): Promise<void> {
    this.flushes += 1;
  }
}

/** Whether `needle` appears anywhere in `hay`, as bytes. */
export const contains = (hay: Uint8Array, needle: string): boolean => Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).includes(Buffer.from(needle, 'utf8'));
