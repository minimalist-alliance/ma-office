import { afterEach, describe, expect, it, vi } from 'vitest';

// The window is an event target here, with a count of the listeners on it.
const windowEvents = new EventTarget();
let listening = 0;
const add = windowEvents.addEventListener.bind(windowEvents);
const remove = windowEvents.removeEventListener.bind(windowEvents);
vi.stubGlobal(
  'window',
  Object.assign(windowEvents, {
    addEventListener: (...a: Parameters<EventTarget['addEventListener']>) => ((listening += 1), add(...a)),
    removeEventListener: (...a: Parameters<EventTarget['removeEventListener']>) => ((listening -= 1), remove(...a)),
  }),
);

const { closeHeld, holdClose, letClose } = await import('./closeGuard');

/** What leaving now does: whether the browser would ask. */
function leaving(): { asks: boolean } {
  const e = new Event('beforeunload', { cancelable: true });
  windowEvents.dispatchEvent(e);
  return { asks: e.defaultPrevented };
}

afterEach(() => letClose(true));

describe('the close guard (shell/closeGuard.ts)', () => {
  it('asks nothing, and listens for nothing, while nothing is held', () => {
    expect(leaving().asks).toBe(false);
    expect(listening).toBe(0);
    expect(closeHeld()).toBe(false);
  });

  it('asks while something is held, and stops the moment it lets go', () => {
    holdClose('maia:1', true);
    expect(listening).toBe(1);
    expect(leaving().asks).toBe(true);
    holdClose('maia:1', false);
    expect(leaving().asks).toBe(false);
    expect(listening).toBe(0);
  });

  it('one listener for any number of holds, there until the last goes', () => {
    holdClose('agent:a', true);
    holdClose('transfer:d-1', true);
    holdClose('agent:a', true); // said again: still one hold
    expect(listening).toBe(1);
    holdClose('agent:a', false);
    expect(leaving().asks).toBe(true);
    holdClose('transfer:d-1', false);
    expect(leaving().asks).toBe(false);
    expect(listening).toBe(0);
    holdClose('never-held', false);
    expect(listening).toBe(0);
  });

  it('a check is asked again as the page goes: text that reached its desk meanwhile asks nothing', () => {
    let unsaved = true;
    holdClose('notebook:1', () => unsaved);
    expect(leaving().asks).toBe(true);
    unsaved = false;
    expect(leaving().asks).toBe(false);
    expect(closeHeld()).toBe(false);
    holdClose('notebook:1', false);
    expect(listening).toBe(0);
  });

  it('a sign-out lets the page go for good: nothing held asks, and nothing holds it again', () => {
    holdClose('maia:1', true);
    letClose();
    expect(listening).toBe(0);
    expect(leaving().asks).toBe(false);
    holdClose('agent:b', true);
    expect(listening).toBe(0);
    expect(leaving().asks).toBe(false);
  });
});
