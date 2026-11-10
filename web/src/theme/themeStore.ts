// themeStore (design 3.12): { pref, resolved, t, rev }. CSS follows data-theme on <html>;
// Konva reads the same token objects from this store, so both switch together.
import { flushSync } from 'react-dom';
import { create } from 'zustand';
import { THEMES, type Tokens } from './tokens';
import { DEFAULT_PREF, parsePref, PREF_KEY, RESOLVED_KEY, resolveTheme, type ResolvedTheme, type ThemePref } from './resolve';
import { reducedMotion } from '../lib/util';

export interface ThemeState {
  pref: ThemePref;
  resolved: ResolvedTheme;
  t: Tokens;
  rev: number;
}

const root = document.documentElement;
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    return parsePref(window.localStorage.getItem(PREF_KEY)) ?? DEFAULT_PREF;
  } catch {
    return DEFAULT_PREF;
  }
}

const initialPref = readPref();
const initialResolved = resolveTheme(initialPref, media.matches);

export const useThemeStore = create<ThemeState>(() => ({
  pref: initialPref,
  resolved: initialResolved,
  t: THEMES[initialResolved],
  rev: 1,
}));

export const getTheme = (): ThemeState => useThemeStore.getState();

/** Selector hook, so a component re-renders only for what it reads. */
export function useTheme<T>(selector: (s: ThemeState) => T): T {
  return useThemeStore(selector);
}

// The canvas registers here: sprites are dropped and the layer redrawn inside the
// transition's update callback, so DOM and canvas land in the same frame.
const redraws = new Set<() => void>();
export function onThemeApplied(fn: () => void): () => void {
  redraws.add(fn);
  return () => redraws.delete(fn);
}

function setMetaThemeColor(t: Tokens): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = t.surface.worldBase;
}

function writeAttr(resolved: ResolvedTheme): void {
  root.setAttribute('data-theme', resolved);
  setMetaThemeColor(THEMES[resolved]);
  // The Platform loader's blocking /_loader/theme.js reads this key before first paint.
  try {
    window.localStorage.setItem(RESOLVED_KEY, resolved);
  } catch {
    /* storage unavailable */
  }
}

function apply(pref: ThemePref, resolved: ResolvedTheme, bump: boolean): void {
  const s = getTheme();
  flushSync(() => {
    useThemeStore.setState({ pref, resolved, t: THEMES[resolved], rev: s.rev + (bump ? 1 : 0) });
  });
  writeAttr(resolved);
  redraws.forEach((fn) => fn());
}

function commit(pref: ThemePref, animate: boolean): void {
  const resolved = resolveTheme(pref, media.matches);
  const changed = resolved !== getTheme().resolved;
  if (!changed) {
    useThemeStore.setState({ pref });
    return;
  }
  const update = (): void => {
    const start = performance.now();
    apply(pref, resolved, true);
    performance.measure('ma:theme-switch', { start, end: performance.now() });
  };
  if (animate && !reducedMotion() && typeof document.startViewTransition === 'function') {
    document.startViewTransition(update);
  } else {
    update();
  }
}

export function setThemePref(next: Partial<ThemePref>): void {
  const pref = { ...getTheme().pref, ...next };
  try {
    window.localStorage.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    /* storage unavailable */
  }
  commit(pref, true);
}

// The loader's theme.js sets an inline background and color-scheme on <html> so the page
// never flashes the wrong color. Drop them once themes.css has applied, or later theme
// switches stay stuck on the boot color. The stylesheet the loader injects may still be
// loading when this module runs, so wait until a token actually resolves.
export function clearBootStyles(framesLeft = 600): void {
  if (getComputedStyle(root).getPropertyValue('--ma-surface-tile').trim()) {
    root.style.removeProperty('background-color');
    root.style.removeProperty('color-scheme');
    return;
  }
  if (framesLeft > 0) requestAnimationFrame(() => clearBootStyles(framesLeft - 1));
}

writeAttr(initialResolved);
clearBootStyles();
media.addEventListener('change', () => commit(getTheme().pref, true));
window.addEventListener('storage', (e) => {
  if (e.key === PREF_KEY) commit(readPref(), true);
});
