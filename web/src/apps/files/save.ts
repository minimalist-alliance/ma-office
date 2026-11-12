// Where a download goes. Where the browser has a save-file picker, straight into the file the member chose, as it arrives
// (so a 20 GB file is never held in memory). Elsewhere, into pieces the browser keeps in its own blob storage, then handed
// over as an ordinary download. The picker must be asked from the member's click, so `askWhere` is called first, before
// anything is awaited.
import type { Sink } from '../../export/zip';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
type WithPicker = Window & { showSaveFilePicker?: (o?: SaveFilePickerOptions) => Promise<FileSystemFileHandle> };

export const canPickFile = (): boolean => typeof (window as WithPicker).showSaveFilePicker === 'function';

/** Asks where to save. `undefined`: this browser can't ask. `null`: the member chose not to. */
export async function askWhere(name: string, folder: boolean): Promise<FileSystemFileHandle | null | undefined> {
  const pick = (window as WithPicker).showSaveFilePicker;
  if (!pick) return undefined;
  try {
    const dot = name.lastIndexOf('.');
    const ext = !folder && dot > 0 && dot < name.length - 1 && /^\.[A-Za-z0-9]{1,12}$/.test(name.slice(dot)) ? name.slice(dot) : null;
    const types = folder ? [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] : ext ? [{ accept: { 'application/octet-stream': [ext] } }] : undefined;
    return await pick.call(window, { suggestedName: name, ...(types ? { types } : {}) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

export interface Target {
  sink: Sink;
  /** All written: close the file, or hand the download over. */
  finish(): Promise<void>;
  /** Give up: nothing is left half-saved where the browser lets us take it back. */
  abort(): Promise<void>;
  /** Where it went, for the live region. */
  where: 'chosen file' | 'downloads';
}

export const DOWNLOAD_TYPE = 'application/octet-stream';

/** Pieces of 1 MiB in blob storage, cut back by slicing. */
export class BlobSink implements Sink {
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  length = 0;

  write(bytes: Uint8Array): Promise<void> {
    this.pending.push(bytes.slice());
    this.pendingBytes += bytes.length;
    this.length += bytes.length;
    if (this.pendingBytes >= 1024 * 1024) this.flush();
    return Promise.resolve();
  }

  truncate(size: number): Promise<void> {
    this.flush();
    this.parts = [new Blob(this.parts).slice(0, size)];
    this.length = size;
    return Promise.resolve();
  }

  /** Always `application/octet-stream`: a blob the office makes never carries a type from desk data (ADR 0054). */
  blob(): Blob {
    this.flush();
    return new Blob(this.parts, { type: DOWNLOAD_TYPE });
  }

  private flush(): void {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingBytes = 0;
  }
}

function startDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function openTarget(handle: FileSystemFileHandle | null | undefined, name: string): Promise<Target> {
  if (handle) {
    const w = await handle.createWritable({ keepExistingData: false });
    return {
      sink: { write: (b) => w.write(b as Uint8Array<ArrayBuffer>), truncate: (n) => w.truncate(n) },
      finish: () => w.close(),
      abort: () => w.abort().catch(() => undefined),
      where: 'chosen file',
    };
  }
  const sink = new BlobSink();
  return { sink, finish: () => Promise.resolve(startDownload(sink.blob(), name)), abort: () => Promise.resolve(), where: 'downloads' };
}
