// An app window: DOM over the stage, in screen space (design 3.6). Window mode drags and resizes;
// full mode fills the area under the top bar, is modal and traps focus. Moves write a transform
// straight to the element and commit to the store only on release, so dragging never re-renders React.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { camera } from '../canvas/controller';
import { deskGeometry, type Rect } from '../canvas/layout';
import { isPhone } from '../canvas/phone';
import { AppGlyph, Icon } from '../chrome/icons';
import { appDef } from '../apps/registry';
import { useRosterAgent } from '../agent/roster';
import { focusProxy } from '../shell/actions';
import { reducedMotion } from '../lib/util';
import { useLayoutStore } from '../state/layoutStore';
import { MIN_H, MIN_W, raiseWindow, removeWindow, requestClose, setWindowRect, toggleFull, type AppWindowState } from '../state/windowStore';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const OPEN_MS = 240;
const CLOSE_MS = 180;
const EASE_IN = 'cubic-bezier(.2,0,0,1)';
const EASE_OUT = 'cubic-bezier(.3,0,1,1)';

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** Where this window's tile is on screen right now, or null if it's off-screen. */
function tileScreenRect(win: AppWindowState): Rect | null {
  const d = useLayoutStore.getState().desks[win.deskId];
  const slot = d ? deskGeometry(d, isPhone()).slots[win.itemId] : null;
  if (!d || !slot) return null;
  const r = camera.toScreen({ x: d.x + slot.x, y: d.y + slot.y, w: slot.w, h: slot.h });
  const on = r.x + r.w > 0 && r.y + r.h > 0 && r.x < window.innerWidth && r.y < window.innerHeight;
  return on ? r : null;
}

function flipFrames(from: Rect, to: DOMRect): Keyframe[] {
  const sx = from.w / to.width;
  const sy = from.h / to.height;
  const dx = from.x - to.left;
  const dy = from.y - to.top;
  return [
    { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.2 },
    { transformOrigin: '0 0', transform: 'none', opacity: 1 },
  ];
}

export function AppWindow({ win, deskName, active, parked, forceFull }: {
  win: AppWindowState;
  deskName: string;
  active: boolean;
  parked: boolean;
  forceFull: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // An agent's window follows its name (task 49).
  useRosterAgent(win.deskId, win.app);
  const def = appDef(win.app, win.deskId);
  const full = forceFull || win.mode === 'full';
  const opened = useRef(false);

  // Open: a FLIP from the tile. This runs in the same task as the click, so the first animation
  // frame is the next frame (budget B4).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || opened.current) return;
    opened.current = true;
    performance.mark(`ma:window-open:${win.app}`);
    const from = tileScreenRect(win);
    if (from && !reducedMotion()) {
      el.animate(flipFrames(from, el.getBoundingClientRect()), { duration: OPEN_MS, easing: EASE_IN });
    }
    el.focus({ preventScroll: true });
  }, [win]);

  // Close: 180 ms back into the tile, or a fade when the tile is off-screen. Focus goes back to it.
  const closingStarted = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!win.closing || !el || closingStarted.current) return;
    closingStarted.current = true;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      removeWindow(win.key);
      focusProxy(win.itemId);
    };
    if (reducedMotion()) {
      finish();
      return;
    }
    const from = tileScreenRect(win);
    const frames = from ? flipFrames(from, el.getBoundingClientRect()).reverse() : [{ opacity: 1 }, { opacity: 0 }];
    const anim = el.animate(frames, { duration: CLOSE_MS, easing: EASE_OUT, fill: 'forwards' });
    anim.onfinish = finish;
    anim.oncancel = finish;
  }, [win]);

  useEffect(() => {
    if (active && !parked && !win.closing && !ref.current?.contains(document.activeElement)) {
      ref.current?.focus({ preventScroll: true });
    }
    // Move focus only when this window becomes the active one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, parked]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || !full || !ref.current) return; // Ctrl+Tab is the member's own browser's
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ----- drag by the title bar
  const onTitlePointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el || full || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const head = e.currentTarget;
    head.setPointerCapture(e.pointerId);
    el.style.willChange = 'transform';
    let dx = 0;
    let dy = 0;
    const move = (ev: PointerEvent): void => {
      dx = ev.clientX - startX;
      dy = ev.clientY - startY;
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    };
    const up = (): void => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      el.style.transform = '';
      el.style.willChange = '';
      if (dx || dy) setWindowRect(win.key, { ...win.rect, x: win.rect.x + dx, y: Math.max(8, win.rect.y + dy) });
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }, [full, win.key, win.rect]);

  // ----- resize from the edges
  const onEdgePointerDown = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = ref.current;
    if (!el || full || e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, r: { ...win.rect } };
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let next: Rect = start.r;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const r = { ...start.r };
      if (edge.includes('e')) r.w = Math.max(MIN_W, start.r.w + dx);
      if (edge.includes('s')) r.h = Math.max(MIN_H, start.r.h + dy);
      if (edge.includes('w')) {
        r.w = Math.max(MIN_W, start.r.w - dx);
        r.x = start.r.x + start.r.w - r.w;
      }
      if (edge.includes('n')) {
        r.h = Math.max(MIN_H, start.r.h - dy);
        r.y = start.r.y + start.r.h - r.h;
      }
      next = r;
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setWindowRect(win.key, next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const close = (): void => requestClose(win.key);
  const Body = def.Window;
  const box = full ? undefined : { left: win.rect.x, top: win.rect.y, width: win.rect.w, height: win.rect.h };

  return (
    <>
      {full && !parked && <div className="window-scrim" onPointerDown={close} />}
      <div
        ref={ref}
        className={`ma-window${full ? ' full' : ''}${active ? ' active' : ''}${parked ? ' parked' : ''}`}
        style={{ ...box, zIndex: win.z + 20 }}
        role="dialog"
        aria-modal={full}
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={`window-${win.app}`}
        data-desk={win.deskId}
        data-app={win.app}
        onPointerDown={() => raiseWindow(win.key)}
        onKeyDown={onKeyDown}
      >
        <div className="window-head" onPointerDown={onTitlePointerDown} onDoubleClick={() => toggleFull(win.key)}>
          <button type="button" className="window-back" onClick={close} aria-label={`Back from ${def.name}`}>
            <Icon name="back" />
          </button>
          <AppGlyph app={win.app} deskId={win.deskId} size={18} />
          <h2 id={titleId} className="window-title">
            {def.name}
            <span className="window-desk">{deskName}</span>
          </h2>
          <div className="window-controls">
            <button type="button" className="icon-btn sm hide-narrow" onClick={() => toggleFull(win.key)} aria-label={full ? 'Restore window' : 'Fill the screen'} title={full ? 'Restore' : 'Fill the screen'}>
              <Icon name={full ? 'windowRestore' : 'windowFull'} />
            </button>
            <button type="button" className="icon-btn sm hide-phone" onClick={close} aria-label={`Close ${def.name}`} title="Close">
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="window-body">
          <Body deskId={win.deskId} deskName={deskName} parked={parked} app={win.app} />
        </div>
        {!full && EDGES.map((edge) => <div key={edge} className={`window-edge ${edge}`} onPointerDown={onEdgePointerDown(edge)} />)}
      </div>
    </>
  );
}
