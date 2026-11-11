import { describe, expect, it } from 'vitest';
import {
  clampMove, clampResize, cornerInset, defaultDesk, deskBounds, deskFromGrid, deskGeometry, detailLevel, ETCH_BASELINE, ETCH_DEPTH, ETCH_ICON, ETCH_SIZE, fitDeskSize, fitNameText, fittedLevel, fitToWidth, G, HIDDEN_MIN, hiddenItems, iconGlyphSize, iconsFit, iconsLeft, isPlaced, levelSize, minDeskSize, MIN_NAME_CHARS, nameRoom, nearestFree, nudgeMove, nudgeResize, overlaps, overOthers, packItems,
  panelH, panelW, placeNewDesk, restacked, roundUnit, settleDesk, slotRight, countSlotW, span, stackOrder, statusClear, statusRoom, STRIP, stripTarget, STATUS_LONGEST, switchFits, tidyDesk, tidyOrder, tidyPack, unionBounds, withStack, workArea,
  type AppId, type DetailLevel, type LayoutDesk,
} from './layout';

const entry = (id: string, level: DetailLevel = 'icon'): { id: string; level: DetailLevel } => ({ id, level });
const app = (id: string, x: number, y: number, w = 76, h = 76, a: AppId = 'chat') => ({ id, app: a, x, y, w, h });

describe('surface (ADR 0062)', () => {
  it('a default desk is 584 x 236: padding, 168 of work height and the strip', () => {
    expect(G.strip).toBe(44);
    expect(panelW(6)).toBe(584);
    expect(panelW(6)).toBe(2 * G.padX + span(6));
    expect(defaultDesk('d', 0, 0)).toMatchObject({ w: 584, h: 236 });
    expect(defaultDesk('d', 0, 0).h).toBe(G.padTop + 168 + G.strip);
  });

  it('a row of the old grid is still what it was, since saved desks were sized by it', () => {
    expect(panelH(1)).toBe(144);
    expect(panelH(1)).toBe(G.padTop + G.cell + G.strip);
    expect(panelH(3)).toBe(G.padTop + span(3) + G.strip);
  });
});

describe('detail levels (ADR 0062)', () => {
  it.each<[number, number, DetailLevel]>([
    [76, 76, 'icon'],
    [167.99, 500, 'icon'],
    [500, 167.99, 'icon'],
    [168, 168, 'small'],
    [351.99, 500, 'small'],
    [352, 168, 'wide'],
    [352, 351.99, 'wide'],
    [352, 352, 'large'],
    [535.99, 900, 'large'],
    [900, 443.99, 'large'],
    [536, 444, 'open'],
    [900, 900, 'open'],
  ])('%f x %f is %s', (w, h, level) => {
    expect(detailLevel(w, h)).toBe(level);
  });

  it('an icon\'s glyph scales with it, and is 48 on a 76 tile', () => {
    expect(iconGlyphSize(76, 76)).toBe(48);
    expect(iconGlyphSize(56, 200)).toBe(35);
  });

  it('each grid level has the size that level starts at', () => {
    for (const level of ['icon', 'small', 'wide', 'large', 'open'] as const) {
      const { w, h } = levelSize(level);
      expect(detailLevel(w, h)).toBe(level);
    }
  });
});

describe('the phone grid', () => {
  it('fills row-major, first fit', () => {
    const { slots, rows } = packItems([entry('a'), entry('b'), entry('c')], 2);
    expect(rows).toBe(2);
    expect(slots['a']).toMatchObject({ x: G.padX, y: G.padTop });
    expect(slots['b']).toMatchObject({ x: G.padX + G.pitch, y: G.padTop });
    expect(slots['c']).toMatchObject({ x: G.padX, y: G.padTop + G.pitch });
  });

  it('puts an icon back into a gap a widget left', () => {
    const { slots } = packItems([entry('a'), entry('w', 'small'), entry('b')], 3);
    expect(slots['w']).toMatchObject({ x: G.padX + G.pitch, y: G.padTop, w: span(2), h: span(2) });
    expect(slots['b']).toMatchObject({ x: G.padX, y: G.padTop + G.pitch });
  });

  it('renders a too-wide item at the next level that fits', () => {
    expect(fittedLevel('large', 2)).toBe('small');
    expect(fittedLevel('wide', 3)).toBe('small');
    expect(fittedLevel('small', 1)).toBe('icon');
    expect(packItems([entry('w', 'wide')], 2).slots['w']).toMatchObject({ level: 'small', w: span(2) });
  });

  it('packs into four columns from the list order, and reads no stored position', () => {
    const items = Array.from({ length: 5 }, (_, i) => app(`i${i}`, 900 - i * 100, 700));
    const desk: LayoutDesk = { id: 'd', x: 0, y: 36, w: 2000, h: 2000, items };
    const g = deskGeometry(desk, true);
    expect(g.w).toBe(panelW(4));
    expect(g.h).toBe(panelH(2));
    expect(g.slots['i0']).toMatchObject({ x: G.padX, y: G.padTop });
    expect(g.slots['i4']).toMatchObject({ x: G.padX, y: G.padTop + G.pitch });
  });

  it('an empty desk still has a row', () => {
    expect(deskGeometry({ id: 'd', x: 0, y: 36, w: 584, h: 144, items: [] }, true).h).toBe(panelH(1));
  });
});

describe('desks', () => {
  it('starts a primary desk at 584 x 236 with four icons in a row at the top', () => {
    const d = defaultDesk('d', 0, 36);
    expect(d.items.map((i) => i.app)).toEqual(['chat', 'notebook', 'browser', 'agent']);
    expect(deskGeometry(d)).toMatchObject({ w: 584, h: 236 });
    expect(d.items.map((i) => i.x)).toEqual([24, 116, 208, 300]);
    expect(d.items.every((i) => i.y === 24 && i.w === 76 && i.h === 76)).toBe(true);
  });

  it('reads an app straight from where it is stored', () => {
    const desk: LayoutDesk = { id: 'd', x: 0, y: 36, w: 700, h: 400, items: [app('a', 33.5, 41.25, 200, 180)] };
    expect(deskGeometry(desk)).toMatchObject({ w: 700, h: 400 });
    expect(deskGeometry(desk).slots['a']).toEqual({ x: 33.5, y: 41.25, w: 200, h: 180, level: 'small' });
  });

  it('is just its panel in its bounds, with nothing above it', () => {
    expect(deskBounds(defaultDesk('d', 10, 50))).toEqual({ x: 10, y: 50, w: 584, h: 236 });
  });

  it('places a new desk right of the last one in the bottom row, however wide it has grown', () => {
    const a = defaultDesk('a', 0, 36);
    expect(placeNewDesk([])).toEqual({ x: 0, y: 0 });
    expect(placeNewDesk([a])).toEqual({ x: 584 + 72, y: 36 });
    expect(placeNewDesk([{ ...a, w: 701.5 }])).toEqual({ x: 701.5 + 72, y: 36 });
  });

  it('unions rects', () => {
    expect(unionBounds([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 30, h: 15 });
  });
});

describe('free desk growth', () => {
  const items = [app('a', 24, 24), app('b', 300, 200, 100, 80)];

  it('takes any size above its minimum, with no snapping', () => {
    expect(fitDeskSize(items, 613.37, 401.91)).toEqual({ w: 613.37, h: 401.91 });
    expect(fitDeskSize(items, 613.371, 401.919)).toEqual({ w: 613.37, h: 401.92 });
  });

  it("can't shrink past what it holds: the apps' far edges, the side margin and the strip", () => {
    expect(minDeskSize(items)).toEqual({ w: 300 + 100 + G.edge, h: 200 + 80 + G.strip });
    expect(fitDeskSize(items, 10, 10)).toEqual(minDeskSize(items));
    expect(fitDeskSize(items, 1000, 10)).toEqual({ w: 1000, h: 324 });
  });

  it('an empty desk still has a floor', () => {
    expect(minDeskSize([])).toEqual({ w: G.minDeskW, h: G.minDeskH });
  });

  it('a minimum-size app fits a minimum-size desk', () => {
    expect(G.minDeskH).toBe(G.padTop + 56 + G.strip);
    expect(minDeskSize([app('a', G.padX, G.padTop, 56, 56)]).h).toBe(G.minDeskH);
  });

  it('never leaves a desk smaller than it holds, for any size asked', () => {
    let seed = 1;
    const next = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 2000; i += 1) {
      const list = Array.from({ length: Math.floor(next() * 6) }, (_, n) => app(`i${n}`, next() * 900, next() * 900, 56 + next() * 400, 56 + next() * 400));
      const { w, h } = fitDeskSize(list, next() * 2000 - 200, next() * 2000 - 200);
      for (const it of list) {
        expect(it.x + it.w + G.edge).toBeLessThanOrEqual(w + 0.01);
        expect(it.y + it.h + G.strip).toBeLessThanOrEqual(h + 0.01);
      }
    }
  });

  it('deskFromGrid never makes a desk too short for its apps', () => {
    const d = deskFromGrid({ id: 'd', x: 0, y: 36, cols: 2, rows: 1, items: Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, app: 'chat' as const, level: 'icon' as const })) });
    expect(d.h).toBe(panelH(3));
    expect(d.w).toBe(G.minDeskW); // two cells is narrower than the smallest desk
    expect(panelW(2)).toBeLessThan(G.minDeskW);
  });
});

describe('a new desk (ADR 0062, item 7)', () => {
  const fresh = defaultDesk('d', 0, 0);
  const area = workArea(fresh.w, fresh.h);
  const item = (app: AppId) => fresh.items.find((i) => i.app === app)!;
  const moved = (app: AppId, change: Partial<LayoutDesk['items'][number]>): LayoutDesk => ({ ...fresh, items: fresh.items.map((i) => (i.app === app ? { ...i, ...change } : i)) });

  it('has a free band under its row, 92 tall, down to the strip', () => {
    expect(area.y + area.h).toBe(236 - G.strip);
    expect(area.y + area.h - (item('chat').y + item('chat').h)).toBe(92);
  });

  it('an app can go under the row, along it past the others, and back up beyond them', () => {
    const chat = item('chat');
    const down = clampMove(chat, { x: 24, y: 116 }, area);
    expect(down).toEqual({ x: 24, y: 116 });
    const along = clampMove({ ...chat, ...down }, { x: 424, y: 116 }, area);
    expect(along).toEqual({ x: 424, y: 116 });
    expect(clampMove({ ...chat, ...along }, { x: 424, y: 24 }, area)).toEqual({ x: 424, y: 24 });
  });

  it('a desk still 144 tall leaves an app no way under the row, which is why the default changed', () => {
    expect(clampMove(item('chat'), { x: 24, y: 116 }, workArea(584, 144))).toEqual({ x: 24, y: 24 });
    expect(clampResize(item('agent'), 168, 168, workArea(584, 144)).h).toBe(76);
  });

  it('an app can reach widget height, and stops at the strip\'s top edge', () => {
    expect(clampResize(item('agent'), 168, 168, area)).toEqual({ w: 168, h: 168 });
    expect(detailLevel(168, 168)).toBe('small');
    expect(clampResize(item('agent'), 168, 900, area)).toEqual({ w: 168, h: 168 });
    expect(clampResize(item('chat'), 900, 168, area)).toEqual({ w: 552, h: 168 }); // over the Notebook and the rest
  });

  describe('cleaning it up', () => {
    it('finds nothing to do on a new desk', () => {
      expect(tidyDesk(fresh)).toBe(fresh);
    });

    it('puts apps at the default size back in one row at the top, with the band free and the desk the same size', () => {
      const after = tidyDesk(moved('chat', { y: 116 }));
      expect(after).toMatchObject({ w: 584, h: 236 });
      expect(after.items.every((i) => i.y === 24 && i.w === 76 && i.h === 76)).toBe(true);
      // An app dragged a whole row down reads last, so it lands at the end of the row, not back in its old place.
      expect(Object.fromEntries(after.items.map((i) => [i.app, i.x]))).toEqual({ notebook: 24, browser: 116, agent: 208, chat: 300 });
    });

    it('an app that\'s only slightly out of the row keeps its place in it', () => {
      const after = tidyDesk(moved('chat', { y: 40 }));
      expect(Object.fromEntries(after.items.map((i) => [i.app, i.x]))).toEqual({ chat: 24, notebook: 116, browser: 208, agent: 300 });
    });

    it('keeps an app at widget height, which fits exactly, so the desk doesn\'t grow', () => {
      const after = tidyDesk(moved('chat', { x: 400, y: 24, w: 168, h: 168 }));
      expect(after.h).toBe(236);
      expect(after.items.find((i) => i.app === 'chat')).toMatchObject({ w: 168, h: 168 });
    });

    it('grows by 16 for an app as tall as the work area, as it did at the old height, since it moves down to the padding', () => {
      expect(tidyDesk(moved('chat', { x: 400, y: 8, h: 184 })).h).toBe(236 + 16);
      const old: LayoutDesk = { ...moved('chat', { x: 400, y: 8, h: 92 }), h: 144 };
      expect(tidyDesk(old).h).toBe(144 + 16);
    });
  });
});

describe('free placement: the work area', () => {
  it('sits inside the desk and above the strip, and an app may reach the strip', () => {
    expect(workArea(584, 144)).toEqual({ x: G.edge, y: G.edge, w: 584 - 2 * G.edge, h: 144 - G.edge - G.strip });
    const area = workArea(584, 144);
    expect(area.y + area.h).toBe(144 - G.strip);
  });

  it('a default desk\'s apps are all placed', () => {
    const d = defaultDesk('d', 0, 36);
    for (const i of d.items) expect(isPlaced(i, workArea(d.w, d.h))).toBe(true);
  });

  it('touching isn\'t overlapping', () => {
    const a = { x: 0, y: 0, w: 76, h: 76 };
    expect(overlaps(a, { x: 76, y: 0, w: 76, h: 76 })).toBe(false);
    expect(overlaps(a, { x: 75.99, y: 0, w: 76, h: 76 })).toBe(true);
    expect(overlaps(a, { x: 76, y: 76, w: 76, h: 76 })).toBe(false);
  });
});

describe('free placement: moving', () => {
  const area = workArea(800, 500);
  const me = { x: 24, y: 24, w: 76, h: 76 };

  it('goes exactly where it\'s asked, with no grid', () => {
    expect(clampMove(me, { x: 133.37, y: 77.91 }, area)).toEqual({ x: 133.37, y: 77.91 });
  });

  it('stops at the desk\'s edges, and can reach the strip', () => {
    expect(clampMove(me, { x: -500, y: -500 }, area)).toEqual({ x: G.edge, y: G.edge });
    expect(clampMove(me, { x: 5000, y: 5000 }, area)).toEqual({ x: 800 - G.edge - 76, y: 500 - G.strip - 76 });
  });

  it('keeps to a hundredth of a unit', () => {
    expect(clampMove(me, { x: 100.123, y: 200.456 }, area)).toEqual({ x: 100.12, y: 200.46 });
  });

  it('stays on a desk it\'s too big for', () => {
    expect(clampMove({ ...me, w: 2000, h: 2000 }, { x: 300, y: 300 }, area)).toEqual({ x: G.edge, y: G.edge });
  });
});

describe('the stack', () => {
  const items = [app('a', 24, 24), app('b', 24, 24), app('c', 24, 24)];
  const order = ['a', 'b', 'c'];
  const desk = (stack?: string[]): LayoutDesk => ({ id: 'd', x: 0, y: 0, w: 800, h: 500, items, ...(stack ? { stack } : {}) });

  it('brings an app to the front, keeping the others in their order', () => {
    expect(restacked(order, 'a', 'front')).toEqual(['b', 'c', 'a']);
    expect(restacked(order, 'b', 'front')).toEqual(['a', 'c', 'b']);
  });

  it('sends an app to the back, keeping the others in their order', () => {
    expect(restacked(order, 'c', 'back')).toEqual(['c', 'a', 'b']);
    expect(restacked(order, 'b', 'back')).toEqual(['b', 'a', 'c']);
  });

  it('hands back the same array if it\'s already there, or isn\'t on this desk', () => {
    expect(restacked(order, 'c', 'front')).toBe(order);
    expect(restacked(order, 'a', 'back')).toBe(order);
    expect(restacked(order, 'nope', 'front')).toBe(order);
  });

  it('with no stack, it\'s the list\'s order', () => {
    expect(stackOrder(desk())).toEqual(order);
  });

  it('a whole stack is read as it is', () => {
    expect(stackOrder(desk(['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('an app it doesn\'t list goes on top, in the list\'s order', () => {
    expect(stackOrder(desk(['b']))).toEqual(['b', 'a', 'c']);
    expect(stackOrder(desk([]))).toEqual(order);
  });

  it('an id that isn\'t on this desk is dropped, and so is a repeat', () => {
    expect(stackOrder(desk(['gone', 'c', 'c', 'a', 'gone', 'a']))).toEqual(['c', 'a', 'b']);
    expect(stackOrder(desk(['gone']))).toEqual(order);
  });

  it('isn\'t stored while it says what the list says', () => {
    const plain = desk();
    expect(withStack(plain, order)).toEqual(plain);
    expect('stack' in withStack(plain, order)).toBe(false);
    expect('stack' in withStack(desk(['c', 'a', 'b']), order)).toBe(false);
  });

  it('is stored when it doesn\'t, as its own copy, and last, so a saved desk reads the same each time', () => {
    const next = withStack(desk(), ['c', 'a', 'b']);
    expect(next.stack).toEqual(['c', 'a', 'b']);
    expect(next.items).toBe(items);
    expect(Object.keys(next)).toEqual(['id', 'x', 'y', 'w', 'h', 'items', 'stack']);
    expect(Object.keys(withStack(desk(['b', 'a', 'c']), ['c', 'a', 'b']))).toEqual(['id', 'x', 'y', 'w', 'h', 'items', 'stack']);
  });

  it('settling a desk keeps its stack, and its list\'s order', () => {
    const settled = settleDesk(desk(['c', 'a', 'b']));
    expect(settled.stack).toEqual(['c', 'a', 'b']);
    expect(settled.items.map((i) => i.id)).toEqual(order);
  });

  it('a phone\'s grid packs from the list, whatever the stack says', () => {
    const grid = deskGeometry(desk(), true);
    expect(deskGeometry(desk(['c', 'b', 'a']), true)).toEqual(grid);
    expect(grid.slots['a']!.x).toBeLessThan(grid.slots['b']!.x);
    expect(grid.slots['b']!.x).toBeLessThan(grid.slots['c']!.x);
  });
});

describe('cleanup', () => {
  const desk = (w: number, h: number, items: LayoutDesk['items']): LayoutDesk => ({ id: 'd', x: 10, y: 20, w, h, items });
  const at = (d: LayoutDesk, id: string): { x: number; y: number } => {
    const { x, y } = d.items.find((i) => i.id === id)!;
    return { x, y };
  };

  function assertTidy(before: LayoutDesk, after: LayoutDesk, note: string): void {
    expect(after.items.length, note).toBe(before.items.length);
    expect(after.w, note).toBe(before.w); // keeps its width
    expect(after.h, note).toBeGreaterThanOrEqual(before.h); // and never gets smaller
    expect(after.x, note).toBe(before.x);
    expect(after.y, note).toBe(before.y);
    const area = workArea(after.w, after.h);
    for (const item of after.items) {
      const was = before.items.find((i) => i.id === item.id)!;
      expect(item.w, note).toBe(was.w); // never shrinks
      expect(item.h, note).toBe(was.h);
      expect(item.y + item.h, note).toBeLessThanOrEqual(after.h - G.strip + 0.001);
      expect(item.y, note).toBeGreaterThanOrEqual(G.padTop - 0.001);
      if (item.w <= after.w - 2 * G.padX) {
        expect(item.x, note).toBeGreaterThanOrEqual(G.padX - 0.001);
        expect(item.x + item.w, note).toBeLessThanOrEqual(after.w - G.padX + 0.001);
      }
      const others = after.items.filter((o) => o !== item);
      expect(isPlaced(item, area), `${note}: ${JSON.stringify(item)}`).toBe(true);
      // 16 between apps, so nothing overlaps.
      const grown = { x: item.x - G.gap, y: item.y - G.gap, w: item.w + 2 * G.gap, h: item.h + 2 * G.gap };
      for (const o of others) expect(overlaps(grown, o), `${note}: ${JSON.stringify([item, o])}`).toBe(false);
    }
  }

  it('lines scattered apps up in reading order, so what was near stays near', () => {
    const before = desk(800, 500, [app('a', 300, 200), app('b', 40, 190), app('c', 500, 30), app('d', 200, 40)]);
    const after = tidyDesk(before);
    expect(tidyOrder(before.items).map((i) => i.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(at(after, 'd')).toEqual({ x: 24, y: 24 });
    expect(at(after, 'c')).toEqual({ x: 116, y: 24 });
    expect(at(after, 'b')).toEqual({ x: 208, y: 24 });
    expect(at(after, 'a')).toEqual({ x: 300, y: 24 });
    assertTidy(before, after, 'scattered');
  });

  it('reads a rough row left to right, whichever app sits a little higher', () => {
    const before = desk(800, 500, [app('right', 400, 60), app('left', 100, 70)]);
    expect(at(tidyDesk(before), 'left')).toEqual({ x: 24, y: 24 });
    expect(at(tidyDesk(before), 'right')).toEqual({ x: 116, y: 24 });
  });

  it('leaves a tidy desk alone: it hands back the same desk', () => {
    const d = defaultDesk('d', 0, 0);
    expect(tidyDesk(d)).toBe(d);
    const grid = deskFromGrid({ id: 'g', x: 0, y: 0, cols: 4, rows: 3, items: Array.from({ length: 11 }, (_, i) => ({ id: `i${i}`, app: 'chat' as const, level: i === 0 ? 'small' as const : 'icon' as const })) });
    expect(tidyDesk(grid)).toBe(grid);
    const empty = desk(584, 144, []);
    expect(tidyDesk(empty)).toBe(empty);
  });

  it('fills a hole with a later app, as the top-left-most free spot', () => {
    const before = desk(584, 600, [app('a', 24, 24), app('big', 116, 24, 352, 352), app('wide', 24, 400, 352, 76), app('d', 400, 400)]);
    const after = tidyDesk(before);
    expect(at(after, 'd')).toEqual({ x: 484, y: 24 }); // beside the big one, not below the wide one
    assertTidy(before, after, 'hole');
    expect(tidyDesk(after)).toBe(after);
  });

  it('keeps the desk\'s size, and grows it downward only when the apps need more room', () => {
    const roomy = desk(800, 500, [app('a', 400, 300)]);
    expect(tidyDesk(roomy).h).toBe(500);
    const tight = desk(300, 240, [app('a', 8, 8, 120, 120), app('b', 140, 8, 120, 120), app('c', 8, 130, 200, 66)]);
    const after = tidyDesk(tight);
    expect(after.w).toBe(300);
    expect(after.h).toBeGreaterThan(240);
    assertTidy(tight, after, 'tight');
  });

  it('an app wider than the padding allows stays on the desk, centered, and the desk keeps its width', () => {
    const before = desk(400, 300, [app('w', 8, 8, 380, 80), app('b', 8, 100)]);
    const after = tidyDesk(before);
    expect(after.w).toBe(400);
    expect(at(after, 'w')).toEqual({ x: 10, y: 24 });
    expect(at(after, 'b')).toEqual({ x: 24, y: 120 });
    assertTidy(before, after, 'wide');
  });

  it('packing with the order kept never changes the reading order', () => {
    const items = [app('a', 24, 24), app('j', 24, 116, 361, 76), app('k', 401, 24, 75, 200)];
    const packed = tidyPack(tidyOrder(items), 500, true);
    expect(tidyOrder(packed).map((i) => i.id)).toEqual(tidyOrder(items).map((i) => i.id));
  });

  it('never overlaps or shrinks, grows only downward, and running it twice changes nothing, on random desks', () => {
    let keptOrder = 0;
    for (let seed = 1; seed <= 1500; seed += 1) {
      let s = seed * 7919;
      const rnd = (): number => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
      const w = roundUnit(G.minDeskW + rnd() * 900);
      const count = Math.floor(rnd() * 13);
      const items: LayoutDesk['items'] = [];
      for (let i = 0; i < count; i += 1) {
        const big = rnd() < 0.3;
        const aw = roundUnit(G.minApp + rnd() * (big ? w - G.minApp - 2 * G.edge : 120));
        const ah = roundUnit(G.minApp + rnd() * (big ? 400 : 120));
        items.push(app(`i${i}`, roundUnit(G.edge + rnd() * (w - aw - 2 * G.edge)), roundUnit(G.edge + rnd() * 900), aw, ah));
      }
      const before = settleDesk(desk(w, roundUnit(G.minDeskH + rnd() * 500), items));
      const after = tidyDesk(before);
      assertTidy(before, after, `seed ${seed}`);
      expect(tidyDesk(after), `seed ${seed}: twice`).toBe(after);
      if (!sameOrderOf(tidyPack(tidyOrder(before.items), before.w), after)) keptOrder += 1;
    }
    expect(keptOrder).toBeGreaterThan(0); // holes get filled, and the order settles after more than one pass
  });

  describe('from apps stacked over each other (ADR 0064)', () => {
    const stacked = (n: number, w = 76, h = 76, x = 100, y = 100): LayoutDesk['items'] => Array.from({ length: n }, (_, i) => app(`i${i}`, x, y, w, h));

    it('counts any overlap as something to change', () => {
      const clean = desk(800, 500, [app('a', 24, 24), app('b', 116, 24)]);
      expect(tidyDesk(clean)).toBe(clean);
      const over = desk(800, 500, [app('a', 24, 24), app('b', 60, 24)]);
      expect(tidyDesk(over)).not.toBe(over);
      const twin = desk(800, 500, [app('a', 24, 24), app('b', 24, 24)]);
      expect(tidyDesk(twin)).not.toBe(twin);
      const barely = desk(800, 500, [app('a', 24, 24), app('b', 99.99, 24)]);
      expect(tidyDesk(barely)).not.toBe(barely);
    });

    it('takes apps at the same place and size apart, with no overlap and no shrinking', () => {
      const before = desk(800, 500, stacked(4));
      const after = tidyDesk(before);
      assertTidy(before, after, 'identical');
      expect(after.items.map((i) => i.x)).toEqual([24, 116, 208, 300]); // ties go by id
      expect(tidyDesk(after)).toBe(after);
    });

    it('a whole desk of apps at one place grows the desk downward, never shrinks one, and settles', () => {
      const before = desk(300, 200, stacked(9, 120, 90, 8, 8));
      const after = tidyDesk(before);
      assertTidy(before, after, 'tight');
      expect(after.h).toBeGreaterThan(200);
      expect(tidyDesk(after)).toBe(after);
    });

    it('doesn\'t depend on how they\'re stacked: any order of the list gives the same places', () => {
      const items = [app('a', 100, 100), app('b', 100, 100, 200, 180), app('c', 130, 110), app('d', 100, 100)];
      const places = (list: LayoutDesk['items']): string => {
        const d = tidyDesk(desk(800, 500, list));
        return ['a', 'b', 'c', 'd'].map((id) => JSON.stringify(at(d, id))).join();
      };
      const want = places(items);
      for (const list of [[...items].reverse(), [items[2]!, items[0]!, items[3]!, items[1]!], [items[3]!, items[2]!, items[1]!, items[0]!]]) expect(places(list)).toBe(want);
    });

    it('a tidy desk stays tidy whatever its stacking: order alone is nothing to clean up', () => {
      const d = defaultDesk('d', 0, 0);
      const flipped = { ...d, items: [...d.items].reverse() };
      expect(tidyDesk(flipped)).toBe(flipped);
      const stacked = withStack(d, stackOrder(d).reverse());
      expect(tidyDesk(stacked)).toBe(stacked);
    });

    it('leaves the list in its order, since that\'s a phone\'s grid, and the same with the stack, which cleanup itself resets', () => {
      const before: LayoutDesk = { ...desk(800, 500, [app('a', 300, 200), app('b', 40, 190), app('c', 500, 30), app('d', 200, 40)]), stack: ['c', 'a', 'd', 'b'] };
      const after = tidyDesk(before);
      expect(after).not.toBe(before);
      expect(after.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
      expect(after.stack).toEqual(['c', 'a', 'd', 'b']);
      expect(tidyDesk(after)).toBe(after);
    });

    it('never overlaps or shrinks, and running it twice changes nothing, on random stacks', () => {
      for (let seed = 1; seed <= 800; seed += 1) {
        let s = seed * 104723;
        const rnd = (): number => {
          s = (s * 16807) % 2147483647;
          return s / 2147483647;
        };
        const w = roundUnit(G.minDeskW + rnd() * 700);
        // A few piles: some apps exactly on top of each other, the rest nearby.
        const piles = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ x: roundUnit(G.edge + rnd() * 100), y: roundUnit(G.edge + rnd() * 100) }));
        const items: LayoutDesk['items'] = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => {
          const pile = piles[Math.floor(rnd() * piles.length)]!;
          const exact = rnd() < 0.5;
          return app(`i${i}`, exact ? pile.x : roundUnit(pile.x + rnd() * 40), exact ? pile.y : roundUnit(pile.y + rnd() * 40), exact ? 76 : roundUnit(G.minApp + rnd() * 90), exact ? 76 : roundUnit(G.minApp + rnd() * 90));
        });
        const before = settleDesk(desk(w, roundUnit(G.minDeskH + rnd() * 300), items));
        const after = tidyDesk(before);
        assertTidy(before, after, `stack seed ${seed}`);
        expect(tidyDesk(after), `stack seed ${seed}: twice`).toBe(after);
      }
    });
  });
});

function sameOrderOf(a: LayoutDesk['items'], d: LayoutDesk): boolean {
  return a.every((i) => {
    const o = d.items.find((x) => x.id === i.id)!;
    return o.x === i.x && o.y === i.y;
  });
}

describe('the strip', () => {
  const widthOf = (s: string): number => Array.from(s).length * 10;

  it('sizes are CSS pixels, and constants: nothing in them takes a zoom', () => {
    expect(ETCH_SIZE).toBe(14);
    expect(ETCH_ICON).toBe(16);
    expect(ETCH_BASELINE).toBe(17);
    expect(ETCH_DEPTH).toBe(1);
    expect(stripTarget(false)).toBe(28);
    expect(stripTarget(true)).toBe(44);
  });

  it('every icon\'s center is on the name\'s center line', () => {
    // Capitals are 0.7 em, so they run 17 to 26.8 up, and the lip takes them down to 16: their middle is 21.4.
    expect(Math.abs(STRIP.iconUp - (ETCH_BASELINE - ETCH_DEPTH + (ETCH_SIZE * 0.7 + ETCH_DEPTH) / 2))).toBeLessThan(1);
    // A target that's centered there fits the strip's bottom edge on touch, with a margin on a mouse.
    expect(STRIP.iconUp - stripTarget(true) / 2).toBe(0);
    expect(STRIP.iconUp - stripTarget(false) / 2).toBe(8);
  });

  it('the row from the right is the grip, cleanup, then the hidden count, with no empty slot inside it', () => {
    expect(slotRight('grip', false)).toBe(6);
    expect(slotRight('cleanup', false)).toBe(42);
    expect(slotRight('count', false, 28)).toBe(78); // past the sparkle's slot while it's held
    expect(slotRight('count', false, 46)).toBe(96); // and past "Undo"
    expect(slotRight('count', false, 0)).toBe(42); // or straight after the grip's, with no hole where cleanup's would be
    expect(slotRight('count', false)).toBe(42);
    expect(slotRight('grip', true)).toBe(0);
    expect(slotRight('cleanup', true)).toBe(44);
    expect(slotRight('count', true, 44)).toBe(88);
    expect(slotRight('count', true, 0)).toBe(44);
    expect(countSlotW(false)).toBe(46);
    expect(countSlotW(true)).toBe(62);
  });

  it('every pair of neighbours in the row is the same gap apart, target to target', () => {
    for (const touch of [false, true]) {
      const gap = touch ? 0 : STRIP.gap;
      for (const held of [stripTarget(touch), stripTarget(touch) + 18]) {
        const gripLeft = slotRight('grip', touch) + stripTarget(touch);
        const cleanupLeft = slotRight('cleanup', touch) + held;
        expect(slotRight('cleanup', touch) - gripLeft, `${touch} ${held}`).toBe(gap);
        expect(slotRight('count', touch, held) - cleanupLeft, `${touch} ${held}`).toBe(gap);
      }
      expect(slotRight('count', touch, 0) - (slotRight('grip', touch) + stripTarget(touch))).toBe(gap);
    }
  });

  it('a one-digit count\'s ink is as far from the sparkle\'s as the sparkle\'s is from the grip\'s', () => {
    // Ink in each 16 px box: the grip's triangle runs 3.5 to 12.5, the sparkle 1 to 15. A digit about 10 px wide after the
    // icon and 3 px is 29 px, centered in its slot.
    for (const touch of [false, true]) {
      const t = stripTarget(touch);
      const boxRight = (slotEnd: number, w: number): number => slotEnd + (w - ETCH_ICON) / 2; // from the desk's right edge
      const gripInkLeft = boxRight(slotRight('grip', touch), t) + ETCH_ICON - 3.5;
      const sparkleInkRight = boxRight(slotRight('cleanup', touch), t) + 1;
      const sparkleInkLeft = boxRight(slotRight('cleanup', touch), t) + ETCH_ICON - 1;
      const countInkRight = slotRight('count', touch, t) + (countSlotW(touch) - 29) / 2 + 1;
      expect(Math.abs((sparkleInkRight - gripInkLeft) - (countInkRight - sparkleInkLeft)), `touch ${touch}`).toBeLessThanOrEqual(1);
    }
  });

  it('what the name keeps clear of goes by what\'s held, so nothing changes when the pointer comes', () => {
    expect(iconsLeft(false, 0, 0, false)).toBe(6 + 28); // the grip's slot, reserved at rest
    expect(iconsLeft(false, 0, 0, true)).toBe(42 + 46); // the count, beside the grip
    expect(iconsLeft(false, 0, 28, false)).toBe(42 + 28); // cleanup's slot, held
    expect(iconsLeft(false, 0, 28, true)).toBe(78 + 46); // the count is furthest left
    expect(iconsLeft(false, 0, 46, false)).toBe(42 + 46); // "Undo" grows left
    expect(iconsLeft(false, 0, 46, true)).toBe(96 + 46); // and takes the count with it
    expect(iconsLeft(true, 0, 0, false)).toBe(44);
    expect(iconsLeft(true, 0, 44, true)).toBe(88 + 62);
    expect(iconsLeft(false, 5, 0, false)).toBe(6 + 28 + 5);
  });

  it('the row stays put until the panel\'s corner would cut the grip\'s hover pad, then moves in with it', () => {
    expect(cornerInset(0.2)).toBe(0);
    expect(cornerInset(1)).toBe(0);
    expect(cornerInset(1.4)).toBe(0);
    expect(cornerInset(1.75)).toBeCloseTo(3.9, 1);
    expect(cornerInset(3)).toBeCloseTo(22.6, 1);
    // At every zoom, the pad's round corner is inside the panel's.
    for (let s = 0.2; s <= 3; s += 0.01) {
      const r = G.panelRadius * s;
      const x = STRIP.gripRight + cornerInset(s) + STRIP.padRadius;
      const y = STRIP.iconUp - STRIP.target / 2 + STRIP.padRadius;
      if (x < r && y < r) expect(Math.hypot(r - x, r - y) + STRIP.padRadius).toBeLessThanOrEqual(r + 1e-6);
    }
  });

  describe('when there\'s no room', () => {
    it('first the icons hide, under 290 wide or 72 tall on screen', () => {
      expect(iconsFit(290, 72)).toBe(true);
      expect(iconsFit(289.9, 72)).toBe(false);
      expect(iconsFit(290, 71.9)).toBe(false);
      expect(iconsFit(1000, 71.9)).toBe(false);
      expect(iconsFit(289.9, 1000)).toBe(false);
    });

    it('and that clears the way for the name, which then has the desk to its edges', () => {
      const right = (w: number, h: number): number => (iconsFit(w, h) ? iconsLeft(false, 0, 28, true) : 0);
      // A desk just under 290 wide has no icons, so PERSONAL (80) fits. At 290 with the sparkle's slot and a count, it has to give way.
      expect(fitNameText('PERSONAL', nameRoom(200, 0, right(200, 100)), widthOf)).toBe('PERSONAL');
      expect(fitNameText('PERSONAL', nameRoom(289.9, 0, right(289.9, 100)), widthOf)).toBe('PERSONAL');
      expect(iconsFit(290, 100)).toBe(true);
      expect(fitNameText('PERSONAL', nameRoom(290, 0, right(290, 100)), widthOf)).toBe('');
      expect(fitNameText('PERSONAL', nameRoom(320, 0, right(320, 100)), widthOf)).toBe(''); // room for 48
      expect(fitNameText('PERSONAL', nameRoom(322, 0, right(322, 100)), widthOf)).toBe('PERS…'); // room for 50
      expect(fitNameText('PERSONAL', nameRoom(340, 0, right(340, 100)), widthOf)).toBe('PERSO…');
      expect(fitNameText('PERSONAL', nameRoom(360, 0, right(360, 100)), widthOf)).toBe('PERSONAL');
    });

    it('the name is centered, so its room is twice what the nearer side leaves, less 12 there', () => {
      expect(nameRoom(584, 0, 0)).toBe(584 - 24);
      expect(nameRoom(584, 0, 34)).toBe(2 * (292 - 34 - 12));
      expect(nameRoom(584, 128, 34)).toBe(2 * (292 - 128 - 12));
      expect(nameRoom(584, 34, 128)).toBe(2 * (292 - 128 - 12));
      expect(nameRoom(40, 0, 0)).toBe(16);
      expect(nameRoom(20, 0, 0)).toBe(0);
      expect(nameRoom(584, 500, 0)).toBe(0);
    });

    it('12 px from the status line is what ellipsizes it: within 12, it gives way', () => {
      // The name is 80 wide on a desk 400 wide, so it spans 160 to 240. A status line can end at 148.
      expect(fitNameText('PERSONAL', nameRoom(400, 148, 0), widthOf)).toBe('PERSONAL');
      expect(fitNameText('PERSONAL', nameRoom(400, 149, 0), widthOf)).toBe('PERSON…');
    });

    it('it ellipsizes first, and hides only when fewer than four characters would fit', () => {
      expect(MIN_NAME_CHARS).toBe(4);
      expect(fitNameText('PERSONAL', 80, widthOf)).toBe('PERSONAL');
      expect(fitNameText('PERSONAL', 79, widthOf)).toBe('PERSON…');
      expect(fitNameText('PERSONAL', 50, widthOf)).toBe('PERS…'); // four, and the ellipsis
      expect(fitNameText('PERSONAL', 49, widthOf)).toBe(''); // three would fit, so it hides
      expect(fitNameText('PERSONAL', 0, widthOf)).toBe('');
    });

    it('a name that fits whole is never held to the limit, however short', () => {
      expect(fitNameText('HQ', 20, widthOf)).toBe('HQ');
      expect(fitNameText('HQ', 19, widthOf)).toBe('');
      expect(fitNameText('WORK', 40, widthOf)).toBe('WORK');
      expect(fitNameText('WORK', 39, widthOf)).toBe(''); // can't drop a letter and stay at four
      expect(fitNameText('GUILD', 50, widthOf)).toBe('GUILD');
      expect(fitNameText('GUILD', 49, widthOf)).toBe('');
    });

    it('counts characters, not code units, and no space before the ellipsis counts as one', () => {
      expect(fitNameText('😀😀😀😀😀😀', 50, widthOf)).toBe('😀😀😀😀…');
      expect(fitNameText('😀😀😀😀😀😀', 49, widthOf)).toBe('');
      expect(fitNameText('ABC DEFGH', 50, widthOf)).toBe('');  // "ABC " trims to three
      expect(fitNameText('ABC DEFGH', 60, widthOf)).toBe('ABC D…');
    });
  });

  it('the status text runs up to the grip\'s glyph or what\'s in cleanup\'s slot, the same on screen at any zoom', () => {
    expect(statusClear(false, 0, 0, false)).toBe(28);
    expect(statusClear(false, 0, 28, false)).toBe(42 + 28);
    expect(statusClear(false, 0, 28, true)).toBe(78 + 46); // the count is further left than cleanup
    expect(statusClear(false, 0, 0, true)).toBe(42 + 46);
    expect(statusClear(true, 0, 0, false)).toBe(30);
    expect(statusRoom(584, STRIP.textX, 1, 28)).toBe(584 - 40 - 28);
    expect(statusRoom(584, STRIP.textX, 0.5, 28)).toBe(584 - 40 - 56);
    expect(statusRoom(584, STRIP.textX, 2, 28)).toBe(584 - 40 - 14);
    expect(statusRoom(584, STRIP.textX + STRIP.markW, 1, 28)).toBe(584 - 60 - 28);
  });

  it('the carousel\'s switch is next to the grip, a gap apart, and the rest of the row moves along one slot for it', () => {
    expect(slotRight('carousel', false)).toBe(42);
    expect(slotRight('cleanup', false, 0, true)).toBe(78);
    expect(slotRight('count', false, 28, true)).toBe(114);
    expect(slotRight('count', false, 0, true)).toBe(78);
    expect(slotRight('carousel', true)).toBe(44);
    expect(slotRight('cleanup', true, 0, true)).toBe(88);
    // Its slot is held at rest, like the grip's, so it's in the same place in both modes and the name never moves for it.
    expect(iconsLeft(false, 0, 0, false, true)).toBe(42 + 28);
    expect(iconsLeft(false, 0, 28, true, true)).toBe(114 + 46);
    expect(statusClear(false, 0, 0, false, true)).toBe(42 + 22);
    for (const touch of [false, true]) {
      const gap = touch ? 0 : STRIP.gap;
      expect(slotRight('carousel', touch) - (slotRight('grip', touch) + stripTarget(touch))).toBe(gap);
      expect(slotRight('cleanup', touch, 0, true) - (slotRight('carousel', touch) + stripTarget(touch))).toBe(gap);
    }
  });

  it('the switch is in the row only from 300 units wide, where the icons show, whatever the zoom', () => {
    expect(switchFits(300, 72)).toBe(true);
    expect(switchFits(299.9, 236)).toBe(false);
    expect(switchFits(1000, 71.9)).toBe(false);
  });

  it('and only where the longest status line still fits beside it, so the smallest desks keep the line before the switch', () => {
    for (const w of [G.minDeskW, 300, 584, 1200]) {
      if (!switchFits(w, 236)) continue;
      expect(statusRoom(w, STRIP.textX, 1, statusClear(false, 0, 0, false, true)), `${w}`).toBeGreaterThanOrEqual(STATUS_LONGEST);
    }
    expect(switchFits(584, 236)).toBe(true); // a new desk has it
    expect(switchFits(G.minDeskW, 124)).toBe(false); // the smallest keeps its status line
  });

  it('the longest status line fits the smallest desk at the smallest zoom where the icons show', () => {
    const smallestZoom = STRIP.iconsMinW / G.minDeskW;
    expect(statusRoom(G.minDeskW, STRIP.textX, smallestZoom, statusClear(false, cornerInset(smallestZoom), 0, false))).toBeGreaterThanOrEqual(161);
  });

  it('a name that fits is left alone, and a long one gets an ellipsis at the room it has', () => {
    const widthOf = (s: string): number => s.length * 10;
    expect(fitToWidth('PERSONAL', 80, widthOf)).toBe('PERSONAL');
    expect(fitToWidth('PERSONAL', 79, widthOf)).toBe('PERSON…');
    expect(fitToWidth('PERSONAL', 45, widthOf)).toBe('PER…');
    expect(fitToWidth('A VERY LONG', 45, widthOf)).toBe('A V…');
    expect(fitToWidth('A VERY LONG', 35, widthOf)).toBe('A…'); // no space before the ellipsis
    expect(fitToWidth('PERSONAL', 5, widthOf)).toBe('…');
    expect(fitToWidth('😀😀😀😀', 25, (s) => Array.from(s).length * 10)).toBe('😀…'); // never inside a character
  });
});

describe('free placement: resizing', () => {
  const area = workArea(800, 500);
  const me = { x: 24, y: 24, w: 76, h: 76 };

  it('takes any size, with no steps', () => {
    expect(clampResize(me, 133.37, 91.5, area)).toEqual({ w: 133.37, h: 91.5 });
  });

  it('keeps its minimum', () => {
    expect(G.minApp).toBe(56);
    expect(clampResize(me, 1, 1, area)).toEqual({ w: 56, h: 56 });
    expect(clampResize(me, -50, 120, area)).toEqual({ w: 56, h: 120 });
  });

  it('stops at the desk\'s edges, and can reach the strip', () => {
    expect(clampResize(me, 5000, 5000, area)).toEqual({ w: 800 - G.edge - 24, h: 500 - G.strip - 24 });
    expect(clampResize({ ...me, x: 400, y: 300 }, 5000, 5000, area)).toEqual({ w: 800 - G.edge - 400, h: 500 - G.strip - 300 });
  });
});

describe('free placement: arrow keys', () => {
  const area = workArea(800, 500);
  const me = { x: 24, y: 24, w: 76, h: 76 };

  it('moves one step', () => {
    expect(nudgeMove(me, 1, 0, 8, area)).toEqual({ x: 32, y: 24 });
    expect(nudgeMove(me, 0, 1, 40, area)).toEqual({ x: 24, y: 64 });
  });

  it('stops only at the edge, and says so', () => {
    expect(nudgeMove({ ...me, x: 12 }, -1, 0, 8, area)).toEqual({ x: 8, y: 24 });
    expect(nudgeMove({ ...me, x: 8 }, -1, 0, 8, area)).toBeNull();
    expect(nudgeMove({ ...me, y: 500 - G.strip - 76 }, 0, 1, 8, area)).toBeNull();
    expect(nudgeMove({ ...me, y: 500 - G.strip - 76 - 4 }, 0, 1, 40, area)).toEqual({ x: 24, y: 500 - G.strip - 76 });
  });

  it('resizes one step, and says when it can\'t', () => {
    expect(nudgeResize(me, 1, 0, 8, area)).toEqual({ w: 84, h: 76 });
    expect(nudgeResize({ ...me, w: 56 }, -1, 0, 8, area)).toBeNull();
    expect(nudgeResize({ ...me, x: 800 - G.edge - 76 }, 1, 0, 8, area)).toBeNull();
    expect(nudgeResize({ ...me, w: 60 }, -1, 0, 8, area)).toEqual({ w: 56, h: 76 });
  });
});

describe('free placement: the free spot', () => {
  const area = workArea(800, 500);
  const me = { x: 24, y: 24, w: 76, h: 76 };

  it('stays put if it\'s already free, and goes to the nearest one if not', () => {
    expect(nearestFree(me, [], area)).toEqual({ x: 24, y: 24 });
    expect(nearestFree(me, [{ x: 24, y: 24, w: 76, h: 76 }], area)).toEqual({ x: 24, y: 100 });
  });

  it('is null if there\'s none', () => {
    expect(nearestFree(me, [{ x: 0, y: 0, w: 800, h: 500 }], area)).toBeNull();
  });
});

describe('free placement: settling a stored desk', () => {
  it('leaves a clean desk exactly as it is', () => {
    const d = defaultDesk('d', 5, 6);
    expect(settleDesk(d)).toEqual(d);
  });

  it('leaves apps over each other where they are, in their order', () => {
    const d: LayoutDesk = { id: 'd', x: 0, y: 36, w: 800, h: 500, items: [app('b', 120, 100), app('a', 100, 100), app('c', 100, 100)] };
    expect(settleDesk(d)).toEqual(d);
  });

  it('grows the desk to hold what it has, and moves nothing to make room', () => {
    const d: LayoutDesk = { id: 'd', x: 0, y: 36, w: 216, h: 124, items: [app('a', 8, 8, 200, 72), app('b', 8, 8, 200, 72)] };
    const s = settleDesk(d);
    expect(s.items).toEqual(d.items);
    for (const i of s.items) expect(i.y + i.h).toBeLessThanOrEqual(s.h - G.strip);
    for (const i of s.items) expect(i.x + i.w).toBeLessThanOrEqual(s.w - G.edge);
  });

  it('brings up an app under the minimum size, and in from outside the desk', () => {
    const s = settleDesk({ id: 'd', x: 0, y: 36, w: 400, h: 300, items: [app('a', -50, -20, 10, 10)] });
    expect(s.items[0]).toMatchObject({ x: G.edge, y: G.edge, w: 56, h: 56 });
  });

  it('an app with no place of its own takes a free spot, and leaves the others alone', () => {
    const d: LayoutDesk = { id: 'd', x: 0, y: 36, w: 800, h: 500, items: [app('a', 100, 100), app('lost', 100, 100), app('b', 120, 100)] };
    const s = settleDesk(d, new Set(['lost']));
    expect(s.items.map((i) => i.id)).toEqual(['a', 'lost', 'b']);
    expect(s.items[0]).toMatchObject({ x: 100, y: 100 });
    expect(s.items[2]).toMatchObject({ x: 120, y: 100 });
    expect(overlaps(s.items[1]!, s.items[0]!)).toBe(false);
    expect(overlaps(s.items[1]!, s.items[2]!)).toBe(false);
  });

  it('an app with no place of its own stays put if there\'s no free spot', () => {
    const d: LayoutDesk = { id: 'd', x: 0, y: 36, w: 232, h: 124, items: [app('a', 8, 8, 216, 72), app('lost', 8, 8, 216, 72)] };
    const s = settleDesk(d, new Set(['lost']));
    expect(s.items[1]).toMatchObject({ x: 8, y: 8 });
    expect(s.h).toBe(124);
  });
});

describe('free placement: no sequence of moves ever leaves the desk', () => {
  // A seeded generator, so a failure repeats.
  const generator = (seed: number) => {
    let s = seed;
    return (): number => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
  };

  function assertValid(desk: LayoutDesk, note: string): void {
    const area = workArea(desk.w, desk.h);
    for (const i of desk.items) {
      if (!isPlaced(i, area)) throw new Error(`${note}: ${JSON.stringify(i)} in ${JSON.stringify(area)}`);
    }
  }

  it('over thousands of random moves, resizes and arrow keys, on crowded desks of any shape', () => {
    let ops = 0;
    let overlapping = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const rnd = generator(seed * 7919);
      const count = 2 + Math.floor(rnd() * 11);
      let desk = settleDesk({
        id: 'd', x: 0, y: 36, w: 216 + rnd() * 900, h: 124 + rnd() * 700,
        items: Array.from({ length: count }, (_, n) => app(`i${n}`, rnd() * 800, rnd() * 600, 56 + rnd() * 200, 56 + rnd() * 200)),
      });
      assertValid(desk, `seed ${seed} start`);
      for (let n = 0; n < 400; n += 1) {
        const pick = Math.floor(rnd() * desk.items.length);
        const item = desk.items[pick]!;
        const area = workArea(desk.w, desk.h);
        const kind = rnd();
        let rect = { x: item.x, y: item.y, w: item.w, h: item.h };
        if (kind < 0.45) {
          rect = { ...rect, ...clampMove(rect, { x: -300 + rnd() * 2000, y: -300 + rnd() * 1600 }, area) };
        } else if (kind < 0.8) {
          rect = { ...rect, ...clampResize(rect, -100 + rnd() * 1200, -100 + rnd() * 1000, area) };
        } else if (kind < 0.9) {
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
          const [dx, dy] = dirs[Math.floor(rnd() * 4)]!;
          const to = nudgeMove(rect, dx, dy, rnd() < 0.5 ? 8 : 40, area);
          if (to) rect = { ...rect, ...to };
        } else {
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
          const [dw, dh] = dirs[Math.floor(rnd() * 4)]!;
          const to = nudgeResize(rect, dw, dh, rnd() < 0.5 ? 8 : 40, area);
          if (to) rect = { ...rect, ...to };
        }
        expect(Number.isFinite(rect.x + rect.y + rect.w + rect.h)).toBe(true);
        const moved = { ...item, ...rect };
        desk = { ...desk, items: [...desk.items.filter((_, k) => k !== pick), moved] };
        ops += 1;
        assertValid(desk, `seed ${seed} step ${n}`);
        if (desk.items.some((o) => o.id !== moved.id && overlaps(o, moved))) overlapping += 1;

        // Now and then the desk is resized too, as far down as it will go.
        if (rnd() < 0.05) desk = { ...desk, ...fitDeskSize(desk.items, rnd() * 1200, rnd() * 900) };
      }
    }
    expect(ops).toBe(60 * 400);
    expect(overlapping).toBeGreaterThan(1000); // this really is stacking
  });

  it('settling any junk at all gives a valid desk, with every app kept', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rnd = generator(seed * 104729);
      const count = Math.floor(rnd() * 14);
      const s = settleDesk({
        id: 'd', x: 0, y: 36, w: rnd() * 1000, h: rnd() * 800,
        items: Array.from({ length: count }, (_, n) => app(`i${n}`, -200 + rnd() * 1400, -200 + rnd() * 1200, rnd() * 500, rnd() * 500)),
      });
      expect(s.items).toHaveLength(count);
      assertValid(s, `settle seed ${seed}`);
    }
  });

  // A desk saved before stacking has no overlaps and no `stack`, and its list may be in any order. So: the same
  // session on the desk as saved and on a copy sorted into reading order. Which app is on top must agree for every
  // pair that overlaps.
  it('the order a saved desk starts in never shows, so it needs no marker and no sort', () => {
    const above = (d: LayoutDesk, a: string, b: string): boolean => stackOrder(d).indexOf(a) > stackOrder(d).indexOf(b);
    const raise = (d: LayoutDesk, id: string, to: 'front' | 'back'): LayoutDesk => withStack(d, restacked(stackOrder(d), id, to));
    let compared = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const rnd = generator(seed * 15485863);
      const saved = Array.from({ length: 4 + Math.floor(rnd() * 8) }, (_, n) => app(`i${n}`, 24 + (n % 4) * 92, 24 + Math.floor(n / 4) * 92));
      const shuffled = [...saved].sort(() => rnd() - 0.5);
      const desk = (items: LayoutDesk['items']): LayoutDesk => ({ id: 'd', x: 0, y: 0, w: 800, h: 600, items });
      let one = desk(shuffled);
      let two = desk(saved); // already in reading order
      const area = workArea(800, 600);
      for (let n = 0; n < 40; n += 1) {
        const id = saved[Math.floor(rnd() * saved.length)]!.id;
        const roll = rnd();
        if (roll < 0.15) {
          const to = rnd() < 0.5 ? 'front' : 'back';
          one = raise(one, id, to);
          two = raise(two, id, to);
        } else {
          // Press, then move or resize: only this changes where anything is.
          const asked = { x: rnd() * 700, y: rnd() * 500 };
          const size = { w: 56 + rnd() * 200, h: 56 + rnd() * 200 };
          const change = (d: LayoutDesk): LayoutDesk => {
            const raised = raise(d, id, 'front');
            return { ...raised, items: raised.items.map((i) => {
              if (i.id !== id) return i;
              return roll < 0.6 ? { ...i, ...clampMove(i, asked, area) } : { ...i, ...clampResize(i, size.w, size.h, area) };
            }) };
          };
          one = change(one);
          two = change(two);
        }
        for (const a of one.items) {
          for (const b of one.items) {
            if (a.id >= b.id || !overlaps(a, b)) continue;
            compared += 1;
            expect(above(one, a.id, b.id), `seed ${seed} step ${n}: ${a.id} over ${b.id}`).toBe(above(two, a.id, b.id));
          }
        }
      }
      // And the list never moved for any of it.
      expect(one.items.map((i) => i.id)).toEqual(shuffled.map((i) => i.id));
      expect(two.items.map((i) => i.id)).toEqual(saved.map((i) => i.id));
    }
    expect(compared).toBeGreaterThan(1000);
  });
});

describe('overOthers: the apps over one below them (ADR 0064)', () => {
  const desk = (items: ReturnType<typeof app>[], stack?: string[]) => ({ items, ...(stack ? { stack } : {}) });

  it('nothing on an empty desk, an app alone, or apps apart', () => {
    expect([...overOthers(desk([]))]).toEqual([]);
    expect([...overOthers(desk([app('a', 8, 8)]))]).toEqual([]);
    expect([...overOthers(desk([app('a', 8, 8), app('b', 100, 8), app('c', 8, 100)]))]).toEqual([]);
  });

  it('touching isn\'t overlapping', () => {
    expect([...overOthers(desk([app('a', 8, 8), app('b', 84, 8), app('c', 8, 84)]))]).toEqual([]);
    // A hundredth of a unit is the smallest a layout can store, and that overlaps.
    expect([...overOthers(desk([app('a', 8, 8), app('b', 83.99, 8)]))]).toEqual(['b']);
  });

  it('only the upper of two counts, and the stack decides which that is', () => {
    const items = [app('a', 8, 8), app('b', 40, 40)];
    expect([...overOthers(desk(items))]).toEqual(['b']); // no stack: the list's order
    expect([...overOthers(desk(items, ['b', 'a']))]).toEqual(['a']);
    expect([...overOthers(desk(items, ['a', 'b']))]).toEqual(['b']);
  });

  it('a pile: everything but its bottom app, and an app apart doesn\'t count', () => {
    const items = [app('a', 8, 8), app('b', 40, 40), app('c', 70, 70), app('far', 400, 8)];
    expect([...overOthers(desk(items))].sort()).toEqual(['b', 'c']);
    expect([...overOthers(desk(items, ['c', 'far', 'b', 'a']))].sort()).toEqual(['a', 'b']);
  });

  it('counts an app over one that isn\'t next below it', () => {
    const items = [app('a', 8, 8), app('apart', 300, 8), app('b', 40, 40)];
    expect([...overOthers(desk(items))]).toEqual(['b']);
  });

  it('a fully covered app, and two at one spot, go by the stack as well', () => {
    expect([...overOthers(desk([app('big', 8, 8, 200, 200), app('small', 40, 40)]))]).toEqual(['small']);
    expect([...overOthers(desk([app('big', 8, 8, 200, 200), app('small', 40, 40)], ['small', 'big']))]).toEqual(['big']);
    expect([...overOthers(desk([app('a', 8, 8), app('b', 8, 8)]))]).toEqual(['b']);
  });

  it('reads the stack the way stackOrder does: unknown ids and repeats don\'t count, and ids it doesn\'t list go on top', () => {
    const items = [app('a', 8, 8), app('b', 40, 40), app('c', 70, 70)];
    expect([...overOthers(desk(items, ['gone', 'c', 'c', 'gone']))].sort()).toEqual(['a', 'b']); // c, then a, then b
  });

  it('never the bottom of the stack, and exactly the apps with an overlap under them, on random desks', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 16807) % 2147483647;
      return seed % n;
    };
    let seen = 0;
    for (let round = 0; round < 500; round += 1) {
      const items = Array.from({ length: 1 + rnd(12) }, (_, n) => app(`i${n}`, rnd(400), rnd(300), 56 + rnd(200), 56 + rnd(200)));
      const stack = items.map((i) => i.id).sort(() => rnd(3) - 1);
      const d = desk(items, stack);
      const over = overOthers(d);
      const order = stackOrder(d);
      expect(over.has(order[0]!)).toBe(false);
      order.forEach((id, n) => {
        const me = items.find((i) => i.id === id)!;
        const under = order.slice(0, n).map((u) => items.find((i) => i.id === u)!);
        expect(over.has(id)).toBe(under.some((u) => overlaps(me, u)));
      });
      seen += over.size;
    }
    expect(seen).toBeGreaterThan(500);
  });
});

describe('hiddenItems: the apps with nothing left to press (ADR 0064)', () => {
  const pile = (items: ReturnType<typeof app>[], stack?: string[]) => ({ items, ...(stack ? { stack } : {}) });
  const sorted = (ids: string[]): string[] => [...ids].sort();

  it('nothing is hidden on a desk where nothing overlaps, or where an overlap leaves enough', () => {
    expect(hiddenItems(pile([app('a', 8, 8), app('b', 100, 8)]))).toEqual([]);
    expect(hiddenItems(pile([app('a', 8, 8), app('b', 40, 40)]))).toEqual([]);
    expect(hiddenItems(pile([]))).toEqual([]);
  });

  it('an app wholly under another is hidden, and the one on top never is', () => {
    expect(hiddenItems(pile([app('small', 40, 40), app('big', 20, 20, 200, 200)]))).toEqual(['small']);
    expect(hiddenItems(pile([app('a', 40, 40), app('b', 40, 40)]))).toEqual(['a']); // exactly on top
  });

  it('goes by the stack, not the list, so a raise brings an app back', () => {
    const items = [app('big', 20, 20, 200, 200), app('small', 40, 40)];
    expect(hiddenItems(pile(items))).toEqual([]);
    expect(hiddenItems(pile(items, ['small', 'big']))).toEqual(['small']);
  });

  it('two apps that together cover a third hide it, though neither does alone', () => {
    const under = app('under', 100, 100, 100, 100);
    const left = app('left', 90, 90, 60, 120);
    const right = app('right', 150, 90, 60, 120);
    expect(hiddenItems(pile([under, left]))).toEqual([]);
    expect(hiddenItems(pile([under, right]))).toEqual([]);
    expect(hiddenItems(pile([under, left, right]))).toEqual(['under']);
    // And four around it, none reaching its middle, leave the middle showing.
    const ring = [app('t', 90, 90, 120, 44), app('b', 90, 166, 120, 44), app('l', 90, 90, 44, 120), app('r', 166, 90, 44, 120)];
    expect(hiddenItems(pile([under, ...ring]))).toEqual([]);
  });

  it('what shows has to hold 12 x 12: a sliver under that counts as hidden, and exactly that does not', () => {
    const under = app('under', 100, 100, 100, 100);
    const covering = (x: number, y: number, w: number, h: number) => pile([under, app('top', x, y, w, h)]);
    expect(hiddenItems(covering(100, 100, 88.01, 100))).toEqual(['under']); // 11.99 wide, all the way down
    expect(hiddenItems(covering(100, 100, 88, 100))).toEqual([]); // 12 wide
    expect(hiddenItems(covering(100, 100, 100, 88.01))).toEqual(['under']); // 11.99 tall
    expect(hiddenItems(covering(100, 100, 100, 88))).toEqual([]);
    expect(hiddenItems(covering(111.99, 100, 88.01, 100))).toEqual(['under']); // on the left too
    expect(hiddenItems(covering(112, 100, 88, 100))).toEqual([]);
    expect(HIDDEN_MIN).toBe(12);
  });

  it('long thin pieces don\'t add up: an L of 11-wide arms, or slivers either side, leave nothing to press', () => {
    const under = app('under', 100, 100, 100, 100);
    expect(hiddenItems(pile([under, app('top', 111, 111, 89, 89)]))).toEqual(['under']); // an L of two 11s
    expect(hiddenItems(pile([under, app('top', 112, 111, 88, 89)]))).toEqual([]); // its upright is 12 wide, and 100 tall
    expect(hiddenItems(pile([under, app('top', 110, 95, 80, 110), app('more', 95, 95, 5, 110)]))).toEqual(['under']); // 10 either side
  });

  it('finds a gap that\'s only at the right of one app and under another', () => {
    const under = app('under', 100, 100, 100, 100);
    const a = app('a', 90, 90, 60, 100); // to x 150, y 190
    const b = app('b', 150, 90, 60, 40); // from x 150, to y 130
    const c = app('c', 90, 190, 120, 20); // from y 190
    const d = app('d', 170, 120, 40, 80); // from x 170
    expect(hiddenItems(pile([under, a, b, c, d]))).toEqual([]); // 20 x 60 at (150, 130)
    expect(hiddenItems(pile([under, a, b, c, app('d', 161, 120, 49, 80)]))).toEqual(['under']); // 11 wide
  });

  it('a hidden app still covers what\'s under it', () => {
    const items = [app('bottom', 100, 100), app('middle', 90, 90, 100, 100), app('top', 80, 80, 120, 120)];
    expect(sorted(hiddenItems(pile(items)))).toEqual(['bottom', 'middle']);
    expect(hiddenItems(pile([app('bottom', 100, 100, 100, 100), app('middle', 130, 100, 100, 100), app('top', 120, 90, 120, 120)]))).toEqual(['middle']);
    // Middle is hidden, and what it covers of bottom counts towards bottom.
    expect(sorted(hiddenItems(pile([app('bottom', 100, 100, 100, 100), app('middle', 100, 100, 50, 100), app('top', 90, 90, 70, 120), app('side', 150, 90, 60, 120)])))).toEqual(['bottom', 'middle']);
  });

  it('float noise in two-decimal values doesn\'t decide it', () => {
    // 20.1 - 8.1 is a shade over 12, and 8.1 + 56.07 a shade under what it reads as.
    expect(hiddenItems(pile([app('under', 8.1, 8.1, 56.07, 56.07), app('top', 20.1, 8.1, 44.07, 56.07)]))).toEqual([]);
    expect(hiddenItems(pile([app('under', 0.1, 0.2, 56.3, 56.7), app('top', 0.1, 0.2, 44.3, 56.7)]))).toEqual([]);
    expect(hiddenItems(pile([app('under', 0.1, 0.2, 56.3, 56.7), app('top', 0.1, 0.2, 44.31, 56.7)]))).toEqual(['under']);
  });

  // A brute-force check: mark what's covered on a grid of `unit`, and look for a free block of 12 x 12.
  function bruteShows(r: { x: number; y: number; w: number; h: number }, above: readonly { x: number; y: number; w: number; h: number }[], unit: number): boolean {
    const cols = Math.round(r.w / unit);
    const rows = Math.round(r.h / unit);
    const need = Math.round(HIDDEN_MIN / unit);
    if (cols < need || rows < need) return false;
    const sum = new Int32Array((cols + 1) * (rows + 1));
    const at = (c: number, row: number): number => row * (cols + 1) + c;
    for (let row = 0; row < rows; row += 1) {
      const cy = r.y + (row + 0.5) * unit;
      for (let c = 0; c < cols; c += 1) {
        const cx = r.x + (c + 0.5) * unit;
        const covered = above.some((a) => cx > a.x && cx < a.x + a.w && cy > a.y && cy < a.y + a.h) ? 1 : 0;
        sum[at(c + 1, row + 1)] = covered + sum[at(c, row + 1)]! + sum[at(c + 1, row)]! - sum[at(c, row)]!;
      }
    }
    for (let row = 0; row + need <= rows; row += 1) {
      for (let c = 0; c + need <= cols; c += 1) {
        if (sum[at(c + need, row + need)]! - sum[at(c, row + need)]! - sum[at(c + need, row)]! + sum[at(c, row)]! === 0) return true;
      }
    }
    return false;
  }

  for (const unit of [1, 0.5]) {
    it(`agrees with a brute-force grid on random piles, at steps of ${unit}`, () => {
      let seed = unit === 1 ? 20261105 : 64;
      const rand = (n: number): number => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return Math.floor((seed / 4294967296) * n);
      };
      let hidden = 0;
      let shown = 0;
      const span2 = Math.round(1 / unit);
      for (let trial = 0; trial < 200; trial += 1) {
        const n = 2 + rand(8);
        const items = Array.from({ length: n }, (_, i) => app(`a${i}`, rand(80 * span2) * unit, rand(60 * span2) * unit, 30 + rand(90 * span2) * unit, 30 + rand(70 * span2) * unit));
        const stack = items.map((i) => i.id);
        for (let k = stack.length - 1; k > 0; k -= 1) {
          const j = rand(k + 1);
          [stack[k], stack[j]] = [stack[j]!, stack[k]!];
        }
        const got = hiddenItems({ items, stack });
        const byId = new Map(items.map((i) => [i.id, i]));
        const want: string[] = [];
        stack.forEach((id, pos) => {
          const above = stack.slice(pos + 1).map((a) => byId.get(a)!);
          if (!bruteShows(byId.get(id)!, above, unit)) want.push(id);
          else shown += 1;
        });
        hidden += want.length;
        expect(sorted(got), `${JSON.stringify(items)} ${stack.join()}`).toEqual(sorted(want));
        expect(got).not.toContain(stack[stack.length - 1]);
      }
      // The test means nothing unless it saw plenty of both.
      expect(hidden).toBeGreaterThan(100);
      expect(shown).toBeGreaterThan(100);
    }, 30_000);
  }
});
