import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../client/types';
import { actionText, nextStep, noteZoneSet, shownInActivity, targetText } from './Activity';

const row = (action: string, target: string, decision: string): Pick<AuditEntry, 'action' | 'target' | 'decision'> => ({ action, target, decision });

describe('Activity at a restart, on a desk with the key store (ADR 0042)', () => {
  it('hides the stop\'s `keys:all` drop where keys are known to last, and only there', () => {
    const drop = row('key.drop', 'keys:all', 'zeroed:2');
    expect(shownInActivity(drop, true)).toBe(false);
    expect(shownInActivity(drop, false)).toBe(true); // an older desk: the keys really went
    expect(shownInActivity(drop, null)).toBe(true); // not known yet: hide nothing
    expect(actionText(drop)).toBe('A restart cleared 2 keys');
    expect(actionText(row('key.drop', 'keys:all', 'zeroed:1'))).toBe('A restart cleared 1 key');
    expect(actionText(row('key.drop', 'key:k-1', 'ok'))).toBe('Deleted a key');
  });
  it('a member\'s own delete, and a refused key\'s drop, still show', () => {
    expect(shownInActivity(row('key.drop', 'key:k-1', 'zeroed'), true)).toBe(true);
    expect(shownInActivity(row('key.drop', 'key:k-1', 'not_held'), true)).toBe(true);
    expect(shownInActivity(row('key.add', 'key:k-1', 'provider:anthropic'), true)).toBe(true);
  });
  it('a restore that read every key is hidden; one that couldn\'t read some is one plain row, plural right', () => {
    expect(shownInActivity(row('key.restore', 'keys:all', 'restored:2:unreadable:0'), true)).toBe(false);
    const one = row('key.restore', 'keys:all', 'restored:1:unreadable:1');
    const two = row('key.restore', 'keys:all', 'restored:0:unreadable:2');
    expect(shownInActivity(one, true)).toBe(true);
    expect(shownInActivity(one, null)).toBe(true);
    expect(actionText({ ...one })).toBe('After a restart, 1 key couldn’t be read');
    expect(actionText({ ...two })).toBe('After a restart, 2 keys couldn’t be read');
    expect(nextStep(one)).toBe('Add it again in Keys.');
    expect(nextStep(two)).toBe('Add them again in Keys.');
    expect(nextStep(row('key.restore', 'keys:all', 'restored:2:unreadable:0'))).toBeNull();
    expect(nextStep(row('key.add', 'key:k-1', 'ok'))).toBeNull();
  });
  it('the desk team\'s own stop and start stay', () => {
    expect(shownInActivity(row('service.stop', 'desk-agent:2026.11.07-0e1fb6c', 'ok'), true)).toBe(true);
    expect(actionText(row('service.stop', 'desk-agent:x', 'ok'))).toBe('Desk team stopped');
    expect(actionText(row('service.start', 'desk-agent:x', 'ok'))).toBe('Desk team started');
  });
});

describe('a row\'s target, in words (the brand review: a key by its name, never its id)', () => {
  const ctx = {
    agents: [{ id: 'manager', name: 'Manager' }],
    keys: [{ keyId: 'k-anthropic-1', label: 'Personal' }],
    providers: [{ id: 'anthropic', name: 'Anthropic' }],
  };
  it('names the key, the agent, the model and the provider', () => {
    expect(targetText('key:k-anthropic-1 model:anthropic/claude-sonnet-4-5', ctx)).toBe('Personal · claude-sonnet-4-5');
    expect(targetText('agent:manager key:k-anthropic-1 model:anthropic/claude-sonnet-4-5', ctx)).toBe('Manager · Personal · claude-sonnet-4-5');
    expect(targetText('provider:anthropic', ctx)).toBe('Anthropic');
    expect(targetText('scope:agent_day key:k-anthropic-1 model:anthropic/claude-sonnet-4-5', ctx)).toBe('Today · Personal · claude-sonnet-4-5');
    expect(targetText('keys:all', ctx)).toBe('every key');
  });
  it('a key no longer on the desk, or with the list not read yet, is never its id', () => {
    expect(targetText('key:k-01a1b5e2-0b8f-77bb-8a01-76960c9a4dcc', ctx)).toBe('a deleted key');
    expect(targetText('key:k-anthropic-1', { ...ctx, keys: null })).toBe('a deleted key');
    for (const t of ['key:k-relcheck-4b6055 model:anthropic/claude-x', 'agent:manager key:k-zzz model:openai/gpt-x']) expect(targetText(t, ctx)).not.toMatch(/k-[a-z0-9-]+/);
  });
  it('an unknown agent or provider keeps its plain id, and anything else reads as it came', () => {
    expect(targetText('agent:research', ctx)).toBe('research');
    expect(targetText('provider:xai', ctx)).toBe('xai');
    expect(targetText('desk-agent:2026.11.07-0e1fb6c', ctx)).toBe('desk-agent:2026.11.07-0e1fb6c');
  });
});

describe('the zone the window set by itself (ADR 0043)', () => {
  it('names the zone on its own row, and every other change of limits stays "Changed limits"', () => {
    noteZoneSet('h-zone', 'America/Denver');
    expect(actionText({ ...row('limits.set', 'agent:manager', 'ok'), hash: 'h-zone' })).toBe('Time zone set to America/Denver');
    expect(actionText({ ...row('limits.set', 'agent:manager', 'ok'), hash: 'h-other' })).toBe('Changed limits');
    expect(actionText(row('limits.set', 'agent:manager', 'ok'))).toBe('Changed limits');
  });

  it('a limits.timezone row says so after a reload, without a zone it does not hold, and with one on the page that sent it', () => {
    expect(actionText({ ...row('limits.timezone', 'agent:manager', 'ok'), hash: 'h-fresh' })).toBe('Time zone set');
    expect(actionText(row('limits.timezone', 'agent:manager', 'ok'))).toBe('Time zone set');
    noteZoneSet('h-tz', 'Asia/Tokyo');
    expect(actionText({ ...row('limits.timezone', 'agent:manager', 'ok'), hash: 'h-tz' })).toBe('Time zone set to Asia/Tokyo');
  });
});
