import { beforeEach, describe, expect, it } from 'vitest';
import { closeSettings, openSettings, setHolding, showSection, useSettingsStore } from './settingsStore';

describe('settingsStore', () => {
  beforeEach(() => useSettingsStore.setState({ open: false, section: 'account', holding: false }));

  it('opens on Account, or on the section asked for', () => {
    openSettings();
    expect(useSettingsStore.getState()).toMatchObject({ open: true, section: 'account' });
    closeSettings();
    openSettings('data');
    expect(useSettingsStore.getState()).toMatchObject({ open: true, section: 'data' });
  });

  it('goes back to a download that is holding it, wherever it was left', () => {
    openSettings('data');
    setHolding(true);
    showSection('account');
    closeSettings();
    expect(useSettingsStore.getState()).toMatchObject({ open: false, holding: true });
    openSettings();
    expect(useSettingsStore.getState().section).toBe('data');
  });

  it('starts on Account again once nothing holds it', () => {
    openSettings('data');
    closeSettings();
    openSettings();
    expect(useSettingsStore.getState().section).toBe('account');
  });
});
