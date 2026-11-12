// Agents to tiles through the stores: a desk's `agent.state` adds and removes them quietly, a removed agent's window goes,
// and a teen's desks get none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../agent/src/client/types';

const stored = new Map<string, string>();
vi.stubGlobal('window', {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: number) => clearTimeout(id),
  matchMedia: () => ({ matches: false }),
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) },
});

const { defaultDesk } = await import('../canvas/layout');
const { useLayoutStore, isQuietChange } = await import('../state/layoutStore');
const { openWindow, useWindowStore } = await import('../state/windowStore');
const { setCurrentBand } = await import('../platform/age');
const { noteAgents, useRosterStore, dropRoster, agentAppName, glyphOf } = await import('./roster');
const { startAgentTiles } = await import('./tileSync');
// The look's drawing, loaded here once so its first transform isn't timed inside a test: in a full run on a loaded box, that
// alone took longer than the 1 s `vi.waitFor` gave it. `roster.ts` still asks for it itself, and `lookReady` flips only then.
await import('./lookChunk');

/** When the roster's state says so: the store's own change, with no deadline of its own. */
const rosterSays = (ok: (s: ReturnType<typeof useRosterStore.getState>) => boolean): Promise<void> =>
  new Promise((resolve) => {
    if (ok(useRosterStore.getState())) return resolve();
    const off = useRosterStore.subscribe((s) => {
      if (!ok(s)) return;
      off();
      resolve();
    });
  });

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, name: id, role: id === 'manager' ? 'manager' : 'staff', lead: id === 'manager', status: 'online', binding: null, badgeHidden: false, badgeNotice: false, unseen: 0, look: { icon: 'spark', tone: 'graphite', png: null }, ...over });
const apps = (deskId = 'd1'): string[] => useLayoutStore.getState().desks[deskId]!.items.map((i) => i.app);

let stop: () => void = () => undefined;
beforeEach(() => {
  setCurrentBand(null);
  dropRoster();
  useLayoutStore.setState({ desks: { d1: defaultDesk('d1', 0, 0), d2: defaultDesk('d2', 700, 0) }, z: ['d1', 'd2'] });
  useWindowStore.setState({ windows: {}, active: null });
  stop = startAgentTiles();
});
afterEach(() => stop());

describe('agent tiles follow agent.state', () => {
  it('a new agent gets a tile on its own desk only, quietly; a removed one loses it and its window', async () => {
    let quiet: boolean[] = [];
    const off = useLayoutStore.subscribe(() => quiet.push(isQuietChange()));
    noteAgents('d1', [agent('manager'), agent('ag-scout000001', { name: 'Scout', look: { icon: 'compass', tone: 'teal', png: null } })]);
    expect(apps('d1')).toEqual(['chat', 'notebook', 'browser', 'agent', 'agent:ag-scout000001']);
    expect(apps('d2')).toEqual(['chat', 'notebook', 'browser', 'agent']);
    expect(quiet).toEqual([true]);
    expect(agentAppName('agent:ag-scout000001', 'd1')).toBe('Scout');
    // The look's drawing is its own chunk: blank until it's here, then the tile's own. It lands when its import resolves, which
    // no clock promises, so this waits for `lookReady` itself.
    expect(glyphOf('d1', 'agent:ag-scout000001')).toBe('look:');
    await rosterSays((s) => s.lookReady);
    expect(glyphOf('d1', 'agent:ag-scout000001')).toBe('look:compass:teal:');
    expect(glyphOf('d2', 'agent:ag-gone')).toBe('look:nodes:graphite:');

    openWindow('d1', 'agent:ag-scout000001', 'd1:agent:ag-scout000001');
    expect(Object.keys(useWindowStore.getState().windows)).toEqual(['d1:agent:ag-scout000001']);
    quiet = [];
    noteAgents('d1', [agent('manager')]);
    expect(apps('d1')).toEqual(['chat', 'notebook', 'browser', 'agent']);
    expect(useWindowStore.getState().windows).toEqual({});
    expect(quiet).toEqual([true]);
    off();
  });

  it('a layout that arrives without them gets them back; one with a stale tile loses it', () => {
    noteAgents('d1', [agent('manager'), agent('ag-scout000001')]);
    useLayoutStore.setState({ desks: { ...useLayoutStore.getState().desks, d1: defaultDesk('d1', 0, 0) } });
    expect(apps('d1')).toContain('agent:ag-scout000001');
    const d1 = useLayoutStore.getState().desks['d1']!;
    useLayoutStore.setState({ desks: { ...useLayoutStore.getState().desks, d1: { ...d1, items: [...d1.items, { id: 'd1:agent:ag-old', app: 'agent:ag-old', x: 24, y: 116, w: 76, h: 76 }] } } });
    expect(apps('d1')).not.toContain('agent:ag-old');
  });

  it('a Guild Desk\'s panel gets none: its Agent is the member\'s one seat there', () => {
    useLayoutStore.setState({ desks: { ...useLayoutStore.getState().desks, 'guild-g1': defaultDesk('guild-g1', 0, 400) } });
    noteAgents('guild-g1', [agent('manager'), agent('ag-scout000001')]);
    expect(apps('guild-g1')).toEqual(['chat', 'notebook', 'browser', 'agent']);
  });

  it('a teen\'s desks get none', () => {
    setCurrentBand('teen');
    noteAgents('d1', [agent('manager'), agent('ag-scout000001')]);
    expect(apps('d1')).toEqual(['chat', 'notebook', 'browser', 'agent']);
  });

  it('the roster is memory only, and says nothing until a desk does', () => {
    expect(useRosterStore.getState().desks).toEqual({});
    expect(agentAppName('agent:ag-x')).toBe('Agent');
    noteAgents('d1', [agent('manager'), agent('ag-a', { name: 'Ann' })]);
    expect([...stored.keys()].some((k) => (stored.get(k) ?? '').includes('Ann'))).toBe(false);
  });
});
