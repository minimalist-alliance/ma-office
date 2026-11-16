// To-do's glyph with the MA mark's 3D finish, a chunk of its own so its tables stay out of the first load (as the Bible's are
// in `deskapps/host/draw3d-bible.ts`): `agent/roster.ts` loads it with the first To-do tile, and the tile draws once it lands.
// DRAFT, for the Product Designer (flagged in `docs/sub-status/mm-todo-app.md`): the VISION's in-tray sketch
// (`design-drafts/todo-store/src/icons.mjs`) put into `draw3d.ts`'s ops by hand, in the family's own ramps (the core set's
// `soft`, `accent` and `default` rows, copied with their fallback hexes) and fold colours, with the sketch's blurred front fold
// made two flat bands that follow the dip. No 24 px cut of its own beyond a thicker check, and no contrast pass yet: the
// Designer's `make_draw3d.py` replaces this file when the final icon is drawn.
import { paint, SMALL_CUT, type InkTokens, type Op, type Set3d } from '../../canvas/draw3d';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const TODO_SET: Set3d = {
  // ramps by key: per theme (light, dusk, dark), [token, offset, ΔL, offset, ΔL, ...]: the core set's soft, accent and default
  // rows, and the page tone flat for the check.
  ramps: [
    [['soft', 0, 0.007, 0.55, 0, 0.74, -0.045, 1, -0.235], ['soft', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.085], ['soft', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.077]],
    [['accent', 0, 0.173, 0.5, 0, 1, -0.142], ['accent', 0, 0.116, 0.5, 0, 1, -0.131], ['accent', 0, 0.173, 0.5, 0, 1, -0.142]],
    [['default', 0, 0.193, 0.55, 0, 0.74, -0.045, 1, -0.235], ['default', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.165], ['default', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.165]],
    [['page', 0, 0, 1, 0], ['page', 0, 0, 1, 0], ['page', 0, 0, 1, 0]],
  ],
  // the same stops precomputed from today's tokens, for a browser without `oklch(from ...)`
  hex: [
    [['#8D959E', '#8B939C', '#7E858E', '#484F57'], ['#B6BDC9', '#AEB5C1', '#A6ADB9', '#949BA6'], ['#8D959F', '#858D97', '#7D858F', '#6E7680']],
    [['#70A4E1', '#3D6FA8', '#12467C'], ['#D7E9FF', '#A9C4E4', '#819BB9'], ['#C7DEFC', '#7FA7DD', '#557BAF']],
    [['#818890', '#4A5158', '#3E454C', '#10161C'], ['#E8ECF3', '#DFE3EA', '#D7DAE1', '#AAAEB5'], ['#D1D5DB', '#C9CDD3', '#C1C5CB', '#95999F']],
    [['#EEF0F3', '#EEF0F3'], ['#5B6271', '#5B6271'], ['#3A4048', '#3A4048']],
  ],
  paths: [
    // 0 the tray's back, 1 and 2 the card's folds on it, 3 the card
    'M9.5 20H38.5A2 2 0 0 1 40.5 22V27H7.5V22A2 2 0 0 1 9.5 20Z',
    'M9.5 22H13V27H9.5Z',
    'M35 22H38.5V27H35Z',
    'M15.5 6.5H32.5A2.5 2.5 0 0 1 35 9V33H13V9A2.5 2.5 0 0 1 15.5 6.5Z',
    // 4 the check (two round-capped strokes, 3.2 wide, as fills)
    'M17.469 17.531L21.469 21.531A1.6 1.6 0 0 0 23.731 19.269L19.731 15.269A1.6 1.6 0 0 0 17.469 17.531ZM23.804 21.454L30.804 13.454A1.6 1.6 0 0 0 28.396 11.346L21.396 19.346A1.6 1.6 0 0 0 23.804 21.454Z',
    // 5 and 6 the front's fold on the card: its own top edge raised 2.6 and 1.2, so the shade follows the dip
    'M13 22.4H15.6C18 22.4 18.4 26 21 26H27C29.6 26 30 22.4 32.4 22.4H35V33H13Z',
    'M13 23.8H15.6C18 23.8 18.4 27.4 21 27.4H27C29.6 27.4 30 23.8 32.4 23.8H35V33H13Z',
    // 7 the tray's front, dipped in the middle as a letter tray's is
    'M6.6 25H15.6C18 25 18.4 28.6 21 28.6H27C29.6 28.6 30 25 32.4 25H41.4A1.6 1.6 0 0 1 42.96 26.95L40.42 39.45A2.5 2.5 0 0 1 37.97 41.5H10.03A2.5 2.5 0 0 1 7.58 39.45L5.04 26.95A1.6 1.6 0 0 1 6.6 25Z',
    // 8 the 24 px cut's check, 4.2 wide
    'M17.115 17.885L21.115 21.885A2.1 2.1 0 0 0 24.085 18.915L20.085 14.915A2.1 2.1 0 0 0 17.115 17.885ZM24.18 21.783L31.18 13.783A2.1 2.1 0 0 0 28.02 11.017L21.02 19.017A2.1 2.1 0 0 0 24.18 21.783Z',
  ],
};

/** The card's folds on the soft back (graphite in Light, white in Zen and Dark), as the family's. */
const BACK_FOLD = ['#0B0E13B2', '#4F586838', '#4F58686B'];
/** The front's fold on the blue card: flat bands (a gradient run from y 40 holds its first stop over the card), a third and three fifths of the family's blue fold. */
const BAND_SOFT = ['#14293F2A', '#14293F15', '#14293F1D'];
const BAND_EDGE = ['#14293F5A', '#14293F2E', '#14293F3D'];

const body = (check: number, lit: boolean): Op[] => [
  [0, 0, 0, 17.94, 13.6, 30.06, 33.4],
  [1, 1, BACK_FOLD, 13, 0, 9.2, 0],
  [1, 2, BACK_FOLD, 35, 0, 38.8, 0],
  [0, 3, 1, 15.09, 5.22, 32.91, 34.28],
  ...(lit ? [[3, [0.45, 0.45, 0.45], 15.09, 5.22, 32.91, 34.28] as Op] : []),
  [0, check, 3, 19.38, 8.7, 28.82, 24.1],
  [1, 5, BAND_SOFT, 0, 40, 0, 41],
  [1, 6, BAND_EDGE, 0, 40, 0, 41],
  [0, 7, 2, 15.14, 18.79, 32.86, 47.71],
  ...(lit ? [[3, [0.5, 0.85, 0.85], 15.14, 18.79, 32.86, 47.71] as Op] : []),
];

/** [the 48 master, the 24 px cut] */
export const TODO_OPS: [Op[], Op[]] = [body(4, true), body(8, false)];

/** To-do at `size` px at the origin, theme index `th` (THEME_IDS order). */
export function drawTodo3d(ctx: Ctx, t: InkTokens, th: number, size: number): void {
  const k = size / 48;
  ctx.save();
  ctx.scale(k, k);
  paint(ctx, TODO_SET, TODO_OPS[size <= SMALL_CUT ? 1 : 0], t, th);
  ctx.restore();
}
