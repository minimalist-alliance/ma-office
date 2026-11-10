// Local calendar days as 'YYYY-MM-DD' strings, which sort as dates. Pure.
// The desk will bucket by its own IANA time zone (design 5.3); the local backend uses this browser's.

const pad = (n: number): string => String(n).padStart(2, '0');

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** The last millisecond of a local day. */
export function endOfDay(key: string): number {
  const d = dateFromKey(key);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

export function addDays(key: string, n: number): string {
  const d = dateFromKey(key);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime());
}

/** 42 days, Monday first, covering a month. */
export function monthCells(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => dayKey(new Date(year, month, 1 - offset + i).getTime()));
}

/** The nearest active day before (-1) or after (+1) `day`, from a list sorted either way. */
export function stepActiveDay(days: string[], day: string, dir: -1 | 1): string | null {
  const sorted = [...days].sort();
  if (dir < 0) {
    for (let i = sorted.length - 1; i >= 0; i -= 1) if ((sorted[i] ?? '') < day) return sorted[i] ?? null;
    return null;
  }
  for (const d of sorted) if (d > day) return d;
  return null;
}

export function formatDayLong(key: string): string {
  return dateFromKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function formatDayShort(key: string): string {
  return dateFromKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Today 3:04 PM", "Yesterday", "Mon", or a date: for page lists and footers. */
export function formatWhen(ts: number, now = Date.now()): string {
  const day = dayKey(ts);
  const today = dayKey(now);
  if (day === today) return `Today ${formatTime(ts)}`;
  if (day === addDays(today, -1)) return 'Yesterday';
  if (now - ts < 6 * 86_400_000 && ts < now) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
