// Files in Maia's composer. Pure where it can be, so a test can hold it. The owner's rule: files are never retained.
// Nothing here writes to any storage, and a file's bytes exist only while a turn is being built or sent.
import { IMAGE_EXT, type AttachCaps } from './caps';
export { readCaps, FALLBACK_ACCEPT, type AttachCaps } from './caps';

/** The picker's `accept` attribute. */
export const acceptAttr = (caps: AttachCaps): string => caps.accept.map((e) => `.${e}`).join(',');

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const isImageName = (name: string, type = ''): boolean => IMAGE_EXT.includes(extOf(name)) || (!extOf(name) && type.startsWith('image/'));

/** "1.2 MB", "340 KB", "12 B". */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  const mb = bytes / 1_000_000;
  return `${mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

export interface Pending {
  id: number;
  name: string;
  size: number;
  type: string;
  file: File;
}

/** What a sent message remembers of a file: a name and a size, never bytes. */
export interface Sent {
  name: string;
  size: number;
}

export interface Incoming {
  name: string;
  size: number;
  type: string;
}

export interface Plan {
  /** Indexes into the incoming list that fit. */
  accepted: number[];
  /** Plain lines, each once. */
  messages: string[];
}

export function capLine(caps: AttachCaps): string {
  return `You can attach up to ${caps.maxFiles} ${caps.maxFiles === 1 ? 'file' : 'files'}, ${formatSize(caps.maxTotalBytes)} in all.`;
}

/**
 * Which of `incoming` can join `current`. Over-cap files are left out and said so; the others still go in.
 * `free`: free Maia can't read images, so an image is left out (unless the server says free images are fine).
 */
export function planAdd(current: readonly { name: string; size: number }[], incoming: readonly Incoming[], caps: AttachCaps, free: boolean): Plan {
  const accepted: number[] = [];
  const messages: string[] = [];
  const say = (m: string): void => {
    if (!messages.includes(m)) messages.push(m);
  };
  let count = current.length;
  let total = current.reduce((s, f) => s + f.size, 0);
  incoming.forEach((f, i) => {
    const ext = extOf(f.name);
    if (current.some((c) => c.name === f.name && c.size === f.size) || accepted.some((j) => incoming[j]!.name === f.name && incoming[j]!.size === f.size)) return;
    if (!ext || !caps.accept.includes(ext)) {
      say(ext ? `Maia can't read .${ext} files.` : `Maia can't read ${f.name}.`);
      return;
    }
    if (free && !caps.freeImages && isImageName(f.name, f.type)) {
      say("Free Maia can't read images.");
      return;
    }
    if (f.size === 0) {
      say(`${f.name} is empty.`);
      return;
    }
    if (f.size > caps.maxFileBytes) {
      say(`${f.name} is over ${formatSize(caps.maxFileBytes)}.`);
      return;
    }
    if (count + 1 > caps.maxFiles || total + f.size > caps.maxTotalBytes) {
      say(capLine(caps));
      return;
    }
    accepted.push(i);
    count += 1;
    total += f.size;
  });
  return { accepted, messages };
}

/** Standard base64 with no prefix, built in chunks of whole 3-byte groups so nothing spreads a huge argument list. */
export function toBase64(bytes: Uint8Array): string {
  const STEP = 3 * 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += STEP) {
    let bin = '';
    const end = Math.min(i + STEP, bytes.length);
    for (let j = i; j < end; j += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(j, Math.min(j + 8192, end)) as unknown as number[]);
    parts.push(btoa(bin));
  }
  return parts.join('');
}

export interface WireFile {
  name: string;
  type: string;
  data: string;
}

export async function encodeFile(p: { name: string; file: Blob }): Promise<WireFile> {
  const bytes = new Uint8Array(await p.file.arrayBuffer());
  return { name: p.name.slice(0, 255), type: (p.file.type || 'application/octet-stream').slice(0, 100), data: toBase64(bytes) };
}

const ATTACHED = /^\[Attached: (.+) \((.+), (.+)\)\]$/;

export interface AttachedChip {
  name: string;
  type: string;
  size: string;
}

/** A line of history text as an attached-file chip, or null. */
export function parseAttachedLine(line: string): AttachedChip | null {
  const m = ATTACHED.exec(line);
  return m ? { name: m[1]!, type: m[2]!, size: m[3]! } : null;
}

/** A past member message: its words, and the chips its `[Attached: …]` lines stand for. */
export function splitAttached(text: string): { text: string; chips: AttachedChip[] } {
  const chips: AttachedChip[] = [];
  const keep: string[] = [];
  for (const line of text.split('\n')) {
    const chip = parseAttachedLine(line);
    if (chip) chips.push(chip);
    else keep.push(line);
  }
  return { text: chips.length ? keep.join('\n').trim() : text, chips };
}

/** Long edge limit and quality for an image that is over the cap. */
const EDGE = 2048;

/** An image scaled down to a JPEG, or null when the browser can't. Browser only. */
export async function downscaleImage(file: File): Promise<File | null> {
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.fillStyle = 'white'; // a transparent PNG would turn black as a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return null;
  }
}
