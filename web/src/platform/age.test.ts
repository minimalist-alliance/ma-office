import { afterEach, describe, expect, it } from 'vitest';
import type { Me } from './api';
import { adultOnly, ageBandOf, ageRulesOn, awaitingParent, mayHaveApp, setCurrentBand } from './age';
import { reportUrl, type ClientConfig } from './clientConfig';

const me = (membership: NonNullable<Me['membership']>): Me => ({ userId: 'u', membership });

afterEach(() => setCurrentBand(null));

describe('ageBandOf', () => {
  it('no band at all, as every member has until the Alliance tier opens', () => {
    expect(ageBandOf(null)).toBeNull();
    expect(ageBandOf({ userId: 'u' })).toBeNull();
    expect(ageBandOf(me({ status: 'active', tier: 'member' }))).toBeNull();
    expect(ageBandOf(me({ ageBand: null }))).toBeNull();
  });

  it('says what the server says', () => {
    expect(ageBandOf(me({ ageBand: 'teen' }))).toBe('teen');
    expect(ageBandOf(me({ ageBand: 'adult' }))).toBe('adult');
  });

  it('reads a value it does not know the careful way', () => {
    expect(ageBandOf(me({ ageBand: 'minor' }))).toBe('teen');
    expect(ageBandOf(me({ ageBand: '' }))).toBe('teen');
  });

  it('never works it out from adultFrom', () => {
    expect(ageBandOf(me({ ageBand: 'teen', adultFrom: '2001-01-01' }))).toBe('teen');
    expect(ageBandOf(me({ ageBand: 'adult', adultFrom: '2999-01-01' }))).toBe('adult');
    expect(ageBandOf(me({ adultFrom: '2999-01-01' }))).toBeNull();
  });
});

describe('awaitingParent', () => {
  it('is a teen with parent pending, and nobody else', () => {
    expect(awaitingParent(me({ ageBand: 'teen', parent: 'pending' }))).toBe(true);
    expect(awaitingParent(me({ ageBand: 'teen', parent: 'done' }))).toBe(false);
    expect(awaitingParent(me({ ageBand: 'teen', parent: null }))).toBe(false);
    expect(awaitingParent(me({ ageBand: 'teen' }))).toBe(false);
    expect(awaitingParent(me({ ageBand: 'adult', parent: 'pending' }))).toBe(false);
    expect(awaitingParent(me({ parent: 'pending' }))).toBe(false);
    expect(awaitingParent(null)).toBe(false);
  });
});

describe('the apps a member can have', () => {
  it('the Agent and any Claude app are adults only, and nothing else', () => {
    expect(['agent', 'claude'].every(adultOnly)).toBe(true);
    expect(['browser', 'notebook', 'chat'].some(adultOnly)).toBe(false);
  });

  it('only a teen goes without', () => {
    for (const band of [null, 'adult'] as const) {
      setCurrentBand(band);
      expect(mayHaveApp('agent')).toBe(true);
    }
    setCurrentBand('teen');
    expect(mayHaveApp('agent')).toBe(false);
    expect(mayHaveApp('claude')).toBe(false);
    expect(mayHaveApp('browser')).toBe(true);
    expect(mayHaveApp('notebook')).toBe(true);
    expect(mayHaveApp('chat')).toBe(true);
  });
});

describe('the age rules in client-config', () => {
  const base = { api: 'x', auth: {} } as unknown as ClientConfig;
  const account = 'https://platform.minimalistalliance.com/account';
  const on = { ...base, ageRules: { enabled: true, minimumAge: 13, adultAge: 18 }, links: { account } };

  it('are on only when they say so', () => {
    expect(ageRulesOn(null)).toBe(false);
    expect(ageRulesOn(base)).toBe(false);
    expect(ageRulesOn({ ...base, ageRules: { enabled: false } })).toBe(false);
    expect(ageRulesOn({ ...base, ageRules: {} })).toBe(false);
    expect(ageRulesOn(on)).toBe(true);
  });

  it('the report page is beside the account page, on the Platform app, and only with the rules on', () => {
    const host = 'office.minimalistalliance.com';
    expect(reportUrl(on, host)).toBe('https://platform.minimalistalliance.com/report');
    expect(reportUrl({ ...on, ageRules: { enabled: false } }, host)).toBeNull();
    expect(reportUrl({ ...base, links: { account } }, host)).toBeNull();
  });

  it('no report row from a link that is not a sibling of this site', () => {
    const host = 'office.minimalistalliance.com';
    expect(reportUrl({ ...on, links: {} }, host)).toBeNull();
    expect(reportUrl({ ...on, links: { account: 'https://evil.example/account' } }, host)).toBeNull();
    expect(reportUrl({ ...on, links: { account: 'http://platform.minimalistalliance.com/account' } }, host)).toBeNull();
    expect(reportUrl({ ...on, links: { account: 'https://office.minimalistalliance.com/account' } }, host)).toBeNull();
  });

  it('follows the site it runs on', () => {
    expect(reportUrl({ ...on, links: { account: 'https://platform.staging.minimalistalliance.com/account' } }, 'office.staging.minimalistalliance.com')).toBe('https://platform.staging.minimalistalliance.com/report');
  });
});
