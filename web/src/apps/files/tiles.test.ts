import { describe, expect, it } from 'vitest';
import { defaultDesk, overlaps } from '../../canvas/layout';
import { isUntouched, type LayoutDoc } from '../../canvas/layoutDoc';
import { fitDeskToFiles } from './tiles';

describe('the Files tile', () => {
  it('goes on a desk that has none, at a free place, on top, and only once', () => {
    const desk = defaultDesk('d-a', 0, 0);
    expect(desk.items.some((i) => i.app === 'files')).toBe(false);
    const withFiles = fitDeskToFiles(desk, true);
    const tile = withFiles.items.find((i) => i.app === 'files')!;
    expect(tile.id).toBe('d-a:files');
    expect(withFiles.items.filter((i) => overlaps(i, tile))).toEqual([tile]);
    expect(fitDeskToFiles(withFiles, true)).toBe(withFiles);
  });

  it('the kill switch takes it away again, and a desk with none stays the same object', () => {
    const desk = defaultDesk('d-a', 0, 0);
    expect(fitDeskToFiles(desk, false)).toBe(desk);
    const gone = fitDeskToFiles(fitDeskToFiles(desk, true), false);
    expect(gone.items.map((i) => i.app)).toEqual(desk.items.map((i) => i.app));
  });

  it('does not make a desk "arranged": nobody has touched it, so there is nothing to send for it', () => {
    const doc: LayoutDoc = { desks: { 'd-a': fitDeskToFiles(defaultDesk('d-a', 0, 0), true) }, z: ['d-a'] };
    expect(isUntouched(doc, ['d-a'])).toBe(true);
  });
});
