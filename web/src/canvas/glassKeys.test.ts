// The glass tiles' bitmaps (the owner's pick C, Nov 16): the solid face keeps release 6.6's key exactly (so the fallback is that
// tile, from the same cache), the glass is keyed apart and by the desk's look, and a tile's backdrop by its place modulo the texture.
import { describe, expect, it } from 'vitest';
import { backdropPlace, tileKey, type TileSpec } from './sprites';

const look = (key: string) => ({ key }) as unknown as NonNullable<TileSpec['at']>['look'];
const spec = (over: Partial<TileSpec> = {}): TileSpec => ({ w: 76, h: 76, app: 'browser', glyphSize: 48, radius: 16, stacked: false, textured: true, tint: 'browser', ...over });

describe('tile keys', () => {
  it('the solid face (a widget\'s card, or any tile under reduced transparency or more contrast) has release 6.6\'s key', () => {
    expect(tileKey(spec(), 3, 2, false)).toBe('t|3|2|76|76|browser|browser|48|16|0|1');
    expect(tileKey(spec({ app: null, tint: undefined, textured: false }), 3, 2, false)).toBe('t|3|2|76|76|||48|16|0|0');
  });
  it('glass is its own bitmap, keyed by the desk\'s look (the body\'s opacity follows the desk\'s colour)', () => {
    const plain = tileKey(spec({ at: { x: 0, y: 0, look: look('plain:light') } }), 3, 2, true);
    const oak = tileKey(spec({ at: { x: 0, y: 0, look: look('white-oak:light') } }), 3, 2, true);
    expect(plain).not.toBe(tileKey(spec(), 3, 2, false));
    expect(plain.startsWith('t|3|2|76|76|browser|browser|48|16|0|1|g|')).toBe(true);
    expect(oak).not.toBe(plain);
    // Its place on the desk isn't in the face's key: every tile of an app and size shares it.
    expect(tileKey(spec({ at: { x: 500, y: 92, look: look('plain:light') } }), 3, 2, true)).toBe(plain);
    // In hand there's no desk under it: the glass over the panel.
    expect(tileKey(spec({ stacked: true }), 3, 2, true)).toBe('t|3|2|76|76|browser|browser|48|16|1|1|g|');
  });
});

describe('a widget\'s card in glass', () => {
  it('keeps the plain card\'s key under the fallback, and is a bitmap of its own in glass, apart from an icon\'s', () => {
    const card = spec({ app: null, tint: undefined, words: true, textured: false });
    expect(tileKey(card, 3, 2, false)).toBe('t|3|2|76|76|||48|16|0|0');
    const glass = tileKey({ ...card, at: { x: 0, y: 0, look: look('plain:light') } }, 3, 2, true);
    expect(glass).toBe('t|3|2|76|76|||48|16|0|0|g|plain:light|w');
    expect(glass).not.toBe(tileKey({ ...card, words: undefined, at: { x: 0, y: 0, look: look('plain:light') } }, 3, 2, true));
  });
});

describe('backdrop places', () => {
  const at = (x: number, y: number) => ({ x, y, look: { key: 'white-oak:light' } });
  it('the texture repeats, so two tiles a period apart share a backdrop, and a quarter unit apart is the same place', () => {
    const p = backdropPlace(spec(), at(24, 60), 1, 512);
    expect(backdropPlace(spec(), at(24 + 512, 60 - 1024), 1, 512)).toBe(p);
    expect(backdropPlace(spec(), at(24.1, 60), 1, 512)).toBe(p);
    expect(backdropPlace(spec(), at(25, 60), 1, 512)).not.toBe(p);
    expect(backdropPlace(spec(), at(-488, 60), 1, 512)).toBe(p);
  });
  it('a new look, size or theme revision is a new backdrop', () => {
    const p = backdropPlace(spec(), at(24, 60), 1, 512);
    expect(backdropPlace(spec(), { ...at(24, 60), look: { key: 'oak:light' } }, 1, 512)).not.toBe(p);
    expect(backdropPlace(spec({ w: 168 }), at(24, 60), 1, 512)).not.toBe(p);
    expect(backdropPlace(spec(), at(24, 60), 2, 512)).not.toBe(p);
  });
});
