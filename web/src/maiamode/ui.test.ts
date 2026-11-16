// The disclosure asked again over the room (the home desk holds an older one, `RoomState.disclosure`): it opens over the room,
// which stays as it is underneath; "Turn on Maia Mode" saves the current version, tells the desk and goes back to the room; "Not
// now" leaves the room cleanly, as "Show my desks" does. An entrance under way never puts the room back over it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ prefs: { on: true, disclosure: { version: 2, at: 'x' }, lastMode: 'maia' } as Record<string, unknown>, saved: [] as Record<string, unknown>[] }));
// The timers are looked up at each call, so the fake ones drive the room's 600 ms.
vi.stubGlobal('window', { setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms), clearTimeout: (t?: number) => clearTimeout(t), innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }) });
vi.stubGlobal('document', { querySelectorAll: () => [], querySelector: () => null, activeElement: null });
vi.stubGlobal('HTMLElement', class {});
vi.mock('../desk/liveStore', () => ({ setRoomLook: () => undefined }));
vi.mock('../state/layoutStore', () => ({ useLayoutStore: { getState: () => ({ desks: {} }) } }));
vi.mock('../state/windowStore', () => ({ useWindowStore: { getState: () => ({ windows: {}, active: null }), setState: () => undefined }, windowKey: (d: string, a: string) => `${d}:${a}` }));
vi.mock('./door', async () => {
  const { create } = await import('zustand');
  return { useMaiaMode: create(() => ({ layer: false, room: false, boot: false })) };
});
vi.mock('./prefs', () => ({
  allowedNow: () => true,
  currentPrefs: () => h.prefs,
  isOn: (p: Record<string, unknown>) => p['on'] === true && (p['disclosure'] as { version?: number } | null)?.version === 2,
  savePrefs: (patch: Record<string, unknown>) => {
    h.saved.push(patch);
    Object.assign(h.prefs, patch);
    return h.prefs;
  },
}));

const { useMaiaMode } = await import('./door');
const { waitingSource } = await import('./source');
const U = await import('./ui');

const roomUp = () => {
  const source = { ...waitingSource('ready'), setOn: vi.fn(() => Promise.resolve(true)) };
  U.useRoomUi.setState({ phase: 'in', source, viewport: null, sheet: false, announce: false });
  useMaiaMode.setState({ layer: true, room: true, boot: false });
  return source;
};

beforeEach(() => {
  vi.useFakeTimers();
  h.prefs = { on: true, disclosure: { version: 2, at: 'x' }, lastMode: 'maia' };
  h.saved.length = 0;
  U.useRoomUi.setState({ phase: 'off', from: null, viewport: null, sheet: false, source: null, announce: false });
  useMaiaMode.setState({ layer: false, room: false, boot: false });
});

describe('the disclosure asked again over the room', () => {
  it('opens over the room, and accepting tells the desk and goes back to the room as it was', () => {
    const source = roomUp();
    U.useRoomUi.setState({ sheet: true });
    U.showDisclosure();
    expect(U.useRoomUi.getState()).toMatchObject({ phase: 'disclosure', sheet: false });
    expect(useMaiaMode.getState()).toMatchObject({ layer: true, room: true });
    U.accept();
    expect(h.saved.at(-1)).toMatchObject({ on: true, disclosure: { version: 2 } });
    expect(source.setOn).toHaveBeenCalledWith(true);
    expect(U.useRoomUi.getState().phase).toBe('in');
    expect(useMaiaMode.getState().room).toBe(true);
  });
  it('“Not now” leaves the room cleanly, as “Show my desks” does', () => {
    const source = roomUp();
    U.showDisclosure();
    U.decline();
    expect(U.useRoomUi.getState().phase).toBe('leaving');
    expect(useMaiaMode.getState()).toMatchObject({ room: false, boot: false });
    vi.advanceTimersByTime(1000);
    expect(U.useRoomUi.getState().phase).toBe('off');
    expect(useMaiaMode.getState().layer).toBe(false);
    expect(source.setOn).not.toHaveBeenCalled();
  });
  it('isn’t opened while the room is leaving or isn’t up, and an entrance under way doesn’t cover it', () => {
    U.showDisclosure();
    expect(U.useRoomUi.getState().phase).toBe('off');
    roomUp();
    U.useRoomUi.setState({ phase: 'leaving' });
    U.showDisclosure();
    expect(U.useRoomUi.getState().phase).toBe('leaving');

    U.useRoomUi.setState({ phase: 'off' });
    useMaiaMode.setState({ layer: false, room: false });
    U.enter(null);
    expect(U.useRoomUi.getState().phase).toBe('entering');
    U.showDisclosure();
    vi.advanceTimersByTime(1000);
    expect(U.useRoomUi.getState().phase).toBe('disclosure');
  });
  it('the first disclosure, with no room up, still goes in on accept and changes nothing on “Not now”', () => {
    h.prefs = { on: false, disclosure: null, lastMode: 'desk' };
    U.enter(null);
    expect(U.useRoomUi.getState().phase).toBe('disclosure');
    U.decline();
    expect(U.useRoomUi.getState().phase).toBe('off');
    expect(useMaiaMode.getState()).toMatchObject({ layer: false, room: false });
    U.enter(null);
    U.accept();
    expect(U.useRoomUi.getState()).toMatchObject({ phase: 'entering', announce: true });
    expect(useMaiaMode.getState().room).toBe(true);
  });
});
