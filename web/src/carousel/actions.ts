// What the carousel's switch, its swipes and its keys do (`carousel/model.ts` has the rules). In the initial bundle, so
// the switch works before the stage's own chunk has loaded; the chunk is `CarouselLayer.tsx`.
import type { AppId } from '../canvas/layout';
import { isPhone } from '../canvas/phone';
import { appLabel, focusDesk, focusProxy, refitDesk } from '../shell/actions';
import { announce } from '../shell/announce';
import { setCarousel, useLayoutStore } from '../state/layoutStore';
import { getView } from '../state/viewStore';
import { removeWindow, topWindow, useWindowStore } from '../state/windowStore';
import { carouselApps, carouselOn, positionOf, positionWords, stepApp, toggled } from './model';
import { asPhoneSees, phoneApp, setPhoneShown } from './phone';

/** The carousel's switch on a desk's strip: `aria-pressed` while it's on. */
export const carouselProxyId = (deskId: string): string => `carousel:${deskId}`;
export const switchLabel = (on: boolean): string => (on ? 'Back to the desk' : 'Carousel');

/** Set by the switch, so the stage that mounts next takes the keyboard, as a window does when it opens. */
let focusOnShow: string | null = null;
export function takeFocusOnShow(deskId: string): boolean {
  if (focusOnShow !== deskId) return false;
  focusOnShow = null;
  return true;
}

/** A desk's windows go into its carousel: there's one place each app shows, never a window and a slide of it at once. */
function closeDeskWindows(deskId: string): void {
  for (const w of Object.values(useWindowStore.getState().windows)) if (w.deskId === deskId) removeWindow(w.key);
}

/** The desk as this screen's carousel has it: a phone's own (`phone.ts`), or the desk's saved one. */
function seen(deskId: string) {
  const desk = useLayoutStore.getState().desks[deskId];
  return desk && isPhone() ? asPhoneSees(desk) : desk;
}

function sayWhere(deskId: string): void {
  const desk = seen(deskId);
  const app = desk?.carousel?.app;
  if (!desk || !app) return;
  const { index, count } = positionOf(desk);
  announce(`${appLabel(app, deskId)}, ${positionWords(index, count)}`);
}

/**
 * The switch at the desk's bottom right. On, the desk shows one app at a time: the window on top of this desk's, if it
 * has one open, else the one it showed last, else its first. Off, it's the desk as before. Not on phones, whose
 * carousel is their own (`phone.ts`): a tile opens it, `backToDesk` leaves it.
 */
export function toggleCarousel(deskId: string): void {
  if (isPhone()) return;
  const desk = useLayoutStore.getState().desks[deskId];
  if (!desk) return;
  const wasOn = carouselOn(desk);
  const top = wasOn ? null : topWindow(deskId);
  const next = toggled(desk, top && carouselApps(desk).includes(top.app) ? top.app : null);
  if (!next) return;
  if (next.on) closeDeskWindows(deskId);
  setCarousel(deskId, next);
  if (next.on) {
    focusOnShow = deskId;
    sayWhere(deskId);
  }
  // The desk fits the screen again for its new mode: as large as it can be for the stage, or as a desk is. It's the
  // member opening an app on this desk, so it wakes the desk as opening one would; going back to the desk wakes nothing.
  const v = getView();
  const here = v.activeDesk === deskId && v.mode !== 'overview';
  if (next.on) focusDesk(deskId);
  else if (here) refitDesk(deskId);
}

/**
 * A phone's way out of its carousel: the head's back arrow, the thumb row's "Back to the desk", or Esc. The phone's own
 * choice becomes the desk, and nothing is saved: a larger screen's carousel on this desk stays as it was. The keyboard
 * goes back to that app's tile, as from a closed window.
 */
export function backToDesk(deskId: string): void {
  const desk = useLayoutStore.getState().desks[deskId];
  const app = desk ? phoneApp(desk) : null;
  if (!desk || !app) return;
  setPhoneShown(deskId, null);
  const item = desk.items.find((i) => i.app === app);
  if (item) focusProxy(item.id);
}

/** One app along, by a swipe, a key or a button. Nothing past the ends. */
export function stepCarousel(deskId: string, dir: 1 | -1): boolean {
  const desk = seen(deskId);
  if (!desk || !carouselOn(desk)) return false;
  const app = stepApp(desk, dir);
  if (!app) return false;
  if (isPhone()) setPhoneShown(deskId, app);
  else setCarousel(deskId, { on: true, app });
  sayWhere(deskId);
  return true;
}

/** Straight to one app: a dot or a phone's glyph, or anything that opens an app's window on this desk (`openWindow`). */
export function showInCarousel(deskId: string, app: AppId): void {
  if (isPhone() ? setPhoneShown(deskId, app) : setCarousel(deskId, { on: true, app })) sayWhere(deskId);
}

/**
 * A desk turned to carousel elsewhere (another browser, through the layout's sync) while this one has its windows open:
 * they go into the carousel too. Windows open on this page by anything else already went there (`openWindow`).
 */
export function watchCarouselWindows(): () => void {
  const sweep = (): void => {
    if (isPhone()) return; // a phone's carousel is its own, and a larger screen's leaves it be
    const desks = useLayoutStore.getState().desks;
    for (const w of Object.values(useWindowStore.getState().windows)) if (carouselOn(desks[w.deskId])) removeWindow(w.key);
  };
  sweep();
  return useLayoutStore.subscribe(sweep);
}
