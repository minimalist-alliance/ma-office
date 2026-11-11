import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../platform/clientConfig';
import { parseMeter } from './meter';
import { officerOffer, officerWeeklyGb } from './upgrade';

const win = { usedBytes: 1e9, limitGb: 3, startsAt: '2026-11-09T00:00:00Z', resetsAt: '2026-11-16T00:00:00Z' };
const meter = (tier: string) => parseMeter({ tier, week: win, month: { ...win, limitGb: 10 }, state: 'ok' });
const cfg = (extra: Record<string, unknown> = {}): ClientConfig => ({ api: 'https://api.minimalistalliance.com', auth: {} as never, links: { account: 'https://platform.minimalistalliance.com/account' }, ...extra });
const HOST = 'office.minimalistalliance.com';

describe('officerOffer', () => {
  it('names the tier from settings and the weekly allowance from settings', () => {
    const o = officerOffer(meter('alliance'), 'adult', cfg({ tierNames: { officer: 'Steward' }, tierAllowances: { officer: { weeklyAllowanceGb: 30 } } }), HOST);
    expect(o).toEqual({ sentence: 'Steward has 30 GB a week.', link: 'Steward has 30 GB a week', href: 'https://platform.minimalistalliance.com/account' });
  });
  it('promises no number when settings give none', () => {
    expect(officerOffer(meter('alliance'), 'adult', cfg(), HOST)?.sentence).toBe('Officer has more each week.');
    expect(officerOffer(meter('alliance'), 'adult', cfg({ tierAllowances: { officer: { weeklyAllowanceGb: -3 } } }), HOST)?.sentence).toBe('Officer has more each week.');
  });
  it('has no link when client-config has no membership page', () => {
    expect(officerOffer(meter('alliance'), 'adult', cfg({ links: {} }), HOST)?.href).toBeNull();
  });
  it('is for an alliance adult only', () => {
    expect(officerOffer(meter('alliance'), 'teen', cfg(), HOST)).toBeNull();
    expect(officerOffer(meter('alliance'), null, cfg(), HOST)).toBeNull();
    expect(officerOffer(meter('officer'), 'adult', cfg(), HOST)).toBeNull();
    expect(officerOffer(meter('lead'), 'adult', cfg(), HOST)).toBeNull();
    expect(officerOffer(null, 'adult', cfg(), HOST)).toBeNull();
    expect(officerOffer(meter('alliance'), 'adult', null, HOST)).toBeNull();
  });
  it('reads the allowance leniently', () => {
    expect(officerWeeklyGb(cfg({ tierAllowances: { officer: { weeklyAllowanceGb: '30' } } }))).toBeNull();
    expect(officerWeeklyGb(cfg({ tierAllowances: { officer: { weeklyAllowanceGb: 30 } } }))).toBe(30);
  });
});
