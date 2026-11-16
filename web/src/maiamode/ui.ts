// The room's state, outside React: its phase (the disclosure, entering, in, leaving), the viewport, the phone's To-do sheet, and
// how the office is put aside and given back exactly as it was (CONCEPT.md Part 1 "Turning it on", "Leaving"; §2 "Entering and
// leaving"). The desks stay mounted underneath, hidden and `inert`, so their camera, windows and focus come back untouched.
import { create } from 'zustand';
import { setRoomLook } from '../desk/liveStore';
import { useLayoutStore } from '../state/layoutStore';
import { useWindowStore, windowKey, type AppWindowState } from '../state/windowStore';
import { useMaiaMode } from './door';
import { setRoomViewport } from './roomView';
import { allowedNow, currentPrefs, isOn, savePrefs } from './prefs';
import type { RoomSource, ShowRequest } from './source';
import { DISCLOSURE } from './words';

export type Phase = 'off' | 'disclosure' | 'entering' | 'in' | 'leaving';

export interface Viewport extends ShowRequest {
  by: 'maia' | 'member';
  /** The office's own window of this app, put aside while the viewport holds the app, and put back after. */
  borrowed: { win: AppWindowState; wasActive: boolean } | null;
}

export interface RoomUi {
  phase: Phase;
  /** Where Maia grows from: her corner bubble's box, or the corner itself. */
  from: { x: number; y: number; size: number } | null;
  viewport: Viewport | null;
  /** The phone's To-do sheet. */
  sheet: boolean;
  source: RoomSource | null;
  /** Turned on before the room's source was here: it tells the home desk as it arrives. */
  announce: boolean;
}

export const useRoomUi = create<RoomUi>(() => ({ phase: 'off', from: null, viewport: null, sheet: false, source: null, announce: false }));

/** Whether the office shows this app as a tile on this desk. */
export const tileOn = (deskId: string, app: string): boolean => useLayoutStore.getState().desks[deskId]?.items.some((i) => i.app === app) ?? false;

/** The desks' fade and Maia's growth (§2: 600 ms, the loading overlay's reveal run backwards). */
export const MOVE_MS = 600;

let returnFocus: HTMLElement | null = null;
let timer = 0;

const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The office's own children, put out of reach while the room is up (and back), by attribute: React never writes `inert`. */
function officeInert(on: boolean): void {
  for (const el of document.querySelectorAll('.ma-shell > :not(.mm-layer)')) {
    if (on) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
}

/** Her corner: Support Maia's bubble where it is, else where it would be (bottom right). */
function corner(): RoomUi['from'] {
  const b = document.querySelector('.maia-bubble, .maia-launcher')?.getBoundingClientRect();
  if (b && b.width > 0) return { x: b.left, y: b.top, size: b.width };
  return { x: window.innerWidth - 88, y: window.innerHeight - 88, size: 64 };
}

export function enter(from: HTMLElement | null): void {
  if (!allowedNow()) return;
  const { phase } = useRoomUi.getState();
  if (phase === 'in' || phase === 'entering' || phase === 'disclosure') return;
  returnFocus = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (!isOn(currentPrefs())) {
    useMaiaMode.setState({ layer: true });
    useRoomUi.setState({ phase: 'disclosure' });
    officeInert(true);
    return;
  }
  goIn();
}

/**
 * The home desk asks for the current disclosure while the room is up (it holds an older one, `RoomState.disclosure`): the
 * disclosure over the room, which stays as it is underneath. Not while the room is on its way out.
 */
export function showDisclosure(): void {
  const { phase } = useRoomUi.getState();
  if (phase === 'off' || phase === 'leaving' || phase === 'disclosure' || !useMaiaMode.getState().room) return;
  // An entrance still under way would put the room back over the disclosure.
  window.clearTimeout(timer);
  useRoomUi.setState({ phase: 'disclosure', sheet: false });
}

/** The disclosure was accepted: Maia Mode is on for the member, here and on every device. */
export function accept(): void {
  savePrefs({ on: true, offPending: false, disclosure: { version: DISCLOSURE.version, at: new Date().toISOString() }, lastMode: 'maia' });
  const source = useRoomUi.getState().source;
  if (source) source.setOn(true);
  else useRoomUi.setState({ announce: true });
  if (!useMaiaMode.getState().room) return goIn();
  // Asked again over the room: back to the room just as it was (`Room.tsx` puts the focus in her composer).
  useRoomUi.setState({ phase: 'in' });
}

/** "Not now": nothing changes, and the focus goes back where it was. Asked again over the room, "Not now" leaves the room. */
export function decline(): void {
  if (useMaiaMode.getState().room) return leave();
  officeInert(false);
  useRoomUi.setState({ phase: 'off' });
  useMaiaMode.setState({ layer: false });
  returnFocus?.focus({ preventScroll: true });
}

function goIn(): void {
  window.clearTimeout(timer);
  useRoomUi.setState({ phase: 'entering', from: corner(), viewport: null, sheet: false });
  useMaiaMode.setState({ layer: true, room: true });
  officeInert(true);
  setRoomLook(null);
  if (currentPrefs().lastMode !== 'maia') savePrefs({ lastMode: 'maia' });
  timer = window.setTimeout(() => useRoomUi.setState({ phase: 'in' }), reduced() ? 200 : MOVE_MS);
}

/** "Show my desks": the office comes back exactly as it was left, its camera, windows and focus. */
export function leave(): void {
  const { phase } = useRoomUi.getState();
  if (phase === 'off' || phase === 'leaving') return;
  window.clearTimeout(timer);
  closeViewport();
  const boot = useMaiaMode.getState().boot;
  useRoomUi.setState({ phase: 'leaving', sheet: false });
  useMaiaMode.setState({ room: false, boot: false });
  officeInert(false);
  setRoomLook(undefined);
  if (currentPrefs().lastMode !== 'desk') savePrefs({ lastMode: 'desk' });
  timer = window.setTimeout(() => {
    useRoomUi.setState({ phase: 'off' });
    useMaiaMode.setState({ layer: false });
  }, reduced() ? 200 : MOVE_MS);
  // Focus goes back where it was before the room; a page that started in the room has nowhere, so the page itself.
  const back = !boot ? returnFocus : null;
  returnFocus = null;
  focusBack(back, 0);
}

/**
 * Focus lands once the office can take it: until React's commit drops the shell's `.mm-on`, everything under it is still
 * `visibility: hidden`, where `focus()` does nothing and the focus falls to the page (release 4's B2). That's this frame's
 * microtask or the next frame; never once the member is back in the room.
 */
function focusBack(back: HTMLElement | null, tries: number): void {
  if (useMaiaMode.getState().room) return;
  if (document.querySelector('.ma-shell.mm-on') && tries < 30) {
    if (tries === 0) queueMicrotask(() => focusBack(back, 1));
    else requestAnimationFrame(() => focusBack(back, tries + 1));
    return;
  }
  if (back?.isConnected) back.focus({ preventScroll: true });
  else (document.activeElement as HTMLElement | null)?.blur?.();
}

/**
 * The member changed in this tab (a sign-in elsewhere), or the gate no longer lets them have it: everything of the room goes at
 * once, with no transition, nothing put back and nothing saved (Security's MR-M3). The viewport's borrowed window was the last
 * member's, so it isn't returned.
 */
export function reset(): void {
  window.clearTimeout(timer);
  const { source } = useRoomUi.getState();
  source?.close();
  useRoomUi.setState({ phase: 'off', from: null, viewport: null, sheet: false, source: null, announce: false });
  useMaiaMode.setState({ layer: false, room: false, boot: false });
  officeInert(false);
  setRoomLook(undefined);
  returnFocus = null;
}

/** The viewport (§2): one app window at a time, from a closed enum, on the member's own desk; never a URL. */
export function openViewport(req: ShowRequest, by: Viewport['by']): void {
  // Only an app the office shows as a tile on that desk: every kill switch (Files, To-do) and every app the desk doesn't have
  // stays shut (Security's MR-L2).
  if (!tileOn(req.deskId, req.app)) return;
  const cur = useRoomUi.getState().viewport;
  if (cur && cur.deskId === req.deskId && cur.app === req.app) {
    useRoomUi.setState({ viewport: { ...cur, ref: req.ref, by } });
    return;
  }
  closeViewport();
  // The office's own window of the same app on the same desk is put aside, so the app never runs twice, and comes back as it was.
  const key = windowKey(req.deskId, req.app);
  const { windows, active } = useWindowStore.getState();
  const win = windows[key];
  let borrowed: Viewport['borrowed'] = null;
  if (win && !win.closing) {
    borrowed = { win, wasActive: active === key };
    const rest = { ...windows };
    delete rest[key];
    useWindowStore.setState({ windows: rest, active: active === key ? null : active });
  }
  useRoomUi.setState({ viewport: { ...req, by, borrowed }, sheet: false });
  setRoomLook(req.deskId);
  // What's in front, for Desk Maia's model of now (the focus shield): the viewport's desk and app, ids only.
  setRoomViewport({ deskId: req.deskId, app: req.app });
}

export function closeViewport(): void {
  const cur = useRoomUi.getState().viewport;
  if (!cur) return;
  useRoomUi.setState({ viewport: null });
  setRoomViewport(null);
  if (useMaiaMode.getState().room) setRoomLook(null);
  if (cur.borrowed) {
    const { win, wasActive } = cur.borrowed;
    const { windows, active } = useWindowStore.getState();
    if (!windows[win.key]) useWindowStore.setState({ windows: { ...windows, [win.key]: win }, active: wasActive ? win.key : active });
  }
}
