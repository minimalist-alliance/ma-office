// Office activity keeps Maia awake. The owner: "Her eyes cannot be closed the whole time!" Her package sleeps her
// after `sleepAfterMs` without use of her own widget, which left her asleep beside a member working in the office.
// So any input in the office counts as use: a key, a press, a scroll or the pointer moving, anywhere on the page,
// a desk's own windows included, and so does a desk's stream playing. She sleeps only once the whole office has been
// idle that long (ma-platform docs/maia.md §14, "Sleep", the alternative it names).
//
// Cheap on purpose ("never sluggish"): passive listeners in the capture phase, so they see input that a desk's
// window stops, and each event costs a time check. At most one wake every `everyMs`, and a wake only writes a number
// in her idle clock. Nothing runs in a hidden tab.

export const WAKE_EVERY_MS = 2_000;
/** While a desk's stream plays, how often that counts as use. Well inside her shortest sleep, 30 s. */
export const STREAM_USE_EVERY_MS = 20_000;

const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export interface ActivityDeps {
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  now?: () => number;
  hidden?: () => boolean;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export interface OfficeActivity {
  /** A desk's stream started or stopped playing. */
  setStreaming(on: boolean): void;
  stop(): void;
}

export function watchOfficeActivity(onUse: () => void, deps: ActivityDeps = {}): OfficeActivity {
  const target = deps.target ?? window;
  const now = deps.now ?? (() => performance.now());
  const hidden = deps.hidden ?? (() => document.visibilityState === 'hidden');
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => window.setInterval(fn, ms));
  const cancel = deps.clearInterval ?? ((id: unknown) => window.clearInterval(id as number));

  let last = -Infinity;
  const noteUse = (): void => {
    if (hidden()) return;
    const t = now();
    if (t - last < WAKE_EVERY_MS) return;
    last = t;
    onUse();
  };
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of EVENTS) target.addEventListener(type, noteUse, options);

  let streamTimer: unknown = null;
  return {
    setStreaming(on) {
      if (on && streamTimer === null) {
        noteUse();
        streamTimer = every(noteUse, STREAM_USE_EVERY_MS);
      } else if (!on && streamTimer !== null) {
        cancel(streamTimer);
        streamTimer = null;
      }
    },
    stop() {
      for (const type of EVENTS) target.removeEventListener(type, noteUse, options);
      if (streamTimer !== null) cancel(streamTimer);
      streamTimer = null;
    },
  };
}
