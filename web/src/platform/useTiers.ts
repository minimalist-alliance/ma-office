// The member's tier and the tiers' names, for React. The rules are `tiers.ts`'s; this only reads the session.
import { useMemo } from 'react';
import { useSession } from './session';
import { liveTier, readBadge, tierNamesFrom, type BadgeId, type TierId, type TierNames } from './tiers';

/** Every tier word in the app comes from here: client-config's `tierNames`, with the contract's defaults. */
export function useTierNames(): TierNames {
  const raw = useSession((s) => s.config?.tierNames);
  return useMemo(() => tierNamesFrom(raw), [raw]);
}

/** The same, outside React. */
export const tierNamesNow = (): TierNames => tierNamesFrom(useSession.getState().config?.tierNames);

/** The tier the member holds now, or null until `/v1/me` says, and while the membership isn't live. */
export function useMyTier(): TierId | null {
  return liveTier(useSession((s) => s.me?.membership));
}

/** The badge to draw on the member's avatar: Platform's `membership.badge`, always (the seal is a placeholder in `Avatar.tsx`). */
export function useMyBadge(): BadgeId | null {
  return useSession((s) => readBadge(s.me?.membership?.badge));
}
