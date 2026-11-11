// Carousel mode's stage (the owner, Nov 9): on the desk that's looked at, the shown app itself, live, docked to the desk's
// rectangle on screen, one at a time. Its own chunk: it loads when a desk is first switched to carousel, or on a load with
// one already on (`shell/Shell.tsx`). The rules are `model.ts`; the switch, the steps and the hand-off from windows are
// `actions.ts`; the card drawn when the app can't show is `canvas/DeskPanel.tsx`.
//
// Only the app on show is mounted, so only it is live: an app swiped away unmounts as a closed window does (the Browser
// asks `off`), and the rest of the desk's apps aren't mounted at all. During the slide the leaving app stays for its 220 ms,
// inert. The stage is mounted only on the shown desk (`shownDesk`, the one-live-picture rule), and only while it's at
// least `STAGE_LIVE_MIN_W` wide on screen at rest; otherwise the canvas draws the app's card.
//
// It follows the camera as `ProxyLayer` does: the layer is laid out in screen pixels for the camera at the last rest, and a
// move writes one transform to the layer (the same on every frame, however many stages), and nothing renders. At rest it's
// laid out again at the new size, in the same commit that clears the transform.
//
// On a phone (under 600 px) the same stage fills the screen instead, outside that layer, as a window does there: the
// Product Designer's option 3, "Thumb row". Each slide has the app's own head (back arrow, glyph, name, desk), and under
// the app a 56 px row of the desk's app glyphs, a tablist, with an accent marker on the one shown and "Back to the desk"
// at its right end. A tap on a glyph, or a swipe along the row, from the screen's edge, or anywhere off the Browser's
// picture and fields, moves.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type Konva from 'konva/lib/Core.js';
import { camera } from '../canvas/controller';
import { useCameraRest, type RestCam } from '../canvas/useCameraRest';
import type { AppId, LayoutDesk } from '../canvas/layout';
import { useIsPhone } from '../canvas/phone';
import { AppGlyph, Icon } from '../chrome/icons';
import { shownDesk } from '../desk/attention';
import { reducedMotion } from '../lib/util';
import { appLabel, inScopeDesks } from '../shell/actions';
import { useDeskStore } from '../state/deskStore';
import { LiveWindow } from '../windows/LiveWindow';
import { useLayoutStore } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';
import { backToDesk, showInCarousel, stepCarousel, takeFocusOnShow } from './actions';
import { asPhoneSees, setPhoneShown, usePhoneCarousel } from './phone';
import { carouselApps, carouselOn, fromScreenEdge, keepsArrows, positionOf, positionWords, shownApp, SLIDE_MS, stageIsLive, stageOnScreen, touchSwipe, WheelSwipe } from './model';

type Cam = RestCam;

/** `?slideMs=` slows the slide for a still of it, outside production builds. */
function slideMs(): number {
  if (import.meta.env.MODE === 'production') return SLIDE_MS;
  const v = Number(new URLSearchParams(location.search).get('slideMs'));
  return v > 0 ? v : SLIDE_MS;
}

/** Something under the pointer that scrolls sideways, and can still go that way, keeps a sideways swipe. */
function scrollsSideways(from: EventTarget | null, stop: HTMLElement, dir: number): boolean {
  for (let el = from instanceof Element ? from : null; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox !== 'auto' && ox !== 'scroll') continue;
    if (dir > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
  }
  return false;
}

/** Where a desk's stage is on screen, for the camera at `rest`. */
const stageBox = (desk: Pick<LayoutDesk, 'x' | 'y' | 'w' | 'h'>, rest: Cam, at = { x: desk.x, y: desk.y }) => stageOnScreen({ ...desk, ...at }, rest);

function Slide({ deskId, deskName, app, index, count, leaving, phone, titleId, slideRef }: {
  deskId: string;
  deskName: string;
  app: AppId;
  index: number;
  count: number;
  leaving: boolean;
  phone: boolean;
  titleId?: string;
  slideRef?: (el: HTMLDivElement | null) => void;
}) {
  const label = appLabel(app, deskId);
  return (
    <LiveWindow
      ref={slideRef}
      deskId={deskId}
      deskName={deskName}
      app={app}
      className={`carousel-slide${leaving ? ' leaving' : ''}`}
      role="group"
      aria-roledescription="slide"
      aria-label={`${label}, ${positionWords(index, count)}`}
      data-testid={`carousel-slide-${app.startsWith('agent:') ? 'agent' : app}`}
      inert={leaving}
    >
      {phone && (
        // A phone's head is the app's own, as a window's is there: it slides with its app, and the back arrow goes back
        // to the desk, as the thumb row's button does.
        <div className="window-head">
          <button type="button" className="window-back" onClick={() => backToDesk(deskId)} aria-label={`Back from ${label}`}>
            <Icon name="back" />
          </button>
          <AppGlyph app={app} deskId={deskId} size={22} />
          <h2 id={titleId} className="window-title">
            {label}
            <span className="window-desk">{deskName}</span>
          </h2>
        </div>
      )}
    </LiveWindow>
  );
}

/** The thumb row's way back: four squares, the desk's own switch glyph at a phone's size. */
function DeskGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="7" height="7" rx="2" />
      <rect x="11" y="2" width="7" height="7" rx="2" />
      <rect x="2" y="11" width="7" height="7" rx="2" />
      <rect x="11" y="11" width="7" height="7" rx="2" />
    </svg>
  );
}

/**
 * A phone's thumb row: the desk's apps as a tablist, the one shown `aria-selected` with the marker (a tint and an accent
 * bar) sliding under it over the slide's 220 ms, then "Back to the desk" at the right end. Arrow keys, Home and End move
 * the carousel and the focus with it; a tap on a glyph goes straight there.
 */
function ThumbRow({ deskId, apps, index, panelId, tabId }: { deskId: string; apps: AppId[]; index: number; panelId: string; tabId: (n: number) => string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const count = apps.length;

  // The focus follows the shown app while it's in the row, as a tablist's does; the one shown stays in view.
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>(`#${CSS.escape(tabId(index))}`);
    if (!list || !tab) return;
    if (list.contains(document.activeElement) && document.activeElement !== tab) tab.focus({ preventScroll: true });
    if (list.scrollWidth > list.clientWidth + 1) {
      const left = tab.offsetLeft;
      const right = left + tab.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
    }
  }, [index, tabId]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const to = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : null;
    if (to === null) return;
    e.preventDefault(); // the stage's own arrows and the office's leave it be
    const app = apps[to];
    if (app && to !== index) showInCarousel(deskId, app);
  };

  return (
    <div className="carousel-thumbs" data-testid="carousel-thumbs">
      <div
        ref={listRef}
        className="thumb-tabs"
        role="tablist"
        aria-label="Apps"
        style={{ '--i': index, '--n': count, '--slide-ms': `${slideMs()}ms` } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        <span className="thumb-mark" aria-hidden="true" />
        {apps.map((a, n) => (
          <button
            key={a}
            type="button"
            role="tab"
            id={tabId(n)}
            className="thumb"
            aria-label={appLabel(a, deskId)}
            aria-selected={n === index}
            aria-controls={n === index ? panelId : undefined}
            tabIndex={n === index ? 0 : -1}
            onClick={() => showInCarousel(deskId, a)}
          >
            <AppGlyph app={a} deskId={deskId} size={28} />
          </button>
        ))}
      </div>
      <span className="thumb-sep" aria-hidden="true" />
      <button type="button" className="thumb-desk" aria-label="Back to the desk" onClick={() => backToDesk(deskId)}>
        <DeskGlyph />
      </button>
    </div>
  );
}

/** How much shorter than its tallest the visible page gets when a phone's on-screen keyboard is up. */
const KEYBOARD_PX = 150;

const typesText = (el: Element | null): boolean => {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
};

/**
 * Whether a phone's on-screen keyboard is up for something in this stage: a field, the Notebook's page or the Browser's
 * picture has the focus, and the visible page (`visualViewport`) is well short of the tallest it's been at this width.
 * The thumb row hides then, so it never sits over what's being typed in, and comes back as the keyboard goes.
 */
function useKeyboardUp(frame: RefObject<HTMLElement | null>, on: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const el = frame.current;
    const vv = window.visualViewport;
    if (!on || !el || !vv) return undefined;
    let width = 0;
    let tallest = 0;
    const check = (): void => {
      const w = vv.width * vv.scale;
      const h = vv.height * vv.scale;
      if (Math.abs(w - width) > 1) {
        // A turn of the phone starts over.
        width = w;
        tallest = 0;
      }
      tallest = Math.max(tallest, h);
      const active = document.activeElement;
      setUp(!!active && el.contains(active) && typesText(active) && h < tallest - KEYBOARD_PX);
    };
    let timer = 0;
    // The focus has moved by the next task, wherever it went.
    const later = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 0);
    };
    check();
    vv.addEventListener('resize', check);
    el.addEventListener('focusin', check);
    el.addEventListener('focusout', later);
    return () => {
      window.clearTimeout(timer);
      vv.removeEventListener('resize', check);
      el.removeEventListener('focusin', check);
      el.removeEventListener('focusout', later);
    };
  }, [frame, on]);
  return up;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function CarouselStage({ deskId, deskName, desk, rest, phone }: { deskId: string; deskName: string; desk: LayoutDesk; rest: Cam; phone: boolean }) {
  const frameRef = useRef<HTMLElement>(null);
  const enterRef = useRef<HTMLDivElement | null>(null);
  const leaveRef = useRef<HTMLDivElement | null>(null);
  const apps = carouselApps(desk);
  const app = shownApp(desk);
  const { index, count } = positionOf(desk);
  const [cur, setCur] = useState(app);
  const [leaving, setLeaving] = useState<{ app: AppId; dir: 1 | -1 } | null>(null);
  const ids = useId();
  const panelId = `${ids}-panel`;
  const tabId = useCallback((n: number): string => `${ids}-tab-${n}`, [ids]);
  const keyboardUp = useKeyboardUp(frameRef, phone);
  // A new app to show: the one before slides out as it slides in, unless motion is reduced, when it simply changes.
  if (app !== cur) {
    const from = cur && apps.includes(cur) ? apps.indexOf(cur) : -1;
    setLeaving(from < 0 || !cur || reducedMotion() ? null : { app: cur, dir: apps.indexOf(app!) > from ? 1 : -1 });
    setCur(app);
  }

  useLayoutEffect(() => {
    if (!leaving) return undefined;
    const enter = enterRef.current;
    const leave = leaveRef.current;
    const ms = slideMs();
    const easing = 'cubic-bezier(.2,0,0,1)';
    const anims = [
      enter?.animate([{ transform: `translateX(${leaving.dir * 100}%)` }, { transform: 'none' }], { duration: ms, easing }),
      leave?.animate([{ transform: 'none' }, { transform: `translateX(${-leaving.dir * 100}%)` }], { duration: ms, easing, fill: 'forwards' }),
    ];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      setLeaving(null);
    };
    const last = anims[0] ?? anims[1];
    if (!last) finish();
    else {
      last.onfinish = finish;
      last.oncancel = finish;
    }
    return () => anims.forEach((a) => a?.cancel());
  }, [leaving]);

  // Docked to the desk: a drag of the desk, a push or a glide moves its node, and the stage goes with it. A phone's
  // fills the screen, docked to nothing.
  useEffect(() => {
    const el = frameRef.current;
    const node = phone ? undefined : camera.getStage()?.findOne<Konva.Node>(`#desk-${deskId}`);
    if (!el || !node) return undefined;
    const place = (): void => {
      const box = stageBox(desk, rest, { x: node.x(), y: node.y() });
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
    };
    node.on('xChange.carousel yChange.carousel', place);
    return () => {
      node.off('xChange.carousel yChange.carousel');
    };
  }, [deskId, desk, rest, phone]);

  // The switch just turned it on, so the stage takes the keyboard, as a window does when it opens. Arrows work at once.
  // A phone's takes it whenever it shows, as a window does there: it covers everything else.
  useEffect(() => {
    if (takeFocusOnShow(deskId) || phone) frameRef.current?.focus({ preventScroll: true });
  }, [deskId, phone]);

  // A phone that opened on a larger screen's carousel holds that app as its own from here (`phone.ts`), so the larger
  // screen moving on later doesn't move it under the member's finger. Only on showing; nothing is saved.
  useEffect(() => {
    if (phone && app && usePhoneCarousel.getState().shown[deskId] === undefined) setPhoneShown(deskId, app);
    // On showing only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskId, phone]);

  // A trackpad's two-finger swipe sideways, one app per gesture; and a finger's, judged as it lifts. Both on the frame,
  // in the capture phase, so a sideways swipe over the Browser's picture is the carousel's and never reaches the page.
  // Up and down, a pinch, and anything over what scrolls sideways itself stay where they were going.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const swipe = new WheelSwipe();
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || scrollsSideways(e.target, frame, Math.sign(e.deltaX))) return;
      const step = swipe.feed(e);
      if (step === 'none') return;
      e.preventDefault(); // nor is it the member's browser's back and forward
      e.stopPropagation();
      if (step !== 'held') stepCarousel(deskId, step === 'next' ? 1 : -1);
    };
    let touch: { x: number; y: number; sure: boolean } | null = null;
    const onTouchStart = (e: TouchEvent): void => {
      const t = e.touches[0];
      const target = e.target instanceof Element ? e.target : null;
      // A phone's thumb row is made for the swipe, its tablist included: nothing in it scrolls by a finger. So is the
      // screen's edge, over the Browser's picture too (`browser/touchInput.ts` sends no scroll for a drag from there).
      const sure = !!target?.closest('.carousel-thumbs') || (!!t && fromScreenEdge(t.clientX, window.innerWidth));
      // Anywhere else, a finger on the Browser's picture is the page's: that's how a page scrolls on a touch screen. The
      // Browser's key row scrolls sideways itself, so it's never the carousel's, edge or not.
      const keys = !!target?.closest('.br-keyrow');
      touch = e.touches.length === 1 && t && !keys && (sure || (!target?.closest('.br-surface') && !keepsArrows(target))) ? { x: t.clientX, y: t.clientY, sure } : null;
    };
    const onTouchEnd = (e: TouchEvent): void => {
      const t = e.changedTouches[0];
      if (!touch || !t || e.touches.length) {
        touch = null;
        return;
      }
      const dx = t.clientX - touch.x;
      const dir = touchSwipe(dx, t.clientY - touch.y);
      const sure = touch.sure;
      touch = null;
      if (dir && (sure || !scrollsSideways(e.target, frame, -dx))) stepCarousel(deskId, dir);
    };
    const onTouchCancel = (): void => {
      touch = null;
    };
    frame.addEventListener('wheel', onWheel, { capture: true, passive: false });
    frame.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    frame.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    frame.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true });
    return () => {
      frame.removeEventListener('wheel', onWheel, { capture: true });
      frame.removeEventListener('touchstart', onTouchStart, { capture: true });
      frame.removeEventListener('touchend', onTouchEnd, { capture: true });
      frame.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    };
  }, [deskId]);

  // Left and Right, anywhere in the frame but a field or a widget that moves with arrows, and not if the app took the key.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (phone && e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
      trapTab(e);
      return;
    }
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.defaultPrevented || keepsArrows(e.target as Element)) return;
    e.preventDefault(); // so the office's own arrows (`useKeyboard`) leave it be
    stepCarousel(deskId, e.key === 'ArrowRight' ? 1 : -1);
  };

  // A phone's stage covers the screen as a window does there, so Tab stays in it (Ctrl+Tab is the member's own browser's).
  const trapTab = (e: ReactKeyboardEvent<HTMLElement>): void => {
    const frame = frameRef.current;
    if (!frame) return;
    const items = [...frame.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null && !n.closest('[inert]'));
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === frame)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!cur) return null;
  const leavingAt = leaving ? apps.indexOf(leaving.app) : -1;
  const slides = (
    <>
      {leaving && (
        // Keyed by its app, as it was while it showed, so it's the same instance sliding out, never a new one.
        <Slide key={leaving.app} deskId={deskId} deskName={deskName} app={leaving.app} index={leavingAt} count={count} leaving phone={phone} titleId={`${ids}-title-${leavingAt}`} slideRef={(el) => { leaveRef.current = el; }} />
      )}
      <Slide key={cur} deskId={deskId} deskName={deskName} app={cur} index={index} count={count} leaving={false} phone={phone} titleId={`${ids}-title-${index}`} slideRef={(el) => { enterRef.current = el; }} />
    </>
  );
  if (phone) {
    const shownAt = apps.indexOf(cur);
    return (
      // Named by the shown app's head ("Notebook Personal"), as a window is on a phone; the tablist and its slides say
      // it's a carousel.
      <section
        ref={frameRef}
        className={`carousel-stage phone${keyboardUp ? ' keyboard-up' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title-${index}`}
        tabIndex={-1}
        data-testid="carousel-stage"
        data-desk={deskId}
        onKeyDown={onKeyDown}
      >
        <div className="carousel-track" role="tabpanel" id={panelId} aria-labelledby={tabId(shownAt)}>
          {slides}
        </div>
        <ThumbRow deskId={deskId} apps={apps} index={shownAt} panelId={panelId} tabId={tabId} />
      </section>
    );
  }
  const box = stageBox(desk, rest);
  const label = appLabel(cur, deskId);
  const atStart = index <= 0;
  const atEnd = index >= count - 1;
  return (
    <section
      ref={frameRef}
      className="carousel-stage"
      style={box}
      role="region"
      aria-roledescription="carousel"
      aria-label={`${deskName} desk's apps`}
      tabIndex={-1}
      data-testid="carousel-stage"
      data-desk={deskId}
      onKeyDown={onKeyDown}
    >
      <div className="carousel-head">
        <button type="button" className="icon-btn sm" aria-label="Previous app" aria-disabled={atStart} onClick={() => stepCarousel(deskId, -1)}>
          <Icon name="chevronLeft" />
        </button>
        <AppGlyph app={cur} deskId={deskId} size={18} />
        <h2 className="carousel-title">{label}</h2>
        <span className="carousel-dots" aria-hidden="true" title={positionWords(index, count)}>
          {apps.map((a, n) => <span key={a} className={n === index ? 'carousel-dot on' : 'carousel-dot'} />)}
        </span>
        <button type="button" className="icon-btn sm" aria-label="Next app" aria-disabled={atEnd} onClick={() => stepCarousel(deskId, 1)}>
          <Icon name="chevronRight" />
        </button>
      </div>
      <div className="carousel-track">{slides}</div>
    </section>
  );
}

export default function CarouselLayer() {
  const phone = useIsPhone();
  const desks = useDeskStore((s) => s.desks);
  const layout = useLayoutStore((s) => s.desks);
  const shown = useViewStore((s) => shownDesk(s));
  const shield = useViewStore((s) => s.privacyShield);
  const phoneShown = usePhoneCarousel((s) => s.shown);
  useViewStore((s) => s.scope);
  const ref = useRef<HTMLDivElement>(null);
  // The camera this layer is laid out for: its last rest (`canvas/useCameraRest.ts`, shared with the open tiles' layer).
  const rest = useCameraRest(ref);

  const inScope = new Set(inScopeDesks().map((d) => d.id));
  const d = shown ? desks.find((x) => x.id === shown) : undefined;
  const l = d ? layout[d.id] : undefined;
  if (phone) {
    // Full screen, so outside the layer the camera moves. Only on the desk that's looked at, as on a larger screen. The
    // phone's own carousel (`phone.ts`), which reads the desk's saved one but never writes it.
    const mine = l ? asPhoneSees(l, phoneShown) : undefined;
    const on = d && mine && carouselOn(mine) && inScope.has(d.id);
    return (
      <div className={`carousel-phone${shield ? ' shielded' : ''}`}>
        {on && <CarouselStage key={d.id} deskId={d.id} deskName={d.name} desk={mine} rest={rest} phone />}
      </div>
    );
  }
  let stage = null;
  if (d && l && carouselOn(l) && inScope.has(d.id)) {
    const box = stageBox(l, rest);
    const onScreen = box.left < window.innerWidth && box.top < window.innerHeight && box.left + box.width > 0 && box.top + box.height > 0;
    if (onScreen && stageIsLive(box.width, box.height)) stage = <CarouselStage key={d.id} deskId={d.id} deskName={d.name} desk={l} rest={rest} phone={false} />;
  }
  return (
    <div ref={ref} className={`carousel-layer${shield ? ' shielded' : ''}`}>
      {stage}
    </div>
  );
}
