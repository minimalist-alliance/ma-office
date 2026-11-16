// The office tour (ADR 0056; the Product Designer's spec, `~/ma-coord/design-drafts/walkthrough/README.md`): its own chunk,
// with its own stylesheet, fetched by `door.ts` only when it may start by itself or a member asks for it.
// - A spotlight on one real thing at a time and a card beside it. A step whose target isn't there (missing, under 60 % on
//   screen, or under a window, a sheet, a menu or Maia's panel) is left out, and "{n} of {total}" counts only those shown.
// - Started by itself, it waits for the office to be quiet for 800 ms, and gives up for this page after 30 s.
// - A modal dialog: the rest of the office is inert, no key reaches it, nothing behind scrolls or zooms. Esc is Skip.
// - A menu that opens anyway (the top bar's, the logo's, as the tour starts) comes first: the tour steps back, scrim, card
//   and all, and lets the office go until the menu shuts, then comes back on the same step (the Product Designer, Nov 14).
// - Done and "Don't show this again" turn the setting off; Skip, the close button and Esc keep nothing.
// - It never moves the camera, opens anything or closes anything.
import Konva from 'konva/lib/Core.js';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import markOnDark from '../assets/brand/ma-mark-on-dark.svg';
import markOnLight from '../assets/brand/ma-mark-primary.svg';
import markZen from '../assets/brand/ma-mark-zen.svg';
import { camera } from '../canvas/controller';
import { G } from '../canvas/layout';
import { isPhone } from '../canvas/phone';
import { holdOffice, releaseOffice } from '../settings/officeInert';
import { useDeskStore } from '../state/deskStore';
import { getView } from '../state/viewStore';
import { ownDesk, type TourLayerProps } from './door';
import { arrival, back, cssRadius, first, grow, holeRadius, next, onScreenShare, phoneDock, placeCard, position, stepsFor, union, type Condition, type Placed, type Rect, type Size, type TourStep } from './engine';
import { setTourOff } from './prefs';
import { STEPS, WORDS } from './steps';
import tourCssUrl from './tour.css?url';

const POLL_MS = 200;
const QUIET_MS = 800;
const GIVE_UP_MS = 30_000;
/** The mark menu's family (the Designer's section 4). */
const OUT = 'cubic-bezier(0.2, 0, 0, 1)';
const IN = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** How long a step's glide runs: the hole's CSS transition, 280 ms. */
const GLIDE_MS = 300;

type End = 'done' | 'skip' | 'off' | 'quiet';
/** A target on screen, with its own corner radius on screen (`r`), which the hole's corners follow. */
interface Target extends Rect {
  r: number;
}
type Found = Map<string, Target | null>;
interface Hole extends Rect {
  r: number;
  ring: boolean;
}

const viewNow = (): Size => ({ w: window.innerWidth, h: window.innerHeight });

/** It has a box and CSS shows it. */
function shown(el: Element): boolean {
  if (!el.getClientRects().length) return false;
  const check = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return check ? check.call(el) : true;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** What covers a target: by its centre, as `a11y/covered.ts` decides it for the proxies. */
const COVERS = '.ma-window, .open-tile, .carousel-stage, .maia-panel, [aria-modal="true"], .mark-pop, .menu';
function covered(el: Element): boolean {
  const r = rectOf(el);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  for (const c of document.querySelectorAll(COVERS)) {
    if (c.closest('.tour') || c.contains(el) || el.contains(c) || !shown(c)) continue;
    const b = c.getBoundingClientRect();
    if (cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom) return true;
  }
  return false;
}

/** There for the tour: shown, not hidden from everyone, at least 60 % on screen, and not covered. */
function there(el: Element | null | undefined, view: Size): el is HTMLElement {
  return !!el && shown(el) && !el.closest('[hidden], [aria-hidden="true"]') && onScreenShare(rectOf(el), view) >= 0.6 && !covered(el);
}

/** The member's own desks' buttons over the canvas (`office.desk`), Personal and Work. */
const ownDeskButtons = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.proxy-layer button[data-desk]')].filter((b) => b.dataset['kind'] === 'personal' || b.dataset['kind'] === 'work');

/**
 * A proxy's scale on screen: the canvas draws in world units under the camera, and its proxy is sized in them too, so its
 * box on screen over its own width is the camera's scale.
 */
function proxyScale(el: HTMLElement): number {
  const own = parseFloat(el.style.width);
  return own > 0 ? el.getBoundingClientRect().width / own : 1;
}

/** A desk's or a tile's corner as the canvas draws it (`canvas/layout.ts`: a desk 22, an icon 18, a widget 20), on screen. */
function canvasRadius(el: HTMLElement): number {
  const world = el.dataset['desk'] !== undefined ? G.panelRadius : el.dataset['level'] && el.dataset['level'] !== 'icon' ? G.widgetRadius : G.tileRadius;
  return world * proxyScale(el);
}

/** An element of the office's chrome: its box and its own CSS corner, on screen. */
function domTarget(el: Element): Target {
  const r = rectOf(el);
  return { ...r, r: cssRadius(getComputedStyle(el).borderTopLeftRadius, r) };
}

const proxyTarget = (el: HTMLElement): Target => ({ ...rectOf(el), r: canvasRadius(el) });

/** The Browser's tile on the first own desk on screen, Personal first; else that desk's first tile that's there (never Courier, which comes later). */
function appTile(view: Size): HTMLElement | null {
  const desks = ownDeskButtons().filter((b) => there(b, view));
  const desk = desks.find((b) => b.dataset['kind'] === 'personal') ?? desks[0];
  if (!desk) return null;
  const tiles = [document.getElementById(`proxy-${desk.dataset['desk']}:browser`), ...(desk.parentElement?.querySelectorAll<HTMLElement>('button[data-face]') ?? [])];
  return tiles.find((t): t is HTMLElement => !!t && !t.id.endsWith(':courier') && there(t, view)) ?? null;
}

/** A step's target on screen now: a rect with its corner, null for a centred card, or undefined when it isn't there. */
function targetOf(step: TourStep, view: Size): Target | null | undefined {
  if (step.anchor === null) return null;
  if (step.anchor === '@desks') {
    const on = ownDeskButtons().filter((b) => there(b, view));
    // One hole round them all, with a desk's corner.
    return on.length ? { ...union(on.map(rectOf)), r: canvasRadius(on[0]!) } : undefined;
  }
  if (step.anchor === '@guild') {
    const g = [...document.querySelectorAll<HTMLElement>('.proxy-layer button[data-desk][data-kind="guild"]')].find((b) => there(b, view));
    return g ? proxyTarget(g) : undefined;
  }
  if (step.anchor === '@app') {
    const t = appTile(view);
    return t ? proxyTarget(t) : undefined;
  }
  for (const el of document.querySelectorAll(step.anchor)) if (there(el, view)) return domTarget(el);
  return undefined;
}

function measure(steps: readonly TourStep[], view: Size): Found {
  const found: Found = new Map();
  for (const s of steps) {
    const t = targetOf(s, view);
    if (t !== undefined) found.set(s.id, t);
  }
  return found;
}

const sameRect = (a: Target | null | undefined, b: Target | null | undefined): boolean =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5 && Math.abs(a.r - b.r) < 0.5);
function sameFound(a: Found | null, b: Found): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [k, v] of b) if (!a.has(k) || !sameRect(a.get(k), v)) return false;
  return true;
}

/**
 * The hole for a step: its target grown by its pad, its corners the target's own grown by the same pad, so the two edges
 * run parallel; the intro's is a point at the middle with no ring.
 */
function holeFor(step: TourStep | undefined, found: Found | null, view: Size): Hole {
  const t = step ? found?.get(step.id) : null;
  if (!step || !t) return { x: view.w / 2, y: view.h / 2, w: 0, h: 0, r: 0, ring: false };
  const pad = step.pad ?? 8;
  const g = grow(t, pad);
  return { ...g, r: holeRadius(t.r, pad, g, step.radius), ring: true };
}

/** What shows over the office that the tour must not start over, or that ends it as Skip does when it arrives. */
const ARRIVING = '.desks-main .notices > *, .desk-notice, .office-notice, .ended-desk, [aria-modal="true"]';
const arrivals = (): Element[] => [...document.querySelectorAll(ARRIVING)].filter((el) => !el.closest('.tour') && !el.classList.contains('new-version') && shown(el));

/**
 * The loader's loading overlay (`#ma-ld`, ADR 0058) still over the office: there and not yet going. The office marks it
 * `aria-hidden` as its fade starts (`chrome/loadingOverlay.ts`) and removes it after; the loader's own safety hides it.
 */
function loading(): boolean {
  const el = document.getElementById('ma-ld');
  if (!el || el.getAttribute('aria-hidden') === 'true' || !el.getClientRects().length) return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  return check ? check.call(el, { opacityProperty: true, visibilityProperty: true }) : true;
}

/** Something the member is using, or in the way: starting by itself waits for none of these (the Designer's rule 4). */
const IN_USE = '.ma-window, .carousel-stage, .open-tile, [role="dialog"], [role="menu"], .mark-pop, .menu, .maia-panel';
function busy(view: Size): boolean {
  if (document.hidden) return true;
  if (loading()) return true;
  if (Konva.isDragging() || camera.isMoving() || getView().kbEdit) return true;
  for (const el of document.querySelectorAll(IN_USE)) if (!el.closest('.tour') && shown(el)) return true;
  if (arrivals().length) return true;
  if (useDeskStore.getState().desks.some((d) => ownDesk(d) && (d.vm === 'setting-up' || d.vm === 'held' || d.queuePosition !== null))) return true;
  return !ownDeskButtons().some((b) => there(b, view));
}

/** A menu or popover the member has open: the top bar's (account, bell, scope), a desk's, the logo's, the bottom bar's zoom. */
const MENUS = '.menu, [role="menu"], .mark-pop:not(.shut), .zoom-pop';
const menuOpen = (): boolean => [...document.querySelectorAll(MENUS)].some((el) => !el.closest('.tour') && shown(el));

export function TourLayer({ auto, from, onEnd, onNotice }: TourLayerProps) {
  // The steps for this member and screen, fixed for this run.
  const [steps] = useState(() => {
    const kinds = new Set(useDeskStore.getState().desks.map((d) => d.kind));
    const both = kinds.has('personal') && kinds.has('work');
    const holds: Record<Condition, boolean> = { personalAndWork: both, oneDesk: !both };
    return stepsFor(STEPS, { phone: isPhone(), holds: (c) => holds[c] });
  });
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [view, setView] = useState(viewNow);
  const [found, setFound] = useState<Found | null>(null);
  /** The step the hole and the buttons are on. */
  const [at, setAt] = useState(-1);
  /** The step the card's words are on: `at`, 100 ms late while the card is faded out. */
  const [shownAt, setShownAt] = useState(-1);
  const [glide, setGlide] = useState(false);
  const [placed, setPlaced] = useState<Placed | 'top' | 'bottom' | null>(null);
  const [said, setSaid] = useState('');
  const [leaving, setLeaving] = useState(false);
  /** Stepped back for a menu the member has open: nothing of the tour shows, and the office is theirs until it shuts. */
  const [yielded, setYielded] = useState(false);
  const yieldedNow = useRef(false);
  /** Back from a menu: the card takes the keyboard again. */
  const returning = useRef(false);
  const layer = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const hole = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<Element | null>(from);
  const atNow = useRef(-1);
  const foundNow = useRef<Found | null>(null);
  const ending = useRef(false);
  const timers = useRef({ swap: 0, glide: 0 });
  const anims = useRef<Animation[]>([]);
  const before = useRef<Set<Element>>(new Set());
  const lastShown = useRef(-1);
  const ids = useId();
  foundNow.current = found;

  const present = (f: Found | null) => (s: TourStep): boolean => !!f?.has(s.id);
  const stopAnims = (): void => {
    for (const a of anims.current) a.cancel();
    anims.current = [];
  };

  // ----- moving and ending, through refs, so the document's listeners always reach the latest

  const moveTo = (j: number): void => {
    if (j === atNow.current || j < 0) return;
    atNow.current = j;
    setAt(j);
    setGlide(true);
    window.clearTimeout(timers.current.glide);
    timers.current.glide = window.setTimeout(() => setGlide(false), GLIDE_MS);
    window.clearTimeout(timers.current.swap);
    // Arriving at the first step, Back becomes Skip: focus goes to Next, so Enter held through Back never skips the tour.
    if (j === first(steps, present(foundNow.current))) primary.current?.focus({ preventScroll: true });
    const c = card.current;
    if (reduced || !c) {
      setShownAt(j);
      return;
    }
    stopAnims();
    anims.current.push(c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: IN, fill: 'forwards' }));
    timers.current.swap = window.setTimeout(() => setShownAt(j), 100);
  };

  const end = (how: End): void => {
    if (ending.current) return;
    ending.current = true;
    window.clearTimeout(timers.current.swap);
    if (how === 'done' || how === 'off') setTourOff(true);
    // The office first: an inert button takes no focus.
    releaseOffice();
    const to = returnTo.current;
    const ok = to instanceof HTMLElement && to.isConnected && to !== document.body && !to.closest('[inert]') && shown(to);
    // Stepped back for a menu, the keyboard is where the member put it (a sheet that menu opened, say): it stays there.
    if (!yieldedNow.current) (ok ? to : document.querySelector<HTMLElement>('.canvas-wrap'))?.focus({ preventScroll: true });
    if (how === 'off') onNotice(WORDS.offNote);
    setLeaving(true);
    const c = card.current;
    const h = hole.current;
    if (reduced || !c || !h || atNow.current < 0) {
      onEnd();
      return;
    }
    stopAnims();
    c.animate([{ opacity: 0 }], { duration: 120, easing: IN, fill: 'forwards' });
    h.animate([{ opacity: 0 }], { duration: 200, easing: IN, fill: 'forwards' }).finished.then(onEnd, onEnd);
  };

  const goNext = (): void => {
    const j = next(steps, atNow.current, present(foundNow.current));
    if (j < 0) end('done');
    else moveTo(j);
  };
  const goQuiet = (): void => {
    const p = present(foundNow.current);
    if (atNow.current === first(steps, p)) end('skip');
    else moveTo(back(steps, atNow.current, p));
  };
  const act = useRef({ end, goNext });
  act.current = { end, goNext };

  // ----- the start: at once when asked for, or after 800 ms of quiet on a first visit

  useEffect(() => {
    const born = performance.now();
    let quietSince = 0;
    let timer = 0;
    const start = (): void => {
      const v = viewNow();
      const f = measure(steps, v);
      const i = first(steps, present(f));
      if (i < 0) {
        onEnd();
        return;
      }
      returnTo.current = from ?? document.activeElement;
      before.current = new Set(arrivals());
      foundNow.current = f;
      atNow.current = i;
      setView(v);
      setFound(f);
      setAt(i);
      setShownAt(i);
    };
    if (!auto) {
      start();
      return undefined;
    }
    const tick = (): void => {
      const v = viewNow();
      if (busy(v)) quietSince = 0;
      else quietSince ||= performance.now();
      if (quietSince && performance.now() - quietSince >= QUIET_MS) return start();
      if (performance.now() - born > GIVE_UP_MS) return onEnd(); // not in this page load; the next time the office opens
      timer = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => window.clearTimeout(timer);
    // Once, as the run begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const started = at >= 0;

  // ----- while it shows: the office held, targets followed, keys and the wheel kept

  // The office held while the card shows; let go while it steps back for a menu, and held again as it comes back.
  useLayoutEffect(() => {
    const el = layer.current;
    if (!started || !el) return undefined;
    if (yielded) {
      // The keyboard goes back where it was before the card took it (as a rule the button of the menu now open), not
      // nowhere as the card hides.
      const to = returnTo.current;
      const lost = el.contains(document.activeElement) || document.activeElement === document.body;
      if (lost && to instanceof HTMLElement && to.isConnected && to !== document.body && !to.closest('[inert]') && shown(to)) to.focus({ preventScroll: true });
      return undefined;
    }
    holdOffice(el);
    if (returning.current) {
      returning.current = false;
      primary.current?.focus({ preventScroll: true });
    }
    return () => {
      if (!ending.current) releaseOffice();
    };
  }, [started, yielded]);

  useLayoutEffect(() => {
    const el = layer.current;
    if (!started || !el) return undefined;
    // Nothing behind it scrolls or zooms: a wheel (a trackpad's pinch is a ctrl+wheel), a finger's move, Safari's pinch. Only
    // the card itself scrolls, on a screen too short for it (`overscroll-behavior: contain`, so nothing past it moves).
    const stop = (e: Event): void => {
      const inCard = !!(e.target as Element | null)?.closest?.('.tour-tip');
      const cardScroll = e.type === 'wheel' ? !(e as WheelEvent).ctrlKey : e.type === 'touchmove' && (e as TouchEvent).touches.length === 1;
      if (!(inCard && cardScroll)) e.preventDefault();
      e.stopPropagation();
    };
    const kinds = ['wheel', 'touchmove', 'gesturestart', 'gesturechange'];
    for (const k of kinds) el.addEventListener(k, stop, { passive: false });
    return () => {
      for (const k of kinds) el.removeEventListener(k, stop);
    };
  }, [started]);

  useEffect(() => {
    if (!started) return undefined;
    const look = (): void => {
      if (ending.current) return;
      // A sign-in, billing or safety notice, or a sheet, arriving ends it as Skip does.
      if (arrivals().some((el) => !before.current.has(el))) return act.current.end('skip');
      // A menu open: step back until it shuts (its own keys and presses are the member's meanwhile). Nothing is measured
      // while it's up, since it covers what it covers only for now.
      const menu = menuOpen();
      if (menu !== yieldedNow.current) {
        yieldedNow.current = menu;
        if (!menu) returning.current = true;
        setYielded(menu);
      }
      if (menu) return;
      const f = measure(steps, viewNow());
      const cur = steps[atNow.current];
      if (cur && !f.has(cur.id)) {
        // Its target went away: on to the next that's there, or the end, with nothing kept.
        foundNow.current = f;
        setFound(f);
        const j = next(steps, atNow.current, present(f));
        if (j < 0) return act.current.end('quiet');
        moveTo(j);
        return;
      }
      if (!sameFound(foundNow.current, f)) {
        foundNow.current = f;
        setFound(f);
      }
    };
    const resize = (): void => {
      setGlide(false); // measured again and placed at once, with no glide
      setView(viewNow());
      look();
    };
    const timer = window.setInterval(look, POLL_MS);
    look(); // at once: a menu that opened as the tour started steps it back before the card is seen
    window.addEventListener('resize', resize);
    // On the document, as the mark's menu does: Esc ends it before the office's own Esc (on the window) can hear it, and no
    // other key reaches the office while it's open.
    const keys = (e: KeyboardEvent): void => {
      if (ending.current || yieldedNow.current) return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        act.current.end('skip');
        return;
      }
      const c = card.current;
      if (!c) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        const all = [...c.querySelectorAll<HTMLElement>('button')].filter(shown);
        const i = all.indexOf(document.activeElement as HTMLElement);
        const to = i < 0 ? (e.shiftKey ? all.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + all.length) % all.length;
        all[to]?.focus();
        return;
      }
      if (e.key === 'Enter' && document.activeElement === c) {
        e.preventDefault();
        act.current.goNext();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('resize', resize);
      document.removeEventListener('keydown', keys);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  useEffect(
    () => () => {
      window.clearTimeout(timers.current.swap);
      window.clearTimeout(timers.current.glide);
    },
    [],
  );

  // ----- the card: placed beside its hole once its words are in, then faded in toward it

  const step = shownAt >= 0 ? steps[shownAt] : undefined;
  const phone = view.w < 600;
  const cardHole = step?.anchor ? holeFor(step, found, view) : null;
  const holeKey = cardHole ? `${cardHole.x},${cardHole.y},${cardHole.w},${cardHole.h}` : '';

  useLayoutEffect(() => {
    const c = card.current;
    if (!c || !step) return;
    const size = { w: c.offsetWidth, h: c.offsetHeight };
    const p = phone ? phoneDock(cardHole, size.h, view) : placeCard(cardHole, size, view, step.placement ?? 'below');
    setPlaced((old) => (JSON.stringify(old) === JSON.stringify(p) ? old : p));
    if (lastShown.current === shownAt) return;
    const firstTime = lastShown.current < 0;
    lastShown.current = shownAt;
    if (firstTime) primary.current?.focus({ preventScroll: true });
    else {
      // Said once through the tour's own polite region (the shell's is inert under the tour); the card isn't live.
      const { n, total } = position(steps, shownAt, present(foundNow.current));
      setSaid(`${WORDS.count(n, total)}. ${step.title}. ${step.body}`);
    }
    if (reduced) return;
    stopAnims();
    const { dx, dy } = arrival(typeof p === 'string' ? null : p.side);
    const from0 = { opacity: 0, transform: `translate(${dx}px, ${dy}px)` };
    const to1 = { opacity: 1, transform: 'translate(0, 0)' };
    if (firstTime) {
      if (hole.current) anims.current.push(hole.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: OUT }));
      anims.current.push(c.animate([from0, to1], { duration: 200, delay: 60, easing: OUT, fill: 'backwards' }));
    } else {
      anims.current.push(c.animate([from0, to1], { duration: 160, delay: 80, easing: OUT, fill: 'backwards' }));
    }
    // Placed again for its words, the screen or its hole; nothing else moves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownAt, phone, view.w, view.h, holeKey]);

  if (!started || !step) return null;

  const p = present(found);
  const isFirst = shownAt === first(steps, p);
  const last = next(steps, shownAt, p) < 0;
  const { n, total } = position(steps, shownAt, p);
  const h = holeFor(steps[at], found, view);
  const side = placed && typeof placed !== 'string' ? placed.side : null;
  const cardStyle: CSSProperties = phone ? {} : placed && typeof placed !== 'string' ? { left: placed.x, top: placed.y } : { left: 0, top: 0, opacity: 0 }; // not measured yet: out of sight, still focusable
  const caretStyle: CSSProperties | undefined =
    side && placed && typeof placed !== 'string' && placed.caret !== null ? (side === 'below' || side === 'above' ? { left: placed.caret } : { top: placed.caret }) : undefined;
  // A press anywhere but the card's own controls does nothing, and doesn't take focus from them.
  const hold = (e: ReactMouseEvent): void => {
    if (!(e.target as Element).closest('button')) e.preventDefault();
  };

  return (
    <div ref={layer} className={`tour${phone ? ' phone' : ''}${leaving ? ' leaving' : ''}${yielded ? ' yield' : ''}`} data-step={step.id} onMouseDown={hold}>
      <div
        ref={hole}
        className={`tour-hole${h.ring ? ' ring' : ''}${glide && !reduced ? '' : ' still'}`}
        style={{ transform: `translate(${h.x}px, ${h.y}px)`, width: h.w, height: h.h, borderRadius: h.r }}
        aria-hidden="true"
      />
      <div
        ref={card}
        className={`tour-tip${step.anchor === null ? ' intro' : ''}${placed === 'top' ? ' top' : ''}`}
        style={cardStyle}
        role="dialog"
        // Modal while it's up; leaving, not, so VoiceOver hears the note that "Don't show this again" leaves in the shell.
        aria-modal={leaving || yielded ? undefined : 'true'}
        aria-labelledby={`${ids}-t`}
        aria-describedby={`${ids}-l ${ids}-n`}
        tabIndex={-1}
        data-testid="tour"
        data-step={step.id}
      >
        {side && <div className="tour-caret" data-side={side} style={caretStyle} aria-hidden="true" />}
        <div className="tour-body">
          {step.anchor === null && (
            // The intro wears the Alliance's mark, the theme's own (the top bar's rule in `app.css`).
            <div className="tour-mark" aria-hidden="true">
              <img className="home-mark-img on-light" src={markOnLight} alt="" width={45} height={28} />
              <img className="home-mark-img on-dark" src={markOnDark} alt="" width={45} height={28} />
              <img className="home-mark-img on-zen" src={markZen} alt="" width={45} height={28} />
            </div>
          )}
          <div className="tour-head">
            <h2 className="tour-title" id={`${ids}-t`}>
              {step.title}
            </h2>
            <button type="button" className="tour-x" aria-label={WORDS.close} title={WORDS.close} data-testid="tour-close" onClick={() => end('skip')}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
          <p className="tour-line" id={`${ids}-l`}>
            {step.body}
          </p>
          <div className="tour-foot">
            <span className="tour-count" id={`${ids}-n`}>
              {WORDS.count(n, total)}
            </span>
            <button type="button" className="tour-quiet" data-testid={isFirst ? 'tour-skip' : 'tour-back'} onClick={goQuiet}>
              {isFirst ? WORDS.skip : WORDS.back}
            </button>
            <button ref={primary} type="button" className="tour-next" data-testid="tour-next" onClick={goNext}>
              {last ? WORDS.done : WORDS.next}
            </button>
          </div>
        </div>
        {!last && (
          <div className="tour-off">
            <button type="button" className="tour-link" data-testid="tour-off" onClick={() => end('off')}>
              {WORDS.off}
            </button>
          </div>
        )}
        {/* Each step change, said once. Inside the dialog: VoiceOver hides everything outside an open modal dialog, and the
            shell's own region is in the office the tour holds inert. */}
        <div className="sr-only" role="status" aria-live="polite" data-testid="tour-said">
          {said}
        </div>
      </div>
    </div>
  );
}

/**
 * The tour's styles are a file of their own, fetched with the chunk, so the app's one stylesheet stays as it was. A failed
 * load rejects like a failed chunk, and the door asks again at the next "Take the tour".
 */
let sheet: Promise<void> | undefined;
function loadSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = tourCssUrl;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      sheet = undefined;
      reject(new Error('The tour stylesheet did not load'));
    };
    document.head.appendChild(link);
  });
  return sheet;
}

/** This chunk, once its stylesheet has loaded: what the door waits for. */
export const ready = (): Promise<typeof TourLayer> => loadSheet().then(() => TourLayer);
