// `lastScreen.ts` against a real IndexedDB (fake-indexeddb): a sign-out's clear beats a save already on its way, nothing is
// kept again until someone signs in, and a picture past seven days is deleted when any is read, not only skipped. The
// whole path, sign-out included, runs in the browser in `alliance.shell.spec.ts`.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clearLastScreens, keepLastScreens, loadLastScreen, MAX_AGE_MS, saveLastScreen } = await import('./lastScreen');

/** A frame to keep. Its JPEG arrives a turn later, as a real `toBlob` does, which is the gap the race lived in. */
class FakeCanvas {
  width = 1280;
  height = 800;
  getContext() {
    return { drawImage: () => {} };
  }
  toBlob(done: (b: Blob | null) => void) {
    setTimeout(() => done(new Blob(['jpeg'])), 5);
  }
}
const frame = (): HTMLCanvasElement => new FakeCanvas() as unknown as HTMLCanvasElement;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/** What the database holds, read without `lastScreen.ts`, so a read can't delete anything. */
async function keys(): Promise<string[]> {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === 'ma-last-screen')) return [];
  return new Promise((resolve) => {
    const req = indexedDB.open('ma-last-screen', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('screens');
    req.onsuccess = () => {
      const all = req.result.transaction('screens').objectStore('screens').getAllKeys();
      all.onsuccess = () => {
        req.result.close();
        resolve(all.result.map(String).sort());
      };
    };
  });
}

beforeEach(async () => {
  vi.stubGlobal('HTMLVideoElement', class {});
  vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
  await clearLastScreens();
  keepLastScreens();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a sign-out and a save on its way', () => {
  it('a save begun before the clear never writes, so the database stays gone', async () => {
    const saving = saveLastScreen('d-a', frame());
    await clearLastScreens();
    await saving;
    await settle();
    expect(await keys()).toEqual([]);
    expect((await indexedDB.databases()).some((d) => d.name === 'ma-last-screen')).toBe(false);
  });

  it('nothing is kept after the clear until someone signs in, and then it is', async () => {
    await clearLastScreens();
    await saveLastScreen('d-a', frame());
    expect(await keys()).toEqual([]);
    expect(await loadLastScreen('d-a')).toBeNull();
    keepLastScreens();
    await saveLastScreen('d-a', frame());
    expect(await keys()).toEqual(['d-a']);
    expect(await loadLastScreen('d-a')).toBeInstanceOf(Blob);
  });

  it('a save that reached the database before the clear goes with it', async () => {
    await saveLastScreen('d-a', frame());
    expect(await keys()).toEqual(['d-a']);
    await clearLastScreens();
    expect(await keys()).toEqual([]);
  });
});

describe('seven days', () => {
  it('a picture past seven days is deleted when any desk is read, and a fresh one stays', async () => {
    const now = Date.now();
    await saveLastScreen('d-old', frame(), now - MAX_AGE_MS - 1);
    await saveLastScreen('d-new', frame(), now - 1000);
    await saveLastScreen('d-edge', frame(), now - MAX_AGE_MS);
    expect(await keys()).toEqual(['d-edge', 'd-new', 'd-old']);
    expect(await loadLastScreen('d-new', now)).toBeInstanceOf(Blob);
    expect(await keys()).toEqual(['d-edge', 'd-new']);
  });

  it('the old one asked for is gone too, not only not shown', async () => {
    const now = Date.now();
    await saveLastScreen('d-old', frame(), now - MAX_AGE_MS - 1);
    expect(await loadLastScreen('d-old', now)).toBeNull();
    expect(await keys()).toEqual([]);
  });
});
