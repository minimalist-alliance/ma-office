// Each app's zoom (ADR 0055): office apps' levels, per app, per member, on this browser; the desk Browser's, per desk, as its
// desk says. In the zoom chunk, with the frames that show it (`AppWindow`, the open tiles, the carousel) and the Browser.
//
// Memory: one localStorage key, `{app: level}`, read once as this chunk loads, written only while the layout's mirror may be
// (`layoutMirrorWritable`, ISS-89), and in `MEMBER_CACHE_KEYS`, so every signed-out state takes it. A change of account in
// this tab drops what's in memory too, so nothing of one member's shows for the next. The Browser's level is the desk's own
// (deskd keeps it), so none of it is kept here.
import type { CSSProperties } from 'react';
import { create } from 'zustand';
import { setAppZoom, type AppZoomInput } from '../canvas/pinch';
import { onMemberChange } from '../platform/auth';
import { layoutMirrorWritable } from '../state/layoutStore';
import { appFromStored, appToStored, recordFromStored, recordToStored } from '../canvas/storedIds';
import { DEFAULT_LEVEL, NO_ZOOM, readLevels, snapLevel, stepLevel, WheelZoom, withLevel, zoomKey } from './level';

/** The member's levels in this browser (`MEMBER_CACHE_KEYS` holds the same string, so a wipe never waits for this chunk). */
export const ZOOM_KEY = 'ma.appZoom.v1';

interface ZoomState {
  /** Office apps' levels by `zoomKey`; absent is 100. */
  levels: Record<string, number>;
  /** Each desk's Browser level, once that desk has answered `browser.zoom.get`; absent, the Browser has no zoom. */
  browser: Record<string, number>;
}

function stored(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(ZOOM_KEY);
    return raw ? recordFromStored(readLevels(JSON.parse(raw)), appKeyFromStored) : {};
  } catch {
    return {};
  }
}

// Keyed by app, Courier as every build stores it (`canvas/storedIds.ts`).
const appKeyFromStored = (key: string): string => appFromStored(key) as string;
const appKeyToStored = (key: string): string => appToStored(key);

export const useZoomStore = create<ZoomState>(() => ({ levels: stored(), browser: {} }));

function keep(levels: Record<string, number>): void {
  if (!layoutMirrorWritable()) return;
  try {
    if (Object.keys(levels).length) window.localStorage.setItem(ZOOM_KEY, JSON.stringify(recordToStored(levels, appKeyToStored)));
    else window.localStorage.removeItem(ZOOM_KEY);
  } catch {
    /* storage refused: the level holds for this page */
  }
}

// Another member's tokens in this tab (a sign-in in another tab): the last member's levels go from memory at once; the
// wipe (`layoutMirrorFor`) has taken them from storage.
onMemberChange((sub, before) => {
  if (before !== null && before !== sub) useZoomStore.setState({ levels: {} });
});

/** A Browser's way to set its desk's level (`browser/driver.ts`), while that desk's Browser is mounted. */
const browserSetters = new Map<string, (level: number) => void>();

/**
 * The level an app shows at, or null where it has no zoom: a Browser whose desk hasn't answered `browser.zoom.get`, and an
 * app that doesn't zoom yet (`NO_ZOOM`).
 */
export function levelOf(s: ZoomState, app: string, deskId: string): number | null {
  if (NO_ZOOM.has(app)) return null;
  if (app === 'browser') return s.browser[deskId] ?? null;
  return s.levels[zoomKey(app)] ?? DEFAULT_LEVEL;
}

export const useAppLevel = (app: string, deskId: string): number | null => useZoomStore((s) => levelOf(s, app, deskId));

/**
 * An office app's body at its level: CSS `zoom` on `.window-body`, so the app re-lays out at the new size, its text crisp
 * and its targets grown with it, never a scaled picture. The Browser's is its desk's: its picture is never scaled.
 */
export function bodyZoom(app: string, level: number | null): CSSProperties | undefined {
  return app === 'browser' || level === null || level === DEFAULT_LEVEL ? undefined : { zoom: level / 100 };
}

/** The member's choice: an office app's is kept, a Browser's goes to its desk. */
export function setAppLevel(app: string, deskId: string, level: number): void {
  if (NO_ZOOM.has(app)) return;
  const next = snapLevel(level);
  if (app === 'browser') {
    const set = browserSetters.get(deskId);
    if (!set || useZoomStore.getState().browser[deskId] === undefined) return;
    useZoomStore.setState((s) => ({ browser: { ...s.browser, [deskId]: next } }));
    set(next);
    return;
  }
  const key = zoomKey(app);
  const s = useZoomStore.getState();
  if ((s.levels[key] ?? DEFAULT_LEVEL) === next) return;
  const levels = withLevel(s.levels, key, next);
  useZoomStore.setState({ levels });
  keep(levels);
}

/** `steps` 10 % steps from where the app is (a wheel or a pinch over it). */
export function stepAppLevel(app: string, deskId: string, steps: number): void {
  const now = levelOf(useZoomStore.getState(), app, deskId);
  if (now === null || !steps) return;
  setAppLevel(app, deskId, stepLevel(now, steps));
}

/**
 * The Browser on `deskId` says what its desk has (`level`), or that it has no zoom (null), with its way to set one. Its
 * level is the desk's: what the desk says shows, here and in every other office the member has open.
 */
export function browserZoom(deskId: string, level: number | null, set: (level: number) => void): void {
  if (level === null) {
    browserGone(deskId, set);
    return;
  }
  browserSetters.set(deskId, set);
  if (useZoomStore.getState().browser[deskId] === level) return;
  useZoomStore.setState((s) => ({ browser: { ...s.browser, [deskId]: level } }));
}

/** That Browser went (its window closed, or its desk's zoom is gone). Another Browser of the desk's may have taken over. */
export function browserGone(deskId: string, set: (level: number) => void): void {
  if (browserSetters.get(deskId) !== set) return;
  browserSetters.delete(deskId);
  if (useZoomStore.getState().browser[deskId] === undefined) return;
  useZoomStore.setState((s) => {
    const browser = { ...s.browser };
    delete browser[deskId];
    return { browser };
  });
}

// ----- the wheel and the pinch over an app (`canvas/pinch.ts` hands them here)

const sums = new WeakMap<Element, WheelZoom>();

/** A wheel or a pinch over an app's frame (`[data-zoom-app]`, with its `data-desk`). */
export function zoomFromWheel({ frame, dy, pinch }: AppZoomInput): void {
  const app = frame.getAttribute('data-zoom-app');
  const deskId = frame.getAttribute('data-desk') ?? '';
  if (!app) return;
  let sum = sums.get(frame);
  if (!sum) sums.set(frame, (sum = new WheelZoom()));
  const steps = sum.add(dy, pinch, performance.now());
  if (steps) stepAppLevel(app, deskId, steps);
}

setAppZoom(zoomFromWheel);
