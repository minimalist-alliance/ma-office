// The Browser's last screen (`lastScreen.ts`): the clear, and the gate every save and read goes through. In the first load,
// for the session (`platform/session.ts`), which clears at sign-out and on every signed-out state, and lets them be kept again
// at a sign-in; the saves and the reads are the Browser's own chunk's (`sub/mm-js-budget`).

/** The pictures' database (`lastScreen.ts`). */
export const DB = 'ma-last-screen';

/** Bumped by each clear. A save begun before it never writes. */
let clears = 0;
/** Off from a clear until the next sign-in: nothing is kept while nobody's signed in. */
let keeping = true;

/** How many clears so far: a save notes it as it begins, and never writes if it's moved since. */
export const clearsSoFar = (): number => clears;
/** Whether pictures may be kept and read now. */
export const keepingNow = (): boolean => keeping;

/** Someone has signed in: their pictures may be kept again. */
export function keepLastScreens(): void {
  keeping = true;
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
