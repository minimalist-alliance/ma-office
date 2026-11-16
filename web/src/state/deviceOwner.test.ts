import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_KEY, deviceOwner, deviceStamp, keptForThisMember, LEFT, setDeviceOwner, stampsFollow, unstampDeviceKeys, VIEW_KEY } from './deviceOwner';

// Whose a kept camera or view is (ADR 0057): the next member in this browser never starts on the last one's, and no
// member's id is left in either once they've signed out (ISS-67, ISS-89).
describe('the member a kept view is for', () => {
  it("before anyone has said, only an unstamped one (an older build's) is taken, and what's written names nobody", () => {
    expect(deviceOwner()).toBeNull();
    expect(keptForThisMember(undefined)).toBe(true);
    expect(keptForThisMember(null)).toBe(true);
    expect(keptForThisMember('u-a')).toBe(false);
    expect(keptForThisMember(LEFT)).toBe(false);
    expect(deviceStamp()).toBeNull();
  });

  it('then only theirs, or an unstamped one; never one left at a sign-out', () => {
    setDeviceOwner('u-a');
    expect(keptForThisMember('u-a')).toBe(true);
    expect(keptForThisMember('u-b')).toBe(false);
    expect(keptForThisMember(undefined)).toBe(true);
    expect(keptForThisMember(LEFT)).toBe(false);
    for (const odd of [0, true, {}, ['u-a']]) expect(keptForThisMember(odd)).toBe(false);
    setDeviceOwner(null); // nobody named: the member stays
    expect(deviceOwner()).toBe('u-a');
    setDeviceOwner('u-b');
    expect(keptForThisMember('u-a')).toBe(false);
  });

  it("is stamped with the member only while the layout mirror's guard allows their id here", () => {
    let writable = true;
    stampsFollow(() => writable);
    setDeviceOwner('u-a');
    expect(deviceStamp()).toBe('u-a');
    writable = false; // signed out here or in another tab, or another account's sign-in owns the storage now
    expect(deviceStamp()).toBe(LEFT);
    writable = true;
    expect(deviceStamp()).toBe('u-a');
  });
});

describe('a signed-out state', () => {
  const store = new Map<string, string>();
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });
  const stub = (): void => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  };

  it('leaves the camera and the view, as the device\'s own, with no member\'s id in them and nobody to start on them', () => {
    stub();
    store.set(CAMERA_KEY, JSON.stringify({ x: 10, y: -4, s: 1.5, owner: 'u-a' }));
    store.set(VIEW_KEY, JSON.stringify({ scope: 'work', activeDesk: 'd-work', mode: 'free', owner: 'u-a' }));
    unstampDeviceKeys();
    expect(JSON.parse(store.get(CAMERA_KEY)!)).toEqual({ x: 10, y: -4, s: 1.5, owner: LEFT });
    expect(JSON.parse(store.get(VIEW_KEY)!)).toEqual({ scope: 'work', activeDesk: 'd-work', mode: 'free', owner: LEFT });
    for (const k of [CAMERA_KEY, VIEW_KEY]) expect(store.get(k)).not.toContain('u-a');
    expect(keptForThisMember(JSON.parse(store.get(VIEW_KEY)!).owner)).toBe(false);
  });

  it("marks an older build's unstamped view too, takes an unreadable one, and leaves what isn't there", () => {
    stub();
    store.set(VIEW_KEY, JSON.stringify({ scope: 'all', activeDesk: null, mode: 'desk' }));
    store.set(CAMERA_KEY, '{not json');
    unstampDeviceKeys();
    expect(JSON.parse(store.get(VIEW_KEY)!)).toEqual({ scope: 'all', activeDesk: null, mode: 'desk', owner: LEFT });
    expect(store.has(CAMERA_KEY)).toBe(false);
    unstampDeviceKeys(); // twice changes nothing
    expect(JSON.parse(store.get(VIEW_KEY)!)).toEqual({ scope: 'all', activeDesk: null, mode: 'desk', owner: LEFT });
    expect(store.has(CAMERA_KEY)).toBe(false);
  });
});
