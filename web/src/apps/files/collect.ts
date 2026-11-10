// What the member picked or dropped, as files with the paths they should land at. The directory picker (`webkitdirectory`)
// gives each file a `webkitRelativePath`; a drop gives `DataTransferItem.webkitGetAsEntry()`, which has to be asked of every
// item synchronously inside the drop event, before anything is awaited, or the browser takes the items back. Names are made
// NFC (deskd refuses anything else), and anything the grammar can't take is left out and counted, never renamed on the quiet.
import { join, nameProblem, nfc, pathFits } from './paths';

export interface Pick {
  file: File;
  /** Relative to the folder it lands in, `/`-separated, NFC. */
  rel: string;
}

export interface Collected {
  files: Pick[];
  /** Folders with nothing in them, relative to the target folder: made so they come across too. */
  emptyDirs: string[];
  /** Items left out: a name the desk can't take. */
  skipped: number;
}

const empty = (): Collected => ({ files: [], emptyDirs: [], skipped: 0 });

/** Whether a relative path is one the desk can take, all its parts. */
export function relFits(rel: string, under: string): boolean {
  const parts = rel.split('/');
  for (const p of parts) if (nameProblem(p, under === '' && parts[0] === p) !== null) return false;
  return pathFits(join(under, rel));
}

/** From `<input type=file>` (with or without `webkitdirectory`). */
export function fromInput(list: FileList | File[], under: string): Collected {
  const out = empty();
  for (const file of Array.from(list)) {
    const rel = nfc((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
    if (relFits(rel, under)) out.files.push({ file, rel });
    else out.skipped += 1;
  }
  return out;
}

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, fail: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: Entry[]) => void, fail: (e: unknown) => void): void };
}

/** Call inside the `drop` event, synchronously. The entries are read afterwards. */
export function entriesOf(items: DataTransferItemList): { entries: Entry[]; plain: File[] } {
  const entries: Entry[] = [];
  const plain: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) plain.push(f);
    }
  }
  return { entries, plain };
}

async function walk(entry: Entry, prefix: string, under: string, out: Collected): Promise<void> {
  const name = nfc(entry.name);
  const rel = prefix ? `${prefix}/${name}` : name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail)).catch(() => null);
    if (!file) out.skipped += 1;
    else if (relFits(rel, under)) out.files.push({ file, rel });
    else out.skipped += 1;
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  if (!relFits(rel, under)) {
    out.skipped += 1;
    return;
  }
  const reader = entry.createReader();
  let any = false;
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail)).catch(() => []);
    if (!batch.length) break;
    any = true;
    for (const child of batch) await walk(child, rel, under, out);
  }
  if (!any) out.emptyDirs.push(rel);
}

/** The entries `entriesOf` gave, walked: folders to their depth. */
export async function fromEntries(got: { entries: Entry[]; plain: File[] }, under: string): Promise<Collected> {
  const out = empty();
  for (const file of got.plain) {
    const rel = nfc(file.name);
    if (relFits(rel, under)) out.files.push({ file, rel });
    else out.skipped += 1;
  }
  for (const entry of got.entries) await walk(entry, '', under, out);
  return out;
}
