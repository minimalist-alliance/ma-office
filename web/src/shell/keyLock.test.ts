import { beforeEach, describe, expect, it, vi } from 'vitest';

// Full screen, the browser's keyboard and its layout, as stubs.
const doc = { fullscreenElement: null as object | null };
vi.stubGlobal('document', doc);
let layout: Map<string, string> | 'refused' | null = null;
const kb = {
  locks: [] as string[][],
  unlocks: 0,
  refuse: false,
  lock: async (codes: string[] = []): Promise<void> => {
    if (kb.refuse) throw new DOMException('not here', 'NotSupportedError');
    kb.locks.push(codes);
  },
  unlock: (): void => {
    kb.unlocks += 1;
  },
  getLayoutMap: async (): Promise<Map<string, string>> => {
    if (layout === 'refused') throw new DOMException('no', 'SecurityError');
    return layout ?? new Map();
  },
};
let standalone = false;
vi.stubGlobal('matchMedia', (query: string) => ({ media: query, get matches() { return standalone && query.includes('display-mode: standalone'); } }));
const nav = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0', keyboard: kb as unknown };
vi.stubGlobal('navigator', nav);

const { canLockKeys, followFullscreen, installedWindow, keysToDesk, LOCKED_KEYS, lockCodes } = await import('./keyLock');

const enter = (): Promise<void> => ((doc.fullscreenElement = {}), followFullscreen());
const leave = (): Promise<void> => ((doc.fullscreenElement = null), followFullscreen());

beforeEach(async () => {
  await leave();
  Object.assign(kb, { locks: [], unlocks: 0, refuse: false });
  nav.keyboard = kb;
  nav.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0';
  layout = null;
  standalone = false;
});

describe('the keys full screen keeps (shell/keyLock.ts)', () => {
  it('is the habit keys by their place on the keyboard, and never Escape, so one press still leaves full screen', () => {
    expect(LOCKED_KEYS).toEqual(['KeyW', 'KeyT', 'KeyN', 'Tab', 'PageUp', 'PageDown', 'KeyL', 'KeyR', 'F5']);
    expect(LOCKED_KEYS).not.toContain('Escape');
    expect(lockCodes(null)).toEqual(LOCKED_KEYS);
  });

  it('adds wherever this keyboard puts the letters: an AZERTY has its w on KeyZ', () => {
    const azerty = new Map([['KeyQ', 'a'], ['KeyW', 'z'], ['KeyZ', 'w'], ['KeyT', 't'], ['KeyN', 'n'], ['Semicolon', 'm']]);
    expect(lockCodes(azerty)).toEqual([...LOCKED_KEYS, 'KeyZ']);
    const dvorak = new Map([['Comma', 'w'], ['KeyK', 't'], ['KeyL', 'n'], ['KeyP', 'l'], ['KeyO', 'r']]);
    expect(lockCodes(dvorak)).toEqual([...LOCKED_KEYS, 'Comma', 'KeyK', 'KeyP', 'KeyO']);
  });

  it('locks on the way into full screen and unlocks on the way out', async () => {
    expect(keysToDesk()).toBe(false);
    await enter();
    expect(kb.locks).toEqual([LOCKED_KEYS]);
    expect(keysToDesk()).toBe(true);
    await leave();
    expect(kb.unlocks).toBe(1);
    expect(keysToDesk()).toBe(false);
  });

  it('with the layout, or without it where the browser won\'t say', async () => {
    layout = new Map([['KeyZ', 'w']]);
    await enter();
    expect(kb.locks.at(-1)).toEqual([...LOCKED_KEYS, 'KeyZ']);
    await leave();
    layout = 'refused';
    await enter();
    expect(kb.locks.at(-1)).toEqual(LOCKED_KEYS);
  });

  it('a refused lock changes nothing: the keys stay the browser\'s', async () => {
    kb.refuse = true;
    await enter();
    expect(keysToDesk()).toBe(false);
  });

  it('left before the lock answered: not locked', async () => {
    doc.fullscreenElement = {};
    const asking = followFullscreen();
    await leave();
    await asking;
    expect(keysToDesk()).toBe(false);
  });

  it('where there is no navigator.keyboard (Safari, Firefox), nothing happens and nothing is said', async () => {
    nav.keyboard = undefined;
    expect(canLockKeys()).toBe(false);
    await enter();
    expect(keysToDesk()).toBe(false);
    expect(kb.locks).toEqual([]);
  });

  it('says so on a Chromium on a computer, not on Android, whose call only refuses', () => {
    expect(canLockKeys()).toBe(true);
    nav.userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/142.0 Mobile';
    expect(canLockKeys()).toBe(false);
  });

  it("in the office's own installed window the keys are the desk's, full screen or not, with no lock asked", () => {
    expect(installedWindow()).toBe(false);
    standalone = true;
    expect(installedWindow()).toBe(true);
    expect(keysToDesk()).toBe(true);
    expect(kb.locks).toEqual([]);
    nav.keyboard = undefined; // Safari's added to the Dock, say: the window still has them first
    expect(keysToDesk()).toBe(true);
  });
});
