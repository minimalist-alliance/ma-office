// Work in progress, shown to the room as it happens but never stored: a stroke being drawn, a
// shape being dragged out, items being moved. The finished result arrives as a board update.
// Binary, little-endian; the server relays it untouched with the sender's member index in front.
import type { Ink, Size } from './model.ts';
import { INKS } from './model.ts';

export const LIVE = { stroke: 1, shape: 2, move: 3, end: 4 } as const;

export type LiveMsg =
  | { kind: 1; key: number; c: Ink; s: Size; pts: number[] } // points appended since the last
  | { kind: 2; key: number; shape: 'r' | 'e' | 'a'; c: Ink; s: Size; x: number; y: number; w: number; h: number }
  | { kind: 3; key: number; dx: number; dy: number; ids: string[] }
  | { kind: 4; key: number };

const SHAPES = ['r', 'e', 'a'] as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeLive(m: LiveMsg): Uint8Array {
  switch (m.kind) {
    case 1: {
      const n = m.pts.length / 3;
      const b = new Uint8Array(9 + n * 9);
      const dv = new DataView(b.buffer);
      b[0] = 1;
      dv.setUint32(1, m.key, true);
      b[5] = INKS.indexOf(m.c);
      b[6] = m.s;
      dv.setUint16(7, n, true);
      for (let i = 0; i < n; i++) {
        dv.setFloat32(9 + i * 9, m.pts[i * 3]!, true);
        dv.setFloat32(13 + i * 9, m.pts[i * 3 + 1]!, true);
        b[17 + i * 9] = Math.round(Math.max(0, Math.min(1, m.pts[i * 3 + 2]!)) * 255);
      }
      return b;
    }
    case 2: {
      const b = new Uint8Array(24);
      const dv = new DataView(b.buffer);
      b[0] = 2;
      dv.setUint32(1, m.key, true);
      b[5] = SHAPES.indexOf(m.shape);
      b[6] = INKS.indexOf(m.c);
      b[7] = m.s;
      dv.setFloat32(8, m.x, true);
      dv.setFloat32(12, m.y, true);
      dv.setFloat32(16, m.w, true);
      dv.setFloat32(20, m.h, true);
      return b;
    }
    case 3: {
      const ids = m.ids.slice(0, 200).map((s) => enc.encode(s));
      const b = new Uint8Array(15 + ids.reduce((a, s) => a + 1 + s.byteLength, 0));
      const dv = new DataView(b.buffer);
      b[0] = 3;
      dv.setUint32(1, m.key, true);
      dv.setFloat32(5, m.dx, true);
      dv.setFloat32(9, m.dy, true);
      dv.setUint16(13, ids.length, true);
      let at = 15;
      for (const s of ids) {
        b[at] = s.byteLength;
        b.set(s, at + 1);
        at += 1 + s.byteLength;
      }
      return b;
    }
    case 4: {
      const b = new Uint8Array(5);
      b[0] = 4;
      new DataView(b.buffer).setUint32(1, m.key, true);
      return b;
    }
  }
}

export function decodeLive(b: Uint8Array): LiveMsg | null {
  if (b.byteLength < 5) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const key = dv.getUint32(1, true);
  const ink = (i: number): Ink => INKS[i] ?? 'ink';
  const size = (i: number): Size => (i === 0 || i === 1 || i === 2 ? i : 1);
  switch (b[0]) {
    case 1: {
      if (b.byteLength < 9) return null;
      const n = dv.getUint16(7, true);
      if (b.byteLength < 9 + n * 9) return null;
      const pts: number[] = [];
      for (let i = 0; i < n; i++) {
        pts.push(dv.getFloat32(9 + i * 9, true), dv.getFloat32(13 + i * 9, true), b[17 + i * 9]! / 255);
      }
      return { kind: 1, key, c: ink(b[5]!), s: size(b[6]!), pts };
    }
    case 2:
      if (b.byteLength < 24) return null;
      return {
        kind: 2,
        key,
        shape: SHAPES[b[5]!] ?? 'r',
        c: ink(b[6]!),
        s: size(b[7]!),
        x: dv.getFloat32(8, true),
        y: dv.getFloat32(12, true),
        w: dv.getFloat32(16, true),
        h: dv.getFloat32(20, true),
      };
    case 3: {
      if (b.byteLength < 15) return null;
      const n = dv.getUint16(13, true);
      const ids: string[] = [];
      let at = 15;
      for (let i = 0; i < n && at < b.byteLength; i++) {
        const len = b[at]!;
        ids.push(dec.decode(b.subarray(at + 1, at + 1 + len)));
        at += 1 + len;
      }
      return { kind: 3, key, dx: dv.getFloat32(5, true), dy: dv.getFloat32(9, true), ids };
    }
    case 4:
      return { kind: 4, key };
    default:
      return null;
  }
}
