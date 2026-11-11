// Tools running now, in a strip above the composer, and the chips a reply keeps after (the Product Designer's spec, section 2).
// The strip is drawn only while the selected agent has a call running, so a calm thread stays calm; Stop stops one call. Its
// data is topic `agent.tools` (the spec's 2.8), which no desk serves yet: there, the strip simply never shows.
import { useEffect, useRef, useState } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, RunningCall, ToolChip, ToolsEvent } from '../client/types';
import { LEVEL_ICON } from '../model/approvals';
import { when } from '../model/format';
import { alsoText, callWords, chipOf, elapsed, runningFor, stripOf, toolsRunningText } from '../model/tools';
import { Icon } from './icons';

/** Every call running on the desk, from `agent.tools`, and the desk's clock against this page's. */
export function useRunningTools(client: AgentClient): { calls: RunningCall[]; offset: number } {
  const [state, setState] = useState<{ calls: RunningCall[]; offset: number }>({ calls: [], offset: 0 });
  useEffect(() => {
    setState({ calls: [], offset: 0 });
    return client.watchTools(
      (e: ToolsEvent) =>
        setState((s) => {
          if (e.type === 'snapshot') return { calls: e.calls, offset: e.serverNow - Date.now() };
          if (e.type === 'call') return { ...s, calls: [...s.calls.filter((c) => c.callId !== e.call.callId), e.call] };
          return { ...s, calls: s.calls.filter((c) => c.callId !== e.callId) };
        }),
      () => setState({ calls: [], offset: 0 }),
    );
  }, [client]);
  return state;
}

const WIDE_ROWS = 3;
const NARROW_ROWS = 2;
const OTHER_LINES = 2;
const GONE_MS = 3000;

export function RunningStrip({ client, calls, offset, agent, agents, onOpenAgent, announce, onStopFailed }: {
  client: AgentClient;
  calls: readonly RunningCall[];
  offset: number;
  agent: Pick<Agent, 'id' | 'name'>;
  agents: readonly Pick<Agent, 'id' | 'name'>[];
  onOpenAgent: (agentId: string) => void;
  announce: (text: string) => void;
  onStopFailed: () => void;
}) {
  const view = stripOf(calls, agent.id, agents);
  const ref = useRef<HTMLElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [gone, setGone] = useState(false);
  const count = view.mine.length;
  const hadCalls = useRef(count);

  // The times tick each second while the page shows them; nothing announces them.
  useEffect(() => {
    if (!count) return undefined;
    const t = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, [count]);
  // A phone's column (under 520 px) keeps two rows, then one line.
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, [count > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Show all" open and the last call ends: say so for 3 s, then go.
  useEffect(() => {
    const had = hadCalls.current;
    hadCalls.current = count;
    if (count === 0 && had > 0 && showAll) {
      setGone(true);
      setShowAll(false);
      const t = setTimeout(() => setGone(false), GONE_MS);
      return () => clearTimeout(t);
    }
    if (count > 0) setGone(false);
    return undefined;
  }, [count, showAll]);
  // A call that ended leaves the stopping set with it.
  useEffect(() => {
    setStopping((s) => (s.size && [...s].some((id) => !calls.some((c) => c.callId === id)) ? new Set([...s].filter((id) => calls.some((c) => c.callId === id))) : s));
  }, [calls]);

  if (!count) {
    return gone ? (
      <section className="ag-running" aria-label={`${agent.name}’s tools running now`} data-testid="running">
        <p className="ag-running-gone">Nothing running now.</p>
      </section>
    ) : null;
  }

  const stop = async (c: RunningCall): Promise<void> => {
    const { label } = callWords(c);
    setStopping((s) => new Set(s).add(c.callId));
    try {
      await client.stopTool(c.callId, { idem: newIdem() });
      announce(`Stopped ${label.charAt(0).toLowerCase()}${label.slice(1)}.`);
    } catch (err) {
      // It ended already: the row goes with its end. Anything else: the row comes back, and the banner says so.
      if (err instanceof AgentError && err.code === 'not_found') return;
      setStopping((s) => {
        const next = new Set(s);
        next.delete(c.callId);
        return next;
      });
      onStopFailed();
    }
  };

  const limit = narrow ? NARROW_ROWS : WIDE_ROWS;
  const folded = !showAll && count > limit;
  const oldest = view.mine[0]!;
  const rows = folded ? (narrow ? [] : view.mine.slice(0, WIDE_ROWS)) : view.mine;
  return (
    <section ref={ref} className="ag-running" aria-label={`${agent.name}’s tools running now`} data-testid="running">
      {folded && narrow ? (
        <div className="ag-running-sum" data-testid="running-sum">
          <b>{toolsRunningText(count)}</b>
          <span className="ag-run-time" aria-hidden="true">
            {elapsed(runningFor(oldest, now, offset))}
          </span>
          <button type="button" className="ag-text-btn sm" onClick={() => setShowAll(true)} data-testid="running-show">
            Show
          </button>
        </div>
      ) : (
        <ul className="ag-running-list" style={showAll ? { maxHeight: '50vh', overflow: 'auto' } : undefined}>
          {rows.map((c) => {
            const w = callWords(c);
            const isStopping = stopping.has(c.callId) || c.state === 'stopping';
            return (
              <li key={c.callId} className="ag-run-row" data-level={w.level} data-state={isStopping ? 'stopping' : 'running'} data-testid="running-row">
                <Icon name={LEVEL_ICON[w.level]} />
                <span className="ag-run-text">
                  <span className="ag-run-label">{w.label}</span>
                  {w.target && (
                    <span className="ag-run-target" title={w.target}>
                      {w.target}
                    </span>
                  )}
                  <span className="ag-sr">, started {when(c.startedAt - offset)}</span>
                </span>
                <span className="ag-run-time" aria-hidden="true" data-testid="running-time">
                  {c.stoppable ? elapsed(runningFor(c, now, offset)) : 'Finishing'}
                </span>
                {c.stoppable && (
                  <button
                    type="button"
                    className="ag-btn sm"
                    onClick={() => void stop(c)}
                    disabled={isStopping}
                    aria-label={`Stop ${w.label.charAt(0).toLowerCase()}${w.label.slice(1)}${w.target ? `, ${w.target}` : ''}`}
                    data-testid="running-stop"
                  >
                    {isStopping ? 'Stopping…' : 'Stop'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {folded && !narrow && (
        <div className="ag-running-also">
          <span>{count - WIDE_ROWS} more running</span>
          <button type="button" className="ag-text-btn sm" onClick={() => setShowAll(true)} data-testid="running-show">
            Show all
          </button>
        </div>
      )}
      {view.others.slice(0, OTHER_LINES).map((o) => (
        <div key={o.agentId} className="ag-running-also" data-testid="running-also">
          <span>{alsoText(o.name, o.count)}</span>
          <button type="button" className="ag-text-btn sm" onClick={() => onOpenAgent(o.agentId)}>
            Open {o.name}
          </button>
        </div>
      ))}
      {view.others.length > OTHER_LINES && (
        <div className="ag-running-also">
          <span>
            and {view.others.length - OTHER_LINES} more {view.others.length - OTHER_LINES === 1 ? 'agent' : 'agents'}
          </span>
        </div>
      )}
    </section>
  );
}

/** A reply's calls, once they've run: a chip each (spec 2.5). Declined and unanswered calls have none: their card says so. */
export function ToolChips({ tools }: { tools?: readonly ToolChip[] | null }) {
  const chips = (tools ?? []).map((t) => chipOf(t)).filter((c): c is NonNullable<ReturnType<typeof chipOf>> => c !== null);
  if (!chips.length) return null;
  return (
    <ul className="ag-tools-done" aria-label="Tools used" data-testid="tool-chips">
      {chips.map((c, i) => (
        <li key={i} className="ag-tool-chip" data-result={c.result} data-level={c.level} title={c.why ?? undefined} data-testid="tool-chip">
          <Icon name={LEVEL_ICON[c.level]} size={14} />
          <span className="ag-tool-word">{c.word}</span>
          {c.target && <span className="ag-tool-target">{c.target}</span>}
          {c.time && <span className="ag-tool-time">{c.time}</span>}
          {c.why && <span className="ag-sr">: {c.why}</span>}
        </li>
      ))}
    </ul>
  );
}
