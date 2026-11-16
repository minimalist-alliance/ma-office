// The window states the desk app host borrows (`door.ts` `HostDeps`): in every app's window's chunk (`vite.config.ts`'s
// `windows` group), never the first load, and fetched beside the host's own chunk (`watch.ts`).
import { PanelBody } from '../browser/BrowserWindow';
import { windowVm } from '../desk/windowVm';
import { deskPanel } from '../notebook/panel';
import type { HostDeps } from './door';

export const hostDeps: HostDeps = { PanelBody, deskPanel, windowVm };
