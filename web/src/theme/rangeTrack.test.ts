// The office's range (`.ma-range`, app.css): in Light its unfilled track is `border.strong`, which must stay 3:1 or more on
// the popover it sits on (WCAG 1.4.11), at the default and at every Contrast above it (the theme sliders, ADR 0098).
import { describe, expect, it } from 'vitest';
import { THEMES } from './tokens';
import { contrastRatio, tuneFlat } from './tune/xf';

const flat = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [g, v] of Object.entries(THEMES.light) as [string, unknown][]) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === 'string') out[`${g}.${k}`] = s;
  }
  return out;
};

describe("the range's unfilled track in Light", () => {
  it('is 3:1 or more on the popover at the default', () => {
    const f = flat();
    expect(contrastRatio(f['border.strong']!, f['surface.overlay']!)).toBeGreaterThanOrEqual(3);
    // What it replaced, for the record: fillStrong was far under.
    expect(contrastRatio(f['surface.fillStrong']!, f['surface.overlay']!)).toBeLessThan(1.5);
  });

  it('stays 3:1 or more at every Contrast from the default up, at every Blue', () => {
    for (const blue of [0, 50, 100]) {
      for (const contrast of [50, 75, 100]) {
        const { out } = tuneFlat(flat(), { blue, contrast });
        expect(contrastRatio(out['border.strong']!, out['surface.overlay']!), `blue ${blue}, contrast ${contrast}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
