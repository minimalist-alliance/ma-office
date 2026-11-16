// Courier's summary as the focus shield takes it (deskd API.md §21 `courier.attention`, §23 "For closeness"): the office reads it
// from each of the member's own open desks and sends it as `desks[].courier` in `agent.maia.observe`, held here to the contract.
// Structure only: never a subject, a snippet, a name or an address. (Each desk's `docs` is the documents work's, read in
// `focusSource.ts` from `docs.feed {front: true}`.)

const ULID = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const time = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

export interface ShieldThread {
  channelId: string;
  kind: 'direct' | 'group';
  contactIds: string[];
  known: boolean;
  confirmed: boolean;
  bulk: boolean;
  theyWroteLastAt: number | null;
  replyBand: number;
  unread: number;
  newestAt: number;
}

export const THREADS_MAX = 50;

/** `courier.attention`'s answer as `desks[].courier`: structure only, at most 50 threads; anything else is dropped. */
export function cleanThreads(raw: unknown): { threads: ShieldThread[] } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const threads: ShieldThread[] = [];
  for (const o of Array.isArray(r['threads']) ? r['threads'] : []) {
    if (threads.length >= THREADS_MAX) break;
    if (!o || typeof o !== 'object') continue;
    const t = o as Record<string, unknown>;
    if (typeof t['channelId'] !== 'string' || !ULID.test(t['channelId'])) continue;
    const band = typeof t['replyBand'] === 'number' && Number.isFinite(t['replyBand']) ? Math.max(0, Math.min(3, Math.floor(t['replyBand']))) : 0;
    const unread = typeof t['unread'] === 'number' && Number.isFinite(t['unread']) ? Math.max(0, Math.min(10_000, Math.floor(t['unread']))) : 0;
    threads.push({
      channelId: t['channelId'],
      kind: t['kind'] === 'group' ? 'group' : 'direct',
      contactIds: (Array.isArray(t['contactIds']) ? t['contactIds'] : []).filter((c): c is string => typeof c === 'string' && ULID.test(c)).slice(0, 8),
      known: t['known'] === true,
      confirmed: t['confirmed'] === true,
      bulk: t['bulk'] === true,
      theyWroteLastAt: time(t['theyWroteLastAt']) ?? null,
      replyBand: band,
      unread,
      newestAt: time(t['newestAt']) ?? 0,
    });
  }
  return { threads };
}
