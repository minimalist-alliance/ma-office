// App glyphs drawn straight onto a canvas context, from the prototype (crisp at every zoom,
// no image decoding). Each draws into a 48x48 box at the origin. Colors are theme tokens.
import { lookChunk, parseLook, type GlyphId } from '../agent/roster';
import { THEME_IDS, THEMES, type Tokens } from '../theme/tokens';
import { CANVAS_FONT } from './font';
import type { CoreAppId } from './layout';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function dot(ctx: Ctx, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

const DRAW: Record<CoreAppId, (ctx: Ctx, t: Tokens) => void> = {
  notebook(ctx, t) {
    ctx.fillStyle = t.glyph.page;
    ctx.beginPath();
    ctx.moveTo(14, 5);
    ctx.lineTo(29, 5);
    ctx.lineTo(37, 13);
    ctx.lineTo(37, 40);
    ctx.quadraticCurveTo(37, 43, 34, 43);
    ctx.lineTo(14, 43);
    ctx.quadraticCurveTo(11, 43, 11, 40);
    ctx.lineTo(11, 8);
    ctx.quadraticCurveTo(11, 5, 14, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = t.glyph.soft;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // folded corner
    ctx.fillStyle = t.glyph.soft;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(29, 5);
    ctx.lineTo(29, 11);
    ctx.quadraticCurveTo(29, 13, 31, 13);
    ctx.lineTo(37, 13);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    // heading block and text lines
    ctx.fillStyle = t.glyph.default;
    ctx.beginPath();
    ctx.roundRect(16, 12, 8, 8, 1.5);
    ctx.fill();
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = t.glyph.soft;
    line(ctx, 16, 27, 32, 27);
    line(ctx, 16, 32, 32, 32);
    ctx.strokeStyle = t.accent.default;
    line(ctx, 16, 37, 26, 37);
  },

  // Files: a folder, the drive's own. Back leaf soft, front panel strong, one accent stroke as the notebook has.
  files(ctx, t) {
    ctx.fillStyle = t.glyph.soft;
    ctx.beginPath();
    ctx.roundRect(7, 11, 15, 12, 3);
    ctx.roundRect(7, 15, 34, 25, 3);
    ctx.fill();
    ctx.fillStyle = t.glyph.default;
    ctx.beginPath();
    ctx.roundRect(7, 20, 34, 20, 3);
    ctx.fill();
    ctx.fillStyle = t.accent.default;
    ctx.fillRect(14, 32, 12, 2.6);
  },

  chat(ctx, t) {
    ctx.fillStyle = t.glyph.default;
    ctx.beginPath();
    ctx.ellipse(24, 22, 17, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(12.5, 29);
    ctx.lineTo(9, 41);
    ctx.lineTo(21, 35.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = t.surface.tile;
    dot(ctx, 16.5, 22, 2.7);
    dot(ctx, 24, 22, 2.7);
    dot(ctx, 31.5, 22, 2.7);
  },

  browser(ctx, t) {
    ctx.strokeStyle = t.glyph.globe;
    ctx.lineWidth = 2.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(24, 24, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(24, 24, 7, 16, 0, 0, Math.PI * 2);
    ctx.stroke();
    line(ctx, 8.5, 24, 39.5, 24);
    line(ctx, 10.6, 16, 37.4, 16);
    line(ctx, 10.6, 32, 37.4, 32);
  },

  // A Guild Desk's Commons (task 48): a board that's always up, with the guild gathered under it.
  commons(ctx, t) {
    ctx.fillStyle = t.glyph.page;
    ctx.beginPath();
    ctx.roundRect(7, 7, 34, 24, 3.5);
    ctx.fill();
    ctx.strokeStyle = t.glyph.soft;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = t.accent.default;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(13, 23);
    ctx.quadraticCurveTo(17, 13, 21, 19);
    ctx.quadraticCurveTo(25, 25, 29, 15);
    ctx.stroke();
    ctx.fillStyle = t.glyph.soft;
    ctx.beginPath();
    ctx.roundRect(30, 12, 7, 7, 1.2);
    ctx.fill();
    // Three people, head and shoulders, light: at tile size, three heavy dots read as an ellipsis or a loading mark.
    ctx.fillStyle = t.glyph.soft;
    for (const x of [14, 24, 34]) {
      dot(ctx, x, 35.6, 2.4);
      ctx.beginPath();
      ctx.ellipse(x, 44, 4, 4.4, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
    }
  },

  agent(ctx, t) {
    const nodes = [-90, -30, 30, 90, 150, 210].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return { x: 24 + Math.cos(a) * 15, y: 24 + Math.sin(a) * 15, a };
    });
    ctx.strokeStyle = t.glyph.default;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    for (const { a } of nodes) {
      line(ctx, 24 + Math.cos(a) * 7, 24 + Math.sin(a) * 7, 24 + Math.cos(a) * 11.5, 24 + Math.sin(a) * 11.5);
    }
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1.4;
    for (let i = 0; i < nodes.length; i += 2) {
      const n1 = nodes[i]!;
      const n2 = nodes[(i + 1) % nodes.length]!;
      line(ctx, n1.x, n1.y, n2.x, n2.y);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = t.glyph.default;
    nodes.forEach((n, i) => dot(ctx, n.x, n.y, i % 2 ? 3.4 : 4.2));
    ctx.strokeStyle = t.accent.default;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.arc(24, 24, 5.2, 0, Math.PI * 2);
    ctx.stroke();
  },
};

/** Draw app glyph `app` scaled to `size` px at the context's current origin. */
export function drawGlyph(ctx: Ctx, app: GlyphId, t: Tokens, size: number): void {
  const look = parseLook(app);
  if (look) {
    // An agent's own app (task 49): its mark, the tone square with its icon or upload in the one foreground color. Its drawing
    // is a chunk of its own (`lookChunk`): until it's here the tile is blank, and its glyph key changes when it comes.
    const draw = look.icon ? lookChunk() : null;
    if (!draw) return;
    const theme = THEME_IDS.find((id) => THEMES[id] === t) ?? 'light';
    draw.drawAgentMark(ctx as CanvasRenderingContext2D, { icon: look.icon, tone: look.tone, theme, mask: look.mask?.bitmap ?? null, x: 0, y: 0, size, radius: size * draw.RADIUS_SHARE });
    return;
  }
  const k = size / 48;
  ctx.save();
  ctx.scale(k, k);
  DRAW[app as CoreAppId](ctx, t);
  ctx.restore();
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
