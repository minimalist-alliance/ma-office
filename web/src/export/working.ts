// One download's working copy, from its key to its end: sealed records in the private storage (`seal.ts`), a sealed
// journal in IndexedDB (`journal.ts`), and the key beside it, non-extractable. All three go together (`dropExport`):
// when the archive is saved, on Discard or Stop, at sign-out, when someone else signs in, and after 6 hours without
// progress with no tab writing it. Each is the member's who started it (`owner`, a tag of their id), and only theirs.
import { dropExport, EXPORT_DB, exportExpired, markExportOwner, markExportProgress } from '../platform/exportSweep';
import { IdbKv, MemoryJournal, SealedJournal, type JournalEntry, type JournalMeta, type JournalStore, type Secret } from './journal';
import { newKey, Nonces, OVERHEAD, RECORD, SealedSink, SLOT } from './seal';
import { copyInto, intoDownload, straightInto, WorkerBlocks } from './sink';
import type { Sink } from './zip';

export interface Working {
  sink: Sink;
  journal: JournalStore;
  sync?: () => Promise<void>;
  /** Deleted from outside while it runs (sign-out, Discard or the 6 hours, maybe in another tab): it must stop. */
  onGone?: (fn: () => void) => void;
  /**
   * The archive is whole: put it where it goes. A null url means it's in the member's own file. A url lasts until
   * `clear` (Done), `close` (the page goes) or `gone` (the sealed copy deleted from anywhere: a sign-out, say). With a
   * passphrase the archive is encrypted with it first.
   */
  finish(meta: JournalMeta, saving: () => void, gone: () => void, passphrase?: string): Promise<Finished>;
  /** Stopped by the member: nothing left behind. */
  discard(): Promise<void>;
  /** Failed, or the app left the page: what's there stays, sealed, to carry on. */
  release(): Promise<void>;
}

export interface Finished {
  url: string | null;
  /** Done: the url and the sealed copy both go. */
  clear: (() => Promise<void>) | null;
  /** The page goes: the url goes, and the sealed copy stays to come back for. */
  close: () => void;
}

/** Thrown where another tab is writing the download. */
const elsewhere = (): DOMException => new DOMException('another tab is writing the download', 'NoModificationAllowedError');

/**
 * One tab at a time writes a download, holding the `ma-export` Web Lock, so another tab never deletes or overwrites
 * it by starting or finding one. Null if another tab holds it. Deleting it (sign-out, Discard, the 6 hours) needs no lock.
 */
function takeLock(): Promise<(() => void) | null> {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(EXPORT_DB, { ifAvailable: true }, (lock) => (lock ? new Promise<void>((release) => resolve(release)) : resolve(null)))
      .catch(reject);
  });
}

function sealed(kv: IdbKv, blocks: WorkerBlocks, secret: Secret, nonces: Nonces, unlock: () => void): Working {
  const sink = new SealedSink(blocks, secret.key, nonces);
  /** The working copy and the lock, for another tab or a later visit. */
  const let_go_of_file = async (): Promise<void> => {
    await blocks.close().catch(() => {});
    unlock();
  };
  const let_go = async (): Promise<void> => {
    kv.onGone = null;
    await let_go_of_file();
    kv.close();
  };
  return {
    sink,
    journal: new SealedJournal(kv, secret, nonces),
    sync: () => sink.flush(),
    onGone: (fn) => {
      kv.onGone = fn;
    },
    async finish(meta, saving, gone, passphrase) {
      await sink.flush();
      saving();
      if (meta.target === 'file' && meta.handle) {
        try {
          await copyInto(blocks, secret.key, meta.handle, passphrase);
          await let_go();
          await dropExport(); // saved: nothing of it stays here
          return { url: null, clear: null, close: () => {} };
        } catch {
          // offered from here instead: the archive is whole either way
        }
      }
      const url = await intoDownload(blocks, secret.key, passphrase);
      await let_go_of_file();
      // The sealed copy stays until Done, so a member who goes before saving can come back for it. The decrypted one
      // goes with it, from whichever tab deletes it: a sign-out anywhere leaves nothing here to save.
      let over = false;
      const close = (): void => {
        if (over) return;
        over = true;
        kv.onGone = null;
        kv.close();
        URL.revokeObjectURL(url);
      };
      kv.onGone = () => {
        close();
        gone();
      };
      return {
        url,
        clear: async () => {
          close();
          await dropExport();
        },
        close,
      };
    },
    async discard() {
      await let_go();
      await dropExport();
    },
    async release() {
      await sink.flush().catch(() => {});
      await let_go();
    },
  };
}

/** A new download, the member's (`owner`): whatever was here goes first, then a new key at epoch 1 and an empty working copy. */
export async function startWorking(handle: FileSystemFileHandle | undefined, owner: string, now = Date.now()): Promise<Working> {
  const unlock = await takeLock();
  if (!unlock) throw elsewhere();
  let kv: IdbKv | null = null;
  try {
    await dropExport();
    markExportOwner(owner);
    markExportProgress(now);
    kv = await IdbKv.open();
    const secret: Secret = { key: await newKey(), epoch: 1, at: now, owner, ...(handle ? { handle } : {}) };
    await kv.putSecret(secret);
    return sealed(kv, await WorkerBlocks.open(false), secret, new Nonces(1), unlock);
  } catch (err) {
    kv?.close();
    await dropExport();
    unlock();
    throw err;
  }
}

/**
 * The member's (`owner`) download left here, its journal opened to read, or null. One that's someone else's, that has
 * gone 6 hours without progress, or that can't be read, is deleted instead, and so is anything stray with no journal.
 */
export async function findPartial(owner: string, now = Date.now()): Promise<{ meta: JournalMeta; entries: JournalEntry[] } | null> {
  const unlock = await takeLock().catch(() => null);
  if (!unlock) return null; // another tab is writing it, or no locks here
  try {
    let kv: IdbKv;
    try {
      kv = await IdbKv.open();
    } catch {
      return null; // no IndexedDB here
    }
    let found: { meta: JournalMeta; entries: JournalEntry[] } | null = null;
    try {
      const secret = await kv.getSecret();
      if (secret && secret.owner === owner && !exportExpired(secret.at, now)) found = await new SealedJournal(kv, secret, null).load();
    } catch {
      found = null;
    }
    kv.close();
    if (!found) await dropExport();
    return found;
  } finally {
    unlock();
  }
}

/**
 * Carrying a download on: a new epoch is written before anything is sealed, so no IV is ever used twice, and the
 * working copy must hold everything the journal says it does.
 */
export async function resumeWorking(meta: JournalMeta, owner: string): Promise<Working> {
  const unlock = await takeLock();
  if (!unlock) throw elsewhere();
  let kv: IdbKv | null = null;
  let blocks: WorkerBlocks | null = null;
  try {
    kv = await IdbKv.open();
    const secret = await kv.getSecret();
    if (!secret || secret.owner !== owner) throw new DOMException('no key for this download', 'NotFoundError');
    const next: Secret = { ...secret, epoch: secret.epoch + 1 };
    await kv.putSecret(next);
    blocks = await WorkerBlocks.open(true);
    const whole = Math.floor(meta.pos / RECORD) * SLOT;
    const part = meta.pos % RECORD;
    if (blocks.size() < whole + (part ? OVERHEAD + part : 0)) throw new DOMException('the working copy is shorter than its journal', 'NotFoundError');
    return sealed(kv, blocks, next, new Nonces(next.epoch), unlock);
  } catch (err) {
    await blocks?.close().catch(() => {});
    kv?.close();
    unlock();
    throw err;
  }
}

/** Where a worker can't write the private storage: straight into the member's chosen file, and gone with the page. */
export async function oneGo(handle: FileSystemFileHandle): Promise<Working> {
  const t = await straightInto(handle);
  return {
    sink: t.sink,
    journal: new MemoryJournal(),
    async finish() {
      await t.close();
      return { url: null, clear: null, close: () => {} };
    },
    discard: () => t.abort(),
    release: () => t.abort(),
  };
}
