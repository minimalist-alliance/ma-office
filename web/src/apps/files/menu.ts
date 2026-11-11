// What the context menu holds, pure so each case has a test. The menu is the toolbar's actions again, for the selection the
// right click (or long press, or Shift+F10) is on, in the toolbar's order and words. What the bar would show disabled is
// left out here. Nothing in this file decides how an action is done: `FilesBody` does that, as for the bar.
import type { Sel } from './selection';

export type MenuAction = 'open' | 'download' | 'rename' | 'move' | 'delete' | 'restore' | 'deleteForever' | 'emptyTrash' | 'uploadFiles' | 'uploadFolder' | 'newFolder';

export interface MenuItem {
  id: MenuAction;
  label: string;
  /** Destructive: drawn in the danger color. */
  danger?: boolean;
  /** A separator goes above it: set on a destructive item that is not first. */
  separatorBefore?: boolean;
}

export const LABELS: Record<MenuAction, string> = {
  open: 'Open',
  download: 'Download',
  rename: 'Rename',
  move: 'Move to…',
  delete: 'Delete',
  restore: 'Restore',
  deleteForever: 'Delete forever',
  emptyTrash: 'Empty trash',
  uploadFiles: 'Upload files',
  uploadFolder: 'Upload folder',
  newFolder: 'New folder',
};

const DESTRUCTIVE: ReadonlySet<MenuAction> = new Set(['delete', 'deleteForever', 'emptyTrash']);

/** Destructive items go last, in the danger color, after a separator (none when one is the menu's only item). */
const items = (...ids: MenuAction[]): MenuItem[] => {
  const ordered = [...ids.filter((id) => !DESTRUCTIVE.has(id)), ...ids.filter((id) => DESTRUCTIVE.has(id))];
  return ordered.map((id, i) => {
    const item: MenuItem = { id, label: LABELS[id] };
    if (DESTRUCTIVE.has(id)) {
      item.danger = true;
      if (i > 0 && !DESTRUCTIVE.has(ordered[i - 1]!)) item.separatorBefore = true;
    }
    return item;
  });
};

export interface MenuWorld {
  mode: 'folder' | 'search' | 'trash';
  /** The desk can't answer, or the engine isn't ready: the bar's buttons are disabled, so there is nothing to offer. */
  locked: boolean;
  /** Rows in the trash, for "Empty trash". */
  rowCount: number;
}

/** The menu on `rows` (the selection the click leaves), or on the list's empty space when `rows` is null. */
export function menuItems(world: MenuWorld, rows: readonly { type: 'file' | 'dir' }[] | null): MenuItem[] {
  if (world.locked) return [];
  const { mode } = world;
  if (!rows) {
    if (mode === 'trash') return world.rowCount > 0 ? items('emptyTrash') : [];
    // Search results aren't a folder: the bar's uploads and New folder are disabled there, so they are left out.
    return mode === 'folder' ? items('uploadFiles', 'uploadFolder', 'newFolder') : [];
  }
  if (!rows.length) return [];
  if (mode === 'trash') return items('restore', 'deleteForever');
  const one = rows.length === 1;
  const out: MenuAction[] = [];
  // The bar has no Open (Enter and a double click are it); a folder's menu offers it, as a file manager's does.
  if (one && rows[0]!.type === 'dir') out.push('open');
  if (one) out.push('download', 'rename');
  out.push('move', 'delete');
  return items(...out);
}

/**
 * The selection after a right click on row `i`, as a desktop file manager has it: on a row outside the selection the selection
 * becomes that row; on one inside it the selection is kept (and the keyboard moves to the row).
 */
export function selectForMenu(rows: readonly { key: string }[], sel: Sel, i: number): Sel {
  const row = rows[i];
  if (!row) return sel;
  if (sel.keys.includes(row.key)) return { ...sel, active: i };
  return { keys: [row.key], active: i, anchor: i };
}

/** Type-ahead inside the menu: the next item after `from` whose label starts with `text`, wrapping, or -1. */
export function menuTypeAhead(labels: readonly string[], from: number, text: string): number {
  if (!text) return -1;
  const t = text.toLowerCase();
  const cycle = [...t].every((c) => c === t[0]);
  const needle = cycle ? t[0]! : t;
  const start = cycle ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < labels.length; k += 1) {
    const i = (start + k) % labels.length;
    if (labels[i]!.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/**
 * Where the menu's top left goes inside a box `W` by `H` for a click at (`x`, `y`) and a menu `w` by `h`: it flips to the other
 * side of the point when it would cross an edge, and is moved in if it still does not fit.
 */
export function place(x: number, y: number, w: number, h: number, W: number, H: number, edge = 6): { left: number; top: number } {
  const fit = (p: number, size: number, box: number): number => {
    let at = p;
    if (at + size > box - edge) at = p - size;
    return Math.max(edge, Math.min(at, box - size - edge));
  };
  return { left: fit(x, w, W), top: fit(y, h, H) };
}
