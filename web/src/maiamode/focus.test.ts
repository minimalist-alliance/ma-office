// The observer's pure parts (the focus shield; deskd API.md §23 `focus`): typing and idle as two edges, never per key; a completed
// action as a fine break only once 5 s pass with no input after it, a closed window at once; the block cut to its limits, with
// never a URL, a title or a name in it; this browser's id; a Files folder hashed so no name travels.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base32x16, deviceId, DEVICE_KEY, focusApp, focusBlock, FocusEvents, folderRef, IDLE_MS, InputClock, newDeviceId, QUIET_MS, TYPING_MS, type FocusFacts } from './focus';

const T0 = 1_763_100_000_000;

describe('the input clock', () => {
  it('says typing at the first key and not again for the next ones, and stops 20 s after the last', () => {
    const c = new InputClock(T0);
    expect(c.key(T0 + 1_000)).toBe(true);
    expect(c.state).toMatchObject({ typing: true, idle: false, lastAt: T0 + 1_000 });
    // Every key after the first is no edge: nothing to send.
    for (let t = 1_100; t < 15_000; t += 120) expect(c.key(T0 + t)).toBe(false);
    expect(c.state.lastAt).toBe(T0 + 1_000);
    expect(c.tick(T0 + 14_900 + TYPING_MS - 1)).toBe(false);
    expect(c.tick(T0 + 14_900 + TYPING_MS + 50)).toBe(true);
    expect(c.state.typing).toBe(false);
    expect(c.state.lastAt).toBeGreaterThan(T0 + 14_000);
  });
  it('moves lastAt at the edges, and else at most once a minute', () => {
    const c = new InputClock(T0);
    const moves = [];
    for (let t = 0; t <= 150_000; t += 1_000) if (c.input(T0 + t)) moves.push(t);
    expect(moves).toEqual([60_000, 120_000]);
  });
  it('goes idle after 2 minutes without input, and back at the next', () => {
    const c = new InputClock(T0);
    c.input(T0 + 5_000);
    expect(c.nextAt()).toBe(T0 + 5_000 + IDLE_MS);
    expect(c.tick(T0 + 5_000 + IDLE_MS)).toBe(true);
    expect(c.state).toMatchObject({ idle: true, typing: false, lastAt: T0 + 5_000 });
    expect(c.nextAt()).toBeNull();
    expect(c.input(T0 + 200_000)).toBe(true);
    expect(c.state).toMatchObject({ idle: false, lastAt: T0 + 200_000 });
  });
  it('starts a new stretch of input after a 5-minute pause', () => {
    const c = new InputClock(T0);
    c.input(T0 + 60_000);
    expect(c.state.flowSince).toBe(T0);
    c.input(T0 + 60_000 + 299_000);
    expect(c.state.flowSince).toBe(T0);
    c.input(T0 + 60_000 + 299_000 + 300_000);
    expect(c.state.flowSince).toBe(T0 + 659_000);
  });
  it('stops typing when the tab goes out of sight, so no timer runs there', () => {
    const c = new InputClock(T0);
    c.key(T0 + 10);
    expect(c.hidden()).toBe(true);
    expect(c.state.typing).toBe(false);
    expect(c.hidden()).toBe(false);
  });
});

describe('completed actions', () => {
  it('are ready once 5 s pass with no input after them', () => {
    const e = new FocusEvents();
    expect(e.add('sent', T0)).toBe(false);
    expect(e.nextAt()).toBe(T0 + QUIET_MS);
    expect(e.tick(T0 + QUIET_MS - 1)).toBe(false);
    expect(e.tick(T0 + QUIET_MS)).toBe(true);
    expect(e.take()).toEqual([{ kind: 'sent', at: T0 }]);
    expect(e.take()).toEqual([]);
  });
  it('are no break when input follows within the 5 s; the action’s own click or key doesn’t count', () => {
    const e = new FocusEvents();
    e.add('todo_checked', T0);
    e.input(T0 + 100);
    e.add('saved', T0 + 1_000);
    e.input(T0 + 3_000);
    expect(e.tick(T0 + 10_000)).toBe(false);
    expect(e.take()).toEqual([]);
  });
  it('says a closed window at once', () => {
    const e = new FocusEvents();
    expect(e.add('window_closed', T0)).toBe(true);
    expect(e.waiting).toBe(true);
    expect(e.take()).toEqual([{ kind: 'window_closed', at: T0 }]);
  });
  it('keeps at most 10', () => {
    const e = new FocusEvents();
    for (let n = 0; n < 14; n += 1) e.add('window_closed', T0 + n);
    expect(e.take()).toHaveLength(10);
  });
});

const facts = (patch: Partial<FocusFacts> = {}): FocusFacts => ({
  surface: 'desk',
  scope: 'work',
  deskId: 'd-work01',
  deskKind: 'work',
  app: 'notebook',
  item: { kind: 'page', id: 'pg-123' },
  people: [],
  input: { typing: false, idle: false, lastAt: T0, flowSince: T0 - 3_600_000 },
  call: false,
  share: false,
  visible: true,
  device: 'dv-k3j9abcd1234efgh',
  events: [],
  ...patch,
});

describe('the focus block', () => {
  it('is exactly §23’s shape', () => {
    const contact = '01JD4Z7K9QW3M8N2P5R6S7T8V9';
    const b = focusBlock(facts({ app: 'courier', item: { kind: 'channel', id: 'ch-1' }, people: [{ deskId: 'd-work01', contactId: contact }], events: [{ kind: 'sent', at: T0 }] }));
    expect(b).toEqual({
      surface: 'desk',
      scope: 'work',
      deskId: 'd-work01',
      app: 'courier',
      item: { kind: 'channel', id: 'ch-1' },
      people: [{ deskId: 'd-work01', contactId: contact }],
      input: { typing: false, idle: false, lastAt: T0, flowSince: T0 - 3_600_000 },
      call: false,
      share: false,
      visible: true,
      device: 'dv-k3j9abcd1234efgh',
      events: [{ kind: 'sent', at: T0 }],
    });
  });
  it('sends a Guild Desk as scope guild, with no desk, app, item or people', () => {
    const b = focusBlock(facts({ deskKind: 'guild', people: [{ deskId: 'd-g', contactId: '01JD4Z7K9QW3M8N2P5R6S7T8V9' }] }));
    expect(b['scope']).toBe('guild');
    for (const k of ['deskId', 'app', 'item', 'people']) expect(b).not.toHaveProperty(k);
  });
  it('sends the Browser as an app with no item, ever', () => {
    const b = focusBlock(facts({ app: 'browser', item: { kind: 'page', id: 'pg-1' } }));
    expect(b['app']).toBe('browser');
    expect(b).not.toHaveProperty('item');
  });
  it('drops what’s out of shape: an unknown app, a URL or a title as an id, a name as a contact, past 8 people', () => {
    expect(focusBlock(facts({ app: 'https://example.org' }))).not.toHaveProperty('app');
    expect(focusBlock(facts({ item: { kind: 'page', id: 'https://example.org/x' } }))).not.toHaveProperty('item');
    expect(focusBlock(facts({ item: { kind: 'page', id: 'My Q3 plan' } }))).not.toHaveProperty('item');
    expect(focusBlock(facts({ people: [{ deskId: 'd-w', contactId: 'Rosa Diaz' }] }))).not.toHaveProperty('people');
    const many = Array.from({ length: 12 }, (_, n) => ({ deskId: 'd-w', contactId: `01JD4Z7K9QW3M8N2P5R6S7T8${String(n).padStart(2, '0')}`.slice(0, 26) }));
    expect((focusBlock(facts({ people: many }))['people'] as unknown[]).length).toBeLessThanOrEqual(8);
    expect(focusBlock(facts({ device: 'phone' }))).not.toHaveProperty('device');
  });
  it('carries no text: only ids, kinds, booleans and times', () => {
    const text = JSON.stringify(focusBlock(facts({ app: 'courier', item: { kind: 'channel', id: 'ch-1' } })));
    expect(text).not.toMatch(/https?:|title|name|subject|text|key/i);
  });
  it('names apps from the closed enum only', () => {
    expect(['notebook', 'courier', 'todo', 'files', 'browser', 'agent', 'commons', 'maia', 'agent:ag-abc', 'app:notes'].map(focusApp)).toEqual(['notebook', 'courier', 'todo', 'files', 'browser', 'agent', 'commons', 'maia', 'agent:ag-abc', 'app:notes']);
    expect(['chat', 'settings', 'app:org.example.notes', '', 7].map(focusApp)).toEqual([null, null, null, null, null]);
  });
});

describe('ids made here', () => {
  it('this browser’s id: dv- and 16 of [a-z0-9], kept, and a fresh one when storage can’t be used', () => {
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    const a = deviceId(store);
    expect(a).toMatch(/^dv-[a-z0-9]{16}$/);
    expect(kept.get(DEVICE_KEY)).toBe(a);
    expect(deviceId(store)).toBe(a);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined };
    expect(deviceId(broken)).toMatch(/^dv-[a-z0-9]{16}$/);
    expect(newDeviceId(() => new Uint8Array(16))).toBe('dv-aaaaaaaaaaaaaaaa');
  });
  it('a Files folder: h- and 16 base32 characters of the SHA-256 of its path, so the path itself never travels', async () => {
    const ref = await folderRef('/Clients/Acme/Contracts');
    expect(ref).toMatch(/^h-[a-z2-7]{16}$/);
    expect(ref).toBe(`h-${base32x16(createHash('sha256').update('/Clients/Acme/Contracts').digest())}`);
    expect(ref).not.toMatch(/acme|clients/i);
    expect(await folderRef('/Clients/Acme/Contracts')).toBe(ref);
    expect(await folderRef('/Clients/Acme')).not.toBe(ref);
    // RFC 4648 base32 of 0xff…: all "7".
    expect(base32x16(new Uint8Array(10).fill(255))).toBe('7777777777777777');
  });
});
