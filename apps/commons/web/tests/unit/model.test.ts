import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { itemsOf, packStroke, putItem, readItem } from '../../src/board/model.ts';
import { emptyBox, grow, hitItem } from '../../src/board/geometry.ts';
import { ago, initials } from '../../src/ui/names.ts';

describe('items', () => {
  it('writes and reads a stroke with its points', () => {
    const doc = new Y.Doc();
    const { x, y, p } = packStroke([10, 20, 0.5, 14, 26, 0.5, 20, 30, 0.7]);
    const id = putItem(doc, { k: 's', x, y, w: 0, h: 0, c: 'green', s: 2, z: 5, p });
    const it = readItem(id, itemsOf(doc).get(id)!)!;
    expect(it).toMatchObject({ k: 's', x: 10, y: 20, c: 'green', s: 2, z: 5 });
    expect(Array.from(it.p!).map((v) => Math.round(v * 10) / 10)).toEqual([0, 0, 0.5, 4, 6, 0.5, 10, 10, 0.7]);
  });

  it('reads damaged or unknown fields safely', () => {
    const m = new Y.Map<unknown>();
    const doc = new Y.Doc();
    doc.getMap('items').set('x', m);
    m.set('k', 'q');
    expect(readItem('x', m)).toBeNull();
    m.set('k', 'r');
    m.set('c', 'chartreuse');
    m.set('s', 99);
    m.set('x', 'nope');
    expect(readItem('x', m)).toMatchObject({ k: 'r', c: 'ink', s: 2, x: 0 });
  });
});

describe('hit tests', () => {
  it('finds a stroke near its line but not far from it', () => {
    const { x, y, p } = packStroke([0, 0, 0.5, 100, 0, 0.5]);
    const it = { id: 'a', k: 's' as const, x, y, w: 0, h: 0, c: 'ink' as const, s: 1 as const, z: 0, p };
    const box = emptyBox();
    grow(box, 0, 0, 4);
    grow(box, 100, 0, 4);
    expect(hitItem(it, box, 50, 2, 2)).toBe(true);
    expect(hitItem(it, box, 50, 12, 2)).toBe(false);
  });

  it('finds an ellipse inside it, not in its corner', () => {
    const it = { id: 'e', k: 'e' as const, x: 0, y: 0, w: 100, h: 50, c: 'ink' as const, s: 1 as const, z: 0 };
    const box = { x0: 0, y0: 0, x1: 100, y1: 50 };
    expect(hitItem(it, box, 50, 25, 0)).toBe(true);
    expect(hitItem(it, box, 2, 2, 0)).toBe(false);
  });
});

describe('names', () => {
  it('makes initials', () => {
    expect(initials('Ana Lopez')).toBe('AL');
    expect(initials('cy')).toBe('C');
    expect(initials('  ')).toBe('?');
    expect(initials('Émile de la Tour')).toBe('ÉT');
  });
  it('says how long ago', () => {
    const now = 1_800_000_000_000;
    expect(ago(now - 10_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 3 * 3600_000, now)).toBe('3 h ago');
  });
});
