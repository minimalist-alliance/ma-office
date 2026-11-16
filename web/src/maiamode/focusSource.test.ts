// The observer in every view (the focus shield; deskd API.md §23): one sender for the page however many hold it, her topic
// subscribed once and handed to the room, `focus` sent 2 s after what the member does settles and only when it changed, a completed
// action at once, one keep-alive a minute, `reach` read for the held line, and `agent.maia.reach.*` with `idem` on every mutation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { method: string; params: Record<string, unknown>; idem: string | undefined; desk: string }[],
  topics: new Map<string, (msg: Record<string, unknown>) => void>(),
  subs: 0,
  courier: false,
  docsFront: { items: [] } as Record<string, unknown>,
}));
vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });

const linkFor = (deskId: string) => ({
  deskId,
  call: async (method: string, params: Record<string, unknown> = {}, o?: { idem?: string }) => {
    h.calls.push({ method, params, idem: o?.idem, desk: deskId });
    if (method === 'todo.summary') return { newFromAgents: 0, zone: 'UTC', rev: 1 };
    if (method === 'todo.list') return { items: [], zone: 'UTC', rev: 1, next: null, more: 0, newFromAgents: 0, toConfirm: 0, today: '2026-11-15' };
    if (method === 'agent.thread.get') return { agentId: 'maia', messages: [], seq: 0 };
    if (method === 'courier.attention') {
      return {
        threads: [
          { channelId: '01JD0000000000000000000001', kind: 'direct', contactIds: ['01JD0000000000000000000002', 'Dana'], known: true, confirmed: true, bulk: false, theyWroteLastAt: T0 - 60_000, replyBand: 7, unread: 2, newestAt: T0 - 60_000, subject: 'Contract terms', name: 'Dana' },
          { channelId: 'not-a-channel', kind: 'direct' },
        ],
      };
    }
    if (method === 'docs.feed') return h.docsFront;
    return {};
  },
  subscribe: (topic: string, fn: (msg: Record<string, unknown>) => void) => {
    if (deskId === 'd-p') {
      h.topics.set(topic, fn);
      if (topic === 'agent.maia') h.subs += 1;
    }
    return () => {
      if (deskId === 'd-p') h.topics.delete(topic);
    };
  },
});
const links: Record<string, ReturnType<typeof linkFor>> = { 'd-p': linkFor('d-p'), 'd-w': linkFor('d-w'), 'd-g': linkFor('d-g') };
vi.mock('../desk/liveStore', async () => {
  const { create } = await import('zustand');
  return {
    useLiveStore: create(() => ({ desks: { 'd-p': { link: 'open' }, 'd-w': { link: 'closed' }, 'd-g': { link: 'open' } } as Record<string, { link: string }> })),
    linkOf: (id: string) => links[id] ?? null,
    wakeDesk: () => undefined,
  };
});
vi.mock('../state/deskStore', async () => {
  const { create } = await import('zustand');
  return {
    useDeskStore: create(() => ({
      desks: [
        { id: 'd-p', name: 'Personal', kind: 'personal', vm: 'running' },
        { id: 'd-w', name: 'Work', kind: 'work', vm: 'stopped' },
        { id: 'd-g', name: 'Guild', kind: 'guild', vm: 'running' },
      ],
    })),
  };
});
vi.mock('./prefs', () => ({ currentPrefs: () => ({ home: null }) }));
vi.mock('../apps/courier/door', () => ({ courierOn: () => h.courier }));

const F = await import('./focusSource');
const Calm = await import('../state/tileCalm');
type Facts = ReturnType<import('./focusSource').FocusEnv['facts']>;

const observes = () => h.calls.filter((c) => c.method === 'agent.maia.observe');
const T0 = 1_763_100_000_000;
const facts = (patch: Partial<Facts> = {}): Facts => ({
  surface: 'desk', scope: 'work', deskId: 'd-p', deskKind: 'personal', app: 'notebook', item: { kind: 'page', id: 'pg-1' }, people: [],
  input: { typing: false, idle: false, lastAt: T0, flowSince: T0 }, call: false, share: false, visible: true, device: 'dv-abcdefgh12345678', ...patch,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  h.calls.length = 0;
  h.topics.clear();
  h.subs = 0;
  h.courier = false;
  h.docsFront = { items: [] };
});
afterEach(() => {
  F.installFocusEnv(null);
  vi.useRealTimers();
});

describe('the one sender', () => {
  it('is one for the page however many hold it: one subscription to her topic, one observe, gone when the last lets go', async () => {
    const a = F.retainFocus();
    const b = F.retainFocus();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.subs).toBe(1);
    expect(observes()).toHaveLength(1);
    expect(observes()[0]?.desk).toBe('d-p');
    expect((observes()[0]?.params['desks'] as { deskId: string }[]).map((d) => d.deskId)).toEqual(['d-p', 'd-w']);
    expect(observes()[0]?.idem).toBeUndefined();
    a.release();
    expect(F.focusRunning()).toBe(true);
    b.release();
    expect(F.focusRunning()).toBe(false);
    expect(h.topics.has('agent.maia')).toBe(false);
  });
  it('hands the room her topic, a late listener the latest at once, and keeps reach for the held line', async () => {
    const f = F.retainFocus();
    const seen: unknown[] = [];
    f.onRoom((m) => seen.push(m));
    h.topics.get('agent.maia')?.({ type: 'snapshot', seq: 1, on: true, reach: { on: true, device: null, line: { kind: 'held', text: '6 held · nothing urgent', held: 6, dot: 'none' }, held: { count: 6, now: 0 } } });
    expect(seen).toHaveLength(1);
    expect(F.useReach.getState().reach?.line.text).toBe('6 held · nothing urgent');
    expect(F.useReach.getState().ready).toBe(true);
    const late: unknown[] = [];
    f.onRoom((m) => late.push(m));
    expect(late).toHaveLength(1);
    f.release();
    expect(F.useReach.getState().reach).toBeNull();
  });
  it('sends one keep-alive a minute when nothing changes', async () => {
    const f = F.retainFocus();
    await vi.advanceTimersByTimeAsync(10);
    expect(observes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(observes()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observes()).toHaveLength(2);
    f.release();
  });
});

describe('documents in front (desks[].docs)', () => {
  it('reads each own desk’s front, sends ids, places and times only, and reads again on a docs event', async () => {
    h.docsFront = {
      items: [
        { docId: 'd_01JD0000000000000000000001', place: 'needs_you', dueAt: T0 + 3_600_000, changed: false, at: T0 - 1000 },
        { docId: 'd_01JD0000000000000000000002', place: 'working', changed: true, at: T0 },
        { docId: '../x', place: 'maybe', at: T0 },
        { docId: 'd_01JD0000000000000000000003', place: 'maybe', changed: false, at: T0, title: 'Lease from Rosa' },
        // What it goes with, ids only: a name or a title in an id's place is dropped (SF2-I4).
        { docId: 'd_01JD0000000000000000000004', place: 'read_later', changed: false, at: T0, contactIds: ['01JC0NTACT0000000000000000', 'Rosa Ortiz'], channelId: '01JCHANNE10000000000000000', agentId: 'scout' },
        { docId: 'd_01JD0000000000000000000005', place: 'needs_you', changed: false, at: T0, contactIds: ['rosa@example.com'], channelId: 'Lease thread', agentId: 'Lease from Rosa!' },
        { docId: 'lease-from-rosa', place: 'needs_you', at: T0 },
      ],
    };
    const f = F.retainFocus();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.calls.some((c) => c.method === 'docs.feed' && c.params['front'] === true && c.desk === 'd-p')).toBe(true);
    expect(h.calls.some((c) => c.method === 'docs.feed' && c.desk === 'd-g')).toBe(false);
    const last = () => (observes().at(-1)?.params['desks'] as { deskId: string; docs?: Record<string, unknown>[] }[]).find((d) => d.deskId === 'd-p');
    expect(last()?.docs).toEqual([
      { docId: 'd_01JD0000000000000000000001', place: 'needs_you', dueAt: T0 + 3_600_000, changed: false, at: T0 - 1000 },
      { docId: 'd_01JD0000000000000000000003', place: 'maybe', changed: false, at: T0 },
      { docId: 'd_01JD0000000000000000000004', place: 'read_later', changed: false, at: T0, contactIds: ['01JC0NTACT0000000000000000'], channelId: '01JCHANNE10000000000000000', agentId: 'scout' },
      { docId: 'd_01JD0000000000000000000005', place: 'needs_you', changed: false, at: T0 },
    ]);
    h.docsFront = { items: [] };
    const before = h.calls.filter((c) => c.method === 'docs.feed').length;
    h.topics.get('docs')?.({ type: 'changed' });
    await vi.advanceTimersByTimeAsync(2_600);
    expect(h.calls.filter((c) => c.method === 'docs.feed').length).toBe(before + 1);
    expect(last()?.docs).toBeUndefined();
    f.release();
  });
});

describe('the focus block', () => {
  it('rides on observe once the page’s facts are in; a change goes 2 s after it settles, and only if it changed', async () => {
    let now = facts();
    let changed = (): void => undefined;
    let event: (k: 'sent' | 'window_closed', at: number) => void = () => undefined;
    F.installFocusEnv({
      facts: () => now,
      start(c, e) {
        changed = c;
        event = e as typeof event;
        return () => undefined;
      },
    });
    const f = F.retainFocus();
    await vi.advanceTimersByTimeAsync(10);
    const first = observes().at(-1)!.params['focus'] as Record<string, unknown>;
    expect(first).toMatchObject({ surface: 'desk', deskId: 'd-p', app: 'notebook', item: { kind: 'page', id: 'pg-1' }, device: 'dv-abcdefgh12345678', visible: true });
    expect(F.useReach.getState().device).toBe('dv-abcdefgh12345678');
    const before = observes().length;
    // A change that changes nothing sent: nothing goes.
    changed();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(observes()).toHaveLength(before);
    // Typing starts: sent 2 s later, not at once, and twice quickly is once.
    now = facts({ input: { typing: true, idle: false, lastAt: T0 + 1, flowSince: T0 } });
    changed();
    await vi.advanceTimersByTimeAsync(1_000);
    changed();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(observes()).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(600);
    expect(observes()).toHaveLength(before + 1);
    expect((observes().at(-1)!.params['focus'] as { input: { typing: boolean } }).input.typing).toBe(true);
    // A completed action goes at once (within the 2-a-second limit), once.
    event('window_closed', T0 + 9);
    await vi.advanceTimersByTimeAsync(600);
    expect((observes().at(-1)!.params['focus'] as { events?: unknown[] }).events).toEqual([{ kind: 'window_closed', at: T0 + 9 }]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect((observes().at(-1)!.params['focus'] as { events?: unknown[] }).events).toBeUndefined();
    f.release();
  });
  it('never sends more than 2 a second', async () => {
    let event: (k: 'window_closed', at: number) => void = () => undefined;
    F.installFocusEnv({ facts: () => facts(), start: (_c, e) => ((event = e as typeof event), () => undefined) });
    const f = F.retainFocus();
    await vi.advanceTimersByTimeAsync(10);
    const at = observes().length;
    for (let n = 0; n < 10; n += 1) event('window_closed', T0 + n);
    await vi.advanceTimersByTimeAsync(400);
    expect(observes().length - at).toBeLessThanOrEqual(1);
    f.release();
  });
});

describe('reach calls', () => {
  it('a mutation carries idem, a read none, and nothing goes without a home desk', async () => {
    await expect(F.reachCall('agent.maia.reach.hold', { minutes: 30 })).rejects.toMatchObject({ code: 'unavailable' });
    const f = F.retainFocus();
    await F.reachCall('agent.maia.reach.hold', { minutes: 30 });
    await F.reachCall('agent.maia.reach.held', { limit: 100 }, true);
    const hold = h.calls.find((c) => c.method === 'agent.maia.reach.hold');
    const held = h.calls.find((c) => c.method === 'agent.maia.reach.held');
    expect(hold?.params).toEqual({ minutes: 30 });
    expect(typeof hold?.idem).toBe('string');
    expect(held?.idem).toBeUndefined();
    f.release();
  });
  it('reads another desk only when it’s the member’s own and open, never a Guild Desk', async () => {
    await expect(F.deskRead('d-g', 'courier.contact.get', { contactId: 'x' })).rejects.toBeTruthy();
    await expect(F.deskRead('d-w', 'courier.contact.get', { contactId: 'x' })).rejects.toBeTruthy();
    await F.deskRead('d-p', 'courier.contact.get', { contactId: 'x' });
    expect(h.calls.filter((c) => c.method === 'courier.contact.get').map((c) => c.desk)).toEqual(['d-p']);
  });
});

describe('the shield’s finish: Courier’s summary and the tiles', () => {
  type Seen = { deskId: string; courier?: { threads: Record<string, unknown>[] } };
  const lastDesks = (): Seen[] => (observes()[observes().length - 1]?.params['desks'] ?? []) as Seen[];

  it('sends each open desk’s Courier summary as structure only, and none while Courier is off', async () => {
    h.courier = true;
    const f = F.retainFocus();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.calls.some((c) => c.method === 'courier.attention' && c.desk === 'd-p')).toBe(true);
    // Never a Guild Desk's, never a closed desk's.
    expect(h.calls.some((c) => c.method === 'courier.attention' && c.desk !== 'd-p')).toBe(false);
    const p = lastDesks().find((d) => d.deskId === 'd-p');
    expect(p?.courier?.threads).toEqual([
      { channelId: '01JD0000000000000000000001', kind: 'direct', contactIds: ['01JD0000000000000000000002'], known: true, confirmed: true, bulk: false, theyWroteLastAt: T0 - 60_000, replyBand: 3, unread: 2, newestAt: T0 - 60_000 },
    ]);
    expect(JSON.stringify(observes())).not.toMatch(/Contract terms|Dana/);
    f.release();
    h.calls.length = 0;
    h.courier = false;
    const g = F.retainFocus();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.calls.some((c) => c.method === 'courier.attention')).toBe(false);
    expect(lastDesks().find((d) => d.deskId === 'd-p')?.courier).toBeUndefined();
    g.release();
  });

  it('turns the tiles calm while the shield is on, the accent only where something may break through', async () => {
    const f = F.retainFocus();
    await vi.advanceTimersByTimeAsync(10);
    h.topics.get('agent.maia')?.({ type: 'snapshot', seq: 1, on: true, reach: { on: true, device: null, line: { kind: 'held', text: '2 held · 1 needs you soon', held: 2, dot: 'none' }, held: { count: 2, now: 1 }, accent: [{ deskId: 'd-wwwwwwwwwwww', app: 'courier', agentId: null }, { deskId: 'not a desk', app: 'courier' }] } });
    const s = Calm.useTileCalm.getState();
    expect(s.on).toBe(true);
    expect(Calm.badgeLook(s, 'd-wwwwwwwwwwww', 'courier')).toBe('accent');
    expect(Calm.badgeLook(s, 'd-wwwwwwwwwwww', 'todo')).toBe('calm');
    f.release();
    expect(Calm.useTileCalm.getState().on).toBe(false);
  });
});
