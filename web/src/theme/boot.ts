// First module the entry imports: sets data-theme before React or any app CSS paints.
// The HTML page belongs to the Platform loader, which injects this bundle, so this runs
// at the earliest point the Desk app controls. See web/CLAUDE.md "Theme flash".
import { MIRROR_KEY, paintBackdrop, parseMirror } from './backdropMirror';
import { bootTheme, PREF_KEY, RESOLVED_KEY } from './resolve';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function systemDark(): boolean | null {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return null;
  }
}

const root = document.documentElement;
const theme = bootTheme(read(PREF_KEY), read(RESOLVED_KEY), systemDark());
root.setAttribute('data-theme', theme);

// The office background this browser last showed, in this theme (ADR 0094): its colour and placeholder paint with the
// first frame, and `theme/backdrop.ts` takes over after the canvas's first paint. Hidden under "Plain background".
const mirror = parseMirror(read(MIRROR_KEY));
if (mirror && mirror.theme === theme && mirror.id !== 'none') paintBackdrop(root, mirror);
