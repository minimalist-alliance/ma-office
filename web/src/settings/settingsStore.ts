// Account settings, the office's full-screen modal (ADR 0052): open or not, which section, and whether a download in
// "Your data" is holding it. A download keeps running with the modal closed, so its panel stays mounted, out of sight,
// until it's finished and saved; opening Account settings again goes straight back to it.
import { create } from 'zustand';

export type SettingsSection = 'account' | 'data';

interface SettingsState {
  open: boolean;
  section: SettingsSection;
  /** A download is running, saving, or finished and waiting for "Save" or "Done". */
  holding: boolean;
}

export const useSettingsStore = create<SettingsState>(() => ({ open: false, section: 'account', holding: false }));

/** What had focus when it opened, which gets it back when it closes. */
let returnTo: HTMLElement | null = null;

export function openSettings(section?: SettingsSection, from?: HTMLElement | null): void {
  const s = useSettingsStore.getState();
  if (!s.open) returnTo = from ?? null;
  useSettingsStore.setState({ open: true, section: section ?? (s.holding ? 'data' : s.open ? s.section : 'account') });
}

export function closeSettings(): void {
  if (!useSettingsStore.getState().open) return;
  useSettingsStore.setState({ open: false });
  // Back to where the member opened it from, or else the account menu's button.
  const to = returnTo?.isConnected ? returnTo : typeof document === 'undefined' ? null : document.querySelector<HTMLElement>('.account-btn');
  returnTo = null;
  to?.focus({ preventScroll: true });
}

export function showSection(section: SettingsSection): void {
  useSettingsStore.setState({ section });
}

export function setHolding(holding: boolean): void {
  if (useSettingsStore.getState().holding !== holding) useSettingsStore.setState({ holding });
}
