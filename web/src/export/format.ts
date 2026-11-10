// Numbers as the page says them.

/** Decimal units, as a computer's own file windows show sizes. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n || 0))} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

export const formatCount = (n: number): string => Math.max(0, Math.round(n)).toLocaleString('en-US');

/** A move code as it's read aloud and typed: `XXXX-XXXX-XXXX`. */
export function formatCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return s.match(/.{1,4}/g)?.join('-') ?? '';
}

/** `14:59`. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** `Nov 6`. */
export const formatDay = (iso: string | undefined): string | null => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
};
