// Whether a Browser covers the bar's ring (walk L13): a free member's time ring sat under a Browser that fills the screen,
// so what was left couldn't be seen while browsing, the one time it counts. While a Browser covers it, the same ring shows
// compact in that Browser's title bar (`Meter.tsx`), and the bar's steps aside, so one ring shows at a time.
//
// "Covers" is asked of the page itself, at the ring's middle: whatever is drawn there, top first. That takes in every way a
// Browser can come over it with one rule: its window filling the screen (its own button, a double-click on its title, a
// tablet or phone where every window does), the office's full screen with it filling that, a window dragged or sized over
// the corner, and a phone's carousel on the Browser. A window the ring draws over (the bar has the keyboard) covers nothing.
import { usePhoneCarousel } from '../carousel/phone';
import { useLayoutStore } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { useWindowStore } from '../state/windowStore';

/**
 * One thing drawn at the ring's middle: the bar's ring itself, something that names itself a cover (`data-cover`: a window,
 * or a phone's carousel) with whether it's showing the Browser, or anything else (null).
 */
export type Hit = 'ring' | { cover: string; browser: boolean } | null;

/**
 * The Browser covering the bar's ring, from what's drawn at its middle, top first: the first cover above the ring, if it's
 * a Browser. The ring on top, another app's window over it, or no cover at all: null. Anything else is passed over
 * (Maia's bubble over a window covers nothing of the Browser's).
 */
export function coverAt(stack: readonly Hit[]): string | null {
  for (const hit of stack) {
    if (hit === 'ring') return null;
    if (hit) return hit.browser ? hit.cover : null;
  }
  return null;
}

/** The bar's ring (`Meter.tsx`); the title bar's is `.free-ring`. */
const BAR = '.free-meter';

/** What an element at the ring's middle is: inside the bar's ring, inside a cover, or neither. */
export function hitOf(el: Element): Hit {
  if (el.closest(BAR)) return 'ring';
  const c = el.closest('[data-cover]');
  if (!c) return null;
  return { cover: c.getAttribute('data-cover') ?? '', browser: c.getAttribute('data-app') === 'browser' };
}

/** Asked of the page now. The bar's ring keeps its place while it steps aside (`visibility`), so its middle is known. */
function measure(): string | null {
  const btn = document.querySelector(`${BAR} .bw-btn`);
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return coverAt(document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).map(hitOf));
}

/** Past a window's open (240 ms), its close (180 ms) and a carousel's slide (220 ms), so what's drawn has settled. */
const SETTLE_MS = 320;
let frame = 0;
let later = 0;
let apply: (key: string | null) => void = () => {};

function run(): void {
  frame = 0;
  apply(measure());
}

/** Something that may change what covers the ring happened: asked on the next frame, and again once motion has settled. */
export function recheckCover(): void {
  if (typeof window === 'undefined') return;
  if (!frame) frame = window.requestAnimationFrame(run);
  window.clearTimeout(later);
  later = window.setTimeout(run, SETTLE_MS);
}

/**
 * Once a page, from the free chunk: asked again whenever a window opens, closes, moves, fills the screen or is raised,
 * the desk looked at changes (another desk's windows are parked), a phone's carousel moves, or the page's size or full
 * screen changes. The rings themselves ask too, as they come and go (`Meter.tsx`).
 */
export function watchCover(set: (key: string | null) => void): void {
  apply = set;
  useWindowStore.subscribe(recheckCover);
  useViewStore.subscribe(recheckCover);
  useLayoutStore.subscribe(recheckCover);
  usePhoneCarousel.subscribe(recheckCover);
  window.addEventListener('resize', recheckCover);
  document.addEventListener('fullscreenchange', recheckCover);
  recheckCover();
}
