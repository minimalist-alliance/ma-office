// Touch control's controls (spec (f) sections 2, 3 and 5; the Product Designer's taste call B): the page row, at the foot
// of the Browser's surface where the thumb is (a column at its right on a phone on its side), with what a finger can't do
// on the picture; the key row it turns into while the phone's keyboard is up, riding on the keyboard; and the first-use
// hint card above it. Shown only on a finger's screen (`(pointer: coarse)`, in `app.css`) while the real page shows with
// a picture. Paste in the key row reads the phone's clipboard in its own tap only (Security's condition).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../chrome/icons';
import type { BrowserDriver } from './driver';
import { KEY } from './softKeys';
import { readForPaste } from './touchPaste';
import type { SoftState } from './softKeyboard';
import { TOUCH_HINT, TOUCH_HINT_MORE, TOUCH_HINT_PHONE, type ZoomState } from './touchInput';

const NEXT = new Set(['ArrowRight', 'ArrowDown']);
const PREV = new Set(['ArrowLeft', 'ArrowUp']);
/** Arrows and Delete repeat while held: after this, every `REPEAT_MS`. */
const REPEAT_AFTER_MS = 400;
const REPEAT_MS = 60;

/** Arrows, Home and End move between a toolbar's buttons, with one Tab stop. */
function useToolbar(count: number): { ref: React.RefObject<HTMLDivElement | null>; stop: (i: number) => 0 | -1; onFocusAt: (i: number) => () => void; onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void } {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let to = at;
    if (NEXT.has(e.key)) to = (at + 1) % all.length;
    else if (PREV.has(e.key)) to = (at - 1 + all.length) % all.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = all.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation(); // not the carousel's arrows
    setActive(to);
    all[to]?.focus();
  };
  return { ref, stop: (i) => (i === Math.min(active, count - 1) ? 0 : -1), onFocusAt: (i) => () => setActive(i), onKeyDown };
}

export function TouchRow({ driver, zoom, soft, desktopSite, notice }: { driver: BrowserDriver; zoom: ZoomState; soft: SoftState; desktopSite: boolean | null; notice: string | null }) {
  return soft.typing ? <KeyRow driver={driver} soft={soft} notice={notice} /> : <PageRow driver={driver} zoom={zoom} desktopSite={desktopSite} />;
}

/** Keyboard, Zoom out and Zoom in, Fit while zoomed, and Desktop site once the desk can lay a page out for the phone. */
function PageRow({ driver, zoom, desktopSite }: { driver: BrowserDriver; zoom: ZoomState; desktopSite: boolean | null }) {
  const count = 3 + (zoom.zoomed ? 1 : 0) + (desktopSite === null ? 0 : 1);
  const { ref, stop, onFocusAt, onKeyDown } = useToolbar(count);
  let i = 0;
  const next = (): { tabIndex: 0 | -1; onFocus: () => void } => {
    const at = i++;
    return { tabIndex: stop(at), onFocus: onFocusAt(at) };
  };
  return (
    <div ref={ref} className="br-row" role="toolbar" aria-label="Page controls" onKeyDown={onKeyDown} data-testid="browser-touch-row">
      {/* In the member's own tap, synchronously: iOS raises a keyboard only for a focus inside it. */}
      <button type="button" className="br-row-keyboard" {...next()} onClick={driver.openKeyboard}>
        <Icon name="keyboard" size={20} />
        <span>Keyboard</span>
      </button>
      <div className="br-row-zoom">
        <button type="button" className="br-row-btn" aria-label="Zoom out" title="Zoom out" aria-disabled={!zoom.canOut} {...next()} onClick={() => zoom.canOut && driver.zoomOut()}>
          <Icon name="minus" size={18} />
        </button>
        <button type="button" className="br-row-btn" aria-label="Zoom in" title="Zoom in" aria-disabled={!zoom.canIn} {...next()} onClick={() => zoom.canIn && driver.zoomIn()}>
          <Icon name="plus" size={18} />
        </button>
      </div>
      {zoom.zoomed && (
        <button type="button" className="br-row-btn br-row-fit" aria-label="Fit the page" title="Fit the page" {...next()} onClick={driver.zoomFit}>
          <Icon name="fit" size={20} />
        </button>
      )}
      {desktopSite !== null && (
        <button type="button" className="br-row-desktop" aria-pressed={desktopSite} title="Desktop site" {...next()} onClick={driver.toggleDesktopSite}>
          <span className="br-row-chip">
            <Icon name="screen" size={16} />
            <span>Desktop site</span>
          </span>
        </button>
      )}
    </div>
  );
}

interface KeyDef {
  label: string;
  /** Its name for a screen reader and speech input, which holds what it says on it (WCAG 2.5.3). */
  name: string;
  /** The whole word, where the key says less: its tooltip. */
  long?: string;
  keysym?: number;
  mod?: 'ctrl' | 'alt';
  repeats?: boolean;
}

/** The Designer's order: what a phone keyboard lacks, the arrows early, so the seventh peeks at 390 px. */
const KEYS: KeyDef[] = [
  { label: 'Esc', name: 'Esc', long: 'Escape', keysym: KEY.Escape },
  { label: 'Tab', name: 'Tab', keysym: KEY.Tab },
  { label: 'Ctrl', name: 'Ctrl', long: 'Control', mod: 'ctrl' },
  { label: '←', name: 'Left', keysym: KEY.Left, repeats: true },
  { label: '→', name: 'Right', keysym: KEY.Right, repeats: true },
  { label: '↑', name: 'Up', keysym: KEY.Up, repeats: true },
  { label: '↓', name: 'Down', keysym: KEY.Down, repeats: true },
  { label: 'Alt', name: 'Alt', mod: 'alt' },
  { label: 'Menu', name: 'Menu', keysym: KEY.Menu },
  { label: 'Home', name: 'Home', keysym: KEY.Home },
  { label: 'End', name: 'End', keysym: KEY.End },
  { label: 'PgUp', name: 'Page up', keysym: KEY.PageUp },
  { label: 'PgDn', name: 'Page down', keysym: KEY.PageDown },
  { label: 'Del', name: 'Delete', keysym: KEY.Delete, repeats: true },
];

/**
 * The key row, while the phone's keyboard is up: the page row's place, sitting on the keyboard. Its keys never take the
 * focus, so the keyboard stays up; a screen reader or a paired keyboard presses them with a click.
 */
function KeyRow({ driver, soft, notice }: { driver: BrowserDriver; soft: SoftState; notice: string | null }) {
  const { ref, stop, onFocusAt, onKeyDown } = useToolbar(KEYS.length + 2);
  const repeat = useRef<{ timer: number; interval: number } | null>(null);

  const stopRepeat = (): void => {
    if (!repeat.current) return;
    window.clearTimeout(repeat.current.timer);
    window.clearInterval(repeat.current.interval);
    repeat.current = null;
  };
  useEffect(() => stopRepeat, []);

  // On the keyboard: the layout keeps its height while the phone's keyboard covers its foot, so the row moves up by the
  // part the keyboard covers. One transform, written straight to the element.
  useLayoutEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!el || !vv) return undefined;
    const place = (): void => {
      el.style.transform = '';
      const covered = el.getBoundingClientRect().bottom - (vv.offsetTop + vv.height);
      el.style.transform = covered > 0 ? `translateY(${-covered}px)` : '';
    };
    place();
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => {
      vv.removeEventListener('resize', place);
      vv.removeEventListener('scroll', place);
    };
  }, [ref]);

  const act = (k: KeyDef): void => {
    if (k.mod) driver.toggleMod(k.mod);
    else if (k.keysym !== undefined) driver.softKey(k.keysym);
  };
  /** A finger or a mouse: at once, and again while held for the keys that repeat. Never the focus. */
  const onDown = (k: KeyDef) => (e: ReactPointerEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    stopRepeat();
    act(k);
    if (!k.repeats || k.keysym === undefined) return;
    const sym = k.keysym;
    const timer = window.setTimeout(() => {
      if (repeat.current) repeat.current.interval = window.setInterval(() => driver.softKey(sym), REPEAT_MS);
    }, REPEAT_AFTER_MS);
    repeat.current = { timer, interval: 0 };
  };
  /** A click with no pointer before it: a screen reader's or a paired keyboard's. */
  const onClick = (k: KeyDef) => (e: ReactMouseEvent<HTMLButtonElement>): void => {
    if (e.detail === 0) act(k);
  };
  const keepFocus = (e: ReactMouseEvent | ReactPointerEvent): void => e.preventDefault();

  return (
    <div ref={ref} className="br-row br-keyrow" role="toolbar" aria-label="Keys for the page" onKeyDown={onKeyDown} onMouseDown={keepFocus} data-testid="browser-key-row">
      <div className="br-keyrow-keys">
        {KEYS.map((k, i) => {
          const mod = k.mod ? soft[k.mod] : null;
          return (
            <button
              key={k.name}
              type="button"
              className={`br-key${mod === 'once' || mod === 'lock' ? ' on' : ''}${mod === 'lock' ? ' locked' : ''}`}
              aria-label={k.name}
              title={k.long ?? k.name}
              {...(k.mod ? { 'aria-pressed': mod !== 'off' } : {})}
              tabIndex={stop(i)}
              onFocus={onFocusAt(i)}
              onPointerDown={onDown(k)}
              onPointerUp={stopRepeat}
              onPointerCancel={stopRepeat}
              onPointerLeave={stopRepeat}
              onClick={onClick(k)}
            >
              {k.label}
            </button>
          );
        })}
      </div>
      <span className="br-keyrow-rule" aria-hidden="true" />
      {/* The one place the phone's clipboard is read: this click, once per tap (Security's condition, Nov 11). */}
      <button type="button" className="br-row-btn" aria-label="Paste" title="Paste" tabIndex={stop(KEYS.length)} onFocus={onFocusAt(KEYS.length)} onClick={() => readForPaste(driver)} data-testid="browser-key-paste">
        <Icon name="clipboard" size={20} />
      </button>
      <button type="button" className="br-row-btn" aria-label="Hide the keyboard" title="Hide the keyboard" tabIndex={stop(KEYS.length + 1)} onFocus={onFocusAt(KEYS.length + 1)} onClick={driver.hideKeyboard}>
        <Icon name="keyboardHide" size={20} />
      </button>
      {/* The bar steps aside while typing, so what it would say shows here, 8 px above the row. */}
      {notice && (
        <span className="br-keyrow-pill" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

/**
 * A member's first finger on a picture in this browser: how touch control works. It goes on Got it or after their third
 * gesture, and never comes back for them here (`touchInput.ts`, `driver.noteTouch`). Its words are said once, politely.
 */
export function TouchHint({ onDismiss, phone }: { onDismiss: () => void; phone: boolean }) {
  return (
    <div className="br-touch-hint" role="note" data-testid="browser-touch-hint">
      <p className="br-touch-hint-title">{phone ? TOUCH_HINT_PHONE : TOUCH_HINT}</p>
      <p className="br-touch-hint-more">{TOUCH_HINT_MORE}</p>
      <button type="button" className="br-touch-hint-ok" onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
