// What reaches the member, started with the office while Desk Maia is on (the focus shield; deskd API.md §23): the one observer in
// every view (`focusSource.ts`, with the page's facts from `focusEnv.ts`), and the held line beside the account menu (`shield/`).
// The startup chunk follows the member's prefs (`followShield` in `door.ts`); a change of member or Desk Maia off ends it all, with
// nothing kept.
import { useShieldSlot } from './door';
import { makeFocusEnv } from './focusEnv';
import { installFocusEnv, retainFocus, useReach, type FocusHandle } from './focusSource';
import { forgetNames } from './shield/actions';
import { resetShieldUi, useShieldUi } from './shield/state';
import { forgetFocusItems } from '../state/focusItems';
import { setTileCalm } from '../state/tileCalm';
import { resetDnd } from './dnd';

let handle: FocusHandle | null = null;
let stopMock: (() => void) | null = null;

export function startShield(): void {
  if (handle) return;
  installFocusEnv(makeFocusEnv());
  handle = retainFocus();
  void import('./shield/chunk').then(
    (m) => m.ready(),
  ).then(
    (m) => {
      if (handle) useShieldSlot.setState({ Line: m.HeldLine });
    },
    () => undefined,
  );
  // `npm run dev` and the shell specs: a sample `reach` with `?shield` (never in a production build).
  if (import.meta.env.MODE !== 'production' && new URLSearchParams(location.search).has('shield')) {
    void import('./mockSource').then((m) => {
      if (handle) stopMock = m.startMockReach();
    });
    (window as unknown as Record<string, unknown>)['__maShieldState'] = () => ({ slot: !!useShieldSlot.getState().Line, reach: useReach.getState().reach, ready: useReach.getState().ready, device: useReach.getState().device });
  }
}

export function stopShield(): void {
  if (!handle) return;
  handle.release();
  handle = null;
  stopMock?.();
  stopMock = null;
  installFocusEnv(null);
  useShieldSlot.setState({ Line: null });
  useReach.setState({ reach: null, room: null });
  setTileCalm(null);
  resetDnd();
  resetShieldUi();
  forgetNames();
  forgetFocusItems();
}

/** "What reaches you", from the account menu: the held line's chunk draws it (it loads first if it isn't here). */
export function openSettings(): void {
  void import('./shield/chunk').then((m) => m.ready()).then(
    (m) => {
      if (!useShieldSlot.getState().Line) useShieldSlot.setState({ Line: m.HeldLine });
      useShieldUi.setState({ settings: true });
    },
    () => undefined,
  );
}
