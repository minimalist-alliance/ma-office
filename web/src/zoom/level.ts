// An app's own zoom (ADR 0055): the levels, the steps, and how a wheel or a pinch turns into steps. Pure, so the rules are
// tested on their own (`level.test.ts`); the store, the button and the handler are beside it in the zoom chunk.
import { isAgentApp } from '../canvas/layout';

export const MIN_LEVEL = 50;
export const MAX_LEVEL = 200;
export const STEP = 10;
export const DEFAULT_LEVEL = 100;

/** A level as deskd or a stored copy has it, made a whole percent in range. Anything else is 100. */
export function clampLevel(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_LEVEL;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(n)));
}

/** On the slider's grid (10 % steps), as the office's own levels always are. */
export const snapLevel = (n: unknown): number => clampLevel(Math.round(clampLevel(n) / STEP) * STEP);

/**
 * `steps` 10 % steps from `level`, held to 50..200. A level off the grid (the desk Browser's own, after a key chord the page
 * took: 67, 75, 125, 175) goes to the grid first, in the step's direction: 67 up is 70, down is 60.
 */
export function stepLevel(level: number, steps: number): number {
  if (!steps) return clampLevel(level);
  const from = clampLevel(level);
  const onGrid = from % STEP === 0;
  const base = onGrid ? from : steps > 0 ? Math.floor(from / STEP) * STEP : Math.ceil(from / STEP) * STEP;
  return clampLevel(base + steps * STEP);
}

/** What a level says, for the button's name, the slider's `aria-valuetext` and the reset. */
export const levelWords = (level: number): string => `${clampLevel(level)}%`;

/**
 * Apps that don't zoom yet, and so have no button: Commons' board sizes its canvas from its box on screen, so under CSS zoom
 * it draws at twice its size at 200 % and its pointer lands in the wrong place (`apps/commons/web/src/board/engine.ts`,
 * the Guild Engineer's). Until it's laid out in its own pixels, Commons stays at 100 %.
 */
export const NO_ZOOM: ReadonlySet<string> = new Set(['commons']);

/**
 * Which level an app shares: every agent is the Agent app (task 49's windows), so all of them take one; a desk app (ADR 0054)
 * is its own app id; every other app its id.
 */
export const zoomKey = (app: string): string => (isAgentApp(app) ? 'agent' : app);

/** A stored key the office would write: an app id, `agent` or a desk app's `app:<id>`. Nothing else is read back. */
const KEY = /^[a-z][a-z0-9._:-]{0,95}$/;
/** At most this many apps are kept: desk apps come and go. The oldest go first. */
export const MAX_KEPT = 64;

/** A stored copy, read back: only apps the office would write, only levels on the grid that aren't 100. */
export function readLevels(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY.test(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const level = snapLevel(value);
    if (level !== DEFAULT_LEVEL) out[key] = level;
    if (Object.keys(out).length >= MAX_KEPT) break;
  }
  return out;
}

/** `levels` with `key` at `level`: 100 isn't kept, a changed key goes last, and past `MAX_KEPT` the oldest go. */
export function withLevel(levels: Record<string, number>, key: string, level: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(levels)) if (k !== key) next[k] = v;
  if (level !== DEFAULT_LEVEL) next[key] = level;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_KEPT))) delete next[k];
  return next;
}

// ----- the wheel and the pinch

/** A pinch's wheel deltas (CSS px) to one 10 % step: the camera's own pinch rate (`camera.ts` `wheelZoomFactor`, 0.012). */
export const PINCH_STEP_PX = Math.log(1.1) / 0.012;
/** A held key's wheel to one step: a trackpad's scroll adds up to it, and a mouse's notch (100 px or more) is one step. */
export const KEY_STEP_PX = 50;
/** A gap this long starts a new gesture: what was added up goes. */
export const GESTURE_GAP_MS = 400;

/**
 * Adds up one app's wheel deltas (CSS px, down positive) into 10 % steps, up for in. At most one step per event, so a fast
 * flick can't run away; a held key's wheel starts afresh after each step (a mouse's notch is one step, never two), and a
 * pinch keeps what's left over, so a slow one steps evenly. A change of direction or a pause starts afresh.
 */
export class WheelZoom {
  private sum = 0;
  private last = -Infinity;

  /** Steps to take now: 1 (in), -1 (out) or 0. */
  add(dy: number, pinch: boolean, now: number): number {
    if (!Number.isFinite(dy) || dy === 0) return 0;
    if (now - this.last > GESTURE_GAP_MS || Math.sign(dy) !== Math.sign(this.sum)) this.sum = 0;
    this.last = now;
    this.sum += dy;
    const per = pinch ? PINCH_STEP_PX : KEY_STEP_PX;
    if (Math.abs(this.sum) < per) return 0;
    const dir = this.sum > 0 ? -1 : 1;
    this.sum = pinch ? Math.max(-per, Math.min(per, this.sum + dir * per)) : 0;
    // Left over from a pinch, but never a step's worth: the next event decides.
    if (Math.abs(this.sum) >= per) this.sum = Math.sign(this.sum) * (per - 1e-6);
    return dir;
  }

  reset(): void {
    this.sum = 0;
    this.last = -Infinity;
  }
}
