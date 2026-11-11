// What the setup circle keeps in the layout document's `prefs`: done steps stay done, Skip and Undo, hide, What's new
// seen, Not now, and a step noticed before the document arrived going up only once it has. The layout document's prefs
// store is the real one; its sync is faked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const stored = new Map<string, string>();
  return { stored, read: true, sets: [] as Record<string, unknown>[] };
});
vi.stubGlobal('window', {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem: (k: string) => h.stored.get(k) ?? null, setItem: (k: string, v: string) => h.stored.set(k, v) },
});
vi.mock('../platform/session', async () => {
  const { create: make } = await import('zustand');
  return { useSession: make(() => ({ me: { userId: 'u-1' } as { userId: string } | null })) };
});
vi.mock('../shell/layoutSync', async () => {
  const { useLayoutPrefs } = await import('../shell/layoutPrefs');
  return {
    layoutDocRead: () => h.read,
    setLayoutPref: (p: Record<string, unknown>) => {
      h.sets.push(p);
      useLayoutPrefs.setState(p);
    },
  };
});

const { adoptLayoutPrefs, resetLayoutPrefs, useLayoutPrefs } = await import('../shell/layoutPrefs');
const { useSession } = await import('../platform/session');
const p = await import('./prefs');

beforeEach(() => {
  h.stored.clear();
  h.sets = [];
  h.read = true;
  resetLayoutPrefs();
  useSession.setState({ me: { userId: 'u-1' } });
});

describe('the setup circle in prefs', () => {
  it('a step is done once: a second time costs no save', () => {
    p.markDone('browser');
    p.markDone('browser');
    expect(h.sets).toEqual([{ setup: { done: ['browser'], skipped: [] } }]);
    expect(p.readSetup()).toEqual({ done: ['browser'], skipped: [] });
  });
  it('Skip and Undo; a skipped step that gets used is done', () => {
    p.skipStep('files');
    expect(p.readSetup()).toEqual({ done: [], skipped: ['files'] });
    p.undoSkip('files');
    expect(p.readSetup()).toEqual({ done: [], skipped: [] });
    p.skipStep('files');
    p.markDone('files');
    expect(p.readSetup()).toEqual({ done: ['files'], skipped: [] });
  });
  it('reads leniently: unknown ids and odd shapes are dropped', () => {
    adoptLayoutPrefs({ setup: { done: ['browser', 'nope', 3, 'browser'], skipped: 'files' } });
    expect(p.readSetup()).toEqual({ done: ['browser'], skipped: [] });
    adoptLayoutPrefs({ setup: 'x', circleHidden: 'yes', whatsNewSeen: [1, 'a'], offerNotNowUntil: 'soon' });
    expect(p.readSetup()).toEqual({ done: [], skipped: [] });
    expect(p.readHidden()).toBe(false);
    expect(p.readSeen()).toEqual(['a']);
    expect(p.readOfferNotNow()).toBeNull();
  });
  it('hide and show, What’s new seen, and Not now go to the document', () => {
    p.setCircleHidden(true);
    expect(useLayoutPrefs.getState()['circleHidden']).toBe(true);
    expect(p.readHidden()).toBe(true);
    p.setCircleHidden(false);
    expect(p.readHidden()).toBe(false);
    p.markSeen(['a', 'b']);
    p.markSeen(['b', 'c']);
    expect(p.readSeen()).toEqual(['a', 'b', 'c']);
    // Got it sends the shown item with every item that fits, itself included: each is kept once.
    p.markSeen(['d', 'e', 'd']);
    expect(p.readSeen()).toEqual(['a', 'b', 'c', 'd', 'e']);
    const until = Date.parse('2026-12-10T00:00:00Z');
    p.offerNotNow(until);
    expect(p.readOfferNotNow()).toBe(until);
  });
  it('a step noticed before the document arrived waits in this browser, then goes up with the document’s own', () => {
    h.read = false;
    p.markDone('name-desks');
    expect(h.sets).toEqual([]);
    expect(p.readSetup().done).toEqual(['name-desks']);
    // The document arrives with a step done in another browser: both are kept, in one save.
    adoptLayoutPrefs({ setup: { done: ['files'], skipped: ['browser'] } });
    h.read = true;
    p.flushSetup();
    expect(h.sets).toEqual([{ setup: { done: ['files', 'name-desks'], skipped: ['browser'] } }]);
    p.flushSetup();
    expect(h.sets.length).toBe(1);
  });
  it('this browser’s copy is the member’s own: someone else signing in here sees none of it', () => {
    h.read = false;
    p.markDone('browser');
    useSession.setState({ me: { userId: 'u-2' } });
    expect(p.readSetup()).toEqual({ done: [], skipped: [] });
  });
});
