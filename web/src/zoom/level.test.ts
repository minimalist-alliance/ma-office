// An app's own zoom (ADR 0055): the levels, the steps, what's kept, and how a wheel or a pinch becomes steps.
import { describe, expect, it } from 'vitest';
import { clampLevel, GESTURE_GAP_MS, KEY_STEP_PX, levelWords, MAX_KEPT, PINCH_STEP_PX, readLevels, snapLevel, stepLevel, WheelZoom, withLevel, zoomKey } from './level';

describe('levels', () => {
  it('are whole percents from 50 to 200; anything else is 100', () => {
    expect(clampLevel(120)).toBe(120);
    expect(clampLevel(67.4)).toBe(67);
    expect(clampLevel(10)).toBe(50);
    expect(clampLevel(900)).toBe(200);
    for (const odd of [Number.NaN, Infinity, '120', null, undefined]) expect(clampLevel(odd)).toBe(100);
  });

  it('the slider\'s are on 10 % steps', () => {
    expect(snapLevel(67)).toBe(70);
    expect(snapLevel(124)).toBe(120);
    expect(snapLevel(125)).toBe(130);
    expect(snapLevel(3)).toBe(50);
  });

  it('a step is 10 %, held at the ends', () => {
    expect(stepLevel(100, 1)).toBe(110);
    expect(stepLevel(100, -1)).toBe(90);
    expect(stepLevel(100, 3)).toBe(130);
    expect(stepLevel(200, 1)).toBe(200);
    expect(stepLevel(50, -1)).toBe(50);
    expect(stepLevel(190, 5)).toBe(200);
    expect(stepLevel(120, 0)).toBe(120);
  });

  it('a step from the desk Browser\'s own level (a key chord in the page) goes to the grid in its direction', () => {
    expect(stepLevel(67, 1)).toBe(70);
    expect(stepLevel(67, -1)).toBe(60);
    expect(stepLevel(125, 1)).toBe(130);
    expect(stepLevel(125, -1)).toBe(120);
    expect(stepLevel(175, 2)).toBe(190);
  });

  it('say themselves as a percent', () => {
    expect(levelWords(120)).toBe('120%');
    expect(levelWords(67)).toBe('67%');
  });
});

describe('what an app shares', () => {
  it('every agent is the Agent app; a desk app and every other app is its own', () => {
    expect(zoomKey('agent:ag-abcdefghijkl')).toBe('agent');
    expect(zoomKey('agent')).toBe('agent');
    expect(zoomKey('notebook')).toBe('notebook');
    expect(zoomKey('app:com.minimalistalliance.bible')).toBe('app:com.minimalistalliance.bible');
  });
});

describe('what this browser keeps', () => {
  it('reads back only apps the office would write, on the grid, and never 100', () => {
    expect(readLevels({ notebook: 120, files: 100, agent: 67, 'app:com.minimalistalliance.bible': 200, 'Bad Key': 150, '<x>': 150, browser: 'big', commons: Number.NaN })).toEqual({
      notebook: 120,
      agent: 70,
      'app:com.minimalistalliance.bible': 200,
    });
    for (const odd of [null, 3, 'x', [120], undefined]) expect(readLevels(odd)).toEqual({});
  });

  it('keeps at most a few dozen apps, the oldest going first', () => {
    let levels: Record<string, number> = {};
    for (let n = 0; n < MAX_KEPT + 5; n += 1) levels = withLevel(levels, `app:a${n}`, 120);
    expect(Object.keys(levels)).toHaveLength(MAX_KEPT);
    expect(levels['app:a0']).toBeUndefined();
    expect(levels[`app:a${MAX_KEPT + 4}`]).toBe(120);
  });

  it('a change goes last, and 100 takes the app out', () => {
    const levels = withLevel(withLevel({ notebook: 120 }, 'files', 80), 'notebook', 130);
    expect(Object.keys(levels)).toEqual(['files', 'notebook']);
    expect(withLevel(levels, 'files', 100)).toEqual({ notebook: 130 });
  });
});

describe('a wheel or a pinch over an app', () => {
  it('a mouse\'s notch with the key held is one step, never two', () => {
    const z = new WheelZoom();
    expect(z.add(-100, false, 0)).toBe(1);
    expect(z.add(-120, false, 30)).toBe(1);
    expect(z.add(-300, false, 60)).toBe(1);
    expect(z.add(100, false, 90)).toBe(-1);
  });

  it('a trackpad\'s small scrolls with the key held add up to a step', () => {
    const z = new WheelZoom();
    const steps: number[] = [];
    for (let n = 0; n < 20; n += 1) steps.push(z.add(-5, false, n * 16));
    expect(steps.filter((s) => s !== 0)).toEqual([1, 1]);
    expect(KEY_STEP_PX * 2).toBe(100);
  });

  it('a pinch steps evenly, about every 10 % of its scale, the camera\'s own rate', () => {
    const z = new WheelZoom();
    let steps = 0;
    // Chromium's pinch: small deltas, down for out; 10 % of scale is about 8 px.
    for (let n = 0; n < 40; n += 1) steps += z.add(2, true, n * 16);
    expect(steps).toBe(-Math.floor((40 * 2) / PINCH_STEP_PX));
    expect(PINCH_STEP_PX).toBeCloseTo(7.94, 1);
  });

  it('a pinch\'s burst is one step per event, the rest kept for the next', () => {
    const z = new WheelZoom();
    expect(z.add(-30, true, 0)).toBe(1);
    expect(z.add(-0.1, true, 16)).toBe(1);
    expect(z.add(-0.1, true, 32)).toBe(0);
  });

  it('a change of direction or a pause starts afresh', () => {
    const z = new WheelZoom();
    expect(z.add(-40, false, 0)).toBe(0);
    expect(z.add(30, false, 16)).toBe(0); // the other way: what was added up went
    expect(z.add(25, false, 32)).toBe(-1);
    expect(z.add(-40, false, 48)).toBe(0);
    expect(z.add(-40, false, 48 + GESTURE_GAP_MS + 1)).toBe(0); // a pause: the first -40 went
    expect(z.add(-10, false, 48 + GESTURE_GAP_MS + 20)).toBe(1);
  });

  it('nothing, or nonsense, moves nothing', () => {
    const z = new WheelZoom();
    expect(z.add(0, true, 0)).toBe(0);
    expect(z.add(Number.NaN, true, 0)).toBe(0);
  });
});
