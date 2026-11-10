import { describe, expect, it } from 'vitest';
import { describeProposal } from './proposals';

const ctx = {
  agents: [{ id: 'ag-a', name: 'Scout', look: { icon: 'compass', tone: 'teal', png: null } }],
  zone: null,
  iconLabel: (id: string) => `icon ${id}`,
  toneLabel: (id: string) => `tone ${id}`,
};

describe('the look preview of a change', () => {
  it('fills the half a change leaves alone from the agent\'s current look', () => {
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', icon: 'book' } }, ctx).look).toEqual({ icon: 'book', tone: 'teal' });
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', tone: 'plum' } }, ctx).look).toEqual({ icon: 'compass', tone: 'plum' });
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-a', name: 'Scout 2' } }, ctx).look).toBeNull();
  });
});
