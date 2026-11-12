// Walk L13: which Browser covers the bar's ring, from what's drawn at its middle, top first (`cover.ts`).
import { describe, expect, it } from 'vitest';
import { coverAt, hitOf, type Hit } from './cover';

const browser = (cover: string): Hit => ({ cover, browser: true });
const other = (cover: string): Hit => ({ cover, browser: false });

describe('coverAt', () => {
  it('a Browser window drawn over the ring covers it, whatever its mode or size', () => {
    // A window's picture, its body, then the window, then the bar's ring under it.
    expect(coverAt([null, null, browser('d-1:browser'), 'ring'])).toBe('d-1:browser');
  });

  it('the bar has stepped aside: the Browser still over its place still covers it', () => {
    expect(coverAt([null, browser('d-1:browser'), null, null])).toBe('d-1:browser');
  });

  it('a phone carousel on the Browser covers it; on another app, nothing does', () => {
    expect(coverAt([null, browser('carousel:d-1'), 'ring'])).toBe('carousel:d-1');
    expect(coverAt([null, other('carousel:d-1'), 'ring'])).toBeNull();
  });

  it('the ring on top covers nothing: a window under it (the bar has the keyboard), or nothing there at all', () => {
    expect(coverAt(['ring', browser('d-1:browser')])).toBeNull();
    expect(coverAt(['ring'])).toBeNull();
    expect(coverAt([null, null])).toBeNull();
    expect(coverAt([])).toBeNull();
  });

  it("another app's window over the Browser: the Browser's title bar is hidden too, so the ring goes nowhere", () => {
    expect(coverAt([other('d-1:notebook'), browser('d-1:browser'), 'ring'])).toBeNull();
  });

  it('what is passed over: anything not a cover above the first cover (Maia over a full Browser)', () => {
    expect(coverAt([null, null, browser('d-1:browser')])).toBe('d-1:browser');
  });

  it('only the topmost cover decides', () => {
    expect(coverAt([browser('d-2:browser'), browser('d-1:browser'), 'ring'])).toBe('d-2:browser');
  });
});

describe('hitOf', () => {
  /** An element as `hitOf` reads it: what `closest` finds, and that element's attributes. */
  const el = (found: Record<string, Record<string, string> | undefined>): Element =>
    ({
      closest: (sel: string) => {
        const attrs = found[sel];
        return attrs ? { getAttribute: (n: string) => attrs[n] ?? null } : null;
      },
    }) as unknown as Element;

  it('inside the bar ring is the ring', () => {
    expect(hitOf(el({ '.free-meter': {} }))).toBe('ring');
  });

  it("inside a cover is that cover, a Browser by its data-app", () => {
    expect(hitOf(el({ '[data-cover]': { 'data-cover': 'd-1:browser', 'data-app': 'browser' } }))).toEqual({ cover: 'd-1:browser', browser: true });
    expect(hitOf(el({ '[data-cover]': { 'data-cover': 'carousel:d-1', 'data-app': 'notebook' } }))).toEqual({ cover: 'carousel:d-1', browser: false });
  });

  it('anything else is nothing', () => {
    expect(hitOf(el({}))).toBeNull();
  });
});
