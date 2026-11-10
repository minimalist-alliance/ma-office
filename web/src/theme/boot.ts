// First module the entry imports: sets data-theme before React or any app CSS paints.
// The HTML page belongs to the Platform loader, which injects this bundle, so this runs
// at the earliest point the Desk app controls. See web/CLAUDE.md "Theme flash".
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

document.documentElement.setAttribute('data-theme', bootTheme(read(PREF_KEY), read(RESOLVED_KEY), systemDark()));
