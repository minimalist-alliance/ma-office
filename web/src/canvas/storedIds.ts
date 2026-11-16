// Courier's id in what's stored (docs/sub-status/courier-id.md). Courier was the Chat app, and every build before this one
// stored it as `chat`: in Platform's layout document and this browser's mirror of it (an app's `app`, its `<desk>:chat` id,
// the desk's `stack` and `carousel`), and in this browser's own caches (a window's place, an app's zoom, a phone's carousel).
// In memory it's `courier`, everywhere. Reading takes either id. Writing says `STORED_COURIER`.
//
// The transition: release 19 and every build before it drop an app they don't know (`readItem`), and the next save takes
// the tile from the document for good. So this build still writes `chat`, which every build reads, and a rollback finds the
// member's layout as it left it. The first release after this one has gone out everywhere (no rollback can reach a build
// that only knows `chat`) sets `STORED_COURIER` to `courier`, and the document says `courier` from its next save. Reading
// `chat` stays: Platform keeps a document as it came, so one nobody has saved since still says it.

/** Courier's id until Nov 12, 2026, and in everything stored by the builds before. */
export const OLD_COURIER = 'chat';
export const COURIER = 'courier';
/** What this build writes for Courier. `chat` for the transition; the flip to `courier` is the status doc's "Removal". */
export const STORED_COURIER: typeof OLD_COURIER | typeof COURIER = OLD_COURIER;

/** An app's id as stored, in memory's terms: `chat` is Courier. */
export const appFromStored = (app: unknown): unknown => (app === OLD_COURIER ? COURIER : app);
/** An app's id from memory, as this build stores it. */
export const appToStored = (app: string, stored: string = STORED_COURIER): string => (app === COURIER ? stored : app);

/** `<desk>:<app>` with Courier as its app: an item's own id (`defaultDesk`) and a window's key (`windowKey`). Desk ids have no colon. */
const STORED_KEY = /^([^:]+):chat$/;
const COURIER_KEY = /^([^:]+):courier$/;
/** A `<desk>:chat` key in memory's terms; anything else as it is. */
export const keyFromStored = (key: string): string => key.replace(STORED_KEY, `$1:${COURIER}`);
/** A `<desk>:courier` key as this build stores it; anything else as it is. */
export const keyToStored = (key: string, stored: string = STORED_COURIER): string => key.replace(COURIER_KEY, `$1:${stored}`);

/** Each key of a stored record in memory's terms. A key that would land on one already there keeps its own. */
export function recordFromStored<T>(raw: Record<string, T>, key: (k: string) => string = keyFromStored): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(raw)) {
    const mine = key(k);
    if (mine === k || !(mine in raw)) out[mine] = v;
    else out[k] = v;
  }
  return out;
}

/** A record from memory, each key as this build stores it. */
export function recordToStored<T>(rec: Record<string, T>, key: (k: string) => string = keyToStored): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const theirs = key(k);
    out[theirs !== k && theirs in rec ? k : theirs] = v;
  }
  return out;
}
