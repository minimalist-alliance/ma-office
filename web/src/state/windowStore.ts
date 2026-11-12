// windows of design 3.13: one window per app per desk, up to 4 per desk. Rects are per device.
import { create } from 'zustand';
import { readJson, writeJson } from '../lib/util';
import { baseApp, type AppId, type BaseAppId, type Rect } from '../canvas/layout';
import { host } from '../deskapps/door';
import { adultOnly, mayHaveApp } from '../platform/age';
import { isPhone } from '../canvas/phone';
import { carouselApps, carouselOn } from '../carousel/model';
import { setPhoneShown } from '../carousel/phone';
import { setCarousel, useLayoutStore } from './layoutStore';

export type WindowMode = 'window' | 'full';

export interface AppWindowState {
  key: string;
  deskId: string;
  app: AppId;
  /** The tile this window launches from and returns to. */
  itemId: string;
  mode: WindowMode;
  rect: Rect;
  z: number;
  closing: boolean;
}

interface WindowsState {
  windows: Record<string, AppWindowState>;
  active: string | null;
}

export const windowKey = (deskId: string, app: AppId): string => `${deskId}:${app}`;

const RECTS_KEY = 'ma.windows.v1';
const savedRects = readJson<Record<string, { rect: Rect; mode: WindowMode }>>(RECTS_KEY) ?? {};

export const useWindowStore = create<WindowsState>(() => ({ windows: {}, active: null }));

let topZ = 1;

export const MIN_W = 360;
export const MIN_H = 280;
const CASCADE = 32;
export const TOP_BAR = 72;

const DEFAULT_SIZE: Record<BaseAppId, { w: number; h: number | 'full'; side?: 'right'; mode?: WindowMode }> = {
  notebook: { w: 880, h: 640 },
  chat: { w: 720, h: 640 },
  agent: { w: 480, h: 'full', side: 'right' },
  browser: { w: 1120, h: 780, mode: 'full' },
  commons: { w: 960, h: 680 },
  files: { w: 880, h: 640 },
  // An installed app opens at its manifest's own size where its desk has said it (the desk app host's `windowSize`), the title bar on top.
  deskapp: { w: 480, h: 440 },
};


function defaultRect(app: AppId, openCount: number): { rect: Rect; mode: WindowMode } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spec = { ...DEFAULT_SIZE[baseApp(app)], ...host?.windowSize(app) };
  const w = Math.min(spec.w, vw - 24);
  const h = spec.h === 'full' ? vh - TOP_BAR - 12 : Math.min(spec.h, vh - TOP_BAR - 12);
  const x = spec.side === 'right' ? vw - w - 12 : Math.max(12, (vw - w) / 2 + openCount * CASCADE);
  const y = spec.side === 'right' ? TOP_BAR : Math.max(TOP_BAR, (vh - h) / 2 + openCount * CASCADE);
  return { rect: { x, y, w, h }, mode: spec.mode ?? 'window' };
}

/** Keep a saved rect reachable on this screen. */
export function clampRect(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(MIN_W, r.w), Math.max(MIN_W, vw - 24));
  const h = Math.min(Math.max(MIN_H, r.h), Math.max(MIN_H, vh - TOP_BAR - 12));
  return {
    w,
    h,
    x: Math.min(Math.max(12 - w + 120, r.x), vw - 120),
    y: Math.min(Math.max(TOP_BAR - 8, r.y), vh - 60),
  };
}

function saveRects(): void {
  const { windows } = useWindowStore.getState();
  for (const w of Object.values(windows)) savedRects[w.key] = { rect: w.rect, mode: w.mode };
  writeJson(RECTS_KEY, savedRects);
}

/**
 * Where an app opened: in its desk's carousel (`carousel/`), or as a window. Null when it can't open here at all.
 */
export type Opened = 'carousel' | 'window' | null;

export function openWindow(deskId: string, app: AppId, itemId: string): Opened {
  if (!mayHaveApp(app)) return null; // the layout has no tile for it, so this is only the last word
  // On a desk in carousel mode an app's window is its place in the carousel: opening it (a tile, the hidden list, a
  // note's link, an agent) moves the carousel there, so the same app never runs twice. On a phone, which has no windows,
  // every app the desk holds opens full screen in the phone's own carousel with the thumb row (the Product Designer's
  // option 3), which is never saved: the desk stays exactly as a larger screen has it (`carousel/phone.ts`).
  const desk = useLayoutStore.getState().desks[deskId];
  if (desk && isPhone() && carouselApps(desk).includes(app)) {
    setPhoneShown(deskId, app);
    return 'carousel';
  }
  if (desk && carouselOn(desk) && carouselApps(desk).includes(app)) {
    setCarousel(deskId, { on: true, app });
    return 'carousel';
  }
  const key = windowKey(deskId, app);
  const { windows } = useWindowStore.getState();
  const cur = windows[key];
  topZ += 1;
  if (cur && !cur.closing) {
    useWindowStore.setState({ windows: { ...windows, [key]: { ...cur, z: topZ } }, active: key });
    return 'window';
  }
  const openHere = Object.values(windows).filter((w) => w.deskId === deskId && !w.closing).length;
  const saved = savedRects[key];
  const { rect, mode } = saved ? { rect: clampRect(saved.rect), mode: saved.mode } : defaultRect(app, openHere);
  useWindowStore.setState({
    windows: { ...windows, [key]: { key, deskId, app, itemId, mode, rect, z: topZ, closing: false } },
    active: key,
  });
  return 'window';
}

export function raiseWindow(key: string): void {
  const { windows, active } = useWindowStore.getState();
  const w = windows[key];
  if (!w || (active === key && w.z === topZ)) return;
  topZ += 1;
  useWindowStore.setState({ windows: { ...windows, [key]: { ...w, z: topZ } }, active: key });
}

export function setWindowRect(key: string, rect: Rect): void {
  const { windows } = useWindowStore.getState();
  const w = windows[key];
  if (!w) return;
  useWindowStore.setState({ windows: { ...windows, [key]: { ...w, rect } } });
  saveRects();
}

export function toggleFull(key: string): void {
  const { windows } = useWindowStore.getState();
  const w = windows[key];
  if (!w) return;
  useWindowStore.setState({ windows: { ...windows, [key]: { ...w, mode: w.mode === 'full' ? 'window' : 'full' } } });
  saveRects();
}

/** Starts the exit animation; the window component calls removeWindow when it ends. */
export function requestClose(key: string): void {
  const { windows } = useWindowStore.getState();
  const w = windows[key];
  if (!w || w.closing) return;
  useWindowStore.setState({ windows: { ...windows, [key]: { ...w, closing: true } } });
}

export function removeWindow(key: string): void {
  const { windows, active } = useWindowStore.getState();
  if (!windows[key]) return;
  const rest = { ...windows };
  delete rest[key];
  const next = active === key
    ? (Object.values(rest).filter((w) => !w.closing).sort((a, b) => b.z - a.z)[0]?.key ?? null)
    : active;
  useWindowStore.setState({ windows: rest, active: next });
}

/** `/v1/me` has just said this member is a teen: an adults-only app's window goes, at once and with nothing said. */
export function closeAdultOnlyWindows(): void {
  for (const w of Object.values(useWindowStore.getState().windows)) if (adultOnly(w.app)) removeWindow(w.key);
}

/** The top window on this desk, for Esc and Shift+Esc. */
export function topWindow(deskId: string | null): AppWindowState | null {
  const { windows } = useWindowStore.getState();
  const list = Object.values(windows).filter((w) => !w.closing && w.deskId === deskId);
  list.sort((a, b) => b.z - a.z);
  return list[0] ?? null;
}
