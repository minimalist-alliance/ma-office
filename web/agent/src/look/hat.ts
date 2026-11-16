// The hat: the Agent app's own 3D icon (`web/src/canvas/draw3d.ts`, `agent`, the owner's final set of Nov 12), which every
// agent wears in its colour (the owner, Nov 15). One drawing for the office's tiles (`web/src/canvas/glyphs.ts`) and the
// Agent app's own marks (`HatMark.tsx`): the icon as drawn, with only its accent (the hat band) swapped for the agent's colour,
// the way each app wears its own accent. No colour (a desk that hasn't said who's there yet, or asleep): the band is the
// glyph's soft grey, so the icon reads grey, as the tiles always have until the desk says.
import { drawGlyph3d } from '../../../src/canvas/draw3d';
import { inkTokens, THEMES, type ThemeId, type Tokens } from '../../../src/theme/tokens';
import { agentColorHex, LEAD_COLOR } from './colors';
import type { LookTheme } from './tones';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const THEME_INDEX: Readonly<Record<LookTheme, number>> = { light: 0, dusk: 1, dark: 2 };

/** The tokens the hat is drawn with: the theme's own, its accent the agent's colour (or the soft grey for none). */
export function hatTokens(color: string | null | undefined, theme: LookTheme, base?: Tokens): Tokens {
  const t = base ?? THEMES[theme as ThemeId];
  const hex = agentColorHex(color, theme) ?? t.glyph.soft;
  return inkTokens(`agent-color:${color ?? 'none'}`, hex, t, theme as ThemeId);
}

/** The hat at `size` px at the context's origin (the 48 box scaled; its 24 px cut at 30 px and under). */
export function drawHat(ctx: Ctx, color: string | null | undefined, theme: LookTheme, size: number, base?: Tokens): void {
  drawGlyph3d(ctx, 'agent', hatTokens(color, theme, base), THEME_INDEX[theme], size);
}

/** The lead's colour, or the agent's own: the lead keeps the Agent app's accent whatever is stored. */
export const colorFor = (a: { lead?: boolean; role?: string; look?: { color?: string } | null }): string | null => (a.lead === true || a.role === 'manager' ? LEAD_COLOR : (a.look?.color ?? null));
