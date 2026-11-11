// Desks that can't wake (S-82, the Product Designer's call for release 13). While card C (payment-suspended) or D
// (ended by the member, desks kept) shows over the desks, they're drawn at 35 percent, once, on one group, and carry
// no count: a 4 or a 1 on a desk that can't wake invites a click that does nothing. It is the decision `noDeskNotice`
// makes, so the card and the dimming never disagree. Active members, E, F, A and B: unchanged.
import { noDeskNotice } from '../shell/deskNotice';
import type { NoDeskInput } from '../shell/deskNotice';

/** How much of a stopped desk shows through (tiles, glyphs and the etched name alike). */
export const STOPPED_OPACITY = 0.35;

/** Whether the desks are stopped behind card C or D. */
export function desksStopped(input: NoDeskInput): boolean {
  if (!input.hasDesks) return false;
  const card = noDeskNotice(input);
  return card === 'paused' || card === 'kept';
}

/** The group opacity for the desks: one value, for the layer's desk group. */
export function desksOpacity(stopped: boolean): number {
  return stopped ? STOPPED_OPACITY : 1;
}
