// The frame budget's attribution (contract 3.2, ADR 0054's addendum of Nov 12): synthetic Long Animation Frames, shaped as
// Chromium 156 reports them (`docs/sub-status/frame-budget-attribution.md`), and the hang guard for browsers without them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const moving = vi.hoisted(() => ({ now: false }));
vi.mock('../../canvas/controller', () => ({ camera: { isMoving: () => moving.now } }));

// Node has no window, and its PerformanceObserver has no Long Animation Frames: just enough of a browser for the watch to start
// (the observer is never fed; the tests feed `noteFrame` and `noteGap` themselves).
const g = globalThis as Record<string, unknown>;
const nodeObserver = g['PerformanceObserver'];
beforeAll(() => {
  g['window'] ??= { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
  g['PerformanceObserver'] = Object.assign(
    class {
      observe(): void {}
      disconnect(): void {}
    },
    { supportedEntryTypes: ['long-animation-frame'] },
  );
});
afterAll(() => {
  g['PerformanceObserver'] = nodeObserver;
});

const { BUDGET_WINDOW_MS, HANG_WINDOW_MS, noteFrame, noteGap, noteInput, overBudget, shareOf, threadOf, viewShare, watchFrames } = await import('./budget');
type FrameLike = import('./budget').FrameLike;

const VIEW = { name: 'view' };
const OTHER = { name: 'other' };
const OFFICE = { name: 'office' };

/** An office-only long frame: the office's own script took `ms`, then style and layout. */
const officeFrame = (at: number, ms: number): FrameLike => ({
  startTime: at,
  duration: ms + 4,
  styleAndLayoutStart: at + ms,
  scripts: [{ startTime: at, duration: ms, windowAttribution: 'self', window: OFFICE, sourceURL: 'https://office.example/assets/main.js' }],
});
/** A view on the office's thread took `ms` before style and layout: Chromium lists none of its scripts in the office's entry. */
const sharedFrame = (at: number, ms: number): FrameLike => ({ startTime: at, duration: ms + 2, styleAndLayoutStart: at + ms, scripts: [] });

let stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  moving.now = false;
});
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

function watch(win: unknown, thread: 'shared' | 'own' | 'unknown' = 'shared', since = 0): { paused: number } {
  const seen = { paused: 0 };
  stops.push(watchFrames({ win: win as Window, probe: null, name: String((win as { name: string }).name), thread, since, pause: () => (seen.paused += 1) }));
  return seen;
}

/** Three frames a second apart, starting well after any input. */
const thrice = (base: number, make: (at: number) => FrameLike): void => {
  for (let i = 0; i < 3; i += 1) noteFrame(make(base + i * 1000));
};

describe('who took a long frame (shareOf)', () => {
  it("an office-only long frame is the office's: nothing is left unexplained", () => {
    const s = shareOf(officeFrame(1000, 80), [VIEW]);
    expect(s.office).toBe(80);
    expect(s.unexplained).toBe(0);
    expect(viewShare(s, VIEW, true)).toBe(0);
  });

  it("a view on the office's thread shows as time no office script explains", () => {
    const s = shareOf(sharedFrame(1000, 100), [VIEW]);
    expect(s.unexplained).toBe(100);
    expect(viewShare(s, VIEW, true)).toBe(100);
    // A view on a thread of its own can't have taken it.
    expect(viewShare(s, VIEW, false)).toBe(0);
  });

  it("a mixed frame counts only the view's share", () => {
    // The office 30 ms, the view 100 ms (as Chromium reports: one 'self' script, the rest unlisted).
    const mixed: FrameLike = { startTime: 1000, duration: 134, styleAndLayoutStart: 1130, scripts: [{ startTime: 1000, duration: 30, windowAttribution: 'self', window: OFFICE }] };
    const s = shareOf(mixed, [VIEW]);
    expect(s.office).toBe(30);
    expect(viewShare(s, VIEW, true)).toBe(100);
    // An office frame that merely includes a few ms of the view: 60 ms of office, 10 of view.
    const small: FrameLike = { startTime: 1000, duration: 74, styleAndLayoutStart: 1070, scripts: [{ startTime: 1000, duration: 60, windowAttribution: 'self', window: OFFICE }] };
    expect(viewShare(shareOf(small, [VIEW]), VIEW, true)).toBe(10);
  });

  it("a script whose window is a view's frame is that view's, whichever thread it's on", () => {
    const f: FrameLike = {
      startTime: 1000,
      duration: 90,
      styleAndLayoutStart: 1085,
      scripts: [
        { startTime: 1000, duration: 70, windowAttribution: 'descendant', window: VIEW, sourceURL: 'blob:null/1' },
        { startTime: 1070, duration: 15, windowAttribution: 'self', window: OFFICE },
      ],
    };
    const s = shareOf(f, [VIEW, OTHER]);
    expect(s.views.get(VIEW)).toBe(70);
    expect(viewShare(s, VIEW, false)).toBe(70);
    expect(viewShare(s, OTHER, false)).toBe(0);
    expect(s.unexplained).toBe(0);
  });

  it("an opaque origin's blob: script no window claims goes to the views on the office's thread", () => {
    const f: FrameLike = { startTime: 0, duration: 70, styleAndLayoutStart: 66, scripts: [{ startTime: 0, duration: 66, windowAttribution: 'other', window: null, sourceURL: 'blob:null/9f' }] };
    const s = shareOf(f, [VIEW]);
    expect(s.opaque).toBe(66);
    expect(viewShare(s, VIEW, true)).toBe(66);
    expect(viewShare(s, VIEW, false)).toBe(0);
    // The office's own blob: (its origin's) is the office's.
    const own: FrameLike = { ...f, scripts: [{ startTime: 0, duration: 66, windowAttribution: 'self', window: OFFICE, sourceURL: 'blob:https://office.example/1' }] };
    expect(viewShare(shareOf(own, [VIEW]), VIEW, true)).toBe(0);
  });

  it('style, layout and paint are nobody\'s, and scripts after them explain nothing before', () => {
    // 20 ms of office script, then 150 ms of style, layout and paint (a slow machine): nothing unexplained.
    const slow: FrameLike = { startTime: 0, duration: 170, styleAndLayoutStart: 20, scripts: [{ startTime: 0, duration: 20, windowAttribution: 'self', window: OFFICE }] };
    expect(shareOf(slow, [VIEW]).unexplained).toBe(0);
    // A resize observer's 40 ms after style and layout doesn't hide 60 ms before it.
    const late: FrameLike = { startTime: 0, duration: 110, styleAndLayoutStart: 60, scripts: [{ startTime: 65, duration: 40, windowAttribution: 'self', window: OFFICE }] };
    expect(shareOf(late, [VIEW]).unexplained).toBe(60);
  });

  it('a frame without rendering ends at its duration', () => {
    expect(shareOf({ startTime: 0, duration: 104, scripts: [] }, [VIEW]).unexplained).toBe(104);
  });
});

describe('the budget (noteFrame)', () => {
  it('the busy office never pauses a view, on its thread or not', () => {
    const shared = watch(VIEW);
    thrice(5000, (at) => officeFrame(at, 80));
    thrice(9000, (at) => officeFrame(at, 200));
    expect(shared.paused).toBe(0);
  });

  it("three frames of a view's own time over 50 ms in 10 s pause it", () => {
    const v = watch(VIEW);
    noteFrame(sharedFrame(5000, 100));
    noteFrame(sharedFrame(6000, 100));
    expect(v.paused).toBe(0);
    noteFrame(sharedFrame(7000, 100));
    expect(v.paused).toBe(1);
  });

  it('frames further apart than 10 s, or 50 ms and under, never add up', () => {
    const v = watch(VIEW);
    noteFrame(sharedFrame(5000, 100));
    noteFrame(sharedFrame(5000 + BUDGET_WINDOW_MS / 2, 100));
    noteFrame(sharedFrame(5000 + BUDGET_WINDOW_MS + 600, 100));
    expect(v.paused).toBe(0);
    thrice(30_000, (at) => ({ ...sharedFrame(at, 50), duration: 80, styleAndLayoutStart: at + 50 }));
    expect(v.paused).toBe(0);
  });

  it('a view on a thread of its own is never paused for unexplained time', () => {
    const own = watch(VIEW, 'own');
    thrice(5000, (at) => sharedFrame(at, 120));
    expect(own.paused).toBe(0);
  });

  it('until its thread is known, a view counts as sharing it', () => {
    const v = watch(VIEW, 'unknown');
    thrice(5000, (at) => sharedFrame(at, 120));
    expect(v.paused).toBe(1);
  });

  it('only the view whose scripts took the time is paused', () => {
    const a = watch(VIEW, 'own');
    const b = watch(OTHER, 'own');
    thrice(5000, (at) => ({ startTime: at, duration: 90, styleAndLayoutStart: at + 88, scripts: [{ startTime: at, duration: 88, windowAttribution: 'descendant', window: VIEW }] }));
    expect(a.paused).toBe(1);
    expect(b.paused).toBe(0);
  });

  it("unexplained time can't be split: every view on the office's thread is paused, and none on its own", () => {
    const a = watch(VIEW);
    const b = watch(OTHER);
    const c = watch(OFFICE, 'own');
    thrice(5000, (at) => sharedFrame(at, 100));
    expect([a.paused, b.paused, c.paused]).toEqual([1, 1, 0]);
  });

  it("frames that start within a second of the member's input, or while the camera moves, don't count", () => {
    const v = watch(VIEW);
    noteInput(4800);
    noteFrame(sharedFrame(5000, 100));
    noteInput(5900);
    noteFrame(sharedFrame(6000, 100));
    moving.now = true;
    noteFrame(sharedFrame(8000, 100));
    moving.now = false;
    noteFrame(sharedFrame(9000, 100));
    expect(v.paused).toBe(0);
    // Input during a frame (queued behind it) doesn't excuse it.
    noteInput(10_050);
    noteFrame(sharedFrame(10_000, 100));
    noteFrame(sharedFrame(11_500, 100));
    expect(v.paused).toBe(1);
  });

  it("a view's first 2 s are its startup, and while one on the office's thread starts, unexplained time is nobody's", () => {
    const older = watch(OTHER);
    const fresh = watch(VIEW, 'shared', 20_000);
    // The fresh view's start: three long frames in its first two seconds strike neither.
    noteFrame(sharedFrame(20_100, 120));
    noteFrame(sharedFrame(20_800, 120));
    noteFrame(sharedFrame(21_500, 120));
    expect([older.paused, fresh.paused]).toEqual([0, 0]);
    // After it, they count again, for both.
    thrice(23_000, (at) => sharedFrame(at, 120));
    expect([older.paused, fresh.paused]).toEqual([1, 1]);
  });

  it('nothing counts while no view shows', () => {
    thrice(5000, (at) => sharedFrame(at, 100));
    const v = watch(VIEW);
    noteFrame(sharedFrame(8100, 100));
    expect(v.paused).toBe(0);
  });

  it('the old pure check still reads three in ten seconds', () => {
    expect(overBudget([0, 4000, 9000], 9000)).toBe(true);
    expect(overBudget([0, 4000, 11_000], 11_000)).toBe(false);
  });
});

describe('the hang guard without Long Animation Frames (noteGap)', () => {
  it('one hang is nothing; a second within 30 s pauses the views on the office\'s thread', () => {
    const shared = watch(VIEW);
    const own = watch(OTHER, 'own');
    noteGap(5000, 1200, true);
    expect(shared.paused).toBe(0);
    noteGap(5000 + HANG_WINDOW_MS - 1000, 1100, true);
    expect([shared.paused, own.paused]).toEqual([1, 0]);
  });

  it("the office's own long frames, a second's gap and under, never count, however many", () => {
    const v = watch(VIEW);
    for (let i = 0; i < 40; i += 1) noteGap(5000 + i * 500, i % 2 ? 80 : 1000, true);
    expect(v.paused).toBe(0);
  });

  it("a hang that starts in a view's first 2 s is its startup", () => {
    const v = watch(VIEW, 'shared', 10_000);
    noteGap(11_500, 1300, true);
    noteGap(13_000, 1300, true);
    expect(v.paused).toBe(0);
    noteGap(15_000, 1300, true);
    expect(v.paused).toBe(0);
    noteGap(17_000, 1300, true);
    expect(v.paused).toBe(1);
  });

  it("hangs further apart than 30 s, after the member's input, or longer than a sleep's 20 s, don't add up", () => {
    const v = watch(VIEW);
    noteGap(5000, 1500, true);
    noteGap(5000 + HANG_WINDOW_MS + 1, 1500, true);
    expect(v.paused).toBe(0);
    noteGap(80_000, 1500, false);
    noteGap(81_000, 1500, false);
    expect(v.paused).toBe(0);
    noteGap(120_000, 25_000, true);
    noteGap(121_000, 25_000, true);
    expect(v.paused).toBe(0);
  });
});

describe('which thread a frame is on (threadOf)', () => {
  it('gives up, holding nothing, once no view shows the frame', async () => {
    const ch = new MessageChannel();
    let pinged = 0;
    ch.port2.onmessage = () => (pinged += 1);
    expect(await threadOf(ch.port1, {} as Window, () => false, async () => {})).toBeNull();
    expect(pinged).toBe(0);
    ch.port1.close();
  });
});
