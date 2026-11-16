// The frame budget (contract 3.2, ADR 0054 and its addendum of Nov 12): a view must not hold the office's main thread, and
// only a view's own time is ever counted against it. The office's own long frames (a live Browser tile, a redraw, the desk
// link, another app, a slow machine) never pause a view.
//
// What a browser lets the office see (proven in Chromium 156, `docs/sub-status/frame-budget-attribution.md`):
// - A view's frame is `sandbox="allow-scripts"` with an opaque origin. Chrome on a computer runs it in a process of its own,
//   where it can't slow the office at all; Chrome's headless shell, Chrome on Android for most sites, Firefox and Safari run it
//   on the office's thread.
// - Long Animation Frames never list a cross-origin frame's scripts in the office's entries (the spec's "nearest same-origin
//   root"): a view's time on the office's thread shows only as time before style and layout that none of the office's own
//   listed scripts explains.
// So: each view's frame says first, from our boot script, whether it shares the office's thread (`threadOf`: a ping on a port,
// sent inside a busy moment of the office's, that the boot script answers on the office's window; an answer queued before the
// office's own marker came from another thread). A view on a thread of its own is never watched. For one that shares it (or until that's known), with Long
// Animation Frames: a long frame counts against the views on the office's thread when the time no office script explains, plus
// any script of an opaque-origin frame, is over 50 ms; three in 10 s while the office is idle (the camera at rest, no input in
// the second before) and no view is in its first 2 s pause them, "Paused to keep your desk smooth" with Resume. Without Long
// Animation Frames (Firefox, Safari) nothing can be attributed, so only a hang counts: an animation frame gap over 1 s while a
// view shows and the office was idle, twice in 30 s. Only while a view shows does anything here run.
import { camera } from '../../canvas/controller';

export const LONG_FRAME_MS = 50;
export const BUDGET_WINDOW_MS = 10_000;
export const BUDGET_COUNT = 3;
/** Without Long Animation Frames: a gap between animation frames this long is a hang. */
export const HANG_MS = 1000;
export const HANG_WINDOW_MS = 30_000;
export const HANG_COUNT = 2;
/** A gap this long is the machine asleep or the tab frozen, not a view. */
const HANG_MAX_MS = 20_000;
/** The office counts as busy for this long after the member's own input. */
const INPUT_QUIET_MS = 1000;
/** A view's first moments are its startup (its data, its first render), as the office's are after input: they don't count. */
export const STARTUP_MS = 2000;
/** How long the office keeps its thread for a probe of whether a view's frame shares it. */
export const PROBE_BUSY_MS = 4;
const PROBE_TRIES = 3;
const PROBE_FIRST_MS = 400;
const PROBE_GAP_MS = 1500;
const PROBE_WAIT_MS = 1000;

const DIAG = import.meta.env.MODE !== 'production';

/** Whether these long frames' times (ms, any clock) break the budget at `now`: three in the last ten seconds. Pure. */
export function overBudget(times: readonly number[], now: number): boolean {
  return times.filter((t) => now - t <= BUDGET_WINDOW_MS).length >= BUDGET_COUNT;
}

/** The fields of a `PerformanceScriptTiming` the budget reads. */
export interface ScriptLike {
  startTime: number;
  duration: number;
  windowAttribution?: string;
  window?: unknown;
  sourceURL?: string;
}

/** The fields of a `PerformanceLongAnimationFrameTiming` the budget reads. */
export interface FrameLike {
  startTime: number;
  duration: number;
  styleAndLayoutStart?: number;
  scripts?: readonly ScriptLike[];
}

/** Who took one long animation frame's time. */
export interface Share {
  /** By each view's frame window: scripts whose `window` is that frame (a browser that lists them). */
  views: Map<unknown, number>;
  /** Scripts from an opaque origin's `blob:` (a view's) that no window claims. */
  opaque: number;
  /** Time before style and layout that no listed script explains: a view on the office's thread, or the office's small work. */
  unexplained: number;
  /** The office's own listed scripts. */
  office: number;
}

/**
 * Who took a long animation frame's time. Pure. A script's `duration` already holds its `forcedStyleAndLayoutDuration`, so
 * that isn't added again. The frame's own style, layout and paint (from `styleAndLayoutStart`) is never anyone's: it's the
 * page's, and a slow machine's.
 */
export function shareOf(frame: FrameLike, wins: readonly unknown[]): Share {
  const share: Share = { views: new Map(), opaque: 0, unexplained: 0, office: 0 };
  const end = frame.styleAndLayoutStart && frame.styleAndLayoutStart > frame.startTime ? frame.styleAndLayoutStart : frame.startTime + frame.duration;
  let listed = 0;
  for (const s of frame.scripts ?? []) {
    const d = Math.max(0, s.duration);
    // Only what ran before style and layout explains the time before it.
    listed += Math.max(0, Math.min(s.startTime + d, end) - Math.max(s.startTime, frame.startTime));
    const win = s.window != null && wins.includes(s.window) ? s.window : null;
    if (win) share.views.set(win, (share.views.get(win) ?? 0) + d);
    else if (s.windowAttribution !== 'self' && (s.sourceURL ?? '').startsWith('blob:null/')) share.opaque += d;
    else share.office += d;
  }
  share.unexplained = Math.max(0, end - frame.startTime - listed);
  return share;
}

/** One view's part of a frame: its own scripts, and when it shares the office's thread, what nothing else explains. Pure. */
export function viewShare(share: Share, win: unknown, sharesThread: boolean): number {
  return (share.views.get(win) ?? 0) + (sharesThread ? share.opaque + share.unexplained : 0);
}

/** Whether these hangs' times break the hang guard at `now`: two in the last thirty seconds. Pure. */
export function hung(times: readonly number[], now: number): boolean {
  return times.filter((t) => now - t <= HANG_WINDOW_MS).length >= HANG_COUNT;
}

export type Thread = 'unknown' | 'shared' | 'own';

/** A view that shows. */
export interface WatchedView {
  /** Its frame's window: scripts whose `window` is this are its own. */
  win: Window | null;
  /** The port its boot script answers on (`boot.js`), for `threadOf`. */
  probe: MessagePort | null;
  /** For the diagnostics. */
  name: string;
  /** Unload it: the budget broke. */
  pause: () => void;
  /** Whether it shares the office's thread, when that's already known (tests); otherwise asked on `probe`. */
  thread?: Thread;
  /** When it began to show (performance time; now by default). */
  since?: number;
}

interface Watched extends WatchedView {
  thread: Thread;
  since: number;
  times: number[];
  hangs: number[];
}

/** Whether `v` is still starting at `at`. */
const starting = (v: Watched, at: number): boolean => at < v.since + STARTUP_MS;

const views = new Set<Watched>();
/** Each frame's answer, kept by its port so a view parked and shown again isn't asked twice. */
const threads = new WeakMap<MessagePort, Thread>();
/** Input times (performance time), the last two seconds' worth. */
let inputs: number[] = [];
let stopWatch: (() => void) | null = null;

/** No input in the second before `at`, and the camera at rest. */
function idleAt(at: number): boolean {
  if (camera.isMoving()) return false;
  return !inputs.some((t) => t <= at && at - t <= INPUT_QUIET_MS);
}

function diag(what: string, detail: Record<string, unknown>): void {
  if (!DIAG) return;
  console.info(`[frame budget] ${what}`, detail);
  const w = globalThis as { __maBudget?: { what: string; detail: Record<string, unknown> }[] };
  const log = (w.__maBudget ??= []);
  log.push({ what, detail });
  if (log.length > 200) log.splice(0, log.length - 200);
}

function pauseView(v: Watched, detail: Record<string, unknown>): void {
  diag('paused', { view: v.name, thread: v.thread, ...detail });
  v.times = [];
  v.hangs = [];
  v.pause();
}

/** A long animation frame, from the observer. Exported for tests. */
export function noteFrame(frame: FrameLike): void {
  if (frame.duration <= LONG_FRAME_MS || !views.size || !idleAt(frame.startTime)) return;
  const all = [...views];
  const share = shareOf(frame, all.map((v) => v.win));
  const at = frame.startTime + frame.duration;
  // While a view on the office's thread is starting, what nothing explains is most likely that start: nobody's.
  const anyStarting = all.some((v) => v.thread !== 'own' && starting(v, frame.startTime));
  for (const v of all) {
    if (starting(v, frame.startTime)) continue;
    const ms = viewShare(share, v.win, v.thread !== 'own' && !anyStarting);
    if (ms <= LONG_FRAME_MS) continue;
    v.times = [...v.times.filter((t) => at - t <= BUDGET_WINDOW_MS), at];
    diag('long frame', { view: v.name, thread: v.thread, frameMs: Math.round(frame.duration), viewMs: Math.round(ms), unexplainedMs: Math.round(share.unexplained), officeMs: Math.round(share.office), count: v.times.length });
    if (overBudget(v.times, at)) pauseView(v, { frames: v.times.length, lastFrameMs: Math.round(frame.duration), lastViewMs: Math.round(ms) });
  }
}

/** Without Long Animation Frames: a gap of `gap` ms between animation frames ending at `at`. Exported for tests. */
export function noteGap(at: number, gap: number, wasIdle: boolean): void {
  if (gap <= HANG_MS || gap > HANG_MAX_MS || !wasIdle || !views.size) return;
  const from = at - gap;
  const all = [...views];
  if (all.some((v) => v.thread !== 'own' && starting(v, from))) return;
  for (const v of all) {
    if (v.thread === 'own') continue;
    v.hangs = [...v.hangs.filter((t) => at - t <= HANG_WINDOW_MS), at];
    diag('hang', { view: v.name, thread: v.thread, gapMs: Math.round(gap), count: v.hangs.length });
    if (hung(v.hangs, at)) pauseView(v, { hangs: v.hangs.length, lastGapMs: Math.round(gap) });
  }
}

/** Input, as the observers see it. Exported for tests. */
export function noteInput(at: number): void {
  // A pointer moving is many events a frame: one kept per 50 ms says enough (the quiet second is then good to 50 ms).
  const last = inputs[inputs.length - 1];
  if (last !== undefined && at >= last && at - last < 50) return;
  inputs = [...inputs.filter((t) => at - t <= 2 * INPUT_QUIET_MS), at];
}

/**
 * One try at whether the frame on `port`'s other end runs on the office's thread: a ping with a fresh nonce on the port (a
 * port's message leaves at once, where a window's waits for the task to end), the office's own thread held for a moment, then
 * a marker posted to the office's own window. The boot script answers on the office's window too, so both wait in one queue,
 * in order. A frame on another thread answers during that moment, so its answer is queued before the marker; one on this
 * thread can't run until the moment ends, so its answer comes after. Nothing a view does can make an answer beat the marker on
 * this thread (the nonce is new), so `true` is certain and `false` may be a slow answer from another thread, which the budget
 * treats as sharing. Measured in Chromium 156: `docs/sub-status/frame-budget-attribution.md`.
 */
function tryThread(port: MessagePort, win: Window): Promise<boolean> {
  return new Promise((resolve) => {
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(2)), (x) => x.toString(36)).join('');
    let marked = false;
    let done = false;
    const finish = (own: boolean): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(own);
    };
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as { t?: unknown; n?: unknown } | null;
      if (!d || d.n !== nonce) return;
      if (e.source === window && d.t === 'ma.mark') marked = true;
      else if (e.source === win && d.t === 'ma.pong') finish(!marked);
    };
    const timer = window.setTimeout(() => finish(false), PROBE_WAIT_MS);
    window.addEventListener('message', onMessage);
    port.postMessage({ t: 'ma.ping', n: nonce });
    const until = performance.now() + PROBE_BUSY_MS;
    while (performance.now() < until) {
      /* the office's thread, held for the probe */
    }
    window.postMessage({ t: 'ma.mark', n: nonce }, window.location.origin);
  });
}

/**
 * Whether a view's frame shares the office's thread: `own` once any try says so, else `shared`; `null` if it stopped being
 * `wanted` (its view closed or parked) before an answer, so nothing holds the office's thread for a frame no one shows.
 */
export async function threadOf(port: MessagePort, win: Window, wanted: () => boolean = () => true, wait = (ms: number) => new Promise<void>((done) => window.setTimeout(done, ms))): Promise<Thread | null> {
  await wait(PROBE_FIRST_MS);
  for (let i = 0; i < PROBE_TRIES; i += 1) {
    if (!wanted()) return null;
    if (await tryThread(port, win)) return 'own';
    if (i < PROBE_TRIES - 1) await wait(PROBE_GAP_MS);
  }
  return 'shared';
}

function start(): () => void {
  const onInput = (): void => noteInput(performance.now());
  const opts = { capture: true, passive: true } as const;
  const types = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
  for (const type of types) window.addEventListener(type, onInput, opts);
  const offInput = (): void => {
    for (const type of types) window.removeEventListener(type, onInput, opts);
  };
  const loaf = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  if (loaf) {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) noteFrame(e as unknown as FrameLike);
    });
    obs.observe({ type: 'long-animation-frame', buffered: false });
    return () => {
      obs.disconnect();
      offInput();
    };
  }
  // No Long Animation Frames: the gap between two animation frames, while the page is shown. A hidden page has no frames, so
  // the gap across it is nobody's: it starts again when the page shows.
  let raf = 0;
  let prev = 0;
  let prevIdle = false;
  const tick = (t: number): void => {
    if (prev && !document.hidden) noteGap(t, t - prev, prevIdle);
    prev = t;
    prevIdle = idleAt(t);
    raf = requestAnimationFrame(tick);
  };
  const restart = (): void => {
    prev = 0;
  };
  document.addEventListener('visibilitychange', restart);
  window.addEventListener('pageshow', restart);
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', restart);
    window.removeEventListener('pageshow', restart);
    offInput();
  };
}

function settle(v: Watched, thread: Thread): void {
  v.thread = thread;
  diag('thread', { view: v.name, thread });
  if (thread === 'own') {
    // Its time can't be the office's: nothing to watch for it.
    v.times = [];
    v.hangs = [];
  }
}

/** Ask a frame which thread it's on, once, for every view it shows in. */
function probe(port: MessagePort, win: Window): void {
  const shown = (): boolean => [...views].some((w) => w.probe === port);
  threads.set(port, 'unknown');
  void threadOf(port, win, shown).then((thread) => {
    threads.delete(port);
    // Given up while its view was parked: ask again if it shows once more.
    if (!thread) {
      if (shown()) probe(port, win);
      return;
    }
    threads.set(port, thread);
    for (const w of views) if (w.probe === port) settle(w, thread);
  });
}

/** A view shows. Returns its stop; the watch runs only while any view shows. */
export function watchFrames(view: WatchedView): () => void {
  const v: Watched = { ...view, thread: 'unknown', since: view.since ?? performance.now(), times: [], hangs: [] };
  views.add(v);
  stopWatch ??= start();
  const known = view.thread ?? (view.probe && view.win ? threads.get(view.probe) : 'shared');
  if (known) settle(v, known);
  else if (view.probe && view.win) probe(view.probe, view.win);
  return () => {
    views.delete(v);
    if (!views.size) {
      stopWatch?.();
      stopWatch = null;
      inputs = [];
    }
  };
}
