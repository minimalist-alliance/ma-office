import { describe, expect, it } from 'vitest';
import { CREDIT_STEP, CreditWindow, FIRST_WINDOW, parseTrailer, trailerMatches } from './credit';

const MiB = 1024 * 1024;

describe('CreditWindow', () => {
  it('starts with the MiB data.read grants, and grants nothing before a step is written', () => {
    const w = new CreditWindow(0);
    expect(w.granted).toBe(FIRST_WINDOW);
    expect(w.writtenTo(16372)).toBe(0);
    expect(w.writtenTo(CREDIT_STEP - 1)).toBe(0);
  });

  it('grants after writing, in steps of at least 256 KiB, keeping a MiB ahead of what is written', () => {
    const w = new CreditWindow(0);
    const grants: number[] = [];
    for (let pos = 16372; pos <= 4 * MiB; pos += 16372) {
      const g = w.writtenTo(pos);
      if (g) grants.push(g);
      expect(w.granted - pos).toBeLessThanOrEqual(FIRST_WINDOW);
      expect(w.granted - pos).toBeGreaterThan(FIRST_WINDOW - CREDIT_STEP);
    }
    expect(grants.length).toBeGreaterThan(10);
    for (const g of grants) expect(g).toBeGreaterThanOrEqual(CREDIT_STEP);
  });

  it('counts from the offset of a resumed read, so what came before it earns nothing', () => {
    const w = new CreditWindow(5 * MiB);
    expect(w.granted).toBe(6 * MiB);
    expect(w.writtenTo(4 * MiB)).toBe(0); // bytes from the last session, still being written
    expect(w.writtenTo(5 * MiB + CREDIT_STEP)).toBe(CREDIT_STEP);
  });

  it('knows when the desk is waiting on us rather than stalled', () => {
    const w = new CreditWindow(0);
    expect(w.waitingOnUs(MiB - 1)).toBe(false);
    expect(w.waitingOnUs(MiB)).toBe(true);
  });
});

describe('the END trailer', () => {
  const trailer = (sha: number[], size: bigint): Uint8Array => {
    const b = new Uint8Array(40);
    b.set(sha);
    new DataView(b.buffer).setBigUint64(32, size);
    return b;
  };
  const sha = Array.from({ length: 32 }, (_, i) => i);

  it('is 32 bytes of SHA-256 and a u64be size', () => {
    expect(parseTrailer(trailer(sha, 5_000_000_000n))).toEqual({ sha256: new Uint8Array(sha), size: 5_000_000_000 });
    expect(parseTrailer(new Uint8Array(39))).toBeNull();
    expect(parseTrailer(trailer(sha, 2n ** 60n))).toBeNull();
  });

  it('matches only the same hash and the same size', () => {
    const t = parseTrailer(trailer(sha, 10n));
    expect(trailerMatches(t, new Uint8Array(sha), 10)).toBe(true);
    expect(trailerMatches(t, new Uint8Array(sha), 9)).toBe(false);
    const other = [...sha];
    other[31] = 99;
    expect(trailerMatches(t, new Uint8Array(other), 10)).toBe(false);
    expect(trailerMatches(null, new Uint8Array(sha), 10)).toBe(false);
  });
});
