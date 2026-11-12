// What the canvas, the proxy layer, the keyboard and the chrome all do. One implementation, so
// they can't drift. Component code calls these; these call the camera and the stores.
import { zoomedInOn } from '../canvas/camera';
import { camera } from '../canvas/controller';
import { deskBounds, detailLevel, isAgentApp, isDeskApp, unionBounds, type AppId, type CoreAppId, type LayoutItem, type Rect } from '../canvas/layout';
import { host } from '../deskapps/door';
import { agentAppName } from '../agent/roster';
import { isPhone } from '../canvas/phone';
import { deskClosed, wakeDesk } from '../desk/liveStore';
import { loadedConfig, supportAddress } from '../platform/clientConfig';
import { useFree } from '../free/door';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { raiseDesk, useLayoutStore } from '../state/layoutStore';
import { getView, setView, type Scope } from '../state/viewStore';
import { openWindow, requestClose, topWindow } from '../state/windowStore';
import { announce } from './announce';
import { restack } from './cleanup';
import { readingOrder } from './order';
import { carouselOn, positionOf, positionWords } from '../carousel/model';
import { asPhoneSees } from '../carousel/phone';
import { readJson, writeJson } from '../lib/util';

export function inScopeDesks(scope: Scope = getView().scope): DeskInfo[] {
  const { desks } = useDeskStore.getState();
  return scope === 'all' ? desks : desks.filter((d) => d.kind === scope);
}

function rects(list: readonly DeskInfo[]): { id: string; rect: Rect }[] {
  const layout = useLayoutStore.getState().desks;
  return list.flatMap((d) => {
    const l = layout[d.id];
    return l ? [{ id: d.id, rect: deskBounds(l, isPhone()) }] : [];
  });
}

export function orderedDeskIds(): string[] {
  return readingOrder(rects(inScopeDesks())).map((d) => d.id);
}

function nameOf(id: string): string {
  return useDeskStore.getState().desks.find((d) => d.id === id)?.name ?? 'Desk';
}

/** What focusing a desk that can't open says after its name, so it never seems to do nothing. */
function closedWords(id: string): string {
  if (useDeskStore.getState().desks.find((d) => d.id === id)?.removed) return ", you're no longer in this guild";
  switch (deskClosed(id)) {
    case 'setting-up':
      return ', still being set up';
    case 'held':
      return `, ${supportAddress(loadedConfig())}`;
    case 'membership':
      return ', membership not active';
    case 'data_guard':
      return ', stopped, data use past your plan';
    default:
      return '';
  }
}

function fitDesk(id: string, animate: boolean, raise = true): boolean {
  const layout = useLayoutStore.getState().desks[id];
  if (!layout) return false;
  const changed = getView().activeDesk !== id || getView().mode !== 'desk';
  setView({ activeDesk: id, mode: 'desk' });
  if (raise) raiseDesk(id);
  camera.animateTo(camera.fit(deskBounds(layout, isPhone()), carouselOn(layout) && !isPhone() ? 'stage' : 'desk'), animate ? undefined : 0);
  if (changed) announce(`${nameOf(id)} desk${closedWords(id)}`);
  return true;
}

/** Fit the desk again for what it now shows (carousel mode or not), and wake nothing. */
export function refitDesk(id: string): void {
  fitDesk(id, true);
}

// The desk the member focused: a click or tap on it, a key, a card. One the office focuses for them (arriving, or a
// scope or Fit with one desk) isn't, so a click outside leaves it be (ADR 0003). A pan or a zoom leaves desk mode.
let chosen: string | null = null;

/** Focusing a desk wakes it if it's stopped (design 3.9, 10.5). */
export function focusDesk(id: string, animate = true): void {
  if (!fitDesk(id, animate)) return;
  chosen = id;
  if (readJson<string>(LANDED)) writeJson(LANDED, null); // the member's own pick is remembered from here
  wakeDesk(id);
}

/** The office focusing a desk for the member. It wakes the same, but it isn't one they chose. */
function showDesk(id: string, animate = true, raise = true): void {
  if (!fitDesk(id, animate, raise)) return;
  chosen = null;
  wakeDesk(id);
}

/** All in-scope desks, however few. This never wakes a desk or closes anything. */
export function goOverview(animate = true): void {
  const ids = orderedDeskIds();
  if (!ids.length) return;
  const active = getView().activeDesk;
  setView({ mode: 'overview', activeDesk: active && ids.includes(active) ? active : ids[0]! });
  // The free tier's empty desk spot is in view too (`free/door.ts`; unset today).
  const bounds = unionBounds([...rects(inScopeDesks()).map((r) => r.rect), ...(useFree.getState().frames?.() ?? [])]);
  camera.animateTo(camera.fit(bounds, 'overview'), animate ? undefined : 0);
}

/** The Fit button and `0`: everything in scope, which with one desk means filling the screen with it. */
export function fitScope(): void {
  const ids = orderedDeskIds();
  if (ids.length === 1) showDesk(ids[0]!);
  else goOverview();
}

/**
 * A click on the canvas outside every desk. It's a way out, like Esc and the mark, but only from a desk in
 * focus: one the member focused, or zoomed in on (`zoomedInOn`). Any other view is the member's own and the
 * click leaves it be (ADR 0003), one desk or many. An open window holds the view too: the overview parks
 * windows, and clicking away from a window is too easy a habit to have it take the member's work off the screen. So
 * does a desk in carousel mode, whose stage is an app at work in the same way (`carousel/`).
 */
export function emptyCanvasClicked(): void {
  const { mode, activeDesk } = getView();
  const layout = activeDesk ? useLayoutStore.getState().desks[activeDesk] : undefined;
  if (mode === 'overview' || topWindow(activeDesk) || (carouselOn(layout) && !isPhone())) return;
  const focused = (mode === 'desk' && activeDesk === chosen)
    || rects(inScopeDesks()).some(({ rect }) => zoomedInOn(rect, camera.cam, camera.vp, camera.fit(rect, 'desk').s));
  if (focused) goOverview();
}

// The first refit of a page load is the member arriving, so desk mode counts as focusing that desk,
// and so does having only one desk to arrive at: it wakes, though it isn't one the member chose (`showDesk`).
// Every later one is a resize or a list change, and those must never wake a desk or bring back a member who zoomed out.
//
// "Only one desk" starts an EC2, so it's Platform's list that says so, counting every desk on it. Until the
// list answers, the desks here are the ones this browser remembers, and a new one may not be among them, or
// may have no layout yet. So the first refits only paint, and the arrival waits for the answer.
//
// A phone arrives at its desk, not at the overview: with several desks the overview is three small grey rectangles on a
// screen that fits one desk well. So a phone with more than one desk arrives like a one-desk member, on the desk it
// remembers if that's still in scope, else the first. Larger screens still arrive on the overview.
let arrived = false;

/** For tests: the next refit is an arrival again. */
export function resetArrival(): void {
  arrived = false;
}

/** The desk this phone was put on asleep, with nothing chosen (the view saves it as `activeDesk` all the same). */
const LANDED = 'ma.view.landed.v1';

/**
 * The desk a phone arrives at, and whether arriving wakes it. The remembered desk if it's still in scope (it wakes, as
 * focusing it always does). With nothing remembered, the first desk already awake, which needs no wake; else the first that
 * can open, framed asleep so the member starts it with the desk's own control; else the first, also asleep. The office never
 * starts a desk the member didn't pick.
 */
const isAwake = (id: string): boolean => {
  const vm = useDeskStore.getState().desks.find((d) => d.id === id)?.vm;
  return (vm === 'running' || vm === 'starting') && !deskClosed(id);
};

function phoneDesk(ids: string[]): { id: string; wake: boolean } {
  const a = getView().activeDesk;
  // A desk the office framed asleep isn't one the member chose, though the view saved it: it doesn't count as remembered.
  if (a && ids.includes(a) && a !== readJson<string>(LANDED)) return { id: a, wake: true };
  const vmOf = (id: string) => useDeskStore.getState().desks.find((d) => d.id === id)?.vm;
  const awake = ids.find((id) => isAwake(id));
  if (awake) return { id: awake, wake: false };
  const open = ids.find((id) => !useDeskStore.getState().desks.find((d) => d.id === id)?.removed && !['setting-up', 'held', 'removed'].includes(vmOf(id) ?? '') && !deskClosed(id));
  return { id: open ?? ids[0]!, wake: false };
}

/** Re-fit whatever the current mode shows: on load, on a resize, or after the desk list changes. */
export function refit(animate: boolean): void {
  const v = getView();
  const ids = orderedDeskIds();
  if (!ids.length) return;
  const arriving = !arrived;
  const { desks, status } = useDeskStore.getState();
  const inDeskMode = v.mode === 'desk' && !!v.activeDesk && ids.includes(v.activeDesk);
  const phone = isPhone();
  if (arriving && status !== 'ready' && (phone || v.mode !== 'free') && !inDeskMode) {
    // What's most likely to stay, with no change to the view or anything else: one desk filling the screen, or all of them.
    // A phone's is the desk it remembers, whatever else it saved, since that is where it will land.
    const layout = useLayoutStore.getState().desks[phone ? phoneDesk(ids).id : ids[0]!];
    if (layout && (phone || desks.length === 1)) camera.animateTo(camera.fit(deskBounds(layout, phone), carouselOn(layout) && !phone ? 'stage' : 'desk'), 0);
    else goOverview(animate);
    return;
  }
  arrived = true;
  if (arriving && phone && desks.length > 1) {
    // Whatever the phone saved (the overview, a free camera), it lands on its desk. Esc and the mark still go to the overview.
    // Without raising it: arriving mustn't rewrite the member's saved stacking, and a phone shows one desk anyway.
    const pick = phoneDesk(ids);
    if (pick.wake) showDesk(pick.id, animate, false);
    else {
      fitDesk(pick.id, animate, false); // frames it with no wake: the member starts it themselves
      if (!isAwake(pick.id)) writeJson(LANDED, pick.id);
    }
    return;
  }
  if (v.mode === 'free') {
    // Keep a free camera. After a reload, restore it; with none saved, fit as usual.
    const saved = camera.takeSaved();
    if (saved) {
      camera.set(saved);
      return;
    }
    if (camera.hasMoved()) return;
  }
  if (inDeskMode) {
    if (arriving) showDesk(v.activeDesk!, animate);
    else fitDesk(v.activeDesk!, animate, false); // a re-fit (resize, list change) isn't the member raising the desk
  } else if (arriving && desks.length === 1) {
    showDesk(ids[0]!, animate);
  } else {
    goOverview(animate);
  }
}

export function setScope(scope: Scope): void {
  setView({ scope });
  const ids = orderedDeskIds();
  if (ids.length === 1) showDesk(ids[0]!);
  else {
    setView({ mode: 'overview' });
    goOverview();
  }
}

export function cycleDesk(dir: 1 | -1): void {
  const ids = orderedDeskIds();
  if (!ids.length) return;
  const v = getView();
  const i = v.activeDesk ? ids.indexOf(v.activeDesk) : -1;
  const next = ids[(i + dir + ids.length) % ids.length]!;
  if (v.mode === 'overview') {
    setView({ activeDesk: next });
    announce(`${nameOf(next)} desk`);
  } else {
    focusDesk(next);
  }
}

function launch(deskId: string, item: LayoutItem): void {
  // An installed app with apps switched off here (client-config's kill switch, or deskd's) is its widget alone, with no window.
  if (isDeskApp(item.app) && host?.openable(deskId) === false) return;
  const opened = openWindow(deskId, item.app, item.id);
  const desk = useLayoutStore.getState().desks[deskId];
  if (opened === 'carousel' && desk) {
    // In the carousel, which says where it is as it does on every step: a phone's own, or the desk's.
    const { index, count } = positionOf(isPhone() ? asPhoneSees(desk) : desk);
    announce(`${appLabel(item.app, deskId)}, ${positionWords(index, count)}`);
  } else announce(`${appLabel(item.app, deskId)} window opened`);
}

const LABELS: Record<CoreAppId, string> = { notebook: 'Notebook', browser: 'Browser', chat: 'Chat', agent: 'Agent', commons: 'Commons', files: 'Files' };
/** An app's name. An agent's own app (task 49) is its agent's name, on this desk where it's given; an installed app's is its own. */
export const appLabel = (app: AppId, deskId?: string): string => (isAgentApp(app) ? agentAppName(app, deskId) : isDeskApp(app) ? (host?.name(app, deskId) ?? 'App') : LABELS[app]);

export function openItem(deskId: string, itemId: string): void {
  const layout = useLayoutStore.getState().desks[deskId];
  const item = layout?.items.find((i) => i.id === itemId);
  if (!layout || !item) return;
  const v = getView();
  if (deskClosed(deskId) === 'held') {
    // A held desk offers nothing that needs a session: focusing it, or saying so again, is all.
    if (v.mode === 'desk' && v.activeDesk === deskId) announce(`${nameOf(deskId)} desk${closedWords(deskId)}`);
    else focusDesk(deskId);
    return;
  }
  if (v.mode === 'desk' && v.activeDesk === deskId) {
    wakeDesk(deskId);
    launch(deskId, item);
    return;
  }
  // From the overview the camera focuses the desk first and the window launches halfway through (design 3.6). An open tile
  // (ADR 0053) is the app itself once its desk is in focus, so no window opens for it on the way.
  focusDesk(deskId);
  if (isPhone() || carouselOn(layout) || detailLevel(item.w, item.h, item.app) !== 'open') window.setTimeout(() => launch(deskId, item), 160);
}

/** A click on a tile: open if it is at least 32 px on screen, otherwise focus its desk (design 3.1). */
export function tileActivated(deskId: string, itemId: string): void {
  if (76 * camera.cam.s >= 32) openItem(deskId, itemId);
  else focusDesk(deskId);
}

export function closeTopWindow(force: boolean): boolean {
  const w = topWindow(getView().activeDesk);
  if (!w) return false;
  if (w.app === 'browser' && !force) return false; // plain Esc belongs to the web page; Shift+Esc always leaves
  requestClose(w.key);
  announce(`${appLabel(w.app, w.deskId)} window closed`);
  return true;
}

export function togglePrivacy(): void {
  const on = !getView().privacyShield;
  setView({ privacyShield: on });
  announce(on ? 'Privacy shield on' : 'Privacy shield off');
}

export function focusProxy(id: string): void {
  setView({ kbFocus: id });
  document.getElementById(`proxy-${id}`)?.focus({ preventScroll: true });
}

// An app that takes keyboard focus comes to the front, so its ring is never on a covered app (ADR 0064). Focus
// that's only coming back leaves the stack alone: the menu may have just sent this app to the back, and a click
// that ended a keyboard edit may have just raised another.
let comingBack = false;

export function appFocused(deskId: string, itemId: string): void {
  setView({ kbFocus: itemId });
  if (!comingBack) restack(deskId, itemId, 'front');
}

export function focusBack(id: string): void {
  comingBack = true;
  focusProxy(id);
  comingBack = false;
}
