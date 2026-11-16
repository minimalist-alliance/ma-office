// The theme sliders' colour math (the Product Designer's pick sheet, Nov 14; the owner picked blue range A, "grey to today",
// and the contrast range as the sheet shows it: ~/ma-coord/design-drafts/theme-sliders/). Pure functions, no DOM.
//
// SHARED FILE: ma-desk `web/src/theme/tune/xf.ts` and ma-platform `web/forums/src/tune/xf.ts` are the same file, byte for
// byte; each repo's `xf.hash.test.ts` pins its SHA-256. Change both and both pins together.
//
//   tuneFlat(flat, { blue, contrast }) -> { out, fixes }
//     flat:  one theme's tokens, dotted keys: { 'surface.panel': '#FDFDFD', 'border.hairline': 'rgba(16, 24, 40, 0.06)', ... }
//     blue:  0..100, 100 (the default) is today's theme, 0 every cool grey at chroma 0. The accent blue never moves.
//     contrast: 0..100, 50 (the default) is today's; low pulls surfaces toward the window colour, fades the hairlines and
//            softens the text; high pushes them apart. Text keeps 4.5:1 (WCAG 2) on every surface in CHECK_SURFACES.
//     out:   the same keys, the slider-ruled colours rewritten, everything else as it came. Both at default: `flat` itself.
//
// In OKLCH, sRGB gamut-clamped by reducing chroma, alpha kept; one rounding to 8 bits at the end, which keeps the hue.

export interface Tune {
  blue: number;
  contrast: number;
}
export const DEFAULT_TUNE: Readonly<Tune> = Object.freeze({ blue: 100, contrast: 50 });
export type Flat = Record<string, string>;

/** An integer in 0..100, or the field's default for anything else (as Platform reads a stored value). */
export const clampTune = (t: Partial<Tune> | null | undefined): Tune => {
  const one = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : d);
  return { blue: one(t?.blue, DEFAULT_TUNE.blue), contrast: one(t?.contrast, DEFAULT_TUNE.contrast) };
};
export const isDefaultTune = (t: Tune): boolean => t.blue === DEFAULT_TUNE.blue && t.contrast === DEFAULT_TUNE.contrast;

// ---------------------------------------------------------------- colour parsing and formatting

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
  rgba: boolean;
}
interface Lch {
  L: number;
  C: number;
  h: number;
}

/** '#RGB', '#RRGGBB', '#RRGGBBAA', 'rgb()', 'rgba()', 'transparent' -> channels in 0..1, or null for anything else. */
export function parseColor(str: string): Rgba | null {
  const s = String(str).trim();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0, rgba: true };
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1]!.split('').map((c) => parseInt(c + c, 16) / 255) as [number, number, number];
    return { r, g, b, a: 1, rgba: false };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const n = m[1]!;
    return { r: parseInt(n.slice(0, 2), 16) / 255, g: parseInt(n.slice(2, 4), 16) / 255, b: parseInt(n.slice(4, 6), 16) / 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1, rgba: false };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return { r: +m[1]! / 255, g: +m[2]! / 255, b: +m[3]! / 255, a: m[4] === undefined ? 1 : +m[4], rgba: true };
  return null;
}

const ch8 = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
const hex2 = (v: number): string => ch8(v).toString(16).padStart(2, '0').toUpperCase();

/** Back to a string in the token's own form: '#RRGGBB' for a solid hex, 'rgba(r, g, b, a)' for an rgba one. */
function formatColor(c: Rgba): string {
  if (c.rgba) return `rgba(${ch8(c.r)}, ${ch8(c.g)}, ${ch8(c.b)}, ${Math.round(Math.min(1, Math.max(0, c.a)) * 1000) / 1000})`;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

// ---------------------------------------------------------------- OKLab / OKLCH (Björn Ottosson's matrices)

const toLin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGam = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.sign(v) * Math.abs(v) ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: { r: number; g: number; b: number }): Lch {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let h = (Math.atan2(Bb, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C: Math.hypot(A, Bb), h };
}

/** OKLCH to linear sRGB (a channel outside 0..1 means out of gamut). */
function oklchToLinear({ L, C, h }: Lch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = C * Math.cos(hr), B = C * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (lin: number[]): boolean => lin.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/** OKLCH to gamma-encoded sRGB in 0..1, gamut-clamped by reducing chroma (L and h kept). */
function oklchToRgb(lch: Lch): { r: number; g: number; b: number } {
  const L = Math.min(1, Math.max(0, lch.L));
  let lin = oklchToLinear({ ...lch, L });
  if (!inGamut(lin)) {
    let lo = 0, hi = lch.C;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ L, C: mid, h: lch.h }))) lo = mid;
      else hi = mid;
    }
    lin = oklchToLinear({ L, C: lo, h: lch.h });
  }
  const g = (v: number): number => Math.min(1, Math.max(0, toGam(Math.min(1, Math.max(0, v)))));
  return { r: g(lin[0]), g: g(lin[1]), b: g(lin[2]) };
}

// ---------------------------------------------------------------- hue-keeping rounding

const inBand = (h: number): boolean => h >= 230 && h <= 275;
const angDist = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
const labOf = ({ L, C, h }: Lch): [number, number, number] => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

/**
 * OKLCH to an 8-bit sRGB that keeps the hue. Plain rounding of a low-chroma colour can swing its hue far (rgba(1, 2, 2) reads
 * h 196, a green-cyan), so of the eight floor/ceil neighbours the nearest in OKLab whose hue stays within 12° of the target
 * (and inside 230..275 when the target is) wins; if none does, the grey of the same OKLab L. C <= 0.004 counts as grey.
 * Never a neighbour whose blue channel is below its red or green (#B8B7B7, a grey a hair warm): cool or exact grey only.
 */
function quantise(lch: Lch): { r: number; g: number; b: number } {
  const rgb = oklchToRgb(lch);
  const want = { ...rgbToOklch(rgb), h: lch.h };
  const wl = labOf(want);
  const opts = (v: number): number[] => [...new Set([Math.floor(v * 255), Math.ceil(v * 255)].map((x) => Math.min(255, Math.max(0, x))))];
  let best: { d: number; c: { r: number; g: number; b: number } } | null = null;
  for (const r of opts(rgb.r)) for (const g of opts(rgb.g)) for (const b of opts(rgb.b)) {
    if (b < r || b < g) continue;
    const c = { r: r / 255, g: g / 255, b: b / 255 };
    const o = rgbToOklch(c);
    if (!(o.C <= 0.004 || (angDist(o.h, want.h) <= 12 && (!inBand(want.h) || inBand(o.h))))) continue;
    const ol = labOf(o);
    const d = Math.hypot(ol[0] - wl[0], ol[1] - wl[1], ol[2] - wl[2]);
    if (!best || d < best.d) best = { d, c };
  }
  if (best) return best.c;
  const grey = Math.round(toGam(Math.min(1, Math.max(0, want.L)) ** 3) * 255) / 255;
  return { r: grey, g: grey, b: grey };
}

const rebuild = (c: Rgba, lch: Lch, a = c.a): string => formatColor({ ...quantise(lch), a, rgba: c.rgba });

// ---------------------------------------------------------------- the ranges

/** Piecewise linear through [[x, y], ...] (x ascending), held flat past the ends. */
function pw(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    if (x <= x1) {
      const [x0, y0] = points[i - 1]!;
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1]![1];
}

/** Range A: every NEUTRAL colour's chroma times s (0 at the left, today at the right and default); hue and L kept. */
const BLUE_M = [[0, 0], [1, 1]] as const;
/** The contrast slider, k = contrast / 100, default 0.5. */
const CONTRAST_G = [[0, 0.55], [0.5, 1], [1, 1.7]] as const; // surfaces' distance from surface.window, in L
const CONTRAST_ALPHA = [[0, 0.6], [0.5, 1], [1, 2.0]] as const; // rgba hairlines' alpha
const CONTRAST_T = [[0, 0.9], [0.5, 1], [1, 1.2]] as const; // text's distance from surface.window, in L

// ---------------------------------------------------------------- token classes

const NEUTRAL_EXACT = new Set(['text.primary', 'text.secondary', 'text.tertiary', 'text.disabled', 'glyph.default', 'glyph.soft', 'glyph.page', 'ring.activeDesk', 'ring.activeGlow', 'status.offline', 'status.warn']);
const NEUTRAL_GROUPS = new Set(['border', 'switcher', 'etch', 'mark']);
const SURFACE_LEFT_ALONE = new Set(['surface.backdrop', 'surface.backdropBlend', 'surface.backdropBand']);
const ACCENT_EXACT = new Set(['text.link', 'focus.ring', 'badge.bg', 'status.online', 'glyph.globe']);
const CONTRAST_TEXT = new Set(['text.primary', 'text.secondary', 'text.tertiary', 'text.disabled', 'text.link']);
export const CHECK_TEXT = ['text.primary', 'text.secondary', 'text.tertiary', 'text.link'] as const;
// The sheet's four, and the tile and the overlay (menus, popovers), which pass today in every theme too.
export const CHECK_SURFACES = ['surface.window', 'surface.panel', 'surface.fill', 'surface.sunken', 'surface.tile', 'surface.overlay'] as const;

/** 'neutral', 'accent' or null (untouched: status.error, text.danger, text.onAccent, badge.fg, avatar.*, seal.*, ring.halo, inks). */
export function classOf(key: string): 'neutral' | 'accent' | null {
  const group = key.split('.')[0]!;
  if (group === 'surface') return SURFACE_LEFT_ALONE.has(key) ? null : 'neutral';
  if (NEUTRAL_GROUPS.has(group) || NEUTRAL_EXACT.has(key)) return 'neutral';
  if (group === 'accent' || ACCENT_EXACT.has(key)) return 'accent';
  return null;
}

// ---------------------------------------------------------------- WCAG

const relLum = ({ r, g, b }: { r: number; g: number; b: number }): number => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);

/** WCAG 2 contrast of two solid colours, on their 8-bit values (as the browser draws them). */
export function contrastRatio(a: string, b: string): number {
  const q = (str: string): { r: number; g: number; b: number } => {
    const c = parseColor(str)!;
    return { r: ch8(c.r) / 255, g: ch8(c.g) / 255, b: ch8(c.b) / 255 };
  };
  const la = relLum(q(a)), lb = relLum(q(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const lchOf = (str: string): Lch => rgbToOklch(parseColor(str)!);

/** Moves each failing text token's L away from the surface it fails on, 0.001 at a time, until it holds 4.5:1 on them all. */
function fixContrast(flat: Flat): string[] {
  const fixed: string[] = [];
  const surfaces = CHECK_SURFACES.filter((s) => flat[s] && parseColor(flat[s]!));
  for (const t of CHECK_TEXT) {
    const before = flat[t];
    if (!before || !parseColor(before)) continue;
    const worst = (v: string): number => Math.min(...surfaces.map((s) => contrastRatio(v, flat[s]!)));
    if (worst(before) >= 4.5) continue;
    const failing = surfaces.reduce((a, s) => (contrastRatio(before, flat[s]!) < contrastRatio(before, flat[a]!) ? s : a));
    const c = parseColor(before)!;
    const lch = rgbToOklch(c);
    const dir = lch.L >= lchOf(flat[failing]!).L ? 1 : -1;
    let v = before;
    for (let i = 1; i <= 1000; i++) {
      v = rebuild(c, { ...lch, L: Math.min(1, Math.max(0, lch.L + dir * i * 0.001)) });
      if (worst(v) >= 4.5) break;
    }
    flat[t] = v;
    fixed.push(t);
  }
  return fixed;
}

// ---------------------------------------------------------------- one theme

/** One theme's tokens through both sliders (blue, then contrast, in one rounding), then the contrast floor. */
export function tuneFlat(flat: Flat, tune: Tune): { out: Flat; fixes: string[] } {
  const t = clampTune(tune);
  if (isDefaultTune(t)) return { out: flat, fixes: [] };
  const s = t.blue / 100;
  const k = t.contrast / 100;
  const window = flat['surface.window'] ? parseColor(flat['surface.window']) : null;
  const Lw = window ? rgbToOklch(window).L : 1;
  const out: Flat = { ...flat };
  for (const [key, v] of Object.entries(flat)) {
    const c = parseColor(v);
    if (!c) continue;
    const lch = rgbToOklch(c);
    let changed = false;
    let a = c.a;
    // Blue: only cool greys move. A real colour outside the brand's hues (C > 0.04, hue outside 230..275) is left as it is.
    if (s !== 1 && classOf(key) === 'neutral' && !(lch.C > 0.04 && !inBand(lch.h))) {
      lch.C *= pw(BLUE_M, s);
      changed = true;
    }
    if (k !== 0.5) {
      const group = key.split('.')[0];
      const toward = (f: number): void => {
        lch.L = Math.min(1, Math.max(0, Lw + (lch.L - Lw) * f));
        changed = true;
      };
      if (group === 'surface' && key !== 'surface.window' && !SURFACE_LEFT_ALONE.has(key)) toward(pw(CONTRAST_G, k));
      else if (key === 'border.hairline' || key === 'border.default') {
        if (c.rgba || c.a < 1) {
          a = Math.min(1, c.a * pw(CONTRAST_ALPHA, k));
          changed = true;
        } else toward(pw(CONTRAST_G, k));
      } else if (key === 'border.strong') toward(pw(CONTRAST_G, k));
      else if (CONTRAST_TEXT.has(key)) toward(pw(CONTRAST_T, k));
    }
    if (!changed) continue;
    const next = rebuild(c, lch, a);
    // The same 8-bit channels and alpha keep today's own spelling ('0.90' stays '0.90').
    const n = parseColor(next)!;
    const same = ch8(n.r) === ch8(c.r) && ch8(n.g) === ch8(c.g) && ch8(n.b) === ch8(c.b) && Math.abs(n.a - c.a) < 1e-6;
    if (!same) out[key] = next;
  }
  return { out, fixes: fixContrast(out) };
}

/** Only what differs from `base`: what a page lays over its stylesheet. */
export function changedOnly(base: Flat, out: Flat): Flat {
  const d: Flat = {};
  for (const [k, v] of Object.entries(out)) if (base[k] !== v) d[k] = v;
  return d;
}

/** The no-warm check: every NEUTRAL or ACCENT colour with C > 0.004 has its hue in 230..275. Returns the offenders. */
export function warmOffenders(flat: Flat): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    if (!classOf(k)) continue;
    const c = parseColor(v);
    if (!c) continue;
    const o = rgbToOklch(c);
    if (o.C > 0.004 && !inBand(o.h)) bad.push(`${k} ${v}`);
  }
  return bad;
}
