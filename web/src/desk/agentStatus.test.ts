import { describe, expect, it } from 'vitest';
import { activityOfAgents, deskSummary, SLOW_OPEN_MS, statusLine, type StatusInput } from './agentStatus';

const base: StatusInput = { vm: 'running', link: 'open', linkAvailable: true, agent: { state: 'idle' } };

describe('what a desk is doing (design 3.5)', () => {
  it.each<[string, Partial<StatusInput>, string]>([
    ['asleep', { vm: 'stopped' }, 'asleep'],
    ['asleep in Give Back', { vm: 'stopped', givebackUntil: '07:00' }, 'asleep · Give Back until 07:00'],
    ['queued', { vm: 'starting', phase: 'queued', queuePosition: 3 }, 'waiting for capacity · #3'],
    ['starting', { vm: 'starting', phase: 'starting' }, 'waking · 1 of 4'],
    ['booting', { vm: 'starting', phase: 'booting' }, 'waking · 2 of 4'],
    ['connecting', { vm: 'starting', phase: 'connecting' }, 'waking · 3 of 4'],
    ['opening', { link: 'connecting' }, 'connecting…'],
    ['reconnecting', { link: 'resuming', lostForSec: 5 }, 'reconnecting…'],
    ['lost', { link: 'retrying', lostForSec: 31 }, "can't reach desk"],
    ['going to sleep', { vm: 'stopping', stopInSec: 45 }, 'going to sleep · 0:45'],
    ['failed', { vm: 'starting', phase: 'failed' }, "couldn't wake · Retry"],
    ['no key', { agent: { state: 'no-key' } }, 'no key'],
    ['idle', { agent: { state: 'idle' } }, 'agent online'],
    ['working', { agent: { state: 'working', task: 'summarizing' } }, 'working · summarizing'],
    ['several', { agent: { state: 'working', count: 3 } }, '3 agents · 1 working'],
    ['needs you', { agent: { state: 'needs-you' } }, 'needs you'],
    ['limit', { agent: { state: 'paused-limit' } }, 'paused · limit reached'],
    ['error', { agent: { state: 'error' } }, 'agent error'],
    ['denied', { link: 'denied' }, 'access denied'],
    ['checking', { vm: 'unknown' }, 'checking…'],
  ])('names %s', (_name, patch, label) => {
    expect(statusLine({ ...base, ...patch }).label).toBe(label);
  });

  it('says so when no link exists yet, and never pretends the agent is online', () => {
    expect(statusLine({ ...base, link: 'idle', linkAvailable: false, agent: { state: 'none' } }).label).toBe('not connected yet');
  });
});

describe('what shows on the desk (ADR 0062)', () => {
  it.each<[string, Partial<StatusInput>]>([
    ['online, with the desk status', { agent: { state: 'none' }, summary: 'online · c7g.large · up 3 h' }],
    ['online, with nothing to say', { agent: { state: 'none' } }],
    ['asleep', { vm: 'stopped' }],
    ['asleep in Give Back', { vm: 'stopped', givebackUntil: '07:00' }],
    ['agent online', { agent: { state: 'idle' } }],
    ['several agents online', { agent: { state: 'idle', count: 3 } }],
    ['working', { agent: { state: 'working', task: 'summarizing' } }],
    ['several working', { agent: { state: 'working', count: 3 } }],
    ['no key', { agent: { state: 'no-key' } }],
    ['checking', { vm: 'unknown' }],
    ['no link yet', { link: 'idle', linkAvailable: false }],
  ])('nothing for %s', (_name, patch) => {
    expect(statusLine({ ...base, ...patch }).dot).toBeNull();
  });

  it.each<[string, Partial<StatusInput>, 'pulse' | 'warn' | 'error']>([
    ['waiting for capacity', { vm: 'starting', phase: 'queued' }, 'pulse'],
    ['waking', { vm: 'starting', phase: 'booting' }, 'pulse'],
    ['reconnecting', { link: 'retrying' }, 'warn'],
    ["can't reach desk", { link: 'retrying', lostForSec: 30 }, 'warn'],
    ['going to sleep', { vm: 'stopping' }, 'warn'],
    ["couldn't wake", { vm: 'error' }, 'error'],
    ['a failed wake phase', { vm: 'starting', phase: 'failed' }, 'error'],
    ['access denied', { link: 'denied' }, 'error'],
    ['needs you', { agent: { state: 'needs-you' } }, 'warn'],
    ['paused', { agent: { state: 'paused-limit' } }, 'warn'],
    ['agent error', { agent: { state: 'error' } }, 'error'],
  ])('at once for %s', (_name, patch, dot) => {
    const line = statusLine({ ...base, ...patch });
    expect(line.dot).toBe(dot);
    expect(line.showAfterMs).toBeUndefined();
  });

  it('marks an agent\'s own states, and only those, for its provider mark (follow-up 8)', () => {
    for (const state of ['needs-you', 'paused-limit', 'error'] as const) {
      expect(statusLine({ ...base, agent: { state } }).fromAgent).toBe(true);
    }
    expect(statusLine({ ...base, link: 'retrying' }).fromAgent).toBeUndefined();
    expect(statusLine({ ...base, vm: 'stopping' }).fromAgent).toBeUndefined();
  });

  it.each(['idle', 'signaling', 'connecting'] as const)('connecting shows only after 2 s, from link state %s', (link) => {
    expect(SLOW_OPEN_MS).toBe(2000);
    expect(statusLine({ ...base, link })).toEqual({ dot: 'pulse', label: 'connecting…', showAfterMs: SLOW_OPEN_MS });
  });

  it('a problem gives way to nothing once the link is open', () => {
    expect(statusLine({ ...base, agent: { state: 'none' }, link: 'retrying', summary: 'online · x' }).label).toBe('reconnecting…');
    expect(statusLine({ ...base, agent: { state: 'none' }, summary: 'online · x' })).toEqual({ dot: null, label: 'online · x' });
  });
});

describe('the desk status in words, for the accessible name', () => {
  it('names the size and the uptime', () => {
    const summary = deskSummary({ instanceType: 'c7g.large', uptimeSec: 3 * 3600 + 120 });
    expect(summary).toBe('online · c7g.large · up 3 h');
    expect(statusLine({ ...base, agent: { state: 'none' }, summary }).label).toBe(summary);
    expect(statusLine({ ...base, agent: { state: 'none' } }).label).toBe('connected');
  });

  it('leaves out an instance type deskd has not read yet', () => {
    expect(deskSummary({ instanceType: null, uptimeSec: 120 })).toBe('online · up 2 min');
  });

  it('gives way to the agent', () => {
    expect(statusLine({ ...base, summary: 'online · x' }).label).toBe('agent online');
  });

  it.each([
    [10, 'up <1 min'],
    [59, 'up <1 min'],
    [60, 'up 1 min'],
    [3599, 'up 59 min'],
    [3600, 'up 1 h'],
    [47 * 3600, 'up 47 h'],
    [48 * 3600, 'up 2 d'],
  ])('rounds %i s down to "%s"', (uptimeSec, up) => {
    expect(deskSummary({ instanceType: 'dev', uptimeSec })).toBe(`online · dev · ${up}`);
  });

  it('a desk the idle rule closed shows nothing, and says why in its accessible name', () => {
    const line = statusLine({ vm: 'running', link: 'resting', linkAvailable: true, agent: { state: 'none' } });
    expect(line.dot).toBeNull();
    expect(line.label).toBe('paused, no recent input');
  });
});

describe('contract 0.3.11: new, held and refused desks', () => {
  it('a new desk says it is being set up at once, with no estimate, whatever the link or phase says', () => {
    for (const phase of ['starting', 'booting', 'connecting', null]) {
      expect(statusLine({ ...base, vm: 'setting-up', phase, link: 'idle' })).toEqual({ dot: 'pulse', label: 'setting up…' });
    }
  });

  it('a held desk shows only the support address, from config or the one mailbox', () => {
    expect(statusLine({ ...base, vm: 'held', link: 'idle' })).toEqual({ dot: 'warn', label: 'support@minimalistalliance.com' });
    expect(statusLine({ ...base, vm: 'stopped', link: 'denied', refusal: { kind: 'unavailable', billingUrl: null }, support: 'help@example.org' }))
      .toEqual({ dot: 'warn', label: 'help@example.org' });
  });

  it('a refused membership says so, over any state the list has', () => {
    for (const vm of ['running', 'stopped', 'starting'] as const) {
      expect(statusLine({ ...base, vm, link: 'denied', refusal: { kind: 'suspended', billingUrl: null } })).toEqual({ dot: 'warn', label: 'membership not active' });
      expect(statusLine({ ...base, vm, link: 'signaling', refusal: { kind: 'inactive', billingUrl: null } }).label).toBe('membership not active');
    }
  });

  it('none of them names a reason or a time', () => {
    const labels = [
      statusLine({ ...base, vm: 'setting-up' }).label,
      statusLine({ ...base, vm: 'held' }).label,
      statusLine({ ...base, refusal: { kind: 'unavailable', billingUrl: null } }).label,
    ];
    for (const label of labels) expect(label).not.toMatch(/\d+ ?(s|min|h)\b|hold|legal|suspend|denied|locked|blocked/i);
  });
});

describe('the panel\'s word from `agent.state`', () => {
  const of = (...status: string[]): ReturnType<typeof activityOfAgents> => activityOfAgents(status.map((s) => ({ status: s })) as never);
  it('spells the wire\'s words its own way', () => {
    expect(of('no_key')).toEqual({ state: 'no-key' });
    expect(of('limit_reached')).toEqual({ state: 'paused-limit' });
    expect(of('needs_you')).toEqual({ state: 'needs-you' });
    expect(of('error')).toEqual({ state: 'error' });
    expect(of('online')).toEqual({ state: 'idle', count: 1 });
    expect(of('working')).toEqual({ state: 'working', count: 1 });
    expect(activityOfAgents([])).toEqual({ state: 'none' });
  });
  it('puts first what the member should hear about, whichever agent says it', () => {
    expect(of('online', 'working', 'limit_reached')).toEqual({ state: 'paused-limit' });
    expect(of('error', 'needs_you')).toEqual({ state: 'needs-you' });
    expect(of('no_key', 'online')).toEqual({ state: 'idle', count: 2 });
    expect(of('online', 'working')).toEqual({ state: 'working', count: 2 });
  });
  it('reaches the status line as the panel already says it', () => {
    const base: StatusInput = { vm: 'running', link: 'open', linkAvailable: true, agent: of('no_key') };
    expect(statusLine(base)).toEqual({ dot: null, label: 'no key' });
    expect(statusLine({ ...base, agent: of('limit_reached') })).toEqual({ dot: 'warn', label: 'paused · limit reached', fromAgent: true });
  });
});

describe('the data guard (ma-platform ADR 0110)', () => {
  it('says why a stop is announced, with the countdown', () => {
    expect(statusLine({ ...base, vm: 'stopping', stopReason: 'data_guard', stopInSec: 45 }).label).toBe('Your desks are stopping: your data use this month went past your plan. 0:45');
    expect(statusLine({ ...base, vm: 'stopping', stopReason: 'data_guard' }).label).toBe('Your desks are stopping: your data use this month went past your plan.');
  });
  it('keeps the usual words for any other reason, known or not', () => {
    expect(statusLine({ ...base, vm: 'stopping', stopReason: 'idle', stopInSec: 45 }).label).toBe('going to sleep · 0:45');
    expect(statusLine({ ...base, vm: 'stopping', stopReason: 'something_new' }).label).toBe('going to sleep');
  });
  it('a refused start is a short line on the desk', () => {
    expect(statusLine({ ...base, vm: 'stopped', link: 'denied', refusal: { kind: 'data_guard', billingUrl: null, message: 'x', resumesAt: null } }).label).toBe('stopped · data use past your plan');
  });
});
