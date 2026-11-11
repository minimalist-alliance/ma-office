// The desk hands over a link (#9, S-141): a page on the desk opened a `mailto:`, `tel:` or meeting link, which only the
// member's own device can open. ONE ADAPTER: this file turns deskd's `browser.links` event `linkOut` (API.md section 10,
// "Links out": `{url, scheme, displayText, reason, at, tabId?}`; built, in no release yet, so a deskd today refuses the
// SUB with `not_found` and there's simply never a card) into a `Handoff`; nothing else reads the topic. The office never
// opens anything by itself: the member presses, every time.
//
// Rules, from the spec and API.md:
// - Only the spec's schemes (`openOnDevice.ts` `HANDOFF_SCHEMES`), checked here again whatever deskd sends.
// - Every subscribed session hears it, so a card shows only on the device the member clicked from: one that sent input
//   through this desk's stream in about the last 2 s (the rule a copy follows), here 3 s for the trip.
// - One card at a time, and the newest wins. One older than 2 minutes isn't shown. "Not now" means that one never shows
//   again; the page asking again is a new event, so a new card.
// - deskd keeps nothing and sends no first event, so a link handed over while no Browser window was open is gone.
import type { BrowserLinkOutMessage } from '../desk/deskLink';
import { handoffScheme, type HandoffScheme } from './openOnDevice';
import { displayText } from './address';

/** A hand-off older than this isn't shown. */
export const HANDOFF_STALE_MS = 2 * 60_000;
/** This device's input on the desk's stream must be this recent: API.md's "about 2 s", plus the trip to deskd and back. */
export const HANDOFF_INPUT_MS = 3_000;

export interface Handoff {
  /** This page's own id for it: deskd's events carry none, and each is new. */
  id: number;
  url: string;
  scheme: HandoffScheme;
  /** What to show of the address: deskd's `displayText`, cleaned again, on one line. */
  shown: string;
  /** When this tab heard it, ms since the epoch. */
  at: number;
}

/** Each scheme's own sentence and chip (new, for Sales): ours, chosen by the scheme alone, never from the page's words. */
export const HANDOFF_WORDS: Record<HandoffScheme, { say: string; glyph: 'mail' | 'call' | 'thread' | 'video' | 'calendar' }> = {
  mailto: { say: 'This page wants to start an email.', glyph: 'mail' },
  tel: { say: 'This page wants to make a call.', glyph: 'call' },
  sms: { say: 'This page wants to send a text.', glyph: 'thread' },
  zoommtg: { say: 'This page wants to open Zoom.', glyph: 'video' },
  zoomus: { say: 'This page wants to open Zoom.', glyph: 'video' },
  msteams: { say: 'This page wants to open Microsoft Teams.', glyph: 'video' },
  webcal: { say: 'This page wants to add a calendar.', glyph: 'calendar' },
};

let nextId = 1;

/** The event as a hand-off, or null for anything else: another type or reason, or a scheme off the list. */
export function parseLinkOut(msg: BrowserLinkOutMessage | Record<string, unknown> | null | undefined, now: number = Date.now()): Handoff | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m['type'] !== undefined && m['type'] !== 'linkOut') return null;
  if (m['reason'] !== undefined && m['reason'] !== 'externalScheme') return null;
  const url = m['url'];
  const scheme = handoffScheme(url);
  if (!scheme || typeof url !== 'string') return null;
  // deskd's own word for the scheme must agree with the link's, or it's not shown.
  if (typeof m['scheme'] === 'string' && m['scheme'].toLowerCase() !== scheme) return null;
  const shown = displayText(typeof m['displayText'] === 'string' && m['displayText'] ? m['displayText'] : url);
  // Its age counts from here: deskd sends it as it happens and keeps nothing, and this tab's clock may not be the desk's.
  return { id: nextId++, url, scheme, shown, at: now };
}

/** Which card shows: the newest hand-off, while it's fresh and not answered. Pure, beside the clock. */
export class HandoffWatch {
  private newest: Handoff | null = null;
  private readonly answered = new Set<number>();

  /** A hand-off arrived; true when it's the card now. `inputAt` is this device's last input on the stream. */
  take(h: Handoff | null, inputAt: number, now: number = Date.now()): boolean {
    if (!h || now - inputAt > HANDOFF_INPUT_MS) return false;
    this.newest = h;
    return true;
  }

  /** The card to show now, or null. */
  card(now: number = Date.now()): Handoff | null {
    const h = this.newest;
    if (!h || this.answered.has(h.id) || now - h.at > HANDOFF_STALE_MS) return null;
    return h;
  }

  /** Not now, or Open on this device: that one never shows again. */
  answer(id: number): void {
    this.answered.add(id);
  }
}

/** This device's last input on each desk's stream (`BrowserApp.tsx` notes it), for the device rule. */
const inputAtByDesk = new Map<string, number>();
export const noteStreamInput = (deskId: string, now: number = Date.now()): void => void inputAtByDesk.set(deskId, now);
export const streamInputAt = (deskId: string): number => inputAtByDesk.get(deskId) ?? -Infinity;
