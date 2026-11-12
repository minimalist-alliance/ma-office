// The keyboard (design 3.1). Esc and Shift+Esc work anywhere. The arrows work anywhere outside a field, a menu, a
// window or the bars' own controls, and take the keyboard onto the desks. Every other single key, and Enter or Space
// on the desks, acts only while the canvas has focus (`canvasHasFocus`, WCAG 2.1.4), as `m`, `r` and `.` always have
// (ADR 0062). So a word a speech-input member dictates, or a key hit by accident, can't wake a desk or show the shield.
import { useEffect } from 'react';
import { camera } from '../canvas/controller';
import { isPhone } from '../canvas/phone';
import { useLayoutStore } from '../state/layoutStore';
import { getView, setView } from '../state/viewStore';
import { beginEdit, editKey, finishEdit } from './arrange';
import { canvasHasFocus } from './canvasFocus';
import { closeTopWindow, cycleDesk, fitScope, focusDesk, focusProxy, goOverview, orderedDeskIds, togglePrivacy } from './actions';
import { cleanupProxyId } from './cleanup';
import { hiddenProxyId } from './hidden';
import { appsInOrder } from './order';
import { backToDesk, carouselProxyId } from '../carousel/actions';
import { carouselOn } from '../carousel/model';

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * Arrows: in the overview the ring moves between desks; on a desk focus moves between tiles, then on to the next desk.
 * Either way the keyboard lands on the desks, so the keys that need it (Enter, `[`, `\`) work next.
 */
function moveFocus(dir: 1 | -1): void {
  const v = getView();
  if (v.mode === 'overview') {
    cycleDesk(dir);
    const next = getView().activeDesk;
    if (next) focusProxy(next);
    return;
  }
  const desk = v.activeDesk ? useLayoutStore.getState().desks[v.activeDesk] : undefined;
  // A carousel's apps are on its stage, not the desk (`carousel/`), so the arrows there meet only the strip.
  const ids = desk && !(carouselOn(desk) && !isPhone()) ? appsInOrder(desk.items, isPhone()).map((i) => i.id) : [];
  // The strip comes after the apps, left to right as it's drawn: the hidden count, cleanup's control, then the
  // carousel's switch, when there are.
  const count = v.activeDesk ? hiddenProxyId(v.activeDesk) : '';
  if (document.getElementById(`proxy-${count}`)) ids.push(count);
  const control = v.activeDesk ? cleanupProxyId(v.activeDesk) : '';
  if (document.getElementById(`proxy-${control}`)) ids.push(control);
  const carousel = v.activeDesk ? carouselProxyId(v.activeDesk) : '';
  if (document.getElementById(`proxy-${carousel}`)) ids.push(carousel);
  if (!ids.length) {
    cycleDesk(dir);
    return;
  }
  const i = v.kbFocus ? ids.indexOf(v.kbFocus) : -1;
  const next = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : i + dir;
  if (next >= 0 && next < ids.length) {
    focusProxy(ids[next]!);
  } else if (orderedDeskIds().length > 1) {
    cycleDesk(dir);
    setView({ kbFocus: null });
  } else {
    focusProxy(ids[(next + ids.length) % ids.length]!);
  }
}

/** `.` or the menu key on a focused desk, app or strip control: the same menu a right click opens. */
function openMenuHere(el: Element): void {
  if (isPhone()) return;
  const id = getView().kbFocus;
  const { desks } = useLayoutStore.getState();
  const owner = Object.values(desks).find((d) => d.id === id || cleanupProxyId(d.id) === id || hiddenProxyId(d.id) === id || carouselProxyId(d.id) === id || d.items.some((i) => i.id === id));
  if (!id || !owner) return;
  const box = el.getBoundingClientRect();
  setView({
    deskMenu: {
      deskId: owner.id,
      itemId: owner.items.some((i) => i.id === id) ? id : null,
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      fromKeyboard: true,
    },
  });
}

export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // ProseMirror marks every Esc as handled and does nothing with it, so an editor would keep the member in.
      const editorEsc = e.key === 'Escape' && (e.target as Element | null)?.closest?.('.ProseMirror');
      if ((e.defaultPrevented && !editorEsc) || e.altKey || e.metaKey || e.ctrlKey) return;
      if (editKey(e)) return;
      const el = document.activeElement;
      // An open tile's app has its keys (ADR 0053); one Esc it didn't use goes back to its tile (`opentile/`).
      if (el?.closest('.open-tile')) return;
      // A phone's carousel fills the screen as a window does there, so Esc goes back to its desk, as the back arrow does.
      const phoneStage = el?.closest<HTMLElement>('.carousel-stage.phone')?.dataset['desk'];
      if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        // From a carousel's app, where plain Esc may be the web page's, Shift+Esc always leaves, as from a window.
        if (!closeTopWindow(true) && el?.closest('.carousel-stage')) {
          if (phoneStage) backToDesk(phoneStage);
          else goOverview();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (closeTopWindow(false)) {
          e.preventDefault();
          return;
        }
        if (el?.closest('[data-testid="window-browser"], [data-testid="carousel-slide-browser"]')) return; // the web page's Esc
        if (phoneStage) {
          e.preventDefault();
          backToDesk(phoneStage);
          return;
        }
        const v = getView();
        if (v.mode !== 'overview') {
          e.preventDefault();
          goOverview();
        }
        return;
      }
      if (isEditable(el) || el?.closest('.menu-wrap') || el?.closest('.ma-window') || el?.closest('.settings-modal')) return;
      // A focused control in the bars or the notices owns its arrows and activation.
      if (el?.closest('.topbar, .bottombar, .notices') && /^(Arrow|Enter$| $)/.test(e.key)) return;
      if (!canvasHasFocus(el) && !e.key.startsWith('Arrow')) return;
      switch (e.key) {
        case '\\':
          e.preventDefault();
          togglePrivacy();
          return;
        case '.':
        case 'ContextMenu':
          if (el?.closest('.proxy-layer')) {
            e.preventDefault();
            openMenuHere(el);
          }
          return;
        case 'F10':
          if (e.shiftKey && el?.closest('.proxy-layer')) {
            e.preventDefault();
            openMenuHere(el);
          }
          return;
        case 'm':
        case 'r':
          // Single keys act only while an app or desk on the canvas has focus (ADR 0062).
          if (el?.closest('.proxy-layer') && beginEdit(e.key === 'm' ? 'move' : 'resize')) e.preventDefault();
          return;
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(1);
          return;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(-1);
          return;
        case ']':
          e.preventDefault();
          cycleDesk(1);
          return;
        case '[':
          e.preventDefault();
          cycleDesk(-1);
          return;
        case '=':
        case '+':
          setView({ mode: 'free' });
          camera.zoomBy(1.25);
          return;
        case '-':
        case '_':
          setView({ mode: 'free' });
          camera.zoomBy(0.8);
          return;
        case '0':
          e.preventDefault();
          fitScope();
          return;
        case 'Enter':
        case ' ': {
          // On a proxy button the browser's own click handles this.
          if (el?.closest('.proxy-layer')) return;
          e.preventDefault();
          const v = getView();
          if (v.mode === 'overview' && v.activeDesk) {
            focusDesk(v.activeDesk);
            return;
          }
          const desk = v.activeDesk ? useLayoutStore.getState().desks[v.activeDesk] : undefined;
          const first = desk && carouselOn(desk) && !isPhone() ? carouselProxyId(desk.id) : desk ? appsInOrder(desk.items, isPhone())[0]?.id : null;
          if (first) focusProxy(first);
          return;
        }
        default:
          if (/^[1-9]$/.test(e.key)) {
            const id = orderedDeskIds()[Number(e.key) - 1];
            if (id) focusDesk(id);
          }
      }
    };
    // A click anywhere ends a keyboard edit, and keeps it; anywhere but the edit bar, whose presses are the edit's own.
    const onPointer = (e: PointerEvent): void => void ((e.target as Element).closest('.edit-bar') || finishEdit(true));
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
}
