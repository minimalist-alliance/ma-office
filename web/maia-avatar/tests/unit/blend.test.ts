// DANCE: the 60 fps blend, around the dance's wink and its pirouette. avatar.ts draws each display frame between the last
// two engine steps (between()). The dance adds two things it must get right (the draft's notes.md):
// - her wink is an eye number like the others, so a frame between two steps shows it between them, not snapped to one;
// - a turn mirrors her as it passes edge on, so the transform is never blended across that mirror, which would pass
//   through no width at all. It holds the nearer step's for that one frame, as the dance preview does.
// Frames are "rendered" here by recording the paths buildPaths() makes, the same paths the canvas fills.
import { beforeAll, describe, expect, test } from 'vitest';
import { Pose, between, handedness } from '../../src/avatar.js';
import { Avatar, DT, VOCAB, compileScore } from '../../src/engine.js';

/** Path2D that keeps its points and arcs, for geometry. */
class Rec {
  pts: number[] = [];
  arcs: [number, number, number][] = [];
  moveTo(x: number, y: number) { this.pts.push(x, y); }
  lineTo(x: number, y: number) { this.pts.push(x, y); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) { this.pts.push(a, b, c, d, x, y); }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { this.pts.push(a, b, x, y); }
  arc(x: number, y: number, r: number) { this.arcs.push([x, y, r]); this.pts.push(x - r, y - r, x + r, y + r); }
  ellipse(x: number, y: number, rx: number, ry: number) { this.pts.push(x - rx, y - ry, x + rx, y + ry); }
  closePath() { /* nothing to keep */ }
  rect(x: number, y: number, w: number, h: number) { this.pts.push(x, y, x + w, y + h); }
}
beforeAll(() => { (globalThis as unknown as { Path2D: unknown }).Path2D = Rec; });

type Av = Avatar & Record<string, unknown>;
const WINK_SIDE = VOCAB.dance.winkSide;

/** Party at 200 px, one Pose per engine step from the start of the dance to the settle. */
function dance(theme: 'light' | 'dusk' | 'dark' = 'dusk', size = 200): { av: Av; poses: Pose[]; rest: Pose } {
  const av = new Avatar(null, { size, dpr: 1, theme, seed: 11 }) as Av;
  av.snap();
  const rest = new Pose();
  rest.take(av);
  av.playCompiled(compileScore({ mood: 'warm', rhythm: 'breath', seconds: 24, beats: [], notes: [], routine: 'party' }));
  const poses: Pose[] = [];
  for (let i = 0; i < Math.round(25 / DT); i += 1) {
    av.step();
    const p = new Pose();
    p.take(av);
    poses.push(p);
  }
  return { av, poses, rest };
}

/** Builds her paths for what the avatar holds now, as draw() does before painting. */
function build(av: Av): void {
  av['hd'] = new Float64Array((av['hd'] as Float64Array).length).fill(9); // as after a jump: rebuild everything
  (av['ED'] as Float64Array)[0] = -9;
  av.buildPaths();
}

/** The winking eye's iris radius as drawn, or 0 when it's shut past showing one. */
function winkIris(av: Av): number {
  build(av);
  const arcs = (av['irises'] as Rec).arcs;
  // buildWinkEyes draws side 0 then side 1, and skips the iris of an eye shut past 0.03.
  return arcs.length === 2 ? arcs[WINK_SIDE]![2] : 0;
}

/** Her drawn width in canvas units: the body path through the transform, as paint() sets it. */
function width(av: Av): number {
  build(av);
  const p = (av['bodyPath'] as Rec).pts, M = av.m;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < p.length; i += 2) { const x = M[0]! * p[i]! + M[2]! * p[i + 1]! + M[4]!; if (x < lo) lo = x; if (x > hi) hi = x; }
  return hi - lo;
}

describe('the blend carries the wink', () => {
  const { av, poses } = dance();
  const pairs = poses.slice(1).map((b, i) => [poses[i]!, b] as const).filter(([a, b]) => a.wk !== b.wk);

  test('the dance winks: her wink changes over several steps', () => {
    expect(pairs.length).toBeGreaterThan(10);
    expect(Math.max(...poses.map((p) => p.wk))).toBeGreaterThan(0.9);
  });

  test('every frame between two steps of the wink has the wink between them, and is drawn with it', () => {
    for (const [a, b] of pairs) {
      for (const k of [0.25, 0.5, 0.75]) {
        between(av, a, b, k);
        expect(av.wk).toBeCloseTo(a.wk + (b.wk - a.wk) * k, 12);
        build(av);
        // The paths were made from this frame's wink, not from either step's.
        expect(av['wkD']).toBe(av.wk);
      }
    }
  });

  test('the winking eye, as drawn, lies between the two steps on every frame between them', () => {
    // The iris shrinks as the eye closes, until the eye is shut past 0.03. Above 40% open it's full size.
    const p0 = new Pose();
    p0.copy(poses[0]!); p0.wk = 0.001; p0.give(av);
    const FULL = winkIris(av);
    let strict = 0;
    for (const [a, b] of pairs) {
      if (a.wk === 0 || b.wk === 0) continue; // the plain eyes draw both sides another way; the wink's own steps are enough
      a.give(av); const ra = winkIris(av);
      b.give(av); const rb = winkIris(av);
      between(av, a, b, 0.5);
      const r = winkIris(av);
      expect(r).toBeGreaterThanOrEqual(Math.min(ra, rb) - 1e-9);
      expect(r).toBeLessThanOrEqual(Math.max(ra, rb) + 1e-9);
      const full = Math.max(ra, rb, r) >= FULL - 1e-9;
      if (ra === 0 || rb === 0 || full || Math.abs(ra - rb) < 1e-6) continue;
      expect(r).toBeGreaterThan(Math.min(ra, rb));
      expect(r).toBeLessThan(Math.max(ra, rb));
      // Without the wink in the blend, the frame shows the later step's wink: nearer that step, a snap every other frame.
      av.wk = b.wk;
      expect(Math.abs(winkIris(av) - rb)).toBeLessThan(Math.abs(r - rb));
      strict += 1;
    }
    expect(strict).toBeGreaterThan(3);
  });

  test('the other eye never winks', () => {
    const [a, b] = pairs[Math.floor(pairs.length / 2)]!;
    between(av, a, b, 0.5);
    build(av);
    const arcs = (av['irises'] as Rec).arcs;
    const other = arcs[1 - WINK_SIDE]![2];
    av.wk = 0;
    build(av);
    expect((av['irises'] as Rec).arcs[1 - WINK_SIDE]![2]).toBeCloseTo(other, 9);
  });
});

describe('the blend never crosses the pirouette\'s mirror', () => {
  const { av, poses, rest } = dance();
  const flips = poses.slice(1).map((b, i) => [poses[i]!, b] as const).filter(([a, b]) => handedness(a.m) * handedness(b.m) < 0);
  const restDet = handedness(rest.m);

  test('the two-turn pirouette mirrors her four times', () => {
    expect(flips.length).toBe(4);
    expect(restDet).toBeGreaterThan(0);
  });

  test('across a mirror the transform holds the nearer step, exactly, while hair and eyes still blend', () => {
    for (const [a, b] of flips) {
      for (const k of [0.25, 0.49, 0.5, 0.75]) {
        between(av, a, b, k);
        expect(Array.from(av.m)).toEqual(Array.from(k < 0.5 ? a.m : b.m));
        expect(av.E[0]).toBeCloseTo(a.E[0]! + (b.E[0]! - a.E[0]!) * k, 12);
      }
    }
  });

  test('no frame between two steps is drawn thinner than the steps themselves; blending across the mirror would be', () => {
    rest.give(av);
    const w0 = width(av);
    let worst = Infinity, naive = Infinity, narrowest = Infinity, minDet = Infinity;
    for (let i = 1; i < poses.length; i += 1) {
      const a = poses[i - 1]!, b = poses[i]!;
      a.give(av); const wa = width(av);
      b.give(av); const wb = width(av);
      for (const k of [0.25, 0.5, 0.75]) {
        between(av, a, b, k);
        const w = width(av);
        minDet = Math.min(minDet, Math.abs(handedness(av.m)) / restDet);
        worst = Math.min(worst, w / Math.min(wa, wb));
        narrowest = Math.min(narrowest, w / w0);
        if (handedness(a.m) * handedness(b.m) < 0) {
          // What a plain blend of the transform would draw on this frame.
          for (let j = 0; j < 6; j += 1) av.m[j] = a.m[j]! + (b.m[j]! - a.m[j]!) * k;
          naive = Math.min(naive, width(av) / Math.min(wa, wb));
        }
      }
    }
    // Her depth keeps her transform at least 45% wide edge on (yawDepth), on every frame drawn.
    expect(minDet).toBeGreaterThan(VOCAB.dance.yawDepth - 0.03);
    expect(worst).toBeGreaterThan(0.85);
    expect(naive).toBeLessThan(0.5);
    console.log(`frames between steps: at worst ${(worst * 100).toFixed(1)}% of the narrower step's width (a plain blend across the mirror: ${(naive * 100).toFixed(1)}%); narrowest frame ${(narrowest * 100).toFixed(1)}% of her rest width, transform at least ${(minDet * 100).toFixed(1)}% wide`);
  });
});
