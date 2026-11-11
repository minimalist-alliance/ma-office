// Dev and test only, through mockDeskLink.ts (never in a production bundle). One desk's Files tree held in memory and served as
// deskd serves `files.*` (services/deskd/docs/files.md): the path grammar, sorted pages, a trash with 30 days, the whole drive's
// quota with the 2 GiB floor, uploads that are credited and committed as the page sends and resume by `status`, and the image
// gate (an image needs the stub token `stub.<sha256>`). It has no knowledge of the app: the app is tested against it, and it
// against files.md.
import type { BulkChannel, FileEntry, FilesChangesMessage, FilesUsage, FileSniff, TrashItem } from './deskLink';
import type { MockBulk } from './mockDeskData';

type Dir = { type: 'dir'; mtimeMs: number; children: Map<string, Node> };
type File = { type: 'file'; mtimeMs: number; bytes: Uint8Array };
type Node = Dir | File;

interface Upload {
  uploadId: string;
  path: string;
  size: number;
  replace: boolean;
  token: string | null;
  mtimeMs: number;
  /** What's committed, contiguous from 0. */
  bytes: Uint8Array;
  committed: number;
  transferId: number | null;
  granted: number;
  lastCredited: number;
  nextSeq: number;
  bulk: MockBulk | null;
}

export interface MockFilesControl {
  /** The size of the drive, and what every other app holds of it. */
  totalBytes: number;
  otherBytes: number;
  floorBytes: number;
  /** A free desk's cap; null is none (ADR 0090). */
  capBytes: number | null;
  /** Bytes the cap counts that the mock holds nowhere (unfinished uploads on a real desk), so a test can fill a 2 GB drive. */
  capExtraBytes: number;
  /** Every method asked, in order. */
  calls: { m: string; p: Record<string, unknown> }[];
  /** Uploads finished: path and size. */
  landed: { path: string; size: number; sha256: string }[];
  /** `files.read`s, in order. */
  reads: { path: string; offset: number }[];
  /** The next call of this method refuses with this code, once. */
  failNext: Record<string, string>;
  /** Every call of this method refuses with this code until it is deleted. */
  refuse: Record<string, string>;
  /** A guild desk answers `forbidden`. */
  guild: boolean;
  /** Pages of `files.list`, for a test that wants more than one. */
  pageSize: number;
  /** The session drops after this many bytes of an upload have been committed (once). */
  dropAfterBytes: number | null;
  /** Sets by the link: drops the session. */
  onDrop: (() => void) | null;
  /** Acks wait this long, to make a slow upload for a test. */
  ackDelayMs: number;
}

const WINDOW = 1024 * 1024;
const CREDIT_STEP = 256 * 1024;
const MAX_PAYLOAD = 16372;
const GiB = 1024 ** 3;
const DAY = Date.UTC(2026, 10, 5, 9, 30);
const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

export const refusal = (code: string, details: Record<string, unknown> = {}): Error => Object.assign(new Error(`mock ${code}`), { code, details });

const BAD = /[\u0000-\u001f\u007f-\u009f\\‪-‮⁦-⁩]/u;

function checkPath(path: string, allowRoot = false): string[] {
  if (typeof path !== 'string') throw refusal('bad_request', { reason: 'path' });
  if (path === '') {
    if (allowRoot) return [];
    throw refusal('invalid', { reason: 'empty' });
  }
  if (new TextEncoder().encode(path).length > 1024) throw refusal('invalid', { reason: 'length' });
  if (path !== path.normalize('NFC')) throw refusal('invalid', { reason: 'nfc' });
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '') throw refusal('invalid', { reason: 'empty' });
    if (part === '.' || part === '..') throw refusal('invalid', { reason: 'dots' });
    if (BAD.test(part)) throw refusal('invalid', { reason: 'chars' });
    if (new TextEncoder().encode(part).length > 255) throw refusal('invalid', { reason: 'length' });
  }
  if (parts[0] === '.uploads' || parts[0] === '.trash') throw refusal('invalid', { reason: 'reserved' });
  return parts;
}

function compare(a: [string, Node], b: [string, Node]): number {
  if (a[1].type !== b[1].type) return a[1].type === 'dir' ? -1 : 1;
  const fa = a[0].toLowerCase();
  const fb = b[0].toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
}

/** deskd's `files.stat` sniff, by magic bytes, the same ten formats. */
export function sniffBytes(b: Uint8Array): FileSniff {
  const at = (s: string, o = 0): boolean => b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', format: 'jpeg' };
  if (at('\x89PNG\r\n\x1a\n')) return { kind: 'image', format: 'png' };
  if (at('GIF8')) return { kind: 'image', format: 'gif' };
  if (at('RIFF') && at('WEBP', 8)) return { kind: 'image', format: 'webp' };
  if (at('BM')) return { kind: 'image', format: 'bmp' };
  if (at('ftyp', 4)) return { kind: 'image', format: at('avif', 8) ? 'avif' : 'heic' };
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 512)))) return { kind: 'image', format: 'svg' };
  return { kind: 'other' };
}

export class MockFilesDesk {
  readonly control: MockFilesControl;
  private root: Dir = { type: 'dir', mtimeMs: DAY, children: new Map() };
  private readonly trash = new Map<string, { id: string; name: string; originalPath: string; node: Node; deletedAt: number }>();
  private readonly uploads = new Map<string, Upload>();
  private readonly replies = new Map<string, unknown>();
  private readonly listeners = new Set<(m: Omit<FilesChangesMessage, 'seq'>) => void>();
  private counter = 0;

  constructor(control?: Partial<MockFilesControl>) {
    this.control = {
      totalBytes: 32 * GiB,
      otherBytes: 9 * GiB,
      floorBytes: 2 * GiB,
      capBytes: null,
      capExtraBytes: 0,
      calls: [],
      landed: [],
      reads: [],
      failNext: {},
      refuse: {},
      guild: false,
      pageSize: 2000,
      dropAfterBytes: null,
      onDrop: null,
      ackDelayMs: 0,
      ...control,
    };
  }

  /** A few files and folders to start with, as a member's drive might hold. */
  seed(): this {
    this.put('Documents/Notes/ideas.txt', text('Fewer words. Fewer decisions.\n'));
    this.put('Documents/Notes/Café menu.txt', text('Flat white\nCortado\n'));
    this.put('Documents/report.pdf', text('%PDF-1.7\n% a stand-in report\n'));
    this.put('Photos/harbor.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...text('JFIF a stand-in harbor photo')]));
    this.put('Photos/Summer/pier.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...text('a stand-in pier')]));
    this.put('Backups/site.zip', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...text('a stand-in archive')]));
    this.put('readme.txt', text('Everything here is on your desk, and only on your desk.\n'));
    this.mkdirp(['Empty folder']);
    // Something already in the trash, deleted three days ago, so the trash view has a row in `npm run dev`.
    const old = this.id();
    this.trash.set(old, { id: old, name: 'old-notes.txt', originalPath: 'Documents/old-notes.txt', node: { type: 'file', mtimeMs: DAY, bytes: text('Things I no longer need.\n') }, deletedAt: Date.now() - 3 * 86_400_000 });
    return this;
  }

  // ---------- test and dev helpers

  put(path: string, bytes: Uint8Array, mtimeMs = DAY): void {
    const parts = path.split('/');
    const dir = this.mkdirp(parts.slice(0, -1));
    dir.children.set(parts[parts.length - 1]!, { type: 'file', mtimeMs, bytes });
  }

  /** The bytes at a path, or null. */
  read(path: string): Uint8Array | null {
    const n = this.walk(path === '' ? [] : path.split('/'));
    return n?.type === 'file' ? n.bytes : null;
  }

  exists(path: string): 'file' | 'dir' | null {
    return this.walk(path === '' ? [] : path.split('/'))?.type ?? null;
  }

  /** Every file path, sorted. */
  allFiles(): string[] {
    const out: string[] = [];
    const rec = (dir: Dir, prefix: string): void => {
      for (const [name, n] of dir.children) {
        if (n.type === 'dir') rec(n, `${prefix}${name}/`);
        else out.push(`${prefix}${name}`);
      }
    };
    rec(this.root, '');
    return out.sort();
  }

  trashedNames(): string[] {
    return [...this.trash.values()].map((t) => t.name);
  }

  subscribe(fn: (m: Omit<FilesChangesMessage, 'seq'>) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Tells every open window to ask for the usage again, as the desk does when a cap changes. */
  usageChanged(): void {
    this.emit([], true);
  }

  private emit(dirs: string[] | null, usage = true, trash = false): void {
    for (const fn of [...this.listeners]) fn({ dirs, usage, trash });
  }

  /** The session goes: every running upload loses its transfer and keeps its partial. */
  detach(): void {
    for (const u of this.uploads.values()) {
      u.bulk?.detachUpload(u.transferId ?? -1);
      u.bulk = null;
      u.transferId = null;
    }
  }

  // ---------- tree

  private mkdirp(parts: string[]): Dir {
    let dir = this.root;
    for (const part of parts) {
      let next = dir.children.get(part);
      if (!next) {
        next = { type: 'dir', mtimeMs: Date.now(), children: new Map() };
        dir.children.set(part, next);
      } else if (next.type !== 'dir') {
        throw refusal('invalid', { reason: 'not_a_folder' });
      }
      dir = next;
    }
    return dir;
  }

  private walk(parts: string[]): Node | null {
    let n: Node = this.root;
    for (const part of parts) {
      if (n.type !== 'dir') return null;
      const next: Node | undefined = n.children.get(part);
      if (!next) return null;
      n = next;
    }
    return n;
  }

  private sizeOf(n: Node): number {
    if (n.type === 'file') return n.bytes.length;
    let s = 0;
    for (const c of n.children.values()) s += this.sizeOf(c);
    return s;
  }

  private id(): string {
    this.counter += 1;
    return `01JC8X${String(this.counter).padStart(8, '0')}${'ABCDEFGHJKMNPQRSTVWXYZ'.padEnd(12, '0').slice(0, 12)}`.slice(0, 26);
  }

  private filesBytes(): number {
    return this.sizeOf(this.root);
  }

  private trashBytes(): number {
    let s = 0;
    for (const t of this.trash.values()) s += this.sizeOf(t.node);
    return s;
  }

  private partialBytes(): number {
    let s = 0;
    for (const u of this.uploads.values()) s += u.committed;
    return s;
  }

  private usedBytes(): number {
    return this.control.otherBytes + this.filesBytes() + this.trashBytes() + this.partialBytes();
  }

  private freeBytes(): number {
    return Math.max(0, this.control.totalBytes - this.usedBytes());
  }

  private owed(): number {
    let s = 0;
    for (const u of this.uploads.values()) s += u.size - u.committed;
    return s;
  }

  private uploadable(): number {
    return Math.max(0, this.freeBytes() - this.control.floorBytes - this.owed());
  }

  private entry(name: string, n: Node): FileEntry {
    return { name, type: n.type, size: n.type === 'file' ? n.bytes.length : null, mtimeMs: n.mtimeMs };
  }

  // ---------- the methods

  /** Anything the desk is asked. `bulk` is this session's. */
  async answer(method: string, params: Record<string, unknown>, ctx: { bulk: MockBulk | null; idem?: string; scope: string }): Promise<unknown> {
    this.control.calls.push({ m: method, p: params });
    await Promise.resolve();
    if (this.control.guild || ctx.scope !== 'owner') throw refusal('forbidden', { reason: 'scope' });
    const refuse = this.control.refuse[method];
    if (refuse) throw refusal(refuse);
    const once = this.control.failNext[method];
    if (once) {
      delete this.control.failNext[method];
      throw refusal(once);
    }
    const mutation = /^files\.(mkdir|rename|delete|trash\.restore|trash\.empty|upload\.(begin|status|finish|abort))$/.test(method);
    if (mutation) {
      if (!ctx.idem) throw refusal('bad_request', { reason: 'idem' });
      const key = `${method}:${ctx.idem}`;
      if (this.replies.has(key)) return this.replies.get(key);
      const result = await this.run(method, params, ctx);
      this.replies.set(key, result);
      if (this.replies.size > 500) this.replies.delete(this.replies.keys().next().value as string);
      return result;
    }
    return this.run(method, params, ctx);
  }

  private async run(method: string, p: Record<string, unknown>, ctx: { bulk: MockBulk | null }): Promise<unknown> {
    const str = (k: string): string => {
      const v = p[k];
      if (typeof v !== 'string') throw refusal('bad_request', { reason: k });
      return v;
    };
    switch (method) {
      case 'files.list': {
        const parts = checkPath(str('path'), true);
        const n = this.walk(parts);
        if (!n) throw refusal('not_found');
        if (n.type !== 'dir') throw refusal('invalid', { reason: 'not_a_folder' });
        const all = [...n.children.entries()].sort(compare);
        const limit = Math.min(Number(p['limit']) || 2000, this.control.pageSize);
        const from = p['cursor'] ? Number(p['cursor']) : 0;
        if (!Number.isInteger(from) || from < 0) throw refusal('invalid', { reason: 'cursor' });
        const page = all.slice(from, from + limit);
        return { entries: page.map(([name, c]) => this.entry(name, c)), next: from + page.length < all.length ? String(from + page.length) : null, skipped: 0 };
      }
      case 'files.stat': {
        const parts = checkPath(str('path'), true);
        const n = this.walk(parts);
        if (!n) throw refusal('not_found');
        return { entry: this.entry(parts[parts.length - 1] ?? '', n), sniff: n.type === 'file' ? sniffBytes(n.bytes.subarray(0, 4096)) : null };
      }
      case 'files.search': {
        const q = str('q').toLowerCase();
        const under = checkPath(typeof p['under'] === 'string' ? p['under'] : '', true);
        const start = this.walk(under);
        if (!start || start.type !== 'dir') throw refusal('not_found');
        const hits: (FileEntry & { path: string })[] = [];
        const rec = (dir: Dir, prefix: string): void => {
          for (const [name, c] of [...dir.children.entries()].sort(compare)) {
            const path = prefix ? `${prefix}/${name}` : name;
            if (name.toLowerCase().includes(q)) hits.push({ ...this.entry(name, c), path });
            if (c.type === 'dir') rec(c, path);
          }
        };
        rec(start, under.join('/'));
        const limit = Math.min(Number(p['limit']) || 100, 200);
        hits.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1)));
        return { entries: hits.slice(0, limit), truncated: hits.length > limit };
      }
      case 'files.usage': {
        const usage: FilesUsage = {
          drive: { totalBytes: this.control.totalBytes, usedBytes: this.usedBytes(), freeBytes: this.freeBytes() },
          files: { bytes: this.filesBytes(), approx: false },
          trash: { bytes: this.trashBytes(), items: this.trash.size },
          floorBytes: this.control.floorBytes,
          uploadableBytes: this.uploadable(),
          ...(this.control.capBytes === null ? {} : { capBytes: this.control.capBytes, capUsedBytes: this.filesBytes() + this.trashBytes() + this.partialBytes() + this.control.capExtraBytes }),
          computedAt: new Date().toISOString(),
        };
        return usage;
      }
      case 'files.mkdir': {
        const parts = checkPath(str('path'));
        const parents = p['parents'] === true;
        const existing = this.walk(parts);
        if (existing) {
          if (parents && existing.type === 'dir') return { created: false };
          throw refusal('exists', { kind: existing.type });
        }
        if (!parents && !this.walk(parts.slice(0, -1))) throw refusal('not_found');
        this.mkdirp(parts);
        this.emit([parts.slice(0, -1).join('/')]);
        return { created: true };
      }
      case 'files.rename': {
        const from = checkPath(str('from'));
        const to = checkPath(str('to'));
        const replace = p['replace'] === true;
        const src = this.walk(from);
        if (!src) throw refusal('not_found');
        if (from.join('/') === to.join('/')) return { path: to.join('/'), replaced: null };
        if (src.type === 'dir' && to.join('/').startsWith(`${from.join('/')}/`)) throw refusal('invalid', { reason: 'into_self' });
        const toParent = this.walk(to.slice(0, -1));
        if (!toParent) throw refusal('not_found');
        if (toParent.type !== 'dir') throw refusal('invalid', { reason: 'not_a_folder' });
        const name = to[to.length - 1]!;
        const taken = toParent.children.get(name);
        let replaced: string | null = null;
        if (taken) {
          if (!replace || taken.type === 'dir' || src.type === 'dir') throw refusal('exists', { kind: taken.type });
          replaced = this.toTrash(taken, name, to.join('/'));
        }
        const fromParent = this.walk(from.slice(0, -1));
        if (fromParent?.type === 'dir') fromParent.children.delete(from[from.length - 1]!);
        toParent.children.set(name, src);
        this.emit([from.slice(0, -1).join('/'), to.slice(0, -1).join('/')]);
        return { path: to.join('/'), replaced };
      }
      case 'files.delete': {
        const paths = p['paths'];
        if (!Array.isArray(paths) || paths.length < 1 || paths.length > 200) throw refusal('bad_request', { reason: 'paths' });
        const results: { path: string; ok: boolean; trashId?: string; code?: string }[] = [];
        for (const raw of paths as string[]) {
          try {
            if (p['permanent'] === true) {
              if (!raw.startsWith('trash:')) throw refusal('invalid', { reason: 'permanent' });
              const id = raw.slice(6);
              if (!this.trash.delete(id)) throw refusal('not_found');
              results.push({ path: raw, ok: true });
              continue;
            }
            if (raw.startsWith('trash:')) throw refusal('invalid', { reason: 'permanent' });
            const parts = checkPath(raw);
            const parent = this.walk(parts.slice(0, -1));
            const name = parts[parts.length - 1]!;
            const n = parent?.type === 'dir' ? parent.children.get(name) : undefined;
            if (!n || parent?.type !== 'dir') throw refusal('not_found');
            parent.children.delete(name);
            results.push({ path: raw, ok: true, trashId: this.toTrash(n, name, raw) });
          } catch (err) {
            results.push({ path: raw, ok: false, code: (err as { code?: string }).code ?? 'internal' });
          }
        }
        this.emit(null, true, true);
        return { results };
      }
      case 'files.trash.list': {
        const items: TrashItem[] = [...this.trash.values()]
          .sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? 1 : -1))
          .map((t) => ({ id: t.id, name: t.name, originalPath: t.originalPath, type: t.node.type, bytes: this.sizeOf(t.node), deletedAt: new Date(t.deletedAt).toISOString(), purgeAt: new Date(t.deletedAt + THIRTY_DAYS).toISOString() }));
        return { items, next: null };
      }
      case 'files.trash.restore': {
        const t = this.trash.get(str('id'));
        if (!t) throw refusal('not_found');
        const target = checkPath(typeof p['to'] === 'string' ? p['to'] : t.originalPath);
        const parent = this.mkdirp(target.slice(0, -1));
        const name = target[target.length - 1]!;
        if (parent.children.has(name)) {
          let n = 2;
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          while (parent.children.has(`${stem} (${n})${ext}`)) n += 1;
          throw refusal('exists', { kind: parent.children.get(name)!.type, suggest: `${stem} (${n})${ext}` });
        }
        parent.children.set(name, t.node);
        this.trash.delete(t.id);
        this.emit(null, true, true);
        return { path: target.join('/') };
      }
      case 'files.trash.empty': {
        const bytes = this.trashBytes();
        const deleted = this.trash.size;
        this.trash.clear();
        this.emit([], true, true);
        return { deleted, freedBytes: bytes };
      }
      case 'files.read': {
        const parts = checkPath(str('path'));
        const n = this.walk(parts);
        if (!n) throw refusal('not_found');
        if (n.type !== 'file') throw refusal('invalid', { reason: 'is_a_folder' });
        if (!ctx.bulk) throw refusal('unavailable');
        const offset = Math.max(0, Number(p['offset']) || 0);
        this.control.reads.push({ path: parts.join('/'), offset });
        const transferId = ctx.bulk.read(parts.join('/'), n.bytes, offset);
        return { transferId, size: n.bytes.length, mtimeMs: n.mtimeMs };
      }
      case 'files.read.stop':
        ctx.bulk?.stop(Number(p['transferId']));
        return {};
      case 'files.upload.begin':
        return this.begin(p, ctx.bulk);
      case 'files.upload.status': {
        const u = this.uploads.get(str('uploadId'));
        if (!u) throw refusal('not_found');
        u.bulk?.detachUpload(u.transferId ?? -1);
        this.attach(u, ctx.bulk);
        return { uploadId: u.uploadId, path: u.path, size: u.size, committed: u.committed, transferId: u.transferId, window: WINDOW, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
      }
      case 'files.upload.finish':
        return this.finish(p);
      case 'files.upload.abort': {
        const u = this.uploads.get(str('uploadId'));
        if (u) {
          u.bulk?.detachUpload(u.transferId ?? -1);
          u.bulk?.emitCredit(u.transferId ?? -1, { bytes: 0, committed: u.committed, error: 'aborted' });
          this.uploads.delete(u.uploadId);
        }
        return {};
      }
      default:
        throw refusal('not_found');
    }
  }

  private toTrash(n: Node, name: string, originalPath: string): string {
    const id = this.id();
    this.trash.set(id, { id, name, originalPath, node: n, deletedAt: Date.now() });
    return id;
  }

  // ---------- uploads

  private begin(p: Record<string, unknown>, bulk: MockBulk | null): unknown {
    const parts = checkPath(String(p['path'] ?? ''));
    const size = Number(p['size']);
    if (!Number.isSafeInteger(size) || size < 0) throw refusal('bad_request', { reason: 'size' });
    if (!bulk) throw refusal('unavailable');
    const replace = p['replace'] === true;
    const existing = this.walk(parts);
    if (existing && (existing.type === 'dir' || !replace)) throw refusal('exists', { kind: existing.type });
    // The mock keeps what it is sent in memory, so it takes at most a gibibyte: more is the same refusal a full drive gives.
    if (size > 1024 ** 3) throw refusal('no_space', { freeBytes: this.freeBytes(), floorBytes: this.control.floorBytes, needBytes: size });
    if (size > this.uploadable()) throw refusal('no_space', { freeBytes: this.freeBytes(), floorBytes: this.control.floorBytes, needBytes: size });
    const u: Upload = {
      uploadId: this.id(),
      path: parts.join('/'),
      size,
      replace,
      token: typeof p['token'] === 'string' ? p['token'] : null,
      mtimeMs: Number.isFinite(Number(p['mtimeMs'])) ? Number(p['mtimeMs']) : Date.now(),
      bytes: new Uint8Array(Math.min(size, 2 ** 31)),
      committed: 0,
      transferId: null,
      granted: 0,
      lastCredited: 0,
      nextSeq: 0,
      bulk: null,
    };
    this.uploads.set(u.uploadId, u);
    this.attach(u, bulk);
    return { uploadId: u.uploadId, transferId: u.transferId, offset: 0, window: WINDOW, size, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  }

  private attach(u: Upload, bulk: MockBulk | null): void {
    if (!bulk) throw refusal('unavailable');
    u.bulk = bulk;
    u.transferId = bulk.newTransferId();
    u.granted = u.committed + Math.min(WINDOW, u.size - u.committed);
    u.lastCredited = u.committed;
    u.nextSeq = 0;
    bulk.attachUpload(u.transferId, (seq, payload) => this.onFrame(u, bulk, seq, payload));
  }

  private onFrame(u: Upload, bulk: MockBulk, seq: number, payload: Uint8Array): void {
    const id = u.transferId!;
    const stop = (error: string): void => {
      bulk.detachUpload(id);
      bulk.emitCredit(id, { bytes: 0, committed: u.committed, error });
    };
    if (seq !== u.nextSeq) return stop('seq');
    if (u.committed + payload.length > u.granted || u.committed + payload.length > u.size) return stop('credit_violation');
    if (this.freeBytes() - this.control.floorBytes < 0) return stop('no_space');
    u.nextSeq += 1;
    u.bytes.set(payload, u.committed);
    u.committed += payload.length;
    const drop = this.control.dropAfterBytes;
    if (drop !== null && u.committed >= drop) {
      this.control.dropAfterBytes = null;
      this.control.onDrop?.();
      return;
    }
    const credited = u.committed - u.lastCredited;
    if (credited >= CREDIT_STEP || u.committed === u.size) {
      const target = Math.min(u.size, u.committed + WINDOW);
      const more = Math.max(0, target - u.granted);
      u.granted += more;
      u.lastCredited = u.committed;
      const send = (): void => bulk.emitCredit(id, { bytes: more, committed: u.committed });
      if (this.control.ackDelayMs) window.setTimeout(send, this.control.ackDelayMs);
      else send();
    }
  }

  private async finish(p: Record<string, unknown>): Promise<unknown> {
    const u = this.uploads.get(String(p['uploadId']));
    if (!u) throw refusal('not_found');
    // Waits up to 30 s for the last bytes: here a short while.
    for (let i = 0; i < 200 && u.committed < u.size; i += 1) await new Promise((r) => window.setTimeout(r, 5));
    if (u.committed < u.size) throw refusal('conflict', { reason: 'incomplete', committed: u.committed });
    const digest = await sha256(u.bytes.subarray(0, u.size));
    if (digest !== p['sha256']) {
      this.uploads.delete(u.uploadId);
      throw refusal('hash_mismatch', { committed: 0 });
    }
    const sniff = sniffBytes(u.bytes.subarray(0, 4096));
    if (sniff.kind === 'image') {
      const token = typeof p['token'] === 'string' ? p['token'] : u.token;
      if (!token) throw refusal('check_required', { format: sniff.format });
      if (token !== `stub.${digest}`) throw refusal('check_invalid', { reason: token.startsWith('stub.') ? 'hash' : 'signature' });
    }
    const parts = u.path.split('/');
    const existing = this.walk(parts);
    if (existing && (existing.type === 'dir' || !u.replace)) throw refusal('exists', { kind: existing.type });
    const parent = this.mkdirp(parts.slice(0, -1));
    const name = parts[parts.length - 1]!;
    let replaced: string | null = null;
    if (existing) replaced = this.toTrash(existing, name, u.path);
    parent.children.set(name, { type: 'file', mtimeMs: u.mtimeMs, bytes: u.bytes.slice(0, u.size) });
    u.bulk?.detachUpload(u.transferId ?? -1);
    this.uploads.delete(u.uploadId);
    this.control.landed.push({ path: u.path, size: u.size, sha256: digest });
    this.emit([parts.slice(0, -1).join('/')]);
    return { path: u.path, size: u.size, mtimeMs: u.mtimeMs, sha256: digest, replaced };
  }
}

/** The frame size the desk expects of the page, for tests. */
export const MOCK_MAX_PAYLOAD = MAX_PAYLOAD;
export type { BulkChannel };

const desks = new Map<string, MockFilesDesk>();

/** A desk's tree, made on first use with a few files in it (a guild's answers `forbidden`). */
export function mockFiles(deskId: string, guild = false): MockFilesDesk {
  let d = desks.get(deskId);
  if (!d) {
    d = new MockFilesDesk({ guild }).seed();
    // `?filesFull=1` in `npm run dev`: a drive with 60 MB of room above the floor, to see "Not enough room" and the trash it points to.
    if (new URLSearchParams(window.location.search).get('filesFull')) d.control.otherBytes = d.control.totalBytes - d.control.floorBytes - 60 * 1024 * 1024;
    desks.set(deskId, d);
  }
  return d;
}

/** What a dev or a test steers: each desk's tree and its knobs. */
export const filesControl = { desk: (deskId: string, guild = false): MockFilesDesk => mockFiles(deskId, guild), all: (): ReadonlyMap<string, MockFilesDesk> => desks };
