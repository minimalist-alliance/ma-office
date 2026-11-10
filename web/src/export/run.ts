// The whole download (draft ADR "data export and transfer", decisions 1 and 2): the account's records from Platform,
// then each chosen desk in turn over its own session, then README.txt and manifest.json, into one archive written as
// it goes. Nothing is uploaded or kept anywhere of ours.
//
// It can take most of a day, so it's said honestly (the total from every desk's `data.parts.list` before anything is
// copied, and a calm estimate of the time left), and it outlives the page: a journal (`journal.ts`) is written every
// couple of seconds, and a reload carries on from it with the archive cut back to what the journal describes.
import type { DeskLink } from '../desk/deskLink';
import { accountFiles, archiveOrder, readme, type Manifest, type ManifestDesk, type ManifestFile } from './archive';
import { Cancelled, DeskCopy, DeskUnavailable, type DeskCopyResult } from './copier';
import { Eta, timeLeft } from './eta';
import type { JournalDesk, JournalEntry, JournalMeta, JournalStore } from './journal';
import { Sha256, toHex } from './sha256';
import { ZipWriter, type Sink } from './zip';

export interface PlannedDesk {
  deskId: string;
  name: string;
  /** Its folder under `desks/`. */
  folder: string;
}

export type DeskRunPhase = 'waiting' | 'waking' | 'connecting' | 'listing' | 'copying' | 'reconnecting' | 'done' | 'unavailable' | 'refused' | 'stopped' | 'failed' | 'left';

export interface DeskRunState {
  deskId: string;
  name: string;
  phase: DeskRunPhase;
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  notCopied: number;
}

export interface RunState {
  phase: 'running' | 'finishing' | 'done';
  desks: DeskRunState[];
  notCopied: number;
  /** The archive's length, once done. */
  size: number;
  /** Bytes in all, from every desk's estimate until its files are listed, and done so far. */
  total: number;
  done: number;
  /** "About 2 hours left", or null until there's enough to go on. */
  timeLeft: string | null;
}

export interface OpenedDesk {
  link: DeskLink;
  /** The desk is asleep and on its way up: "Waking …" until the session opens. */
  waking: boolean;
  /** When this desk is finished with, however it went. */
  done(): void;
}

export interface RunHooks {
  /** `GET /v1/me/export`, as fresh as it can be. */
  account(): Promise<unknown>;
  /** A link to this desk, open or opening. */
  open(deskId: string): Promise<OpenedDesk>;
  onState(s: RunState): void;
  version: string;
  /** Makes what's in the sink durable before the journal says it's there. */
  sync?(): Promise<void>;
  now?: () => number;
  /** How often the page hears of progress. */
  everyMs?: number;
  /** How often the journal catches up during a desk's copy. */
  checkpointMs?: number;
  /** Hands the page a way to leave a desk out while the download runs: one that won't open, say. */
  control?(c: RunControl): void;
}

export interface RunControl {
  /** The desk ends at once, keeping what it copied, and the others carry on. */
  leaveOut(deskId: string): void;
}

/** The working copy doesn't hold what its journal says (a tab killed mid-cut, say): it can't carry on. */
export class CantCarryOn extends Error {
  constructor() {
    super("the working copy doesn't hold what its journal says");
    this.name = 'CantCarryOn';
  }
}

/** Unreadable, or shorter than the journal: what `ZipWriter.resume` throws when the working copy can't be carried on. */
const unreadable = (err: unknown): boolean => err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OperationError');

export interface RunInput {
  /** The archive's file: empty for a new download, or holding at least `meta.pos` bytes of this one. */
  sink: Sink;
  journal: JournalStore;
  meta: JournalMeta;
  /** The journal's entries, when carrying on. */
  entries?: JournalEntry[];
}

const UNAVAILABLE: Record<DeskUnavailable['reason'], DeskRunPhase> = { helper: 'unavailable', forbidden: 'unavailable', gone: 'stopped', refused: 'refused' };

const NOTES: Record<string, string> = {
  unavailable: "the download isn't available on this desk yet.",
  refused: "the desk couldn't be opened for a download.",
  stopped: 'the desk stopped before everything was copied.',
  failed: "the desk couldn't be read.",
  left: 'it was left out of this download.',
};

const shaOf = (bytes: Uint8Array): string => toHex(new Sha256().update(bytes).digest());

export async function runExport(input: RunInput, hooks: RunHooks, signal: AbortSignal): Promise<RunState> {
  const { sink, journal, meta } = input;
  const now = hooks.now ?? (() => Date.now());
  const madeAt = new Date(meta.madeAt);
  const loaded = input.entries ?? [];
  let zip: ZipWriter;
  try {
    zip = loaded.length || meta.pos ? await ZipWriter.resume(sink, { pos: meta.pos, records: loaded, open: meta.open }) : new ZipWriter(sink);
  } catch (err) {
    throw unreadable(err) ? new CantCarryOn() : err;
  }
  /** Making the archive durable failed: the disk is full, say. Like a failed write, it ends the whole download. */
  let syncFailed: { err: unknown } | null = null;
  const diskFailure = (): { err: unknown } | null => zip.failure ?? syncFailed;

  // Every entry in the journal, and the SHA-256 of each file as it finishes, for the journal and the manifest.
  const saved: JournalEntry[] = [...loaded];
  const inArchive = new Map(loaded.map((e) => [e.name, e.size]));
  const finished = new Map<string, string>();
  let unsaved: JournalEntry[] = [];

  const state: RunState = {
    phase: 'running',
    desks: meta.desks.map((d) => ({
      deskId: d.deskId,
      name: d.name,
      phase: (d.done?.phase as DeskRunPhase | undefined) ?? 'waiting',
      files: d.done?.files ?? 0,
      filesDone: d.done?.files ?? 0,
      bytes: d.done?.bytes ?? 0,
      bytesDone: d.done?.bytes ?? 0,
      notCopied: d.done?.notCopied ?? 0,
    })),
    notCopied: 0,
    size: 0,
    total: 0,
    done: 0,
    timeLeft: null,
  };
  let accountBytes = loaded.filter((e) => e.name.startsWith('account/')).reduce((s, e) => s + e.size, 0);
  const totals = (): void => {
    state.total = accountBytes + state.desks.reduce((s, d) => s + Math.max(d.bytes, d.bytesDone), 0);
    state.done = accountBytes + state.desks.reduce((s, d) => s + d.bytesDone, 0);
  };

  const eta = new Eta();
  let sampling = false;
  const sampler = window.setInterval(() => {
    totals();
    if (!sampling) return;
    eta.sample(now(), state.done, state.total);
    state.timeLeft = timeLeft(eta.left());
  }, 1000);

  let timer = 0;
  const flush = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    totals();
    hooks.onState({ ...state, desks: state.desks.map((d) => ({ ...d })) });
  };
  const emit = (soon = false): void => {
    if (soon) flush();
    else timer ||= window.setTimeout(flush, hooks.everyMs ?? 250);
  };

  let current: DeskCopy | null = null;
  let running = -1;
  const opened = new Map<number, { desk: OpenedDesk; copy: DeskCopy }>();
  /** The journal catches up with the archive: only what the sink holds is written down. */
  const checkpoint = async (): Promise<void> => {
    const c = await zip.checkpoint();
    const head = current?.headState() ?? null;
    let pos = c.pos;
    let open: JournalMeta['open'] = null;
    if (c.open) {
      if (head && head.name === c.open.name && head.size === c.open.size) open = { ...c.open, part: head.part, path: head.path, sha: head.sha };
      else pos = c.open.start; // nothing to carry on that file with: it starts again
    }
    const add = [...unsaved, ...c.records.map((r) => (finished.has(r.name) ? { ...r, sha256: finished.get(r.name) } : r))];
    totals();
    const next: JournalMeta = { ...meta, pos, open, doneBytes: state.done, totalBytes: state.total };
    try {
      await hooks.sync?.();
    } catch (err) {
      syncFailed ??= { err };
      throw err;
    }
    try {
      await journal.save(next, add);
      Object.assign(meta, next);
      saved.push(...add);
      unsaved = [];
    } catch {
      unsaved = add; // tried again at the next one, and the journal still describes an archive that's there
    }
  };

  const todo = meta.desks.map((d, i) => ({ d, i })).filter(({ d }) => !d.done);
  /** Each desk's own stop: the member leaving it out, or the whole download stopping. */
  const own = new Map(todo.map(({ i }) => [i, new AbortController()]));
  const stopAll = (): void => {
    for (const ac of own.values()) ac.abort();
  };
  signal.addEventListener('abort', stopAll);

  emit(true);
  try {
    // The account's records first, unless they're in the archive from before a reload.
    if (!inArchive.has('account/account.json')) {
      for (const [name, text] of accountFiles(await hooks.account())) {
        const bytes = new TextEncoder().encode(text);
        await zip.add(name, bytes, { mtimeMs: madeAt.getTime() });
        finished.set(name, shaOf(bytes));
        accountBytes += bytes.length;
      }
      await checkpoint();
    }

    // Every desk still to do is asked for its size at once, so the total means something, and each is copied as soon as
    // it has answered: one that never opens holds nobody up, and the member can leave it out.
    const failed = new Map<number, unknown>();
    hooks.control?.({
      leaveOut: (deskId) => {
        const i = meta.desks.findIndex((d) => d.deskId === deskId);
        own.get(i)?.abort();
      },
    });
    const survey = async ({ d, i }: { d: JournalDesk; i: number }): Promise<void> => {
      const ds = state.desks[i]!;
      const mine = own.get(i)!.signal;
      ds.phase = 'connecting';
      let desk: OpenedDesk;
      try {
        desk = await hooks.open(d.deskId);
      } catch (err) {
        failed.set(i, err);
        return;
      }
      if (mine.aborted) {
        desk.done(); // left out, or stopped, while it opened
        return;
      }
      let waking = desk.waking && desk.link.status() !== 'open';
      let surveyed = false;
      ds.phase = waking ? 'waking' : 'connecting';
      emit();
      const root = `desks/${d.folder}/`;
      const open = meta.open?.name.startsWith(root) ? { name: meta.open.name, size: meta.open.size, sha: meta.open.sha } : null;
      const copy = new DeskCopy(
        desk.link,
        zip,
        root,
        (p) => {
          if (p.phase !== 'connecting') waking = false;
          // Only the desk being copied says what it's doing; the others, once they've said their size, wait.
          if (ds.phase === 'left') return;
          ds.phase = running === i ? p.phase : waking ? 'waking' : surveyed ? 'waiting' : 'connecting';
          if (p.files || p.bytes) {
            ds.files = p.files;
            ds.bytes = p.bytes;
          }
          ds.filesDone = p.filesDone;
          ds.bytesDone = p.bytesDone;
          emit();
        },
        mine,
        undefined,
        { skip: inArchive, open, checkpoint, finished, ...(hooks.checkpointMs !== undefined ? { checkpointMs: hooks.checkpointMs } : {}) },
      );
      opened.set(i, { desk, copy });
      try {
        const est = await copy.survey();
        ds.files = Math.max(ds.files, est.files);
        ds.bytes = Math.max(ds.bytes, est.bytes);
        waking = false;
        surveyed = true;
        ds.phase = 'waiting';
      } catch (err) {
        failed.set(i, err);
      }
      emit();
    };
    /** Desks that have answered, or been left out, and so can be taken in turn. */
    const ready = new Set<number>();
    let poke = (): void => {};
    for (const t of todo) {
      const settle = (): void => {
        ready.add(t.i);
        poke();
      };
      void survey(t).finally(settle);
      own.get(t.i)!.signal.addEventListener('abort', settle);
    }

    const left = new Set(todo.map(({ i }) => i));
    while (left.size) {
      if (signal.aborted) throw new Cancelled();
      // In the plan's order, among those ready.
      const next = todo.find(({ i }) => left.has(i) && ready.has(i));
      if (!next) {
        await new Promise<void>((r) => {
          poke = r;
        });
        continue;
      }
      const { d, i } = next;
      left.delete(i);
      const ds = state.desks[i]!;
      const mine = own.get(i)!.signal;
      const o = opened.get(i);
      let result: DeskCopyResult = { files: [], links: [], notCopied: [], parts: [] };
      const err = failed.get(i);
      const runs = !!o && err === undefined && !mine.aborted;
      // An entry a reload left open belongs to the desk it's under; if that desk can't carry it on, it goes.
      if (zip.openName && !(runs && zip.openName.startsWith(`desks/${d.folder}/`))) await zip.rewind();
      if (o && runs) {
        current = o.copy;
        running = i;
        sampling = true;
        try {
          result = await o.copy.run();
          ds.phase = 'done';
        } catch (e) {
          if (signal.aborted) throw new Cancelled();
          // The disk, not the desk: the download can't go on, and says so with the browser's own error.
          const disk = diskFailure();
          if (disk) throw disk.err;
          result = o.copy.partial();
          if (mine.aborted) {
            ds.phase = 'left';
            await zip.rewind(); // the file it was on, as a cancel leaves it open
          } else {
            ds.phase = e instanceof DeskUnavailable ? UNAVAILABLE[e.reason] : 'failed';
            if (!(e instanceof DeskUnavailable)) console.warn(`Export: ${d.deskId}:`, e);
          }
        } finally {
          current = null;
          running = -1;
        }
      } else if (mine.aborted) {
        ds.phase = 'left';
      } else {
        ds.phase = err instanceof DeskUnavailable ? UNAVAILABLE[err.reason] : 'failed';
        if (err !== undefined && !(err instanceof DeskUnavailable)) console.warn(`Export: ${d.deskId}:`, err);
      }
      o?.desk.done();
      opened.delete(i);
      ds.notCopied = result.notCopied.length;
      const note = ds.phase === 'done' ? undefined : NOTES[ds.phase];
      const desk: JournalDesk = {
        ...d,
        done: { phase: ds.phase, files: ds.filesDone - ds.notCopied, bytes: ds.bytesDone, notCopied: ds.notCopied, ...(note ? { note } : {}), parts: result.parts, links: result.links, notCopiedList: result.notCopied },
      };
      meta.desks = meta.desks.map((x) => (x.deskId === d.deskId ? desk : x));
      await checkpoint();
      emit(true);
    }
    if (signal.aborted) throw new Cancelled();
    state.phase = 'finishing';
    state.timeLeft = null;
    emit(true);
    await checkpoint();
    const desks = meta.desks.map((d) => d.done);
    const notCopied = desks.flatMap((d) => d?.notCopiedList ?? []);
    const incomplete = meta.desks.filter((d) => d.done?.note).map((d) => `${d.name}: ${d.done?.note}`);
    const readmeBytes = new TextEncoder().encode(readme({
        madeAt,
        desks: meta.desks.map((d) => d.name),
        notCopied: notCopied.length,
        incomplete,
        accountNames: [...saved, ...unsaved].map((e) => e.name).filter((n) => n.startsWith('account/')),
        ...(meta.encrypted ? { encrypted: true } : {}),
      }));
    await zip.add('README.txt', readmeBytes, { mtimeMs: madeAt.getTime() });
    const files: ManifestFile[] = [
      { path: 'README.txt', size: readmeBytes.length, sha256: shaOf(readmeBytes) },
      ...[...saved, ...unsaved].filter((e) => !e.dir && e.sha256).map((e) => ({ path: e.name, size: e.size, sha256: e.sha256 as string })),
    ];
    const manifest: Manifest = {
      format: 1,
      madeAt: madeAt.toISOString(),
      madeBy: `Minimalist Alliance office ${hooks.version}`,
      desks: meta.desks.map(
        (d): ManifestDesk => ({ deskId: d.deskId, name: d.name, folder: `desks/${d.folder}/`, complete: d.done?.phase === 'done' && !d.done.notCopied, ...(d.done?.note ? { note: d.done.note } : {}), parts: d.done?.parts ?? [] }),
      ),
      files,
      links: desks.flatMap((d) => d?.links ?? []),
      notCopied,
    };
    await zip.add('manifest.json', new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`), { mtimeMs: madeAt.getTime() });
    state.size = await zip.finish(archiveOrder);
    await hooks.sync?.();
    state.notCopied = notCopied.length;
    state.phase = 'done';
    emit(true);
    return state;
  } finally {
    window.clearTimeout(timer);
    window.clearInterval(sampler);
    signal.removeEventListener('abort', stopAll);
    stopAll(); // a desk still opening or listing lets go
    for (const { desk } of opened.values()) desk.done();
  }
}
