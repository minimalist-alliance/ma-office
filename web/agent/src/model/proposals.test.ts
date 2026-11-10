// The lead's cards (task 49 fix): the words around a change, old to new, who suggested it, and what can't be confirmed.
import { describe, expect, it } from 'vitest';
import { describeProposal, diffText, failedText, namesClose, nameKey, STATE_TEXT } from './proposals';
import { daysText } from './timers';

const look = (icon: string, tone: string) => ({ icon, tone });
const agents = [
  { id: 'ag-aaaa1111', name: 'Scout', look: look('compass', 'teal'), purpose: 'Old purpose here.', binding: { keyId: 'k1', model: 'm-old' } },
  { id: 'ag-bbbb2222', name: 'Writer', look: look('pen', 'plum') },
  { id: 'ag-cccc3333', name: 'Scout 2', look: look('book', 'blue') },
  { id: 'ag-lead', name: 'Manager', role: 'manager' as const, lead: true, purpose: 'You set up agents.' },
];
const ctx = { agents, zone: 'America/Denver', iconLabel: (i: string) => `icon ${i}`, toneLabel: (t: string) => `tone ${t}`, modelLabel: (m: string) => ({ 'm-old': 'Old Model', 'm-new': 'New Model' })[m] ?? null, keyLabel: () => 'Personal · Anthropic' };

describe('card words', () => {
  it('shows old to new from before, model names, and warns when a size is below what is used', () => {
    const v = describeProposal({ action: 'agent.update', payload: { agentId: 'ag-aaaa1111', model: 'm-new', workspaceMb: 5 }, before: { model: 'm-old', workspaceMb: 50, usedBytes: 20 * 1024 * 1024 } }, ctx);
    const model = v.rows.find((r) => r.label === 'Model')!;
    expect([model.before, model.value]).toEqual(['Old Model', 'New Model']);
    const ws = v.rows.find((r) => r.label === 'Workspace')!;
    expect([ws.before, ws.value]).toEqual(['50 MB', '5 MB']);
    expect(ws.warn).toBe('Scout already uses 20 MB; delete files first.');
  });

  it('a card for a deleted agent says so and cannot be confirmed', () => {
    const v = describeProposal({ action: 'timer.set', payload: { agentId: 'ag-gone', timer: { label: 'x', kind: 'once', inMinutes: 5, prompt: 'p' } } }, ctx);
    expect(v.title).toBe('Add a timer to a deleted agent');
    expect(v.gone).toBe(true);
    expect(describeProposal({ action: 'agent.links', payload: { agentId: 'ag-bbbb2222', links: [{ to: 'ag-gone', rules: 'r' }] } }, ctx).gone).toBe(true);
    // An applied removal keeps the name it had.
    const done = describeProposal({ action: 'agent.delete', payload: { agentId: 'ag-gone' }, before: { name: 'Old Scout' }, state: 'applied' }, ctx);
    expect(done.title).toBe('Remove Old Scout');
  });

  it('flags a taken name and a taken look, but not an agent against itself', () => {
    const create = describeProposal({ action: 'agent.create', payload: { name: 'sсout', icon: 'compass', tone: 'teal' }, state: 'pending' }, ctx);
    expect(create.nameTaken).toBe('sсout');
    expect(create.lookTaken).toBe(true);
    expect(describeProposal({ action: 'agent.create', payload: { name: 'Fresh', icon: 'compass' } }, ctx).lookTaken).toBe(false);
    const self = describeProposal({ action: 'agent.update', payload: { agentId: 'ag-aaaa1111', name: 'Scout', icon: 'compass', tone: 'teal' } }, ctx);
    expect([self.nameTaken, self.lookTaken]).toEqual([null, false]);
  });

  it('stamps a card the member did not start', () => {
    const base = { action: 'agent.delete' as const, payload: { agentId: 'ag-bbbb2222' } };
    expect(describeProposal(base, ctx).stamp).toBeNull();
    expect(describeProposal({ ...base, origin: { kind: 'member' } }, ctx).stamp).toBeNull();
    expect(describeProposal({ ...base, origin: { kind: 'agent', agentId: 'ag-aaaa1111', name: 'Scout' } }, ctx).stamp).toBe('Suggested while answering Scout');
    expect(describeProposal({ ...base, origin: { kind: 'timer', agentId: 'ag-aaaa1111', timerId: 't', label: 'Morning brief' } }, ctx).stamp).toBe('Suggested by the timer Morning brief');
  });

  it('adds an id suffix when two names are close', () => {
    expect(describeProposal({ action: 'agent.delete', payload: { agentId: 'ag-aaaa1111' } }, ctx).subject?.hint).toBe('…1111');
    expect(describeProposal({ action: 'agent.delete', payload: { agentId: 'ag-bbbb2222' } }, ctx).subject?.hint).toBeNull();
    expect(namesClose('Scout', 'Scоut')).toBe(true);
    expect(namesClose('Ann', 'Amy')).toBe(false);
    expect(nameKey(' ＳＣＯＵＴ​ ')).toBe('scout');
  });

  it('a purpose change is a diff, and the lead is marked', () => {
    const v = describeProposal({ action: 'agent.update', payload: { agentId: 'ag-lead', purpose: 'You set up agents and no one else.' }, before: { purpose: 'You set up agents.' } }, ctx);
    expect(v.purpose).toEqual({ before: 'You set up agents.', after: 'You set up agents and no one else.', lead: true });
    expect(v.rows.some((r) => r.label === 'Purpose')).toBe(false);
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-aaaa1111', purpose: 'New.' } }, ctx).purpose?.lead).toBe(false);
    const runs = diffText('a b c', 'a x c');
    expect(runs.map((r) => `${r.op}${r.text}`)).toEqual(['=a ', '-b', '+x', '= c']);
  });

  it('a timer change shows the one it replaces, and says when it turns one back on', () => {
    const old = { id: 't1', label: 'Brief', kind: 'repeat', days: [1, 2, 3, 4, 5], time: '08:00', everyMinutes: null, at: null, prompt: 'Old ask.', enabled: false };
    const v = describeProposal({ action: 'timer.set', payload: { agentId: 'ag-aaaa1111', timer: { id: 't1', label: 'Brief', kind: 'repeat', days: [1], time: '09:00', prompt: 'New ask.', enabled: true } }, before: { timer: old } }, ctx);
    const t = v.timers[0]!;
    expect(t.was).toMatchObject({ label: 'Brief', schedule: 'Weekdays at 8:00 AM (off)', prompt: 'Old ask.' });
    expect(t.schedule).toBe('Mondays at 9:00 AM');
    expect(t.turnsOn).toBe(true);
  });

  it('a timer removal shows its timer in full', () => {
    const old = { id: 't1', label: 'Brief', kind: 'repeat', days: [1, 2, 3, 4, 5], time: '08:00', prompt: 'Ask.', enabled: true };
    const v = describeProposal({ action: 'timer.delete', payload: { agentId: 'ag-aaaa1111', timerId: 't1' }, before: { timer: old } }, ctx);
    expect(v.timers[0]).toMatchObject({ label: 'Brief', schedule: 'Weekdays at 8:00 AM', prompt: 'Ask.', removed: true });
    expect(describeProposal({ action: 'timer.delete', payload: { agentId: 'ag-aaaa1111', timerId: 't1', label: 'Brief' } }, ctx).timers[0]?.label).toBe('Brief');
  });

  it('says it plainly: no days, other change, not done', () => {
    expect(daysText([])).toBe('no days');
    expect(describeProposal({ action: 'agent.update', payload: { agentId: 'ag-aaaa1111', extra_flag: true } }, ctx).rows[0]?.label).toBe('Other change: extra_flag');
    expect(STATE_TEXT.failed).toBe('Not done:');
    expect(failedText('links')).toBe('One of these agents isn’t on this desk any more.');
    expect(failedText('name_taken')).toContain('already has an agent with that name');
    expect(failedText(null)).toBe('The desk couldn’t make this change.');
  });
});

describe('diff', () => {
  it('reads inline when most of the text is shared, apart when it is not', async () => {
    const { diffIsChoppy } = await import('./proposals');
    const a = 'Write short notes for the member each morning.';
    const b = 'Write short notes for the member each evening.';
    expect(diffIsChoppy(diffText(a, b), a, b)).toBe(false);
    const c = 'Read the workspace and brief me.';
    const d = 'Keep notes short and say when unsure.';
    expect(diffIsChoppy(diffText(c, d), c, d)).toBe(true);
  });
});
