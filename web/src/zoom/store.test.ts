// Each app's zoom, as the office keeps it (ADR 0055): per app, per member, on this browser; never written from a tab that
// may not write the member's caches (ISS-89); dropped from memory on a change of account; the desk Browser's from its desk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  memberChange: [] as ((sub: string, before: string | null) => void)[],
  writable: true,
  handler: null as unknown,
}));
vi.mock('../platform/auth', () => ({
  onMemberChange: (fn: (sub: string, before: string | null) => void) => {
    h.memberChange.push(fn);
    return () => {};
  },
}));
vi.mock('../state/layoutStore', () => ({ layoutMirrorWritable: () => h.writable }));
vi.mock('../canvas/pinch', () => ({
  setAppZoom: (fn: unknown) => {
    h.handler = fn;
  },
}));

type Store = typeof import('./store');
let local: Map<string, string>;
let store: Store;

async function load(seed?: unknown): Promise<void> {
  local = new Map();
  if (seed !== undefined) local.set('ma.appZoom.v1', typeof seed === 'string' ? seed : JSON.stringify(seed));
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    },
  });
  vi.resetModules();
  h.memberChange = [];
  h.handler = null;
  store = await import('./store');
}

const kept = (): unknown => {
  const raw = local.get('ma.appZoom.v1');
  return raw === undefined ? undefined : JSON.parse(raw);
};
const level = (app: string, deskId = 'd-1'): number | null => store.levelOf(store.useZoomStore.getState(), app, deskId);

beforeEach(() => {
  h.writable = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('office apps', () => {
  it('start at what this browser kept, read once as the chunk loads, and 100 otherwise', async () => {
    await load({ notebook: 130, agent: 80 });
    expect(level('notebook')).toBe(130);
    expect(level('agent:ag-abcdefghijkl')).toBe(80);
    expect(level('files')).toBe(100);
    local.set('ma.appZoom.v1', JSON.stringify({ files: 150 }));
    expect(level('files')).toBe(100);
  });

  it('a bad copy is nobody\'s', async () => {
    await load('{not json');
    expect(level('notebook')).toBe(100);
  });

  it('a change is kept per app, on the grid; every agent shares one; 100 takes it out, and the last takes the key', async () => {
    await load();
    store.setAppLevel('notebook', 'd-1', 124);
    store.setAppLevel('agent:ag-abcdefghijkl', 'd-2', 150);
    expect(level('notebook', 'd-9')).toBe(120);
    expect(level('agent:ag-zzzzzzzzzzzz')).toBe(150);
    expect(kept()).toEqual({ notebook: 120, agent: 150 });
    store.setAppLevel('notebook', 'd-1', 100);
    store.setAppLevel('agent', 'd-1', 100);
    expect(kept()).toBeUndefined();
  });

  it('a step goes from where the app is, held at the ends', async () => {
    await load({ files: 190 });
    store.stepAppLevel('files', 'd-1', 1);
    store.stepAppLevel('files', 'd-1', 1);
    expect(level('files')).toBe(200);
    store.stepAppLevel('courier', 'd-1', -6);
    expect(level('courier')).toBe(50);
  });

  it('Courier\'s level an earlier build kept as `chat` is Courier\'s, and goes back as every build reads it (canvas/storedIds.ts)', async () => {
    await load({ chat: 150, notebook: 80 });
    expect(level('courier')).toBe(150);
    store.setAppLevel('courier', 'd-1', 170);
    expect(kept()).toEqual({ notebook: 80, chat: 170 });
    // What the next release writes reads the same here.
    await load({ courier: 130 });
    expect(level('courier')).toBe(130);
  });

  it('Commons doesn\'t zoom yet: no level, and nothing set (its board sizes its canvas on screen)', async () => {
    await load({ commons: 150 });
    expect(level('commons')).toBeNull();
    store.setAppLevel('commons', 'd-1', 150);
    store.stepAppLevel('commons', 'd-1', 1);
    expect(level('commons')).toBeNull();
    expect(kept()).toEqual({ commons: 150 });
  });

  it('never written from a tab that may not write the member\'s caches; the level still holds on this page', async () => {
    await load();
    h.writable = false;
    store.setAppLevel('notebook', 'd-1', 140);
    expect(level('notebook')).toBe(140);
    expect(kept()).toBeUndefined();
  });

  it('another member\'s tokens in this tab drop the last member\'s levels from memory; the first member\'s don\'t', async () => {
    await load({ notebook: 130 });
    for (const fn of h.memberChange) fn('u-a', null);
    expect(level('notebook')).toBe(130);
    for (const fn of h.memberChange) fn('u-a', 'u-a');
    expect(level('notebook')).toBe(130);
    for (const fn of h.memberChange) fn('u-b', 'u-a');
    expect(level('notebook')).toBe(100);
  });
});

describe('the desk Browser', () => {
  it('has no zoom until its desk says a level, and none again once it goes', async () => {
    await load();
    expect(level('browser')).toBeNull();
    const set = vi.fn();
    store.browserZoom('d-1', 125, set);
    expect(level('browser', 'd-1')).toBe(125);
    expect(level('browser', 'd-2')).toBeNull();
    store.browserGone('d-1', set);
    expect(level('browser', 'd-1')).toBeNull();
  });

  it('the member\'s change goes to the desk, never to this browser\'s storage', async () => {
    await load();
    const set = vi.fn();
    store.browserZoom('d-1', 100, set);
    store.setAppLevel('browser', 'd-1', 150);
    store.stepAppLevel('browser', 'd-1', 1);
    expect(set.mock.calls).toEqual([[150], [160]]);
    expect(level('browser', 'd-1')).toBe(160);
    expect(kept()).toBeUndefined();
  });

  it('a step from the desk\'s own off-grid level goes to the grid', async () => {
    await load();
    const set = vi.fn();
    store.browserZoom('d-1', 67, set);
    store.stepAppLevel('browser', 'd-1', 1);
    expect(set).toHaveBeenCalledWith(70);
  });

  it('nothing is set where the desk has no zoom', async () => {
    await load();
    store.setAppLevel('browser', 'd-1', 150);
    store.stepAppLevel('browser', 'd-1', 1);
    expect(level('browser', 'd-1')).toBeNull();
  });

  it('a Browser that went doesn\'t take away the one that took its place', async () => {
    await load();
    const first = vi.fn();
    const second = vi.fn();
    store.browserZoom('d-1', 110, first);
    store.browserZoom('d-1', 110, second);
    store.browserGone('d-1', first);
    expect(level('browser', 'd-1')).toBe(110);
    store.setAppLevel('browser', 'd-1', 120);
    expect(second).toHaveBeenCalledWith(120);
    expect(first).not.toHaveBeenCalled();
    store.browserZoom('d-1', null, second);
    expect(level('browser', 'd-1')).toBeNull();
  });
});

describe('a wheel or a pinch over an app\'s frame', () => {
  const frame = (app: string | null, deskId = 'd-1'): Element => ({ getAttribute: (n: string) => (n === 'data-zoom-app' ? app : n === 'data-desk' ? deskId : null) }) as unknown as Element;

  it('is this chunk\'s, as it loads (`canvas/pinch.ts` hands it here)', async () => {
    await load();
    expect(h.handler).toBe(store.zoomFromWheel);
  });

  it('steps the app its frame names, its sum kept per frame', async () => {
    await load();
    const nb = frame('notebook');
    store.zoomFromWheel({ frame: nb, dy: -100, pinch: false });
    store.zoomFromWheel({ frame: frame('files'), dy: -30, pinch: false });
    store.zoomFromWheel({ frame: nb, dy: -100, pinch: false });
    expect(level('notebook')).toBe(120);
    expect(level('files')).toBe(100);
    store.zoomFromWheel({ frame: frame(null), dy: -100, pinch: false });
  });

  it('over the Browser, its desk\'s', async () => {
    await load();
    const set = vi.fn();
    store.browserZoom('d-7', 100, set);
    store.zoomFromWheel({ frame: frame('browser', 'd-7'), dy: 120, pinch: false });
    expect(set).toHaveBeenCalledWith(90);
  });
});
