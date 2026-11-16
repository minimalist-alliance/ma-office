// The welcome's score: the key, the levels, the motif variants and the rules that pick what plays (CONCEPT.md §7.1). Pure data
// and pure functions, so the rules are tested without any audio. Every sound is written in code; nothing here is a sample.

/** A note's frequency from its MIDI number (A4 = 69 = 440 Hz). */
export const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** Decibels to a gain. */
export const db = (d: number): number => 10 ** (d / 20);

/**
 * The levels, in one place (README "Levels"). Gains are each voice's peak before the master limiter, at volume 1. With every
 * layer sounding they put the music at about -24 LUFS short-term (L0 and L1 alone about -26.5; the arithmetic is in the README).
 * The hero's swell peaks about 3 dB over the music (momentary), and the limiter's ceiling keeps any peak at or under -1 dBTP.
 */
export const LEVEL = {
  air: db(-26), // L0: the noise bed's gain (white noise is about -5 dBFS RMS, band-passed to about -11)
  airSway: 0.3, // the air's slow breathing, as a share of its level
  pad: db(-28), // L1: each of the dyad's two notes, sine; its triangle partial is a third of that
  motif: db(-20), // L2: a pluck's peak
  glass: db(-30), // L3: a glass note's peak
  low: db(-25), // L4: the low sine's sustain
  cadence: db(-28), // the cadence's chord notes; its plucks use `motif`
  hero: db(-26), // each of the hero chord's five notes at its peak
  duck: db(-10), // the music under a voice (a seam: no voice at launch)
} as const;

/** The master limiter: a hard knee near the top, so its ceiling is about -1 dBFS with its own make-up gain (README). */
export const LIMITER = { threshold: -2.6, knee: 0, ratio: 20, attack: 0.002, release: 0.25 } as const;

/** Every fade, in seconds. */
export const FADE = {
  in: 4, // from silence at the press
  hidden: 2, // the tab hidden, out and back
  pause: 0.4, // the flow's Pause, out (back in over `hidden`)
  stop: 1.5,
  mute: 0.08,
  volume: 0.05,
  music: 0.8,
  duckIn: 0.15,
  duckOut: 0.8,
  layerIn: 1.5, // a layer's bus coming up
  heroOut: 0.8, // everything else, under the hero
} as const;

/** L1 begins this long after the press; L0 is there from the start. */
export const PAD_DELAY = 4;

// One key throughout: D major, with no fourth in the music itself (it only passes through the cadence), so nothing leans.
/** The motif's notes: D4 E4 F#4 A4 B4 C#5 D5 E5 F#5 A5. */
export const MOTIF_NOTES = [62, 64, 66, 69, 71, 73, 74, 76, 78, 81] as const;
/** L1's two-note sustains: D3-A3, F#3-C#4, B2-F#3, A2-E3, D3-F#3, E3-A3. */
export const DYADS = [[50, 57], [54, 61], [47, 54], [45, 52], [50, 54], [52, 57]] as const;
/** L3's glass notes: D6 A5 C#6 E6 F#6 B5. */
export const GLASS_NOTES = [86, 81, 85, 88, 90, 83] as const;
/** L4's low notes: D2 most of the time, A1 and B1 now and then. */
export const LOW_NOTES = [38, 38, 33, 35] as const;
/** The hero chord, spread and glassy: D4 A4 E5 F#5 C#6. */
export const HERO_CHORD = [62, 69, 76, 78, 85] as const;
/** The cadence: a G major ninth leaning into D, with a pluck line B4 A4 F#4 E4 D4 landing on the resolution. */
export const CADENCE = {
  lean: [55, 59, 66, 69],
  home: [50, 57, 64, 66],
  line: [71, 69, 66, 64, 62],
  at: [0.04, 0.18, 0.32, 0.44, 0.55], // each pluck, as a share of the phrase
  resolve: 0.55, // where the home chord lands
  glass: 86,
} as const;

/** One motif: notes as [index into MOTIF_NOTES, seconds from its start]. */
export type Motif = readonly (readonly [note: number, at: number])[];

/** The twelve motif variants: 3 to 5 notes each, no hook, none a copy of another. */
export const MOTIFS: readonly Motif[] = [
  [[3, 0], [4, 0.9], [6, 1.6]],
  [[6, 0], [5, 0.8], [3, 1.7], [2, 2.9]],
  [[2, 0], [3, 0.7], [7, 1.5]],
  [[4, 0], [6, 1.0], [8, 1.8], [7, 3.0]],
  [[0, 0], [3, 0.8], [5, 1.5], [6, 2.6]],
  [[7, 0], [6, 0.9], [4, 2.0]],
  [[3, 0], [2, 0.6], [3, 1.4], [6, 2.5], [5, 3.4]],
  [[8, 0], [7, 0.8], [5, 1.6], [3, 2.8]],
  [[1, 0], [3, 0.9], [6, 1.7]],
  [[5, 0], [3, 0.7], [4, 1.6], [2, 2.7]],
  [[6, 0], [8, 1.1], [9, 1.9], [7, 3.1]],
  [[2, 0], [4, 0.8], [3, 1.5], [1, 2.4], [0, 3.6]],
];

/** The phrase rules: 8 to 12 s of sound, then 2 to 6 s of real silence (only the air under it). */
export const PHRASE = { min: 8, max: 12, restMin: 2, restMax: 6 } as const;
/** A motif comes every 20 to 40 s, at most this far into a phrase. */
export const MOTIF_GAP = { min: 20, max: 40, offsetMin: 1, offsetMax: 2 } as const;
/** The cadence's length, in seconds. */
export const CADENCE_LEN = { min: 6, max: 8 } as const;
/** The hero: the swell, then the decay to silence; the context closes just after. */
export const HERO = { swell: 0.9, decay: 1.8, close: 0.2 } as const;

const between = (r: number, lo: number, hi: number) => lo + (hi - lo) * r;

/** The next phrase's length and the silence after it. */
export function phrase(random: () => number): { len: number; rest: number } {
  return { len: between(random(), PHRASE.min, PHRASE.max), rest: between(random(), PHRASE.restMin, PHRASE.restMax) };
}

/**
 * Picks from `count` choices, never one of the last `memory` picks, so a short run never repeats. With twelve motifs and a memory
 * of three, nine are open each time.
 */
export function picker(count: number, memory: number, random: () => number): () => number {
  const recent: number[] = [];
  return () => {
    const open: number[] = [];
    for (let i = 0; i < count; i++) if (!recent.includes(i)) open.push(i);
    const pick = open[Math.min(open.length - 1, Math.floor(random() * open.length))] ?? 0;
    recent.push(pick);
    if (recent.length > memory) recent.shift();
    return pick;
  };
}

/**
 * Whether a phrase starting at `start` carries the motif (times in seconds). The first after the answer always does; after that
 * only once 20 s have passed since the last, and it must when waiting for the next phrase (which starts at `nextStart`) could
 * run past 40 s. Otherwise it's a coin, so the spacing wanders between the two.
 */
export function motifDue(start: number, nextStart: number, last: number | null, random: () => number): boolean {
  if (last === null) return true;
  if (start + MOTIF_GAP.offsetMin - last < MOTIF_GAP.min) return false;
  if (nextStart + MOTIF_GAP.offsetMax - last > MOTIF_GAP.max) return true;
  return random() < 0.5;
}

/** Where the cadence starts and how long it is, so that it ends at `end` (never before `now`). */
export function cadenceSpan(now: number, end: number): { start: number; len: number } {
  const len = Math.min(CADENCE_LEN.max, Math.max(0, end - now));
  return { start: end - len, len };
}

/** A seeded random (mulberry32), for the tests and for anyone who wants the same performance twice. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
