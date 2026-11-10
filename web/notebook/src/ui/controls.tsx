// Small controls the Notebook shares: segmented switch, inline rename, menus, highlighted text.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MatchRange } from '../model/types.ts';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = options[(i + dir + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    refs.current[(i + dir + options.length) % options.length]?.focus();
  };
  return (
    <div className="nb-seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A name that turns into a field on double-click (or when `editing` is set), and commits on Enter or blur. */
export function InlineName({
  value,
  onCommit,
  label,
  editing: editingProp = false,
  onDone,
}: {
  value: string;
  onCommit: (name: string) => void;
  label: string;
  editing?: boolean;
  onDone?: () => void;
}) {
  const [editing, setEditing] = useState(editingProp);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingProp) setEditing(true);
  }, [editingProp]);
  useEffect(() => {
    if (editing) {
      setDraft(value);
      input.current?.focus();
      input.current?.select();
    }
    // Only when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  if (!editing) {
    return (
      <span className="nb-name" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
        {value}
      </span>
    );
  }
  const finish = (commit: boolean) => {
    const name = draft.trim();
    if (commit && name && name !== value) onCommit(name);
    setEditing(false);
    onDone?.();
  };
  return (
    <input
      ref={input}
      className="nb-inline-name"
      aria-label={label}
      value={draft}
      maxLength={60}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A dot of this tab color before the label. */
  swatch?: string;
  checked?: boolean;
  /** A heading row that isn't selectable. */
  heading?: boolean;
}

/**
 * A menu anchored to a point or an element. Arrow keys move, Enter picks, Esc or a click away closes,
 * and focus goes back where it was. Rendered in a portal so a scrolling list never clips it.
 */
export function Menu({
  items,
  anchor,
  onClose,
  label,
}: {
  items: MenuItem[];
  anchor: { x: number; y: number } | HTMLElement;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const back = useRef<Element | null>(null);

  useLayoutEffect(() => {
    back.current = document.activeElement;
    const el = ref.current;
    if (!el) return;
    const box = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor instanceof HTMLElement ? box.right - w : box.left;
    let top = box.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, box.top - h - 4);
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ left, top });
    el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [anchor]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  const close = (refocus = true) => {
    onClose();
    if (refocus && back.current instanceof HTMLElement) back.current.focus({ preventScroll: true });
  };

  const onKey = (e: KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="nb-menu ma-nb-portal"
      role="menu"
      aria-label={label}
      onKeyDown={onKey}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {items.map((it, i) =>
        it.heading ? (
          <div key={i} className="nb-menu-heading" role="presentation">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={it.checked}
            aria-disabled={it.disabled || undefined}
            className={`nb-menu-item${it.danger ? ' danger' : ''}`}
            onClick={() => {
              if (it.disabled) return;
              close(false);
              it.onSelect?.();
            }}
          >
            {it.swatch && <span className="nb-swatch" data-color={it.swatch} aria-hidden="true" />}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Text with match ranges wrapped in <mark>. */
export function Highlighted({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
