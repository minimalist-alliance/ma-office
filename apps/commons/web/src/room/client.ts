// The room client: the one object between Commons' UI and the guild server. It keeps the room's
// state for React (channels, members, boards, chat, who's speaking), syncs the channel's board that's up
// as a Y.Doc, relays cursors and work in progress, keeps chat messages pending until the server has them,
// and runs voice.
import * as Y from 'yjs';
import type { CommonsLink } from '../net/link.ts';
import {
  PROTOCOL_VERSION,
  REC,
  boardPrefix,
  ctrl,
  cursorBody,
  decodeCtrl,
  eachRecord,
  readBoardId,
  readCursor,
  readSpeaking,
  readU16,
  readU32,
  record,
  u32,
  PartJoiner,
} from '../net/protocol.ts';
import { decodeLive, encodeLive, type LiveMsg } from '../board/live.ts';
import { itemsOf } from '../board/model.ts';
import { Voice, type VoiceState } from '../voice/voice.ts';

export interface Member {
  i: number;
  /** The guild member id (gm-…): the same person in every window. */
  id: string;
  name: string;
  /** The tier's seal: 'officer', or 'lead' (shown as Founder). Never anything about age. */
  badge?: 'officer' | 'lead';
  /** The member's checked profile picture (Platform's public avatar route); absent means initials. */
  avatarUrl?: string;
  /** The member's built avatar (the avatar kit's recipe, checked by the server); read through `builtRecipeOf` in `ui/names.ts`. */
  avatarRecipe?: unknown;
  role: 'lead' | 'officer' | 'member';
  color: number;
  /** The channel they're in or looking at. */
  ch: string;
  in: boolean;
  muted: boolean;
}

export interface Channel {
  id: string;
  name: string;
  main?: boolean;
  created: number;
  by?: string;
  /** The newest chat seq, for unread marks. */
  last: number;
}

export interface Settings {
  joinMuted: boolean;
  maxChannels: number;
}

export interface ChatMsg {
  seq: number;
  from: string;
  name: string;
  badge?: 'officer' | 'lead';
  text: string;
  at: number;
  edited?: number;
  /** This member's own message the server hasn't taken yet, or couldn't. */
  nonce?: string;
  pending?: boolean;
  failed?: string;
}

export interface Thread {
  msgs: ChatMsg[];
  more: boolean;
  loaded: boolean;
  loadingOlder: boolean;
}

/** The most characters a chat message may hold (the server's limit). */
export const MAX_CHAT = 4000;

export interface BoardMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
  by?: string;
  empty: boolean;
  bytes: number;
}

export interface RoomState {
  link: 'connecting' | 'open' | 'offline';
  me: number | null;
  members: Member[];
  channels: Channel[];
  /** The channel this member is in or looking at. */
  ch: string | null;
  settings: Settings;
  /** The cap in force: the guild's setting under the roster's ceiling. */
  maxChannels: number;
  ceiling: number;
  can: { manage: boolean; moderate: boolean };
  /** Chat threads by channel, as far as they've been loaded. */
  threads: Readonly<Record<string, Thread>>;
  /** The newest seq this member has seen, by channel. */
  read: Readonly<Record<string, number>>;
  boards: BoardMeta[];
  active: string | null;
  boardReady: boolean;
  /** Every change made here has reached the guild server. */
  saved: boolean;
  speaking: ReadonlySet<number>;
  joined: boolean;
  muted: boolean;
  voice: VoiceState;
  hasMic: boolean;
  myLevel: number;
  notice: { text: string; at: number } | null;
}

/** Origin of updates that came from the server, so they aren't sent back. */
export const REMOTE = Symbol('remote');
/** Origin of this member's own edits: the undo manager tracks only these. */
export const LOCAL = Symbol('local');

export interface Cursor {
  x: number;
  y: number;
  at: number;
}

export interface RoomClientOptions {
  /** -dev only: the name to use when the URL gave none. On a guild desk the name comes from deskd. */
  name?: string;
  /** Called with every Live message from others, as it arrives. */
  onLive?: (member: number, m: LiveMsg) => void;
}

export class RoomClient {
  private st: RoomState = {
    link: 'connecting',
    me: null,
    members: [],
    channels: [],
    ch: null,
    settings: { joinMuted: false, maxChannels: 10 },
    maxChannels: 10,
    ceiling: 10,
    can: { manage: false, moderate: false },
    threads: {},
    read: {},
    boards: [],
    active: null,
    boardReady: false,
    saved: true,
    speaking: new Set(),
    joined: false,
    muted: false,
    voice: 'off',
    hasMic: false,
    myLevel: 0,
    notice: null,
  };
  private subs = new Set<() => void>();
  private boardSubs = new Set<(doc: Y.Doc | null) => void>();
  private cursorSubs = new Set<() => void>();
  private liveSubs = new Set<(member: number, m: LiveMsg) => void>();
  /** Others' cursors in board units, by member. */
  readonly cursors = new Map<number, Cursor>();

  doc: Y.Doc | null = null;
  private docId: string | null = null;
  private applied = 0; // highest seq this doc has, from entries and acks
  private nextRef = 1;
  private pending = new Map<number, Uint8Array>(); // ref → update not yet acked
  private wasEmpty = true;
  private voice: Voice | null = null;
  private slots = 0;
  private wantJoin = false;
  private wantCh: string | null = null;
  private pingAt = new Map<number, number>();
  private parts = new PartJoiner();
  /** Chat messages sent and not yet taken by the server, by nonce, oldest first. */
  private outbox = new Map<string, { ch: string; text: string; at: number }>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Round trips to the guild server, ms, most recent last. For tests and the stats line. */
  readonly rtts: number[] = [];

  constructor(
    readonly link: CommonsLink,
    private readonly opts: RoomClientOptions,
  ) {
    link.onOpen = () => {
      this.set({ link: 'open' });
      this.link.send(ctrl({ t: 'hello', v: PROTOCOL_VERSION, name: this.opts.name ?? '' }));
    };
    link.onClose = () => {
      this.cursors.clear();
      this.emitCursors();
      this.set({ link: 'offline', boardReady: false, speaking: new Set() });
      if (this.voice) {
        this.voice.stop();
        this.voice = null;
      }
    };
    link.onMessage = (msg) => {
      try {
        eachRecord(msg, (t, p) => this.onRecord(t, p));
      } catch (e) {
        console.warn('commons: bad message', e);
      }
    };
  }

  // ---------------------------------------------------------------- React store
  get state(): RoomState {
    return this.st;
  }
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getSnapshot = (): RoomState => this.st;
  private set(patch: Partial<RoomState>): void {
    this.st = { ...this.st, ...patch };
    for (const fn of this.subs) fn();
  }

  onBoard(fn: (doc: Y.Doc | null) => void): () => void {
    this.boardSubs.add(fn);
    fn(this.doc);
    return () => this.boardSubs.delete(fn);
  }
  onCursors(fn: () => void): () => void {
    this.cursorSubs.add(fn);
    return () => this.cursorSubs.delete(fn);
  }
  onLiveMsg(fn: (member: number, m: LiveMsg) => void): () => void {
    this.liveSubs.add(fn);
    return () => this.liveSubs.delete(fn);
  }
  private emitCursors(): void {
    for (const fn of this.cursorSubs) fn();
  }

  member(i: number): Member | undefined {
    return this.st.members.find((m) => m.i === i);
  }

  /** This member, as the room sees them. */
  get me(): Member | undefined {
    return this.st.me === null ? undefined : this.member(this.st.me);
  }

  // ---------------------------------------------------------------- incoming
  private onRecord(type: number, p: Uint8Array): void {
    switch (type) {
      case REC.part: {
        const rec = this.parts.add(p);
        if (rec) eachRecord(rec, (t, q) => this.onRecord(t, q));
        break;
      }
      case REC.ctrl:
        this.onCtrl(decodeCtrl(p));
        break;
      case REC.boardEntry: {
        const { id, rest } = readBoardId(p);
        if (id !== this.docId || !this.doc) return;
        const seq = readU32(rest);
        Y.applyUpdate(this.doc, rest.subarray(4), REMOTE);
        this.applied = Math.max(this.applied, seq);
        break;
      }
      case REC.boardAck: {
        const { id, rest } = readBoardId(p);
        if (id !== this.docId) return;
        this.applied = Math.max(this.applied, readU32(rest));
        this.pending.delete(readU32(rest, 4));
        if (this.pending.size === 0 && !this.st.saved) this.set({ saved: true });
        break;
      }
      case REC.cursor: {
        const c = readCursor(p);
        if (Number.isNaN(c.x)) this.cursors.delete(c.member);
        else this.cursors.set(c.member, { x: c.x, y: c.y, at: performance.now() });
        this.emitCursors();
        break;
      }
      case REC.live: {
        const m = decodeLive(p.subarray(2));
        if (!m) return;
        const member = readU16(p);
        this.opts.onLive?.(member, m);
        for (const fn of this.liveSubs) fn(member, m);
        break;
      }
      case REC.speaking:
        this.set({ speaking: new Set(readSpeaking(p)) });
        break;
    }
  }

  private onCtrl(m: Record<string, unknown> & { t: string }): void {
    switch (m.t) {
      case 'welcome': {
        const you = m['you'] as Member;
        const boards = m['boards'] as { list: BoardMeta[]; active: string };
        this.slots = Number(m['slots'] ?? 0);
        this.setSettings(m['settings'] as SettingsMsg);
        this.set({
          me: you.i,
          members: [...((m['members'] as Member[]) ?? []), you],
          channels: (m['channels'] as Channel[]) ?? [],
          ch: typeof m['ch'] === 'string' ? m['ch'] : (you.ch ?? null),
          can: (m['can'] as RoomState['can']) ?? { manage: false, moderate: false },
          threads: {},
          boards: boards.list,
          speaking: new Set((m['speaking'] as number[] | null) ?? []),
        });
        this.openBoard(boards.active);
        // After a drop: back into the room, and resend what the server may not have.
        if (this.wantJoin) {
          if (this.st.ch && this.wantCh && this.wantCh !== this.st.ch) this.send({ t: 'channel', op: 'switch', id: this.wantCh });
          this.sendJoin();
        }
        this.flushOutbox();
        break;
      }
      case 'you': {
        const mm = m['m'] as Member;
        this.upsert(mm);
        this.set({ can: (m['can'] as RoomState['can']) ?? this.st.can });
        break;
      }
      case 'channels':
        this.set({ channels: (m['list'] as Channel[]) ?? [] });
        break;
      case 'channel': {
        const id = String(m['ch']);
        const boards = m['boards'] as { list: BoardMeta[]; active: string };
        this.wantCh = id;
        this.cursors.clear();
        this.emitCursors();
        this.set({ ch: id, boards: boards.list });
        this.openBoard(boards.active);
        break;
      }
      case 'settings':
        this.setSettings(m as unknown as SettingsMsg);
        break;
      case 'moved':
        this.voice?.stop();
        this.voice = null;
        this.wantJoin = false;
        this.set({ joined: false, voice: 'off', myLevel: 0 });
        this.notify('You’re in the room from another window.');
        break;
      case 'notice':
        this.notify(String(m['text'] ?? ''));
        break;
      case 'chat':
        this.onChat(String(m['ch']), m['m'] as ChatMsg);
        break;
      case 'chat-edit':
        this.patchThread(String(m['ch']), (msgs) => msgs.map((x) => (x.seq === (m['m'] as ChatMsg).seq ? { ...(m['m'] as ChatMsg) } : x)));
        break;
      case 'chat-delete':
        this.patchThread(String(m['ch']), (msgs) => msgs.filter((x) => x.pending || x.seq !== Number(m['seq'])));
        break;
      case 'chat-page':
        this.onPage(String(m['ch']), (m['msgs'] as ChatMsg[]) ?? [], Boolean(m['more']), Boolean(m['latest']));
        break;
      case 'member': {
        const mm = m['m'] as Member;
        this.upsert(mm);
        if (!mm.in || mm.ch !== this.st.ch) {
          this.cursors.delete(mm.i);
          this.emitCursors();
        }
        break;
      }
      case 'gone': {
        const i = Number(m['i']);
        this.cursors.delete(i);
        this.emitCursors();
        this.set({ members: this.st.members.filter((x) => x.i !== i) });
        break;
      }
      case 'boards': {
        if (m['ch'] !== undefined && m['ch'] !== this.st.ch) break;
        const list = m['list'] as BoardMeta[];
        const active = String(m['active']);
        const by = typeof m['by'] === 'string' ? m['by'] : '';
        const switched = active !== this.st.active;
        this.set({ boards: list });
        if (switched) {
          this.openBoard(active);
          const meta = list.find((b) => b.id === active);
          if (by && meta) this.notify(`${by} opened ${meta.name || 'a new board'}`);
        }
        break;
      }
      case 'board-ready':
        if (m['id'] === this.docId) {
          this.set({ boardReady: true });
          this.checkEmpty();
          // Edits made while the link was down go now, after the server's copy.
          for (const [ref, u] of this.pending) this.sendUpdate(ref, u);
        }
        break;
      case 'compact':
        if (this.docId && m['id'] === this.docId && this.doc && this.st.boardReady) {
          const state = Y.encodeStateAsUpdate(this.doc);
          this.link.send(record(REC.boardSnapshot, boardPrefix(this.docId), u32(this.applied), state));
        }
        break;
      case 'rtc-answer':
        void this.voice?.answer(String(m['sdp']), (m['mids'] as string[]) ?? []);
        break;
      case 'rtc-ice':
        void this.voice?.ice(m['candidate'] as RTCIceCandidateInit);
        break;
      case 'rtc-down':
        // 'policed': the server closed this voice connection for sending far more than voice needs (NET031-2). The
        // client reconnects as for any loss; a normal microphone never gets here. Wording is the Designer's.
        if (m['reason'] === 'policed') this.notify('Your voice was sending too much at once, so it reconnected.');
        this.voice?.restart();
        break;
      case 'slots':
        this.voice?.setSlots((m['s'] as number[]) ?? []);
        break;
      case 'pong': {
        const n = Number(m['n']);
        const at = this.pingAt.get(n);
        if (at !== undefined) {
          this.pingAt.delete(n);
          this.rtts.push(performance.now() - at);
          if (this.rtts.length > 50) this.rtts.shift();
        }
        break;
      }
      case 'error':
        if (m['code'] === 'version') this.notify('Commons was updated. Reload to keep going.');
        else if (m['code'] === 'chat') this.onChatError(m);
        else if (m['code'] === 'channel') this.notify(CHANNEL_ERRORS[String(m['reason'])] ?? 'That didn’t work. Try again.');
        else if (m['code'] === 'settings') this.notify(m['reason'] === 'forbidden' ? 'Only the Founder and Officers who manage spaces can change this.' : 'That setting is out of range.');
        break;
    }
  }

  private notify(text: string): void {
    this.set({ notice: { text, at: Date.now() } });
  }

  private upsert(mm: Member): void {
    const members = this.st.members.filter((x) => x.i !== mm.i);
    members.push(mm);
    members.sort((a, b) => a.i - b.i);
    this.set({ members });
  }

  private setSettings(s: SettingsMsg | undefined): void {
    if (!s) return;
    this.set({ settings: s.settings, maxChannels: s.max, ceiling: s.ceiling });
  }

  // ---------------------------------------------------------------- chat
  private patchThread(ch: string, fn: (msgs: ChatMsg[]) => ChatMsg[]): void {
    const th = this.st.threads[ch];
    if (!th) return;
    this.set({ threads: { ...this.st.threads, [ch]: { ...th, msgs: fn(th.msgs) } } });
  }

  private markRead(ch: string, seq: number): void {
    if ((this.st.read[ch] ?? 0) >= seq) return;
    this.set({ read: { ...this.st.read, [ch]: seq } });
  }

  private onChat(ch: string, msg: ChatMsg): void {
    // The channel list's newest seq, for unread marks.
    if (this.st.channels.some((c) => c.id === ch && c.last < msg.seq)) {
      this.set({ channels: this.st.channels.map((c) => (c.id === ch ? { ...c, last: msg.seq } : c)) });
    }
    if (msg.nonce) this.outbox.delete(msg.nonce);
    const th = this.st.threads[ch];
    if (th) {
      const msgs = th.msgs.filter((x) => !(msg.nonce && x.nonce === msg.nonce) && !(x.seq === msg.seq && !x.pending));
      const settled: ChatMsg = { ...msg };
      delete settled.nonce;
      // Keep pending ones last, in the order they were written.
      const firm = msgs.filter((x) => !x.pending && !x.failed);
      const waiting = msgs.filter((x) => x.pending || x.failed);
      firm.push(settled);
      firm.sort((a, b) => a.seq - b.seq);
      this.set({ threads: { ...this.st.threads, [ch]: { ...th, msgs: [...firm, ...waiting] } } });
    }
    if (ch === this.st.ch || msg.from === this.me?.id) this.markRead(ch, msg.seq);
  }

  private onPage(ch: string, page: ChatMsg[], more: boolean, latest: boolean): void {
    const th = this.st.threads[ch];
    const waiting = (th?.msgs ?? []).filter((x) => x.pending || x.failed);
    let firm: ChatMsg[];
    if (latest || !th) firm = page;
    else {
      const seen = new Set(th.msgs.map((x) => x.seq));
      firm = [...page.filter((x) => !seen.has(x.seq)), ...th.msgs.filter((x) => !x.pending && !x.failed)];
      firm.sort((a, b) => a.seq - b.seq);
      more = more && page.length > 0;
    }
    // A pending message the server already has (sent just before a drop) shows once.
    for (const [nonce, o] of this.outbox) if (o.ch === ch && !waiting.some((w) => w.nonce === nonce)) waiting.push(this.pendingMsg(nonce, o));
    this.set({
      threads: { ...this.st.threads, [ch]: { msgs: [...firm, ...waiting], more, loaded: true, loadingOlder: false } },
    });
    if (latest && ch === this.st.ch) {
      const last = this.st.channels.find((c) => c.id === ch)?.last ?? 0;
      this.markRead(ch, Math.max(last, page.at(-1)?.seq ?? 0));
    }
  }

  private pendingMsg(nonce: string, o: { text: string; at: number }): ChatMsg {
    const me = this.me;
    const msg: ChatMsg = { seq: 0, from: me?.id ?? '', name: me?.name ?? '', text: o.text, at: o.at, nonce, pending: true };
    if (me?.badge) msg.badge = me.badge;
    return msg;
  }

  private onChatError(m: Record<string, unknown>): void {
    const nonce = typeof m['nonce'] === 'string' ? m['nonce'] : '';
    const reason = String(m['reason'] ?? '');
    if (nonce && this.outbox.has(nonce)) {
      if (reason === 'rate') {
        // Too fast: it goes again shortly, still pending.
        if (!this.retryTimer) this.retryTimer = setTimeout(() => ((this.retryTimer = null), this.flushOutbox()), 1500);
        return;
      }
      const o = this.outbox.get(nonce)!;
      this.outbox.delete(nonce);
      this.patchThread(o.ch, (msgs) => msgs.map((x) => (x.nonce === nonce ? { ...x, pending: false, failed: CHAT_ERRORS[reason] ?? 'Not sent.' } : x)));
      return;
    }
    if (reason === 'rate') this.notify('Slow down a little. Try again in a moment.');
    else if (reason === 'not-yours') this.notify('Only its writer can change that message.');
    else if (reason !== 'no-message') this.notify(CHAT_ERRORS[reason] ?? 'That didn’t work. Try again.');
  }

  private flushOutbox(): void {
    if (this.st.link !== 'open') return;
    for (const [nonce, o] of this.outbox) this.send({ t: 'chat-send', ch: o.ch, nonce, text: o.text });
  }

  /** Sends a chat message to a channel. It shows at once, pending, until the server gives it a number. */
  say(text: string, ch = this.st.ch): void {
    const t = text.trim();
    if (!t || !ch) return;
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const o = { ch, text: t, at: Date.now() };
    this.outbox.set(nonce, o);
    const th = this.st.threads[ch] ?? { msgs: [], more: false, loaded: false, loadingOlder: false };
    this.set({ threads: { ...this.st.threads, [ch]: { ...th, msgs: [...th.msgs, this.pendingMsg(nonce, o)] } } });
    if (this.st.link === 'open') this.send({ t: 'chat-send', ch, nonce, text: t });
  }

  /** Sends a message that failed again. */
  retrySay(nonce: string, ch = this.st.ch): void {
    if (!ch) return;
    const msg = this.st.threads[ch]?.msgs.find((x) => x.nonce === nonce);
    if (!msg) return;
    this.patchThread(ch, (msgs) => msgs.filter((x) => x.nonce !== nonce));
    this.say(msg.text, ch);
  }

  /** Drops a message that failed. */
  discard(nonce: string, ch = this.st.ch): void {
    if (ch) this.patchThread(ch, (msgs) => msgs.filter((x) => x.nonce !== nonce));
  }

  editMessage(seq: number, text: string, ch = this.st.ch): void {
    if (ch && text.trim()) this.send({ t: 'chat-edit', ch, seq, text });
  }

  deleteMessage(seq: number, ch = this.st.ch): void {
    if (ch) this.send({ t: 'chat-delete', ch, seq });
  }

  /** Asks for the page before the oldest message shown. */
  loadOlder(ch = this.st.ch): void {
    const th = ch ? this.st.threads[ch] : undefined;
    if (!ch || !th || !th.more || th.loadingOlder) return;
    const oldest = th.msgs.find((x) => !x.pending && !x.failed)?.seq ?? 0;
    this.set({ threads: { ...this.st.threads, [ch]: { ...th, loadingOlder: true } } });
    this.send({ t: 'chat-history', ch, before: oldest, limit: 50 });
  }

  /** Marks the channel shown as read to its newest message. */
  readAll(ch = this.st.ch): void {
    const c = this.st.channels.find((x) => x.id === ch);
    if (c) this.markRead(c.id, c.last);
  }

  // ---------------------------------------------------------------- channels and settings
  /** Goes to another channel: its board, its chat and, if in the room, its voice. */
  openChannel(id: string): void {
    if (id !== this.st.ch) this.send({ t: 'channel', op: 'switch', id });
  }
  createChannel(name: string): void {
    this.send({ t: 'channel', op: 'create', name });
  }
  renameChannel(id: string, name: string): void {
    this.send({ t: 'channel', op: 'rename', id, name });
  }
  deleteChannel(id: string): void {
    this.send({ t: 'channel', op: 'delete', id });
  }
  saveSettings(s: Partial<Settings>): void {
    this.send({ t: 'settings', ...s });
  }

  // ---------------------------------------------------------------- board sync
  private openBoard(id: string): void {
    if (id === this.docId && this.doc) {
      // Same board after a reconnect: keep the doc and its unsent edits; the server's log merges in.
      this.set({ active: id, boardReady: false });
      return;
    }
    this.doc?.destroy();
    const doc = new Y.Doc();
    this.doc = doc;
    this.docId = id;
    this.applied = 0;
    this.pending.clear();
    this.wasEmpty = true;
    doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      const ref = this.nextRef++;
      this.pending.set(ref, u);
      if (this.st.saved) this.set({ saved: false });
      this.sendUpdate(ref, u);
    });
    doc.on('afterTransaction', () => this.checkEmpty());
    this.set({ active: id, boardReady: false, saved: true });
    for (const fn of this.boardSubs) fn(doc);
  }

  private sendUpdate(ref: number, u: Uint8Array): void {
    if (this.docId && this.st.link === 'open' && this.st.boardReady) {
      this.link.send(record(REC.boardUpdate, boardPrefix(this.docId), u32(ref), u));
    }
  }

  private checkEmpty(): void {
    if (!this.doc || !this.docId || !this.st.boardReady || !this.st.joined) return;
    const empty = itemsOf(this.doc).size === 0;
    if (empty !== this.wasEmpty) {
      this.wasEmpty = empty;
      this.send({ t: 'boards', op: 'empty', id: this.docId, empty });
    }
  }

  // ---------------------------------------------------------------- outgoing
  send(msg: object): void {
    this.link.send(ctrl(msg));
  }

  sendCursor(x: number, y: number): void {
    if (this.st.joined) this.link.send(record(REC.cursor, cursorBody(x, y)));
  }

  hideCursor(): void {
    this.sendCursor(NaN, NaN);
  }

  sendLive(m: LiveMsg): void {
    if (this.st.joined) this.link.send(record(REC.live, encodeLive(m)));
  }

  ping(): void {
    const n = Math.floor(Math.random() * 1e9);
    this.pingAt.set(n, performance.now());
    this.send({ t: 'ping', n });
  }

  // ---------------------------------------------------------------- room actions
  /** Into the room: voice, and the board becomes editable. */
  join(): void {
    if (this.st.joined) return;
    this.wantJoin = true;
    // The guild's setting: everyone joins muted, or everyone joins talking.
    const muted = this.st.settings.joinMuted;
    this.voice?.setMuted(muted);
    this.set({ joined: true, muted });
    this.sendJoin();
  }

  private sendJoin(): void {
    this.send({ t: 'join', muted: this.st.muted });
    this.wasEmpty = this.doc ? itemsOf(this.doc).size === 0 : true;
    this.send({ t: 'boards', op: 'empty', id: this.docId, empty: this.wasEmpty });
    if (!this.voice) {
      this.voice = new Voice(
        {
          send: (m) => this.send(m),
          state: (s) => this.set({ voice: s, hasMic: this.voice?.hasMic ?? false }),
          level: (v) => {
            if (Math.abs(v - this.st.myLevel) > 0.04) this.set({ myLevel: v });
          },
        },
        this.slots,
      );
      void this.voice.start(this.st.muted);
    }
  }

  leave(): void {
    this.wantJoin = false;
    this.voice?.stop();
    this.voice = null;
    this.send({ t: 'leave' });
    this.set({ joined: false, voice: 'off', myLevel: 0 });
  }

  setMuted(muted: boolean): void {
    this.set({ muted });
    this.voice?.setMuted(muted);
    if (this.st.joined) this.send({ t: 'mute', muted });
  }

  /** Voice didn't connect, or the network blocked it: try once more, keeping the microphone. */
  retryVoice(): void {
    this.voice?.restart();
  }

  newBoard(): void {
    this.send({ t: 'boards', op: 'new' });
  }
  openSaved(id: string): void {
    if (id !== this.st.active) this.send({ t: 'boards', op: 'switch', id });
  }
  rename(id: string, name: string): void {
    this.send({ t: 'boards', op: 'rename', id, name });
  }
  remove(id: string): void {
    this.send({ t: 'boards', op: 'delete', id });
  }
  refreshBoards(): void {
    this.send({ t: 'boards', op: 'list' });
  }
  clearNotice(): void {
    this.set({ notice: null });
  }

  /** For tests and the demo's stats: voice internals. */
  get voiceDebug(): Voice | null {
    return this.voice;
  }

  close(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.voice?.stop();
    this.voice = null;
    this.link.close();
    this.doc?.destroy();
    this.doc = null;
  }
}

interface SettingsMsg {
  settings: Settings;
  max: number;
  ceiling: number;
}

const CHAT_ERRORS: Record<string, string> = {
  'too-long': `Messages hold up to ${MAX_CHAT.toLocaleString('en-US')} characters.`,
  empty: 'Write something first.',
  'no-channel': 'That channel was deleted.',
  'no-message': 'That message was deleted.',
  rate: 'Slow down a little. Try again in a moment.',
};

const CHANNEL_ERRORS: Record<string, string> = {
  forbidden: 'Only the Founder and Officers who manage spaces can change channels.',
  limit: 'The guild has all the channels its settings allow.',
  'name-taken': 'There’s a channel with that name already.',
  name: 'Give the channel a name.',
  main: 'The main channel stays.',
  'no-channel': 'That channel was deleted.',
};
