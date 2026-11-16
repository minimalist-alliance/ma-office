// The tones: the tile color behind an agent's mark. 7 of them, one row each, all in the brand's cool band (the owner's
// rule: no green, brown or warm tints anywhere in the UI), the neutral `graphite` (the default) first. Each row gives its color
// for the three themes. The Product Designer's set (Nov 14, `~/ma-coord/design-drafts/agent-tones/tones.py`): within HSL
// hue 195 to 290, with the mark's 4.5:1 and a delta E of 9 or more, seven is the most that fit, at two depths.
//
// How to change it:
//  - A color is `lch(lightness, chroma, hue)` below (CIE L*C*h, D65). Edit the numbers, not hex strings (the Desk's lint rule
//    keeps hex literals in `web/src/theme/tokens.ts`, and `lch()` here is a function that returns a hex string at load time).
//    LCh keeps the strength of colour even across hues, which HSL does not (HSL saturation 30 ran from chroma 16 to 48).
//  - Keep every color dark enough for FOREGROUND (foreground.ts) to read at 4.5:1: lightness 43 to 46.5 (graphite in Zen) at this chroma,
//    and the deep row at 31.5 to 35. `npm test` checks that, that no two tones in a theme are closer than a color difference
//    (delta E 2000) of 9, and that every one is cool (look.test.ts).
//  - Why the lightness differs by theme: Light tiles sit on white tiles, so the tones can be the deepest (43). Dusk's ground
//    is a mid gray (#585E68, its tile #50565F), so its tones run lighter (46.5; graphite 46.5, down from 47.5, because the mark is #F1F3F7 since ADR 0093 and needs 4.5:1; it still does not
//    vanish into the tile) to stand off it. Dark's ground is near black, and 45.5 stands off it. Hue and chroma stay the same
//    in all three, so an agent keeps its color identity.
//  - To add a tone, add a row; to retire one, delete it and map its id to the nearest kept one in RETIRED_TONES (and
//    desk-agent's `TeamStore.RETIRED_TONES`, which moves stored rows once; `LookIdsTest` checks the lists agree).
//  - Chroma 7 to 26 is the calm part: this is MA's muted palette, not a rainbow.
//  - The ring order of ToneWheel is the order of this table.
import { toHex } from './foreground';

export type LookTheme = 'light' | 'dusk' | 'dark';

/** A tile background per theme. Colors are `#rrggbb`. */
export interface Tone {
  id: string;
  label: string;
  light: string;
  dusk: string;
  dark: string;
}

/** CIE LCh (D65: lightness 0 to 100, chroma, hue in degrees) to `#rrggbb`, clipped into sRGB. */
export function lch(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  const fy = (l + 16) / 116;
  const fx = fy + (c * Math.cos(rad)) / 500;
  const fz = fy - (c * Math.sin(rad)) / 200;
  const inv = (t: number): number => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = 0.95047 * inv(fx);
  const y = l > 8 ? fy ** 3 : l / (24389 / 27);
  const z = 1.08883 * inv(fz);
  const encode = (v: number): number => {
    const u = Math.max(0, Math.min(1, v));
    return (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055) * 255;
  };
  return toHex([encode(3.2406 * x - 1.5372 * y - 0.4986 * z), encode(-0.9689 * x + 1.8758 * y + 0.0415 * z), encode(0.0557 * x - 0.204 * y + 1.057 * z)]);
}

// One row: id, label, hue, chroma, then lightness for [Light, Dusk, Dark].
type Row = readonly [id: string, label: string, hue: number, chroma: number, lightness: readonly [number, number, number]];

const ROWS: readonly Row[] = [
  ['graphite', 'Graphite', 262, 7, [43, 46.5, 45.5]],
  ['steel', 'Steel', 234, 20, [43, 46.5, 45.5]],
  ['blue', 'Blue', 266, 26, [43, 46.5, 45.5]],
  ['indigo', 'Indigo', 286, 20, [43, 46.5, 45.5]],
  ['harbor', 'Harbor', 238, 20, [31.5, 35, 34]],
  ['navy', 'Navy', 270, 20, [31.5, 35, 34]],
  ['iris', 'Iris', 298, 20, [31.5, 35, 34]],
];

export const TONES: readonly Tone[] = ROWS.map(([id, label, h, c, [light, dusk, dark]]) => ({
  id,
  label,
  light: lch(light, c, h),
  dusk: lch(dusk, c, h),
  dark: lch(dark, c, h),
}));

/**
 * Tones that were retired, and the kept one each now shows as (the nearest of the seven): a saved agent renders as the
 * replacement, and desk-agent moves its stored id once (`TeamSchema`). The warm and green ones went on Nov 14.
 */
export const RETIRED_TONES: Readonly<Record<string, string>> = {
  rose: 'iris',
  clay: 'navy',
  amber: 'steel',
  olive: 'harbor',
  green: 'harbor',
  teal: 'harbor',
  cyan: 'steel',
  violet: 'iris',
  plum: 'iris',
  moss: 'harbor',
  sky: 'blue',
};

/** The tone id to use for a stored one: a retired id becomes its replacement, anything else stays. */
export function currentTone(toneId: string): string {
  return RETIRED_TONES[toneId] ?? toneId;
}

/** The neutral one: what an agent has before anyone picks, and what an unknown id becomes. */
export const DEFAULT_TONE = 'graphite';

/** The tile color of a tone in a theme. An unknown id gives the default tone's color. */
export function toneColor(toneId: string, theme: LookTheme): string {
  const tone = TONES.find((t) => t.id === currentTone(toneId)) ?? TONES.find((t) => t.id === DEFAULT_TONE) ?? TONES[0]!;
  return tone[theme];
}
