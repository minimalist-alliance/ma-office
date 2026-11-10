import { describe, expect, it } from 'vitest';
import { keptLine } from './keptLine';

describe('keptLine', () => {
  it('says the server\'s days, and points to desk agents where there are some', () => {
    expect(keptLine(30, true)).toBe('Chats are kept 30 days and pass through us, so keep private things with your desk agents.');
    expect(keptLine(14, false)).toBe('Chats are kept 14 days and pass through us.');
  });
  it('names no number when the server gives none', () => {
    expect(keptLine(null, true)).toBe('Chats pass through us, so keep private things with your desk agents.');
    expect(keptLine(null, false)).toBe('Chats pass through us.');
  });
});
