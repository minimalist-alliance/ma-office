// The Files window's context menu: the office's own menu (`.menu.desk-menu`, `role="menu"` with `role="menuitem"` buttons, keys
// handled as `chrome/DeskMenu.tsx` and `HiddenList.tsx` do: arrows wrap, Home and End, Esc and Tab close, and the menu takes
// focus itself from a pointer and its first item from the keyboard), with type-ahead added. It sits inside the window and
// flips or shifts at its edges. Choosing an item, Esc or a click away closes it, and the keyboard goes back to the list.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { menuTypeAhead, place, type MenuAction, type MenuItem } from './menu';

export interface MenuAt {
  /** Where the point is, in the window's own pixels (before any scale). */
  x: number;
  y: number;
  fromKeyboard: boolean;
  items: MenuItem[];
  label: string;
}

interface Props {
  at: MenuAt;
  /** The element the menu is placed in (position: relative). */
  box: HTMLElement;
  /** Closes it; `back` says the keyboard goes back to the list (and otherwise stays where a click put it). */
  onClose(back: boolean): void;
  onChoose(id: MenuAction): void;
}

export function ContextMenu({ at, box, onClose, onChoose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const typed = useRef({ text: '', at: 0 });
  // The effect below must not run again for a new function, which would take the keyboard back to the first item.
  const close = useRef(onClose);
  close.current = onClose;

  // Place it once it has a size, flipping or shifting so it stays in the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(place(at.x, at.y, el.offsetWidth, el.offsetHeight, box.clientWidth, box.clientHeight));
  }, [at, box]);

  // Focus waits for the menu to be placed: a hidden element takes none. From the keyboard it is the first item, from a pointer the
  // menu itself, so the arrows and Esc still reach it.
  const placed = pos !== null;
  useEffect(() => {
    const el = ref.current;
    if (!el || !placed) return;
    if (at.fromKeyboard) el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    else el.focus({ preventScroll: true });
  }, [at, placed]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const items = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const onKey = (e: KeyboardEvent): void => {
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // the window keeps its own Esc
        close.current(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        list[i <= 0 ? list.length - 1 : i - 1]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        list[list.length - 1]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        close.current(true);
      } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        close.current(true);
      } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = performance.now();
        const t = typed.current;
        t.text = now - t.at > 700 ? e.key : t.text + e.key;
        t.at = now;
        const k = menuTypeAhead(at.items.map((x) => x.label), i, t.text);
        if (k >= 0) {
          e.preventDefault();
          list[k]?.focus();
        }
      }
      // Whatever else is pressed doesn't reach the list under it.
      e.stopPropagation();
    };
    el.addEventListener('keydown', onKey);
    // A click or a touch anywhere else closes it. The click itself is let through (a button elsewhere still works).
    const away = (e: Event): void => {
      if (e.target instanceof Node && el.contains(e.target)) return;
      // A click on something that takes the keyboard (a button, a field) leaves it there; on anything else it goes back to the list.
      const other = e.target instanceof Element && e.target.closest('button, a[href], input, select, textarea, [role="option"], [tabindex]:not([tabindex="-1"])');
      close.current(!other);
    };
    // A touch's own mouse events can put the keyboard back on the list after the menu opened; then Esc still closes it, and any
    // other key brings the keyboard in.
    const stray = (e: KeyboardEvent): void => {
      if (e.target instanceof Node && el.contains(e.target)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current(true);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
      }
    };
    document.addEventListener('keydown', stray, true);
    const leave = (): void => close.current(false);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('contextmenu', away, true);
    window.addEventListener('blur', leave);
    window.addEventListener('resize', leave);
    box.addEventListener('wheel', leave, { passive: true });
    return () => {
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', stray, true);
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('contextmenu', away, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('resize', leave);
      box.removeEventListener('wheel', leave);
    };
  }, [at, box]);

  return (
    <div
      ref={ref}
      className="menu desk-menu files-menu"
      role="menu"
      tabIndex={-1}
      aria-label={at.label}
      data-testid="files-menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {at.items.map((item) => (
        <Fragment key={item.id}>
          {item.separatorBefore && <div className="menu-sep" role="separator" />}
          <button type="button" role="menuitem" className={`menu-item${item.danger ? ' danger' : ''}`} data-item={item.id} onClick={() => onChoose(item.id)}>
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
