// The drawer's Usage tab (design 9.9): what's spent against each limit, and the member's form to change them. The form leads
// with the whole desk's day and month and its time zone, which follow the account unless this desk sets its own (ADR 0043), and
// sends only what the member changed.
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, LimitsView } from '../client/types';
import { errorText } from '../model/agents';
import { usdLimit } from '../model/format';
import {
  DESK_DEFAULTS,
  DESK_FIELDS,
  DRAFT_FIELDS,
  draftFromView,
  editDraft,
  followAccount,
  layers,
  limitRows,
  parseDraft,
  pricesDate,
  resetText,
  runRows,
  sourceOf,
  ZONE_UNKNOWN,
  zoneList,
  type DraftField,
  type LayeredField,
  type PolicyDraft,
} from '../model/limits';
import { Meter } from './bits';

export function UsageRows({ view }: { view: LimitsView }) {
  const rows = limitRows(view);
  const told = new Set<string>(); // a scope with a $ and a token cap says when it resets once
  return (
    <ul className="ag-usage-rows" data-testid="usage-rows">
      {rows.map((r) => {
        const reset = told.has(r.scope) ? null : resetText(r.scope, r.resetsAt, view);
        told.add(r.scope);
        return (
          <li key={`${r.scope}:${r.text}`} data-level={r.level} data-scope={r.scope}>
            <div className="ag-usage-head">
              <span>{r.label}</span>
              <b>{r.text}</b>
            </div>
            {r.fraction != null && <Meter fraction={r.fraction} level={r.level} label={`${r.label}: ${r.text}`} />}
            {reset && (
              <small className="ag-muted ag-small" data-testid="usage-reset">
                {reset}
              </small>
            )}
          </li>
        );
      })}
      {rows.length === 0 && <li className="ag-muted">No spending limits set.</li>}
    </ul>
  );
}

/**
 * What a desk counts where neither it nor the account sets a value, in words (the brand review): the day's is "No limit", the
 * month's is the desk's built-in amount. The zone's is UTC, which the window replaces with this browser's.
 */
function builtIn(field: LayeredField): { value: string; follow: string } {
  if (field === 'timeZone') return { value: 'Default', follow: 'Use the default' };
  const micro = DESK_DEFAULTS[field];
  return micro == null ? { value: 'No limit', follow: 'Remove the limit' } : { value: `${usdLimit(micro)} · built in`, follow: `Use the built-in ${usdLimit(micro)}` };
}

/** Where a layered value comes from, or the way back to the account's where this desk sets its own. */
function Source({ field, source, accountSets, onFollow, disabled }: { field: LayeredField; source: ReturnType<typeof sourceOf>; accountSets: boolean; onFollow: () => void; disabled: boolean }) {
  if (source === 'account' || source === 'default') {
    return (
      <small className="ag-source" data-testid={`limit-${field}-source`} data-source={source}>
        {source === 'account' ? 'From your account' : builtIn(field).value}
      </small>
    );
  }
  // A zone the account doesn't set has nothing to go back to but UTC, which the box takes as typed. Clearing it would only have
  // this browser's zone set again next time.
  if (source !== 'own' || (field === 'timeZone' && !accountSets)) return null;
  return (
    <button type="button" className="ag-text-btn sm ag-follow" onClick={onFollow} disabled={disabled} data-testid={`limit-${field}-follow`}>
      {accountSets ? 'Use my account’s' : builtIn(field).follow}
    </button>
  );
}

/** One amount: its words on the left, the box on the right, its error under both. */
function AmountField({ id, field, label, hint, extra, draft, error, busy, onChange }: {
  id: string;
  field: DraftField;
  label: string;
  hint?: string | undefined;
  extra?: ReactNode;
  draft: PolicyDraft;
  error: string | undefined;
  busy: boolean;
  onChange: (text: string) => void;
}) {
  return (
    <div className="ag-field ag-limit-field">
      <span>
        <label htmlFor={id}>{label}</label>
        {hint && <small>{hint}</small>}
        {extra}
      </span>
      <span className="ag-amount">
        {field !== 'runMaxSteps' && <span aria-hidden="true">$</span>}
        <input
          id={id}
          inputMode={field === 'runMaxSteps' ? 'numeric' : 'decimal'}
          value={draft[field]}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          disabled={busy}
          data-testid={`limit-${field}`}
        />
      </span>
      {error && (
        <small className="ag-error" id={`${id}-err`}>
          {error}
        </small>
      )}
    </div>
  );
}

export function LimitsPanel({ client, agent, view, onSaved }: { client: AgentClient; agent: Agent; view: LimitsView | null; onSaved: (v: LimitsView) => void }) {
  const ids = useId();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  // What the form opened on: a view that changes under it, as when the zone is set, mustn't turn an untouched box into a change.
  const [base, setBase] = useState<LimitsView | null>(null);
  const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const zones = useMemo(() => (base && layers(base) ? zoneList() : []), [base]);

  if (!view) return <div className="ag-panel ag-muted">Loading…</div>;
  const formView = base ?? view;
  const layered = layers(formView);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!draft) return;
    const parsed = parseDraft(draft, formView);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    setFailed(null);
    if (!parsed.change) {
      setDraft(null); // nothing changed, so nothing to send
      setBase(null);
      return;
    }
    setBusy(true);
    try {
      onSaved(await client.setLimits(agent.id, parsed.change, { idem: newIdem() }));
      setDraft(null);
      setBase(null);
    } catch (err) {
      if (err instanceof AgentError && err.reason === 'time_zone') setErrors({ timeZone: ZONE_UNKNOWN });
      else setFailed(err instanceof AgentError ? errorText(err.reason, err.detail) : errorText(null));
    } finally {
      setBusy(false);
    }
  };

  const edit = (field: DraftField) => (text: string) => draft && setDraft(editDraft(draft, field, text));
  const source = (field: LayeredField) =>
    draft && layered ? (
      <Source field={field} source={sourceOf(draft, formView, field)} accountSets={layered.account[field] != null} onFollow={() => setDraft(followAccount(draft, formView, field))} disabled={busy} />
    ) : null;

  return (
    <div className="ag-panel" data-testid="limits-panel">
      <section>
        <h4>{agent.name}’s spending</h4>
        <UsageRows view={view} />
        <p className="ag-muted ag-small">{runRows(view.policy).join(' · ')}</p>
      </section>
      <section>
        {draft ? (
          <form className="ag-limits-form" onSubmit={(e) => void save(e)} noValidate data-testid="limits-form">
            <h4>Change limits</h4>
            <p className="ag-muted ag-small">In dollars. Leave a box empty for no limit there.</p>
            <fieldset className="ag-limit-group" data-testid="limits-desk">
              <legend>Whole desk team</legend>
              {DESK_FIELDS.filter(({ field }) => field !== 'deskDay' || formView.policy.deskDay).map(({ field, label }) => (
                <AmountField key={field} id={`${ids}-${field}`} field={field} label={label} extra={source(field)} draft={draft} error={errors[field]} busy={busy} onChange={edit(field)} />
              ))}
              {layered && (
                <div className="ag-field ag-zone-field">
                  <span className="ag-zone-head">
                    <label htmlFor={`${ids}-timeZone`}>Time zone</label>
                    {source('timeZone')}
                  </span>
                  <input
                    id={`${ids}-timeZone`}
                    list={`${ids}-zones`}
                    value={draft.timeZone}
                    onChange={(e) => edit('timeZone')(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={errors.timeZone ? true : undefined}
                    aria-describedby={errors.timeZone ? `${ids}-timeZone-err` : `${ids}-timeZone-hint`}
                    disabled={busy}
                    data-testid="limit-timeZone"
                  />
                  <datalist id={`${ids}-zones`}>
                    {zones.map((z) => (
                      <option key={z} value={z} />
                    ))}
                  </datalist>
                  {errors.timeZone ? (
                    <small className="ag-error" id={`${ids}-timeZone-err`} data-testid="limit-timeZone-error">
                      {errors.timeZone}
                    </small>
                  ) : (
                    <small id={`${ids}-timeZone-hint`}>Days and months start at midnight here.</small>
                  )}
                </div>
              )}
            </fieldset>
            <fieldset className="ag-limit-group" data-testid="limits-agent">
              <legend>{agent.name}</legend>
              {DRAFT_FIELDS.map(({ field, label, hint }) => (
                <AmountField key={field} id={`${ids}-${field}`} field={field} label={label} hint={hint} draft={draft} error={errors[field]} busy={busy} onChange={edit(field)} />
              ))}
            </fieldset>
            {failed && <p className="ag-error" role="alert">{failed}</p>}
            <div className="ag-row-end">
              <button type="button" className="ag-btn" onClick={() => (setDraft(null), setBase(null), setErrors({}), setFailed(null))} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="ag-btn primary" disabled={busy} data-testid="limits-save">
                {busy ? 'Saving…' : 'Save limits'}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="ag-btn" onClick={() => (setBase(view), setDraft(draftFromView(view)))} data-testid="limits-edit">
            Change limits
          </button>
        )}
      </section>
      <p className="ag-note">
        Amounts are estimates from the tokens each provider reports.
        {view.pricesAsOf && <span data-testid="prices-as-of"> Prices as of {pricesDate(view.pricesAsOf)}.</span>} Only you can change these; agents can’t. Set a spend limit in the provider’s console too: it’s the real backstop.
      </p>
    </div>
  );
}
