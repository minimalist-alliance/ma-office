// Card D in Sales' words (business/ended-membership-copy.md): the rows by tier, each only where its fact is sent, Rejoin
// with the tier and today's price, the teen's and the unknown tier's cases, and where Compare goes.
import { describe, expect, it } from 'vitest';
import { browserMinutesOf, compareUrl, ENDED_WORDS, endedCard, endedFacts, endedRows, endedTier, FREE_NOW_WORDS, freeDeskCell, freeNowCard, freeNowRows, type EndedFacts, type EndedLinks } from './endedCard';
import { pricesFrom } from '../platform/membershipOffer';
import { DEFAULT_TIER_NAMES } from '../platform/tiers';

const NOW = Date.parse('2026-11-12T20:00:00Z');
const KEPT = '2026-12-12T20:00:00Z';
const LINKS: EndedLinks = {
  account: 'https://platform.minimalistalliance.com/account',
  billing: null,
  exportPage: '/export',
  support: 'support@minimalistalliance.com',
  rejoin: 'https://platform.minimalistalliance.com/billing',
  compare: 'https://minimalistalliance.com/#pricing',
};
const PRICES = pricesFrom({ billing: { enabled: true, officerMonthlyUsd: 100, leadMonthlyUsd: 200, allianceMonthlyUsd: 10 } });
const GUILDS = { guilds: { open: true, maxGuildsPerMember: 3 } };
const facts = (tier: string | undefined, over: Partial<EndedFacts> = {}, me: Record<string, unknown> = {}): EndedFacts => ({
  ...endedFacts({ membership: { tier }, ...me }, GUILDS, PRICES),
  ...over,
});
const table = (f: EndedFacts) => endedRows(f, 'December 12').map((r) => [r.label, r.was, r.now]);

describe('card D: what an ended membership is now and what changed', () => {
  it('reads the tier it ended from, and nothing else as one', () => {
    expect(['alliance', 'officer', 'lead', 'member', 'free', undefined, null, 'gold'].map(endedTier)).toEqual(['alliance', 'officer', 'lead', 'officer', null, null, null, null]);
  });

  it('Officer: Desks, Forums, Guilds, Moderating and Badge', () => {
    expect(table(facts('officer'))).toEqual([
      ['Desks', 'Personal and Work', 'Stopped, kept until December 12'],
      ['Forums', 'Read and post', 'Read only'],
      ['Guilds', 'Join and help run them', 'Paused until you rejoin'],
      ['Moderating', 'Help moderate the Forums', 'Ended'],
      ['Badge', 'Officer badge', 'None'],
    ]);
  });

  it('Alliance: one small desk, Forums, and the guild cap from client-config', () => {
    expect(table(facts('alliance'))).toEqual([
      ['Desk', 'One small desk', 'Stopped, kept until December 12'],
      ['Forums', 'Read and post', 'Read only'],
      ['Guilds', 'Join up to 3', 'Paused until you rejoin'],
    ]);
  });

  it('Founder: Your guild only when they lead one, never the Guilds row', () => {
    const leads = facts('lead', {}, { guilds: [{ guildId: 'gu-1', role: 'lead' }] });
    expect(table(leads).map((r) => r[0])).toEqual(['Desks', 'Forums', 'Your guild', 'Moderating', 'Badge']);
    expect(table(leads)[2]).toEqual(['Your guild', 'You lead it', "It stays, but you can't change it until you rejoin as Founder"]);
    expect(table(facts('lead', {}, { guilds: [{ guildId: 'gu-1', role: 'member' }] })).map((r) => r[0])).toEqual(['Desks', 'Forums', 'Moderating', 'Badge']);
  });

  it('a fact not sent leaves its row out: no guilds where they are closed, no cap for Alliance without one', () => {
    const closed = endedFacts({ membership: { tier: 'officer' } }, { guilds: { open: false } }, PRICES);
    expect(table(closed).map((r) => r[0])).toEqual(['Desks', 'Forums', 'Moderating', 'Badge']);
    const noCap = endedFacts({ membership: { tier: 'alliance' } }, { guilds: { open: true } }, PRICES);
    expect(table(noCap).map((r) => r[0])).toEqual(['Desk', 'Forums']);
  });

  it('the tier names are the setting\'s', () => {
    const names = { ...DEFAULT_TIER_NAMES, officer: 'Captain', lead: 'Patron' };
    const f = endedFacts({ membership: { tier: 'lead' }, guilds: [{ role: 'lead' }] }, GUILDS, PRICES, names);
    const d = endedCard(KEPT, f, LINKS, NOW, 'UTC');
    expect(d.title).toBe('Your Patron membership has ended');
    expect(d.action?.label).toBe('Rejoin Patron · $200 a month');
    expect(table(f).find((r) => r[0] === 'Badge')).toEqual(['Badge', 'Patron badge', 'None']);
  });

  it('the card: title, line, the date after the list, Rejoin with the tier and price, Compare and Download your data', () => {
    const d = endedCard(KEPT, facts('alliance'), LINKS, NOW, 'UTC');
    expect(d.letter).toBe('D');
    expect(d.title).toBe('Your Alliance Member membership has ended');
    expect(d.say).toBe("Your account is still here, without a membership. Rejoin by December 12 and we'll restore your desks. After December 12, we delete your desks and their data, as our Terms say.");
    expect(d.after).toBe('After December 12, we delete your desks and their data, as our Terms say.');
    expect(d.action).toEqual({ label: 'Rejoin Alliance Member · $10 a month', href: LINKS.rejoin });
    expect(d.link).toEqual({ label: 'Compare memberships', href: LINKS.compare });
    expect(d.more).toEqual([{ label: 'Download your data', href: '/export' }]);
    expect(d.say).not.toMatch(/free|Maia|Agent|Courier|year/i);
  });

  it('no price while Pay is off, and no tier name when the tier is unknown', () => {
    expect(endedCard(KEPT, facts('officer', { priceUsd: null }), LINKS, NOW, 'UTC').action?.label).toBe('Rejoin Officer');
    expect(endedFacts({ membership: { tier: 'officer' } }, GUILDS, null).priceUsd).toBeNull();
    const unknown = endedCard(KEPT, facts(undefined), LINKS, NOW, 'UTC');
    expect(unknown.title).toBe('Your membership has ended');
    expect(unknown.action?.label).toBe('Rejoin');
    // Without its With column: just the Now lines for desks, Forums and guilds.
    expect(table(facts(undefined))).toEqual([
      ['Desks', null, 'Stopped, kept until December 12'],
      ['Forums', null, 'Read only'],
      ['Guilds', null, 'Paused until you rejoin'],
    ]);
  });

  it('a teen whose parent pays (parent done, or pending): Ask your parent to rejoin, with no price', () => {
    for (const parent of ['done', 'pending']) {
      const f = endedFacts({ membership: { tier: 'alliance', ageBand: 'teen', parent } }, GUILDS, PRICES);
      expect(f.priceUsd).toBeNull();
      expect(endedCard(KEPT, f, LINKS, NOW, 'UTC').action).toEqual({ label: ENDED_WORDS.askParent, href: LINKS.rejoin });
    }
  });

  it('a teen in a state that asks for no parent (parent null or absent): Rejoin with the tier, still no price; an adult never asks a parent', () => {
    for (const parent of [null, undefined, 'released']) {
      const f = endedFacts({ membership: { tier: 'alliance', ageBand: 'teen', parent } }, GUILDS, PRICES);
      expect([f.parentActs, f.priceUsd]).toEqual([false, null]);
      expect(endedCard(KEPT, f, LINKS, NOW, 'UTC').action).toEqual({ label: 'Rejoin Alliance Member', href: LINKS.rejoin });
    }
    expect(endedFacts({ membership: { tier: 'alliance', ageBand: 'adult', parent: 'done' } }, GUILDS, PRICES).parentActs).toBe(false);
  });

  it('where the export page is off, Ask for your data by email; no Rejoin without a page to go to', () => {
    const d = endedCard(KEPT, facts('officer'), { ...LINKS, exportPage: null, rejoin: null, compare: null }, NOW, 'UTC');
    expect(d.more?.[0]?.label).toBe('Ask for your data');
    expect(d.more?.[0]?.href).toMatch(/^mailto:support@minimalistalliance\.com\?subject=/);
    expect(d.action).toBeNull();
    expect(d.link).toBeNull();
  });
});

describe('card D in both client-config states (with free.open, and with no free block)', () => {
  // Identity's POST /v1/me/free refuses `ended` (FREE_JOINABLE, ma-platform tiers.md 11.2): an ended membership stays ended
  // where Free is on, so the card is the same with or without client-config's `free` block, and never claims Free.
  const STAGING_FREE = { free: { open: true, monthlyUsd: 0, minimumAge: 13, desks: 1, browserMinutesPerDay: 45, filesGb: 2, idleStopMinutes: 30 } };
  const NAMES = { ...DEFAULT_TIER_NAMES, free: 'Free' } as typeof DEFAULT_TIER_NAMES;
  const words = (c: ReturnType<typeof endedCard>) => JSON.stringify([c.title, c.say, c.after, c.action, c.link, c.more]);

  for (const tier of ['alliance', 'officer', 'lead', 'gold']) {
    it(`${tier}: the same facts, rows and words with the free block as without, and no "free" anywhere`, () => {
      const me = { membership: { tier }, guilds: [{ guildId: 'gu-1', role: 'lead' }] };
      const noBlock = endedFacts(me, GUILDS, PRICES, NAMES);
      const freeOpen = endedFacts(me, { ...GUILDS, ...STAGING_FREE }, PRICES, NAMES);
      expect(freeOpen).toEqual(noBlock);
      expect(endedRows(freeOpen, 'December 12')).toEqual(endedRows(noBlock, 'December 12'));
      const a = endedCard(KEPT, noBlock, LINKS, NOW, 'UTC');
      const b = endedCard(KEPT, freeOpen, LINKS, NOW, 'UTC');
      expect(words(b)).toBe(words(a));
      expect(words(b)).not.toMatch(/free/i);
      expect(b.title).toMatch(/membership has ended$/);
    });
  }

  it('"without a membership", in Sales\' words, in both', () => {
    const c = endedCard(KEPT, endedFacts({ membership: { tier: 'officer' } }, STAGING_FREE, PRICES, NAMES), LINKS, NOW, 'UTC');
    expect(c.say).toBe("Your account is still here, without a membership. Rejoin by December 12 and we'll restore your desks. After December 12, we delete your desks and their data, as our Terms say.");
  });
});

describe('Compare memberships', () => {
  const host = 'office.minimalistalliance.com';
  it('links.pricing first, else /#pricing on the landing the policies name, else nothing', () => {
    expect(compareUrl({ pricing: 'https://minimalistalliance.com/pricing' }, host)).toBe('https://minimalistalliance.com/pricing');
    expect(compareUrl({ support: 'https://minimalistalliance.com/contact' }, host)).toBe('https://minimalistalliance.com/#pricing');
    expect(compareUrl({ terms: 'https://minimalistalliance.com/terms' }, host)).toBe('https://minimalistalliance.com/#pricing');
    expect(compareUrl({ support: 'mailto:support@minimalistalliance.com', terms: 'https://evil.example/terms' }, host)).toBeNull();
    expect(compareUrl(undefined, host)).toBeNull();
  });
});

describe('each tier\'s price, from Platform\'s billing block', () => {
  it('only while Pay is open, each tier only where it has a price', () => {
    expect(pricesFrom({ billing: { enabled: true, officerMonthlyUsd: 100 } })).toEqual({ alliance: null, officer: 100, lead: null });
    expect(PRICES).toEqual({ alliance: 10, officer: 100, lead: 200 });
    expect(pricesFrom({ billing: { enabled: false, officerMonthlyUsd: 100, leadMonthlyUsd: 200 } })).toBeNull();
    expect(pricesFrom({})).toBeNull();
  });
});

// Sales' 1A (and its Nov 14 note): "You're on {Free} now", the free chunk's card (free/freeNow.tsx), the same words as
// ma-platform's /account and /billing.
describe('1A: on Free after a paid membership', () => {
  const WORK_KEPT = { personal: false, work: true };
  const NONE = { personal: false, work: false };
  const ALL = { personal: true, work: true };
  const DL = { label: 'Download your data', href: '/export' };
  const L = { rejoin: LINKS.rejoin, compare: LINKS.compare, download: DL };

  it('the desk cell: a desk Free can\'t hold is "Stopped, kept for you to download" for every tier, never One desk or Personal', () => {
    expect(freeDeskCell('alliance', { personal: true, work: false })).toBe('Stopped, kept for you to download');
    expect(freeDeskCell('officer', ALL)).toBe('Stopped, kept for you to download');
    expect(freeDeskCell('lead', { personal: true, work: false })).toBe('Stopped, kept for you to download');
    expect(freeDeskCell('alliance', NONE)).toBe('One desk');
    expect(freeDeskCell('officer', WORK_KEPT)).toBe('Personal. Work is stopped and kept for you to download.');
    expect(freeDeskCell('officer', NONE)).toBe('Personal');
  });

  it('Officer: Desks, Browser, Moderating and Badge against On Free', () => {
    expect(freeNowRows('officer', facts(undefined), 45, WORK_KEPT).map((r) => [r.label, r.was, r.now])).toEqual([
      ['Desks', 'Personal and Work', 'Personal. Work is stopped and kept for you to download.'],
      ['Browser', 'Within your monthly allowance', '45 minutes a day'],
      ['Moderating', 'Help moderate the Forums', 'Ended'],
      ['Badge', 'Officer badge', 'None'],
    ]);
  });

  it('Alliance: Desk and Browser; Founder who leads a guild: You no longer lead it; no Browser row without its minutes', () => {
    expect(freeNowRows('alliance', facts(undefined), null, { personal: true, work: false }).map((r) => [r.label, r.was, r.now])).toEqual([['Desk', 'One small desk', 'Stopped, kept for you to download']]);
    expect(freeNowRows('lead', facts(undefined, { leadsGuild: true }), 45, WORK_KEPT).map((r) => r.label)).toEqual(['Desks', 'Browser', 'Your guild', 'Moderating', 'Badge']);
    expect(freeNowRows('lead', facts(undefined, { leadsGuild: true }), 45, WORK_KEPT)[2]!.now).toBe('You no longer lead it');
    expect(freeNowRows('lead', facts(undefined), 45, WORK_KEPT).map((r) => r.label)).not.toContain('Your guild');
  });

  it('the card: Sales\' title and line, Rejoin the tier it had at today\'s price, Compare, and the download only while a desk is kept', () => {
    const c = freeNowCard('officer', facts(undefined, { priceUsd: 100 }), 'Free', 45, WORK_KEPT, L);
    expect(c.title).toBe("You're on Free now");
    expect(c.line).toBe('Your Officer membership has ended, and your account moved to Free, which has no charge.');
    expect(c.say).toBe("You're on Free now. Your Officer membership has ended, and your account moved to Free, which has no charge.");
    expect(c.action).toEqual({ label: 'Rejoin Officer · $100 a month', href: LINKS.rejoin });
    expect(c.link).toEqual({ label: 'Compare memberships', href: LINKS.compare });
    expect(c.more).toEqual([DL]);
    expect(freeNowCard('alliance', facts(undefined, { priceUsd: 10 }), 'Free', 45, NONE, L).more).toEqual([]);
    expect(freeNowCard('alliance', facts(undefined, { priceUsd: 10 }), 'Free', 45, { personal: true, work: false }, L).more).toEqual([DL]);
    // The free tier's name is the setting's.
    expect(freeNowCard('officer', facts(undefined), 'Basic', 45, WORK_KEPT, L).title).toBe("You're on Basic now");
  });

  it('a teen: no price; a parent who pays: Ask your parent to rejoin; no Rejoin without a page', () => {
    expect(freeNowCard('alliance', facts(undefined, { priceUsd: 10, teen: true }), 'Free', 45, NONE, L).action!.label).toBe('Rejoin Alliance Member');
    expect(freeNowCard('alliance', facts(undefined, { priceUsd: 10, teen: true, parentActs: true }), 'Free', 45, NONE, L).action!.label).toBe('Ask your parent to rejoin');
    expect(freeNowCard('officer', facts(undefined), 'Free', 45, NONE, { ...L, rejoin: null }).action).toBeNull();
  });

  it('the Browser minutes only as a positive whole number', () => {
    expect([{ browserMinutesPerDay: 45 }, { browserMinutesPerDay: 0 }, { browserMinutesPerDay: 4.5 }, {}, null, 'x'].map(browserMinutesOf)).toEqual([45, null, null, null, null, null]);
  });

  it('words: the same as ma-platform\'s FREE_NOW', () => {
    expect(FREE_NOW_WORDS.keptForDownload).toBe('Stopped, kept for you to download');
    expect(FREE_NOW_WORDS.onHead('Free')).toBe('On Free');
  });
});
