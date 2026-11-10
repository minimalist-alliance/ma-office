// createAvatar: version 7's engine on a canvas, with everything around it that the engine leaves to its caller.
// - Frames: the engine steps at exactly 1/30 s, as approved. Each display frame, up to 60 a second, draws her
//   between the last two steps, so every step's pose is drawn as the engine made it and the frames between are
//   blends of two of them. During a desk stream she draws every second step, 15 a second, as the spec says.
// - Sleep: after sleepAfterMs without use (5 minutes by default) she falls asleep, then breathes from the
//   engine's bitmap strip, played by the compositor. The render loop stops.
// - No frames while asleep, paused, settled, off screen or in a hidden tab.
// - DANCE: the blend carries her wink, and never blends her across the mirror of a turn (see between()).

import { Avatar, DT, ROUTINES, VOCAB, compileScore, internal, makeSleepStrip } from './engine.js';
import type { EngineState, SleepStrip, ThemeName } from './engine.js';
import { IdleClock, sleepAfter } from './idle.js';
import type { IdleTimers } from './idle.js';
import * as loop from './loop.js';
import { parseScore } from './parse.js';
import { DEFAULT_RHYTHM } from './score.js';
import type { Score } from './score.js';

export type Theme = ThemeName;
export const THEMES: readonly Theme[] = ['light', 'dusk', 'dark'];

/** What the app can ask for. `calm` is the default mood with no score; `sleeping` puts her to sleep now. */
export type AvatarState = 'calm' | 'thinking' | 'speaking' | 'unavailable' | 'sleeping';

/** Where she is. `score` is awake, playing the last score or `calm`. */
export type { EngineState };

export interface AvatarOptions {
  theme?: Theme;
  /** Her canvas's size in CSS px: the bubble. She's drawn at 76% of it. Default: the canvas's laid-out width, or 64. */
  size?: number;
  /** Fixed on or off. Left out, she follows `prefers-reduced-motion` as it changes. */
  reducedMotion?: boolean;
  /** Time without use before she falls asleep. Default 300000 (5 minutes), or `animation.sleepAfterSec * 1000`. */
  sleepAfterMs?: number;
  /** Hover, a press or focus here counts as use, and wakes her. Usually her widget. */
  activityTarget?: Element | null;
  /** Which side of her the text is on: 1 for her right as you look at her, -1 for her left. */
  textSide?: 1 | -1;
  /** Device pixel ratio for the backing store. Default `devicePixelRatio`, at most 3. */
  dpr?: number;
  /** @internal Tests only: timers for the sleep clock. */
  timers?: IdleTimers;
}

export interface MaiaAvatar {
  readonly state: EngineState;
  readonly paused: boolean;
  /** Counters for tests and perf: frames drawn and engine steps. */
  readonly stats: { readonly frames: number; readonly steps: number };
  setState(state: AvatarState): void;
  /** Parses with `parseScore` and plays the result, or `calm` when it's null. Returns what was parsed.
   * DANCE: a score's `routine` plays once first. */
  playScore(input: unknown): Score | null;
  /** DANCE: she dances the named routine once, then settles into its mood. With no name, the one she knows, so a new
   * dance needs no change here. Under reduced motion or a desk stream she smiles instead. False, and nothing happens,
   * for a name she doesn't know. */
  playRoutine(name?: string): boolean;
  /** She was used: wakes her if she's asleep, and starts the sleep clock again. */
  wake(): void;
  /** Stops all motion and shows her rest pose, eyes open (WCAG 2.2.2). */
  pause(): void;
  resume(): void;
  setTheme(theme: Theme): void;
  /** Characters a second while text streams, for `speaking`. */
  setRate(charsPerSecond: number): void;
  /** While a desk stream plays: 15 frames a second, with beats drawn out (spec, "Performance"). */
  setStreamMode(on: boolean): void;
  destroy(): void;
}

const MAX_STEPS = 3; // a longer stall slows her down rather than jumping, as in the reference page
const MIN_FRAME_MS = 10; // every frame at 60 Hz, every other at 120 Hz
const SLEEP = VOCAB.states.sleeping;
const strips = new Map<string, SleepStrip>();

/** What a frame is drawn from, after one step. */
export class Pose {
  readonly hl = new Float64Array(10);
  readonly il = new Float64Array(10);
  readonly sp = new Float64Array(22);
  readonly ip = new Float64Array(22);
  readonly m = new Float64Array(6);
  readonly E = new Float64Array(5);
  gx = 0;
  gy = 0;
  /** DANCE: her wink, an eye number like `E`. */
  wk = 0;
  take(av: Avatar): void {
    this.hl.set(av.hl); this.il.set(av.il); this.sp.set(av.sp); this.ip.set(av.ip); this.m.set(av.m); this.E.set(av.E);
    this.gx = av.gx; this.gy = av.gy; this.wk = av.wk;
  }
  give(av: Avatar): void {
    av.hl.set(this.hl); av.il.set(this.il); av.sp.set(this.sp); av.ip.set(this.ip); av.m.set(this.m); av.E.set(this.E);
    av.gx = this.gx; av.gy = this.gy; av.wk = this.wk;
  }
  copy(o: Pose): void {
    this.hl.set(o.hl); this.il.set(o.il); this.sp.set(o.sp); this.ip.set(o.ip); this.m.set(o.m); this.E.set(o.E);
    this.gx = o.gx; this.gy = o.gy; this.wk = o.wk;
  }
}

function blend(out: Float64Array, a: Float64Array, b: Float64Array, k: number): void {
  for (let i = 0; i < out.length; i += 1) out[i] = a[i]! + (b[i]! - a[i]!) * k;
}

/** Which way round her transform is: negative while a turn shows her from behind, mirrored. */
export const handedness = (m: Float64Array): number => m[0]! * m[3]! - m[1]! * m[2]!;

/** Sets the avatar to the pose a fraction k (above 0) of the way from step a to step b. The hair is walked out from
 * blended headings, so every stretch keeps its length; the transform, eyes and gaze are blended as numbers.
 * DANCE: the wink blends with the eyes. Across a turn that mirrors her between the two steps, the transform isn't
 * blended, since halfway it would have no width: it holds the nearer step's, as the dance preview does. */
export function between(av: Avatar, a: Pose, b: Pose, k: number): void {
  blend(av.hl, a.hl, b.hl, k);
  blend(av.il, a.il, b.il, k);
  internal.spineFrom(av.rig, av.hl, av.sp);
  internal.walk(av.rig.inner, av.il, av.ip, a.ip[0]! + (b.ip[0]! - a.ip[0]!) * k, a.ip[1]! + (b.ip[1]! - a.ip[1]!) * k);
  if (handedness(a.m) * handedness(b.m) > 0) blend(av.m, a.m, b.m, k);
  else av.m.set(k < 0.5 ? a.m : b.m);
  blend(av.E, a.E, b.E, k);
  av.gx = a.gx + (b.gx - a.gx) * k;
  av.gy = a.gy + (b.gy - a.gy) * k;
  av.wk = a.wk + (b.wk - a.wk) * k;
}

let warned = false;
function warnOnce(text: string): void {
  if (!warned) console.warn(text);
  warned = true;
}

function style(el: HTMLElement, props: Partial<CSSStyleDeclaration>): void {
  Object.assign(el.style, props); // CSSOM, which a strict style-src allows
}

class Controller implements MaiaAvatar, loop.Actor {
  private readonly av: Avatar;
  private readonly size: number;
  private readonly dpr: number;
  private readonly idle: IdleClock;
  private readonly motion: MediaQueryList | null;
  private readonly undo: (() => void)[] = [];
  private theme: Theme;
  private docShown = true;
  private inView = true;
  private isPaused = false;
  private failed = false;
  private gone = false;
  private streaming = false;
  /** Asleep with the strip breathing, or with no parent to hold it: either way, no frames. */
  private strip: { clip: HTMLElement; el: HTMLCanvasElement; anim: Animation | null } | null = null;
  private stillAsleep = false;
  private acc = 0;
  private last = 0;
  private held = 0;
  private lastDraw = -Infinity;
  private readonly prev = new Pose();
  private readonly cur = new Pose();
  readonly stats = { frames: 0, steps: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, o: AvatarOptions) {
    this.theme = o.theme && THEMES.includes(o.theme) ? o.theme : 'light';
    this.size = o.size && o.size > 0 ? o.size : canvas.getBoundingClientRect().width || 64;
    this.dpr = o.dpr && o.dpr > 0 ? o.dpr : Math.min(globalThis.devicePixelRatio || 1, 3);
    this.motion = o.reducedMotion === undefined && typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const reduced = o.reducedMotion ?? this.motion?.matches ?? false;
    canvas.setAttribute('aria-hidden', 'true');
    style(canvas, { width: `${this.size}px`, height: `${this.size}px` });
    // Setting the size clears the canvas, and every paint clears it again first: lashes and body go in behind
    // what's already there, so anything left on it would hide them (spec, "Drawing model").
    this.av = new Avatar(canvas, { size: this.size, dpr: this.dpr, theme: this.theme, reduced, ...(o.textSide ? { textSide: o.textSide } : {}) });
    this.av.snap();
    this.av.draw();
    this.stats.frames += 1;
    this.cur.take(this.av);
    this.prev.copy(this.cur);
    this.idle = new IdleClock(sleepAfter(o.sleepAfterMs), () => this.idleNow(), o.timers);

    if (this.motion) this.listen(this.motion, 'change', () => this.applyReduced(!!this.motion?.matches));
    if (typeof document !== 'undefined') {
      const seen = () => {
        this.docShown = document.visibilityState !== 'hidden';
        this.shown();
      };
      this.docShown = document.visibilityState !== 'hidden';
      this.listen(document, 'visibilitychange', seen);
    }
    if (typeof IntersectionObserver === 'function') {
      this.inView = false; // until the observer's first report, which comes on the next frame
      const io = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        if (e) this.inView = e.isIntersecting;
        this.shown();
      }, { rootMargin: '32px' });
      io.observe(canvas);
      this.undo.push(() => io.disconnect());
    }
    const target = o.activityTarget;
    if (target) for (const type of ['pointerenter', 'pointerdown', 'focusin']) this.listen(target, type, () => this.wake());
    this.kick();
  }

  // ---- the API

  get state(): EngineState { return this.av.state; }
  get paused(): boolean { return this.isPaused; }

  setState(s: AvatarState): void {
    if (this.gone) return;
    if (s === 'sleeping') { this.idleNow(); return; }
    this.leaveSleep();
    this.av.setState(s);
    this.idle.hold(s === 'thinking' || s === 'speaking');
    this.idle.touch();
    this.afterJump();
  }

  playScore(input: unknown): Score | null {
    const parsed = parseScore(input);
    if (this.gone) return parsed;
    this.leaveSleep();
    this.av.playCompiled(compileScore(parsed ? { ...parsed, notes: [] } : null));
    this.idle.hold(false);
    this.idle.touch();
    this.afterJump();
    return parsed;
  }

  // DANCE: as the dance preview plays one: a score of the routine's own mood, the ordinary rhythm and no beats.
  playRoutine(name: string = [...ROUTINES.keys()][0] ?? ''): boolean {
    if (typeof name !== 'string' || !ROUTINES.has(name)) return false;
    if (this.gone) return true;
    this.leaveSleep();
    const settle = VOCAB.routines[name]?.settle ?? 'warm';
    this.av.playCompiled(compileScore({ mood: settle, rhythm: DEFAULT_RHYTHM, seconds: 24, beats: [], notes: [], routine: name }));
    this.idle.hold(false);
    this.idle.touch();
    this.afterJump();
    return true;
  }

  wake(): void {
    if (this.gone) return;
    this.idle.touch();
    const s = this.av.state;
    if (s !== 'falling' && s !== 'sleeping') return;
    this.leaveSleep();
    this.av.wake();
    this.afterJump();
  }

  pause(): void {
    if (this.gone || this.isPaused) return;
    this.isPaused = true;
    loop.stop(this);
    if (this.strip) { this.strip.clip.style.display = 'none'; this.canvas.style.visibility = ''; }
    this.still();
    this.syncStrip();
  }

  resume(): void {
    if (this.gone || !this.isPaused) return;
    this.isPaused = false;
    if (this.strip) { this.strip.clip.style.display = 'block'; this.canvas.style.visibility = 'hidden'; } else this.drawNow();
    this.syncStrip();
    this.kick();
  }

  setTheme(theme: Theme): void {
    if (this.gone || !THEMES.includes(theme) || theme === this.theme) return;
    this.theme = theme;
    this.av.setTheme(theme);
    if (this.strip) this.toStrip();
    if (this.isPaused) this.still();
    else if (!this.strip) this.drawNow();
    this.kick();
  }

  setRate(cps: number): void {
    if (!this.gone && Number.isFinite(cps)) this.av.setRate(cps);
  }

  setStreamMode(on: boolean): void {
    if (this.gone || this.streaming === !!on) return;
    this.streaming = !!on;
    this.held = 0;
    this.av.setStreamMode(this.streaming);
    this.afterJump();
  }

  destroy(): void {
    if (this.gone) return;
    this.gone = true;
    loop.stop(this);
    this.idle.destroy();
    for (const f of this.undo.splice(0)) f();
    this.removeStrip();
  }

  // ---- the loop

  active(): boolean {
    return !this.gone && !this.isPaused && !this.failed && this.docShown && this.inView && !this.strip && !this.stillAsleep && !this.av.dormant;
  }

  frame(now: number): void {
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = dt > 0.1 ? 0.1 : dt > 0 ? dt : 0;
    this.acc += dt;
    try {
      let n = 0;
      while (this.acc >= DT && n < MAX_STEPS) {
        this.prev.copy(this.cur);
        this.av.step();
        this.cur.take(this.av);
        this.acc -= DT;
        n += 1;
      }
      if (this.acc >= DT) this.acc = 0;
      this.stats.steps += n;
      // Settled asleep: draw this step as it is, so the strip's first frame matches it, and stop.
      if (this.av.state === 'sleeping' && !this.av.reduced) { this.drawNow(); this.toStrip(); return; }
      if (this.streaming) {
        this.held += n;
        if (this.held < 2) return;
        this.held = 0;
        this.drawNow();
        return;
      }
      if (now - this.lastDraw < MIN_FRAME_MS) return;
      this.lastDraw = now;
      this.drawBetween(this.acc / DT);
    } catch (err) {
      this.fail(err);
    }
  }

  /** The pose a fraction k of the way from the last step to this one, by between(). k = 0 is the last step. */
  private drawBetween(k: number): void {
    const av = this.av, a = this.prev, b = this.cur;
    if (k > 0) between(av, a, b, k);
    else a.give(av);
    try {
      av.draw();
      this.stats.frames += 1;
    } finally {
      b.give(av);
    }
  }

  /** This step, exactly as the engine left it. */
  private drawNow(): void {
    if (this.failed) return;
    try {
      this.av.draw();
      this.stats.frames += 1;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Her rest pose, eyes open, looking at the person: pause and errors both show it. */
  private still(): void {
    try { this.av.drawStill(); } catch { /* nothing more to do */ }
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    console.warn('Maia stopped', err instanceof Error ? err.message : err);
    this.still();
  }

  /** Something changed that isn't a step: start blending again from where she is now, and ask for frames. */
  private afterJump(): void {
    this.cur.take(this.av);
    this.prev.copy(this.cur);
    this.held = 0;
    if (this.showing() && !this.loopRunning()) this.drawNow();
    this.kick();
  }

  private kick(): void {
    if (!this.active()) return;
    if (!this.loopRunning()) {
      this.last = performance.now();
      this.acc = 0;
      this.cur.take(this.av);
      this.prev.copy(this.cur);
    }
    loop.run(this);
  }

  private loopRunning(): boolean { return loop.running(this); }
  private showing(): boolean { return this.docShown && this.inView && !this.isPaused && !this.failed; }

  private shown(): void {
    if (!this.showing()) loop.stop(this);
    this.syncStrip();
    this.kick();
  }

  // ---- sleep

  private idleNow(): void {
    const s = this.av.state;
    if (this.gone || s === 'falling' || s === 'sleeping') return;
    this.idle.hold(false);
    if (this.showing()) {
      this.av.fallAsleep();
      this.kick();
    } else {
      // Nobody can see her fall asleep, so she's simply asleep when they look again.
      this.av.settleAsleep();
      this.cur.take(this.av);
      this.prev.copy(this.cur);
      this.kick();
    }
  }

  /** The strip, as the reference page plays it: half a breath of whole frames, there and back, by a compositor transform. */
  private toStrip(): void {
    const parent = this.canvas.parentElement;
    if (!parent || getComputedStyle(parent).position === 'static') {
      warnOnce('Maia: her canvas needs a positioned parent, her bubble, to breathe while asleep. She sleeps still.');
      this.removeStrip();
      this.stillAsleep = true;
      return;
    }
    const was = this.strip?.anim?.currentTime ?? null;
    this.removeStrip();
    const key = `${this.size}|${this.dpr}|${this.theme}`;
    let s = strips.get(key);
    if (!s) {
      s = makeSleepStrip({ size: this.size, dpr: this.dpr, theme: this.theme, frames: SLEEP.stripFrames });
      strips.set(key, s);
    }
    const size = this.size, clip = document.createElement('span'), el = document.createElement('canvas');
    style(clip, { position: 'absolute', display: 'block', left: `${this.canvas.offsetLeft}px`, top: `${this.canvas.offsetTop}px`, width: `${size}px`, height: `${size}px`, overflow: 'hidden', pointerEvents: 'none' });
    el.width = s.canvas.width;
    el.height = s.canvas.height;
    el.setAttribute('aria-hidden', 'true');
    el.getContext('2d')?.drawImage(s.canvas, 0, 0);
    style(el, { display: 'block', width: `${size * s.frames}px`, height: `${size}px`, maxWidth: 'none', willChange: 'transform' });
    clip.append(el);
    this.canvas.after(clip);
    this.canvas.style.visibility = 'hidden';
    const anim = typeof el.animate === 'function'
      ? el.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${-(s.frames - 1) * size}px, 0, 0)` }],
        { duration: s.halfS * 1000, iterations: Infinity, direction: 'alternate', easing: `steps(${s.frames}, jump-none)` })
      : null;
    if (anim && was !== null) anim.currentTime = was;
    this.strip = { clip, el, anim };
    if (this.isPaused) { clip.style.display = 'none'; this.canvas.style.visibility = ''; }
    this.syncStrip();
  }

  /** Nothing breathes where nobody can see it. */
  private syncStrip(): void {
    const anim = this.strip?.anim;
    if (!anim) return;
    if (this.showing()) anim.play();
    else anim.pause();
  }

  private removeStrip(): void {
    if (!this.strip) return;
    this.strip.anim?.cancel();
    this.strip.clip.remove();
    this.strip = null;
    this.canvas.style.visibility = '';
  }

  /** Back from the strip to live frames, at the point of the breath the strip had reached. */
  private leaveSleep(): void {
    this.stillAsleep = false;
    const s = this.strip;
    if (!s) return;
    const t = s.anim?.currentTime;
    const at = typeof t === 'number' ? (t / 1000) % SLEEP.cycle : 0;
    this.av.sleepClock = Math.max(0, at - 1);
    for (let i = 0; i < 30; i += 1) this.av.step();
    this.removeStrip();
    this.av.dormant = false;
  }

  private applyReduced(on: boolean): void {
    if (this.gone || on === this.av.reduced) return;
    if (on) { this.removeStrip(); this.stillAsleep = false; }
    this.av.setReduced(on);
    if (!on) this.av.dormant = false;
    this.afterJump();
  }

  private listen(target: EventTarget, type: string, fn: () => void): void {
    target.addEventListener(type, fn);
    this.undo.push(() => target.removeEventListener(type, fn));
  }
}

/** Maia on a canvas. Put the canvas inside her bubble, an element with `position` set and the bubble's background:
 * nothing is ever drawn behind her on the canvas itself. While she's asleep the package adds a strip beside it. */
export function createAvatar(canvas: HTMLCanvasElement, options: AvatarOptions = {}): MaiaAvatar {
  return new Controller(canvas, options);
}
