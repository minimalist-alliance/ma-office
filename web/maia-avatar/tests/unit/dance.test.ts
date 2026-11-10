// DANCE: she dances exactly as the Product Designer's draft does. The draft's engine (version 7 with dance/engine.diff,
// checked against the draft's own hash) and the package's run the Party routine side by side, and every number a
// frame is drawn from, the dance's own included, must be identical after every step. Where the draft is on this
// machine, the reference runs with the draft's own vocab.js, so this also shows src/art holds the draft's data.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { buildDance, buildDanceReference, danceSource } from '../../scripts/dance.mjs';
import * as pkg from '../../src/engine.js';
import { parseScore } from '../../src/parse.js';
import { makeParser } from '../../src/score.js';
import { vocabulary } from '../../src/parse.js';
import ROUTINE from '../../src/art/routine.json';

const ref = buildDanceReference();
const ctx = vm.createContext({});
for (const code of [ref.dataJs, ref.vocabJs, ref.engine]) vm.runInContext(code, ctx);
type RefEngine = typeof pkg & { parseScore(i: unknown): Parameters<typeof pkg.compileScore>[0] | null };
const R = (ctx as unknown as { MaiaEngine: RefEngine }).MaiaEngine;

type Av = pkg.Avatar & Record<string, unknown>;
type Act = (a: Av, E: 'ref' | 'pkg') => void;

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

const FIELDS = ['P', 'PV', 'E', 'EV', 'h', 'hv', 'ih', 'hl', 'il', 'sp', 'ip', 'm', 'R', 'RV'] as const;
const NUMS = ['t', 'gx', 'gy', 'tx', 'ty', 'rot', 'sq', 'sleepClock', 'scoreT', 'chainK', 'gR', 'gT', 'gS', 'gZ', 'gB', 'rateSmooth', 'loop',
  'rOn', 'rT', 'rE', 'rFading', 'rFade', 'spinA', 'spinV', 'yawA', 'wk', 'rPend'] as const;
function snapshot(a: Av): unknown[] {
  const out: unknown[] = [a.state, a.dormant, a['hb'], a['eb'], a['bb'], a['ro'] === null];
  for (const f of FIELDS) out.push(...Array.from(a[f] as Float64Array));
  for (const n of NUMS) out.push(a[n]);
  return out;
}

const PARTY = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [], routine: 'party' };
const BRIGHT = { v: 1, mood: 'bright', rhythm: 'lively', seconds: 24, beats: [{ t: 2, do: 'hop', level: 2 }, { t: 5, do: 'smile', level: 2 }], routine: 'party' };
const CHAT = { v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [{ t: 0, do: 'wave', level: 2 }, { t: 1, do: 'smile', level: 2 }] };
const LONG = 30; // the dance is 23.2 s, then she settles

interface Scene { name: string; size: number; seconds: number; opts?: object; at: [number, Act][] }
const scenes: Scene[] = [
  ...[40, 64, 120, 200].map((size) => ({ name: `the whole dance and the settle at ${size} px`, size, seconds: LONG, opts: { seed: 11 }, at: [[0.5, play(PARTY)]] as [number, Act][] })),
  { name: 'in a bright score: the dance, then the score and its beats', size: 64, seconds: 40, opts: { seed: 4 }, at: [[0, play(BRIGHT)]] },
  { name: 'cut short by a new turn mid-pirouette: the turn fades the short way', size: 112, seconds: 20, opts: { seed: 6 }, at: [[0, play(PARTY)], [13.1, call('setState', 'thinking')], [15, call('setState', 'speaking')], [15, call('setRate', 30)], [17, play(CHAT)]] },
  { name: 'cut short by a new score during the dip', size: 64, seconds: 22, opts: { seed: 6 }, at: [[0, play(PARTY)], [15.2, play(CHAT)]] },
  { name: 'a second dance over the first', size: 64, seconds: 34, opts: { seed: 6 }, at: [[0, play(PARTY)], [6, play(PARTY)]] },
  { name: 'a desk stream starting mid-dance: the dance fades, the turn too', size: 96, seconds: 18, opts: { seed: 8 }, at: [[0, play(PARTY)], [12.9, call('setStreamMode', true)]] },
  { name: 'during a desk stream: a smile instead', size: 64, seconds: 8, opts: { seed: 8 }, at: [[0, call('setStreamMode', true)], [0.2, play(PARTY)]] },
  { name: 'reduced motion switched on mid-dance: it stops at once, with a smile', size: 64, seconds: 10, opts: { seed: 3 }, at: [[0, play(PARTY)], [4.4, call('setReduced', true)], [8, call('setReduced', false)]] },
  { name: 'reduced motion throughout: a smile instead', size: 64, seconds: 8, opts: { seed: 3, reduced: true }, at: [[0.5, play(PARTY)]] },
  { name: 'asleep: she wakes first, then dances', size: 64, seconds: 40, opts: { seed: 2 }, at: [[0, call('fallAsleep')], [6, play(PARTY)]] },
  { name: 'falling asleep mid-dance', size: 64, seconds: 14, opts: { seed: 2 }, at: [[0, play(PARTY)], [9, call('fallAsleep')]] },
  { name: 'unavailable mid-dance', size: 64, seconds: 12, opts: { seed: 2 }, at: [[0, play(PARTY)], [3, call('setState', 'unavailable')]] },
  { name: 'beats fired over the dance', size: 64, seconds: 12, opts: { seed: 5 }, at: [[0, play(PARTY)], [2, call('beat', 'hop', 3)], [4, call('beat', 'blink', 2)], [7, call('beat', 'wave', 3)], [9, call('beat', 'flutter', 2)]] },
];

describe('the package dances exactly as the draft', () => {
  test(`the reference runs ${ref.draftVocab ? "the draft's own vocab.js" : "version 7's vocabulary with src/art's dance (the draft isn't on this machine)"}`, () => {
    expect(R.ROUTINES.has('party')).toBe(true);
    expect(pkg.ROUTINES.has('party')).toBe(true);
    expect([...pkg.ROUTINES.keys()]).toEqual(['party']);
    const a = R.ROUTINES.get('party')!, b = pkg.ROUTINES.get('party')!;
    expect(b.seconds).toBe(a.seconds);
    expect(b.bps).toBe(a.bps);
    expect(b.lead).toBe(a.lead);
  });

  for (const s of scenes) {
    test(s.name, () => {
      const make = (E: typeof pkg) => new E.Avatar(null, { size: s.size, dpr: 1, theme: 'dusk', ...s.opts }) as Av;
      const a = make(R), b = make(pkg);
      a.snap(); b.snap();
      expect(snapshot(b)).toStrictEqual(snapshot(a));
      const steps = Math.round(s.seconds / pkg.DT);
      const due = s.at.map(([t, f]) => [Math.round(t / pkg.DT), f] as const);
      let danced = 0;
      for (let i = 0; i <= steps; i += 1) {
        for (const [at, f] of due) if (at === i) { f(a, 'ref'); f(b, 'pkg'); }
        a.step(); b.step();
        if (b.state === 'routine') danced += 1;
        const x = snapshot(a), y = snapshot(b);
        if (!x.every((v, k) => Object.is(v, y[k]))) throw new Error(`differs at step ${i}: ${JSON.stringify(x.map((v, k) => [k, v, y[k]]).filter(([, p, q]) => !Object.is(p, q)).slice(0, 4))}`);
      }
      // Under a stream or reduced motion there's no dance; everywhere else there is.
      const none = /smile instead/.test(s.name);
      if (none) expect(danced).toBe(0);
      else expect(danced).toBeGreaterThan(30);
    });
  }

  test('the whole dance is 23.2 s, 48 beats at 124 a minute, and she settles into warm', () => {
    const b = new pkg.Avatar(null, { size: 64, dpr: 1, seed: 1 }) as Av;
    play(PARTY)(b, 'pkg');
    let n = 0, started = -1;
    for (; n < 40 * 30; n += 1) {
      b.step();
      if (b.state === 'routine' && started < 0) started = n;
      if (started >= 0 && b.state !== 'routine') break;
    }
    expect((n - started) * pkg.DT).toBeCloseTo(48 * 60 / 124, 1);
    expect(b['moodName']).toBe('warm');
  });
});

describe("the score: score.ts's `routine` (ma-platform 6bee406)", () => {
  const contract = makeParser(vocabulary);
  test('party rides along, exactly as the contract parses it', () => {
    expect(contract(PARTY)?.routine).toBe('party');
    expect(parseScore(PARTY)).toStrictEqual(contract(PARTY));
    expect(parseScore(JSON.stringify(BRIGHT))).toStrictEqual(contract(BRIGHT));
  });
  test("groove and swim, which the contract allows and this engine doesn't know, are dropped; the score still plays", () => {
    for (const routine of ['groove', 'swim']) {
      expect(contract({ ...PARTY, routine })?.routine).toBe(routine);
      const p = parseScore({ ...PARTY, routine });
      expect(p).toStrictEqual({ v: 1, mood: 'warm', rhythm: 'breath', seconds: 24, beats: [] });
      expect(p && 'routine' in p).toBe(false);
    }
  });
  test('anything else is the contract parser\'s answer', () => {
    for (const routine of ['PARTY', '__proto__', 'toString', 1, null, {}, ['party']]) {
      expect(parseScore({ ...PARTY, routine })).toStrictEqual(contract({ ...PARTY, routine }));
      expect(parseScore({ ...PARTY, routine })?.routine).toBeUndefined();
    }
    expect(parseScore({ v: 1, routine: 'party' })).toBeNull();
    expect(parseScore({ ...PARTY, v: 2 })).toBeNull();
  });
  test('a groove score plays its mood and beats with no dance', () => {
    const b = new pkg.Avatar(null, { size: 64, dpr: 1 }) as Av;
    play({ ...BRIGHT, routine: 'groove' })(b, 'pkg');
    for (let i = 0; i < 90; i += 1) { b.step(); expect(b.state).not.toBe('routine'); }
    expect(b['moodName']).toBe('bright');
  });
});

describe('her data is the draft\'s', () => {
  const dir = danceSource();
  test.skipIf(!existsSync(join(dir, 'vocab.js')))('src/art/dance.json and routine.json are what scripts/dance.mjs gives from the draft today', async () => {
    const { readFileSync } = await import('node:fs');
    const out = buildDance('party', dir);
    expect(readFileSync(new URL('../../src/art/dance.json', import.meta.url), 'utf8')).toBe(out.dance);
    expect(readFileSync(new URL('../../src/art/routine.json', import.meta.url), 'utf8')).toBe(out.routine);
  });
  test("the routine's eye cues are version 7's own beats, and her vocabulary gains nothing", () => {
    const eyes = new Set(Object.keys(pkg.VOCAB.beats).filter((k) => pkg.VOCAB.beats[k]!.track === 'eyes'));
    const steps = ROUTINE.routine.steps as unknown[][];
    const cues = steps.map((s) => s[1] as string).filter((n) => !(n in ROUTINE.moves));
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) expect(eyes.has(c), c).toBe(true);
    for (const n of ['wink', 'twirl', 'shimmy', 'giggle', 'cheer', 'stretch']) expect(n in pkg.VOCAB.beats).toBe(false);
    expect(vocabulary.beats.map((b) => b.name)).not.toContain('wink');
  });
});
