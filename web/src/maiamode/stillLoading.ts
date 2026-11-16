// "Still loading your office…" under the startup chooser, only while the office really is still loading (the owner, Nov 16: it
// said so over an office that had loaded, "because when I click on Desk, the whole thing is instant"). It shows `STILL_MS` in
// unless the office has said it's ready by then (`onOfficeReady`, the same word that ends the loader's overlay, held or not), and
// goes once it says so: a quiet fade, at once under reduced motion (chooser.css).
import { onOfficeReady } from '../chrome/loadingOverlay';

export const STILL_MS = 10_000;

/** Tests can shorten the wait, outside production builds only: `?stillLoadingMs=500`. */
export function stillMs(): number {
  if (import.meta.env.MODE === 'production' || typeof location === 'undefined') return STILL_MS;
  const n = Number(new URLSearchParams(location.search).get('stillLoadingMs'));
  return n > 0 ? n : STILL_MS;
}

/** Shows `line` (its class `on`) after `ms` while the office hasn't said it's ready, and takes it away once it has. */
export function followStillLine(line: { classList: { toggle(name: string, on: boolean): boolean } }, ms = stillMs()): () => void {
  const timer = setTimeout(() => line.classList.toggle('on', true), ms);
  const off = onOfficeReady(() => {
    clearTimeout(timer);
    line.classList.toggle('on', false);
  });
  return () => {
    clearTimeout(timer);
    off();
  };
}
