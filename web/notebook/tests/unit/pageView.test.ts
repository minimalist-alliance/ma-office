// The page list's filter and sort by label (src/ui/pageView.ts).
import { describe, expect, it } from 'vitest';
import type { PageRec } from '../../src/model/types.ts';
import { ALL_PAGES, applyView, isFiltered, labelCounts, labelOf, readView, toggleLabel } from '../../src/ui/pageView.ts';

const page = (id: string, label?: unknown): PageRec =>
  ({ id, tabId: 't', sortKey: 0, title: id, snippet: '', wordCount: 0, hasChecklist: false, createdAt: 0, updatedAt: 0, deletedAt: null, rowVersion: 1, ...(label === undefined ? {} : { label }) }) as PageRec;

const pages = [page('a', 'rose'), page('b'), page('c', 'blue'), page('d', 'rose'), page('e', null), page('f', 'c99'), page('g', 'blue')];
const ids = (ps: PageRec[]) => ps.map((p) => p.id).join('');

describe('labels', () => {
  it('reads a palette id, and anything else as none', () => {
    expect(labelOf(pages[0]!)).toBe('rose');
    expect(labelOf(page('x', 'c8'))).toBeNull(); // an id this palette has no color for
    expect(labelOf(pages[1]!)).toBeNull();
    expect(labelOf(pages[4]!)).toBeNull();
    expect(labelOf(pages[5]!)).toBeNull(); // an id this build doesn't know
  });

  it('counts each label and none', () => {
    const c = labelCounts(pages);
    expect(c.rose).toBe(2);
    expect(c.blue).toBe(2);
    expect(c.none).toBe(3);
    expect(c.amber).toBe(0);
  });
});

describe('filter', () => {
  it('shows everything by default, in manual order', () => {
    expect(ids(applyView(pages, ALL_PAGES))).toBe('abcdefg');
    expect(isFiltered(ALL_PAGES)).toBe(false);
  });

  it('by one label, by several, and by no label', () => {
    expect(ids(applyView(pages, { ...ALL_PAGES, labels: ['rose'] }))).toBe('ad');
    expect(ids(applyView(pages, { ...ALL_PAGES, labels: ['blue', 'rose'] }))).toBe('acdg');
    expect(ids(applyView(pages, { ...ALL_PAGES, none: true }))).toBe('bef');
    expect(ids(applyView(pages, { ...ALL_PAGES, labels: ['blue'], none: true }))).toBe('bcefg');
    expect(ids(applyView(pages, { ...ALL_PAGES, labels: ['amber'] }))).toBe('');
  });

  it('toggles a label or none on and off, kept in palette order', () => {
    let v = toggleLabel(ALL_PAGES, 'rose');
    v = toggleLabel(v, 'blue');
    expect(v.labels).toEqual(['blue', 'rose']);
    v = toggleLabel(v, 'none');
    expect(v.none).toBe(true);
    v = toggleLabel(toggleLabel(toggleLabel(v, 'rose'), 'blue'), 'none');
    expect(isFiltered(v)).toBe(false);
  });
});

describe('sort', () => {
  it('by label: palette order, none last, manual order within each', () => {
    expect(ids(applyView(pages, { ...ALL_PAGES, sort: 'label' }))).toBe('cgadbef');
  });

  it('sorts what the filter left', () => {
    expect(ids(applyView(pages, { labels: ['rose', 'blue'], none: false, sort: 'label' }))).toBe('cgad');
  });
});

describe('what was stored', () => {
  it('keeps only what this build understands', () => {
    expect(readView({ labels: ['green', 'nope', 'amber', 'c8', 4], none: true, sort: 'label' })).toEqual({ labels: ['amber', 'green'], none: true, sort: 'label' });
    expect(readView({ sort: 'sideways' })).toEqual(ALL_PAGES);
    expect(readView('junk')).toEqual(ALL_PAGES);
    expect(readView(null)).toEqual(ALL_PAGES);
  });
});
