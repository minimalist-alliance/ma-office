// An installed app's tile, worked out from its record (contract 3.1 and 2.6, ADR 0054): the widget the Desk app draws from the
// app's `summary` with its own components (no app code on the canvas), and a stopped app's words. Pure.
import type { AppRecord, TileSummary } from './store';

interface Row {
  text: string;
  detail: string | null;
  time: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cut = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** The contract's `app.summary` (section 3.1), read leniently: at most 6 rows of 120 characters, a problem of 40. */
export function summaryOf(v: unknown): { badge: number; problem: string | null; rows: Row[] } | null {
  if (!isObj(v)) return null;
  const rows = (Array.isArray(v['rows']) ? v['rows'] : []).slice(0, 6).flatMap((r: unknown) =>
    isObj(r) && typeof r['text'] === 'string' ? [{ text: r['text'].slice(0, 120), detail: cut(r['detail'], 120), time: cut(r['time'], 40) }] : [],
  );
  const badge = typeof v['badge'] === 'number' && Number.isFinite(v['badge']) ? Math.max(0, Math.floor(v['badge'])) : 0;
  return { badge, problem: cut(v['problem'], 40), rows };
}

/** The contract's words for an app that's stopped by a problem (section 2.6), drafts for Sales. Null: nothing to say. */
export function problemWords(rec: Pick<AppRecord, 'state' | 'problem'>): string | null {
  if (rec.state === 'disabled' || rec.problem === 'revoked') return 'Turned off by Minimalist Alliance';
  if (rec.state !== 'failed' && !rec.problem) return null;
  switch (rec.problem) {
    case 'memory':
      return 'Stopped: used too much memory';
    case 'crashed':
      return 'Stopped: it kept closing';
    case 'needs_update':
      return 'Needs an update';
    default:
      return 'Couldn’t start';
  }
}

const clock = (iso: string | null): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1)) return null;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

/**
 * The tile's widget: the first row as the title, its detail and the other rows under it, and the app's own problem line or the
 * first row's time at the foot. A stopped app's problem takes the title in the contract's words.
 */
export function widgetOf(rec: AppRecord): TileSummary {
  const words = problemWords(rec);
  // As the widget's text, which wraps, so the words fit a small tile whole.
  if (words) return { widget: { title: '', text: words }, problem: words };
  const s = summaryOf(rec.summary);
  const first = s?.rows[0];
  if (!s || !first) return {};
  const body = [first.detail, ...s.rows.slice(1).map((r) => (r.detail ? `${r.text} · ${r.detail}` : r.text))].filter((x): x is string => !!x).join('\n');
  const when = clock(first.time);
  const foot = s.problem ?? (when ? `Updated ${when}` : undefined);
  return { ...(s.badge ? { badge: s.badge } : {}), widget: { title: first.text, ...(body ? { text: body } : {}), ...(foot ? { foot } : {}) } };
}
