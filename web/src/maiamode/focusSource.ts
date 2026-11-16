// The observer in every view (the focus shield; CONCEPT.md §2.5, deskd API.md §23 "What reaches the member"): while Desk Maia is
// on, the office tells her home desk what it sees on the member's own desks and what the member is doing, in the room, the desk
// view and the overview alike, not only while her room is mounted. One sender for the page: the room's source (`deskSource.ts`)
// and the desk view's held line (`shield/`) both hold it (`retainFocus`), and it lives while either does.
//
// It owns, for the home desk: the subscription to topic `agent.maia` (the room's list and `reach`, handed to the room and kept for
// the held line), the watchers of each own desk's agents, waits and To-do (lifted from `deskSource.ts`), and `agent.maia.observe`,
// sent whole on every change of the desks (at most twice a second), with the `focus` block debounced 2 s and only when it changes,
// a completed action at once once its 5 s have passed, and one keep-alive a minute. The `focus` block's facts come from the page
// (`focusEnv.ts`, installed by the office's start; a page without it sends observe as before). Nothing here goes to the Platform,
// any model or a push: only to the member's own home desk, over its data channel.
import { create } from 'zustand';
import { newIdem } from '../../agent/src/client/agentClient';
import { RpcAgentClient } from '../../agent/src/client/rpcAgentClient';
import type { Agent } from '../../agent/src/client/types';
import { courierOn } from '../apps/courier/door';
import { rpcTodoClient } from '../apps/todo/client';
import type { DeskLink } from '../desk/deskLink';
import { linkOf, useLiveStore } from '../desk/liveStore';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { focusBlock, type FocusFacts } from './focus';
import { minutesUntil, plain } from './model';
import { currentPrefs } from './prefs';
import { readReach, type Reach } from './reach';
import { cleanThreads, type ShieldThread } from './shieldSeams';
import { setTileCalm } from '../state/tileCalm';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "No observe in the last 2 minutes" is away (§23): one keep-alive well inside it. */
export const KEEP_ALIVE_MS = 60_000;
/** At most 2 observes a second (§23). */
export const OBSERVE_GAP_MS = 500;
/** What the member is doing settles for 2 s before it's sent (§23 `focus`). */
export const FOCUS_DEBOUNCE_MS = 2_000;
/** A desk's team view is read again at most this often, when an agent there stops working. */
const USAGE_GAP_MS = 20_000;
/** Courier's summary is read again at most this often, when Courier says something changed. */
export const COURIER_GAP_MS = 5_000;

// ----- what the office sees on each own desk, for her list (§23 `agent.maia.observe`)

export interface DeskSeen {
  agents: Agent[];
  /** `risk` and `untrusted` for the decision tray's confirm strip and its line (never the payload). */
  approvals: { approvalId: string; agentId: string; expiresAt: number; risk?: string; untrusted?: boolean }[];
  /** `from`: the source kind of a to-do that came from someone (the decision tray's "to-do from someone"). */
  todo: { newFromAgents: number; dueSoon: { id: string; title: string; dueAt: number; mine?: boolean; from?: string }[] } | null;
  /** From that desk's team view (§23 `agent.usage.summary`): each agent's headroom and usual task, counts and dollars only. */
  budget?: Record<string, Obj>;
  /** What her briefs cost on that desk today and this month, from its own ledger (`maiaBriefs`). */
  briefs?: Obj | null;
  /** Courier's summary for the shield (`courier.attention`): the People lane's unread threads, structure only. */
  courier?: { threads: ShieldThread[] } | null;
  /** The documents in front of the member there (deskd API.md §25 `docs.feed` with `front`): ids, places and times only. */
  docs?: Obj[];
}

const DOC_PLACES = new Set(['needs_you', 'maybe', 'read_later', 'records']);
const DOC_ID = /^d_[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A desk's `docs.feed {front: true}`, cut to the shield's `desks[].docs`: at most 50, ids, places and times, and what each
 * goes with (Courier's contact and channel, the agent that made it), so the shield's "close to what's open" can match it.
 * Ids only, each to its own shape (a title or a name can't pass as one: Security's SF2-I4); anything else is dropped.
 */
export function readDocsFront(raw: unknown): Obj[] {
  return arr(obj(raw)['items']).slice(0, 50).flatMap((i) => {
    const o = obj(i);
    const docId = str(o['docId'], 80);
    const place = str(o['place'], 20);
    if (!docId || !DOC_ID.test(docId) || !place || !DOC_PLACES.has(place)) return [];
    const dueAt = num(o['dueAt']);
    const at = num(o['at']);
    const contactIds = arr(o['contactIds']).filter((c): c is string => typeof c === 'string' && ULID.test(c)).slice(0, 8);
    const channelId = typeof o['channelId'] === 'string' && ULID.test(o['channelId']) ? o['channelId'] : null;
    const agentId = typeof o['agentId'] === 'string' && AGENT_ID.test(o['agentId']) ? o['agentId'] : null;
    return [
      {
        docId,
        place,
        ...(dueAt !== null && dueAt > 0 ? { dueAt } : {}),
        changed: o['changed'] === true,
        ...(at !== null && at > 0 ? { at } : {}),
        ...(contactIds.length ? { contactIds } : {}),
        ...(channelId ? { channelId } : {}),
        ...(agentId ? { agentId } : {}),
      },
    ];
  });
}

const HEADROOM = ['dayLeftMicroUsd', 'monthLeftMicroUsd', 'runMaxMicroUsd', 'briefMaxMicroUsd', 'perTaskMicroUsd', 'tasks', 'perBriefMicroUsd', 'briefs'] as const;

/** A desk's team view, cut to what her planning needs (counts and dollars only): per agent headroom, and her briefs' cost there. */
export function readUsage(raw: unknown): { budget: Record<string, Obj>; briefs: Obj | null } {
  const r = obj(raw);
  const budget: Record<string, Obj> = {};
  for (const a of arr(r['agents']).slice(0, 50)) {
    const o = obj(a);
    const id = str(o['agentId'], 64);
    const h = obj(o['headroom']);
    if (!id || !Object.keys(h).length) continue;
    const out: Obj = {};
    for (const k of HEADROOM) {
      const v = num(h[k]);
      out[k] = v !== null && v >= 0 ? v : null;
    }
    budget[id] = out;
  }
  const b = obj(r['maiaBriefs']);
  const briefs = num(b['todayMicroUsd']) === null ? null : { todayMicroUsd: num(b['todayMicroUsd']), monthMicroUsd: num(b['monthMicroUsd']) ?? 0, today: num(b['today']) ?? 0, month: num(b['month']) ?? 0 };
  return { budget, briefs };
}

const STATE: Partial<Record<string, string>> = { running: 'running', starting: 'starting', 'setting-up': 'starting', stopped: 'stopped', stopping: 'asleep', error: 'failed', held: 'stopped' };

/** The whole picture, each call (§23): the member's own desks only, never a Guild Desk, within its limits. */
export function observePayload(desks: readonly DeskInfo[], linkOpen: (id: string) => boolean, seen: (id: string) => DeskSeen | undefined, typing: boolean): Obj {
  return {
    desks: desks
      .filter((d) => d.kind !== 'guild')
      .slice(0, 20)
      .map((d) => {
        const s = seen(d.id);
        return {
          deskId: d.id, name: plain(d.name, 60), kind: d.kind, guild: false, state: STATE[d.vm] ?? 'stopped', link: linkOpen(d.id) ? 'open' : 'closed',
          agents: (s?.agents ?? []).slice(0, 50).map((a) => ({ agentId: a.id, name: plain(a.name, 60), status: a.status, statusDetail: a.statusDetail ?? null, approvalsPending: a.approvalsPending ?? 0, ...(s?.budget?.[a.id] ? { budget: s.budget[a.id] } : {}) })),
          approvals: (s?.approvals ?? []).slice(0, 100),
          stopped: [],
          todo: s?.todo ? { newFromAgents: s.todo.newFromAgents, dueSoon: s.todo.dueSoon.slice(0, 20) } : { newFromAgents: 0, dueSoon: [] },
          ...(s?.briefs ? { briefs: s.briefs } : {}),
          ...(s?.courier ? { courier: s.courier } : {}),
          ...(s?.docs?.length ? { docs: s.docs } : {}),
        };
      }),
    typing,
  };
}

/** The home desk: the one the desk names (`{maia}.home`), else Personal, else the first of the member's own. */
export const pickHome = (desks: readonly DeskInfo[], named: string | null): DeskInfo | null =>
  desks.find((d) => d.id === named && d.kind !== 'guild') ?? desks.find((d) => d.kind === 'personal') ?? desks.find((d) => d.kind !== 'guild') ?? null;

// ----- the page's facts (`focusEnv.ts`)

/** What the page knows of the member's now: everything of `focus` but the device and the events, which this keeps. */
export interface FocusEnv {
  facts(): Omit<FocusFacts, 'events'>;
  /** Calls `changed` when a fact changes, `event` for a completed action ready to send (the 5 s rule is the env's). */
  start(changed: () => void, event: (kind: FocusFacts['events'][number]['kind'], at: number) => void): () => void;
}

// ----- what the held line reads

export interface ReachState {
  /** `reach` from the room's snapshot, null while Desk Maia is off or the desk doesn't send it. */
  reach: Reach | null;
  /** The room's snapshot as it came (the list for To-do as a sheet), or null. */
  room: Obj | null;
  /** The home desk's link is open and her topic is subscribed. */
  ready: boolean;
  home: string | null;
  /** This browser's device id, once the page's facts are in. */
  device: string | null;
}
export const useReach = create<ReachState>(() => ({ reach: null, room: null, ready: false, home: null, device: null }));

// ----- the one sender

interface Wire {
  call(method: string, params?: Obj, idem?: string): Promise<unknown>;
  subscribe(topic: string, fn: (msg: Obj) => void, refused?: (code: string) => void): () => void;
}
const wireOf = (link: DeskLink): Wire => ({
  call: (m, p, idem) => link.call(m as never, p, idem ? { idem, deadlineMs: 15_000 } : { deadlineMs: 15_000 }),
  subscribe: (t, fn, r) => link.subscribe(t as never, fn as never, r),
});

/** A mutation keeps one key across a retry of a lost reply (deskd API.md §4). */
export async function mutateOn(w: Pick<Wire, 'call'>, method: string, params: Obj): Promise<unknown> {
  const key = newIdem();
  let last: unknown;
  for (let n = 0; n < 3; n += 1) {
    try {
      return await w.call(method, params, key);
    } catch (e) {
      last = e;
      const code = (e as { code?: unknown } | null)?.code;
      const details = (e as { details?: { reason?: unknown; mayHaveApplied?: boolean } } | null)?.details;
      // Her model not offered on this desk (`no_service`) is an answer, not a lost reply: asking again changes nothing.
      if (code === 'unavailable' && details?.reason === 'no_service') break;
      if (code !== 'deadline_exceeded' && code !== 'cancelled' && !(code === 'unavailable' && !details?.mayHaveApplied)) break;
    }
  }
  throw last;
}

export interface FocusHandle {
  release(): void;
  /** The room's snapshot of topic `agent.maia`, now (when one has come) and on every event. */
  onRoom(fn: (msg: Obj) => void): () => void;
  /** The home desk the desk itself names (`{maia}.home`): the sender follows it. */
  setHome(deskId: string | null): void;
  /** The member is typing in her chat (the observe's own `typing`, beside the focus block's edges). */
  setChatTyping(on: boolean): void;
  /** Send now (the room opening, a coarse moment), within the 2-a-second limit. */
  nudge(): void;
}

interface Core {
  retained: number;
  close(): void;
  setHome(id: string | null): void;
  setChatTyping(on: boolean): void;
  nudge(): void;
  onRoom(fn: (msg: Obj) => void): () => void;
  wire(): Wire | null;
  setEnv(env: FocusEnv | null): void;
}

let core: Core | null = null;
let pendingEnv: FocusEnv | null = null;

/** The page's facts (the office's start installs them once): every observe from then on carries `focus`. */
export function installFocusEnv(env: FocusEnv | null): void {
  pendingEnv = env;
  core?.setEnv(env);
}

/** Holds the one sender while the caller lives: the room's source, the office's start while Desk Maia is on. */
export function retainFocus(): FocusHandle {
  core ??= makeCore();
  const c = core;
  c.retained += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      c.retained -= 1;
      if (c.retained <= 0 && core === c) {
        core = null;
        c.close();
      }
    },
    onRoom: (fn) => c.onRoom(fn),
    setHome: (id) => c.setHome(id),
    setChatTyping: (on) => c.setChatTyping(on),
    nudge: () => c.nudge(),
  };
}

/** Whether the sender is running (a test's and the held line's question). */
export const focusRunning = (): boolean => core !== null;

let stand: ((method: string, params: Obj) => Promise<unknown>) | null = null;
/** `npm run dev` and the shell specs: a stand-in desk for `agent.maia.reach.*` (`mockSource.ts`'s `startMockReach`). */
export function setReachStandIn(fn: ((method: string, params: Obj) => Promise<unknown>) | null): void {
  stand = fn;
}

/** `agent.maia.reach.*` to the home desk: a mutation with `idem` (kept across a lost reply's retry), or a read. */
export function reachCall(method: string, params: Obj = {}, read = false): Promise<unknown> {
  if (stand) return stand(method, params);
  const w = core?.wire();
  if (!w) return Promise.reject(Object.assign(new Error('no home desk'), { code: 'unavailable' }));
  return read ? w.call(method, params) : mutateOn(w, method, params);
}

/** A call to another of the member's own desks (Courier's subject for a card's quote, a contact's name): reads only. */
export function deskRead(deskId: string, method: string, params: Obj): Promise<unknown> {
  const own = useDeskStore.getState().desks.some((d) => d.id === deskId && d.kind !== 'guild');
  const link = own && useLiveStore.getState().desks[deskId]?.link === 'open' ? linkOf(deskId) : null;
  if (!link) return Promise.reject(Object.assign(new Error('desk closed'), { code: 'unavailable' }));
  return link.call(method as never, params, { deadlineMs: 15_000 });
}

function makeCore(): Core {
  const roomFns = new Set<(msg: Obj) => void>();
  let latest: Obj | null = null;
  let named: string | null = null;
  let home: string | null = null;
  let w: Wire | null = null;
  let offTopic: (() => void) | null = null;
  let closed = false;
  let chatTyping = false;
  let env: FocusEnv | null = null;
  let offEnv: (() => void) | null = null;
  let events: FocusFacts['events'] = [];
  let lastFocus = '';

  // A stand-in desk (`npm run dev`, the shell specs) owns what the held line reads; the real desk's topic doesn't overwrite it.
  const setReach = (patch: Partial<ReachState>): void => {
    if (stand) {
      const rest = { ...patch };
      delete rest.reach;
      delete rest.room;
      if (Object.keys(rest).length) useReach.setState(rest);
    } else useReach.setState(patch);
  };

  // ----- the observer
  const seen = new Map<string, DeskSeen>();
  const watchers = new Map<string, () => void>();
  let lastSent = '';
  let lastAt = 0;
  let timer = 0;
  let debounce = 0;

  const focusNow = (): Obj | null => (env ? focusBlock({ ...env.facts(), events }) : null);

  const observe = (force = false): void => {
    if (!w || closed) return;
    window.clearTimeout(timer);
    const wait = OBSERVE_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) {
      timer = window.setTimeout(() => observe(force), wait);
      return;
    }
    const desks = useDeskStore.getState().desks;
    const live = useLiveStore.getState().desks;
    const payload = observePayload(desks, (id) => live[id]?.link === 'open', (id) => seen.get(id), chatTyping);
    const focus = focusNow();
    if (focus) payload['focus'] = focus;
    const text = JSON.stringify(payload);
    if (text === lastSent && !force && Date.now() - lastAt < KEEP_ALIVE_MS) {
      // Nothing new: the keep-alive still comes a minute after the last send.
      timer = window.setTimeout(() => observe(true), lastAt + KEEP_ALIVE_MS - Date.now());
      return;
    }
    lastSent = text;
    lastAt = Date.now();
    // The actions it carried are said once.
    if (events.length) events = [];
    void w.call('agent.maia.observe', payload).catch(() => undefined);
    timer = window.setTimeout(() => observe(true), KEEP_ALIVE_MS);
  };

  /** A fact of what the member is doing changed: sent once it has settled 2 s, and only if what's sent changed. */
  const focusChanged = (): void => {
    if (!env) return;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      const f = JSON.stringify(focusNow());
      if (f === lastFocus) return;
      lastFocus = f;
      observe();
    }, FOCUS_DEBOUNCE_MS);
  };
  const focusEvent = (kind: FocusFacts['events'][number]['kind'], at: number): void => {
    events = [...events, { kind, at }].slice(-10);
    window.clearTimeout(debounce);
    observe();
  };

  const setEnv = (next: FocusEnv | null): void => {
    offEnv?.();
    offEnv = null;
    env = next;
    lastFocus = '';
    if (env) {
      offEnv = env.start(focusChanged, focusEvent);
      setReach({ device: env.facts().device });
    }
    observe();
  };

  /** Each own desk's agents, waits and To-do, over its own open session. */
  const watchDesk = (deskId: string, link: DeskLink): (() => void) => {
    const client = new RpcAgentClient({ call: (m, p, o) => link.call(m as never, p, o), subscribe: (t, fn, r) => link.subscribe(t as never, fn as never, r) });
    const entry: DeskSeen = { agents: [], approvals: [], todo: null };
    seen.set(deskId, entry);
    let pending = -1;
    // Its team view, for her planning (§23): read now, and again when an agent stops working (its spend just changed), at most
    // once every USAGE_GAP_MS. Never on a timer of its own.
    let usageAt = 0;
    let usageTimer = 0;
    let working = 0;
    const readUsageNow = (): void => {
      usageAt = Date.now();
      void link.call('agent.usage.summary' as never, { days: 7 }, { deadlineMs: 15_000 }).then(
        (r) => {
          const u = readUsage(r);
          entry.budget = u.budget;
          entry.briefs = u.briefs;
          observe();
        },
        () => undefined,
      );
    };
    const readUsageSoon = (): void => {
      window.clearTimeout(usageTimer);
      const wait = USAGE_GAP_MS - (Date.now() - usageAt);
      if (wait <= 0) readUsageNow();
      else usageTimer = window.setTimeout(readUsageNow, wait);
    };
    readUsageNow();
    const readApprovals = (): void => {
      void client.listApprovals({ state: 'pending' }).then(
        (r) => {
          entry.approvals = r.approvals.flatMap((a) =>
            a.id && a.agentId
              ? [{ approvalId: a.id, agentId: a.agentId, expiresAt: (a as unknown as { expiresAt?: number }).expiresAt ?? 0, ...(typeof a.risk === 'string' && /^[a-z]{1,10}$/.test(a.risk) ? { risk: a.risk } : {}), untrusted: a.untrusted === true }]
              : [],
          );
          observe();
        },
        () => undefined,
      );
    };
    const offAgents = client.watchAgents((agents) => {
      entry.agents = agents;
      const busy = agents.filter((a) => a.status === 'working').length;
      if (busy < working) readUsageSoon();
      working = busy;
      const waiting = agents.reduce((n, a) => n + (a.approvalsPending ?? 0), 0);
      if (waiting !== pending) {
        pending = waiting;
        if (waiting > 0) readApprovals();
        else entry.approvals = [];
      }
      observe();
    });
    const todo = rpcTodoClient(link, newIdem);
    const readTodo = (): void => {
      void Promise.all([todo.summary(), todo.list({ view: 'needs_you' })]).then(
        ([s, needs]) => {
          const now = Date.now();
          const zone = needs.zone || s.zone || 'UTC';
          const dueSoon = needs.items.flatMap((i) => {
            const mins = i.due ? minutesUntil(i.due, now, zone) : null;
            // `mine`: the member made it (not an agent, not after reading something untrusted): only those count for
            // the shield's "Anything due today" (Security's FS-L2).
            // `from`: where a to-do that came from someone came from (its source kind), never its label or its ref.
            const from = i.source?.kind && i.source.kind !== 'member' ? i.source.kind : undefined;
            return mins !== null && mins >= -60 && mins <= 24 * 60 ? [{ id: i.id, title: plain(i.title, 60), dueAt: now + mins * 60_000, mine: i.by === 'member' && !i.untrusted, ...(from ? { from } : {}) }] : [];
          });
          entry.todo = { newFromAgents: s.newFromAgents, dueSoon };
          observe();
        },
        () => undefined,
      );
    };
    readTodo();
    const offTodo = todo.watch(() => readTodo(), () => undefined);
    // Courier's summary for the shield (deskd `courier.attention`, API.md §21): structure only, read again when Courier says
    // something changed, at most every COURIER_GAP_MS. Only while Courier's switch is on; a desk without it says nothing.
    let courierAt = 0;
    let courierTimer = 0;
    let offCourier = (): void => undefined;
    const readCourier = (): void => {
      courierAt = Date.now();
      void link.call('courier.attention' as never, {}, { deadlineMs: 15_000 }).then(
        (r) => {
          entry.courier = cleanThreads(r);
          observe();
        },
        () => {
          if (entry.courier) {
            entry.courier = null;
            observe();
          }
        },
      );
    };
    const readCourierSoon = (): void => {
      window.clearTimeout(courierTimer);
      courierTimer = window.setTimeout(readCourier, Math.max(0, COURIER_GAP_MS - (Date.now() - courierAt)));
    };
    if (courierOn()) {
      readCourier();
      offCourier = link.subscribe('courier.changed' as never, readCourierSoon as never, () => undefined);
    }
    // Its documents in front of the member (Documents, deskd API.md §25): read now and again on each `docs` event, at most once
    // every 2 s; a desk without Documents (or with it off) refuses, and sends none.
    let docsTimer = 0;
    let docsAt = 0;
    const readDocs = (): void => {
      docsAt = Date.now();
      void link.call('docs.feed' as never, { front: true }, { deadlineMs: 15_000 }).then(
        (r) => {
          entry.docs = readDocsFront(r);
          observe();
        },
        () => undefined,
      );
    };
    const readDocsSoon = (): void => {
      window.clearTimeout(docsTimer);
      docsTimer = window.setTimeout(readDocs, Math.max(0, FOCUS_DEBOUNCE_MS - (Date.now() - docsAt)));
    };
    readDocs();
    const offDocs = link.subscribe('docs' as never, (() => readDocsSoon()) as never, () => undefined);
    return () => {
      offAgents();
      offTodo();
      offCourier();
      offDocs();
      window.clearTimeout(docsTimer);
      window.clearTimeout(usageTimer);
      window.clearTimeout(courierTimer);
      seen.delete(deskId);
    };
  };
  const syncWatchers = (): void => {
    const live = useLiveStore.getState().desks;
    const own = useDeskStore.getState().desks.filter((d) => d.kind !== 'guild');
    for (const [id, off] of watchers) {
      if (!own.some((d) => d.id === id) || live[id]?.link !== 'open') {
        off();
        watchers.delete(id);
      }
    }
    for (const d of own) {
      const link = live[d.id]?.link === 'open' ? linkOf(d.id) : null;
      if (link && !watchers.has(d.id)) watchers.set(d.id, watchDesk(d.id, link));
    }
    observe();
  };

  // ----- the home desk and her topic
  const drop = (): void => {
    offTopic?.();
    offTopic = null;
    w = null;
    latest = null;
    setReach({ reach: null, room: null, ready: false });
    if (!stand) setTileCalm(null);
  };
  const connect = (link: DeskLink): void => {
    const wire = wireOf(link);
    w = wire;
    lastSent = '';
    offTopic = wire.subscribe('agent.maia', (msg) => {
      latest = msg;
      const room = obj(msg['room'] ?? msg);
      const reach = readReach(room['reach']);
      setReach({ reach, room, ready: true });
      // The office's tiles: still counts under the shield, the accent only where something may break through.
      if (!stand) setTileCalm(reach);
      for (const f of roomFns) f(msg);
    });
    setReach({ ready: true, home });
    syncWatchers();
  };
  const pick = (): void => {
    if (closed) return;
    const desk = pickHome(useDeskStore.getState().desks, named ?? currentPrefs().home);
    const id = desk?.id ?? null;
    if (id !== home) {
      if (w) drop();
      home = id;
      setReach({ home: id });
    }
    if (!desk) return;
    const link = useLiveStore.getState().desks[desk.id]?.link === 'open' ? linkOf(desk.id) : null;
    if (link && !w) connect(link);
    else if (!link && w) drop();
  };
  const offLive = useLiveStore.subscribe(() => {
    pick();
    syncWatchers();
  });
  const offList = useDeskStore.subscribe(() => {
    pick();
    syncWatchers();
  });

  // The page's facts first, so the first observe already carries `focus`.
  if (pendingEnv) setEnv(pendingEnv);
  pick();
  syncWatchers();

  return {
    retained: 0,
    close() {
      if (closed) return;
      closed = true;
      window.clearTimeout(timer);
      window.clearTimeout(debounce);
      offEnv?.();
      offEnv = null;
      for (const off of watchers.values()) off();
      watchers.clear();
      offLive();
      offList();
      drop();
      roomFns.clear();
      setReach({ home: null });
    },
    setHome(id) {
      if (id === named) return;
      named = id;
      pick();
    },
    setChatTyping(on) {
      chatTyping = on;
    },
    nudge() {
      observe(true);
    },
    onRoom(fn) {
      roomFns.add(fn);
      if (latest) fn(latest);
      return () => roomFns.delete(fn);
    },
    wire: () => w,
    setEnv,
  };
}
