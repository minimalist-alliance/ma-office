import { describe, expect, it } from 'vitest';
import { describeProposal } from './proposals';

const ctx = {
  agents: [
    { id: 'ag-a', name: 'Scout', look: { icon: 'compass', tone: 'teal', png: null } },
    { id: 'ag-b', name: 'Writer', look: { icon: 'hat', color: 'sage', tone: 'iris', png: null } },
  ],
  zone: null,
  iconLabel: (id: string) => `icon ${id}`,
  toneLabel: (id: string) => `tone ${id}`,
};

describe('the look preview of a change', () => {
  it('fills the half a change leaves alone from the agent\'s current look', () => {
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', icon: 'book' } }, ctx).look).toEqual({ icon: 'book', tone: 'teal', color: null });
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', tone: 'plum' } }, ctx).look).toEqual({ icon: 'compass', tone: 'plum', color: null });
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-b', color: 'amber' } }, ctx).look).toEqual({ icon: 'hat', tone: 'iris', color: 'amber' });
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', name: 'Scout 2' } }, ctx).look).toBeNull();
  });
  it('says when another agent here already wears that icon in that colour (Nov 15)', () => {
    expect(describeProposal({ action: 'agent.create', payload: { name: 'Third', purpose: '', color: 'sage' } }, ctx).lookTaken).toBe(true);
    expect(describeProposal({ action: 'agent.create', payload: { name: 'Third', purpose: '', color: 'amber' } }, ctx).lookTaken).toBe(false);
    expect(describeProposal({ action: 'agent.create', payload: { name: 'Third', purpose: '' } }, ctx).lookTaken).toBe(false);
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-b', color: 'sage' } }, ctx).lookTaken).toBe(false);
  });
});
