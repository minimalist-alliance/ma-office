// Who the welcome is for, as pure rules (`plan.test.ts`): the Platform's own rule for a new membership (ma-platform
// `services/maia/src/welcome.ts` `activatedAt` and `dueFrom`), and the layout document's record of a welcome done or declined.
import type { Me } from '../platform/api';
import { useLayoutPrefs } from '../shell/layoutPrefs';

export const WELCOME_KEY = 'welcome';
const DAY_MS = 86_400_000;
const SKEW_MS = 5 * 60_000;

/** When the membership became active, from `/v1/me` (ma-platform `services/maia/src/welcome.ts` `activatedAt`). */
export function activatedAt(me: Me | null | undefined): number | null {
  const m = me?.membership as Record<string, unknown> | undefined;
  if (!m) return null;
  const trial = m['trial'] && typeof m['trial'] === 'object' ? (m['trial'] as Record<string, unknown>)['startedAt'] : undefined;
  const times = [m['tier'] === 'free' ? m['freeSince'] : undefined, trial, m['billingAnchor']].map((v) => (typeof v === 'string' ? Date.parse(v) : NaN)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

const LIVE = ['active', 'past_due', 'canceling'];
export function newMember(me: Me | null | undefined, now = Date.now()): boolean {
  const m = me?.membership;
  if (!me || !m || m.closed === true || me.roles?.includes('owner')) return false;
  if (!(LIVE.includes(m.status ?? '') || m.comped === true)) return false;
  const from = activatedAt(me);
  return from !== null && now - from <= DAY_MS && now - from >= -SKEW_MS;
}

/** The layout document's record: `{state: 'done' | 'explored' | 'later', at}`. */
export function welcomeRecord(prefs: Record<string, unknown> = useLayoutPrefs.getState()): { state: string; at: number } | null {
  const w = prefs[WELCOME_KEY];
  if (!w || typeof w !== 'object') return null;
  const state = (w as Record<string, unknown>)['state'];
  const at = Date.parse(String((w as Record<string, unknown>)['at'] ?? ''));
  return typeof state === 'string' ? { state, at: Number.isFinite(at) ? at : 0 } : null;
}

/** Whether the welcome takes this first load: pure, for `door.test.ts`. */
export function decide(input: { on: boolean; me: Me | null | undefined; record: { state: string; at: number } | null; closed: boolean; now?: number }): boolean {
  const now = input.now ?? Date.now();
  if (!input.on || input.closed || !input.me || input.me.roles?.includes('owner')) return false;
  // `npm run dev` and the shell specs: `?welcome=1` plays it for the fixture member (never in a production build).
  if (import.meta.env.MODE !== 'production' && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('welcome') === '1') return true;
  const r = input.record;
  if (r && r.state === 'later') return now - r.at <= DAY_MS;
  if (r) return false;
  return newMember(input.me, now);
}
