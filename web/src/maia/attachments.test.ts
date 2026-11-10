import { describe, expect, it } from 'vitest';
import { acceptAttr, capLine, encodeFile, formatSize, parseAttachedLine, planAdd, readCaps, splitAttached, toBase64, FALLBACK_ACCEPT, type AttachCaps } from './attachments';
import { readState } from './gate';

const CAPS: AttachCaps = { enabled: true, maxFiles: 3, maxFileBytes: 2_000_000, maxTotalBytes: 4_000_000, accept: ['png', 'pdf', 'txt', 'csv'], freeImages: false };
const f = (name: string, size: number, type = '') => ({ name, size, type });

describe('readCaps', () => {
  it('is null when absent, off or unusable: the feature is hidden', () => {
    for (const bad of [undefined, null, 'x', [], {}, { enabled: false, maxFiles: 3, maxFileBytes: 1, maxTotalBytes: 1 }, { enabled: true, maxFiles: 0, maxFileBytes: 1, maxTotalBytes: 1 }]) {
      expect(readCaps(bad)).toBeNull();
    }
    expect(readState({ enabled: true }) ?.attachments).toBeNull();
  });
  it('reads the caps and lower-cases accept, with a fallback list when it is missing', () => {
    expect(readCaps({ enabled: true, maxFiles: 10, maxFileBytes: 5, maxTotalBytes: 9, accept: ['PDF', 'png', 'bad ext', 7], freeImages: false })).toEqual({
      enabled: true, maxFiles: 10, maxFileBytes: 5, maxTotalBytes: 9, accept: ['pdf', 'png'], freeImages: false,
    });
    expect(readCaps({ enabled: true, maxFiles: 1, maxFileBytes: 5, maxTotalBytes: 9 })?.accept).toEqual([...FALLBACK_ACCEPT]);
    expect(acceptAttr(CAPS)).toBe('.png,.pdf,.txt,.csv');
  });
  it('rides GET /v1/maia/state', () => {
    const st = readState({ enabled: true, attachments: { enabled: true, maxFiles: 2, maxFileBytes: 3, maxTotalBytes: 4, accept: ['txt'], freeImages: false } });
    expect(st?.attachments?.maxFiles).toBe(2);
  });
});

describe('formatSize and the cap line', () => {
  it('uses human units', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(340_000)).toBe('340 KB');
    expect(formatSize(1_234_567)).toBe('1.2 MB');
    expect(capLine({ ...CAPS, maxFiles: 10, maxTotalBytes: 4_000_000 })).toBe('You can attach up to 10 files, 4 MB in all.');
    expect(capLine({ ...CAPS, maxFiles: 1 })).toBe('You can attach up to 1 file, 4 MB in all.');
  });
});

describe('planAdd', () => {
  it('adds what fits and says why the rest did not', () => {
    const p = planAdd([], [f('a.pdf', 100), f('b.exe', 100), f('big.pdf', 3_000_000), f('c.txt', 100), f('d.txt', 100), f('e.csv', 100)], CAPS, false);
    expect(p.accepted).toEqual([0, 3, 4]);
    expect(p.messages).toEqual(["Maia can't read .exe files.", 'big.pdf is over 2 MB.', 'You can attach up to 3 files, 4 MB in all.']);
  });
  it('counts what is already there, and the total size', () => {
    expect(planAdd([f('a.pdf', 1_900_000), f('b.pdf', 1_900_000)], [f('c.pdf', 1_000_000), f('d.txt', 100_000)], CAPS, false)).toEqual({
      accepted: [1],
      messages: ['You can attach up to 3 files, 4 MB in all.'],
    });
  });
  it('skips a repeat and an empty file', () => {
    const p = planAdd([f('a.pdf', 5)], [f('a.pdf', 5), f('z.txt', 0)], CAPS, false);
    expect(p.accepted).toEqual([]);
    expect(p.messages).toEqual(['z.txt is empty.']);
  });
  it("free Maia can't read images, but other files are fine", () => {
    const p = planAdd([], [f('a.png', 10, 'image/png'), f('b.txt', 10), f('c.PNG', 10)], CAPS, true);
    expect(p.accepted).toEqual([1]);
    expect(p.messages).toEqual(["Free Maia can't read images."]);
    expect(planAdd([], [f('a.png', 10)], CAPS, false).accepted).toEqual([0]);
    expect(planAdd([], [f('a.png', 10)], { ...CAPS, freeImages: true }, true).accepted).toEqual([0]);
  });
});

describe('base64', () => {
  it('encodes binary exactly, in chunks', () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 255;
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(toBase64(new Uint8Array([0, 255, 128]))).toBe('AP+A');
    expect(toBase64(new Uint8Array([]))).toBe('');
    expect(toBase64(new Uint8Array([1]))).toBe('AQ==');
  });
  it('encodeFile gives name, advisory type and no data: prefix', async () => {
    const w = await encodeFile({ name: 'x.bin', file: new Blob([new Uint8Array([1, 2, 3, 250])], { type: 'application/x-test' }) });
    expect(w).toEqual({ name: 'x.bin', type: 'application/x-test', data: 'AQID+g==' });
  });
});

describe('the Attached line', () => {
  it('matches exactly', () => {
    expect(parseAttachedLine('[Attached: report.pdf (PDF, 1.2 MB)]')).toEqual({ name: 'report.pdf', type: 'PDF', size: '1.2 MB' });
    expect(parseAttachedLine('[Attached: my (v2).pdf (PDF, 1.2 MB)]')?.name).toBe('my (v2).pdf');
    for (const bad of ['[Attached: x]', ' [Attached: a (PDF, 1 MB)]', '[Attached: a (PDF, 1 MB)] more', 'Attached: a (PDF, 1 MB)']) expect(parseAttachedLine(bad)).toBeNull();
  });
  it('splits a past message into words and chips', () => {
    expect(splitAttached('What is this?\n[Attached: a.pdf (PDF, 1 MB)]\n[Attached: b.csv (CSV, 3 KB)]')).toEqual({
      text: 'What is this?',
      chips: [{ name: 'a.pdf', type: 'PDF', size: '1 MB' }, { name: 'b.csv', type: 'CSV', size: '3 KB' }],
    });
    expect(splitAttached('plain\ntext')).toEqual({ text: 'plain\ntext', chips: [] });
  });
});
