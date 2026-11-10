// Whether a file is an image is decided by its bytes alone (Lead decision, Nov 8): never by the name, so an image renamed
// `.dat` or `.txt` still goes through the image check, and a zip, a PDF or any other document never does. The same rule deskd
// applies at `finish` (files.md `files.stat`), from the first 4 KiB.
export const SNIFF_BYTES = 4096;

export type Sniff = { kind: 'image'; format: string } | { kind: 'other' };

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i += 1) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];

/** The root element name of an SVG document: the XML prolog, comments, a doctype and a BOM skipped. Null if it isn't one. */
function svgRoot(head: Uint8Array): boolean {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(head);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (;;) {
    text = text.replace(/^\s+/, '');
    if (text.startsWith('<?')) {
      const end = text.indexOf('?>');
      if (end < 0) return false;
      text = text.slice(end + 2);
    } else if (text.startsWith('<!--')) {
      const end = text.indexOf('-->');
      if (end < 0) return false;
      text = text.slice(end + 3);
    } else if (/^<!doctype/i.test(text)) {
      const end = text.indexOf('>');
      if (end < 0) return false;
      text = text.slice(end + 1);
    } else {
      break;
    }
  }
  return /^<svg[\s>/]/i.test(text) || /^<[a-z][\w.-]*:svg[\s>]/i.test(text);
}

/** `head` is the file's first bytes (at least `SNIFF_BYTES` if it has them). */
export function sniff(head: Uint8Array): Sniff {
  const b = head;
  const image = (format: string): Sniff => ({ kind: 'image', format });
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return image('jpeg');
  if (ascii(b, 0, '\x89PNG\r\n\x1a\n')) return image('png');
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return image('gif');
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return image('webp');
  if (ascii(b, 0, 'BM') && b.length >= 14) return image('bmp');
  if ((ascii(b, 0, 'II') && b[2] === 42 && b[3] === 0) || (ascii(b, 0, 'MM') && b[2] === 0 && b[3] === 42)) return image('tiff');
  if (ascii(b, 4, 'ftyp')) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0);
    if (brand === 'avif' || brand === 'avis') return image('avif');
    if (HEIF_BRANDS.includes(brand)) return image(brand === 'mif1' || brand === 'msf1' ? 'heif' : 'heic');
  }
  if (svgRoot(b)) return image('svg');
  return { kind: 'other' };
}

export const isImage = (s: Sniff): s is { kind: 'image'; format: string } => s.kind === 'image';

/** Read a local file's head and decide. */
export async function sniffFile(file: Blob): Promise<Sniff> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  return sniff(head);
}
