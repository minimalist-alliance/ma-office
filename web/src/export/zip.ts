// A small streaming ZIP writer (draft ADR "data export and transfer", decision 2): STORED entries only, a data
// descriptor after each file, CRC-32, ZIP64 when anything passes 4 GiB, UTF-8 names (flag bit 11). It writes to a
// `Sink` in order, so a member's file grows as the desk's bytes arrive, and nothing is held but the entry being
// written. STORED is what makes a file that stopped halfway resumable: the bytes so far are the file's bytes, and the
// CRC is a running number.
import { crc32 } from './crc32';

/** Where the archive goes: the member's own file, the browser's private storage, or memory in a test. */
export interface Sink {
  /** Appends at the end. The bytes may be reused once it resolves. */
  write(bytes: Uint8Array): Promise<void>;
  /** Cuts the file back to `size` bytes. The next write lands there. */
  truncate(size: number): Promise<void>;
}

export interface EntryOptions {
  mtimeMs?: number;
  /** Unix permission bits. Read and write for the owner are always added, so nothing comes out unreadable. */
  mode?: number;
  /** What the file is expected to be. ZIP64 is decided here, as the local header goes first. */
  sizeHint?: number;
}

export interface ZipOptions {
  /** ZIP64 records for every entry and the end, however small. For tests of the ZIP64 path. */
  forceZip64?: boolean;
  /** Bytes gathered before each write to the sink. */
  bufferBytes?: number;
}

interface Record_ {
  name: Uint8Array;
  text: string;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  zip64: boolean;
  dir: boolean;
  mode: number;
}

/** A finished entry, as a journal keeps it to write the central directory after a reload. */
export interface EntryRecord {
  name: string;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
  zip64: boolean;
  dir: boolean;
  mode: number;
}

/** The entry being written, with what's in the sink of it so far. */
export interface OpenEntry extends EntryRecord {
  /** Where its local header starts. */
  start: number;
}

/** Everything up to `pos` is in the sink: these entries, and as much of `open` as its `size` says. */
export interface Checkpoint {
  pos: number;
  /** Entries finished since the last checkpoint. */
  records: EntryRecord[];
  open: OpenEntry | null;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** Past this, an entry is ZIP64 from its local header on. A little under 4 GiB, for headers and a file that grows. */
const ZIP64_AT = MAX32 - 0x100000;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const MADE_BY = (3 << 8) | 63; // Unix, spec 6.3: external attributes hold the mode
const utf8 = new TextEncoder();

const plain = (r: Record_): EntryRecord => ({ name: r.text, crc: r.crc, size: r.size, offset: r.offset, time: r.time, date: r.date, zip64: r.zip64, dir: r.dir, mode: r.mode });

function dosTime(ms: number | undefined): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) ? (ms as number) : Date.now());
  const y = d.getFullYear();
  if (y < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (y > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Little-endian fields into one buffer. */
class Fields {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(v: number): this {
    this.view.setBigUint64(this.at, BigInt(v), true);
    this.at += 8;
    return this;
  }
  raw(b: Uint8Array): this {
    this.bytes.set(b, this.at);
    this.at += b.length;
    return this;
  }
}

export class ZipWriter {
  private readonly sink: Sink;
  private readonly forceZip64: boolean;
  private readonly bufferBytes: number;
  private buf: Uint8Array;
  private bufLen = 0;
  /** Bytes the sink has. */
  private flushed = 0;
  /** Bytes handed to the sink and not yet written. */
  private writing = 0;
  /** A write that failed: the sink no longer holds what this writer thinks, so nothing more is written. */
  private failed: { err: unknown } | null = null;
  private readonly records: Record_[] = [];
  private cur: { rec: Record_; start: number; crc: number; size: number } | null = null;
  private done = false;
  /** How many of `records` the last checkpoint gave out. */
  private given = 0;

  constructor(sink: Sink, options: ZipOptions = {}) {
    this.sink = sink;
    this.forceZip64 = options.forceZip64 ?? false;
    this.bufferBytes = options.bufferBytes ?? 256 * 1024;
    this.buf = new Uint8Array(this.bufferBytes);
  }

  /**
   * Carries on an archive a checkpoint describes, in a sink holding at least `pos` bytes of it: cuts it back to `pos`,
   * then takes `records` as written and `open` as the entry being written, `size` bytes in.
   */
  static async resume(sink: Sink, all: { pos: number; records: readonly EntryRecord[]; open: OpenEntry | null }, options: ZipOptions = {}): Promise<ZipWriter> {
    const z = new ZipWriter(sink, options);
    await sink.truncate(all.pos);
    z.flushed = all.pos;
    for (const r of all.records) z.records.push({ ...r, name: utf8.encode(r.name), text: r.name });
    z.given = z.records.length;
    if (all.open) {
      const { start, ...r } = all.open;
      z.cur = { rec: { ...r, name: utf8.encode(r.name), text: r.name }, start, crc: r.crc, size: r.size };
    }
    return z;
  }

  /** Puts everything so far in the sink, and says what that is. */
  async checkpoint(): Promise<Checkpoint> {
    await this.flush();
    const records = this.records.slice(this.given).map(plain);
    this.given = this.records.length;
    const c = this.cur;
    return { pos: this.position, records, open: c ? { ...plain(c.rec), crc: c.crc, size: c.size, start: c.start } : null };
  }

  /** Where the next byte goes: the archive's length so far. */
  get position(): number {
    return this.flushed + this.writing + this.bufLen;
  }

  /** The entry being written, if any. */
  get openName(): string | null {
    return this.cur?.rec.text ?? null;
  }

  /** The sink's error, once a write or a cut has failed. */
  get failure(): { err: unknown } | null {
    return this.failed;
  }

  /** Entries finished so far. */
  get count(): number {
    return this.records.length;
  }

  /** Starts a file. Its bytes follow through `data`, and `end` closes it. */
  async begin(name: string, options: EntryOptions = {}): Promise<void> {
    this.throwIfFailed();
    if (this.cur || this.done) throw new Error('the previous entry is still open');
    const offset = this.position;
    const zip64 = this.forceZip64 || (options.sizeHint ?? 0) >= ZIP64_AT || offset >= ZIP64_AT;
    const rec: Record_ = { name: utf8.encode(name), text: name, crc: 0, size: 0, offset, ...dosTime(options.mtimeMs), zip64, dir: false, mode: ((options.mode ?? 0o644) & 0o777) | 0o600 };
    this.cur = { rec, start: offset, crc: 0, size: 0 };
    await this.put(this.localHeader(rec, FLAG_DESCRIPTOR | FLAG_UTF8));
  }

  async data(bytes: Uint8Array): Promise<void> {
    const cur = this.cur;
    if (!cur) throw new Error('no entry is open');
    cur.crc = crc32(cur.crc, bytes);
    cur.size += bytes.length;
    await this.put(bytes);
  }

  /** Closes the file with its data descriptor. */
  async end(): Promise<{ crc: number; size: number }> {
    const cur = this.cur;
    if (!cur) throw new Error('no entry is open');
    const { rec } = cur;
    rec.crc = cur.crc;
    rec.size = cur.size;
    if (!rec.zip64 && rec.size > MAX32) throw new Error('an entry passed 4 GiB without ZIP64'); // sizeHint was too low
    const d = rec.zip64 ? new Fields(24).u32(0x08074b50).u32(rec.crc).u64(rec.size).u64(rec.size) : new Fields(16).u32(0x08074b50).u32(rec.crc).u32(rec.size).u32(rec.size);
    await this.put(d.bytes);
    this.records.push(rec);
    this.cur = null;
    return { crc: rec.crc, size: rec.size };
  }

  /** Drops the open entry, header and all, as if it had never begun: to read a file again from its start. */
  async rewind(): Promise<void> {
    this.throwIfFailed();
    const cur = this.cur;
    if (!cur) return;
    this.cur = null;
    if (cur.start >= this.flushed) {
      this.bufLen = cur.start - this.flushed;
      return;
    }
    this.bufLen = 0;
    this.buf = new Uint8Array(this.bufferBytes);
    await this.landed(this.sink.truncate(cur.start));
    this.flushed = cur.start;
  }

  /** A whole file that's already in memory. */
  async add(name: string, bytes: Uint8Array, options: EntryOptions = {}): Promise<{ crc: number; size: number }> {
    await this.begin(name, { ...options, sizeHint: bytes.length });
    await this.data(bytes);
    return this.end();
  }

  /** A directory, so an empty one comes out too. `name` ends with `/`. */
  async addDir(name: string, options: EntryOptions = {}): Promise<void> {
    this.throwIfFailed();
    if (this.cur || this.done) throw new Error('the previous entry is still open');
    const offset = this.position;
    const dirName = name.endsWith('/') ? name : `${name}/`;
    const rec: Record_ = {
      name: utf8.encode(dirName),
      text: dirName,
      crc: 0,
      size: 0,
      offset,
      ...dosTime(options.mtimeMs),
      zip64: this.forceZip64 || offset >= ZIP64_AT,
      dir: true,
      mode: ((options.mode ?? 0o755) & 0o777) | 0o700,
    };
    await this.put(this.localHeader(rec, FLAG_UTF8));
    this.records.push(rec);
  }

  /**
   * The central directory and the end records. `order` sorts the directory, which is the order an unzip lists
   * things in, whatever order the entries went in. Returns the archive's length.
   */
  async finish(order?: (a: string, b: string) => number): Promise<number> {
    this.throwIfFailed();
    if (this.cur) throw new Error('an entry is still open');
    this.done = true;
    const recs = order ? [...this.records].sort((a, b) => order(a.text, b.text)) : this.records;
    const cdStart = this.position;
    for (const r of recs) await this.put(this.centralHeader(r));
    const cdSize = this.position - cdStart;
    const n = recs.length;
    const zip64 = this.forceZip64 || n >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const at = this.position;
      await this.put(new Fields(56).u32(0x06064b50).u64(44).u16((3 << 8) | 45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdStart).bytes);
      await this.put(new Fields(20).u32(0x07064b50).u32(0).u64(at).u32(1).bytes);
    }
    const e = new Fields(22).u32(0x06054b50).u16(0).u16(0);
    if (zip64) e.u16(MAX16).u16(MAX16).u32(MAX32).u32(MAX32);
    else e.u16(n).u16(n).u32(cdSize).u32(cdStart);
    await this.put(e.u16(0).bytes);
    await this.flush();
    return this.flushed;
  }

  private localHeader(r: Record_, flags: number): Uint8Array {
    const extra = r.zip64 && !r.dir ? new Fields(20).u16(0x0001).u16(16).u64(0).u64(0).bytes : new Uint8Array(0);
    const sizes = r.zip64 && !r.dir ? MAX32 : 0;
    return new Fields(30 + r.name.length + extra.length)
      .u32(0x04034b50)
      .u16(r.zip64 ? 45 : 20)
      .u16(flags)
      .u16(0) // STORED
      .u16(r.time)
      .u16(r.date)
      .u32(0)
      .u32(sizes)
      .u32(sizes)
      .u16(r.name.length)
      .u16(extra.length)
      .raw(r.name)
      .raw(extra).bytes;
  }

  private centralHeader(r: Record_): Uint8Array {
    const bigSize = r.zip64 && !r.dir;
    const bigOffset = r.zip64 || r.offset >= MAX32;
    const extraLen = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
    const extra = new Fields(extraLen ? 4 + extraLen : 0);
    if (extraLen) {
      extra.u16(0x0001).u16(extraLen);
      if (bigSize) extra.u64(r.size).u64(r.size);
      if (bigOffset) extra.u64(r.offset);
    }
    const type = r.dir ? 0o040000 : 0o100000;
    const external = (((type | r.mode) << 16) >>> 0) | (r.dir ? 0x10 : 0);
    return new Fields(46 + r.name.length + extra.bytes.length)
      .u32(0x02014b50)
      .u16(MADE_BY)
      .u16(r.zip64 ? 45 : 20)
      .u16(r.dir ? FLAG_UTF8 : FLAG_DESCRIPTOR | FLAG_UTF8)
      .u16(0)
      .u16(r.time)
      .u16(r.date)
      .u32(r.crc)
      .u32(bigSize ? MAX32 : r.size)
      .u32(bigSize ? MAX32 : r.size)
      .u16(r.name.length)
      .u16(extra.bytes.length)
      .u16(0) // comment
      .u16(0) // disk
      .u16(0) // internal attributes
      .u32(external)
      .u32(bigOffset ? MAX32 : r.offset)
      .raw(r.name)
      .raw(extra.bytes).bytes;
  }

  private async put(bytes: Uint8Array): Promise<void> {
    this.throwIfFailed();
    if (bytes.length >= this.bufferBytes) {
      await this.flush();
      await this.write(bytes);
      return;
    }
    if (this.bufLen + bytes.length > this.bufferBytes) await this.flush();
    this.buf.set(bytes, this.bufLen);
    this.bufLen += bytes.length;
  }

  /** Hands what's gathered to the sink. `position` stays right while the write is on its way. */
  async flush(): Promise<void> {
    this.throwIfFailed();
    if (!this.bufLen) return;
    const out = this.buf.subarray(0, this.bufLen);
    this.buf = new Uint8Array(this.bufferBytes); // the sink may still be reading the old one
    this.bufLen = 0;
    await this.write(out);
  }

  /** `flushed` moves on only once the sink has the bytes. */
  private async write(bytes: Uint8Array): Promise<void> {
    this.writing += bytes.length;
    try {
      await this.landed(this.sink.write(bytes));
      this.flushed += bytes.length;
    } finally {
      this.writing -= bytes.length;
    }
  }

  /** A sink that failed once may hold part of a write: everything after it would be a broken archive. */
  private async landed(op: Promise<void>): Promise<void> {
    try {
      await op;
    } catch (err) {
      this.failed ??= { err };
      throw err;
    }
  }

  private throwIfFailed(): void {
    if (this.failed) throw this.failed.err;
  }
}
