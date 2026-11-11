// Color helpers and the face rule, ported from source/lib/compose-core.mjs (same constants, same formula).
const hex2 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
export function mix(a, b, t) {
  const A = hex2(a), B = hex2(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}
export function lum(h) {
  const c = hex2(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
// one subtle tone step: lighter on dark colors, darker on light ones
export const step = (h) => (lum(h) < 0.18 ? mix(h, '#FFFFFF', 0.13) : mix(h, '#15171B', 0.12));
export const shade = (h) => mix(h, '#15171B', 0.18);

export const FEATURE_FLOOR = 3.0;
export const FEATURE_DARK = '#4A1A1A';
export const FEATURE_LIGHT = '#FAD0C4';
export const BROW_DARK = '#1E1A1A';
export const BROW_LIGHT = '#E6D3C6';
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function featureEnd(skin, [dark, light] = [FEATURE_DARK, FEATURE_LIGHT]) {
  return contrast(skin, dark) >= contrast(skin, light) ? dark : light;
}
export function toFloor(base, skin, ends, floor = FEATURE_FLOOR) {
  const end = featureEnd(skin, ends);
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const c = mix(base, end, Math.min(t, 1));
    if (contrast(c, skin) >= floor) return c;
  }
  return end;
}
