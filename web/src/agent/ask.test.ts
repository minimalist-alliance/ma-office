// Documents' "Ask Lead" (the owner, Nov 15): a question goes to the desk's lead by default, or another agent picked, into that
// agent's window, never sent by itself; a document goes as its text in a file. And the welcome's word that a helper couldn't run.
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { defaultDesk, agentApp } = await import('../canvas/layout');
const { useLayoutStore } = await import('../state/layoutStore');
const { useWindowStore } = await import('../state/windowStore');
const { noteAgents, dropRoster } = await import('./roster');
const { askAgent, askableAgents, docTextFile, takeAgentAsk, useAgentAsk } = await import('./ask');
const { cantRun } = await import('../welcome/refusals');

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, name: id, role: id === 'manager' ? 'manager' : 'staff', lead: id === 'manager', status: 'online', binding: null, badgeHidden: false, badgeNotice: false, unseen: 0, look: { icon: 'hat', tone: 'graphite', png: null }, ...over });

beforeEach(() => {
  dropRoster();
  const d1 = defaultDesk('d1', 0, 0);
  d1.items.push({ id: 'd1:agent:ag-scout000001', app: agentApp('ag-scout000001'), x: 400, y: 400, w: 76, h: 76 });
  useLayoutStore.setState({ desks: { d1, d2: { ...defaultDesk('d2', 700, 0), items: [] } }, z: ['d1', 'd2'] });
  useWindowStore.setState({ windows: {}, active: null });
  useAgentAsk.setState({ ask: null });
});

describe('asking a desk agent', () => {
  it('lists the lead first, then the others', () => {
    noteAgents('d1', [agent('ag-scout000001', { name: 'Scout' }), agent('manager', { name: 'Lead' })]);
    expect(askableAgents('d1').map((a) => a.name)).toEqual(['Lead', 'Scout']);
    expect(askableAgents('d2')).toEqual([]);
  });
  it('hands the words to the lead in its own window (the Agent tile), and once taken, they go', () => {
    noteAgents('d1', [agent('manager', { name: 'Lead' })]);
    expect(askAgent('d1', 'manager', 'About “Contract”: ')).toBe(true);
    const ask = useAgentAsk.getState().ask!;
    expect(ask).toMatchObject({ deskId: 'd1', agentId: 'manager', app: 'agent', text: 'About “Contract”: ', file: null });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual(['d1:agent']);
    takeAgentAsk(ask.seq + 1);
    expect(useAgentAsk.getState().ask).not.toBeNull();
    takeAgentAsk(ask.seq);
    expect(useAgentAsk.getState().ask).toBeNull();
  });
  it('hands a picked agent the words in its own window', () => {
    noteAgents('d1', [agent('manager'), agent('ag-scout000001', { name: 'Scout' })]);
    expect(askAgent('d1', 'ag-scout000001', 'payment')).toBe(true);
    expect(useAgentAsk.getState().ask).toMatchObject({ agentId: 'ag-scout000001', app: 'agent:ag-scout000001' });
  });
  it('hands nothing over on a desk with no Agent tile', () => {
    noteAgents('d2', [agent('manager')]);
    expect(askAgent('d2', 'manager', 'x')).toBe(false);
    expect(useAgentAsk.getState().ask).toBeNull();
  });
  it('makes the document a plain text file under its title, pages marked', async () => {
    const f = docTextFile('12 Nov · Rosa Ortiz · Contract', { pages: [{ n: 1, text: 'One' }, { n: 2, text: 'Two' }], sections: [] })!;
    expect(f.name).toBe('12 Nov Rosa Ortiz Contract.txt');
    expect(f.type).toBe('text/plain');
    expect(await f.text()).toBe('Page 1\nOne\n\nPage 2\nTwo');
    expect(await docTextFile('Notes', { pages: [], sections: [{ text: 'A' }, { text: 'B' }] })!.text()).toBe('A\n\nB');
    expect(docTextFile('Blank', { pages: [], sections: [] })).toBeNull();
    expect(docTextFile('../../etc/passwd', { pages: [{ n: 1, text: 'x' }], sections: [] })!.name).toBe('.. .. etc passwd.txt');
  });
});

describe('the welcome', () => {
  it('reads the desk\'s word that a helper could not run', () => {
    expect(cantRun({ code: 'precondition_failed', details: { reason: 'cant_run' } })).toBe(true);
    expect(cantRun({ code: 'precondition_failed', details: { reason: 'agent_cap' } })).toBe(false);
    expect(cantRun(new Error('x'))).toBe(false);
    expect(cantRun(null)).toBe(false);
  });
});
