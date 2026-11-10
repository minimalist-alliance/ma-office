// Small shared pieces: the provider badge, the status dot, the switch, the meter.
import type { Agent, Badge } from '../client/types';
import { monogram, STATUS_DOT, statusWord } from '../model/agents';
import type { Level } from '../model/limits';

export function ProviderBadge({ badge, compact = false }: { badge: Pick<Badge, 'providerName'> & { model?: string }; compact?: boolean }) {
  const title = badge.model ? `Runs on ${badge.providerName} · ${badge.model}` : `Runs on ${badge.providerName}`;
  return (
    <span className={`ag-badge${compact ? ' compact' : ''}`} title={title} data-testid="provider-badge">
      <span className="ag-badge-mono" aria-hidden="true">
        {monogram(badge.providerName)}
      </span>
      {compact ? <span className="ag-sr">{badge.providerName}</span> : <span>{badge.providerName}</span>}
    </span>
  );
}

export function StatusWord({ agent }: { agent: Pick<Agent, 'status' | 'binding'> }) {
  return (
    <span className="ag-status" data-status={agent.status}>
      <i className={`ag-dot ${STATUS_DOT[agent.status]}`} aria-hidden="true" />
      {statusWord(agent)}
    </span>
  );
}

export function Switch({ id, label, hint, checked, onChange, disabled, hideLabel = false }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hideLabel?: boolean }) {
  return (
    <label className={`ag-switch-row${hideLabel ? ' bare' : ''}`} htmlFor={id}>
      <span className={hideLabel ? 'ag-sr' : 'ag-switch-text'}>
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ag-switch" aria-hidden="true" />
    </label>
  );
}

export function Meter({ fraction, level, label }: { fraction: number; level: Level; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="ag-meter" data-level={level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <span style={{ transform: `scaleX(${pct / 100})` }} />
    </div>
  );
}

export function Avatar({ large = false }: { large?: boolean }) {
  return (
    <span className={`ag-avatar${large ? ' lg' : ''}`} aria-hidden="true">
      <svg width={large ? 20 : 16} height={large ? 20 : 16} viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" />
      </svg>
    </span>
  );
}
