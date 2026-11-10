// view of design 3.13. Camera, scope and active desk are per device (localStorage, design 3.8).
import { create } from 'zustand';
import { readJson, writeJson } from '../lib/util';

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

const KEY = 'ma.view.v1';
const saved = readJson<Partial<Pick<ViewState, 'scope' | 'activeDesk' | 'mode'>>>(KEY);

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

useViewStore.subscribe((s) => {
  writeJson(KEY, { scope: s.scope, activeDesk: s.activeDesk, mode: s.mode });
});

export const getView = (): ViewState => useViewStore.getState();
export const setView = (p: Partial<ViewState>): void => useViewStore.setState(p);
