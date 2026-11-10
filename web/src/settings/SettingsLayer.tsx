// Mounts Account settings (ADR 0052) while it's open, or while a download in it still needs it. Its code loads on first open.
import { lazy, Suspense } from 'react';
import { useSettingsStore } from './settingsStore';

const AccountSettings = lazy(() => import('./AccountSettings'));

export function SettingsLayer() {
  const show = useSettingsStore((s) => s.open || s.holding);
  if (!show) return null;
  return (
    <Suspense fallback={null}>
      <AccountSettings />
    </Suspense>
  );
}
