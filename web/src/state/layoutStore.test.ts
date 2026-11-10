import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deskGeometry, settleDesk, stackOrder, type LayoutDesk } from '../canvas/layout';
import { LAYOUT_KEY, readLayoutDoc } from '../canvas/layoutDoc';
import { isPhone } from '../canvas/phone';
import { cleanUpDesk, needsCleanup, restack, undoCleanup, useCleanup } from '../shell/cleanup';
import { fitLayoutToBand, isQuietChange, moveDesk, placeItem, putDesk, reconcileLayout, reorderItems, resizeDesk, setDeskStyle, setItemLevel, stackItem, useLayoutStore } from './layoutStore';
import { setCurrentBand } from '../platform/age';

// The list is a phone's grid and the stack is how apps sit on a larger screen (ADR 0064). These go through the
// store, the code every input calls, and `isPhone`, against a stand-in for the browser's window. Cleanup only asks
// the camera whether it's moving, and the real one needs a real window as it loads.
vi.mock('../canvas/controller', () => ({ camera: { isMoving: () => false, onSettle: () => () => undefined } }));

const LIST = ['a', 'b', 'c', 'd'];
const app = (id: string, x: number, y = 24) => ({ id, app: 'chat' as const, x, y, w: 76, h: 76 });
const DESK: LayoutDesk = { id: 'd1', x: 0, y: 36, w: 800, h: 500, items: [app('a', 400), app('b', 60), app('c', 90), app('d', 300, 200)] };

const stored = new Map<string, string>();

/** A window this wide. `isPhone` asks it the same query it asks a real one. */
function windowOf(width: number): void {
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    matchMedia: (query: string) => {
      const max = /max-width: (\d+)px/.exec(query);
      return { matches: !!max && width <= Number(max[1]) };
    },
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) },
  });
}
const PHONE = 390;
const WIDE = 1440;

const desk = (): LayoutDesk => useLayoutStore.getState().desks['d1']!;
const list = (d: LayoutDesk = desk()): string[] => d.items.map((i) => i.id);
/** The mirror's debounce has run: this is what a reload would read. */
const mirror = (): string => {
  vi.advanceTimersByTime(1000);
  return stored.get(LAYOUT_KEY)!;
};

beforeEach(() => {
  vi.useFakeTimers();
  stored.clear();
  windowOf(WIDE);
  useLayoutStore.setState({ desks: { d1: DESK }, z: ['d1'] });
  useCleanup.setState({}, true);
  vi.advanceTimersByTime(1000); // that set-up's own write
  stored.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a raise on a larger screen', () => {
  it('changes the stack, and not the list', () => {
    restack('d1', 'a', 'front');
    expect(stackOrder(desk())).toEqual(['b', 'c', 'd', 'a']);
    expect(list()).toEqual(LIST);
    expect(desk().items).toBe(DESK.items); // the same array, so no app hears of it
  });

  it('so does sending to the back', () => {
    restack('d1', 'c', 'back');
    expect(stackOrder(desk())).toEqual(['c', 'a', 'b', 'd']);
    expect(list()).toEqual(LIST);
  });

  it('on the app already there stores nothing at all', () => {
    expect(stackItem('d1', 'd', 'front')).toBe(DESK);
    expect(stackItem('d1', 'a', 'back')).toBe(DESK);
    expect(desk()).toBe(DESK);
  });

  it('that brings the stack back to the list\'s order drops the field, and the doc is what it was', () => {
    const start = JSON.stringify({ desks: { d1: DESK }, z: ['d1'] });
    restack('d1', 'c', 'front');
    expect(desk().stack).toEqual(['a', 'b', 'd', 'c']);
    restack('d1', 'd', 'front');
    expect('stack' in desk()).toBe(false);
    expect(mirror()).toBe(start);
  });

  it('survives a reload, on the list it came from', () => {
    restack('d1', 'a', 'front');
    const read = readLayoutDoc(JSON.parse(mirror()))!.desks['d1']!;
    expect(read.stack).toEqual(['b', 'c', 'd', 'a']);
    expect(list(read)).toEqual(LIST);
  });
});

describe('a phone\'s grid', () => {
  it('doesn\'t change when a larger screen raises', () => {
    windowOf(PHONE);
    expect(isPhone()).toBe(true);
    const grid = deskGeometry(desk(), isPhone());

    windowOf(WIDE);
    expect(isPhone()).toBe(false);
    restack('d1', 'a', 'front');
    restack('d1', 'c', 'back');
    restack('d1', 'b', 'front');
    expect(stackOrder(desk())).toEqual(['c', 'd', 'a', 'b']);

    windowOf(PHONE);
    expect(deskGeometry(desk(), isPhone())).toEqual(grid);
    expect(list()).toEqual(LIST);
  });

  it('nothing raises on a phone', () => {
    windowOf(PHONE);
    restack('d1', 'a', 'front');
    restack('d1', 'd', 'back');
    expect(desk()).toBe(DESK);
  });

  it('its reorder changes the list, and the stack doesn\'t follow, stacked or not', () => {
    windowOf(PHONE);
    reorderItems('d1', ['d', 'a', 'b', 'c']);
    expect(list()).toEqual(['d', 'a', 'b', 'c']);
    expect(stackOrder(desk())).toEqual(LIST);

    windowOf(WIDE);
    restack('d1', 'a', 'front');
    expect(stackOrder(desk())).toEqual(['b', 'c', 'd', 'a']);
    windowOf(PHONE);
    reorderItems('d1', LIST);
    expect(list()).toEqual(LIST);
    expect(stackOrder(desk())).toEqual(['b', 'c', 'd', 'a']);
  });

  it('a reorder back to the stack\'s order leaves no field', () => {
    windowOf(PHONE);
    reorderItems('d1', ['d', 'a', 'b', 'c']);
    expect(desk().stack).toEqual(LIST);
    reorderItems('d1', LIST);
    expect('stack' in desk()).toBe(false);
  });
});

describe('what else changes a desk keeps its stack and its list', () => {
  beforeEach(() => restack('d1', 'a', 'front'));

  it('a drop', () => {
    expect(placeItem('d1', 'b', { x: 200, y: 200, w: 100, h: 100 })).toBe(true);
    expect(stackOrder(desk())).toEqual(['b', 'c', 'd', 'a']);
    expect(list()).toEqual(LIST);
  });

  it('a phone\'s size chip', () => {
    setItemLevel('d1', 'b', 'small');
    expect(stackOrder(desk())).toEqual(['b', 'c', 'd', 'a']);
    expect(list()).toEqual(LIST);
  });

  it('settling', () => {
    expect(settleDesk(desk()).stack).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('cleanup', () => {
  // Reading order is b, c, a, d. The stack starts as the list's order.
  const READING = ['b', 'c', 'a', 'd'];

  it('resets the stack to reading order, and leaves the list', () => {
    expect(needsCleanup(desk())).toBe(true);
    restack('d1', 'b', 'back');
    cleanUpDesk('d1');
    expect(stackOrder(desk())).toEqual(READING);
    expect(desk().stack).toEqual(READING);
    expect(list()).toEqual(LIST);
    expect(needsCleanup(desk())).toBe(false);
  });

  it('undo restores the stack, the list and every place, exactly', () => {
    restack('d1', 'c', 'back');
    const before = desk();
    cleanUpDesk('d1');
    expect(desk()).not.toBe(before);
    undoCleanup('d1');
    expect(desk()).toBe(before);
    expect(desk().stack).toEqual(['c', 'a', 'b', 'd']);
    expect(list()).toEqual(LIST);
  });

  it('undo restores having no stack at all', () => {
    cleanUpDesk('d1');
    expect(desk().stack).toEqual(READING);
    undoCleanup('d1');
    expect('stack' in desk()).toBe(false);
  });

  it('a raise after it leaves the undo good, and undo still brings back the stack from before', () => {
    restack('d1', 'c', 'back');
    cleanUpDesk('d1');
    restack('d1', 'a', 'front');
    expect(stackOrder(desk())).toEqual(['b', 'c', 'd', 'a']);
    undoCleanup('d1');
    expect(desk().stack).toEqual(['c', 'a', 'b', 'd']);
  });

  it('a raise in a neighbour the cleanup pushed isn\'t a move, so undo still brings it back', () => {
    const pile = ['a', 'b', 'c', 'd'].map((id) => app(id, 24));
    const near: LayoutDesk = { id: 'd2', x: 0, y: 180, w: 400, h: 300, items: [app('p', 24), app('q', 60)] };
    useLayoutStore.setState({ desks: { d1: { ...DESK, y: 0, w: 200, h: 156, items: pile }, d2: near }, z: ['d1', 'd2'] });
    cleanUpDesk('d1');
    const pushedTo = useLayoutStore.getState().desks['d2']!;
    expect(pushedTo.y).toBeGreaterThan(near.y);
    restack('d2', 'p', 'front');
    undoCleanup('d1');
    const back = useLayoutStore.getState().desks['d2']!;
    expect(back).toMatchObject({ x: near.x, y: near.y });
    expect(back.stack).toEqual(['q', 'p']);
  });

  it('a stack back in the list\'s order after a cleanup leaves no field', () => {
    useLayoutStore.setState({ desks: { d1: { ...DESK, items: [app('a', 60), app('b', 90), app('c', 400), app('d', 300, 200)] } } });
    restack('d1', 'a', 'front');
    cleanUpDesk('d1');
    expect('stack' in desk()).toBe(false);
    undoCleanup('d1');
    expect(desk().stack).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('a doc with no stack', () => {
  const TEXT = '{"desks":{"d1":{"id":"d1","x":0,"y":36,"w":800,"h":500,"items":[{"id":"a","app":"chat","x":400,"y":24,"w":76,"h":76},{"id":"b","app":"agent","x":60,"y":24,"w":76,"h":76}]}},"z":["d1"]}';

  it('comes through byte-identical from a read to a write, until something raises', () => {
    useLayoutStore.setState(readLayoutDoc(JSON.parse(TEXT))!);
    putDesk('d1', { ...desk() }); // stores a new desk that says the same thing
    expect(mirror()).toBe(TEXT);

    restack('d1', 'a', 'front');
    expect(mirror()).toBe(TEXT.replace('}]}},"z"', '}],"stack":["b","a"]}},"z"'));
  });
});

describe('an age band', () => {
  beforeEach(() => useLayoutStore.setState({ desks: {}, z: [] }));
  afterEach(() => setCurrentBand(null));
  const appsOf = (id: string): string[] => useLayoutStore.getState().desks[id]!.items.map((i) => i.app);

  it('with no band, a desk it has never seen has every app, as ever', () => {
    reconcileLayout(['d-a']);
    expect(appsOf('d-a')).toEqual(['chat', 'notebook', 'browser', 'agent']);
  });

  it("a teen's new desk has no Agent from the first", () => {
    setCurrentBand('teen');
    reconcileLayout(['d-a']);
    expect(appsOf('d-a')).toEqual(['chat', 'notebook', 'browser']);
  });

  it('takes hold on the desks already here, quietly, and the mirror has it at once', () => {
    reconcileLayout(['d-a', 'd-b']);
    const quiet: boolean[] = [];
    const off = useLayoutStore.subscribe(() => quiet.push(isQuietChange()));
    setCurrentBand('teen');
    fitLayoutToBand();
    off();
    expect(quiet).toEqual([true]);
    expect(appsOf('d-a')).toEqual(['chat', 'notebook', 'browser']);
    expect(appsOf('d-b')).toEqual(['chat', 'notebook', 'browser']);
    expect(JSON.stringify(readLayoutDoc(JSON.parse(stored.get(LAYOUT_KEY)!)))).not.toContain('agent');
  });

  it('asks for no write when nothing changes', () => {
    reconcileLayout(['d-a']);
    const before = useLayoutStore.getState();
    fitLayoutToBand();
    setCurrentBand('adult');
    fitLayoutToBand();
    expect(useLayoutStore.getState()).toBe(before);
  });

  it("a teen's new desk has nothing for cleanup to do", () => {
    setCurrentBand('teen');
    reconcileLayout(['d-a']);
    expect(needsCleanup(useLayoutStore.getState().desks['d-a']!)).toBe(false);
  });

  it('someone who has turned 18 finds the Agent back', () => {
    setCurrentBand('teen');
    reconcileLayout(['d-a']);
    setCurrentBand('adult');
    fitLayoutToBand();
    expect(appsOf('d-a')).toEqual(['chat', 'notebook', 'browser', 'agent']);
  });
});

// The owner's desk textures: the member picks a style from the desk's menu, and it's kept on the desk.
describe('a desk\'s style', () => {
  it('is stored when the member picks one, as their own change, and reaches the mirror', () => {
    expect(setDeskStyle('d1', 'walnut')).toBe(true);
    expect(desk().style).toBe('walnut');
    expect(isQuietChange()).toBe(false);
    expect(readLayoutDoc(JSON.parse(mirror()))!.desks['d1']!.style).toBe('walnut');
  });

  it('picking what the desk already wears stores nothing, the default on a desk that never chose included', () => {
    expect(setDeskStyle('d1', 'oak')).toBe(false);
    expect(desk()).toBe(DESK);
    setDeskStyle('d1', 'walnut');
    const walnut = desk();
    expect(setDeskStyle('d1', 'walnut')).toBe(false);
    expect(desk()).toBe(walnut);
    // Back to the default from another style is a choice like any other, and is stored as one.
    expect(setDeskStyle('d1', 'oak')).toBe(true);
    expect(desk().style).toBe('oak');
  });

  it('a desk that isn\'t there stores nothing', () => {
    expect(setDeskStyle('gone', 'walnut')).toBe(false);
    expect(useLayoutStore.getState().desks['gone']).toBeUndefined();
  });

  it('stays through everything else the member does to the desk', () => {
    setDeskStyle('d1', 'walnut');
    moveDesk('d1', 40, 80);
    resizeDesk('d1', 900, 600);
    restack('d1', 'a', 'front');
    placeItem('d1', 'b', { x: 500, y: 200, w: 76, h: 76 });
    reorderItems('d1', ['d', 'c', 'b', 'a']);
    cleanUpDesk('d1');
    vi.advanceTimersByTime(1000);
    expect(desk().style).toBe('walnut');
  });
});
