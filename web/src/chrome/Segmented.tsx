import type { ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function Segmented<T extends string>({ options, value, onChange, label, className = '' }: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Switch({ id, checked, onChange, label, hint }: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="switch-row" htmlFor={id}>
      <span className="switch-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}
