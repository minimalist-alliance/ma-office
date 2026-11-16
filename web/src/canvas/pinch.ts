// A trackpad pinch is the office's, wherever on it it starts (ADR 0064's constant size). Left to the browser, a pinch
// magnifies the whole page: the etched name grows and shrinks with it, the bars slide off, and the camera doesn't move.
// Chromium and Firefox send a pinch as wheel events with `ctrlKey` to whatever is under the pointer, and the canvas took
// only those over itself, so a pinch over the bars or a notice magnified the page. Safari sends GestureEvents and no
// wheel at all, so there a pinch never zoomed the office and always magnified the page.
//
// So: a pinch over the office zooms the camera at the pointer, as one over the canvas always has. One over a window, a
// menu or a field magnifies nothing and moves nothing, since the camera isn't what's under it. A wheel with the real
// Control key held is left to the browser outside the canvas, so Ctrl and the wheel still zoom the page for those who
// need it. A touch pinch on a phone or tablet is the canvas's own (`onTouchMove`), so its GestureEvents only stop Safari's.
//
// Over an app (ADR 0055), a pinch, Ctrl and the wheel, or Cmd and the wheel zoom that app: its frame says which app it is
// (`[data-zoom-app]`, with its `data-desk`), and the zoom chunk, loaded with the frames, takes it from here (`setAppZoom`).
// A desk app's view is a sandboxed frame whose events the office never hears: its boot sends these up (`viewZoom`).
// Off the apps, all of the above stands.
import { wheelDeltaY } from './camera';

/**
 * What keeps its own pinch: windows, menus, panels, the bars' own fields, and an open tile (ADR 0053), whose app is a
 * window's insides. Everything else in the office is the camera's.
 */
const OWN_PINCH = '[role="dialog"], [role="menu"], [role="listbox"], .open-tile, input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** An app's frame while its app can zoom: a window, an open tile, the carousel's stage or a phone's slide. */
export const APP_ZOOM = '[data-zoom-app]';

export type PinchTarget = 'camera' | 'stop' | 'browser' | 'app';

/**
 * Where a ctrl+wheel (or a cmd+wheel) goes. `taken`: something already took it (the canvas, a Browser window's stream).
 * `keyHeld`: the real Control key, or Cmd, is down, so it isn't a pinch. Over an app, either zooms the app.
 */
export function wheelPinchGoes(target: Element | null, taken: boolean, keyHeld: boolean): PinchTarget {
  if (taken || !target) return 'browser';
  if (target.closest(APP_ZOOM)) return 'app';
  if (target.closest(OWN_PINCH)) return keyHeld ? 'browser' : 'stop';
  return keyHeld ? 'browser' : 'camera';
}

/** Where one of Safari's GestureEvents goes. A finger on the screen means a touch pinch, which the canvas zooms itself. */
export function gesturePinchGoes(target: Element | null, touching: boolean): Exclude<PinchTarget, 'browser'> {
  if (touching || !target) return 'stop';
  if (target.closest(APP_ZOOM)) return 'app';
  if (target.closest(OWN_PINCH)) return 'stop';
  return 'camera';
}

/** A wheel or a pinch over an app: its frame, its delta (CSS px, down positive) and whether it was a pinch. */
export interface AppZoomInput {
  frame: Element;
  dy: number;
  pinch: boolean;
}

let appZoom: ((input: AppZoomInput) => void) | null = null;
/** The real Control key is down (the stage's listener keeps it), so a ctrl+wheel isn't a pinch. */
let controlHeld = false;

/** The zoom chunk's handler (`zoom/store.ts`), set as it loads; until then a pinch over an app does nothing, as before. */
export function setAppZoom(fn: ((input: AppZoomInput) => void) | null): void {
  appZoom = fn;
}

/**
 * A wheel or a pinch over a desk app's sandboxed view, which only that frame hears, sent up by its boot
 * (`deskapps/host/boot.js`): as one over the app. `keyHeld`: the frame saw Control or Cmd; the office may have seen Control.
 */
export function viewZoom(el: Element, dy: number, keyHeld: boolean): void {
  const frame = el.closest(APP_ZOOM);
  if (frame) appZoom?.({ frame, dy, pinch: !keyHeld && !controlHeld });
}

/** Safari's `scale` is since the gesture began; the camera wants the step since the last event. */
export function gestureStep(lastScale: number, scale: number): number {
  if (!(lastScale > 0) || !(scale > 0) || !Number.isFinite(scale)) return 1;
  return scale / lastScale;
}

/** Safari's step as a pinch's wheel delta, at the camera's pinch rate (`camera.ts` `wheelZoomFactor`), so both feel the same. */
export const gestureDelta = (step: number): number => (step > 0 && Number.isFinite(step) ? -Math.log(step) / 0.012 : 0);

/** The element an event is on, if it's one: an event on the window or the document is on none. */
const elementOf = (t: EventTarget | null): Element | null => (t && typeof (t as Element).closest === 'function' ? (t as Element) : null);

interface GestureLike extends Event {
  scale?: number;
  clientX?: number;
  clientY?: number;
}

/**
 * Listen on the whole page, for as long as the stage is mounted. `zoomAt` takes a point in the stage's own pixels and a
 * factor, and `wheelFactor` turns a wheel's delta into one, exactly as the canvas's own handler does.
 */
export function listenForPinches(opts: {
  stageBox: () => DOMRect | null;
  zoomAt: (p: { x: number; y: number }, factor: number) => void;
  begin: () => void;
  wheelFactor: (e: WheelEvent) => number;
}): () => void {
  let touching = false;
  let gesture: { goes: 'camera' | 'stop' | 'app'; last: number; frame: Element | null } | null = null;

  const at = (x: number, y: number): { x: number; y: number } => {
    const r = opts.stageBox();
    return r ? { x: x - r.left, y: y - r.top } : { x, y };
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Control') controlHeld = e.type === 'keydown';
  };
  const onBlur = (): void => {
    controlHeld = false;
  };
  const onTouch = (e: TouchEvent): void => {
    touching = e.touches.length > 0;
  };
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return;
    const target = elementOf(e.target);
    const keyHeld = controlHeld || e.metaKey;
    const goes = wheelPinchGoes(target, e.defaultPrevented, keyHeld);
    if (goes === 'browser') return;
    e.preventDefault();
    if (goes === 'stop') return;
    if (goes === 'app') {
      const frame = target?.closest(APP_ZOOM);
      if (frame) appZoom?.({ frame, dy: wheelDeltaY(e.deltaY, e.deltaMode, window.innerHeight), pinch: !keyHeld });
      return;
    }
    opts.begin();
    opts.zoomAt(at(e.clientX, e.clientY), opts.wheelFactor(e));
  };
  const onGestureStart = (e: GestureLike): void => {
    e.preventDefault();
    const target = elementOf(e.target);
    const goes = gesturePinchGoes(target, touching);
    gesture = { goes, last: e.scale ?? 1, frame: goes === 'app' ? (target?.closest(APP_ZOOM) ?? null) : null };
    if (gesture.goes === 'camera') opts.begin();
  };
  const onGestureChange = (e: GestureLike): void => {
    e.preventDefault();
    if (!gesture || gesture.goes === 'stop' || touching) return;
    const scale = e.scale ?? gesture.last;
    const step = gestureStep(gesture.last, scale);
    gesture.last = scale;
    if (step === 1) return;
    if (gesture.goes === 'app') {
      if (gesture.frame) appZoom?.({ frame: gesture.frame, dy: gestureDelta(step), pinch: true });
      return;
    }
    opts.zoomAt(at(e.clientX ?? 0, e.clientY ?? 0), step);
  };
  const onGestureEnd = (e: GestureLike): void => {
    e.preventDefault();
    gesture = null;
  };

  const active = { passive: false } as const;
  const listeners: [string, EventListener, AddEventListenerOptions][] = [
    ['keydown', onKey as EventListener, { capture: true }],
    ['keyup', onKey as EventListener, { capture: true }],
    ['blur', onBlur, {}],
    ['touchstart', onTouch as EventListener, { capture: true, passive: true }],
    ['touchend', onTouch as EventListener, { capture: true, passive: true }],
    ['touchcancel', onTouch as EventListener, { capture: true, passive: true }],
    // Bubbling, so the canvas's own handler and a Browser window's stream get theirs first and mark it taken.
    ['wheel', onWheel as EventListener, active],
    ['gesturestart', onGestureStart as EventListener, active],
    ['gesturechange', onGestureChange as EventListener, active],
    ['gestureend', onGestureEnd as EventListener, active],
  ];
  for (const [type, fn, o] of listeners) window.addEventListener(type, fn, o);
  return () => {
    for (const [type, fn, o] of listeners) window.removeEventListener(type, fn, o);
  };
}
