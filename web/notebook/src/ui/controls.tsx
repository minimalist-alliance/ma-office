// Small controls the Notebook shares: segmented switch, inline rename, menus, highlighted text.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
  readOnly = false,
}: {
  value: string;
  onCommit: (name: string) => void;
  label: string;
  editing?: boolean;
  onDone?: () => void;
  /** Shows the name and does not turn into a field. */
  readOnly?: boolean;
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
  if (readOnly) return <span className="nb-name">{value}</span>;
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

// The Notebook's one menu (menu/Menu.tsx), here too for the views that have always imported it from here.
export { Menu, type MenuItem } from './menu/Menu.tsx';

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
