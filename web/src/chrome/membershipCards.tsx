// What the office's membership cards say, word for word from the membership card proposal ("Copy"), and what each
// offers. Calm, short and specific: at most one main button, no exclamation marks, and nothing about age. Prices come
// from settings through Platform (`platform/membershipOffer.ts`), never from here. `CalmScreen.tsx` draws them.
// A teen's two cards are the only ones that differ by age, and they don't say so: `teenWelcomeCard` and `parentCard`.
import type { ReactNode } from 'react';
import { formatUsd, type MembershipOffer } from '../platform/membershipOffer';
import { DEFAULT_TIER_NAMES, type TierNames } from '../platform/tiers';

export interface CardLink {
  label: string;
  href: string;
}

export interface NoticeCard {
  /** The proposal's letter for this card, for tests and screenshots. T and P are a teen's: welcome, and waiting on a parent. */
  letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'T' | 'P';
  /** Two small desk tiles, etched "Personal" and "Work": A and E only. Decoration, so hidden from screen readers. */
  picture: boolean;
  /** "Personal" alone: the Alliance Member's one small desk. */
  oneDesk?: boolean;
  title: string;
  body: ReactNode;
  /** The body as plain text, for the live region. */
  say: string;
  /** The one main button. */
  action: CardLink | null;
  /** "Membership opens soon." in the button's place: card A before billing opens. */
  soon: boolean;
  /** The quiet link under the button: "Write to us", "Ask for an export". */
  link: CardLink | null;
  /** The Alliance line, information only, while that tier is on sale. */
  alliance: string | null;
}

const BLANK = { picture: false, action: null, soon: false, link: null, alliance: null } as const;

export const SOON = 'Membership opens soon.';

/** The tier's name is the owner's setting (contract tiers.md), on its own, so any name reads right. */
export const allianceLine = (usd: number, name: string = DEFAULT_TIER_NAMES.alliance): string =>
  `Want to start smaller? ${name} is one small desk with Browser, for ${formatUsd(usd)} a month.`;

/**
 * A. Signed up, never paid. The button goes to the account page, which has Pay, and only while Platform says Pay is
 * open; before that, "Membership opens soon." takes its place. `offer` null means Platform couldn't be asked, so the
 * card neither offers nor promises. The Alliance line needs Pay open and that tier's price.
 */
export function welcomeCard(offer: MembershipOffer | null, accountHref: string | null, names: TierNames = DEFAULT_TIER_NAMES): NoticeCard {
  const body = "Your desks appear here once you're a member: one for your personal life and one for your work, each on its own private desk. Work stays at work. Home stays home.";
  const open = offer?.open === true;
  return {
    ...BLANK,
    letter: 'A',
    picture: true,
    title: 'Welcome to your office',
    body,
    say: body,
    action: open && accountHref ? { label: 'See membership', href: accountHref } : null,
    soon: offer !== null && !open,
    alliance: open && offer.allianceMonthlyUsd !== null ? allianceLine(offer.allianceMonthlyUsd, names.alliance) : null,
  };
}

/**
 * A, for a teen who hasn't paid: one small desk, as Alliance is, and nothing about Pro or Officer, whose words and price
 * aren't theirs to see. The account page only offers them Alliance, so its button needs that tier on sale as well as
 * Pay open; otherwise "Membership opens soon." As on A, `offer` null means neither an offer nor a promise. The button
 * reads "How joining works": it informs and doesn't sell. The tier's name is the setting's, on its own, as in A's line.
 */
export function teenWelcomeCard(offer: MembershipOffer | null, accountHref: string | null, names: TierNames = DEFAULT_TIER_NAMES): NoticeCard {
  const body = `Your desk appears here once you join. ${names.alliance} is one small desk with Browser.`;
  const open = offer?.open === true && offer.allianceMonthlyUsd !== null;
  return {
    ...BLANK,
    letter: 'T',
    picture: true,
    oneDesk: true,
    title: 'Welcome to your office',
    body,
    say: body,
    action: open && accountHref ? { label: 'How joining works', href: accountHref } : null,
    soon: offer !== null && !open,
  };
}

/**
 * A teen whose parent or guardian hasn't agreed yet, in the words the Platform app's own page uses. The link is the
 * account page, which shows that page and can send the email again or fix the address. No billing or Pay words.
 */
export function parentCard(accountHref: string | null): NoticeCard {
  const body = "We're emailing them a link. Your account opens once they agree.";
  return {
    ...BLANK,
    letter: 'P',
    title: 'Waiting for your parent or guardian',
    body,
    say: body,
    link: accountHref ? { label: 'Send the email again', href: accountHref } : null,
  };
}

/** B. On the waitlist: nothing to press. */
export function waitlistCard(): NoticeCard {
  const body = "Membership opens soon, and we'll email you when it does. There's nothing to do until then.";
  return { ...BLANK, letter: 'B', title: "You're on the list", body, say: body };
}

/**
 * F. Ended or suspended by us, or held, and for now everyone whose membership stopped (C to E wait for `/v1/me`).
 * No offer, no dates and no reason: a held account must not learn it's held.
 */
export function inactiveCard(support: string): NoticeCard {
  return {
    ...BLANK,
    letter: 'F',
    title: 'Your membership is not active',
    body: (
      <>
        If you think this is a mistake, write to <a href={`mailto:${support}`}>{support}</a>.
      </>
    ),
    say: `If you think this is a mistake, write to ${support}.`,
  };
}
