// An agent's settings (task 49): everything the lead can set up, by hand. Name and purpose, key and model, the look,
// messaging with other agents, the workspace, timers, a way to its limits, and removing it (never the lead). The panel reads
// the whole agent (`agent.get`): `agent.state` leaves the purpose, the workspace and the rules' text out.
import { useId, useState, type FormEvent } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentCaps, KeyMeta } from '../client/types';
import type { LookTheme } from '../look/tones';
import { errorText } from '../model/agents';
import { charCount } from '../model/links';
import { useRead } from './hooks';
import { BindingPicker } from './Keys';
import { LinksEditor } from './Links';
import { LookEditor } from './Look';
import { TimersSection } from './Timers';
import { WorkspaceSection } from './Workspace';

const PURPOSE_MAX = 4000;
export const isLeadAgent = (a: Pick<Agent, 'lead' | 'role'>): boolean => a.lead === true || a.role === 'manager';

function About({ client, agent, caps }: { client: AgentClient; agent: Agent; caps: AgentCaps | null }) {
  const ids = useId();
  const max = caps?.purposeMax ?? PURPOSE_MAX;
  const [name, setName] = useState(agent.name);
  const [purpose, setPurpose] = useState(agent.purpose ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // The desk's word changed (this save, or a confirmed proposal): take it, unless the member is mid-change.
  const [synced, setSynced] = useState({ name: agent.name, purpose: agent.purpose ?? '' });
  if (synced.name !== agent.name || synced.purpose !== (agent.purpose ?? '')) {
    setSynced({ name: agent.name, purpose: agent.purpose ?? '' });
    if (name === synced.name) setName(agent.name);
    if (purpose === synced.purpose) setPurpose(agent.purpose ?? '');
  }
  const changed = name.trim() !== agent.name || purpose !== (agent.purpose ?? '');
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) {
      setNote({ ok: false, text: 'Give it a name.' });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const patch: { name?: string; purpose?: string } = {};
      if (name.trim() !== agent.name) patch.name = name.trim();
      if (purpose !== (agent.purpose ?? '')) patch.purpose = purpose;
      await client.updateAgent(agent.id, patch, { idem: newIdem() });
      setNote({ ok: true, text: 'Saved' });
    } catch (err) {
      setNote({ ok: false, text: err instanceof AgentError && err.reason === 'name_taken' ? errorText('name_taken') : err instanceof AgentError && err.reason === 'hidden_chars' ? errorText('hidden_chars') : err instanceof AgentError && err.detail === 'name' ? 'A name is 1 to 24 characters.' : err instanceof AgentError && err.detail === 'purpose' ? `A purpose is up to ${max} characters.` : errorText(err instanceof AgentError ? err.reason : null) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ag-about" onSubmit={(e) => void submit(e)} noValidate data-testid="settings-about">
      <label className="ag-field" htmlFor={`${ids}-name`}>
        <span>Name</span>
        <input id={`${ids}-name`} value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoComplete="off" data-testid="settings-name" />
      </label>
      <label className="ag-field" htmlFor={`${ids}-purpose`}>
        <span>Purpose</span>
        <textarea
          id={`${ids}-purpose`}
          className="ag-textarea"
          rows={4}
          value={purpose}
          maxLength={max}
          onChange={(e) => setPurpose(e.target.value)}
          aria-describedby={`${ids}-pc ${ids}-ph`}
          placeholder={isLeadAgent(agent) ? 'Blank uses the lead’s built-in instructions.' : 'What this agent is for, and how it should work.'}
          data-testid="settings-purpose"
        />
        <small id={`${ids}-pc`} className="ag-counter" data-testid="purpose-count">
          {charCount(purpose)} / {max}
        </small>
        <small id={`${ids}-ph`}>Its instructions. Blank uses the built-in default.</small>
      </label>
      <div className="ag-row-end">
        {note && (
          <span className={note.ok ? 'ag-muted ag-small' : 'ag-error'} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </span>
        )}
        <button type="submit" className="ag-btn sm" disabled={busy || !changed} data-testid="settings-save">
          Save
        </button>
      </div>
    </form>
  );
}

function Remove({ client, agent, onDeleted }: { client: AgentClient; agent: Agent; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await client.deleteAgent(agent.id, { idem: newIdem() });
      onDeleted();
    } catch (err) {
      setError(err instanceof AgentError && err.reason === 'busy' ? `${agent.name} is answering. Stop it or wait, then delete it.` : 'The desk couldn’t delete this agent just now.');
      setBusy(false);
    }
  };
  return (
    <div data-testid="settings-remove">
      {confirm ? (
        <div className="ag-confirm" role="group" aria-label={`Delete ${agent.name}`}>
          <span>
            Delete {agent.name}? Its thread, workspace, timers, icon and links go with it, and its tile leaves the desk. The activity and agent-message logs keep their rows.
          </span>
          <button type="button" className="ag-btn sm" onClick={() => setConfirm(false)} disabled={busy} autoFocus>
            Keep
          </button>
          <button type="button" className="ag-btn sm danger" onClick={() => void remove()} disabled={busy} data-testid="agent-delete-confirm">
            Delete {agent.name}
          </button>
        </div>
      ) : (
        <button type="button" className="ag-btn sm danger" onClick={() => setConfirm(true)} data-testid="agent-delete">
          Delete this agent
        </button>
      )}
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsPanel({ client, agent, agents, keys, caps, theme, onOpenUsage, onDeleted }: {
  client: AgentClient;
  /** As `agent.state` has it. */
  agent: Agent;
  agents: readonly Agent[];
  keys: KeyMeta[];
  caps: AgentCaps | null;
  theme: LookTheme;
  onOpenUsage: () => void;
  onDeleted: () => void;
}) {
  // Read again whenever the agent changes on the desk, by anyone: the member here, another window, or a confirmed proposal.
  const version = JSON.stringify(agent);
  const full = useRead<Agent>(() => client.getAgent(agent.id), [client, agent.id, version]);
  const a = full.value && full.value.id === agent.id ? { ...full.value, ...pickLive(agent) } : null;
  if (!a) {
    return (
      <div className="ag-panel" data-testid="settings-panel">
        <p className="ag-muted">{full.error ? 'This agent’s settings couldn’t be read just now.' : 'Reading…'}</p>
      </div>
    );
  }
  const lead = isLeadAgent(a);
  return (
    <div className="ag-panel" data-testid="settings-panel">
      <section aria-label="About">
        <h4>About</h4>
        <About key={a.id} client={client} agent={a} caps={caps} />
      </section>
      <section aria-label="Key and model">
        <h4>Key and model</h4>
        {keys.length ? <BindingPicker key={`${a.id}:${a.binding?.keyId}:${a.binding?.model}`} client={client} agent={a} keys={keys} compact /> : <p className="ag-muted ag-small">Add a key in Keys first.</p>}
      </section>
      {/* The lead's tile stays the Agent app's own tile (a white tile that opens the whole desk team), so it has no look to set. */}
      {!lead && (
        <section aria-label="Look">
          <h4>Look</h4>
          <LookEditor client={client} agent={a} caps={caps} theme={theme} />
        </section>
      )}
      <section aria-label="Messages with other agents">
        <h4>Messages with other agents</h4>
        <LinksEditor key={a.id} client={client} agent={a} agents={agents} caps={caps} />
      </section>
      <section aria-label="Workspace">
        <h4>Workspace</h4>
        <WorkspaceSection key={a.id} client={client} agent={a} agents={agents} caps={caps} />
      </section>
      <section aria-label="Timers">
        <h4>Timers</h4>
        <TimersSection key={a.id} client={client} agent={a} caps={caps} />
      </section>
      <section aria-label="Limits">
        <h4>Limits</h4>
        <p className="ag-muted ag-small">What {a.name} may spend a day, a week and a month, and on each run.</p>
        <div className="ag-row-start">
          <button type="button" className="ag-btn sm" onClick={onOpenUsage} data-testid="settings-limits">
            Usage and limits
          </button>
        </div>
      </section>
      {!lead && (
        <section aria-label="Delete">
          <h4>Delete</h4>
          <Remove client={client} agent={a} onDeleted={onDeleted} />
        </section>
      )}
    </div>
  );
}

/** What `agent.state` says now wins over a read that may be a moment older: status, look, solo and counts. */
function pickLive(a: Agent): Partial<Agent> {
  const out: Partial<Agent> = { status: a.status, binding: a.binding, unseen: a.unseen, name: a.name };
  if (a.look) out.look = a.look;
  if (a.solo !== undefined) out.solo = a.solo;
  if (a.timers !== undefined) out.timers = a.timers;
  return out;
}
