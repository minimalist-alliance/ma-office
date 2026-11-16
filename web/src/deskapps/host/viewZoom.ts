// A zoom gesture a desk app's view sent up from its sandboxed frame (`boot.js`, ADR 0055): Ctrl or Cmd with the wheel, or a
// pinch, over the view. It comes on a port only the frame's boot holds, but it's still read as the frame's: a plain object of
// exactly the boot's numbers, each held to its range, and at most so many a second. Nothing else from the frame is read.
import { wheelDeltaY } from '../../canvas/camera';
import { gestureDelta } from '../../canvas/pinch';

/** What a gesture is to the office: a wheel's delta in CSS px (down positive), and whether a key was held, so not a pinch. */
export interface ViewZoom {
  dy: number;
  keyHeld: boolean;
}

/** A wheel's delta past this is still one step (`zoom/level.ts`); held here so nothing larger reaches the office. */
const MAX_DY = 2000;
/** More than a trackpad sends (about 120 a second); past it, the rest of that second goes nowhere. */
export const VIEW_ZOOMS_PER_SECOND = 240;

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);
const plain = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && Object.getPrototypeOf(d) === Object.prototype;

/**
 * The boot's `{w, m, k}` (a wheel: its `deltaY`, its `deltaMode` and whether Control or Cmd was down) or `{g}` (Safari's
 * pinch step since the last), or null for anything else.
 */
export function readViewZoom(data: unknown, pageHeight: number): ViewZoom | null {
  if (!plain(data)) return null;
  const keys = Object.keys(data);
  const { w, m, k, g } = data;
  if (keys.length === 3 && typeof w === 'number' && typeof m === 'number' && typeof k === 'boolean') {
    if (!Number.isFinite(w) || (m !== 0 && m !== 1 && m !== 2)) return null;
    const dy = wheelDeltaY(clamp(w, -10_000, 10_000), m, clamp(pageHeight, 0, 10_000));
    return { dy: clamp(dy, -MAX_DY, MAX_DY), keyHeld: k };
  }
  if (keys.length === 1 && typeof g === 'number') {
    if (!Number.isFinite(g) || g < 0.1 || g > 10 || g === 1) return null;
    return { dy: clamp(gestureDelta(g), -MAX_DY, MAX_DY), keyHeld: false };
  }
  return null;
}

/** True for at most `perSecond` calls in any second from the first of them; false for the rest of it. */
export function rateCap(perSecond: number, now: () => number = () => performance.now()): () => boolean {
  let since = -Infinity;
  let count = 0;
  return () => {
    const t = now();
    if (t - since >= 1000) {
      since = t;
      count = 0;
    }
    count += 1;
    return count <= perSecond;
  };
}
