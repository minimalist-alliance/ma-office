import { describe, expect, it } from 'vitest';
import { statusLine } from './agentStatus';
import { clearsLine, TRAFFIC_DESK_LINE, TRAFFIC_HOST_LINE, trafficLine } from '../chrome/trafficWords';
import { trafficHold, trafficStopOf } from './trafficStop';

const Z = { locale: 'en-US', timeZone: 'America/Denver' };
// 2026-11-11 20:00 UTC is 1:00 PM in Denver.
const NOW = Date.parse('2026-11-11T20:00:00Z');

describe('the traffic stop words (TD-162)', () => {
  it('has the two drafted lines, with no number and no limit in them', () => {
    expect(TRAFFIC_DESK_LINE).toBe('This desk was stopped because its internet traffic went far beyond normal personal use.');
    expect(TRAFFIC_HOST_LINE).toBe('This desk was stopped for a while because of very heavy internet traffic on the computer it shares with other desks.');
    for (const t of [TRAFFIC_DESK_LINE, TRAFFIC_HOST_LINE]) expect(t).not.toMatch(/\d|GB|15m|24h/);
    expect(trafficLine('host')).toBe(TRAFFIC_HOST_LINE);
    expect(trafficLine('desk')).toBe(TRAFFIC_DESK_LINE);
  });
  it('reads only a traffic stopDetail, and ignores unknown scopes', () => {
    expect(trafficStopOf({ reason: 'traffic', limit: '15m', scope: 'host', at: 'x', clearsAt: '2026-11-11T21:00:00Z', extra: 1 })).toEqual({ scope: 'host', clearsAt: '2026-11-11T21:00:00Z' });
    expect(trafficStopOf({ reason: 'traffic', scope: 'galaxy', clearsAt: 'soon' })).toEqual({ scope: 'desk', clearsAt: null });
    expect(trafficStopOf({ reason: 'other' })).toBeNull();
    expect(trafficStopOf(null)).toBeNull();
  });
  it('holds the desk only until clearsAt', () => {
    const s = { scope: 'desk' as const, clearsAt: '2026-11-11T21:00:00Z' };
    expect(trafficHold(s, NOW)).toBe(s);
    expect(trafficHold(s, Date.parse('2026-11-11T21:00:01Z'))).toBeNull();
    expect(trafficHold({ scope: 'desk', clearsAt: null }, NOW)).toBeNull();
    expect(trafficHold(undefined, NOW)).toBeNull();
  });
  it('says the time today, tomorrow, or on a date, in the viewer\'s zone', () => {
    expect(clearsLine('2026-11-11T22:40:00Z', { now: NOW, ...Z })).toBe('You can start it again after 3:40 PM today.');
    expect(clearsLine('2026-11-12T22:40:00Z', { now: NOW, ...Z })).toBe('You can start it again after 3:40 PM tomorrow.');
    expect(clearsLine('2026-11-14T22:40:00Z', { now: NOW, ...Z })).toBe('You can start it again on Nov 14.');
    // 2026-11-12 03:00 UTC is still Nov 11 evening in Denver, and Nov 12 in Tokyo.
    expect(clearsLine('2026-11-12T03:00:00Z', { now: NOW, ...Z })).toBe('You can start it again after 8:00 PM today.');
    expect(clearsLine('2026-11-12T03:00:00Z', { now: NOW, locale: 'en-US', timeZone: 'Asia/Tokyo' })).toBe('You can start it again after 12:00 PM today.');
  });
  it('the strip says it while stopping and while the stop holds, and not after', () => {
    const base = { vm: 'stopped', phase: null, queuePosition: null, link: 'idle', linkAvailable: false, agent: { state: 'idle' } } as never;
    expect(statusLine({ ...(base as object), trafficStop: true } as never).label).toBe('stopped for heavy traffic');
    expect(statusLine(base).label).toBe('asleep');
    expect(statusLine({ ...(base as object), vm: 'stopping', stopReason: 'traffic', stopInSec: 65 } as never).label).toBe('stopped for heavy traffic · 1:05');
  });
});
