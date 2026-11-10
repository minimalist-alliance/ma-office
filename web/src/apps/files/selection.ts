// The list's selection, as a file manager does it, pure so each rule has a test. Rows are addressed by index into the list
// as it is now; `keys` are the rows' stable keys. `active` is the row the keyboard is on (aria-activedescendant), `anchor`
// where a Shift range starts.
export interface Sel {
  keys: string[];
  active: number;
  anchor: number;
}

export const EMPTY_SEL: Sel = { keys: [], active: -1, anchor: -1 };

export interface Mods {
  shift?: boolean;
  ctrl?: boolean;
}

const range = (rows: readonly { key: string }[], a: number, b: number): string[] => rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.key);

/** A click or a tap on row `i`: plain selects only it, Ctrl toggles it, Shift selects from the anchor. */
export function click(rows: readonly { key: string }[], sel: Sel, i: number, mods: Mods = {}): Sel {
  const row = rows[i];
  if (!row) return sel;
  if (mods.shift && sel.anchor >= 0) return { keys: range(rows, sel.anchor, i), active: i, anchor: sel.anchor };
  if (mods.ctrl) {
    const has = sel.keys.includes(row.key);
    return { keys: has ? sel.keys.filter((k) => k !== row.key) : [...sel.keys, row.key], active: i, anchor: i };
  }
  return { keys: [row.key], active: i, anchor: i };
}

/** Where an arrow, Home, End, PageUp or PageDown goes. Ctrl moves the keyboard without selecting. */
export function move(rows: readonly { key: string }[], sel: Sel, to: number, mods: Mods = {}): Sel {
  if (!rows.length) return EMPTY_SEL;
  const i = Math.max(0, Math.min(rows.length - 1, to));
  if (mods.ctrl && !mods.shift) return { ...sel, active: i };
  if (mods.shift) {
    const anchor = sel.anchor >= 0 ? sel.anchor : Math.max(sel.active, 0);
    return { keys: range(rows, anchor, i), active: i, anchor };
  }
  return { keys: [rows[i]!.key], active: i, anchor: i };
}

/** Space: toggles the row the keyboard is on. */
export function toggleActive(rows: readonly { key: string }[], sel: Sel): Sel {
  const row = rows[sel.active];
  if (!row) return sel;
  const has = sel.keys.includes(row.key);
  return { keys: has ? sel.keys.filter((k) => k !== row.key) : [...sel.keys, row.key], active: sel.active, anchor: sel.active };
}

export function selectAll(rows: readonly { key: string }[], sel: Sel): Sel {
  return { keys: rows.map((r) => r.key), active: Math.max(sel.active, 0), anchor: 0 };
}

/**
 * The selection after the rows changed under it: keys that are gone are dropped, and the indexes follow the keys. The
 * keyboard stays on its row if it is still there, else on the nearest.
 */
export function reconcile(rows: readonly { key: string }[], sel: Sel, activeKey: string | null): Sel {
  if (!rows.length) return EMPTY_SEL;
  const have = new Set(rows.map((r) => r.key));
  const keys = sel.keys.filter((k) => have.has(k));
  // The keyboard has no place until the member puts it somewhere: nothing here invents one.
  if (sel.active < 0 && !activeKey) return keys.length === sel.keys.length ? sel : { keys, active: -1, anchor: -1 };
  let active = activeKey ? rows.findIndex((r) => r.key === activeKey) : -1;
  if (active < 0) active = Math.min(Math.max(sel.active, 0), rows.length - 1);
  const anchor = Math.min(Math.max(sel.anchor, 0), rows.length - 1);
  return { keys, active, anchor };
}

/** The selection after one row took a new key (a rename): the same place in the list, under the new name. */
export function follow(sel: Sel, from: string, to: string): Sel {
  if (!sel.keys.includes(from)) return sel;
  return { ...sel, keys: sel.keys.map((k) => (k === from ? to : k)) };
}

/** Type-ahead: the next row after `from` whose name starts with `text` (case-insensitive), wrapping, or -1. */
export function typeAhead(rows: readonly { name: string }[], from: number, text: string): number {
  if (!text) return -1;
  const t = text.toLowerCase();
  const n = rows.length;
  // The same letter repeated cycles through names that start with it.
  const cycle = [...t].every((c) => c === t[0]);
  const needle = cycle ? t[0]! : t;
  const start = cycle ? from + 1 : Math.max(from, 0);
  for (let k = 0; k < n; k += 1) {
    const i = (start + k) % n;
    if (rows[i]!.name.toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}
