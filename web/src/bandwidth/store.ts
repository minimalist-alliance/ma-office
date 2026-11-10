// The meter as Platform last said it: `GET /v1/desks/bandwidth` every `pollAfterSeconds` while the tab shows, and on
// coming back to it. Platform counts and decides; this only holds its answer. A `404` is a Platform with no meter yet,
// so nothing shows and nothing asks again until the next load.
//
// The meter's week is Monday 00:00 in the member's own zone (contract bandwidth.md, TD-226): the account's stored zone
// (`agentDefaults.timeZone`), else the zone Platform already holds, else this browser's, which every ask carries as `?tz=`
// so the first one can set it. Platform decides; `resetsAt` is shown in the member's own time, whatever it is.
//
// Each desk also has its own word: deskd refuses `browser.stream.set live` with `unavailable`, `reason: bandwidth_limit`
// and `resumesAt` while Platform has the member paused (deskd API.md section 10). That holds a desk's Browser paused
// whatever this browser's clock or the meter says (`deskSaysPaused`), until the desk's own time.
import { create } from 'zustand';
import { api, ApiError } from '../platform/api';
import { parseMeter, type BandwidthMeter } from './meter';

export const METER_PATH = '/v1/desks/bandwidth';

/** `?tz=<this browser's IANA zone>`, or nothing when the browser won't say (Platform then uses Denver). */
export function browserZoneQuery(): string {
  try {
    const z = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z ? `?tz=${encodeURIComponent(z)}` : '';
  } catch {
    return '';
  }
}
/** Coming back to the tab asks at most this often. */
const RETURN_MIN_MS = 15_000;
const FAIL_MS = 60_000;

/** A desk said its Browser is paused (`bandwidth_limit`): its own reset time, and when to ask it again. */
export interface DeskPause {
  /** The desk's `resumesAt`, or null if it didn't say. Shown as it is: the desk's word, not this browser's clock. */
  resumesAt: string | null;
  /** When it said so, by this browser's clock. */
  saidAt: number;
  /** The Browser asks the desk again from here: at `resumesAt`, but never sooner than `DESK_PAUSE_MIN_MS` after it said so. */
  askAt: number;
}

export interface BandwidthState {
  meter: BandwidthMeter | null;
  /** By desk id. */
  desks: Readonly<Record<string, DeskPause>>;
}

/**
 * The soonest a desk is asked again after it said it's paused. A clock that's fast passes `resumesAt` before the desk
 * does, and then each ask is refused: this keeps that to one a minute, and nothing asks in between.
 */
export const DESK_PAUSE_MIN_MS = 60_000;
/** A pause with no `resumesAt`: asked again after this. A hold changes within about 5 minutes (contract bandwidth.md). */
export const DESK_PAUSE_UNTIMED_MS = 5 * 60_000;

export const useBandwidth = create<BandwidthState>(() => ({ meter: null, desks: {} }));

/** Paused right now: Platform said so, and its reset hasn't passed. */
export function isPaused(m: BandwidthMeter | null, now = Date.now()): boolean {
  return !!m?.paused && (!m.resumesAt || Date.parse(m.resumesAt) > now);
}

/** The desk's own pause, while it holds: null once it's time to ask the desk again. */
export function deskPause(p: DeskPause | null | undefined, now = Date.now()): DeskPause | null {
  return p && now < p.askAt ? p : null;
}

/** The desk refused `live` with `bandwidth_limit`. Its Browser shows the pause until `askAt`, and asks nothing till then. */
export function deskSaysPaused(deskId: string, resumesAt: string | null, now = Date.now()): void {
  const at = resumesAt === null ? NaN : Date.parse(resumesAt);
  const time = Number.isNaN(at) ? null : resumesAt;
  const askAt = time === null ? now + DESK_PAUSE_UNTIMED_MS : Math.max(at, now + DESK_PAUSE_MIN_MS);
  const { desks } = useBandwidth.getState();
  useBandwidth.setState({ desks: { ...desks, [deskId]: { resumesAt: time, saidAt: now, askAt } } });
}

/**
 * The meter says the member isn't paused, after a desk said it was: a raised limit, or enforcement off. The desk lifts its
 * hold within minutes of Platform, so each paused desk is asked again soon, still no sooner than a minute after it said so.
 */
function meterLifts(now: number): void {
  const { desks } = useBandwidth.getState();
  let next: Record<string, DeskPause> | null = null;
  for (const [id, p] of Object.entries(desks)) {
    const soonest = p.saidAt + DESK_PAUSE_MIN_MS;
    if (p.askAt > soonest && p.askAt > now) (next ??= { ...desks })[id] = { ...p, askAt: Math.max(soonest, now) };
  }
  if (next) useBandwidth.setState({ desks: next });
}

let running = 0;
let timer = 0;
let etag: string | null = null;
let lastAsk = 0;
let gone = false;
let inFlight = false;

async function ask(): Promise<void> {
  if (gone || inFlight) return;
  inFlight = true;
  lastAsk = Date.now();
  let next = FAIL_MS;
  try {
    const r = await api<unknown>(`${METER_PATH}${browserZoneQuery()}`, { etag });
    if (r.status !== 304) {
      const m = parseMeter(r.data);
      // The same answer renders nothing.
      if (JSON.stringify(m) !== JSON.stringify(useBandwidth.getState().meter)) useBandwidth.setState({ meter: m });
      etag = m ? r.etag : null;
    }
    const meter = useBandwidth.getState().meter;
    if (meter && !meter.paused) meterLifts(Date.now());
    next = (meter?.pollAfterSeconds ?? 60) * 1000;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      gone = true;
      useBandwidth.setState({ meter: null });
    }
    // Anything else keeps the last answer: a blip mustn't hide the meter or lift a pause.
  } finally {
    inFlight = false;
  }
  schedule(next);
}

function schedule(ms: number): void {
  window.clearTimeout(timer);
  timer = 0;
  if (!running || gone) return;
  const m = useBandwidth.getState().meter;
  // A paused Browser comes back on time, even if a poll would land later.
  const untilReset = isPaused(m) && m?.resumesAt ? Date.parse(m.resumesAt) - Date.now() + 2_000 : Infinity;
  timer = window.setTimeout(() => {
    timer = 0;
    if (document.hidden) return; // `visibilitychange` asks when the tab comes back
    void ask();
  }, Math.max(1_000, Math.min(ms, untilReset)));
}

const onVisible = (): void => {
  if (document.hidden || !running) return;
  if (!timer || Date.now() - lastAsk >= RETURN_MIN_MS) void ask();
};

/** Starts asking; the returned function stops. Safe to call from more than one place. */
export function watchBandwidth(): () => void {
  running += 1;
  if (running === 1) {
    document.addEventListener('visibilitychange', onVisible);
    void ask();
  }
  return () => {
    running -= 1;
    if (running > 0) return;
    document.removeEventListener('visibilitychange', onVisible);
    window.clearTimeout(timer);
    timer = 0;
  };
}

/** Tests only: forget everything. */
export function resetBandwidthForTests(): void {
  window.clearTimeout(timer);
  timer = 0;
  running = 0;
  etag = null;
  lastAsk = 0;
  gone = false;
  inFlight = false;
  useBandwidth.setState({ meter: null, desks: {} });
}
