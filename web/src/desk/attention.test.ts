// Task 46, lever 2: which desk is looked at, and when `desk.attention.set` goes. A fake clock and a fake send.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttentionSignal, lookedAtDesk, shownDesk } from './attention';
import { DeskNotConnected } from './deskLink';

describe('"looked at", the one rule', () => {
  it('is the active desk in desk and free mode', () => {
    expect(shownDesk({ mode: 'desk', activeDesk: 'a' })).toBe('a');
    expect(shownDesk({ mode: 'free', activeDesk: 'a' })).toBe('a');
    expect(lookedAtDesk({ mode: 'desk', activeDesk: 'a' }, false)).toBe('a');
    expect(lookedAtDesk({ mode: 'free', activeDesk: 'b' }, false)).toBe('b');
  });

  it('is no desk in the overview, which parks every window, even with one desk ringed', () => {
    expect(shownDesk({ mode: 'overview', activeDesk: 'a' })).toBeNull();
    expect(lookedAtDesk({ mode: 'overview', activeDesk: 'a' }, false)).toBeNull();
  });

  it('is no desk while the tab is hidden, though its windows stay where they were', () => {
    expect(lookedAtDesk({ mode: 'desk', activeDesk: 'a' }, true)).toBeNull();
    expect(shownDesk({ mode: 'desk', activeDesk: 'a' })).toBe('a');
  });

  it('in a hidden tab, is the shown desk only while the member is listening to it', () => {
    expect(lookedAtDesk({ mode: 'desk', activeDesk: 'a' }, true, true, true)).toBe('a');
    expect(lookedAtDesk({ mode: 'desk', activeDesk: 'a' }, true, true, false)).toBeNull();
    expect(lookedAtDesk({ mode: 'overview', activeDesk: 'a' }, true, true, true)).toBeNull(); // the overview shows no desk
    expect(lookedAtDesk({ mode: 'desk', activeDesk: 'a' }, false, true, false)).toBe('a');
  });

  it('is no desk while the office itself isn\'t showing, or with no active desk', () => {
    expect(lookedAtDesk({ mode: 'desk', activeDesk: 'a' }, false, false)).toBeNull();
    expect(lookedAtDesk({ mode: 'desk', activeDesk: null }, false)).toBeNull();
  });
});

interface Pending {
  seen: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

let sent: Pending[];
let signal: AttentionSignal;
const seenSent = (): boolean[] => sent.map((p) => p.seen);
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const refuse = (code: string): Error => Object.assign(new Error(code), { code, details: {} });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  sent = [];
  signal = new AttentionSignal((seen) => new Promise((resolve, reject) => sent.push({ seen, resolve: () => resolve({ seen }), reject })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('desk.attention.set', () => {
  it('says nothing without a session, and says the wish as soon as one opens', () => {
    signal.want(false);
    expect(seenSent()).toEqual([]);
    signal.up();
    expect(seenSent()).toEqual([false]);
  });

  it('says nothing to a new session before the office has a wish', () => {
    signal.up();
    expect(seenSent()).toEqual([]);
    signal.want(true);
    expect(seenSent()).toEqual([true]);
  });

  it('goes at once on a change, in the same task, with no timer in between', async () => {
    signal.up();
    signal.want(false);
    sent[0]!.resolve();
    await flush();
    signal.want(true);
    expect(seenSent()).toEqual([false, true]); // synchronously: a switch back is never held for a turn
  });

  it('sends one at a time, and only the newest wish, so a quick switch away and back can\'t land out of order', async () => {
    signal.up();
    signal.want(true);
    signal.want(false);
    signal.want(true);
    expect(seenSent()).toEqual([true]);
    sent[0]!.resolve();
    await flush();
    expect(seenSent()).toEqual([true]); // the newest wish is what the desk already heard
    signal.want(false);
    signal.want(true);
    signal.want(false);
    sent[1]!.resolve();
    await flush();
    expect(seenSent()).toEqual([true, false]);
  });

  it('a repeat of what the desk heard sends nothing', async () => {
    signal.up();
    signal.want(true);
    sent[0]!.resolve();
    await flush();
    signal.want(true);
    expect(seenSent()).toEqual([true]);
  });

  it('says it again on every new session, whatever the last one heard', async () => {
    signal.up();
    signal.want(false);
    sent[0]!.resolve();
    await flush();
    signal.down();
    signal.up();
    expect(seenSent()).toEqual([false, false]);
    expect(signal.answer).toBeNull();
    sent[1]!.resolve();
    await flush();
    expect(signal.answer).toBe('ok');
  });

  it('a reply from a session that has gone counts for nothing', async () => {
    signal.up();
    signal.want(true);
    signal.down();
    signal.want(false);
    signal.up();
    sent[0]!.resolve(); // the old session's
    await flush();
    expect(seenSent()).toEqual([true, false]);
    sent[1]!.resolve();
    await flush();
    signal.want(false);
    expect(seenSent()).toEqual([true, false]);
  });

  it('a desk that doesn\'t know the method is asked nothing more until the next session', async () => {
    signal.up();
    signal.want(false);
    sent[0]!.reject(refuse('not_found'));
    await flush(60_000);
    expect(signal.answer).toBe('not_found');
    signal.want(true);
    signal.want(false);
    expect(seenSent()).toEqual([false]);
    signal.down();
    signal.up();
    expect(seenSent()).toEqual([false, false]); // a desk updated in between may know it now
  });

  it('tries again with backoff after `unavailable`, and a new wish goes at once instead', async () => {
    signal.up();
    signal.want(false);
    sent[0]!.reject(refuse('unavailable'));
    await flush(300);
    expect(seenSent()).toEqual([false]);
    await flush(400); // the first backoff is 0.5 s, give or take 20 %
    expect(seenSent()).toEqual([false, false]);
    sent[1]!.reject(refuse('unavailable'));
    await flush();
    signal.want(true); // the member switched back: no waiting out the backoff
    expect(seenSent()).toEqual([false, false, true]);
  });

  it('a session going stops the retry, and the next one asks from the start', async () => {
    signal.up();
    signal.want(false);
    sent[0]!.reject(refuse('internal'));
    await flush();
    signal.down();
    await flush(60_000);
    expect(seenSent()).toEqual([false]);
    signal.up();
    expect(seenSent()).toEqual([false, false]);
  });

  it('the session dropping mid-call waits for the next one, with no retry of its own', async () => {
    signal.up();
    signal.want(true);
    sent[0]!.reject(new DeskNotConnected('d', true));
    await flush(60_000);
    expect(seenSent()).toEqual([true]);
    expect(signal.answer).toBe('not_connected');
    signal.down();
    signal.up();
    expect(seenSent()).toEqual([true, true]);
  });
});
