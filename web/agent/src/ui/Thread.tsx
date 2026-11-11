// The conversation and its composer (design 9.1). Replies are untrusted text from a model: they render as plain
// text, never HTML, and nothing in them loads (no images, no link previews). Markdown comes later, sanitized.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { AgentClient } from '../client/agentClient';
import type { Agent, Approval, Message, SentFile } from '../client/types';
import { approvalOpen } from '../model/approvals';
import { errorText, isFreeLimit, offersOtherModel } from '../model/agents';
import { formatSize } from '../model/attachments';
import { tokens, usd, when } from '../model/format';
import { refusedSaveText } from '../model/workspace';
import { ApprovalCard, WaitingPill, type ApprovalContext } from './Approvals';
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

const MessageRow = memo(function MessageRow({ m, agentName, showBadge, agents, proposals, approvals = NONE, approvalCtx = null, onPickModel = null }: {
  m: Message;
  agentName: string;
  showBadge: boolean;
  agents: readonly Pick<Agent, 'id' | 'name'>[];
  proposals: ProposalContext | null;
  /** This reply's approvals (API.md section 18), oldest first. */
  approvals?: readonly Approval[];
  approvalCtx?: ApprovalContext | null;
  /** Opens Keys, for "Pick another model" under a free model's busy, slow or privacy-settings failure. */
  onPickModel?: (() => void) | null;
}) {
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
      <ToolChips tools={m.tools} />
      {approvalCtx && approvals.length > 0 && (
        <div className="ag-approvals">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} agentName={agentName} egressCount={m.egressCount ?? 0} ctx={approvalCtx} />
          ))}
        </div>
      )}
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

export function ThreadView({ agent, agents, messages, loaded, showBadge, deskName, proposals = null, approvals = NONE, approvalCtx = null, free = false, onPickModel = null }: {
  agent: Agent;
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
  const byMessage = useMemo(() => {
    const map = new Map<string, Approval[]>();
    for (const a of approvals) map.set(a.messageId, [...(map.get(a.messageId) ?? []), a]);
    return map;
  }, [approvals]);
  const waiting = approvals.filter((a) => approvalOpen(a, Date.now()) && byMessage.has(a.messageId) && messages.some((m) => m.id === a.messageId)).length;
  const [pill, setPill] = useState(false);

  // Before paint, so a new line never shows a frame out of view. One layout read per committed frame at most.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text.length, agent.id, approvals.length]);
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
        <MessageRow key={m.id} m={m} agentName={agent.name} showBadge={showBadge} agents={agents} proposals={proposals} approvals={byMessage.get(m.id) ?? NONE} approvalCtx={approvalCtx} onPickModel={onPickModel} />
      ))}
    </ol>
    {waiting > 0 && pill && <WaitingPill count={waiting} onShow={showCard} />}
    </div>
  );
}

/** What `onSend` tells the composer: whether the desk took the message, and which staged files it no longer has. */
export interface SendResult {
  sent: boolean;
  /** The desk no longer has the staged files (it read and deleted them before refusing, or lost them). */
  lost?: boolean;
}

const hasFiles = (e: DragEvent<HTMLElement>): boolean => Array.from(e.dataTransfer.types).includes('Files');

export function Composer({ client, agent, busy, streamingRunId, waiting = false, onSend, onStop, disabled, suggestions, initialDraft, onDraftChange }: {
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
  onDraftChange: (text: string) => void;
}) {
  const [draft, setDraftState] = useState(initialDraft);
  const staged = useStagedFiles(client, agent.id, agent.binding?.model);
  const { view, files } = staged;
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
