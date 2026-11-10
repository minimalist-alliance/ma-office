// The camera lives here, outside React. Moving it writes straight to the Konva stage and asks for
// one batched draw per frame, so a camera move never re-renders React (design 3.10).
import Konva from 'konva/lib/Core.js';
import { readJson, reducedMotion, writeJson } from '../lib/util';
import {
  cameraDuration, DESK_MAX_SCALE, easeCamera, fitRect, interpolateCamera, isVisible, lodFor, OVERVIEW_MAX_SCALE, SlowFrameWindow, snapToDevice, zoomAtPoint,
  type Camera, type Insets, type Lod, type Viewport,
} from './camera';
import { setRasterScale, setScreenScale } from './sprites';
import type { Point, Rect } from './layout';

const SETTLE_MS = 140;
const SLOW_FRAME_MS = 20;
const FRAME_WINDOW = 12;
const SLOW_IN_WINDOW = 4; // a one-off stall isn't worth reallocating the canvas
const LOW_DPR_MOVES = 8; // moves that start at DPR 1 after a drop, before full DPR is tried again
const PHONE_W = 600;
const CAMERA_KEY = 'ma.camera.v1';

export function chromeInsets(w: number): Insets {
  return { top: w < PHONE_W ? 16 : 72, bottom: w < PHONE_W ? 16 : 64, side: 0 };
}
export const fitMargin = (w: number): number => (w < PHONE_W ? 16 : 48);

class CameraController {
  cam: Camera = { x: 0, y: 0, s: 1 };
  vp: Viewport = { w: window.innerWidth, h: window.innerHeight };
  lod: Lod = 'full';
  stats = { dprDrops: 0, moves: 0 };

  private stage: Konva.Stage | null = null;
  private layer: Konva.Layer | null = null;
  private anim = 0;
  private settleTimer = 0;
  private moving = false;
  private readonly desks = new Map<string, { node: Konva.Node; rect: Rect }>();
  private readonly glides = new Map<string, { frame: number; to: Point }>();
  private readonly settleListeners = new Set<() => void>();
  private readonly moveListeners = new Set<() => void>();
  private lastFrame = 0;
  private readonly slowFrames = new SlowFrameWindow(FRAME_WINDOW);
  private droppedDpr = false;
  private lowDprMoves = 0;
  private saved: Camera | null = null;

  /** Canvas pixels per CSS pixel: min(devicePixelRatio, 2) (design 3.10). */
  dpr(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  attach(stage: Konva.Stage, layer: Konva.Layer): void {
    this.stage = stage;
    this.layer = layer;
    const saved = readJson<Camera>(CAMERA_KEY);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.s > 0) this.saved = saved;
    Konva.pixelRatio = this.dpr();
    layer.getCanvas().setPixelRatio(this.dpr());
    setRasterScale(this.cam.s * this.dpr());
    setScreenScale(this.cam.s * this.dpr());
    this.write();
  }

  detach(): void {
    this.stop();
    this.stage = null;
    this.layer = null;
    this.desks.clear();
  }

  getStage(): Konva.Stage | null {
    return this.stage;
  }

  registerDesk(id: string, node: Konva.Node, rect: Rect): () => void {
    this.desks.set(id, { node, rect });
    node.visible(isVisible(rect, this.cam, this.vp));
    return () => {
      if (this.desks.get(id)?.node === node) this.desks.delete(id);
    };
  }

  updateDeskRect(id: string, rect: Rect): void {
    const d = this.desks.get(id);
    if (!d) return;
    d.rect = rect;
    // A desk can now move with no camera write to cull it: pushed into view, it has to show.
    const on = isVisible(rect, this.cam, this.vp);
    if (d.node.isVisible() !== on) d.node.visible(on);
  }

  /** A desk's world box as culling has it, kept current through drags and pushes: what a field over the desk follows. */
  deskRect(id: string): Rect | null {
    return this.desks.get(id)?.rect ?? null;
  }

  /** A desk pushed aside: its node and its box, with no React. A drag's own batched draw shows it. */
  placeDesk(id: string, x: number, y: number): void {
    const d = this.desks.get(id);
    if (!d) return;
    this.stopGlide(id);
    d.node.position({ x, y });
    this.updateDeskRect(id, { ...d.rect, x, y });
  }

  /** Cleanup's neighbours: from here to where the layout says, over its time. The caller checks reduced motion. */
  glideDesk(id: string, from: Point, to: Point, ms: number): void {
    const d = this.desks.get(id);
    if (!d) return;
    this.stopGlide(id);
    const start = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, Math.max(0, (now - start) / ms));
      const k = easeCamera(p);
      const at = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      d.node.position(at);
      this.updateDeskRect(id, { ...d.rect, ...at });
      this.layer?.batchDraw();
      if (p < 1) this.glides.set(id, { frame: requestAnimationFrame(step), to });
      else this.glides.delete(id);
    };
    d.node.position(from);
    this.glides.set(id, { frame: requestAnimationFrame(step), to });
  }

  /** Before a drag works anything out, every desk gets to where the layout already says it is. */
  finishGlides(): void {
    for (const [id, { to }] of this.glides) this.placeDesk(id, to.x, to.y);
  }

  private stopGlide(id: string): void {
    const glide = this.glides.get(id);
    if (!glide) return;
    cancelAnimationFrame(glide.frame);
    this.glides.delete(id);
  }

  setViewport(w: number, h: number): void {
    this.vp = { w, h };
  }

  onSettle(fn: () => void): () => void {
    this.settleListeners.add(fn);
    return () => this.settleListeners.delete(fn);
  }

  /** Called on every camera write. Keep it to a style write: it runs inside the frame budget. */
  onMove(fn: () => void): () => void {
    this.moveListeners.add(fn);
    return () => this.moveListeners.delete(fn);
  }

  private cull(): void {
    for (const { node, rect } of this.desks.values()) {
      const on = isVisible(rect, this.cam, this.vp);
      if (node.isVisible() !== on) node.visible(on);
    }
  }

  private checkLod(): void {
    const next = lodFor(this.cam.s);
    if (next === this.lod) return;
    this.lod = next;
    this.applyLod();
  }

  /** Text nodes are shown or hidden directly: this runs at most once per threshold crossing, without React. */
  applyLod(): void {
    const show = this.lod === 'full';
    this.stage?.find('.lod-text').forEach((n) => n.visible(show));
  }

  private write(): void {
    const st = this.stage;
    if (!st) return;
    const c = this.cam;
    st.setAttrs({ x: c.x, y: c.y, scaleX: c.s, scaleY: c.s });
    this.cull();
    this.checkLod();
    setScreenScale(c.s * (this.droppedDpr ? 1 : this.dpr()));
    this.moveListeners.forEach((fn) => fn());
    st.batchDraw();
  }

  /** The hit graph isn't redrawn while the camera moves (design 3.10). */
  markMoving(): void {
    if (!this.moving) {
      this.moving = true;
      this.stats.moves += 1;
      this.lastFrame = 0;
      this.slowFrames.reset();
      this.layer?.listening(false);
      if (this.lowDprMoves > 0) {
        // The last moves were too slow at full DPR, so don't spend this one's first frames finding out.
        this.lowDprMoves -= 1;
        this.dropDpr();
      }
      requestAnimationFrame(this.watchFrame);
    }
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS);
  }

  /**
   * Real frame times while the camera moves, from rAF and not from input events: a mouse wheel's
   * notches are far apart without any frame being slow.
   */
  private readonly watchFrame = (now: number): void => {
    if (!this.moving) return;
    if (this.lastFrame && this.slowFrames.note(now - this.lastFrame > SLOW_FRAME_MS) >= SLOW_IN_WINDOW && !this.droppedDpr) {
      // If frames during a move exceed 20 ms, DPR drops to 1 until the camera settles.
      this.lowDprMoves = LOW_DPR_MOVES;
      this.dropDpr();
    }
    this.lastFrame = now;
    requestAnimationFrame(this.watchFrame);
  };

  private dropDpr(): void {
    if (this.droppedDpr || this.dpr() <= 1) return;
    this.droppedDpr = true;
    this.stats.dprDrops += 1;
    this.layer?.getCanvas().setPixelRatio(1);
    setScreenScale(this.cam.s);
    // Resizing cleared the canvas, and a batched draw asked for inside a frame lands on the next one.
    this.layer?.draw();
  }

  isMoving(): boolean {
    return this.moving;
  }

  /**
   * Point a draw at screen pixels, whatever the zoom: this is the counter-scale for what's a constant size on
   * a desk (ADR 0064). It happens as a desk draws, so a desk that's culled costs nothing, no Konva node is
   * written, and nothing is allocated. Konva restores the context after the draw. Smoothing is on only while
   * the camera moves: then bitmaps land on fractions of a pixel, and at rest on whole ones (`pinned`).
   */
  pinToScreen(ctx: CanvasRenderingContext2D): void {
    const d = this.droppedDpr ? 1 : this.dpr();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.imageSmoothingEnabled = this.moving;
  }

  /** A screen position for what's pinned. Moving, it's exact, so it follows the desk smoothly. At rest, it's on a whole device pixel, so the bevel stays crisp. */
  pinned(v: number): number {
    return this.moving ? v : snapToDevice(v, this.droppedDpr ? 1 : this.dpr());
  }

  /** A zoom doesn't fit the name again until it settles, so it never makes a bitmap per wheel tick. */
  holdsNameFit(): boolean {
    return this.moving;
  }

  private settle(): void {
    if (this.anim) {
      this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS);
      return;
    }
    this.moving = false;
    if (this.droppedDpr) {
      this.droppedDpr = false;
      this.layer?.getCanvas().setPixelRatio(this.dpr());
    }
    // Land on whole device pixels and re-raster at this scale, so rest is crisp.
    const d = this.dpr();
    this.cam = { s: this.cam.s, x: Math.round(this.cam.x * d) / d, y: Math.round(this.cam.y * d) / d };
    setRasterScale(this.cam.s * d);
    this.layer?.listening(true);
    this.write();
    writeJson(CAMERA_KEY, this.cam); // per device (design 3.8), for a free camera after a reload
    this.settleListeners.forEach((fn) => fn());
  }

  /** Has anything positioned the camera yet in this page load? */
  hasMoved(): boolean {
    return this.stats.moves > 0;
  }

  /** The camera saved on this device, once, for a reload in free mode. */
  takeSaved(): Camera | null {
    const s = this.saved;
    this.saved = null;
    return s;
  }

  /** Called from a stage drag: Konva has already moved the stage. */
  fromStageDrag(x: number, y: number): void {
    this.cam = { ...this.cam, x, y };
    this.markMoving();
    this.cull();
    this.moveListeners.forEach((fn) => fn());
  }

  set(cam: Camera): void {
    this.cam = cam;
    this.markMoving();
    this.write();
  }

  stop(): void {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
  }

  isAnimating(): boolean {
    return this.anim !== 0;
  }

  animateTo(to: Camera, duration?: number): number {
    this.stop();
    if (duration === 0) {
      // A jump lands at its final scale, so raster there at once rather than at the settle.
      setRasterScale(to.s * this.dpr());
      this.set(to);
      return 0;
    }
    if (reducedMotion()) {
      // The camera jumps; the change is a 120 ms crossfade.
      this.stage?.container().animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120 });
      this.set(to);
      return 0;
    }
    const from = { ...this.cam };
    const total = duration ?? cameraDuration(from, to, this.vp);
    const start = performance.now();
    this.markMoving();
    const step = (now: number): void => {
      const p = Math.min(1, Math.max(0, (now - start) / total));
      this.cam = p >= 1 ? to : interpolateCamera(from, to, easeCamera(p), this.vp);
      this.markMoving();
      this.write();
      this.anim = p < 1 ? requestAnimationFrame(step) : 0;
    };
    this.anim = requestAnimationFrame(step);
    return total;
  }

  fit(rect: Rect, mode: 'desk' | 'overview'): Camera {
    const max = mode === 'desk' ? DESK_MAX_SCALE : OVERVIEW_MAX_SCALE;
    return fitRect(rect, this.vp, chromeInsets(this.vp.w), fitMargin(this.vp.w), max);
  }

  zoomAt(p: { x: number; y: number }, factor: number): void {
    this.set(zoomAtPoint(this.cam, p, factor));
  }

  zoomBy(factor: number): void {
    this.animateTo(zoomAtPoint(this.cam, { x: this.vp.w / 2, y: this.vp.h / 2 }, factor), 220);
  }

  panBy(dx: number, dy: number): void {
    this.set({ ...this.cam, x: this.cam.x - dx, y: this.cam.y - dy });
  }

  /** Screen rect of a world rect, for the window FLIP. */
  toScreen(r: Rect): Rect {
    const c = this.cam;
    return { x: r.x * c.s + c.x, y: r.y * c.s + c.y, w: r.w * c.s, h: r.h * c.s };
  }
}

export const camera = new CameraController();
