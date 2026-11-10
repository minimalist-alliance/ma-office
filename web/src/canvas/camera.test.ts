import { describe, expect, it } from 'vitest';
import { cameraDuration, cubicBezier, DESK_MAX_SCALE, easeCamera, edgePan, fitRect, FOCUS_ZOOM, interpolateCamera, isVisible, lodFor, MAX_SCALE, MIN_SCALE, SlowFrameWindow, snapToDevice, wheelZoomFactor, zoomAtPoint, zoomedInOn } from './camera';

const vp = { w: 1000, h: 800 };
const ins = { top: 72, bottom: 64, side: 0 };

describe('whole device pixels', () => {
  it('at 1x a CSS pixel is one, and at 2x there are two to a CSS pixel', () => {
    expect(snapToDevice(10.2, 1)).toBe(10);
    expect(snapToDevice(10.5, 1)).toBe(11);
    expect(snapToDevice(10.2, 2)).toBe(10);
    expect(snapToDevice(10.25, 2)).toBe(10.5);
    expect(snapToDevice(10.3, 2)).toBe(10.5);
    expect(snapToDevice(10.8, 2)).toBe(11);
    expect(snapToDevice(-3.3, 2)).toBe(-3.5);
    expect(snapToDevice(10, 1.5) * 1.5).toBe(15);
    expect(snapToDevice(10.2, 1.5) * 1.5).toBe(15);
  });

  it('never moves anything more than half a device pixel', () => {
    for (const ratio of [1, 1.25, 1.5, 2]) {
      for (let v = -40; v < 40; v += 0.137) {
        expect(Math.abs(snapToDevice(v, ratio) - v) * ratio).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });
});

describe('a dragged corner at the viewport edge', () => {
  it('pans nothing away from the edge', () => {
    expect(edgePan({ x: 500, y: 400 }, vp, 16)).toEqual({ dx: 0, dy: 0 });
    expect(edgePan({ x: 952, y: 752 }, vp, 16)).toEqual({ dx: 0, dy: 0 });
  });

  it('pans harder toward the edge, and no harder past it', () => {
    const near = edgePan({ x: 976, y: 400 }, vp, 16);
    const at = edgePan({ x: 1000, y: 400 }, vp, 16);
    expect(near.dx).toBeGreaterThan(0);
    expect(at.dx).toBeGreaterThan(near.dx);
    expect(edgePan({ x: 1400, y: 400 }, vp, 16).dx).toBe(at.dx);
    expect(at.dy).toBe(0);
  });

  it('is gentle, and doesn\'t depend on the frame rate', () => {
    expect(edgePan({ x: 1000, y: 800 }, vp, 1000)).toEqual({ dx: 480, dy: 480 });
    expect(edgePan({ x: 1000, y: 800 }, vp, 8).dx * 2).toBeCloseTo(edgePan({ x: 1000, y: 800 }, vp, 16).dx);
  });

  it('never pans up or left, since a corner only grows right and down', () => {
    expect(edgePan({ x: 0, y: 0 }, vp, 16)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('easing', () => {
  it('starts at 0, ends at 1, never leaves the range', () => {
    expect(easeCamera(0)).toBe(0);
    expect(easeCamera(1)).toBe(1);
    for (let t = 0; t <= 1; t += 0.05) {
      expect(easeCamera(t)).toBeGreaterThanOrEqual(0);
      expect(easeCamera(t)).toBeLessThanOrEqual(1);
    }
  });
  it('is the identity for a linear bezier', () => {
    const linear = cubicBezier(0.25, 0.25, 0.75, 0.75);
    expect(linear(0.4)).toBeCloseTo(0.4, 2);
  });
  it('is fast early, as an entrance curve should be', () => {
    expect(easeCamera(0.3)).toBeGreaterThan(0.6);
  });
});

describe('camera duration (320 + up to 160 ms)', () => {
  const a = { x: 0, y: 0, s: 1 };
  it('is 320 for no distance', () => {
    expect(cameraDuration(a, a, vp)).toBe(320);
  });
  it('never exceeds 480', () => {
    expect(cameraDuration(a, { x: -9000, y: 0, s: 0.2 }, vp)).toBe(480);
  });
  it('grows with distance', () => {
    expect(cameraDuration(a, { x: -300, y: 0, s: 1 }, vp)).toBeGreaterThan(320);
  });
});

describe('interpolation', () => {
  const from = { x: 0, y: 0, s: 0.5 };
  const to = { x: -200, y: -100, s: 2 };
  it('hits both ends', () => {
    expect(interpolateCamera(from, to, 0, vp)).toMatchObject({ s: 0.5 });
    const end = interpolateCamera(from, to, 1, vp);
    expect(end.s).toBeCloseTo(2);
    expect(end.x).toBeCloseTo(-200);
    expect(end.y).toBeCloseTo(-100);
  });
  it('interpolates the scale in log space', () => {
    expect(interpolateCamera(from, to, 0.5, vp).s).toBeCloseTo(1);
  });
});

describe('fit', () => {
  it('caps at the desk maximum', () => {
    const c = fitRect({ x: 0, y: 0, w: 100, h: 50 }, vp, ins, 48, DESK_MAX_SCALE);
    expect(c.s).toBe(DESK_MAX_SCALE);
  });
  it('keeps the margin and centers in the free area', () => {
    const c = fitRect({ x: 0, y: 0, w: 4000, h: 500 }, vp, ins, 48, DESK_MAX_SCALE);
    expect(c.s).toBeCloseTo(1000 / 4096, 3);
    expect(c.x + 2000 * c.s).toBeCloseTo(500);
    expect(c.y + 250 * c.s).toBeCloseTo(72 + (800 - 72 - 64) / 2);
  });
  it('never goes below the minimum', () => {
    expect(fitRect({ x: 0, y: 0, w: 1e6, h: 1e6 }, vp, ins, 48, 1).s).toBe(MIN_SCALE);
  });
});

// A click outside the desks leaves only a desk in focus (ADR 0003): this is the zoom's half of that.
describe('zoomed in on a desk', () => {
  const desk = { x: 0, y: 0, w: 584, h: 236 }; // a new desk
  const focus = fitRect(desk, vp, ins, 48, DESK_MAX_SCALE);
  const centered = (s: number): { x: number; y: number; s: number } => zoomAtPoint(focus, { x: vp.w / 2, y: vp.h / 2 }, s / focus.s);

  it('the view focusing gives is not zoomed in on it, nor is a pan of it or a zoom out', () => {
    expect(zoomedInOn(desk, focus, vp, focus.s)).toBe(false);
    expect(zoomedInOn(desk, { ...focus, x: focus.x + 120 }, vp, focus.s)).toBe(false);
    expect(zoomedInOn(desk, centered(focus.s * 0.8), vp, focus.s)).toBe(false);
  });
  it('one wheel notch in from there is', () => {
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(FOCUS_ZOOM);
    expect(zoomedInOn(desk, centered(focus.s * wheelZoomFactor(-100, false)), vp, focus.s)).toBe(true);
    expect(zoomedInOn(desk, centered(focus.s * FOCUS_ZOOM), vp, focus.s)).toBe(true);
  });
  it('only with the desk under the middle of the screen', () => {
    const c = centered(focus.s * 1.5);
    expect(zoomedInOn(desk, { ...c, x: c.x + vp.w }, vp, focus.s)).toBe(false);
    expect(zoomedInOn(desk, { ...c, y: c.y - vp.h }, vp, focus.s)).toBe(false);
  });
});

describe('zoom at a point', () => {
  it('keeps the world point under the pointer', () => {
    const c = { x: 37, y: -12, s: 0.8 };
    const p = { x: 400, y: 300 };
    const w = { x: (p.x - c.x) / c.s, y: (p.y - c.y) / c.s };
    const z = zoomAtPoint(c, p, 1.5);
    expect((p.x - z.x) / z.s).toBeCloseTo(w.x);
    expect((p.y - z.y) / z.s).toBeCloseTo(w.y);
  });
  it('clamps the scale', () => {
    expect(zoomAtPoint({ x: 0, y: 0, s: 1 }, { x: 0, y: 0 }, 100).s).toBe(MAX_SCALE);
    expect(zoomAtPoint({ x: 0, y: 0, s: 1 }, { x: 0, y: 0 }, 0.001).s).toBe(MIN_SCALE);
  });
});

describe('level of detail (design 3.10)', () => {
  it('uses on-screen tile size', () => {
    expect(lodFor(1)).toBe('full');
    expect(lodFor(40 / 76)).toBe('full');
    expect(lodFor(39 / 76)).toBe('glyph');
    expect(lodFor(20 / 76)).toBe('glyph');
    expect(lodFor(19 / 76)).toBe('card');
  });
});

describe('culling', () => {
  const r = { x: 100, y: 100, w: 50, h: 50 };
  it('sees what is on screen', () => {
    expect(isVisible(r, { x: 0, y: 0, s: 1 }, vp)).toBe(true);
  });
  it('culls what is far off screen', () => {
    expect(isVisible(r, { x: -5000, y: 0, s: 1 }, vp)).toBe(false);
    expect(isVisible(r, { x: 5000, y: 0, s: 1 }, vp)).toBe(false);
  });
  it('respects the padding', () => {
    expect(isVisible(r, { x: -180, y: 0, s: 1 }, vp, 40)).toBe(true);
  });
});

describe('slow frame window', () => {
  it('counts alternating slow and fast frames, which never make a run', () => {
    const w = new SlowFrameWindow(12);
    let n = 0;
    for (let i = 0; i < 12; i += 1) n = w.note(i % 2 === 0);
    expect(n).toBe(6);
  });
  it('forgets a frame once it leaves the window', () => {
    const w = new SlowFrameWindow(4);
    w.note(true);
    expect(w.note(false)).toBe(1);
    w.note(false);
    w.note(false);
    expect(w.note(false)).toBe(0);
  });
  it('holds at a steady rate', () => {
    const w = new SlowFrameWindow(3);
    w.note(true);
    w.note(true);
    expect(w.note(true)).toBe(3);
    expect(w.note(true)).toBe(3);
  });
  it('starts over on reset', () => {
    const w = new SlowFrameWindow(3);
    w.note(true);
    w.reset();
    expect(w.note(false)).toBe(0);
  });
});
