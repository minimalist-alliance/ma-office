// The carousel's stage (`CarouselLayer.tsx`), its own rules: its box on screen, when it holds the live app, the slide, a
// trackpad's and a finger's swipes, and which keys stay with what has focus. Pure, and tested on their own
// (`model.test.ts`). In the carousel's own chunk, out of the first load since `sub/mm-js-budget`; the rules the canvas, the
// proxies and the keyboard share are `model.ts`.
import { CAROUSEL_INSET, G } from '../canvas/layout';
import { EDGE_PX, SIDEWAYS, SWIPE_PX } from './model';

/** Under this width on screen an app can't be used, so the stage shows the app's name and glyph instead, as a card. */
export const STAGE_LIVE_MIN_W = 480;
/** And under this height, for the same reason: the window's head and a few lines of the app. */
export const STAGE_LIVE_MIN_H = 240;
/** The slide from one app to the next. Instant under reduced motion. */
export const SLIDE_MS = 220;

/**
 * The live stage on screen, for a desk at `x, y, w, h` in the world and a camera. Its app is laid out in screen pixels, so
 * the strip it leaves at the bottom is the etched row's own, which scales with the desk (`G.strip` times the zoom), and
 * the inset at the top and sides keeps its corners inside the panel's however round they are on screen. Under 1x it's the
 * same box as the canvas's card (`carouselStage`), which is what shows below `STAGE_LIVE_MIN_W`.
 */
export function stageOnScreen(desk: { x: number; y: number; w: number; h: number }, cam: { x: number; y: number; s: number }): { left: number; top: number; width: number; height: number } {
  const { s } = cam;
  const inset = CAROUSEL_INSET * Math.min(s, 1.25);
  const bottom = G.strip * s;
  const left = desk.x * s + cam.x + inset;
  const top = desk.y * s + cam.y + inset;
  return { left, top, width: Math.max(0, desk.w * s - 2 * inset), height: Math.max(0, desk.h * s - inset - bottom) };
}

/** Is a stage this big on screen one that can hold the live app? */
export const stageIsLive = (wPx: number, hPx: number): boolean => wPx >= STAGE_LIVE_MIN_W && hPx >= STAGE_LIVE_MIN_H;

/** A trackpad's sideways swipe, summed over its wheel events. Less than a finger, since a wheel's deltas are small. */
export const WHEEL_SWIPE_PX = 48;
/** A gesture's wheel events come at most this far apart; momentum included. A longer gap starts a new gesture. */
export const WHEEL_QUIET_MS = 180;

/** Within `EDGE_PX` of the screen's left or right edge. */
export const fromScreenEdge = (x: number, screenWidth: number): boolean => x <= EDGE_PX || x >= screenWidth - EDGE_PX;

export type WheelStep = 'next' | 'prev' | 'held' | 'none';

/**
 * A trackpad's two-finger swipe is a run of wheel events with `deltaX`, and its momentum keeps them coming after the
 * fingers lift. This turns a run into at most one step: once a gesture has moved the carousel, the rest of it, momentum
 * included, is held (taken, and does nothing), until a gap of `WHEEL_QUIET_MS` ends it. A gesture that's mostly up and
 * down is none of the carousel's, so a scroll in an app stays the app's. A pinch (ctrlKey) is never a swipe.
 */
export class WheelSwipe {
  private acc = 0;
  private last = -Infinity;
  private moved = false;
  private sideways = false;

  feed(e: { deltaX: number; deltaY: number; deltaMode?: number; ctrlKey?: boolean; timeStamp: number }): WheelStep {
    if (e.ctrlKey) return 'none';
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.timeStamp - this.last > WHEEL_QUIET_MS) {
      this.acc = 0;
      this.moved = false;
      this.sideways = false;
    }
    this.last = e.timeStamp;
    if (this.moved) return 'held';
    if (!this.sideways) {
      if (Math.abs(dx) <= Math.abs(dy) * SIDEWAYS || dx === 0) return 'none';
      this.sideways = true;
    }
    this.acc += dx;
    if (Math.abs(this.acc) < WHEEL_SWIPE_PX) return 'held';
    this.moved = true;
    // Fingers moving left scroll the content right, which is a positive deltaX: the next app, as on a phone.
    return this.acc > 0 ? 'next' : 'prev';
  }
}

/** A finger's swipe, judged as it lifts: far enough, and sideways enough. Left is the next app. */
export function touchSwipe(dx: number, dy: number): 1 | -1 | 0 {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) <= Math.abs(dy) * SIDEWAYS) return 0;
  return dx < 0 ? 1 : -1;
}

/** Arrow keys move the carousel unless what has focus uses them itself: a field, or a widget that moves with arrows. */
const OWN_ARROWS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="slider"], [role="grid"], [role="tree"], [role="radiogroup"], [role="toolbar"], [role="spinbutton"]';
export const keepsArrows = (el: Element | null): boolean => !!el?.closest(OWN_ARROWS) || (el as HTMLElement | null)?.isContentEditable === true;
