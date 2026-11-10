// Where the archive is written as it arrives: sealed records in this browser's private storage, in place, so a reload
// or a closed tab can carry on (`opfsWorker.ts`, `seal.ts`), then decrypted only as it's copied out into the file the
// member chose, or into the download. Where a worker can't have that storage, straight into the chosen file instead.
import { EXPORT_WORKING } from '../platform/exportSweep';
import { encryptStream } from './passphrase';
import { unseal, type Blocks } from './seal';
import type { Sink } from './zip';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
type WithPicker = Window & { showSaveFilePicker?: (o?: SaveFilePickerOptions) => Promise<FileSystemFileHandle> };

export const canPickFile = (): boolean => typeof (window as WithPicker).showSaveFilePicker === 'function';

/** Whether a download here can outlive the page: a worker, and the private storage to write in place. */
export const canResume = (): boolean => typeof Worker === 'function' && typeof navigator.storage?.getDirectory === 'function';

/** The working copy, through `opfsWorker.ts`: positional, durable on `flush`, and locked to this tab while open. */
export class WorkerBlocks implements Blocks {
  private readonly worker: Worker;
  private length = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: number | ArrayBuffer | undefined) => void; reject: (e: Error) => void }>();

  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: number | ArrayBuffer; name?: string; message?: string }>) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      if (e.data.ok) w.resolve(e.data.result);
      else w.reject(new DOMException(e.data.message ?? 'failed', e.data.name ?? 'Error'));
    };
    worker.onerror = () => {
      for (const w of this.waiting.values()) w.reject(new DOMException('the storage worker stopped', 'InvalidStateError'));
      this.waiting.clear();
    };
  }

  /** Empty for a new download, or as it is (`keep`) to carry one on. */
  static async open(keep: boolean): Promise<WorkerBlocks> {
    const b = new WorkerBlocks(new Worker(new URL('./opfsWorker.ts', import.meta.url), { type: 'module' }));
    try {
      b.length = Number(await b.call({ op: 'open', name: EXPORT_WORKING, keep })) || 0;
      return b;
    } catch (err) {
      b.worker.terminate();
      throw err;
    }
  }

  size(): number {
    return this.length;
  }

  async writeAt(at: number, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice();
    this.length = Math.max(this.length, at + bytes.length);
    await this.call({ op: 'write', at, bytes: copy.buffer }, [copy.buffer]);
  }

  async read(at: number, len: number): Promise<Uint8Array> {
    return new Uint8Array((await this.call({ op: 'read', at, len })) as ArrayBuffer);
  }

  async truncate(size: number): Promise<void> {
    this.length = Math.min(this.length, size);
    await this.call({ op: 'truncate', size });
  }

  async flush(): Promise<void> {
    await this.call({ op: 'flush' });
  }

  /** Lets go of the file, for another tab or a later visit. */
  async close(): Promise<void> {
    try {
      await this.call({ op: 'close' });
    } finally {
      this.worker.terminate();
    }
  }

  private call(m: Record<string, unknown>, transfer: Transferable[] = []): Promise<number | ArrayBuffer | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ ...m, id }, transfer);
    });
  }
}

/** The finished archive, decrypted record by record into the file the member chose. */
export async function copyInto(blocks: WorkerBlocks, key: CryptoKey, target: FileSystemFileHandle, passphrase?: string): Promise<void> {
  const w = await target.createWritable({ keepExistingData: false });
  try {
    const src = unseal(blocks, blocks.size(), key);
    for await (const out of passphrase ? encryptStream(src, passphrase) : src) await w.write(out as Uint8Array<ArrayBuffer>);
    await w.close();
  } catch (err) {
    await w.abort().catch(() => {});
    throw err;
  }
}

/** The finished archive, decrypted into the download: a Blob, in the browser's own blob storage while the page lasts. */
export async function intoDownload(blocks: WorkerBlocks, key: CryptoKey, passphrase?: string): Promise<string> {
  const parts: Blob[] = [];
  const src = unseal(blocks, blocks.size(), key);
  for await (const out of passphrase ? encryptStream(src, passphrase) : src) parts.push(new Blob([out as Uint8Array<ArrayBuffer>]));
  return URL.createObjectURL(new Blob(parts, { type: passphrase ? 'application/octet-stream' : 'application/zip' }));
}

/** Asks where to save, straight from the click. Undefined with no picker, null if they chose not to. */
export async function pickHandle(name: string, encrypted = false): Promise<FileSystemFileHandle | null | undefined> {
  const pick = (window as WithPicker).showSaveFilePicker;
  if (!pick) return undefined;
  try {
    return await pick.call(window, { suggestedName: name, types: encrypted ? [{ description: 'Encrypted archive', accept: { 'application/octet-stream': ['.enc'] } }] : [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Write permission for a handle kept across a reload. It asks the member, so it must come from their click. */
export async function mayWrite(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as FileSystemFileHandle & { queryPermission?(o: { mode: string }): Promise<string>; requestPermission?(o: { mode: string }): Promise<string> };
  try {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return true;
    return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Without a worker: straight into the chosen file, the member's own, as it arrives. It can't carry on after a reload. */
export async function straightInto(handle: FileSystemFileHandle): Promise<{ sink: Sink; close(): Promise<void>; abort(): Promise<void> }> {
  const w = await handle.createWritable({ keepExistingData: false });
  return { sink: { write: (b) => w.write(b as Uint8Array<ArrayBuffer>), truncate: (n) => w.truncate(n) }, close: () => w.close(), abort: () => w.abort() };
}
