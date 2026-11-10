// The package's parseScore is makeParser(vocabulary), as docs/contracts/maia-score.md says, with score.ts unchanged.
// The vocabulary's words and tracks come from the engine's own copy, in the order vocabulary.json lists them.
// Descriptions are for the model and play no part in parsing, so the browser bundle doesn't carry them: each word
// stands for its own description. tests/parse.test.ts checks the words and tracks against vocabulary.json, and
// that this parser gives the same answer as makeParser(vocabulary.json) on every vector and on fuzzed scores.
//
// DANCE: score.ts carries an optional `routine` (groove, party or swim). The engine knows only the routines in
// src/art/routine.json, so any other is dropped here, as the contract says an engine that doesn't know it does.
import { ROUTINES, VOCAB } from './engine.js';
import { makeParser } from './score.js';
import type { Score, Vocabulary } from './score.js';

const words = (table: object) => Object.keys(table).map((name) => ({ name, description: name }));

/** vocabulary.json's three lists, without the prose. */
export const vocabulary: Vocabulary = {
  moods: words(VOCAB.moods),
  rhythms: words(VOCAB.rhythms),
  beats: Object.entries(VOCAB.beats).map(([name, b]) => ({ name, track: b.track, description: name })),
};

const contract = makeParser(vocabulary);

/** Any value or JSON text in, a clean score or null out. Null means play `calm`. Never throws. */
export function parseScore(input: unknown): Score | null {
  const score = contract(input);
  if (!score || score.routine === undefined || ROUTINES.has(score.routine)) return score;
  return { v: score.v, mood: score.mood, rhythm: score.rhythm, seconds: score.seconds, beats: score.beats };
}
