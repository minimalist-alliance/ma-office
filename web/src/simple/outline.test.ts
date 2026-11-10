// The page's outline (the spec's section 12) and a front page's own hidden h1 (R61).
import { describe, expect, it } from 'vitest';
import type { KeyedBlock } from './docStore';
import type { Block } from './mdoc';
import { isFront, outline } from './outline';

const h = (key: string, level: 1 | 2 | 3 | 4 | 5 | 6): KeyedBlock => ({ key, block: { t: 'heading', level, c: [{ t: 'text', text: key }], dialog: false } as Block }) as KeyedBlock;

describe('outline', () => {
  it('one h1, the page’s first level 1 or else its first heading, then no level skipped', () => {
    expect([...outline([h('a', 2), h('b', 4), h('c', 3)])]).toEqual([['a', 1], ['b', 2], ['c', 3]]);
    expect([...outline([h('a', 2), h('b', 1), h('c', 3)])]).toEqual([['a', 2], ['b', 1], ['c', 2]]);
  });

  it('R61: a front page with no h1 of its own keeps its sections at h2, for the view’s hidden h1', () => {
    const blocks = [h('world', 2), h('lead', 3), h('sport', 2)];
    expect(isFront('https://news.example/', blocks)).toBe(true);
    expect([...outline(blocks, true)]).toEqual([['world', 2], ['lead', 3], ['sport', 2]]);
    // Not a front page: a path, a query (a search at the root), no headings, or an h1 of its own.
    expect(isFront('https://news.example/world', blocks)).toBe(false);
    expect(isFront('https://search.example/?q=lamps', blocks)).toBe(false);
    expect(isFront('https://news.example/', [])).toBe(false);
    expect(isFront('https://news.example/', [h('top', 1), ...blocks])).toBe(false);
    expect(isFront(null, blocks)).toBe(false);
  });
});
