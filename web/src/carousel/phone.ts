// A phone's carousel (the thumb row): which app this phone shows full screen on each desk. On a phone the carousel is
// simply how apps open, since a phone has no windows, so it's the phone's own and never written to the layout document:
// opening an app on a phone leaves the desk exactly as a larger screen has it (the UI/UX Engineer, Nov 10). The phone
// only reads the shared `desks[<id>].carousel`: a desk a larger screen has in carousel opens here on that app, as a
// convenience, until this phone makes its own choice for that desk. Kept in this tab's sessionStorage, so a reload keeps
// it and a new visit starts again from the shared state. In the initial bundle, beside `model.ts`: `openWindow` uses it.
import { create } from 'zustand';
import type { AppId, LayoutDesk } from '../canvas/layout';
import { carouselApps, carouselOn, shownApp } from './model';

const KEY = 'ma.phoneCarousel.v1';

/** Per desk: the app this phone shows, null for the desk itself, absent while it follows the shared state. */
export type PhoneShown = Readonly<Record<string, AppId | null>>;

function load(): PhoneShown {
  try {
    const v: unknown = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, app]) => app === null || typeof app === 'string')) as PhoneShown;
  } catch {
    return {};
  }
}

export const usePhoneCarousel = create<{ shown: PhoneShown }>(() => ({ shown: load() }));

/** This phone's own choice for a desk: an app, or null for the desk. False if it's already so. Never saved to Platform. */
export function setPhoneShown(deskId: string, app: AppId | null): boolean {
  const cur = usePhoneCarousel.getState().shown;
  if (cur[deskId] === app) return false;
  const shown = { ...cur, [deskId]: app };
  usePhoneCarousel.setState({ shown });
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(shown));
  } catch {
    /* storage unavailable: this tab still has it */
  }
  return true;
}

/**
 * The app this phone shows on a desk, or null at the desk: its own choice while the desk still holds that app, else the
 * app a larger screen's carousel is on, if it's on.
 */
export function phoneApp(desk: Pick<LayoutDesk, 'id' | 'items' | 'carousel'>, shown: PhoneShown = usePhoneCarousel.getState().shown): AppId | null {
  const own = shown[desk.id];
  if (own !== undefined) return own !== null && carouselApps(desk).includes(own) ? own : null;
  return carouselOn(desk) ? shownApp(desk) : null;
}

/**
 * The desk as this phone's carousel has it, so the model's rules (`shownApp`, `stepApp`, `positionOf`) and the stage
 * read it as they read a larger screen's. A copy for reading only: it's never stored.
 */
export function asPhoneSees(desk: LayoutDesk, shown?: PhoneShown): LayoutDesk {
  const app = phoneApp(desk, shown);
  const rest = { ...desk };
  delete rest.carousel;
  return app ? { ...rest, carousel: { on: true, app } } : rest;
}
