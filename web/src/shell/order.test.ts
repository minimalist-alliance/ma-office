import { describe, expect, it } from 'vitest';
import { appsInOrder, readingOrder } from './order';

const d = (id: string, x: number, y: number, w = 100, h = 100) => ({ id, rect: { x, y, w, h } });

describe('reading order', () => {
  it('groups rows by vertical overlap, then sorts by x', () => {
    const order = readingOrder([d('c', 0, 300), d('b', 200, 10), d('a', 0, 0)]);
    expect(order.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('keeps slightly offset desks in one row', () => {
    const order = readingOrder([d('b', 200, 50), d('a', 0, 0), d('c', 400, 90)]);
    expect(order.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('things at the same place keep one order, however the list came in', () => {
    const want = ['a', 'b', 'c'];
    expect(readingOrder([d('c', 10, 10), d('a', 10, 10), d('b', 10, 10)]).map((x) => x.id)).toEqual(want);
    expect(readingOrder([d('b', 10, 10), d('c', 10, 10), d('a', 10, 10)]).map((x) => x.id)).toEqual(want);
  });
  it('in one row at the same x, the higher one comes first, whatever its id', () => {
    expect(readingOrder([d('a', 10, 50), d('z', 10, 0)]).map((x) => x.id)).toEqual(['z', 'a']);
  });
});

describe('the order the keyboard meets a desk\'s apps', () => {
  const app = (id: string, x: number, y: number) => ({ id, app: 'chat' as const, x, y, w: 76, h: 76 });
  const items = [app('top-left', 24, 24), app('over-it', 30, 30), app('far', 300, 24), app('below', 24, 300)];

  it('goes by where they are, never by how they\'re stacked', () => {
    const want = ['top-left', 'over-it', 'far', 'below'];
    expect(appsInOrder(items, false).map((i) => i.id)).toEqual(want);
    expect(appsInOrder([...items].reverse(), false).map((i) => i.id)).toEqual(want);
    expect(appsInOrder([items[2]!, items[3]!, items[0]!, items[1]!], false).map((i) => i.id)).toEqual(want);
  });

  it('stays the same when two apps share a place and either is raised', () => {
    const twin = [app('a', 24, 24), app('b', 24, 24)];
    expect(appsInOrder(twin, false).map((i) => i.id)).toEqual(['a', 'b']);
    expect(appsInOrder([twin[1]!, twin[0]!], false).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('on a phone is the list, which is its grid', () => {
    expect(appsInOrder([...items].reverse(), true).map((i) => i.id)).toEqual(['below', 'far', 'over-it', 'top-left']);
  });
});
