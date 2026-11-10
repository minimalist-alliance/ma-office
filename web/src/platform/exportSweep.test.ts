// An unfinished export goes after 6 hours without progress, checked as the office loads and on a timer, and at
// sign-out: the journal's database (with the key) and the working copy, whatever the export page is doing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropExport, EXPORT_DB, EXPORT_IDLE_MS, EXPORT_WORKING, exportOwnerTag, keepExportFor, markExportOwner, markExportProgress, startExportSweep, sweepExport } from './exportSweep';

const store = new Map<string, string>();
const deleted: string[] = [];
const removed: string[] = [];
/** Whether a tab holds the `ma-export` lock, as one writing a download does. */
const locks = { held: false };

beforeEach(() => {
  store.clear();
  deleted.length = 0;
  removed.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('indexedDB', {
    deleteDatabase: (name: string) => {
      deleted.push(name);
      const r: { onsuccess?: () => void } = {};
      setTimeout(() => r.onsuccess?.(), 0);
      return r;
    },
  });
  locks.held = false;
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => ({ removeEntry: async (n: string) => void removed.push(n) }) },
    locks: { request: async (_name: string, _o: unknown, fn: (lock: object | null) => Promise<void>) => fn(locks.held ? null : {}) },
  });
  vi.stubGlobal('window', { setTimeout, setInterval });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the export sweep', () => {
  it('leaves an export that moved on within 6 hours', () => {
    markExportProgress(1_000_000);
    sweepExport(1_000_000 + EXPORT_IDLE_MS - 1);
    expect(deleted).toEqual([]);
  });

  it('deletes the journal, its key and the working copy after 6 hours without progress', async () => {
    markExportProgress(1_000_000);
    sweepExport(1_000_000 + EXPORT_IDLE_MS);
    await vi.runAllTimersAsync();
    expect(deleted).toEqual([EXPORT_DB]);
    expect(removed).toEqual([EXPORT_WORKING]);
    expect(store.has('ma.export.at')).toBe(false);
  });

  it('checks as the office loads and every 10 minutes while it stays open', async () => {
    vi.setSystemTime(10_000_000);
    markExportProgress(10_000_000);
    startExportSweep();
    expect(deleted).toEqual([]);
    await vi.advanceTimersByTimeAsync(EXPORT_IDLE_MS + 10 * 60 * 1000);
    expect(deleted).toEqual([EXPORT_DB]);
  });

  it('deletes everything when asked, as sign-out does, whether or not there was anything', async () => {
    const dropping = dropExport();
    await vi.runAllTimersAsync();
    await dropping;
    expect(deleted).toEqual([EXPORT_DB]);
    expect(removed).toEqual([EXPORT_WORKING]);
  });
});

describe('a download a tab is still writing', () => {
  it('stays, however long the computer slept: the tab holds its lock', async () => {
    markExportProgress(1_000_000);
    locks.held = true;
    sweepExport(1_000_000 + 7 * 60 * 60 * 1000);
    await vi.runAllTimersAsync();
    expect(deleted).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('goes after 6 hours once no tab holds it', async () => {
    markExportProgress(1_000_000);
    sweepExport(1_000_000 + 7 * 60 * 60 * 1000);
    await vi.runAllTimersAsync();
    expect(deleted).toEqual([EXPORT_DB]);
  });
});

describe('whose a download is', () => {
  beforeEach(() => vi.useRealTimers()); // the hash is WebCrypto's, which no fake clock moves
  const keep = (sub: string | null): Promise<void> => keepExportFor(sub);

  it("stays for the member who started it, and holds only a hash of who that is", async () => {
    markExportOwner(await exportOwnerTag('u-member-A'));
    markExportProgress(1_000_000);
    await keep('u-member-A');
    expect(deleted).toEqual([]);
    expect([...store.values()].join(' ')).not.toContain('u-member-A');
  });

  it('goes when anyone else signs in', async () => {
    markExportOwner(await exportOwnerTag('u-member-A'));
    markExportProgress(1_000_000);
    await keep('u-member-B');
    expect(deleted).toEqual([EXPORT_DB]);
    expect(removed).toEqual([EXPORT_WORKING]);
    expect(store.size).toBe(0);
  });

  it('goes when this browser starts with nobody signed in', async () => {
    markExportOwner(await exportOwnerTag('u-member-A'));
    markExportProgress(1_000_000);
    await keep(null);
    expect(deleted).toEqual([EXPORT_DB]);
  });

  it("goes when it can't say whose it is, as one from before owners were kept", async () => {
    markExportProgress(1_000_000);
    await keep('u-member-A');
    expect(deleted).toEqual([EXPORT_DB]);
  });

  it('touches nothing when there is nothing', async () => {
    await keep('u-member-A');
    expect(deleted).toEqual([]);
  });
});
