// Shapes for drawing and hit tests. Every path is in board units and cached per item revision, so a
// frame only sets the camera's transform and fills paths.
import { getStroke } from 'perfect-freehand';
import type { Item } from './model.ts';
import { LINE_WIDTH, NOTE_TEXT, PEN_WIDTH, TEXT_SIZE } from './model.ts';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

export function grow(b: Box, x: number, y: number, r = 0): void {
  if (x - r < b.x0) b.x0 = x - r;
  if (y - r < b.y0) b.y0 = y - r;
  if (x + r > b.x1) b.x1 = x + r;
  if (y + r > b.y1) b.y1 = y + r;
}

export function intersects(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** perfect-freehand's outline for a stroke's points (absolute triples). */
export function strokeOutline(pts: ArrayLike<number>, width: number, last: boolean): number[][] {
  const input: number[][] = [];
  let pressure = false;
  for (let i = 0; i < pts.length; i += 3) {
    const p = pts[i + 2]!;
    if (p !== 0.5) pressure = true;
    input.push([pts[i]!, pts[i + 1]!, p]);
  }
  return getStroke(input, {
    size: width,
    thinning: pressure ? 0.6 : 0.5,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: !pressure,
    last,
  });
}

export function outlinePath(outline: number[][], path = new Path2D()): Path2D {
  if (!outline.length) return path;
  const [f] = outline;
  path.moveTo(f![0]!, f![1]!);
  // Quadratic curves through the midpoints: smooth at any zoom for a few points' cost.
  for (let i = 1; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    path.quadraticCurveTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  path.closePath();
  return path;
}

/** A dot for a click without a drag. */
function dot(x: number, y: number, r: number): Path2D {
  const p = new Path2D();
  p.arc(x, y, r, 0, Math.PI * 2);
  return p;
}

export interface Shape {
  /** Filled for strokes and arrowheads, stroked for shapes. */
  fill?: Path2D;
  line?: Path2D;
  lineWidth: number;
  box: Box;
}

export function absPoints(it: Item): number[] {
  const p = it.p;
  if (!p) return [];
  const out: number[] = new Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i]! + it.x;
    out[i + 1] = p[i + 1]! + it.y;
    out[i + 2] = p[i + 2]!;
  }
  return out;
}

export function arrowShape(x: number, y: number, x2: number, y2: number, width: number): { line: Path2D; head: Path2D } {
  const line = new Path2D();
  const ang = Math.atan2(y2 - y, x2 - x);
  const len = Math.hypot(x2 - x, y2 - y);
  const hl = Math.min(len * 0.5, 10 + width * 3);
  // Stop the line short of the tip so its cap doesn't poke through the head.
  const ex = x2 - Math.cos(ang) * hl * 0.6;
  const ey = y2 - Math.sin(ang) * hl * 0.6;
  line.moveTo(x, y);
  line.lineTo(ex, ey);
  const head = new Path2D();
  const spread = 0.42;
  head.moveTo(x2, y2);
  head.lineTo(x2 - Math.cos(ang - spread) * hl, y2 - Math.sin(ang - spread) * hl);
  head.lineTo(x2 - Math.cos(ang + spread) * hl, y2 - Math.sin(ang + spread) * hl);
  head.closePath();
  return { line, head };
}

/** Text lines wrapped to a width, measured with ctx (already set to the right font). */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (width <= 0) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && ctx.measureText(next).width > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

export function textFont(size: number, family: string, weight = 500): string {
  return `${weight} ${size}px ${family}`;
}

export function lineHeight(size: number): number {
  return Math.round(size * 1.35);
}

/** Builds an item's paths and bounding box. Text and notes are drawn as text each frame. */
export function buildShape(it: Item, ctx: CanvasRenderingContext2D, family: string): Shape {
  const box = emptyBox();
  switch (it.k) {
    case 's': {
      const pts = absPoints(it);
      const width = PEN_WIDTH[it.s]!;
      if (pts.length <= 3) {
        const r = width / 2;
        grow(box, pts[0] ?? it.x, pts[1] ?? it.y, r + 1);
        return { fill: dot(pts[0] ?? it.x, pts[1] ?? it.y, r), lineWidth: 0, box };
      }
      const outline = strokeOutline(pts, width, true);
      for (const [x, y] of outline) grow(box, x!, y!, 1);
      return { fill: outlinePath(outline), lineWidth: 0, box };
    }
    case 'r':
    case 'e': {
      const lw = LINE_WIDTH[it.s]!;
      const x = Math.min(it.x, it.x + it.w);
      const y = Math.min(it.y, it.y + it.h);
      const w = Math.abs(it.w);
      const h = Math.abs(it.h);
      const line = new Path2D();
      if (it.k === 'r') line.roundRect(x, y, w, h, Math.min(8, w / 4, h / 4));
      else line.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      grow(box, x, y, lw);
      grow(box, x + w, y + h, lw);
      return { line, lineWidth: lw, box };
    }
    case 'a': {
      const lw = LINE_WIDTH[it.s]! + 0.5;
      const { line, head } = arrowShape(it.x, it.y, it.x + it.w, it.y + it.h, lw);
      const pad = 10 + lw * 3;
      grow(box, it.x, it.y, pad);
      grow(box, it.x + it.w, it.y + it.h, pad);
      return { line, fill: head, lineWidth: lw, box };
    }
    case 't': {
      const size = TEXT_SIZE[it.s]!;
      ctx.font = textFont(size, family);
      const lines = wrapText(ctx, it.tx ?? '', it.w);
      let w = it.w;
      if (w <= 0) for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
      grow(box, it.x, it.y, 2);
      grow(box, it.x + Math.max(w, size), it.y + lines.length * lineHeight(size), 2);
      return { lineWidth: 0, box };
    }
    case 'n': {
      grow(box, it.x, it.y, 6);
      grow(box, it.x + it.w, it.y + it.h, 10);
      return { lineWidth: 0, box };
    }
  }
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does a point (board units) touch the item, within tol? */
export function hitItem(it: Item, box: Box, x: number, y: number, tol: number): boolean {
  if (x < box.x0 - tol || x > box.x1 + tol || y < box.y0 - tol || y > box.y1 + tol) return false;
  switch (it.k) {
    case 's': {
      const p = it.p;
      if (!p) return false;
      const r = PEN_WIDTH[it.s]! / 2 + tol;
      if (p.length <= 3) return Math.hypot(x - it.x - p[0]!, y - it.y - p[1]!) <= r;
      for (let i = 3; i < p.length; i += 3) {
        if (distToSeg(x, y, it.x + p[i - 3]!, it.y + p[i - 2]!, it.x + p[i]!, it.y + p[i + 1]!) <= r) return true;
      }
      return false;
    }
    case 'a':
      return distToSeg(x, y, it.x, it.y, it.x + it.w, it.y + it.h) <= LINE_WIDTH[it.s]! / 2 + tol + 2;
    case 'e': {
      const cx = it.x + it.w / 2;
      const cy = it.y + it.h / 2;
      const rx = Math.abs(it.w / 2) + tol;
      const ry = Math.abs(it.h / 2) + tol;
      return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    }
    default:
      return true; // rectangles, notes and text: anywhere in the box
  }
}

/** Does a segment (an eraser's move) touch the item? Sampled every few units along it. */
export function hitSegment(it: Item, box: Box, ax: number, ay: number, bx: number, by: number, tol: number): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(2, tol)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (hitItem(it, box, ax + (bx - ax) * t, ay + (by - ay) * t, tol)) return true;
  }
  return false;
}

export const NOTE_PAD = 16;
export const NOTE_FONT = NOTE_TEXT;
