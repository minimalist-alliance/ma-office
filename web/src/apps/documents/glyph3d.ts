// Documents' glyph with the MA mark's 3D finish: a calm stack of three sheets, the front one the accent blue with its corner
// folded and three lines of text. A chunk of its own so its tables stay out of the first load (as To-do's): `agent/roster.ts`
// loads it with the first Documents tile, and the tile draws once it lands. DRAFT for the Product Designer, in To-do's own
// ramps (the core set's `soft`, `accent`, `default` and the page tone, with their fallback hexes), so it needs no colour of its
// own; the Designer's `make_draw3d.py` replaces this file when the final icon is drawn. No stars, sparkles or odd metaphors.
import { paint, SMALL_CUT, type InkTokens, type Op, type Set3d } from '../../canvas/draw3d';
import { TODO_SET } from '../todo/glyph3d';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Ramp keys in To-do's set: 0 soft, 1 accent, 2 default, 3 page. */
export const DOCS_SET: Set3d = {
  ramps: TODO_SET.ramps,
  hex: TODO_SET.hex,
  paths: [
    // 0 the back sheet, 1 the middle one
    'M18.5 4.5H36.5A2.5 2.5 0 0 1 39 7V33.5H16V7A2.5 2.5 0 0 1 18.5 4.5Z',
    'M14.5 8.5H32.5A2.5 2.5 0 0 1 35 11V37.5H12V11A2.5 2.5 0 0 1 14.5 8.5Z',
    // 2 the front sheet, its top right corner cut for the fold
    'M10.5 12.5H25.5L33 20V40.5A2.5 2.5 0 0 1 30.5 43H10.5A2.5 2.5 0 0 1 8 40.5V15A2.5 2.5 0 0 1 10.5 12.5Z',
    // 3 the fold
    'M25.5 12.5V18A2 2 0 0 0 27.5 20H33Z',
    // 4 three lines of text, round-ended
    'M12.75 25.25H27.25A1.5 1.5 0 0 1 27.25 28.25H12.75A1.5 1.5 0 0 1 12.75 25.25ZM12.75 30.75H27.25A1.5 1.5 0 0 1 27.25 33.75H12.75A1.5 1.5 0 0 1 12.75 30.75ZM12.75 36.25H22.25A1.5 1.5 0 0 1 22.25 39.25H12.75A1.5 1.5 0 0 1 12.75 36.25Z',
    // 5 the 24 px cut's two lines, thicker
    'M13 25H27A2.25 2.25 0 0 1 27 29.5H13A2.25 2.25 0 0 1 13 25ZM13 32.5H23A2.25 2.25 0 0 1 23 37H13A2.25 2.25 0 0 1 13 32.5Z',
  ],
};

const body = (lines: number, lit: boolean): Op[] => [
  [0, 0, 0, 27.5, 4.5, 27.5, 33.5],
  [0, 1, 2, 23.5, 8.5, 23.5, 37.5],
  ...(lit ? [[3, [0.4, 0.4, 0.4], 12, 8.5, 35, 37.5] as Op] : []),
  [0, 2, 1, 14, 12.5, 30, 43],
  ...(lit ? [[3, [0.45, 0.45, 0.45], 14, 12.5, 30, 43] as Op] : []),
  [0, 3, 3, 25.5, 12.5, 33, 20],
  [0, lines, 3, 12, 25, 12, 39],
];

/** [the 48 master, the 24 px cut] */
export const DOCS_OPS: [Op[], Op[]] = [body(4, true), body(5, false)];

/** Documents at `size` px at the origin, theme index `th` (THEME_IDS order). */
export function drawDocs3d(ctx: Ctx, t: InkTokens, th: number, size: number): void {
  const k = size / 48;
  ctx.save();
  ctx.scale(k, k);
  paint(ctx, DOCS_SET, DOCS_OPS[size <= SMALL_CUT ? 1 : 0], t, th);
  ctx.restore();
}
