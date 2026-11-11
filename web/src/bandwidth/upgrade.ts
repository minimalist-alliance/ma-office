// What an {alliance} adult may read about the next tier when a limit is felt (the Designer's free-tier README, "Alliance
// Members moving up", A2 and A3). Pure. The tier's name is the owner's setting (`tierNames`) and Officer's weekly allowance
// is a setting too (client-config `tierAllowances.officer.weeklyAllowanceGb`, proposed, from `pricing#current`): neither
// is typed here. With no allowance on the wire the sentence says "more each week" and promises no number.
// Adults only: Officer is 18 and up, so a teen, and anyone whose band isn't known to be adult, reads nothing new.
import { accountUrl, type ClientConfig } from '../platform/clientConfig';
import type { AgeBand } from '../platform/age';
import { tierNamesFrom } from '../platform/tiers';
import { formatGb, type BandwidthMeter } from './meter';

export interface OfficerOffer {
  /** The panel's sentence: "Officer has 30 GB a week." or "Officer has more each week." */
  sentence: string;
  /** The pause's link text, without the full stop: "Officer has 30 GB a week". */
  link: string;
  /** The Platform app's membership page, or null when client-config has no good one (then no link is shown). */
  href: string | null;
}

/** Officer's weekly allowance in GB, from settings, or null when Platform doesn't say (or says nonsense). */
export function officerWeeklyGb(cfg: ClientConfig | null | undefined): number | null {
  const v = (cfg as { tierAllowances?: { officer?: { weeklyAllowanceGb?: unknown } } } | null | undefined)?.tierAllowances?.officer?.weeklyAllowanceGb;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100_000 ? v : null;
}

/** The offer for this member, or null: only an {alliance} adult, and only once client-config has loaded. */
export function officerOffer(meter: BandwidthMeter | null, band: AgeBand, cfg: ClientConfig | null | undefined, hostname?: string): OfficerOffer | null {
  if (!meter || meter.tier !== 'alliance' || band !== 'adult' || !cfg) return null;
  const name = tierNamesFrom(cfg.tierNames).officer;
  const weekly = officerWeeklyGb(cfg);
  const link = weekly === null ? `${name} has more each week` : `${name} has ${formatGb(weekly)} a week`;
  return { sentence: `${link}.`, link, href: hostname === undefined ? accountUrl(cfg) : accountUrl(cfg, hostname) };
}
