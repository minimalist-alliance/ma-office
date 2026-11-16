// To-do's draft glyph (`glyph3d.ts`): every fill a ramp on the family's own tokens, the fallback hexes the tokens moved by the
// same ΔL (as glyphs.test.ts checks the core set's), the 24 px cut without lit lines, and drawn through `drawGlyph` once its
// chunk is here.
import { beforeAll, describe, expect, it } from 'vitest';
import { THEME_IDS, THEMES } from '../../theme/tokens';
import { TODO_OPS, TODO_SET, drawTodo3d } from './glyph3d';

class FakePath {
  constructor(readonly d: string) {}
}
beforeAll(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;
});

// ---- OKLCH, as the Designer's build/oklch.py has it (Ottosson's matrices; out of gamut, chroma reduced until it fits).
const lin = (c: number): number => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const gam = (c: number): number => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function shift(hex: string, dL: number): number[] {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16))) as [number, number, number];
  const [l, m, s] = [0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b].map(Math.cbrt) as [number, number, number];
  const L = Math.max(0, Math.min(1, 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s + dL));
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let C = Math.hypot(A, B);
  const H = Math.atan2(B, A);
  let rgb: number[] = [];
  for (let k = 0; k < 40; k += 1) {
    const [a2, b2] = [C * Math.cos(H), C * Math.sin(H)];
    const [l2, m2, s2] = [L + 0.3963377774 * a2 + 0.2158037573 * b2, L - 0.1055613458 * a2 - 0.0638541728 * b2, L - 0.0894841775 * a2 - 1.291485548 * b2].map((v) => v ** 3) as [number, number, number];
    rgb = [4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2, -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2, -0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2];
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) break;
    C *= 0.9;
  }
  return rgb.map((v) => Math.round(gam(Math.max(0, Math.min(1, v)))));
}
const rgbOf = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A context that keeps each fill's and stroke's style, and each gradient's stops. */
function recorder(): { ctx: CanvasRenderingContext2D; fills: string[][]; strokes: number } {
  const fills: string[][] = [];
  let strokes = 0;
  let style: unknown = null;
  const grad = (): { stops: string[]; addColorStop(at: number, c: string): void } => {
    const g = { stops: [] as string[], addColorStop: (_at: number, c: string) => void g.stops.push(c) };
    return g;
  };
  const ctx = {
    save() {},
    restore() {},
    scale() {},
    clip() {},
    set fillStyle(v: unknown) {
      style = v;
    },
    set strokeStyle(_v: unknown) {},
    set lineWidth(_v: number) {},
    createLinearGradient: grad,
    createRadialGradient: grad,
    fill() {
      fills.push((style as { stops: string[] }).stops);
    },
    stroke() {
      strokes += 1;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills, get strokes() {
    return strokes;
  } } as { ctx: CanvasRenderingContext2D; fills: string[][]; strokes: number };
}

describe("To-do's glyph", () => {
  for (const [th, id] of THEME_IDS.entries()) {
    const t = THEMES[id];
    it(`${id}: the fallback hexes are its tokens moved by each stop's ΔL`, () => {
      TODO_SET.ramps.forEach((ramp, key) => {
        const [name, ...st] = ramp[th]!;
        const token = name === 'accent' ? t.accent.default : (t.glyph as Record<string, string>)[name]!;
        for (let i = 0; i < st.length; i += 2) {
          const want = shift(token, st[i + 1]!);
          const got = rgbOf(TODO_SET.hex[key]![th]![i / 2]!);
          for (let k = 0; k < 3; k += 1) expect(Math.abs(got[k]! - want[k]!), `${name} ${st[i + 1]}`).toBeLessThanOrEqual(1);
        }
      });
    });
    for (const size of [96, 48, 24]) {
      it(`${id}, ${size} px: back, card, check, two fold bands and the front; lit lines on the master only`, () => {
        const r = recorder();
        drawTodo3d(r.ctx, t, th, size);
        // back, two side folds, card, check, two bands, front
        expect(r.fills).toHaveLength(8);
        expect(r.strokes).toBe(size <= 30 ? 0 : 4);
      });
    }
  }

  it('the cut has the thicker check and no lit ops; both share every other shape', () => {
    const [master, cut] = TODO_OPS;
    expect(master.filter((o) => o[0] === 3)).toHaveLength(2);
    expect(cut.filter((o) => o[0] === 3)).toHaveLength(0);
    expect(cut.find((o) => o[0] === 0 && o[2] === 3)![1]).toBe(8);
    expect(master.find((o) => o[0] === 0 && o[2] === 3)![1]).toBe(4);
  });
});
