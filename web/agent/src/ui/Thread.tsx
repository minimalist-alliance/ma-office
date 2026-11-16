// The conversation and its composer (design 9.1). Replies are untrusted text from a model: they render as plain
// text, never HTML, and nothing in them loads (no images, no link previews). Markdown comes later, sanitized.
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { AgentClient } from '../client/agentClient';
import type { Agent, Approval, DeskOrigin, Message, PlanStep, SentFile } from '../client/types';
import type { OtherDesk } from '../model/access';
import { approvalOpen, shown } from '../model/approvals';
import { ANSWER_PRIVATE, ANSWER_UNTRUSTED, deskLine } from '../model/deskMessages';
import { errorText, isFreeLimit, offersOtherModel } from '../model/agents';
import { formatSize } from '../model/attachments';
import { tokens, usd, when } from '../model/format';
import { refusedSaveText } from '../model/workspace';
import { TAINT_NOTICE, planStepLabel, resumedNote, runSummaryOf, runSummaryParts } from '../model/runSummary';
import { ApprovalCard, WaitingPill, type ApprovalContext } from './Approvals';
import { AutoLine, AutoUndoContext, useAutoUndo } from './Auto';
import { isAuto } from '../model/auto';
import { Avatar, ProviderBadge } from './bits';
import { Icon } from './icons';
import { ProposalCard, type ProposalContext } from './Proposals';
import { ToolChips } from './Running';
import { useStagedFiles } from './useStagedFiles';

/** Under this many pixels from the bottom counts as reading the newest message, so new text keeps it in view. */
const STICK_PX = 48;

/**
 * A message the member didn't write: from another agent, marked with who and the rules of that pairing, which travel with
 * every message (multi-agent.md section 4), or from a timer, with its name.
 */
function FromRow({ m, from }: { m: Message; from: string }) {
  const o = m.origin!;
  const rules = o.kind === 'agent' ? (o.rules ?? '') : '';
  return (
    <li className="ag-msg from" data-testid="msg-from" data-origin={o.kind}>
      <span className="ag-msg-meta">
        <Icon name={o.kind === 'timer' ? 'clock' : 'messages'} size={13} />
        <span>{from}</span>
        <span aria-hidden="true">·</span> {when(m.at)}
      </span>
      <div className="ag-bubble">{m.text}</div>
      {o.kind === 'agent' && (
        <details className="ag-msg-rules" data-testid="msg-rules">
          <summary>Rules for this pairing</summary>
          <p className="ag-pre">{rules || 'No rules came with it.'}</p>
        </details>
      )}
    </li>
  );
}

const NO_DESKS: readonly OtherDesk[] = [];

/**
 * A message from another of the member's desks (W6; deskd API.md section 18, "In the threads"): X's message in Y's thread, Y's
 * answer in X's thread, marked untrusted, or a notice about one that got no answer. Who and which desk come from `deskLine`: the
 * desk by the member's own name for it, the agent as plain text. The text is the other desk's: text only, as every reply is.
 */
function DeskRow({ m, origin, desks }: { m: Message; origin: DeskOrigin; desks: readonly OtherDesk[] }) {
  const line = deskLine(origin, desks);
  if (origin.role === 'notice') {
    return (
      <li className="ag-msg ag-msg-notice" data-testid="msg-desk-notice" data-notice={origin.notice ?? 'refused'}>
        <p className="ag-desk-notice">
          <Icon name="messages" size={13} />
          <span>{line}</span>
        </p>
        <span className="ag-msg-meta">{when(m.at)}</span>
      </li>
    );
  }
  const answer = origin.role === 'answer';
  return (
    <li className="ag-msg from ag-msg-desk" data-testid="msg-desk" data-role={origin.role}>
      <span className="ag-msg-meta">
        <Icon name="messages" size={13} />
        <span>{line}</span>
        <span aria-hidden="true">·</span> {when(m.at)}
      </span>
      <div className="ag-bubble">{m.text}</div>
      {answer && (
        <p className="ag-taint-note" data-testid="msg-desk-untrusted">
          <Icon name="eye" size={14} />
          <span>
            {ANSWER_UNTRUSTED}
            {origin.private ? ` ${ANSWER_PRIVATE}` : ''}
          </span>
        </p>
      )}
    </li>
  );
}

/** Files a message carried: a name, a size and the desk's note, as text. The content is gone. */
function SentChips({ files }: { files?: SentFile[] | null }) {
  if (!files?.length) return null;
  return (
    <ul className="ag-files ag-files-sent" aria-label="Attached files" data-testid="sent-files">
      {files.map((f, i) => (
        <li key={`${i}-${f.name}`} className="ag-file" data-testid="sent-file">
          <Icon name="file" size={13} />
          <span className="ag-file-name">{f.name}</span>
          <span className="ag-file-size">{formatSize(f.size)}</span>
          {f.note && <span className="ag-file-note">{f.note}</span>}
        </li>
      ))}
    </ul>
  );
}

const NONE: readonly Approval[] = [];

/** A step's mark, drawn as text so a state never reads in colour alone; its word is for screen readers. */
const PLAN_MARK: Record<PlanStep['state'], string> = { done: '✓', doing: '›', todo: '○', skipped: '–' };

/** The agent's checklist for a run (`plan_update`): its own words, as text only. Live while the reply streams. */
function PlanList({ plan }: { plan: readonly PlanStep[] }) {
  return (
    <ol className="ag-plan" aria-label="Plan" data-testid="msg-plan">
      {plan.map((step, i) => (
        <li key={i} className="ag-plan-step" data-state={step.state}>
          <span className="ag-plan-mark" aria-hidden="true">
            {PLAN_MARK[step.state]}
          </span>
          {/* The agent's words: hidden and bidi characters show as their code points, as on a card. */}
          <span className="ag-plan-text">{shown(step.text)}</span>
          <span className="ag-sr">, {planStepLabel(step)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Under a reply whose run has ended: the taint notice when it read untrusted content (draft ADR section 6), then one line of what
 * the run did, all from the desk's own fields: its chips, cards and egress count.
 */
function RunDetails({ m, approvals }: { m: Message; approvals: readonly Approval[] }) {
  const summary = runSummaryOf(m, approvals);
  const parts = summary ? runSummaryParts(summary) : [];
  const ended = m.state === 'done' || m.state === 'stopped' || m.state === 'failed' || m.state === undefined;
  return (
    <>
      {ended && m.untrusted && (
        <p className="ag-taint-note" data-testid="msg-untrusted">
          <Icon name="eye" size={14} />
          <span>{TAINT_NOTICE}</span>
        </p>
      )}
      {parts.length > 0 && (
        <p className="ag-run-summary" data-testid="run-summary">
          <span className="ag-sr">This task: </span>
          {/* Each part stays on one line with its dot, so a count never wraps away from its word ("1 / declined"). */}
          {parts.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && ' '}
              <span className="ag-run-part">{i < parts.length - 1 ? `${part} ·` : part}</span>
            </Fragment>
          ))}
        </p>
      )}
    </>
  );
}

const MessageRow = memo(function MessageRow({ m, agentName, showBadge, agents, proposals, approvals = NONE, approvalCtx = null, onPickModel = null, desks = NO_DESKS }: {
  m: Message;
  agentName: string;
  showBadge: boolean;
  agents: readonly Pick<Agent, 'id' | 'name'>[];
  /** The member's own desk list, which names the other desk of a message between desks (W6). */
  desks?: readonly OtherDesk[];
  proposals: ProposalContext | null;
  /** This reply's cards (API.md section 18), oldest first: never a row done without asking. */
  approvals?: readonly Approval[];
  approvalCtx?: ApprovalContext | null;
  /** Opens Keys, for "Pick another model" under a free model's busy, slow or privacy-settings failure. */
  onPickModel?: (() => void) | null;
}) {
  if (m.origin?.kind === 'desk') return <DeskRow m={m} origin={m.origin} desks={desks} />;
  if (m.role === 'user' && m.origin) {
    const from = m.origin.kind === 'timer' ? `Timer: ${m.origin.label || 'unnamed'}` : `From ${agents.find((a) => a.id === (m.origin as { agentId: string }).agentId)?.name ?? 'an agent no longer here'}`;
    return <FromRow m={m} from={from} />;
  }
  if (m.role === 'user') {
    return (
      <li className="ag-msg me" data-testid="msg-user">
        {m.text && <div className="ag-bubble">{m.text}</div>}
        <SentChips files={m.attachments} />
        <span className="ag-msg-meta">You · {when(m.at)}</span>
      </li>
    );
  }
  const total = m.usage ? m.usage.inputTokens + m.usage.cachedInputTokens + m.usage.cacheWriteTokens + m.usage.outputTokens : null;
  const by = m.badge ? `Answered by ${m.badge.providerName} · ${m.badge.model}` : undefined;
  return (
    <li className={`ag-msg agent${m.state === 'streaming' ? ' streaming' : ''}`} data-testid="msg-agent" data-state={m.state ?? 'done'} aria-busy={m.state === 'streaming' || undefined}>
      {(m.text || m.state === 'streaming') && (
        <div className="ag-bubble">
          {m.text}
          {m.state === 'streaming' && <span className="ag-caret" aria-hidden="true" />}
          {m.state === 'streaming' && !m.text && <span className="ag-sr">{agentName} is replying</span>}
        </div>
      )}
      <span className="ag-msg-meta">
        {agentName}
        {showBadge && m.badge && <ProviderBadge badge={m.badge} compact />}
        <span aria-hidden="true">·</span> {when(m.at)}
        {m.state === 'stopped' && <span className="ag-tag">Stopped</span>}
      </span>
      {resumedNote(m) && <p className="ag-run-summary" data-testid="msg-resumed">{resumedNote(m)}</p>}
      {m.state === 'failed' &&
        // Today's free requests used is a limit, not a failure: not red (agent-free-key spec §4).
        (isFreeLimit(m) ? (
          <span className="ag-msg-limit" data-testid="msg-free-limit">
            {errorText(m.error, m.errorDetail, 'openrouter')}
          </span>
        ) : (
          <span className="ag-error ag-small">{errorText(m.error, m.errorDetail, m.badge?.provider)}</span>
        ))}
      {m.state === 'failed' && onPickModel && offersOtherModel(m.errorDetail, m.badge?.provider) && (
        <button type="button" className="ag-text-btn sm" onClick={onPickModel} data-testid="pick-model">
          Pick another model
        </button>
      )}
      {(m.workspaceRefused ?? []).map((w) => (
        <span key={w.path} className="ag-chip-note" data-testid="msg-save-refused">
          {refusedSaveText(w.path, w.reason)}
        </span>
      ))}
      {m.plan && m.plan.length > 0 && <PlanList plan={m.plan} />}
      <ToolChips m={m} />
      {approvalCtx && approvals.length > 0 && (
        <div className="ag-approvals">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} agentName={agentName} egressCount={m.egressCount ?? 0} ctx={approvalCtx} />
          ))}
        </div>
      )}
      <RunDetails m={m} approvals={approvals} />
      <AutoLine m={m} />
      {m.state !== 'streaming' && m.state !== 'awaiting_approval' && m.badge && (
        <span className="ag-msg-foot" title={by} data-testid="msg-foot">
          {m.badge.model}
          {total != null && ` · ${tokens(total)}`}
          {/* A free model's reply costs nothing: "free", never "$0" (spec §3.1). */}
          {m.costMicroUsd === 0 && m.badge.provider === 'openrouter' ? ' · free' : m.costMicroUsd !== undefined && ` · est. ${usd(m.costMicroUsd)}`}
        </span>
      )}
      {m.state !== 'streaming' && proposals && (m.proposals ?? []).length > 0 && (
        <div className="ag-proposals">
          {(m.proposals ?? []).map((p) => (
            <ProposalCard key={p.id} proposal={p} ctx={proposals} />
          ))}
        </div>
      )}
    </li>
  );
});

export function ThreadView({ agent, agents, messages, loaded, showBadge, deskName, proposals = null, approvals = NONE, approvalCtx = null, free = false, onPickModel = null, desks = NO_DESKS }: {
  agent: Agent;
  /** The member's own desk list, for messages from their other desks (W6). */
  desks?: readonly OtherDesk[];
  agents: readonly Pick<Agent, 'id' | 'name'>[];
  messages: Message[];
  loaded: boolean;
  showBadge: boolean;
  deskName: string;
  /** On free models through OpenRouter: the empty thread says what that means, once (spec §3.1). */
  free?: boolean;
  onPickModel?: (() => void) | null;
  /** What a lead's proposal cards need. Without it, a reply's proposals don't show (only the lead makes them). */
  proposals?: ProposalContext | null;
  /** The thread's approvals, each under the reply its `messageId` names. */
  approvals?: readonly Approval[];
  approvalCtx?: ApprovalContext | null;
}) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const last = messages[messages.length - 1];
  // A call done without asking is never a card, pending or not (API.md section 18): it's a chip with its Undo, and the line.
  const cards = useMemo(() => approvals.filter((a) => !isAuto(a)), [approvals]);
  const byMessage = useMemo(() => {
    const map = new Map<string, Approval[]>();
    for (const a of cards) map.set(a.messageId, [...(map.get(a.messageId) ?? []), a]);
    return map;
  }, [cards]);
  const waiting = cards.filter((a) => approvalOpen(a, Date.now()) && byMessage.has(a.messageId) && messages.some((m) => m.id === a.messageId)).length;
  const autoUndo = useAutoUndo(approvalCtx, approvals, approvalCtx?.tabs);
  const [pill, setPill] = useState(false);

  // Before paint, so a new line never shows a frame out of view. One layout read per committed frame at most.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text.length, last?.tools?.length, last?.auto?.length, agent.id, approvals.length]);
  useLayoutEffect(() => {
    stick.current = true;
  }, [agent.id]);

  // "1 request waiting · Show" while the oldest waiting card is out of view (spec 1.5).
  const oldestCard = useCallback((): HTMLElement | null => ref.current?.querySelector<HTMLElement>('[data-approval-pending]') ?? null, []);
  const measure = useCallback((): void => {
    const box = ref.current;
    const card = oldestCard();
    if (!box || !card) {
      setPill(false);
      return;
    }
    const b = box.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    setPill(c.bottom <= b.top + 24 || c.top >= b.bottom - 24);
  }, [oldestCard]);
  useEffect(() => {
    measure();
  }, [measure, waiting, messages.length]);
  const showCard = (): void => {
    const card = oldestCard();
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.querySelector<HTMLElement>('h4')?.focus({ preventScroll: true });
    setPill(false);
  };

  return (
    <AutoUndoContext.Provider value={autoUndo}>
    <div className="ag-thread-wrap">
    <ol
      ref={ref}
      className="ag-thread"
      aria-label={`Conversation with ${agent.name}`}
      // A long thread scrolls, so the keyboard has to be able to reach it (axe: scrollable-region-focusable).
      tabIndex={0}
      data-testid="thread"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        if (waiting) measure();
      }}
    >
      {loaded && messages.length === 0 && (
        <li className="ag-thread-empty">
          <Avatar large />
          <p>
            {agent.name} works on the {deskName} desk only. Ask anything.
          </p>
          {free && (
            <p className="ag-note" data-testid="free-note">
              On free models through OpenRouter: slower than paid ones, with a limited number of requests a day. The companies running them may keep what you send.
            </p>
          )}
        </li>
      )}
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} agentName={agent.name} showBadge={showBadge} agents={agents} proposals={proposals} approvals={byMessage.get(m.id) ?? NONE} approvalCtx={approvalCtx} onPickModel={onPickModel} desks={desks} />
      ))}
    </ol>
    {waiting > 0 && pill && <WaitingPill count={waiting} onShow={showCard} />}
    </div>
    </AutoUndoContext.Provider>
  );
}

/** What `onSend` tells the composer: whether the desk took the message, and which staged files it no longer has. */
export interface SendResult {
  sent: boolean;
  /** The desk no longer has the staged files (it read and deleted them before refusing, or lost them). */
  lost?: boolean;
}

const hasFiles = (e: DragEvent<HTMLElement>): boolean => Array.from(e.dataTransfer.types).includes('Files');

export function Composer({ client, agent, busy, streamingRunId, waiting = false, onSend, onStop, disabled, suggestions, initialDraft, initialFiles, onDraftChange }: {
  client: AgentClient;
  agent: Agent;
  busy: boolean;
  streamingRunId: string | null;
  /** The run waits on the member's answer to a card: nothing goes until it's answered (spec 1.5). */
  waiting?: boolean;
  onSend: (text: string, attachments: string[]) => Promise<SendResult>;
  onStop: () => void;
  /** Nothing can go now. The box still takes what's typed, so a dropped connection doesn't stop a thought. */
  disabled: boolean;
  suggestions: readonly string[];
  /** Unsent text survives switching agents, in memory only. */
  initialDraft: string;
  /** Files handed over with a question from the host (Documents' "Ask Lead about this"), staged as if the member added them. */
  initialFiles?: readonly File[] | undefined;
  onDraftChange: (text: string) => void;
}) {
  const [draft, setDraftState] = useState(initialDraft);
  const staged = useStagedFiles(client, agent.id, agent.binding?.model);
  const { view, files } = staged;
  // Handed-over files go up once the desk has said what it takes; a desk that takes no files leaves them out.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !view || !initialFiles?.length) return;
    seeded.current = true;
    staged.add(initialFiles);
  }, [view, initialFiles, staged]);
  const pick = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const uploading = files.some((f) => f.state === 'uploading');
  const ready = files.filter((f) => f.state === 'ready');
  const setDraft = (next: string | ((d: string) => string)): void => {
    setDraftState((d) => {
      const v = typeof next === 'function' ? next(d) : next;
      onDraftChange(v);
      return v;
    });
  };
  const send = async (text: string): Promise<void> => {
    const t = text.trim();
    if ((!t && !ready.length) || uploading || busy || disabled || streamingRunId) return;
    // The text and the files stay until the desk has them, so a refusal (a busy desk, say) loses nothing.
    const r = await onSend(t, ready.map((f) => f.uploadId));
    if (r.sent) {
      setDraft((d) => (d.trim() === t ? '' : d));
      staged.taken();
    } else if (r.lost) {
      staged.lost();
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };
  const take = (list: File[]): void => {
    if (disabled) return;
    staged.add(list);
  };
  const dropProps = view
    ? {
        onDragEnter: (e: DragEvent<HTMLElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        },
        onDragOver: (e: DragEvent<HTMLElement>) => {
          if (hasFiles(e)) e.preventDefault();
        },
        onDragLeave: (e: DragEvent<HTMLElement>) => {
          if (!hasFiles(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setOver(false);
        },
        onDrop: (e: DragEvent<HTMLElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          take(Array.from(e.dataTransfer.files));
        },
      }
    : {};
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!view) return;
    const got = Array.from(e.clipboardData.files);
    // Words that came with the files win: pasting from a document is still pasting words.
    if (!got.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    take(got);
  };
  const canSend = (!!draft.trim() || ready.length > 0) && !uploading;
  return (
    <>
      {suggestions.length > 0 && (
        <div className="ag-quick" aria-label="Suggestions">
          {suggestions.map((q) => (
            <button key={q} type="button" className="ag-chip" onClick={() => void send(q)} disabled={disabled || busy || !!streamingRunId}>
              {q}
            </button>
          ))}
        </div>
      )}
      <form
        className={`ag-composer${over ? ' over' : ''}`}
        data-testid="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
        {...dropProps}
      >
        {view && (
          <div className="ag-attach-row">
            {files.length > 0 && (
              <ul className="ag-files" aria-label="Files to send" data-testid="staged-files">
                {files.map((f) => (
                  <li key={f.id} className="ag-file" data-state={f.state} data-testid="staged-file">
                    <Icon name="file" size={13} />
                    <span className="ag-file-name">{f.name}</span>
                    <span className="ag-file-size">{f.state === 'uploading' ? `${Math.round(f.progress * 100)}%` : formatSize(f.size)}</span>
                    <button type="button" className="ag-file-x" aria-label={`Remove ${f.name}`} title={`Remove ${f.name}`} onClick={() => staged.remove(f.id)} data-testid="staged-remove">
                      <Icon name="close" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="ag-small ag-muted ag-attach-line" role="status" data-testid="attach-line">
              {over ? 'Drop to attach.' : (staged.line ?? (uploading ? 'Attaching…' : ''))}
            </p>
          </div>
        )}
        {view && (
          <>
            <input
              ref={pick}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              data-testid="attach-input"
              onChange={(e) => {
                take(Array.from(e.currentTarget.files ?? []));
                e.currentTarget.value = '';
              }}
            />
            <button type="button" className="ag-icon-btn ag-attach" aria-label="Attach files" title="Attach files" onClick={() => pick.current?.click()} disabled={disabled} data-testid="attach-button">
              <Icon name="attach" />
            </button>
          </>
        )}
        <label htmlFor={`ag-input-${agent.id}`} className="ag-sr">
          Message {agent.name}
        </label>
        <textarea
          id={`ag-input-${agent.id}`}
          rows={1}
          placeholder={waiting ? 'Waiting for your answer' : files.length ? 'Ask about your files' : `Ask ${agent.name}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          data-testid="composer-input"
        />
        {streamingRunId ? (
          <button type="button" className="ag-btn" onClick={onStop} disabled={disabled} data-testid="composer-stop">
            <Icon name="stop" /> Stop
          </button>
        ) : (
          <button type="submit" className="ag-btn primary" disabled={disabled || busy || !canSend} data-testid="composer-send">
            <Icon name="send" /> Send
          </button>
        )}
      </form>
    </>
  );
}
