// Binds what opens a context menu to an element: a right click (or Ctrl+click on a Mac), a long press by touch or pen, and
// Shift+F10 or the menu key while it, or something in it, has focus. Spread the result onto the element.
import { useMemo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { createLongPress } from './gestures.ts';
import { isMenuKey } from './nav.ts';

export interface MenuRequest {
  /** Where: the pointer, or for the keyboard, the middle of the focused element. */
  x: number;
  y: number;
  via: 'pointer' | 'touch' | 'keyboard';
  /** What was pressed or had focus. */
  target: HTMLElement;
}

export interface TriggerProps {
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: MouseEvent<HTMLElement>) => void;
}

/** `open` returns false to leave the browser's own menu alone (nothing of ours applies there). */
export function useMenuTrigger(open: (req: MenuRequest) => boolean | void): TriggerProps {
  const openRef = useRef(open);
  openRef.current = open;
  const target = useRef<HTMLElement | null>(null);
  const press = useMemo(
    () =>
      createLongPress({
        onLongPress: (x, y) => {
          if (target.current?.isConnected) openRef.current({ x, y, via: 'touch', target: target.current });
        },
      }),
    [],
  );
  // A menu is drawn in a portal, and React passes its events up to whatever rendered it: they aren't this element's.
  const own = (e: { currentTarget: EventTarget; target: EventTarget }): boolean => (e.currentTarget as Node).contains(e.target as Node);
  return useMemo<TriggerProps>(
    () => ({
      onContextMenu: (e) => {
        if (!own(e)) return;
        // A long press already opened it; this is the browser's own contextmenu for the same press.
        if (press.justFired()) {
          e.preventDefault();
          return;
        }
        press.cancel();
        const native = e.nativeEvent as globalThis.MouseEvent & { pointerType?: string };
        const via = native.pointerType === 'touch' || native.pointerType === 'pen' ? 'touch' : 'pointer';
        if (openRef.current({ x: e.clientX, y: e.clientY, via, target: e.target as HTMLElement }) !== false) e.preventDefault();
      },
      onKeyDown: (e) => {
        if (!own(e) || !isMenuKey(e)) return;
        const el = e.target as HTMLElement;
        const box = el.getBoundingClientRect();
        if (openRef.current({ x: box.left + Math.min(24, box.width / 2), y: box.top + box.height / 2, via: 'keyboard', target: el }) === false) return;
        e.preventDefault();
        e.stopPropagation();
      },
      onPointerDown: (e) => {
        if (!own(e)) return;
        target.current = e.target as HTMLElement;
        press.down(e.clientX, e.clientY, e.pointerType, e.pointerId, e.isPrimary);
      },
      onPointerMove: (e) => press.move(e.clientX, e.clientY, e.pointerId),
      onPointerUp: () => press.up(),
      onPointerCancel: () => press.cancel(),
      onClickCapture: (e) => {
        if (own(e) && press.justFired()) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    [press],
  );
}
