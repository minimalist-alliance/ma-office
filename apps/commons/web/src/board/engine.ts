// The board: two canvases and a layer of cursors over one Y.Doc.
//
// - `base` holds the finished items. It redraws only when the board or the camera changes, and a
//   frame then costs one transform and one fill or stroke per visible item, from cached paths.
// - `over` holds what's moving: this member's stroke in progress, others' strokes as they draw
//   them, items being dragged, the selection and the eraser's trail.
// - Cursors are DOM elements moved with transforms, so names stay crisp and cost no canvas work.
//
// Nothing renders while the board is still: frames run only when something changed.
import * as Y from 'yjs';
import type { LiveMsg } from './live.ts';
import {
  INKS,
  NOTE_SIZE,
  PEN_WIDTH,
  LINE_WIDTH,
  TEXT_SIZE,
  itemsOf,
  packStroke,
  putItem,
  readItem,
  topZ,
  type Ink,
  type Item,
  type Size,
} from './model.ts';
import {
  NOTE_FONT,
  NOTE_PAD,
  arrowShape,
  buildShape,
  emptyBox,
  hitItem,
  hitSegment,
  intersects,
  lineHeight,
  outlinePath,
  strokeOutline,
  textFont,
  union,
  wrapText,
  type Box,
  type Shape,
} from './geometry.ts';
import { COMMONS_THEMES, currentTheme, type CommonsTokens } from '../theme/tokens.ts';
import { LOCAL, type RoomClient } from '../room/client.ts';

export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'note' | 'eraser';

interface Entry {
  item: Item;
  shape: Shape;
  lines?: string[];
}

interface RemoteLive {
  member: number;
  msg: LiveMsg;
  pts: number[];
  at: number;
}

interface Cam {
  x: number;
  y: number;
  z: number;
}

type Gesture =
  | { k: 'none' }
  | { k: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { k: 'pen'; key: number; pts: number[]; sent: number }
  | { k: 'shape'; key: number; shape: 'r' | 'e' | 'a'; x0: number; y0: number; x1: number; y1: number }
  | { k: 'move'; key: number; x0: number; y0: number; dx: number; dy: number; ids: string[] }
  | { k: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { k: 'erase'; lx: number; ly: number; trail: number[] }
  | { k: 'pinch'; d0: number; z0: number; mx: number; my: number; cx: number; cy: number };

export interface EngineEvents {
  /** The camera's zoom, for the zoom label. */
  zoom(z: number): void;
  selection(n: number): void;
  /** After placing text or a note, the tool goes back to select. */
  toolDone(): void;
  /** A frame took this long, ms (for the perf test). */
  frame?(ms: number): void;
}

const MIN_Z = 0.1;
const MAX_Z = 4;
const STALE_LIVE_MS = 5000;

export class BoardEngine {
  readonly base: HTMLCanvasElement;
  readonly over: HTMLCanvasElement;
  readonly cursorLayer: HTMLDivElement;
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private editor: HTMLTextAreaElement | null = null;

  cam: Cam = { x: 0, y: 0, z: 1 };
  tool: Tool = 'pen';
  color: Ink = 'ink';
  size: Size = 1;
  readOnly = true;

  private doc: Y.Doc | null = null;
  private items: Y.Map<Y.Map<unknown>> | null = null;
  private undo: Y.UndoManager | null = null;
  private entries = new Map<string, Entry>();
  private sorted: Entry[] = [];
  private selection = new Set<string>();
  private live = new Map<string, RemoteLive>();
  private hiddenRemote = new Map<string, { dx: number; dy: number; key: string }>();
  private editing: { id: string | null; k: 't' | 'n'; x: number; y: number } | null = null;

  private w = 0;
  private h = 0;
  private dpr = 1;
  private tokens: CommonsTokens = COMMONS_THEMES.light;
  private accent = '';
  private font = '"Inter Variable", system-ui, sans-serif';
  private baseDirty = true;
  private overDirty = true;
  private cursorsDirty = true;
  private raf = 0;
  private gesture: Gesture = { k: 'none' };
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private space = false;
  private pointerWorld: { x: number; y: number } | null = null;
  private cursorPending = false;
  private cursorEls = new Map<number, HTMLDivElement>();
  private unsubs: (() => void)[] = [];
  private ro: ResizeObserver;
  private mo: MutationObserver;
  private boardId: string | null = null;

  constructor(
    readonly host: HTMLElement,
    readonly client: RoomClient,
    private readonly ev: EngineEvents,
  ) {
    this.base = document.createElement('canvas');
    this.over = document.createElement('canvas');
    this.cursorLayer = document.createElement('div');
    this.base.className = 'ma-cm-canvas';
    this.over.className = 'ma-cm-canvas ma-cm-over';
    this.cursorLayer.className = 'ma-cm-cursors';
    this.over.setAttribute('aria-label', 'Whiteboard');
    this.over.setAttribute('role', 'img');
    host.append(this.base, this.over, this.cursorLayer);
    this.bctx = this.base.getContext('2d')!;
    this.octx = this.over.getContext('2d')!;

    this.readTheme();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.mo = new MutationObserver(() => {
      this.readTheme();
      this.invalidateAll();
    });
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    void document.fonts?.ready.then(() => this.invalidateAll());
    document.fonts?.addEventListener('loadingdone', this.onFonts);

    const o = this.over;
    o.addEventListener('pointerdown', this.onDown);
    o.addEventListener('pointermove', this.onMove);
    o.addEventListener('pointerup', this.onUp);
    o.addEventListener('pointercancel', this.onUp);
    o.addEventListener('pointerleave', this.onLeave);
    o.addEventListener('wheel', this.onWheel, { passive: false });
    o.addEventListener('dblclick', this.onDblClick);
    o.addEventListener('contextmenu', (e) => e.preventDefault());

    this.unsubs.push(client.onBoard((doc) => this.setDoc(doc)));
    this.unsubs.push(client.onCursors(() => this.markCursors()));
    this.unsubs.push(client.onLiveMsg((m, msg) => this.onLive(m, msg)));
    this.resize();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.mo.disconnect();
    document.fonts?.removeEventListener('loadingdone', this.onFonts);
    for (const u of this.unsubs) u();
    this.unobserve?.();
    this.undo?.destroy();
    this.closeEditor(true);
    this.base.remove();
    this.over.remove();
    this.cursorLayer.remove();
  }

  private onFonts = (): void => this.invalidateAll();

  private readTheme(): void {
    this.tokens = COMMONS_THEMES[currentTheme()];
    const cs = getComputedStyle(this.host);
    this.accent = cs.getPropertyValue('--ma-accent').trim() || this.tokens.ink.blue;
    const f = cs.getPropertyValue('--ma-font-ui').trim();
    if (f) this.font = f;
  }

  private invalidateAll(): void {
    if (this.items) for (const id of this.entries.keys()) this.rebuild(id);
    this.sort();
    this.baseDirty = this.overDirty = this.cursorsDirty = true;
    this.schedule();
  }

  // ------------------------------------------------------------------ doc
  private unobserve: (() => void) | null = null;

  private setDoc(doc: Y.Doc | null): void {
    this.unobserve?.();
    this.unobserve = null;
    this.undo?.destroy();
    this.undo = null;
    this.closeEditor(true);
    this.entries.clear();
    this.sorted = [];
    this.selection.clear();
    this.live.clear();
    this.hiddenRemote.clear();
    this.gesture = { k: 'none' };
    this.ev.selection(0);
    this.doc = doc;
    this.items = doc ? itemsOf(doc) : null;
    this.saveCam();
    this.boardId = this.client.state.active;
    if (this.items) {
      const items = this.items;
      const obs = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
        const changed = new Set<string>();
        for (const e of events) {
          if (e.target === items) for (const k of e.changes.keys.keys()) changed.add(k);
          else if (typeof e.path[0] === 'string') changed.add(e.path[0]);
        }
        for (const id of changed) this.rebuild(id);
        this.sort();
        for (const id of [...this.selection]) if (!this.entries.has(id)) this.selection.delete(id);
        this.ev.selection(this.selection.size);
        this.baseDirty = this.overDirty = true;
        this.schedule();
      };
      items.observeDeep(obs);
      this.unobserve = () => items.unobserveDeep(obs);
      for (const id of items.keys()) this.rebuild(id);
      this.sort();
      this.undo = new Y.UndoManager(items, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
    }
    this.restoreCam();
    this.baseDirty = this.overDirty = this.cursorsDirty = true;
    this.schedule();
  }

  /** Board loaded (all entries applied): frame the content if this member has no camera for it. */
  boardReady(): void {
    if (!this.hasSavedCam()) this.fit(false);
    this.invalidateAll();
  }

  private rebuild(id: string): void {
    const m = this.items?.get(id);
    const it = m ? readItem(id, m) : null;
    if (!it) {
      this.entries.delete(id);
      return;
    }
    const shape = buildShape(it, this.bctx, this.font);
    const e: Entry = { item: it, shape };
    if (it.k === 't') {
      this.bctx.font = textFont(TEXT_SIZE[it.s]!, this.font);
      e.lines = wrapText(this.bctx, it.tx ?? '', it.w);
    } else if (it.k === 'n') {
      this.bctx.font = textFont(NOTE_FONT, this.font);
      e.lines = wrapText(this.bctx, it.tx ?? '', it.w - NOTE_PAD * 2);
    }
    this.entries.set(id, e);
  }

  private sort(): void {
    this.sorted = [...this.entries.values()].sort((a, b) => a.item.z - b.item.z || (a.item.id < b.item.id ? -1 : 1));
  }

  get itemCount(): number {
    return this.entries.size;
  }

  // ------------------------------------------------------------------ camera
  private camKey(): string | null {
    return this.boardId ? `ma.commons.cam.${this.boardId}` : null;
  }
  private hasSavedCam(): boolean {
    const k = this.camKey();
    try {
      return !!(k && sessionStorage.getItem(k));
    } catch {
      return false;
    }
  }
  private saveCam(): void {
    const k = this.camKey();
    try {
      if (k) sessionStorage.setItem(k, JSON.stringify(this.cam));
    } catch {
      // Storage off: the camera just isn't remembered.
    }
  }
  private restoreCam(): void {
    const k = this.camKey();
    let c: Cam | null = null;
    try {
      c = k ? (JSON.parse(sessionStorage.getItem(k) ?? 'null') as Cam | null) : null;
    } catch {
      c = null;
    }
    if (c && Number.isFinite(c.x) && Number.isFinite(c.y) && c.z >= MIN_Z && c.z <= MAX_Z) this.cam = c;
    else this.cam = { x: -this.w / 2, y: -this.h / 2, z: 1 };
    this.ev.zoom(this.cam.z);
  }

  private camMoved(): void {
    this.baseDirty = this.overDirty = this.cursorsDirty = true;
    this.cursorPending = !!this.pointerWorld;
    this.positionEditor();
    this.ev.zoom(this.cam.z);
    this.schedule();
    clearTimeout(this.camSaveTimer);
    this.camSaveTimer = setTimeout(() => this.saveCam(), 300);
  }
  private camSaveTimer: ReturnType<typeof setTimeout> | undefined;

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / this.cam.z + this.cam.x, y: sy / this.cam.z + this.cam.y };
  }
  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.cam.x) * this.cam.z, y: (y - this.cam.y) * this.cam.z };
  }

  zoomAt(sx: number, sy: number, z: number): void {
    z = Math.max(MIN_Z, Math.min(MAX_Z, z));
    const w = this.toWorld(sx, sy);
    this.cam = { x: w.x - sx / z, y: w.y - sy / z, z };
    this.camMoved();
  }

  zoomBy(f: number): void {
    this.zoomAt(this.w / 2, this.h / 2, this.cam.z * f);
  }

  zoomTo(z: number): void {
    this.zoomAt(this.w / 2, this.h / 2, z);
  }

  /** Frames everything on the board, at no more than 100%. */
  fit(animate = true): void {
    void animate;
    let box: Box | null = null;
    for (const e of this.entries.values()) box = box ? union(box, e.shape.box) : { ...e.shape.box };
    if (!box || !this.w) {
      this.cam = { x: -this.w / 2, y: -this.h / 2, z: 1 };
      this.camMoved();
      return;
    }
    const pad = 64;
    const z = Math.max(MIN_Z, Math.min(1, (this.w - pad * 2) / (box.x1 - box.x0 || 1), (this.h - pad * 2) / (box.y1 - box.y0 || 1)));
    this.cam = { x: (box.x0 + box.x1) / 2 - this.w / 2 / z, y: (box.y0 + box.y1) / 2 - this.h / 2 / z, z };
    this.camMoved();
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    // Keep the board's centre where it was.
    if (this.w) {
      this.cam.x += (this.w - w) / 2 / this.cam.z;
      this.cam.y += (this.h - h) / 2 / this.cam.z;
    } else {
      this.cam = { x: -w / 2, y: -h / 2, z: 1 };
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    for (const c of [this.base, this.over]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.camMoved();
  }

  // ------------------------------------------------------------------ frames
  schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    const t0 = performance.now();
    if (this.cursorPending && this.pointerWorld && !this.readOnly) {
      this.client.sendCursor(this.pointerWorld.x, this.pointerWorld.y);
    }
    this.cursorPending = false;
    if (this.baseDirty) this.drawBase();
    if (this.overDirty) this.drawOver();
    if (this.cursorsDirty) this.drawCursors();
    this.baseDirty = this.overDirty = this.cursorsDirty = false;
    // Others' strokes that stopped arriving (they left mid-stroke) fade out.
    if (this.live.size) {
      const now = performance.now();
      for (const [k, l] of this.live) {
        if (now - l.at > STALE_LIVE_MS) {
          this.live.delete(k);
          this.dropRemoteHidden(k);
          this.overDirty = this.baseDirty = true;
        }
      }
      if (this.overDirty) this.schedule();
    }
    this.ev.frame?.(performance.now() - t0);
  };

  private viewBox(pad = 0): Box {
    const a = this.toWorld(-pad, -pad);
    const b = this.toWorld(this.w + pad, this.h + pad);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  private applyCam(ctx: CanvasRenderingContext2D): void {
    const s = this.dpr * this.cam.z;
    ctx.setTransform(s, 0, 0, s, -this.cam.x * s, -this.cam.y * s);
  }

  private drawBase(): void {
    const ctx = this.bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    this.drawGrid(ctx);
    this.applyCam(ctx);
    const vb = this.viewBox(8);
    const moving = this.gesture.k === 'move' ? new Set(this.gesture.ids) : null;
    for (const e of this.sorted) {
      const id = e.item.id;
      if (moving?.has(id) || this.hiddenRemote.has(id) || this.editing?.id === id) continue;
      if (!intersects(e.shape.box, vb)) continue;
      this.drawItem(ctx, e, 0, 0);
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const z = this.cam.z;
    let step = 24;
    while (step * z < 14) step *= 2;
    const r = Math.max(0.6, Math.min(1.2, z)) * this.dpr;
    ctx.fillStyle = this.tokens.grid;
    const vb = this.viewBox();
    const x0 = Math.floor(vb.x0 / step) * step;
    const y0 = Math.floor(vb.y0 / step) * step;
    const s = this.dpr * z;
    ctx.beginPath();
    for (let x = x0; x <= vb.x1; x += step) {
      const sx = (x - this.cam.x) * s;
      for (let y = y0; y <= vb.y1; y += step) {
        const sy = (y - this.cam.y) * s;
        ctx.rect(sx - r / 2, sy - r / 2, r, r);
      }
    }
    ctx.fill();
  }

  private drawItem(ctx: CanvasRenderingContext2D, e: Entry, dx: number, dy: number): void {
    const it = e.item;
    const ink = this.tokens.ink[it.c];
    if (dx || dy) {
      ctx.save();
      ctx.translate(dx, dy);
    }
    switch (it.k) {
      case 's':
        ctx.fillStyle = ink;
        ctx.fill(e.shape.fill!);
        break;
      case 'r':
      case 'e':
        ctx.strokeStyle = ink;
        ctx.lineWidth = e.shape.lineWidth;
        ctx.lineJoin = 'round';
        ctx.stroke(e.shape.line!);
        break;
      case 'a':
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
        ctx.lineWidth = e.shape.lineWidth;
        ctx.lineCap = 'round';
        ctx.stroke(e.shape.line!);
        ctx.fill(e.shape.fill!);
        break;
      case 't': {
        const size = TEXT_SIZE[it.s]!;
        const lh = lineHeight(size);
        ctx.font = textFont(size, this.font);
        ctx.fillStyle = ink;
        ctx.textBaseline = 'middle';
        e.lines?.forEach((l, i) => ctx.fillText(l, it.x, it.y + i * lh + lh / 2));
        break;
      }
      case 'n': {
        const r = 6;
        ctx.fillStyle = this.tokens.noteShadow;
        ctx.beginPath();
        ctx.roundRect(it.x, it.y + 3, it.w, it.h, r);
        ctx.fill();
        ctx.fillStyle = this.tokens.note[it.c];
        ctx.beginPath();
        ctx.roundRect(it.x, it.y, it.w, it.h, r);
        ctx.fill();
        if (e.lines?.length && it.tx) {
          const lh = lineHeight(NOTE_FONT);
          ctx.font = textFont(NOTE_FONT, this.font);
          ctx.fillStyle = this.tokens.noteText;
          ctx.textBaseline = 'middle';
          const max = Math.floor((it.h - NOTE_PAD * 2) / lh);
          e.lines.slice(0, max).forEach((l, i) => ctx.fillText(l, it.x + NOTE_PAD, it.y + NOTE_PAD + i * lh + lh / 2));
        }
        break;
      }
    }
    if (dx || dy) ctx.restore();
  }

  private drawOver(): void {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.over.width, this.over.height);
    this.applyCam(ctx);
    const z = this.cam.z;

    // Others' work in progress.
    for (const l of this.live.values()) this.drawLive(ctx, l.msg, l.pts);
    for (const [id, mv] of this.hiddenRemote) {
      const e = this.entries.get(id);
      if (e) this.drawItem(ctx, e, mv.dx, mv.dy);
    }

    const g = this.gesture;
    if (g.k === 'pen' && g.pts.length) {
      ctx.fillStyle = this.tokens.ink[this.color];
      ctx.fill(this.penPath(g.pts, PEN_WIDTH[this.size]!, false));
    } else if (g.k === 'shape') {
      this.drawShapePreview(ctx, g.shape, this.color, this.size, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);
    } else if (g.k === 'move') {
      for (const id of g.ids) {
        const e = this.entries.get(id);
        if (e) this.drawItem(ctx, e, g.dx, g.dy);
      }
    } else if (g.k === 'erase' && g.trail.length >= 4) {
      ctx.strokeStyle = this.tokens.eraser;
      ctx.lineWidth = 14 / z;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(g.trail[0]!, g.trail[1]!);
      for (let i = 2; i < g.trail.length; i += 2) ctx.lineTo(g.trail[i]!, g.trail[i + 1]!);
      ctx.stroke();
    }

    // Selection.
    if (this.selection.size && this.editing === null) {
      const off = g.k === 'move' ? { dx: g.dx, dy: g.dy } : { dx: 0, dy: 0 };
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1.5 / z;
      let all: Box | null = null;
      for (const id of this.selection) {
        const e = this.entries.get(id);
        if (!e) continue;
        const b = e.shape.box;
        all = all ? union(all, b) : { ...b };
        if (this.selection.size > 1) ctx.strokeRect(b.x0 + off.dx, b.y0 + off.dy, b.x1 - b.x0, b.y1 - b.y0);
      }
      if (all) {
        const p = 4 / z;
        ctx.setLineDash(this.selection.size > 1 ? [4 / z, 3 / z] : []);
        ctx.strokeRect(all.x0 - p + off.dx, all.y0 - p + off.dy, all.x1 - all.x0 + p * 2, all.y1 - all.y0 + p * 2);
        ctx.setLineDash([]);
      }
    }
    if (g.k === 'marquee') {
      ctx.fillStyle = this.tokens.marquee;
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1 / z;
      const x = Math.min(g.x0, g.x1);
      const y = Math.min(g.y0, g.y1);
      ctx.fillRect(x, y, Math.abs(g.x1 - g.x0), Math.abs(g.y1 - g.y0));
      ctx.strokeRect(x, y, Math.abs(g.x1 - g.x0), Math.abs(g.y1 - g.y0));
    }
  }

  private penPath(pts: number[], width: number, last: boolean): Path2D {
    if (pts.length <= 3) {
      const p = new Path2D();
      p.arc(pts[0]!, pts[1]!, width / 2, 0, Math.PI * 2);
      return p;
    }
    return outlinePath(strokeOutline(pts, width, last));
  }

  private drawShapePreview(
    ctx: CanvasRenderingContext2D,
    shape: 'r' | 'e' | 'a',
    c: Ink,
    s: Size,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const ink = this.tokens.ink[c];
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (shape === 'a') {
      const lw = LINE_WIDTH[s]! + 0.5;
      ctx.lineWidth = lw;
      const { line, head } = arrowShape(x, y, x + w, y + h, lw);
      ctx.stroke(line);
      ctx.fill(head);
      return;
    }
    ctx.lineWidth = LINE_WIDTH[s]!;
    const rx = Math.min(x, x + w);
    const ry = Math.min(y, y + h);
    const aw = Math.abs(w);
    const ah = Math.abs(h);
    ctx.beginPath();
    if (shape === 'r') ctx.roundRect(rx, ry, aw, ah, Math.min(8, aw / 4, ah / 4));
    else ctx.ellipse(rx + aw / 2, ry + ah / 2, aw / 2, ah / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawLive(ctx: CanvasRenderingContext2D, m: LiveMsg, pts: number[]): void {
    if (m.kind === 1 && pts.length) {
      ctx.fillStyle = this.tokens.ink[m.c];
      ctx.fill(this.penPath(pts, PEN_WIDTH[m.s]!, false));
    } else if (m.kind === 2) {
      this.drawShapePreview(ctx, m.shape, m.c, m.s, m.x, m.y, m.w, m.h);
    }
  }

  private markCursors(): void {
    this.cursorsDirty = true;
    this.schedule();
  }

  private drawCursors(): void {
    const seen = new Set<number>();
    for (const [i, c] of this.client.cursors) {
      const m = this.client.member(i);
      if (!m) continue;
      seen.add(i);
      let el = this.cursorEls.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ma-cm-cursor';
        el.innerHTML =
          '<svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M1.5 1.5 L14 9.2 L8.2 10.3 L5.2 16 Z"/></svg><span></span>';
        this.cursorLayer.append(el);
        this.cursorEls.set(i, el);
      }
      el.style.setProperty('--ma-cm-c', `var(--ma-cm-member-${m.color})`);
      const label = el.querySelector('span')!;
      if (label.textContent !== m.name) label.textContent = m.name;
      const s = this.toScreen(c.x, c.y);
      const off = s.x < -20 || s.y < -20 || s.x > this.w + 20 || s.y > this.h + 20;
      el.style.display = off ? 'none' : '';
      el.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`;
    }
    for (const [i, el] of this.cursorEls) {
      if (!seen.has(i)) {
        el.remove();
        this.cursorEls.delete(i);
      }
    }
  }

  // ------------------------------------------------------------------ others' live work
  private onLive(member: number, m: LiveMsg): void {
    const key = `${member}:${m.key}`;
    if (m.kind === 4) {
      this.live.delete(key);
      this.dropRemoteHidden(key);
    } else if (m.kind === 3) {
      for (const id of m.ids) this.hiddenRemote.set(id, { dx: m.dx, dy: m.dy, key });
      this.live.set(key, { member, msg: m, pts: [], at: performance.now() });
      this.baseDirty = true;
    } else {
      const l = this.live.get(key);
      if (m.kind === 1 && l && l.msg.kind === 1) {
        l.pts.push(...m.pts);
        l.at = performance.now();
      } else {
        this.live.set(key, { member, msg: m, pts: m.kind === 1 ? [...m.pts] : [], at: performance.now() });
      }
    }
    this.overDirty = true;
    this.schedule();
  }

  private dropRemoteHidden(key: string): void {
    for (const [id, h] of this.hiddenRemote) {
      if (h.key === key) {
        this.hiddenRemote.delete(id);
        this.baseDirty = true;
      }
    }
  }

  // ------------------------------------------------------------------ input
  private local(e: PointerEvent | MouseEvent): { sx: number; sy: number; x: number; y: number } {
    const r = this.over.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const w = this.toWorld(sx, sy);
    return { sx, sy, x: w.x, y: w.y };
  }

  private hitTop(x: number, y: number): Entry | null {
    const tol = 4 / this.cam.z;
    for (let i = this.sorted.length - 1; i >= 0; i--) {
      const e = this.sorted[i]!;
      if (hitItem(e.item, e.shape.box, x, y, tol)) return e;
    }
    return null;
  }

  private pressure(e: PointerEvent): number {
    return e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
  }

  private onDown = (e: PointerEvent): void => {
    // Focus is ours to place: the board, or the text editor a click opens.
    e.preventDefault();
    this.host.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const p = this.local(e);
    // Two fingers: pinch to zoom and pan, whatever the tool.
    if (this.pointers.size === 2 && e.pointerType === 'touch') {
      this.cancelGesture();
      const [a, b] = [...this.pointers.values()];
      const r = this.over.getBoundingClientRect();
      const mx = (a!.x + b!.x) / 2 - r.left;
      const my = (a!.y + b!.y) / 2 - r.top;
      const w = this.toWorld(mx, my);
      this.gesture = { k: 'pinch', d0: Math.hypot(a!.x - b!.x, a!.y - b!.y), z0: this.cam.z, mx, my, cx: w.x, cy: w.y };
      return;
    }
    if (this.pointers.size > 1) return;
    if (this.editing) this.closeEditor(false);
    this.over.setPointerCapture(e.pointerId);
    const pan = e.button === 1 || this.space || this.tool === 'hand' || (this.readOnly && e.button === 0);
    if (pan) {
      this.gesture = { k: 'pan', sx: p.sx, sy: p.sy, cx: this.cam.x, cy: this.cam.y };
      this.host.dataset['panning'] = '1';
      return;
    }
    if (e.button !== 0) return;
    const key = (Math.random() * 0xffffffff) >>> 0;
    switch (this.tool) {
      case 'pen': {
        const pts = [p.x, p.y, this.pressure(e)];
        this.gesture = { k: 'pen', key, pts, sent: 0 };
        this.flushPen();
        break;
      }
      case 'rect':
      case 'ellipse':
      case 'arrow':
        this.gesture = { k: 'shape', key, shape: this.tool === 'rect' ? 'r' : this.tool === 'ellipse' ? 'e' : 'a', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        break;
      case 'eraser':
        this.gesture = { k: 'erase', lx: p.x, ly: p.y, trail: [p.x, p.y] };
        this.eraseAlong(p.x, p.y, p.x, p.y);
        break;
      case 'text': {
        const hit = this.hitTop(p.x, p.y);
        if (hit && hit.item.k === 't') this.openEditor(hit.item.id, 't', hit.item.x, hit.item.y);
        else this.openEditor(null, 't', p.x, p.y - lineHeight(TEXT_SIZE[this.size]!) / 2);
        break;
      }
      case 'note': {
        const hit = this.hitTop(p.x, p.y);
        if (hit && hit.item.k === 'n') {
          this.openEditor(hit.item.id, 'n', hit.item.x, hit.item.y);
        } else {
          const x = p.x - NOTE_SIZE / 2;
          const y = p.y - NOTE_SIZE / 2;
          let id = '';
          this.transact(() => {
            id = putItem(this.doc!, { k: 'n', x, y, w: NOTE_SIZE, h: NOTE_SIZE, c: this.color === 'ink' ? 'amber' : this.color, s: 1, z: topZ(), tx: '' });
          });
          this.openEditor(id, 'n', x, y);
        }
        this.tool = 'select';
        this.host.dataset['tool'] = 'select';
        this.ev.toolDone();
        break;
      }
      case 'select': {
        const hit = this.hitTop(p.x, p.y);
        if (hit) {
          if (e.shiftKey) {
            if (this.selection.has(hit.item.id)) this.selection.delete(hit.item.id);
            else this.selection.add(hit.item.id);
          } else if (!this.selection.has(hit.item.id)) {
            this.selection = new Set([hit.item.id]);
          }
          this.ev.selection(this.selection.size);
          if (this.selection.has(hit.item.id)) {
            this.gesture = { k: 'move', key, x0: p.x, y0: p.y, dx: 0, dy: 0, ids: [...this.selection] };
            this.baseDirty = true;
          }
        } else {
          if (!e.shiftKey) this.selection.clear();
          this.ev.selection(this.selection.size);
          this.gesture = { k: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey };
        }
        break;
      }
    }
    this.overDirty = true;
    this.schedule();
  };

  private onMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (prev) {
      prev.x = e.clientX;
      prev.y = e.clientY;
    }
    const p = this.local(e);
    this.pointerWorld = { x: p.x, y: p.y };
    if (!this.readOnly) {
      this.cursorPending = true;
      this.schedule();
    }
    const g = this.gesture;
    switch (g.k) {
      case 'none':
        return;
      case 'pinch': {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) return;
        const r = this.over.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r.left;
        const my = (a.y + b.y) / 2 - r.top;
        const z = Math.max(MIN_Z, Math.min(MAX_Z, (g.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / (g.d0 || 1)));
        this.cam = { x: g.cx - mx / z, y: g.cy - my / z, z };
        this.camMoved();
        return;
      }
      case 'pan':
        this.cam = { ...this.cam, x: g.cx - (p.sx - g.sx) / this.cam.z, y: g.cy - (p.sy - g.sy) / this.cam.z };
        this.camMoved();
        return;
      case 'pen': {
        // Every sample since the last event, so fast strokes stay smooth.
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
        const minD = 0.75 / this.cam.z;
        for (const ce of evs.length ? evs : [e]) {
          const q = this.local(ce);
          const n = g.pts.length;
          if (Math.hypot(q.x - g.pts[n - 3]!, q.y - g.pts[n - 2]!) < minD) continue;
          g.pts.push(q.x, q.y, this.pressure(ce));
        }
        this.flushPen();
        break;
      }
      case 'shape': {
        g.x1 = p.x;
        g.y1 = p.y;
        if (e.shiftKey) {
          // Square, circle, or an arrow at 45° steps.
          const dx = g.x1 - g.x0;
          const dy = g.y1 - g.y0;
          if (g.shape === 'a') {
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            g.x1 = g.x0 + Math.cos(ang) * len;
            g.y1 = g.y0 + Math.sin(ang) * len;
          } else {
            const s = Math.max(Math.abs(dx), Math.abs(dy));
            g.x1 = g.x0 + Math.sign(dx || 1) * s;
            g.y1 = g.y0 + Math.sign(dy || 1) * s;
          }
        }
        this.client.sendLive({ kind: 2, key: g.key, shape: g.shape, c: this.color, s: this.size, x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 });
        break;
      }
      case 'move':
        g.dx = p.x - g.x0;
        g.dy = p.y - g.y0;
        this.client.sendLive({ kind: 3, key: g.key, dx: g.dx, dy: g.dy, ids: g.ids });
        break;
      case 'marquee':
        g.x1 = p.x;
        g.y1 = p.y;
        break;
      case 'erase':
        this.eraseAlong(g.lx, g.ly, p.x, p.y);
        g.lx = p.x;
        g.ly = p.y;
        g.trail.push(p.x, p.y);
        if (g.trail.length > 40) g.trail.splice(0, 2);
        break;
    }
    this.overDirty = true;
    this.schedule();
  };

  private flushPen(): void {
    const g = this.gesture;
    if (g.k !== 'pen') return;
    const n = g.pts.length;
    if (n > g.sent) {
      this.client.sendLive({ kind: 1, key: g.key, c: this.color, s: this.size, pts: g.pts.slice(g.sent, n) });
      g.sent = n;
    }
  }

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (g.k === 'pinch') {
      if (this.pointers.size < 2) this.gesture = { k: 'none' };
      return;
    }
    if (this.over.hasPointerCapture(e.pointerId)) this.over.releasePointerCapture(e.pointerId);
    delete this.host.dataset['panning'];
    this.gesture = { k: 'none' };
    switch (g.k) {
      case 'pen': {
        const { x, y, p } = packStroke(g.pts);
        this.transact(() => putItem(this.doc!, { k: 's', x, y, w: 0, h: 0, c: this.color, s: this.size, z: topZ(), p }));
        this.client.sendLive({ kind: 4, key: g.key });
        break;
      }
      case 'shape': {
        const w = g.x1 - g.x0;
        const h = g.y1 - g.y0;
        if (Math.hypot(w, h) * this.cam.z >= 4) {
          const k = g.shape;
          this.transact(() => putItem(this.doc!, { k, x: g.x0, y: g.y0, w, h, c: this.color, s: this.size, z: topZ() }));
        }
        this.client.sendLive({ kind: 4, key: g.key });
        break;
      }
      case 'move': {
        if (g.dx || g.dy) {
          this.transact(() => {
            for (const id of g.ids) {
              const m = this.items?.get(id);
              if (!m) continue;
              m.set('x', (m.get('x') as number) + g.dx);
              m.set('y', (m.get('y') as number) + g.dy);
            }
          });
        }
        this.client.sendLive({ kind: 4, key: g.key });
        this.baseDirty = true;
        break;
      }
      case 'marquee': {
        const box: Box = { x0: Math.min(g.x0, g.x1), y0: Math.min(g.y0, g.y1), x1: Math.max(g.x0, g.x1), y1: Math.max(g.y0, g.y1) };
        if (box.x1 - box.x0 > 1 || box.y1 - box.y0 > 1) {
          for (const en of this.entries.values()) {
            const b = en.shape.box;
            if (b.x0 >= box.x0 && b.y0 >= box.y0 && b.x1 <= box.x1 && b.y1 <= box.y1) this.selection.add(en.item.id);
          }
        }
        this.ev.selection(this.selection.size);
        break;
      }
    }
    this.overDirty = true;
    this.schedule();
  };

  private onLeave = (): void => {
    if (this.gesture.k === 'none') {
      this.pointerWorld = null;
      if (!this.readOnly) this.client.hideCursor();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      // Pinch on a trackpad arrives as ctrl+wheel.
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      this.zoomAt(p.sx, p.sy, this.cam.z * f);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.cam = { ...this.cam, x: this.cam.x + (dx * k) / this.cam.z, y: this.cam.y + (dy * k) / this.cam.z };
      this.camMoved();
    }
  };

  private onDblClick = (e: MouseEvent): void => {
    if (this.readOnly || this.tool !== 'select') return;
    const p = this.local(e);
    const hit = this.hitTop(p.x, p.y);
    if (hit && (hit.item.k === 't' || hit.item.k === 'n')) this.openEditor(hit.item.id, hit.item.k, hit.item.x, hit.item.y);
  };

  private cancelGesture(): void {
    const g = this.gesture;
    if (g.k === 'pen' || g.k === 'shape' || g.k === 'move') this.client.sendLive({ kind: 4, key: g.key });
    this.gesture = { k: 'none' };
    this.baseDirty = this.overDirty = true;
    this.schedule();
  }

  private transact(fn: () => void): void {
    if (!this.doc || this.readOnly) return;
    this.doc.transact(fn, LOCAL);
  }

  private eraseAlong(ax: number, ay: number, bx: number, by: number): void {
    const tol = 7 / this.cam.z;
    const segBox: Box = emptyBox();
    segBox.x0 = Math.min(ax, bx) - tol;
    segBox.y0 = Math.min(ay, by) - tol;
    segBox.x1 = Math.max(ax, bx) + tol;
    segBox.y1 = Math.max(ay, by) + tol;
    const hits: string[] = [];
    for (const e of this.sorted) {
      if (!intersects(e.shape.box, segBox)) continue;
      // Rectangles and notes erase from their edge or body; text from anywhere in it.
      if (hitSegment(e.item, e.shape.box, ax, ay, bx, by, tol)) hits.push(e.item.id);
    }
    if (hits.length) this.transact(() => hits.forEach((id) => this.items?.delete(id)));
  }

  // ------------------------------------------------------------------ keyboard (from the UI)
  setSpace(down: boolean): void {
    this.space = down;
    if (down) this.host.dataset['space'] = '1';
    else delete this.host.dataset['space'];
  }

  deleteSelection(): void {
    if (!this.selection.size) return;
    const ids = [...this.selection];
    this.transact(() => ids.forEach((id) => this.items?.delete(id)));
    this.selection.clear();
    this.ev.selection(0);
  }

  selectAll(): void {
    this.selection = new Set(this.entries.keys());
    this.ev.selection(this.selection.size);
    this.overDirty = true;
    this.schedule();
  }

  clearSelection(): void {
    if (this.editing) this.closeEditor(false);
    this.cancelGesture();
    this.selection.clear();
    this.ev.selection(0);
  }

  /** Recolors or resizes the selection: the toolbar's color and size act on it too. */
  styleSelection(c: Ink | null, s: Size | null): void {
    if (!this.selection.size) return;
    this.transact(() => {
      for (const id of this.selection) {
        const m = this.items?.get(id);
        if (!m) continue;
        if (c) m.set('c', c);
        if (s !== null && m.get('k') !== 'n') m.set('s', s);
      }
    });
  }

  undoLast(): void {
    this.undo?.undo();
  }
  redoLast(): void {
    this.undo?.redo();
  }

  setReadOnly(ro: boolean): void {
    this.readOnly = ro;
    if (ro) {
      this.cancelGesture();
      this.closeEditor(false);
      this.selection.clear();
      this.ev.selection(0);
    }
    this.host.dataset['readonly'] = ro ? '1' : '0';
  }

  setTool(t: Tool): void {
    if (t !== this.tool && this.editing) this.closeEditor(false);
    this.tool = t;
    this.host.dataset['tool'] = t;
    if (t !== 'select') {
      this.selection.clear();
      this.ev.selection(0);
      this.overDirty = true;
      this.schedule();
    }
  }

  // ------------------------------------------------------------------ text editor
  private openEditor(id: string | null, k: 't' | 'n', x: number, y: number): void {
    if (this.readOnly) return;
    this.closeEditor(false);
    this.editing = { id, k, x, y };
    const ta = document.createElement('textarea');
    ta.className = `ma-cm-editor ma-cm-editor-${k}`;
    ta.spellcheck = true;
    ta.setAttribute('aria-label', k === 'n' ? 'Note text' : 'Text');
    const it = id ? this.entries.get(id)?.item : undefined;
    ta.value = it?.tx ?? '';
    if (k === 'n') {
      const c = it?.c ?? 'amber';
      ta.style.setProperty('--ma-cm-note', `var(--ma-cm-note-${c})`);
    } else {
      ta.style.setProperty('--ma-cm-ink', `var(--ma-cm-ink-${it?.c ?? this.color})`);
    }
    ta.addEventListener('input', () => this.editorInput());
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.closeEditor(false);
        this.host.focus();
      }
    });
    ta.addEventListener('blur', () => {
      if (this.editor === ta) this.closeEditor(false);
    });
    this.host.append(ta);
    this.editor = ta;
    this.positionEditor();
    this.baseDirty = true;
    this.schedule();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  private editorInput(): void {
    const ed = this.editing;
    const ta = this.editor;
    if (!ed || !ta || !this.doc) return;
    const text = ta.value;
    if (!ed.id) {
      if (!text) return;
      this.transact(() => {
        ed.id = putItem(this.doc!, { k: 't', x: ed.x, y: ed.y, w: 0, h: 0, c: this.color, s: this.size, z: topZ(), tx: text });
      });
    } else {
      const m = this.items?.get(ed.id);
      if (m) this.transact(() => m.set('tx', text));
    }
    this.positionEditor();
  }

  private positionEditor(): void {
    const ed = this.editing;
    const ta = this.editor;
    if (!ed || !ta) return;
    const z = this.cam.z;
    const s = this.toScreen(ed.x, ed.y);
    ta.style.transform = `translate(${s.x}px, ${s.y}px) scale(${z})`;
    if (ed.k === 'n') {
      const it = ed.id ? this.entries.get(ed.id)?.item : undefined;
      ta.style.width = `${it?.w ?? NOTE_SIZE}px`;
      ta.style.height = `${it?.h ?? NOTE_SIZE}px`;
    } else {
      const it = ed.id ? this.entries.get(ed.id)?.item : undefined;
      const size = TEXT_SIZE[it?.s ?? this.size]!;
      ta.style.fontSize = `${size}px`;
      ta.style.lineHeight = `${lineHeight(size)}px`;
      ta.style.height = '0px';
      ta.style.height = `${Math.max(lineHeight(size), ta.scrollHeight)}px`;
      ta.style.width = '0px';
      ta.style.width = `${Math.max(size * 2, ta.scrollWidth + size)}px`;
    }
  }

  private closeEditor(silent: boolean): void {
    const ed = this.editing;
    const ta = this.editor;
    this.editing = null;
    this.editor = null;
    ta?.remove();
    if (!ed || silent) return;
    // Text left empty goes; an empty note stays, as a note.
    if (ed.id && ed.k === 't') {
      const m = this.items?.get(ed.id);
      if (m && !String(m.get('tx') ?? '').trim()) this.transact(() => this.items?.delete(ed.id!));
    }
    this.baseDirty = this.overDirty = true;
    this.schedule();
  }

  // ------------------------------------------------------------------ for tests
  /** Draws a stroke from board points as if a member drew it (perf fixtures). */
  addStroke(pts: number[], c: Ink = 'ink', s: Size = 1): void {
    const { x, y, p } = packStroke(pts);
    this.transact(() => putItem(this.doc!, { k: 's', x, y, w: 0, h: 0, c, s, z: topZ(), p }));
  }

  /** A heavy board in one go, for the perf script: n strokes, and a note and a rectangle per 20. */
  fixture(n: number): void {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    // In transactions of 100, as members' updates would come, under the server's 1 MB per update.
    for (let at = 0; at < n; at += 100) this.transact(() => {
      for (let i = at; i < Math.min(n, at + 100); i++) {
        const pts: number[] = [];
        let x = rnd() * 4000 - 2000;
        let y = rnd() * 2600 - 1300;
        for (let j = 0; j < 40; j++) {
          x += rnd() * 16 - 4;
          y += rnd() * 16 - 8;
          pts.push(x, y, 0.5);
        }
        const st = packStroke(pts);
        putItem(this.doc!, { k: 's', ...st, w: 0, h: 0, c: INKS[i % INKS.length]!, s: (i % 3) as Size, z: i });
        if (i % 20 === 0) {
          putItem(this.doc!, { k: 'n', x: rnd() * 4000 - 2000, y: rnd() * 2600 - 1300, w: NOTE_SIZE, h: NOTE_SIZE, c: 'amber', s: 1, z: n + i, tx: `Note ${i}: a few words to wrap across lines` });
          putItem(this.doc!, { k: 'r', x: rnd() * 4000 - 2000, y: rnd() * 2600 - 1300, w: 160, h: 90, c: 'blue', s: 1, z: n + i + 1 });
        }
      }
    });
  }
}
