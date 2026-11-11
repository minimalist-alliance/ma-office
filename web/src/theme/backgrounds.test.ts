import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMirror } from './backdropMirror';
import { BACKGROUNDS_IN, DEFAULT_SCENE_IN, NONE, parseBackgroundPref, parseEdgeBand, parseManifest, pictureSources, sceneFor, srcsetFor, type Scene } from './backgrounds';
import { THEME_IDS, THEMES } from './tokens';

const scene = (id: string, widths = [960, 1920, 2560, 3840]): Scene => ({ id, name: id, widths, formats: ['avif', 'webp'], average: '#6b7a62', luminance: 0.19, placeholder: 'data:image/webp;base64,AA==' });
const SCENES = [scene('misty-forest'), scene('still-water')];

describe('the preference', () => {
  it('is an id or "none", and anything else reads as nothing', () => {
    expect(parseBackgroundPref('misty-forest')).toBe('misty-forest');
    expect(parseBackgroundPref(NONE)).toBe(NONE);
    expect(parseBackgroundPref('a')).toBe('a');
    expect(parseBackgroundPref('a'.repeat(32))).toBe('a'.repeat(32));
    for (const bad of ['', 'Misty', '-x', 'a'.repeat(33), 'a b', 42, null, undefined, {}, ['misty-forest']]) expect(parseBackgroundPref(bad)).toBeUndefined();
  });
});

describe('the scene to show', () => {
  it('is the first scene in the themes with a default and none elsewhere, with nothing chosen', () => {
    for (const theme of THEME_IDS) expect(sceneFor(undefined, theme, SCENES)?.id).toBe(DEFAULT_SCENE_IN.includes(theme) ? 'misty-forest' : undefined);
    expect(DEFAULT_SCENE_IN).toEqual(['dusk']);
  });
  it('is what was chosen in any theme that shows scenes, and "none" shows none', () => {
    for (const theme of BACKGROUNDS_IN) {
      expect(sceneFor('still-water', theme, SCENES)?.id).toBe('still-water');
      expect(sceneFor(NONE, theme, SCENES)).toBeNull();
    }
  });
  it('shows the default for an id this manifest lacks, which stays stored as it came', () => {
    expect(sceneFor('from-a-newer-build', 'dusk', SCENES)?.id).toBe('misty-forest');
    expect(sceneFor('from-a-newer-build', 'light', SCENES)).toBeNull();
  });
  it('shows scenes in Zen only', () => {
    expect(BACKGROUNDS_IN).toEqual(['dusk']);
  });
  it('shows none in a theme outside BACKGROUNDS_IN, while the choice stays stored for Zen', () => {
    const others = THEME_IDS.filter((t) => !BACKGROUNDS_IN.includes(t));
    for (const theme of others) expect(sceneFor('still-water', theme, SCENES)).toBeNull();
    // The same preference, back in Zen, shows again: nothing in the rule clears it.
    expect(sceneFor('still-water', 'dusk', SCENES)?.id).toBe('still-water');
  });
  it('shows none of an empty manifest', () => {
    expect(sceneFor(undefined, 'dusk', [])).toBeNull();
  });
});

describe('the files', () => {
  it('builds a srcset of every width under the base, smallest first', () => {
    expect(srcsetFor('/v/2026.11.10-abc/', SCENES[0]!, 'avif')).toBe(
      '/v/2026.11.10-abc/backgrounds/misty-forest/960.avif 960w, /v/2026.11.10-abc/backgrounds/misty-forest/1920.avif 1920w, /v/2026.11.10-abc/backgrounds/misty-forest/2560.avif 2560w, /v/2026.11.10-abc/backgrounds/misty-forest/3840.avif 3840w',
    );
  });
  it('stops at a width for a browser saving data, and keeps the smallest if even that is too wide', () => {
    expect(srcsetFor('/', SCENES[0]!, 'webp', 1920)).toBe('/backgrounds/misty-forest/960.webp 960w, /backgrounds/misty-forest/1920.webp 1920w');
    expect(srcsetFor('/', scene('x', [2560]), 'webp', 1920)).toBe('/backgrounds/x/2560.webp 2560w');
  });
  it('puts AVIF before WebP, whatever order the manifest has', () => {
    const s = { ...SCENES[0]!, formats: ['webp', 'avif'] };
    expect(pictureSources('/', s).map((p) => p.type)).toEqual(['image/avif', 'image/webp']);
    expect(pictureSources('/', scene('y')).map((p) => p.type)).toEqual(['image/avif', 'image/webp']);
  });
});

describe('the manifest', () => {
  it('reads version 1 and leaves out a scene missing what the layer needs', () => {
    const raw = {
      version: 1,
      scenes: [
        { id: 'ok', name: 'Ok', widths: [1920, 960], formats: ['webp'], average: '#abcdef', luminance: 0.4, placeholder: 'data:image/webp;base64,AA==' },
        { id: 'Bad Id', name: 'x', widths: [960], formats: ['webp'], average: '#abcdef', placeholder: 'data:image/webp;base64,AA==' },
        { id: 'no-average', name: 'x', widths: [960], formats: ['webp'], average: 'green', placeholder: 'data:image/webp;base64,AA==' },
        { id: 'no-placeholder', name: 'x', widths: [960], formats: ['webp'], average: '#abcdef', placeholder: 'https://elsewhere/x.webp' },
        { id: 'no-widths', name: 'x', widths: [], formats: ['webp'], average: '#abcdef', placeholder: 'data:image/webp;base64,AA==' },
      ],
    };
    const m = parseManifest(raw);
    expect(m?.scenes.map((s) => s.id)).toEqual(['ok']);
    expect(m?.scenes[0]?.widths).toEqual([960, 1920]);
    expect(parseManifest({ version: 2, scenes: [] })).toBeNull();
    expect(parseManifest({ version: 1, scenes: [] })).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('x')).toBeNull();
  });
  it('is what public/backgrounds/manifest.json holds, about ten scenes with every width and both formats, and the edge band', () => {
    const m = parseManifest(JSON.parse(readFileSync(new URL('../../public/backgrounds/manifest.json', import.meta.url), 'utf8')));
    expect(m).not.toBeNull();
    expect(m!.scenes.length).toBeGreaterThanOrEqual(2);
    for (const s of m!.scenes) {
      expect(s.widths).toEqual([960, 1920, 2560, 3840]);
      expect(s.formats.sort()).toEqual(['avif', 'webp']);
      expect(s.placeholder.length).toBeLessThan(2048);
    }
    expect(new Set(m!.scenes.map((s) => s.id)).size).toBe(m!.scenes.length);
    expect(m!.edgeBand).toEqual({ color: 'rgba(12, 16, 26, 0.4)', topBottom: 0.14, sides: 0 });
  });
});

describe('the edge bands', () => {
  it('read grade.edge_band with a hex or an rgb colour, and nothing short of all four parts', () => {
    expect(parseEdgeBand({ alpha: 0.4, top_bottom: 0.14, sides: 0.12, color: '#1e1b17' })).toEqual({ color: 'rgba(30, 27, 23, 0.4)', topBottom: 0.14, sides: 0.12 });
    expect(parseEdgeBand({ alpha: 0.35, top_bottom: 0.2, sides: 0.1, color: [30, 27, 23] })).toEqual({ color: 'rgba(30, 27, 23, 0.35)', topBottom: 0.2, sides: 0.1 });
    expect(parseEdgeBand({ alpha: 0.4, top_bottom: 0.14, sides: 0, color: '#1e1b17' })?.sides).toBe(0);
    // As the v6 manifest spells it: an rgba string, whose own alpha gives way to `alpha`.
    expect(parseEdgeBand({ alpha: 0.4, top_bottom: 0.14, sides: 0, color: 'rgba(30, 27, 23, 0.40)' })).toEqual({ color: 'rgba(30, 27, 23, 0.4)', topBottom: 0.14, sides: 0 });
    for (const bad of [null, 'x', {}, { alpha: 0.4, top_bottom: 0.14, sides: 0.12 }, { alpha: 1.4, top_bottom: 0.14, sides: 0.12, color: '#1e1b17' }, { alpha: 0.4, top_bottom: 0.9, sides: 0.12, color: '#1e1b17' }, { alpha: 0.4, top_bottom: 0.14, sides: 0.12, color: 'dark' }]) {
      expect(parseEdgeBand(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('come with the manifest, or not', () => {
    const scene = { id: 'ok', name: 'Ok', widths: [960], formats: ['webp'], average: '#abcdef', placeholder: 'data:image/webp;base64,AA==' };
    expect(parseManifest({ version: 1, scenes: [scene] })?.edgeBand).toBeNull();
    expect(parseManifest({ version: 1, grade: { version: 6, edge_band: { alpha: 0.4, top_bottom: 0.14, sides: 0.12, color: '#1e1b17' } }, scenes: [scene] })?.edgeBand).toEqual({ color: 'rgba(30, 27, 23, 0.4)', topBottom: 0.14, sides: 0.12 });
  });
});

describe('the mirror', () => {
  it('reads an id and theme, with the paint hints only when they look right', () => {
    expect(parseMirror(null)).toBeNull();
    expect(parseMirror('{')).toBeNull();
    expect(parseMirror(JSON.stringify({ id: 'x' }))).toBeNull();
    expect(parseMirror(JSON.stringify({ id: 'none', theme: 'light' }))).toEqual({ id: 'none', theme: 'light' });
    expect(parseMirror(JSON.stringify({ id: 'x', theme: 'dusk', average: '#abcdef', placeholder: 'data:image/webp;base64,AA==' }))).toEqual({ id: 'x', theme: 'dusk', average: '#abcdef', placeholder: 'data:image/webp;base64,AA==' });
    expect(parseMirror(JSON.stringify({ id: 'x', theme: 'dusk', average: 'red', placeholder: 'https://elsewhere/' }))).toEqual({ id: 'x', theme: 'dusk' });
  });
});

// ----- contrast: the scrim over every scene keeps design 3.12's ratios for what sits on the ground.

type Rgba = { r: number; g: number; b: number; a: number };

function parse(c: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) throw new Error(`can't parse ${c}`);
  const [r, g, b, a] = m[1]!.split(',').map((s) => Number(s.trim()));
  return { r: r!, g: g!, b: b!, a: a ?? 1 };
}

/** `mix-blend-mode: multiply` of a translucent colour over an opaque one: each channel `under * (1 - a + a * top / 255)`. */
const multiply = (top: Rgba, under: Rgba): Rgba => ({
  r: under.r * (1 - top.a + (top.a * top.r) / 255),
  g: under.g * (1 - top.a + (top.a * top.g) / 255),
  b: under.b * (1 - top.a + (top.a * top.b) / 255),
  a: 1,
});

const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1,
});

function luminance({ r, g, b }: Rgba): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const rgbaCss = ({ r, g, b, a }: Rgba): string => `rgba(${r}, ${g}, ${b}, ${a})`;

function contrast(fg: string, bg: Rgba): number {
  const l1 = luminance(over(parse(fg), bg));
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('the scrim and the halo', () => {
  const manifest = parseManifest(JSON.parse(readFileSync(new URL('../../public/backgrounds/manifest.json', import.meta.url), 'utf8')))!;
  // Scenes show in Zen only (the owner, Nov 11), so only Zen's scrim is held. Each scene is taken as its average colour under
  // the scrim, composed as the theme's `backdropBlend` says: Zen multiplies (the owner's call to keep the deep dark blues; the
  // picture is toned down in the pipeline instead). No text sits on bare ground (the bars' words are on surface.chrome pills,
  // notices on surface.overlay; `backgrounds.shell.spec.ts` holds them opaque). While a scene shows, the rings carry a 1 px halo
  // (ring.halo) outside, so the ring or the halo reaches 3:1 on the ground, and the ring always reaches 3:1 on its halo, so the
  // pair reads as one ring. Zen's alpha is 0, a no-op darken, since its rings pass on the bare toned picture (the owner called
  // anything darker depressing). A new or regraded scene must pass here again.
  const grounds = manifest.scenes.map((s) => ({ name: s.id, color: s.average }));
  for (const theme of BACKGROUNDS_IN) {
    const t = THEMES[theme];
    for (const g of grounds) {
      const ground = (t.surface.backdropBlend === 'multiply' ? multiply : over)(parse(t.surface.backdrop), parse(g.color));
      const halo = over(parse(t.ring.halo), ground);
      it(`${theme}: the rings or their halo hold on ${g.name}`, () => {
        for (const [name, ring] of [['ring.activeDesk', t.ring.activeDesk], ['focus.ring', t.focus.ring]] as const) {
          const onGround = contrast(ring, ground);
          const haloOnGround = contrast(rgbaCss(halo), ground);
          expect(Math.max(onGround, haloOnGround), `${name}: ring ${onGround.toFixed(2)}, halo ${haloOnGround.toFixed(2)} on the ground`).toBeGreaterThanOrEqual(3);
          expect(contrast(ring, halo), `${name} on its halo`).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});
