// The traffic stop's words and the time it clears (TD-162), pure, in the lazy chunk with `trafficView.tsx`. No number from `limit`.
import type { TrafficStop } from '../desk/trafficStop';

export const TRAFFIC_DESK_LINE = 'This desk was stopped because its internet traffic went far beyond normal personal use.';
export const TRAFFIC_HOST_LINE = 'This desk was stopped for a while because of very heavy internet traffic on the computer it shares with other desks.';
export const trafficLine = (scope: TrafficStop['scope']): string => (scope === 'host' ? TRAFFIC_HOST_LINE : TRAFFIC_DESK_LINE);

export interface ClockOpts {
  now: number;
  locale?: string;
  timeZone?: string;
}

/** "You can start it again after 3:40 PM today." (or tomorrow), and on a later day just "on Nov 14.", in the viewer's zone. */
export function clearsLine(clearsAt: string, c: ClockOpts = { now: Date.now() }): string {
  const at = Date.parse(clearsAt);
  const z = c.timeZone ? { timeZone: c.timeZone } : {};
  const day = (t: number): string => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...z }).format(t);
  const time = new Intl.DateTimeFormat(c.locale, { hour: 'numeric', minute: '2-digit', ...z }).format(at);
  if (day(at) === day(c.now)) return `You can start it again after ${time} today.`;
  if (day(at) === day(c.now + 24 * 3600_000)) return `You can start it again after ${time} tomorrow.`;
  return `You can start it again on ${new Intl.DateTimeFormat(c.locale, { month: 'short', day: 'numeric', ...z }).format(at)}.`;
}
