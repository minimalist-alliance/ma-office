// What an agent remembers: the drawer's Memory tab (the Product Designer's spec, section 3), on desk-agent's real
// `agent.memory.list`, `.delete` and `.clear` (S-14, `71ea7739`). Search, delete one at once with no confirm (as Maia's memory
// view), and forget everything behind one plain question whose words make the delete honest. The thread's summary isn't a
// memory and isn't listed. A line's text is the member's: it shows here and nowhere else in this app.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, MemoryLine, MemoryList } from '../client/types';
import { errorText } from '../model/agents';
import { barText, forgetBody, forgetQuestion, marked, matching, MEMORY_WORDS as W, searchPlaceholder, sourceText } from '../model/memory';
import { Icon } from './icons';

const PAGE = 50;

export function MemoryPanel({ client, agent, agents, version, announce }: {
  client: AgentClient;
  agent: Pick<Agent, 'id' | 'name'>;
  agents: readonly Pick<Agent, 'id' | 'name'>[];
  /** Changes when the thread does, so a line the agent just saved shows. */
  version: unknown;
  announce: (text: string) => void;
}) {
  const ids = useId();
  const [list, setList] = useState<MemoryList | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const focusAfter = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    client.listMemories(agent.id).then(
      (l) => {
        if (!live) return;
        setList(l);
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, agent.id, version]);
  // Focus goes to Cancel, never to the destructive button, so Enter then forgets nothing.
  useEffect(() => {
    if (forget) cancelRef.current?.focus();
  }, [forget]);
  // After a delete: the next Delete, or the search box.
  useEffect(() => {
    if (focusAfter.current === null) return;
    const i = focusAfter.current;
    focusAfter.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-testid="memory-delete"]');
    const next = buttons?.[Math.min(i, (buttons?.length ?? 1) - 1)];
    (next ?? searchRef.current)?.focus();
  }, [list]);

  const lines = list?.memories ?? [];
  const found = matching(lines, query);
  const max = list?.limits.items ?? 0;

  const remove = async (line: MemoryLine, index: number): Promise<void> => {
    setBusy(line.id);
    setError(null);
    try {
      await client.deleteMemory(agent.id, line.id, { idem: newIdem() });
      focusAfter.current = index;
      setList((l) => (l ? { ...l, memories: l.memories.filter((m) => m.id !== line.id) } : l));
      announce(W.deleted(agent.name));
    } catch {
      setError(W.deleteFailed);
    } finally {
      setBusy(null);
    }
  };

  const forgetAll = async (): Promise<void> => {
    setBusy('all');
    setError(null);
    try {
      await client.clearMemories(agent.id, { idem: newIdem() });
      setList((l) => (l ? { ...l, memories: [], summary: null } : l));
      setForget(false);
      setQuery('');
      announce(W.forgotAll(agent.name));
      searchRef.current?.focus();
    } catch {
      setError(errorText(null));
    } finally {
      setBusy(null);
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Esc clears the search, and only then closes the drawer.
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    }
  };

  return (
    <div className="ag-panel ag-memory" data-testid="memory-panel">
      <p className="ag-muted ag-small">{W.intro(agent.name)}</p>
      {!list && !failed && <p className="ag-muted">Loading…</p>}
      {failed && !list && (
        <p className="ag-error" role="alert">
          {errorText(null)}
        </p>
      )}
      {list && (
        <>
          {list.on === false && lines.length === 0 ? (
            <p className="ag-muted" data-testid="memory-off">
              {W.offNone(agent.name)}
            </p>
          ) : lines.length === 0 ? (
            <p className="ag-muted" data-testid="memory-empty">
              {W.empty(agent.name)}
            </p>
          ) : (
            <>
              <label className="ag-search" htmlFor={`${ids}-search`}>
                <span className="ag-sr">Search what {agent.name} remembers</span>
                <Icon name="search" />
                <input
                  id={`${ids}-search`}
                  ref={searchRef}
                  type="search"
                  value={query}
                  placeholder={searchPlaceholder(lines.length)}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  autoComplete="off"
                  data-testid="memory-search"
                />
              </label>
              <div className="ag-memory-bar">
                <p className="ag-memory-count" data-testid="memory-count">
                  {barText(lines.length, max, agent.name)}
                </p>
                {!forget && (
                  <button type="button" className="ag-text-btn sm danger" onClick={() => setForget(true)} data-testid="memory-forget">
                    Forget everything
                  </button>
                )}
              </div>
              {forget && (
                <div className="ag-forget" role="group" aria-labelledby={`${ids}-forget`} data-testid="memory-forget-box">
                  <p className="ag-forget-q" id={`${ids}-forget`}>
                    {forgetQuestion(lines.length, agent.name)}
                  </p>
                  <p>{forgetBody(agent.name)}</p>
                  <div className="ag-row-end">
                    <button type="button" ref={cancelRef} className="ag-btn sm" onClick={() => setForget(false)} disabled={busy === 'all'} data-testid="memory-forget-cancel">
                      Cancel
                    </button>
                    <button type="button" className="ag-btn danger sm" onClick={() => void forgetAll()} disabled={busy === 'all'} data-testid="memory-forget-all">
                      Forget everything
                    </button>
                  </div>
                </div>
              )}
              {error && (
                <p className="ag-error" role="alert" data-testid="memory-error">
                  {error}
                </p>
              )}
              {found.length === 0 ? (
                <p className="ag-muted" data-testid="memory-none">
                  {W.none(agent.name, query.trim())}
                </p>
              ) : (
                <ol className="ag-mem-list" ref={listRef} aria-label={`What ${agent.name} remembers`}>
                  {found.slice(0, shown).map((m, i) => (
                    <li key={m.id} className="ag-mem" data-testid="memory-line">
                      <p className="ag-mem-text">
                        {marked(m.text, query).map((r, j) => (r.hit ? <mark key={j}>{r.text}</mark> : <span key={j}>{r.text}</span>))}
                      </p>
                      <p className="ag-mem-meta">
                        <span>{sourceText(m, agents)}</span>
                        {m.pinned && <span className="ag-tag">Always in mind</span>}
                      </p>
                      <div className="ag-mem-actions">
                        <button type="button" className="ag-text-btn sm danger" onClick={() => void remove(m, i)} disabled={busy !== null} aria-label={`Delete “${m.text}”`} data-testid="memory-delete">
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {found.length > shown && (
                <button type="button" className="ag-text-btn" onClick={() => setShown((n) => n + PAGE)}>
                  Show {found.length - shown} more
                </button>
              )}
            </>
          )}
          <p className="ag-muted ag-small ag-memory-foot">{W.foot(agent.name)}</p>
        </>
      )}
    </div>
  );
}
