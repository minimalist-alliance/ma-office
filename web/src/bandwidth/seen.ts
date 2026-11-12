// Which of the bandwidth circle's heads-ups this browser has shown (`BandwidthCircle.tsx`): the last one's key. It's the
// member's (that they were warned, or paused), so it goes with the layout's mirror on every signed-out state and is
// written only while that may be (`MEMBER_CACHE_KEYS` in `state/layoutStore.ts`, ISS-89).
import { layoutMirrorWritable } from '../state/layoutStore';

export const SEEN_KEY = 'ma.bandwidth.notice.v1';

export function headsUpSeen(key: string): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === key;
  } catch {
    return false;
  }
}

export function markHeadsUpSeen(key: string): void {
  if (!layoutMirrorWritable()) return;
  try {
    localStorage.setItem(SEEN_KEY, key);
  } catch {
    /* private mode: it may show again on the next load, which is fine */
  }
}
