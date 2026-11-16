// The held line's own state in this page (the focus shield): which of its panels is open, the snapshots Back restores (memory
// only, never sent), and where the member last was. Nothing here is saved or leaves the browser.
import { create } from 'zustand';
import { Snapshots } from '../back';
import type { ReachBack } from '../reach';

export interface ShieldUi {
  /** The held line's menu. */
  menu: boolean;
  /** To-do as a sheet, on its list or on All held. */
  sheet: null | 'todo' | 'held';
  /** What reaches you. */
  settings: boolean;
  /** The catch-up panel under the line (desk view). */
  catchup: boolean;
  /** The ready-to-resume line over the item, for 5 s after Back. */
  resume: { text: string; at: number } | null;
  /** A card this page has put away (it tucked back, or was answered): not drawn again. */
  gone: string | null;
}

export const useShieldUi = create<ShieldUi>(() => ({ menu: false, sheet: null, settings: false, catchup: false, resume: null, gone: null }));

/** The working set at each card's first sight, for Back. */
export const snapshots = new Snapshots();

/** The last Back the desk offered that wasn't taken: a pick-up line restores it the same way. */
export const lastBack: { back: ReachBack | null } = { back: null };

/** A change of member, or Desk Maia off: nothing of the last state stays. */
export function resetShieldUi(): void {
  snapshots.clear();
  lastBack.back = null;
  useShieldUi.setState({ menu: false, sheet: null, settings: false, catchup: false, resume: null, gone: null });
}
