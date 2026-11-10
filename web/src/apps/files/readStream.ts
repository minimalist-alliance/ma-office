// One `files.read` as a stream of byte pieces in order (files.md section 4). CHUNKs can overtake the reply that names their
// transfer, so the listener is on before the call and holds what comes early. Credit is given back only as the caller says it
// has written, so a slow disk slows its own transfer and nothing piles up. It ends with the desk's trailer (SHA-256 of the
// whole file from byte 0, then its size), which the caller checks against the hash it kept. A dropped session ends it with
// `SessionLost` and the caller carries on from the byte it reached: `files.read` takes an `offset`.
import type { BulkChannel, DeskLink } from '../../desk/deskLink';
import { CreditWindow, parseTrailer, type Trailer } from '../../export/credit';
import { toFilesError, type FilesApi } from './api';
import { hubOf } from './hub';

export class SessionLost extends Error {
  constructor() {
    super('the session went');
    this.name = 'SessionLost';
  }
}
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}
export class ReadStalled extends Error {
  constructor() {
    super('nothing arrived');
    this.name = 'ReadStalled';
  }
}
export class ReadBroken extends Error {
  constructor(readonly why: 'seq' | 'trailer') {
    super(`the read broke: ${why}`);
    this.name = 'ReadBroken';
  }
}

/** No piece for this long, with credit to spare, and the desk is taken to have stopped. */
export const STALL_MS = 60_000;
const ORPHAN_LIMIT = 4 * 1024 * 1024;

export interface Piece {
  bytes: Uint8Array;
  /** The offset of the byte after it, from byte 0 of the file. */
  to: number;
}

export class ReadStream {
  size = 0;
  mtimeMs = 0;
  trailer: Trailer | null = null;
  private id = -1;
  private seq = 0;
  private at: number;
  private queue: Piece[] = [];
  private early = new Map<number, { seq: number; end: boolean; payload: Uint8Array }[]>();
  private earlyBytes = 0;
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;
  private credit!: CreditWindow;
  private off: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly api: FilesApi,
    private readonly link: DeskLink,
    private readonly bulk: BulkChannel,
    private readonly path: string,
    private readonly from: number,
    private readonly stallMs = STALL_MS,
  ) {
    this.at = from;
  }

  async open(): Promise<void> {
    this.off = hubOf(this.bulk).listenChunks((id, seq, end, payload) => this.onChunk(id, seq, end, payload));
    this.offStatus = this.link.onStatus((s) => {
      if (s !== 'open' || this.link.bulk() !== this.bulk) this.fail(new SessionLost());
    });
    try {
      const r = await this.api.readStart(this.path, this.from);
      if (this.link.bulk() !== this.bulk) {
        this.close();
        throw new SessionLost();
      }
      this.id = r.transferId;
      this.size = r.size;
      this.mtimeMs = r.mtimeMs;
      this.credit = new CreditWindow(this.from);
      const early = this.early.get(this.id) ?? [];
      this.early.clear();
      this.earlyBytes = 0;
      for (const c of early) this.onChunk(this.id, c.seq, c.end, c.payload);
    } catch (err) {
      this.close();
      throw err instanceof SessionLost ? err : toFilesError(err);
    }
  }

  /** The next piece in order, or null after the last. Throws `SessionLost`, `ReadStalled`, `ReadBroken`. */
  async next(): Promise<Piece | null> {
    for (;;) {
      const piece = this.queue.shift();
      if (piece) return piece;
      if (this.error) throw this.error;
      if (this.ended) return null;
      await this.waitForChunk();
    }
  }

  /** Everything before `pos` is written: gives the desk more credit. */
  written(pos: number): void {
    if (this.closed || this.id < 0) return;
    const more = this.credit.writtenTo(pos);
    if (more) this.bulk.credit(this.id, more);
  }

  /** The member cancelled: ends the read at once, and tells the desk. */
  cancel(): void {
    this.fail(new Cancelled());
    this.close(true);
  }

  close(stop = false): void {
    if (this.closed) return;
    this.closed = true;
    this.off?.();
    this.offStatus?.();
    if (stop && this.id >= 0 && !this.ended) void this.api.readStop(this.id);
  }

  private fail(err: Error): void {
    if (this.error || this.closed) return;
    this.error = err;
    this.wake?.();
  }

  private waitForChunk(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.wake = null;
        // Waiting on us for credit is not the desk stalling: a piece is in the queue then, never here.
        reject(new ReadStalled());
      }, this.stallMs);
      this.wake = () => {
        window.clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private onChunk(id: number, seq: number, end: boolean, payload: Uint8Array): void {
    if (this.closed) return;
    if (this.id < 0) {
      // Before the reply: keep it for when we know whose it is.
      if (this.earlyBytes + payload.length > ORPHAN_LIMIT) return;
      const list = this.early.get(id) ?? [];
      list.push({ seq, end, payload: payload.slice() });
      this.early.set(id, list);
      this.earlyBytes += payload.length;
      return;
    }
    if (id !== this.id) return;
    if (seq !== this.seq) return this.fail(new ReadBroken('seq'));
    this.seq += 1;
    if (end) {
      this.trailer = parseTrailer(payload);
      this.ended = true;
    } else if (payload.length) {
      this.at += payload.length;
      this.queue.push({ bytes: payload.slice(), to: this.at });
    }
    this.wake?.();
  }
}
