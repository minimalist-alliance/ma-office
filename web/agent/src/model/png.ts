// An uploaded icon (multi-agent.md section 7): the quick checks this window makes before a PNG goes to the desk, so a
// plainly wrong file is refused here with words, and the desk's own refusal reasons in the same words. The desk decodes
// the whole image and keeps only a mask; this reads the signature and the header chunk, with its CRC, and nothing else.

export type PngRefusal = 'not_png' | 'too_large' | 'too_many_pixels' | 'corrupt' | 'no_shape' | 'too_thin';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let table: Uint32Array | null = null;
/** CRC-32 as PNG's chunks use it (ISO 3309). */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/** The checks, in the desk's order: a PNG at all, then its size in bytes, its header, then its size in pixels. */
export function pngCheck(bytes: Uint8Array, limits: { maxBytes: number; maxPx: number }): { ok: true; width: number; height: number } | { ok: false; reason: PngRefusal } {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) return { ok: false, reason: 'not_png' };
  if (bytes.length > limits.maxBytes) return { ok: false, reason: 'too_large' };
  // The first chunk is IHDR: length 13, type, 13 bytes of data, CRC over type and data.
  if (bytes.length < 8 + 25 || u32(bytes, 8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return { ok: false, reason: 'corrupt' };
  if (crc32(bytes.subarray(12, 29)) !== u32(bytes, 29)) return { ok: false, reason: 'corrupt' };
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (width === 0 || height === 0) return { ok: false, reason: 'corrupt' };
  if (width > limits.maxPx || height > limits.maxPx) return { ok: false, reason: 'too_many_pixels' };
  return { ok: true, width, height };
}

/** What the member reads for a refusal, from this window or the desk. */
export function pngRefusalText(reason: string | null, limits: { maxBytes: number; maxPx: number }): string {
  switch (reason) {
    case 'not_png':
      return 'That file isn’t a PNG inside, even if its name ends in .png. Export it as PNG and try again.';
    case 'no_shape':
      return 'We couldn’t find a shape in that picture. Use a logo or icon on a clear or plain white background.';
    case 'too_thin':
      return 'Its lines are too thin to see at icon size. Try a bolder version.';
    case 'too_large':
      return `That file is over ${Math.round(limits.maxBytes / 1024)} KB. Pick a smaller one.`;
    case 'too_many_pixels':
      return `That picture is over ${limits.maxPx} by ${limits.maxPx} pixels. Save a smaller copy and try again.`;
    case 'corrupt':
      return 'That PNG couldn’t be read. It may be damaged.';
    default:
      return 'The desk couldn’t take that picture. Try again.';
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/** Where a coverage under this counts as no ink at all: it removes haze and noise. */
const COVERAGE_FLOOR = 24;
/** The empty margin round the shape, as a share of the square's side, on each side. */
const MARGIN = 0.08;

/**
 * The mask the desk keeps of an upload (contract section 4), from the picture's RGBA pixels. The same steps as desk-agent's
 * `PngMark`, so the mock and the real desk agree:
 *  1. Coverage: the alpha if the picture has any transparency; otherwise how far each pixel's brightness is from the median
 *     brightness of the 1 px border (so white on dark works as well as dark on white).
 *  2. Coverage under 24 becomes 0. 3. The rest is stretched so its 98th percentile is full (255).
 *  4. The shape is trimmed and centred in a square with an 8% margin on each side.
 * Refused: `no_shape` (nothing left, ink over 85% of the trimmed box, or no transparency and a border that is not one
 * color), `too_thin` (at 28 px the strongest pixel has under 50% coverage). The result is white with the coverage as alpha.
 */
export function maskPixels(rgba: Uint8ClampedArray, width: number, height: number): { ok: true; size: number; rgba: Uint8ClampedArray } | { ok: false; reason: 'no_shape' | 'too_thin' } {
  const n = width * height;
  let transparent = false;
  for (let i = 3; i < n * 4; i += 4) {
    if (rgba[i]! < 255) {
      transparent = true;
      break;
    }
  }
  const bright = (i: number): number => 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  const cover = new Float32Array(n);
  if (transparent) {
    for (let i = 0; i < n; i += 1) cover[i] = rgba[i * 4 + 3]!;
  } else {
    const border: number[] = [];
    for (let x = 0; x < width; x += 1) border.push(bright(x), bright((height - 1) * width + x));
    for (let y = 1; y < height - 1; y += 1) border.push(bright(y * width), bright(y * width + width - 1));
    border.sort((a, b) => a - b);
    if (border[border.length - 1]! - border[0]! > 20) return { ok: false, reason: 'no_shape' };
    const ground = border[border.length >> 1]!;
    for (let i = 0; i < n; i += 1) cover[i] = Math.min(255, Math.abs(bright(i) - ground));
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const levels: number[] = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (cover[i]! < COVERAGE_FLOOR) {
        cover[i] = 0;
        continue;
      }
      levels.push(cover[i]!);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (levels.length === 0) return { ok: false, reason: 'no_shape' };
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (levels.length > 0.85 * bw * bh) return { ok: false, reason: 'no_shape' };
  levels.sort((a, b) => a - b);
  const top = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.98))]!;
  const side = Math.max(bw, bh);
  const size = Math.max(1, Math.ceil(side / (1 - 2 * MARGIN)));
  const ox = Math.floor((size - bw) / 2);
  const oy = Math.floor((size - bh) / 2);
  const out = new Uint8ClampedArray(size * size * 4);
  const alpha = new Float32Array(size * size);
  for (let y = 0; y < bh; y += 1)
    for (let x = 0; x < bw; x += 1) {
      const c = cover[(minY + y) * width + minX + x]!;
      if (c === 0) continue;
      const a = Math.min(255, (c * 255) / top);
      const j = (oy + y) * size + ox + x;
      alpha[j] = a;
      out.set([255, 255, 255, Math.round(a)], j * 4);
    }
  // Too thin: scaled down to 28 px (box average), the strongest pixel is under half covered.
  const small = 28;
  let strongest = 0;
  if (size <= small) strongest = Math.max(...alpha);
  else {
    const cell = size / small;
    for (let cy = 0; cy < small; cy += 1)
      for (let cx = 0; cx < small; cx += 1) {
        const x0 = Math.floor(cx * cell);
        const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cell));
        const y0 = Math.floor(cy * cell);
        const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cell));
        let sum = 0;
        for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) sum += alpha[y * size + x]!;
        strongest = Math.max(strongest, sum / ((x1 - x0) * (y1 - y0)));
      }
  }
  if (strongest < 127.5) return { ok: false, reason: 'too_thin' };
  return { ok: true, size, rgba: out };
}

/**
 * A PNG over `maxPx` on a side, scaled down in the browser to fit `maxPx`, as a new PNG (so a 2048 px logo goes through).
 * `null`: this browser can't, or the picture didn't decode; the caller then sends the file as it is and the desk decides.
 */
export async function scalePngDown(bytes: Uint8Array, maxPx: number): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }));
    const k = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.floor(bitmap.width * k));
    const h = Math.max(1, Math.floor(bitmap.height * k));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
