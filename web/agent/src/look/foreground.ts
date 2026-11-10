// The ONE foreground color: every agent mark on every tone in every theme is drawn in this color, never anything else.
//
// How to change it: edit FOREGROUND_RGB. Then run `npm test`: look.test.ts fails if this color is under 4.5:1
// (WCAG 2 AA for text and meaningful graphics) on any tone in any theme, and you then lighten or darken the
// offending tone's lightness in tones.ts.
//
// Why a near-white: it is the Desk's own white ink, "truly white" in Dusk (text.primary, ADR 0050; ADR 0065 keeps
// it) and one step off Light's pure `surface.tile` white, so it matches the theme kit on every theme. One color
// everywhere is what makes a row of different agents read as one family (the owner's rule), and it lets the
// tone table below do all the work of telling agents apart. The cost is that every tone has to be a mid-dark
// color (relative luminance 0.17 or lower), which the tone table keeps by construction.
//
// The value is three numbers rather than a hex string because the Desk's `ma/no-color-literals` lint rule keeps hex
// literals in `web/src/theme/tokens.ts` alone. `toHex` turns them into the string the components use.

export const FOREGROUND_RGB: readonly [number, number, number] = [250, 250, 250];

/** `[r, g, b]` (0 to 255) as `#rrggbb`. */
export function toHex([r, g, b]: readonly [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** The standard foreground color of every mark, as `#rrggbb`. */
export const FOREGROUND: string = toHex(FOREGROUND_RGB);
