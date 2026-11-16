// Whose this browser's view of the office is (ADR 0057). The camera (`ma.camera.v1`) and the view's scope, desk and mode
// (`ma.view.v1`) are kept per device (design 3.8, ISS-67) and survive a sign-out, so each is stamped with the member it was
// written for. The next member in the same browser never starts on the last one's camera: their first office is framed as
// a first office is (the owner's rule), and the same member coming back after a reload finds their own view.
//
// The stamp is the member's id only while it may be kept here: the layout mirror's own guard (`layoutMirrorWritable`,
// ISS-89). Every signed-out state, and another account's sign-in, leave both keys stamped `false`, "left at a sign-out",
// with no id (`unstampDeviceKeys`, from `forgetLayoutMirror`), and a page that may no longer keep its member's id writes
// them so too (`deviceStamp`): nothing that names the member outlives the sign-out (ISS-67, ISS-89). A view or camera left
// so is nobody's to start on, so whoever signs in next, the same member included, starts on a first visit's framing.
// No imports, so the camera, the view store and the layout store can all read it without a cycle.

export const CAMERA_KEY = 'ma.camera.v1';
export const VIEW_KEY = 'ma.view.v1';
/** The keys stamped here. Each is a JSON object with an `owner`. */
export const STAMPED_KEYS: readonly string[] = [CAMERA_KEY, VIEW_KEY];
/** The stamp of a camera or view left at a sign-out, or written where the member's id mustn't be: nobody's. */
export const LEFT = false;

/** The account this tab's tokens are, once one has said (`layoutMirrorFor`), or the mirror's owner as the page loads. */
let who: string | null = null;
/** Whether the member's id may be kept in this browser now: `layoutMirrorWritable`, handed in by the layout store. */
let mayKeep: () => boolean = () => true;

export const deviceOwner = (): string | null => who;

/** From `state/layoutStore.ts` only: the mirror's owner as it loads, then each token's `sub`. */
export function setDeviceOwner(sub: string | null): void {
  if (sub !== null) who = sub;
}

/** From `state/layoutStore.ts` only, as it loads: the stamp follows the mirror's own guard. */
export function stampsFollow(writable: () => boolean): void {
  mayKeep = writable;
}

/**
 * What a camera or view written now is stamped with: the member, while their id may be kept here; nobody known (`null`)
 * before any account has said; else `LEFT` (this page signed out, another tab did, or another account's sign-in owns
 * this browser's storage now).
 */
export const deviceStamp = (): string | null | typeof LEFT => (who === null ? null : mayKeep() ? who : LEFT);

/**
 * A kept camera or view is this member's: stamped with them, or with nobody known (an older build's, or one written before
 * any account had said). Stamped with someone else, left at a sign-out, or with anyone while nobody has said yet, it isn't.
 */
export const keptForThisMember = (stamp: unknown): boolean => stamp === undefined || stamp === null || (typeof stamp === 'string' && stamp === who);

/**
 * A signed-out state, or another account's sign-in (`forgetLayoutMirror`): both keys stay, as the device's own (the scope
 * a member chose here survives a sign-out, design 3.8), but stamped `LEFT`, so no member's id is left in them and nobody
 * starts on them. Anything that isn't a JSON object goes, as unreadable.
 */
export function unstampDeviceKeys(): void {
  for (const key of STAMPED_KEYS) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) continue;
      let kept: unknown = null;
      try {
        kept = JSON.parse(raw);
      } catch {
        /* unreadable: it goes below */
      }
      if (kept && typeof kept === 'object' && !Array.isArray(kept)) {
        if ((kept as { owner?: unknown }).owner !== LEFT) window.localStorage.setItem(key, JSON.stringify({ ...kept, owner: LEFT }));
      } else window.localStorage.removeItem(key);
    } catch {
      /* storage refused: there's nothing there to rewrite */
    }
  }
}
