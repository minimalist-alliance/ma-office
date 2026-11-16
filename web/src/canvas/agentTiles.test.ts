// Every agent is its own app (task 49 item 6): agents to desk items and back, and what the layout doc does with them.
import { describe, expect, it } from 'vitest';
import { adultOnly } from '../platform/age';
import { agentItemId, fitDeskToAgents, freeSpot, placeNewTile, withNewTile, type TileAgent } from './agentTiles';
import { agentIdOf, baseApp, defaultDesk, G, isAgentApp, stackOrder, workArea, isPlaced, overlaps, type LayoutDesk } from './layout';
import { fitDeskToBand, isUntouched, readLayoutDoc, readServerLayout, writeServerLayout } from './layoutDoc';

const LEAD: TileAgent = { id: 'manager', lead: true };
const staff = (n: number): TileAgent[] => Array.from({ length: n }, (_, i) => ({ id: `ag-${String(i).padStart(12, 'a')}`, lead: false }));

describe('agent apps', () => {
  it('are `agent:<id>`, Agent apps by kind, and adults-only', () => {
    expect(isAgentApp('agent:ag-3k9x0d2m4q1z')).toBe(true);
    expect(isAgentApp('agent:researcher')).toBe(true);
    expect(isAgentApp('agent')).toBe(false);
    expect(isAgentApp('agent:')).toBe(false);
    expect(isAgentApp('agent:../x')).toBe(false);
    expect(isAgentApp('agent:AG-1')).toBe(false);
    expect(agentIdOf('agent:ag-1')).toBe('ag-1');
    expect(baseApp('agent:ag-1')).toBe('agent');
    expect(baseApp('notebook')).toBe('notebook');
    expect(adultOnly('agent:ag-1')).toBe(true);
    expect(adultOnly('notebook')).toBe(false);
  });
});

describe('placing a new agent tile', () => {
  it('goes to the next free cell of a new desk\'s row, then the next row', () => {
    const d = defaultDesk('d1', 0, 0);
    expect(placeNewTile(d)).toEqual({ x: G.padX + 4 * G.pitch, y: G.padTop, w: G.cell, h: G.cell });
    // A new desk's row is nine cells (ADR 0057): four apps and five agents fill it.
    const full = fitDeskToAgents(d, [LEAD, ...staff(5)]);
    expect(placeNewTile(full)).toEqual({ x: G.padX, y: G.padTop + G.pitch, w: G.cell, h: G.cell });
  });

  it('keeps a gap from an app that sits off the grid', () => {
    const d: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 584, h: 236, items: [{ id: 'w', app: 'courier', x: 30, y: 30, w: 168, h: 168 }] };
    const at = placeNewTile(d);
    expect(overlaps({ x: at.x - G.gap + 1, y: at.y - G.gap + 1, w: at.w + 2 * G.gap - 2, h: at.h + 2 * G.gap - 2 }, d.items[0]!)).toBe(false);
  });
});

// A full desk with a Notebook made open across six columns, as staging's fleet-officer desk had it (MP `docs/sub-status/
// e2e-red.md`): 664 wide, the Notebook at 8, 24 at 540 x 444, and the right-hand column full of icons.
const OPEN_NOTEBOOK = { id: 'd1:notebook', app: 'notebook' as const, x: 8, y: 24, w: 540, h: 444 };
const column = (x: number, ys: number[]) => ys.map((y, n) => ({ id: `d1:i${n}`, app: `agent:ag-${String(n).padStart(12, 'b')}` as const, x, y, w: 76, h: 76 }));
/** The office's desk-mode fit on a 1280 x 720 screen: no side insets, 136 px of bars, a 48-unit margin. */
const LAPTOP = (w: number, h: number): number => Math.min(1280 / (w + 96), 584 / (h + 96));
const liveWide = (s: number): boolean => OPEN_NOTEBOOK.w * s >= 480 && OPEN_NOTEBOOK.h * s >= 320;

describe('a tile the office places itself', () => {
  it('takes a free spot beside an open app before the desk grows', () => {
    const d: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 664, h: 512, items: [OPEN_NOTEBOOK, ...column(564, [24, 116, 208])] };
    expect(freeSpot(d)).toEqual({ x: 564, y: 300, w: 76, h: 76 });
    const next = withNewTile(d, 'd1:todo', 'todo', LAPTOP);
    expect(next.items.at(-1)).toMatchObject({ app: 'todo', x: 564, y: 300, w: 76, h: 76 });
    expect({ w: next.w, h: next.h }).toEqual({ w: 664, h: 512 });
    expect(stackOrder(next).at(-1)).toBe('d1:todo');
    for (const i of next.items) for (const j of next.items) if (i !== j) expect(overlaps(i, j)).toBe(false);
    expect(liveWide(LAPTOP(next.w, next.h))).toBe(true);
    // Placed the same with no screen to ask: there was room.
    expect(withNewTile(d, 'd1:todo', 'todo').items.at(-1)).toMatchObject({ x: 564, y: 300 });
  });

  it('on a full desk with a live open tile, grows the way that keeps it live: a column on the right, not a row below', () => {
    const d: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 664, h: 512, items: [OPEN_NOTEBOOK, ...column(564, [24, 116, 208, 300, 392])] };
    expect(freeSpot(d)).toBeNull();
    expect(liveWide(LAPTOP(d.w, d.h))).toBe(true);
    // Downward, as before, with no screen to ask: there, at 1280 x 720, the Notebook would be 450 px wide, under live size.
    const down = withNewTile(d, 'd1:todo', 'todo');
    expect(down.items.at(-1)).toMatchObject({ x: 24, y: 484 });
    expect({ w: down.w, h: down.h }).toEqual({ w: 664, h: 604 });
    expect(liveWide(LAPTOP(down.w, down.h))).toBe(false);
    const side = withNewTile(d, 'd1:todo', 'todo', LAPTOP);
    expect(side.items.at(-1)).toMatchObject({ x: 656, y: 24, w: 76, h: 76 });
    expect({ w: side.w, h: side.h }).toEqual({ w: 756, h: 512 });
    expect(liveWide(LAPTOP(side.w, side.h))).toBe(true);
    for (const i of side.items) for (const j of side.items) if (i !== j) expect(overlaps(i, j)).toBe(false);
  });

  it('when both ways would take a live tile under live size, takes a smaller free spot instead', () => {
    // 640 wide: right of the Notebook is 68 units, too narrow for an icon but not for the smallest app.
    const d: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 640, h: 512, items: [OPEN_NOTEBOOK] };
    const tight = (w: number, h: number): number => Math.min((0.9 * 736) / (w + 96), (0.9 * 608) / (h + 96));
    expect(freeSpot(d)).toBeNull();
    expect(liveWide(tight(d.w, d.h))).toBe(true);
    const next = withNewTile(d, 'd1:todo', 'todo', tight);
    expect(next.items.at(-1)).toMatchObject({ x: 564, y: 24, w: G.minApp, h: G.minApp });
    expect({ w: next.w, h: next.h }).toEqual({ w: 640, h: 512 });
    expect(isPlaced(next.items.at(-1)!, workArea(next.w, next.h))).toBe(true);
  });

  it('with no open tile, a full desk grows downward as it always has, whatever the screen', () => {
    const d: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 664, h: 236, items: column(24, [24, 116]).concat(column(116, [24, 116]).map((i) => ({ ...i, id: `${i.id}b` }))) };
    const wideD = { ...d, w: 232 };
    const next = withNewTile(wideD, 'd1:todo', 'todo', LAPTOP);
    expect(next.w).toBe(232);
    expect(next.h).toBeGreaterThan(236);
  });
});

describe('fitDeskToAgents', () => {
  const desk = defaultDesk('d1', 0, 0);

  it('changes nothing until the desk has said who\'s there, or when only the lead is', () => {
    expect(fitDeskToAgents(desk, null)).toBe(desk);
    expect(fitDeskToAgents(desk, [LEAD])).toBe(desk);
  });

  it('adds a tile for each agent but the lead, after the rest, on top, and is idempotent', () => {
    const [a, b] = staff(2);
    const next = fitDeskToAgents(desk, [LEAD, a!, b!]);
    expect(next.items.map((i) => i.app)).toEqual(['courier', 'notebook', 'browser', 'agent', `agent:${a!.id}`, `agent:${b!.id}`]);
    expect(next.items[4]).toMatchObject({ id: agentItemId('d1', a!.id), x: G.padX + 4 * G.pitch, y: G.padTop, w: G.cell, h: G.cell });
    expect(next.items[5]).toMatchObject({ x: G.padX + 5 * G.pitch, y: G.padTop });
    expect(stackOrder(next).slice(-2)).toEqual([agentItemId('d1', a!.id), agentItemId('d1', b!.id)]);
    expect(fitDeskToAgents(next, [LEAD, a!, b!])).toBe(next);
    for (const i of next.items) expect(isPlaced(i, workArea(next.w, next.h))).toBe(true);
  });

  it('grows the desk downward when the rows are full, and nothing overlaps', () => {
    // Four rows of nine fit a new desk (ADR 0057): the 37th tile grows it.
    const next = fitDeskToAgents(desk, [LEAD, ...staff(33)]);
    expect(next.items).toHaveLength(37);
    expect(next.h).toBeGreaterThan(desk.h);
    expect(next.w).toBe(desk.w);
    for (const i of next.items) for (const j of next.items) if (i !== j) expect(overlaps(i, j)).toBe(false);
  });

  it('takes a gone agent\'s tile off, with its place in the stack, and never keeps one for the lead', () => {
    const [a, b] = staff(2);
    const two = fitDeskToAgents(desk, [LEAD, a!, b!]);
    const one = fitDeskToAgents(two, [LEAD, b!]);
    expect(one.items.map((i) => i.app)).toEqual(['courier', 'notebook', 'browser', 'agent', `agent:${b!.id}`]);
    expect(stackOrder(one)).not.toContain(agentItemId('d1', a!.id));
    const withLeadTile: LayoutDesk = { ...desk, items: [...desk.items, { id: 'd1:agent:manager', app: 'agent:manager', x: 400, y: 24, w: 76, h: 76 }] };
    expect(fitDeskToAgents(withLeadTile, [LEAD]).items.map((i) => i.app)).toEqual(['courier', 'notebook', 'browser', 'agent']);
  });

  it('keeps a tile the member moved where they put it', () => {
    const [a] = staff(1);
    const placed = fitDeskToAgents(desk, [LEAD, a!]);
    const moved: LayoutDesk = { ...placed, items: placed.items.map((i) => (i.app === `agent:${a!.id}` ? { ...i, x: 200, y: 120 } : i)) };
    expect(fitDeskToAgents(moved, [LEAD, a!])).toBe(moved);
  });
});

describe('the layout doc and agent tiles', () => {
  const [a] = staff(1);
  const desk = fitDeskToAgents(defaultDesk('d1', 0, 0), [LEAD, a!]);

  it('reads and writes them, and leaves out an app it doesn\'t know', () => {
    const body = JSON.parse(writeServerLayout({ desks: { d1: desk }, z: ['d1'] })) as { layout: unknown };
    const read = readServerLayout(body.layout);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.doc.desks['d1']!.items.map((i) => i.app)).toEqual(desk.items.map((i) => i.app));
    const stored = { desks: { d1: { ...desk, items: [...desk.items, { id: 'x', app: 'agent:../../etc', x: 24, y: 24, w: 76, h: 76 }, { id: 'y', app: 'agentx', x: 24, y: 24, w: 76, h: 76 }] } }, z: ['d1'] };
    expect(readLayoutDoc(stored)!.desks['d1']!.items.map((i) => i.app)).toEqual(desk.items.map((i) => i.app));
  });

  it('a teen\'s desk holds none, as it holds no Agent', () => {
    expect(fitDeskToBand(desk, 'teen').items.map((i) => i.app)).toEqual(['courier', 'notebook', 'browser']);
  });

  it('an agent tile alone doesn\'t make a desk arranged, so a first visit still uploads nothing', () => {
    expect(isUntouched({ desks: { d1: desk }, z: ['d1'] }, ['d1'])).toBe(true);
    const moved = { ...desk, items: desk.items.map((i) => (i.app === 'courier' ? { ...i, x: 300, y: 120 } : i)) };
    expect(isUntouched({ desks: { d1: moved }, z: ['d1'] }, ['d1'])).toBe(false);
  });
});
