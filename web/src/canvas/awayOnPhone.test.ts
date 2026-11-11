import { describe, expect, it } from 'vitest';
import { awayOnPhone } from './awayOnPhone';

describe('the desks a phone does not draw', () => {
  it('in desk mode, every desk but the one in front', () => {
    expect(awayOnPhone(true, 'desk', 'a', 'b')).toBe(true);
    expect(awayOnPhone(true, 'desk', 'a', 'a')).toBe(false);
  });
  it('the overview, a free camera and larger screens draw them all', () => {
    expect(awayOnPhone(true, 'overview', 'a', 'b')).toBe(false);
    expect(awayOnPhone(true, 'free', 'a', 'b')).toBe(false);
    expect(awayOnPhone(false, 'desk', 'a', 'b')).toBe(false);
  });
});
