// DRAFT, not imported by the app: cards C, D and E, and tile G, from the membership card proposal ("Copy"). They need
// `/v1/me` to say why a membership stopped and until when (proposal point 8), a contract change across two repos that
// waits for the owner's OK. The exact change is in STATUS.md (`sub/membership-cards`). Until it lands, everyone whose
// membership stopped sees card F. To wire them in: add `MembershipStop` to `Me` in `platform/api.ts`, have
// `noDeskNotice` return `draftCardKind`'s answer before F's, and draw these in `CalmScreen.tsx` like the others.
import type { MembershipOffer } from '../platform/membershipOffer';
import { allianceLine, type NoticeCard } from './membershipCards';

/** The proposed `/v1/me` fields, under `membership` (STATUS.md). */
export interface MembershipStop {
  /** Why the desks stopped, in the member's terms only. `other` is ended or suspended by us, or held: never more. */
  stoppedBy?: 'payment' | 'member' | 'other' | null;
  /** When the desks stopped (C). Null for `other`. */
  stoppedAt?: string | null;
  /** When the desk data is deleted, or was (C, D, E). Null for `other`. */
  dataDeleteAt?: string | null;
}

export type DraftCardKind = 'paused' | 'kept' | 'welcomeBack';

/**
 * C, D or E, or null for F (or for A and B, which the status alone decides). Anything missing or odd is F, which
 * says the least: a date we can't read is never guessed, and `other` never shows a date or an offer.
 */
export function draftCardKind(status: string | undefined, stop: MembershipStop | undefined, now: number): DraftCardKind | null {
  if (!stop) return null;
  const deleteAt = Date.parse(stop.dataDeleteAt ?? '');
  if (Number.isNaN(deleteAt)) return null;
  if (stop.stoppedBy === 'payment' && (status === 'suspended' || status === 'unpaid')) {
    return deleteAt > now && !Number.isNaN(Date.parse(stop.stoppedAt ?? '')) ? 'paused' : null;
  }
  if (stop.stoppedBy === 'member' && status === 'ended') return deleteAt > now ? 'kept' : 'welcomeBack';
  return null;
}

/** A calendar date in the member's own time zone: "December 6", with the year when it isn't this year's. */
export function calendarDate(iso: string, now: number, timeZone?: string): string {
  const at = new Date(iso);
  const year = (d: Date) => new Intl.DateTimeFormat('en-US', { year: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(d);
  const sameYear = year(at) === year(new Date(now));
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), ...(timeZone ? { timeZone } : {}) }).format(at);
}

/** Proposal point 5: "with your tabs and sign-ins" only once the restore rehearsal passes (TD-110). It hasn't. */
export const RESTORE_REHEARSAL_PASSED = false;

export interface DraftLinks {
  /** `links.account`, through `accountUrl`: the account page, with Pay. */
  account: string | null;
  /** `links.billing`, through `siblingUrl` in `platform/hosts.ts`: where a failed payment is paid. */
  billing: string | null;
  /** `supportAddress(config)`. */
  support: string;
}

const NONE = { picture: false, action: null, soon: false, link: null, alliance: null } as const;

/** C. Payment failed, desks stopped. No price pitch: this person already wants in. */
export function pausedCard(stoppedAt: string, dataDeleteAt: string, links: DraftLinks, now: number, timeZone?: string): NoticeCard {
  const stopped = calendarDate(stoppedAt, now, timeZone);
  const kept = calendarDate(dataDeleteAt, now, timeZone);
  return {
    ...NONE,
    letter: 'C',
    title: 'Your desks are paused',
    body: (
      <>
        Your last payment didn't go through, so your desks stopped on <b>{stopped}</b>. Everything on them is kept until <b>{kept}</b>. Update your payment method and they start again.
      </>
    ),
    say: `Your last payment didn't go through, so your desks stopped on ${stopped}. Everything on them is kept until ${kept}. Update your payment method and they start again.`,
    action: links.billing ? { label: 'Update payment', href: links.billing } : null,
    link: { label: 'Write to us', href: `mailto:${links.support}` },
  };
}

/**
 * Where card D's "Ask for an export" goes, in this one place. By email for now (proposal point 6). Task 32 is building
 * a self-serve export on `/account`: when it ships, point this at that page, and nothing else changes.
 */
export const EXPORT_TARGET = (links: DraftLinks): string => `mailto:${links.support}?subject=${encodeURIComponent('Export my desks')}`;

/** D. Cancelled, desks still kept. Export is as easy to find as Rejoin. */
export function keptCard(dataDeleteAt: string, links: DraftLinks, now: number, timeZone?: string): NoticeCard {
  const kept = calendarDate(dataDeleteAt, now, timeZone);
  const restore = RESTORE_REHEARSAL_PASSED ? "Rejoin before then and we'll restore them, with your tabs and sign-ins." : "Rejoin before then and we'll restore them.";
  return {
    ...NONE,
    letter: 'D',
    title: 'Your membership has ended',
    body: (
      <>
        Your desks are kept until <b>{kept}</b>. {restore} After that we delete them, as our Terms say.
      </>
    ),
    say: `Your desks are kept until ${kept}. ${restore} After that we delete them, as our Terms say.`,
    action: links.account ? { label: 'Rejoin', href: links.account } : null,
    link: { label: 'Ask for an export', href: EXPORT_TARGET(links) },
  };
}

/** E. Cancelled, desks deleted: a fresh start, with the Alliance line from A. */
export function welcomeBackCard(dataDeleteAt: string, offer: MembershipOffer | null, links: DraftLinks, now: number, timeZone?: string): NoticeCard {
  const deleted = calendarDate(dataDeleteAt, now, timeZone);
  const open = offer?.open === true;
  return {
    ...NONE,
    letter: 'E',
    picture: true,
    title: 'Welcome back',
    body: (
      <>
        Your earlier desks were deleted on <b>{deleted}</b>, as our Terms say, so rejoining starts with fresh ones.
      </>
    ),
    say: `Your earlier desks were deleted on ${deleted}, as our Terms say, so rejoining starts with fresh ones.`,
    action: open && links.account ? { label: 'See membership', href: links.account } : null,
    alliance: open && offer.allianceMonthlyUsd !== null ? allianceLine(offer.allianceMonthlyUsd) : null,
  };
}

// ----- G: the Alliance Member tile. A desk-sized slot in canvas space beside the member's desk (the Look), which is
// canvas work in `src/canvas/` and waits for that tier to be on sale. Only its words and "Not now" are drafted here.
export const TILE_G = {
  title: 'Room for work and life',
  body: 'Membership adds a Personal and a Work desk, each its own private desk. Move up any time and pay only the difference for the rest of the month.',
  action: 'See membership',
  notNow: 'Not now',
} as const;

/** Proposal point 7: "Not now" hides the tile for 30 days, in this browser. */
export const TILE_G_QUIET_MS = 30 * 24 * 60 * 60 * 1000;
export const TILE_G_KEY = 'ma.tileG.notNow.v1';

/** Whether tile G may show, given when "Not now" was last pressed (ms since epoch, or nothing). */
export function tileGShows(notNowAt: number | null, now: number): boolean {
  return notNowAt === null || !Number.isFinite(notNowAt) || notNowAt > now || now - notNowAt >= TILE_G_QUIET_MS;
}
