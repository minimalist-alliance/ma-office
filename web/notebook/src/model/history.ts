// When versions are written and kept (design 5.3). Pure, so the rules are tested apart from storage.
import { dayKey } from './days.ts';
import type { VersionMeta } from './types.ts';

export const SESSION_IDLE_MS = 5 * 60_000;
export const INTERVAL_MS = 30 * 60_000;
export const KEEP_ALL_MS = 30 * 86_400_000;
export const TRASH_KEEP_MS = 30 * 86_400_000;

/**
 * Every version is kept for 30 days. Older than that, only the last of each day stays.
 * Returns the ids to delete. `day` buckets by another zone than this process's, as the desk does.
 */
export function versionsToPrune(versions: VersionMeta[], now: number, day: (ts: number) => string = dayKey): string[] {
  const lastOfDay = new Map<string, VersionMeta>();
  for (const v of versions) {
    const key = `${v.pageId}|${day(v.createdAt)}`;
    const cur = lastOfDay.get(key);
    if (!cur || v.createdAt > cur.createdAt) lastOfDay.set(key, v);
  }
  const keep = new Set([...lastOfDay.values()].map((v) => v.id));
  return versions.filter((v) => now - v.createdAt > KEEP_ALL_MS && !keep.has(v.id)).map((v) => v.id);
}

/** The version that shows a page as it stood at `cutoff`: the newest at or before it. */
export function versionAt<T extends VersionMeta>(versions: T[], cutoff: number): T | null {
  let best: T | null = null;
  for (const v of versions) if (v.createdAt <= cutoff && (!best || v.createdAt >= best.createdAt)) best = v;
  return best;
}

export const REASON_LABELS: Record<VersionMeta['reason'], string> = {
  session: 'Editing session',
  interval: 'While editing',
  day_end: 'End of day',
  pre_agent: 'Before an agent edit',
  restore: 'Restored',
  manual: 'Saved by you',
};
