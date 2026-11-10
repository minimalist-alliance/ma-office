// The lead's proposals as confirm cards (multi-agent.md section 3): each shows exactly what will change, every field of its
// payload, with Confirm and Decline. Nothing applies without the member's yes, and the yes carries the card's own `sha256`,
// which the card first checks against the payload it shows. Afterwards the card says what happened.
import { useEffect, useMemo, useState } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, KeyMeta, ModelInfo, Proposal } from '../client/types';
import { AgentMark } from '../look/AgentMark';
import { currentIcon, iconById } from '../look/icons';
import { TONES, currentTone, type LookTheme } from '../look/tones';
import { usd } from '../model/format';
import { describeProposal, diffIsChoppy, diffText, failedText, proposalChecks, proposalOpen, STATE_TEXT, type AgentTag, type ChangeTimer } from '../model/proposals';

export interface ProposalContext {
  client: AgentClient;
  agents: readonly Agent[];
  keys: readonly KeyMeta[];
  /** The member's zone, for a one-shot timer's time. */
  zone: string | null;
  theme: LookTheme;
  /** Opens an agent the card made or changed. */
  onOpenAgent?: (agentId: string) => void;
}

const toneLabel = (id: string): string => TONES.find((t) => t.id === currentTone(id))?.label ?? `${id} (shown as Graphite)`;
const iconLabel = (id: string): string => (id === 'png' ? 'Your picture' : iconById(id).id === currentIcon(id) ? iconById(id).label : `${id} (shown as Spark)`);

/** An agent on a card: its mark, its name, and the end of its id when another agent's name is close. */
function AgentChip({ tag, theme }: { tag: AgentTag; theme: LookTheme }) {
  return (
    <span className="ag-chip" data-testid="proposal-agent">
      {tag.look && <AgentMark icon={tag.look.icon} tone={tag.look.tone} theme={theme} size={20} />}
      <b>{tag.name}</b>
      {tag.hint && (
        <span className="ag-muted ag-small" title={tag.id}>
          {' '}
          ({tag.hint})
        </span>
      )}
    </span>
  );
}

function TimerLine({ t, heading }: { t: ChangeTimer; heading?: string }) {
  return (
    <>
      {heading && <span className="ag-muted ag-small">{heading} </span>}
      <b>{t.label}</b>
      {t.schedule && <> · {t.schedule}</>}
      {t.prompt && (
        <p className="ag-pre ag-small">
          <span className="ag-muted">What it asks: </span>
          {t.prompt}
        </p>
      )}
    </>
  );
}

export function ProposalCard({ proposal, ctx }: { proposal: Proposal; ctx: ProposalContext }) {
  // What the desk answered, until the thread's own event brings the same.
  const [answered, setAnswered] = useState<Proposal | null>(null);
  const p = answered && answered.id === proposal.id && proposal.state === 'pending' ? answered : proposal;
  const [checked, setChecked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // A purpose change has to be opened before Confirm works.
  const [opened, setOpened] = useState(false);
  const [models, setModels] = useState<Record<string, readonly ModelInfo[]>>({});

  useEffect(() => {
    let live = true;
    setChecked(null);
    void proposalChecks(proposal).then((ok) => live && setChecked(ok));
    return () => {
      live = false;
    };
  }, [proposal]);
  // A card left open past its 24 hours says so without a reload.
  useEffect(() => {
    if (p.state !== 'pending') return undefined;
    const wait = Math.min(Math.max(0, p.expiresAt - Date.now()) + 50, 60 * 60_000);
    const t = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(t);
  }, [p.state, p.expiresAt, now]);

  // Model names, not ids: the keys this card names or the agent already uses.
  const keyIds = useMemo(() => {
    const ids = new Set<string>();
    const add = (v: unknown): void => {
      if (typeof v === 'string' && v) ids.add(v);
    };
    add(p.payload['keyId']);
    add(p.before?.['keyId']);
    add(ctx.agents.find((a) => a.id === p.payload['agentId'])?.binding?.keyId);
    return [...ids].filter((id) => ctx.keys.some((k) => k.keyId === id));
  }, [p.payload, p.before, ctx.agents, ctx.keys]);
  useEffect(() => {
    let live = true;
    for (const id of keyIds) {
      ctx.client.listModels(id).then(
        (list) => live && setModels((m) => (m[id] ? m : { ...m, [id]: list })),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [keyIds, ctx.client]);

  const view = describeProposal(p, {
    agents: ctx.agents,
    keyName: (id) => ctx.keys.find((x) => x.keyId === id)?.label ?? null,
    keyLabel: (id) => {
      const k = ctx.keys.find((x) => x.keyId === id);
      return k ? `${k.label} · ${k.providerName}` : null;
    },
    modelLabel: (id) => {
      for (const list of Object.values(models)) {
        const m = list.find((x) => x.id === id);
        if (m) return m.label;
      }
      return null;
    },
    zone: ctx.zone,
    iconLabel,
    toneLabel,
  });
  const open = proposalOpen(p, now);
  const state = p.state === 'pending' && !open ? 'expired' : p.state;
  const pending = state === 'pending';
  const blocked = view.gone || view.nameTaken !== null || (view.purpose !== null && !opened);

  const answer = async (accept: boolean): Promise<void> => {
    setBusy(accept ? 'yes' : 'no');
    setError(null);
    try {
      setAnswered(await ctx.client.answerProposal(p.id, accept, p.sha256, { idem: newIdem() }));
    } catch (err) {
      if (err instanceof AgentError && err.code === 'conflict') setError('This was already answered. The thread shows how.');
      else if (err instanceof AgentError && err.detail === 'sha256') setError('This card no longer matches what the lead proposed, so nothing changed.');
      else setError('The desk couldn’t take your answer just now. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const madeId = p.state === 'applied' ? (p.result?.agentId ?? view.agentId) : null;
  const mark = view.look ?? view.subject?.look ?? null;
  const details = (
    <>
      {view.subject && (
        <p className="ag-small">
          <AgentChip tag={view.subject} theme={ctx.theme} />
        </p>
      )}
      {view.rows.length > 0 && (
        <dl className="ag-proposal-rows">
          {view.rows.map((r, i) => (
            <div key={`${r.label}-${i}`}>
              <dt>{r.label}</dt>
              <dd>
                {r.long && r.value.length > 120 ? (
                  <details>
                    <summary>{r.value.slice(0, 100)}…</summary>
                    <p className="ag-pre">{r.value}</p>
                  </details>
                ) : (
                  <span className="ag-pre">
                    {r.before !== undefined && (
                      <>
                        <span className="ag-muted">{r.before}</span> →{' '}
                      </>
                    )}
                    {r.value}
                  </span>
                )}
                {r.warn && (
                  <p className="ag-warn ag-small" role="note" data-testid="proposal-warn">
                    {r.warn}
                  </p>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {view.purpose && (
        <div className={`ag-proposal-part ${view.purpose.lead ? 'ag-lead-purpose' : ''}`} data-testid="proposal-purpose">
          <h5>Purpose</h5>
          {view.purpose.lead && <p className="ag-warn ag-small">This changes the lead’s own instructions, which shape every card it makes.</p>}
          <details open={!pending || undefined} onToggle={(e) => e.currentTarget.open && setOpened(true)}>
            <summary>{pending && !opened ? 'Read the full change to confirm it' : 'The full change'}</summary>
            {(() => {
              const pc = view.purpose;
              const runs = diffText(pc.before, pc.after);
              return diffIsChoppy(runs, pc.before, pc.after) ? (
                <div data-testid="proposal-diff">
                  <p className="ag-small ag-muted">Now</p>
                  <p className="ag-pre ag-diff"><del>{pc.before || '(the built-in default)'}</del></p>
                  <p className="ag-small ag-muted">After</p>
                  <p className="ag-pre ag-diff"><ins>{pc.after || '(the built-in default)'}</ins></p>
                </div>
              ) : (
                <p className="ag-pre ag-diff" data-testid="proposal-diff">
                  {runs.map((r, i) => (r.op === '=' ? <span key={i}>{r.text}</span> : r.op === '-' ? <del key={i}>{r.text}</del> : <ins key={i}>{r.text}</ins>))}
                </p>
              );
            })()}
          </details>
        </div>
      )}
      {view.links && (
        <div className="ag-proposal-part">
          <h5>May message</h5>
          {view.links.length === 0 ? (
            <p className="ag-muted ag-small">No other agent.</p>
          ) : (
            <ul>
              {view.links.map((l, i) => (
                <li key={`${l.to}-${i}`} data-testid="proposal-link">
                  <AgentChip tag={l.tag} theme={ctx.theme} />
                  <span className="ag-muted ag-small"> under these rules:</span>
                  <p className="ag-pre ag-rules">{l.rules || '(none written)'}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {view.timers.length > 0 && (
        <div className="ag-proposal-part">
          <h5>{view.timers[0]?.removed ? 'Timer to remove' : view.timers.length === 1 ? 'Timer' : 'Timers'}</h5>
          <ul>
            {view.timers.map((t, i) => (
              <li key={`${t.label}-${i}`} data-testid="proposal-timer">
                {t.was && (
                  <p className="ag-small" data-testid="proposal-timer-was">
                    <TimerLine t={t.was} heading="Now:" />
                  </p>
                )}
                <TimerLine t={t} heading={t.was ? 'After:' : undefined} />
                {t.turnsOn && <p className="ag-small ag-warn">This turns it back on.</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );

  return (
    <section className={`ag-proposal${view.stamp ? ' foreign' : ''}`} aria-label={view.title} data-testid="proposal" data-state={state} data-action={p.action}>
      <header className="ag-proposal-head">
        {mark && <AgentMark icon={mark.icon} tone={mark.tone} theme={ctx.theme} size={32} />}
        <div>
          <h4>{view.title}</h4>
          {view.stamp && (
            <p className="ag-proposal-stamp" data-testid="proposal-origin">
              {view.stamp}
            </p>
          )}
        </div>
      </header>
      {pending ? (
        details
      ) : (
        <details className="ag-proposal-was">
          <summary>What it was</summary>
          {details}
        </details>
      )}
      {pending && view.gone && (
        <p className="ag-warn" role="alert" data-testid="proposal-gone">
          Not possible now: that agent was deleted.
        </p>
      )}
      {pending && view.nameTaken !== null && !view.gone && (
        <p className="ag-warn" role="alert" data-testid="proposal-name-taken">
          There’s already an agent called {view.nameTaken}.
        </p>
      )}
      {pending && view.lookTaken && (
        <p className="ag-warn ag-small" role="note" data-testid="proposal-look-taken">
          Another agent here already looks like this.
        </p>
      )}
      {pending && checked === false && (
        <p className="ag-error" role="alert" data-testid="proposal-unchecked">
          This card doesn’t match what the lead proposed, so it can’t be confirmed here. Ask the lead again.
        </p>
      )}
      {pending && view.note && (
        <p className="ag-muted ag-small" data-testid="proposal-note">
          {view.note}
        </p>
      )}
      {pending ? (
        <div className="ag-row-end">
          <button type="button" className="ag-btn sm" onClick={() => void answer(false)} disabled={busy !== null} data-testid="proposal-decline">
            Decline
          </button>
          {!view.gone && (
            <button type="button" className={view.remove ? 'ag-btn danger sm' : 'ag-btn primary sm'} onClick={() => void answer(true)} disabled={busy !== null || checked !== true || blocked} data-testid="proposal-confirm">
              {busy === 'yes' ? 'Confirming…' : (view.remove?.button ?? 'Confirm')}
            </button>
          )}
        </div>
      ) : (
        <p className={`ag-proposal-state ${state}`} role="status" data-testid="proposal-state">
          <b>{STATE_TEXT[state]}</b>
          {(state === 'failed' || state === 'applied_partly' || (state === 'expired' && p.detail === 'stopped')) && <span>{failedText(p.detail)}</span>}
          {madeId && ctx.onOpenAgent && ctx.agents.some((a) => a.id === madeId) && (
            <button type="button" className="ag-text-btn sm" onClick={() => ctx.onOpenAgent?.(madeId)}>
              Open {ctx.agents.find((a) => a.id === madeId)?.name}
            </button>
          )}
        </p>
      )}
      {error && (
        <p className="ag-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Spend on a timer or a message, in the same words as the thread's. */
export const spentText = (micro: number | null | undefined): string => (micro ? `${usd(micro)} spent` : 'Nothing spent yet');
