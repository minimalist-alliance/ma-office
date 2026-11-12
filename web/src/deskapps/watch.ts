// Imported by `Shell` for what it does (ADR 0054): an app's tile in the layout loads the desk app host's chunk (its widget, its
// name, its window), from the first layout on. Apart from `door.ts` so the door imports no store but its own.
import { isDeskApp } from '../canvas/layout';
import { useLayoutStore } from '../state/layoutStore';
import { PanelBody } from '../browser/BrowserWindow';
import { windowVm } from '../desk/windowVm';
import { deskPanel } from '../notebook/panel';
import { loadHost, setHostImport, useDoor } from './door';

setHostImport(() => import('./host/index'), { PanelBody, deskPanel, windowVm });

// Until the host is here, an app's tile in any desk's layout loads it.
const check = (): void => {
  if (!useDoor.getState().host && Object.values(useLayoutStore.getState().desks).some((d) => d.items.some((i) => isDeskApp(i.app)))) loadHost();
};
check();
useLayoutStore.subscribe(check);
