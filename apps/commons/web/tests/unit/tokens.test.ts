// Contrast for Commons' own colors, on the Desk app's surfaces (web/src/theme/tokens.ts):
// 4.5:1 for text, 3:1 for strokes and other graphics (WCAG 2.1, as the app's own tokens test).
import { describe, expect, it } from 'vitest';
import { THEMES } from '../../../../../web/src/theme/tokens.ts';
import { COMMONS_THEMES, THEME_IDS } from '../../src/theme/tokens.ts';
import { INKS } from '../../src/board/model.ts';

function lum(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const c = v.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe.each(THEME_IDS)('%s', (id) => {
  const cm = COMMONS_THEMES[id];
  const desk = THEMES[id];
  it('inks read on the board (3:1)', () => {
    for (const c of INKS) expect(contrast(cm.ink[c], desk.surface.window), c).toBeGreaterThanOrEqual(3);
  });
  it('note text reads on every note (4.5:1)', () => {
    for (const c of INKS) expect(contrast(cm.noteText, cm.note[c]), c).toBeGreaterThanOrEqual(4.5);
  });
  it('initials and cursor names read on every member color (4.5:1)', () => {
    for (const m of cm.member) expect(contrast(cm.memberFg, m), m).toBeGreaterThanOrEqual(4.5);
  });
  it('member colors stand out on the board (3:1)', () => {
    for (const m of cm.member) expect(contrast(m, desk.surface.window), m).toBeGreaterThanOrEqual(3);
  });
});
