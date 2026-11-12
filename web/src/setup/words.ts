// Every sentence the setup panel shows (the Product Designer's `design-drafts/setup-circle/README.md`), word for word,
// in the panel's own chunk. Tier names come from the setting, on their own, with no article. Figures come from settings;
// a line whose figure Platform doesn't send yet is left out, never filled in here.
import type { TierNames } from '../platform/tiers';
import type { OfferTier, StepId } from './steps';

export const PANEL_TITLE = 'Set up your office';
export const doneOf = (settled: number, total: number): string => `${settled} of ${total} done`;
export const SKIP = 'Skip';
export const SKIPPED = 'Skipped';
export const UNDO = 'Undo';
export const HIDE_CIRCLE = 'Hide this circle';
export const ALL_SET = 'Your office is set up.';
export const AFTER_FOUND = 'After you found your guild.';

export const AFTER_TITLE = 'Your office';
export const TRY_IT = 'Try it';
export const GOT_IT = 'Got it';
export const SEE_MEMBERSHIP = 'See membership';
export const NOT_NOW = 'Not now';
/** Said with every link that opens a new tab, as its description, for screen readers only (the office's rule: no "(opens in a new tab)" on screen). */
export const NEW_TAB = 'Opens in a new tab';

export interface StepWords {
  title: string;
  line: string;
  button: string;
}

export const STEP_WORDS: Readonly<Record<StepId, StepWords>> = {
  'found-guild': { title: 'Found your guild', line: 'Your membership includes a guild of your own, with a shared Guild Desk for its members.', button: 'Found a guild' },
  invite: { title: 'Invite your first members', line: 'A guild comes alive with people in it.', button: 'Invite' },
  'work-desk': { title: 'Open your Work desk', line: 'Work stays at work: its own Browser sign-ins, files and agents.', button: 'Go to Work' },
  browser: { title: 'Open the Browser', line: 'Browse from your desk, in a simpler, quieter view.', button: 'Open Browser' },
  'agent-key': { title: 'Give your Agent an AI key', line: 'Try free models with no card, or use a key of your own. Either way, the key is kept on your desk.', button: 'Add key' },
  files: { title: 'Put a file in Files', line: 'What you upload stays on your desk, private to you.', button: 'Open Files' },
  'maia-trial': { title: 'Try Maia for a week', line: 'She knows your office and can help with it. Free for a week, or up to $1 of her time.', button: 'Start the week' },
  'guild-join': { title: 'Join a guild', line: 'Guilds share a desk, a board and chat with people you choose.', button: 'Find a guild' },
  'name-desks': { title: 'Name your desks', line: 'Personal and Work are just the start. Call them what you like.', button: 'Rename' },
};

/** The offer card's lines, each a figure from settings where it has one, or left out while Platform sends none. */
export function offerLines(offer: OfferTier, names: TierNames, figures: { allianceDrive: string | null; officerWeekly: string | null }): string[] {
  if (offer === 'alliance') return ['No daily Browser limit', ...(figures.allianceDrive ? [`A ${figures.allianceDrive} drive`] : []), 'Maia included'];
  if (offer === 'officer') return [`${names.officer} adds a Work desk, private and walled off from this one.`, figures.officerWeekly ? `${figures.officerWeekly} of bandwidth a week` : `${names.officer} has more each week`, 'Desks you can name'];
  return [`${names.lead} includes a guild of your own, with a Guild Desk for its members.`];
}
