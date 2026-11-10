// Attachment limits as `GET /v1/maia/state` gives them. Its own file: the office's first load takes only this much of the feature.

export interface AttachCaps {
  enabled: boolean;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Lower-case extensions without the dot. The server is the authority. */
  accept: string[];
  freeImages: boolean;
}

/** Used for the picker only if the server's state has no `accept`. */
export const FALLBACK_ACCEPT: readonly string[] = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log',
  'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'html', 'css', 'sh', 'sql', 'docx', 'xlsx', 'pptx',
];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** `attachments` from `GET /v1/maia/state`, or null (feature off). */
export function readCaps(v: unknown): AttachCaps | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  if (b['enabled'] !== true) return null;
  const maxFiles = n(b['maxFiles']);
  const maxFileBytes = n(b['maxFileBytes']);
  const maxTotalBytes = n(b['maxTotalBytes']);
  if (!maxFiles || !maxFileBytes || !maxTotalBytes) return null;
  const accept = Array.isArray(b['accept'])
    ? (b['accept'] as unknown[]).filter((x): x is string => typeof x === 'string' && /^[a-z0-9]{1,10}$/.test(x.toLowerCase())).map((x) => x.toLowerCase())
    : [];
  return { enabled: true, maxFiles, maxFileBytes, maxTotalBytes, accept: accept.length ? accept : [...FALLBACK_ACCEPT], freeImages: b['freeImages'] === true };
}
