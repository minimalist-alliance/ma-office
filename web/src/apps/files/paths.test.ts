import { describe, expect, it } from 'vitest';
import { byteLength, compareEntries, crumbs, freeName, isUnder, listingTouched, join, nameProblem, nfc, parent, baseName } from './paths';

describe('the path grammar (files.md section 0)', () => {
  it('names: empty, dots, control characters, a backslash, a slash, bidi overrides, 255 bytes, and the two reserved at the root', () => {
    expect(nameProblem('')).toBe('empty');
    expect(nameProblem('.')).toBe('dots');
    expect(nameProblem('..')).toBe('dots');
    for (const bad of ['a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\\b', 'a/b', 'a‮b', 'a⁧b']) expect(nameProblem(bad)).toBe('chars');
    expect(nameProblem('a'.repeat(255))).toBeNull();
    expect(nameProblem('a'.repeat(256))).toBe('length');
    expect(nameProblem('é'.repeat(128))).toBe('length'); // 256 bytes in UTF-8
    expect(nameProblem('.uploads', true)).toBe('reserved');
    expect(nameProblem('.trash', true)).toBe('reserved');
    expect(nameProblem('.uploads')).toBeNull(); // anywhere but the root it is an ordinary name
    expect(nameProblem('.hidden')).toBeNull();
    expect(nameProblem('Café notes 🎉.txt')).toBeNull();
  });

  it('NFC: a decomposed name is made composed before it is sent', () => {
    const decomposed = 'Café';
    expect(decomposed).not.toBe(nfc(decomposed));
    expect(byteLength(nfc(decomposed))).toBe(5);
  });

  it('join, parent, base name, under and the breadcrumbs', () => {
    expect(join('', 'a')).toBe('a');
    expect(join('a/b', 'c')).toBe('a/b/c');
    expect(parent('a/b/c')).toBe('a/b');
    expect(parent('a')).toBe('');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(isUnder('a/b/c', 'a/b')).toBe(true);
    expect(isUnder('a/b', 'a/b')).toBe(false);
    expect(isUnder('a/bc', 'a/b')).toBe(false);
    expect(isUnder('x', '')).toBe(true);
    expect(crumbs('a/b')).toEqual([{ name: '', path: '' }, { name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }]);
  });

  it('sorts as deskd does: folders first, then case-folded name, then bytes', () => {
    const list = [
      { name: 'b.txt', type: 'file' },
      { name: 'Zeta', type: 'dir' },
      { name: 'B.txt', type: 'file' },
      { name: 'alpha', type: 'dir' },
    ];
    expect([...list].sort(compareEntries).map((e) => e.name)).toEqual(['alpha', 'Zeta', 'B.txt', 'b.txt']);
  });

  it('a taken name becomes "name (2).ext"', () => {
    const taken = new Set(['a.txt', 'a (2).txt']);
    expect(freeName('a.txt', (c) => taken.has(c))).toBe('a (3).txt');
    expect(freeName('b', () => false)).toBe('b');
    expect(freeName('.env', (c) => c === '.env')).toBe('.env (2)');
  });
});

describe('listingTouched', () => {
  it('a change in a folder below changes the listing above it, since the row for the folder may be new', () => {
    expect(listingTouched(['Trip/Day 1'], '')).toBe(true);
    expect(listingTouched(['Trip/Day 1'], 'Trip')).toBe(true);
    expect(listingTouched(['Trip'], 'Trip')).toBe(true);
    expect(listingTouched([''], '')).toBe(true);
    expect(listingTouched(['Trip/Day 1'], 'Trip/Day 1')).toBe(true);
  });
  it('and a change beside or above it does not', () => {
    expect(listingTouched(['Photos'], 'Trip')).toBe(false);
    expect(listingTouched(['Trip2'], 'Trip')).toBe(false);
    expect(listingTouched([''], 'Trip')).toBe(false);
    expect(listingTouched([], '')).toBe(false);
  });
});
