// The Notebook menu's keyboard, as pure functions over the menu's shape, so it's tested without a DOM
// (tests/unit/menuNav.test.ts). The component (Menu.tsx) only maps the result to focus.
//
// The state is a stack: the focused item's index at each open level, root first. The deepest entry is where focus is.
// A level is a list (one column) or a grid of swatches (`columns` > 1), where a `wide` item takes a row of its own.

export interface NavNode {
  label: string;
  /** Headings and separators are drawn but never focused. */
  inert?: boolean;
  disabled?: boolean;
  /** A wide item in a grid takes a row of its own. */
  wide?: boolean;
  /** The item opens a submenu. */
  children?: NavNode[];
  /** For a submenu: its columns. 1, or absent, is a list. */
  columns?: number;
  /** Where focus starts in a submenu, after `start`: the checked item. */
  checked?: boolean;
  /** Where focus starts in a submenu above all: a color row's last-used color, when nothing is checked. */
  start?: boolean;
  /** An item with a submenu that also does something itself: Enter or a click does it, then opens the submenu. */
  action?: boolean;
  /** Choosing it leaves the menu open (a checkbox in a filter). */
  keepOpen?: boolean;
}

export type NavEffect =
  | { type: 'none' }
  /** Close the whole menu. `refocus` puts focus back where it was before the menu opened. */
  | { type: 'close'; refocus: boolean }
  /** Choose the item at this path. */
  | { type: 'activate'; path: number[] };

export interface NavResult {
  stack: number[];
  effect: NavEffect;
  /** Whether the key was the menu's, so the caller should prevent its default. */
  handled: boolean;
}

export const focusable = (n: NavNode | undefined): boolean => !!n && !n.inert && !n.disabled;

/** The items of the level at `depth`, given the stack that opened it. */
export function levelItems(root: NavNode[], stack: number[], depth: number): NavNode[] {
  let items = root;
  for (let d = 0; d < depth; d += 1) items = items[stack[d] ?? -1]?.children ?? [];
  return items;
}

export function levelColumns(root: NavNode[], stack: number[], depth: number): number {
  if (depth === 0) return 1;
  const parent = levelItems(root, stack, depth - 1)[stack[depth - 1] ?? -1];
  return Math.max(1, parent?.columns ?? 1);
}

/** The first item focus lands on in a level: the one marked to start on, the checked one, else the first. -1 if none. */
export function initialIndex(items: NavNode[]): number {
  const start = items.findIndex((n) => n.start && focusable(n));
  if (start >= 0) return start;
  const checked = items.findIndex((n) => n.checked && focusable(n));
  return checked >= 0 ? checked : items.findIndex(focusable);
}

/** Opens the menu: focus on its first item. */
export function openStack(root: NavNode[]): number[] {
  const i = root.findIndex(focusable);
  return i < 0 ? [] : [i];
}

function step(items: NavNode[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let k = 1; k <= n; k += 1) {
    const i = (((from + dir * k) % n) + n) % n;
    if (focusable(items[i])) return i;
  }
  return from;
}

/** Row and column of each item in a grid. */
export function gridCells(items: NavNode[], columns: number): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  let row = 0;
  let col = 0;
  for (const it of items) {
    if (it.wide) {
      if (col > 0) row += 1;
      out.push({ row, col: 0 });
      row += 1;
      col = 0;
    } else {
      out.push({ row, col });
      col += 1;
      if (col >= columns) {
        row += 1;
        col = 0;
      }
    }
  }
  return out;
}

function gridVertical(items: NavNode[], columns: number, from: number, dir: 1 | -1): number {
  const cells = gridCells(items, columns);
  const here = cells[from];
  if (!here) return from;
  const rows = Math.max(...cells.map((c) => c.row)) + 1;
  for (let k = 1; k <= rows; k += 1) {
    const row = (((here.row + dir * k) % rows) + rows) % rows;
    const inRow = cells.map((c, i) => ({ ...c, i })).filter((c) => c.row === row && focusable(items[c.i]));
    if (!inRow.length) continue;
    // The same column, or the nearest there is in that row.
    const best = inRow.reduce((a, b) => (Math.abs(b.col - here.col) < Math.abs(a.col - here.col) ? b : a));
    return best.i;
  }
  return from;
}

function gridHorizontal(items: NavNode[], columns: number, from: number, dir: 1 | -1): number | null {
  const cells = gridCells(items, columns);
  const here = cells[from];
  if (!here) return null;
  for (let i = from + dir; i >= 0 && i < items.length; i += dir) {
    if (cells[i]?.row !== here.row) return null;
    if (focusable(items[i])) return i;
  }
  return null;
}

/** Typeahead: the next item after `from` whose label starts with `ch`, wrapping. */
export function typeahead(items: NavNode[], from: number, ch: string): number {
  const c = ch.toLocaleLowerCase();
  const n = items.length;
  for (let k = 1; k <= n; k += 1) {
    const i = (from + k) % n;
    const it = items[i];
    if (focusable(it) && it!.label.trim().toLocaleLowerCase().startsWith(c)) return i;
  }
  return from;
}

/** The menu's answer to one key, from the focused item (the stack's last entry). */
export function navKey(root: NavNode[], stack: number[], key: string): NavResult {
  const same = (handled: boolean): NavResult => ({ stack, effect: { type: 'none' }, handled });
  if (!stack.length) {
    if (key === 'Escape' || key === 'Tab') return { stack, effect: { type: 'close', refocus: true }, handled: true };
    return same(false);
  }
  const depth = stack.length - 1;
  const items = levelItems(root, stack, depth);
  const columns = levelColumns(root, stack, depth);
  const at = stack[depth] ?? 0;
  const item = items[at];
  const set = (i: number): NavResult => ({ stack: [...stack.slice(0, depth), i], effect: { type: 'none' }, handled: true });
  const back = (): NavResult => ({ stack: stack.slice(0, depth), effect: { type: 'none' }, handled: true });
  const openChild = (): NavResult => {
    const kids = item?.children ?? [];
    const first = initialIndex(kids);
    return first < 0 ? same(true) : { stack: [...stack, first], effect: { type: 'none' }, handled: true };
  };

  switch (key) {
    case 'ArrowDown':
      return set(columns > 1 ? gridVertical(items, columns, at, 1) : step(items, at, 1));
    case 'ArrowUp':
      return set(columns > 1 ? gridVertical(items, columns, at, -1) : step(items, at, -1));
    case 'Home':
      return set(items.findIndex(focusable));
    case 'End': {
      let last = -1;
      items.forEach((n, i) => {
        if (focusable(n)) last = i;
      });
      return set(last);
    }
    case 'ArrowRight': {
      if (columns > 1) {
        const next = gridHorizontal(items, columns, at, 1);
        return next === null ? same(true) : set(next);
      }
      return item?.children ? openChild() : same(true);
    }
    case 'ArrowLeft': {
      if (columns > 1) {
        const next = gridHorizontal(items, columns, at, -1);
        if (next !== null) return set(next);
      }
      return depth > 0 ? back() : same(true);
    }
    case 'Enter':
    case ' ':
      if (!focusable(item)) return same(true);
      // An item that acts and has a submenu (Turn into callout) acts first; the caller then opens its submenu.
      if (item?.children && !item.action) return openChild();
      return { stack, effect: { type: 'activate', path: [...stack] }, handled: true };
    case 'Escape':
      return depth > 0 ? back() : { stack: [], effect: { type: 'close', refocus: true }, handled: true };
    case 'Tab':
      // Tab leaves the menu altogether, as a native menu does, back to where the member was.
      return { stack: [], effect: { type: 'close', refocus: true }, handled: true };
    default:
      // A letter jumps to the next item that starts with it. A grid of swatches has the arrows only.
      if (key.length === 1 && key !== ' ' && columns === 1) return set(typeahead(items, at, key));
      return same(false);
  }
}

/** Shift+F10 or the menu key: what opens a context menu from the keyboard. */
export function isMenuKey(e: { key: string; shiftKey: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}
