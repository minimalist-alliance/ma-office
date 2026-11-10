import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserZoneQuery } from './store';

describe('the ask carries this browser\'s zone (TD-226)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('as an encoded IANA name', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((function () { return { resolvedOptions: () => ({ timeZone: 'America/Los_Angeles' }) }; }) as never);
    expect(browserZoneQuery()).toBe('?tz=America%2FLos_Angeles');
  });

  it('as nothing when the browser has none or throws', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((function () { return { resolvedOptions: () => ({ timeZone: '' }) }; }) as never);
    expect(browserZoneQuery()).toBe('');
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((() => {
      throw new Error('no');
    }) as never);
    expect(browserZoneQuery()).toBe('');
  });
});
