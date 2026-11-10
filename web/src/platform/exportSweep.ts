// An unfinished export leaves its working copy, its journal and their key in this browser (`src/export/`, draft ADR
// "data export and transfer"). The copy and the journal are encrypted under that key, and members use the office on
// shared computers, so all of it goes: after 6 hours without progress with no tab writing it (checked as the office
// loads, and every 10 minutes while it's open), at sign-out, when a dead session goes off to sign in, when this
// browser starts with nobody signed in, and when anyone but the member who started it signs in. That's why it's here,
// in the main bundle: none of those waits for the export page to load.
export const EXPORT_DB = 'ma-export';
export const EXPORT_WORKING = 'ma-export-working.zip';
export const EXPORT_IDLE_MS = 6 * 60 * 60 * 1000;
const AT = 'ma.export.at';
/** Whose it is, as `exportOwnerTag` gives it. */
const OWNER = 'ma.export.owner';

/** The member a download belongs to, as a hash of their id, so the id itself is never kept for it. */
export async function exportOwnerTag(sub: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ma-export-owner:${sub}`)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new download is this member's. Written before anything of it, so no other tab finds it without an owner. */
export function markExportOwner(tag: string): void {
  try {
    localStorage.setItem(OWNER, tag);
  } catch {
    // the export page checks the key's own record too
  }
}

/**
 * Who's signed in now (`sub`), or nobody (null). A download of anyone else's goes, and so does one this browser
 * can't say whose it is; with nobody signed in, any download goes. Only the member who started it may carry it on.
 */
export async function keepExportFor(sub: string | null): Promise<void> {
  let owner: string | null;
  let at: string | null;
  try {
    owner = localStorage.getItem(OWNER);
    at = localStorage.getItem(AT);
  } catch {
    // Can't tell from here whose it is; the export page checks the key's own record before it offers anything.
    if (sub === null) await dropExport();
    return;
  }
  if (sub !== null && owner === null && at === null) return; // nothing here
  if (sub !== null && owner !== null && owner === (await exportOwnerTag(sub))) return;
  await dropExport();
}

/** The download moved on: its 6 hours count from `at`. A time, never anything of the member's. */
export function markExportProgress(at: number): void {
  try {
    localStorage.setItem(AT, String(at));
  } catch {
    // the export page checks its own journal's time too
  }
}

export const exportExpired = (at: number, now: number): boolean => now - at >= EXPORT_IDLE_MS;

/** Deletes it all. Resolves once it's gone, or once deleting is under way where another tab still holds the journal. */
export function dropExport(): Promise<void> {
  try {
    localStorage.removeItem(AT);
    localStorage.removeItem(OWNER);
  } catch {
    // nothing to do
  }
  const db = new Promise<void>((done) => {
    try {
      const r = indexedDB.deleteDatabase(EXPORT_DB);
      r.onsuccess = r.onerror = r.onblocked = () => done();
    } catch {
      done();
    }
  });
  const file = Promise.resolve()
    .then(() => navigator.storage.getDirectory())
    .then((d) => d.removeEntry(EXPORT_WORKING))
    .catch(() => {});
  return Promise.all([db, file]).then(() => undefined);
}

/** At most a second of a sign-out. The key goes with the journal, which is what leaves the copy unreadable. */
export const dropExportSoon = (): Promise<void> => Promise.race([dropExport(), new Promise<void>((r) => window.setTimeout(r, 1000))]);

/**
 * A partial export left 6 hours with no progress goes, unless a tab is still writing it: that tab holds the
 * `ma-export` Web Lock (`src/export/working.ts`), and a computer that slept through the 6 hours wakes with it held.
 */
export function sweepExport(now = Date.now()): void {
  let at = 0;
  try {
    at = Number(localStorage.getItem(AT)) || 0;
  } catch {
    return;
  }
  if (!at || !exportExpired(at, now)) return;
  if (!navigator.locks) {
    void dropExport();
    return;
  }
  navigator.locks
    .request(EXPORT_DB, { ifAvailable: true }, async (lock) => {
      if (lock) await dropExport();
    })
    .catch(() => {});
}

/** As the office loads, then every 10 minutes. */
export function startExportSweep(): void {
  sweepExport();
  window.setInterval(() => sweepExport(), 10 * 60 * 1000);
}
