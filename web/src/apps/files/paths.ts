// The Files tree's path grammar (services/deskd/docs/files.md section 0), checked here first so the member hears what is wrong
// in plain words before anything is sent. deskd checks again and never rewrites a name: a non-NFC one is refused, so the web
// normalizes before it sends. Paths are relative to the tree, `/`-separated; the root is "".

export const MAX_NAME_BYTES = 255;
export const MAX_PATH_BYTES = 1024;
/** Names that can't be made or named at the root. */
export const RESERVED: readonly string[] = ['.uploads', '.trash'];

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;

export type NameProblem = 'empty' | 'length' | 'chars' | 'dots' | 'reserved';

const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\\‪-‮⁦-⁩/]/u;

/** The first thing wrong with one name, or null. `atRoot`: the folder is the root, where two names are reserved. */
export function nameProblem(name: string, atRoot = false): NameProblem | null {
  if (name === '') return 'empty';
  if (name === '.' || name === '..') return 'dots';
  if (BAD_CHARS.test(name)) return 'chars';
  if (byteLength(name) > MAX_NAME_BYTES) return 'length';
  if (atRoot && RESERVED.includes(name)) return 'reserved';
  return null;
}

/** NFC, trimmed of nothing: deskd refuses a name that isn't NFC, and the member's own spaces are theirs. */
export const nfc = (s: string): string => s.normalize('NFC');

export const join = (folder: string, name: string): string => (folder === '' ? name : `${folder}/${name}`);

export function parent(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `a/b/c` is under `a/b` and under `a`, not under itself. The root holds everything. */
export const isUnder = (path: string, folder: string): boolean => (folder === '' ? path !== '' : path.startsWith(`${folder}/`));

export interface Crumb {
  name: string;
  path: string;
}

/** The breadcrumbs for a folder: the root first (its `name` is left for the caller to word). */
export function crumbs(folder: string): Crumb[] {
  const out: Crumb[] = [{ name: '', path: '' }];
  let at = '';
  for (const part of folder === '' ? [] : folder.split('/')) {
    at = join(at, part);
    out.push({ name: part, path: at });
  }
  return out;
}

/** The whole path is within limits. */
export const pathFits = (path: string): boolean => byteLength(path) <= MAX_PATH_BYTES;

/** "name (2).ext" for a name that's taken: `taken` says whether a candidate is. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * Sort as deskd does: folders first, then files; within each, by the name case-folded, then by its UTF-8 bytes. Used for entries
 * the client adds to a listing before the desk's own order comes back.
 */
export function compareEntries(a: { name: string; type: string }, b: { name: string; type: string }): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  const fa = a.name.toLowerCase();
  const fb = b.name.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ba = encoder.encode(a.name);
  const bb = encoder.encode(b.name);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i += 1) if (ba[i] !== bb[i]) return ba[i]! - bb[i]!;
  return ba.length - bb.length;
}

/**
 * Whether a `files.changes` list of folders changes what `folder` shows. A folder an upload made on the way is named by
 * its own parent only if that parent is the one that changed, and deskd names only the file's folder, so a folder
 * deeper down means this one gained a row too.
 */
export const listingTouched = (dirs: readonly string[], folder: string): boolean => dirs.some((d) => d === folder || isUnder(d, folder));
