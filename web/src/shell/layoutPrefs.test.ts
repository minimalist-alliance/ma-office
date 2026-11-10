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
});
