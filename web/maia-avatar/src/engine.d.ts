// Types for the parts of engine.js that avatar.ts uses. The engine itself stays the reference's JavaScript.

// DANCE: `routine` while she dances.
export type EngineState = 'score' | 'thinking' | 'speaking' | 'unavailable' | 'falling' | 'sleeping' | 'waking' | 'routine';
export type ThemeName = 'light' | 'dusk' | 'dark';
export type Tier = 'sm' | 'md' | 'lg';

/** A beat as compileScore reads it. score.ts's beats have these fields and a track. */
export interface ParsedLike {
  mood: string;
  rhythm: string;
  seconds: number;
  beats: readonly { t: number; do: string; level: number }[];
  notes: string[];
  /** DANCE: a routine she performs once, by name, before the score plays on. */
  routine?: string | undefined;
}

export interface Compiled {
  mood: string;
  rhythm: string;
  seconds: number;
  cycles: number;
  notes: string[];
  seed: number;
  routine?: string;
}

export interface AvatarOpts {
  size: number;
  dpr?: number;
  tier?: Tier;
  reduced?: boolean;
  textSide?: 1 | -1;
  seed?: number;
  theme?: ThemeName;
  backing?: number;
  noNoise?: boolean;
}

export class Avatar {
  constructor(canvas: HTMLCanvasElement | null, opts: AvatarOpts);
  readonly tier: Tier;
  readonly rig: Rig;
  state: EngineState;
  reduced: boolean;
  dormant: boolean;
  sleepClock: number;
  frames: number;
  t: number;
  scoreT: number;
  loop: number;
  // What a frame is drawn from. avatar.ts reads and writes these to draw between steps.
  hl: Float64Array;
  il: Float64Array;
  sp: Float64Array;
  ip: Float64Array;
  h: Float64Array;
  ih: Float64Array;
  m: Float64Array;
  E: Float64Array;
  gx: number;
  gy: number;
  /** DANCE: how far her winking eye has closed, 0 to 1. Drawn from, like `E`. */
  wk: number;
  /** DANCE: the routine playing, or null. */
  ro: CompiledRoutine | null;
  /** DANCE: the channels a routine and the moves ask for this step. */
  RV: Float64Array;
  beat(name: string, level: number): void;
  setTheme(name: ThemeName): void;
  setRate(cps: number): void;
  setStreamMode(on: boolean): void;
  setReduced(on: boolean): void;
  setState(name: 'calm' | 'thinking' | 'speaking' | 'unavailable' | 'sleeping' | 'waking'): void;
  setMood(name: string): void;
  setRhythm(name: string): void;
  playCompiled(c: Compiled): void;
  fallAsleep(): void;
  settleAsleep(): void;
  wake(): void;
  snap(): void;
  step(): void;
  draw(): boolean;
  drawStill(): void;
  buildPaths(): boolean;
  paint(ctx: CanvasRenderingContext2D, grad: CanvasGradient, width: number): void;
}

export interface Rig {
  readonly tier: Tier;
  readonly inner: unknown;
}

export interface SleepStrip {
  canvas: HTMLCanvasElement;
  frames: number;
  cell: number;
  halfS: number;
}

/** DANCE: a routine as the engine compiles it from src/art/routine.json. */
export interface CompiledRoutine {
  readonly bps: number;
  readonly lead: number;
  readonly seconds: number;
}

export function compileScore(parsed: ParsedLike | null): Compiled;
export function makeSleepStrip(o: { size: number; dpr: number; theme: ThemeName; frames: number }): SleepStrip;
export function tierFor(px: number): Tier;
export function backingScale(px: number, dpr: number): number;
export const DT: number;
export const VOCAB: {
  stage: { launcherPx: number; scale: number };
  states: { sleeping: { stripFrames: number; cycle: number; fallS: number } };
  moods: Record<string, unknown>;
  rhythms: Record<string, unknown>;
  beats: Record<string, { track: string; dur: number[] }>;
  /** DANCE */
  routines: Record<string, { bpm: number; beats: number; settle: string }>;
  dance: { channels: string[]; leadS: number; yawDepth: number; winkSide: number };
};
/** DANCE: the routines she knows, compiled. */
export const ROUTINES: ReadonlyMap<string, CompiledRoutine>;
export const internal: {
  spineFrom(rig: Rig, h: Float64Array, sp: Float64Array): void;
  walk(rig: unknown, h: Float64Array, sp: Float64Array, x: number, y: number): void;
  [name: string]: unknown;
};
