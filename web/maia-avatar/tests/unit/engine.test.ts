// She moves exactly as version 7 does. The reference engine (docs/assets/maia/engine/src/engine.js, with the data and
// vocabulary its own build.py inlines) and the package's engine run the same scenes side by side, and every number a
// frame is drawn from must be identical after every step. The scenes are the reference preview's own scores and its
// chat, across all three tiers, with stream mode, reduced motion and every engine state.
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { buildReference } from '../../scripts/art.mjs';
import * as pkg from '../../src/engine.js';
import { parseScore } from '../../src/parse.js';

const ref = buildReference();
const ctx = vm.createContext({});
for (const code of [ref.dataJs, ref.vocabJs, ref.engine]) vm.runInContext(code, ctx);
const R = (ctx as unknown as { MaiaEngine: typeof pkg & { parseScore(i: unknown): (Parameters<typeof pkg.compileScore>[0]) | null } }).MaiaEngine;

type Av = pkg.Avatar & Record<string, unknown>;
type Act = (a: Av, E: 'ref' | 'pkg') => void;

/** The page's scores compile the same through the reference page's parser and through score.ts. */
function play(score: object): Act {
  return (a, E) => {
    if (E === 'ref') a.playCompiled(R.compileScore(R.parseScore(score)));
    else {
      const p = parseScore(score);
      a.playCompiled(pkg.compileScore(p ? { ...p, notes: [] } : null));
    }
  };
}
const call = (name: string, ...args: unknown[]): Act => (a) => (a[name] as (...x: unknown[]) => void)(...args);

const FIELDS = ['P', 'PV', 'E', 'EV', 'h', 'hv', 'ih', 'hl', 'il', 'sp', 'ip', 'm', 'R'] as const;
const NUMS = ['t', 'gx', 'gy', 'tx', 'ty', 'rot', 'sq', 'sleepClock', 'scoreT', 'chainK', 'gR', 'gT', 'gS', 'gZ', 'gB', 'rateSmooth', 'loop'] as const;
function snapshot(a: Av): unknown[] {
  const out: unknown[] = [a.state, a.dormant, a['hb'], a['eb'], a['bb']];
  for (const f of FIELDS) out.push(...Array.from(a[f] as Float64Array));
  for (const n of NUMS) out.push(a[n]);
  return out;
}

interface Scene { name: string; size: number; seconds: number; opts?: object; at: [number, Act][] }
const beats = (...l: [number, string, number][]) => l.map(([t, d, level]) => ({ t, do: d, level }));
const SCORES: Record<string, object> = {
  calm: { rhythm: 'breath', beats: beats([3, 'flick', 1], [9, 'bob', 1], [15, 'curl', 1]) },
  warm: { rhythm: 'breath', beats: beats([1, 'wave', 2], [4, 'smile', 2], [9, 'bob', 2], [15, 'smile', 1], [17, 'nod', 2]) },
  curious: { rhythm: 'lively', beats: beats([2, 'lift', 1], [5, 'lean', 2], [9, 'glance', 2], [13, 'flick', 2], [17, 'lean', 1]) },
  focused: { rhythm: 'quiet', beats: beats([3, 'curl', 2], [8, 'nod', 1], [14, 'glance', 2]) },
  gentle: { rhythm: 'quiet', beats: beats([3, 'soften', 2], [8, 'bob', 1], [14, 'nod', 1], [18, 'soften', 1]) },
  bright: { rhythm: 'lively', beats: beats([1, 'hop', 3], [2, 'smile', 2], [8, 'wave', 3], [12, 'flutter', 2], [14, 'hop', 2]) },
};
const CHAT = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: beats([0, 'wave', 2], [1, 'smile', 2], [5, 'bob', 2], [8, 'glance', 2], [11, 'lean', 2], [12, 'flick', 2], [17, 'smile', 1], [18, 'hop', 1]) };
const FULL = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 30, beats: beats([1, 'wave', 2], [2, 'smile', 1], [5, 'hop', 2], [7, 'lift', 2], [9, 'glance', 2], [11, 'nod', 2], [13, 'lean', 2], [15, 'flutter', 2], [17, 'flick', 3], [19, 'bob', 2], [21, 'smile', 2], [24, 'curl', 2]) };
const STREAM = { v: 1, mood: 'bright', rhythm: 'lively', seconds: 24, beats: beats([1, 'wave', 3], [2, 'hop', 3], [7, 'lift', 3], [8, 'lean', 2], [13, 'flick', 3], [14, 'hop', 2], [18, 'curl', 2]) };
const TRY = { v: 1, mood: 'curious', rhythm: 'drift', seconds: 26, beats: beats([1, 'lift', 2], [3, 'lean', 2], [5, 'glance', 2], [11, 'curl', 2], [16, 'hop', 1], [19, 'dance', 3]) };

const scenes: Scene[] = [
  ...Object.keys(SCORES).flatMap((mood, i) => [56, 112].map((size) => ({ name: `${mood} at ${size} px`, size, seconds: 26, opts: { seed: 21 + i }, at: [[0, play({ v: 1, mood, seconds: 24, ...SCORES[mood] })]] as [number, Act][] }))),
  ...[24, 32, 40, 64, 96, 200].map((size) => ({ name: `a full 12-beat score, two loops, at ${size} px`, size, seconds: 62, opts: { seed: 9 }, at: [[0, play(FULL)]] as [number, Act][] })),
  ...[56, 96].map((size) => ({ name: `stream mode at ${size} px`, size, seconds: 26, opts: { seed: 15 }, at: [[0, call('setStreamMode', true)], [0, play(STREAM)]] as [number, Act][] })),
  { name: 'the try-a-score example, with an unknown beat', size: 120, seconds: 28, opts: { seed: 2 }, at: [[0, play(TRY)]] },
  {
    name: 'the chat: thinking, speaking, the score, asleep and awake', size: 64, seconds: 50, opts: { seed: 11 },
    at: [[0, call('setState', 'thinking')], [4, call('setRate', 0)], [4, call('setState', 'speaking')], [5, call('setRate', 34)], [7, call('setRate', 12)],
      [9, play(CHAT)], [28, call('fallAsleep')], [32.5, call('setTheme', 'dusk')], [44, call('wake')]],
  },
  { name: 'the chat at 200 px', size: 200, seconds: 40, opts: { seed: 11 }, at: [[0, call('setState', 'thinking')], [3, call('setState', 'speaking')], [3, call('setRate', 32)], [8, play(CHAT)], [20, call('fallAsleep')], [35, call('wake')]] },
  { name: 'unavailable, until she settles and stops', size: 56, seconds: 10, opts: { seed: 7 }, at: [[0, call('setState', 'unavailable')]] },
  { name: 'woken while still falling asleep', size: 64, seconds: 12, opts: { seed: 7 }, at: [[1, call('fallAsleep')], [2.5, call('wake')]] },
  {
    name: 'reduced motion, fading between moods', size: 112, seconds: 20, opts: { seed: 7, reduced: true },
    at: [[0, call('setMood', 'warm')], [3, call('setMood', 'gentle')], [6, call('setMood', 'bright')], [9, call('setMood', 'focused')], [12, play(SCORES['bright'] ? { v: 1, mood: 'bright', seconds: 24, ...SCORES['bright'] } : {})], [15, call('fallAsleep')]],
  },
  { name: 'reduced motion switched on and off', size: 64, seconds: 14, opts: { seed: 3 }, at: [[0, play(CHAT)], [3, call('setReduced', true)], [7, call('setReduced', false)]] },
  { name: 'dark, with a beat a second', size: 64, seconds: 12, opts: { seed: 3, theme: 'dark' }, at: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((t, i) => [t, call('beat', ['wave', 'hop', 'smile', 'nod', 'glance', 'lean', 'curl', 'flutter', 'lift', 'flick'][i], 3)] as [number, Act]) },
];

describe('the package engine moves exactly as the reference', () => {
  for (const s of scenes) {
    test(s.name, () => {
      const make = (E: typeof pkg) => new E.Avatar(null, { size: s.size, dpr: 1, theme: 'light', ...s.opts }) as Av;
      const a = make(R), b = make(pkg);
      a.snap(); b.snap();
      expect(snapshot(b)).toStrictEqual(snapshot(a));
      const steps = Math.round(s.seconds / pkg.DT);
      const due = s.at.map(([t, f]) => [Math.round(t / pkg.DT), f] as const);
      const states = new Set<string>();
      for (let i = 0; i <= steps; i += 1) {
        for (const [at, f] of due) if (at === i) { f(a, 'ref'); f(b, 'pkg'); }
        a.step(); b.step();
        states.add(b.state);
        const x = snapshot(a), y = snapshot(b);
        if (!x.every((v, k) => Object.is(v, y[k]))) throw new Error(`differs at step ${i}: ${JSON.stringify(x.map((v, k) => [k, v, y[k]]).filter(([, p, q]) => !Object.is(p, q)).slice(0, 4))}`);
      }
      expect(states.size).toBeGreaterThan(0);
    });
  }

  test('the chat goes through every state the engine owns', () => {
    const b = new pkg.Avatar(null, { size: 64, dpr: 1, theme: 'light' }) as Av;
    const seen = new Set<string>();
    const run = (n: number) => { for (let i = 0; i < n; i += 1) { b.step(); seen.add(b.state); } };
    b.setState('thinking'); run(60); b.setState('speaking'); run(60); play(CHAT)(b, 'pkg'); run(60);
    b.fallAsleep(); run(200); b.wake(); run(60); b.setState('unavailable'); run(30);
    expect([...seen].sort()).toEqual(['falling', 'score', 'sleeping', 'speaking', 'thinking', 'unavailable', 'waking']);
  });

  test("the page's scores compile to the same timeline through score.ts as through the reference page's parser", () => {
    const strip = (c: object) => JSON.parse(JSON.stringify(c, (k, v) => (k === 'notes' ? undefined : v)));
    for (const score of [CHAT, FULL, STREAM, TRY, ...Object.entries(SCORES).map(([mood, s]) => ({ v: 1, mood, seconds: 24, ...s }))]) {
      const p = parseScore(score);
      expect(p).not.toBeNull();
      expect(strip(pkg.compileScore({ ...p!, notes: [] }))).toEqual(strip(R.compileScore(R.parseScore(score))));
    }
  });
});
