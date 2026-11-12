// A desk the cost guard stopped for its traffic (ma-platform contract desks.md "Traffic stops", TD-162). The desk object
// carries `stopReason: "traffic"` while it stops and `stopDetail` until its next start. Draft words for Sales. Never a
// number from `limit` in a member's words, and no Start before `clearsAt`, which the guard would only undo.

export interface TrafficStop {
  scope: 'desk' | 'host';
  /** When the stop clears by itself (an estimate), or null if the platform gave none. */
  clearsAt: string | null;
}

export const TRAFFIC_STOP_REASON = 'traffic';
/** The strip's short form, beside the countdown or in place of "asleep". */
export const TRAFFIC_STRIP = 'stopped for heavy traffic';

/** The platform's `stopDetail`, or null unless it is a traffic stop. Unknown fields and scopes are safe. */
export const trafficStopOf = (r: unknown): TrafficStop | null => {
  const d = r as { reason?: unknown; scope?: unknown; clearsAt?: string } | null;
  return d?.reason === TRAFFIC_STOP_REASON ? { scope: d.scope === 'host' ? 'host' : 'desk', clearsAt: Date.parse(d.clearsAt ?? '') ? d.clearsAt! : null } : null;
};

/** The stop while it still holds: `clearsAt` is ahead. Without a time, or after it, the desk starts as usual. */
export function trafficHold(s: TrafficStop | null | undefined, now: number = Date.now()): TrafficStop | null {
  return s?.clearsAt && Date.parse(s.clearsAt) > now ? s : null;
}
