// The free tier's wire reads and words (S-119). Every sentence a member reads is here word for word.
import { afterEach, describe, expect, it } from 'vitest';
import type { Me } from '../platform/api';
import { setCurrentBand } from '../platform/age';
import { allianceDrive, freeName, isFree, membershipUrl, paidTier, readBrowserTime, readHeld, readTrial, secondsLeft, usedUp, DEFAULT_FREE_NAME } from './wire';
import {
  BUSY_LINE,
  headsUpText,
  meterLabel,
  meterNumbers,
  noDailyLimit,
  pausedWords,
  resetWord,
  trialLine,
  TRIAL_ENDED,
  TRIAL_OFFER,
  UPGRADED,
  UPGRADED_WORK,
} from './words';

const me = (membership: Record<string, unknown> | undefined): Me => ({ userId: 'u-1', ...(membership ? { membership } : {}) }) as Me;
const day = (startIso: string, used: number, limit = 45) => ({
  usedSeconds: used * 60,
  limitSeconds: limit * 60,
  startsAt: startIso,
  resetsAt: new Date(Date.parse(startIso) + 86_400_000).toISOString(),
});
// A day in Denver: from 07:00 UTC, so its reset is midnight there.
const DENVER = { timeZone: 'America/Denver', locale: 'en-US' };
const START = '2026-11-09T07:00:00.000Z';
const NOON = Date.parse('2026-11-09T19:00:00.000Z');

afterEach(() => setCurrentBand(null));

describe('who is free (`/v1/me`)', () => {
  it('reads `membership.tier: "free"`, whatever the status says', () => {
    expect(isFree(me({ tier: 'free', status: 'active' }))).toBe(true);
    expect(isFree(me({ tier: 'free', status: 'unpaid' }))).toBe(true);
    expect(isFree(me({ tier: 'officer', status: 'active' }))).toBe(false);
    expect(isFree(me(undefined))).toBe(false);
    expect(isFree(null)).toBe(false);
  });
  it('says which tier an upgrade went to, old ids included', () => {
    expect(paidTier(me({ tier: 'alliance' }))).toBe('alliance');
    expect(paidTier(me({ tier: 'officer' }))).toBe('officer');
    expect(paidTier(me({ tier: 'lead' }))).toBe('lead');
    expect(paidTier(me({ tier: 'member' }))).toBe('officer');
    expect(paidTier(me({}))).toBe('officer');
    expect(paidTier(me({ tier: 'free' }))).toBeNull();
    expect(paidTier(me({ tier: 'platinum' }))).toBeNull();
  });
});

describe('the free tier\'s name and the membership page', () => {
  it('is the owner\'s setting, `tierNames.free`, read as every name is, with "Free" where it\'s missing', () => {
    expect(DEFAULT_FREE_NAME).toBe('Free');
    expect(freeName(null)).toBe('Free');
    expect(freeName({ tierNames: { free: '  Starter ' } } as never)).toBe('Starter');
    for (const bad of ['', '   ', 'x'.repeat(25), 42, null]) expect(freeName({ tierNames: { free: bad } } as never)).toBe('Free');
  });
  it('goes to `links.membership` once Platform sends one, else the account page, and only on a sibling host', () => {
    const cfg = (links: Record<string, string>) => ({ api: 'https://api.minimalistalliance.com', auth: {}, links }) as never;
    const host = 'office.minimalistalliance.com';
    expect(membershipUrl(cfg({ account: 'https://platform.minimalistalliance.com/account' }), host)).toBe('https://platform.minimalistalliance.com/account');
    expect(membershipUrl(cfg({ account: 'https://platform.minimalistalliance.com/account', membership: 'https://platform.minimalistalliance.com/membership' }), host)).toBe(
      'https://platform.minimalistalliance.com/membership',
    );
    expect(membershipUrl(cfg({ membership: 'https://evil.example/m' }), host)).toBeNull();
    expect(membershipUrl(cfg({ account: 'http://platform.minimalistalliance.com/account' }), host)).toBeNull();
    expect(membershipUrl(null, host)).toBeNull();
  });
});

describe('the Alliance tier\'s drive, for the Files app', () => {
  it('is the setting\'s size, or nothing: never a figure of the app\'s own', () => {
    expect(allianceDrive({ tierAllowances: { alliance: { driveGb: 25 } } } as never)).toBe('25 GB');
    expect(allianceDrive({ tierAllowances: { alliance: { driveGb: 0 } } } as never)).toBeNull();
    expect(allianceDrive({} as never)).toBeNull();
    expect(allianceDrive(null)).toBeNull();
  });
});

describe('today\'s Browser time (the meter\'s `browserTime`, proposed)', () => {
  it('reads the numbers, and nothing that isn\'t a day', () => {
    expect(readBrowserTime(day(START, 19))).toEqual(day(START, 19));
    expect(readBrowserTime(null)).toBeNull();
    expect(readBrowserTime({ ...day(START, 19), limitSeconds: 0 })).toBeNull();
    expect(readBrowserTime({ ...day(START, 19), usedSeconds: -1 })).toBeNull();
    expect(readBrowserTime({ ...day(START, 19), resetsAt: 'midnight' })).toBeNull();
    expect(readBrowserTime({ ...day(START, 19), resetsAt: START })).toBeNull();
    // More than the limit reads as the limit: the ring is empty, never past empty.
    expect(readBrowserTime(day(START, 50))!.usedSeconds).toBe(45 * 60);
  });
  it('is used up at the limit, until the reset', () => {
    const t = readBrowserTime(day(START, 45))!;
    expect(usedUp(t, NOON)).toBe(true);
    expect(usedUp(t, Date.parse(t.resetsAt))).toBe(false);
    expect(usedUp(readBrowserTime(day(START, 44)), NOON)).toBe(false);
    expect(secondsLeft(readBrowserTime(day(START, 30))!)).toBe(15 * 60);
  });
});

describe('Maia\'s trial and a desk\'s busy word', () => {
  it('reads `trial.status`, and anything else as no trial', () => {
    for (const status of ['unused', 'active', 'ended', 'off'] as const) expect(readTrial({ status, days: 7 })).toEqual({ status, endsAt: null });
    expect(readTrial({ status: 'over' })).toBeNull();
    expect(readTrial(undefined)).toBeNull();
  });
  it('is held only when the desk says exactly that', () => {
    expect(readHeld({ seq: 1, held: true })).toBe(true);
    expect(readHeld({ seq: 1, held: 'yes' })).toBe(false);
    expect(readHeld(null)).toBe(false);
  });
});

describe('the words (the Product Designer\'s draft)', () => {
  const c = { now: NOON, ...DENVER };
  const t = readBrowserTime(day(START, 19))!;

  it('says "midnight" for the coming midnight, and the meter\'s time otherwise', () => {
    expect(resetWord(t.resetsAt, c)).toBe('midnight');
    // A reset at 1 AM there (an account zone an hour off this browser's) is written as the meter writes it.
    expect(resetWord('2026-11-10T08:00:00.000Z', c)).toBe('Tue 1:00 AM');
    // A midnight days away isn't "midnight".
    expect(resetWord('2026-11-12T07:00:00.000Z', c)).toBe('Thu 12:00 AM');
  });
  it('gives the meter its accessible name, with the numbers', () => {
    expect(meterLabel(t, c)).toBe('Browser time today: 19 of 45 minutes used. Resets at midnight.');
    expect(meterNumbers(t)).toBe('19 of 45 minutes used');
  });
  it('names the tier with no daily limit on its own, with no article', () => {
    expect(noDailyLimit('Alliance Member')).toBe('Alliance Member has no daily limit');
  });
  it('says the minutes actually left in the heads-up', () => {
    expect(headsUpText(readBrowserTime(day(START, 35))!, c)).toBe('10 minutes of Browser time left today. Resets at midnight.');
    expect(headsUpText(readBrowserTime(day(START, 38))!, c)).toBe('7 minutes of Browser time left today. Resets at midnight.');
    expect(headsUpText(readBrowserTime(day(START, 44))!, c)).toBe('1 minute of Browser time left today. Resets at midnight.');
  });
  it('pauses the Browser in its window, naming only apps the member has', () => {
    setCurrentBand('adult');
    expect(pausedWords(t.resetsAt, c)).toEqual({
      title: 'The Browser is paused until midnight',
      body: "That's today's free Browser time. Notebook and Agent keep working, and your tabs are safe.",
    });
    setCurrentBand('teen');
    expect(pausedWords(t.resetsAt, c).body).toBe("That's today's free Browser time. Notebook keeps working, and your tabs are safe.");
  });
  it('has Maia\'s trial, its end, the busy line and the upgrade\'s notice word for word, with no tier named', () => {
    expect(TRIAL_OFFER).toBe('Maia knows your office and can help with it. Try her free for a week, or up to $1 of her time, whichever ends first.');
    expect(TRIAL_ENDED).toBe("That was Maia's week. She comes with every membership.");
    expect(BUSY_LINE).toBe('Free desks share more, so busy times can be slower.');
    expect(UPGRADED).toBe('Your membership has started. Your desk keeps everything, with more room now.');
    expect(UPGRADED_WORK).toBe('Your membership has started. This desk keeps everything, and your Work desk is on its way.');
  });
});

describe("Maia's trial line in the usage panel", () => {
  const c = { now: NOON, ...DENVER };
  it('says unused, active with its date, and ended word for word, and nothing where she is off', () => {
    expect(trialLine(readTrial({ status: 'unused' }), c)).toBe('Maia: free for a week or up to $1, starting with your first message');
    expect(trialLine(readTrial({ status: 'active', endsAt: '2026-11-16T20:00:00.000Z' }), c)).toBe('Maia: free trial until Nov 16');
    expect(trialLine(readTrial({ status: 'active' }), c)).toBe('Maia: free trial');
    expect(trialLine(readTrial({ status: 'ended', endsAt: '2026-11-16T20:00:00.000Z' }), c)).toBe('Maia: trial ended');
    expect(trialLine(readTrial({ status: 'off' }), c)).toBeNull();
    expect(trialLine(readTrial(undefined), c)).toBeNull();
  });
});
