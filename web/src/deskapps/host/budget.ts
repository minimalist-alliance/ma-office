// The frame budget (contract 3.2, ADR 0054): a view must not hold the office's main thread. Chrome may run a sandboxed frame in
// a process of its own, but no browser promises it, so the office watches its own frames: Long Animation Frames, or the gaps
// between animation frames where that API is missing. Three frames over 50 ms in 10 s, while a view shows and the office's own
// work is idle (the camera at rest, no input for a second), and every view showing is unloaded with "Paused to keep your desk
// smooth" and Resume. Only while a view shows does anything here run.
import { camera } from '../../canvas/controller';

export const LONG_FRAME_MS = 50;
export const BUDGET_WINDOW_MS = 10_000;
export const BUDGET_COUNT = 3;
/** The office counts as busy for this long after the member's own input. */
const INPUT_QUIET_MS = 1000;

/** Whether these long frames' times (ms, any clock) break the budget at `now`: three in the last ten seconds. Pure. */
export function overBudget(times: readonly number[], now: number): boolean {
  return times.filter((t) => now - t <= BUDGET_WINDOW_MS).length >= BUDGET_COUNT;
}

type Pause = () => void;

const views = new Set<Pause>();
let times: number[] = [];
let lastInput = -Infinity;
let stopWatch: (() => void) | null = null;

const idle = (): boolean => !camera.isMoving() && performance.now() - lastInput > INPUT_QUIET_MS;

/** A long frame at `at` (performance time), counted only while the office is idle. Exported for tests. */
export function noteLongFrame(at: number, duration: number): void {
  if (duration <= LONG_FRAME_MS || !views.size || !idle()) return;
  times = [...times.filter((t) => at - t <= BUDGET_WINDOW_MS), at];
  if (!overBudget(times, at)) return;
  times = [];
  for (const pause of [...views]) pause();
}

function start(): () => void {
  const onInput = (): void => {
    lastInput = performance.now();
  };
  const opts = { capture: true, passive: true } as const;
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.addEventListener(type, onInput, opts);
  const offInput = (): void => {
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const) window.removeEventListener(type, onInput, opts);
  };
  const loaf = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  if (loaf) {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) noteLongFrame(e.startTime + e.duration, e.duration);
    });
    obs.observe({ type: 'long-animation-frame', buffered: false });
    return () => {
      obs.disconnect();
      offInput();
    };
  }
  // No Long Animation Frames: the gap between two animation frames, while the page is shown.
  let raf = 0;
  let prev = 0;
  const tick = (t: number): void => {
    if (prev && !document.hidden) noteLongFrame(t, t - prev);
    prev = t;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    offInput();
  };
}

/** A view shows: `pause` unloads it when the budget breaks. Returns its stop; the watch runs only while any view shows. */
export function watchFrames(pause: Pause): () => void {
  views.add(pause);
  stopWatch ??= start();
  return () => {
    views.delete(pause);
    if (!views.size) {
      stopWatch?.();
      stopWatch = null;
      times = [];
    }
  };
}
