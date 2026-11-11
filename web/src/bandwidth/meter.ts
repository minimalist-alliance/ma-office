// The bandwidth meter's words and numbers (ma-platform ADR 0095, contract bandwidth.md). Pure but for the age band's one line, so every state has a test.
// Platform counts and decides. This only shows what it said: the real number, the limit, and when the week resets.
import { mayHaveApp } from '../platform/age';
import { readTier, type TierId } from '../platform/tiers';

export interface MeterWindow {
  usedBytes: number;
  usedGb: number;
  limitGb: number;
  startsAt: string;
  resetsAt: string;
}

/** The data guard has stopped the member's desks (contract bandwidth.md 0.3.44, ma-platform ADR 0110). Never present for the owner's account. */
export interface DataGuardState {
  /** The platform's words, shown as given. */
  message: string;
  since: string | null;
  /** The member's next billing day. */
  resumesAt: string | null;
}

/** `GET /v1/desks/bandwidth`. Unknown fields and values are safe. */
export interface BandwidthMeter {
  /** The tier's id (contract tiers.md): `member` from before the migration reads as `officer`. Never shown. */
  tier: TierId | null;
  week: MeterWindow;
  month: MeterWindow;
  state: 'ok' | 'warn' | 'limit';
  limitedBy: 'week' | 'month' | null;
  warnAtPct: number;
  enforced: boolean;
  paused: boolean;
  resumesAt: string | null;
  asOf: string | null;
  pollAfterSeconds: number;
  /** Null, or present while the data guard holds the member's desks. */
  dataGuard: DataGuardState | null;
  /** A free member's Browser time today, as it came: only the free tier's chunk reads it (`free/wire.ts`). */
  browserTime?: unknown;
}

const GB = 1e9;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const time = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function windowOf(v: unknown): MeterWindow | null {
  const w = (v ?? {}) as Partial<Record<keyof MeterWindow, unknown>>;
  if (!num(w.usedBytes) || !num(w.limitGb) || !time(w.startsAt) || !time(w.resetsAt)) return null;
  return { usedBytes: w.usedBytes, usedGb: num(w.usedGb) ? w.usedGb : w.usedBytes / GB, limitGb: w.limitGb, startsAt: w.startsAt, resetsAt: w.resetsAt };
}

function guardOf(v: unknown): DataGuardState | null {
  if (!v || typeof v !== 'object') return null;
  const g = v as Partial<Record<keyof DataGuardState, unknown>>;
  if (typeof g.message !== 'string' || !g.message.trim()) return null;
  return { message: g.message, since: time(g.since) ? g.since : null, resumesAt: time(g.resumesAt) ? g.resumesAt : null };
}

/** Null for anything that isn't a meter, so a surprise shows nothing rather than a wrong number. */
export function parseMeter(raw: unknown): BandwidthMeter | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Record<keyof BandwidthMeter, unknown>>;
  const week = windowOf(r.week);
  const month = windowOf(r.month);
  if (!week || !month) return null;
  // An unknown state is read from the numbers, so it can't hide a limit.
  const share = Math.max(shareOf(week), shareOf(month));
  const warnAtPct = num(r.warnAtPct) && r.warnAtPct > 0 ? r.warnAtPct : 80;
  const state = r.state === 'ok' || r.state === 'warn' || r.state === 'limit' ? r.state : share >= 1 ? 'limit' : share * 100 >= warnAtPct ? 'warn' : 'ok';
  const paused = r.paused === true;
  return {
    tier: readTier(r.tier),
    week,
    month,
    state,
    limitedBy: r.limitedBy === 'week' || r.limitedBy === 'month' ? r.limitedBy : null,
    warnAtPct,
    enforced: r.enforced === true,
    paused,
    resumesAt: time(r.resumesAt) ? r.resumesAt : null,
    asOf: time(r.asOf) ? r.asOf : null,
    pollAfterSeconds: num(r.pollAfterSeconds) && r.pollAfterSeconds >= 1 ? Math.min(r.pollAfterSeconds, 600) : 60,
    dataGuard: guardOf(r.dataGuard),
    browserTime: r.browserTime,
  };
}

export function shareOf(w: MeterWindow): number {
  if (w.limitGb <= 0) return w.usedBytes > 0 ? Infinity : 0;
  return w.usedBytes / (w.limitGb * GB);
}

/** The window nearer its limit: what the ring shows. The week, unless the month is closer. */
export function ringWindow(m: BandwidthMeter): 'week' | 'month' {
  if (m.state === 'limit' && m.limitedBy) return m.limitedBy;
  return shareOf(m.month) > shareOf(m.week) ? 'month' : 'week';
}

/** How full the ring is, 0 to 1. */
export function ringShare(m: BandwidthMeter): number {
  const s = shareOf(m[ringWindow(m)]);
  return Math.min(1, Math.max(0, Number.isFinite(s) ? s : 1));
}

/** The real number: MB under 1 GB, one decimal under 100 GB, whole GB above. */
export function formatBytes(bytes: number): string {
  if (bytes < GB) {
    const mb = bytes / 1e6;
    return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
  }
  const gb = bytes / GB;
  return `${gb < 100 ? Math.floor(gb * 10) / 10 : Math.floor(gb)} GB`;
}

export function formatGb(gb: number): string {
  return gb < 1 ? `${Math.round(gb * 1000)} MB` : `${Math.round(gb * 10) / 10} GB`;
}

export interface Clock {
  now: number;
  /** For tests; the member's own by default. */
  locale?: string;
  timeZone?: string;
}

/**
 * When something resets, in the member's own time: "Mon 5:00 PM" within the coming week, "Dec 1" further out, plus the
 * time when it isn't midnight there.
 */
export function formatReset(iso: string, c: Clock): string {
  const at = Date.parse(iso);
  const opts = c.timeZone ? { timeZone: c.timeZone } : {};
  const soon = at - c.now < 6.5 * 86_400_000;
  const dateText = new Intl.DateTimeFormat(c.locale, soon ? { weekday: 'short', ...opts } : { month: 'short', day: 'numeric', ...opts }).format(at);
  const timeText = new Intl.DateTimeFormat(c.locale, { hour: 'numeric', minute: '2-digit', ...opts }).format(at);
  const midnight = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts }).format(at) === '00:00';
  return soon || !midnight ? `${dateText} ${timeText}` : dateText;
}

const windowWord = (w: 'week' | 'month'): string => (w === 'week' ? 'this week' : 'this month');

/** The circle's accessible name, which carries the numbers, so a screen reader hears them without opening it. */
export function circleLabel(m: BandwidthMeter, c: Clock): string {
  const w = ringWindow(m);
  const win = m[w];
  const used = `Bandwidth: ${formatBytes(win.usedBytes)} of ${formatGb(win.limitGb)} used ${windowWord(w)}`;
  if (m.dataGuard) return `${used}. Desks stopped: data use past your plan.`;
  if (m.paused && m.resumesAt) return `${used}. Browser paused until ${formatReset(m.resumesAt, c)}.`;
  if (m.state === 'limit') return `${used}. Limit reached.`;
  return `${used}. Resets ${formatReset(win.resetsAt, c)}.`;
}

/**
 * What goes on when the Browser pauses: only apps the member has and can use. Chat isn't built, so it's never named, and a
 * teen has no Agent, so it isn't named for them.
 */
export const keepsWorking = (): string => (mayHaveApp('agent') ? 'Notebook and Agent keep working' : 'Notebook keeps working');

/** The one line under the numbers in the panel, or null when there's nothing to say. */
export function stateLine(m: BandwidthMeter, c: Clock): string | null {
  const w = ringWindow(m);
  if (m.paused && m.resumesAt) {
    return `The Browser is paused until ${formatReset(m.resumesAt, c)}. ${keepsWorking()}.`;
  }
  if (m.state === 'limit') return `You're past ${windowWord(w)}'s limit.`;
  if (m.state === 'warn') {
    const pct = Math.floor(shareOf(m[w]) * 100);
    return m.enforced
      ? `You've used ${pct}% of ${windowWord(w)}'s bandwidth. At the limit, the Browser pauses until the ${w} resets. ${keepsWorking()}.`
      : `You've used ${pct}% of ${windowWord(w)}'s bandwidth.`;
  }
  return null;
}

/** The gentle heads-up, once per week per browser: at the warning line, and again if the Browser pauses. */
export function headsUp(m: BandwidthMeter, c: Clock): { key: string; text: string } | null {
  if (m.dataGuard) return { key: `guard:${m.dataGuard.since ?? m.dataGuard.resumesAt ?? 'now'}`, text: m.dataGuard.message };
  if (m.paused && m.resumesAt) {
    return { key: `paused:${m.resumesAt}`, text: `Bandwidth limit reached. The Browser is paused until ${formatReset(m.resumesAt, c)}. ${keepsWorking()}.` };
  }
  if (m.state === 'warn' || m.state === 'limit') {
    const w = ringWindow(m);
    return { key: `warn:${m[w].startsAt}`, text: `You've used ${Math.min(100, Math.floor(shareOf(m[w]) * 100))}% of ${windowWord(w)}'s bandwidth: ${formatBytes(m[w].usedBytes)} of ${formatGb(m[w].limitGb)}.` };
  }
  return null;
}

/**
 * What a paused Browser or streamed app says instead of its picture. `resumesAt` is the desk's own time when a desk
 * refused (`bandwidth_limit`), and the meter's otherwise. The numbers are said only while the meter is at its limit too.
 */
export function pausedCopy(m: BandwidthMeter | null, appName: string, c: Clock, resumesAt: string | null = m?.resumesAt ?? null): { title: string; body: string } {
  // With no time, it still says when: the pause lifts when the member's bandwidth resets.
  const title = `${appName} is paused until ${resumesAt ? formatReset(resumesAt, c) : 'your bandwidth resets'}`;
  const safe = `${keepsWorking()}, and your tabs are safe.`;
  if (!m || m.state !== 'limit') return { title, body: `You've reached your bandwidth limit. ${safe}` };
  const w = m.limitedBy ?? ringWindow(m);
  return { title, body: `You've used ${windowWord(w)}'s ${formatGb(m[w].limitGb)} of bandwidth. ${safe}` };
}
