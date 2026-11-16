// OKLab and OKLCH from and to sRGB hex, for the few colours the office works out rather than spells: an app tile's tint and
// its egg-shaped gradient (`tileFace.ts`). The maths is Björn Ottosson's, the same as CSS `oklch()`.

const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: readonly number[]): string => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

const lin = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const gam = (v: number): number => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

/** sRGB hex to OKLab [L, a, b]. */
export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = hexRgb(hex).map(lin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab [L, a, b] to linear sRGB, unclipped. */
function linearRgb([L, A, B]: readonly number[]): [number, number, number] {
  const l = (L! + 0.3963377774 * A! + 0.2158037573 * B!) ** 3;
  const m = (L! - 0.1055613458 * A! - 0.0638541728 * B!) ** 3;
  const s = (L! - 0.0894841775 * A! - 1.291485548 * B!) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** OKLab [L, a, b] to sRGB hex (each channel clipped to the gamut). */
export const fromOklab = (lab: readonly number[]): string => toHex(linearRgb(lab).map(gam));

/** Whether OKLab [L, a, b] is an sRGB colour as it is, with nothing to clip. */
export const inGamut = (lab: readonly number[]): boolean => linearRgb(lab).every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** sRGB hex to OKLCH [L, C, h in radians]. */
export function oklch(hex: string): [number, number, number] {
  const [L, a, b] = oklab(hex);
  return [L, Math.hypot(a, b), Math.atan2(b, a)];
}

/** OKLCH (h in radians) to sRGB hex. */
export const fromOklch = (L: number, C: number, h: number): string => fromOklab([L, C * Math.cos(h), C * Math.sin(h)]);

/** WCAG relative luminance of an sRGB hex. */
export function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex).map(lin) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two sRGB hex colours. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
