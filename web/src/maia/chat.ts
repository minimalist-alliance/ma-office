// One member's chat with Support Maia, outside React: the turn and its stream, the cards and their decisions, and
// her memory list. The widget renders from `store`; the reply being written lives in `streaming`, a store of its own
// updated at most every 60 ms, so a delta renders that reply alone and never the list.
import type { MaiaAvatar } from '@minimalist-alliance/maia-avatar';
import { create } from 'zustand';
import { getLive } from '../desk/liveStore';
import { getView } from '../state/viewStore';
import { capLine, type AttachCaps, downscaleImage, encodeFile, isImageName, planAdd, type Pending, type Sent, type WireFile } from './attachments';
import { expired, memoryOutcome, readMemory, type Memory } from './cards';
import { FrameReader, type Frame, type Proposal } from './frames';
import { startStatus } from './free';
import type { MaiaState } from './gate';
import { parseMarkdown, plainText } from './markdown';
import { errorCode, maiaFetch } from './net';
import { refusalCode, refusedLine, turnBody, type TurnContext } from './turn';

declare const __MA_VERSION__: string;

export interface CardState {
  proposal: Proposal;
  status: 'pending' | 'busy' | 'done' | 'expired';
  /** What happened, in a few plain words. */
  line: string | null;
}

export interface Msg {
  key: number;
  role: 'me' | 'maia' | 'note';
  /** Hers is Markdown; the member's and a note are plain text. */
  text: string;
  /** Her reply ended with `stop`: its text, shown exactly as it came. */
  stop: string | null;
  stopReason: string | null;
  cards: CardState[];
  /** A note that offers the account page, where the member can upgrade (free Maia's notice, ADR 0104). */
  upgrade?: boolean;
  /** The member's message only: the files it carried, as names and sizes. Never their bytes. */
  files?: Sent[];
}

export interface ChatState {
  conversationId: string | null;
  modelLabel: string;
  messages: Msg[];
  /** `waiting` until her first words, then `streaming`. The composer sends only when idle. */
  phase: 'idle' | 'waiting' | 'streaming';
  /** "Looking that up…" while she does. */
  status: string | null;
  /** One plain line about the last thing that didn't work. */
  line: string | null;
  /** For the widget's live region: her reply, once it has finished. */
  said: string;
  /** What she remembers, once asked; null until then. */
  memories: Memory[] | null;
  memoryLine: string | null;
  /** While she answers on her free model (ma-platform ADR 0104): when the member's allowance resets. Null otherwise. */
  freeUntil: string | null;
  /** Files waiting to be sent. Held in memory only, and gone once a turn has gone out. */
  files: Pending[];
  /** One plain line about the last file that wasn't added. */
  attachLine: string | null;
  /** Words to put back in the composer: the turn did not happen. */
  restore: { text: string; n: number } | null;
}

interface Turn {
  seq: number;
  messageId: string | null;
  text: string;
  cards: Proposal[];
  firstAt: number;
  speaking: boolean;
  ended: 'done' | 'stop' | 'cut' | null;
}

const CONVERSATION_KEY = 'ma.maia.conversation.v1';
const FLUSH_MS = 60;
const LOOKING = 'Looking that up…';

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the chat lasts as long as the page */
  }
}

/** The envelope's `code` and human `message`, if the body has them. */
export async function errorInfo(res: Response): Promise<{ code: string | null; message: string | null }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    const { code, message } = body.error ?? {};
    return { code: typeof code === 'string' ? code : null, message: typeof message === 'string' && message ? message.slice(0, 300) : null };
  } catch {
    return { code: null, message: null };
  }
}

export class Chat {
  readonly store;
  /** What's in the composer while the panel is hidden. */
  draft = '';
  readonly streaming = create<{ text: string }>(() => ({ text: '' }));
  private seq = 0;
  private turn: Turn | null = null;
  private ctl: AbortController | null = null;
  private flushTimer = 0;
  private keys = 0;
  private loadedConversation = false;
  private fileKeys = 0;
  private sending = false;
  /** The files of the turn on its way, so a refusal can give them back. Dropped as soon as the turn is over. */
  private inflight: { text: string; files: Pending[] } | null = null;

  constructor(
    private readonly base: string,
    private readonly state: MaiaState,
    private readonly avatar: () => MaiaAvatar | null,
  ) {
    this.store = create<ChatState>(() => ({
      conversationId: readSession(CONVERSATION_KEY),
      modelLabel: state.modelLabel,
      messages: [],
      phase: 'idle',
      status: null,
      line: null,
      said: '',
      memories: null,
      memoryLine: null,
      freeUntil: state.free?.until ?? null,
      files: [],
      attachLine: null,
      restore: null,
    }));
  }

  /** Attachment limits, or null: then the feature isn't shown at all. */
  get caps(): AttachCaps | null {
    return this.state.attachments;
  }

  get = (): ChatState => this.store.getState();
  private set = (p: Partial<ChatState>): void => this.store.setState(p);

  /** The widget went (sign-out): whatever is on its way is dropped. React's strict mode runs this and carries on in dev. */
  destroy(): void {
    this.seq += 1;
    this.ctl?.abort();
    window.clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    this.inflight = null;
    this.set({ files: [], attachLine: null, restore: null });
    if (this.turn) {
      this.turn.ended = 'cut';
      this.turn = null;
      this.streaming.setState({ text: '' });
      this.set({ phase: 'idle', status: null });
    }
  }

  /** On sign-out: the next member in this tab starts fresh. */
  forgetConversation(): void {
    writeSession(CONVERSATION_KEY, null);
  }

  private setConversation(id: string | null): void {
    this.set({ conversationId: id });
    writeSession(CONVERSATION_KEY, id);
  }

  private push(msg: Omit<Msg, 'key'>): void {
    this.keys += 1;
    this.set({ messages: [...this.get().messages, { ...msg, key: this.keys }] });
  }

  private note(text: string, upgrade = false): void {
    this.push({ role: 'note', text, stop: null, stopReason: null, cards: [], ...(upgrade ? { upgrade } : {}) });
  }

  /** Free Maia's line goes once its time has passed, or the widget's clock says so. */
  clearFreeIfOver(now: number): void {
    const until = this.get().freeUntil;
    if (until && !(Date.parse(until) > now)) this.set({ freeUntil: null });
  }

  /** What a turn says about where the member is. Never anything from a desk's content. */
  private context(): TurnContext {
    const v = getView();
    const onDesk = v.mode === 'desk' && !!v.activeDesk;
    return {
      appVersion: __MA_VERSION__,
      route: onDesk ? 'desk' : 'home',
      lastErrorCode: v.activeDesk ? refusalCode(getLive(v.activeDesk).refusal?.kind) : null,
    };
  }

  // ---------------------------------------------------------------- a turn

  /** Add files from the picker, a drop or a paste. Over-cap files are left out and said so; the rest still go in. */
  async addFiles(list: File[]): Promise<void> {
    const caps = this.state.attachments;
    if (!caps || !list.length) return;
    const free = this.get().freeUntil !== null;
    let files = list;
    // An image over the cap is scaled down in the browser before it is refused.
    if (files.some((f) => isImageName(f.name, f.type) && f.size > caps.maxFileBytes && !(free && !caps.freeImages))) {
      files = await Promise.all(files.map(async (f) => (isImageName(f.name, f.type) && f.size > caps.maxFileBytes && !(free && !caps.freeImages) ? ((await downscaleImage(f)) ?? f) : f)));
    }
    const cur = this.get().files;
    const plan = planAdd(cur, files.map((f) => ({ name: f.name || 'file', size: f.size, type: f.type })), caps, this.get().freeUntil !== null);
    const added: Pending[] = plan.accepted.map((i) => {
      const f = files[i]!;
      return { id: ++this.fileKeys, name: f.name || 'file', size: f.size, type: f.type, file: f };
    });
    this.set({ files: [...cur, ...added], attachLine: plan.messages.length ? plan.messages.join(' ') : null });
  }

  removeFile(id: number): void {
    this.set({ files: this.get().files.filter((f) => f.id !== id), attachLine: null });
  }

  setAttachLine(line: string | null): void {
    this.set({ attachLine: line });
  }

  /** False when nothing went: the composer keeps the text, and the files are still in the list. */
  async send(raw: string): Promise<boolean> {
    const message = raw.trim();
    if (!message || this.get().phase !== 'idle' || this.sending) return false;
    const caps = this.state.attachments;
    const files = caps ? this.get().files : [];
    if (files.length && this.get().freeUntil !== null && !caps?.freeImages && files.some((f) => isImageName(f.name, f.type))) {
      this.set({ attachLine: "Free Maia can't read images." });
      return false;
    }
    if (caps && files.length > caps.maxFiles) {
      this.set({ attachLine: capLine(caps) });
      return false;
    }
    this.sending = true;
    let wire: WireFile[];
    try {
      wire = await Promise.all(files.map((f) => encodeFile({ name: f.name, file: f.file })));
    } catch {
      this.sending = false;
      this.set({ attachLine: "Couldn't read a file. Remove it and try again." });
      return false;
    }
    this.sending = false;
    if (this.get().phase !== 'idle') return false;
    this.inflight = { text: message, files };
    this.push({ role: 'me', text: message, stop: null, stopReason: null, cards: [], ...(files.length ? { files: files.map((f) => ({ name: f.name, size: f.size })) } : {}) });
    this.set({ files: [], attachLine: null });
    const ok = await this.run(message, wire, false);
    if (!ok) {
      // It never reached her: take it back off the list, so sending again doesn't show it twice.
      this.dropLastMine();
      this.giveBack();
    }
    return ok;
  }

  private dropLastMine(): void {
    const list = this.get().messages;
    const i = list.map((m) => m.role).lastIndexOf('me');
    if (i >= 0) this.set({ messages: [...list.slice(0, i), ...list.slice(i + 1)] });
  }

  /** The files go back to the composer (the turn didn't happen). */
  private giveBack(): void {
    const back = this.inflight;
    this.inflight = null;
    if (back) this.set({ files: [...back.files, ...this.get().files].slice(0, this.state.attachments?.maxFiles ?? 99) });
  }

  private async run(message: string, wire: WireFile[], retried: boolean): Promise<boolean> {
    const turn: Turn = { seq: ++this.seq, messageId: null, text: '', cards: [], firstAt: 0, speaking: false, ended: null };
    this.turn = turn;
    this.set({ phase: 'waiting', status: null, line: null });
    this.avatar()?.setState('thinking');
    this.ctl?.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    let res: Response;
    try {
      res = await maiaFetch(this.base, '/v1/maia/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(turnBody(this.get().conversationId, message, this.context(), wire)),
        signal: ctl.signal,
      });
    } catch {
      if (!ctl.signal.aborted) this.refused("Maia can't be reached right now. Try again in a moment.");
      return false;
    }
    if (!res.ok || !res.body) {
      const info = res.ok ? { code: null, message: null } : await errorInfo(res);
      const code = info.code;
      if (res.status === 400 && code === 'attachments_rejected') {
        this.refused(info.message ?? "Maia couldn't take those files.");
        return false;
      }
      if (res.status === 404 && this.get().conversationId && !retried) {
        // An expired chat: this message starts a new one.
        this.setConversation(null);
        this.note('That chat had ended, so this is a new one.');
        return this.run(message, wire, true);
      }
      this.refused(refusedLine(res.status, code));
      return false;
    }
    void this.read(res.body, turn, ctl.signal);
    return true;
  }

  private refused(line: string): void {
    this.turn = null;
    this.set({ phase: 'idle', status: null, line });
    this.avatar()?.setState('calm');
  }

  /** To the stream's end, past `done`: an `animation` frame can follow it by a few seconds. */
  private async read(body: ReadableStream<Uint8Array>, turn: Turn, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const frames = new FrameReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const f of frames.push(decoder.decode(value, { stream: true }))) this.frame(f, turn);
      }
      for (const f of frames.push(decoder.decode())) this.frame(f, turn);
      for (const f of frames.end()) this.frame(f, turn);
    } catch {
      /* cut off: below */
    }
    if (!turn.ended && !signal.aborted) this.finish(turn, 'cut', null);
  }

  private frame(f: Frame, turn: Turn): void {
    if (f.type === 'animation') {
      // Only for the reply that's still the latest, and never after a stop. Untrusted: the package parses it.
      const latest = turn.seq === this.seq && turn.ended === 'done' && !!f.messageId && f.messageId === turn.messageId;
      if (latest && this.state.animation.enabled) this.avatar()?.playScore(f.score);
      return;
    }
    if (turn.ended) return;
    switch (f.type) {
      case 'start':
        if (f.conversationId) this.setConversation(f.conversationId);
        if (f.modelLabel) this.set({ modelLabel: f.modelLabel });
        // Each turn says whether it's on free Maia, so her line follows the latest one.
        if ((f.free?.until ?? null) !== this.get().freeUntil) this.set({ freeUntil: f.free?.until ?? null });
        // Free Maia can take a minute to start: a calm line until her first words (cleared by the first text, a stop or done).
        if (startStatus(f.free, turn.text)) {
          this.set({ status: startStatus(f.free, turn.text) });
          turn.speaking = false;
          this.avatar()?.setState('thinking');
        }
        turn.messageId = f.messageId;
        return;
      case 'notice':
        this.note(f.text, f.code === 'free_mode' && f.upgrade);
        if (f.code === 'free_ended') this.set({ freeUntil: null });
        return;
      case 'status':
        // Waiting in free Maia's line: her thinking line says where they are and about how long, until her first words.
        this.set({ status: f.code === 'free_queue' && f.text ? f.text : LOOKING });
        turn.speaking = false;
        this.avatar()?.setState('thinking');
        return;
      case 'text': {
        const now = performance.now();
        if (!turn.firstAt) turn.firstAt = now;
        turn.text += f.text;
        const avatar = this.avatar();
        // Characters a second so far, for how she moves while she speaks.
        avatar?.setRate(Math.min(120, Math.max(4, turn.text.length / Math.max(0.25, (now - turn.firstAt) / 1000))));
        if (!turn.speaking) {
          turn.speaking = true;
          avatar?.setState('speaking');
        }
        const s = this.get();
        if (s.phase !== 'streaming' || s.status) this.set({ phase: 'streaming', status: null });
        if (!this.flushTimer) this.flushTimer = window.setTimeout(() => this.flush(turn), FLUSH_MS);
        return;
      }
      case 'proposal':
        turn.cards.push(f);
        return;
      case 'stop':
        this.finish(turn, 'stop', f);
        return;
      case 'done':
        this.finish(turn, 'done', null);
        return;
    }
  }

  private flush(turn: Turn): void {
    this.flushTimer = 0;
    if (this.turn === turn && !turn.ended) this.streaming.setState({ text: turn.text });
  }

  private finish(turn: Turn, how: 'done' | 'stop' | 'cut', stop: Extract<Frame, { type: 'stop' }> | null): void {
    turn.ended = how;
    window.clearTimeout(this.flushTimer);
    this.flushTimer = 0;
    if (how === 'stop' && stop?.reason === 'attachments') {
      // The turn did not happen: the bubble goes, and the words and the files go back to the composer.
      const back = this.inflight;
      this.dropLastMine();
      this.giveBack();
      this.streaming.setState({ text: '' });
      this.set({ phase: 'idle', status: null, line: stop.text || "Maia couldn't take those files.", said: stop.text, restore: { text: back?.text ?? '', n: Date.now() } });
      if (this.turn === turn) this.turn = null;
      this.avatar()?.setState('calm');
      return;
    }
    this.inflight = null; // the turn happened: no file is kept
    const now = Date.now();
    // A reply that ends in `stop` has no cards (ADR 0088), so any that came are dropped.
    const cards: CardState[] = how === 'done' ? turn.cards.map((proposal) => ({ proposal, status: expired(proposal, now) ? 'expired' : 'pending', line: null })) : [];
    if (turn.text || stop || cards.length) {
      this.push({ role: 'maia', text: turn.text, stop: stop ? stop.text : null, stopReason: stop?.reason ?? null, cards });
    }
    this.streaming.setState({ text: '' });
    const heard = plainText(parseMarkdown(turn.text));
    this.set({
      phase: 'idle',
      status: null,
      line: how === 'cut' ? 'The reply was cut off. Try again.' : null,
      said: [heard, stop?.text ?? '', cards.length ? 'Maia suggests something below.' : ''].filter(Boolean).join(' ') || (how === 'cut' ? 'The reply was cut off.' : ''),
    });
    if (this.turn === turn) this.turn = null;
    this.avatar()?.setState(how === 'stop' ? 'unavailable' : 'calm');
    if (cards.some((c) => c.proposal.action === 'forget') && !this.get().memories) void this.loadMemories();
  }

  /** A new chat. Not while she's answering. */
  newChat(): void {
    if (this.get().phase !== 'idle') return;
    this.seq += 1; // a score still on its way from the last reply is ignored
    this.setConversation(null);
    this.loadedConversation = true;
    this.set({ messages: [], line: null, said: '' });
  }

  /** The chat this tab was in, after a reload: display text only (contract, `GET /v1/maia/conversations/{id}`). */
  async loadConversation(): Promise<void> {
    const id = this.get().conversationId;
    if (this.loadedConversation || !id || this.get().messages.length) return;
    this.loadedConversation = true;
    try {
      const res = await maiaFetch(this.base, `/v1/maia/conversations/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        if (this.get().conversationId === id) this.setConversation(null);
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { messages?: unknown };
      if (!Array.isArray(body.messages) || this.get().conversationId !== id || this.get().messages.length) return;
      const msgs: Msg[] = [];
      for (const m of body.messages as { role?: unknown; text?: unknown }[]) {
        if (typeof m?.text !== 'string' || (m.role !== 'user' && m.role !== 'assistant')) continue;
        this.keys += 1;
        msgs.push({ key: this.keys, role: m.role === 'user' ? 'me' : 'maia', text: m.text, stop: null, stopReason: null, cards: [] });
      }
      this.set({ messages: msgs });
    } catch {
      /* the chat goes on from here */
    }
  }

  // ---------------------------------------------------------------- cards

  setCard(key: number, proposalId: string, patch: Partial<CardState>): void {
    this.set({
      messages: this.get().messages.map((m) =>
        m.key !== key ? m : { ...m, cards: m.cards.map((c) => (c.proposal.proposalId === proposalId ? { ...c, ...patch } : c)) },
      ),
    });
  }

  /** `POST /v1/maia/proposals/{id}/decision`. The status, and the error's code. */
  async decide(proposalId: string, body: { decision: 'confirmed' | 'declined'; result: 'ok' | 'failed' | null; errorCode: string | null }): Promise<{ status: number; code: string | null }> {
    try {
      const res = await maiaFetch(this.base, `/v1/maia/proposals/${encodeURIComponent(proposalId)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, code: res.ok ? null : await errorCode(res) };
    } catch {
      return { status: 0, code: null };
    }
  }

  /** Remember or forget: the decision is the change itself, so its answer is the outcome. */
  async decideMemory(key: number, card: CardState, action: 'remember' | 'forget'): Promise<void> {
    const id = card.proposal.proposalId;
    if (expired(card.proposal, Date.now())) {
      this.setCard(key, id, { status: 'expired' });
      return;
    }
    this.setCard(key, id, { status: 'busy' });
    const { status, code } = await this.decide(id, { decision: 'confirmed', result: null, errorCode: null });
    const out = memoryOutcome(action, status, code);
    this.setCard(key, id, { status: 'done', line: out.line });
    if (out.ok || code === 'memory_full') void this.loadMemories();
  }

  // ---------------------------------------------------------------- memory

  async loadMemories(): Promise<void> {
    try {
      const res = await maiaFetch(this.base, '/v1/maia/memories');
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { memories?: unknown };
      const list = Array.isArray(body.memories) ? body.memories.map(readMemory).filter((m): m is Memory => m !== null) : [];
      this.set({ memories: list, memoryLine: null });
    } catch {
      this.set({ memoryLine: "Couldn't reach Maia's memory. Try again in a moment." });
    }
  }

  async deleteMemory(memoryId: string): Promise<void> {
    try {
      const res = await maiaFetch(this.base, `/v1/maia/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      this.set({ memories: (this.get().memories ?? []).filter((m) => m.memoryId !== memoryId), memoryLine: null });
    } catch {
      this.set({ memoryLine: "That didn't delete. Try again in a moment." });
    }
  }

  async forgetEverything(): Promise<boolean> {
    try {
      const res = await maiaFetch(this.base, '/v1/maia/memories', { method: 'DELETE' });
      if (!res.ok) throw new Error(String(res.status));
      this.set({ memories: [], memoryLine: null });
      return true;
    } catch {
      this.set({ memoryLine: "That didn't go through. Try again in a moment." });
      return false;
    }
  }
}
