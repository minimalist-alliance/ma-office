// The conversation and its composer (design 9.1). Replies are untrusted text from a model: they render as plain
// text, never HTML, and nothing in them loads (no images, no link previews). Markdown comes later, sanitized.
import { memo, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { AgentClient } from '../client/agentClient';
import type { Agent, Message, SentFile } from '../client/types';
import { errorText } from '../model/agents';
import { formatSize } from '../model/attachments';
import { tokens, usd, when } from '../model/format';
import { refusedSaveText } from '../model/workspace';
import { Avatar, ProviderBadge } from './bits';
import { Icon } from './icons';
import { ProposalCard, type ProposalContext } from './Proposals';
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

const MessageRow = memo(function MessageRow({ m, agentName, showBadge, agents, proposals }: { m: Message; agentName: string; showBadge: boolean; agents: readonly Pick<Agent, 'id' | 'name'>[]; proposals: ProposalContext | null }) {
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
      <div className="ag-bubble">
        {m.text}
        {m.state === 'streaming' && <span className="ag-caret" aria-hidden="true" />}
        {m.state === 'streaming' && !m.text && <span className="ag-sr">{agentName} is replying</span>}
      </div>
      <span className="ag-msg-meta">
        {agentName}
        {showBadge && m.badge && <ProviderBadge badge={m.badge} compact />}
        <span aria-hidden="true">·</span> {when(m.at)}
        {m.state === 'stopped' && <span className="ag-tag">Stopped</span>}
      </span>
      {m.state === 'failed' && <span className="ag-error ag-small">{errorText(m.error, m.errorDetail)}</span>}
      {(m.workspaceRefused ?? []).map((w) => (
        <span key={w.path} className="ag-chip-note" data-testid="msg-save-refused">
          {refusedSaveText(w.path, w.reason)}
        </span>
      ))}
      {m.state !== 'streaming' && m.badge && (
        <span className="ag-msg-foot" title={by} data-testid="msg-foot">
          {m.badge.model}
          {total != null && ` · ${tokens(total)}`}
          {m.costMicroUsd !== undefined && ` · est. ${usd(m.costMicroUsd)}`}
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

export function ThreadView({ agent, agents, messages, loaded, showBadge, deskName, proposals = null }: {
  agent: Agent;
  agents: readonly Pick<Agent, 'id' | 'name'>[];
  messages: Message[];
  loaded: boolean;
  showBadge: boolean;
  deskName: string;
  /** What a lead's proposal cards need. Without it, a reply's proposals don't show (only the lead makes them). */
  proposals?: ProposalContext | null;
}) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const last = messages[messages.length - 1];

  // Before paint, so a new line never shows a frame out of view. One layout read per committed frame at most.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.text.length, agent.id]);
  useLayoutEffect(() => {
    stick.current = true;
  }, [agent.id]);

  return (
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
      }}
    >
      {loaded && messages.length === 0 && (
        <li className="ag-thread-empty">
          <Avatar large />
          <p>
            {agent.name} works on the {deskName} desk only. Ask anything.
          </p>
        </li>
      )}
      {messages.map((m) => (
        <MessageRow key={m.id} m={m} agentName={agent.name} showBadge={showBadge} agents={agents} proposals={proposals} />
      ))}
    </ol>
  );
}

/** What `onSend` tells the composer: whether the desk took the message, and which staged files it no longer has. */
export interface SendResult {
  sent: boolean;
  /** The desk no longer has the staged files (it read and deleted them before refusing, or lost them). */
  lost?: boolean;
}

const hasFiles = (e: DragEvent<HTMLElement>): boolean => Array.from(e.dataTransfer.types).includes('Files');

export function Composer({ client, agent, busy, streamingRunId, onSend, onStop, disabled, suggestions, initialDraft, onDraftChange }: {
  client: AgentClient;
  agent: Agent;
  busy: boolean;
  streamingRunId: string | null;
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
          placeholder={files.length ? 'Ask about your files' : `Ask ${agent.name}`}
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
