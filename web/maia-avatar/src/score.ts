// The score: what the model writes for one reply and the avatar performs (docs/maia.md §14, ADR 0083).
// It's untrusted model output, and this is the one way in. Contract: docs/contracts/maia-score.md.
// It uses only what the language itself provides, so the avatar package can copy this file unchanged.

export interface VocabularyEntry {
  name: string;
  /** What the model reads to choose this word. */
  description: string;
}

export interface BeatEntry extends VocabularyEntry {
  /** Which track the beat runs on. The engine uses it to keep beats on one track from colliding. */
  track: string;
}

/** The words a score may use. Data, not code, because the Product Designer tunes them. */
export interface Vocabulary {
  moods: readonly VocabularyEntry[];
  rhythms: readonly VocabularyEntry[];
  beats: readonly BeatEntry[];
}

export interface Beat {
  /** Seconds into the cycle: at least 0 and less than the score's `seconds`. */
  t: number;
  do: string;
  /** A whole number, 1 to 3. */
  level: number;
  /** Always from the vocabulary, never from the input. */
  track: string;
}

/** Her dances (the Product Designer's engine, `~/ma-design-drafts/preview-dance/`). The model never writes one: the server adds it. */
export const ROUTINES = ['groove', 'party', 'swim'] as const;
export type Routine = (typeof ROUTINES)[number];
export const isRoutine = (v: unknown): v is Routine => typeof v === 'string' && (ROUTINES as readonly string[]).includes(v);

export interface Score {
  v: 1;
  mood: string;
  rhythm: string;
  seconds: number;
  /** Sorted by `t`. Empty is valid: she holds the mood and rhythm, and the engine adds the blinks. */
  beats: Beat[];
  /** Optional: one dance, played once before the score settles. An unknown name is dropped, like any other field. */
  routine?: Routine;
}

export const SCORE_VERSION = 1;
/** 4 KB, in UTF-8 bytes rather than characters, so multi-byte text can't get past it. */
export const MAX_SCORE_BYTES = 4096;
export const MIN_SECONDS = 20;
export const MAX_SECONDS = 30;
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 3;
export const DEFAULT_LEVEL = 1;
export const MAX_BEATS = 12;
export const DEFAULT_MOOD = 'calm';
/** The ordinary loop, and clearly alive. `quiet` is smaller, a poor guess when the model's word is unknown. */
export const DEFAULT_RHYTHM = 'breath';

/** How far before the end a late beat lands, since `t` must stay under `seconds`. Well above float noise at 30. */
const LATE_BEAT_GAP = 0.001;
/** Rules out `__proto__` and markup, so a word is safe wherever the engine later uses it. */
const NAME_FORMAT = /^[a-z][a-z0-9_-]{0,63}$/;

interface Known {
  /** Maps, never `obj[name]`, so `__proto__` and `toString` are just unknown words. */
  moods: ReadonlyMap<string, string>;
  rhythms: ReadonlyMap<string, string>;
  /** Beat name to its track. */
  tracks: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `Number.isFinite` doesn't coerce, so `"24"` is invalid rather than 24. */
function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && NAME_FORMAT.test(value);
}

function readList(vocabulary: Record<string, unknown>, list: 'moods' | 'rhythms' | 'beats'): Map<string, string> {
  const entries = vocabulary[list];
  // An empty list would also be an empty enum, which the API refuses.
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`vocabulary.${list} must be a list with at least one entry`);
  const found = new Map<string, string>();
  entries.forEach((entry: unknown, i) => {
    const where = `vocabulary.${list}[${i}]`;
    if (!isRecord(entry)) throw new Error(`${where} must be an object`);
    const { name, description, track } = entry;
    if (!isName(name)) throw new Error(`${where}.name must match ${NAME_FORMAT}`);
    if (typeof description !== 'string' || description.trim() === '') throw new Error(`${where}.description must be text`);
    if (found.has(name)) throw new Error(`${where}.name repeats ${name}`);
    if (list !== 'beats') {
      found.set(name, name);
    } else if (isName(track)) {
      found.set(name, track);
    } else {
      throw new Error(`${where}.track must match ${NAME_FORMAT}`);
    }
  });
  return found;
}

/**
 * Throws on a malformed vocabulary: it's our own data, so a mistake should stop at startup rather
 * than play out as a silent `calm`. The fallbacks must exist, or a parsed score could name a word
 * the engine has no motion for. Copied into Maps, so later changes to the object change nothing.
 */
function readVocabulary(vocabulary: unknown): Known {
  if (!isRecord(vocabulary)) throw new Error('vocabulary must be an object');
  const known = {
    moods: readList(vocabulary, 'moods'),
    rhythms: readList(vocabulary, 'rhythms'),
    tracks: readList(vocabulary, 'beats'),
  };
  if (!known.moods.has(DEFAULT_MOOD)) throw new Error(`vocabulary.moods must include ${DEFAULT_MOOD}`);
  if (!known.rhythms.has(DEFAULT_RHYTHM)) throw new Error(`vocabulary.rhythms must include ${DEFAULT_RHYTHM}`);
  return known;
}

/** Counts UTF-8 bytes by hand, because TextEncoder isn't part of the language. Stops once over. */
function fitsSizeLimit(text: string): boolean {
  // Every UTF-16 unit is at least one byte, so a huge string ends here without being walked.
  if (text.length > MAX_SCORE_BYTES) return false;
  let bytes = 0;
  for (let i = 0; i < text.length && bytes <= MAX_SCORE_BYTES; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4; // A surrogate pair is one character.
      i++;
    } else {
      bytes += 3; // A lone surrogate counts as U+FFFD would.
    }
  }
  return bytes <= MAX_SCORE_BYTES;
}

/** Counts values as it goes, so a huge array or object stops here instead of being written out in full. */
function stringifyWithinLimit(input: unknown): string | undefined {
  let spent = 0;
  return JSON.stringify(input, (_key, value: unknown) => {
    spent += typeof value === 'string' ? value.length + 2 : 1;
    if (spent > MAX_SCORE_BYTES) throw new RangeError('score too large');
    return value;
  });
}

/**
 * Everything goes through JSON.parse, objects included. What comes out is plain data read once, so
 * getters, proxies, toJSON, cycles and inherited fields can't reach the checks below, and this
 * catch is the only place that input can make anything throw (a stack overflow is caught here too).
 */
function toPlainJson(input: unknown): unknown {
  try {
    const text = typeof input === 'string' ? input : stringifyWithinLimit(input);
    return text !== undefined && fitsSizeLimit(text) ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** A beat has no default time or name, so one without them is dropped. A bad level has a default. */
function readBeat(item: unknown, seconds: number, tracks: Known['tracks']): Beat | null {
  if (!isRecord(item)) return null;
  const { t, do: name, level } = item;
  if (typeof name !== 'string' || !isFiniteNumber(t)) return null;
  const track = tracks.get(name);
  if (track === undefined) return null;
  return {
    // Math.max also turns -0 into 0.
    t: t >= seconds ? seconds - LATE_BEAT_GAP : Math.max(0, t),
    do: name,
    // Rounds down, so a beat is never stronger than the model asked for.
    level: isFiniteNumber(level) ? clamp(Math.floor(level), MIN_LEVEL, MAX_LEVEL) : DEFAULT_LEVEL,
    track,
  };
}

/** Builds new objects from known keys only, so nothing else in the input can travel. */
function readScore(data: Record<string, unknown>, known: Known): Score | null {
  const { v, mood, rhythm, seconds, beats, routine } = data;
  if (v !== SCORE_VERSION) return null;
  if (typeof mood !== 'string' || typeof rhythm !== 'string') return null;
  if (!isFiniteNumber(seconds) || !Array.isArray(beats)) return null;

  // Seconds first, because a beat's limit is the clamped length.
  const length = clamp(seconds, MIN_SECONDS, MAX_SECONDS);
  const kept: Beat[] = [];
  for (const item of beats) {
    const beat = readBeat(item, length, known.tracks);
    if (beat) kept.push(beat);
  }

  const knownMood = known.moods.get(mood);
  const knownRhythm = known.rhythms.get(rhythm);
  // One known word is enough to perform. With none, the model said nothing we can use.
  if (knownMood === undefined && knownRhythm === undefined && kept.length === 0) return null;

  // Sorted after clamping and dropping, so the cap keeps the earliest beats that can actually play.
  kept.sort((a, b) => a.t - b.t);
  return {
    v: SCORE_VERSION,
    mood: knownMood ?? DEFAULT_MOOD,
    rhythm: knownRhythm ?? DEFAULT_RHYTHM,
    seconds: length,
    beats: kept.slice(0, MAX_BEATS),
    ...(isRoutine(routine) ? { routine } : {}),
  };
}

/**
 * Returns the parser for this vocabulary. It takes an object or a JSON string and returns a clean
 * score, or null when the caller should play `calm`. It never throws on input, only here, on a
 * malformed vocabulary. Collisions on a track and the end of the cycle are the engine's, since they
 * depend on beat durations.
 */
export function makeParser(vocabulary: Vocabulary): (input: unknown) => Score | null {
  const known = readVocabulary(vocabulary);
  return (input) => {
    const data = toPlainJson(input);
    return isRecord(data) ? readScore(data, known) : null;
  };
}

/**
 * The JSON Schema for structured outputs. The API can't enforce number ranges or array lengths, so
 * the ranges are only described here for the model, and the parser is what enforces them. Every
 * property is required, `level` included, with its 1 to 3 as an enum (enum is supported, and
 * `minimum` isn't). The model always writes a level, and the parser's default is for other sources.
 */
export function scoreJsonSchema(vocabulary: Vocabulary): Record<string, unknown> {
  const known = readVocabulary(vocabulary);
  return {
    type: 'object',
    properties: {
      v: { type: 'integer', const: SCORE_VERSION },
      mood: { type: 'string', enum: [...known.moods.keys()] },
      rhythm: { type: 'string', enum: [...known.rhythms.keys()] },
      seconds: { type: 'number', description: `Length of one cycle in seconds, ${MIN_SECONDS} to ${MAX_SECONDS}.` },
      beats: {
        type: 'array',
        description: `At most ${MAX_BEATS} beats, earliest first.`,
        items: {
          type: 'object',
          properties: {
            t: { type: 'number', description: 'Seconds into the cycle: 0 or more, and less than seconds.' },
            do: { type: 'string', enum: [...known.tracks.keys()] },
            level: { type: 'integer', enum: [1, 2, 3] },
          },
          required: ['t', 'do', 'level'],
          additionalProperties: false,
        },
      },
    },
    required: ['v', 'mood', 'rhythm', 'seconds', 'beats'],
    additionalProperties: false,
  };
}
