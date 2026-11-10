// The tiers' ids, their names from the owner's setting, and the old ids from before the migration (contract tiers.md).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIER_NAMES, liveTier, membershipLive, namesList, readBadge, readTier, tierNamesFrom, tierRenames } from './tiers';

const RENAMED = { alliance: 'Cadet', officer: 'Captain', lead: 'Pathfinder' };

describe('tierNamesFrom', () => {
  it('is the contract defaults with no setting, as in prod until it ships', () => {
    expect(DEFAULT_TIER_NAMES).toEqual({ alliance: 'Alliance Member', officer: 'Officer', lead: 'Founder' });
    for (const raw of [undefined, null, {}, 'Officer', 42, []]) expect(tierNamesFrom(raw)).toEqual(DEFAULT_TIER_NAMES);
  });

  it('takes every name the owner set, trimmed', () => {
    expect(tierNamesFrom(RENAMED)).toEqual(RENAMED);
    expect(tierNamesFrom({ alliance: '  Cadet ', officer: 'Captain', lead: 'Pathfinder' }).alliance).toBe('Cadet');
    expect(tierNamesFrom({ alliance: 'Ünïcödé Členka', officer: 'O&M', lead: "Lead's" })).toEqual({ alliance: 'Ünïcödé Členka', officer: 'O&M', lead: "Lead's" });
  });

  it('keeps the default for one name it can not use, and the others as set', () => {
    expect(tierNamesFrom({ officer: 'Captain' })).toEqual({ ...DEFAULT_TIER_NAMES, officer: 'Captain' });
    for (const bad of ['', '   ', 7, null, 'x'.repeat(25), `Cap${String.fromCharCode(10)}tain`]) {
      expect(tierNamesFrom({ ...RENAMED, lead: bad }).lead).toBe('Founder');
      expect(tierNamesFrom({ ...RENAMED, lead: bad }).officer).toBe('Captain');
    }
    expect(tierNamesFrom({ ...RENAMED, lead: 'x'.repeat(24) }).lead).toBe('x'.repeat(24));
  });
});

describe('readTier, before and after the migration ("Until the migration has run")', () => {
  it('reads the old `member`, or no tier at all, as officer', () => {
    expect(readTier('member')).toBe('officer');
    expect(readTier(undefined)).toBe('officer');
    expect(readTier(null)).toBe('officer');
  });
  it('reads the new ids as themselves, `officer` included, which no row holds in its old sense', () => {
    expect(readTier('alliance')).toBe('alliance');
    expect(readTier('officer')).toBe('officer');
    expect(readTier('lead')).toBe('lead');
  });
  it('says nothing for a tier it does not know, rather than something wrong', () => {
    for (const raw of ['pro', 'master', 'founder', 'Officer', '', 3, {}]) expect(readTier(raw)).toBeNull();
  });
  it('names each tier, old ids included, from the setting', () => {
    const names = tierNamesFrom(RENAMED);
    expect(['member', 'officer', 'lead', 'alliance'].map((t) => names[readTier(t)!])).toEqual(['Captain', 'Captain', 'Pathfinder', 'Cadet']);
  });
});

describe('readBadge', () => {
  it('is Platform’s badge or none: a missing field, as before it ships, is no badge', () => {
    expect(readBadge('officer')).toBe('officer');
    expect(readBadge('lead')).toBe('lead');
    for (const raw of [undefined, null, 'alliance', 'member', 'Officer', 1]) expect(readBadge(raw)).toBeNull();
  });
});

describe('liveTier', () => {
  it('is the tier only while the membership is live: active, past due, canceling or comped', () => {
    expect(liveTier({ status: 'active', tier: 'member' })).toBe('officer');
    expect(liveTier({ status: 'past_due', tier: 'lead' })).toBe('lead');
    expect(liveTier({ status: 'canceling', tier: 'alliance' })).toBe('alliance');
    expect(liveTier({ status: 'ended', tier: 'lead', comped: true })).toBe('lead');
    // An unpaid sign-up also reads as officer, so it holds nothing yet.
    for (const status of ['unpaid', 'waitlisted', 'ended', 'suspended', 'closed', undefined]) expect(liveTier({ status, tier: 'officer' })).toBeNull();
    expect(liveTier(null)).toBeNull();
    expect(membershipLive(undefined)).toBe(false);
  });
});

describe('who renames, and names in a sentence', () => {
  it('renaming comes with officer and lead, never alliance', () => {
    expect(tierRenames('officer')).toBe(true);
    expect(tierRenames('lead')).toBe(true);
    expect(tierRenames('alliance')).toBe(false);
    expect(tierRenames(null)).toBe(false);
  });
  it('joins names in the contract order, falling back to the given ids', () => {
    const names = tierNamesFrom(RENAMED);
    expect(namesList(['lead', 'officer'], names, [])).toBe('Captain or Pathfinder');
    expect(namesList(['lead'], names, [])).toBe('Pathfinder');
    expect(namesList(['bogus'], names, ['officer', 'lead'])).toBe('Captain or Pathfinder');
    expect(namesList(['alliance', 'officer', 'lead'], names, [], 'and')).toBe('Cadet, Captain and Pathfinder');
  });
});

// A tier's name comes only from the setting: no string the app shows may hard-code one, and "Pro" is gone.
describe('no tier name is hard-coded', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(join('platform', 'tiers.ts')));
  // Comments may name a tier to explain the code; strings and markup may not.
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('finds what it checks', () => {
    expect(files.some((f) => f.endsWith('AccountMenu.tsx'))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });
  it('holds no Alliance Member, Officer, Founder, Pro or Pro Member outside the defaults', () => {
    const found = files.flatMap((f) =>
      code(readFileSync(f, 'utf8'))
        .split('\n')
        .filter((line) => /Alliance Member|\bOfficer\b|\bFounder\b|\bPro\b|Pro Member/.test(line))
        .map((line) => `${f.slice(SRC.length)}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });
});
