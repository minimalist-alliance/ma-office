// The canvas glyphs, drawn into a context that records what it was asked to do. The core apps and the Bible are the MA mark's
// 3D finish (variant B, the owner's pick, Nov 12; `draw3d.ts`, `deskapps/host/draw3d-bible.ts`): every fill is a ramp built on
// one token, and where a browser's canvas can't parse `oklch(from ...)` it takes the precomputed hexes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { accentTokens, APP_ACCENTS, APP_INKS, THEME_IDS, THEMES, type ThemeId, type Tokens } from '../theme/tokens';
import { NOTEBOOK_SCHEME } from '../../notebook/src/ui/palette';
import { drawEtchIcon, drawGlyph } from './glyphs';
import { drawGlyph3d, GLYPHS_3D, SMALL_CUT } from './draw3d';
import { drawBible3d } from '../deskapps/host/draw3d-bible';

// Node has no Path2D: a stand-in that keeps the path text.
class FakePath {
  constructor(readonly d: string) {}
}
beforeAll(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;
});

class Grad {
  readonly stops: [number, string][] = [];
  constructor(readonly kind: 'linear' | 'radial') {}
  addColorStop(at: number, c: string): void {
    this.stops.push([at, c]);
  }
}
interface Mark {
  op: string;
  style: unknown;
  args: unknown[];
}

/** A stand-in 2D context: every call is kept, with the fill (or stroke) in force when it was made. */
function recorder(): { ctx: CanvasRenderingContext2D; marks: Mark[] } {
  const marks: Mark[] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === 'createLinearGradient') return () => new Grad('linear');
      if (key === 'createRadialGradient') return () => new Grad('radial');
      return (...args: unknown[]) => marks.push({ op: key, style: key === 'stroke' ? target['strokeStyle'] : target['fillStyle'], args });
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, marks };
}

const CORE = ['browser', 'files', 'notebook', 'agent', 'courier', 'commons'] as const;
type Core = (typeof CORE)[number];
const themes = Object.entries(THEMES) as [ThemeId, Tokens][];
const fills = (marks: Mark[]): Mark[] => marks.filter((m) => m.op === 'fill');
/** The body fills: a ramp's stops are opaque colours (a fold's carry alpha, a lit edge is a stroke). */
const bodies = (marks: Mark[]): Grad[] => fills(marks).map((m) => m.style as Grad).filter((g) => g instanceof Grad && g.stops.every(([, c]) => !/^#[0-9A-F]{8}$/i.test(c)));
/** The token a LIVE stop is built on: `oklch(from <token> ...)`, or the token itself at the ramp's middle. */
const base = (c: string): string => /^oklch\(from (#[0-9A-F]{6}) /i.exec(c)?.[1] ?? c;
const bibleInk = (id: ThemeId): string => APP_INKS['app:com.minimalistalliance.bible']![id].accent;

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

/** The canvas a browser would hand `draw3d`'s probe: one that takes relative colour, one whose `fillStyle` keeps what it had, one whose gradient throws. */
function stubCanvas(mode: 'takes' | 'refuses' | 'throws'): void {
  class Ctx {
    private fill = '#000000';
    get fillStyle(): string {
      return this.fill;
    }
    set fillStyle(v: string) {
      if (v.startsWith('oklch(from') && mode === 'refuses') return;
      this.fill = v === '#000' ? '#000000' : v.startsWith('oklch(from') ? '#9a9a9a' : v;
    }
    createLinearGradient(): { addColorStop(at: number, c: string): void } {
      return {
        addColorStop(_at: number, c: string) {
          if (mode === 'throws' && c.startsWith('oklch(from')) throw new SyntaxError('The value provided could not be parsed as a color.');
        },
      };
    }
  }
  vi.stubGlobal('OffscreenCanvas', class {
    getContext(): Ctx {
      return new Ctx();
    }
  });
}
type Fresh = { D: typeof import('./draw3d'); B: typeof import('../deskapps/host/draw3d-bible'); T: typeof import('../theme/tokens') };
/** `draw3d` fresh, so its probe runs again, and the Bible's with it, on fresh tokens (the Bible finds its theme by identity). */
async function fresh(): Promise<Fresh> {
  vi.resetModules();
  return { D: await import('./draw3d'), B: await import('../deskapps/host/draw3d-bible'), T: await import('../theme/tokens') };
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LIVE: the canvas itself decides whether stops are `oklch(from ...)` or the precomputed hexes', () => {
  const stopsOf = (D: typeof import('./draw3d')): string[] => {
    const { ctx, marks } = recorder();
    D.drawGlyph3d(ctx, 'browser', THEMES.light, 0, 96);
    return bodies(marks).flatMap((g) => g.stops.map(([, c]) => c));
  };
  it('in Node, with no canvas to ask: every stop is a hex', async () => {
    const { D } = await fresh();
    expect(stopsOf(D).every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });
  it('a canvas that takes relative colour (Chromium): stops are the tokens moved in OKLCH lightness', async () => {
    stubCanvas('takes');
    const { D } = await fresh();
    const stops = stopsOf(D);
    expect(stops.some((c) => c.startsWith('oklch(from #4A5158 calc(l + 0.193) c h)'))).toBe(true);
    expect(stops.every((c) => /^oklch\(from #[0-9A-F]{6} calc\(l \+ -?[0-9.]+\) c h\)$/.test(c) || /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });
  it('a canvas whose fillStyle keeps what it had, though CSS might say yes: the hexes', async () => {
    stubCanvas('refuses');
    vi.stubGlobal('CSS', { supports: () => true });
    const { D } = await fresh();
    expect(stopsOf(D).every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });
  it('a canvas whose gradient throws on it: the hexes, and nothing throws', async () => {
    stubCanvas('throws');
    const { D } = await fresh();
    expect(stopsOf(D).every((c) => /^#[0-9A-F]{6}$/.test(c))).toBe(true);
  });
});

describe('the fallback hexes are today\'s tokens moved by the same ΔL (regenerate draw3d.ts after a token change)', () => {
  /** LIVE's stops and the fallback's for the same glyph, side by side: the same calls in the same order. */
  async function pairs(draw: (f: Fresh, ctx: CanvasRenderingContext2D) => void): Promise<[string, string][]> {
    const stops = async (): Promise<string[]> => {
      const f = await fresh();
      const { ctx, marks } = recorder();
      draw(f, ctx);
      return bodies(marks).flatMap((g) => g.stops.map(([, c]) => c));
    };
    stubCanvas('takes');
    const live = await stops();
    vi.unstubAllGlobals();
    const hex = await stops();
    expect(live).toHaveLength(hex.length);
    return live.map((c, i) => [c, hex[i]!]);
  }
  const check = (p: [string, string][]): void => {
    for (const [live, hex] of p) {
      const m = /^oklch\(from (#[0-9A-F]{6}) calc\(l \+ (-?[0-9.]+)\) c h\)$/i.exec(live);
      const want = m ? shift(m[1]!, Number(m[2])) : rgbOf(live);
      const got = rgbOf(hex);
      for (let k = 0; k < 3; k += 1) expect(Math.abs(got[k]! - want[k]!), `${live} -> ${hex}`).toBeLessThanOrEqual(1);
    }
  };
  for (const [i, id] of THEME_IDS.entries()) {
    for (const app of CORE) {
      for (const size of [96, 24]) {
        it(`${app}, ${id}, ${size} px`, async () => check(await pairs(({ D }, ctx) => D.drawGlyph3d(ctx, app, THEMES[id], i, size))));
      }
    }
    for (const size of [96, 24]) it(`the Bible, ${id}, ${size} px`, async () => check(await pairs(({ B, T }, ctx) => B.drawBible3d(ctx, T.THEMES[id], size))));
  }
});

describe('every core app, theme and size: ramps on its own tokens, the 24 px cut at 30 px and under', () => {
  /** The tokens each app's parts are built on (the Designer's README, "Roles and parts"). */
  const tokens = (app: Core, id: ThemeId, t: Tokens): string[] =>
    ({
      browser: [t.glyph.default, t.glyph.page, t.accent.default],
      files: [t.glyph.filesBody, t.glyph.filesSheet, t.glyph.filesFront],
      notebook: [t.glyph.notebookTab, t.glyph.soft, t.glyph.default, t.glyph.page],
      agent: [t.glyph.default, t.accent.default],
      // The raven is `glyph.default` in Light and the mid grey `soft` in Zen and Dark, so it reads as a raven; eye and flap page, the letter accent.
      courier: [id === 'light' ? t.glyph.default : t.glyph.soft, t.glyph.page, t.accent.default],
      commons: [t.glyph.soft, t.accent.default],
    })[app];
  for (const [i, [id, t]] of themes.entries()) {
    for (const app of CORE) {
      for (const size of [24, 30, 31, 48, 96]) {
        const cut = size <= SMALL_CUT;
        it(`${app}, ${id}, ${size} px: ${cut ? 'the cut, no lit lines' : 'the master, with its lit lines'}`, async () => {
          stubCanvas('takes');
          const { D } = await fresh();
          const { ctx, marks } = recorder();
          D.drawGlyph3d(ctx, app, t, i, size);
          expect(marks[1]).toMatchObject({ op: 'scale', args: [size / 48, size / 48] });
          const ops = GLYPHS_3D[app]![cut ? 1 : 0];
          expect(fills(marks)).toHaveLength(ops.filter((o) => o[0] !== 3).length);
          // Nothing flat: every fill is a gradient.
          expect(fills(marks).every((m) => m.style instanceof Grad)).toBe(true);
          expect(new Set(bodies(marks).flatMap((g) => g.stops.map(([, c]) => base(c))))).toEqual(new Set(tokens(app, id, t)));
          expect(marks.filter((m) => m.op === 'clip').length > 0).toBe(!cut);
        });
      }
    }
    it(`the six apps with an icon accent of their own draw it, the others keep the office blue (${id})`, () => {
      expect(Object.keys(APP_ACCENTS).sort()).toEqual(['agent', 'commons', 'courier', 'documents', 'notebook', 'todo']);
      for (const app of CORE) {
        const own = APP_ACCENTS[app]?.[id];
        const a = recorder();
        drawGlyph(a.ctx, app, t, 40);
        const cols = new Set(bodies(a.marks).flatMap((g) => g.stops.map(([, c]) => base(c))));
        if (own) { expect(cols.has(own)).toBe(true); expect(cols.has(t.accent.default)).toBe(false); }
      }
    });
    it(`drawGlyph hands every core app to draw3d at its theme's index (${id})`, () => {
      for (const app of CORE) {
        const a = recorder();
        const b = recorder();
        drawGlyph(a.ctx, app, t, 40);
        drawGlyph3d(b.ctx, app, accentTokens(app, t, id), i, 40);
        expect(JSON.stringify(a.marks)).toBe(JSON.stringify(b.marks));
        expect(a.marks.length).toBeGreaterThan(5);
      }
    });
  }
});

describe('Commons is round 3\'s three people, not task 48\'s board', () => {
  for (const [i, [id, t]] of themes.entries()) {
    for (const size of [96, 24]) {
      it(`two people either side in soft, the centre one in the accent, nothing on a board (${id}, ${size} px)`, async () => {
        stubCanvas('takes');
        const { D } = await fresh();
        const { ctx, marks } = recorder();
        D.drawGlyph3d(ctx, 'commons', t, i, size);
        const ramps = bodies(marks).map((g) => base(g.stops[1]![1]));
        expect(ramps.filter((c) => c === t.glyph.soft)).toHaveLength(4);
        expect(ramps.filter((c) => c === t.accent.default)).toHaveLength(2);
        expect(ramps).not.toContain(t.glyph.page);
      });
    }
  }
  it('the 24 px cut puts every head on whole pixels: the sides r 3 at (11, 21) and (37, 21), the centre r 6 at (24, 14)', () => {
    const { ctx, marks } = recorder();
    drawGlyph(ctx, 'commons', THEMES.light, 24);
    const d = fills(marks).map((m) => (m.args[0] as FakePath).d);
    expect(d).toContain('M8 21A3 3 0 1 0 14 21A3 3 0 1 0 8 21Z');
    expect(d).toContain('M34 21A3 3 0 1 0 40 21A3 3 0 1 0 34 21Z');
    expect(d).toContain('M18 14A6 6 0 1 0 30 14A6 6 0 1 0 18 14Z');
  });
});

describe('Courier is the raven (raven 4, variation 1) on its letter', () => {
  for (const [i, [id, t]] of themes.entries()) {
    it(`the raven in its grey, eye and flap page, the letter the accent, no speech bubble (${id})`, async () => {
      stubCanvas('takes');
      const { D } = await fresh();
      const { ctx, marks } = recorder();
      D.drawGlyph3d(ctx, 'courier', t, i, 96);
      const ramps = bodies(marks).map((g) => base(g.stops[1]![1]));
      expect(ramps.filter((c) => c === (id === 'light' ? t.glyph.default : t.glyph.soft)).length).toBeGreaterThanOrEqual(3); // legs, raven, wing
      expect(ramps.filter((c) => c === t.glyph.page)).toHaveLength(2); // eye, flap
      expect(ramps.filter((c) => c === t.accent.default)).toHaveLength(1); // the letter
      expect(marks.some((m) => m.op === 'ellipse')).toBe(false);
      expect(ramps).not.toContain(t.surface.tile);
    });
  }
});

describe('the Bible takes its own Lapis ink, never the office blue', () => {
  for (const [id, t] of themes) {
    for (const size of [96, 24]) {
      it(`its cross is APP_INKS' Bible accent, its board default, its pages page (${id}, ${size} px)`, async () => {
        stubCanvas('takes');
        const { B, T } = await fresh();
        const { ctx, marks } = recorder();
        B.drawBible3d(ctx, T.THEMES[id], size);
        const ramps = bodies(marks).map((g) => base(g.stops[1]![1]));
        expect(new Set(ramps)).toEqual(new Set([t.glyph.default, t.glyph.page, bibleInk(id)]));
        expect(ramps.at(-1)).toBe(bibleInk(id)); // the cross, painted last
        expect(ramps).not.toContain(t.accent.default);
        expect(marks.filter((m) => m.op === 'clip').length > 0).toBe(size > SMALL_CUT);
      });
    }
  }
  it('is Lapis in every theme', () => {
    expect(THEME_IDS.map(bibleInk)).toEqual(['#2C51B6', '#9FBDFE', '#759BF2']);
  });
  it('the host\'s fallback draws the cross in Lapis too', () => {
    const { ctx, marks } = recorder();
    drawBible3d(ctx, THEMES.light, 96);
    const cross = bodies(marks).at(-1)!.stops.map(([, c]) => c);
    expect(cross).toEqual(['#5B87F1', '#2C51B6', '#0A2488']);
  });
});

describe('the Notebook glyph\'s tabs', () => {
  const theme = { light: 'light', dusk: 'dusk', dark: 'dark' } as const;
  for (const [i, [name, t]] of themes.entries()) {
    it(`take Notebook's own ink accent, never a fixed color (${name})`, async () => {
      const accent = NOTEBOOK_SCHEME[theme[name]].accent;
      expect(t.glyph.notebookTab).toBe(accent);
      stubCanvas('takes');
      const { D } = await fresh();
      const { ctx, marks } = recorder();
      D.drawGlyph3d(ctx, 'notebook', t, i, 48);
      expect(base(bodies(marks)[0]!.stops[1]![1])).toBe(accent);
    });
  }
  it('is the Navy ink', () => {
    expect([THEMES.light, THEMES.dusk, THEMES.dark].map((t) => t.glyph.notebookTab)).toEqual(['#536992', '#B6C8E9', '#94A5C5']);
  });
});

describe('the carousel switch\'s glyph', () => {
  it('is a landscape card between two thin, short slivers with a clear gap to each, spanning 4.5 to 14.5', () => {
    const { ctx, marks } = recorder();
    drawEtchIcon(ctx, 'carousel', '#000');
    const [mid, left, right] = marks.filter((m) => m.op === 'roundRect').map((m) => ({ x: m.args[0] as number, y: m.args[1] as number, w: m.args[2] as number, h: m.args[3] as number }));
    expect(mid!.w).toBeGreaterThan(mid!.h * 1.05); // wider than tall: a card, never a bar
    for (const side of [left!, right!]) {
      expect(side.w).toBeLessThanOrEqual(1.5); // thin
      expect(side.h).toBeLessThan(mid!.h); // and short
    }
    expect(mid!.x - (left!.x + left!.w)).toBeGreaterThanOrEqual(1);
    expect(right!.x - (mid!.x + mid!.w)).toBeGreaterThanOrEqual(1);
    expect(left!.x).toBe(4.5);
    expect(right!.x + right!.w).toBeCloseTo(14.5, 5);
  });
});
