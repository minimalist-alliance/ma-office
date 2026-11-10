// Small shared helpers. No React here.
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const contrastQuery = typeof window === 'undefined' ? null : window.matchMedia('(prefers-contrast: more)');

/** Cheap enough to read in a draw. */
export const moreContrast = (): boolean => contrastQuery?.matches ?? false;

export function onContrastChange(fn: () => void): () => void {
  contrastQuery?.addEventListener('change', fn);
  return () => contrastQuery?.removeEventListener('change', fn);
}

/** Move item `id` so it sits at the position `targetId` had. */
export function moveBefore<T>(order: readonly T[], id: T, targetId: T): T[] {
  const ti = order.indexOf(targetId);
  const next = order.filter((x) => x !== id);
  next.splice(ti, 0, id);
  return next;
}

export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the mirror is only a convenience */
  }
}

export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
