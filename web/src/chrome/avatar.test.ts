// The initials avatar: the tint each member keeps, and their initials (the Product Designer's spec.json).
import { describe, expect, it } from 'vitest';
import { HUES, hueOf, initialsOf } from './avatar';

describe('hueOf', () => {
  it('is FNV-1a over the id’s UTF-8 bytes, mod 6, in the spec’s order, so every app picks the same', () => {
    expect(HUES).toEqual(['blue', 'green', 'amber', 'rose', 'violet', 'slate']);
    // FNV-1a 32 of "" is 0x811c9dc5 = 2166136261, and 2166136261 mod 6 = 1.
    expect(hueOf('')).toBe('green');
    // "a": 0xe40c292c = 3826002220, mod 6 = 4.
    expect(hueOf('a')).toBe('violet');
  });
  it('is stable for a member, whatever else changes', () => {
    for (const id of ['u-test', 'dev', '9f1c2a3b-0000-4000-8000-0123456789ab', 'Ünïcödé']) expect(hueOf(id)).toBe(hueOf(id));
  });
  it('spreads members over all six tints', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i += 1) {
      const h = hueOf(`u-${i.toString(36)}-member`);
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...HUES].sort());
    for (const n of counts.values()) expect(n).toBeGreaterThan(800);
  });
});

describe('initialsOf', () => {
  it('is the first letters of the first and last words, upper-cased', () => {
    expect(initialsOf('Dana Example')).toBe('DE');
    expect(initialsOf('riley van der mock')).toBe('RM');
    expect(initialsOf('  Sam  ')).toBe('S');
    expect(initialsOf('élodie Ørsted')).toBe('ÉØ');
  });
  it('keeps a letter with its accent, and skips words with no letter', () => {
    expect(initialsOf('émile Zola')).toBe('ÉZ');
    expect(initialsOf('Dana (Example) 2')).toBe('DE');
  });
  it('falls back to the email’s local part, and then to nothing', () => {
    expect(initialsOf(null, 'dana.example@example.org')).toBe('DE');
    expect(initialsOf('', 'member-1@example.org')).toBe('M');
    expect(initialsOf(undefined, '123@example.org')).toBe('');
    expect(initialsOf(null, null)).toBe('');
  });
});

describe('the profile picture (acct-picture)', () => {
  const ok = 'https://api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxyz'.replace('abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26));
  it('takes only the Platform public avatar route over https', async () => {
    const { pictureUrlOf } = await import('./avatar');
    expect(pictureUrlOf(ok)).toBe(ok);
    for (const bad of [null, undefined, 3, '', 'http://api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxyz', 'data:image/png;base64,AAAA', 'blob:https://x/1', 'https://api.example.test/other.png', `${ok}?x=1`, `${ok}#x`, 'https://u:p@api.example.test/v1/public/avatars/im_abcdefghijklmnopqrstuvwxyz', 'https://api.example.test/v1/public/avatars/im_short'])
      expect(pictureUrlOf(bad)).toBeNull();
  });
  it('reads avatarUrl, else an upload avatar, and ignores unknown kinds', async () => {
    const { pictureOf } = await import('./avatar');
    expect(pictureOf({ avatarUrl: ok })).toBe(ok);
    expect(pictureOf({ avatarUrl: null, avatar: { kind: 'upload', url: ok } })).toBe(ok);
    expect(pictureOf({ avatar: { kind: 'built', config: { kind: 'built', kit: 1 }, url: ok } })).toBeNull();
    expect(pictureOf(null)).toBeNull();
  });
});

describe('the built avatar (acct-avatar)', () => {
  const recipe = { kind: 'built', kit: 1, skin: 4, face: 'smile', hair: 'wavy', extras: ['freckles'] };
  const built = (config: unknown) => ({ avatar: { kind: 'built', config, setAt: '2026-11-09T10:00:00Z' } });
  it('takes a plain built kit-1 recipe', async () => {
    const { builtRecipeOf } = await import('./avatar');
    expect(builtRecipeOf(built(recipe))).toEqual(recipe);
    expect(builtRecipeOf(built({ kind: 'built', kit: 1 }))).toEqual({ kind: 'built', kit: 1 });
  });
  it('is null for anything else, so the initials show', async () => {
    const { builtRecipeOf } = await import('./avatar');
    const big = { ...recipe, extras: Array.from({ length: 100 }, () => 'freckles') };
    for (const bad of [null, undefined, 'x', 3, [], [recipe], { ...recipe, kind: 'upload' }, { ...recipe, kind: undefined }, { ...recipe, kit: 2 }, { ...recipe, kit: '1' }, { skin: 4 }, big, Object.create({ kind: 'built', kit: 1 })])
      expect(builtRecipeOf(built(bad))).toBeNull();
    expect(builtRecipeOf(null)).toBeNull();
    expect(builtRecipeOf({})).toBeNull();
    expect(builtRecipeOf({ avatar: null })).toBeNull();
    expect(builtRecipeOf({ avatar: { kind: 'upload', url: 'https://x', config: recipe } })).toBeNull();
    expect(builtRecipeOf({ avatar: 'built' })).toBeNull();
  });
  it('allows 600 bytes and not 601', async () => {
    const { builtRecipeOf, BUILT_MAX_BYTES } = await import('./avatar');
    const base = { kind: 'built', kit: 1, face: '' };
    const pad = BUILT_MAX_BYTES - JSON.stringify(base).length;
    expect(builtRecipeOf(built({ ...base, face: 'x'.repeat(pad) }))).not.toBeNull();
    expect(builtRecipeOf(built({ ...base, face: 'x'.repeat(pad + 1) }))).toBeNull();
  });
  it('renders through the lazy kit as a data: image, cached, at each size', async () => {
    const { builtAvatarSrc } = await import('./avatarKit');
    const a = await builtAvatarSrc(recipe, 32);
    expect(a).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(a!.split(',')[1]!)).toMatch(/^<svg[^>]*width="32"/);
    expect(await builtAvatarSrc(recipe, 32)).toBe(a);
    expect(await builtAvatarSrc(recipe, 40)).not.toBe(a);
  });
});
