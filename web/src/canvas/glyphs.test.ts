// The canvas glyphs, drawn into a context that records what it was asked to do.
import { describe, expect, it } from 'vitest';
import { THEMES } from '../theme/tokens';
import { drawGlyph } from './glyphs';

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
