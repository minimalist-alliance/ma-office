// score.ts and its vectors are the AI Engineer's, copied unchanged from ma-platform (docs/contracts/maia-score.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { makeParser } from '../../src/score.js';
import type { Score, Vocabulary } from '../../src/score.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url));
/** git's blob id, so the copy can be checked against ma-platform's history without a clone. */
const blob = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

// DANCE: 6bee406 adds the optional `routine` (the AI Engineer, "Maia's dance"). The vectors are unchanged since 7d32c0d.
test('src/score.ts is ma-platform services/maia/src/score.ts at 6bee406, byte for byte', () => {
  expect(blob(read('../../src/score.ts'))).toBe('cf2f2f44f662dc966047939972cdd08a4c9037bc');
});

test('tests/maia-score-vectors.json is ma-platform docs/contracts/maia-score-vectors.json at 7d32c0d', () => {
  expect(blob(read('./maia-score-vectors.json'))).toBe('b468be044e2e7aafc510bf54541efb3acea89a73');
});

const file = JSON.parse(read('./maia-score-vectors.json').toString('utf8')) as {
  testFixtureVocabulary: Vocabulary;
  vectors: { name: string; input: unknown; expected: Score | null }[];
};
const parse = makeParser(file.testFixtureVocabulary);

describe('the contract vectors', () => {
  test('there are at least 40, with unique names', () => {
    expect(file.vectors.length).toBeGreaterThanOrEqual(40);
    expect(new Set(file.vectors.map((v) => v.name)).size).toBe(file.vectors.length);
  });
  for (const v of file.vectors) {
    test(v.name, () => {
      expect(parse(v.input)).toStrictEqual(v.expected);
      if (typeof v.input !== 'string') expect(parse(JSON.stringify(v.input))).toStrictEqual(v.expected);
    });
  }
});
