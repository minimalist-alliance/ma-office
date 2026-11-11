// Every wire read the free tier makes, in one place (S-119). Platform owns the contract and hasn't written it yet (it
// starts after task 46's core), so each shape below is this app's provisional one, built to extend the contracts that
// exist: `/v1/me`'s `membership.tier` (tiers.md, maia.md), client-config's `tierNames` and `links` (tiers.md section 3),
// `GET /v1/desks/bandwidth` (bandwidth.md), `GET /v1/maia/state`'s `trial` (maia.md, already in the contract) and deskd's
// topics and refusals (`services/deskd/docs/API.md` sections 5 and 10). STATUS.md proposes them ("For Platform", "For the
// Desk Engineer", "For the AI Engineer"). When the contract lands, only this file changes. Pure but for the stand-ins.
import type { Me } from '../platform/api';
import { accountUrl, type ClientConfig } from '../platform/clientConfig';
import { siblingUrl } from '../platform/hosts';
import { usable } from '../platform/tiers';

/** `membership.tier: "free"`, whatever the status says (contract maia.md, "The free tier's trial"). */
export const isFree = (me: Me | null | undefined): boolean => me?.membership?.tier === 'free';

/** The tier a member upgraded to, as `/v1/me` says it: any tier but free, or none for an unknown one. */
export function paidTier(me: Me | null | undefined): 'alliance' | 'officer' | 'lead' | null {
  const t: unknown = me?.membership?.tier;
  if (t === 'alliance' || t === 'officer' || t === 'lead') return t;
  // Before the migration, `member` or none is `officer` (tiers.md, "Until the migration has run").
  return t === undefined || t === null || t === 'member' ? 'officer' : null;
}

/**
 * The free tier's name: `tierNames.free`, the owner's setting, read as every name is (tiers.md section 2), with the
 * Designer's default where it's missing ("Free", the draft's question 2). Sentences put it on its own, with no article.
 */
export const DEFAULT_FREE_NAME = 'Free';
export const freeName = (cfg: ClientConfig | null | undefined): string => usable((cfg?.tierNames as Record<string, unknown> | undefined)?.['free']) ?? DEFAULT_FREE_NAME;

/**
 * Where "See membership" goes: `links.membership` once Platform sends one, else the account page (`links.account`), as
 * Account settings does. Only an `https` URL on a sibling host counts, never this app's own (`siblingUrl`).
 */
export function membershipUrl(cfg: ClientConfig | null | undefined, hostname: string = window.location.hostname): string | null {
  if (!cfg) return null;
  return siblingUrl(cfg.links?.['membership'], hostname)?.href ?? accountUrl(cfg, hostname);
}

/**
 * The Alliance tier's drive, from settings (proposed: client-config `tierAllowances.alliance.driveGb`), as "25 GB", or
 * null while Platform sends none. Never a figure of this app's own.
 */
export function allianceDrive(cfg: ClientConfig | null | undefined): string | null {
  const gb = (cfg as { tierAllowances?: { alliance?: { driveGb?: unknown } } } | null | undefined)?.tierAllowances?.alliance?.driveGb;
  return typeof gb === 'number' && Number.isFinite(gb) && gb > 0 && gb < 100_000 ? `${Math.round(gb * 10) / 10} GB` : null;
}

/** Today's Browser time, from the meter's `browserTime` (proposed, bandwidth.md). Seconds; the day is the member's own. */
export interface BrowserTime {
  usedSeconds: number;
  limitSeconds: number;
  startsAt: string;
  resetsAt: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const time = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** Null for anything that isn't today's Browser time, so a surprise shows nothing rather than a wrong number. */
export function readBrowserTime(raw: unknown): BrowserTime | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { usedSeconds, limitSeconds, startsAt, resetsAt } = r;
  if (!num(usedSeconds) || !num(limitSeconds) || limitSeconds <= 0 || !time(startsAt) || !time(resetsAt)) return null;
  if (Date.parse(resetsAt) <= Date.parse(startsAt)) return null;
  return { usedSeconds: Math.min(usedSeconds, limitSeconds), limitSeconds, startsAt, resetsAt };
}

/** The day's Browser time is used up, until its reset. */
export const usedUp = (t: BrowserTime | null, now = Date.now()): boolean => !!t && t.usedSeconds >= t.limitSeconds && Date.parse(t.resetsAt) > now;

/** Seconds left today. */
export const secondsLeft = (t: BrowserTime): number => Math.max(0, t.limitSeconds - t.usedSeconds);

/** Maia's trial (contract maia.md, "The free tier's trial"): `GET /v1/maia/state`'s `trial`, only in a free member's state. */
export interface Trial {
  status: 'unused' | 'active' | 'ended' | 'off';
  /** When an active trial ends (`trial.endsAt`), or null where the state doesn't say. */
  endsAt: string | null;
}

export function readTrial(raw: unknown): Trial | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = r['status'];
  const ends = r['endsAt'];
  const endsAt = typeof ends === 'string' && !Number.isNaN(Date.parse(ends)) ? ends : null;
  return s === 'unused' || s === 'active' || s === 'ended' || s === 'off' ? { status: s, endsAt } : null;
}

/**
 * A desk's own word that its container is being held back (proposed: deskd topic `desk.contention`, from the container's
 * cgroup `cpu.stat`). Never guessed here: no topic, a refusal, or anything odd is "not held".
 */
export const CONTENTION_TOPIC = 'desk.contention' as const;
export const readHeld = (msg: unknown): boolean => !!msg && typeof msg === 'object' && (msg as Record<string, unknown>)['held'] === true;

/**
 * `npm run dev`'s stand-in for the meter's `browserTime` (no network there): `?browserUsed=` and `?browserLimit=` in
 * minutes, 19 of 45 by default, today to the next local midnight. Only in dev; production has none of this.
 */
export function devBrowserTime(now = Date.now()): BrowserTime | null {
  if (!import.meta.env.DEV) return null;
  const q = new URLSearchParams(window.location.search);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return readBrowserTime({
    usedSeconds: Number(q.get('browserUsed') ?? 19) * 60,
    limitSeconds: Number(q.get('browserLimit') ?? 45) * 60,
    startsAt: start.toISOString(),
    resetsAt: end.toISOString(),
  });
}
