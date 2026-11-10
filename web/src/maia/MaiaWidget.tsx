// Support Maia in the office (contract maia.md, "The widget"; docs/maia.md sections 1, 8 and 14), loaded lazily by
// `MaiaMount`. Plain DOM in the right-most bottom corner (the owner, Nov 7), to the right of the bandwidth circle and
// just above it on a screen under 1200 px, outside the Konva canvas: her round bubble, where she lives and moves, and
// above it, when opened, her chat. Hidden is the bubble alone, and it reopens with a press.
// - Her avatar is the package, version 7, never changed here. She's calm, thinks when a turn is sent, speaks while
//   text arrives, plays a score for the latest reply only, and is unavailable after a stop.
// - Collapsed, nothing of ours runs: only her own loop, which stops while she's asleep or can't be seen.
import { createAvatar, type MaiaAvatar } from '@minimalist-alliance/maia-avatar';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useIsPhone } from '../canvas/phone';
import { ageBandOf, ageRulesOn } from '../platform/age';
import { accountUrl } from '../platform/clientConfig';
import { onBeforeSignOut, useSession } from '../platform/session';
import { useWindowStore } from '../state/windowStore';
import { getTheme, useTheme } from '../theme/themeStore';
import { acceptAttr, splitAttached } from './attachments';
import { Card } from './Card';
import { PendingChips, SentChips } from './Chips';
import { kindLabel } from './cards';
import { Chat, type Msg } from './chat';
import type { MaiaState } from './gate';
import { FREE_TICK_MS, freeLabel } from './free';
import { MaiaIcon } from './icons';
import { watchOfficeActivity } from './officeActivity';
import { Markdown } from './Markdown';
import { MAX_MESSAGE_CHARS } from './turn';
import { keptLine } from './keptLine';
import './maia.css';

/** The launcher, as her spec has it: 64 px, which draws her at the `md` tier. */
const BUBBLE = 64;
const OPEN_KEY = 'ma.maia.open.v1';
const MOTION_KEY = 'ma.maia.motion.v1';
/** The count shows from here on. */
const COUNT_FROM = MAX_MESSAGE_CHARS - 400;

function readStore(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStore(store: 'local' | 'session', key: string, value: string | null): void {
  try {
    const s = store === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable: it lasts as long as the page */
  }
}

/** Whether any `<video>` here is playing, which in this app means a desk's stream. Told only when that changes. */
function watchVideo(on: (playing: boolean) => void): () => void {
  let last = false;
  const check = (): void => {
    const playing = Array.from(document.querySelectorAll('video')).some((v) => !v.paused && !v.ended && v.readyState > 2);
    if (playing === last) return;
    last = playing;
    on(playing);
  };
  // Media events don't bubble, but they do pass the document on the way down.
  const types = ['playing', 'pause', 'ended', 'emptied', 'waiting'];
  for (const t of types) document.addEventListener(t, check, true);
  // A closed window takes its video out of the page, which says nothing to the document.
  const off = useWindowStore.subscribe(() => window.setTimeout(check, 0));
  check();
  return () => {
    for (const t of types) document.removeEventListener(t, check, true);
    off();
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

interface Props {
  base: string;
  initial: MaiaState;
}

export default function MaiaWidget({ base, initial }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const avatarRef = useRef<MaiaAvatar | null>(null);
  const [chat] = useState(() => new Chat(base, initial, () => avatarRef.current));
  const [open, setOpen] = useState(() => readStore('session', OPEN_KEY) === '1');
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const [paused, setPaused] = useState(() => readStore('local', MOTION_KEY) === 'paused');
  const focusOnOpen = useRef(false);
  const theme = useTheme((s) => s.resolved);
  const phone = useIsPhone();
  const said = chat.store((s) => s.said);

  // Her avatar, made once. The bubble is its positioned parent, where she breathes while asleep.
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return undefined;
    const avatar = createAvatar(canvas, {
      theme: getTheme().resolved,
      size: BUBBLE,
      sleepAfterMs: initial.animation.sleepAfterSec * 1000,
      activityTarget: root,
      textSide: 1,
    });
    avatarRef.current = avatar;
    if (readStore('local', MOTION_KEY) === 'paused') avatar.pause();
    // Office activity counts as use, so she isn't asleep beside a member working in the office. The owner: "Her
    // eyes cannot be closed the whole time!" She sleeps only once the whole office has been idle `sleepAfterSec`.
    const activity = watchOfficeActivity(() => avatar.wake());
    const offVideo = watchVideo((playing) => {
      avatar.setStreamMode(playing);
      activity.setStreaming(playing);
    });
    // Read-only, for tests: how many frames she has drawn, and the scores she was given. Not in a production bundle.
    if (import.meta.env.MODE !== 'production') {
      const scores: unknown[] = [];
      const play = avatar.playScore.bind(avatar);
      avatar.playScore = (input: unknown) => {
        scores.push(input);
        return play(input);
      };
      (window as unknown as Record<string, unknown>)['__maMaia'] = { stats: () => ({ ...avatar.stats, state: avatar.state, paused: avatar.paused, scores: scores.length }) };
    }
    return () => {
      offVideo();
      activity.stop();
      avatar.destroy();
      avatarRef.current = null;
    };
  }, [initial]);

  useEffect(() => avatarRef.current?.setTheme(theme), [theme]);
  useEffect(() => () => chat.destroy(), [chat]);
  useEffect(() => onBeforeSignOut(async () => chat.forgetConversation()), [chat]);

  const togglePause = (): void => {
    const next = !paused;
    setPaused(next);
    writeStore('local', MOTION_KEY, next ? 'paused' : null);
    if (next) avatarRef.current?.pause();
    else avatarRef.current?.resume();
  };

  const show = (): void => {
    focusOnOpen.current = true;
    setOpen(true);
    writeStore('session', OPEN_KEY, '1');
  };

  const hide = useCallback((): void => {
    setOpen(false);
    setView('chat');
    writeStore('session', OPEN_KEY, null);
    launcherRef.current?.focus();
  }, []);

  // A card that moved the office (a desk, all desks): on a phone the panel covers it, so it steps aside.
  const onLeft = useCallback((): void => {
    if (phone) hide();
  }, [phone, hide]);

  useEffect(() => {
    if (!open) return;
    void chat.loadConversation();
    if (!chat.get().memories) void chat.loadMemories();
  }, [open, chat]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      hide();
      return;
    }
    // Keys meant for Maia are hers: the office's own shortcuts (Enter on a desk, arrows, digits) never see them.
    if (open || e.key !== 'Escape') e.stopPropagation();
  };

  return (
    <div ref={rootRef} className={`maia${open ? ' open' : ''}`} data-testid="maia" onKeyDown={onKeyDown}>
      {open && (
        <Panel
          chat={chat}
          view={view}
          setView={setView}
          paused={paused}
          togglePause={togglePause}
          hide={hide}
          focusOnOpen={focusOnOpen}
          retentionDays={initial.retentionDays}
          memoryOn={initial.memory.enabled}
          onLeft={onLeft}
        />
      )}
      <button
        ref={launcherRef}
        type="button"
        className="maia-launcher"
        aria-label="Maia, AI assistant"
        aria-expanded={open}
        {...(open ? { 'aria-controls': 'maia-panel' } : {})}
        title={open ? 'Hide Maia' : 'Maia'}
        onClick={() => (open ? hide() : show())}
      >
        <span className="maia-bubble">
          <canvas ref={canvasRef} className="maia-canvas" width={BUBBLE} height={BUBBLE} aria-hidden="true" />
        </span>
      </button>
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
    </div>
  );
}

interface PanelProps {
  chat: Chat;
  view: 'chat' | 'memory';
  setView: (v: 'chat' | 'memory') => void;
  paused: boolean;
  togglePause: () => void;
  hide: () => void;
  focusOnOpen: RefObject<boolean>;
  retentionDays: number | null;
  memoryOn: boolean;
  onLeft: () => void;
}

function Panel({ chat, view, setView, paused, togglePause, hide, focusOnOpen, retentionDays, memoryOn, onLeft }: PanelProps) {
  // A teen has no desk agents, so nothing here points them to any. With the age rules on, that waits for `/v1/me`.
  const agents = useSession((st) => (st.me ? ageBandOf(st.me) !== 'teen' : !ageRulesOn(st.config)));
  const modelLabel = chat.store((s) => s.modelLabel);
  // On free Maia the line above the composer says so; nothing here names what answers (ADR 0104).
  const onFree = chat.store((s) => s.freeUntil !== null);
  const idle = chat.store((s) => s.phase === 'idle');
  const empty = chat.store((s) => s.messages.length === 0);
  const remembered = chat.store((s) => (s.memories?.length ?? 0) > 0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const memoryBtnRef = useRef<HTMLButtonElement>(null);
  const showMemory = memoryOn || remembered || view === 'memory';

  // Focus goes into the panel when the member opens it, not when a reload brings it back open.
  useLayoutEffect(() => {
    if (!focusOnOpen.current) return;
    focusOnOpen.current = false;
    inputRef.current?.focus();
  }, [focusOnOpen]);

  const toMemory = (): void => {
    setView('memory');
    window.setTimeout(() => backRef.current?.focus(), 0);
  };
  const toChat = (): void => {
    setView('chat');
    window.setTimeout(() => (memoryBtnRef.current ?? inputRef.current)?.focus(), 0);
  };

  return (
    <section className="maia-panel" id="maia-panel" role="dialog" aria-labelledby="maia-title">
      <header className="maia-head">
        <div className="maia-head-row">
          {view === 'memory' && (
            <button ref={backRef} type="button" className="maia-tool" aria-label="Back to the chat" title="Back" onClick={toChat}>
              <MaiaIcon name="back" />
            </button>
          )}
          <h2 className="maia-title" id="maia-title">
            {view === 'memory' ? 'What Maia remembers' : 'Maia'}
          </h2>
          {view === 'chat' && modelLabel && !onFree && <span className="maia-model">{modelLabel}</span>}
          <div className="maia-tools">
            {view === 'chat' && (
              <button
                type="button"
                className="maia-tool"
                aria-label="New chat"
                title="New chat"
                disabled={!idle || empty}
                onClick={() => {
                  chat.newChat();
                  inputRef.current?.focus();
                }}
              >
                <MaiaIcon name="newChat" />
              </button>
            )}
            {view === 'chat' && showMemory && (
              <button ref={memoryBtnRef} type="button" className="maia-tool" aria-label="What Maia remembers" title="What Maia remembers" onClick={toMemory}>
                <MaiaIcon name="memory" />
              </button>
            )}
            <button type="button" className="maia-tool" aria-label="Pause Maia's motion" aria-pressed={paused} title={paused ? "Resume Maia's motion" : "Pause Maia's motion"} onClick={togglePause}>
              <MaiaIcon name={paused ? 'play' : 'pause'} />
            </button>
            <button type="button" className="maia-tool" aria-label="Hide Maia" title="Hide (Esc)" onClick={hide}>
              <MaiaIcon name="hide" />
            </button>
          </div>
        </div>
        {view === 'chat' ? (
          // Two lines, the owner's words (Nov 9). How long chats are kept is the server's `retentionDays`, never a number here.
          <>
            <p className="maia-sub">Ask about your desks, your account, or your office. I can be wrong.</p>
            <p className="maia-sub" data-testid="maia-kept">{keptLine(retentionDays, agents)}</p>
          </>
        ) : (
          <p className="maia-sub">{agents ? 'Delete anything, any time. Private things stay with your desk agents.' : 'Delete anything, any time.'}</p>
        )}
      </header>
      {view === 'chat' ? (
        <ChatView chat={chat} inputRef={inputRef} onLeft={onLeft} />
      ) : (
        <MemoryView chat={chat} backRef={backRef} />
      )}
    </section>
  );
}

function ChatView({ chat, inputRef, onLeft }: { chat: Chat; inputRef: RefObject<HTMLTextAreaElement | null>; onLeft: () => void }) {
  const messages = chat.store((s) => s.messages);
  const idle = chat.store((s) => s.phase === 'idle');
  const line = chat.store((s) => s.line);
  const files = chat.store((s) => s.files);
  const attachLine = chat.store((s) => s.attachLine);
  const restore = chat.store((s) => s.restore);
  const caps = chat.caps;
  const [over, setOver] = useState(false);
  const overDepth = useRef(0);
  const pickRef = useRef<HTMLInputElement>(null);
  // A past message carried a file, and none is waiting: she can't see it any more.
  const staleFiles = !files.length && messages.some((m) => m.role === 'me' && ((m.files?.length ?? 0) > 0 || splitAttached(m.text).chips.length > 0));
  const logRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const atEnd = useRef(true);
  const newChat = useCallback(() => chat.newChat(), [chat]);


  const stick = useCallback((): void => {
    const el = logRef.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(stick, [messages, stick]);

  const grow = (): void => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    const count = countRef.current;
    if (count) count.textContent = el.value.length >= COUNT_FROM ? `${el.value.length.toLocaleString()} / ${MAX_MESSAGE_CHARS.toLocaleString()}` : '';
  };

  // A draft outlasts hiding the panel.
  useEffect(() => {
    const el = inputRef.current;
    if (el && chat.draft) {
      el.value = chat.draft;
      grow();
    }
    return () => {
      chat.draft = el?.value ?? '';
    };
    // Once, as the panel opens: `grow` reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, inputRef]);

  // A turn the server refused before it began: the words come back, and the files are already in the list.
  const seenRestore = useRef(restore?.n ?? 0);
  useEffect(() => {
    const el = inputRef.current;
    if (!restore || restore.n === seenRestore.current) return;
    seenRestore.current = restore.n;
    if (el && restore.text) {
      el.value = el.value ? `${restore.text}\n${el.value}` : restore.text;
      grow();
    }
    // `grow` reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore, inputRef]);

  const takeFiles = (list: File[]): void => void chat.addFiles(list);
  const isFiles = (e: DragEvent<HTMLElement>): boolean => !!caps && Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = caps
    ? {
        onDragEnter: (e: DragEvent<HTMLElement>) => {
          if (!isFiles(e)) return;
          e.preventDefault();
          overDepth.current += 1;
          setOver(true);
        },
        onDragOver: (e: DragEvent<HTMLElement>) => {
          if (isFiles(e)) e.preventDefault();
        },
        onDragLeave: (e: DragEvent<HTMLElement>) => {
          if (!isFiles(e)) return;
          overDepth.current = Math.max(0, overDepth.current - 1);
          if (!overDepth.current) setOver(false);
        },
        onDrop: (e: DragEvent<HTMLElement>) => {
          if (!isFiles(e)) return;
          e.preventDefault();
          overDepth.current = 0;
          setOver(false);
          takeFiles(Array.from(e.dataTransfer.files));
        },
      }
    : {};

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!caps) return;
    const got = Array.from(e.clipboardData.files);
    // Text that came with the files wins: pasting from a document is still pasting words.
    if (!got.length || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    takeFiles(got);
  };

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    const el = inputRef.current;
    if (!el || !idle) return;
    const text = el.value;
    if (!text.trim()) return;
    el.value = '';
    grow();
    atEnd.current = true;
    const sent = await chat.send(text);
    // It never went: the words come back, unless something new has been typed since.
    if (!sent && !el.value) {
      el.value = text;
      grow();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <>
      <div
        ref={logRef}
        className={over ? 'maia-log maia-over' : 'maia-log'}
        {...dropProps}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {messages.map((m) => (
          <Message key={m.key} msg={m} chat={chat} onLeft={onLeft} newChat={newChat} />
        ))}
        <Streaming chat={chat} stick={stick} />
      </div>
      {line && (
        <p className="maia-line" role="status">
          {line}
        </p>
      )}
      <FreeLine chat={chat} />
      <form className={over ? 'maia-compose maia-over' : 'maia-compose'} onSubmit={(e) => void submit(e)} {...dropProps}>
        {caps && (
          <div className="maia-attach-row">
            <PendingChips files={files} onRemove={(id) => chat.removeFile(id)} />
            <p className="maia-line maia-attach-line" role="status">
              {over ? 'Drop to attach.' : (attachLine ?? (staleFiles ? "Maia can't see earlier files. Attach it again to ask more." : ''))}
            </p>
          </div>
        )}
        {caps && (
          <>
            <input
              ref={pickRef}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              accept={acceptAttr(caps)}
              onChange={(e) => {
                takeFiles(Array.from(e.currentTarget.files ?? []));
                e.currentTarget.value = '';
              }}
            />
            <button type="button" className="maia-attach" aria-label="Attach files" title="Attach files" onClick={() => pickRef.current?.click()}>
              <MaiaIcon name="attach" />
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          className="maia-input"
          aria-label="Message to Maia"
          placeholder={files.length ? 'Ask about your file' : 'Ask Maia'}
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          onKeyDown={onKey}
          onPaste={onPaste}
          onInput={grow}
        />
        <span ref={countRef} className="maia-count" />
        <button type="submit" className="maia-send" aria-label="Send" title="Send" aria-disabled={!idle}>
          <MaiaIcon name="send" />
        </button>
      </form>
    </>
  );
}

/**
 * While she answers on her free model (ma-platform ADR 0104), a quiet line above the composer: "Free Maia until 5:00 pm",
 * in the member's own time. It goes when a turn comes back on her usual model, or when the time passes.
 */
function FreeLine({ chat }: { chat: Chat }) {
  const until = chat.store((s) => s.freeUntil);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), FREE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [until]);
  const label = freeLabel(until, now);
  useEffect(() => {
    if (until && !label) chat.clearFreeIfOver(now);
  }, [chat, until, label, now]);
  if (!label) return null;
  return (
    <p className="maia-free" data-testid="maia-free">
      <span className="maia-free-dot" aria-hidden="true" />
      {label}
    </p>
  );
}

/** Free Maia's notice, with the account page to upgrade from when there's a higher tier and a good address for it. */
function Note({ msg }: { msg: Msg }) {
  const config = useSession((st) => st.config);
  const href = msg.upgrade && config ? accountUrl(config) : null;
  return (
    <p className="maia-note">
      {msg.text}
      {href && (
        <>
          {' '}
          <a className="maia-note-link" href={href} target="_blank" rel="noopener noreferrer">
            Upgrade
          </a>
        </>
      )}
    </p>
  );
}

const Message = memo(function Message({ msg, chat, onLeft, newChat }: { msg: Msg; chat: Chat; onLeft: () => void; newChat: () => void }) {
  if (msg.role === 'note') return <Note msg={msg} />;
  if (msg.role === 'me') {
    const past = splitAttached(msg.text);
    return (
      <div className="maia-msg maia-me">
        {past.text && <p className="maia-me-text">{past.text}</p>}
        <SentChips files={msg.files} past={past.chips} />
      </div>
    );
  }
  return (
    <div className="maia-msg maia-her">
      {msg.text && (
        <div className="maia-md">
          <Markdown text={msg.text} />
        </div>
      )}
      {msg.stop !== null && <p className="maia-stop">{msg.stop}</p>}
      {msg.stopReason === 'too_long' && (
        <button type="button" className="maia-btn" onClick={newChat}>
          Start a new chat
        </button>
      )}
      {msg.cards.map((c) => (
        <Card key={c.proposal.proposalId} chat={chat} msgKey={msg.key} card={c} onLeft={onLeft} />
      ))}
    </div>
  );
});

/** The reply being written. Only this renders as text arrives, at most every 60 ms. */
function Streaming({ chat, stick }: { chat: Chat; stick: () => void }) {
  const text = chat.streaming((s) => s.text);
  const phase = chat.store((s) => s.phase);
  const status = chat.store((s) => s.status);
  useLayoutEffect(stick, [text, phase, status, stick]);
  if (phase === 'idle') return null;
  return (
    <div className="maia-msg maia-her" aria-busy="true">
      {text && (
        <div className="maia-md">
          <Markdown text={text} />
        </div>
      )}
      {status ? (
        <p className="maia-status">{status}</p>
      ) : (
        !text && (
          <p className="maia-thinking">
            <span className="sr-only">Maia is thinking</span>
            <span aria-hidden="true" className="maia-dots">
              <i />
              <i />
              <i />
            </span>
          </p>
        )
      )}
    </div>
  );
}

const EMPTY_MEMORY = "Nothing yet. As you talk, Maia can remember how you like answers and help, and what you've set up.";

function MemoryView({ chat, backRef }: { chat: Chat; backRef: RefObject<HTMLButtonElement | null> }) {
  const memories = chat.store((s) => s.memories);
  const line = chat.store((s) => s.memoryLine);
  const [confirmAll, setConfirmAll] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const allRef = useRef<HTMLButtonElement>(null);
  const sureRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmAll) sureRef.current?.focus();
  }, [confirmAll]);

  // Fresh each time it opens: she may have remembered something since.
  useEffect(() => {
    void chat.loadMemories();
  }, [chat]);

  /** After a delete, focus goes on to the next one, or back to the panel, never to nothing. */
  const settleFocus = (index: number): void => {
    window.setTimeout(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('.maia-mem-delete');
      const next = buttons?.[Math.min(index, buttons.length - 1)];
      (next ?? allRef.current ?? backRef.current)?.focus();
    }, 0);
  };

  if (memories === null) {
    return (
      <div className="maia-log">
        <p className="maia-intro">{line ?? 'Loading…'}</p>
      </div>
    );
  }
  return (
    <div className="maia-log maia-memory" ref={listRef}>
      {memories.length === 0 ? (
        <p className="maia-intro">{EMPTY_MEMORY}</p>
      ) : (
        <ul className="maia-mem-list">
          {memories.map((m, i) => {
            const date = formatDate(m.createdAt);
            return (
              <li key={m.memoryId} className="maia-mem">
                <div className="maia-mem-main">
                  <p className="maia-mem-meta">
                    {kindLabel(m.kind)}
                    {date && <span> · {date}</span>}
                  </p>
                  <p className="maia-mem-text">{m.text}</p>
                </div>
                <button
                  type="button"
                  className="maia-btn maia-mem-delete"
                  aria-label={`Delete "${m.text.length > 60 ? `${m.text.slice(0, 59)}…` : m.text}"`}
                  onClick={() => {
                    void chat.deleteMemory(m.memoryId).then(() => settleFocus(i));
                  }}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {memories.length > 0 &&
        (confirmAll ? (
          <div className="maia-confirm" role="group" aria-label="Forget everything">
            <p>Forget everything Maia remembers? This can't be undone.</p>
            <div className="maia-card-actions">
              <button
                type="button"
                className="maia-btn danger"
                ref={sureRef}
                onClick={() => {
                  void chat.forgetEverything().then((ok) => {
                    setConfirmAll(false);
                    if (ok) window.setTimeout(() => backRef.current?.focus(), 0);
                  });
                }}
              >
                Forget everything
              </button>
              <button
                type="button"
                className="maia-btn"
                onClick={() => {
                  setConfirmAll(false);
                  window.setTimeout(() => allRef.current?.focus(), 0);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button ref={allRef} type="button" className="maia-btn maia-forget-all" onClick={() => setConfirmAll(true)}>
            Forget everything
          </button>
        ))}
      {line && (
        <p className="maia-line" role="status">
          {line}
        </p>
      )}
    </div>
  );
}
