// The Apps sheet's layer (ADR 0054), mounted by the first load's `../AppsLayer.tsx` once this chunk is here.
import AppsSheet from './AppsSheet';
import { useDeskAppsStore } from './store';

export function AppsLayer() {
  const sheet = useDeskAppsStore((s) => s.sheet);
  return sheet ? <AppsSheet deskId={sheet.deskId} appId={sheet.appId} /> : null;
}
