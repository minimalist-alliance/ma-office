import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWelcomeAudio } from './engine';
import { FakeBiquad, FakeBufferSource, FakeCompressor, FakeContext, FakeOsc, type FakeNode } from './fakeAudio';
import { LEVEL, LIMITER, MOTIF_NOTES, MOTIFS, seeded } from './score';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Runs audio time and timers together, `step` seconds at a time; a suspended context's clock stands still. */
async function run(ctx: FakeContext, secs: number, step = 0.1): Promise<void> {
  for (let i = 0; i < Math.round(secs / step); i++) {
    if (ctx.state === 'running') ctx.currentTime += step;
    await vi.advanceTimersByTimeAsync(step * 1000);
    ctx.endVoices();
  }
}

function setup(o: { reducedCpu?: boolean; seed?: number } = {}) {
  const ctx = new FakeContext();
  const audio = createWelcomeAudio({ context: () => ctx.asContext(), random: seeded(o.seed ?? 7), reducedCpu: o.reducedCpu ?? false });
  return { ctx, audio };
}

async function started(o: { reducedCpu?: boolean; seed?: number } = {}) {
  const s = setup(o);
  expect(await s.audio.start()).toBe(true);
  return s;
}

/** The engine's buses, found by the graph's shape. */
function buses(ctx: FakeContext) {
  const into = (to: FakeNode) => ctx.gains().filter((g) => g.outs.has(to));
  const limiter = ctx.nodes.find((n): n is FakeCompressor => n instanceof FakeCompressor);
  if (!limiter) throw new Error('no limiter');
  const [master] = into(limiter);
  if (!master) throw new Error('no master');
  const [out] = into(master);
  if (!out) throw new Error('no out');
  const [duck, hero] = into(out);
  if (!duck || !hero) throw new Error('no duck or hero');
  const [music] = into(duck);
  if (!music) throw new Error('no music');
  const [air, pad, motif, glass, low, cadence] = into(music);
  if (!air || !pad || !motif || !glass || !low || !cadence) throw new Error('missing a layer');
  return { limiter, master, out, duck, hero, music, air, pad, motif, glass, low, cadence };
}

const midi = (f: number) => Math.round(69 + 12 * Math.log2(f / 440));
/** Felt-piano plucks: the one-shot triangles. */
const plucks = (ctx: FakeContext) => ctx.oscillators().filter((o) => o.type === 'triangle' && o.stopAt !== null && o.startAt !== null);
/** Plucks grouped into motifs (notes within 6 s of each other). */
function motifs(ctx: FakeContext): FakeOsc[][] {
  const sorted = plucks(ctx).sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0));
  const groups: FakeOsc[][] = [];
  for (const p of sorted) {
    const g = groups.at(-1);
    const prev = g?.at(-1);
    if (g && prev && (p.startAt ?? 0) - (prev.startAt ?? 0) < 6) g.push(p);
    else groups.push([p]);
  }
  return groups;
}
const variantOf = (group: FakeOsc[]) => MOTIFS.findIndex((m) => m.length === group.length && m.every(([n], i) => MOTIF_NOTES[n] === midi(group[i]?.frequency.value ?? 0)));

/** A dyad note's phrases, read from its gain's shape: [start, end] pairs. */
function padPhrases(ctx: FakeContext): [number, number][] {
  const { pad } = buses(ctx);
  const tone = ctx.nodes.find((n): n is FakeBiquad => n instanceof FakeBiquad && n.outs.has(pad));
  const env = ctx.gains().find((g) => tone && g.outs.has(tone));
  if (!env) throw new Error('no pad voice');
  const evs = [...env.gain.events].sort((a, b) => a.t - b.t);
  const out: [number, number][] = [];
  for (let i = 0; i + 3 < evs.length; i++) {
    const [a, , , d] = [evs[i], evs[i + 1], evs[i + 2], evs[i + 3]];
    if (a?.kind === 'set' && a.v === 0 && d?.kind === 'linear' && d.v === 0) {
      out.push([a.t, d.t]);
      i += 3;
    }
  }
  return out;
}

describe('the welcome music engine', () => {
  it('builds its graph inside the press: layers → music → duck → out → master → limiter → speakers, hero beside the music', async () => {
    const { ctx, audio } = await started();
    expect(audio.state).toBe('running');
    const b = buses(ctx);
    expect(b.limiter.outs.has(ctx.destination)).toBe(true);
    expect(b.limiter.threshold.value).toBe(LIMITER.threshold);
    expect(b.limiter.ratio.value).toBe(LIMITER.ratio);
    expect(b.limiter.knee.value).toBe(0);
    for (const layer of [b.air, b.pad, b.motif, b.glass, b.low, b.cadence]) expect(ctx.reaches(layer, ctx.destination)).toBe(true);
    expect(ctx.reaches(b.hero, b.music)).toBe(false);
    expect(ctx.reaches(b.hero, ctx.destination)).toBe(true);
    // L0 is there from the press: a looped noise buffer, band-passed.
    const src = ctx.nodes.find((n): n is FakeBufferSource => n instanceof FakeBufferSource);
    expect(src?.loop).toBe(true);
    expect(src?.startAt).not.toBeNull();
    expect(src?.buffer?.length).toBe(ctx.sampleRate * 2);
    // No samples, no files: every sound is an oscillator or that one buffer of noise.
    expect(ctx.nodes.filter((n) => n.kind === 'buffer-source')).toHaveLength(1);
  });

  it('fades in from silence over 4 s', async () => {
    const { ctx } = await started();
    const { out } = buses(ctx);
    expect(out.gain.at(0)).toBe(0);
    expect(out.gain.at(1)).toBeLessThan(0.1);
    expect(out.gain.at(2)).toBeLessThan(0.5);
    expect(out.gain.last()).toMatchObject({ v: 1, t: 4 });
  });

  it('starts L1 4 s after the press, in phrases of 8 to 12 s with real silences of 2 to 6 s', async () => {
    const { ctx } = await started();
    await run(ctx, 180, 0.5);
    const ph = padPhrases(ctx);
    expect(ph.length).toBeGreaterThan(8);
    expect(ph[0]?.[0]).toBeCloseTo(4, 5);
    ph.forEach(([s, e], i) => {
      expect(e - s).toBeGreaterThanOrEqual(8);
      expect(e - s).toBeLessThanOrEqual(12);
      const next = ph[i + 1];
      if (next) {
        expect(next[0] - e).toBeGreaterThanOrEqual(2);
        expect(next[0] - e).toBeLessThanOrEqual(6);
      }
    });
  });

  it('plays no motif until the first answer, then one every 20 to 40 s, never one of the last three', async () => {
    const { ctx, audio } = await started({ seed: 21 });
    await run(ctx, 30, 0.5);
    expect(plucks(ctx)).toHaveLength(0);
    const answeredAt = ctx.currentTime;
    audio.answered();
    await run(ctx, 900, 0.5);
    const groups = motifs(ctx);
    expect(groups.length).toBeGreaterThan(20);
    // The first comes with the next phrase (a phrase and a silence are 18 s at most).
    expect((groups[0]?.[0]?.startAt ?? 0) - answeredAt).toBeLessThanOrEqual(18 + 2 + 1.5);
    const starts = groups.map((g) => g[0]?.startAt ?? 0);
    for (let i = 1; i < starts.length; i++) {
      const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(20);
      expect(gap).toBeLessThanOrEqual(40);
    }
    const picks = groups.map(variantOf);
    expect(picks).not.toContain(-1);
    picks.forEach((p, i) => expect(picks.slice(Math.max(0, i - 3), i), `motif ${i}`).not.toContain(p));
    expect(new Set(picks).size).toBeGreaterThanOrEqual(10);
    // Each note is a soft-attack pluck that lets go of its nodes once it has rung out.
    const done = plucks(ctx).filter((o) => (o.stopAt ?? Infinity) < ctx.currentTime);
    expect(done.length).toBeGreaterThan(0);
    for (const o of done) expect(o.disconnected).toBe(true);
  });

  it('brings in glass on the first desk ready and the low sustain on the second, once each', async () => {
    const { ctx, audio } = await started();
    const b = buses(ctx);
    const glassVoices = () => ctx.gains().filter((g) => g.wired.has(b.glass)).length;
    const lowShapes = () => ctx.gains().filter((g) => g.outs.has(b.low)).flatMap((g) => g.gain.events).filter((e) => e.kind === 'linear' && e.v > 0).length;
    await run(ctx, 40, 0.5);
    expect(glassVoices()).toBe(0);
    expect(lowShapes()).toBe(0);
    audio.deskReady(1);
    audio.deskReady(1);
    await run(ctx, 40, 0.5);
    expect(glassVoices()).toBeGreaterThan(0);
    expect(lowShapes()).toBe(0);
    audio.deskReady(2);
    audio.deskReady(3);
    await run(ctx, 40, 0.5);
    expect(lowShapes()).toBeGreaterThan(0);
    const levels = ctx.gains().filter((g) => g.outs.has(b.low)).flatMap((g) => g.gain.events).filter((e) => e.kind === 'linear' && e.v > 0);
    for (const e of levels) expect(e.v).toBeCloseTo(LEVEL.low, 6);
  });

  it('times the cadence to end exactly when asked, and the other layers step aside', async () => {
    const { ctx, audio } = await started();
    audio.answered();
    await run(ctx, 20, 0.5);
    const now = ctx.currentTime;
    const before = ctx.oscillators().length;
    audio.cadence(10_000);
    const b = buses(ctx);
    const end = now + 10;
    expect(b.cadence.gain.last()).toMatchObject({ kind: 'linear', v: 0 });
    expect(b.cadence.gain.last()?.t).toBeCloseTo(end, 6);
    const voices = ctx.oscillators().slice(before);
    expect(voices.length).toBeGreaterThan(0);
    const first = Math.min(...voices.map((o) => o.startAt ?? Infinity));
    const last = Math.max(...voices.map((o) => o.stopAt ?? 0));
    expect(first).toBeCloseTo(end - 8, 6); // 8 s long, so it starts 2 s from now
    expect(last).toBeLessThanOrEqual(end + 0.05);
    for (const layer of [b.pad, b.motif, b.glass, b.low]) {
      expect(layer.gain.last()?.v).toBe(0);
      expect(layer.gain.at(end - 8 + 2.01)).toBeCloseTo(0, 6);
    }
    expect(b.air.gain.at(end)).toBe(1); // the air stays under it
    // Only once, and no new phrases after it begins.
    audio.cadence(3000);
    expect(b.cadence.gain.last()?.t).toBeCloseTo(end, 6);
    const count = ctx.oscillators().length;
    await run(ctx, 30, 0.5);
    expect(ctx.oscillators().length).toBe(count);
  });

  it('starts a short cadence at once, still ending on time', async () => {
    const { ctx, audio } = await started();
    await run(ctx, 6, 0.5);
    const now = ctx.currentTime;
    const before = ctx.oscillators().length;
    audio.cadence(6500);
    const voices = ctx.oscillators().slice(before);
    expect(Math.min(...voices.map((o) => o.startAt ?? Infinity))).toBeCloseTo(now, 6);
    expect(buses(ctx).cadence.gain.last()?.t).toBeCloseTo(now + 6.5, 6);
  });

  it('plays the hero once, over everything fading, then closes', async () => {
    const { ctx, audio } = await started();
    audio.answered();
    audio.deskReady(2);
    await run(ctx, 30, 0.5);
    const b = buses(ctx);
    const before = ctx.oscillators().length;
    audio.hero();
    const hero = ctx.gains().filter((g) => g.outs.has(b.hero));
    expect(hero).toHaveLength(5);
    const peak = Math.max(...hero.flatMap((g) => g.gain.events.map((e) => e.v)));
    expect(peak).toBeCloseTo(LEVEL.hero, 6);
    const tops = hero.map((g) => g.gain.events.find((e) => e.kind === 'linear')?.t ?? 0);
    const ends = hero.map((g) => g.gain.events.find((e) => e.kind === 'exp')?.t ?? 0);
    for (let i = 0; i < 5; i++) {
      const swellAndDecay = (ends[i] ?? 0) - ctx.currentTime;
      expect(swellAndDecay).toBeGreaterThanOrEqual(2);
      expect(swellAndDecay).toBeLessThanOrEqual(3);
      expect((tops[i] ?? 0) - ctx.currentTime).toBeGreaterThan(0.5);
    }
    for (const layer of [b.air, b.pad, b.motif, b.glass, b.low, b.cadence]) expect(layer.gain.last()?.v).toBe(0);
    const made = ctx.oscillators().length;
    audio.hero();
    expect(ctx.oscillators().length).toBe(made);
    expect(made).toBeGreaterThan(before);
    await run(ctx, 2.5);
    expect(audio.state).toBe('running');
    await run(ctx, 1);
    expect(audio.state).toBe('closed');
    expect(ctx.closes).toBe(1);
    audio.hero();
    audio.cadence(5000);
    expect(ctx.oscillators().length).toBe(made);
    expect(await audio.start()).toBe(false);
  });

  it('mutes, turns the music off, sets the volume and ducks with the right gains and times', async () => {
    const { ctx, audio } = await started();
    await run(ctx, 5);
    const b = buses(ctx);
    const t = ctx.currentTime;
    audio.setMuted(true);
    expect(b.master.gain.last()?.v).toBe(0);
    expect(b.master.gain.last()?.t).toBeCloseTo(t + 0.08, 6);
    audio.setMuted(false);
    expect(b.master.gain.last()?.v).toBe(1);
    audio.setVolume(0.5);
    expect(b.master.gain.last()?.v).toBeCloseTo(0.25, 6);
    expect(b.master.gain.last()?.t).toBeCloseTo(t + 0.05, 6);
    audio.setVolume(7);
    expect(b.master.gain.last()?.v).toBe(1);
    audio.setVolume(-1);
    expect(b.master.gain.last()?.v).toBe(0);
    audio.setVolume(0.8);
    audio.setMusic(false);
    expect(b.music.gain.last()).toMatchObject({ v: 0 });
    expect(b.music.gain.last()?.t).toBeCloseTo(t + 0.8, 6);
    expect(b.hero.gain.value).toBe(1); // the hero isn't music
    audio.setMusic(true);
    expect(b.music.gain.last()?.v).toBe(1);
    audio.duck(true);
    expect(b.duck.gain.last()?.v).toBeCloseTo(10 ** (-10 / 20), 6);
    expect(b.duck.gain.last()?.t).toBeCloseTo(t + 0.15, 6);
    await run(ctx, 0.3);
    const t2 = ctx.currentTime;
    audio.duck(false);
    expect(b.duck.gain.last()?.v).toBe(1);
    expect(b.duck.gain.last()?.t).toBeCloseTo(t2 + 0.8, 6);
    expect(b.duck.gain.at(t2)).toBeCloseTo(10 ** (-10 / 20), 4);
  });

  it('keeps settings made before the press', async () => {
    const { ctx, audio } = setup();
    audio.setMuted(true);
    audio.setMusic(false);
    audio.duck(true);
    expect(await audio.start()).toBe(true);
    const b = buses(ctx);
    expect(b.master.gain.value).toBe(0);
    expect(b.music.gain.value).toBe(0);
    expect(b.duck.gain.value).toBeCloseTo(LEVEL.duck, 6);
  });

  it('fades out over 2 s and suspends when the tab is hidden, and comes back gently', async () => {
    const { ctx, audio } = await started();
    await run(ctx, 10);
    const { out } = buses(ctx);
    const t = ctx.currentTime;
    audio.setHidden(true);
    expect(audio.state).toBe('paused');
    expect(out.gain.last()).toMatchObject({ v: 0 });
    expect(out.gain.last()?.t).toBeCloseTo(t + 2, 6);
    expect(ctx.suspends).toBe(0);
    await run(ctx, 2.2);
    expect(ctx.suspends).toBe(1);
    expect(ctx.state).toBe('suspended');
    expect(out.gain.value).toBe(0);
    await run(ctx, 60); // the clock stands still while hidden
    expect(ctx.currentTime).toBeCloseTo(t + 2.1, 1);
    audio.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.state).toBe('running');
    expect(ctx.state).toBe('running');
    const back = ctx.currentTime;
    expect(out.gain.at(back)).toBe(0);
    expect(out.gain.at(back + 0.5)).toBeLessThan(0.1); // never a blast
    expect(out.gain.last()).toMatchObject({ v: 1 });
    expect(out.gain.last()?.t).toBeCloseTo(back + 2, 6);
  });

  it('turns round if the tab comes back inside the fade, without suspending', async () => {
    const { ctx, audio } = await started();
    await run(ctx, 10);
    audio.setHidden(true);
    await run(ctx, 1);
    audio.setHidden(false);
    await run(ctx, 3);
    expect(ctx.suspends).toBe(0);
    expect(audio.state).toBe('running');
    expect(buses(ctx).out.gain.value).toBe(1);
  });

  it('pauses and resumes with the flow', async () => {
    const { ctx, audio } = await started();
    await run(ctx, 8);
    audio.pause();
    expect(audio.state).toBe('paused');
    await run(ctx, 0.5);
    expect(ctx.state).toBe('suspended');
    audio.setHidden(true);
    audio.setHidden(false);
    await run(ctx, 1);
    expect(audio.state).toBe('paused'); // still paused: only Resume resumes
    audio.resume();
    await run(ctx, 2.5);
    expect(audio.state).toBe('running');
    expect(buses(ctx).out.gain.value).toBe(1);
  });

  it('stops with a 1.5 s fade, then closes', async () => {
    const { ctx, audio } = await started();
    await run(ctx, 6);
    const t = ctx.currentTime;
    audio.stop();
    expect(buses(ctx).out.gain.last()).toMatchObject({ v: 0 });
    expect(buses(ctx).out.gain.last()?.t).toBeCloseTo(t + 1.5, 6);
    await run(ctx, 1.4);
    expect(ctx.closes).toBe(0);
    await run(ctx, 0.3);
    expect(ctx.closes).toBe(1);
    expect(audio.state).toBe('closed');
  });

  it('returns false and shows blocked when audio can’t start', async () => {
    const thrown = createWelcomeAudio({
      context: () => {
        throw new Error('no audio');
      },
    });
    expect(await thrown.start()).toBe(false);
    expect(thrown.state).toBe('blocked');

    const broken = new FakeContext();
    broken.createDynamicsCompressor = () => {
      throw new Error('no such node');
    };
    const half = createWelcomeAudio({ context: () => broken.asContext() });
    expect(await half.start()).toBe(false);
    expect(half.state).toBe('blocked');
    expect(broken.closes).toBe(1); // a context made and then failed is let go of

    const hung = setup();
    hung.ctx.resumeMode = 'hang';
    const p = hung.audio.start();
    await vi.advanceTimersByTimeAsync(1600);
    expect(await p).toBe(false);
    expect(hung.audio.state).toBe('blocked');
    expect(hung.ctx.closes).toBe(1);

    // Each press makes a fresh context; the first is refused.
    const made: FakeContext[] = [];
    const refused = createWelcomeAudio({
      random: seeded(1),
      context: () => {
        const c = new FakeContext();
        if (made.length === 0) c.resumeMode = 'reject';
        made.push(c);
        return c.asContext();
      },
    });
    expect(await refused.start()).toBe(false);
    expect(refused.state).toBe('blocked');
    expect(made[0]?.closes).toBe(1);
    // Calls while blocked do nothing, and a later press may try again.
    refused.answered();
    refused.hero();
    refused.setHidden(true);
    refused.setHidden(false);
    expect(await refused.start()).toBe(true);
    expect(refused.state).toBe('running');
    expect(made).toHaveLength(2);
  });

  it('answers one press once, and stop before the press closes it for good', async () => {
    const { ctx, audio } = setup();
    const [a, b] = await Promise.all([audio.start(), audio.start()]);
    expect(a && b).toBe(true);
    expect(ctx.nodes.filter((n) => n instanceof FakeCompressor)).toHaveLength(1);
    const idle = setup().audio;
    idle.stop();
    expect(idle.state).toBe('closed');
    expect(await idle.start()).toBe(false);
  });

  it('builds fewer voices with reducedCpu', async () => {
    const full = await started();
    const lite = await started({ reducedCpu: true });
    expect(lite.ctx.oscillators().length).toBeLessThan(full.ctx.oscillators().length);
    for (const s of [full, lite]) {
      s.audio.answered();
      s.audio.deskReady(2);
      await run(s.ctx, 120, 0.5);
    }
    expect(lite.ctx.nodes.length).toBeLessThan(full.ctx.nodes.length * 0.75);
  });
});
