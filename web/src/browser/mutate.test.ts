import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskNotConnected } from '../desk/deskLink';
import { certainlyNotDone, mayHaveGoneOut, mutate } from './mutate';

/** Each is `code`, `code:reason`, or `code:reason:applied` for `mayHaveApplied: true`. */
const refusal = (spec: string): Error => {
  const [code, reason, applied] = spec.split(':');
  return Object.assign(new Error(spec), { code, details: { ...(reason ? { reason } : {}), ...(applied ? { mayHaveApplied: true } : {}) } });
};

const failing = (...codes: string[]): { fn: (idem: string) => Promise<string>; keys: string[] } => {
  const keys: string[] = [];
  const left = [...codes];
  return {
    keys,
    fn: (idem) => {
      keys.push(idem);
      const next = left.shift();
      return next ? Promise.reject(refusal(next)) : Promise.resolve('done');
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mutate', () => {
  it('sends a UUIDv7 and returns the answer', async () => {
    const { fn, keys } = failing();
    await expect(mutate(fn)).resolves.toBe('done');
    expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('one action keeps one key across every retry, whatever comes back', async () => {
    const { fn, keys } = failing('unavailable', 'deadline_exceeded', 'unavailable:chromium', 'cancelled', 'unavailable');
    const done = mutate(fn);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBe('done');
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(1);
  });

  it.each(['unavailable', 'unavailable:chromium'])('%s with no mayHaveApplied: nothing was done, so the same key runs it', async (c) => {
    const { fn, keys } = failing(c);
    const done = mutate(fn);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe('done');
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('a desk older than the flag stores the error and replays it: it waits on the one key, gives up, and never makes a second', async () => {
    const stored = new Map<string, Error>();
    const keys: string[] = [];
    const replaying = (idem: string): Promise<string> => {
      keys.push(idem);
      if (!stored.has(idem)) stored.set(idem, refusal('unavailable:chromium'));
      return Promise.reject(stored.get(idem) as Error);
    };
    const done = mutate(replaying).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(240_000);
    await expect(done).resolves.toMatchObject({ code: 'unavailable', details: { reason: 'chromium' } });
    expect(keys.length).toBeGreaterThan(1);
    expect(stored.size).toBe(1);
  });

  it.each(['unavailable::applied', 'unavailable:chromium:applied', 'internal::applied'])('%s may have gone out: one try, and back to the caller', async (c) => {
    const { fn, keys } = failing(c);
    const done = mutate(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const err = await done;
    expect(err).toMatchObject({ details: { mayHaveApplied: true } });
    expect(mayHaveGoneOut(err)).toBe(true);
    expect(keys).toHaveLength(1);
  });

  it('a flag that arrives on a retry stops the retrying', async () => {
    const { fn, keys } = failing('unavailable', 'unavailable:chromium:applied');
    const done = mutate(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mayHaveGoneOut(await done)).toBe(true);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('active_tab: nothing was done and nothing will change, so one try. The member asking again is a new action with a new key', async () => {
    const { fn, keys } = failing('unavailable:active_tab', 'unavailable:active_tab');
    const first = mutate(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await first).toMatchObject({ code: 'unavailable', details: { reason: 'active_tab' } });
    expect(keys).toHaveLength(1);
    await mutate(fn).catch((e: unknown) => e);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('no session from the start: it never left, so that is certain', async () => {
    const keys: string[] = [];
    const err = await mutate((idem) => {
      keys.push(idem);
      return Promise.reject(new DeskNotConnected('d'));
    }).catch((e: unknown) => e);
    expect(keys).toHaveLength(1);
    expect(certainlyNotDone(err)).toBe(true);
  });

  it('a call the session took with it is not retried, on this session or the next', async () => {
    const keys: string[] = [];
    const done = mutate((idem) => {
      keys.push(idem);
      return Promise.reject(new DeskNotConnected('d', true));
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mayHaveGoneOut(await done)).toBe(true);
    expect(keys).toHaveLength(1);
  });

  it('a lost reply and then no session: the first try may have gone out, so it is not certain', async () => {
    const keys: string[] = [];
    const answers = [refusal('deadline_exceeded'), new DeskNotConnected('d')];
    const err = await mutate((idem) => {
      keys.push(idem);
      return Promise.reject(answers.shift() as Error);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeskNotConnected);
    expect(certainlyNotDone(err)).toBe(false);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('certainlyNotDone: an answer from deskd with no flag, or a call that never left, and nothing else', () => {
    for (const yes of ['bad_request', 'forbidden:permission', 'not_found', 'too_large', 'rate_limited', 'unavailable', 'unavailable:chromium', 'unavailable:active_tab', 'internal']) expect(certainlyNotDone(refusal(yes))).toBe(true);
    expect(certainlyNotDone(new DeskNotConnected('d'))).toBe(true);
    for (const no of ['unavailable::applied', 'internal::applied', 'too_large::applied', 'deadline_exceeded', 'cancelled']) expect(certainlyNotDone(refusal(no))).toBe(false);
    expect(certainlyNotDone(new DeskNotConnected('d', true))).toBe(false);
    expect(certainlyNotDone(new Error('something else'))).toBe(false);
    expect(certainlyNotDone(null)).toBe(false);
  });

  it('mayHaveGoneOut: the flag and a lost reply, and nothing else', () => {
    for (const yes of ['unavailable::applied', 'internal::applied', 'too_large::applied', 'deadline_exceeded', 'cancelled']) expect(mayHaveGoneOut(refusal(yes))).toBe(true);
    for (const no of ['unavailable', 'unavailable:chromium', 'unavailable:active_tab', 'internal', 'forbidden:permission']) expect(mayHaveGoneOut(refusal(no))).toBe(false);
    expect(mayHaveGoneOut(Object.assign(new Error('x'), { code: 'unavailable', details: { mayHaveApplied: false } }))).toBe(false);
    expect(mayHaveGoneOut(new DeskNotConnected('d', true))).toBe(true);
    expect(mayHaveGoneOut(new DeskNotConnected('d'))).toBe(false);
    expect(mayHaveGoneOut(new Error('something else'))).toBe(false);
    expect(mayHaveGoneOut(null)).toBe(false);
  });

  it.each(['deadline_exceeded', 'cancelled'])('%s retries with the SAME key: the command may have gone out, and must not run twice', async (c) => {
    const { fn, keys } = failing(c, c);
    await expect(mutate(fn)).resolves.toBe('done');
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('gives up on lost replies after a couple of retries', async () => {
    const { fn, keys } = failing('deadline_exceeded', 'deadline_exceeded', 'deadline_exceeded');
    await expect(mutate(fn)).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(keys).toHaveLength(3);
  });

  it('unavailable outlasts a 75 s first start, and goes within about 5 s of Chromium being up', async () => {
    const started = Date.now();
    let answered = 0;
    const keys: string[] = [];
    const done = mutate((idem) => {
      keys.push(idem);
      if (Date.now() - started < 75_000) return Promise.reject(refusal('unavailable:chromium'));
      answered = Date.now() - started;
      return Promise.resolve('done');
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(done).resolves.toBe('done');
    expect(answered).toBeLessThan(81_000);
    expect(new Set(keys).size).toBe(1);
  });

  it('gives up on unavailable after about 2 minutes, still on the one key', async () => {
    const codes = new Array(200).fill('unavailable') as string[];
    const { fn, keys } = failing(...codes);
    const done = mutate(fn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(keys.length).toBeLessThan(40);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(done).resolves.toMatchObject({ code: 'unavailable' });
    expect(keys.length).toBeLessThan(40);
    expect(new Set(keys).size).toBe(1);
  });

  it('forbidden for permission is not retried', async () => {
    const { fn, keys } = failing('forbidden:permission');
    await expect(mutate(fn)).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'permission' } });
    expect(keys).toHaveLength(1);
  });

  it.each(['not_found', 'bad_request', 'forbidden', 'internal'])('%s goes straight to the caller', async (c) => {
    const { fn, keys } = failing(c);
    await expect(mutate(fn)).rejects.toMatchObject({ code: c });
    expect(keys).toHaveLength(1);
  });
});
