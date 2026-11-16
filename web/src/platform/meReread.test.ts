// `/v1/me` again on coming back to the tab (the owner, Nov 16): signed in, someone known, at most once a minute.
import { describe, expect, it } from 'vitest';
import { ME_RETURN_GAP_MS, rereadOnReturn, type ReturnState } from './meReread';

const back: ReturnState = { hidden: false, signedIn: true, known: true, now: 1_000_000, askedAt: 1_000_000 - ME_RETURN_GAP_MS, gap: ME_RETURN_GAP_MS };

describe('rereadOnReturn', () => {
  it('asks again a minute or more after the last ask', () => {
    expect(ME_RETURN_GAP_MS).toBe(60_000);
    expect(rereadOnReturn(back)).toBe(true);
    expect(rereadOnReturn({ ...back, askedAt: 0 })).toBe(true);
  });

  it('not sooner: any read counts, the one at sign-in included', () => {
    expect(rereadOnReturn({ ...back, askedAt: back.now - ME_RETURN_GAP_MS + 1 })).toBe(false);
  });

  it('not on going away, signed out, or before Platform has said who this is', () => {
    expect(rereadOnReturn({ ...back, hidden: true })).toBe(false);
    expect(rereadOnReturn({ ...back, signedIn: false })).toBe(false);
    expect(rereadOnReturn({ ...back, known: false })).toBe(false);
  });

  it('a test gap of 0 asks every time', () => {
    expect(rereadOnReturn({ ...back, askedAt: back.now, gap: 0 })).toBe(true);
  });
});
