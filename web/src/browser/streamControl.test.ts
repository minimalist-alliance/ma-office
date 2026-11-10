import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamState } from '../desk/deskLink';
import { StreamControl, type StreamStatus } from './streamControl';

interface Call {
  state: StreamState;
  resolve: () => void;
  reject: (e: unknown) => void;
}

let calls: Call[];
let statuses: StreamStatus[];
let control: StreamControl;
const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const sent = (): StreamState[] => calls.map((c) => c.state);
const last = (): Call => calls[calls.length - 1] as Call;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  calls = [];
  statuses = [];
  control = new StreamControl(
    (state) => new Promise<void>((resolve, reject) => calls.push({ state, resolve, reject })),
    (s) => statuses.push(s),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('StreamControl', () => {
  it('waits for a session, then asks', () => {
    control.set('live');
    expect(sent()).toEqual([]);
    control.up();
    expect(sent()).toEqual(['live']);
  });

  it('a new session has nothing to turn off, so off sends nothing', () => {
    control.up();
    control.set('off');
    expect(sent()).toEqual([]);
  });

  it('says live only once the desk has', async () => {
    control.set('live');
    control.up();
    expect(statuses.at(-1)?.live).toBe(false);
    last().resolve();
    await flush();
    expect(statuses.at(-1)?.live).toBe(true);
  });

  it('one call at a time: a close during a slow live goes out when it ends', async () => {
    control.set('live');
    control.up();
    control.set('off');
    expect(sent()).toEqual(['live']);
    last().resolve();
    await flush();
    expect(sent()).toEqual(['live', 'off']);
  });

  it('only the newest wish goes out: live, off, live while one is on its way sends no more', async () => {
    control.set('live');
    control.up();
    control.set('off');
    control.set('live');
    last().resolve();
    await flush();
    expect(sent()).toEqual(['live']);
  });

  it('live, warm, live again: the hidden tab path', async () => {
    control.set('live');
    control.up();
    last().resolve();
    await flush();
    control.set('warm');
    expect(sent()).toEqual(['live', 'warm']);
    expect(statuses.at(-1)?.live).toBe(true); // not yet confirmed either way
    last().resolve();
    await flush();
    expect(statuses.at(-1)?.live).toBe(false);
    control.set('live');
    expect(sent()).toEqual(['live', 'warm', 'live']);
  });

  it.each(['unavailable', 'rate_limited', 'internal', ''])('%s retries on backoff', async (code) => {
    control.set('live');
    control.up();
    last().reject({ code });
    await flush(100);
    expect(sent()).toEqual(['live']);
    await flush(700);
    expect(sent()).toEqual(['live', 'live']);
    last().reject({ code });
    await flush(1_300);
    expect(sent()).toEqual(['live', 'live', 'live']);
    last().resolve();
    await flush();
    expect(statuses.at(-1)).toEqual({ refused: null, live: true, ready: true, trying: false, bandwidthPaused: false, resumesAt: null });
  });

  it('warm, once the desk says yes, is ready but not live: the simple view needs no picture (task 47)', async () => {
    control.set('warm');
    control.up();
    last().resolve();
    await flush();
    expect(statuses.at(-1)).toEqual({ refused: null, live: false, ready: true, trying: false, bandwidthPaused: false, resumesAt: null });
  });

  it('deadline_exceeded: the work carries on and the state stands, so nothing is sent again', async () => {
    control.set('live');
    control.up();
    last().reject({ code: 'deadline_exceeded' });
    await flush(60_000);
    expect(sent()).toEqual(['live']);
    expect(statuses.at(-1)).toEqual({ refused: null, live: true, ready: true, trying: false, bandwidthPaused: false, resumesAt: null });
    control.set('off');
    expect(sent()).toEqual(['live', 'off']);
  });

  it('again asks once more for what is wanted, which starts a unit that stopped by itself', async () => {
    control.set('live');
    control.up();
    last().resolve();
    await flush();
    control.again();
    expect(sent()).toEqual(['live', 'live']);
    control.again(); // one is on its way
    expect(sent()).toEqual(['live', 'live']);
  });

  it('again has nothing to do with no session, or a final no', async () => {
    control.set('live');
    control.again();
    expect(sent()).toEqual([]);
    control.up();
    last().reject({ code: 'not_found' });
    await flush();
    control.again();
    expect(sent()).toEqual(['live']);
  });

  it('a new wish does not wait out the backoff', async () => {
    control.set('live');
    control.up();
    last().resolve();
    await flush();
    control.set('off');
    last().reject({ code: 'unavailable' });
    await flush();
    control.set('live'); // already what the desk has
    expect(sent()).toEqual(['live', 'off']);
    control.set('off');
    expect(sent()).toEqual(['live', 'off', 'off']);
  });

  it.each(['not_found', 'forbidden'])('%s is final until the next session', async (code) => {
    control.set('live');
    control.up();
    last().reject({ code });
    await flush();
    expect(statuses.at(-1)?.refused).toBe(code);
    await flush(5 * 60 * 1000);
    expect(sent()).toEqual(['live']);
    control.down();
    control.up();
    expect(sent()).toEqual(['live', 'live']);
    expect(statuses.at(-1)?.refused).toBeNull();
  });

  describe('chromium_older_than_profile: the desk refused to start an older Chromium on the profile (ADR 0035)', () => {
    const older = { code: 'unavailable', details: { unit: 'desk-browser', code: 'failed', reason: 'chromium_older_than_profile' } };

    it('is final: it says so, never asks again by itself, and the session is off', async () => {
      control.set('live');
      control.up();
      last().reject(older);
      await flush();
      expect(statuses.at(-1)).toEqual({ refused: 'chromium_older_than_profile', live: false, ready: false, trying: false, bandwidthPaused: false, resumesAt: null });
      control.again(); // the no-picture watchdog
      await flush(10 * 60 * 1000);
      expect(sent()).toEqual(['live']);
      expect(control.settled()).toBe(true);
      control.set('warm'); // hidden past 5 minutes: warm starts no Chromium, so there's nothing it could show
      control.set('off'); // closed: deskd has put the session off already
      control.set('live');
      await flush(60_000);
      expect(sent()).toEqual(['live']);
    });

    it('a new session asks once more, as it would after a fix that restarted the desk', async () => {
      control.set('live');
      control.up();
      last().reject(older);
      await flush();
      control.down();
      control.up();
      expect(statuses.at(-1)?.refused).toBeNull();
      expect(sent()).toEqual(['live', 'live']);
      last().reject(older);
      await flush(5 * 60 * 1000);
      expect(sent()).toEqual(['live', 'live']);
      expect(statuses.at(-1)?.refused).toBe('chromium_older_than_profile');
    });

    it("the member's press is one live, says it's trying, and still refused stays refused", async () => {
      control.set('live');
      control.up();
      last().reject(older);
      await flush();
      control.retry();
      expect(sent()).toEqual(['live', 'live']);
      expect(statuses.at(-1)).toEqual({ refused: 'chromium_older_than_profile', live: false, ready: false, trying: true, bandwidthPaused: false, resumesAt: null });
      control.retry(); // one is on its way
      expect(sent()).toEqual(['live', 'live']);
      last().reject(older);
      await flush(60_000);
      expect(sent()).toEqual(['live', 'live']);
      expect(statuses.at(-1)).toEqual({ refused: 'chromium_older_than_profile', live: false, ready: false, trying: false, bandwidthPaused: false, resumesAt: null });
    });

    it('a press that finds the desk fixed goes live', async () => {
      control.set('live');
      control.up();
      last().reject(older);
      await flush();
      control.retry();
      last().resolve();
      await flush();
      expect(statuses.at(-1)).toEqual({ refused: null, live: true, ready: true, trying: false, bandwidthPaused: false, resumesAt: null });
    });

    it('any other answer to the press carries on as for any session: a unit failure retries on backoff', async () => {
      control.set('live');
      control.up();
      last().reject(older);
      await flush();
      control.retry();
      last().reject({ code: 'unavailable', details: { unit: 'desk-browser', code: 'timeout' } });
      await flush();
      expect(statuses.at(-1)?.refused).toBeNull();
      await flush(1_000);
      expect(sent()).toEqual(['live', 'live', 'live']);
    });

    it('a press does nothing with no such refusal, or with the window not wanting live', async () => {
      control.set('live');
      control.up();
      last().reject({ code: 'not_found' });
      await flush();
      control.retry();
      expect(sent()).toEqual(['live']);
      control.down();
      control.up();
      last().reject(older);
      await flush();
      control.set('off');
      control.retry();
      expect(sent()).toEqual(['live', 'live']);
    });

    it('only that reason: a plain unit failure is still retried by itself', async () => {
      control.set('live');
      control.up();
      last().reject({ code: 'unavailable', details: { unit: 'desk-browser', code: 'failed' } });
      await flush(1_000);
      expect(sent()).toEqual(['live', 'live']);
      expect(statuses.at(-1)?.refused).toBeNull();
    });
  });

  describe('bandwidth_limit: Platform has the member paused, and the desk says so (deskd API.md section 10)', () => {
    const paused = (resumesAt: unknown = '2026-11-09T07:00:00.000Z') => ({ code: 'unavailable', details: { reason: 'bandwidth_limit', resumesAt } });

    it("stops: it reads the desk's reason and resumesAt, never retries live, and the session is off", async () => {
      control.set('live');
      control.up();
      last().reject(paused());
      await flush();
      expect(statuses.at(-1)).toEqual({ refused: null, live: false, ready: false, trying: false, bandwidthPaused: true, resumesAt: '2026-11-09T07:00:00.000Z' });
      control.again(); // the no-picture watchdog
      control.set('warm');
      control.set('live');
      await flush(10 * 60 * 1000);
      // `warm` still goes, as the desk takes it; `live` never again in this session.
      expect(sent()).toEqual(['live', 'warm']);
      last().resolve();
      await flush();
      control.set('live');
      await flush(60_000);
      expect(sent()).toEqual(['live', 'warm']);
      expect(control.settled()).toBe(true);
    });

    it('a closing window has nothing to say: the desk already left it off', async () => {
      control.set('live');
      control.up();
      last().reject(paused());
      await flush();
      control.set('off');
      expect(sent()).toEqual(['live']);
      expect(control.settled()).toBe(true);
    });

    it("no time, or one that isn't a time, is null: the pause still holds", async () => {
      control.set('live');
      control.up();
      last().reject(paused(null));
      await flush();
      expect(statuses.at(-1)).toMatchObject({ bandwidthPaused: true, resumesAt: null });
      control.down();
      control.up();
      expect(statuses.at(-1)).toMatchObject({ bandwidthPaused: false, resumesAt: null }); // a new session asks once
      last().reject(paused('soon'));
      await flush(60_000);
      expect(statuses.at(-1)).toMatchObject({ bandwidthPaused: true, resumesAt: null });
      expect(sent()).toEqual(['live', 'live']);
    });

    it('only that reason: another unavailable is still retried by itself', async () => {
      control.set('live');
      control.up();
      last().reject({ code: 'unavailable', details: { reason: 'held' } });
      await flush(1_000);
      expect(sent()).toEqual(['live', 'live']);
      expect(statuses.at(-1)?.bandwidthPaused).toBe(false);
    });
  });

  it('refuse: the desk took video away. It stops asking, the window hears, and a closing window can still say off', async () => {
    control.set('live');
    control.up();
    last().resolve();
    await flush();
    control.refuse('forbidden');
    expect(statuses.at(-1)?.refused).toBe('forbidden');
    control.again();
    await flush(60_000);
    expect(sent()).toEqual(['live']);
    control.set('off');
    expect(sent()).toEqual(['live', 'off']);
    control.down();
    control.set('live');
    control.up();
    expect(statuses.at(-1)?.refused).toBeNull(); // a new session asks afresh
    expect(sent()).toEqual(['live', 'off', 'live']);
  });

  it('a new session asks again, and a reply from the old one means nothing', async () => {
    control.set('live');
    control.up();
    const old = last();
    control.down();
    expect(statuses.at(-1)?.live).toBe(false);
    old.resolve();
    await flush();
    expect(statuses.at(-1)?.live).toBe(false);
    control.up();
    expect(sent()).toEqual(['live', 'live']);
    last().resolve();
    await flush();
    expect(statuses.at(-1)?.live).toBe(true);
  });

  it('a session lost during a backoff waits for the next one', async () => {
    control.set('live');
    control.up();
    last().reject({ code: 'unavailable' });
    await flush();
    control.down();
    await flush(60_000);
    expect(sent()).toEqual(['live']);
  });
});
