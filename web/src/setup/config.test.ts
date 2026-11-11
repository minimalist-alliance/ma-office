// What the setup circle reads from client-config and `/v1/me`: tiers, kill switches, links on our own hosts, and figures
// only from settings.
import { describe, expect, it, vi } from 'vitest';
import type { Me } from '../platform/api';
import type { ClientConfig } from '../platform/clientConfig';
import { afterOn, allianceDrive, filesOn, guildAppHref, guildsOpen, membershipHref, officerWeekly, setupOn, setupTierOf, whatsNewItems } from './config';

vi.mock('../platform/session', () => ({ useSession: () => null }));
vi.mock('../state/deskStore', () => ({ useDeskStore: () => null }));
const { wantsSetup } = await import('./door');

const HOST = 'office.minimalistalliance.com';
const cfg = (over: Record<string, unknown> = {}): ClientConfig =>
  ({ api: 'https://api.minimalistalliance.com', auth: {}, links: { account: 'https://platform.minimalistalliance.com/account', guildAdmin: 'https://guild.minimalistalliance.com/' }, ...over }) as unknown as ClientConfig;
const me = (membership: Record<string, unknown> | undefined): Me => ({ userId: 'u', email: 'e', displayName: 'D', ...(membership ? { membership } : {}) }) as Me;

describe('the circle’s config', () => {
  it('the tier: free as /v1/me says it, else a live paid tier, else none', () => {
    expect(setupTierOf(me({ tier: 'free', status: 'active' }))).toBe('free');
    expect(setupTierOf(me({ tier: 'lead', status: 'active' }))).toBe('lead');
    expect(setupTierOf(me({ tier: 'member', status: 'active' }))).toBe('officer');
    expect(setupTierOf(me({ tier: 'officer', status: 'signed_up' }))).toBeNull();
    expect(setupTierOf(me(undefined))).toBeNull();
  });
  it('kill switches: absent is on, `false` is off', () => {
    expect(setupOn(cfg())).toBe(true);
    expect(setupOn(cfg({ setupCircle: { enabled: false } }))).toBe(false);
    expect(afterOn(cfg())).toBe(true);
    expect(afterOn(cfg({ whatsNew: { enabled: false } }))).toBe(false);
    expect(guildsOpen(cfg({ guilds: { open: false } }))).toBe(false);
    expect(filesOn(cfg({ files: { enabled: false } }))).toBe(false);
  });
  it('the door opens only for a member with a tier and an own desk, where the circle is on', () => {
    expect(wantsSetup(me({ tier: 'officer', status: 'active' }), cfg(), true)).toBe(true);
    expect(wantsSetup(me({ tier: 'free', status: 'active' }), cfg(), true)).toBe(true);
    expect(wantsSetup(me({ tier: 'officer', status: 'active' }), cfg(), false)).toBe(false);
    expect(wantsSetup(me({ tier: 'officer', status: 'active' }), cfg({ setupCircle: { enabled: false } }), true)).toBe(false);
    expect(wantsSetup(me({ tier: 'officer', status: 'signed_up' }), cfg(), true)).toBe(false);
    expect(wantsSetup(null, cfg(), true)).toBe(false);
  });
  it('links only to our own hosts: the Guild app’s pages and the membership page', () => {
    expect(guildAppHref(cfg(), '/new', HOST)).toBe('https://guild.minimalistalliance.com/new');
    expect(guildAppHref(cfg(), '/gu-abcdefghijkl/invites', HOST)).toBe('https://guild.minimalistalliance.com/gu-abcdefghijkl/invites');
    expect(guildAppHref(cfg({ links: { guildAdmin: 'https://evil.example/' } }), '/new', HOST)).toBeNull();
    expect(membershipHref(cfg(), HOST)).toBe('https://platform.minimalistalliance.com/account');
    expect(membershipHref(cfg({ links: { account: 'https://platform.minimalistalliance.com/account', membership: 'https://platform.minimalistalliance.com/membership' } }), HOST)).toBe('https://platform.minimalistalliance.com/membership');
    expect(membershipHref(cfg({ links: {} }), HOST)).toBeNull();
  });
  it('figures come from settings or not at all', () => {
    expect(allianceDrive(cfg({ tierAllowances: { alliance: { driveGb: 25 } } }))).toBe('25 GB');
    expect(allianceDrive(cfg())).toBeNull();
    expect(allianceDrive(cfg({ tierAllowances: { alliance: { driveGb: -1 } } }))).toBeNull();
    expect(officerWeekly(cfg({ tierAllowances: { officer: { weeklyAllowanceGb: 30 } } }))).toBe('30 GB');
    expect(officerWeekly(cfg())).toBeNull();
  });
  it('What’s new: client-config’s list replaces the repo’s, read item by item', () => {
    expect(whatsNewItems(cfg(), HOST)).toEqual([]);
    const items = whatsNewItems(
      cfg({
        whatsNew: {
          items: [
            { id: 'a', title: 'T', line: 'L', action: { href: 'https://platform.minimalistalliance.com/news' }, from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' },
            { id: 'b', title: 'T', line: 'L', action: { href: 'https://evil.example/' }, from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' },
          ],
        },
      }),
      HOST,
    );
    expect(items.map((i) => i.id)).toEqual(['a']);
  });
});
