// Whether the owner's "About this desk" is open (`AccountPanel.tsx`), remembered in this browser. Only the owner sees it,
// so it says who used this browser: it goes with the layout's mirror on every signed-out state and is written only while
// that may be (`MEMBER_CACHE_KEYS` in `state/layoutStore.ts`, ISS-89).
import { readJson, writeJson } from '../lib/util';
import { layoutMirrorWritable } from '../state/layoutStore';

export const ABOUT_KEY = 'ma.menu.about.v1';

/** Shut by default. */
export const aboutOpen = (): boolean => readJson<boolean>(ABOUT_KEY) === true;

export function keepAboutOpen(open: boolean): void {
  if (layoutMirrorWritable()) writeJson(ABOUT_KEY, open);
}
