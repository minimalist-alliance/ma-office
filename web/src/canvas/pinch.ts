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

/** What keeps its own pinch: windows, menus, panels, the bars' own fields. Everything else in the office is the camera's. */
const OWN_PINCH = '[role="dialog"], [role="menu"], [role="listbox"], input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export type PinchTarget = 'camera' | 'stop' | 'browser';

/**
 * Where a ctrl+wheel goes. `taken`: something already took it (the canvas, a Browser window's stream). `ctrlHeld`: the
 * real Control key is down, so it isn't a pinch.
 */
export function wheelPinchGoes(target: Element | null, taken: boolean, ctrlHeld: boolean): PinchTarget {
  if (taken || !target) return 'browser';
  if (target.closest(OWN_PINCH)) return ctrlHeld ? 'browser' : 'stop';
  return ctrlHeld ? 'browser' : 'camera';
}

/** Where one of Safari's GestureEvents goes. A finger on the screen means a touch pinch, which the canvas zooms itself. */
export function gesturePinchGoes(target: Element | null, touching: boolean): Exclude<PinchTarget, 'browser'> {
  if (touching || !target || target.closest(OWN_PINCH)) return 'stop';
  return 'camera';
}

/** Safari's `scale` is since the gesture began; the camera wants the step since the last event. */
export function gestureStep(lastScale: number, scale: number): number {
  if (!(lastScale > 0) || !(scale > 0) || !Number.isFinite(scale)) return 1;
  return scale / lastScale;
}

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
  let ctrlHeld = false;
  let touching = false;
  let gesture: { goes: 'camera' | 'stop'; last: number } | null = null;

  const at = (x: number, y: number): { x: number; y: number } => {
    const r = opts.stageBox();
    return r ? { x: x - r.left, y: y - r.top } : { x, y };
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Control') ctrlHeld = e.type === 'keydown';
  };
  const onBlur = (): void => {
    ctrlHeld = false;
  };
  const onTouch = (e: TouchEvent): void => {
    touching = e.touches.length > 0;
  };
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey) return;
    const goes = wheelPinchGoes(elementOf(e.target), e.defaultPrevented, ctrlHeld);
    if (goes === 'browser') return;
    e.preventDefault();
    if (goes === 'stop') return;
    opts.begin();
    opts.zoomAt(at(e.clientX, e.clientY), opts.wheelFactor(e));
  };
  const onGestureStart = (e: GestureLike): void => {
    e.preventDefault();
    gesture = { goes: gesturePinchGoes(elementOf(e.target), touching), last: e.scale ?? 1 };
    if (gesture.goes === 'camera') opts.begin();
  };
  const onGestureChange = (e: GestureLike): void => {
    e.preventDefault();
    if (!gesture || gesture.goes !== 'camera' || touching) return;
    const scale = e.scale ?? gesture.last;
    const step = gestureStep(gesture.last, scale);
    gesture.last = scale;
    if (step !== 1) opts.zoomAt(at(e.clientX ?? 0, e.clientY ?? 0), step);
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
