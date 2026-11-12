// The connect-time round trip (ma-platform ADR 0112 P4, contract desks.md "Connect-time round trip", 0.3.69 draft): how
// far a member's desk is, by network time, so the Platform can tell whether a region in the middle of the country would
// help. Once per session to the member's own desk (never a Guild Desk's), and only where client-config has
// `connectRtt.enabled`: 3 s after the peer connection first connects, read the selected candidate pair's
// `currentRoundTripTime` 5 times, 1 s apart, and send the median and whether the pair is relayed (TURN), once, to
// `POST /v1/desks/{deskId}/rtt` with a fresh Idempotency-Key.
//
// Nothing else goes: no location, time or id beyond the desk in the path. The Platform adds the day, the desk's region
// and the viewer's state, and keeps only counts. Nothing here throws, retries, logs or touches the session: every
// failure ends quietly. `peer.ts` calls `watchConnectRtt` once, as it makes the RTCPeerConnection.
import { layoutMirrorWritable } from '../../state/layoutStore';

export const FIRST_SAMPLE_MS = 3000;
export const SAMPLE_EVERY_MS = 1000;
export const SAMPLES = 5;
/** Fewer samples than this on the pair's latest path, and nothing is sent. */
export const MIN_SAMPLES = 3;

export interface RttReport {
  rttMs: number;
  relayed: boolean;
}

interface Stat {
  type?: string;
  id?: string;
  state?: string;
  selected?: boolean;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  currentRoundTripTime?: number;
}

/** What `getStats()` gives back, as far as this reads it. */
export interface StatsLike {
  forEach(cb: (r: Stat) => void): void;
  get(id: string): Stat | undefined;
}

/**
 * The selected candidate pair's round trip in ms, and whether it's relayed (either candidate is `relay`), from one
 * report; null when there's no succeeded pair with a round trip yet. The pair is the transport's
 * `selectedCandidatePairId`, or else (Firefox) the candidate pair marked `selected`.
 */
export function sampleOf(report: StatsLike): RttReport | null {
  let pairId: string | null = null;
  let marked: Stat | null = null;
  report.forEach((r) => {
    if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    else if (r.type === 'candidate-pair' && r.selected === true && !marked) marked = r;
  });
  const pair = (pairId ? report.get(pairId) : undefined) ?? marked;
  if (!pair || pair.state !== 'succeeded') return null;
  const rtt = pair.currentRoundTripTime;
  if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt < 0) return null;
  const local = pair.localCandidateId ? report.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? report.get(pair.remoteCandidateId) : undefined;
  return { rttMs: rtt * 1000, relayed: local?.candidateType === 'relay' || remote?.candidateType === 'relay' };
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * What to send from the samples (null where a sample had none): the median of those on the latest sample's path, to a
 * tenth of a ms, with that path; null when fewer than MIN_SAMPLES are on it.
 */
export function summarize(samples: readonly (RttReport | null)[]): RttReport | null {
  const valid = samples.filter((s): s is RttReport => s !== null);
  const last = valid[valid.length - 1];
  if (!last) return null;
  const on = valid.filter((s) => s.relayed === last.relayed).map((s) => s.rttMs);
  if (on.length < MIN_SAMPLES) return null;
  return { rttMs: Math.round(median(on) * 10) / 10, relayed: last.relayed };
}

/**
 * The contract caps a member at 24 counted reports a UTC day and answers the rest `429 rate_limited` with `Retry-After`
 * the time to 00:00 UTC. The browser logs a refused request as a console error itself, so the only quiet way is to send
 * none: after a 429 the time it lifts is kept in localStorage with the member's `sub`, and nothing is measured or sent
 * until then. Storage that throws just means no memory.
 */
export const CAP_KEY = 'ma.rttCapped.v1';

/** The next 00:00 UTC after `now`, in ms. */
export function nextMidnightUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Remember that `sub` sends no reports until `Retry-After` seconds from `now` (the next 00:00 UTC when it's missing or bad). */
export function markCapped(sub: string, retryAfterSec: number | null, now: number, storage?: Pick<Storage, 'setItem'>): void {
  // The member's id: it goes with the layout's mirror on every signed-out state, and is written only while that may be (ISS-89).
  if (!layoutMirrorWritable()) return;
  try {
    const until = typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? now + retryAfterSec * 1000 : nextMidnightUtc(now);
    (storage ?? globalThis.localStorage).setItem(CAP_KEY, JSON.stringify({ sub, until }));
  } catch {
    /* no memory, so the next session asks again */
  }
}

/** Whether `sub` is still held off at `now`. */
export function isCapped(sub: string, now: number, storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(CAP_KEY);
    if (!raw) return false;
    const v = JSON.parse(raw) as { sub?: unknown; until?: unknown };
    return v.sub === sub && typeof v.until === 'number' && v.until > now;
  } catch {
    return false;
  }
}

export interface RttDeps {
  /** Whether client-config says to report here. */
  enabled(): Promise<boolean>;
  /** Whether this member is held off until later today by a 429; absent means never. */
  capped?(): Promise<boolean>;
  stats(): Promise<StatsLike>;
  /** The peer connection's `connectionState` now. */
  state(): string;
  wait(ms: number): Promise<void>;
  send(report: RttReport, idempotencyKey: string): Promise<void>;
  key(): string;
}

export type RttOutcome = 'sent' | 'off' | 'closed' | 'too_few' | 'failed' | 'capped';

/** Measure and send once. Resolves with what happened; never rejects. */
export async function measureAndSend(deps: RttDeps): Promise<RttOutcome> {
  try {
    if (!(await deps.enabled())) return 'off';
    if (deps.capped && (await deps.capped())) return 'capped';
    await deps.wait(FIRST_SAMPLE_MS);
    const samples: (RttReport | null)[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      if (i > 0) await deps.wait(SAMPLE_EVERY_MS);
      const state = deps.state();
      if (state === 'closed' || state === 'failed') return 'closed';
      samples.push(state === 'connected' ? sampleOf(await deps.stats()) : null);
    }
    const report = summarize(samples);
    if (!report) return 'too_few';
    await deps.send(report, deps.key());
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** A fresh Idempotency-Key for this session's one report: 16 to 64 of A-Z, a-z, 0-9, _ and - (contract errors.md). */
export function newKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The signed-in member's `sub`, from the access token; null when there's none to read. Through `api`'s chunk, so no chunk of its own. */
async function memberSub(): Promise<string | null> {
  try {
    return await (await import('../../platform/api')).accessSub();
  } catch {
    return null;
  }
}

/** The real thing: client-config and the API, loaded only when a report is due, so nothing here weighs on a session. */
function liveDeps(pc: RTCPeerConnection, deskId: string): RttDeps {
  return {
    enabled: async () => {
      const { getClientConfig } = await import('../../platform/clientConfig');
      const cfg = (await getClientConfig()) as { connectRtt?: { enabled?: unknown } };
      return cfg.connectRtt?.enabled === true;
    },
    capped: async () => {
      const sub = await memberSub();
      return sub !== null && isCapped(sub, Date.now());
    },
    stats: () => pc.getStats() as Promise<StatsLike>,
    state: () => pc.connectionState,
    wait: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
    send: async (report, idempotencyKey) => {
      const { api, ApiError } = await import('../../platform/api');
      try {
        await api(`/v1/desks/${encodeURIComponent(deskId)}/rtt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ rttMs: report.rttMs, relayed: report.relayed }),
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          const sub = await memberSub();
          if (sub !== null) markCapped(sub, e.retryAfterSec, Date.now());
        }
        throw e;
      }
    },
    key: newKey,
  };
}

const watched = new WeakSet<object>();

/**
 * One report for this peer connection, from the first time it connects; an ICE restart's later `connected` starts
 * nothing. Call once, as the connection is made, for a session to the member's own desk only. Never throws.
 */
export function watchConnectRtt(pc: RTCPeerConnection, deskId: string, deps: (pc: RTCPeerConnection, deskId: string) => RttDeps = liveDeps): void {
  try {
    if (watched.has(pc)) return;
    watched.add(pc);
    const onChange = (): void => {
      if (pc.connectionState !== 'connected') return;
      pc.removeEventListener('connectionstatechange', onChange);
      void measureAndSend(deps(pc, deskId));
    };
    pc.addEventListener('connectionstatechange', onChange);
  } catch {
    /* a report is never worth disturbing a session */
  }
}
