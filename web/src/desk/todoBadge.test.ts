import { afterEach, describe, expect, it, vi } from 'vitest';
import { untilMidnight, watchTodoBadge } from './todoBadge';

function fakeLink(answers: (n: number) => Promise<Record<string, unknown>>) {
  let fn: ((msg: unknown) => void) | null = null;
  let refused: ((code: string) => void) | undefined;
  const calls: string[] = [];
  const link = {
    call: vi.fn((method: string) => {
      calls.push(method);
      return answers(calls.length);
    }),
    subscribe: vi.fn((topic: string, f: (msg: unknown) => void, onRefused?: (code: string) => void) => {
      expect(topic).toBe('todo');
      fn = f;
      refused = onRefused;
      return () => {
        fn = null;
      };
    }),
  };
  return { link: link as never, calls, event: (msg: unknown = { seq: 1, type: 'snapshot', rev: 3 }) => fn?.(msg), refuse: () => refused?.('not_found'), live: () => fn !== null };
}

const summary = (badge: number, zone = 'UTC') => Promise.resolve({ open: 4, badge, today: '2026-11-14', zone });

afterEach(() => {
  vi.useRealTimers();
});

describe('watchTodoBadge (API.md section 22)', () => {
  it("reads todo.summary's badge on the topic's snapshot and on each change", async () => {
    const seen: number[] = [];
    const f = fakeLink((n) => summary(n === 1 ? 2 : 3));
    watchTodoBadge(f.link, (b) => seen.push(b));
    expect(f.calls).toEqual([]);
    f.event();
    await vi.waitFor(() => expect(seen).toEqual([2]));
    f.event({ seq: 2, type: 'changed', op: 'add', id: 't1', rev: 4 });
    await vi.waitFor(() => expect(seen).toEqual([2, 3]));
    expect(f.calls).toEqual(['todo.summary', 'todo.summary']);
  });

  it('changes that come while it reads make one more read, not one each', async () => {
    let release: (v: Record<string, unknown>) => void = () => undefined;
    const f = fakeLink((n) => (n === 1 ? new Promise((r) => (release = r)) : summary(5)));
    const seen: number[] = [];
    watchTodoBadge(f.link, (b) => seen.push(b));
    f.event();
    f.event({ seq: 2, type: 'changed' });
    f.event({ seq: 3, type: 'changed' });
    release({ badge: 1, zone: 'UTC' });
    await vi.waitFor(() => expect(seen).toEqual([1, 5]));
    expect(f.calls).toHaveLength(2);
  });

  it('a desk before section 22, a refusal or a failed read says nothing, and a stop ends it', async () => {
    const seen: number[] = [];
    const f = fakeLink(() => Promise.reject(Object.assign(new Error('nf'), { code: 'not_found' })));
    const stop = watchTodoBadge(f.link, (b) => seen.push(b));
    f.refuse();
    f.event();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
    stop();
    expect(f.live()).toBe(false);
  });

  it('asks nothing while the kill switch is off, read at each event, and reads once it is on again', async () => {
    let on = false;
    const seen: number[] = [];
    const f = fakeLink(() => summary(4));
    watchTodoBadge(f.link, (b) => seen.push(b), () => on);
    f.event();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toEqual([]);
    on = true;
    f.event({ seq: 2, type: 'changed' });
    await vi.waitFor(() => expect(seen).toEqual([4]));
  });

  it('reads again just after the desk’s midnight, when “due today” moves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 14, 23, 0, 0));
    const seen: number[] = [];
    const f = fakeLink((n) => summary(n));
    watchTodoBadge(f.link, (b) => seen.push(b), () => true);
    f.event();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual([1, 2]);
  });
});

describe('untilMidnight', () => {
  it('goes by the desk’s zone, a little past midnight, and never less than a minute', () => {
    const at = Date.UTC(2026, 10, 14, 23, 0, 0);
    expect(untilMidnight(at, 'UTC')).toBe(3_600_000 + 2_000);
    // 23:00 UTC is 16:00 in Denver (MST, UTC-7): eight hours to go.
    expect(untilMidnight(at, 'America/Denver')).toBe(8 * 3_600_000 + 2_000);
    expect(untilMidnight(Date.UTC(2026, 10, 14, 23, 59, 59), 'UTC')).toBe(60_000);
    expect(untilMidnight(at, 'Not/AZone')).toBe(3_600_000);
  });
});
