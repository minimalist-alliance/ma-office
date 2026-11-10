import { describe, expect, it } from 'vitest';
import { uuidv7 } from './idem';

describe('uuidv7', () => {
  it('has the shape, version and variant, and is at most 128 chars', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('starts with 48 bits of milliseconds, so later ones sort later', () => {
    const at = 0x0198_1234_5678;
    expect(uuidv7(at, (b) => b.fill(0))).toBe('01981234-5678-7000-8000-000000000000');
    expect(uuidv7(at + 1) > uuidv7(at)).toBe(true);
  });

  it('keeps the random bits around the version and variant', () => {
    expect(uuidv7(0, (b) => b.fill(0xff))).toBe('00000000-0000-7fff-bfff-ffffffffffff');
  });

  it('two in the same millisecond differ', () => {
    expect(uuidv7(1000)).not.toBe(uuidv7(1000));
  });
});
