// The approval card (the Product Designer's spec, section 1; deskd API.md section 18): what the agent wants to do, with which
// tool, on what, at which level, and Approve and Decline. Nothing approves itself: there's no form, no default button and no
// shortcut, focus never moves onto a card that arrives, and Approve ignores a press for 500 ms after the card renders, its
// payload changes or the window comes back into focus. Approve is offered only when the payload the card shows hashes to the
// card's `sha256`, and the yes carries that hash. Afterwards the card says what happened, in one line.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AgentError, newIdem, type AgentClient } from '../client/agentClient';
import type { Agent, Approval } from '../client/types';
import { approvalChecks, answerByText, ARM_MS, cardOf, decideErrorText, egressText, futureWhen, mismatchText, stateOf, type CardView } from '../model/approvals';
import { when } from '../model/format';
import { Icon } from './icons';

const NOTE_MAX = 500;
const RANK: Record<Approval['state'], number> = { pending: 0, approved: 1, done: 2, failed: 2, declined: 2, expired: 2, interrupted: 2 };

export interface ApprovalContext {
  client: AgentClient;
  agents: readonly Agent[];
  /** The desk can't be reached: buttons wait, and the card says until when it waits. */
  offline: boolean;
  /** The polite status line. */
  announce: (text: string) => void;
}

function Rows({ view }: { view: CardView }) {
  return (
    <>
      <dl className="ag-approval-rows" data-testid="approval-rows">
        {view.fields.map((f, i) => (
          <div key={`${f.label}-${i}`}>
            <dt>{f.label}</dt>
            <dd className={f.mono ? 'ag-val-mono' : undefined}>
              {f.long && f.value.length > 120 ? (
                <details>
                  <summary>{f.value.slice(0, 100)}…</summary>
                  <p className="ag-pre">{f.value}</p>
                </details>
              ) : (
                <span className="ag-pre">{f.mono ? breakable(f.value) : f.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {view.leaves && (
        <div className="ag-leaves" data-testid="approval-leaves">
          <h5>What this address tells {view.leaves.host}</h5>
          <dl className="ag-val-mono">
            {view.leaves.parts.map((p, i) => (
              <div key={`${p.name}-${i}`}>
                <dt>{p.name}</dt>
                <dd>{p.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

/** An address or a path may break after `/`, `?`, `&` and `=` (spec 1.2), and nowhere it would mislead. */
function breakable(value: string) {
  const parts = value.split(/(?<=[/?&=])/);
  return parts.map((p, i) => (
    <span key={i}>
      {p}
      {i < parts.length - 1 && <wbr />}
    </span>
  ));
}

export function ApprovalCard({ approval, agentName, egressCount = 0, ctx }: { approval: Approval; agentName: string; egressCount?: number; ctx: ApprovalContext }) {
  const ids = useId();
  // What the desk answered, or a fetch brought, until the thread's own event says the same or more.
  const [local, setLocal] = useState<Approval | null>(null);
  const a = local && local.id === approval.id && RANK[local.state] >= RANK[approval.state] && (local.payload || !approval.payload) ? local : approval;
  const view = useMemo(() => cardOf(a, ctx.agents), [a, ctx.agents]);
  const [checked, setChecked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const armedAt = useRef(Date.now());
  const answerKey = useRef<{ key: string; idem: string } | null>(null);
  const stateRef = useRef<HTMLParagraphElement>(null);
  const focusState = useRef(false);
  const whyRef = useRef<HTMLTextAreaElement>(null);

  // The payload the card shows is the one its hash names, or there's no Approve. A payload over 32 KiB comes by itself.
  useEffect(() => {
    let live = true;
    setChecked(null);
    void approvalChecks(a).then((ok) => live && setChecked(ok));
    return () => {
      live = false;
    };
  }, [a]);
  useEffect(() => {
    if (!view.needsPayload || a.state !== 'pending') return undefined;
    let live = true;
    ctx.client.getApproval(a.id).then(
      (full) => live && setLocal(full),
      () => undefined, // the card stays without Approve, and Decline still works
    );
    return () => {
      live = false;
    };
  }, [ctx.client, a.id, a.state, view.needsPayload]);
  // Arm again whenever what Approve would approve changes, and when the window comes back: a click meant for something else
  // that was there a moment ago does nothing.
  useEffect(() => {
    armedAt.current = Date.now();
  }, [a.sha256, a.payload]);
  useEffect(() => {
    const rearm = (): void => {
      armedAt.current = Date.now();
    };
    window.addEventListener('focus', rearm);
    return () => window.removeEventListener('focus', rearm);
  }, []);
  // The foot's time, and a card left open past its time says so by itself.
  useEffect(() => {
    if (a.state !== 'pending') return undefined;
    const left = a.expiresAt - Date.now();
    const t = setTimeout(() => setNow(Date.now()), Math.max(1000, Math.min(left + 50, 60_000)));
    return () => clearTimeout(t);
  }, [a.state, a.expiresAt, now]);
  useEffect(() => {
    if (why !== null) whyRef.current?.focus();
  }, [why !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = stateOf(a, view, agentName, now, when);
  useEffect(() => {
    if (state && focusState.current) {
      focusState.current = false;
      stateRef.current?.focus();
    }
  }, [state]);

  const decide = async (approve: boolean, note?: string): Promise<void> => {
    if (approve && Date.now() - armedAt.current < ARM_MS) return;
    if (approve && checked !== true) return;
    // The same answer again (after a lost reply) keeps its key, so the desk gives the first answer back.
    const key = `${approve}\u0000${note ?? ''}`;
    const idem = answerKey.current?.key === key ? answerKey.current.idem : newIdem();
    answerKey.current = { key, idem };
    setBusy(approve ? 'yes' : 'no');
    setError(null);
    try {
      const next = await ctx.client.decideApproval(a.id, { approve, sha256: a.sha256, ...(note ? { note } : {}) }, { idem });
      answerKey.current = null;
      focusState.current = true;
      setLocal(next);
      setWhy(null);
      ctx.announce(approve ? 'Approved.' : 'Declined.');
    } catch (err) {
      const e = err instanceof AgentError ? err : null;
      if (e?.code === 'bad_request' && e.detail === 'sha256') {
        // Section 18: fetch it and show it again. A card that still doesn't match keeps no Approve.
        answerKey.current = null;
        ctx.client.getApproval(a.id).then((full) => setLocal(full), () => undefined);
        setError(mismatchText(agentName));
      } else {
        if (e && !e.mayHaveApplied && e.code !== 'unavailable' && e.code !== 'deadline_exceeded') answerKey.current = null;
        setError(decideErrorText(e, agentName));
      }
    } finally {
      setBusy(null);
    }
  };

  if (state) {
    const icon = state.kind === 'approved' ? 'check' : state.kind === 'declined' ? 'minus' : state.kind === 'expired' ? 'clock' : null;
    return (
      <section className="ag-approval" role="group" aria-labelledby={`${ids}-state`} data-state={a.state} data-level={view.level} data-testid="approval">
        <p className="ag-approval-state" id={`${ids}-state`} ref={stateRef} tabIndex={-1} data-result={state.result ?? undefined} data-testid="approval-state">
          {icon && <Icon name={icon} size={14} className={state.kind === 'approved' ? 'ok' : undefined} />}
          <b>{state.head}</b>
          {state.meta.map((m, i) => (
            <span key={i} className={i === state.meta.length - 1 && state.result === 'failed' ? 'ag-approval-failed' : undefined}>
              <span aria-hidden="true">· </span>
              {i === state.meta.length - 1 && state.result === 'failed' ? <b>{m}</b> : m}
            </span>
          ))}
        </p>
        {state.sub && (
          <p className="ag-approval-sub" data-testid="approval-sub">
            {state.sub}
          </p>
        )}
        {state.note && (
          <p className="ag-approval-sub" data-testid="approval-note">
            {state.note}
          </p>
        )}
        <details className="ag-approval-was">
          <summary>What it was</summary>
          <p className="ag-approval-sub">
            <b>{view.title}</b>
          </p>
          <Rows view={view} />
        </details>
      </section>
    );
  }

  const blocked = busy !== null || ctx.offline;
  const answerBy = answerByText(a.expiresAt, now, view.level);
  const onWhyKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      // The note's Esc is Cancel, and the window stays open.
      e.preventDefault();
      e.stopPropagation();
      setWhy(null);
    }
  };
  return (
    <section className="ag-approval" role="group" aria-labelledby={`${ids}-title`} data-state="pending" data-level={view.level} data-testid="approval" data-approval-pending="">
      <div className="ag-approval-top">
        <span className="ag-level" data-level={view.level} data-testid="approval-level">
          <Icon name={view.level === 'send' ? 'out' : view.level === 'spend' ? 'coin' : view.level === 'read' ? 'eye' : 'pencil'} size={14} />
          {view.chip}
        </span>
        <span className="ag-approval-when">Waiting since {when(a.createdAt, now)}</span>
      </div>
      <div className="ag-approval-title">
        <h4 id={`${ids}-title`} tabIndex={-1} data-testid="approval-title">
          {view.title}
        </h4>
        {view.stamp && (
          <p className="ag-approval-origin" data-testid="approval-origin">
            {view.stamp}
          </p>
        )}
      </div>
      {why === null ? (
        <>
          <Rows view={view} />
          {view.reason && (
            <p className="ag-approval-says" data-testid="approval-says">
              <b>{agentName} says:</b> {view.reason}
            </p>
          )}
          {view.note && (
            <p className="ag-approval-note" data-testid="approval-why">
              <Icon name={view.note.icon} size={14} />
              <span>{view.note.text}</span>
            </p>
          )}
          {view.untrustedLine && (
            <p className="ag-approval-note" data-testid="approval-untrusted">
              <Icon name="eye" size={14} />
              <span>{view.untrustedLine}</span>
            </p>
          )}
          {view.level === 'send' && egressCount > 0 && (
            <p className="ag-approval-note" data-testid="approval-egress">
              <Icon name="out" size={14} />
              <span>{egressText(egressCount)}</span>
            </p>
          )}
        </>
      ) : (
        <div className="ag-why-field" data-testid="approval-why-field">
          <label htmlFor={`${ids}-why`} className="ag-small">
            Tell {agentName} why (it reads this with your no)
          </label>
          <textarea
            id={`${ids}-why`}
            ref={whyRef}
            className="ag-textarea"
            rows={2}
            maxLength={NOTE_MAX}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={onWhyKey}
            aria-describedby={`${ids}-count`}
            data-testid="approval-why-input"
          />
          <div className="ag-row-between">
            <small id={`${ids}-count`}>
              {why.length} of {NOTE_MAX}
            </small>
          </div>
        </div>
      )}
      {ctx.offline && (
        <p className="ag-muted ag-small" data-testid="approval-offline">
          Your desk can’t be reached right now. This waits for you until {futureWhen(a.expiresAt, now)}.
        </p>
      )}
      {checked === false && !view.needsPayload && (
        <p className="ag-error" role="alert" data-testid="approval-mismatch">
          {mismatchText(agentName)}
        </p>
      )}
      {error && !(checked === false && error === mismatchText(agentName)) && (
        <p className="ag-error" role="alert" data-testid="approval-error">
          {error}
        </p>
      )}
      <div className="ag-approval-actions">
        {why === null ? (
          <>
            <button type="button" className="ag-text-btn ag-why" onClick={() => setWhy('')} disabled={blocked} data-testid="approval-why-open">
              Decline and say why
            </button>
            <button type="button" className="ag-btn sm" onClick={() => void decide(false)} disabled={blocked} data-testid="approval-decline">
              {busy === 'no' ? 'Declining…' : 'Decline'}
            </button>
            {checked === true && (
              <button type="button" className="ag-btn primary sm" onClick={() => void decide(true)} disabled={blocked} data-testid="approval-approve">
                {busy === 'yes' ? 'Approving…' : view.level === 'spend' && view.cost ? `Approve ${view.cost}` : 'Approve'}
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="ag-text-btn" onClick={() => setWhy(null)} disabled={busy !== null} data-testid="approval-why-cancel">
              Cancel
            </button>
            <button type="button" className="ag-btn sm" onClick={() => void decide(false, why.trim() || undefined)} disabled={blocked} data-testid="approval-why-send">
              {busy === 'no' ? 'Declining…' : 'Decline with this note'}
            </button>
          </>
        )}
      </div>
      <p className="ag-approval-foot" data-testid="approval-foot">
        {answerBy}
      </p>
    </section>
  );
}

/**
 * "1 request waiting · Show", at the foot of the thread while the oldest waiting card is out of view (spec 1.5). A real button:
 * it scrolls that card into view and focuses its title.
 */
export function WaitingPill({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <button type="button" className="ag-waiting-pill" onClick={onShow} data-testid="waiting-pill">
      <i className="ag-dot warn" aria-hidden="true" />
      {count} {count === 1 ? 'request' : 'requests'} waiting <span aria-hidden="true">·</span> <span className="ag-link-word">Show</span>
    </button>
  );
}
