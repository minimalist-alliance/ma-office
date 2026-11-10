// When an open tab asks whether a new release shipped, and what it does with the answer. A fake clock and document.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VERSION_CHECK_MS, watchVersion } from './newVersion';

let doc: { hidden: boolean; handler: (() => void) | null; addEventListener: (t: string, fn: () => void) => void; removeEventListener: () => void };
let asked: number;
let answers: (string | undefined | Error)[];
let ready: string[];
let stop: () => void;

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const setHidden = (hidden: boolean): void => {
  doc.hidden = hidden;
  doc.handler?.();
};

function start(running = '2026.11.06-aaaaaaa'): void {
  stop = watchVersion({
    running,
    latest: () => {
      asked += 1;
      const a = answers.length > 1 ? answers.shift() : answers[0];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
    onReady: (v) => ready.push(v),
    doc: doc as unknown as Document,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  doc = {
    hidden: false,
    handler: null,
    addEventListener: (_t, fn) => {
      doc.handler = fn;
    },
    removeEventListener: () => {
      doc.handler = null;
    },
  };
  asked = 0;
  answers = ['2026.11.06-aaaaaaa'];
  ready = [];
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('watchVersion', () => {
  it('asks nothing at load, since the page has just loaded what is current, then once a turn', async () => {
    start();
    await flush(VERSION_CHECK_MS - 1);
    expect(asked).toBe(0);
    await flush(1);
    expect(asked).toBe(1);
    await flush(VERSION_CHECK_MS);
    expect(asked).toBe(2);
    expect(ready).toEqual([]);
  });

  it('a turn is 15 minutes: rare', () => {
    expect(VERSION_CHECK_MS).toBe(15 * 60_000);
  });

  it('a different version is ready: it says so once, and asks no more', async () => {
    answers = ['2026.11.07-bbbbbbb'];
    start();
    await flush(VERSION_CHECK_MS);
    expect(ready).toEqual(['2026.11.07-bbbbbbb']);
    await flush(10 * VERSION_CHECK_MS);
    expect(asked).toBe(1);
    expect(doc.handler).toBeNull();
  });

  it('a hidden tab asks nothing, however long', async () => {
    start();
    setHidden(true);
    await flush(24 * 60 * 60_000);
    expect(asked).toBe(0);
  });

  it('back after a long while: it asks at once', async () => {
    start();
    setHidden(true);
    await flush(3 * VERSION_CHECK_MS);
    setHidden(false);
    await flush();
    expect(asked).toBe(1);
  });

  it('back before a turn is up: it waits out the rest of the turn, not a whole new one', async () => {
    start();
    await flush(VERSION_CHECK_MS / 3);
    setHidden(true);
    await flush(VERSION_CHECK_MS / 3);
    setHidden(false);
    await flush(VERSION_CHECK_MS / 3 - 1);
    expect(asked).toBe(0);
    await flush(1);
    expect(asked).toBe(1);
  });

  it('a failure or no version says nothing, and asks again next turn', async () => {
    answers = [new Error('offline'), undefined, '2026.11.07-bbbbbbb'];
    start();
    await flush(VERSION_CHECK_MS);
    await flush(VERSION_CHECK_MS);
    expect(ready).toEqual([]);
    await flush(VERSION_CHECK_MS);
    expect(asked).toBe(3);
    expect(ready).toEqual(['2026.11.07-bbbbbbb']);
  });

  it('an answer that lands after a stop does nothing', async () => {
    let answer: (v: string) => void = () => {};
    stop = watchVersion({
      running: 'a',
      latest: () => new Promise<string>((r) => (answer = r)),
      onReady: (v) => ready.push(v),
      doc: doc as unknown as Document,
    });
    await flush(VERSION_CHECK_MS);
    stop();
    answer('b');
    await flush();
    expect(ready).toEqual([]);
  });

  it('turning visible while an ask is out starts no second one', async () => {
    let answer: (v: string) => void = () => {};
    let calls = 0;
    stop = watchVersion({
      running: 'a',
      latest: () => {
        calls += 1;
        return new Promise<string>((r) => (answer = r));
      },
      onReady: (v) => ready.push(v),
      doc: doc as unknown as Document,
    });
    await flush(VERSION_CHECK_MS);
    setHidden(true);
    setHidden(false);
    await flush(VERSION_CHECK_MS);
    expect(calls).toBe(1);
    answer('a');
    await flush(VERSION_CHECK_MS);
    expect(calls).toBe(2);
  });
});
