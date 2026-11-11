// The setup circle's only code in the office's first load (S-121; the initial JS budget): a door the circle's chunk
// (`core.ts`) hangs its parts on, and the one test that fetches it, once `/v1/me` says the member holds a tier and the
// circle is on here. Until then, and for anyone it isn't for, the bottom bar, the account menu, the canvas, the scope
// switch and the overview are exactly as they were.
import { createElement, useEffect, type ComponentType } from 'react';
import { create } from 'zustand';
import type { Me } from '../platform/api';
import type { ClientConfig } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { liveTier } from '../platform/tiers';
import { useDeskStore } from '../state/deskStore';

export interface SetupParts {
  /** The circle, in the bottom bar. */
  Circle?: ComponentType;
  /** The account menu's "Show setup and what's new", and its row on a narrow phone. */
  MenuItems?: ComponentType;
}

export const useSetupDoor = create<SetupParts>(() => ({}));

/** The circle is for a member with a tier (free, or a live paid one), with an own desk, where it isn't switched off. */
export function wantsSetup(me: Me | null | undefined, config: ClientConfig | null | undefined, ownDesk: boolean): boolean {
  if (!me || !config || !ownDesk) return false;
  if ((config as { setupCircle?: { enabled?: unknown } }).setupCircle?.enabled === false) return false;
  return (me.membership as { tier?: unknown } | undefined)?.tier === 'free' || liveTier(me.membership) !== null;
}

let opening = false;

/** In the Shell, where the circle goes: fetches the chunk the first time it's wanted, then shows the circle. */
export function SetupMount() {
  const me = useSession((s) => s.me);
  const config = useSession((s) => s.config);
  const ownDesk = useDeskStore((s) => s.desks.some((d) => d.kind !== 'guild'));
  const wanted = wantsSetup(me, config, ownDesk);
  const Circle = useSetupDoor((s) => s.Circle);
  useEffect(() => {
    if (!wanted || opening) return;
    opening = true;
    import('./core').then(
      (m) => m.open(),
      () => {
        opening = false; // the next change asks again
      },
    );
  }, [wanted]);
  return Circle ? createElement(Circle) : null;
}

/** In the account menu. */
export function SetupMenuSlot() {
  const MenuItems = useSetupDoor((s) => s.MenuItems);
  return MenuItems ? createElement(MenuItems) : null;
}
