// The Browser's last screen, kept in the member's own browser (ma-platform ADR 0097, ADR 0047 here). For a desk that
// starts with the office (the Alliance Member's hosted small desk), a copy of the last frame is kept in this browser's
// IndexedDB, so the window shows it at once while the desk wakes, and the real picture replaces it on its first frame.
//
// It never leaves this browser: no request carries it, and nothing on the desk or the platform reads it. One picture a
// desk, downscaled and JPEG, about 100 KB. Sign-out deletes them all (`session.ts`), so the next person on a shared
// computer sees nothing. It's a picture of the screen only: the desk's own browser data (cookies, history) is on its
// disk and is never touched by this or anything else here.
//
// A sign-out closes the desk links, and a closing link keeps one last copy, which takes a few ms to encode. So a clear
// also drops every save begun before it, and nothing more is kept until someone signs in again (`keepLastScreens`):
// otherwise that copy reopened the database after the delete, and the picture outlived the sign-out (the weekend review).
// A picture past MAX_AGE_MS is deleted whenever one is read, not only skipped.
//
// Every call is best effort: storage that's off, full or private-mode just means no picture, never an error.

const DB = 'ma-last-screen';
const STORE = 'screens';
/** Wide enough to read a page at a glance while the stream starts; the stream itself is 1280 wide at most. */
export const MAX_WIDTH = 1280;
export const QUALITY = 0.7;
/** An old picture is worse than none: a member back after a month sees the waking panel alone. */
export const MAX_AGE_MS = 7 * 86_400_000;

interface Kept {
  blob: Blob;
  savedAt: number;
}

/** Bumped by each clear. A save begun before it never writes. */
let clears = 0;
/** Off from a clear until the next sign-in: nothing is kept while nobody's signed in. */
let keeping = true;

/** Someone has signed in: their pictures may be kept again. */
export function keepLastScreens(): void {
  keeping = true;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
}

/** The size to keep a `w`×`h` frame at: never wider than MAX_WIDTH, never enlarged. */
export function keptSize(w: number, h: number): { w: number; h: number } {
  if (w <= MAX_WIDTH) return { w, h };
  return { w: MAX_WIDTH, h: Math.round((h * MAX_WIDTH) / w) };
}

/** Keep what `source` shows now as this desk's last screen. */
export async function saveLastScreen(deskId: string, source: HTMLVideoElement | HTMLCanvasElement, now = Date.now()): Promise<void> {
  if (!keeping) return;
  const begun = clears;
  const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!w || !h) return;
  const size = keptSize(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    ctx.drawImage(source, 0, 0, size.w, size.h);
  } catch {
    return;
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  canvas.width = 0;
  // Nothing awaits between this check and the open in `tx`, so a clear that comes later is queued behind this write.
  if (!blob || !keeping || begun !== clears) return;
  await tx('readwrite', (s) => s.put({ blob, savedAt: now } satisfies Kept, deskId));
}

const expired = (k: Kept | undefined, now: number): boolean => !k || !(k.blob instanceof Blob) || !(now - k.savedAt <= MAX_AGE_MS);

/** This desk's last screen, unless there's none or it's older than MAX_AGE_MS. Every desk's picture past that age goes. */
export async function loadLastScreen(deskId: string, now = Date.now()): Promise<Blob | null> {
  if (!keeping) return null;
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    let found: Blob | null = null;
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.oncomplete = t.onabort = t.onerror = () => resolve(found);
      const req = t.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const kept = cursor.value as Kept | undefined;
        if (expired(kept, now)) cursor.delete();
        else if (cursor.key === deskId && kept) found = kept.blob;
        cursor.continue();
      };
    } catch {
      resolve(null);
    } finally {
      db.close();
    }
  });
}

/**
 * Sign-out, or a session that ended: every desk's picture goes, a save already on its way included, and nothing more is
 * kept until `keepLastScreens`. Resolves once the database is gone, which an open connection can hold up for as long as
 * its write takes: callers cap the wait (`forAtMost`).
 */
export function clearLastScreens(): Promise<void> {
  clears += 1;
  keeping = false;
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
