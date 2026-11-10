// Numbers as the member reads them. Amounts are µ$ on the wire (task 04) and always shown as estimates.

const MICRO = 1_000_000;

/** `$0.42`, `$12.50`; `<$0.01` for a little; `unknown` for a model with no price. */
export function usd(micro: number | null | undefined): string {
  if (micro == null) return 'unknown';
  if (micro > 0 && micro < 10_000) return '<$0.01';
  return `$${(micro / MICRO).toFixed(2)}`;
}

/** A limit: `$5`, `$2.50`. Whole dollars drop their cents. */
export function usdLimit(micro: number): string {
  const dollars = micro / MICRO;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** `412`, `12.4k`, `1.2M`. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim1(n / 1000)}k`;
  return `${trim1(n / 1_000_000)}M`;
}

const trim1 = (x: number): string => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));

export function tokens(n: number): string {
  return `${compactCount(n)} ${n === 1 ? 'token' : 'tokens'}`;
}

/** Dollars typed by the member to µ$, or null if it isn't an amount. At most two decimals. */
export function parseUsd(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * MICRO + Number((frac + '00').slice(0, 2)) * 10_000;
}

/** µ$ back to what the field shows: `5`, `2.5`, `0.05`. */
export function usdField(micro: number | null): string {
  if (micro == null) return '';
  return String(Math.round(micro / 10_000) / 100);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A time in a thread or the activity log: `14:05` today, `Yesterday 14:05`, `Nov 3, 14:05`. */
export function when(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= dayStart) return hm;
  if (at >= dayStart - 86_400_000) return `Yesterday ${hm}`;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${hm}`;
}
