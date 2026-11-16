import { describe, expect, it } from 'vitest';
import {
  CADENCE,
  DYADS,
  GLASS_NOTES,
  HERO_CHORD,
  LOW_NOTES,
  MOTIF_GAP,
  MOTIF_NOTES,
  MOTIFS,
  cadenceSpan,
  db,
  hz,
  motifDue,
  phrase,
  picker,
  seeded,
} from './score';

// D major's pitch classes: D E F# G A B C#.
const KEY = new Set([2, 4, 6, 7, 9, 11, 1]);

describe('the welcome score', () => {
  it('stays in one key everywhere', () => {
    const all = [...MOTIF_NOTES, ...DYADS.flat(), ...GLASS_NOTES, ...LOW_NOTES, ...HERO_CHORD, ...CADENCE.lean, ...CADENCE.home, ...CADENCE.line, CADENCE.glass];
    for (const m of all) expect(KEY.has(m % 12), `MIDI ${m}`).toBe(true);
    expect(hz(69)).toBe(440);
    expect(db(-10)).toBeCloseTo(0.3162, 4);
  });

  it('has twelve motif variants of 3 to 5 notes, no two alike', () => {
    expect(MOTIFS).toHaveLength(12);
    const seen = new Set<string>();
    for (const m of MOTIFS) {
      expect(m.length).toBeGreaterThanOrEqual(3);
      expect(m.length).toBeLessThanOrEqual(5);
      for (const [note] of m) expect(MOTIF_NOTES[note]).toBeDefined();
      const key = m.map(([n]) => n).join(',');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('makes phrases of 8 to 12 s with silences of 2 to 6 s', () => {
    const r = seeded(3);
    for (let i = 0; i < 500; i++) {
      const { len, rest } = phrase(r);
      expect(len).toBeGreaterThanOrEqual(8);
      expect(len).toBeLessThanOrEqual(12);
      expect(rest).toBeGreaterThanOrEqual(2);
      expect(rest).toBeLessThanOrEqual(6);
    }
  });

  it('never picks one of the last three motifs, whatever the random', () => {
    const randoms: [string, () => number][] = [
      ['seeded', seeded(11)],
      ['always 0', () => 0],
      ['always almost 1', () => 0.999999],
      ['Math.random', Math.random],
    ];
    for (const [name, r] of randoms) {
      const pick = picker(12, 3, r);
      const history: number[] = [];
      for (let i = 0; i < 400; i++) {
        const p = pick();
        expect(p, name).toBeGreaterThanOrEqual(0);
        expect(p, name).toBeLessThan(12);
        expect(history.slice(-3), `${name} at ${i}`).not.toContain(p);
        history.push(p);
      }
      // With a real random it uses all twelve over a long run, so it never settles into a loop of four.
      if (!name.startsWith('always')) expect(new Set(history).size, name).toBe(12);
    }
  });

  it('spaces motifs 20 to 40 s apart, the first at once', () => {
    const r = seeded(5);
    let start = 0;
    let last: number | null = null;
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      const { len, rest } = phrase(r);
      const next = start + len + rest;
      if (motifDue(start, next, last, r)) {
        const at = start + MOTIF_GAP.offsetMin + r() * (MOTIF_GAP.offsetMax - MOTIF_GAP.offsetMin);
        times.push(at);
        last = at;
      }
      start = next;
    }
    expect(times[0]).toBeLessThanOrEqual(2);
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(20);
      expect(gap).toBeLessThanOrEqual(40);
    }
  });

  it('times the cadence to end where it is asked to, 8 s at most', () => {
    expect(cadenceSpan(100, 110)).toEqual({ start: 102, len: 8 });
    expect(cadenceSpan(100, 107)).toEqual({ start: 100, len: 7 });
    expect(cadenceSpan(100, 103)).toEqual({ start: 100, len: 3 });
    expect(cadenceSpan(100, 99)).toEqual({ start: 99, len: 0 });
  });
});
