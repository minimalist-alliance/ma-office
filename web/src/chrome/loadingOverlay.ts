// The loading overlay, the office's half (ADR 0058). Platform's loader page draws `#ma-ld`, the theme's mark on the theme's
// ground with the Product Designer's glint under it, from the first paint (ma-platform `sites/desk-loader/`). The office
// says when it's ready, and this fades it out and removes it, once a page. "Ready" is the first frame the member sees of
// the office they'll use: /v1/me answered (or failed), the desk list answered (not the mirror), the free tier's chunk in
// for a free member, fonts in, and the canvas drawn after all that; or a card standing in for desks; or a page that isn't
// the office. Not the desk links, and no other lazy chunk. The loader takes it away itself on its kill switch, a failure,
// a bundle from before it, or after 15 s. In the first load: a few hundred bytes.
import { useEffect } from 'react';
import { camera } from '../canvas/controller';
import { meAnswered, useSession } from '../platform/session';
import { useDeskStore, type DeskListStatus } from '../state/deskStore';

export type ReadyReason = 'desks' | 'card' | 'signIn' | 'refused' | 'export' | 'connect' | 'error' | 'maia' | 'welcome';

/** `loading.css`'s longest fade is 600 ms; one whose `animationend` never comes is cut off here. */
const FADE_CAP_MS = 700;
let done = false;
/**
 * Maia Mode's startup holds the ending while it decides which mode the page opens in (`maiamode/startup.ts`), a few seconds at
 * most, and so does the welcome while it decides whether this is a new member's first load (`welcome/door.tsx`). Each holder
 * lets go on its own; once none holds, a ready that came meanwhile ends the overlay then, unless the last to let go says `run`
 * false: the room, or the welcome's threshold, says its own.
 */
let hold: ReadyReason | true | null = null;
const holders = new Set<string>();
export function holdLoading(on: boolean, run = true, who = 'maia'): void {
  if (on) holders.add(who);
  else holders.delete(who);
  const was = hold;
  hold = holders.size ? (hold ?? true) : null;
  if (!holders.size && run && was && was !== true) loadingDone(was);
}

/**
 * The office has said it's ready (or failed), whether or not a holder keeps the overlay up meanwhile: Maia Mode's chooser asks
 * over a loaded office, and its "Still loading your office…" line must know (the owner, Nov 16). `onOfficeReady` hears it once,
 * at once if it's already been said.
 */
let ready = false;
const readyListeners = new Set<() => void>();
function said(): void {
  if (ready) return;
  ready = true;
  for (const fn of readyListeners) fn();
  readyListeners.clear();
}
export const officeHasSaidReady = (): boolean => ready;
export function onOfficeReady(fn: () => void): () => void {
  if (ready) {
    fn();
    return () => undefined;
  }
  readyListeners.add(fn);
  return () => void readyListeners.delete(fn);
}

/**
 * Takes the loader's overlay away, as the Designer's spec says (loader.js does the same steps): `aria-hidden` and no
 * `aria-busy` on the same frame, then the full fade, or the bare ground's if the mark hadn't begun to show, removed on its
 * own `animationend`. A hidden tab, an overlay `loading.css` never styled (still `hidden`), or one its safety already hid,
 * goes at once. `aria-hidden` says it's
 * going, so whichever of the loader and the office comes second leaves it be. Only the first call does anything.
 */
export function loadingDone(reason: ReadyReason): void {
  said();
  if (done) return;
  if (hold && reason !== 'error') {
    hold = reason;
    return;
  }
  done = true;
  performance.mark('ma:office-ready', { detail: reason });
  document.getElementById('ma-root')?.removeAttribute('aria-busy');
  const el = document.getElementById('ma-ld');
  if (!el || el.hasAttribute('aria-hidden')) return; // a loader without it, its kill switch, or its safety took it away
  el.setAttribute('aria-hidden', 'true');
  const remove = (): void => el.remove();
  const cs = getComputedStyle(el);
  if (document.hidden || cs.display === 'none' || cs.opacity === '0') return remove();
  const inner = el.querySelector('.ma-ld-in');
  const shown = !!inner && getComputedStyle(inner).opacity !== '0';
  el.addEventListener('animationend', (e) => {
    if (e.target === el) remove();
  });
  window.setTimeout(remove, FADE_CAP_MS);
  el.classList.add(shown ? 'ma-ld-out' : 'ma-ld-fast');
}

/**
 * Whether the office's first frame will hold still: the desk list's answer is in (the mirror doesn't count), `/v1/me` has
 * answered or failed (a last visit's record doesn't count: C and D's cards and the tier's parts depend on it), and a free
 * member's chunk is in. A card (`DeskNotice`) is enough by itself: it's what the member reads. A card that's due but whose
 * chunk isn't in yet (`cardDue`) holds it: the answers are in, but the frame they'd show is the empty office the card is
 * about to cover (the list failing, a closed account over its desks).
 */
export function officeSettled(list: DeskListStatus, me: boolean, tierParts: boolean, card: boolean, cardDue = false): boolean {
  return card || (!cardDue && list !== 'loading' && me && tierParts);
}

/**
 * The shell's half. `fonts`: the stage is mounted (it waits for fonts, at most 800 ms). `card`: a `DeskNotice` is shown.
 * `cardDue`: one is due (its chunk may still be loading). `tierParts`: the free tier's chunk is in, or failed, or this isn't a free member. Ready on the canvas's next frame once
 * settled, one animation frame later so that frame is on screen. A frame painted before (the mirror's desks, an empty
 * stage) doesn't count: the answers can still change it.
 */
export function useOfficeReady(fonts: boolean, card: boolean, tierParts: boolean, cardDue = false): void {
  const list = useDeskStore((s) => s.status);
  const me = useSession(meAnswered);
  const settled = fonts && officeSettled(list, me, tierParts, card, cardDue);
  useEffect(() => {
    if (!settled) return undefined;
    const layer = camera.getStage()?.getLayers()[0];
    let frame = 0;
    const ready = (): void => {
      frame = requestAnimationFrame(() => loadingDone(card ? 'card' : 'desks'));
    };
    if (!layer) {
      ready();
      return () => cancelAnimationFrame(frame);
    }
    layer.on('draw.maReady', () => {
      layer.off('draw.maReady');
      ready();
    });
    layer.batchDraw();
    return () => {
      layer.off('draw.maReady');
      cancelAnimationFrame(frame);
    };
  }, [settled, card]);
}

/** For a page that isn't the office: ready once it's shown. */
export function LoadingDone({ reason }: { reason: ReadyReason }): null {
  useEffect(() => loadingDone(reason), [reason]);
  return null;
}
