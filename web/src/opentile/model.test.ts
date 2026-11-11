// Open tiles (ADR 0053): the level above `large`, its per-app minimums, the kill switch, the phone grid, and which tiles are
// live (the shown desk's, at rest, big enough on screen, four at most, one place per app).
import { afterEach, describe, expect, it } from 'vitest';
import { CELLS, deskGeometry, detailLevel, fittedLevel, G, levelSize, openMin, packItems, setOpenLevel, span, type AppId, type LayoutDesk, type LayoutItem } from '../canvas/layout';
import { resizeFrom } from './resize';
import { bigEnough, liveTiles, MAX_LIVE, OPEN_LIVE_MIN_H, OPEN_LIVE_MIN_W, tileOnScreen } from './model';

afterEach(() => setOpenLevel(true));

const item = (id: string, app: AppId, x: number, y: number, w: number, h: number): LayoutItem => ({ id, app, x, y, w, h });
const desk = (items: LayoutItem[], stack?: string[]): LayoutDesk => ({ id: 'd', x: 0, y: 0, w: 4000, h: 2000, items, ...(stack ? { stack } : {}) });
const OPEN = { w: span(6), h: span(5) };
const cam1 = { x: 0, y: 0, s: 1 };
const vp = { w: 4000, h: 2000 };
const none = new Set<AppId>();

describe('the open level', () => {
  it('starts at 6 x 5 cells, above large', () => {
    expect(CELLS.open).toEqual({ w: 6, h: 5 });
    expect(detailLevel(span(6), span(5), 'notebook')).toBe('open');
    expect(detailLevel(span(6) - 0.01, span(5), 'notebook')).toBe('large');
    expect(detailLevel(span(6), span(5) - 0.01, 'notebook')).toBe('large');
    expect(levelSize('open')).toEqual(OPEN);
  });

  it('takes an app\'s own minimum: the Browser at 7 x 5, the rest the default', () => {
    expect(openMin('browser')).toEqual({ w: 7, h: 5 });
    for (const app of ['notebook', 'chat', 'files', 'agent', 'commons', 'agent:ag-0123456789ab'] as const) expect(openMin(app)).toEqual({ w: 6, h: 5 });
    expect(detailLevel(span(6), span(5), 'browser')).toBe('large');
    expect(detailLevel(span(7), span(5), 'browser')).toBe('open');
    // An agent's own app is an Agent, with its size.
    expect(detailLevel(span(6), span(5), 'agent:ag-0123456789ab')).toBe('open');
  });

  it('with the kill switch off, nothing goes past large', () => {
    setOpenLevel(false);
    expect(detailLevel(2000, 2000, 'notebook')).toBe('large');
    expect(deskGeometry(desk([item('a', 'notebook', 24, 24, 900, 900)])).slots['a']!.level).toBe('large');
    setOpenLevel(true);
    expect(deskGeometry(desk([item('a', 'notebook', 24, 24, 900, 900)])).slots['a']!.level).toBe('open');
  });

  it('on the phone grid an open tile is large, and fits down from there', () => {
    expect(fittedLevel('open', G.phoneCols)).toBe('large');
    expect(fittedLevel('open', 2)).toBe('small');
    const d = desk([item('a', 'notebook', 24, 24, 900, 900), item('b', 'chat', 24, 24, 76, 76)]);
    const phone = deskGeometry(d, true);
    expect(phone.slots['a']).toMatchObject({ level: 'large', w: span(4), h: span(4) });
    expect(packItems([{ id: 'x', level: 'open' }], 4).slots['x']).toMatchObject({ level: 'large' });
    // A larger screen keeps the member's own size and the level it makes.
    expect(deskGeometry(d, false).slots['a']).toMatchObject({ level: 'open', w: 900, h: 900 });
  });
});

describe('which open tiles are live', () => {
  it('is big enough at 480 x 320 on screen', () => {
    expect([OPEN_LIVE_MIN_W, OPEN_LIVE_MIN_H]).toEqual([480, 320]);
    expect(bigEnough(480, 320)).toBe(true);
    expect(bigEnough(479.9, 320)).toBe(false);
    expect(bigEnough(480, 319.9)).toBe(false);
  });

  it('places a tile on screen from its desk and the camera', () => {
    expect(tileOnScreen({ x: 100, y: 50 }, { x: 24, y: 24, w: 536, h: 444 }, { x: 10, y: 20, s: 0.5 })).toEqual({ left: 72, top: 57, width: 268, height: 222 });
  });

  it('only at open, and only while it is at least 480 x 320 on screen', () => {
    const d = desk([item('n', 'notebook', 24, 24, OPEN.w, OPEN.h), item('c', 'chat', 700, 24, 352, 352)]);
    expect(liveTiles(d, cam1, vp, none)).toEqual(['n']);
    // Zoomed out, 536 x 444 units is 482 x 400 px at 0.9, and 429 x 355 at 0.8: the widget then.
    expect(liveTiles(d, { x: 0, y: 0, s: 0.9 }, vp, none)).toEqual(['n']);
    expect(liveTiles(d, { x: 0, y: 0, s: 0.8 }, vp, none)).toEqual([]);
    // Off the screen altogether, nothing.
    expect(liveTiles(d, { x: -3000, y: 0, s: 1 }, vp, none)).toEqual([]);
    // Partly on screen counts.
    expect(liveTiles(d, { x: -300, y: 0, s: 1 }, vp, none)).toEqual(['n']);
  });

  it('never while its window is open: one place per app', () => {
    const d = desk([item('n', 'notebook', 24, 24, OPEN.w, OPEN.h), item('f', 'files', 700, 24, OPEN.w, OPEN.h)]);
    expect(liveTiles(d, cam1, vp, new Set<AppId>(['notebook']))).toEqual(['f']);
  });

  it('one place per app: of two tiles of one app, the larger', () => {
    const d = desk([item('a', 'notebook', 24, 24, OPEN.w, OPEN.h), item('b', 'notebook', 700, 24, OPEN.w + 100, OPEN.h)]);
    expect(liveTiles(d, cam1, vp, none)).toEqual(['b']);
  });

  it('at most four, the largest on screen first', () => {
    const apps: AppId[] = ['notebook', 'chat', 'files', 'agent', 'commons'];
    const items = apps.map((a, n) => item(a, a, 24 + n * 700, 24, OPEN.w + n * 10, OPEN.h));
    const live = liveTiles(desk(items), cam1, vp, none);
    expect(MAX_LIVE).toBe(4);
    expect(live).toHaveLength(4);
    expect(live).not.toContain('notebook'); // the smallest
    // What's on screen decides "largest": the biggest one, mostly off screen, gives way.
    const off = liveTiles(desk(items), cam1, { w: 24 + 4 * 700 + 60, h: 2000 }, none);
    expect(off.sort()).toEqual(['agent', 'chat', 'files', 'notebook']);
  });

  it('not with anything above it over it: the canvas stacks that, so it stays a drawing', () => {
    const n = item('n', 'notebook', 24, 24, OPEN.w, OPEN.h);
    const c = item('c', 'chat', 100, 100, 76, 76);
    expect(liveTiles(desk([n, c], ['n', 'c']), cam1, vp, none)).toEqual([]);
    // Brought to the front, it's live, and the icon is under it.
    expect(liveTiles(desk([n, c], ['c', 'n']), cam1, vp, none)).toEqual(['n']);
    // Something above it but beside it is no matter.
    expect(liveTiles(desk([n, { ...c, x: 700 }], ['n', 'c']), cam1, vp, none)).toEqual(['n']);
  });

  it('not with the switch off', () => {
    setOpenLevel(false);
    expect(liveTiles(desk([item('n', 'notebook', 24, 24, 900, 900)]), cam1, vp, none)).toEqual([]);
  });

  it('the Browser needs its own 7 x 5', () => {
    expect(liveTiles(desk([item('b', 'browser', 24, 24, OPEN.w, OPEN.h)]), cam1, vp, none)).toEqual([]);
    expect(liveTiles(desk([item('b', 'browser', 24, 24, span(7), span(5))]), cam1, vp, none)).toEqual(['b']);
  });
});

describe('the grip', () => {
  const area = { x: 8, y: 8, w: 1000, h: 600 };
  const r = { x: 100, y: 100, w: 600, h: 400 };
  it('moves only the edge it holds, from the minimum size to the work area\'s edges', () => {
    expect(resizeFrom(r, 'e', 50, 999, area)).toEqual({ x: 100, y: 100, w: 650, h: 400 });
    expect(resizeFrom(r, 'se', 999, 999, area)).toEqual({ x: 100, y: 100, w: 908, h: 508 });
    expect(resizeFrom(r, 'w', -50, 0, area)).toEqual({ x: 50, y: 100, w: 650, h: 400 });
    expect(resizeFrom(r, 'nw', -999, -999, area)).toEqual({ x: 8, y: 8, w: 692, h: 492 });
    expect(resizeFrom(r, 'n', 0, 999, area)).toEqual({ x: 100, y: 500 - G.minApp, w: 600, h: G.minApp });
    expect(resizeFrom(r, 's', 0, -999, area)).toEqual({ x: 100, y: 100, w: 600, h: G.minApp });
  });
});
