import { describe, expect, it } from 'vitest';
import { embedUrl, frameRefused, frameState } from './accountFrame';

const ORIGIN = 'https://platform.minimalistalliance.com';
const frame = {} as Window;
const other = {} as Window;

describe('embedUrl', () => {
  it('adds embed=office', () => {
    expect(embedUrl('https://platform.minimalistalliance.com/account')).toBe('https://platform.minimalistalliance.com/account?embed=office');
  });
  it('keeps what the link already has, and never doubles it', () => {
    expect(embedUrl('https://platform.minimalistalliance.com/account?from=office&embed=x')).toBe('https://platform.minimalistalliance.com/account?from=office&embed=office');
  });
});

describe('frameState', () => {
  const msg = (data: unknown, over: Partial<{ origin: string; source: Window }> = {}) => ({ origin: ORIGIN, source: frame, data, ...over });
  it('reads the three states', () => {
    expect(frameState(msg({ type: 'ma-account', state: 'ready' }), frame, ORIGIN)).toBe('ready');
    expect(frameState(msg({ type: 'ma-account', state: 'signed-out' }), frame, ORIGIN)).toBe('signed-out');
    expect(frameState(msg({ type: 'ma-account', state: 'escape' }), frame, ORIGIN)).toBe('escape');
  });
  it('ignores another origin, another window, or no frame', () => {
    expect(frameState(msg({ type: 'ma-account', state: 'ready' }, { origin: 'https://evil.example' }), frame, ORIGIN)).toBeNull();
    expect(frameState(msg({ type: 'ma-account', state: 'ready' }, { origin: 'https://guild.minimalistalliance.com' }), frame, ORIGIN)).toBeNull();
    expect(frameState(msg({ type: 'ma-account', state: 'ready' }, { source: other }), frame, ORIGIN)).toBeNull();
    expect(frameState(msg({ type: 'ma-account', state: 'ready' }), null, ORIGIN)).toBeNull();
  });
  it('ignores anything not in the agreed shape', () => {
    expect(frameState(msg('ready'), frame, ORIGIN)).toBeNull();
    expect(frameState(msg(null), frame, ORIGIN)).toBeNull();
    expect(frameState(msg({ type: 'ma-account', state: 'navigate' }), frame, ORIGIN)).toBeNull();
    expect(frameState(msg({ type: 'other', state: 'ready' }), frame, ORIGIN)).toBeNull();
  });
});

describe('frameRefused', () => {
  it('is the office CSP refusing that origin', () => {
    expect(frameRefused({ effectiveDirective: 'frame-src', blockedURI: `${ORIGIN}/account?embed=office` }, ORIGIN)).toBe(true);
    expect(frameRefused({ effectiveDirective: 'default-src', blockedURI: ORIGIN }, ORIGIN)).toBe(true);
  });
  it('is not another directive or another address', () => {
    expect(frameRefused({ effectiveDirective: 'img-src', blockedURI: `${ORIGIN}/a.png` }, ORIGIN)).toBe(false);
    expect(frameRefused({ effectiveDirective: 'frame-src', blockedURI: 'https://elsewhere.example/' }, ORIGIN)).toBe(false);
  });
});
