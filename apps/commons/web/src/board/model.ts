// A board is one Y.Doc. Its items live in the map `items`, keyed by id, each a Y.Map of the
// fields below, so two members can move and recolor one item at once and both changes keep.
// Colors are stored by name and drawn from the viewer's theme (src/theme/tokens.ts).
import * as Y from 'yjs';

export type Kind = 's' | 'r' | 'e' | 'a' | 't' | 'n';
export const INKS = ['ink', 'blue', 'green', 'amber', 'red', 'violet'] as const;
export type Ink = (typeof INKS)[number];
export type Size = 0 | 1 | 2;

/** Pen width, shape line and text size by size step, in board units (CSS px at 100%). */
export const PEN_WIDTH: readonly number[] = [3, 6, 12];
export const LINE_WIDTH: readonly number[] = [1.5, 2.5, 4];
export const TEXT_SIZE: readonly number[] = [16, 24, 40];
export const NOTE_SIZE = 200;
export const NOTE_TEXT = 16;

/** An item as the renderer sees it: plain values, read once per change. */
export interface Item {
  id: string;
  k: Kind;
  x: number;
  y: number;
  /** Size for shapes, notes and text wrap; for an arrow, the end point relative to x, y. */
  w: number;
  h: number;
  c: Ink;
  s: Size;
  z: number;
  /** Stroke points relative to x, y: Float32 triples (x, y, pressure). */
  p?: Float32Array;
  tx?: string;
}

export const ITEMS = 'items';

export function itemsOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(ITEMS);
}

export function readItem(id: string, m: Y.Map<unknown>): Item | null {
  const k = m.get('k');
  if (typeof k !== 'string' || !'sreatn'.includes(k) || k.length !== 1) return null;
  const num = (key: string, d = 0): number => {
    const v = m.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const c = m.get('c');
  const item: Item = {
    id,
    k: k as Kind,
    x: num('x'),
    y: num('y'),
    w: num('w'),
    h: num('h'),
    c: INKS.includes(c as Ink) ? (c as Ink) : 'ink',
    s: Math.max(0, Math.min(2, Math.round(num('s', 1)))) as Size,
    z: num('z'),
  };
  const p = m.get('p');
  if (p instanceof Uint8Array && p.byteLength % 12 === 0) {
    // Copy into an aligned buffer: Yjs may hand back a view at any offset.
    item.p = new Float32Array(p.slice().buffer);
  }
  const tx = m.get('tx');
  if (typeof tx === 'string') item.tx = tx;
  return item;
}

export function newId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

/** The next z on top of everything, without needing to know what's there: time, plus a tiebreak. */
export function topZ(): number {
  return Date.now() + Math.random();
}

/** Writes a new item. Call inside a transaction with the local origin. */
export function putItem(doc: Y.Doc, item: Omit<Item, 'id'> & { id?: string }): string {
  const id = item.id ?? newId();
  const m = new Y.Map<unknown>();
  m.set('k', item.k);
  m.set('x', item.x);
  m.set('y', item.y);
  m.set('w', item.w);
  m.set('h', item.h);
  m.set('c', item.c);
  m.set('s', item.s);
  m.set('z', item.z);
  if (item.p) m.set('p', new Uint8Array(item.p.buffer, item.p.byteOffset, item.p.byteLength).slice());
  if (item.tx !== undefined) m.set('tx', item.tx);
  itemsOf(doc).set(id, m);
  return id;
}

/** Points to a stroke: origin at the first point, Float32 triples. */
export function packStroke(pts: readonly number[]): { x: number; y: number; p: Float32Array } {
  const x = pts[0] ?? 0;
  const y = pts[1] ?? 0;
  const p = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    p[i] = pts[i]! - x;
    p[i + 1] = pts[i + 1]! - y;
    p[i + 2] = pts[i + 2]!;
  }
  return { x, y, p };
}
