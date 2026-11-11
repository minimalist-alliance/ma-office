// A channel's chat thread, beside the board: like a Slack or Discord channel that's always open. Messages show at
// once, pending, until the guild server gives them a number; links are plain links, never previewed.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_CHAT, type ChatMsg, type Member, type RoomClient, type RoomState } from '../room/client.ts';
import { Face } from './Face.tsx';
import { IconClose, IconHash, IconRename, IconSend, IconTrash, Seal } from './icons.tsx';
import { colorOf, linkify, timeOf } from './text.tsx';

/** Messages from one person within this long sit under one name. */
const GROUP_MS = 5 * 60 * 1000;

export function Chat({ client, st, onClose }: { client: RoomClient; st: RoomState; onClose: () => void }) {
  const ch = st.channels.find((c) => c.id === st.ch);
  const thread = st.ch ? st.threads[st.ch] : undefined;
  const msgs = useMemo(() => thread?.msgs ?? [], [thread]);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Keep to the bottom as messages come, unless the member scrolled up; keep the place when older ones load above.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const first = msgs.find((m) => !m.pending)?.seq;
    if (prevFirst.current !== undefined && first !== undefined && first < prevFirst.current && !atBottom.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [msgs]);
  useEffect(() => {
    atBottom.current = true;
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [st.ch]);
  useEffect(() => {
    if (st.ch) client.readAll(st.ch);
  }, [client, st.ch, ch?.last]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 60 && thread?.more) client.loadOlder();
  };

  const myId = client.me?.id;
  // A member who's here keeps their room color; anyone else gets one from their id.
  const colors = useMemo(() => new Map(st.members.map((m) => [m.id, m.color])), [st.members]);
  return (
    <aside className="ma-cm-chat" aria-label={`Chat in ${ch?.name ?? 'this channel'}`}>
      <div className="ma-cm-chat-head">
        <IconHash />
        <span className="ma-cm-chat-title">{ch?.name ?? ''}</span>
        <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Hide chat" data-tip="Hide chat" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="ma-cm-chat-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions">
        {thread?.more ? (
          <button className="ma-cm-chat-older" onClick={() => client.loadOlder()} disabled={thread.loadingOlder}>
            {thread.loadingOlder ? 'Loading' : 'Earlier messages'}
          </button>
        ) : thread?.loaded ? (
          <p className="ma-cm-chat-start">This is the start of #{ch?.name}. Everyone in the guild can read it.</p>
        ) : null}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const head = !prev || prev.from !== m.from || m.at - prev.at > GROUP_MS || Boolean(prev.failed);
          return (
            <Message
              key={m.nonce ?? m.seq}
              client={client}
              m={m}
              color={colors.get(m.from) ?? colorOf(m.from)}
              who={st.members.find((p) => p.id === m.from)}
              head={head}
              mine={m.from === myId}
              canModerate={st.can.moderate}
              now={now}
            />
          );
        })}
      </div>
      <Composer client={client} name={ch?.name ?? ''} />
    </aside>
  );
}

function Message({
  client,
  m,
  color,
  who,
  head,
  mine,
  canModerate,
  now,
}: {
  client: RoomClient;
  m: ChatMsg;
  color: number;
  who: Member | undefined;
  head: boolean;
  mine: boolean;
  canModerate: boolean;
  now: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const [confirm, setConfirm] = useState(false);
  const settled = !m.pending && !m.failed;
  const canDelete = settled && (mine || canModerate);
  const save = () => {
    const t = draft.trim();
    if (t && t !== m.text) client.editMessage(m.seq, t);
    setEditing(false);
  };
  return (
    <div className="ma-cm-msg" data-head={head ? '1' : '0'} data-pending={m.pending ? '1' : '0'} data-failed={m.failed ? '1' : '0'}>
      {head ? (
        <span className="ma-cm-avatar ma-cm-msg-avatar" style={{ ['--ma-cm-c' as string]: `var(--ma-cm-member-${color})` }} aria-hidden="true">
          <Face name={m.name} url={who?.avatarUrl} recipe={who?.avatarRecipe} size={28} />
        </span>
      ) : null}
      <div className="ma-cm-msg-body">
        {head ? (
          <div className="ma-cm-msg-meta">
            <span className="ma-cm-msg-name">{m.name}</span>
            {m.badge ? <Seal badge={m.badge} size={13} /> : null}
            <time className="ma-cm-msg-time" dateTime={new Date(m.at).toISOString()}>
              {timeOf(m.at, now)}
            </time>
          </div>
        ) : null}
        {editing ? (
          <form
            className="ma-cm-msg-edit"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <textarea
              autoFocus
              value={draft}
              maxLength={MAX_CHAT}
              aria-label="Edit message"
              rows={Math.min(8, draft.split('\n').length)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  save();
                }
              }}
            />
            <span className="ma-cm-msg-hint">Enter to save, Esc to cancel</span>
          </form>
        ) : (
          <p className="ma-cm-msg-text">
            {linkify(m.text)}
            {m.edited ? <span className="ma-cm-msg-edited"> (edited)</span> : null}
          </p>
        )}
        {m.pending ? <span className="ma-cm-msg-state">Sending</span> : null}
        {m.failed ? (
          <span className="ma-cm-msg-state ma-cm-msg-failed">
            Not sent. {m.failed}{' '}
            <button className="ma-cm-link" onClick={() => client.retrySay(m.nonce!)}>
              Try again
            </button>{' '}
            <button className="ma-cm-link" onClick={() => client.discard(m.nonce!)}>
              Discard
            </button>
          </span>
        ) : null}
        {confirm ? (
          <span className="ma-cm-msg-confirm" role="alert">
            {mine ? 'Delete this message for everyone?' : 'Delete this message? The deletion is logged.'}
            <button className="ma-cm-btn ma-cm-btn-danger" onClick={() => client.deleteMessage(m.seq)}>
              Delete
            </button>
            <button className="ma-cm-btn ma-cm-btn-quiet" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </span>
        ) : null}
      </div>
      {settled && !editing && !confirm && (mine || canDelete) ? (
        <span className="ma-cm-msg-actions">
          {mine ? (
            <button
              className="ma-cm-icon ma-cm-icon-sm"
              aria-label="Edit message"
              data-tip="Edit"
              onClick={() => {
                setDraft(m.text);
                setEditing(true);
              }}
            >
              <IconRename />
            </button>
          ) : null}
          {canDelete ? (
            <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Delete message" data-tip="Delete" onClick={() => setConfirm(true)}>
              <IconTrash />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function Composer({ client, name }: { client: RoomClient; name: string }) {
  const [text, setText] = useState('');
  const left = MAX_CHAT - [...text].length;
  const send = () => {
    if (!text.trim() || left < 0) return;
    client.say(text);
    setText('');
  };
  return (
    <form
      className="ma-cm-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        className="ma-cm-composer-input"
        value={text}
        placeholder={`Message #${name}`}
        aria-label={`Message #${name}`}
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {left < 400 ? (
        <span className="ma-cm-composer-left" data-over={left < 0 ? '1' : '0'} aria-live="polite">
          {left}
        </span>
      ) : null}
      <button className="ma-cm-icon" type="submit" aria-label="Send" data-tip="Send  Enter" disabled={!text.trim() || left < 0}>
        <IconSend />
      </button>
    </form>
  );
}
