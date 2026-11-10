import { randomBytes } from 'node:crypto';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';

describe('crc32', () => {
  it('gives the check value for "123456789"', () => {
    expect(crc32(0, new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for nothing, and agrees with zlib at every length around the 8-byte stride', () => {
    expect(crc32(0, new Uint8Array(0))).toBe(0);
    for (let n = 1; n <= 40; n += 1) {
      const b = randomBytes(n);
      expect(crc32(0, b)).toBe(zlibCrc32(b));
    }
  });

  it('carries on across pieces of any size, as a resumed file does', () => {
    const whole = randomBytes(200_003);
    for (const cut of [1, 7, 8, 16372, 65536, 199_999]) {
      let c = 0;
      for (let at = 0; at < whole.length; at += cut) c = crc32(c, whole.subarray(at, at + cut));
      expect(c).toBe(zlibCrc32(whole));
    }
  });
});
