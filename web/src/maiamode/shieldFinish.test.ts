// The focus shield's finish (deskd API.md §23): calls and screen shares as "do not disturb" (`dnd.ts`), the seams' contracts
// (`shieldSeams.ts`: Courier's summary, structure only), the tiles' calm badges (`state/tileCalm.ts`)
// and `reach.accent`.
import { describe, expect, it, vi } from 'vitest';
import { callOn, onDnd, resetDnd, setCall, setShare, shareOn } from './dnd';
import { cleanThreads, THREADS_MAX } from './shieldSeams';
import { readAccent, readReach } from './reach';
import { badgeLook, countFree, setTileCalm, useTileCalm } from '../state/tileCalm';

const CH = '01JD0000000000000000000001';
const CT = '01JD0000000000000000000002';

describe('calls and screen shares as do not disturb', () => {
  it('is on while any source says so, tells listeners only at the edges, and resets', () => {
    resetDnd();
    const seen = vi.fn();
    const off = onDnd(seen);
    setCall('commons:d-a', true);
    setCall('voice', true);
    expect(callOn()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    setCall('commons:d-a', false);
    expect(callOn()).toBe(true);
    setCall('voice', false);
    expect(callOn()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    setShare('screen', true);
    expect(shareOn()).toBe(true);
    resetDnd();
    expect(shareOn()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(4);
    off();
  });
});

describe('Courier’s summary as the shield takes it', () => {
  it('keeps structure only, clamps every number, and drops what is out of shape', () => {
    const r = cleanThreads({
      threads: [
        { channelId: CH, kind: 'group', contactIds: [CT, 'Dana', 7], known: true, confirmed: 'yes', bulk: false, theyWroteLastAt: -5, replyBand: 9, unread: 1e9, newestAt: 1_763_100_000_000, subject: 'Hi', snippet: 'x' },
        { channelId: 'https://example.com', kind: 'direct' },
        'nope',
      ],
    });
    expect(r.threads).toEqual([{ channelId: CH, kind: 'group', contactIds: [CT], known: true, confirmed: false, bulk: false, theyWroteLastAt: null, replyBand: 3, unread: 10_000, newestAt: 1_763_100_000_000 }]);
    expect(cleanThreads({ threads: Array.from({ length: 80 }, () => ({ channelId: CH })) }).threads).toHaveLength(THREADS_MAX);
    expect(cleanThreads(null).threads).toEqual([]);
  });
});

describe('the tiles under the shield', () => {
  it('reads reach.accent leniently: own desk ids, known apps, an agent’s id only for agents', () => {
    expect(readAccent([
      { deskId: 'd-aaaaaaaaaaaa', app: 'courier', agentId: 'ag-x' },
      { deskId: 'd-aaaaaaaaaaaa', app: 'agent', agentId: 'ag-abc' },
      { deskId: 'd-bad/../x', app: 'courier' },
      { deskId: 'd-aaaaaaaaaaaa', app: 'javascript:alert(1)' },
    ])).toEqual([
      { deskId: 'd-aaaaaaaaaaaa', app: 'courier', agentId: null },
      { deskId: 'd-aaaaaaaaaaaa', app: 'agent', agentId: 'ag-abc' },
    ]);
    expect(readReach({ on: true, held: { count: 1, now: 0 } })?.accent).toEqual([]);
  });
  it('is plain while the shield is off, calm while it is on, and keeps the accent only where something may break through', () => {
    setTileCalm(null);
    expect(badgeLook(useTileCalm.getState(), 'd-a', 'todo')).toBe('plain');
    setTileCalm({ on: true, accent: [{ deskId: 'd-a', app: 'courier', agentId: null }, { deskId: 'd-a', app: 'agent', agentId: 'ag-1' }] });
    const s = useTileCalm.getState();
    expect(badgeLook(s, 'd-a', 'todo')).toBe('calm');
    expect(badgeLook(s, 'd-a', 'courier')).toBe('accent');
    expect(badgeLook(s, 'd-b', 'courier')).toBe('calm');
    expect(badgeLook(s, 'd-a', 'agent')).toBe('accent');
    expect(badgeLook(s, 'd-a', 'agent:ag-1')).toBe('accent');
    expect(badgeLook(s, 'd-a', 'agent:ag-2')).toBe('calm');
    // The same picture again changes nothing (no render for the canvas).
    setTileCalm({ on: true, accent: [{ deskId: 'd-a', app: 'agent', agentId: 'ag-1' }, { deskId: 'd-a', app: 'courier', agentId: null }] });
    expect(useTileCalm.getState()).toBe(s);
    // "Show everything as it comes": as before.
    setTileCalm({ on: false, accent: [{ deskId: 'd-a', app: 'courier', agentId: null }] });
    expect(badgeLook(useTileCalm.getState(), 'd-a', 'courier')).toBe('plain');
    expect(countFree('courier')).toBe(true);
    expect(countFree('todo')).toBe(false);
  });
});
