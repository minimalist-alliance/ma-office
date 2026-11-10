// Messages with other agents, in an agent's settings (multi-agent.md section 4): whether it messages other agents at all
// (off is solo, the default), and whom it may message, each with the member's rules of engagement, which travel with every
// message. Below, read-only, the links into this agent and their rules. An agent receives from any agent whose link names it. Saved together, and refused here with
// words before the desk would refuse it.
import { useId, useState } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, AgentCaps, AgentLink } from '../client/types';
import { charCount, linkProblems, type LinkProblem } from '../model/links';
import { Switch } from './bits';

const RULES_MAX = 500;

const PROBLEM: Record<LinkProblem, string> = {
  self: 'An agent can’t message itself.',
  unknown: 'That agent isn’t on this desk any more.',
  duplicate: 'That agent is listed twice.',
  empty: 'Write the rules for this pairing.',
  long: 'Keep the rules shorter.',
};

export function LinksEditor({ client, agent, agents, caps }: { client: AgentClient; agent: Agent; agents: readonly Agent[]; caps: AgentCaps | null }) {
  const ids = useId();
  const rulesMax = caps?.rulesMax ?? RULES_MAX;
  const others = agents.filter((a) => a.id !== agent.id);
  const [solo, setSolo] = useState(agent.solo ?? true);
  const [picked, setPicked] = useState<Record<string, string | null>>(() => Object.fromEntries((agent.links ?? []).map((l) => [l.to, l.rules ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [shown, setShown] = useState<Record<string, LinkProblem>>({});
  // A paste that went past the most is cut by the field; this says so, until the next edit.
  const [cut, setCut] = useState<string | null>(null);

  const links: AgentLink[] = Object.entries(picked).flatMap(([to, rules]) => (rules === null ? [] : [{ to, rules }]));
  const was = JSON.stringify({ solo: agent.solo ?? true, links: (agent.links ?? []).map((l) => ({ to: l.to, rules: l.rules ?? '' })) });
  const now = JSON.stringify({ solo, links });
  // The desk's word changed (a save landed, or the lead's proposal did): take it, unless the member is mid-change.
  const [synced, setSynced] = useState(was);
  if (synced !== was) {
    setSynced(was);
    if (now === synced) {
      setSolo(agent.solo ?? true);
      setPicked(Object.fromEntries((agent.links ?? []).map((l) => [l.to, l.rules ?? ''])));
    }
  }
  // Links to agents that have gone since don't count against a save: the desk took them off already.
  const live = links.filter((l) => agents.some((a) => a.id === l.to));
  // The links into this agent: the full view says them with their rules; an older desk's list gives who, without the rules.
  const inbound: { from: Agent; rules: string }[] = (
    agent.incoming ?? others.filter((a) => (a.links ?? []).some((l) => l.to === agent.id)).map((a) => ({ from: a.id, rules: '' }))
  ).flatMap((i) => {
    const from = agents.find((a) => a.id === i.from);
    return from ? [{ from, rules: i.rules }] : [];
  });

  const save = async (): Promise<void> => {
    setSaved(false);
    setError(null);
    const problems = solo ? [] : linkProblems(agent.id, live, agents, rulesMax);
    setShown(Object.fromEntries(problems.map((p) => [p.to, p.problem])));
    if (problems.length) return;
    setBusy(true);
    try {
      await client.setLinks(agent.id, { solo, links: live.map((l) => ({ to: l.to, rules: (l.rules ?? '').trim() })) }, { idem: newIdem() });
      setSaved(true);
    } catch (err) {
      setError(err instanceof AgentError && err.reason === 'hidden_chars' ? 'Those rules have hidden characters in them. Remove them and try again.' : err instanceof AgentError && err.detail === 'links' ? 'The desk refused these links. Check each has its rules.' : 'The desk couldn’t save this just now. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ag-links" data-testid="links-editor">
      <Switch
        id={`${ids}-messages`}
        label="Messages other agents"
        hint="Off means solo: it messages no other agent. Every new agent starts solo."
        checked={!solo}
        onChange={(v) => {
          setSolo(!v);
          setSaved(false);
        }}
      />
      {!solo && (
        <fieldset className="ag-field" data-testid="links-list">
          <legend>{agent.name} may message</legend>
          {others.length === 0 && <p className="ag-muted ag-small">No other agents on this desk yet.</p>}
          {others.map((o) => {
            const on = picked[o.id] !== undefined && picked[o.id] !== null;
            const rules = picked[o.id] ?? '';
            const problem = shown[o.id];
            const count = charCount(rules);
            return (
              <div key={o.id} className="ag-link-row" data-testid={`link-${o.id}`}>
                <label className="ag-check">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      setPicked((p) => ({ ...p, [o.id]: e.target.checked ? (p[o.id] ?? '') : null }));
                      setSaved(false);
                    }}
                  />
                  <span>{o.name}</span>
                </label>
                {on && (
                  <label className="ag-field" htmlFor={`${ids}-r-${o.id}`}>
                    <span>Rules of engagement with {o.name}</span>
                    <textarea
                      id={`${ids}-r-${o.id}`}
                      className="ag-textarea"
                      rows={2}
                      value={rules}
                      maxLength={rulesMax}
                      required
                      aria-invalid={problem ? true : undefined}
                      aria-describedby={`${ids}-c-${o.id}${problem ? ` ${ids}-e-${o.id}` : ''}`}
                      placeholder="e.g. Ask only for summaries. Never pass on my notes."
                      onPaste={(e) => {
                        const field = e.currentTarget;
                        const pasted = e.clipboardData.getData('text');
                        const room = rulesMax - (field.value.length - Math.abs(field.selectionEnd - field.selectionStart));
                        if (pasted.length > room) setCut(o.id);
                      }}
                      onChange={(e) => {
                        const text = e.target.value;
                        setPicked((p) => ({ ...p, [o.id]: text }));
                        setSaved(false);
                        if (cut === o.id && text.length < rulesMax) setCut(null);
                      }}
                      data-testid="link-rules"
                    />
                    <small id={`${ids}-c-${o.id}`} className="ag-counter" aria-live="off">
                      {count} / {rulesMax}
                    </small>
                    {cut === o.id && (
                      <small className="ag-muted" role="status" data-testid="link-cut">
                        Cut to {rulesMax} characters.
                      </small>
                    )}
                    {problem && (
                      <small id={`${ids}-e-${o.id}`} className="ag-error" role="alert">
                        {PROBLEM[problem]}
                      </small>
                    )}
                  </label>
                )}
              </div>
            );
          })}
          <p className="ag-muted ag-small">The rules go with every message {agent.name} sends that agent, and the agent-message log keeps them.</p>
          <p className="ag-muted ag-small" data-testid="links-scope">
            An agent answering a message uses its own workspace only: not its chat with you, and not workspaces shared with it.
          </p>
        </fieldset>
      )}
      {inbound.length > 0 && (
        <div className="ag-inbound" data-testid="links-inbound">
          <h5>Messaged by</h5>
          <ul className="ag-inbound-list">
            {inbound.map(({ from, rules }) => (
              <li key={from.id} data-testid={`inbound-${from.id}`}>
                <strong>{from.name}</strong>
                {from.solo !== false && <span className="ag-muted ag-small"> (solo for now: it sends none)</span>}
                {rules && <p className="ag-inbound-rules">{rules}</p>}
                <small className="ag-muted">Change in {from.name}’s settings.</small>
              </li>
            ))}
          </ul>
          <p className="ag-muted ag-small">{agent.name} gets these rules with each message and answers under them.</p>
        </div>
      )}
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
      <div className="ag-row-end">
        {saved && (
          <span className="ag-muted ag-small" role="status">
            Saved
          </span>
        )}
        <button type="button" className="ag-btn sm" onClick={() => void save()} disabled={busy || was === now} data-testid="links-save">
          Save messaging
        </button>
      </div>
    </div>
  );
}
