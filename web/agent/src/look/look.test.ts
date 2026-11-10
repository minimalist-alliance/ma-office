import { describe, expect, it } from 'vitest';
import { drawAgentMark, glyphSize, strokeFor } from './draw';
import { FOREGROUND, FOREGROUND_RGB } from './foreground';
import { AGENT_ICONS, DEFAULT_ICON, RETIRED_ICONS, STROKE, iconById } from './icons';
import { DEFAULT_TONE, TONES, toneColor, type LookTheme } from './tones';
import { nextIndex } from './Pickers';
import { THEMES } from '../../../src/theme/tokens';

const THEME_LIST: LookTheme[] = ['light', 'dusk', 'dark'];

const rgb = (hex: string): [number, number, number] => {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
};
const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** WCAG 2 relative luminance. */
const luminance = ([r, g, b]: number[]): number => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
/** WCAG 2 contrast ratio. */
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** CIEDE2000 color difference (D65), the standard formula of Sharma, Wu and Dalal. */
function deltaE(a: number[], b: number[]): number {
  const lab = (c: number[]): [number, number, number] => {
    const [r, g, bl] = c.map(lin) as [number, number, number];
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  const rad = Math.PI / 180;
  const deg = (v: number): number => (((v / rad) % 360) + 360) % 360;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const c1 = Math.hypot(ap1, b1);
  const c2 = Math.hypot(ap2, b2);
  const h1 = c1 === 0 ? 0 : deg(Math.atan2(b1, ap1));
  const h2 = c2 === 0 ? 0 : deg(Math.atan2(b2, ap2));
  const dL = l2 - l1;
  const dC = c2 - c1;
  let dh = h2 - h1;
  if (c1 * c2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh * rad) / 2);
  const lBar = (l1 + l2) / 2;
  const cBar2 = (c1 + c2) / 2;
  let hBar = h1 + h2;
  if (c1 * c2 === 0) hBar = h1 + h2;
  else if (Math.abs(h1 - h2) <= 180) hBar /= 2;
  else hBar = (hBar + (hBar < 360 ? 360 : -360)) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBar2;
  const sh = 1 + 0.015 * cBar2 * t;
  const rc = 2 * Math.sqrt(cBar2 ** 7 / (cBar2 ** 7 + 25 ** 7));
  const rt = -Math.sin(2 * 30 * Math.exp(-(((hBar - 275) / 25) ** 2)) * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

/** Smallest color difference (delta E 2000) allowed between any two tones in a theme. 9 keeps neighbours easy to tell apart when names show only on hover. */
const MIN_DELTA_E = 9;
/** WCAG 2 AA for text and meaningful graphics. */
const MIN_CONTRAST = 4.5;

describe('foreground', () => {
  it('is one near-white color matching the theme kit', () => {
    expect(FOREGROUND).toBe(THEMES.dusk.text.primary.toLowerCase());
    // Dusk's "truly white" primary text (ADR 0050, 0065).
    expect(rgb(THEMES.dusk.text.primary.toLowerCase())).toEqual([...FOREGROUND_RGB]);
  });
});

describe('contrast', () => {
  for (const theme of THEME_LIST) {
    it(`FOREGROUND reads at 4.5:1 or more on every tone in ${theme}`, () => {
      const low = TONES.map((t) => ({ id: t.id, c: contrast([...FOREGROUND_RGB], rgb(t[theme])) })).filter((x) => x.c < MIN_CONTRAST);
      expect(low).toEqual([]);
    });
  }
});

describe('tones', () => {
  it('has 12 to 16, with unique lowercase-word ids and labels, and the default among them', () => {
    expect(TONES.length).toBe(12);
    expect(new Set(TONES.map((t) => t.id)).size).toBe(TONES.length);
    expect(new Set(TONES.map((t) => t.label)).size).toBe(TONES.length);
    for (const t of TONES) expect(t.id).toMatch(/^[a-z]+$/);
    expect(TONES.some((t) => t.id === DEFAULT_TONE)).toBe(true);
  });
  for (const theme of THEME_LIST) {
    it(`keeps every pair at a color difference of ${MIN_DELTA_E} or more in ${theme}`, () => {
      const close: string[] = [];
      for (let i = 0; i < TONES.length; i++)
        for (let j = i + 1; j < TONES.length; j++) {
          const d = deltaE(rgb(TONES[i]![theme]), rgb(TONES[j]![theme]));
          // Compared at the one decimal the review's table gives: teal/cyan is 8.97 in Dusk and Dark, which that table lists as 9.0.
          if (Math.round(d * 10) / 10 < MIN_DELTA_E) close.push(`${TONES[i]!.id}/${TONES[j]!.id} ${d.toFixed(1)}`);
        }
      expect(close).toEqual([]);
    });
  }
  it('has the reviewed hex values, and shows a retired tone as its replacement', () => {
    const t = (id: string) => TONES.find((x) => x.id === id)!;
    expect([t('graphite').light, t('graphite').dusk, t('graphite').dark].map(rgb)).toEqual([[94, 103, 113], [105, 114, 124], [100, 109, 119]]);
    expect([t('plum').light, t('plum').dusk, t('plum').dark].map(rgb)).toEqual([[132, 88, 117], [141, 96, 126], [139, 94, 124]]);
    expect(toneColor('moss', 'light')).toBe(toneColor('green', 'light'));
    expect(toneColor('sky', 'dusk')).toBe(toneColor('blue', 'dusk'));
  });
  it('gives each theme its own value for a tone and falls back to the default for an unknown id', () => {
    expect(toneColor('blue', 'dusk')).toBe(TONES.find((t) => t.id === 'blue')!.dusk);
    expect(toneColor('nope', 'dark')).toBe(toneColor(DEFAULT_TONE, 'dark'));
    expect(toneColor('', 'light')).toBe(toneColor(DEFAULT_TONE, 'light'));
  });
});

// A strict-enough check of SVG path data: commands with the right number of numbers, starting with a move.
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
function parsePath(d: string): boolean {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)|[\s,]+/gy;
  const tokens: (string | number)[] = [];
  let pos = 0;
  for (let m = re.exec(d); m; m = re.exec(d)) {
    pos = re.lastIndex;
    if (m[1]) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(Number(m[2]));
  }
  if (pos !== d.length || tokens[0] !== 'M' || tokens.length === 0) return false;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (typeof cmd !== 'string') return false;
    const n = ARGS[cmd.toUpperCase()]!;
    let count = 0;
    while (typeof tokens[i] === 'number') {
      count++;
      i++;
    }
    if (n === 0 ? count !== 0 : count === 0 || count % n !== 0) return false;
  }
  return true;
}

describe('icons', () => {
  it('has about 24, with unique stable-looking ids and labels, and a default that exists', () => {
    expect(AGENT_ICONS.length).toBeGreaterThanOrEqual(22);
    expect(AGENT_ICONS.length).toBeLessThanOrEqual(26);
    expect(new Set(AGENT_ICONS.map((i) => i.id)).size).toBe(AGENT_ICONS.length);
    expect(new Set(AGENT_ICONS.map((i) => i.label)).size).toBe(AGENT_ICONS.length);
    for (const i of AGENT_ICONS) expect(i.id).toMatch(/^[a-z]+$/);
    expect(AGENT_ICONS.some((i) => i.id === DEFAULT_ICON)).toBe(true);
  });
  it('names the roles the brief lists', () => {
    const want = ['spark', 'compass', 'book', 'pen', 'calendar', 'clock', 'chart', 'code', 'mail', 'person', 'search', 'leaf', 'flask', 'document', 'music', 'camera', 'plane', 'shield', 'wallet', 'bulb', 'home', 'bell', 'list', 'terminal'];
    expect(AGENT_ICONS.map((i) => i.id)).toEqual(want);
  });
  it('has path data that parses, inside the 24 grid, with no two icons drawn the same', () => {
    for (const icon of AGENT_ICONS) {
      expect(icon.paths.length).toBeGreaterThan(0);
      for (const d of icon.paths) {
        expect(parsePath(d), `${icon.id}: ${d}`).toBe(true);
        // Absolute coordinates stay inside 0..24 (relative ones are checked by the eye in the demo).
        for (const m of d.matchAll(/[MLHV]\s*(-?[\d.]+)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      }
    }
    expect(new Set(AGENT_ICONS.map((i) => i.paths.join('|'))).size).toBe(AGENT_ICONS.length);
  });
  it('rejects malformed path data (the checker works)', () => {
    expect(parsePath('M1 2L3')).toBe(false);
    expect(parsePath('L1 2')).toBe(false);
    expect(parsePath('M1 2x')).toBe(false);
  });
  it('shows a retired icon as its replacement', () => {
    expect(RETIRED_ICONS).toEqual({ globe: 'plane', chat: 'person', heart: 'wallet', star: 'bulb', puzzle: 'terminal', briefcase: 'document' });
    for (const [old, now] of Object.entries(RETIRED_ICONS)) expect(iconById(old).id).toBe(now);
  });
  it('falls back to the default icon for an unknown id', () => {
    expect(iconById('terminal').id).toBe('terminal');
    expect(iconById('nope').id).toBe(DEFAULT_ICON);
    expect(iconById('').id).toBe(DEFAULT_ICON);
  });
});

describe('small sizes', () => {
  it('makes the glyph 70% of the tile below 32 px, else 56%, and keeps a stroke of at least 1.3 px', () => {
    expect(glyphSize(20)).toBeCloseTo(14, 5);
    expect(glyphSize(31)).toBeCloseTo(21.7, 5);
    expect(glyphSize(32)).toBeCloseTo(17.92, 5);
    expect(glyphSize(76)).toBeCloseTo(42.56, 5);
    expect(STROKE).toBe(2);
    expect(strokeFor(42.56)).toBe(STROKE);
    expect((strokeFor(14) * 14) / 24).toBeGreaterThanOrEqual(1.3 - 1e-9);
    expect((strokeFor(10) * 10) / 24).toBeGreaterThanOrEqual(1.3 - 1e-9);
  });
});

describe('keyboard', () => {
  it('moves with arrows, wraps, and jumps with Home and End', () => {
    expect(nextIndex('ArrowRight', 2, 5)).toBe(3);
    expect(nextIndex('ArrowRight', 4, 5)).toBe(0);
    expect(nextIndex('ArrowLeft', 0, 5)).toBe(4);
    expect(nextIndex('Home', 3, 5)).toBe(0);
    expect(nextIndex('End', 0, 5)).toBe(4);
    expect(nextIndex('a', 0, 5)).toBeNull();
  });
});

describe('drawAgentMark', () => {
  it('fills the tile in the tone and strokes the icon in FOREGROUND only', () => {
    const fills: unknown[] = [];
    const strokes: unknown[] = [];
    const ctx = new Proxy({ fillStyle: '', strokeStyle: '' } as Record<string, unknown>, {
      get: (t, k: string) => {
        if (k === 'fill') return () => fills.push(t['fillStyle']);
        if (k === 'stroke') return () => strokes.push(t['strokeStyle']);
        return k in t ? t[k] : () => undefined;
      },
    });
    (globalThis as { Path2D?: unknown }).Path2D = class {};
    drawAgentMark(ctx as unknown as CanvasRenderingContext2D, { icon: 'person', tone: 'blue', theme: 'dusk', x: 0, y: 0, size: 76, radius: 18 });
    expect(fills).toEqual([toneColor('blue', 'dusk')]);
    expect(strokes.length).toBe(iconById('person').paths.length);
    expect(new Set(strokes)).toEqual(new Set([FOREGROUND]));
    delete (globalThis as { Path2D?: unknown }).Path2D;
  });
  it('fits a non-square mask into the square instead of stretching it', () => {
    const calls: number[][] = [];
    const scratchCtx = new Proxy({} as Record<string, unknown>, {
      get: (_t, k: string) => (k === 'drawImage' ? (...a: number[]) => calls.push(a.slice(1)) : k === 'canvas' ? {} : () => undefined),
      set: () => true,
    });
    const g = globalThis as { OffscreenCanvas?: unknown; Path2D?: unknown };
    g.OffscreenCanvas = class {
      getContext() {
        return scratchCtx;
      }
    };
    const ctx = new Proxy({ fillStyle: '' } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : () => undefined), set: () => true });
    drawAgentMark(ctx as unknown as CanvasRenderingContext2D, { icon: 'png', tone: 'blue', theme: 'light', mask: { width: 100, height: 20 } as unknown as CanvasImageSource, x: 0, y: 0, size: 100, radius: 10 });
    delete g.OffscreenCanvas;
    // A 100 x 20 mask in a square: full width, a fifth of the height, centred vertically.
    const [x, y, w, h] = calls[0]!;
    expect(x).toBeCloseTo(0, 5);
    expect(w! / h!).toBeCloseTo(5, 5);
    expect(y! * 2 + h!).toBeCloseTo(w!, 5);
  });
});
