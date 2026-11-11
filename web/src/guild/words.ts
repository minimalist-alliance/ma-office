// What a desk's windows say about the desk, in a Guild Desk's own words where they differ (task 48). The windows are the
// same on every desk; `GuildWindow` sets this context around a guild's, so `Waking` and the panels pick the words up.
import { createContext, useContext } from 'react';

export const OnGuildDesk = createContext(false);
export const useOnGuildDesk = (): boolean => useContext(OnGuildDesk);

export interface DeskWords {
  waking: string;
  asleep: string;
  stopping: string;
  failed: string;
  wake: string;
}

export const DESK_WORDS: DeskWords = {
  waking: 'Waking this desk…',
  asleep: 'This desk is asleep',
  stopping: 'This desk is going to sleep',
  failed: "Couldn't wake this desk",
  wake: 'Wake this desk',
};

/** The waking screen's line is the design's own (draft ADR, section 6): a Guild Desk takes about a minute. */
export const GUILD_WORDS: DeskWords = {
  waking: 'The Guild Desk is waking, about a minute',
  asleep: 'The Guild Desk is asleep',
  stopping: 'The Guild Desk is going to sleep',
  failed: "Couldn't wake the Guild Desk",
  wake: 'Wake the Guild Desk',
};

export const useDeskWords = (): DeskWords => (useOnGuildDesk() ? GUILD_WORDS : DESK_WORDS);

export const REMOVED_TITLE = "You're no longer in this guild";
export const REMOVED_LINE = 'Its Guild Desk, Commons and pages have closed here. Your own desks are just as they were.';
/** The Agent window's quiet line on a Guild Desk (draft ADR section 7, decision 6). */
export const AGENT_PRIVATE_LINE = "Your conversations here are private to you. The guild's limits apply.";
/** Where a link in a guild page goes instead of a Browser: one of the member's own desks, by their choice. */
export const OPEN_ON = { personal: 'Open on Personal', work: 'Open on Work' } as const;
