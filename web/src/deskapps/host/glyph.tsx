// An installed app's glyph (ADR 0054), until packages carry their own icon: the Bible's is the Product Designer's option 1
// (`~/ma-coord/design-drafts/bible-app/icon/bible-1.svg`, roles `default`, `page`, `accent`), any other app the generic one (four
// rounded squares, one in the accent). The canvas's drawing and the DOM's, the same shapes in a 48 box.
import type { Tokens } from '../../theme/tokens';
import type { DeskGlyph as Kind } from './store';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DRAW: Record<string, (ctx: Ctx, t: Tokens) => void> = {
  bible(ctx, t) {
    ctx.fillStyle = t.glyph.default;
    ctx.beginPath();
    ctx.roundRect(8, 6, 32, 36, 3);
    ctx.fill();
    ctx.fillStyle = t.glyph.page;
    ctx.beginPath();
    ctx.roundRect(10, 8, 28, 32, 1);
    ctx.fill();
    ctx.fillStyle = t.glyph.default;
    ctx.beginPath();
    ctx.roundRect(8, 6, 28, 32, 2.5);
    ctx.fill();
    ctx.fillStyle = t.glyph.page;
    ctx.fill(new Path2D('M19 9H25V13H29V19H25V31H19V19H15V13H19Z'));
    ctx.fillStyle = t.accent.default;
    ctx.fill(new Path2D('M20 10H24V14H28V18H24V30H20V18H16V14H20Z'));
  },
  generic(ctx, t) {
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
  },
};

/** The canvas's: glyph `kind` scaled to `size` px at the context's origin (`canvas/glyphs.ts` hands it on). */
export function drawGlyph(ctx: Ctx, kind: string, t: Tokens, size: number): void {
  const draw = DRAW[kind];
  if (!draw) return;
  const k = size / 48;
  ctx.save();
  ctx.scale(k, k);
  draw(ctx, t);
  ctx.restore();
}

/** The DOM's (`chrome/icons.tsx` `AppGlyph`, the sheet, a phone's Apps button). */
export function DeskGlyph({ glyph, size }: { glyph: Kind; size: number }) {
  const common = { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, className: 'app-glyph' } as const;
  if (glyph === 'bible') {
    return (
      <svg {...common}>
        <rect x="8" y="6" width="32" height="36" rx="3" fill="var(--ma-glyph)" />
        <rect x="10" y="8" width="28" height="32" rx="1" fill="var(--ma-glyph-page)" />
        <rect x="8" y="6" width="28" height="32" rx="2.5" fill="var(--ma-glyph)" />
        <path d="M19 9H25V13H29V19H25V31H19V19H15V13H19Z" fill="var(--ma-glyph-page)" />
        <path d="M20 10H24V14H28V18H24V30H20V18H16V14H20Z" fill="var(--ma-accent)" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="8" y="8" width="15" height="15" rx="4" fill="var(--ma-glyph)" />
      <rect x="25" y="8" width="15" height="15" rx="4" fill="var(--ma-glyph-soft)" />
      <rect x="8" y="25" width="15" height="15" rx="4" fill="var(--ma-glyph-soft)" />
      <rect x="25" y="25" width="15" height="15" rx="4" fill="var(--ma-accent)" />
    </svg>
  );
}
