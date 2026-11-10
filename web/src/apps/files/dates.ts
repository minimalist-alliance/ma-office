// Dates in a list: "Nov 5" this year, "Nov 5, 2025" before. No time of day: the list is calm, the tooltip has the rest.
export function shortDate(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', year ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function longDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "in 12 days" / "tomorrow" for the trash's purge date. */
export function daysUntil(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.ceil((t - now) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
