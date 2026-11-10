import { describe, expect, it } from 'vitest';
import { sniff } from './sniff';

const bytes = (...parts: (number[] | string)[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const pad = (b: Uint8Array): Uint8Array => Uint8Array.from([...b, ...new Array(64).fill(0)]);

describe('what is an image is decided by the bytes, never the name', () => {
  const images: [string, Uint8Array][] = [
    ['jpeg', bytes([0xff, 0xd8, 0xff, 0xe0])],
    ['png', bytes([0x89], 'PNG\r\n', [0x1a, 0x0a])],
    ['gif', bytes('GIF89a')],
    ['gif', bytes('GIF87a')],
    ['webp', bytes('RIFF', [0, 0, 0, 0], 'WEBP')],
    ['bmp', bytes('BM', new Array(20).fill(0))],
    ['tiff', bytes('II', [42, 0])],
    ['tiff', bytes('MM', [0, 42])],
    ['avif', bytes([0, 0, 0, 24], 'ftypavif')],
    ['heic', bytes([0, 0, 0, 24], 'ftypheic')],
    ['heif', bytes([0, 0, 0, 24], 'ftypmif1')],
    ['svg', bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['svg', bytes([0xef, 0xbb, 0xbf], '<?xml version="1.0"?>\n<!-- a comment -->\n<!DOCTYPE svg PUBLIC "x" "y">\n<svg viewBox="0 0 1 1"/>')],
  ];
  for (const [format, head] of images) {
    it(`${format}`, () => expect(sniff(pad(head))).toEqual({ kind: 'image', format }));
  }

  it('archives, documents and plain text are not images, whatever they hold or are called', () => {
    for (const head of [bytes([0x50, 0x4b, 3, 4]), bytes('7z', [0xbc, 0xaf, 0x27, 0x1c]), bytes('Rar!', [0x1a, 7, 0]), bytes('%PDF-1.7\n'), bytes('hello, <svg> is a word here'), bytes('<html><svg></svg></html>'), bytes([])]) {
      expect(sniff(pad(head))).toEqual({ kind: 'other' });
    }
    // A tar has "ustar" at 257; nothing at the front is an image.
    expect(sniff(pad(bytes(new Array(300).fill(0))))).toEqual({ kind: 'other' });
  });

  it('a .jpg that is really a PNG is a png, and an image under another name is still an image', () => {
    const png = pad(bytes([0x89], 'PNG\r\n', [0x1a, 0x0a]));
    expect(sniff(png)).toEqual({ kind: 'image', format: 'png' });
  });
});
