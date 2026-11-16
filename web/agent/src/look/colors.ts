// An agent's colour (the owner, Nov 15: "Agent's icons have assignable colors so they use the guy with the hat"). Every agent
// wears the Agent app's own 3D icon, the guy with the hat (`web/src/canvas/draw3d.ts`, `agent`), and its colour takes the
// icon's accent (the hat band) and tints its tile, as each app's accent tints its own (APP-TILES). The colours are the app accents the owner picked (palette C,
// `web/src/theme/tokens.ts` APP_ACCENTS) and the office blue, so an agent's colour is always one an app already wears: each
// is 3:1 or more on the tile in Light, Zen and Dark (`look.test.ts`). The lead keeps the Agent app's own accent, `indigo`.
//
// How to change it: the values live in `tokens.ts` (`AGENT_COLORS`); this file only names and orders them. The order is the
// order a new agent takes them in (desk-agent's `TeamStore.COLORS`; `LookIdsTest` keeps the two lists equal), and the order
// the picker shows them in. Ids are stored with the agent (`look.color`): never reuse or rename one.
import { AGENT_COLORS, THEMES, type ThemeId } from '../../../src/theme/tokens';
import { tileFill, type TileFill } from '../../../src/theme/tileFace';
import type { LookTheme } from './tones';

export interface AgentColor {
  id: string;
  label: string;
}

// One row: id, label. The first unused one, in this order, is a new agent's.
// Sage first, not blue: the office blue is the closest to the lead's indigo (the brand review, Nov 15).
const ROWS: readonly (readonly [id: string, label: string])[] = [
  ['sage', 'Sage'],
  ['amber', 'Amber'],
  ['rose', 'Rose'],
  ['blue', 'Blue'],
  ['harbor', 'Harbor'],
  ['clay', 'Coral'], // Courier's accent, coral since Nov 15 night (COURIER-ACCENT); the id stays, as stored
  ['indigo', 'Indigo'],
];

export const AGENT_COLOR_LIST: readonly AgentColor[] = ROWS.map(([id, label]) => ({ id, label }));

/** The lead's: the Agent app's own accent. */
export const LEAD_COLOR = 'indigo';

/** Whether `id` is one of the colours. */
export const isAgentColor = (id: string | null | undefined): id is string => !!id && AGENT_COLOR_LIST.some((c) => c.id === id);

/** A colour's value in a theme, or null for no colour (an agent its desk hasn't told of yet: grey, as asleep). */
export function agentColorHex(id: string | null | undefined, theme: LookTheme): string | null {
  return isAgentColor(id) ? (AGENT_COLORS[id]?.[theme as ThemeId] ?? null) : null;
}

/** The colour a new agent on this desk takes: the first unused, else the least used (this order breaks ties). */
export function nextAgentColor(used: readonly (string | null | undefined)[]): string {
  const count = new Map<string, number>();
  for (const id of used) if (isAgentColor(id)) count.set(id, (count.get(id) ?? 0) + 1);
  let best = AGENT_COLOR_LIST[0]!.id;
  let least = Infinity;
  for (const c of AGENT_COLOR_LIST) {
    const n = count.get(c.id) ?? 0;
    if (n < least) {
      best = c.id;
      least = n;
    }
  }
  return best;
}

/**
 * The tile behind an agent's icon, in this theme: the same face as every app's (APP-TILES, `web/src/theme/tileFace.ts`), tinted
 * by the agent's colour as a very subtle egg, with no rim of colour (the owner, Nov 15 night: the inner glow "really sucks").
 * No colour (a desk that hasn't said): the tile's own.
 */
export function agentTileTint(id: string | null | undefined, theme: LookTheme): TileFill {
  return tileFill(agentColorHex(id, theme), theme as ThemeId);
}

/** Each theme's tile, for the tests and the pickers. */
export const tileOf = (theme: LookTheme): string => THEMES[theme as ThemeId].surface.tile;
