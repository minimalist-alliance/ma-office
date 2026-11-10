import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, guildIdOfPanel, guildPanelId, guildVm, isGuildPanel, limitProblem, limitsPatch, mayManageAgents, maySeeUsage, myGuilds, runs, share, usd, zoneName } from './panel';
import type { GuildMine } from './api';

const g = (guildId: string, over: Partial<GuildMine> = {}): GuildMine => ({ guildId, name: `Guild ${guildId}`, role: 'member', ...over });

describe('a guild’s panel id', () => {
  it('is the office’s own, and reads back to the guild', () => {
    expect(guildPanelId('gu-abc')).toBe('guild-gu-abc');
    expect(guildIdOfPanel('guild-gu-abc')).toBe('gu-abc');
    expect(isGuildPanel('guild-gu-abc')).toBe(true);
  });
  it('is never a member’s own desk', () => {
    expect(isGuildPanel('d-testk3m7q2x')).toBe(false);
    expect(isGuildPanel('guild-')).toBe(false);
    expect(guildIdOfPanel('d-guild')).toBeNull();
  });
});

describe('myGuilds', () => {
  it('keeps at most three, in identity’s order', () => {
    expect(myGuilds([g('a'), g('b'), g('c'), g('d')]).map((x) => x.guildId)).toEqual(['a', 'b', 'c']);
  });
  it('drops what today’s list shows but the member hasn’t joined, and anything malformed', () => {
    const list = [g('a', { joined: false }), g('b', { role: null as unknown as 'member' }), { guildId: 'c' } as GuildMine, g('d', { role: 'officer' }), null as unknown as GuildMine];
    expect(myGuilds(list).map((x) => x.guildId)).toEqual(['d']);
  });
  it('reads nothing from nothing', () => {
    expect(myGuilds(undefined)).toEqual([]);
    expect(myGuilds({} as unknown as GuildMine[])).toEqual([]);
  });
});

describe('guildVm', () => {
  it.each([
    ['none', 'stopped'],
    ['stopped', 'stopped'],
    ['provisioning', 'starting'],
    ['starting', 'starting'],
    ['running', 'running'],
    ['stopping', 'stopping'],
    ['something new', 'starting'],
    [undefined, 'unknown'],
  ])('%s is %s', (state, vm) => expect(guildVm(state)).toBe(vm));
});

describe('who sees what', () => {
  it('limits: the Founder, or an Officer with manage_agents', () => {
    expect(mayManageAgents('lead', [])).toBe(true);
    expect(mayManageAgents('officer', ['moderate', 'manage_agents'])).toBe(true);
    expect(mayManageAgents('officer', ['moderate'])).toBe(false);
    expect(mayManageAgents('member', ['manage_agents'])).toBe(false);
    expect(mayManageAgents(null, null)).toBe(false);
  });
  it('usage: the Founder and every Officer', () => {
    expect(maySeeUsage('lead')).toBe(true);
    expect(maySeeUsage('officer')).toBe(true);
    expect(maySeeUsage('member')).toBe(false);
    expect(maySeeUsage(undefined)).toBe(false);
  });
});

describe('limitProblem', () => {
  it('takes whole runs and dollars to the cent', () => {
    expect(limitProblem('20', 'count', 1000)).toBeNull();
    expect(limitProblem('2.50', 'usd', 1000)).toBeNull();
    expect(limitProblem(' 0 ', 'usd', 1000)).toBeNull();
  });
  it('says what’s wrong, plainly', () => {
    expect(limitProblem('', 'usd', 10)).toBe('Enter a number.');
    expect(limitProblem('1.5', 'count', 10)).toBe('Use a whole number.');
    expect(limitProblem('2.505', 'usd', 10)).toBe('Use dollars and cents, like 2.50.');
    expect(limitProblem('-1', 'usd', 10)).toBe('Use dollars and cents, like 2.50.');
    expect(limitProblem('11', 'usd', 10)).toBe('At most $10.');
    expect(limitProblem('9', 'count', 8)).toBe('At most 8.');
    expect(limitProblem('0', 'count', 8)).toBe('At least 1.');
  });
});

describe('limitsPatch', () => {
  it('sends only what changed', () => {
    const now = { ...DEFAULT_LIMITS, perMember: { ...DEFAULT_LIMITS.perMember, usdPerDay: 2 }, tools: { ...DEFAULT_LIMITS.tools, post: false }, ownKeys: true };
    expect(limitsPatch(DEFAULT_LIMITS, now)).toEqual({ perMember: { usdPerDay: 2 }, tools: { post: false }, ownKeys: true });
  });
  it('is null when nothing did', () => {
    expect(limitsPatch(DEFAULT_LIMITS, structuredClone(DEFAULT_LIMITS))).toBeNull();
  });
});

describe('words for money and runs', () => {
  it('usd', () => {
    expect(usd(12)).toBe('$12');
    expect(usd(1.2)).toBe('$1.20');
    expect(usd(0.044)).toBe('$0.04');
    expect(usd(0)).toBe('$0');
    expect(usd(Number.NaN)).toBe('$0');
  });
  it('runs', () => {
    expect(runs(1)).toBe('1 run');
    expect(runs(0)).toBe('0 runs');
    expect(runs(52)).toBe('52 runs');
  });
  it('share', () => {
    expect(share(5, 10)).toBe(0.5);
    expect(share(15, 10)).toBe(1);
    expect(share(5, 0)).toBe(0);
  });
});

describe('the usage note’s time zone', () => {
  it('is the name people use, not the zone’s id', () => {
    expect(zoneName('America/Denver')).toBe('Mountain Time');
    expect(zoneName('UTC')).toBe('UTC');
    expect(zoneName('Etc/UTC')).toBe('UTC');
  });
  it('falls back to the id for a zone the browser doesn’t know', () => {
    expect(zoneName('Nowhere/Atlantis')).toBe('Nowhere/Atlantis');
  });
});
