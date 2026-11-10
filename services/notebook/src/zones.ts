// Local calendar days in the member's zone (design 5.3): the desk buckets days by the last zone the client sent.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'gregory', numberingSystem: 'latn' });
    formatters.set(zone, f);
  }
  return f;
}

export function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || zone.length > 128) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD' in that zone, which sorts as a date. */
export function dayIn(ts: number, zone: string): string {
  let y = '';
  let m = '';
  let d = '';
  for (const p of formatter(zone).formatToParts(ts)) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return `${y.padStart(4, '0')}-${m}-${d}`;
}
