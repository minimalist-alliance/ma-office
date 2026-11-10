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
