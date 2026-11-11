// The close guard: the browser's own "Leave site?" prompt, armed only while closing the office would lose something the
// member made. Each app says what it holds by its own id (a draft with text, a Notebook edit not on its desk yet, a Files
// transfer running, an export, a settings form with changes) and lets go the moment it hasn't, so the rule is here once.
// Never for a desk being connected or a window being open: a guard that asks too often is noise. Its words are the browser's.
import { useEffect, useId } from 'react';

type Check = () => boolean;
const holds = new Map<string, Check>();
const always: Check = () => true;
/** The office is over for this page (`letClose`): nothing holds it again. */
let over = false;

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!closeHeld()) return;
  e.preventDefault();
  e.returnValue = ''; // what older browsers need
}

/** Whether leaving now would lose something: any hold whose check still says so. */
export function closeHeld(): boolean {
  for (const check of holds.values()) if (check()) return true;
  return false;
}

/**
 * Holds the page while `id` has something to lose, or lets it go with `false`. A check, where given, is asked again as
 * the page goes, for what can change without a word (a Notebook page reaching its desk). The listener is on the window
 * only while something is held.
 */
export function holdClose(id: string, on: boolean | Check): void {
  if (typeof window === 'undefined' || over) return;
  const was = holds.size;
  if (on === false) holds.delete(id);
  else holds.set(id, on === true ? always : on);
  if (!was && holds.size) window.addEventListener('beforeunload', onBeforeUnload);
  else if (was && !holds.size) window.removeEventListener('beforeunload', onBeforeUnload);
}

/**
 * Lets the page go, for good: the member signed out, or the session ended, so nothing here can reach a desk any more, and
 * the browser's prompt would only stand between them and the sign-in page. For tests, `again` arms it once more.
 */
export function letClose(again = false): void {
  over = !again;
  if (holds.size && typeof window !== 'undefined') window.removeEventListener('beforeunload', onBeforeUnload);
  holds.clear();
}

/** `holdClose` for a component: held while `on`, and let go when it unmounts. */
export function useCloseHold(on: boolean): void {
  const id = useId();
  useEffect(() => {
    holdClose(id, on);
  }, [id, on]);
  useEffect(() => () => holdClose(id, false), [id]);
}
