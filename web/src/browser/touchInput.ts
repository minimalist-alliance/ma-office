// A finger on the Browser's picture (#12, touch control on phones; the Product Designer's spec (f),
// `~/ma-coord/design-drafts/launch-features/touch/README.md`, section 1). Gestures on the wire that exists
// (`desk/rtc/input.ts`: MOVE, BUTTON, WHEEL; no wire change). `streamInput.ts` hands every `pointerType: 'touch'` event
// here; a pen and a mouse keep its own path.
//
// - A tap is a click at the lift: MOVE, then BUTTON 1 down and up, where the finger landed. A tap that turns into a drag
//   never presses; the tap dot (`touchFeedback.ts`) covers the wait.
// - A double tap is a double click: the second tap's BUTTON goes at the first tap's exact point, so X counts it. A triple
//   tap is a triple click the same way.
// - A one-finger drag scrolls the page: WHEEL, in the desk's pixels, so the page follows the finger. A drag that starts
//   1.5 times more along one axis than the other sends only that axis, for the whole drag and its fling. A quick drag
//   carries on after the lift, slowing as a phone's own scroll does, and the next touch stops it (and presses nothing).
// - A long press (500 ms, still) holds. Lifting then is the right button, the page's menu, at the press point. Dragging
//   then is a left-button drag (BUTTON 1 down at the press point, MOVE with the finger, up at the lift): it selects text,
//   moves a slider or drags a thing.
// - Two fingers zoom and move the picture here, never the page: a transform on `.br-video` (and the held still under it),
//   clipped by the surface, so zoomed it fills the whole area. Nothing reaches the desk. A tap lands where it shows,
//   through the transform and `contentBox`. One finger is always the page's; two are always the picture's.
// - A drag that lands within 16 px of the screen's left or right edge and goes mostly sideways is the phone's (its back
//   gesture) or the carousel's swipe (`CarouselLayer.tsx`): nothing goes. Mostly up or down, it scrolls, as anywhere. One
//   that lands within 16 px of the bottom and goes up is the phone's home gesture. A tap at an edge is still a tap. When
//   the phone takes a touch (`pointercancel`), nothing more comes of it.
//
// - In the desk's phone view (`phoneView.ts`, deskd API.md section 10 "On a phone"), Chromium's touch emulation makes the
//   primary button a finger, so one finger goes as it is (`direct`): BUTTON 1 down where it lands, MOVE with it, up where
//   it lifts, and the page taps, scrolls with its own momentum and long-presses by itself. The press waits up to 100 ms,
//   or 8 px of movement, so a second finger in that time makes it a pinch with nothing sent. Never WHEEL there.
//
// `TouchGestures` and the arithmetic are pure and unit tested (`touchInput.test.ts`); `bindTouchControl` is the DOM round
// them. Nothing here is React state: a transform while the picture zooms, one WHEEL or MOVE per display frame.
import type { BrowserInput } from '../desk/deskLink';
import { contentBox, normalized, WheelSum, type Box } from '../desk/rtc/input';
import { EDGE_PX } from '../carousel/model';
import { readJson, reducedMotion, writeJson } from '../lib/util';
import { touchFeedback } from './touchFeedback';

/** A finger that moves less than this is still a tap or a press. */
export const TAP_SLOP_PX = 10;
export const LONG_PRESS_MS = 500;
/** A tap this soon after the last one lifted, and this close to the first of the run, adds a click to it. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 30;
/** At least this much zoom, or enough for the desk's text to reach `READABLE` phone pixels per desk pixel. */
export const ZOOM_MAX_LEAST = 4;
const READABLE = 1.25;
/** The page row's Zoom in and Zoom out, about the middle of what's shown, over `ZOOM_STEP_MS`. */
export const ZOOM_STEP = 1.5;
const ZOOM_STEP_MS = 200;
/** The phone view's page is laid out for the phone: its odd small line needs no more than this. */
export const PHONE_ZOOM_MAX = 3;
/** In the phone view a first finger's press waits this long, or for `DIRECT_SLOP_PX` of movement (deskd's numbers). */
export const DIRECT_HOLD_MS = 100;
const DIRECT_SLOP_PX = 8;
/** A pinch that ends under this snaps back to fit, so a picture is never left a hair off. */
const ZOOM_SNAP = 1.08;
/** How much more along one axis than the other a drag is to keep to it, as the carousel's swipe (`model.ts`). */
const ONE_AXIS = 1.5;
/** A drag's speed is read over its last 100 ms, and a finger that rested 60 ms before lifting doesn't fling. */
const VELOCITY_MS = 100;
const STALE_MS = 60;
/** Screen pixels per ms: a fling starts above the first and stops under the second, slowing like a phone's own scroll. */
const FLING_MIN = 0.3;
const FLING_STOP = 0.02;
const FLING_TAU_MS = 325;
const FRAME_MAX_MS = 32;

// ----- the picture's zoom: pure

/** `translate(x, y) scale(s)` about the element's top left, in screen pixels. */
export interface Zoom {
  s: number;
  x: number;
  y: number;
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Where the picture is, on screen: the element without its transform, the surface that clips it, and the part of the
 * element that's the picture to keep in view (`pic`: the phone view's region; the whole element if left out).
 */
export interface Frame {
  el: Box;
  area: Box;
  pic?: Box;
}

export const FIT: Zoom = Object.freeze({ s: 1, x: 0, y: 0 });

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
/** No `-0`: it would read as a change. */
const tidy = (n: number): number => n || 0;

/** How far the picture zooms: `ZOOM_MAX_LEAST`, or enough for the desk's text to read (5x or so for 1920 across a phone). */
export function zoomLimit(el: Box, videoWidth: number, videoHeight: number): number {
  const pic = contentBox(el, videoWidth, videoHeight);
  return videoWidth && pic.width ? Math.max(ZOOM_MAX_LEAST, (READABLE * videoWidth) / pic.width) : ZOOM_MAX_LEAST;
}

/** One axis: no gap at a side once the picture is larger than the surface that way; while smaller, `start` or centred. */
function axis(t: number, offset: number, length: number, s: number, space: number, start: boolean): number {
  const size = length * s;
  if (size >= space) return tidy(clamp(t, space - size - offset, -offset));
  return tidy(start ? -offset : (space - size) / 2 - offset);
}

/** Between fit and `max`; at fit, exactly as laid out; zoomed, covering the surface, or at its top and centred across. */
export function clampZoom(z: Zoom, f: Frame, max: number): Zoom {
  const s = clamp(z.s, 1, Math.max(1, max));
  if (s === 1) return FIT;
  const pic = f.pic ?? f.el;
  // The picture's corner, from the surface's, as the transform about the element's corner moves it.
  const ex = f.el.left - f.area.left + (pic.left - f.el.left) * s;
  const ey = f.el.top - f.area.top + (pic.top - f.el.top) * s;
  return { s, x: axis(z.x, ex, pic.width, s, f.area.width, false), y: axis(z.y, ey, pic.height, s, f.area.height, true) };
}

/** Scale `s` about `at` (screen pixels from the element's own top left), which stays where it is as far as the bounds allow. */
export function zoomAbout(z: Zoom, at: Pt, s: number, f: Frame, max: number): Zoom {
  const k = clamp(s, 1, Math.max(1, max)) / z.s;
  return clampZoom({ s: z.s * k, x: at.x - (at.x - z.x) * k, y: at.y - (at.y - z.y) * k }, f, max);
}

/** The middle of what's shown of the picture, in the element's own screen pixels: where the page row's buttons zoom about. */
export function shownMiddle(z: Zoom, f: Frame): Pt {
  const pic = f.pic ?? f.el;
  const ex = f.el.left - f.area.left;
  const ey = f.el.top - f.area.top;
  const px = ex + z.x + (pic.left - f.el.left) * z.s;
  const py = ey + z.y + (pic.top - f.el.top) * z.s;
  const left = Math.max(0, px);
  const top = Math.max(0, py);
  const right = Math.min(f.area.width, px + pic.width * z.s);
  const bottom = Math.min(f.area.height, py + pic.height * z.s);
  return { x: (left + Math.max(left, right)) / 2 - ex, y: (top + Math.max(top, bottom)) / 2 - ey };
}

/** Where two fingers began: the zoom then, their midpoint in the element's pixels, and how far apart they were. */
export interface PinchStart {
  zoom: Zoom;
  mid: Pt;
  dist: number;
}

/** Two fingers now: the point of the picture that was under their midpoint follows it, scaled as their spread is. */
export function pinchZoom(start: PinchStart, mid: Pt, dist: number, f: Frame, max: number): Zoom {
  const z = start.zoom;
  const s = clamp(z.s * (start.dist > 0 ? dist / start.dist : 1), 1, Math.max(1, max));
  const lx = (start.mid.x - z.x) / z.s;
  const ly = (start.mid.y - z.y) / z.s;
  return clampZoom({ s, x: mid.x - lx * s, y: mid.y - ly * s }, f, max);
}

/** The element's box on screen as if it had no transform: `getBoundingClientRect`, with the zoom undone. */
export function unzoomed(r: Box, z: Zoom): Box {
  return { left: r.left - z.x, top: r.top - z.y, width: r.width / z.s, height: r.height / z.s };
}

/** Where a point on screen lands in the desk's picture, `normalized` as the wire wants: through the zoom, then the letterbox. */
export function deskPoint(client: Pt, base: Box, z: Zoom, videoWidth: number, videoHeight: number): Pt {
  const pic = contentBox({ left: 0, top: 0, width: base.width, height: base.height }, videoWidth, videoHeight);
  const x = (client.x - base.left - z.x) / z.s;
  const y = (client.y - base.top - z.y) / z.s;
  return { x: normalized(x, pic.left, pic.width), y: normalized(y, pic.top, pic.height) };
}

/** The desk's pixels under one of the screen's, so a drag scrolls the page as far as the finger went. */
export function deskPixelsPerScreenPixel(base: Box, z: Zoom, videoWidth: number, videoHeight: number): number {
  const pic = contentBox({ left: 0, top: 0, width: base.width, height: base.height }, videoWidth, videoHeight);
  return videoWidth && pic.width ? videoWidth / (pic.width * z.s) : 1;
}

export const zoomTransform = (z: Zoom): string => (z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`);

// ----- the recogniser: pure, with its clock given

/** A pointer event as the recogniser reads it: client pixels, and the event's time in ms. */
export interface Finger {
  id: number;
  x: number;
  y: number;
  t: number;
}

/** Where a finger landed, as the phone's own gestures see it. */
export interface Edges {
  /** Within `EDGE_PX` of the screen's left or right edge. */
  side: boolean;
  /** Within `EDGE_PX` of its bottom. */
  bottom: boolean;
}

export interface GestureSink {
  /** A tap's click (button 1, at the first tap's point for a double or triple tap), or a held press's lift (button 3). */
  click(at: Pt, button: 1 | 3): void;
  /** A held press that moves: the left button goes down where it was held, follows the finger, and comes up at the lift. */
  press(at: Pt): void;
  drag(at: Pt): void;
  release(at: Pt): void;
  /** Wheel pixels on screen, positive right and down, as a page scrolls: a finger moving up scrolls the page down. */
  scroll(at: Pt, dx: number, dy: number): void;
  zoom(z: Zoom): void;
  /** Feedback: a first finger landed; the hold is reached; the finger's mark goes (`tap`: it was a press that lifted). */
  land(at: Pt): void;
  held(at: Pt): void;
  lift(tap: boolean): void;
  /** Every finger is up: one gesture done. */
  done(): void;
}

export interface GestureClock {
  later(fn: () => void, ms: number): number;
  cancel(id: number): void;
  frame(fn: (t: number) => void): number;
  cancelFrame(id: number): void;
}

export interface GestureOptions {
  sink: GestureSink;
  clock: GestureClock;
  /** The element's box on screen without the zoom, and the surface's. */
  frame(): Frame;
  /** How far the picture may zoom now (`zoomLimit`). */
  maxZoom(): number;
  /** Which of the screen's edges a finger landed on. */
  edges(at: Pt): Edges;
  /** One finger goes as it is (the phone view): read as each touch begins. */
  direct?(): boolean;
}

type Axis = 'x' | 'y' | null;
type Mode =
  | { kind: 'idle' }
  | { kind: 'press'; id: number; at: Pt; t: number; quiet: boolean; edges: Edges }
  /** The phone view: a finger not yet sent (`sent` false, up to `DIRECT_HOLD_MS`), then pressed and following. */
  | { kind: 'direct'; id: number; at: Pt; last: Pt; sent: boolean; edges: Edges }
  | { kind: 'held'; id: number; at: Pt }
  | { kind: 'select'; id: number; last: Pt }
  | { kind: 'scroll'; id: number; last: Pt; samples: Finger[]; axis: Axis }
  | { kind: 'pinch'; a: number; b: number; start: PinchStart; frame: Frame; max: number }
  /** Done for this touch (an edge's drag, a finger left from a pinch, a cancel): nothing more until all lift. */
  | { kind: 'spent' };

const IDLE: Mode = { kind: 'idle' };
const SPENT: Mode = { kind: 'spent' };
const apart = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Mostly along one axis, as a drag's first move past the slop says. */
export function dragAxis(dx: number, dy: number): Axis {
  if (Math.abs(dx) > Math.abs(dy) * ONE_AXIS) return 'x';
  if (Math.abs(dy) > Math.abs(dx) * ONE_AXIS) return 'y';
  return null;
}

export class TouchGestures {
  private readonly fingers = new Map<number, Pt>();
  private mode: Mode = IDLE;
  private holdTimer = 0;
  /** The run of taps so far: where its first one landed, when the last one lifted, and how many. */
  private taps: { at: Pt; t: number; n: number } | null = null;
  private fling: { at: Pt; vx: number; vy: number; t: number; frame: number } | null = null;
  private z: Zoom = FIT;

  constructor(private readonly o: GestureOptions) {}

  get zoom(): Zoom {
    return this.z;
  }

  /** Straight to `z`, as the page row's buttons step and when the picture's box changes size. Never while fingers move it. */
  zoomTo(z: Zoom): void {
    if (this.mode.kind === 'pinch') return;
    this.setZoom(z);
  }

  down(f: Finger): void {
    const quiet = this.stopFling();
    this.fingers.set(f.id, { x: f.x, y: f.y });
    if (this.fingers.size === 1) {
      const at = { x: f.x, y: f.y };
      const edges = this.o.edges(at);
      this.o.sink.land(at);
      if (this.o.direct?.()) {
        this.mode = { kind: 'direct', id: f.id, at, last: at, sent: false, edges };
        // At an edge it waits for the finger to say: a swipe there is the phone's or the carousel's.
        if (!edges.side && !edges.bottom) this.holdTimer = this.o.clock.later(this.onDirectHold, DIRECT_HOLD_MS);
        return;
      }
      this.mode = { kind: 'press', id: f.id, at, t: f.t, quiet, edges };
      this.holdTimer = this.o.clock.later(this.onHold, LONG_PRESS_MS);
      return;
    }
    this.clearHold();
    this.taps = null;
    if (this.fingers.size !== 2) return; // a third finger changes nothing
    const m = this.mode;
    if (m.kind === 'select') this.o.sink.release(m.last);
    if (m.kind === 'direct' && m.sent) this.o.sink.release(m.last);
    if (m.kind === 'press' || m.kind === 'held' || m.kind === 'select' || m.kind === 'scroll' || m.kind === 'direct') this.o.sink.lift(false);
    const [[a, pa], [b, pb]] = [...this.fingers] as [[number, Pt], [number, Pt]];
    const frame = this.o.frame();
    const mid = { x: (pa.x + pb.x) / 2 - frame.el.left, y: (pa.y + pb.y) / 2 - frame.el.top };
    this.mode = { kind: 'pinch', a, b, start: { zoom: this.z, mid, dist: apart(pa, pb) }, frame, max: this.o.maxZoom() };
  }

  move(f: Finger): void {
    const p = this.fingers.get(f.id);
    if (!p) return;
    p.x = f.x;
    p.y = f.y;
    const m = this.mode;
    if (m.kind === 'direct' && m.id === f.id) {
      m.last = { x: f.x, y: f.y };
      if (m.sent) {
        if (apart(m.at, f) > DIRECT_SLOP_PX) this.o.sink.lift(false); // a drag: the moving page is the mark now
        this.o.sink.drag(m.last);
        return;
      }
      if (apart(m.at, f) <= DIRECT_SLOP_PX) return;
      this.clearHold();
      this.o.sink.lift(false);
      const ax = dragAxis(f.x - m.at.x, f.y - m.at.y);
      if ((m.edges.side && ax !== 'y') || (m.edges.bottom && ax === 'y' && f.y < m.at.y)) {
        this.mode = SPENT;
        return;
      }
      m.sent = true;
      this.o.sink.press(m.at);
      this.o.sink.drag(m.last);
    } else if (m.kind === 'press' && m.id === f.id) {
      if (apart(m.at, f) <= TAP_SLOP_PX) return;
      this.clearHold();
      this.taps = null;
      this.o.sink.lift(false);
      const ax = dragAxis(f.x - m.at.x, f.y - m.at.y);
      // The phone's own: its back gesture or the carousel's swipe from a side, its home gesture from the bottom.
      const phones = (m.edges.side && ax !== 'y') || (m.edges.bottom && ax === 'y' && f.y < m.at.y);
      // The slop isn't sent: the page starts moving from here, so it doesn't jump.
      this.mode = phones ? SPENT : { kind: 'scroll', id: f.id, last: { x: f.x, y: f.y }, samples: [f], axis: ax };
    } else if (m.kind === 'held' && m.id === f.id) {
      if (apart(m.at, f) <= TAP_SLOP_PX) return;
      this.o.sink.lift(false);
      this.o.sink.press(m.at);
      this.o.sink.drag({ x: f.x, y: f.y });
      this.mode = { kind: 'select', id: f.id, last: { x: f.x, y: f.y } };
    } else if (m.kind === 'select' && m.id === f.id) {
      m.last = { x: f.x, y: f.y };
      this.o.sink.drag(m.last);
    } else if (m.kind === 'scroll' && m.id === f.id) {
      const dx = m.axis === 'y' ? 0 : m.last.x - f.x;
      const dy = m.axis === 'x' ? 0 : m.last.y - f.y;
      m.last = { x: f.x, y: f.y };
      m.samples.push(f);
      while (m.samples.length > 2 && f.t - m.samples[0]!.t > VELOCITY_MS) m.samples.shift();
      if (dx || dy) this.o.sink.scroll({ x: f.x, y: f.y }, dx, dy);
    } else if (m.kind === 'pinch' && (f.id === m.a || f.id === m.b)) {
      const a = this.fingers.get(m.a)!;
      const b = this.fingers.get(m.b)!;
      const mid = { x: (a.x + b.x) / 2 - m.frame.el.left, y: (a.y + b.y) / 2 - m.frame.el.top };
      this.setZoom(pinchZoom(m.start, mid, apart(a, b), m.frame, m.max));
    }
  }

  up(f: Finger): void {
    if (!this.fingers.delete(f.id)) return;
    const m = this.mode;
    if (m.kind === 'direct') {
      this.clearHold();
      this.mode = IDLE;
      if (!m.sent) {
        // A tap: the press and its release together, where it landed.
        this.o.sink.lift(true);
        this.o.sink.press(m.at);
        this.o.sink.release(m.at);
      } else {
        this.o.sink.lift(true);
        this.o.sink.release({ x: f.x, y: f.y });
      }
    } else if (m.kind === 'press') {
      this.clearHold();
      this.mode = IDLE;
      this.o.sink.lift(true);
      if (!m.quiet) this.tap(m.at, f.t, m.t);
    } else if (m.kind === 'held') {
      this.mode = IDLE;
      this.o.sink.lift(true);
      this.o.sink.click(m.at, 3);
    } else if (m.kind === 'select') {
      this.mode = IDLE;
      this.o.sink.release({ x: f.x, y: f.y });
    } else if (m.kind === 'scroll') {
      this.mode = IDLE;
      this.startFling(m.samples, f.t, m.axis);
    } else if (m.kind === 'pinch') {
      if (f.id !== m.a && f.id !== m.b) return; // a third finger
      if (this.z.s < ZOOM_SNAP) this.setZoom(FIT);
      this.mode = this.fingers.size ? SPENT : IDLE;
    } else if (!this.fingers.size) this.mode = IDLE;
    if (!this.fingers.size) this.o.sink.done();
  }

  /** The phone took the touch (its own gesture), or it went elsewhere: nothing more comes of it. A held button lets go. */
  cancel(f: Finger): void {
    if (!this.fingers.delete(f.id)) return;
    const m = this.mode;
    if (m.kind === 'select' || (m.kind === 'direct' && m.sent)) this.o.sink.release(m.last);
    if (m.kind === 'press' || m.kind === 'held' || m.kind === 'select' || m.kind === 'direct') this.o.sink.lift(false);
    this.clearHold();
    this.taps = null;
    this.mode = this.fingers.size ? SPENT : IDLE;
    if (!this.fingers.size) this.o.sink.done();
  }

  /** Forget every finger and stop what's moving, as when the window loses focus (which releases every button). The zoom stays. */
  stop(): void {
    if (this.mode.kind === 'press' || this.mode.kind === 'held' || this.mode.kind === 'direct') this.o.sink.lift(false);
    this.clearHold();
    this.stopFling();
    this.fingers.clear();
    this.taps = null;
    this.mode = IDLE;
  }

  /** A tap's click: a new run, or the next click of a double or triple tap, at the run's first point. */
  private tap(at: Pt, upAt: number, downAt: number): void {
    const run = this.taps;
    if (run && run.n < 3 && downAt - run.t <= DOUBLE_TAP_MS && apart(run.at, at) <= DOUBLE_TAP_PX) {
      this.taps = { at: run.at, t: upAt, n: run.n + 1 };
      this.o.sink.click(run.at, 1);
      return;
    }
    this.taps = { at, t: upAt, n: 1 };
    this.o.sink.click(at, 1);
  }

  /** The phone view's finger held still for `DIRECT_HOLD_MS`: its press goes now, so the page's own long press can come. */
  private readonly onDirectHold = (): void => {
    this.holdTimer = 0;
    const m = this.mode;
    if (m.kind !== 'direct' || m.sent) return;
    m.sent = true;
    this.o.sink.press(m.at);
  };

  private readonly onHold = (): void => {
    this.holdTimer = 0;
    const m = this.mode;
    if (m.kind !== 'press') return;
    this.mode = { kind: 'held', id: m.id, at: m.at };
    this.taps = null;
    this.o.sink.held(m.at);
  };

  private clearHold(): void {
    if (this.holdTimer) this.o.clock.cancel(this.holdTimer);
    this.holdTimer = 0;
  }

  private setZoom(z: Zoom): void {
    if (z.s === this.z.s && z.x === this.z.x && z.y === this.z.y) return;
    this.z = z;
    this.o.sink.zoom(z);
  }

  private startFling(samples: Finger[], upAt: number, ax: Axis): void {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || upAt - last.t > STALE_MS || last.t <= first.t) return;
    const dt = last.t - first.t;
    const vx = ax === 'y' ? 0 : (first.x - last.x) / dt;
    const vy = ax === 'x' ? 0 : (first.y - last.y) / dt;
    if (Math.hypot(vx, vy) < FLING_MIN) return;
    this.fling = { at: { x: last.x, y: last.y }, vx, vy, t: upAt, frame: this.o.clock.frame(this.onFlingFrame) };
  }

  private readonly onFlingFrame = (t: number): void => {
    const g = this.fling;
    if (!g) return;
    const dt = clamp(t - g.t, 0, FRAME_MAX_MS);
    g.t = t;
    const decay = Math.exp(-dt / FLING_TAU_MS);
    const k = FLING_TAU_MS * (1 - decay); // how far a speed decaying so goes in `dt`
    if (dt) this.o.sink.scroll(g.at, g.vx * k, g.vy * k);
    g.vx *= decay;
    g.vy *= decay;
    if (Math.hypot(g.vx, g.vy) < FLING_STOP) this.fling = null;
    else g.frame = this.o.clock.frame(this.onFlingFrame);
  };

  /** True when a fling was going: the touch that stopped it presses nothing. */
  private stopFling(): boolean {
    if (!this.fling) return false;
    this.o.clock.cancelFrame(this.fling.frame);
    this.fling = null;
    return true;
  }
}

// ----- the hint, once per member per browser

/** The Product Designer's words (spec (f) section 5; Sales reads them). Shown on a member's first touch on a picture here. */
export const TOUCH_HINT = 'Tap to click, drag to scroll, pinch to zoom.';
export const TOUCH_HINT_MORE = "Hold for the page's menu, or hold and drag to select.";
/** The same hint while the tabs have this phone's view: the page is laid out for it, and a finger is a finger there. */
export const TOUCH_HINT_PHONE = 'Tap and scroll as on any site. Pinch to zoom.';
/** It goes on Got it, or after this many gestures on the picture: they've found their way. */
export const TOUCH_HINT_GESTURES = 3;
const HINT_KEY = 'ma.browser.touchHint.v1';
const HINT_KEEP = 20;

/** The members this browser has shown the hint to. A convenience: with no storage it may show again on a later visit. */
export function touchHintDue(member: string): boolean {
  const seen = readJson<unknown>(HINT_KEY);
  return !(Array.isArray(seen) && seen.includes(member));
}

export function touchHintShown(member: string): void {
  const seen = readJson<unknown>(HINT_KEY);
  const list = Array.isArray(seen) ? seen.filter((m): m is string => typeof m === 'string' && m !== member) : [];
  writeJson(HINT_KEY, [...list, member].slice(-HINT_KEEP));
}

// ----- the DOM

/** What the page row shows (`TouchRow.tsx`), told only when it changes. */
export interface ZoomState {
  zoomed: boolean;
  canIn: boolean;
  canOut: boolean;
}

export interface TouchControlOptions {
  video: HTMLVideoElement;
  /** Null while there's no session: the gesture goes nowhere, though the picture still zooms. */
  input(): BrowserInput | null;
  /** Real input on this desk. */
  onInput(): void;
  /** A left button's release, which may be on a page's Copy button (`streamInput.ts`). Called in the event. */
  onCopyGesture(chord: boolean): void;
  /** The first finger on this picture since it was bound. */
  onTouch(): void;
  /** Every finger is up after a gesture on the picture. */
  onGesture?(): void;
  onZoom?(state: ZoomState): void;
  /** A first finger on the picture: a tap on the page starts the phone keyboard's next run (`softKeys.ts`). */
  onFinger?(): void;
  /**
   * The phone view's region of the picture, while the tabs have this phone's view (`phoneView.ts`), or null: then a finger
   * goes as it is, the zoom keeps to the region, and it goes to `PHONE_ZOOM_MAX`.
   */
  region?(): { x: number; y: number; width: number; height: number; screenWidth: number; screenHeight: number } | null;
}

export interface TouchControl {
  down(e: PointerEvent): void;
  move(e: PointerEvent): void;
  up(e: PointerEvent): void;
  cancel(e: PointerEvent): void;
  /** The page row's Zoom in (`k` over 1) and Zoom out, about the middle of what's shown. */
  zoomBy(k: number): void;
  fit(): void;
  /**
   * Zoom to type (spec (f) section 3): as the phone's keyboard comes up, a picture whose text shows under 1 phone px per
   * desk px goes to 1:1 about the last tap, which goes `TYPE_AT` down the room above `bottom` (a client y). `back` puts the
   * zoom from before it back.
   */
  zoomToType(bottom: number): void;
  back(): void;
  stop(): void;
  dispose(): void;
}

const PRIMARY = 1;
const HOLD_BUZZ_MS = 8;
/** Zoom to type puts the field this far down the room left above the key row (spec (f) section 3). */
const TYPE_AT = 0.3;
const ease = (t: number): number => 1 - (1 - t) ** 3;

export function bindTouchControl(o: TouchControlOptions): TouchControl {
  const { video } = o;
  const surface = video.parentElement ?? video;
  const wheel = new WheelSum();
  let frame = 0;
  let wheelAt: Pt = { x: 0, y: 0 };
  /** A held drag's newest point, sent at the next display frame. */
  let dragAt: Pt | null = null;
  let touched = false;
  let stepping = 0;
  let told: ZoomState = { zoomed: false, canIn: true, canOut: false };

  // Read when it's needed, so a window drag or a new remote size is never stale. The transform is written in the same
  // task as the zoom changes, so the box read here always matches it.
  const base = (): Box => unzoomed(video.getBoundingClientRect(), gestures.zoom);
  const area = (): Box => surface.getBoundingClientRect();
  const onDesk = (p: Pt): Pt => deskPoint(p, base(), gestures.zoom, video.videoWidth, video.videoHeight);
  const limit = (): number => (o.region?.() ? PHONE_ZOOM_MAX : zoomLimit(base(), video.videoWidth, video.videoHeight));
  /** The element, the surface, and the phone view's region of the element, if that's what shows. */
  const frameNow = (): Frame => {
    const el = base();
    const r = o.region?.();
    if (!r) return { el, area: area() };
    const pic = { left: el.left + (el.width * r.x) / r.screenWidth, top: el.top + (el.height * r.y) / r.screenHeight, width: (el.width * r.width) / r.screenWidth, height: (el.height * r.height) / r.screenHeight };
    return { el, area: area(), pic };
  };
  /** Where the last finger landed, for zoom to type. */
  let lastTap: Pt | null = null;
  /** The zoom before zoom to type, to go back to. */
  let beforeTyping: Zoom | null = null;

  const feedback = touchFeedback(surface, reducedMotion);

  const flush = (): void => {
    frame = 0;
    const sink = o.input();
    if (!sink) {
      wheel.reset();
      dragAt = null;
      return;
    }
    const scroll = wheel.take();
    if (scroll) {
      const at = onDesk(wheelAt);
      sink.wheel(at.x, at.y, scroll.dx, scroll.dy);
    }
    // A MOVE that can't go now waits for the next frame, and only the newest is ever kept.
    if (dragAt) {
      const at = onDesk(dragAt);
      if (sink.move(at.x, at.y)) dragAt = null;
    }
    if (wheel.hasMore() || dragAt) frame = requestAnimationFrame(flush);
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  /** A scroll or a drag waiting goes before a button, so the two can't swap. */
  const flushNow = (): void => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    flush();
  };

  const tell = (z: Zoom): void => {
    const max = limit();
    const now = { zoomed: z.s > 1, canIn: z.s < max - 1e-6, canOut: z.s > 1 };
    if (now.zoomed === told.zoomed && now.canIn === told.canIn && now.canOut === told.canOut) return;
    told = now;
    o.onZoom?.(now);
  };

  /** The held still (`.br-held`) has the same box as the picture, so it takes the same transform. */
  const show = (z: Zoom): void => {
    const transform = zoomTransform(z);
    for (const el of [video, surface.querySelector<HTMLElement>('.br-held')]) if (el) el.style.transform = transform;
    video.dataset['zoom'] = String(Math.round(z.s * 100) / 100);
    tell(z);
  };

  const gestures: TouchGestures = new TouchGestures({
    sink: {
      click(at, button) {
        flushNow();
        const sink = o.input();
        if (!sink) return;
        const p = onDesk(at);
        sink.move(p.x, p.y);
        sink.button(true, button, p.x, p.y);
        sink.button(false, button, p.x, p.y);
        if (button === PRIMARY) o.onCopyGesture(false);
        o.onInput();
      },
      press(at) {
        flushNow();
        const sink = o.input();
        if (!sink) return;
        const p = onDesk(at);
        sink.move(p.x, p.y);
        sink.button(true, PRIMARY, p.x, p.y);
        o.onInput();
      },
      drag(at) {
        dragAt = at;
        schedule();
        o.onInput();
      },
      release(at) {
        dragAt = null;
        flushNow();
        const sink = o.input();
        if (!sink) return;
        const p = onDesk(at);
        sink.button(false, PRIMARY, p.x, p.y);
        o.onCopyGesture(false);
        o.onInput();
      },
      scroll(at, dx, dy) {
        const k = deskPixelsPerScreenPixel(base(), gestures.zoom, video.videoWidth, video.videoHeight);
        wheel.add(dx * k, dy * k);
        wheelAt = at;
        schedule();
        o.onInput();
      },
      zoom: show,
      land: (at) => {
        cancelAnimationFrame(stepping);
        stepping = 0;
        lastTap = at;
        feedback.land(at);
        o.onFinger?.();
      },
      held: () => {
        feedback.held();
        navigator.vibrate?.(HOLD_BUZZ_MS);
      },
      lift: (tap) => feedback.lift(tap),
      done: () => o.onGesture?.(),
    },
    clock: {
      later: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (id) => window.clearTimeout(id),
      frame: (fn) => requestAnimationFrame(fn),
      cancelFrame: (id) => cancelAnimationFrame(id),
    },
    frame: frameNow,
    maxZoom: limit,
    edges: (at) => ({ side: at.x <= EDGE_PX || at.x >= window.innerWidth - EDGE_PX, bottom: at.y >= window.innerHeight - EDGE_PX }),
    direct: () => !!o.region?.(),
  });

  /** To `to`, over `ZOOM_STEP_MS` (at once under reduced motion), keeping `about` where it is on screen. */
  const animate = (to: number, about: Pt): void => {
    cancelAnimationFrame(stepping);
    stepping = 0;
    const f = frameNow();
    const max = limit();
    const from = gestures.zoom;
    if (reducedMotion()) {
      gestures.zoomTo(zoomAbout(from, about, to, f, max));
      return;
    }
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / ZOOM_STEP_MS);
      gestures.zoomTo(zoomAbout(from, about, from.s * (to / from.s) ** ease(t), f, max));
      stepping = t < 1 ? requestAnimationFrame(step) : 0;
    };
    stepping = requestAnimationFrame(step);
  };

  // A new box for the picture (a turned phone, a resized window, a new remote size) starts at fit again.
  let size = '';
  const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const now = `${video.offsetWidth}x${video.offsetHeight}`;
    if (size && now !== size) {
      cancelAnimationFrame(stepping);
      gestures.zoomTo(FIT);
    }
    size = now;
  });
  resized?.observe(video);
  const onPictureSize = (): void => gestures.zoomTo(FIT);
  video.addEventListener('resize', onPictureSize);

  // The page's own touch control only while this one is on: the member's browser doesn't scroll or zoom the office instead.
  video.classList.add('touch-on');
  surface.classList.add('touch-on');
  const finger = (e: PointerEvent): Finger => ({ id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp });

  return {
    down(e) {
      if (!touched) {
        touched = true;
        o.onTouch();
      }
      gestures.down(finger(e));
    },
    move: (e) => gestures.move(finger(e)),
    up: (e) => gestures.up(finger(e)),
    cancel: (e) => gestures.cancel(finger(e)),
    zoomBy(k) {
      animate(gestures.zoom.s * k, shownMiddle(gestures.zoom, frameNow()));
    },
    zoomToType(bottom) {
      const f = frameNow();
      const fitScale = contentBox(f.el, video.videoWidth, video.videoHeight).width / (video.videoWidth || 1);
      // The phone view's page is laid out for the phone, and a picture already as large as the desk's pixels needs nothing.
      if (o.region?.() || !lastTap || !video.videoWidth || fitScale >= 1) return;
      beforeTyping = gestures.zoom;
      const s = Math.min(limit(), 1 / fitScale);
      const z = gestures.zoom;
      // The point under the last tap, in the picture's own pixels, goes `TYPE_AT` down what shows above the key row.
      const lx = (lastTap.x - f.el.left - z.x) / z.s;
      const ly = (lastTap.y - f.el.top - z.y) / z.s;
      const room = Math.max(0, bottom - f.area.top);
      const target = { x: lastTap.x - f.el.left, y: f.area.top + room * TYPE_AT - f.el.top };
      cancelAnimationFrame(stepping);
      gestures.zoomTo(clampZoom({ s, x: target.x - lx * s, y: target.y - ly * s }, f, limit()));
    },
    back() {
      if (!beforeTyping) return;
      const z = beforeTyping;
      beforeTyping = null;
      gestures.zoomTo(clampZoom(z, frameNow(), limit()));
    },
    fit() {
      cancelAnimationFrame(stepping);
      stepping = 0;
      gestures.zoomTo(FIT);
    },
    stop() {
      gestures.stop();
      wheel.reset();
      dragAt = null;
    },
    dispose() {
      gestures.stop();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(stepping);
      resized?.disconnect();
      video.removeEventListener('resize', onPictureSize);
      feedback.dispose();
      video.classList.remove('touch-on');
      surface.classList.remove('touch-on');
      show(FIT);
      delete video.dataset['zoom'];
    },
  };
}
