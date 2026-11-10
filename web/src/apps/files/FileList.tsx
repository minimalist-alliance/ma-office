// The list of rows: one listbox, keyboard-complete (arrows, Home and End, Shift and Ctrl ranges, Space, type-ahead, Enter,
// Backspace, F2, Delete). The keys act only while this list has focus, so nothing a member dictates or types elsewhere
// moves a file (WCAG 2.1.4). Each row is one option with its whole meaning in its name, since an option holds no controls;
// the actions are the toolbar's, and the same keys. Drag is one way to move, never the only one ("Move to…" is the other).
import { memo, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { formatBytes } from '../../export/format';
import { daysUntil, longDate, shortDate } from './dates';
import { FileIcon, kindOf, kindWords } from './FileIcon';
import { baseName, parent } from './paths';
import { click as clickSel, move as moveSel, selectAll, toggleActive, typeAhead, type Sel } from './selection';
import type { Row } from './useFilesModel';

export interface ListActions {
  open(row: Row): void;
  up(): void;
  rename(row: Row): void;
  remove(rows: Row[]): void;
  /** Trash rows: restore. */
  restore?(rows: Row[]): void;
  /** Rows dragged onto a folder (its path), from inside the window. */
  dropOn?(rows: Row[], folderPath: string): void;
}

interface Props {
  rows: Row[];
  sel: Sel;
  setSel(sel: Sel): void;
  actions: ListActions;
  mode: 'folder' | 'search' | 'trash';
  label: string;
  /** Read-only: the desk is away. Selection and opening a folder still work from the list it has. */
  readOnly: boolean;
}

const DRAG_TYPE = 'application/x-ma-files';

export const FileList = memo(function FileList({ rows, sel, setSel, actions, mode, label, readOnly }: Props) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const [over, setOver] = useState<string | null>(null);
  const selected = new Set(sel.keys);

  // Keep the keyboard's row in view.
  useEffect(() => {
    if (sel.active < 0) return;
    box.current?.querySelector<HTMLElement>(`[data-index="${sel.active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [sel.active]);

  const rowsAt = (keys: string[]): Row[] => rows.filter((r) => keys.includes(r.key));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      return actions.up();
    }
    if (e.altKey || (e.metaKey && e.key !== 'a')) return;
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    const active = rows[sel.active];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return setSel(moveSel(rows, sel, sel.active < 0 ? 0 : sel.active + 1, mods));
      case 'ArrowUp':
        e.preventDefault();
        return setSel(moveSel(rows, sel, sel.active < 0 ? 0 : sel.active - 1, mods));
      case 'Home':
        e.preventDefault();
        return setSel(moveSel(rows, sel, 0, mods));
      case 'End':
        e.preventDefault();
        return setSel(moveSel(rows, sel, rows.length - 1, mods));
      case 'PageDown':
        e.preventDefault();
        return setSel(moveSel(rows, sel, sel.active + 10, mods));
      case 'PageUp':
        e.preventDefault();
        return setSel(moveSel(rows, sel, sel.active - 10, mods));
      case ' ':
        e.preventDefault();
        return setSel(toggleActive(rows, sel.active < 0 ? moveSel(rows, sel, 0, { ctrl: true }) : sel));
      case 'a':
        if (!mods.ctrl) break;
        e.preventDefault();
        return setSel(selectAll(rows, sel));
      case 'Enter':
        if (!active) return;
        e.preventDefault();
        if (mode === 'trash') return actions.restore?.(rowsAt(sel.keys.length ? sel.keys : [active.key]));
        return actions.open(active);
      case 'Backspace':
        if (mode === 'trash') break;
        e.preventDefault();
        return actions.up();
      case 'F2':
        if (!active || readOnly || mode === 'trash') return;
        e.preventDefault();
        return actions.rename(active);
      case 'Delete': {
        if (readOnly) return;
        const picked = sel.keys.length ? rowsAt(sel.keys) : active ? [active] : [];
        if (!picked.length) return;
        e.preventDefault();
        return actions.remove(picked);
      }
      case 'Escape':
        if (sel.keys.length) {
          e.preventDefault();
          e.stopPropagation();
          setSel({ ...sel, keys: [] });
        }
        return;
    }
    // Type-ahead: letters and digits, a short pause forgets them.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.key !== ' ') {
      const now = performance.now();
      const t = typed.current;
      t.text = now - t.at > 700 ? e.key : t.text + e.key;
      t.at = now;
      const i = typeAhead(rows, sel.active, t.text);
      if (i >= 0) {
        e.preventDefault();
        setSel(moveSel(rows, sel, i));
      }
    }
  };

  const onRowClick = (i: number) => (e: MouseEvent): void => {
    setSel(clickSel(rows, sel, i, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey }));
    box.current?.focus({ preventScroll: true });
  };

  const onDragStart = (row: Row) => (e: DragEvent): void => {
    if (readOnly || mode !== 'folder') return e.preventDefault();
    const keys = selected.has(row.key) ? sel.keys : [row.key];
    if (!selected.has(row.key)) setSel({ keys, active: rows.indexOf(row), anchor: rows.indexOf(row) });
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDropRow = (row: Row) => (e: DragEvent): void => {
    setOver(null);
    if (row.type !== 'dir' || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    let keys: string[] = [];
    try {
      keys = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as string[];
    } catch {
      return;
    }
    actions.dropOn?.(rowsAt(keys), row.path);
  };

  return (
    <div
      ref={box}
      className="files-list"
      role="listbox"
      aria-multiselectable="true"
      aria-label={label}
      aria-activedescendant={sel.active >= 0 && rows[sel.active] ? `${id}-${sel.active}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="files-list"
    >
      <div className="files-head" aria-hidden="true">
        <span className="c-name">Name</span>
        {mode === 'search' && <span className="c-where">In</span>}
        <span className="c-size">Size</span>
        <span className="c-date">{mode === 'trash' ? 'Deleted' : 'Modified'}</span>
      </div>
      {rows.map((row, i) => (
        <div
          key={row.key}
          id={`${id}-${i}`}
          role="option"
          aria-selected={selected.has(row.key)}
          data-index={i}
          data-testid="files-row"
          data-name={row.name}
          data-type={row.type}
          className={`files-row${selected.has(row.key) ? ' selected' : ''}${sel.active === i ? ' active' : ''}${over === row.key ? ' drop' : ''}`}
          draggable={!readOnly && mode === 'folder'}
          onClick={onRowClick(i)}
          onDoubleClick={() => (mode === 'trash' ? actions.restore?.([row]) : actions.open(row))}
          onDragStart={onDragStart(row)}
          onDragOver={(e) => {
            if (row.type === 'dir' && e.dataTransfer.types.includes(DRAG_TYPE) && !readOnly) {
              e.preventDefault();
              if (over !== row.key) setOver(row.key);
            }
          }}
          onDragLeave={() => over === row.key && setOver(null)}
          onDrop={onDropRow(row)}
        >
          <span className="c-name">
            <FileIcon name={row.name} type={row.type} />
            <span className="files-name">{row.name}</span>
            <span className="sr-only">, {kindWords(kindOf(row.name, row.type))}</span>
          </span>
          {mode === 'search' && (
            <span className="c-where">
              <span className="sr-only">, in </span>
              {parent(row.path) || 'Top folder'}
            </span>
          )}
          <span className="c-size">
            {row.size !== null && <span className="sr-only">, </span>}
            {row.size !== null ? formatBytes(row.size) : ''}
          </span>
          <span className="c-date" title={longDate(row.mtimeMs)}>
            <span className="sr-only">{mode === 'trash' ? ', deleted ' : ', modified '}</span>
            {shortDate(row.mtimeMs)}
            {mode === 'trash' && row.trash && <span className="sr-only">, gone {daysUntil(row.trash.purgeAt)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
});

export { DRAG_TYPE, baseName };
