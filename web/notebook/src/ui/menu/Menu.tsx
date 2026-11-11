// The Notebook's one menu: every context menu and the ⋯ and filter menus use it.
//
// - Opens at a point (right click), beside an element (a button, or a row from the keyboard), or, on a phone, clear of what
//   it acts on (placement.ts).
// - Arrow keys, Home, End and a letter move; Enter or Space chooses; Right or Enter opens a submenu and Left or Esc closes it;
//   Esc closes the menu and Tab leaves it; focus goes back where it was (nav.ts, gestures.ts).
// - A submenu can be a grid of color swatches, each a radio item named for its color, so a screen reader hears "Blue".
// - On a phone a submenu opens in place of its menu, with Back, so nothing is ever drawn off screen or over the selection.
//
// Rendered in a portal, under `.ma-nb-portal`, so a scrolling list never clips it and nothing leaks into the app.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons.tsx';
import type { PaletteId } from '../palette.ts';
import { createFocusReturn } from './gestures.ts';
import { focusable, initialIndex, levelItems, navKey, openStack, type NavNode } from './nav.ts';
import { placeCompact, placeMenu, placeSubmenu, pointRect, rectOf, type Placement, type Rect } from './placement.ts';

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A dot of this binder tab color before the label. */
  swatch?: string;
  /** A palette color: a round swatch in a grid, or a dot before the label. `null` is "none". */
  pal?: PaletteId | null;
  /** A radio item when set. */
  checked?: boolean;
  /** With `checked`: a checkbox rather than a radio. */
  checkbox?: boolean;
  /** A heading row that isn't selectable. */
  heading?: boolean;
  separator?: boolean;
  /** Choosing it leaves the menu open. */
  keepOpen?: boolean;
  /** Quiet text at the end of the row: a shortcut or a count. */
  hint?: string;
  submenu?: MenuItem[];
  /** For a submenu: drawn as a grid of this many columns. */
  columns?: number;
  /** In a grid: a row of its own ("None"). */
  wide?: boolean;
  /** Where focus starts in its submenu, before the checked item: the last color used. */
  start?: boolean;
  /** What this item would do, for a preview while it's focused or under the pointer (`onActiveChange`). */
  preview?: unknown;
  testId?: string;
}

export type MenuAnchor = { x: number; y: number } | HTMLElement | Rect;

export interface MenuProps {
  items: MenuItem[];
  anchor: MenuAnchor;
  onClose: () => void;
  label: string;
  /** On a phone, what the menu must never cover: the selection, or the pressed row. Defaults to the anchor. */
  avoid?: Rect | null;
  /** Opened by touch: lay it out as on a phone whatever the width. */
  touch?: boolean;
  /** Where focus goes if what had it when the menu opened has gone. */
  fallbackFocus?: HTMLElement | null;
  /** The item focus is on (or the pointer, which moves focus), and null when the menu closes: for a live preview. */
  onActiveChange?: (item: MenuItem | null) => void;
}

/** A phone wraps a row of swatches four across (color.css), so its arrows go by four. */
const COMPACT_COLUMNS = 4;

const toNav = (items: MenuItem[], compact = false): NavNode[] =>
  items.map((it) => ({
    label: it.label,
    inert: !!(it.heading || it.separator),
    disabled: it.disabled,
    wide: it.wide,
    checked: it.checked,
    start: it.start,
    action: !!(it.submenu && it.onSelect),
    keepOpen: it.keepOpen,
    columns: compact && it.columns && it.columns > 1 ? Math.min(it.columns, COMPACT_COLUMNS) : it.columns,
    children: it.submenu ? toNav(it.submenu, compact) : undefined,
  }));

function itemAt(items: MenuItem[], path: number[]): MenuItem | undefined {
  let list = items;
  let it: MenuItem | undefined;
  for (const i of path) {
    it = list[i];
    list = it?.submenu ?? [];
  }
  return it;
}

const isEl = (el: unknown): el is HTMLElement => typeof HTMLElement !== 'undefined' && el instanceof HTMLElement;

function anchorRect(anchor: MenuAnchor): Rect {
  if (isEl(anchor)) return rectOf(anchor.getBoundingClientRect());
  if ('x' in anchor) return pointRect(anchor.x, anchor.y);
  return anchor;
}

/** A phone, or anything with a finger for a pointer: menus lay out clear of the selection, and submenus open in place. */
export function isCompact(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 600 || !!window.matchMedia?.('(pointer: coarse)').matches;
}

/** Filled with the color's label in every use, so it's recognizable in every theme (the Designer's rule). */
function Swatch({ pal }: { pal: PaletteId | null }) {
  return pal === null ? <span className="nb-pal nb-pal-none" aria-hidden="true" /> : <span className="nb-pal" data-pal={pal} aria-hidden="true" />;
}

export function Menu({ items, anchor, onClose, label, avoid, touch, fallbackFocus, onActiveChange }: MenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const compact = useMemo(() => !!touch || isCompact(), [touch]);
  const nav = useMemo(() => toNav(items, compact), [items, compact]);
  const [stack, setStack] = useState<number[]>(() => openStack(nav));
  // A mouse resting on an item with a submenu shows the submenu without taking focus into it.
  const [peek, setPeek] = useState(false);
  const [pos, setPos] = useState<Placement[]>([]);
  const openedAt = useRef(performance.now());
  const back = useMemo(() => createFocusReturn(() => document.activeElement, isEl), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // What had focus when the menu opened gets it back when it closes.
  useLayoutEffect(() => {
    back.capture(fallbackFocus ?? null);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(
    (refocus: boolean) => {
      if (refocus) back.restore();
      else back.forget();
      closeRef.current();
    },
    [back],
  );

  // Which panels show: every level the stack has open, plus a peeked submenu. On a phone, only the deepest.
  const deepest = stack.length - 1;
  const activeItem = deepest >= 0 ? levelItems(nav, stack, deepest)[stack[deepest] ?? -1] : undefined;
  const levels = stack.length + (peek && activeItem?.children && !compact ? 1 : 0);
  const shown = compact ? [Math.max(0, deepest)] : Array.from({ length: Math.max(1, levels) }, (_, d) => d);

  useLayoutEffect(() => {
    const view = { w: window.innerWidth, h: window.innerHeight };
    const next: Placement[] = [];
    for (const d of shown) {
      const el = panels.current[d];
      if (!el) continue;
      const size = { w: el.offsetWidth, h: el.scrollHeight };
      if (compact) {
        next[d] = placeCompact(avoid ?? anchorRect(anchor), size.h, view);
      } else if (d === 0) {
        next[d] = placeMenu(anchorRect(anchor), size, view);
      } else {
        const parent = next[d - 1];
        const parentEl = panels.current[d - 1];
        const itemEl = parentEl?.querySelector<HTMLElement>(`[data-idx="${stack[d - 1]}"]`);
        if (!parent || !parentEl || !itemEl) continue;
        const pRect = { left: parent.left, top: parent.top, right: parent.left + parentEl.offsetWidth, bottom: parent.top + parentEl.offsetHeight };
        const top = parent.top + itemEl.offsetTop - parentEl.scrollTop;
        next[d] = placeSubmenu({ left: pRect.left, right: pRect.right, top, bottom: top + itemEl.offsetHeight }, pRect, size, view);
      }
    }
    setPos((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    // `shown` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, avoid, compact, stack, peek, items]);

  // The item focus is on, for a preview; nothing once the menu has gone.
  const activeRef = useRef(onActiveChange);
  activeRef.current = onActiveChange;
  const activePath = stack.join('.');
  useEffect(() => {
    activeRef.current?.(stack.length ? (itemAt(items, stack) ?? null) : null);
    // Only when focus moves, not on every render of new items.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);
  useEffect(() => () => activeRef.current?.(null), []);

  // Focus follows the stack: the deepest level's item, or the panel itself if it has nothing to focus.
  useLayoutEffect(() => {
    if (deepest < 0) {
      panels.current[0]?.focus({ preventScroll: true });
      return;
    }
    const el = panels.current[deepest]?.querySelector<HTMLElement>(`[data-idx="${stack[deepest]}"]`);
    el?.focus({ preventScroll: true });
  }, [stack, deepest, compact]);

  // A press anywhere else closes it, and focus stays with what was pressed. So does a scroll outside it, or a resize,
  // since the menu would no longer be next to what it's about.
  useEffect(() => {
    const away = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    const resize = () => close(false);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', away, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', resize);
    };
  }, [close]);

  const choose = (path: number[]) => {
    const it = itemAt(items, path);
    if (!it || it.disabled || it.heading || it.separator) return;
    if (it.submenu) {
      // Turn into callout acts at once (in the last color), then shows the row to change it.
      it.onSelect?.();
      const first = initialIndex(toNav(it.submenu, compact));
      setPeek(false);
      if (first >= 0) setStack([...path, first]);
      return;
    }
    if (it.keepOpen) {
      it.onSelect?.();
      return;
    }
    // Focus goes back first, so an action that moves it (a rename field, a confirm) has the last word.
    close(true);
    it.onSelect?.();
  };

  const onKey = (e: KeyboardEvent) => {
    const r = navKey(nav, stack, e.key);
    if (!r.handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (r.effect.type === 'close') close(r.effect.refocus);
    else if (r.effect.type === 'activate') choose(r.effect.path);
    else {
      setPeek(false);
      setStack(r.stack);
    }
  };

  const hover = (depth: number, i: number, it: MenuItem) => {
    if (compact || !focusable(levelItems(nav, stack, depth)[i])) return;
    const same = stack.length === depth + 1 && stack[depth] === i;
    if (!same) setStack([...stack.slice(0, depth), i]);
    // Resting on an item with a submenu shows it (even the item focus started on); another item puts it away.
    if (it.submenu) setPeek(true);
    else if (!same) setPeek(false);
  };

  const renderItem = (it: MenuItem, i: number, depth: number, grid: boolean): ReactNode => {
    if (it.separator) return <div key={i} className="nb-menu-sep" role="separator" />;
    if (it.heading)
      return (
        <div key={i} className="nb-menu-heading" role="presentation">
          {it.label}
        </div>
      );
    const path = [...stack.slice(0, depth), i];
    const expanded = !!it.submenu && stack[depth] === i && (stack.length > depth + 1 || (peek && !compact));
    const role = it.checked === undefined ? 'menuitem' : it.checkbox ? 'menuitemcheckbox' : 'menuitemradio';
    const swatchOnly = grid && !it.wide && it.pal !== undefined;
    return (
      <button
        key={i}
        type="button"
        tabIndex={-1}
        data-idx={i}
        data-testid={it.testId}
        role={role}
        aria-checked={it.checked}
        aria-disabled={it.disabled || undefined}
        aria-haspopup={it.submenu ? 'menu' : undefined}
        aria-expanded={it.submenu ? expanded : undefined}
        aria-label={swatchOnly ? it.label : undefined}
        title={swatchOnly ? it.label : undefined}
        className={`${swatchOnly ? 'nb-menu-swatch' : 'nb-menu-item'}${it.danger ? ' danger' : ''}${it.wide ? ' wide' : ''}${expanded ? ' open' : ''}`}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse') hover(depth, i, it);
        }}
        onClick={() => {
          // The finger that long-pressed lifts after the menu opens: that isn't a choice.
          if (performance.now() - openedAt.current < 250 && compact) return;
          choose(path);
        }}
      >
        {it.swatch && <span className="nb-swatch" data-color={it.swatch} aria-hidden="true" />}
        {it.pal !== undefined && <Swatch pal={it.pal} />}
        {!swatchOnly && <span className="nb-menu-label">{it.label}</span>}
        {!swatchOnly && it.hint && <span className="nb-menu-hint">{it.hint}</span>}
        {!swatchOnly && it.checkbox && <Icon name="check" size={16} className={`nb-menu-check${it.checked ? ' on' : ''}`} />}
        {!swatchOnly && it.submenu && <Icon name="chevronRight" size={15} className="nb-menu-more" />}
      </button>
    );
  };

  const panel = (depth: number) => {
    const list = depth === 0 ? items : (itemAt(items, stack.slice(0, depth)) ?? { submenu: [] }).submenu ?? [];
    const parent = depth === 0 ? undefined : itemAt(items, stack.slice(0, depth));
    const columns = parent?.columns ?? 1;
    const grid = columns > 1;
    const p = pos[depth];
    return (
      <div
        key={depth}
        ref={(el) => {
          panels.current[depth] = el;
        }}
        className={`nb-menu ma-nb-portal${grid ? ' nb-menu-grid' : ''}${compact ? ' compact' : ''}`}
        role="menu"
        tabIndex={-1}
        aria-label={parent ? parent.label : label}
        data-depth={depth}
        data-columns={grid ? columns : undefined}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
        style={{ ...(p ? { left: p.left, top: p.top, maxHeight: p.maxHeight, width: p.width } : { left: -9999, top: -9999 }), ...(grid ? { '--cols': columns } : {}) } as CSSProperties}
      >
        {compact && depth > 0 && (
          <button
            type="button"
            tabIndex={-1}
            role="menuitem"
            className="nb-menu-item nb-menu-back"
            aria-label={`Back to ${depth === 1 ? label : (itemAt(items, stack.slice(0, depth - 1))?.label ?? label)}`}
            onClick={() => setStack(stack.slice(0, depth))}
          >
            <Icon name="chevronLeft" size={15} />
            <span className="nb-menu-label">{parent?.label}</span>
          </button>
        )}
        {list.map((it, i) => renderItem(it, i, depth, grid))}
      </div>
    );
  };

  return createPortal(
    <div ref={root} className="nb-menu-root" data-testid="nb-menu">
      {shown.map((d) => panel(d))}
    </div>,
    document.body,
  );
}
