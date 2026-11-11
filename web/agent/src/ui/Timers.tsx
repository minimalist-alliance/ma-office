// An agent's timers, in its settings (multi-agent.md section 6): listed with the next run in the member's zone, the last
// result and what they've spent; added, changed, switched on and off, and deleted. A timer starts a run of its agent with its
// prompt, and its runs count toward every limit.
import { useId, useMemo, useState, type FormEvent } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentCaps, Timer, TimerInput, TimerList } from '../client/types';
import { usd } from '../model/format';
import { charCount } from '../model/links';
import { browserZone } from '../model/limits';
import { DAYS, isFinished, lastStateText, parseTime, scheduleText, timerProblem, timerProblemText, wallAt, wallToEpoch, whenText, zoneName } from '../model/timers';
import { Switch } from './bits';
import { useRead, useUnsaved } from './hooks';
import { Icon } from './icons';

const CAPS_FALLBACK = { promptMax: 2000, timerMinMinutes: 5, timersPerAgent: 10 };

/** A timer's input again, for a change that keeps the rest as it is. */
export function inputOf(t: Timer): TimerInput {
  const base = { id: t.id, label: t.label, kind: t.kind, prompt: t.prompt, enabled: t.enabled };
  if (t.kind === 'once') return { ...base, at: t.at };
  return t.everyMinutes != null ? { ...base, everyMinutes: t.everyMinutes } : { ...base, days: t.days ?? [], time: t.time ?? '' };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DDTHH:MM` in the zone, for a datetime-local field. */
function localValue(ms: number, zone: string | null): string {
  const w = wallAt(ms, zone);
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

type Draft = {
  label: string;
  prompt: string;
  kind: 'once' | 'repeat';
  once: 'in' | 'at';
  inAmount: string;
  inUnit: 'minutes' | 'hours';
  at: string;
  repeat: 'days' | 'every';
  days: number[];
  time: string;
  every: string;
  everyUnit: 'minutes' | 'hours';
  enabled: boolean;
};

function draftOf(t: Timer | null, zone: string | null, now: number): Draft {
  const blank: Draft = { label: '', prompt: '', kind: 'repeat', once: 'in', inAmount: '2', inUnit: 'hours', at: localValue(now + 3_600_000, zone), repeat: 'days', days: [1, 2, 3, 4, 5], time: '08:00', every: '60', everyUnit: 'minutes', enabled: true };
  if (!t) return blank;
  return {
    ...blank,
    label: t.label,
    prompt: t.prompt,
    kind: t.kind,
    once: 'at',
    at: t.at != null ? localValue(t.at, zone) : blank.at,
    repeat: t.everyMinutes != null ? 'every' : 'days',
    days: t.days ?? blank.days,
    time: t.time ?? blank.time,
    // A whole number of hours reads as hours.
    every: t.everyMinutes != null ? String(t.everyMinutes % 60 === 0 ? t.everyMinutes / 60 : t.everyMinutes) : blank.every,
    everyUnit: t.everyMinutes != null && t.everyMinutes % 60 === 0 ? 'hours' : 'minutes',
    enabled: t.enabled,
  };
}

/** The form's draft as what `agent.timer.set` takes. */
function inputFrom(d: Draft, id: string | undefined, zone: string | null): TimerInput {
  const base = { ...(id ? { id } : {}), label: d.label.trim(), prompt: d.prompt.trim(), kind: d.kind, enabled: d.enabled };
  if (d.kind === 'once') {
    if (d.once === 'in') {
      const n = Number(d.inAmount);
      return { ...base, inMinutes: Number.isFinite(n) ? Math.round(n * (d.inUnit === 'hours' ? 60 : 1)) : NaN };
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(d.at);
    return { ...base, at: m ? wallToEpoch(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), zone) : NaN };
  }
  if (d.repeat === 'every') return { ...base, everyMinutes: Math.round(Number(d.every) * (d.everyUnit === 'hours' ? 60 : 1)) };
  return { ...base, days: [...d.days].sort((a, b) => a - b), time: parseTime(d.time) ? d.time : '' };
}

function TimerForm({ client, agentId, timer, zone, caps, onDone, onCancel }: { client: AgentClient; agentId: string; timer: Timer | null; zone: string | null; caps: typeof CAPS_FALLBACK; onDone: () => void; onCancel: () => void }) {
  const ids = useId();
  const [d, setD] = useState<Draft>(() => draftOf(timer, zone, Date.now()));
  const [opened] = useState(d);
  useUnsaved(useMemo(() => JSON.stringify(d) !== JSON.stringify(opened), [d, opened]));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>): void => {
    setD((x) => ({ ...x, ...patch }));
    setProblem(null);
  };
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const input = inputFrom(d, timer?.id, zone);
    const local = timerProblem(input, caps, Date.now());
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    try {
      await client.setTimer(agentId, input, { idem: newIdem() });
      onDone();
    } catch (err) {
      setProblem(err instanceof AgentError ? (err.reason === 'timer_cap' || err.reason === 'hidden_chars' ? err.reason : err.detail) : null);
    } finally {
      setBusy(false);
    }
  };
  const err = (field: string | string[]): boolean => (Array.isArray(field) ? field.includes(problem ?? '') : problem === field);
  return (
    <form className="ag-timer-form" onSubmit={(e) => void submit(e)} noValidate data-testid="timer-form" aria-label={timer ? `Change ${timer.label}` : 'New timer'}>
      <label className="ag-field" htmlFor={`${ids}-label`}>
        <span>Name</span>
        <input id={`${ids}-label`} value={d.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} aria-invalid={err('label') || undefined} placeholder="e.g. Morning brief" data-testid="timer-label" />
      </label>
      <label className="ag-field" htmlFor={`${ids}-prompt`}>
        <span>What it asks</span>
        <textarea id={`${ids}-prompt`} className="ag-textarea" rows={2} value={d.prompt} maxLength={caps.promptMax} onChange={(e) => set({ prompt: e.target.value })} aria-invalid={err('prompt') || undefined} aria-describedby={`${ids}-pc`} data-testid="timer-prompt" />
        <small id={`${ids}-pc`} className="ag-counter">
          {charCount(d.prompt)} / {caps.promptMax}
        </small>
      </label>
      <fieldset className="ag-field">
        <legend>When</legend>
        <div className="ag-seg" role="radiogroup" aria-label="Once or repeating">
          {(['once', 'repeat'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={d.kind === k} className={d.kind === k ? 'on' : ''} onClick={() => set({ kind: k })} data-testid={`timer-kind-${k}`}>
              {k === 'once' ? 'Once' : 'Repeat'}
            </button>
          ))}
        </div>
        {d.kind === 'once' ? (
          <div className="ag-timer-when">
            <label className="ag-radio">
              <input type="radio" name={`${ids}-once`} checked={d.once === 'in'} onChange={() => set({ once: 'in' })} />
              <span>In</span>
            </label>
            <input className="ag-num" inputMode="numeric" aria-label="How many" value={d.inAmount} onChange={(e) => set({ inAmount: e.target.value, once: 'in' })} aria-invalid={err('inMinutes') || undefined} data-testid="timer-in" />
            <select aria-label="Minutes or hours" value={d.inUnit} onChange={(e) => set({ inUnit: e.target.value as Draft['inUnit'], once: 'in' })} data-testid="timer-in-unit">
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
            <label className="ag-radio">
              <input type="radio" name={`${ids}-once`} checked={d.once === 'at'} onChange={() => set({ once: 'at' })} />
              <span>At</span>
            </label>
            <input type="datetime-local" aria-label="Date and time" value={d.at} onChange={(e) => set({ at: e.target.value, once: 'at' })} aria-invalid={err('at') || undefined} data-testid="timer-at" />
          </div>
        ) : (
          <div className="ag-timer-when">
            <label className="ag-radio">
              <input type="radio" name={`${ids}-rep`} checked={d.repeat === 'days'} onChange={() => set({ repeat: 'days' })} data-testid="timer-repeat-days" />
              <span>On</span>
            </label>
            <div className="ag-days" role="group" aria-label="Days">
              {DAYS.map((day) => (
                <label key={day.n} className="ag-day" title={day.long}>
                  <input type="checkbox" checked={d.days.includes(day.n)} onChange={(e) => set({ repeat: 'days', days: e.target.checked ? [...d.days, day.n] : d.days.filter((x) => x !== day.n) })} aria-label={day.long} />
                  <span aria-hidden="true">{day.short[0]}</span>
                </label>
              ))}
            </div>
            <input type="time" aria-label="Time of day" value={d.time} onChange={(e) => set({ time: e.target.value, repeat: 'days' })} aria-invalid={err(['time', 'days']) || undefined} data-testid="timer-time" />
            <label className="ag-radio">
              <input type="radio" name={`${ids}-rep`} checked={d.repeat === 'every'} onChange={() => set({ repeat: 'every' })} data-testid="timer-repeat-every" />
              <span>Every</span>
            </label>
            <input className="ag-num" inputMode="numeric" aria-label="Every how many minutes" value={d.every} onChange={(e) => set({ every: e.target.value, repeat: 'every' })} aria-invalid={err('everyMinutes') || undefined} data-testid="timer-every" />
            <select aria-label="Minutes or hours" value={d.everyUnit} onChange={(e) => set({ everyUnit: e.target.value as Draft['everyUnit'], repeat: 'every' })} data-testid="timer-every-unit">
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </div>
        )}
      </fieldset>
      {problem !== null && (
        <p className="ag-error" role="alert" data-testid="timer-error">
          {timerProblemText(problem, caps)}
        </p>
      )}
      <div className="ag-row-end">
        <button type="button" className="ag-text-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="ag-btn primary sm" disabled={busy} data-testid="timer-save">
          {timer ? 'Save timer' : 'Add timer'}
        </button>
      </div>
    </form>
  );
}

export function TimersSection({ client, agent, caps }: { client: AgentClient; agent: Agent; caps: AgentCaps | null }) {
  const limits = caps ? { promptMax: caps.promptMax, timerMinMinutes: caps.timerMinMinutes, timersPerAgent: caps.timersPerAgent } : CAPS_FALLBACK;
  const [tick, setTick] = useState(0);
  // Read again as the agent's count or status changes: a timer's run shows as the agent working, then its last result.
  const list = useRead<TimerList>(() => client.listTimers(agent.id), [client, agent.id, tick, agent.timers, agent.status]);
  const [editing, setEditing] = useState<Timer | 'new' | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = list.value?.timers ?? [];
  const zone = list.value?.zone ?? null;
  const full = timers.length >= limits.timersPerAgent;
  const reload = (): void => setTick((t) => t + 1);
  // This computer's zone, when the timers' differs from it (or fell back to UTC): one press makes it the desk's zone.
  const here = browserZone();
  const mismatch = list.value && here && (zone ?? 'UTC') !== here ? here : null;

  const moveToHere = async (): Promise<void> => {
    if (!mismatch) return;
    setError(null);
    try {
      await client.setLimits(agent.id, { timeZone: mismatch }, { idem: newIdem() });
      reload();
    } catch {
      setError('The desk couldn’t change its time zone just now.');
    }
  };
  const toggle = async (t: Timer, on: boolean): Promise<void> => {
    setError(null);
    try {
      // A one-shot timer whose time has passed can't be switched back on as it is: it needs a new time.
      await client.setTimer(agent.id, { ...inputOf(t), enabled: on }, { idem: newIdem() });
      reload();
    } catch (err) {
      setError(err instanceof AgentError && err.detail === 'at' ? 'That time has passed. Change the timer to give it a new one.' : 'The desk couldn’t change this timer just now.');
    }
  };
  const remove = async (t: Timer): Promise<void> => {
    setError(null);
    try {
      await client.deleteTimer(agent.id, t.id, { idem: newIdem() });
      setConfirm(null);
      reload();
    } catch {
      setError('The desk couldn’t delete this timer just now.');
    }
  };

  return (
    <div className="ag-timers" data-testid="timers">
      {list.value && (
        <p className="ag-muted ag-small" data-testid="timers-zone">
          Times are in {zoneName(zone)}.
          {mismatch && (
            <>
              {' '}
              Your computer is on {zoneName(mismatch)}.{' '}
              <button type="button" className="ag-text-btn sm" onClick={() => void moveToHere()} data-testid="timers-use-zone">
                Use {zoneName(mismatch)}
              </button>
            </>
          )}
        </p>
      )}
      {list.value && timers.length === 0 && !editing && <p className="ag-muted ag-small">No timers. A timer asks {agent.name} something once, or on a schedule.</p>}
      <ul className="ag-timer-list">
        {timers.map((t) =>
          editing !== 'new' && editing?.id === t.id ? (
            <li key={t.id}>
              <TimerForm client={client} agentId={agent.id} timer={t} zone={zone} caps={limits} onCancel={() => setEditing(null)} onDone={() => (setEditing(null), reload())} />
            </li>
          ) : (
            <li key={t.id} className="ag-timer" data-testid="timer-row">
              <div className="ag-timer-main">
                <Icon name="clock" size={14} />
                <b className="ag-timer-label">{t.label}</b>
                {isFinished(t) ? <span className="ag-muted ag-small" data-testid="timer-done">Done</span> : <Switch id={`ag-timer-${t.id}`} label={`${t.label}, on`} checked={t.enabled} onChange={(v) => void toggle(t, v)} hideLabel />}
              </div>
              <p className="ag-small ag-timer-line">
                <span data-testid="timer-schedule">{scheduleText(t, zone)}</span>
                <span className="ag-muted" data-testid="timer-next">
                  {isFinished(t) ? 'Done' : t.nextAt != null ? `Next: ${whenText(t.nextAt, zone)}` : t.enabled ? 'Not scheduled again' : 'Off'}
                </span>
              </p>
              <p className="ag-muted ag-small ag-timer-line" data-testid="timer-last">
                <span>
                  {lastStateText(t.lastState)}
                  {t.lastAt != null && `, ${whenText(t.lastAt, zone)}`}
                </span>
                <span>{t.spentMicroUsd ? `${usd(t.spentMicroUsd)} spent` : 'nothing spent yet'}</span>
              </p>
              <div className="ag-timer-foot">
                <details className="ag-small">
                  <summary>What it asks</summary>
                  <p className="ag-pre">{t.prompt}</p>
                </details>
                {confirm === t.id ? (
                  <span className="ag-confirm">
                    <span>Delete this timer?</span>
                    <button type="button" className="ag-btn sm" onClick={() => setConfirm(null)}>
                      Keep
                    </button>
                    <button type="button" className="ag-btn sm danger" onClick={() => void remove(t)} data-testid="timer-delete-confirm">
                      Delete
                    </button>
                  </span>
                ) : (
                  <span className="ag-timer-actions">
                    <button type="button" className="ag-text-btn sm" onClick={() => setEditing(t)} aria-label={`Change ${t.label}`} data-testid="timer-edit">
                      Change
                    </button>
                    <button type="button" className="ag-text-btn sm" onClick={() => setConfirm(t.id)} aria-label={`Delete ${t.label}`} data-testid="timer-delete">
                      Delete
                    </button>
                  </span>
                )}
              </div>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <TimerForm client={client} agentId={agent.id} timer={null} zone={zone} caps={limits} onCancel={() => setEditing(null)} onDone={() => (setEditing(null), reload())} />
      ) : (
        <div className="ag-row-start">
          <button type="button" className="ag-btn sm" onClick={() => setEditing('new')} disabled={full} aria-describedby={full ? `ag-timers-full-${agent.id}` : undefined} data-testid="timer-add">
            <Icon name="plus" size={14} /> Add a timer
          </button>
          {full && (
            <span id={`ag-timers-full-${agent.id}`} className="ag-muted ag-small">
              {limits.timersPerAgent} timers is the most an agent can have.
            </span>
          )}
        </div>
      )}
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
