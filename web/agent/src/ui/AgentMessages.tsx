// The drawer's Agent messages view (multi-agent.md section 4): every message between agents, newest first, for this agent
// or all, with its rules, what came of it and its cost. Text, rules and replies are what agents and the member wrote: text
// only.
import { useEffect, useState } from 'react';
import type { AgentClient } from '../client/agentClient';
import type { A2aMessage, Agent } from '../client/types';
import { usd, when } from '../model/format';
import { a2aStateText } from '../model/links';

export function AgentMessagesPanel({ client, agent, agents, version }: { client: AgentClient; agent: Agent; agents: readonly Agent[]; version: string }) {
  const [scope, setScope] = useState<'one' | 'all'>('one');
  const [rows, setRows] = useState<A2aMessage[] | null>(null);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState(false);
  const agentId = scope === 'one' ? agent.id : undefined;

  useEffect(() => {
    let live = true;
    client.listA2a(agentId ? { agentId } : {}).then(
      (page) => {
        if (!live) return;
        setRows(page.messages);
        setOlder(page.older);
        setError(false);
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [client, agentId, version]);

  const more = async (): Promise<void> => {
    const last = rows?.[rows.length - 1];
    if (!last) return;
    try {
      const page = await client.listA2a({ ...(agentId ? { agentId } : {}), before: last.at });
      setRows((r) => [...(r ?? []), ...page.messages.filter((m) => !(r ?? []).some((x) => x.id === m.id))]);
      setOlder(page.older);
    } catch {
      setError(true);
    }
  };

  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? 'a removed agent';
  return (
    <div className="ag-panel" data-testid="a2a-panel">
      <div className="ag-seg" role="radiogroup" aria-label="Whose messages">
        <button type="button" role="radio" aria-checked={scope === 'one'} className={scope === 'one' ? 'on' : ''} onClick={() => setScope('one')}>
          {agent.name}’s
        </button>
        <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')} data-testid="a2a-all">
          Every agent’s
        </button>
      </div>
      <p className="ag-muted ag-small">Every message one agent sends another, with the rules you set for that pair. Kept 100 days.</p>
      {error && <p className="ag-error">The log couldn’t be read just now.</p>}
      {rows && rows.length === 0 && <p className="ag-muted">None yet. Agents are solo until you turn on “Messages other agents” in their settings.</p>}
      <ol className="ag-a2a" aria-label="Agent messages">
        {(rows ?? []).map((m) => (
          <li key={m.id} data-testid="a2a-row" data-state={m.state}>
            <div className="ag-a2a-head">
              <b>
                {name(m.from)} <span aria-label="to">→</span> {name(m.to)}
              </b>
              <span className="ag-muted ag-small">{when(m.at)}</span>
            </div>
            <p className="ag-pre ag-a2a-text">{m.text}</p>
            <p className={`ag-small ag-a2a-state ${m.state}`} data-testid="a2a-state">
              {a2aStateText(m)}
              {m.costMicroUsd != null && ` · est. ${usd(m.costMicroUsd)}`}
            </p>
            <details className="ag-small">
              <summary>Rules</summary>
              <p className="ag-pre" data-testid="a2a-rules">
                {m.rules || 'None.'}
              </p>
            </details>
            {m.reply && (
              <details className="ag-small">
                <summary>Reply</summary>
                <p className="ag-pre">{m.reply}</p>
              </details>
            )}
          </li>
        ))}
      </ol>
      {older && (
        <button type="button" className="ag-btn sm" onClick={() => void more()}>
          Show older
        </button>
      )}
    </div>
  );
}
