// The canvas glyphs, drawn into a context that records what it was asked to do.
import { describe, expect, it } from 'vitest';
import { THEMES } from '../theme/tokens';
import { drawEtchIcon, drawGlyph } from './glyphs';

interface Mark {
  op: string;
  fill: string;
  args: number[];
}

/** A stand-in 2D context: every call is kept, with the fill in force when it was made. */
function recorder(): { ctx: CanvasRenderingContext2D; marks: Mark[] } {
  const marks: Mark[] = [];
  const state: Record<string, unknown> = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: number[]) => marks.push({ op: key, fill: String(target['fillStyle']), args });
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, marks };
}

describe('the Commons glyph', () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    it(`draws three people, head and shoulders, light, not three heavy dots (${theme})`, () => {
      const { ctx, marks } = recorder();
      drawGlyph(ctx, 'commons', t, 48);
      const heads = marks.filter((m) => m.op === 'arc');
      expect(heads).toHaveLength(3);
      for (const h of heads) expect(h.args[2]).toBeLessThanOrEqual(2.5);
      expect(marks.filter((m) => m.op === 'ellipse')).toHaveLength(3);
      // Nothing under the board is filled in the strong glyph color: the people are the soft one.
      const fills = marks.filter((m) => m.op === 'fill');
      expect(fills.some((f) => f.fill === t.glyph.default)).toBe(false);
      expect(fills.filter((f) => f.fill === t.glyph.soft).length).toBeGreaterThanOrEqual(7);
    });
  }
});

describe('the carousel switch\'s glyph', () => {
  it('is a landscape card between two thin, short slivers with a clear gap to each, spanning 4.5 to 14.5', () => {
    const { ctx, marks } = recorder();
    drawEtchIcon(ctx, 'carousel', '#000');
    const [mid, left, right] = marks.filter((m) => m.op === 'roundRect').map((m) => ({ x: m.args[0]!, y: m.args[1]!, w: m.args[2]!, h: m.args[3]! }));
    expect(mid!.w).toBeGreaterThan(mid!.h * 1.05); // wider than tall: a card, never a bar
    for (const side of [left!, right!]) {
      expect(side.w).toBeLessThanOrEqual(1.5); // thin
      expect(side.h).toBeLessThan(mid!.h); // and short
    }
    expect(mid!.x - (left!.x + left!.w)).toBeGreaterThanOrEqual(1);
    expect(right!.x - (mid!.x + mid!.w)).toBeGreaterThanOrEqual(1);
    expect(left!.x).toBe(4.5);
    expect(right!.x + right!.w).toBeCloseTo(14.5, 5);
  });
});
