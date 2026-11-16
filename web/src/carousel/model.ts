// Carousel mode (the owner, Nov 9): "each app takes up most of the real estate of the desk and shows the full app and I
// can swipe through each app one at a time". Pure rules only, so they're the same for the canvas, the proxies, the
// keyboard and the stage, and tested on their own. In the initial bundle: it's small, and the switch draws before any
// of the carousel's own chunk has loaded. The stage's own rules (its box on screen, swipes, keys) are `stage.ts`, in that
// chunk since `sub/mm-js-budget`.
import { type AppId, type DeskCarousel, type LayoutDesk } from '../canvas/layout';
import { appsInOrder } from '../shell/order';
import { mayHaveApp } from '../platform/age';

export const carouselOn = (desk: Pick<LayoutDesk, 'carousel'> | undefined): boolean => desk?.carousel?.on === true;

/** The apps a carousel goes through: the desk's own, in the order the keyboard meets them (reading order), each once. */
export function carouselApps(desk: Pick<LayoutDesk, 'items'>): AppId[] {
  const seen = new Set<AppId>();
  for (const item of appsInOrder(desk.items, false)) if (mayHaveApp(item.app)) seen.add(item.app);
  return [...seen];
}

/** Which app shows: the one saved, if the desk still has it, else the first. Null on a desk with no apps. */
export function shownApp(desk: Pick<LayoutDesk, 'items' | 'carousel'>): AppId | null {
  const apps = carouselApps(desk);
  const saved = desk.carousel?.app;
  return saved && apps.includes(saved) ? saved : apps[0] ?? null;
}

/** Where the shown app is in the list, from 0, and how many there are. */
export function positionOf(desk: Pick<LayoutDesk, 'items' | 'carousel'>): { index: number; count: number } {
  const apps = carouselApps(desk);
  const app = shownApp(desk);
  return { index: app ? apps.indexOf(app) : 0, count: apps.length };
}

/** The app one step along, or null past either end: it doesn't wrap, so the ends read as ends. */
export function stepApp(desk: Pick<LayoutDesk, 'items' | 'carousel'>, dir: 1 | -1): AppId | null {
  const apps = carouselApps(desk);
  const app = shownApp(desk);
  if (!app) return null;
  return apps[apps.indexOf(app) + dir] ?? null;
}

/** "2 of 4": the words for where a carousel is, which the dots draw. */
export const positionWords = (index: number, count: number): string => `${index + 1} of ${count}`;

/** The carousel's next state for the switch: on with the app given, or off keeping the one that was showing. */
export function toggled(desk: Pick<LayoutDesk, 'items' | 'carousel'>, app: AppId | null): DeskCarousel | null {
  if (carouselOn(desk)) {
    const showing = shownApp(desk);
    return showing ? { on: false, app: showing } : null;
  }
  const next = app ?? shownApp(desk);
  return next ? { on: true, app: next } : null;
}

// ----- swipes

/** How far a sideways swipe has to go before it moves the carousel, in CSS pixels. */
export const SWIPE_PX = 56;
/** How much more sideways than up or down a swipe has to be. */
export const SIDEWAYS = 1.5;
/**
 * A finger that lands this close to the screen's left or right edge is the carousel's swipe, even on the Browser's picture,
 * whose other drags scroll the page (`browser/touchInput.ts`). A tap there is still the page's.
 */
export const EDGE_PX = 16;
