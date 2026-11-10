import { describe, expect, it } from 'vitest';
import type { AttachCapsView } from '../client/types';
import { attachErrorText, capLine, desksKeepsFiles, formatSize, planAdd, stagedReducer, type Staged } from './attachments';

const MIB = 1024 * 1024;
const view = (over: Partial<AttachCapsView['caps']> = {}, vision?: boolean): Pick<AttachCapsView, 'caps' | 'vision'> => ({
  caps: { maxFiles: 3, maxFileBytes: 8 * MIB, maxImageBytes: 5 * MIB, maxTotalBytes: 12 * MIB, maxFileChars: 100_000, maxTotalChars: 200_000, maxPdfPages: 100, ...over },
  ...(vision === undefined ? {} : { vision }),
});
const f = (name: string, size: number, type = '') => ({ name, size, type });

describe('planAdd', () => {
  it('takes files within the caps', () => {
    expect(planAdd([], [f('a.pdf', 1000), f('b.txt', 20)], view())).toEqual({ accepted: [0, 1], messages: [] });
  });

  it('leaves out one over the file cap and still takes the rest', () => {
    const p = planAdd([], [f('big.pdf', 9 * MIB), f('ok.txt', 10)], view());
    expect(p.accepted).toEqual([1]);
    expect(p.messages).toEqual(['big.pdf is over 8 MB.']);
  });

  it('holds a picture to the picture cap', () => {
    expect(planAdd([], [f('p.png', 6 * MIB)], view()).messages).toEqual(['p.png is over 5 MB.']);
    expect(planAdd([], [f('p.png', 4 * MIB)], view()).accepted).toEqual([0]);
  });

  it('counts what is already staged, and says the cap once', () => {
    const p = planAdd([f('x.txt', 5), f('y.txt', 5)], [f('c.txt', 5), f('d.txt', 5), f('e.txt', 5)], view());
    expect(p.accepted).toEqual([0]);
    expect(p.messages).toEqual([capLine(view().caps)]);
    expect(capLine(view().caps)).toBe('You can attach up to 3 files, 12 MB in all.');
  });

  it('stops at the total size', () => {
    const p = planAdd([f('a.pdf', 7 * MIB)], [f('b.pdf', 7 * MIB)], view());
    expect(p.accepted).toEqual([]);
    expect(p.messages).toHaveLength(1);
  });

  it('says plainly that a model without vision cannot read a picture, and still takes documents', () => {
    const p = planAdd([], [f('p.jpg', 10), f('d.pdf', 10)], view({}, false));
    expect(p.accepted).toEqual([1]);
    expect(p.messages[0]).toMatch(/can't read pictures/);
    expect(planAdd([], [f('p.jpg', 10)], view({}, true)).accepted).toEqual([0]);
    expect(planAdd([], [f('p.jpg', 10)], view()).accepted).toEqual([0]);
  });

  it('skips an empty file and a file that is already staged', () => {
    const p = planAdd([f('a.txt', 5)], [f('a.txt', 5), f('e.txt', 0)], view());
    expect(p.accepted).toEqual([]);
    expect(p.messages).toEqual(['e.txt is empty.']);
  });

  it('does not judge the kind of file: the desk reads by content', () => {
    expect(planAdd([], [f('notes', 10), f('thing.xyz', 10)], view()).accepted).toEqual([0, 1]);
  });
});

describe('stagedReducer', () => {
  const file = (id: number): Staged => ({ id, uploadId: `u${id}`, name: `f${id}.txt`, size: 10, state: 'uploading', progress: 0 });
  it('adds, progresses, readies, removes and clears', () => {
    let s = stagedReducer([], { type: 'add', file: file(1) });
    s = stagedReducer(s, { type: 'add', file: file(2) });
    s = stagedReducer(s, { type: 'progress', id: 1, progress: 0.5 });
    expect(s[0]).toMatchObject({ progress: 0.5, state: 'uploading' });
    s = stagedReducer(s, { type: 'ready', id: 1 });
    expect(s[0]).toMatchObject({ progress: 1, state: 'ready' });
    s = stagedReducer(s, { type: 'progress', id: 1, progress: 0.2 });
    expect(s[0]!.progress).toBe(1);
    s = stagedReducer(s, { type: 'remove', id: 1 });
    expect(s.map((x) => x.id)).toEqual([2]);
    expect(stagedReducer(s, { type: 'clear' })).toEqual([]);
  });

  it('holds only a name, a size and an upload id: no bytes', () => {
    const s = stagedReducer([], { type: 'add', file: file(1) });
    expect(Object.keys(s[0]!).sort()).toEqual(['id', 'name', 'progress', 'size', 'state', 'uploadId']);
  });
});

describe('what the desk refuses with', () => {
  it('names the file and the limit', () => {
    expect(attachErrorText({ reason: 'too_large', file: 'a.pdf', limit: 8 * MIB })).toBe('a.pdf is over 8 MB.');
    expect(attachErrorText({ reason: 'encrypted', file: 'a.pdf', limit: null })).toMatch(/^a\.pdf is password protected/);
    expect(attachErrorText({ reason: 'too_many', file: null, limit: 5 })).toBe('You can attach up to 5 files to one message.');
    expect(attachErrorText({ reason: 'no_text', file: 's.pdf', limit: null })).toMatch(/Scanned pages/);
  });

  it('has words for every reason in API.md, and none for a reason that is not about files', () => {
    for (const reason of ['too_many', 'too_large', 'total_too_large', 'too_long', 'unsupported_type', 'legacy_office', 'binary', 'empty', 'encrypted', 'no_text', 'unreadable', 'too_complex', 'timeout', 'image_too_big', 'no_vision', 'missing', 'bad_upload', 'staging_full'] as const) {
      expect(attachErrorText({ reason, file: 'x', limit: 1000 }), reason).toBeTruthy();
    }
    expect(attachErrorText({ reason: 'busy', file: null, limit: null })).toBeNull();
    expect(attachErrorText({ reason: 'limit_reached', file: null, limit: null })).toBeNull();
  });

  it('keeps the staged files after a busy desk, a missing key or a dropped link, and not after a refusal that came after reading', () => {
    expect(desksKeepsFiles({ code: 'conflict', reason: 'busy' })).toBe(true);
    expect(desksKeepsFiles({ code: 'conflict', reason: 'staging_full' })).toBe(true);
    expect(desksKeepsFiles({ code: 'precondition_failed', reason: 'no_key' })).toBe(true);
    expect(desksKeepsFiles({ code: 'unavailable', reason: 'unavailable' })).toBe(true);
    expect(desksKeepsFiles(new Error('link down'))).toBe(true);
    expect(desksKeepsFiles({ code: 'bad_request', reason: 'encrypted' })).toBe(false);
    expect(desksKeepsFiles({ code: 'precondition_failed', reason: 'limit_reached' })).toBe(false);
    expect(desksKeepsFiles({ code: 'bad_request', reason: 'missing' })).toBe(false);
  });
});

describe('formatSize', () => {
  it('says it the way Maia does', () => {
    expect([12, 340 * 1024, 1.2 * MIB, 150 * MIB].map(formatSize)).toEqual(['12 B', '340 KB', '1.2 MB', '150 MB']);
  });
});
