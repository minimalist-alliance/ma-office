import { describe, expect, it } from 'vitest';
import { browserPanel, type PanelInput } from './panel';

const base: PanelInput = { vm: 'running', phase: 'ready', queuePosition: null, link: 'open', unreachable: false, canPlayVideo: true, refused: null, hasFrame: true };
const panel = (p: Partial<PanelInput>) => browserPanel({ ...base, ...p });

describe('browserPanel', () => {
  it('a free desk waiting for room is a wait, shown before anything the desk or link might say', () => {
    expect(panel({ busy: true, link: 'retrying' })).toEqual({ kind: 'busy' });
    expect(panel({ busy: true, vm: 'held' })).toEqual({ kind: 'support' });
    expect(panel({ busy: false, link: 'retrying' })).toEqual({ kind: 'reconnecting' });
  });

  it('a running desk with a frame shows the picture and nothing else', () => {
    expect(panel({})).toEqual({ kind: 'playing' });
  });

  it('waiting for the first frame is its own calm state', () => {
    expect(panel({ hasFrame: false })).toEqual({ kind: 'starting' });
  });

  it('a desk thawing for the member says so, over the still or over nothing, and gives way to anything that matters more', () => {
    expect(panel({ resuming: true })).toEqual({ kind: 'resuming' });
    expect(panel({ resuming: true, hasFrame: false })).toEqual({ kind: 'resuming' });
    expect(panel({ resuming: true, link: 'resuming' })).toEqual({ kind: 'reconnecting' });
    expect(panel({ resuming: true, vm: 'stopping' })).toEqual({ kind: 'stopping' });
    expect(panel({ resuming: true, refused: 'forbidden' })).toEqual({ kind: 'forbidden' });
  });

  it('a stopped desk is asleep, whatever the link says', () => {
    expect(panel({ vm: 'stopped', link: 'idle', phase: 'stopped' })).toEqual({ kind: 'asleep' });
  });

  it.each([
    ['starting', 1],
    ['booting', 2],
    ['connecting', 3],
    [null, 1],
  ] as const)('waking in phase %s is step %i', (phase, step) => {
    expect(panel({ vm: 'starting', phase, link: 'idle' })).toEqual({ kind: 'waking', step });
  });

  it('queued shows the position', () => {
    expect(panel({ vm: 'starting', phase: 'queued', queuePosition: 3 })).toEqual({ kind: 'queued', position: 3 });
  });

  it('after the phases, opening a session is the last step', () => {
    expect(panel({ link: 'signaling', hasFrame: false })).toEqual({ kind: 'opening' });
    expect(panel({ link: 'connecting', hasFrame: false })).toEqual({ kind: 'opening' });
    expect(panel({ link: 'idle', hasFrame: false })).toEqual({ kind: 'opening' });
  });

  it('stopping holds whatever is on screen under its own state', () => {
    expect(panel({ vm: 'stopping' })).toEqual({ kind: 'stopping' });
  });

  it('a failed wake says so, by phase or by state', () => {
    expect(panel({ vm: 'error' })).toEqual({ kind: 'failed' });
    expect(panel({ vm: 'stopped', phase: 'failed' })).toEqual({ kind: 'failed' });
  });

  it('a lost session says reconnecting, and after 30 s that it cannot reach the desk', () => {
    expect(panel({ link: 'resuming' })).toEqual({ kind: 'reconnecting' });
    expect(panel({ link: 'retrying' })).toEqual({ kind: 'reconnecting' });
    expect(panel({ link: 'retrying', unreachable: true })).toEqual({ kind: 'unreachable' });
  });

  it('access denied beats everything about the stream', () => {
    expect(panel({ link: 'denied', hasFrame: false })).toEqual({ kind: 'denied' });
  });

  it('the idle rule closing the session is its own quiet state', () => {
    expect(panel({ link: 'resting' })).toEqual({ kind: 'resting' });
  });

  it('m=video 0 says this browser cannot play it, and never shows starting', () => {
    expect(panel({ canPlayVideo: false, hasFrame: false })).toEqual({ kind: 'unplayable' });
  });

  it('a desk that has no Browser yet, or refuses this session, says so', () => {
    expect(panel({ refused: 'not_found', hasFrame: false })).toEqual({ kind: 'unsupported' });
    expect(panel({ refused: 'forbidden', hasFrame: false })).toEqual({ kind: 'forbidden' });
  });

  it("a desk that won't start an older Chromium on the profile says so, and whether the member's try is out", () => {
    expect(panel({ refused: 'chromium_older_than_profile', hasFrame: false })).toEqual({ kind: 'outdated', trying: false });
    expect(panel({ refused: 'chromium_older_than_profile', hasFrame: false, trying: true })).toEqual({ kind: 'outdated', trying: true });
  });

  it('a desk asleep or out of reach says that first, as the refusal is only of this session', () => {
    expect(panel({ refused: 'chromium_older_than_profile', vm: 'stopped' })).toEqual({ kind: 'asleep' });
    expect(panel({ refused: 'chromium_older_than_profile', link: 'retrying' })).toEqual({ kind: 'reconnecting' });
  });

  it('an unknown desk is still opening, not asleep', () => {
    expect(panel({ vm: 'unknown', link: 'idle', phase: null })).toEqual({ kind: 'opening' });
  });
});

describe('contract 0.3.11 in the Browser window', () => {
  it('a new desk says it is being set up, with nothing to press, whatever the link says', () => {
    expect(panel({ vm: 'setting-up', link: 'idle', hasFrame: false })).toEqual({ kind: 'settingUp' });
  });

  it('a held desk, or one connect calls unavailable, shows the support address only', () => {
    expect(panel({ vm: 'held', link: 'idle' })).toEqual({ kind: 'support' });
    expect(panel({ link: 'denied', refusal: { kind: 'unavailable', billingUrl: null } })).toEqual({ kind: 'support' });
  });

  it('a refused membership replaces any picture, with its billing link or none', () => {
    expect(panel({ link: 'denied', refusal: { kind: 'suspended', billingUrl: 'https://platform.localhost/billing' } })).toEqual({ kind: 'membership', billingUrl: 'https://platform.localhost/billing' });
    expect(panel({ vm: 'stopped', link: 'signaling', refusal: { kind: 'inactive', billingUrl: null } })).toEqual({ kind: 'membership', billingUrl: null });
  });
});

describe('the data guard (ma-platform ADR 0110)', () => {
  it('shows the guard\'s own panel, not the membership one', () => {
    const refusal = { kind: 'data_guard' as const, billingUrl: null, message: 'Stopped.', resumesAt: '2026-11-17T07:00:00.000Z' };
    expect(browserPanel({ ...base, vm: 'stopped', link: 'denied', refusal })).toEqual({ kind: 'dataGuard', message: 'Stopped.', resumesAt: '2026-11-17T07:00:00.000Z' });
  });
});
