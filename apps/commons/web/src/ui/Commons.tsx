// Commons: the guild's always-open room. Channels down the left, the channel's board in the middle with its chrome
// floating over it, and the channel's chat on the right.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BoardEngine, type Tool } from '../board/engine.ts';
import { INKS, type Ink, type Size } from '../board/model.ts';
import type { BoardMeta, Member, RoomClient, RoomState } from '../room/client.ts';
import { ago, initials } from './names.ts';
import { Channels } from './Channels.tsx';
import { Chat } from './Chat.tsx';
import {
  IconArrow,
  IconBoards,
  IconChevron,
  IconClose,
  IconEllipse,
  IconEraser,
  IconFit,
  IconHand,
  IconLeave,
  IconMic,
  IconMicOff,
  IconMinus,
  IconNote,
  IconPen,
  IconPlus,
  IconRect,
  IconRedo,
  IconRename,
  IconSelect,
  IconText,
  IconTrash,
  IconUndo,
  IconChat,
  IconSidebar,
  Seal,
} from './icons.tsx';

export interface CommonsProps {
  client: RoomClient;
  /** What the room is called on screen; the guild's name on a guild desk. */
  title?: string;
  /** Whether the channels and the chat start shown (the member can hide and show each). */
  channelsOpen?: boolean;
  chatOpen?: boolean;
  /** The engine, for tests and the demo's perf hooks. */
  onEngine?: (e: BoardEngine | null) => void;
}

const TOOLS: { id: Tool; label: string; key: string; icon: () => ReactNode }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: IconSelect },
  { id: 'hand', label: 'Move the board', key: 'H', icon: IconHand },
  { id: 'pen', label: 'Pen', key: 'P', icon: IconPen },
  { id: 'note', label: 'Note', key: 'N', icon: IconNote },
  { id: 'text', label: 'Text', key: 'T', icon: IconText },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: IconRect },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: IconEllipse },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: IconArrow },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: IconEraser },
];

const INK_LABEL: Record<Ink, string> = { ink: 'Ink', blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', violet: 'Violet' };
const SIZE_LABEL = ['Thin', 'Medium', 'Thick'];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

function useRoom(client: RoomClient): RoomState {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

function Avatar({ m, speaking, size = 28, you }: { m: Member; speaking: boolean; size?: number; you?: boolean }) {
  return (
    <span
      className="ma-cm-avatar"
      data-speaking={speaking ? '1' : '0'}
      style={{ ['--ma-cm-c' as string]: `var(--ma-cm-member-${m.color})`, width: size, height: size }}
      title={you ? `${m.name} (you)` : m.name}
    >
      {initials(m.name)}
      {m.muted && m.in ? (
        <span className="ma-cm-avatar-muted" aria-label="Muted">
          <IconMicOff />
        </span>
      ) : null}
    </span>
  );
}

export function Commons({ client, title = 'Commons', onEngine, channelsOpen = true, chatOpen: chatAtFirst = true }: CommonsProps) {
  const st = useRoom(client);
  const rootRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<Ink>('ink');
  const [size, setSize] = useState<Size>(1);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState(0);
  const [people, setPeople] = useState(false);
  const [boardsOpen, setBoardsOpen] = useState(false);
  const [side, setSide] = useState(channelsOpen);
  const [chatOpen, setChatOpen] = useState(chatAtFirst);

  const onEngineRef = useRef(onEngine);
  onEngineRef.current = onEngine;

  // The engine lives as long as the component.
  useEffect(() => {
    const host = boardRef.current!;
    const engine = new BoardEngine(host, client, {
      zoom: setZoom,
      selection: setSelected,
      toolDone: () => setTool('select'),
    });
    engineRef.current = engine;
    onEngineRef.current?.(engine);
    return () => {
      onEngineRef.current?.(null);
      engine.destroy();
      engineRef.current = null;
    };
  }, [client]);

  useEffect(() => engineRef.current?.setTool(tool), [tool]);
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.color = color;
    e.size = size;
  }, [color, size]);
  useEffect(() => engineRef.current?.setReadOnly(!st.joined || !st.boardReady), [st.joined, st.boardReady]);
  useEffect(() => {
    if (st.boardReady) engineRef.current?.boardReady();
  }, [st.boardReady, st.active]);

  const pickColor = useCallback((c: Ink) => {
    setColor(c);
    engineRef.current?.styleSelection(c, null);
  }, []);
  const pickSize = useCallback((s: Size) => {
    setSize(s);
    engineRef.current?.styleSelection(null, s);
  }, []);

  // Keyboard: only while focus is inside Commons, so the desk's other windows keep their keys.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      const eng = engineRef.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (st.joined) client.setMuted(!st.muted);
        return;
      }
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        eng?.setSpace(true);
        return;
      }
      if (e.key === 'Escape') {
        engineRef.current?.clearSelection();
        setBoardsOpen(false);
        setPeople(false);
        return;
      }
      if (!st.joined) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) eng?.redoLast();
        else eng?.undoLast();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        eng?.redoLast();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setTool('select');
        eng?.selectAll();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        eng?.deleteSelection();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === '+' || e.key === '=') return eng?.zoomBy(1.25);
      if (e.key === '-' || e.key === '_') return eng?.zoomBy(0.8);
      if (e.key === '!' || (e.shiftKey && e.key === '1')) return eng?.fit();
      if (e.key === ')' || (e.shiftKey && e.key === '0')) return eng?.zoomTo(1);
      const tl = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (tl) setTool(tl.id);
    },
    [client, st.joined, st.muted],
  );
  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === ' ') engineRef.current?.setSpace(false);
  }, []);

  const me = st.members.find((m) => m.i === st.me);
  const inRoom = useMemo(() => st.members.filter((m) => m.in && m.ch === st.ch), [st.members, st.ch]);
  const watching = useMemo(() => st.members.filter((m) => !m.in && m.ch === st.ch), [st.members, st.ch]);
  const activeMeta = st.boards.find((b) => b.id === st.active);
  const channel = st.channels.find((c) => c.id === st.ch);
  const unreadElsewhere = st.channels.some((c) => c.id !== st.ch && c.last > (st.read[c.id] ?? 0));

  return (
    <div
      ref={rootRef}
      className="ma-cm"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      data-joined={st.joined ? '1' : '0'}
      data-side={side ? 'open' : 'closed'}
      data-chat={chatOpen ? 'open' : 'closed'}
      aria-label={title}
    >
      {side ? <Channels client={client} st={st} title={title} onHide={() => setSide(false)} /> : null}
      <div className="ma-cm-stage">
        <div ref={boardRef} className="ma-cm-board" tabIndex={0} aria-label={channel ? `Board in ${channel.name}` : 'Board'} />

        <div className="ma-cm-top">
          {!side ? (
            <button className="ma-cm-icon ma-cm-float" aria-label="Show channels" data-tip="Channels" data-unread={unreadElsewhere ? '1' : '0'} onClick={() => setSide(true)}>
              <IconSidebar />
            </button>
          ) : null}
          <BoardChip client={client} st={st} meta={activeMeta} open={boardsOpen} setOpen={setBoardsOpen} />
        </div>
        {st.link !== 'open' ? (
          <div className="ma-cm-banner" role="status">
            {st.link === 'connecting' ? 'Connecting to the guild server' : 'Can’t reach the guild server. Trying again.'}
          </div>
        ) : (
          <Notice client={client} st={st} />
        )}

        {st.joined ? (
          <Toolbar tool={tool} setTool={setTool} color={color} setColor={pickColor} size={size} setSize={pickSize} engineRef={engineRef} selected={selected} />
        ) : null}

        <div className="ma-cm-topright">
          {!chatOpen ? (
            <button className="ma-cm-icon ma-cm-float" aria-label="Show chat" data-tip="Chat" onClick={() => setChatOpen(true)}>
              <IconChat />
            </button>
          ) : null}
          <div className="ma-cm-zoom">
            <button className="ma-cm-icon" onClick={() => engineRef.current?.zoomBy(0.8)} aria-label="Zoom out" data-tip="Zoom out  −">
              <IconMinus />
            </button>
            <button className="ma-cm-zoom-level" onClick={() => engineRef.current?.zoomTo(1)} aria-label="Zoom to 100%" data-tip="Zoom to 100%  ⇧0">
              {Math.round(zoom * 100)}%
            </button>
            <button className="ma-cm-icon" onClick={() => engineRef.current?.zoomBy(1.25)} aria-label="Zoom in" data-tip="Zoom in  +">
              <IconPlus />
            </button>
            <button className="ma-cm-icon" onClick={() => engineRef.current?.fit()} aria-label="Show the whole board" data-tip="Show the whole board  ⇧1">
              <IconFit />
            </button>
          </div>
        </div>

        {st.joined && st.voice === 'blocked' ? (
          <div className="ma-cm-voiceline" role="status">
            <span>Your network blocks voice here. The board and chat still work.</span>
            <button className="ma-cm-btn ma-cm-btn-quiet" onClick={() => client.retryVoice()}>
              Retry
            </button>
          </div>
        ) : null}

        <RoomBar client={client} st={st} me={me} inRoom={inRoom} onPeople={() => setPeople((p) => !p)} peopleOpen={people} />

        {people ? <People st={st} inRoom={inRoom} watching={watching} onClose={() => setPeople(false)} /> : null}
      </div>
      {chatOpen ? <Chat client={client} st={st} onClose={() => setChatOpen(false)} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ board chip and list
function BoardChip({
  client,
  st,
  meta,
  open,
  setOpen,
}: {
  client: RoomClient;
  st: RoomState;
  meta: BoardMeta | undefined;
  open: boolean;
  setOpen: (o: boolean) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const untitled = !meta?.name;

  useEffect(() => {
    if (!open) return;
    client.refreshBoards();
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open, client, setOpen]);

  const startNaming = () => {
    setName(meta?.name ?? '');
    setNaming(true);
  };
  const commit = () => {
    const n = name.trim();
    if (meta && n && n !== meta.name) client.rename(meta.id, n);
    setNaming(false);
  };

  return (
    <div className="ma-cm-chipwrap" ref={ref}>
      <div className="ma-cm-chip">
        {naming ? (
          <form
            className="ma-cm-nameform"
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <input
              autoFocus
              className="ma-cm-nameinput"
              value={name}
              placeholder="Name this board"
              maxLength={80}
              aria-label="Board name"
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNaming(false);
                e.stopPropagation();
              }}
            />
          </form>
        ) : (
          <button
            className="ma-cm-chip-main"
            onClick={() => setOpen(!open)}
            aria-haspopup="dialog"
            aria-expanded={open}
            data-tip={open ? undefined : 'Boards'}
          >
            <IconBoards />
            <span className={untitled ? 'ma-cm-chip-name ma-cm-muted' : 'ma-cm-chip-name'}>{meta?.name || 'Untitled board'}</span>
            <IconChevron />
          </button>
        )}
        {st.joined && !naming ? (
          untitled ? (
            <button className="ma-cm-chip-save" onClick={startNaming}>
              Save
            </button>
          ) : (
            <span className="ma-cm-chip-state" aria-live="polite">
              {st.saved ? 'Saved' : 'Saving'}
            </span>
          )
        ) : null}
      </div>
      {open ? (
        <div className="ma-cm-menu ma-cm-boards" role="dialog" aria-label="Boards">
          <div className="ma-cm-menu-head">
            <span>Boards</span>
            {st.joined ? (
              <button
                className="ma-cm-btn ma-cm-btn-quiet"
                onClick={() => {
                  client.newBoard();
                  setOpen(false);
                }}
              >
                <IconPlus /> New board
              </button>
            ) : null}
          </div>
          <BoardList client={client} st={st} onOpen={() => setOpen(false)} onRename={startNaming} />
          <p className="ma-cm-menu-foot">Boards are kept on the guild server as you draw. Opening one puts it up for everyone in the room.</p>
        </div>
      ) : null}
    </div>
  );
}

function BoardList({ client, st, onOpen, onRename }: { client: RoomClient; st: RoomState; onOpen: () => void; onRename: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <ul className="ma-cm-boardlist">
      {st.boards.map((b) => {
        const active = b.id === st.active;
        return (
          <li key={b.id} data-active={active ? '1' : '0'}>
            <button
              className="ma-cm-boardrow"
              disabled={!st.joined && !active}
              onClick={() => {
                if (!active) client.openSaved(b.id);
                onOpen();
              }}
            >
              <span className="ma-cm-boardrow-name">{b.name || 'Untitled board'}</span>
              <span className="ma-cm-boardrow-meta">
                {confirm === b.id ? (
                  'Delete for everyone?'
                ) : (
                  <>
                    {active ? 'Up now · ' : ''}
                    Edited {ago(b.updated, now)}
                    {b.by ? ` by ${b.by}` : ''}
                  </>
                )}
              </span>
            </button>
            {st.joined ? (
              confirm === b.id ? (
                <span className="ma-cm-confirm">
                  <button className="ma-cm-btn ma-cm-btn-danger" onClick={() => client.remove(b.id)}>
                    Delete
                  </button>
                  <button className="ma-cm-btn ma-cm-btn-quiet" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <span className="ma-cm-rowactions">
                  {active ? (
                    <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Rename" data-tip="Rename" onClick={onRename}>
                      <IconRename />
                    </button>
                  ) : null}
                  <button className="ma-cm-icon ma-cm-icon-sm" aria-label={`Delete ${b.name || 'Untitled board'}`} data-tip="Delete" onClick={() => setConfirm(b.id)}>
                    <IconTrash />
                  </button>
                </span>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Notice({ client, st }: { client: RoomClient; st: RoomState }) {
  const n = st.notice;
  useEffect(() => {
    if (!n) return;
    const t = setTimeout(() => client.clearNotice(), 3500);
    return () => clearTimeout(t);
  }, [n, client]);
  return n ? (
    <div className="ma-cm-banner" role="status" key={n.at}>
      {n.text}
    </div>
  ) : null;
}

// ------------------------------------------------------------------ toolbar
function Toolbar({
  tool,
  setTool,
  color,
  setColor,
  size,
  setSize,
  engineRef,
  selected,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  color: Ink;
  setColor: (c: Ink) => void;
  size: Size;
  setSize: (s: Size) => void;
  engineRef: React.RefObject<BoardEngine | null>;
  selected: number;
}) {
  const styled = tool !== 'hand' && tool !== 'eraser' && (tool !== 'select' || selected > 0);
  return (
    <div className="ma-cm-rail" role="toolbar" aria-label="Board tools" aria-orientation="vertical">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className="ma-cm-icon"
          aria-pressed={tool === t.id}
          aria-label={t.label}
          data-tip={`${t.label}  ${t.key}`}
          onClick={() => setTool(t.id)}
        >
          <t.icon />
        </button>
      ))}
      {styled ? <StylePicker tool={tool} color={color} setColor={setColor} size={size} setSize={setSize} /> : null}
      <span className="ma-cm-sep" />
      <button className="ma-cm-icon" aria-label="Undo" data-tip={`Undo  ${MOD}Z`} onClick={() => engineRef.current?.undoLast()}>
        <IconUndo />
      </button>
      <button className="ma-cm-icon" aria-label="Redo" data-tip={`Redo  ${MOD}⇧Z`} onClick={() => engineRef.current?.redoLast()}>
        <IconRedo />
      </button>
      {selected > 0 ? (
        <button className="ma-cm-icon" aria-label="Delete selection" data-tip="Delete  ⌫" onClick={() => engineRef.current?.deleteSelection()}>
          <IconTrash />
        </button>
      ) : null}
    </div>
  );
}

function StylePicker({ tool, color, setColor, size, setSize }: { tool: Tool; color: Ink; setColor: (c: Ink) => void; size: Size; setSize: (s: Size) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const sized = tool !== 'note';
  return (
    <div className="ma-cm-stylewrap" ref={ref}>
      <span className="ma-cm-sep" />
      <button
        className="ma-cm-icon"
        aria-label={`Color and size: ${INK_LABEL[color]}${sized ? `, ${SIZE_LABEL[size]}` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tip={open ? undefined : 'Color and size'}
        onClick={() => setOpen(!open)}
      >
        <span className="ma-cm-dot" style={{ ['--ma-cm-sw' as string]: `var(--ma-cm-ink-${color})` }} />
      </button>
      {open ? (
        <div className="ma-cm-menu ma-cm-style" role="dialog" aria-label="Color and size">
          <div className="ma-cm-swatches" role="radiogroup" aria-label="Color">
            {INKS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={color === c}
                aria-label={INK_LABEL[c]}
                data-tip={INK_LABEL[c]}
                className="ma-cm-swatch"
                style={{ ['--ma-cm-sw' as string]: `var(--ma-cm-ink-${c})` }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          {sized ? (
            <div className="ma-cm-sizes" role="radiogroup" aria-label="Size">
              {([0, 1, 2] as Size[]).map((s) => (
                <button key={s} role="radio" aria-checked={size === s} aria-label={SIZE_LABEL[s]} data-tip={SIZE_LABEL[s]} className="ma-cm-size" onClick={() => setSize(s)}>
                  <span style={{ width: 4 + s * 4, height: 4 + s * 4 }} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ room bar and people
function RoomBar({
  client,
  st,
  me,
  inRoom,
  onPeople,
  peopleOpen,
}: {
  client: RoomClient;
  st: RoomState;
  me: Member | undefined;
  inRoom: Member[];
  onPeople: () => void;
  peopleOpen: boolean;
}) {
  const shown = inRoom.slice(0, 5);
  const more = inRoom.length - shown.length;
  const count = inRoom.length === 0 ? 'No one’s here yet' : inRoom.length === 1 ? '1 in the room' : `${inRoom.length} in the room`;
  const mySpeaking = st.joined && !st.muted && st.myLevel > 0.18;
  let voiceNote = '';
  if (st.joined) {
    if (st.voice === 'connecting') voiceNote = 'Connecting voice';
    else if (st.voice === 'failed') voiceNote = 'Voice didn’t connect';
    else if (st.voice === 'listening') voiceNote = 'Listening only. Allow the microphone, then rejoin.';
  }
  return (
    <div className="ma-cm-roombar" role="region" aria-label="Room">
      <button className="ma-cm-people-btn" onClick={onPeople} aria-expanded={peopleOpen} aria-label={`${count}. Show who's here`}>
        <span className="ma-cm-stack">
          {shown.map((m) => (
            <Avatar key={m.i} m={m} speaking={m.i === st.me ? mySpeaking : st.speaking.has(m.i)} you={m.i === st.me} />
          ))}
          {more > 0 ? <span className="ma-cm-avatar ma-cm-avatar-more">+{more}</span> : null}
        </span>
        <span className="ma-cm-count">{voiceNote || count}</span>
      </button>
      {st.joined && st.voice === 'failed' ? (
        <button className="ma-cm-btn ma-cm-btn-quiet" onClick={() => client.retryVoice()}>
          Try again
        </button>
      ) : null}
      {st.joined ? (
        <>
          <button
            className="ma-cm-icon ma-cm-icon-lg"
            aria-pressed={st.muted}
            data-state={st.muted ? 'off' : 'on'}
            disabled={!st.hasMic && st.voice !== 'connecting'}
            aria-label={st.muted ? 'Unmute' : 'Mute'}
            data-tip={`${st.muted ? 'Unmute' : 'Mute'}  ${MOD}⇧M`}
            onClick={() => client.setMuted(!st.muted)}
          >
            {st.muted || !st.hasMic ? <IconMicOff /> : <IconMic />}
          </button>
          <button className="ma-cm-btn ma-cm-btn-leave" onClick={() => client.leave()}>
            <IconLeave /> Leave
          </button>
        </>
      ) : (
        <button className="ma-cm-btn ma-cm-btn-join" disabled={st.link !== 'open' || !me} onClick={() => client.join()} data-tip="Talk and draw with the room">
          Join
        </button>
      )}
    </div>
  );
}

function People({ st, inRoom, watching, onClose }: { st: RoomState; inRoom: Member[]; watching: Member[]; onClose: () => void }) {
  const mySpeaking = st.joined && !st.muted && st.myLevel > 0.18;
  const row = (m: Member) => (
    <li key={m.i}>
      <Avatar m={m} speaking={m.i === st.me ? mySpeaking : st.speaking.has(m.i)} size={28} you={m.i === st.me} />
      <span className="ma-cm-person">
        {m.name}
        {m.i === st.me ? <span className="ma-cm-muted"> (you)</span> : null}
      </span>
      {m.badge ? <Seal badge={m.badge} /> : null}
      {m.in && m.muted ? (
        <span className="ma-cm-person-state" aria-label="Muted">
          <IconMicOff />
        </span>
      ) : null}
    </li>
  );
  return (
    <aside className="ma-cm-menu ma-cm-people" aria-label="People">
      <div className="ma-cm-menu-head">
        <span>In the room · {inRoom.length}</span>
        <button className="ma-cm-icon ma-cm-icon-sm" aria-label="Close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      {inRoom.length ? <ul className="ma-cm-peoplelist">{inRoom.map(row)}</ul> : <p className="ma-cm-menu-foot">No one’s here yet.</p>}
      {watching.length ? (
        <>
          <div className="ma-cm-menu-sub">Looking in · {watching.length}</div>
          <ul className="ma-cm-peoplelist ma-cm-peoplelist-dim">{watching.map(row)}</ul>
        </>
      ) : null}
      <p className="ma-cm-menu-foot">Voice and boards go only between the room and the guild server, encrypted. Nothing is recorded.</p>
    </aside>
  );
}
