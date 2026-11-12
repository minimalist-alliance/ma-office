// The transfers of the Files window: uploads (files and folders, images checked first), downloads (a file, or a folder as a
// ZIP made in this browser), their limits, their progress and their recovery. Pure of React: the window reads `snapshot()` and
// is told by `subscribe`. Every byte goes over the desk's own `bulk` channel; nothing of ours sees it (draft ADR decision 4).
//
// Uploads (files.md section 5): `begin` makes a partial and grants a 1 MiB window; CHUNKs go out within credit and the desk's
// CREDIT says what it has written; `finish` checks the SHA-256 and lets the file appear whole. A lost session pauses the
// transfer ("Waiting for your desk") and `status` picks it up from what the desk has, the local file's first bytes hashed
// again so the digest covers the whole file. An image is checked first (`ImageCheck`) and goes up as its ORIGINAL bytes with
// the verdict token; archives and documents are never checked.
//
// Downloads: `files.read` into the save-file picker's file, or the browser's own download; a folder is a STORED ZIP built
// here by `export/zip.ts`, fetched file by file in a breadth-first order. A dropped session carries on from the byte it reached.
import type { DeskLink } from '../../desk/deskLink';
import { trailerMatches } from '../../export/credit';
import { Eta, timeLeft } from '../../export/eta';
import { Sha256, toHex } from '../../export/sha256';
import { ZipWriter } from '../../export/zip';
import type { CheckEvent, ImageCheck } from '../../platform/imageCheck';
import { FilesError, isNotConnected, toFilesError, type FilesApi } from './api';
import type { Pick } from './collect';
import { hubOf } from './hub';
import { baseName, join, parent } from './paths';
import { Cancelled, ReadBroken, ReadStalled, ReadStream, SessionLost } from './readStream';
import { openTarget, type Target } from './save';
import { Slots } from './slots';
import { isImage, sniffFile, type Sniff } from './sniff';
import { downloadedWords, errorWords, noRoomWords, speedWords, uploadedWords, WAITING_FOR_DESK } from './words';

export const UPLOADS_AT_ONCE = 3;
export const TRANSFERS_AT_ONCE = 8;
const CHECKS_AT_ONCE = 4;
const DOWNLOADS_AT_ONCE = 3;
const BLOCK_BYTES = 512 * 1024;
/** The most file bytes one CHUNK frame carries: a 16 KiB frame less its 12-byte header (`desk/rtc/frames.ts`). */
const MAX_PAYLOAD = 16 * 1024 - 12;
const CREDIT_STALL_MS = 120_000;
const MAX_ATTEMPTS = 5;

export type JobState = 'queued' | 'checking' | 'sending' | 'finishing' | 'paused' | 'done' | 'failed' | 'rejected' | 'cancelled';

export interface JobView {
  id: string;
  kind: 'upload' | 'download';
  /** The file or folder's own name. */
  name: string;
  /** Upload: where it lands. Download: what it reads. */
  path: string;
  folder: boolean;
  size: number;
  done: number;
  state: JobState;
  /** The one calm line about it. */
  words: string;
  /** In line for the image check, 1 is next. */
  position: number | null;
  speed: string | null;
  left: string | null;
  /** The member can press Try again. */
  retry: boolean;
  /** An image that broke a guideline. */
  rejected: { code: string; guideline: string; url: string } | null;
}

interface Job {
  id: string;
  kind: 'upload' | 'download';
  name: string;
  path: string;
  folder: boolean;
  size: number;
  done: number;
  state: JobState;
  words: string;
  position: number | null;
  retry: boolean;
  rejected: JobView['rejected'];
  ac: AbortController;
  eta: Eta;
  attempts: number;
  /** Counts toward the batch summary. */
  counted: boolean;
}

interface UploadJob extends Job {
  kind: 'upload';
  file: File;
  wanted: string;
  sniff: Sniff | null;
  verdict: { token: string; sha256: string; imageId: string } | null;
  uploadId: string | null;
  sha: Sha256 | null;
  shaPos: number;
  digestHex: string | null;
  finishIdem: string | null;
  finishing: boolean;
  restarts: number;
  renames: number;
  rechecks: number;
}

interface DownloadJob extends Job {
  kind: 'download';
  handle: FileSystemFileHandle | null | undefined;
  mtimeMs: number;
}

export interface EngineDeps {
  link: DeskLink;
  api: FilesApi;
  imageCheck: ImageCheck;
  now?: () => number;
  /** A polite live-region line. */
  announce?: (text: string) => void;
  /** A folder's listing changed because of a transfer. */
  changed?: (folder: string) => void;
  /** Whether a transfer is running (not paused): the idle rule keeps the session open for it (`desk/idle.ts`). */
  setBusy?: (busy: boolean) => void;
  /** Where a download goes. Tests give their own. */
  open?: typeof openTarget;
  /** How long progress is batched before the window hears of it. */
  notifyMs?: number;
}

const isTerminal = (s: JobState): boolean => s === 'done' || s === 'failed' || s === 'rejected' || s === 'cancelled';
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (window.clearTimeout(t), resolve()), { once: true });
  });

class UploadStop extends Error {
  constructor(readonly code: string) {
    super(`upload stopped: ${code}`);
    this.name = 'UploadStop';
  }
}
class UploadStalled extends Error {
  constructor() {
    super('the desk stopped giving credit');
    this.name = 'UploadStalled';
  }
}
class FileGone extends Error {
  constructor() {
    super('the local file changed');
    this.name = 'FileGone';
  }
}

export class TransferEngine {
  private readonly jobs: Job[] = [];
  private readonly listeners = new Set<() => void>();
  private views: readonly JobView[] = [];
  private readonly uploadSlots = new Slots(UPLOADS_AT_ONCE);
  private readonly downloadSlots = new Slots(DOWNLOADS_AT_ONCE);
  private readonly allSlots = new Slots(TRANSFERS_AT_ONCE);
  private readonly checkSlots = new Slots(CHECKS_AT_ONCE);
  private ticker = 0;
  private notifyTimer = 0;
  private nextId = 1;
  private busy = false;
  private disposed = false;
  private batch = { added: 0, failed: 0, open: 0 };
  private readonly offStatus: () => void;
  private readonly now: () => number;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.offStatus = deps.link.onStatus(() => this.notify());
  }

  // ---------- reading it

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  snapshot(): readonly JobView[] {
    return this.views;
  }

  /** Whole queue as numbers, for the tray's summary and tests. */
  counts(): { active: number; paused: number; done: number; failed: number } {
    let active = 0;
    let paused = 0;
    let done = 0;
    let failed = 0;
    for (const j of this.jobs) {
      if (j.state === 'done') done += 1;
      else if (j.state === 'failed' || j.state === 'rejected') failed += 1;
      else if (j.state === 'paused') paused += 1;
      else if (!isTerminal(j.state)) active += 1;
    }
    return { active, paused, done, failed };
  }

  dispose(): void {
    this.disposed = true;
    this.offStatus();
    window.clearInterval(this.ticker);
    window.clearTimeout(this.notifyTimer);
    for (const j of this.jobs) j.ac.abort();
    this.deps.setBusy?.(false);
  }

  // ---------- commands

  /** Queue uploads into `under`. Folders come as the relative paths in `picks`. */
  upload(picks: readonly Pick[], under: string): string[] {
    const ids: string[] = [];
    for (const p of picks) {
      const j: UploadJob = {
        ...this.base('upload', baseName(p.rel), join(under, p.rel), p.file.size),
        kind: 'upload',
        file: p.file,
        wanted: join(under, p.rel),
        sniff: null,
        verdict: null,
        uploadId: null,
        sha: null,
        shaPos: 0,
        digestHex: null,
        finishIdem: null,
        finishing: false,
        restarts: 0,
        renames: 0,
        rechecks: 0,
      };
      this.add(j);
      ids.push(j.id);
    }
    if (picks.length) this.deps.announce?.(picks.length === 1 ? `Uploading ${baseName(picks[0]!.rel)}` : `Uploading ${picks.length} files`);
    for (const id of ids) void this.runUpload(this.jobs.find((j) => j.id === id) as UploadJob);
    return ids;
  }

  /** A file, or a folder as a ZIP. `handle` is what the member chose in the save picker (asked at their click), if the browser has one. */
  download(target: { path: string; name: string; folder: boolean; size: number; mtimeMs?: number }, handle: FileSystemFileHandle | null | undefined): string {
    const j: DownloadJob = { ...this.base('download', target.name, target.path, target.size), kind: 'download', folder: target.folder, handle, mtimeMs: target.mtimeMs ?? 0 };
    this.add(j);
    void this.runDownload(j);
    return j.id;
  }

  cancel(id: string): void {
    const j = this.find(id);
    if (!j || isTerminal(j.state)) return;
    j.ac.abort();
    this.settle(j, 'cancelled', 'Cancelled');
    if (j.kind === 'upload' && (j as UploadJob).uploadId) void this.deps.api.uploadAbort((j as UploadJob).uploadId!);
  }

  retry(id: string): void {
    const j = this.find(id);
    if (!j || j.state !== 'failed' || !j.retry) return;
    j.ac = new AbortController();
    j.attempts = 0;
    j.retry = false;
    j.eta = new Eta();
    j.state = 'queued';
    j.words = 'Waiting its turn';
    if (j.kind === 'upload') {
      const u = j as UploadJob;
      u.uploadId = null;
      u.sha = null;
      u.shaPos = 0;
      u.digestHex = null;
      u.finishIdem = null;
      u.finishing = false;
      u.restarts = 0;
      u.renames = 0;
      u.done = 0;
      this.batch.open += 1;
      void this.runUpload(u);
    } else {
      j.done = 0;
      this.batch.open += 1;
      void this.runDownload(j as DownloadJob);
    }
    this.notify();
  }

  /** Take a finished, cancelled, failed or rejected line off the tray. */
  dismiss(id: string): void {
    const at = this.jobs.findIndex((j) => j.id === id && isTerminal(j.state));
    if (at < 0) return;
    this.jobs.splice(at, 1);
    this.notify(true);
  }

  clearFinished(): void {
    for (let i = this.jobs.length - 1; i >= 0; i -= 1) if (this.jobs[i]!.state === 'done' || this.jobs[i]!.state === 'cancelled') this.jobs.splice(i, 1);
    this.notify(true);
  }

  // ---------- plumbing

  private base(kind: 'upload' | 'download', name: string, path: string, size: number): Job {
    return {
      id: `t${this.nextId++}`,
      kind,
      name,
      path,
      folder: false,
      size,
      done: 0,
      state: 'queued',
      words: 'Getting ready',
      position: null,
      retry: false,
      rejected: null,
      ac: new AbortController(),
      eta: new Eta(),
      attempts: 0,
      counted: true,
    };
  }

  private add(j: Job): void {
    this.jobs.push(j);
    this.batch.open += 1;
    this.ensureTicker();
    this.notify(true);
  }

  private find(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private ensureTicker(): void {
    if (this.ticker || this.disposed) return;
    this.ticker = window.setInterval(() => {
      const t = this.now();
      let any = false;
      for (const j of this.jobs) {
        if (isTerminal(j.state)) continue;
        any = true;
        if (j.state === 'sending' || j.state === 'finishing') j.eta.sample(t, j.done, j.size);
      }
      if (!any) {
        window.clearInterval(this.ticker);
        this.ticker = 0;
      }
      this.notify();
    }, 1000);
  }

  private set(j: Job, state: JobState, words: string): void {
    if (isTerminal(j.state)) return;
    j.state = state;
    j.words = words;
    this.notify();
  }

  /** A job ends. Failed and rejected are announced at once; the rest add up to a summary. */
  private settle(j: Job, state: 'done' | 'failed' | 'rejected' | 'cancelled', words: string, retry = false): void {
    if (isTerminal(j.state)) return;
    j.state = state;
    j.words = words;
    j.retry = retry;
    j.position = null;
    if (state === 'done') {
      j.done = j.size;
      this.batch.added += 1;
    } else if (state === 'failed' || state === 'rejected') {
      this.batch.failed += 1;
      this.deps.announce?.(`${j.name}: ${words}`);
    }
    this.batch.open = Math.max(0, this.batch.open - 1);
    if (this.batch.open === 0) {
      const { added, failed } = this.batch;
      this.batch = { added: 0, failed: 0, open: 0 };
      if (added > 0 && (added + failed > 1 || state === 'done')) {
        const what = j.kind === 'download' ? 'downloaded' : 'uploaded';
        this.deps.announce?.(added + failed === 1 ? (j.kind === 'download' ? downloadedWords(j.name) : uploadedWords(j.name)) : failed ? `${added} ${what}, ${failed} did not finish` : `All ${added} ${what}`);
      }
    }
    this.notify(true);
  }

  private notify(now = false): void {
    if (this.disposed) return;
    const go = (): void => {
      this.notifyTimer = 0;
      this.views = this.jobs.map((j) => this.view(j));
      const c = this.counts();
      const busy = c.active > 0;
      if (busy !== this.busy) {
        this.busy = busy;
        this.deps.setBusy?.(busy);
      }
      for (const fn of [...this.listeners]) fn();
    };
    if (now) {
      window.clearTimeout(this.notifyTimer);
      go();
    } else if (!this.notifyTimer) {
      this.notifyTimer = window.setTimeout(go, this.deps.notifyMs ?? 150);
    }
  }

  private view(j: Job): JobView {
    const sending = j.state === 'sending' || j.state === 'finishing';
    return {
      id: j.id,
      kind: j.kind,
      name: j.name,
      path: j.path,
      folder: j.folder,
      size: j.size,
      done: Math.min(j.done, j.size),
      state: j.state,
      words: j.words,
      position: j.position,
      speed: sending ? speedWords(j.eta.rate()) : null,
      left: sending ? timeLeft(j.eta.left()) : null,
      retry: j.retry,
      rejected: j.rejected,
    };
  }

  /** The link has a session that can carry a transfer. */
  private canCarry(): boolean {
    return this.deps.link.status() === 'open' && this.deps.link.bulk() !== null;
  }

  /** Waits for a session, saying so. Returns false if cancelled meanwhile. */
  private async untilOpen(j: Job): Promise<boolean> {
    while (!this.canCarry()) {
      if (j.ac.signal.aborted) return false;
      this.set(j, 'paused', WAITING_FOR_DESK);
      await new Promise<void>((resolve) => {
        const done = (): void => {
          off();
          window.clearTimeout(timer);
          j.ac.signal.removeEventListener('abort', done);
          resolve();
        };
        const off = this.deps.link.onStatus(done);
        const timer = window.setTimeout(done, 3000);
        j.ac.signal.addEventListener('abort', done, { once: true });
      });
    }
    return !j.ac.signal.aborted;
  }

  /** Why a call failed, as the job's end: offline errors are not an end. */
  private isOffline(err: unknown): boolean {
    return err instanceof SessionLost || isNotConnected(err) || (err instanceof FilesError && err.offline);
  }

  // ---------- uploads

  private async runUpload(j: UploadJob): Promise<void> {
    const signal = j.ac.signal;
    try {
      j.sniff ??= await sniffFile(j.file).catch(() => ({ kind: 'other' }) as Sniff);
      if (isImage(j.sniff) && !j.verdict) {
        if (!(await this.untilOpen(j))) return;
        if (!(await this.checkImage(j))) return;
      }
      this.set(j, 'queued', 'Waiting its turn');
      const releaseUpload = await this.uploadSlots.acquire(signal);
      if (!releaseUpload) return;
      const releaseAll = await this.allSlots.acquire(signal);
      if (!releaseAll) return releaseUpload();
      try {
        await this.uploadLoop(j);
      } finally {
        releaseAll();
        releaseUpload();
      }
    } catch (err) {
      if (!signal.aborted) this.settle(j, 'failed', errorWords(toFilesError(err), 'add that file'), true);
    }
  }

  /** The image check: its events become the job's words. True if it passed. */
  private async checkImage(j: UploadJob): Promise<boolean> {
    const signal = j.ac.signal;
    const release = await this.checkSlots.acquire(signal);
    if (!release) return false;
    try {
      this.set(j, 'checking', 'Sending your image to be checked.');
      for await (const ev of this.deps.imageCheck.check(j.file, this.deps.link.deskId, signal)) {
        if (signal.aborted) return false;
        if (!this.onCheck(j, ev)) return false;
        if (j.verdict) return true;
      }
      if (signal.aborted) return false;
      if (!j.verdict) this.settle(j, 'failed', "We couldn't check your image just now. Nothing was added.", true);
      return j.verdict !== null;
    } catch (err) {
      if (!signal.aborted) this.settle(j, 'failed', "We couldn't check your image just now. Nothing was added.", true);
      void err;
      return false;
    } finally {
      release();
    }
  }

  /** False when the event ended the job. */
  private onCheck(j: UploadJob, ev: CheckEvent): boolean {
    switch (ev.type) {
      case 'queued':
        j.position = ev.position;
        this.set(j, 'checking', ev.words);
        return true;
      case 'checking':
        j.position = null;
        this.set(j, 'checking', ev.words);
        return true;
      case 'passed':
        if (ev.bytes !== j.size) {
          this.settle(j, 'failed', 'The image changed while it was being checked. Try again.', true);
          return false;
        }
        j.position = null;
        j.verdict = { token: ev.token, sha256: ev.sha256, imageId: ev.imageId };
        return true;
      case 'rejected':
        j.rejected = { code: ev.code, guideline: ev.guideline, url: ev.guidelinesUrl };
        this.settle(j, 'rejected', ev.words);
        return false;
      case 'error':
        this.settle(j, 'failed', ev.words, ev.retryable);
        return false;
    }
  }

  private async uploadLoop(j: UploadJob): Promise<void> {
    const signal = j.ac.signal;
    for (;;) {
      if (!(await this.untilOpen(j))) return;
      try {
        await this.uploadOnce(j);
        return;
      } catch (err) {
        if (signal.aborted || err instanceof Cancelled) return;
        if (this.isOffline(err)) continue;
        j.attempts += 1;
        if (err instanceof UploadStop) {
          if (err.code === 'aborted') return;
          if (err.code === 'no_space') return this.settle(j, 'failed', 'Your drive filled up while this was uploading. Make some room, then try again.', true);
          if (err.code === 'superseded') return this.settle(j, 'failed', 'Another window took over this upload.', true);
        }
        if (err instanceof FileGone) return this.settle(j, 'failed', 'The file changed on your computer while it was uploading. Try again.', true);
        if (err instanceof FilesError) {
          const handled = await this.uploadError(j, err);
          if (handled === 'return') return;
          if (handled === 'retry') continue;
        }
        if (j.attempts >= MAX_ATTEMPTS) return this.settle(j, 'failed', err instanceof FilesError ? errorWords(err, 'add that file') : "Your desk didn't keep up. Try again.", true);
        await sleep(Math.min(8000, 500 * 2 ** j.attempts), signal);
      }
    }
  }

  /** A desk error during an upload: 'return' (ended), 'retry' (go again now) or 'backoff'. */
  private async uploadError(j: UploadJob, err: FilesError): Promise<'return' | 'retry' | 'backoff'> {
    switch (err.code) {
      case 'too_many':
      case 'rate_limited':
        await sleep(1500, j.ac.signal);
        return j.attempts > 20 ? (this.settle(j, 'failed', errorWords(err), true), 'return') : 'retry';
      case 'hash_mismatch':
        j.uploadId = null;
        j.sha = null;
        j.shaPos = 0;
        j.digestHex = null;
        j.restarts += 1;
        if (j.restarts > 2) return this.settle(j, 'failed', errorWords(err), true), 'return';
        return 'retry';
      case 'check_invalid':
        if (j.verdict && j.rechecks < 2) {
          // The token timed out while the desk slept, or similar: check again, from the top.
          j.rechecks += 1;
          j.verdict = null;
          j.uploadId = null;
          j.sha = null;
          j.shaPos = 0;
          j.digestHex = null;
          return (await this.checkImage(j)) ? 'retry' : 'return';
        }
        return this.settle(j, 'failed', errorWords(err), true), 'return';
      case 'check_required':
        if (isImage(j.sniff ?? { kind: 'other' }) && j.rechecks < 2) {
          j.rechecks += 1;
          j.verdict = null;
          j.uploadId = null;
          return (await this.checkImage(j)) ? 'retry' : 'return';
        }
        return this.settle(j, 'failed', errorWords(err), true), 'return';
      case 'no_space':
        return this.settle(j, 'failed', noRoomWords(err.details), true), 'return';
      case 'invalid':
      case 'forbidden':
      case 'exists':
        return this.settle(j, 'failed', errorWords(err, 'add that file'), false), 'return';
      case 'conflict':
        await sleep(1000, j.ac.signal);
        return 'retry';
      default:
        return 'backoff';
    }
  }

  private async uploadOnce(j: UploadJob): Promise<void> {
    const bulk = this.deps.link.bulk();
    if (!bulk) throw new SessionLost();
    this.set(j, 'sending', 'Uploading');
    const att = await this.attach(j);
    if (att === 'landed') return;
    await this.rehash(j, att.offset);
    j.done = att.offset;
    await this.send(j, att, bulk);
    await this.finish(j);
  }

  /** `begin`, or `status` on an upload that has a partial. `landed` if the desk already finished it. */
  private async attach(j: UploadJob): Promise<{ transferId: number; offset: number; window: number } | 'landed'> {
    const { api } = this.deps;
    if (j.uploadId) {
      try {
        const s = await api.uploadStatus(j.uploadId, this.deps.api.idem());
        return { transferId: s.transferId, offset: s.committed, window: s.window };
      } catch (err) {
        const e = toFilesError(err);
        if (e.code !== 'not_found') throw e;
        if (j.finishing && (await this.landed(j))) {
          this.finished(j);
          return 'landed';
        }
        j.uploadId = null;
        j.sha = null;
        j.shaPos = 0;
      }
    }
    for (let tries = 0; tries < 100; tries += 1) {
      const candidate = tries === 0 ? j.wanted : join(parent(j.wanted), this.renamed(j.wanted, tries + 1));
      try {
        const r = await api.uploadBegin(
          { path: candidate, size: j.size, mtimeMs: j.file.lastModified || Date.now(), ...(j.verdict ? { token: j.verdict.token, sha256: j.verdict.sha256 } : {}) },
          this.deps.api.idem(),
        );
        j.uploadId = r.uploadId;
        j.path = candidate;
        j.name = baseName(candidate);
        j.renames = tries;
        return { transferId: r.transferId, offset: r.offset, window: r.window };
      } catch (err) {
        const e = toFilesError(err);
        if (e.code !== 'exists') throw e;
      }
    }
    throw new FilesError('exists');
  }

  /** "name (2).ext", "name (3).ext": the name a taken one gets, the way a file manager does. */
  private renamed(wanted: string, n: number): string {
    const name = baseName(wanted);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${stem} (${n})${ext}`;
  }

  private async landed(j: UploadJob): Promise<boolean> {
    try {
      const s = await this.deps.api.stat(j.path);
      return s.entry.type === 'file' && s.entry.size === j.size;
    } catch {
      return false;
    }
  }

  /** The running hash has to cover the file from byte 0 to where the desk has it: kept if it is there already, else read again. */
  private async rehash(j: UploadJob, committed: number): Promise<void> {
    if (j.sha && j.shaPos === committed) return;
    const sha = new Sha256();
    let pos = 0;
    while (pos < committed) {
      if (j.ac.signal.aborted) throw new Cancelled();
      const end = Math.min(committed, pos + 4 * 1024 * 1024);
      const buf = new Uint8Array(await j.file.slice(pos, end).arrayBuffer());
      if (buf.length !== end - pos) throw new FileGone();
      sha.update(buf);
      pos = end;
    }
    j.sha = sha;
    j.shaPos = committed;
    j.digestHex = null;
  }

  private async send(j: UploadJob, att: { transferId: number; offset: number; window: number }, bulk: NonNullable<ReturnType<DeskLink['bulk']>>): Promise<void> {
    const { link } = this.deps;
    const signal = j.ac.signal;
    let granted = att.offset + att.window;
    let terminal: string | null = null;
    let wake: (() => void) | null = null;
    const off = hubOf(bulk).listenCredits((id, msg) => {
      if (id !== att.transferId) return;
      if (msg.error) terminal = msg.error;
      else granted += msg.bytes;
      if (msg.committed !== undefined && msg.committed > j.done) {
        j.done = msg.committed;
        this.notify();
      }
      wake?.();
    });
    const waitForCredit = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          wake = null;
          reject(new UploadStalled());
        }, CREDIT_STALL_MS);
        wake = () => {
          window.clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    const onAbort = (): void => wake?.();
    signal.addEventListener('abort', onAbort);
    const sha = j.sha!;
    let pos = att.offset;
    let seq = 0;
    let frames = 0;
    try {
      while (pos < j.size) {
        if (signal.aborted) throw new Cancelled();
        if (link.status() !== 'open' || link.bulk() !== bulk) throw new SessionLost();
        const end = Math.min(j.size, pos + BLOCK_BYTES);
        const block = new Uint8Array(await j.file.slice(pos, end).arrayBuffer());
        if (block.length !== end - pos) throw new FileGone();
        for (let o = 0; o < block.length; ) {
          const n = Math.min(MAX_PAYLOAD, block.length - o);
          while (terminal === null && pos + n > granted) {
            if (signal.aborted) throw new Cancelled();
            if (link.status() !== 'open' || link.bulk() !== bulk) throw new SessionLost();
            await waitForCredit();
          }
          if (terminal !== null) throw new UploadStop(terminal);
          if ((frames++ & 15) === 0) await bulk.drained();
          const frame = block.subarray(o, o + n);
          if (!bulk.send(att.transferId, seq++, frame)) throw new SessionLost();
          sha.update(frame);
          pos += n;
          o += n;
          j.shaPos = pos;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      off();
    }
  }

  private async finish(j: UploadJob): Promise<void> {
    const { api } = this.deps;
    this.set(j, 'finishing', 'Finishing up');
    if (!j.sha || j.shaPos !== j.size) throw new UploadStalled();
    j.digestHex ??= toHex(j.sha.digest());
    if (j.verdict && j.verdict.sha256 !== j.digestHex) {
      j.verdict = null;
      this.settle(j, 'failed', 'The image changed while it was being added. Try again.', true);
      throw new Cancelled();
    }
    j.finishIdem ??= this.deps.api.idem();
    j.finishing = true;
    for (let tries = 0; ; tries += 1) {
      try {
        const r = await api.uploadFinish({ uploadId: j.uploadId!, sha256: j.digestHex, size: j.size, ...(j.verdict ? { token: j.verdict.token } : {}) }, j.finishIdem);
        j.path = r.path;
        this.finished(j);
        return;
      } catch (err) {
        const e = toFilesError(err);
        if (e.code === 'conflict' && e.details['reason'] === 'incomplete' && tries < 3) {
          await sleep(1000, j.ac.signal);
          continue;
        }
        throw e;
      }
    }
  }

  private finished(j: UploadJob): void {
    if (j.verdict) void this.deps.imageCheck.settle(j.verdict.imageId).catch(() => undefined);
    j.uploadId = null;
    this.settle(j, 'done', 'Uploaded');
    this.deps.changed?.(parent(j.path));
  }

  // ---------- downloads

  private async runDownload(j: DownloadJob): Promise<void> {
    const signal = j.ac.signal;
    let target: Target | null = null;
    try {
      this.set(j, 'queued', 'Waiting its turn');
      const releaseDownload = await this.downloadSlots.acquire(signal);
      if (!releaseDownload) return;
      const releaseAll = await this.allSlots.acquire(signal);
      if (!releaseAll) return releaseDownload();
      try {
        const name = j.folder ? `${j.name}.zip` : j.name;
        target = await (this.deps.open ?? openTarget)(j.handle, name).catch(() => null);
        if (!target) return this.settle(j, 'failed', "Your browser wouldn't let this be saved there. Try again.", true);
        if (j.folder) await this.downloadFolder(j, target);
        else await this.downloadOne(j, target);
        if (signal.aborted) return void (await target.abort());
        await target.finish();
        this.settle(j, 'done', target.where === 'downloads' ? 'Downloaded. Check your Downloads.' : 'Saved');
      } finally {
        releaseAll();
        releaseDownload();
      }
    } catch (err) {
      await target?.abort();
      if (signal.aborted || err instanceof Cancelled) return;
      const e = toFilesError(err);
      this.settle(j, 'failed', err instanceof ReadBroken || err instanceof ReadStalled ? "It didn't come through whole. Try again." : errorWords(e, 'send that'), true);
    }
  }

  private async downloadOne(j: DownloadJob, target: Target): Promise<void> {
    this.set(j, 'sending', 'Downloading');
    const sha = { state: new Sha256(), received: 0 };
    await this.pull(j, j.path, sha, (bytes) => target.sink.write(bytes), async () => void (await target.sink.truncate(0)));
  }

  /**
   * One remote file into `write`, resuming from the byte it reached when the session goes, and from 0 if it changed
   * while it was read (the trailer's SHA-256 is what the desk read, start to end).
   */
  private async pull(j: DownloadJob, path: string, st: { state: Sha256; received: number }, write: (b: Uint8Array) => Promise<void>, rewind: () => Promise<void>): Promise<void> {
    const { link, api } = this.deps;
    let mismatches = 0;
    let errors = 0;
    for (;;) {
      if (!(await this.untilOpen(j))) throw new Cancelled();
      this.set(j, 'sending', 'Downloading');
      const bulk = link.bulk()!;
      const rs = new ReadStream(api, link, bulk, path, st.received);
      const onAbort = (): void => rs.cancel();
      j.ac.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await rs.open();
        for (;;) {
          const piece = await rs.next();
          if (!piece) break;
          await write(piece.bytes);
          st.state.update(piece.bytes);
          st.received = piece.to;
          j.done += piece.bytes.length;
          this.notify();
          rs.written(piece.to);
        }
        const digest = st.state.digest();
        if (rs.trailer && st.received === rs.size && trailerMatches(rs.trailer, digest, st.received)) return;
        throw new ReadBroken('trailer');
      } catch (err) {
        rs.close(true);
        if (j.ac.signal.aborted || err instanceof Cancelled) throw new Cancelled();
        if (this.isOffline(err)) continue;
        if (err instanceof ReadBroken) {
          // Not what the desk read, start to end (or a CHUNK was lost): again from 0.
          mismatches += 1;
          if (mismatches > 2) throw err;
          j.done -= st.received;
          st.state = new Sha256();
          st.received = 0;
          await rewind();
          continue;
        }
        if (err instanceof ReadStalled) {
          errors += 1;
          if (errors >= MAX_ATTEMPTS) throw err;
          continue;
        }
        const e = toFilesError(err);
        if (e.code === 'too_many' || e.code === 'rate_limited') {
          await sleep(1500, j.ac.signal);
          continue;
        }
        throw e;
      } finally {
        j.ac.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  private async downloadFolder(j: DownloadJob, target: Target): Promise<void> {
    const { api } = this.deps;
    this.set(j, 'sending', 'Looking through the folder');
    // Breadth-first, folders before files within a folder, so the archive reads in a calm order.
    const files: { path: string; name: string; size: number; mtimeMs: number }[] = [];
    const dirs: { name: string; mtimeMs: number }[] = [];
    const queue: string[] = [j.path];
    const top = j.name;
    dirs.push({ name: `${top}/`, mtimeMs: j.mtimeMs });
    while (queue.length) {
      if (j.ac.signal.aborted) throw new Cancelled();
      const folder = queue.shift()!;
      if (!(await this.untilOpen(j))) throw new Cancelled();
      const listing = await api.list(folder);
      for (const e of listing.entries) {
        const full = join(folder, e.name);
        const rel = `${top}/${full.slice(j.path.length + 1)}`;
        if (e.type === 'dir') {
          dirs.push({ name: `${rel}/`, mtimeMs: e.mtimeMs });
          queue.push(full);
        } else {
          files.push({ path: full, name: rel, size: e.size ?? 0, mtimeMs: e.mtimeMs });
        }
      }
    }
    j.size = files.reduce((s, f) => s + f.size, 0);
    j.done = 0;
    const zip = new ZipWriter(target.sink);
    for (const d of dirs) await zip.addDir(d.name, { mtimeMs: d.mtimeMs });
    for (const f of files) {
      if (j.ac.signal.aborted) throw new Cancelled();
      const opts = { mtimeMs: f.mtimeMs, sizeHint: f.size };
      await zip.begin(f.name, opts);
      const st = { state: new Sha256(), received: 0 };
      await this.pull(j, f.path, st, (b) => zip.data(b), async () => {
        await zip.rewind();
        await zip.begin(f.name, opts);
      });
      await zip.end();
    }
    await zip.finish();
  }
}
