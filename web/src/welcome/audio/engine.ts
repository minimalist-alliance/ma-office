// The welcome's music engine (CONCEPT.md §7.1 and §7.2; README.md beside this file). Our own Web Audio graph, every sound written
// in code, scheduled on the audio clock. Lazy: the welcome imports this only after "Begin with sound", never in the first load.
// No voice at launch (captions and music only): `duck` is the seam a later voice would use.
//
//   L0 air ─┐
//   L1 pad ─┤
//   L2 motif┤→ music (Music on/off) → duck → out (fades) → master (mute × volume) → limiter → speakers
//   L3 glass┤                                  ↑
//   L4 low ─┤                                hero
//   cadence ┘
import {
  CADENCE,
  DYADS,
  FADE,
  GLASS_NOTES,
  HERO,
  HERO_CHORD,
  LEVEL,
  LIMITER,
  LOW_NOTES,
  MOTIF_GAP,
  MOTIF_NOTES,
  MOTIFS,
  PAD_DELAY,
  cadenceSpan,
  motifDue,
  phrase,
  picker,
  seeded,
} from './score';
import { chord, filter, gain, glass, pluck, shape, sustain, type Sustain } from './voices';

export interface WelcomeAudio {
  start(): Promise<boolean>; // call inside the "Begin with sound" click; false if audio is blocked or fails (the UI then shows the speaker off)
  answered(): void; // after the first answer: starts L2
  deskReady(count: number): void; // 1 → L3, 2+ → L4 (idempotent)
  cadence(endsInMs: number): void;
  hero(): void; // once; afterwards silence and close
  setMuted(on: boolean): void;
  setMusic(on: boolean): void;
  setVolume(v: number /*0..1*/): void;
  duck(on: boolean): void; // the voice seam: -10 dB, 150 ms attack, 800 ms release (unused at launch)
  pause(): void;
  resume(): void; // the flow's Pause
  setHidden(hidden: boolean): void;
  stop(): void; // 1.5 s fade then close
  readonly state: 'idle' | 'running' | 'paused' | 'blocked' | 'closed';
}

type State = WelcomeAudio['state'];

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  out: GainNode;
  duck: GainNode;
  music: GainNode;
  air: GainNode;
  pad: GainNode;
  motif: GainNode;
  glass: GainNode;
  low: GainNode;
  cadence: GainNode;
  hero: GainNode;
  felt: BiquadFilterNode;
  dyad: Sustain[];
  bass: Sustain;
}

/** How long a press may wait for the browser to let audio run before the speaker shows off. */
const BLOCKED_AFTER_MS = 1500;

/** Moves a gain to `target` over `secs` from wherever it is now, on an eased curve (slow start up, fast start down). */
function glide(p: AudioParam, target: number, secs: number, at: number): void {
  const from = p.value;
  p.cancelScheduledValues(at);
  p.setValueAtTime(from, at);
  const up = target > from;
  for (const k of [1, 2, 3]) {
    const x = k / 3;
    const f = up ? x * x : 1 - (1 - x) * (1 - x);
    p.linearRampToValueAtTime(from + (target - from) * f, at + secs * x);
  }
}

export function createWelcomeAudio(opts: { context?: () => AudioContext; random?: () => number; reducedCpu?: boolean } = {}): WelcomeAudio {
  const random = opts.random ?? Math.random;
  const lite = opts.reducedCpu === true;
  const tickMs = lite ? 1000 : 500;
  const ahead = lite ? 2.5 : 1.5; // how far ahead the scheduler writes, in seconds of audio time
  const nextMotif = picker(MOTIFS.length, 3, random);

  let state: State = 'idle';
  let g: Graph | null = null;
  let starting: Promise<boolean> | null = null;
  // The member's settings and the flow's progress, kept from before the press too.
  let muted = false;
  let musicOn = true;
  let volume = 1;
  let ducked = false;
  let paused = false;
  let hidden = false;
  let motifOn = false;
  let glassOn = false;
  let lowOn = false;
  // The score's place.
  let nextPhrase = 0;
  let lastMotif: number | null = null;
  let lastDyad = -1;
  let cadenceAt: number | null = null;
  let heroed = false;
  let closeAt: number | null = null;
  let stopping = false;
  let ticker: ReturnType<typeof setTimeout> | undefined;
  let sleeper: ReturnType<typeof setTimeout> | undefined;

  const masterLevel = () => (muted ? 0 : volume * volume);

  function build(ctx: AudioContext): Graph {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    limiter.connect(ctx.destination);
    const master = gain(ctx, masterLevel(), limiter);
    const out = gain(ctx, 0, master);
    const duck = gain(ctx, ducked ? LEVEL.duck : 1, out);
    const music = gain(ctx, musicOn ? 1 : 0, duck);
    const bus = () => gain(ctx, 1, music);
    const air = bus();
    const pad = bus();
    const motif = bus();
    const glassBus = bus();
    const low = bus();
    const cadence = bus();
    const hero = gain(ctx, 1, out);
    const felt = filter(ctx, 'lowpass', 1700, 0.4, motif);

    // L0: a looped buffer of white noise, band-passed high and cool, breathing very slowly.
    const rate = ctx.sampleRate;
    const noise = ctx.createBuffer(1, Math.round(rate * (lite ? 1 : 2)), rate);
    const data = noise.getChannelData(0);
    const n = seeded(Math.floor(random() * 4294967296));
    for (let i = 0; i < data.length; i++) data[i] = n() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const airAmp = gain(ctx, LEVEL.air, air);
    src.connect(filter(ctx, 'bandpass', 2200, 0.6, airAmp));
    src.start();
    if (!lite) {
      const sway = ctx.createOscillator();
      sway.frequency.value = 0.06;
      const depth = ctx.createGain();
      depth.gain.value = LEVEL.air * LEVEL.airSway;
      sway.connect(depth);
      depth.connect(airAmp.gain);
      sway.start();
    }

    // L1 and L4 live as long as the context; their phrases are shapes on their gains.
    const padTone = filter(ctx, 'lowpass', 1100, 0.3, pad);
    const dyad = [sustain(ctx, padTone, 50, !lite), sustain(ctx, padTone, 57, !lite)];
    const bass = sustain(ctx, low, 38, false);
    for (const s of [...dyad, bass]) for (const o of s.oscs) o.start();

    return { ctx, master, out, duck, music, air, pad, motif, glass: glassBus, low, cadence, hero, felt, dyad, bass };
  }

  /** One phrase of the score, from `start` for `len` seconds; the next starts at `next`. */
  function playPhrase(gr: Graph, start: number, len: number, next: number): void {
    const { ctx } = gr;
    let d = Math.floor(random() * DYADS.length);
    if (d === lastDyad) d = (d + 1) % DYADS.length;
    lastDyad = d;
    const notes = DYADS[d] ?? DYADS[0];
    gr.dyad.forEach((s, i) => {
      s.tune(notes[i] ?? 50, start);
      shape(s.env.gain, start, len, LEVEL.pad, Math.min(2.5, len / 3));
    });
    if (lowOn) {
      gr.bass.tune(LOW_NOTES[Math.floor(random() * LOW_NOTES.length)] ?? 38, start);
      shape(gr.bass.env.gain, start, len, LEVEL.low, 3);
    }
    if (!musicOn) return; // the one-shots wait until the music is on again
    if (motifOn && motifDue(start, next, lastMotif, random)) {
      const at = start + MOTIF_GAP.offsetMin + random() * (MOTIF_GAP.offsetMax - MOTIF_GAP.offsetMin);
      lastMotif = at;
      const motif = MOTIFS[nextMotif()] ?? [];
      const stretch = 0.9 + random() * 0.25;
      motif.forEach(([note, t], i) => {
        const jitter = i === 0 ? 0 : (random() - 0.5) * 0.08;
        pluck(ctx, gr.felt, MOTIF_NOTES[note] ?? 62, at + t * stretch + jitter, LEVEL.motif * (0.8 + random() * 0.2), lite);
      });
    }
    if (glassOn) {
      const count = random() < 0.5 ? 1 : 2;
      for (let i = 0; i < count; i++) {
        const at = start + 1.5 + random() * Math.max(0, len - 6);
        glass(ctx, gr.glass, GLASS_NOTES[Math.floor(random() * GLASS_NOTES.length)] ?? 86, at, LEVEL.glass, 0.25, 4.5, lite);
      }
    }
  }

  function tick(): void {
    ticker = undefined;
    const gr = g;
    if (!gr || state === 'closed') return;
    const now = gr.ctx.currentTime;
    if (closeAt !== null && now >= closeAt) {
      finish();
      return;
    }
    if (gr.ctx.state === 'running' && !heroed && !stopping) {
      while (nextPhrase < now + ahead && (cadenceAt === null || nextPhrase < cadenceAt - 2)) {
        const start = Math.max(nextPhrase, now + 0.05);
        const { len, rest } = phrase(random);
        nextPhrase = start + len + rest;
        playPhrase(gr, start, len, nextPhrase);
      }
    }
    ticker = setTimeout(tick, tickMs);
  }

  function finish(): void {
    clearTimeout(ticker);
    clearTimeout(sleeper);
    ticker = sleeper = undefined;
    const gr = g;
    g = null;
    state = 'closed';
    if (gr) gr.ctx.close().catch(() => undefined);
  }

  /** Runs or sleeps the context for the flow's Pause and a hidden tab: fades out and suspends, or resumes and fades back in. */
  function apply(): void {
    const gr = g;
    if (!gr || (state !== 'running' && state !== 'paused') || stopping) return;
    clearTimeout(sleeper);
    sleeper = undefined;
    const { ctx } = gr;
    if (paused || hidden) {
      const secs = paused ? FADE.pause : FADE.hidden;
      state = 'paused';
      glide(gr.out.gain, 0, secs, ctx.currentTime);
      sleeper = setTimeout(() => {
        sleeper = undefined;
        if (g === gr && state === 'paused') ctx.suspend().catch(() => undefined);
      }, secs * 1000 + 50);
      return;
    }
    state = 'running';
    ctx.resume().then(
      () => {
        if (g === gr && state === 'running') glide(gr.out.gain, 1, FADE.hidden, ctx.currentTime);
      },
      () => undefined,
    );
  }

  function attempt(): Promise<boolean> {
    let made: AudioContext | undefined;
    let resumed: Promise<void>;
    try {
      made = (opts.context ?? (() => new AudioContext({ latencyHint: 'playback' })))();
      // Inside the click, before anything awaits: the browser counts the press only here.
      resumed = made.state === 'running' ? Promise.resolve() : made.resume();
      g = build(made);
    } catch {
      g = null;
      made?.close().catch(() => undefined);
      state = stopping ? 'closed' : 'blocked';
      return Promise.resolve(false);
    }
    const ctx = made;
    const gr = g;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, BLOCKED_AFTER_MS)));
    return Promise.race([resumed, late]).then(
      () => {
        clearTimeout(timer);
        if (ctx.state === 'running' && g === gr && !stopping) return began(gr);
        return blocked(gr);
      },
      () => {
        clearTimeout(timer);
        return blocked(gr);
      },
    );
  }

  function blocked(gr: Graph): boolean {
    if (g === gr) g = null;
    gr.ctx.close().catch(() => undefined);
    if (state === 'idle' || state === 'blocked') state = stopping ? 'closed' : 'blocked';
    return false;
  }

  function began(gr: Graph): boolean {
    const now = gr.ctx.currentTime;
    state = 'running';
    // From silence over 4 s, eased; L1 begins 4 s after the press, and the score's phrases follow.
    glide(gr.out.gain, 1, FADE.in, now);
    nextPhrase = now + PAD_DELAY;
    if (paused || hidden) apply();
    tick();
    return true;
  }

  const audio: WelcomeAudio = {
    get state() {
      return state;
    },
    start() {
      if (state === 'running' || state === 'paused') return Promise.resolve(true);
      if (state === 'closed') return Promise.resolve(false);
      starting ??= attempt().finally(() => (starting = null));
      return starting;
    },
    answered() {
      motifOn = true;
    },
    deskReady(count) {
      if (count >= 1) glassOn = true;
      if (count >= 2) lowOn = true;
    },
    cadence(endsInMs) {
      const gr = g;
      if (!gr || cadenceAt !== null || heroed || stopping || !(endsInMs >= 0)) return;
      const now = gr.ctx.currentTime;
      const end = now + endsInMs / 1000;
      const { start, len } = cadenceSpan(now, end);
      cadenceAt = start;
      // The other layers step aside as it begins; the air stays under it.
      for (const b of [gr.pad, gr.motif, gr.glass, gr.low]) glide(b.gain, 0, Math.min(2, Math.max(0.3, len / 3)), start);
      if (len < 0.3) return;
      const r = start + len * CADENCE.resolve;
      const L = LEVEL.cadence;
      chord(gr.ctx, gr.cadence, CADENCE.lean, [[start, 0], [start + len * 0.2, L], [r - len * 0.03, L], [r + len * 0.06, 0]], !lite);
      chord(gr.ctx, gr.cadence, CADENCE.home, [[r - len * 0.05, 0], [r + len * 0.08, L], [end - len * 0.2, L * 0.8], [end, 0]], !lite);
      CADENCE.line.forEach((m, i) => pluck(gr.ctx, gr.felt, m, start + len * (CADENCE.at[i] ?? 0), LEVEL.motif * (1 - i * 0.08), lite));
      glass(gr.ctx, gr.cadence, CADENCE.glass, r, LEVEL.glass * 1.4, len * 0.03, end - r - len * 0.03, lite);
      // Whatever still rings is gone exactly at the end.
      const c = gr.cadence.gain;
      c.setValueAtTime(1, Math.max(start, end - 0.6));
      c.linearRampToValueAtTime(0, end);
    },
    hero() {
      const gr = g;
      if (!gr || heroed || stopping) return;
      heroed = true;
      const now = gr.ctx.currentTime;
      const at = now + 0.02;
      for (const b of [gr.air, gr.pad, gr.motif, gr.glass, gr.low, gr.cadence]) glide(b.gain, 0, FADE.heroOut, now);
      for (const m of HERO_CHORD) glass(gr.ctx, gr.hero, m, at, LEVEL.hero, HERO.swell, HERO.decay, lite);
      closeAt = at + HERO.swell + HERO.decay + HERO.close;
    },
    setMuted(on) {
      muted = on;
      if (g) glide(g.master.gain, masterLevel(), FADE.mute, g.ctx.currentTime);
    },
    setMusic(on) {
      musicOn = on;
      if (g) glide(g.music.gain, on ? 1 : 0, FADE.music, g.ctx.currentTime);
    },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
      if (g) glide(g.master.gain, masterLevel(), FADE.volume, g.ctx.currentTime);
    },
    duck(on) {
      ducked = on;
      if (g) glide(g.duck.gain, on ? LEVEL.duck : 1, on ? FADE.duckIn : FADE.duckOut, g.ctx.currentTime);
    },
    pause() {
      paused = true;
      apply();
    },
    resume() {
      paused = false;
      apply();
    },
    setHidden(h) {
      hidden = h;
      apply();
    },
    stop() {
      const gr = g;
      if (!gr || state === 'idle' || state === 'blocked') {
        stopping = true;
        if (!starting) finish();
        return;
      }
      if (stopping || state === 'closed') return;
      stopping = true;
      clearTimeout(sleeper);
      if (gr.ctx.state !== 'running') {
        finish();
        return;
      }
      glide(gr.out.gain, 0, FADE.stop, gr.ctx.currentTime);
      clearTimeout(ticker);
      ticker = setTimeout(finish, FADE.stop * 1000 + 50);
    },
  };
  return audio;
}
