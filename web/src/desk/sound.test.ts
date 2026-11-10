import { describe, expect, it } from 'vitest';
import type { BrowserMedia } from './deskLink';
import { LastSound, SOUND_QUIET_MS } from './sound';

let clock = 0;
const media = (silentFor: number | undefined): BrowserMedia => ({ stream: {} as MediaStream, canPlayVideo: true, ...(silentFor === undefined ? {} : { silentFor: () => silentFor }) });

describe('LastSound', () => {
  it('the quiet time is a minute', () => {
    expect(SOUND_QUIET_MS).toBe(60_000);
  });

  it('nothing heard, or nothing to ask, is no sound', () => {
    const s = new LastSound(() => clock);
    expect(s.playing(null)).toBe(false);
    expect(s.playing(media(undefined))).toBe(false); // a link that can't tell, such as the mock
    expect(s.playing(media(Infinity))).toBe(false);
  });

  it('sound just heard plays on for SOUND_QUIET_MS, and then has stopped', () => {
    clock = 1_000_000;
    const s = new LastSound(() => clock);
    expect(s.left(media(2_000))).toBe(SOUND_QUIET_MS - 2_000);
    clock += SOUND_QUIET_MS - 2_001;
    expect(s.playing(media(SOUND_QUIET_MS - 1))).toBe(true);
    clock += 1;
    expect(s.playing(media(SOUND_QUIET_MS))).toBe(false);
  });

  it('keeps what an earlier session said, so a reconnect is not the sound stopping', () => {
    clock = 1_000_000;
    const s = new LastSound(() => clock);
    expect(s.playing(media(0))).toBe(true);
    clock += 1_000;
    expect(s.playing(null)).toBe(true); // between sessions
    expect(s.playing(media(Infinity))).toBe(true); // a new one with nothing heard yet
    clock += SOUND_QUIET_MS;
    expect(s.playing(media(Infinity))).toBe(false);
  });

  it('a longer quiet time for a caller that asks seldom', () => {
    clock = 1_000_000;
    const s = new LastSound(() => clock, 2 * SOUND_QUIET_MS);
    s.left(media(0));
    clock += SOUND_QUIET_MS + 1;
    expect(s.playing(null)).toBe(true);
  });
});
