// App glyphs drawn straight onto a canvas context (crisp at every zoom, no image decoding), the one copy: the DOM's
// `AppGlyph` (`chrome/icons.tsx`) draws through here too. Each draws into a 48x48 box at the origin. Colors are theme tokens;
// the core apps' shapes and ramps are `draw3d.ts`.
import { docsGlyphChunk, lookChunk, parseLook, todoGlyphChunk, type GlyphId } from '../agent/roster';
import { accentTokens, AGENT_COLORS, APP_ACCENTS, APP_INKS, THEME_IDS, THEMES, type ThemeId, type Tokens } from '../theme/tokens';
import { CANVAS_FONT } from './font';
import { host } from '../deskapps/door';
import { drawGlyph3d } from './draw3d';
import { drawHat } from '../../agent/src/look/hat';
import { wearsHat } from '../../agent/src/look/icons';

/** The theme a token set is (a set made from one, such as an app's accent, is that theme's), Light if none. */
export const themeOf = (t: Tokens): ThemeId => THEME_IDS.find((id) => THEMES[id] === t || THEMES[id].surface.tile === t.surface.tile) ?? 'light';

/** The installed apps whose own ink tints their tile, by their glyph (`dapp:<glyph>`): the Bible's Lapis. */
const DAPP_INK: Record<string, string> = { bible: 'app:com.minimalistalliance.bible' };

/**
 * The accent an icon's tile is tinted by (APP-TILES, the owner, Nov 15: each tile takes its app's primary accent): an app's own
 * (`APP_ACCENTS`), Files' Silver and the Bible's Lapis (their inks), an agent's colour, else the office blue (the Browser, an
 * installed app with no ink of its own). Null for an agent its desk hasn't given a colour (grey, as asleep): the plain tile.
 */
export function tileAccent(app: GlyphId, t: Tokens): string | null {
  const theme = themeOf(t);
  const look = parseLook(app);
  if (look) return look.color ? (AGENT_COLORS[look.color]?.[theme] ?? null) : null;
  if (app.startsWith('dapp:')) {
    const ink = DAPP_INK[app.slice(5)];
    return (ink && APP_INKS[ink]?.[theme].accent) || THEMES[theme].accent.default;
  }
  const id = app.endsWith(':') ? app.slice(0, -1) : app; // To-do's and Documents' blanks, before their chunks are here
  return APP_ACCENTS[id]?.[theme] ?? APP_INKS[id]?.[theme].accent ?? THEMES[theme].accent.default;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** Draw app glyph `app` scaled to `size` px at the context's current origin. */
export function drawGlyph(ctx: Ctx, app: GlyphId, t: Tokens, size: number): void {
  if (app.startsWith('dapp:')) {
    // An installed app (ADR 0054): drawn by the desk app host's chunk once it's here; until then the tile is plain.
    host?.drawGlyph(ctx, app.slice(5), t, size);
    return;
  }
  const look = parseLook(app);
  if (look) {
    if (!look.icon) return;
    const theme = themeOf(t);
    // An agent's own app (task 49): the Agent app's own icon, the guy with the hat, in the agent's colour (the owner, Nov 15),
    // drawn like the core apps' (`draw3d.ts`); no colour yet is grey, as asleep.
    if (wearsHat(look.icon)) return void drawHat(ctx, look.color || null, theme, size, t);
    // A library icon or an upload the member picked instead: its mark, the square in its colour with the icon in the one
    // foreground color. That drawing is a chunk of its own (`lookChunk`): blank until it's here, and its glyph key changes then.
    const draw = lookChunk();
    if (!draw) return;
    draw.drawAgentMark(ctx as CanvasRenderingContext2D, { icon: look.icon, color: look.color || null, tone: look.tone, theme, mask: look.mask?.bitmap ?? null, x: 0, y: 0, size, radius: size * draw.RADIUS_SHARE });
    return;
  }
  const th = Math.max(0, THEME_IDS.findIndex((id) => THEMES[id] === t));
  // Six apps have an icon accent of their own (`APP_ACCENTS`); the rest keep the office blue.
  t = accentTokens(app, t, THEME_IDS[th]!);
  // To-do's, from its own chunk once it's here (`todo:` is the blank before).
  if (app === 'todo') return void todoGlyphChunk()?.drawTodo3d(ctx, t, th, size);
  // Documents', from its own chunk too (`documents:` is the blank before).
  if (app === 'documents') return void docsGlyphChunk()?.drawDocs3d(ctx, t, th, size);
  // A core app: the MA mark's 3D finish (variant B, the owner's pick, Nov 12), its 24 px cut at 30 px and under (`draw3d.ts`).
  drawGlyph3d(ctx, app, t, th, size);
}

/** Two little arrows: outward (make small) or inward (make icon). Centred on the origin. */
export function drawSizeToggle(ctx: Ctx, toSmall: boolean, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const arrow = (x1: number, y1: number, x2: number, y2: number): void => {
    line(ctx, x1, y1, x2, y2);
    const dx = Math.sign(x2 - x1) * 3.4;
    const dy = Math.sign(y2 - y1) * 3.4;
    ctx.beginPath();
    ctx.moveTo(x2 - dx, y2);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2, y2 - dy);
    ctx.stroke();
  };
  if (toSmall) {
    arrow(1, -1, 5, -5);
    arrow(-1, 1, -5, 5);
  } else {
    arrow(5, -5, 1, -1);
    arrow(-5, 5, -1, 1);
  }
  ctx.restore();
}

export type EtchIcon = 'grip' | 'sparkle' | 'carousel' | 'desk';

/**
 * The strip's icons, as solid shapes in a 16-unit box, since each is cut in a color at a time and a thin line
 * has nothing left once the cut takes its top. The grip is a corner, and the sparkle a four-pointed star. The
 * carousel's switch shows where it leads: one app large between the edges of its neighbours (to the carousel), or
 * four apps in a square (back to the desk).
 */
export function drawEtchIcon(ctx: Ctx, icon: EtchIcon, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (icon === 'grip') {
    ctx.moveTo(12.5, 5);
    ctx.lineTo(12.5, 14);
    ctx.lineTo(3.5, 14);
    ctx.closePath();
  } else if (icon === 'carousel') {
    // It runs 4.5 to 14.5 across, so the row's gaps, ink to ink, stay even between the sparkle and the grip, whose ink sits
    // right of its box's middle (`hidden.shell.spec.ts` measures them).
    // The middle card is clearly landscape and the slivers thin and short, with a clear gap to each, so at 16 px it reads
    // as "one app, more either side" and never as a pause's bars (the Product Designer's review).
    ctx.roundRect(6.7, 5.7, 5.6, 4.6, 1);
    ctx.roundRect(4.5, 6.6, 1.2, 2.8, 0.6);
    ctx.roundRect(13.3, 6.6, 1.2, 2.8, 0.6);
  } else if (icon === 'desk') {
    ctx.roundRect(4.5, 3, 4, 4, 1);
    ctx.roundRect(10.5, 3, 4, 4, 1);
    ctx.roundRect(4.5, 9, 4, 4, 1);
    ctx.roundRect(10.5, 9, 4, 4, 1);
  } else {
    const r = 7;
    const k = 1.1; // the waist
    ctx.moveTo(8, 8 - r);
    ctx.quadraticCurveTo(8 + k, 8 - k, 8 + r, 8);
    ctx.quadraticCurveTo(8 + k, 8 + k, 8, 8 + r);
    ctx.quadraticCurveTo(8 - k, 8 + k, 8 - r, 8);
    ctx.quadraticCurveTo(8 - k, 8 - k, 8, 8 - r);
    ctx.closePath();
  }
  ctx.fill();
}

/**
 * The hidden count's icon: an eye with a slash, solid for the same reason as above, in the same 16-unit box. The eye
 * is a thick outline with a round pupil, and the slash runs corner to corner with a clear gap cut either side of it,
 * so the two read apart. The gap is a clip, not an erase, so each pass of the cut draws the same shape.
 */
export function drawHiddenIcon(ctx: Ctx, color: string): void {
  // The eye's outer edge and inner edge, two quadratic arcs each, and its pupil.
  const eye = (x0: number, x1: number, top: number, bottom: number): void => {
    const cx = (x0 + x1) / 2;
    const cy = (top + bottom) / 2;
    ctx.moveTo(x0, cy);
    ctx.quadraticCurveTo(cx, 2 * top - cy, x1, cy);
    ctx.quadraticCurveTo(cx, 2 * bottom - cy, x0, cy);
    ctx.closePath();
  };
  // The slash, as a band of half-width `hw` along the box's diagonal, run past the box's corners.
  const band = (hw: number): void => {
    const n = hw / Math.SQRT2;
    ctx.moveTo(-4 + n, -4 - n);
    ctx.lineTo(20 + n, 20 - n);
    ctx.lineTo(20 - n, 20 + n);
    ctx.lineTo(-4 - n, -4 + n);
    ctx.closePath();
  };
  const bar = 2;
  const gap = 0.9;
  ctx.fillStyle = color;
  ctx.save();
  ctx.beginPath();
  ctx.rect(-4, -4, 24, 24);
  band(bar / 2 + gap);
  ctx.clip('evenodd');
  ctx.beginPath();
  eye(0.25, 15.75, 2.25, 13.75);
  eye(3.45, 12.55, 4.25, 11.75);
  ctx.moveTo(11, 8);
  ctx.arc(8, 8, 3, 0, Math.PI * 2);
  ctx.fill('evenodd');
  ctx.restore();
  ctx.strokeStyle = color;
  ctx.lineWidth = bar;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(1.75, 1.75);
  ctx.lineTo(14.25, 14.25);
  ctx.stroke();
}

/** An agent's provider mark: a disc with its letter. */
export function drawMark(ctx: Ctx, x: number, y: number, r: number, letter: string, t: Tokens): void {
  ctx.fillStyle = t.mark.disc;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = t.border.default;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = t.mark.fg;
  ctx.font = `700 ${r}px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, x, y + 0.5);
}

/** Diagonal grip lines for an app's resize corner. */
export function drawGrip(ctx: Ctx, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  line(ctx, 20, 8, 8, 20);
  line(ctx, 20, 13, 13, 20);
  line(ctx, 20, 18, 18, 20);
  ctx.restore();
}
