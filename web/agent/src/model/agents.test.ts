import { describe, expect, it } from 'vitest';
import type { Agent, KeyMeta, Message } from '../client/types';
import { badgeDismissable, badgeShown, errorText, KEY_RESTART_LINE, keyLost, keysLast, monogram, retryDelayMs, STATUS_DOT, STATUS_LABEL, statusWord } from './agents';
import { applyEvent, applyEvents, EMPTY_THREAD, streaming } from './conversation';

const bound = { keyId: 'k', provider: 'anthropic', providerName: 'Anthropic', model: 'm' };
const agent = (over: Partial<Agent> = {}): Agent => ({ id: 'a', name: 'A', role: 'manager', status: 'online', binding: bound, badgeHidden: false, badgeNotice: false, unseen: 0, ...over });

describe('provider badges (design 9.4)', () => {
  it('show by default, hide globally or per agent', () => {
    expect(badgeShown(agent(), true)).toBe(true);
    expect(badgeShown(agent(), false)).toBe(false);
    expect(badgeShown(agent({ badgeHidden: true }), true)).toBe(false);
    expect(badgeShown(agent({ binding: null }), true)).toBe(false);
  });
  it('come back after a provider change until dismissed, however they were hidden', () => {
    expect(badgeShown(agent({ badgeNotice: true }), false)).toBe(true);
    expect(badgeShown(agent({ badgeNotice: true, badgeHidden: true }), true)).toBe(true);
    expect(badgeDismissable(agent({ badgeNotice: true }), false)).toBe(true);
    expect(badgeDismissable(agent({ badgeNotice: true }), true)).toBe(false); // showing anyway: nothing to dismiss
    expect(badgeDismissable(agent(), false)).toBe(false);
  });
  it('fall back to a neutral monogram', () => {
    expect(monogram('Anthropic')).toBe('A');
    expect(monogram(' openai')).toBe('O');
    expect(monogram('')).toBe('?');
  });
});

describe('status', () => {
  it('every state has a word and a dot, so color is never the only signal', () => {
    for (const s of Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_DOT[s]).toBeTruthy();
    }
  });
  it('errors read in words, never as the provider said them', () => {
    expect(errorText('provider_error', 'rate_limited')).toMatch(/rate limit/);
    expect(errorText('key_refused')).toMatch(/refused this key/);
    expect(errorText('name_taken')).toBe('Another agent on this desk has that name.');
    expect(errorText('disk_low')).toMatch(/low on storage/);
    expect(errorText('disk_budget')).toMatch(/share of this desk’s storage/);
    expect(errorText('too_many_folders')).toMatch(/as many folders/);
    expect(errorText('cut_off')).toBe('The reply was cut off at its length limit.');
    expect(errorText('refused')).toBe('The model declined to answer.');
    expect(errorText(null)).toMatch(/couldn’t/);
  });
});

const msg = (id: string, at: number, over: Partial<Message> = {}): Message => ({ id, role: 'assistant', text: '', at, ...over });

describe('the thread reducer', () => {
  it('a snapshot replaces, sorted by time', () => {
    const t = applyEvent(EMPTY_THREAD, { type: 'snapshot', seq: 4, messages: [msg('b', 2), msg('a', 1)] });
    expect(t.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(t.seq).toBe(4);
  });
  it('streams deltas into the reply, and drops repeats', () => {
    let t = applyEvent(EMPTY_THREAD, { type: 'snapshot', seq: 0, messages: [] });
    t = applyEvents(t, [
      { type: 'message', seq: 1, message: msg('r', 5, { state: 'streaming' }) },
      { type: 'delta', seq: 2, messageId: 'r', runId: 'x', text: 'Hel' },
      { type: 'delta', seq: 3, messageId: 'r', runId: 'x', text: 'lo' },
      { type: 'delta', seq: 3, messageId: 'r', runId: 'x', text: 'lo' }, // a repeat
    ]);
    expect(t.messages[0]?.text).toBe('Hello');
    expect(streaming(t)?.id).toBe('r');
    t = applyEvent(t, { type: 'message', seq: 4, message: msg('r', 5, { state: 'done', text: 'Hello' }) });
    t = applyEvent(t, { type: 'delta', seq: 5, messageId: 'r', runId: 'x', text: ' late' }); // after it finished
    expect(t.messages[0]?.text).toBe('Hello');
    expect(streaming(t)).toBeNull();
  });
  it('touches only the message an event is for', () => {
    const t = applyEvent(EMPTY_THREAD, { type: 'snapshot', seq: 0, messages: [msg('a', 1), msg('r', 2, { state: 'streaming' })] });
    const next = applyEvent(t, { type: 'delta', seq: 1, messageId: 'r', runId: 'x', text: 'x' });
    expect(next.messages[0]).toBe(t.messages[0]);
    expect(next.messages[1]).not.toBe(t.messages[1]);
  });
  it('places a late message by time', () => {
    let t = applyEvent(EMPTY_THREAD, { type: 'snapshot', seq: 0, messages: [msg('a', 1), msg('c', 3)] });
    t = applyEvent(t, { type: 'message', seq: 1, message: msg('b', 2) });
    expect(t.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('a key that went', () => {
  const key = (over: Partial<KeyMeta> = {}): KeyMeta => ({ keyId: 'k', provider: 'anthropic', providerName: 'Anthropic', label: 'Personal', last4: 'abcd', createdAt: 0, createdByDesk: 'Personal', ...over });

  // `keysLast`, the stopgap until the Desk Engineer offers an explicit field: either sign from desk-agent 0e1fb6c says the store.
  it('keys last where any key carries `available`, either way, whatever the limits say', () => {
    expect(keysLast([key({ available: true })], {})).toBe(true);
    expect(keysLast([key(), key({ available: false })], undefined)).toBe(true);
  });
  it('keys last where `agent.limits.get` has a `timeZone`, even null, so a desk with no keys yet shows no line', () => {
    expect(keysLast([], { agentId: 'manager', timeZone: null })).toBe(true);
    expect(keysLast([], { timeZone: 'Europe/London' })).toBe(true);
    expect(keysLast([key()], { timeZone: null })).toBe(true);
  });
  it('a desk with neither is an older desk-agent: keys don\'t last, and it gets the restart line', () => {
    expect(keysLast([], { agentId: 'manager', policy: {}, usage: [] })).toBe(false);
    expect(keysLast([key()], { agentId: 'manager' })).toBe(false);
    expect(keysLast([], null)).toBe(false); // the limits read failed: the caution stays
    expect(KEY_RESTART_LINE).toContain('until this desk restarts');
  });
  it('not known until both reads have answered, unless a key already says', () => {
    expect(keysLast([], undefined)).toBeNull();
    expect(keysLast(null, { timeZone: null })).toBe(true);
    expect(keysLast(null, {})).toBeNull();
  });
  it('`available: false` is lost, and `true` is not, whatever an agent shows', () => {
    expect(keyLost(key({ available: false }), [])).toBe(true);
    expect(keyLost(key({ available: true }), [agent({ status: 'no_key' })])).toBe(false);
  });
  it('with no `available`, only an agent still bound to it and showing `no_key` says it went', () => {
    expect(keyLost(key(), [agent({ status: 'no_key' })])).toBe(true);
    expect(keyLost(key(), [agent({ status: 'online' })])).toBe(false);
    expect(keyLost(key(), [agent({ status: 'no_key', binding: null })])).toBe(false);
    expect(keyLost(key({ keyId: 'other' }), [agent({ status: 'no_key' })])).toBe(false);
  });
  it('the status word says it needs adding again, not that there never was one', () => {
    expect(statusWord(agent({ status: 'no_key' }))).toBe('add key again');
    expect(statusWord(agent({ status: 'no_key', binding: null }))).toBe('no key');
    expect(statusWord(agent({ status: 'online' }))).toBe('online');
    expect(errorText('no_key')).not.toContain('yet');
  });
});

describe('reading again while desk-agent is down', () => {
  it('grows and stays calm', () => {
    expect([0, 1, 2, 3, 4, 50].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  });
});
