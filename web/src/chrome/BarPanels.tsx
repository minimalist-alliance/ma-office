// The panels of the bars' two menu buttons in short-viewport mode (`BarMenus.tsx`), in the top bar's popovers chunk: the
// scope list and the zoom popover, with all an open one does: its keys, a press outside, Esc, and the keyboard's way back
// to its button. Shut, they draw nothing; opened before the chunk is here, they come with it, the keyboard in them.
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { camera } from '../canvas/controller';
import { fitScope, setScope } from '../shell/actions';
import { setView, type Scope } from '../state/viewStore';
import type { PanelProps } from './BarMenus';
import { Icon } from './icons';

type Btn = RefObject<HTMLButtonElement | null>;

/** The quality menu's own check (`quality/QualityMenu.tsx`): the same glyph, not a new one. */
function Check() {
  return (
    <svg className="icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5.5 12.5 4.2 4.2 8.8-9.2" />
    </svg>
  );
}

/**
 * While open: shut by a press outside the button's wrap, by Esc inside it (which gives the keyboard back to the button and
 * goes no further, so the office's own Esc never hears it), and by the keyboard leaving it for somewhere else.
 */
function useShut(btn: Btn, shut: () => void): void {
  const close = useRef(shut);
  close.current = shut;
  useEffect(() => {
    const wrap = btn.current?.parentElement;
    if (!wrap) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!wrap.contains(e.target as Node)) close.current();
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close.current();
      btn.current?.focus();
    };
    const onOut = (e: FocusEvent): void => {
      if (e.relatedTarget && !wrap.contains(e.relatedTarget as Node)) close.current();
    };
    document.addEventListener('pointerdown', onDown);
    wrap.addEventListener('keydown', onKey);
    wrap.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      wrap.removeEventListener('keydown', onKey);
      wrap.removeEventListener('focusout', onOut);
    };
  }, [btn]);
}

/** Arrows (wrapping), Home and End among `items`: the office's menu keys, as `DeskMenu.tsx` has them. */
function moveAmong(e: KeyboardEvent, items: HTMLElement[], next: readonly string[], prev: readonly string[]): boolean {
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to = next.includes(e.key) ? i + 1 : prev.includes(e.key) ? (i < 0 ? -1 : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null;
  if (to === null) return false;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
  return true;
}

/**
 * Personal, Work, Guild and All (those there are desks for, and All), the current one checked, in the office's menu
 * (`.menu.desk-menu`). Up and Down move, Enter or Space picks, Esc and Tab shut it; the keyboard goes back to the button.
 */
export function ScopeList({ options, value, btn, shut }: PanelProps & {
  options: readonly { value: Scope; label: string }[];
  value: Scope;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useShut(btn, shut);
  const items = (): HTMLElement[] => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
  const done = (): void => {
    shut();
    btn.current?.focus();
  };
  useEffect(() => {
    const list = items();
    (list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
    // Only as it opens: a change of scope behind it doesn't move the keyboard.
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (moveAmong(e, items(), ['ArrowDown'], ['ArrowUp'])) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      done();
    }
  };
  return (
    <div ref={ref} id="scope-list" className="menu desk-menu bar-list" role="menu" aria-label="Scope" tabIndex={-1} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="menuitemradio"
          aria-checked={o.value === value}
          className="menu-item"
          onClick={() => {
            done();
            if (o.value !== value) setScope(o.value);
          }}
        >
          <Check />
          {o.label}
        </button>
      ))}
    </div>
  );
}

const zoom = (factor: number): void => {
  setView({ mode: 'free' });
  camera.zoomBy(factor);
};

/**
 * −, + and Fit, in that order, as the zoom group has them, with their keys while it has the keyboard: − or _, + or =,
 * and 0, the canvas's own. Left and Right move between them. It stays open for another press; Esc, a press outside or
 * the keyboard leaving it shut it.
 */
export function ZoomPanel({ btn, shut }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  useShut(btn, shut);
  useEffect(() => {
    // The keyboard goes in, on −. (From a press, Chromium shows no ring for that, and a second press on the button shuts it.)
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (moveAmong(e, Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []), ['ArrowRight', 'ArrowDown'], ['ArrowLeft', 'ArrowUp'])) return;
    const act = e.key === '-' || e.key === '_' ? () => zoom(0.8) : e.key === '+' || e.key === '=' ? () => zoom(1.25) : e.key === '0' ? fitScope : null;
    if (!act || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    act();
  };
  return (
    <div ref={ref} id="zoom-pop" className="zoom-ctl zoom-pop" role="dialog" aria-label="Zoom" onKeyDown={onKey}>
      <button type="button" className="icon-btn chrome" onClick={() => zoom(0.8)} aria-label="Zoom out" title="Zoom out ( − )"><Icon name="minus" /></button>
      <button type="button" className="icon-btn chrome" onClick={() => zoom(1.25)} aria-label="Zoom in" title="Zoom in ( + )"><Icon name="plus" /></button>
      <button type="button" className="icon-btn chrome" onClick={fitScope} aria-label="Fit the desk" title="Fit ( 0 )"><Icon name="fit" /></button>
    </div>
  );
}
