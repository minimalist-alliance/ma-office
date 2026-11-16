// The Bible's glyph with the 3D finish, for the desk-app host's chunk (`web/src/deskapps/host/glyph.tsx`): it replaces
// `DRAW.bible` there, and keeps the Bible's tables out of the first load. GENERATED with draw3d.ts (same ops and
// formulas; see its header). Its accent is the Bible's own ink, Lapis
// (`APP_INKS['app:com.minimalistalliance.bible'][theme].accent`), not the office blue: its ramps name `ink`.
import { APP_INKS, THEME_IDS, THEMES, type Tokens } from '../../theme/tokens';
import { paint, SMALL_CUT, type Op, type Set3d } from '../../canvas/draw3d';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const BIBLE: Set3d = {
  // ramps by key: per theme (light, dusk, dark), [token, offset, ΔL, offset, ΔL, ...]
  ramps: [
    [['default', 0, -0.137, 1, -0.257], ['default', 0, -0.06, 1, -0.156], ['default', 0, -0.06, 1, -0.156]],
    [['page', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.165], ['page', 0, 0.193, 0.55, 0, 0.74, -0.045, 1, -0.235], ['page', 0, 0.193, 0.55, 0, 0.74, -0.045, 1, -0.235]],
    [['default', 0, 0.193, 0.55, 0, 0.74, -0.045, 1, -0.235], ['default', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.165], ['default', 0, 0.026, 0.55, 0, 0.74, -0.026, 1, -0.165]],
    [['ink', 0, 0.173, 0.5, 0, 1, -0.142], ['ink', 0, 0.116, 0.5, 0, 1, -0.131], ['ink', 0, 0.173, 0.5, 0, 1, -0.142]],
  ],
  // the same stops precomputed from today's tokens, for a browser without `oklch(from ...)`
  hex: [
    [['#272D34', '#0B1117'], ['#CBCFD6', '#ADB1B7'], ['#B6BAC0', '#989CA2']],
    [['#F7F9FC', '#EEF0F3', '#E5E7EA', '#B8BABD'], ['#939BAB', '#5B6271', '#4F5564', '#1E2431'], ['#6F767F', '#3A4048', '#2F343C', '#05080E']],
    [['#818890', '#4A5158', '#3E454C', '#10161C'], ['#E8ECF3', '#DFE3EA', '#D7DAE1', '#AAAEB5'], ['#D1D5DB', '#C9CDD3', '#C1C5CB', '#95999F']],
    [['#5B87F1', '#2C51B6', '#0A2488'], ['#D7E4FE', '#9FBDFE', '#7794D2'], ['#C2D5FC', '#759BF2', '#4C6FC2']],
  ],
  // every shape once (a cut that shares its master's shape shares its path)
  paths: [
    'M11 6H37A3 3 0 0 1 40 9V39A3 3 0 0 1 37 42H11A3 3 0 0 1 8 39V9A3 3 0 0 1 11 6Z',
    'M11 8H37A1 1 0 0 1 38 9V39A1 1 0 0 1 37 40H11A1 1 0 0 1 10 39V9A1 1 0 0 1 11 8Z',
    'M36 8H38V40L36 38Z',
    'M10 38H36L38 40H10Z',
    'M10.5 6H33.5A2.5 2.5 0 0 1 36 8.5V35.5A2.5 2.5 0 0 1 33.5 38H10.5A2.5 2.5 0 0 1 8 35.5V8.5A2.5 2.5 0 0 1 10.5 6Z',
    'M19 9H25V13H29V19H25V31H19V19H15V13H19Z',
    'M20 10H24V14H28V18H24V30H20V18H16V14H20Z',
    'M10 6H38A2 2 0 0 1 40 8V40A2 2 0 0 1 38 42H10A2 2 0 0 1 8 40V8A2 2 0 0 1 10 6Z',
    'M10 8H38V40H10Z',
    'M10 6H34A2 2 0 0 1 36 8V36A2 2 0 0 1 34 38H10A2 2 0 0 1 8 36V8A2 2 0 0 1 10 6Z',
    'M18 8H26V12H30V20H26V32H18V20H14V12H18Z',
  ],
};

/** [the 48 master, the 24 px cut] */
const BIBLE_OPS: [Op[], Op[]] = [[[0, 0, 0, 11.61, 3.79, 36.39, 44.21], [0, 1, 1, 13.05, 6.13, 34.95, 41.87], [1, 2, ['#4F58686B', '#0B0E13B2', '#0B0E13B2'], 36, 24, 38.5, 24], [1, 3, ['#4F58686B', '#0B0E13B2', '#0B0E13B2'], 24, 38, 24, 40.5], [0, 4, 2, 11.05, 4.13, 32.95, 39.87], [3, [0.5, 0.85, 0.85], 11.05, 4.13, 32.95, 39.87], [0, 5, 1, 15.19, 8.88, 28.81, 31.12], [0, 6, 3, 15.91, 10.06, 28.09, 29.94]], [[0, 7, 0, 11.61, 3.79, 36.39, 44.21], [0, 8, 1, 13.05, 6.13, 34.95, 41.87], [0, 9, 2, 11.05, 4.13, 32.95, 39.87], [0, 10, 1, 14.47, 7.71, 29.53, 32.29], [0, 6, 3, 15.91, 10.06, 28.09, 29.94]]];

export function drawBible3d(ctx: Ctx, t: Tokens, size: number): void {
  const id = THEME_IDS.find((i) => THEMES[i] === t) ?? 'light';
  const k = size / 48;
  ctx.save();
  ctx.scale(k, k);
  paint(ctx, BIBLE, BIBLE_OPS[size <= SMALL_CUT ? 1 : 0], t, THEME_IDS.indexOf(id), APP_INKS['app:com.minimalistalliance.bible']![id].accent);
  ctx.restore();
}
