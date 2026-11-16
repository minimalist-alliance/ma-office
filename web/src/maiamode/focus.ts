// Desk Maia's model of now, the office's half (the focus shield; deskd API.md §23 "What reaches the member", `focus` in
// `agent.maia.observe`; CONCEPT.md §2.5): the pure parts, tested in `focus.test.ts`. Structure and timing only: which surface,
// desk, app and item are in front (ids), who the open thread is with (contact ids), when input started and stopped (two edges,
// never per key), whether the tab is seen, a random id for this browser, and completed actions. **Never** a URL, a title, a
// tab, a key, any text or the clipboard. It goes to the member's home desk only, inside observe (`focusSource.ts`).

export type Surface = 'room' | 'desk' | 'overview' | 'phone';
export type FocusScope = 'personal' | 'work' | 'guild' | 'all';
export interface FocusRef {
  kind: 'page' | 'thread' | 'channel' | 'todo' | 'folder' | 'run';
  id: string;
}
export interface FocusEvent {
  kind: 'sent' | 'todo_checked' | 'approval_decided' | 'saved' | 'page_left' | 'window_closed';
  at: number;
}

/** A key in the last 20 s is typing (deskd's `Focus.TYPING_MS`). */
export const TYPING_MS = 20_000;
/** No input for 2 minutes is idle. */
export const IDLE_MS = 120_000;
/** `lastAt` moves at the edges, else at most once a minute. */
export const LAST_EVERY_MS = 60_000;
/** A pause this long ends a stretch of input (`flowSince`). */
export const FLOW_GAP_MS = 300_000;
/** A completed action counts as a fine break once 5 s pass with no input after it. */
export const QUIET_MS = 5_000;
/** Input this soon after the action is the action itself (the click or key that did it), not input following it. */
export const ACTION_GRACE_MS = 300;
export const MAX_EVENTS = 10;
export const MAX_PEOPLE = 8;

const ITEM_KINDS = new Set(['page', 'thread', 'channel', 'todo', 'folder', 'run']);
const ITEM_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const DESK_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** Courier's contact ids: 26-character ULIDs (deskd's `Focus.contactId`). */
const CONTACT_ID = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const DEVICE = /^dv-[a-z0-9]{8,32}$/;
const CORE = new Set(['notebook', 'courier', 'todo', 'files', 'browser', 'agent', 'commons', 'maia']);
const AGENT_OR_APP = /^(agent|app):[A-Za-z0-9_-]{1,64}$/;

/** The closed enum (§23): the office's own apps, an agent's (`agent:<id>`), an installed app (`app:<id>`), else no app. */
export function focusApp(app: unknown): string | null {
  if (typeof app !== 'string') return null;
  if (CORE.has(app)) return app;
  // An installed app's id is reverse DNS (`app:org.example.notes`): its dots don't pass the desk's pattern, so it's no app
  // (STATUS.md asks whether the desk should take dots).
  return AGENT_OR_APP.test(app) ? app : null;
}

// ----- typing and idle: two edges, never per key

export interface InputState {
  typing: boolean;
  idle: boolean;
  lastAt: number;
  flowSince: number;
}

/**
 * The input clock. `key` and `input` are the capture-phase listeners' (a key; a press, a wheel, a touch or the pointer moving),
 * `tick` applies the timeouts. Each returns true when what's sent changed: typing starts at the first key and stops 20 s after the
 * last, idle starts after 2 minutes without input, `lastAt` moves at those edges and else at most once a minute, `flowSince` is
 * where the current stretch began (a 5-minute pause ends one).
 */
export class InputClock {
  private lastKey = Number.NEGATIVE_INFINITY;
  private lastInput: number;
  state: InputState;

  constructor(now: number) {
    this.lastInput = now;
    this.state = { typing: false, idle: false, lastAt: now, flowSince: now };
  }

  input(t: number): boolean {
    const s = this.state;
    let edge = false;
    let flow = s.flowSince;
    if (t - this.lastInput >= FLOW_GAP_MS) flow = t;
    this.lastInput = t;
    let idle = s.idle;
    if (idle) {
      idle = false;
      edge = true;
    }
    const lastAt = edge || t - s.lastAt >= LAST_EVERY_MS ? t : s.lastAt;
    const next = { ...s, idle, lastAt, flowSince: flow };
    const moved = next.idle !== s.idle || next.lastAt !== s.lastAt || next.flowSince !== s.flowSince;
    this.state = next;
    return moved;
  }

  key(t: number): boolean {
    this.lastKey = t;
    const wasTyping = this.state.typing;
    const moved = this.input(t);
    if (wasTyping) return moved;
    this.state = { ...this.state, typing: true, lastAt: t };
    return true;
  }

  /** The timeouts, at `t`. */
  tick(t: number): boolean {
    let s = this.state;
    let moved = false;
    if (s.typing && t - this.lastKey >= TYPING_MS) {
      s = { ...s, typing: false, lastAt: this.lastInput };
      moved = true;
    }
    if (!s.idle && t - this.lastInput >= IDLE_MS) {
      s = { ...s, idle: true, typing: false, lastAt: this.lastInput };
      moved = true;
    }
    this.state = s;
    return moved;
  }

  /** The tab went out of sight: whatever was being typed has stopped (no timer runs in a hidden tab). */
  hidden(): boolean {
    if (!this.state.typing) return false;
    this.state = { ...this.state, typing: false, lastAt: this.lastInput };
    return true;
  }

  /** When the next timeout changes something, else null. */
  nextAt(): number | null {
    const s = this.state;
    const ats = [s.typing ? this.lastKey + TYPING_MS : null, !s.idle ? this.lastInput + IDLE_MS : null].filter((x): x is number => x !== null);
    return ats.length ? Math.min(...ats) : null;
  }
}

// ----- completed actions: a fine break after 5 s with no input following, a closed window at once

export class FocusEvents {
  private pending: FocusEvent[] = [];
  private ready: FocusEvent[] = [];

  /** `window_closed` is ready at once (true); the rest wait out their 5 s. */
  add(kind: FocusEvent['kind'], t: number): boolean {
    if (kind === 'window_closed') {
      this.ready.push({ kind, at: t });
      this.ready = this.ready.slice(-MAX_EVENTS);
      return true;
    }
    this.pending.push({ kind, at: t });
    this.pending = this.pending.slice(-MAX_EVENTS);
    return false;
  }

  /** Input at `t`: an action still in its 5 s with input after it wasn't a break. */
  input(t: number): void {
    if (this.pending.length) this.pending = this.pending.filter((e) => t - e.at <= ACTION_GRACE_MS);
  }

  /** True when an action's 5 s passed with nothing after it: it's ready to send. */
  tick(t: number): boolean {
    const due = this.pending.filter((e) => t - e.at >= QUIET_MS);
    if (!due.length) return false;
    this.pending = this.pending.filter((e) => t - e.at < QUIET_MS);
    this.ready = [...this.ready, ...due].slice(-MAX_EVENTS);
    return true;
  }

  nextAt(): number | null {
    return this.pending.length ? Math.min(...this.pending.map((e) => e.at + QUIET_MS)) : null;
  }

  get waiting(): boolean {
    return this.ready.length > 0;
  }

  /** What's ready, once: each observe carries the actions since the last one. */
  take(): FocusEvent[] {
    const out = this.ready;
    this.ready = [];
    return out;
  }
}

// ----- the block

export interface FocusFacts {
  surface: Surface;
  scope: FocusScope;
  deskId: string | null;
  /** The desk in front's kind: a Guild Desk sends no ids (other people use it). */
  deskKind: string | null;
  app: string | null;
  item: FocusRef | null;
  people: { deskId: string; contactId: string }[];
  input: InputState;
  call: boolean;
  share: boolean;
  visible: boolean;
  device: string;
  events: FocusEvent[];
}

const time = (n: number): number => Math.max(0, Math.round(n));

/** The `focus` block exactly as §23 has it, every field checked and cut to its limits here (the desk checks again). */
export function focusBlock(f: FocusFacts): Record<string, unknown> {
  const guild = f.deskKind === 'guild' || f.scope === 'guild';
  const out: Record<string, unknown> = { surface: f.surface, scope: guild ? 'guild' : f.scope };
  if (!guild) {
    if (f.deskId && DESK_ID.test(f.deskId)) out['deskId'] = f.deskId;
    const app = focusApp(f.app);
    if (app) out['app'] = app;
    if (app && app !== 'browser' && f.item && ITEM_KINDS.has(f.item.kind) && ITEM_ID.test(f.item.id)) out['item'] = { kind: f.item.kind, id: f.item.id };
    const seen = new Set<string>();
    const people = f.people.filter((p) => {
      const key = `${p.deskId}|${p.contactId}`;
      if (!DESK_ID.test(p.deskId) || !CONTACT_ID.test(p.contactId) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (people.length) out['people'] = people.slice(0, MAX_PEOPLE).map((p) => ({ deskId: p.deskId, contactId: p.contactId }));
  }
  out['input'] = { typing: f.input.typing, idle: f.input.idle, lastAt: time(f.input.lastAt), flowSince: time(f.input.flowSince) };
  out['call'] = f.call;
  out['share'] = f.share;
  out['visible'] = f.visible;
  if (DEVICE.test(f.device)) out['device'] = f.device;
  if (f.events.length) out['events'] = f.events.slice(-MAX_EVENTS).map((e) => ({ kind: e.kind, at: time(e.at) }));
  return out;
}

// ----- this browser's id, and a folder's

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const DEVICE_KEY = 'ma.maia.device.v1';

/** `dv-` and 16 random characters: a fresh one, from the browser's CSPRNG. */
export function newDeviceId(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return `dv-${Array.from(rand(16), (b) => ALPHA[b % ALPHA.length]).join('')}`;
}

/** This browser's id, kept in localStorage; a storage that can't be used gets one for this page. */
export function deviceId(store: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): string {
  try {
    const kept = store?.getItem(DEVICE_KEY) ?? null;
    if (kept && DEVICE.test(kept)) return kept;
    const id = newDeviceId();
    store?.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return newDeviceId();
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** The first 80 bits of `bytes`, as 16 base32 characters. */
export function base32x16(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 16) break;
  }
  return out;
}

/** A Files folder as the desk sees it: `h-` and 16 base32 characters of the SHA-256 of its path, made here, so no name travels. */
export async function folderRef(path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return `h-${base32x16(new Uint8Array(digest))}`;
}
