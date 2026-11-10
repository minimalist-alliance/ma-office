// One desk's files into the archive, over that desk's own session (draft ADR "data export and transfer", sections 4
// and 7): `data.parts.list`, every page of `data.manifest`, then `data.read` for each file, several at once, with the
// bytes arriving on `bulk`. The archive is written in order, so only the file at the head of the queue goes to it as it
// arrives; the few after it fill their first window in memory and wait, which is what makes many small files quick.
//
// A dropped session is carried over: each file goes on from the byte it had reached, with its SHA-256 and the
// archive's CRC where they were, and the desk checks the whole file end to end in its trailer.
import { DeskNotConnected, type BulkChannel, type DataPart, type DeskLink, type DeskRpc } from '../desk/deskLink';
import { partLabel, safePath, type ManifestDesk, type ManifestFile } from './archive';
import { CreditWindow, parseTrailer, trailerMatches, type Trailer } from './credit';
import { Sha256, toHex, type Sha256State } from './sha256';
import type { ZipWriter } from './zip';

/** Files read at once. deskd allows 8 a session, and each waiting one holds at most its first MiB. */
export const MAX_IN_FLIGHT = 6;
/** A transfer that has credit and sends nothing for this long is asked again from where it stopped. */
export const STALL_MS = 45_000;
/** A link that has given up (stopped, refused) for this long means the desk has gone. */
export const GONE_MS = 20_000;
const MAX_MISMATCHES = 3;
const MAX_ERRORS = 5;
const MAX_BUSY = 30;
const ORPHAN_BYTES = 8 * 1024 * 1024;
const ORPHAN_MS = 60_000;
const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type DeskCopyPhase = 'connecting' | 'listing' | 'copying' | 'reconnecting';

export interface DeskCopyProgress {
  phase: DeskCopyPhase;
  files: number;
  /** Copied or given up on. */
  filesDone: number;
  bytes: number;
  bytesDone: number;
}

export interface DeskCopyResult {
  files: ManifestFile[];
  links: { path: string; target: string }[];
  notCopied: { path: string; reason: string }[];
  parts: ManifestDesk['parts'];
}

/** The file a reload interrupted: its name in the archive, how much of it is there, and the hash of that much. */
export interface ResumeOpen {
  name: string;
  size: number;
  sha: Sha256State;
}

export interface DeskCopyOptions {
  /** Entries already in the archive from before a reload, by name, with their sizes: listed, counted, not read again. */
  skip?: ReadonlyMap<string, number>;
  /** The entry the archive has open from before a reload, if it's this desk's. */
  open?: ResumeOpen | null;
  /** Called every couple of seconds between writes, for a journal. */
  checkpoint?: () => Promise<void>;
  /** Filled in as files finish: name to SHA-256, for the journal. */
  finished?: Map<string, string>;
  /** How often `checkpoint` is called. */
  checkpointMs?: number;
}

/** The file at the head of the queue, as far as it's in the archive. */
export interface HeadState extends ResumeOpen {
  part: string;
  path: string;
}

export const CHECKPOINT_MS = 2000;

/** The desk can't give its files: no helper yet, the scope, the desk went away, or Platform wouldn't open it. */
export class DeskUnavailable extends Error {
  readonly reason: 'helper' | 'forbidden' | 'gone' | 'refused';
  constructor(reason: 'helper' | 'forbidden' | 'gone' | 'refused') {
    super(`desk unavailable: ${reason}`);
    this.name = 'DeskUnavailable';
    this.reason = reason;
  }
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

interface DirJob {
  kind: 'dir';
  name: string;
  mtimeMs: number | undefined;
  mode: number | undefined;
}

interface FileJob {
  kind: 'file';
  part: string;
  /** On the desk, as the manifest gave it. */
  path: string;
  /** In the archive. */
  name: string;
  mtimeMs: number | undefined;
  mode: number | undefined;
  /** The manifest's size: on disk, so only a hint for a SQLite file. */
  hint: number;
  state: 'queued' | 'starting' | 'reading' | 'ended' | 'skipped';
  /** Each `data.read` gets a new one, so a late answer to an old one is known for what it is. */
  token: number;
  /** Over what's in the archive (`written`), so it can be kept across a reload. */
  sha: Sha256 | null;
  /** Bytes from 0 that have arrived, in order. */
  received: number;
  /** Arrived and not yet in the archive. */
  pending: Uint8Array[];
  /** Bytes from 0 in the archive. */
  written: number;
  begun: boolean;
  /** `data.read`'s size: what the desk will send, counting from 0. */
  size: number | null;
  id: number;
  bulk: BulkChannel | null;
  seq: number;
  credit: CreditWindow | null;
  trailer: Trailer | null;
  digest: Uint8Array | null;
  heard: number;
  mismatches: number;
  errors: number;
  busy: number;
  retryAt: number;
}

type Job = DirJob | FileJob;

const codeOf = (err: unknown): string => (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '');
const reasonOf = (err: unknown): string => {
  const d = err && typeof err === 'object' ? (err as { details?: unknown }).details : null;
  return d && typeof d === 'object' && typeof (d as { reason?: unknown }).reason === 'string' ? (d as { reason: string }).reason : '';
};
const backoff = (n: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, n - 1));
/** Worth asking again: the desk was busy or slow, not saying no. */
const PASSING = new Set(['deadline_exceeded', 'rate_limited', 'too_many', 'cancelled', 'internal', 'unavailable']);

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export class DeskCopy {
  private readonly link: DeskLink;
  private readonly zip: ZipWriter;
  private readonly root: string;
  private readonly onProgress: (p: DeskCopyProgress) => void;
  private readonly signal: AbortSignal;
  private readonly clock: Clock;
  private readonly options: DeskCopyOptions;

  private jobs: Job[] = [];
  private head = 0;
  private listed: DataPart[] | null = null;
  private lastCheckpoint = 0;
  private readonly files: ManifestFile[] = [];
  private readonly links: { path: string; target: string }[] = [];
  private readonly notCopied: { path: string; reason: string }[] = [];
  private parts: ManifestDesk['parts'] = [];

  private phase: DeskCopyPhase = 'connecting';
  /** `data.parts.list`'s, from a walk without hashing, until the manifest has the real numbers. */
  private estimate = { files: 0, bytes: 0 };
  /** The archive's open entry from before a reload isn't on the desk any more. */
  private dropOpen = false;
  private fileCount = 0;
  private filesDone = 0;
  private bytes = 0;
  private bytesDone = 0;

  private attached: BulkChannel | null = null;
  private readonly byId = new Map<number, FileJob>();
  private readonly stopped = new Set<number>();
  private readonly orphans = new Map<number, { at: number; chunks: { seq: number; end: boolean; payload: Uint8Array }[] }>();
  private orphanBytes = 0;
  private readonly nudges = new Set<() => void>();
  private gone: DeskUnavailable | null = null;
  private goneTimer = 0;
  private tickTimer = 0;
  private wakeAt = 0;
  private wakeTimer = 0;

  constructor(link: DeskLink, zip: ZipWriter, root: string, onProgress: (p: DeskCopyProgress) => void, signal: AbortSignal, clock: Clock = realClock, options: DeskCopyOptions = {}) {
    this.link = link;
    this.zip = zip;
    this.root = root.endsWith('/') ? root : `${root}/`;
    this.onProgress = onProgress;
    this.signal = signal;
    this.clock = clock;
    this.options = options;
  }

  /** The head file as far as it's in the archive, for a journal: null unless the archive has it open. */
  headState(): HeadState | null {
    const j = this.jobs[this.head];
    if (!j || j.kind !== 'file' || !j.begun || !j.sha) return null;
    return { name: j.name, part: j.part, path: j.path, size: j.written, sha: j.sha.save() };
  }

  /** What's in the archive so far, for a desk that stopped partway. */
  partial(): DeskCopyResult {
    return { files: this.files, links: this.links, notCopied: this.notCopied, parts: this.parts };
  }

  /** `data.parts.list`, for the download's total before anything is copied. Its numbers are an estimate. */
  async survey(): Promise<{ files: number; bytes: number }> {
    await this.watching(() => this.listParts());
    return { ...this.estimate };
  }

  async run(): Promise<DeskCopyResult> {
    return this.watching(async () => {
      if (!this.listed) await this.listParts();
      this.phase = 'listing';
      this.report();
      this.pushDir(this.root, undefined, undefined);
      for (const p of this.listed ?? []) await this.listPart(p.part, p.label);
      this.placeOpen();
      this.phase = 'copying';
      this.report();
      await this.pump();
      return { files: this.files, links: this.links, notCopied: this.notCopied, parts: this.parts };
    }, true);
  }

  private async listParts(): Promise<void> {
    this.report();
    const listed = await this.ask('data.parts.list', {}, 120_000);
    this.listed = Array.isArray(listed?.parts) ? listed.parts : [];
    this.estimate = { files: 0, bytes: 0 };
    for (const p of this.listed) {
      this.estimate.files += Number(p.files) || 0;
      this.estimate.bytes += Number(p.bytes) || 0;
    }
  }

  /** Listens to the link while `fn` runs, and lets go of everything after, however it ends. */
  private async watching<T>(fn: () => Promise<T>, copying = false): Promise<T> {
    const offStatus = this.link.onStatus(() => this.onLink());
    const onAbort = (): void => this.kick();
    this.signal.addEventListener('abort', onAbort);
    this.onLink();
    this.tick();
    try {
      return await fn();
    } finally {
      offStatus();
      this.signal.removeEventListener('abort', onAbort);
      this.clock.clearTimeout(this.goneTimer);
      this.goneTimer = 0;
      this.clock.clearTimeout(this.tickTimer);
      this.clock.clearTimeout(this.wakeTimer);
      for (const id of this.byId.keys()) this.stopTransfer(id);
      this.byId.clear();
      if (this.attached) this.attached.onChunk = null;
      this.attached = null;
      // A file left open by a failure doesn't belong to the next desk. A cancel leaves it, for a journal to carry on.
      if (copying && !this.signal.aborted) await this.zip.rewind();
    }
  }

  /**
   * The file the archive has open from before a reload goes first, as nothing else can begin until it's closed. If the
   * desk has no such file any more, the archive lets go of it.
   */
  private placeOpen(): void {
    const open = this.options.open;
    if (!open) return;
    const at = this.jobs.findIndex((j) => j.kind === 'file' && j.name === open.name);
    if (at < 0) {
      this.dropOpen = true;
      return;
    }
    const [job] = this.jobs.splice(at, 1) as [FileJob];
    job.received = job.written = open.size;
    job.sha = Sha256.restore(open.sha);
    job.begun = true;
    this.bytesDone += open.size;
    this.jobs.unshift(job);
  }

  // ----- listing

  private async listPart(part: string, label: string | undefined): Promise<void> {
    if (typeof part !== 'string' || !PART_NAME.test(part)) {
      this.notCopied.push({ path: `${this.root}${String(part)}`, reason: "Its name can't be stored safely in an archive." });
      return;
    }
    const base = `${this.root}${part}/`;
    const counts = { part, label: partLabel(part, label), files: 0, bytes: 0 };
    this.parts.push(counts);
    this.pushDir(base, undefined, undefined);
    let cursor: string | null = null;
    do {
      const page: DeskRpc['data.manifest'] = await this.ask('data.manifest', cursor === null ? { part } : { part, cursor }, 60_000);
      for (const e of Array.isArray(page?.entries) ? page.entries : []) {
        const rel = safePath(e.path);
        if (!rel) {
          this.notCopied.push({ path: `${base}${String(e.path)}`, reason: "Its name can't be stored safely in an archive." });
          continue;
        }
        const name = `${base}${rel}`;
        const mtimeMs = Number.isFinite(e.mtimeMs) ? e.mtimeMs : undefined;
        const mode = Number.isInteger(e.mode) ? e.mode : undefined;
        const done = this.options.skip?.get(e.type === 'dir' ? `${name}/` : name);
        if (done !== undefined) {
          // In the archive already, from before a reload.
          if (e.type === 'file') {
            counts.files += 1;
            counts.bytes += done;
            this.fileCount += 1;
            this.bytes += done;
            this.filesDone += 1;
            this.bytesDone += done;
          }
          continue;
        }
        if (e.type === 'dir') this.pushDir(`${name}/`, mtimeMs, mode);
        else if (e.type === 'link') this.links.push({ path: name, target: String(e.target ?? '') });
        else if (e.type === 'file') {
          const hint = Math.max(0, Number(e.size) || 0);
          this.jobs.push(newFileJob(part, e.path, name, mtimeMs, mode, hint));
          counts.files += 1;
          counts.bytes += hint;
          this.fileCount += 1;
          this.bytes += hint;
        }
      }
      cursor = typeof page?.next === 'string' ? page.next : null;
      this.report();
    } while (cursor !== null);
  }

  /** A directory entry, unless the archive has it from before a reload. */
  private pushDir(name: string, mtimeMs: number | undefined, mode: number | undefined): void {
    if (!this.options.skip?.has(name)) this.jobs.push({ kind: 'dir', name, mtimeMs, mode });
  }

  /** One RPC, asked again across a reconnect or a passing refusal. */
  private async ask<M extends keyof DeskRpc>(method: M, params: Record<string, unknown>, deadlineMs: number): Promise<DeskRpc[M]> {
    let errors = 0;
    for (;;) {
      await this.until(() => this.open() !== null);
      try {
        return await this.link.call(method, params, { deadlineMs });
      } catch (err) {
        this.throwIfOver();
        const code = codeOf(err);
        if (method === 'data.parts.list') {
          // `not_found` there is a deskd from before `data.*`: as good as no helper.
          if (code === 'not_found' || (code === 'unavailable' && reasonOf(err) === 'helper')) throw new DeskUnavailable('helper');
          if (code === 'forbidden') throw new DeskUnavailable('forbidden');
        }
        if (!(err instanceof DeskNotConnected) || this.open()) errors += 1; // a reconnect isn't the desk refusing
        if (errors >= MAX_ERRORS * 2 || !(err instanceof DeskNotConnected || PASSING.has(code))) throw err;
        await this.sleep(err instanceof DeskNotConnected ? 500 : backoff(errors));
      }
    }
  }

  // ----- the queue

  private async pump(): Promise<void> {
    if (this.dropOpen) {
      await this.zip.rewind();
      this.dropOpen = false;
    }
    let h = 0;
    while (h < this.jobs.length) {
      this.throwIfOver();
      this.head = h;
      if (this.options.checkpoint && this.clock.now() - this.lastCheckpoint >= (this.options.checkpointMs ?? CHECKPOINT_MS)) {
        this.lastCheckpoint = this.clock.now();
        await this.options.checkpoint();
      }
      this.startMore(h);
      const job = this.jobs[h]!;
      if (job.kind === 'dir') {
        await this.zip.addDir(job.name, { mtimeMs: job.mtimeMs, mode: job.mode });
        h += 1;
        continue;
      }
      if (job.state === 'skipped') {
        if (job.begun) await this.dropFromArchive(job);
        this.release(job);
        h += 1;
        continue;
      }
      if (!job.begun) {
        if (job.size === null) {
          await this.nudge();
          continue;
        }
        await this.zip.begin(job.name, { mtimeMs: job.mtimeMs, mode: job.mode, sizeHint: Math.max(job.size, job.hint) });
        job.begun = true;
      }
      const chunk = job.pending.shift();
      if (chunk) {
        await this.zip.data(chunk);
        job.sha?.update(chunk);
        job.written += chunk.length;
        this.bytesDone += chunk.length;
        // Grant after writing: the disk sets the pace.
        if (job.state === 'reading' && job.credit && job.bulk && job.bulk === this.attached) {
          const more = job.credit.writtenTo(job.written);
          if (more) job.bulk.credit(job.id, more);
        }
        this.report();
        continue;
      }
      if (job.state === 'ended') {
        job.digest ??= job.sha?.digest() ?? null;
        job.sha = null;
        // All of `data.read`'s size, too: a helper from before the next bake ends a file that shrank mid-read with a
        // trailer that matches the shorter body.
        if (job.digest && job.written === job.received && job.received === job.size && trailerMatches(job.trailer, job.digest, job.received)) {
          await this.zip.end();
          const sha256 = toHex(job.digest);
          this.files.push({ path: job.name, size: job.received, sha256 });
          this.options.finished?.set(job.name, sha256);
          this.filesDone += 1;
          this.release(job);
          h += 1;
          this.report();
        } else {
          // Not what the desk read, start to end: the file changed while it was read, or something was lost. Again from 0.
          await this.dropFromArchive(job);
          job.mismatches += 1;
          if (job.mismatches >= MAX_MISMATCHES) this.skip(job, 'It kept changing while it was being copied.');
          else this.restart(job, 0);
        }
        continue;
      }
      await this.nudge();
    }
  }

  /** Starts the next few files, up to `MAX_IN_FLIGHT` from the head, on the session that's open now. */
  private startMore(h: number): void {
    const bulk = this.open();
    if (!bulk) return;
    if (bulk !== this.attached) this.attach(bulk);
    const now = this.clock.now();
    let n = 0;
    for (let i = h; i < this.jobs.length && n < MAX_IN_FLIGHT; i += 1) {
      const j = this.jobs[i]!;
      if (j.kind !== 'file' || j.state === 'skipped') continue;
      n += 1;
      if (j.state !== 'queued') continue;
      if (now >= j.retryAt) void this.start(j, bulk);
      else this.wakeUpAt(j.retryAt);
    }
  }

  private async start(j: FileJob, bulk: BulkChannel): Promise<void> {
    const token = ++j.token;
    j.state = 'starting';
    j.sha ??= new Sha256();
    const offset = j.received;
    let r: DeskRpc['data.read'];
    try {
      r = await this.link.call('data.read', { part: j.part, path: j.path, offset }, { deadlineMs: 120_000 });
    } catch (err) {
      if (token === j.token && j.state === 'starting') this.readFailed(j, err);
      this.kick();
      return;
    }
    if (token !== j.token || j.state !== 'starting' || bulk !== this.attached) {
      // Reset meanwhile, or asked on a session that has gone, which took its transfers with it.
      if (bulk === this.attached) this.stopTransfer(r.transferId);
      if (token === j.token && j.state === 'starting') j.state = 'queued';
      this.kick();
      return;
    }
    j.size = Math.max(0, Number(r.size) || 0);
    j.id = r.transferId;
    j.bulk = bulk;
    j.seq = 0;
    j.credit = new CreditWindow(offset);
    j.heard = this.clock.now();
    j.busy = 0;
    if (j.mtimeMs === undefined && Number.isFinite(r.mtimeMs)) j.mtimeMs = r.mtimeMs;
    j.state = 'reading';
    this.byId.set(r.transferId, j);
    const early = this.orphans.get(r.transferId);
    if (early) {
      this.orphans.delete(r.transferId);
      for (const c of early.chunks) {
        this.orphanBytes -= c.payload.length;
        this.onChunk(r.transferId, c.seq, c.end, c.payload);
      }
    }
    this.kick();
  }

  private readFailed(j: FileJob, err: unknown): void {
    if (err instanceof DeskNotConnected) {
      j.state = 'queued'; // the session went: the next one asks again from the same byte
      return;
    }
    const code = codeOf(err);
    if (code === 'not_found') return this.skip(j, 'It was removed while the download ran.');
    if (code === 'invalid') return this.skip(j, "It isn't a regular file.");
    if (code === 'forbidden') return this.skip(j, "This session can't read it.");
    if (code === 'too_many' || code === 'rate_limited') {
      j.busy += 1;
      if (j.busy >= MAX_BUSY) return this.skip(j, "The desk couldn't read it.");
      j.state = 'queued';
      j.retryAt = this.clock.now() + 1000;
      return;
    }
    j.errors += 1;
    if (j.errors >= MAX_ERRORS) return this.skip(j, "The desk couldn't read it.");
    j.state = 'queued';
    j.retryAt = this.clock.now() + backoff(j.errors);
  }

  private onChunk(id: number, seq: number, end: boolean, payload: Uint8Array): void {
    const j = this.byId.get(id);
    if (!j) {
      if (!this.stopped.has(id)) this.orphan(id, seq, end, payload);
      return;
    }
    if (seq !== j.seq) {
      this.restart(j, j.received); // something in between was lost: on from what's here
      this.kick();
      return;
    }
    j.seq += 1;
    j.heard = this.clock.now();
    if (end) {
      this.byId.delete(id);
      j.trailer = parseTrailer(payload);
      j.state = 'ended';
    } else if (payload.length) {
      j.received += payload.length;
      j.pending.push(payload);
    }
    this.kick();
  }

  /** CHUNK can overtake `data.read`'s answer, as channels aren't ordered against each other. Kept until it comes. */
  private orphan(id: number, seq: number, end: boolean, payload: Uint8Array): void {
    let o = this.orphans.get(id);
    if (!o) {
      o = { at: this.clock.now(), chunks: [] };
      this.orphans.set(id, o);
    }
    o.chunks.push({ seq, end, payload });
    this.orphanBytes += payload.length;
    while (this.orphanBytes > ORPHAN_BYTES && this.orphans.size) this.dropOrphans(this.orphans.keys().next().value as number);
  }

  private dropOrphans(id: number): void {
    const o = this.orphans.get(id);
    if (!o) return;
    for (const c of o.chunks) this.orphanBytes -= c.payload.length;
    this.orphans.delete(id);
  }

  /** Read again from `from`: 0 starts the file over, anything else carries on with the state it has. */
  private restart(j: FileJob, from: number): void {
    if (j.state === 'reading' || j.state === 'starting') this.stopTransfer(j.id);
    this.byId.delete(j.id);
    j.token += 1;
    if (from === 0) {
      j.sha = new Sha256();
      j.received = 0;
      j.pending = [];
      j.written = 0;
      j.size = null;
      j.trailer = null;
      j.digest = null;
    }
    j.bulk = null;
    j.credit = null;
    j.state = 'queued';
  }

  private skip(j: FileJob, reason: string): void {
    if (j.state === 'reading') this.stopTransfer(j.id);
    this.byId.delete(j.id);
    j.token += 1;
    j.state = 'skipped';
    j.pending = [];
    this.notCopied.push({ path: j.name, reason });
    this.filesDone += 1;
    this.report();
  }

  private async dropFromArchive(j: FileJob): Promise<void> {
    await this.zip.rewind();
    j.begun = false;
    this.bytesDone -= j.written;
  }

  private release(j: FileJob): void {
    j.pending = [];
    j.sha = null;
    j.credit = null;
    j.trailer = null;
    j.bulk = null;
  }

  private stopTransfer(id: number): void {
    if (!this.attached || this.stopped.has(id)) return;
    this.stopped.add(id);
    this.link.call('data.read.stop', { transferId: id }).catch(() => {});
  }

  // ----- the session

  /** This session's `bulk` while the link is open, else null. */
  private open(): BulkChannel | null {
    return this.link.status() === 'open' ? this.link.bulk() : null;
  }

  private onLink(): void {
    const state = this.link.status();
    const bulk = this.open();
    if (bulk && bulk !== this.attached) this.attach(bulk);
    if (state === 'idle' || state === 'denied') {
      if (!this.goneTimer && !this.gone) {
        this.goneTimer = this.clock.setTimeout(() => {
          this.goneTimer = 0;
          const s = this.link.status();
          if (s === 'idle' || s === 'denied') this.gone = new DeskUnavailable(s === 'denied' ? 'refused' : 'gone');
          this.kick();
        }, GONE_MS);
      }
    } else if (this.goneTimer) {
      this.clock.clearTimeout(this.goneTimer);
      this.goneTimer = 0;
    }
    this.report();
    this.kick();
  }

  /** A new session: what was being read on the last one goes on from where it had got to. */
  private attach(bulk: BulkChannel): void {
    if (this.attached) this.attached.onChunk = null;
    this.attached = bulk;
    bulk.onChunk = (id, seq, end, payload) => this.onChunk(id, seq, end, payload);
    this.byId.clear();
    this.stopped.clear();
    this.orphans.clear();
    this.orphanBytes = 0;
    for (const j of this.jobs) {
      if (j.kind === 'file' && (j.state === 'reading' || j.state === 'starting')) {
        j.token += 1;
        j.bulk = null;
        j.credit = null;
        j.state = 'queued';
        j.retryAt = 0;
      }
    }
  }

  /** Every few seconds: a transfer that owes bytes and has gone quiet is asked again, and old orphans go. */
  private tick(): void {
    this.tickTimer = this.clock.setTimeout(() => {
      const now = this.clock.now();
      if (this.open()) {
        for (const j of [...this.byId.values()]) {
          if (j.state === 'reading' && now - j.heard > STALL_MS && j.credit && !j.credit.waitingOnUs(j.received)) this.restart(j, j.received);
        }
      }
      for (const [id, o] of [...this.orphans]) if (now - o.at > ORPHAN_MS) this.dropOrphans(id);
      this.kick();
      this.tick();
    }, 5000);
  }

  private wakeUpAt(at: number): void {
    if (this.wakeTimer && this.wakeAt <= at) return;
    this.clock.clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = 0;
      this.kick();
    }, Math.max(0, at - this.clock.now()));
  }

  private throwIfOver(): void {
    if (this.signal.aborted) throw new Cancelled();
    if (this.gone) throw this.gone;
  }

  private kick(): void {
    for (const fn of [...this.nudges]) fn();
  }

  /** Resolves at the next thing that happens: a chunk, an answer, a session, a timer. */
  private nudge(): Promise<void> {
    return new Promise((resolve) => {
      const fn = (): void => {
        this.nudges.delete(fn);
        resolve();
      };
      this.nudges.add(fn);
    });
  }

  private async until(ready: () => boolean): Promise<void> {
    while (!ready()) {
      this.throwIfOver();
      await this.nudge();
    }
    this.throwIfOver();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = this.clock.setTimeout(() => {
        this.nudges.delete(fn);
        resolve();
      }, ms);
      const fn = (): void => {
        if (!this.signal.aborted && !this.gone) return;
        this.clock.clearTimeout(id);
        this.nudges.delete(fn);
        resolve();
      };
      this.nudges.add(fn);
    });
  }

  private report(): void {
    const listed = this.phase === 'copying';
    this.onProgress({
      phase: this.phase !== 'connecting' && !this.open() ? 'reconnecting' : this.phase,
      files: listed ? this.fileCount : Math.max(this.fileCount, this.estimate.files),
      filesDone: this.filesDone,
      bytes: listed ? this.bytes : Math.max(this.bytes, this.estimate.bytes),
      bytesDone: Math.max(0, this.bytesDone),
    });
  }
}

function newFileJob(part: string, path: string, name: string, mtimeMs: number | undefined, mode: number | undefined, hint: number): FileJob {
  return {
    kind: 'file',
    part,
    path,
    name,
    mtimeMs,
    mode,
    hint,
    state: 'queued',
    token: 0,
    sha: null,
    received: 0,
    pending: [],
    written: 0,
    begun: false,
    size: null,
    id: -1,
    bulk: null,
    seq: 0,
    credit: null,
    trailer: null,
    digest: null,
    heard: 0,
    mismatches: 0,
    errors: 0,
    busy: 0,
    retryAt: 0,
  };
}
