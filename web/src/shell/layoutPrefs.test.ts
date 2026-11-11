import { beforeEach, describe, expect, it } from 'vitest';
import { adoptLayoutPrefs, resetLayoutPrefs, useLayoutPrefs, withPrefs } from './layoutPrefs';

describe('prefs in the layout document (design 9.4)', () => {
  beforeEach(resetLayoutPrefs);

  it('provider badges show until the document says otherwise', () => {
    expect(useLayoutPrefs.getState().showProviderBadges).toBe(true);
    adoptLayoutPrefs({ showProviderBadges: false });
    expect(useLayoutPrefs.getState().showProviderBadges).toBe(false);
  });
  it('anything else there, or nothing, reads as the default', () => {
    adoptLayoutPrefs({ showProviderBadges: false });
    adoptLayoutPrefs({ showProviderBadges: 'no' });
    expect(useLayoutPrefs.getState().showProviderBadges).toBe(true);
    adoptLayoutPrefs({ showProviderBadges: false });
    adoptLayoutPrefs(undefined);
    expect(useLayoutPrefs.getState().showProviderBadges).toBe(true);
  });
  it('what a newer build keeps in `prefs` goes back as it came', () => {
    useLayoutPrefs.setState({ showProviderBadges: false });
    expect(withPrefs({ theme: { mode: 'dusk' } })).toEqual({ theme: { mode: 'dusk' }, showProviderBadges: false });
    expect(withPrefs(undefined)).toEqual({ showProviderBadges: false });
  });
  it('keys this file doesn\'t read are kept as they came, and a key set here goes back with them (the free tier\'s)', () => {
    adoptLayoutPrefs({ showProviderBadges: false, freeSpotHiddenUntil: '2026-12-09T00:00:00.000Z', theme: { mode: 'dusk' } });
    expect(useLayoutPrefs.getState()['freeSpotHiddenUntil']).toBe('2026-12-09T00:00:00.000Z');
    useLayoutPrefs.setState({ maiaTrialNotNow: '2026-11-09T19:00:00.000Z' });
    expect(withPrefs({ theme: { mode: 'dusk' }, other: 1 })).toEqual({
      theme: { mode: 'dusk' },
      other: 1,
      showProviderBadges: false,
      freeSpotHiddenUntil: '2026-12-09T00:00:00.000Z',
      maiaTrialNotNow: '2026-11-09T19:00:00.000Z',
    });
  });
  it('nothing of one member\'s stays for the next', () => {
    adoptLayoutPrefs({ showProviderBadges: false, freeSaidOn: '2026-11-09T07:00:00.000Z' });
    resetLayoutPrefs();
    expect(useLayoutPrefs.getState()).toEqual({ showProviderBadges: true });
    expect(withPrefs(undefined)).toEqual({ showProviderBadges: true });
  });
});
