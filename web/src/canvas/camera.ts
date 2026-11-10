// Pure camera math (design 3.1). No DOM, no Konva, so it is unit tested directly.
import { clamp } from '../lib/util';
import type { Rect } from './layout';

export interface Camera {
  x: number;
  y: number;
  s: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  bottom: number;
  side: number;
}

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;
export const DESK_MAX_SCALE = 1.75;
export const OVERVIEW_MAX_SCALE = 1;

/** CSS cubic-bezier as a function of progress t in 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number): number => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number): number => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number): number => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 6; i += 1) {
      const err = sampleX(u) - t;
      if (Math.abs(err) < 1e-4) break;
      const d = slopeX(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    u = clamp(u, 0, 1);
    return sampleY(u);
  };
}

export const easeCamera = cubicBezier(0.2, 0, 0, 1);

/** Camera moves take 320 ms plus up to 160 ms for distance. */
export function cameraDuration(from: Camera, to: Camera, vp: Viewport): number {
  const cx = vp.w / 2;
  const cy = vp.h / 2;
  const a = { x: (cx - from.x) / from.s, y: (cy - from.y) / from.s };
  const b = { x: (cx - to.x) / to.s, y: (cy - to.y) / to.s };
  const screenMove = Math.hypot(a.x - b.x, a.y - b.y) * Math.max(from.s, to.s);
  const zoomMove = Math.abs(Math.log(to.s / from.s));
  const d = screenMove / Math.max(1, Math.hypot(vp.w, vp.h)) + zoomMove / 2;
  return 320 + 160 * clamp(d, 0, 1);
}

/** Center interpolated linearly, scale in log space, so zoom speed feels even. */
export function interpolateCamera(from: Camera, to: Camera, e: number, vp: Viewport): Camera {
  const cx = vp.w / 2;
  const cy = vp.h / 2;
  const a = { x: (cx - from.x) / from.s, y: (cy - from.y) / from.s };
  const b = { x: (cx - to.x) / to.s, y: (cy - to.y) / to.s };
  const s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
  const wx = a.x + (b.x - a.x) * e;
  const wy = a.y + (b.y - a.y) * e;
  return { s, x: cx - wx * s, y: cy - wy * s };
}

export function fitRect(rect: Rect, vp: Viewport, ins: Insets, margin: number, maxScale: number): Camera {
  const availW = Math.max(100, vp.w - 2 * ins.side);
  const availH = Math.max(100, vp.h - ins.top - ins.bottom);
  const w = rect.w + 2 * margin;
  const h = rect.h + 2 * margin;
  const s = clamp(Math.min(availW / w, availH / h), MIN_SCALE, maxScale);
  return {
    s,
    x: vp.w / 2 - (rect.x + rect.w / 2) * s,
    y: ins.top + availH / 2 - (rect.y + rect.h / 2) * s,
  };
}

/** A wheel's zoom step, from its vertical delta in CSS pixels. A pinch (a wheel with `ctrlKey`) takes far bigger steps per pixel than a scroll. */
export function wheelZoomFactor(dy: number, pinch: boolean): number {
  return Math.exp(clamp(-dy, -300, 300) * (pinch ? 0.012 : 0.0016));
}

/** A wheel's vertical delta in CSS pixels, whatever unit it came in. */
export function wheelDeltaY(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

export function zoomAtPoint(c: Camera, p: { x: number; y: number }, factor: number): Camera {
  const s = clamp(c.s * factor, MIN_SCALE, MAX_SCALE);
  const wx = (p.x - c.x) / c.s;
  const wy = (p.y - c.y) / c.s;
  return { s, x: p.x - wx * s, y: p.y - wy * s };
}

// Within this many pixels of the viewport's right or bottom edge, a dragged corner pushes the camera.
const EDGE_ZONE_PX = 48;
const EDGE_SPEED_PX_PER_S = 480;

/** How far to pan for a dragged corner this frame: nothing until it nears an edge, then gently harder toward it. */
export function edgePan(pointer: { x: number; y: number }, vp: Viewport, dtMs: number): { dx: number; dy: number } {
  const push = (at: number, size: number): number => clamp((at - (size - EDGE_ZONE_PX)) / EDGE_ZONE_PX, 0, 1);
  const px = (EDGE_SPEED_PX_PER_S * dtMs) / 1000;
  return { dx: push(pointer.x, vp.w) * px, dy: push(pointer.y, vp.h) * px };
}

/** The nearest whole device pixel to a CSS pixel position, at `ratio` device pixels per CSS pixel. */
export const snapToDevice = (v: number, ratio: number): number => Math.round(v * ratio) / ratio;

/** Level of detail by on-screen tile size s = 76 * scale (design 3.10). */
export type Lod = 'full' | 'glyph' | 'card';
export function lodFor(scale: number): Lod {
  const px = 76 * scale;
  if (px >= 40) return 'full';
  if (px >= 20) return 'glyph';
  return 'card';
}

/** Does a world rect touch the viewport under this camera? Konva does not cull on its own. */
export function isVisible(r: Rect, c: Camera, vp: Viewport, pad = 40): boolean {
  const x = r.x * c.s + c.x;
  const y = r.y * c.s + c.y;
  const w = r.w * c.s;
  const h = r.h * c.s;
  return x + w > -pad && y + h > -pad && x < vp.w + pad && y < vp.h + pad;
}

/**
 * How far past the zoom that focusing a desk gives (`fitRect` in desk mode) the camera has to be before that desk is
 * plainly the one in focus, however the camera got there (ADR 0003). Focusing lands on exactly 1, so it takes zooming
 * in: one wheel notch from there does (`wheelZoomFactor`); a pan, or a zoom out, never does.
 */
export const FOCUS_ZOOM = 1.1;

/** Is the camera zoomed in on this desk: past FOCUS_ZOOM of `focusScale`, with the desk under the middle of the screen? */
export function zoomedInOn(r: Rect, c: Camera, vp: Viewport, focusScale: number): boolean {
  if (c.s < focusScale * FOCUS_ZOOM) return false;
  const x = (vp.w / 2 - c.x) / c.s;
  const y = (vp.h / 2 - c.y) / c.s;
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * How many of the last `size` frames were slow. A rate and not a run: a canvas too costly for the
 * frame alternates slow and fast frames, which never add up to a run. A one-off stall stays under it.
 */
export class SlowFrameWindow {
  private readonly frames: boolean[];
  private at = 0;
  private count = 0;

  constructor(size: number) {
    this.frames = new Array<boolean>(size).fill(false);
  }

  /** Records a frame and returns the slow frames now in the window. */
  note(slow: boolean): number {
    if (this.frames[this.at]) this.count -= 1;
    if (slow) this.count += 1;
    this.frames[this.at] = slow;
    this.at = (this.at + 1) % this.frames.length;
    return this.count;
  }

  reset(): void {
    this.frames.fill(false);
    this.at = 0;
    this.count = 0;
  }
}
