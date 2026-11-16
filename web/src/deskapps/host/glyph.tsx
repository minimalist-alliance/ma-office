// An installed app's glyph (ADR 0054), until packages carry their own icon: the Bible's is the Product Designer's option 1 with
// the MA mark's 3D finish and its own Lapis ink (`draw3d-bible.ts`, the owner's pick, Nov 12), any other app the generic one
// (four rounded squares, one in the accent). The DOM draws the Bible on a canvas through the same code.
import type { Tokens } from '../../theme/tokens';
import { GlyphCanvas } from '../../chrome/icons';
import { drawBible3d } from './draw3d-bible';
import type { DeskGlyph as Kind } from './store';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DRAW: Record<string, (ctx: Ctx, t: Tokens, size: number) => void> = {
  bible: drawBible3d,
  generic(ctx, t, size) {
    const k = size / 48;
    ctx.save();
    ctx.scale(k, k);
    const sq = (x: number, y: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, 15, 15, 4);
      ctx.fill();
    };
    sq(8, 8, t.glyph.default);
    sq(25, 8, t.glyph.soft);
    sq(8, 25, t.glyph.soft);
    sq(25, 25, t.accent.default);
    ctx.restore();
  },
};

/** The canvas's: glyph `kind` scaled to `size` px at the context's origin (`canvas/glyphs.ts` hands it on). */
export function drawGlyph(ctx: Ctx, kind: string, t: Tokens, size: number): void {
  DRAW[kind]?.(ctx, t, size);
}

/** The DOM's (`chrome/icons.tsx` `AppGlyph`, the sheet, a phone's Apps button): the Bible on a canvas, the generic one in SVG. */
export function DeskGlyph({ glyph, size }: { glyph: Kind; size: number }) {
  const common = { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, className: 'app-glyph' } as const;
  if (glyph === 'bible') return <GlyphCanvas glyph="dapp:bible" size={size} />;
  return (
    <svg {...common}>
      <rect x="8" y="8" width="15" height="15" rx="4" fill="var(--ma-glyph)" />
      <rect x="25" y="8" width="15" height="15" rx="4" fill="var(--ma-glyph-soft)" />
      <rect x="8" y="25" width="15" height="15" rx="4" fill="var(--ma-glyph-soft)" />
      <rect x="25" y="25" width="15" height="15" rx="4" fill="var(--ma-accent)" />
    </svg>
  );
}
