// The free tier's only code in the office's first load (S-119, `~/ma-coord/free-tier.md`): what its chunk hands the few
// places that show it. `session.ts` loads the chunk (`office.tsx`) only once `GET /v1/me` says `membership.tier: "free"`;
// for everyone else this stays empty, each place below renders exactly as it did, and no free code is fetched.
import type { ComponentType, ReactNode } from 'react';
import { create } from 'zustand';
import type { Rect } from '../canvas/layout';

export interface FreeParts {
  /** On while the member is free: what `free` turns on outside the chunk (the last screen kept for their desk). */
  free?: boolean;
  /** On while the free meter shows today's Browser time: the bandwidth circle stands aside. */
  meter?: boolean;
  /** Beside the bandwidth circle: the free meter. */
  Office?: ComponentType;
  /** Top of the notices stack. */
  Notices?: ComponentType;
  /** Unset since the Designer's Nov 9, 9:15 pm change (the Work desk offer is the setup circle's): the seam stays in the Lead's files until they merge. */
  Canvas?: ComponentType;
  /** Unset, as `Canvas` above. */
  Proxy?: ComponentType;
  /** In the account menu and the Account settings modal, in place of a paid member's tier line. */
  Account?: ComponentType<{ className?: string; testId?: string }>;
  /** In a Browser window's bar. */
  BrowserLine?: ComponentType<{ deskId?: string }>;
  /**
   * In a Browser's title bar, left of its buttons (walk L13): the meter, compact, only while that Browser covers the bar's.
   * `cover` is the same name the window or a phone's carousel gives itself in `data-cover`.
   */
  WindowRing?: ComponentType<{ cover: string }>;
  /** Unset, as `Canvas` above. */
  frames?: () => Rect[];
  /** Its words for a Browser it paused at the day's limit, or null for any other pause. */
  pause?: (resumesAt: string | null) => { title: string; body: string; link?: ReactNode } | null;
  /** Counts up when Maia's state should be asked again: an upgrade, which wakes her. */
  maia?: number;
  /**
   * For the Files app's drive line (the draft's row 5, the Desk Engineer's): while the member is free, the tier with the
   * bigger drive, that drive's size from settings (null until Platform sends it), and where See membership goes.
   */
  drive?: () => { alliance: string; allianceDrive: string | null; href: string | null };
}

export const useFree = create<FreeParts>(() => ({}));
