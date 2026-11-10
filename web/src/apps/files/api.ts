// The Files calls over one desk link (services/deskd/docs/files.md), with the one thing every mutation needs: an `idem` key
// that stays the same across a retry of a lost reply. It imports nothing from the desk's modules but their types: this chunk is lazy,
// and a value it shared with the initial chunk would change how the bundle is split (the 250 KB budget, `scripts/build-release.mjs`).
// A link that isn't there throws `DeskNotConnected`, told by its name.
// Errors are turned into `FilesError`, whose words never name a file
// (deskd's details carry codes only), and the plain-words table is `words.ts`.
import type { DeskLink, DeskRpc, FileEntry, FilesUsage, FileSniff, TrashItem } from '../../desk/deskLink';

export class FilesError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  /** The link wasn't there, or went before the reply: nothing may be assumed done (`inFlight`). */
  readonly offline: boolean;
  readonly inFlight: boolean;

  constructor(code: string, details: Record<string, unknown> = {}, offline = false, inFlight = false) {
    super(`files: ${code}`);
    this.name = 'FilesError';
    this.code = code;
    this.details = details;
    this.offline = offline;
    this.inFlight = inFlight;
  }
}

/** `DeskNotConnected` (`desk/deskLink.ts`): no open link, or it went before the answer (`inFlight`). */
export const isNotConnected = (err: unknown): boolean => err instanceof Error && err.name === 'DeskNotConnected';

/** Anything a call throws, as a `FilesError`. */
export function toFilesError(err: unknown): FilesError {
  if (err instanceof FilesError) return err;
  if (isNotConnected(err)) return new FilesError('unavailable', {}, true, (err as { inFlight?: boolean }).inFlight === true);
  const e = err as { code?: unknown; details?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : 'internal';
  const details = e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  return new FilesError(code, details);
}

/** Asked of the root: an old deskd answers `not_found` to the method itself, and a guild desk or another scope `forbidden`. */
export const cannotDoFiles = (err: FilesError): boolean => err.code === 'not_found' || err.code === 'forbidden';

export interface Listing {
  entries: FileEntry[];
  skipped: number;
}

export interface MutationOptions {
  idem?: string;
  deadlineMs?: number;
}

const LONG_DEADLINE_MS = 10 * 60_000;

export class FilesApi {
  /** `idem` makes a UUIDv7 (`desk/idem.ts`), handed in so this module shares nothing with it. */
  constructor(
    readonly link: DeskLink,
    readonly idem: () => string,
  ) {}

  private async call<M extends keyof DeskRpc>(method: M, params: Record<string, unknown>, options?: MutationOptions & { mutation?: boolean }): Promise<DeskRpc[M]> {
    try {
      const idem = options?.mutation ? (options.idem ?? this.idem()) : undefined;
      return await this.link.call(method, params, { ...(idem ? { idem } : {}), ...(options?.deadlineMs ? { deadlineMs: options.deadlineMs } : {}) });
    } catch (err) {
      throw toFilesError(err);
    }
  }

  /** Every page of a folder (2,000 an entry page), until `next` is null. */
  async list(path: string): Promise<Listing> {
    const entries: FileEntry[] = [];
    let cursor: string | null = null;
    let skipped = 0;
    do {
      const page: DeskRpc['files.list'] = await this.call('files.list', { path, ...(cursor ? { cursor } : {}) });
      entries.push(...page.entries);
      skipped = page.skipped;
      cursor = page.next;
    } while (cursor);
    return { entries, skipped };
  }

  stat(path: string): Promise<{ entry: FileEntry; sniff: FileSniff | null }> {
    return this.call('files.stat', { path });
  }

  search(q: string, under = ''): Promise<DeskRpc['files.search']> {
    return this.call('files.search', { q, under, limit: 100 });
  }

  usage(): Promise<FilesUsage> {
    return this.call('files.usage', {});
  }

  mkdir(path: string, options?: MutationOptions & { parents?: boolean }): Promise<{ created: boolean }> {
    return this.call('files.mkdir', { path, ...(options?.parents ? { parents: true } : {}) }, { ...options, mutation: true });
  }

  rename(from: string, to: string, options?: MutationOptions & { replace?: boolean }): Promise<{ path: string; replaced: string | null }> {
    return this.call('files.rename', { from, to, ...(options?.replace ? { replace: true } : {}) }, { ...options, mutation: true });
  }

  /** To the trash, up to 200 paths at a time. Each succeeds or fails alone. */
  async remove(paths: readonly string[]): Promise<DeskRpc['files.delete']['results']> {
    const out: DeskRpc['files.delete']['results'] = [];
    for (let i = 0; i < paths.length; i += 200) out.push(...(await this.call('files.delete', { paths: paths.slice(i, i + 200) }, { mutation: true })).results);
    return out;
  }

  /** For good, trash items only (`trash:<id>`). */
  async deleteForGood(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 200) await this.call('files.delete', { paths: ids.slice(i, i + 200).map((id) => `trash:${id}`), permanent: true }, { mutation: true });
  }

  async trashList(): Promise<TrashItem[]> {
    const items: TrashItem[] = [];
    let cursor: string | null = null;
    do {
      const page: DeskRpc['files.trash.list'] = await this.call('files.trash.list', cursor ? { cursor } : {});
      items.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return items;
  }

  restore(id: string, to?: string): Promise<{ path: string }> {
    return this.call('files.trash.restore', { id, ...(to ? { to } : {}) }, { mutation: true });
  }

  emptyTrash(): Promise<{ deleted: number; freedBytes: number }> {
    return this.call('files.trash.empty', {}, { mutation: true, deadlineMs: LONG_DEADLINE_MS });
  }

  // Transfers (the engine drives these; they live here so there is one place that knows the shapes).
  readStart(path: string, offset: number): Promise<DeskRpc['files.read']> {
    return this.call('files.read', { path, ...(offset ? { offset } : {}) }, { deadlineMs: 120_000 });
  }

  readStop(transferId: number): Promise<unknown> {
    return this.call('files.read.stop', { transferId }).catch(() => undefined);
  }

  uploadBegin(params: { path: string; size: number; replace?: boolean; sha256?: string; token?: string; mtimeMs?: number }, idem: string): Promise<DeskRpc['files.upload.begin']> {
    return this.call('files.upload.begin', params, { mutation: true, idem });
  }

  uploadStatus(uploadId: string, idem: string): Promise<DeskRpc['files.upload.status']> {
    return this.call('files.upload.status', { uploadId }, { mutation: true, idem });
  }

  uploadFinish(params: { uploadId: string; sha256: string; size: number; token?: string }, idem: string): Promise<DeskRpc['files.upload.finish']> {
    return this.call('files.upload.finish', params, { mutation: true, idem, deadlineMs: 120_000 });
  }

  uploadAbort(uploadId: string): Promise<unknown> {
    return this.call('files.upload.abort', { uploadId }, { mutation: true }).catch(() => undefined);
  }
}
