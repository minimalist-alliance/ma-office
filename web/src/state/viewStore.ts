// view of design 3.13. Camera, scope and active desk are per device (localStorage, design 3.8).
import { create } from 'zustand';
import { readJson, writeJson } from '../lib/util';
import { deviceStamp, keptForThisMember, VIEW_KEY } from './deviceOwner';

export type CameraMode = 'overview' | 'desk' | 'free';
export type Scope = 'personal' | 'work' | 'guild' | 'all';

/** Where the desk's context menu is open, and on what. */
export interface DeskMenuAt {
  deskId: string;
  itemId: string | null;
  x: number;
  y: number;
  fromKeyboard: boolean;
}

export interface ViewState {
  scope: Scope;
  activeDesk: string | null;
  mode: CameraMode;
  /** Item or desk id whose proxy holds the roving tab stop. */
  kbFocus: string | null;
  /** That item or desk is being moved or resized from the keyboard. */
  kbEdit: 'move' | 'resize' | null;
  deskMenu: DeskMenuAt | null;
  /** The desk whose list of hidden apps is open (ADR 0064). */
  hiddenList: { deskId: string; fromKeyboard: boolean } | null;
  /** The desk whose etched name is a field for a new one (task 45). */
  renaming: { deskId: string; fromKeyboard: boolean } | null;
  privacyShield: boolean;
}

type Kept = Partial<Pick<ViewState, 'scope' | 'activeDesk' | 'mode'>> & { owner?: unknown };
const saved = readJson<Kept>(VIEW_KEY);
/** Who the kept view was written for (`deviceOwner.ts`): none from a build before it, `LEFT` after a sign-out. */
let keptBy: unknown = saved?.owner;
const DEVICE_DEFAULTS = { scope: 'all', activeDesk: null, mode: 'desk' } as const;

export const useViewStore = create<ViewState>(() => ({
  scope: saved?.scope ?? 'all',
  activeDesk: saved?.activeDesk ?? null,
  mode: saved?.mode ?? 'desk',
  kbFocus: null,
  kbEdit: null,
  deskMenu: null,
  hiddenList: null,
  renaming: null,
  privacyShield: false,
}));

// Only when what's kept changes: a focus move, a menu or a change of account (`forgetDeskFocus`) writes nothing.
useViewStore.subscribe((s, was) => {
  if (s.scope !== was.scope || s.activeDesk !== was.activeDesk || s.mode !== was.mode) keep(s);
});

function keep(s: Pick<ViewState, 'scope' | 'activeDesk' | 'mode'>): void {
  keptBy = deviceStamp();
  writeJson(VIEW_KEY, { scope: s.scope, activeDesk: s.activeDesk, mode: s.mode, owner: keptBy });
}

/** The kept view is the member's in front of it: written for them, or for nobody known (`keptForThisMember`). */
export const viewIsTheMembers = (): boolean => keptForThisMember(keptBy);

/**
 * The view kept in this browser was another member's, or left at a sign-out with no id in it (ADR 0057): the next member
 * starts where a first visit does, in desk mode on no desk yet, so arriving frames their own desks (`refit`), a new one by
 * the owner's rule. Kept for them from now.
 */
export function forgetDeviceView(): void {
  setView(DEVICE_DEFAULTS);
  keep(getView());
}

export const getView = (): ViewState => useViewStore.getState();
export const setView = (p: Partial<ViewState>): void => useViewStore.setState(p);

/**
 * This tab's tokens became another account's (ISS-89's follow-up): what points at the last member's desks and apps goes, the
 * keyboard's stop, a move or resize from the keyboard, the desk menu, the hidden list and a rename's field, so the new
 * member's first desk takes the tab stop when their list lands. The device's own view (scope, active desk, mode) stays for
 * the member it was kept for (ISS-67), with no id in it once they've signed out; another member's goes when their list
 * arrives (`forgetDeviceView`, from `refit`, ADR 0057), and the arrival frames their desks.
 */
export function forgetDeskFocus(): void {
  setView({ kbFocus: null, kbEdit: null, deskMenu: null, hiddenList: null, renaming: null });
}
