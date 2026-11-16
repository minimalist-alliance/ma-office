// The mark menu's rows and links (`MarkPanel.tsx`, the Product Designer's mark menu spec §2): every row with Platform's
// keys present and absent, the apex check on `links.support`, a closed account, and "All desks" only where `home`.
import { describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../platform/clientConfig';
import { apexUrl, markGroups, type MarkGroup } from './MarkPanel';

// The panel's React side reaches the office's stores and the canvas, which need a page; the rows need none of it.
vi.mock('../shell/actions', () => ({ goOverview: () => undefined }));
vi.mock('../platform/session', () => ({ useSession: () => null }));
vi.mock('../platform/useClosed', () => ({ useClosed: () => false }));
vi.mock('../tour/door', () => ({ ownDesk: () => true, prefetchTour: () => undefined, startTour: () => undefined, tourOn: () => true }));

const PROD = 'office.minimalistalliance.com';
const STAGING = 'office.staging.minimalistalliance.com';
const P = 'https://platform.minimalistalliance.com';
const auth = { domain: 'https://auth.example', clientId: 'c', redirectUri: 'https://x/cb', logoutUri: 'https://x/out', scopes: [] };

/** Prod's desk-web links before Nov 12's keys: no forums, help or policy keys (the fallbacks). */
const TODAY: ClientConfig = { api: '', auth, links: { account: `${P}/account`, billing: `${P}/billing`, support: 'https://minimalistalliance.com/contact', office: 'https://office.minimalistalliance.com/' } };
/** With the five keys Platform is asked for. */
const KEYS: ClientConfig = {
  ...TODAY,
  links: {
    ...TODAY.links,
    forums: 'https://forums.minimalistalliance.com/',
    help: 'https://minimalistalliance.com/help',
    privacy: 'https://minimalistalliance.com/privacy',
    terms: 'https://minimalistalliance.com/terms',
    guidelines: 'https://minimalistalliance.com/guidelines',
  },
};

const flat = (groups: MarkGroup[]): [string, string | null][] => groups.flatMap((g) => g.rows.map((r): [string, string | null] => [r.label, r.href]));
const names = (groups: MarkGroup[]): (string | null)[] => groups.map((g) => g.name);
const member = { home: true, closed: false };

describe('markGroups', () => {
  it('with the keys: every row, in order, each to its page', () => {
    const groups = markGroups(KEYS, member, PROD);
    expect(names(groups)).toEqual([null, 'Community', 'Your account', 'Policies']);
    expect(flat(groups)).toEqual([
      ['All desks', null],
      ['Forums', 'https://forums.minimalistalliance.com/'],
      ['Help', 'https://minimalistalliance.com/help'],
      ['Account', `${P}/account`],
      ['Billing', `${P}/billing`],
      ['Privacy', 'https://minimalistalliance.com/privacy'],
      ['Terms', 'https://minimalistalliance.com/terms'],
      ['Guidelines', 'https://minimalistalliance.com/guidelines'],
    ]);
    expect(groups.find((g) => g.name === 'Policies')?.foot).toBe(true);
  });

  it('without them (prod today): no Forums row, Help is the Contact page, the policies are on links.support\'s origin', () => {
    expect(flat(markGroups(TODAY, member, PROD))).toEqual([
      ['All desks', null],
      ['Help', 'https://minimalistalliance.com/contact'],
      ['Account', `${P}/account`],
      ['Billing', `${P}/billing`],
      ['Privacy', 'https://minimalistalliance.com/privacy'],
      ['Terms', 'https://minimalistalliance.com/terms'],
      ['Guidelines', 'https://minimalistalliance.com/guidelines'],
    ]);
  });

  it('the keys as Platform sends them in both envs from Nov 12 (contract desks.md 0.3.119 draft): every row, Help still on Contact', () => {
    const live = (apex: string, suffix: string): ClientConfig => ({
      api: '',
      auth,
      links: {
        forums: `https://forums.${suffix}/`,
        help: `${apex}/contact`,
        privacy: `${apex}/privacy`,
        terms: `${apex}/terms`,
        guidelines: `${apex}/guidelines`,
        account: `https://platform.${suffix}/account`,
        billing: `https://platform.${suffix}/billing`,
        support: `${apex}/contact`,
      },
    });
    for (const [host, apex, suffix] of [
      [PROD, 'https://minimalistalliance.com', 'minimalistalliance.com'],
      [STAGING, 'https://staging.minimalistalliance.com', 'staging.minimalistalliance.com'],
    ] as const) {
      expect(flat(markGroups(live(apex, suffix), member, host))).toEqual([
        ['All desks', null],
        ['Forums', `https://forums.${suffix}/`],
        ['Help', `${apex}/contact`],
        ['Account', `https://platform.${suffix}/account`],
        ['Billing', `https://platform.${suffix}/billing`],
        ['Privacy', `${apex}/privacy`],
        ['Terms', `${apex}/terms`],
        ['Guidelines', `${apex}/guidelines`],
      ]);
    }
  });

  it('staging: its own apex and siblings, never prod\'s', () => {
    const S = 'https://platform.staging.minimalistalliance.com';
    const staging: ClientConfig = { api: '', auth, links: { account: `${S}/account`, billing: `${S}/billing`, support: 'https://staging.minimalistalliance.com/contact' } };
    expect(flat(markGroups(staging, member, STAGING))).toEqual([
      ['All desks', null],
      ['Help', 'https://staging.minimalistalliance.com/contact'],
      ['Account', `${S}/account`],
      ['Billing', `${S}/billing`],
      ['Privacy', 'https://staging.minimalistalliance.com/privacy'],
      ['Terms', 'https://staging.minimalistalliance.com/terms'],
      ['Guidelines', 'https://staging.minimalistalliance.com/guidelines'],
    ]);
    // Prod's links on staging's office are no good there: only All desks is left.
    expect(flat(markGroups(KEYS, member, STAGING))).toEqual([['All desks', null]]);
    expect(flat(markGroups(KEYS, member, `test.${STAGING}`))).toEqual([['All desks', null]]);
  });

  it('"All desks" only where home; a group with no rows has no separator, since it isn\'t there', () => {
    expect(flat(markGroups(KEYS, { home: false, closed: false }, PROD)).map(([l]) => l)).toEqual(['Forums', 'Help', 'Account', 'Billing', 'Privacy', 'Terms', 'Guidelines']);
    expect(names(markGroups(KEYS, { home: false, closed: false }, PROD))).toEqual(['Community', 'Your account', 'Policies']);
  });

  it('"Take the tour" after All desks, where the tour is on (ADR 0056), with or without a way home', () => {
    expect(flat(markGroups(KEYS, { ...member, tour: true }, PROD)).slice(0, 3)).toEqual([
      ['All desks', null],
      ['Take the tour', null],
      ['Forums', 'https://forums.minimalistalliance.com/'],
    ]);
    const away = markGroups(KEYS, { home: false, closed: false, tour: true }, PROD);
    expect(names(away)).toEqual([null, 'Community', 'Your account', 'Policies']);
    expect(away[0]?.rows).toEqual([{ label: 'Take the tour', href: null, act: 'tour' }]);
  });

  it('a closed account: Help and the policies only, no way home, no tour, no Forums, no Account or Billing', () => {
    for (const home of [true, false]) {
      expect(flat(markGroups(KEYS, { home, closed: true, tour: true }, PROD))).toEqual([
        ['Help', 'https://minimalistalliance.com/help'],
        ['Privacy', 'https://minimalistalliance.com/privacy'],
        ['Terms', 'https://minimalistalliance.com/terms'],
        ['Guidelines', 'https://minimalistalliance.com/guidelines'],
      ]);
    }
    expect(names(markGroups(TODAY, { home: false, closed: true }, PROD))).toEqual(['Community', 'Policies']);
  });

  it('billing falls back to /v1/me\'s billingUrl, and only a good one counts', () => {
    const noBilling: ClientConfig = { ...TODAY, links: { ...TODAY.links, billing: 'http://platform.minimalistalliance.com/billing' } };
    expect(flat(markGroups(noBilling, member, PROD)).map(([l]) => l)).not.toContain('Billing');
    expect(flat(markGroups(noBilling, { ...member, billingFromMe: `${P}/billing?from=me` }, PROD))).toContainEqual(['Billing', `${P}/billing?from=me`]);
  });

  it('a link that isn\'t good gets no row; never a guess', () => {
    const bad: ClientConfig = {
      api: '',
      auth,
      links: {
        forums: 'https://forums.example.com/',
        help: 'javascript:alert(1)',
        account: 'https://office.minimalistalliance.com/account',
        billing: 'https://a.b.minimalistalliance.com/billing',
        support: 'mailto:support@minimalistalliance.com',
        privacy: 'http://minimalistalliance.com/privacy',
        terms: 'https://minimalistalliance.com:8443/terms',
        guidelines: 'https://user:pw@minimalistalliance.com/guidelines',
      },
    };
    expect(markGroups(bad, { home: false, closed: false }, PROD)).toEqual([]);
    expect(flat(markGroups(bad, member, PROD))).toEqual([['All desks', null]]);
  });

  it('a policy key of its own wins over the fallback, each on its own', () => {
    const one: ClientConfig = { ...TODAY, links: { ...TODAY.links, terms: 'https://minimalistalliance.com/legal/terms' } };
    expect(flat(markGroups(one, member, PROD)).slice(-3)).toEqual([
      ['Privacy', 'https://minimalistalliance.com/privacy'],
      ['Terms', 'https://minimalistalliance.com/legal/terms'],
      ['Guidelines', 'https://minimalistalliance.com/guidelines'],
    ]);
  });

  it('before client-config: only what needs none', () => {
    expect(flat(markGroups(null, member, PROD))).toEqual([['All desks', null]]);
    expect(markGroups(null, { home: false, closed: false }, PROD)).toEqual([]);
  });

  it('on a host that isn\'t the office, nothing but the way home', () => {
    expect(flat(markGroups(KEYS, member, 'evil.example.com'))).toEqual([['All desks', null]]);
  });
});

describe('apexUrl: links.support counts only as this site\'s apex', () => {
  it('takes the apex, over https, on this site only', () => {
    expect(apexUrl('https://minimalistalliance.com/contact', PROD)?.href).toBe('https://minimalistalliance.com/contact');
    expect(apexUrl('https://staging.minimalistalliance.com/contact', STAGING)?.href).toBe('https://staging.minimalistalliance.com/contact');
    expect(apexUrl('https://staging.minimalistalliance.com/contact', `test.${STAGING}`)?.href).toBe('https://staging.minimalistalliance.com/contact');
  });

  it('refuses a non-apex, http, a port, credentials, another site and anything not a URL', () => {
    for (const raw of [
      'https://platform.minimalistalliance.com/support',
      'https://www.minimalistalliance.com/contact',
      'https://office.minimalistalliance.com/contact',
      'http://minimalistalliance.com/contact',
      'https://minimalistalliance.com:8443/contact',
      'https://user@minimalistalliance.com/contact',
      'https://user:pw@minimalistalliance.com/contact',
      'https://minimalistalliance.com.evil.example/contact',
      'https://evilminimalistalliance.com/contact',
      'https://staging.minimalistalliance.com/contact',
      'mailto:support@minimalistalliance.com',
      'not a url',
      '',
      null,
      42,
    ]) {
      expect(apexUrl(raw, PROD), String(raw)).toBeNull();
    }
    // Prod's apex isn't staging's.
    expect(apexUrl('https://minimalistalliance.com/contact', STAGING)).toBeNull();
  });
});
