// A workspace per agent (multi-agent.md section 5): paths as the desk checks them, sizes in words, and the folder a path
// sits in. Pure, and tested in multiAgent.test.ts.

export const MB = 1024 * 1024;
export const PATH_MAX_BYTES = 1024;
export const PATH_MAX_DEPTH = 16;
/** `agent.workspace.read` answers this many characters of a file's text a page, at most. */
export const READ_PAGE_CHARS = 128 * 1024;

/**
 * Why the desk would refuse this path, or null: relative, `/`-separated, no `.` or `..` component, no empty component, no
 * NUL, at most 16 deep and 1024 bytes. The desk also checks every component on disk, which only it can.
 */
export function pathProblem(path: string): 'empty' | 'absolute' | 'dot' | 'nul' | 'deep' | 'long' | null {
  if (!path) return 'empty';
  if (path.startsWith('/') || path.includes('\\')) return 'absolute';
  if (path.includes('\0')) return 'nul';
  if (new TextEncoder().encode(path).length > PATH_MAX_BYTES) return 'long';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'dot';
  if (parts.length > PATH_MAX_DEPTH) return 'deep';
  return null;
}

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `512 bytes`, `18 KB`, `1.5 MB`, `200 MB`. */
export function bytesText(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  if (n < MB) return `${trim(n / 1024)} KB`;
  if (n < 1024 * MB) return `${trim(n / MB)} MB`;
  return `${trim(n / (1024 * MB))} GB`;
}

const trim = (x: number): string => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));

/** A quota in whole MB, as the member types it, or null. */
export function parseMb(text: string, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= max ? n : null;
}

/** How a workspace's fullness reads, from use over the quota: null under 80%. */
export function fullness(usedBytes: number, quotaBytes: number): 'nearly' | 'full' | null {
  if (quotaBytes <= 0) return null;
  const f = usedBytes / quotaBytes;
  return f >= 1 ? 'full' : f >= 0.8 ? 'nearly' : null;
}

/** What the member reads of a workspace that is nearly full or full. */
export function fullnessText(level: 'nearly' | 'full', agent: string): string {
  return level === 'full' ? `Full. ${agent} can’t save files until you delete some or make it bigger.` : `Nearly full. ${agent} can’t save more once it’s full.`;
}

/** The thread chip for a file an agent couldn't save. */
export function refusedSaveText(path: string, reason: string): string {
  switch (reason) {
    case 'disk_low':
      return `Couldn’t save ${path}: this desk is low on storage.`;
    case 'too_many_folders':
      return `Couldn’t save ${path}: the workspace has as many folders as it can hold.`;
    default:
      return `Couldn’t save ${path}: the workspace is full.`;
  }
}
