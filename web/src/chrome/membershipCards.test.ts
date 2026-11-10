import { describe, expect, it } from 'vitest';
import {
  calendarDate,
  draftCardKind,
  EXPORT_TARGET,
  keptCard,
  pausedCard,
  RESTORE_REHEARSAL_PASSED,
  TILE_G,
  TILE_G_QUIET_MS,
  tileGShows,
  welcomeBackCard,
} from './membershipCards.draft';
import { allianceLine, inactiveCard, parentCard, SOON, teenWelcomeCard, waitlistCard, welcomeCard, type NoticeCard } from './membershipCards';

const ACCOUNT = 'https://platform.minimalistalliance.com/account';
const OPEN = { open: true, allianceMonthlyUsd: null };
const CLOSED = { open: false, allianceMonthlyUsd: null };
const SUPPORT = 'support@minimalistalliance.com';
const LINKS = { account: ACCOUNT, billing: 'https://platform.minimalistalliance.com/billing', support: SUPPORT };
const NOW = Date.parse('2026-11-20T12:00:00Z');

/** Every word a card shows, to check the whole card at once. */
const words = (c: NoticeCard): string => [c.title, c.say, c.action?.label, c.soon ? SOON : '', c.link?.label, c.alliance].filter(Boolean).join(' ');

describe("a teen's welcome card", () => {
  const ALLIANCE_OPEN = { open: true, allianceMonthlyUsd: 5 };

  it('speaks of one small desk, as Alliance is', () => {
    const t = teenWelcomeCard(ALLIANCE_OPEN, ACCOUNT);
    expect(t.title).toBe('Welcome to your office');
    expect(t.say).toBe('Your desk appears here once you join. Alliance Member is one small desk with Browser.');
    expect(t.picture).toBe(true);
    expect(t.oneDesk).toBe(true);
  });

  it("names the tier from the owner's setting, on its own", () => {
    const t = teenWelcomeCard(ALLIANCE_OPEN, ACCOUNT, { alliance: 'Cadet', officer: 'Captain', lead: 'Pathfinder' });
    expect(t.say).toBe('Your desk appears here once you join. Cadet is one small desk with Browser.');
  });

  it('goes to the Platform app, whose page only offers them Alliance, with a button that informs and does not sell', () => {
    expect(teenWelcomeCard(ALLIANCE_OPEN, ACCOUNT).action).toEqual({ label: 'How joining works', href: ACCOUNT });
  });

  it('offers nothing while Alliance is not on sale, whatever Pro is doing', () => {
    for (const offer of [{ open: true, allianceMonthlyUsd: null }, { open: false, allianceMonthlyUsd: 5 }, CLOSED]) {
      const t = teenWelcomeCard(offer, ACCOUNT);
      expect(t.action).toBeNull();
      expect(t.soon).toBe(true);
    }
  });

  it('when Platform could not be asked, or gave no account page: no button, and no promise either', () => {
    expect(teenWelcomeCard(null, ACCOUNT).action).toBeNull();
    expect(teenWelcomeCard(null, ACCOUNT).soon).toBe(false);
    expect(teenWelcomeCard(ALLIANCE_OPEN, null).action).toBeNull();
    expect(teenWelcomeCard(ALLIANCE_OPEN, null).soon).toBe(false);
  });

  it('never offers Pro or Officer or prices them, or says anything about age', () => {
    for (const offer of [ALLIANCE_OPEN, { open: true, allianceMonthlyUsd: null }, CLOSED, null]) {
      const t = teenWelcomeCard(offer, ACCOUNT);
      expect(words(t)).not.toMatch(/\bPro\b|Officer|Work\b|\$|\bage\b|\bteen|\b1[3-8]\b/i);
      expect(t.alliance).toBeNull();
    }
  });
});

describe('the card for a teen waiting on a parent', () => {
  it('says the account opens once they agree, and links to the page that can send the email again', () => {
    const p = parentCard(ACCOUNT);
    expect(p.title).toBe('Waiting for your parent or guardian');
    expect(p.say).toBe("We're emailing them a link. Your account opens once they agree.");
    expect(p.link).toEqual({ label: 'Send the email again', href: ACCOUNT });
    expect(p.picture).toBe(false);
  });

  it('has no button, and no billing or Pay words', () => {
    const p = parentCard(ACCOUNT);
    expect(p.action).toBeNull();
    expect(p.soon).toBe(false);
    expect(p.alliance).toBeNull();
    expect(words(p)).not.toMatch(/\bpay|billing|price|\$|membership|checkout|card\b|\bPro\b|Officer/i);
  });

  it('with no good account link, it still says what is happening and offers nothing', () => {
    const p = parentCard(null);
    expect(p.link).toBeNull();
    expect(p.title).toContain('parent or guardian');
    expect(p.say).toContain('opens once they agree');
  });
});

describe('card A, welcome', () => {
  it('has the proposal’s words and its picture', () => {
    const a = welcomeCard(OPEN, ACCOUNT);
    expect(a.title).toBe('Welcome to your office');
    expect(a.say).toBe("Your desks appear here once you're a member: one for your personal life and one for your work, each on its own private desk. Work stays at work. Home stays home.");
    expect(a.picture).toBe(true);
  });

  it('offers the account page only while Pay is open', () => {
    expect(welcomeCard(OPEN, ACCOUNT).action).toEqual({ label: 'See membership', href: ACCOUNT });
    expect(welcomeCard(OPEN, ACCOUNT).soon).toBe(false);
  });

  it('before billing opens: no button, and "Membership opens soon." instead', () => {
    const a = welcomeCard(CLOSED, ACCOUNT);
    expect(a.action).toBeNull();
    expect(a.soon).toBe(true);
    expect(SOON).toBe('Membership opens soon.');
  });

  it('when Platform could not be asked, or gave no account page: no button, and no promise either', () => {
    for (const a of [welcomeCard(null, ACCOUNT), welcomeCard(OPEN, null)]) {
      expect(a.action).toBeNull();
      expect(a.soon).toBe(false);
    }
  });

  it('the Alliance line shows only with that tier’s price from settings, and only while Pay is open', () => {
    expect(welcomeCard(OPEN, ACCOUNT).alliance).toBeNull();
    expect(welcomeCard({ open: false, allianceMonthlyUsd: 10 }, ACCOUNT).alliance).toBeNull();
    expect(welcomeCard({ open: true, allianceMonthlyUsd: 10 }, ACCOUNT).alliance).toBe(
      'Want to start smaller? Alliance Member is one small desk with Browser, for $10 a month.',
    );
    expect(allianceLine(7.5)).toContain('for $7.50 a month.');
  });

  it('names the tier from the owner’s setting, on its own', () => {
    const names = { alliance: 'Cadet', officer: 'Captain', lead: 'Pathfinder' };
    expect(welcomeCard({ open: true, allianceMonthlyUsd: 10 }, ACCOUNT, names).alliance).toBe('Want to start smaller? Cadet is one small desk with Browser, for $10 a month.');
  });
});

describe('cards B and F', () => {
  it('B: the waitlist, with nothing to press', () => {
    const b = waitlistCard();
    expect([b.title, b.say]).toEqual(["You're on the list", "Membership opens soon, and we'll email you when it does. There's nothing to do until then."]);
    expect([b.picture, b.action, b.soon, b.link, b.alliance]).toEqual([false, null, false, null, null]);
  });

  it('F: no offer, no date, no reason, and the support address', () => {
    const f = inactiveCard(SUPPORT);
    expect([f.title, f.say]).toEqual(['Your membership is not active', 'If you think this is a mistake, write to support@minimalistalliance.com.']);
    expect([f.picture, f.action, f.soon, f.link, f.alliance]).toEqual([false, null, false, null, null]);
  });
});

describe('every card', () => {
  const all = [
    welcomeCard({ open: true, allianceMonthlyUsd: 10 }, ACCOUNT),
    welcomeCard(CLOSED, ACCOUNT),
    waitlistCard(),
    inactiveCard(SUPPORT),
    pausedCard('2026-11-18T03:00:00Z', '2026-12-06T03:00:00Z', LINKS, NOW, 'America/Denver'),
    keptCard('2026-12-06T03:00:00Z', LINKS, NOW, 'America/Denver'),
    welcomeBackCard('2026-11-01T03:00:00Z', { open: true, allianceMonthlyUsd: 10 }, LINKS, NOW, 'America/Denver'),
  ];

  it('is calm: no exclamation marks, no age, no trial or discount, no provider, no other tier name', () => {
    for (const c of all) {
      const w = words(c);
      expect(w).not.toMatch(/!/);
      expect(w).not.toMatch(/\b(age|ages|aged|years? old|18|13|adult|minor|under)\b/i);
      expect(w).not.toMatch(/\b(free|trial|discount|off|hurry|limited|left|only \d)\b|%/i);
      expect(w).not.toMatch(/\b(aws|amazon|ec2)\b/i);
      expect(w).not.toMatch(/pro member/i);
    }
  });
});

describe('drafts: cards C, D and E', () => {
  const stop = (stoppedBy: 'payment' | 'member' | 'other', dataDeleteAt: string | null, stoppedAt: string | null = '2026-11-18T03:00:00Z') => ({ stoppedBy, stoppedAt, dataDeleteAt });

  it('picks C, D or E from the proposed fields, and F (null) for anything else', () => {
    expect(draftCardKind('suspended', stop('payment', '2026-12-06T00:00:00Z'), NOW)).toBe('paused');
    expect(draftCardKind('unpaid', stop('payment', '2026-12-06T00:00:00Z'), NOW)).toBe('paused');
    expect(draftCardKind('ended', stop('member', '2026-12-06T00:00:00Z'), NOW)).toBe('kept');
    expect(draftCardKind('ended', stop('member', '2026-11-01T00:00:00Z'), NOW)).toBe('welcomeBack');
    expect(draftCardKind('ended', stop('other', '2026-12-06T00:00:00Z'), NOW)).toBeNull();
    expect(draftCardKind('suspended', stop('other', null, null), NOW)).toBeNull();
    expect(draftCardKind('suspended', stop('payment', 'not a date'), NOW)).toBeNull();
    expect(draftCardKind('suspended', stop('payment', '2026-12-06T00:00:00Z', null), NOW)).toBeNull();
    expect(draftCardKind('ended', undefined, NOW)).toBeNull();
  });

  it('dates are a calendar date in the member’s own time zone, with the year only when it differs', () => {
    // 03:00 UTC on the 6th is still the 5th in Denver.
    expect(calendarDate('2026-12-06T03:00:00Z', NOW, 'America/Denver')).toBe('December 5');
    expect(calendarDate('2026-12-06T03:00:00Z', NOW, 'Europe/Berlin')).toBe('December 6');
    expect(calendarDate('2027-01-02T12:00:00Z', NOW, 'UTC')).toBe('January 2, 2027');
  });

  it('C, D and E have the proposal’s words', () => {
    const c = pausedCard('2026-11-28T12:00:00Z', '2026-12-06T12:00:00Z', LINKS, NOW, 'UTC');
    expect(c.say).toBe("Your last payment didn't go through, so your desks stopped on November 28. Everything on them is kept until December 6. Update your payment method and they start again.");
    expect([c.title, c.action?.label, c.link?.label, c.link?.href]).toEqual(['Your desks are paused', 'Update payment', 'Write to us', `mailto:${SUPPORT}`]);

    const d = keptCard('2026-12-06T12:00:00Z', LINKS, NOW, 'UTC');
    expect(RESTORE_REHEARSAL_PASSED).toBe(false);
    expect(d.say).toBe("Your desks are kept until December 6. Rejoin before then and we'll restore them. After that we delete them, as our Terms say.");
    expect([d.title, d.action?.label, d.link?.label]).toEqual(['Your membership has ended', 'Rejoin', 'Ask for an export']);
    // By email until task 32's self-serve export ships, from the one constant that will point there.
    expect(d.link?.href).toBe(EXPORT_TARGET(LINKS));
    expect(EXPORT_TARGET(LINKS)).toMatch(/^mailto:support@minimalistalliance\.com\?subject=/);

    const e = welcomeBackCard('2026-11-01T12:00:00Z', { open: true, allianceMonthlyUsd: 10 }, LINKS, NOW, 'UTC');
    expect(e.say).toBe('Your earlier desks were deleted on November 1, as our Terms say, so rejoining starts with fresh ones.');
    expect([e.title, e.action?.label, e.picture, e.alliance]).toEqual(['Welcome back', 'See membership', true, allianceLine(10)]);
  });

  it('tile G: its words, and "Not now" quiets it for 30 days', () => {
    expect(TILE_G.title).toBe('Room for work and life');
    expect(tileGShows(null, NOW)).toBe(true);
    expect(tileGShows(NOW - 1000, NOW)).toBe(false);
    expect(tileGShows(NOW - TILE_G_QUIET_MS + 1, NOW)).toBe(false);
    expect(tileGShows(NOW - TILE_G_QUIET_MS, NOW)).toBe(true);
    expect(tileGShows(NOW + 60_000, NOW)).toBe(true); // a time from the future can't be trusted
  });
});
