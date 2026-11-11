// The few words the ring itself says, in the initial chunk: its accessible names and the account menu's lines. The
// panel's words are `words.ts`, in its own chunk. Tier names come from the setting and stand on their own.
import type { TierNames } from '../platform/tiers';
import type { OfferTier } from './steps';

export const WHATS_NEW = "What's new";
export const SHOW_CIRCLE = "Show setup and what's new";
/** The account menu's row on a phone too narrow for the circle, in setup and after it. */
export const MENU_SETUP = 'Set up your office';
export const MENU_AFTER = 'Your office';

/** The offer card's title, which is also the circle's name while the card is all it holds. */
export function offerTitle(offer: OfferTier, names: TierNames): string {
  if (offer === 'alliance') return `More room with ${names.alliance}`;
  if (offer === 'officer') return 'Room for a Work desk';
  return 'Lead a guild of your own';
}
