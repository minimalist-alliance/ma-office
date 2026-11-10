// GET /v1/desks/bandwidth as ma-platform's services/desks answers it (contract bandwidth.md, ADR 0095), for the
// harness. Tests set `bandwidth` through POST /__harness: a meter to answer with, or 404 for a Platform with none yet.
const GB = 1e9;
const DAY = 86_400_000;

/** This week (from Monday 00:00 UTC) and this month, with `weekBytes` used of a member's 30 and 100 GB. */
export function meterAt(nowMs = Date.now(), { weekBytes = 1.2 * GB, monthBytes = weekBytes, weekGb = 30, monthGb = 100, enforced = true } = {}) {
  const now = new Date(nowMs);
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const win = (used, limitGb, start, end) => ({ usedBytes: used, usedGb: Math.round((used / GB) * 100) / 100, limitGb, startsAt: new Date(start).toISOString(), resetsAt: new Date(end).toISOString() });
  const week = win(weekBytes, weekGb, weekStart, weekStart + 7 * DAY);
  const month = win(monthBytes, monthGb, monthStart, nextMonth);
  const share = Math.max(weekBytes / (weekGb * GB), monthBytes / (monthGb * GB));
  const state = share >= 1 ? 'limit' : share >= 0.8 ? 'warn' : 'ok';
  const limitedBy = state !== 'limit' ? null : monthBytes >= monthGb * GB && month.resetsAt > week.resetsAt ? 'month' : weekBytes >= weekGb * GB ? 'week' : 'month';
  return {
    tier: 'officer',
    week,
    month,
    state,
    limitedBy,
    warnAtPct: 80,
    enforced,
    paused: enforced && state === 'limit',
    resumesAt: limitedBy ? (limitedBy === 'week' ? week : month).resetsAt : null,
    asOf: now.toISOString(),
    pollAfterSeconds: 60,
  };
}

/** What the harness answers: the test's meter, a 404 if it asked for one, or a quiet week. */
export function bandwidthReply(setting) {
  if (setting === 404) return [404, { error: { code: 'not_found', message: 'Not found.', requestId: 'harness', retryable: false } }];
  return [200, setting ?? meterAt()];
}
