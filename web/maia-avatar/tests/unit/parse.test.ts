// The package's parseScore: makeParser over version 7's words and tracks. Its descriptions are the words themselves,
// which can't change an answer, so it must agree with makeParser(vocabulary.json) on everything.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseScore, vocabulary } from '../../src/parse.js';
import { makeParser } from '../../src/score.js';
import type { Vocabulary } from '../../src/score.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const full = read('../../src/art/vocabulary.json') as Vocabulary & Record<string, unknown>;
const real = makeParser(full);
const vectors = (read('./maia-score-vectors.json') as { vectors: { input: unknown }[] }).vectors;

test("its words and tracks are vocabulary.json's, in the same order", () => {
  const strip = (l: readonly { name: string; track?: string }[]) => l.map((e) => ('track' in e ? { name: e.name, track: e.track } : { name: e.name }));
  expect(strip(vocabulary.moods)).toEqual(strip(full.moods));
  expect(strip(vocabulary.rhythms)).toEqual(strip(full.rhythms));
  expect(strip(vocabulary.beats)).toEqual(strip(full.beats));
  expect(vocabulary.moods.map((m) => m.name)).toEqual(['calm', 'warm', 'curious', 'focused', 'gentle', 'bright']);
});

test('the example score from the motion spec parses, with each beat on its track', () => {
  expect(parseScore('{"v":1,"mood":"warm","rhythm":"breath","seconds":24,"beats":[{"t":1,"do":"wave","level":2}]}')).toEqual(
    { v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [{ t: 1, do: 'wave', level: 2, track: 'hair' }] });
});

test("it gives makeParser(vocabulary.json)'s answer on every contract vector", () => {
  for (const v of vectors) expect(parseScore(v.input)).toStrictEqual(real(v.input));
});

test("it gives makeParser(vocabulary.json)'s answer on 5,000 seeded random scores", () => {
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = <T>(l: readonly T[]): T => l[Math.floor(rand() * l.length)]!;
  const words = [...full.moods, ...full.rhythms, ...full.beats].map((e) => e.name).concat(['dance', '__proto__', 'toString', '', 'CALM', 'calm ']);
  const numbers = [0, -1, 1, 2, 3, 2.5, 0.4, 19, 20, 24, 30, 31, 1e308, -0, Number.NaN, Infinity, 1e-9];
  const odd = () => pick<unknown>([null, true, 'x', '24', [], {}, pick(numbers)]);
  let some = 0;
  for (let i = 0; i < 5000; i += 1) {
    const beats = Array.from({ length: Math.floor(rand() * 16) }, () => {
      const b: Record<string, unknown> = { t: rand() < 0.9 ? rand() * 34 - 2 : odd(), do: rand() < 0.85 ? pick(words) : odd() };
      if (rand() < 0.8) b['level'] = rand() < 0.8 ? pick(numbers) : odd();
      if (rand() < 0.1) b['track'] = 'eyes';
      return b;
    });
    const score: Record<string, unknown> = { v: rand() < 0.95 ? 1 : odd(), mood: rand() < 0.9 ? pick(words) : odd(), rhythm: rand() < 0.9 ? pick(words) : odd(), seconds: rand() < 0.9 ? 15 + rand() * 20 : odd(), beats: rand() < 0.95 ? beats : odd() };
    if (rand() < 0.1) score['extra'] = { script: 'x' };
    const input = rand() < 0.5 ? JSON.stringify(score) : score;
    const a = parseScore(input);
    expect(a).toStrictEqual(real(input));
    if (a) some += 1;
  }
  expect(some).toBeGreaterThan(1000);
});
