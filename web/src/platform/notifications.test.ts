// The bell's poll (ADR 0125 §9, contract notifications.md §2): a 304 that keeps the last count, the kill switch, and
// when a tab asks. A fake clock, document and window. The words are the kit's (`packages/bell-kit`, tested there).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { ApiError, type ApiResult } from './api';
import {
  askUnread,
  takeUnread,
  UNREAD_POLL_MS,
  UNREAD_SLOW_POLL_MS,
  watchUnread,
  type NotificationsState,
  type UnreadAnswer,
} from './notifications';

const ok = (unread: number, etag: string | null): ApiResult<{ unread: number }> => ({ status: 200, data: { unread }, etag, retryAfter: null });
const notModified = (etag: string | null): ApiResult<{ unread: number }> => ({ status: 304, data: null, etag, retryAfter: null });

describe('asking for the count', () => {
  it('reads the count and keeps the ETag', async () => {
    const calls: (string | null)[] = [];
    const answer = await askUnread(null, (etag) => {
      calls.push(etag);
      return Promise.resolve(ok(3, '"a"'));
    });
    expect(answer).toEqual({ kind: 'count', unread: 3, etag: '"a"' });
    expect(calls).toEqual([null]);
  });
  it('sends the last ETag back, and a 304 keeps the count it has', async () => {
    const calls: (string | null)[] = [];
    const answer = await askUnread('"a"', (etag) => {
      calls.push(etag);
      return Promise.resolve(notModified(etag));
    });
    expect(calls).toEqual(['"a"']);
    expect(answer).toEqual({ kind: 'same' });
    const state: NotificationsState = { unread: 3, etag: '"a"', paused: false };
    expect(takeUnread(state, answer)).toBe(state);
  });
  it('404 (the routes not there yet) hides the bell the same way', async () => {
    const answer = await askUnread(null, () => Promise.reject(new ApiError(404, 'not_found', 'Not found.', 'r-2', false)));
    expect(answer).toEqual({ kind: 'paused' });
  });

  it('503 notifications_paused is the kill switch, and hides the bell', async () => {
    const answer = await askUnread(null, () => Promise.reject(new ApiError(503, 'notifications_paused', 'Paused.', 'r-1', true)));
    expect(answer).toEqual({ kind: 'paused' });
    const state: NotificationsState = { unread: 3, etag: '"a"', paused: false };
    expect(takeUnread(state, answer)).toEqual({ unread: 3, etag: '"a"', paused: true });
    // Back on: the next count brings the bell back.
    expect(takeUnread({ unread: 3, etag: '"a"', paused: true }, { kind: 'count', unread: 4, etag: '"b"' })).toEqual({ unread: 4, etag: '"b"', paused: false });
    expect(takeUnread({ unread: 3, etag: '"a"', paused: true }, { kind: 'same' })).toEqual({ unread: 3, etag: '"a"', paused: false });
  });
  it('any other failure changes nothing', async () => {
    expect(await askUnread(null, () => Promise.reject(new ApiError(503, 'unavailable', 'Try again.', 'r-1', true)))).toEqual({ kind: 'failed' });
    expect(await askUnread(null, () => Promise.reject(new TypeError('Failed to fetch')))).toEqual({ kind: 'failed' });
    expect(await askUnread(null, () => Promise.resolve({ status: 200, data: { unread: 'many' } as unknown as { unread: number }, etag: null, retryAfter: null }))).toEqual({ kind: 'failed' });
    const state: NotificationsState = { unread: 2, etag: null, paused: false };
    expect(takeUnread(state, { kind: 'failed' })).toBe(state);
  });
  it('a negative or fractional count reads as a whole one', async () => {
    expect(await askUnread(null, () => Promise.resolve(ok(-2, null)))).toEqual({ kind: 'count', unread: 0, etag: null });
    expect(await askUnread(null, () => Promise.resolve(ok(2.7, null)))).toEqual({ kind: 'count', unread: 2, etag: null });
  });
});

describe('the poll', () => {
  type Listener = () => void;
  let doc: { visibilityState: 'visible' | 'hidden'; on: Listener | null; addEventListener: (t: string, fn: Listener) => void; removeEventListener: () => void };
  let win: { on: Listener | null; addEventListener: (t: string, fn: Listener) => void; removeEventListener: () => void };
  let asked: (string | null)[];
  let answers: UnreadAnswer[];
  let store: UseBoundStore<StoreApi<NotificationsState>>;
  let stop: () => void;

  const flush = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  const show = (v: 'visible' | 'hidden'): void => {
    doc.visibilityState = v;
    doc.on?.();
  };

  function start(): void {
    stop = watchUnread({
      ask: (etag) => {
        asked.push(etag);
        return Promise.resolve(answers.length > 1 ? answers.shift()! : answers[0]!);
      },
      doc: doc as unknown as Document,
      win: win as unknown as Window,
      store,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    doc = { visibilityState: 'visible', on: null, addEventListener: (_t, fn) => void (doc.on = fn), removeEventListener: () => void (doc.on = null) };
    win = { on: null, addEventListener: (_t, fn) => void (win.on = fn), removeEventListener: () => void (win.on = null) };
    asked = [];
    answers = [{ kind: 'count', unread: 2, etag: '"a"' }];
    store = create<NotificationsState>(() => ({ unread: null, etag: null, paused: false }));
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('asks at once, then once a minute while visible, with the ETag', async () => {
    start();
    await flush(0);
    expect(asked).toEqual([null]);
    expect(store.getState()).toEqual({ unread: 2, etag: '"a"', paused: false });
    answers = [{ kind: 'same' }];
    await flush(UNREAD_POLL_MS - 1);
    expect(asked).toHaveLength(1);
    await flush(1);
    expect(asked).toEqual([null, '"a"']);
    expect(store.getState().unread).toBe(2);
    await flush(UNREAD_POLL_MS);
    expect(asked).toHaveLength(3);
  });

  it('asks nothing while hidden, and at once when shown again after a while', async () => {
    start();
    await flush(0);
    show('hidden');
    await flush(3 * UNREAD_POLL_MS);
    expect(asked).toHaveLength(1);
    show('visible');
    await flush(0);
    expect(asked).toHaveLength(2);
  });

  it('starts hidden: asks only once shown', async () => {
    doc.visibilityState = 'hidden';
    start();
    await flush(UNREAD_POLL_MS);
    expect(asked).toHaveLength(0);
    show('visible');
    await flush(0);
    expect(asked).toHaveLength(1);
  });

  it('a tab focused again asks now, but not twice within a few seconds', async () => {
    start();
    await flush(0);
    win.on?.();
    await flush(0);
    expect(asked).toHaveLength(1); // just asked
    await flush(10_000);
    win.on?.();
    await flush(0);
    expect(asked).toHaveLength(2);
  });

  it('paused hides the bell and keeps asking, so it comes back', async () => {
    answers = [{ kind: 'paused' }, { kind: 'count', unread: 1, etag: '"b"' }];
    start();
    await flush(0);
    expect(store.getState().paused).toBe(true);
    await flush(UNREAD_SLOW_POLL_MS);
    expect(store.getState()).toEqual({ unread: 1, etag: '"b"', paused: false });
  });

  it('absent or paused: asks every 10 minutes, and a real answer brings the minute back', async () => {
    answers = [{ kind: 'paused' }, { kind: 'paused' }, { kind: 'count', unread: 1, etag: '"b"' }, { kind: 'same' }];
    start();
    await flush(0);
    expect(asked).toHaveLength(1);
    await flush(UNREAD_POLL_MS * 9);
    expect(asked).toHaveLength(1);
    await flush(UNREAD_SLOW_POLL_MS - UNREAD_POLL_MS * 9);
    expect(asked).toHaveLength(2);
    expect(store.getState().paused).toBe(true);
    await flush(UNREAD_SLOW_POLL_MS);
    expect(asked).toHaveLength(3);
    expect(store.getState().paused).toBe(false);
    await flush(UNREAD_POLL_MS);
    expect(asked).toHaveLength(4);
  });

  it('a failure while paused keeps the slow pace', async () => {
    answers = [{ kind: 'paused' }, { kind: 'failed' }, { kind: 'count', unread: 1, etag: null }];
    start();
    await flush(0);
    await flush(UNREAD_SLOW_POLL_MS);
    expect(asked).toHaveLength(2);
    await flush(UNREAD_POLL_MS * 2);
    expect(asked).toHaveLength(2);
    await flush(UNREAD_SLOW_POLL_MS - UNREAD_POLL_MS * 2);
    expect(asked).toHaveLength(3);
  });

  it('a failure changes nothing and the next ask is a minute on', async () => {
    answers = [{ kind: 'failed' }, { kind: 'count', unread: 5, etag: null }];
    start();
    await flush(0);
    expect(store.getState().unread).toBeNull();
    await flush(UNREAD_POLL_MS);
    expect(store.getState().unread).toBe(5);
  });

  it('stopped, it asks no more and lets go of its listeners', async () => {
    start();
    await flush(0);
    stop();
    expect(doc.on).toBeNull();
    expect(win.on).toBeNull();
    await flush(5 * UNREAD_POLL_MS);
    expect(asked).toHaveLength(1);
    stop = () => {};
  });
});
