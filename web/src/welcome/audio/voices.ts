// The welcome's voices, each written in code (CONCEPT.md §7.1, source B): sine and triangle partials, a soft FM bell for glass,
// and felt-piano-like plucks. A composer's stems would replace these functions one for one (README "Stems later"). Every
// one-shot voice stops itself and disconnects its nodes when its last oscillator ends; the sustains live as long as the context.
import { hz } from './score';

type Ctx = BaseAudioContext;

export function gain(ctx: Ctx, value: number, to: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  g.connect(to);
  return g;
}

function osc(ctx: Ctx, type: OscillatorType, f: number, to: AudioNode): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.connect(to);
  return o;
}

export function filter(ctx: Ctx, type: BiquadFilterType, f: number, q: number, to: AudioNode): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.connect(to);
  return b;
}

/** Starts a one-shot voice at `t`, stops it at `end`, and lets go of its nodes once it has ended. */
function play(nodes: AudioNode[], oscs: OscillatorNode[], t: number, end: number): void {
  for (const o of oscs) {
    o.start(t);
    o.stop(end);
  }
  const last = oscs[oscs.length - 1];
  if (last)
    last.onended = () => {
      for (const n of nodes) n.disconnect();
      for (const o of oscs) o.disconnect();
    };
}

/**
 * A felt-piano-like pluck: a triangle with a soft 12 ms attack and a fast decay, and a sine an octave up that fades faster still
 * (the felt's brief brightness). The motif bus's shared low-pass takes the edge off.
 */
export function pluck(ctx: Ctx, to: AudioNode, midi: number, t: number, peak: number, lite: boolean): void {
  const f = hz(midi);
  const env = gain(ctx, 0, to);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + 0.012);
  env.gain.setTargetAtTime(0, t + 0.012, 0.32);
  const nodes: AudioNode[] = [env];
  const oscs = [osc(ctx, 'triangle', f, env)];
  if (!lite) {
    const felt = gain(ctx, 0, env);
    felt.gain.setValueAtTime(0.35, t);
    felt.gain.setTargetAtTime(0, t, 0.09);
    nodes.push(felt);
    oscs.push(osc(ctx, 'sine', f * 2, felt));
  }
  play(nodes, oscs, t, t + 2.4);
}

/**
 * Glass: a sine with a soft FM shimmer at a 2:1 ratio (glassy harmonics, not a gong) whose index fades in half a second, rising
 * over `rise` and falling to silence exactly `fall` later. The hero chord is five of these.
 */
export function glass(ctx: Ctx, to: AudioNode, midi: number, t: number, peak: number, rise: number, fall: number, lite: boolean): void {
  const f = hz(midi);
  const end = t + rise + fall;
  const env = gain(ctx, 0, to);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + rise);
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  env.gain.setValueAtTime(0, end);
  const carrier = osc(ctx, 'sine', f, env);
  const nodes: AudioNode[] = [env];
  const oscs = [carrier];
  if (!lite) {
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(f * 0.9, t);
    depth.gain.setTargetAtTime(0, t + rise * 0.5, 0.5);
    depth.connect(carrier.frequency);
    nodes.push(depth);
    oscs.unshift(osc(ctx, 'sine', f * 2, depth));
  }
  play(nodes, oscs, t, end + 0.02);
}

/** A sustained note that lives as long as the context: a sine, and a slightly detuned triangle a third as loud. */
export interface Sustain {
  readonly env: GainNode;
  readonly oscs: OscillatorNode[];
  /** Its gains, for letting go of a one-shot. */
  readonly nodes: AudioNode[];
  /** Retunes it at `t` (only ever in a silence, so no glide is heard). */
  tune(midi: number, t: number): void;
}

export function sustain(ctx: Ctx, to: AudioNode, midi: number, triangle: boolean): Sustain {
  const env = gain(ctx, 0, to);
  const oscs = [osc(ctx, 'sine', hz(midi), env)];
  const nodes: AudioNode[] = [env];
  if (triangle) {
    const third = gain(ctx, 1 / 3, env);
    const tri = osc(ctx, 'triangle', hz(midi), third);
    tri.detune.value = 4;
    oscs.push(tri);
    nodes.push(third);
  }
  return {
    env,
    oscs,
    nodes,
    tune(m, t) {
      for (const o of oscs) o.frequency.setValueAtTime(hz(m), t);
    },
  };
}

/** A phrase's shape on a sustain's gain: up over `rise`, held, and down to silence exactly at `start + len`. */
export function shape(p: AudioParam, start: number, len: number, level: number, rise: number): void {
  p.setValueAtTime(0, start);
  p.linearRampToValueAtTime(level, start + rise);
  p.setValueAtTime(level, start + len - rise);
  p.linearRampToValueAtTime(0, start + len);
}

/** A one-shot chord (the cadence's): each note a sustain's partials, following `points` ([time, gain]) and then gone. */
export function chord(ctx: Ctx, to: AudioNode, midis: readonly number[], points: readonly (readonly [number, number])[], triangle: boolean): void {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return;
  for (const m of midis) {
    const s = sustain(ctx, to, m, triangle);
    s.env.gain.setValueAtTime(first[1], first[0]);
    for (const [t, v] of points.slice(1)) s.env.gain.linearRampToValueAtTime(v, t);
    play(s.nodes, s.oscs, first[0], last[0] + 0.02);
  }
}
