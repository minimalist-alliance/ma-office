import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, toHex } from './sha256';

const node = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('Sha256, a piece at a time', () => {
  it('gives the known digests of "" and "abc"', () => {
    expect(toHex(new Sha256().digest())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(new Sha256().update(new TextEncoder().encode('abc')).digest())).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agrees with node:crypto at every length across the padding boundaries', () => {
    for (let n = 0; n <= 200; n += 1) {
      const b = randomBytes(n);
      expect(toHex(new Sha256().update(b).digest())).toBe(node(b));
    }
  });

  it('gives the same digest however the bytes are split, as CHUNK frames and a resume split them', () => {
    const whole = randomBytes(1_000_003);
    for (const cut of [1, 3, 63, 64, 65, 16372, 262144]) {
      const h = new Sha256();
      for (let at = 0; at < whole.length; at += cut) h.update(whole.subarray(at, at + cut));
      expect(h.length).toBe(whole.length);
      expect(toHex(h.digest())).toBe(node(whole));
    }
  });

  it('gives its digest once', () => {
    const h = new Sha256();
    h.digest();
    expect(() => h.digest()).toThrow();
    expect(() => h.update(new Uint8Array(1))).toThrow();
  });
});
