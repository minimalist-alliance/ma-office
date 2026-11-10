// Every agent is its own app (task 49 item 6): agents to desk items and back, and what the layout doc does with them.
import { describe, expect, it } from 'vitest';
import { adultOnly } from '../platform/age';
import { agentItemId, fitDeskToAgents, placeNewTile, type TileAgent } from './agentTiles';
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
    const full = fitDeskToAgents(d, [LEAD, ...staff(2)]);
    expect(placeNewTile(full)).toEqual({ x: G.padX, y: G.padTop + G.pitch, w: G.cell, h: G.cell });
  });

  it('keeps a gap from an app that sits off the grid', () => {
    const d: LayoutDesk = { id: 'd1', x: 0, y: 0, w: 584, h: 236, items: [{ id: 'w', app: 'chat', x: 30, y: 30, w: 168, h: 168 }] };
    const at = placeNewTile(d);
    expect(overlaps({ x: at.x - G.gap + 1, y: at.y - G.gap + 1, w: at.w + 2 * G.gap - 2, h: at.h + 2 * G.gap - 2 }, d.items[0]!)).toBe(false);
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
    expect(next.items.map((i) => i.app)).toEqual(['chat', 'notebook', 'browser', 'agent', `agent:${a!.id}`, `agent:${b!.id}`]);
    expect(next.items[4]).toMatchObject({ id: agentItemId('d1', a!.id), x: G.padX + 4 * G.pitch, y: G.padTop, w: G.cell, h: G.cell });
    expect(next.items[5]).toMatchObject({ x: G.padX + 5 * G.pitch, y: G.padTop });
    expect(stackOrder(next).slice(-2)).toEqual([agentItemId('d1', a!.id), agentItemId('d1', b!.id)]);
    expect(fitDeskToAgents(next, [LEAD, a!, b!])).toBe(next);
    for (const i of next.items) expect(isPlaced(i, workArea(next.w, next.h))).toBe(true);
  });

  it('grows the desk downward when the rows are full, and nothing overlaps', () => {
    const next = fitDeskToAgents(desk, [LEAD, ...staff(9)]);
    expect(next.items).toHaveLength(13);
    expect(next.h).toBeGreaterThan(desk.h);
    expect(next.w).toBe(desk.w);
    for (const i of next.items) for (const j of next.items) if (i !== j) expect(overlaps(i, j)).toBe(false);
  });

  it('takes a gone agent\'s tile off, with its place in the stack, and never keeps one for the lead', () => {
    const [a, b] = staff(2);
    const two = fitDeskToAgents(desk, [LEAD, a!, b!]);
    const one = fitDeskToAgents(two, [LEAD, b!]);
    expect(one.items.map((i) => i.app)).toEqual(['chat', 'notebook', 'browser', 'agent', `agent:${b!.id}`]);
    expect(stackOrder(one)).not.toContain(agentItemId('d1', a!.id));
    const withLeadTile: LayoutDesk = { ...desk, items: [...desk.items, { id: 'd1:agent:manager', app: 'agent:manager', x: 400, y: 24, w: 76, h: 76 }] };
    expect(fitDeskToAgents(withLeadTile, [LEAD]).items.map((i) => i.app)).toEqual(['chat', 'notebook', 'browser', 'agent']);
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
    expect(fitDeskToBand(desk, 'teen').items.map((i) => i.app)).toEqual(['chat', 'notebook', 'browser']);
  });

  it('an agent tile alone doesn\'t make a desk arranged, so a first visit still uploads nothing', () => {
    expect(isUntouched({ desks: { d1: desk }, z: ['d1'] }, ['d1'])).toBe(true);
    const moved = { ...desk, items: desk.items.map((i) => (i.app === 'chat' ? { ...i, x: 300, y: 120 } : i)) };
    expect(isUntouched({ desks: { d1: moved }, z: ['d1'] }, ['d1'])).toBe(false);
  });
});
