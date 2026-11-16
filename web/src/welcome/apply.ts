// The apply queue (CONCEPT.md §5.3): what "Looks right" set up, applied through the member's own session on each desk as that
// desk comes up, with an `idem` per item so nothing applies twice, one retry, and "Didn't take · Try again" after that. Nothing
// blocks the reveal. Items for a desk still building wait in this browser (`ma.welcome.v1`, one of the layout mirror's keys,
// so a sign-out or another member wipes it) for up to a day, and apply the next time the office is open with that desk up.
// To-dos and the names typed under Q4 live only here and on the desk: never the Platform, never a model.
import { create } from 'zustand';
import { linkOf } from '../desk/liveStore';
import { patchDeskName } from '../platform/api';
import { useSession } from '../platform/session';
import { onMemberChange } from '../platform/auth';
import { layoutMirrorWritable } from '../state/layoutStore';
import type { Helper } from './plan';
import { cantRun } from './refusals';

export const QUEUE_KEY = 'ma.welcome.v1';
const DAY_MS = 86_400_000;

export type ItemState = 'pencilled' | 'applying' | 'done' | 'failed';

interface Base {
  id: string;
  /** The member who queued it: only theirs ever applies (Security's WEL-3). */
  who: string | null;
  deskId: string;
  state: ItemState;
  tries: number;
  /** The `idem` sent with every try (deskd API.md §4), so a lost reply's retry is the same call. */
  idem: string;
}
export type Item =
  | (Base & { kind: 'helper'; helper: Helper; agentId?: string; needsKey?: boolean; skipped?: boolean })
  | (Base & { kind: 'todo'; title: string })
  | (Base & { kind: 'maia'; attention: Record<string, number> | null; notes: boolean })
  | (Base & { kind: 'reach'; reach: Record<string, unknown> })
  | (Base & { kind: 'notes'; doc: Record<string, unknown> })
  | (Base & { kind: 'rename'; name: string; was: string });

export type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'state' | 'tries' | 'idem' | 'who'> : never) : never;

interface QueueState {
  items: Item[];
}
export const useQueue = create<QueueState>(() => ({ items: [] }));

const who = (): string | null => useSession.getState().me?.userId ?? null;

function save(): void {
  if (!layoutMirrorWritable()) return;
  const me = who();
  const items = useQueue.getState().items.filter((i) => i.state !== 'done' && i.who === me);
  try {
    if (!items.length) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify({ who: who(), at: Date.now(), items }));
  } catch {
    /* this page keeps them */
  }
}

/** What an earlier page left for desks that weren't up, for this member only, within a day. */
export function restoreQueue(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? 'null') as { who?: unknown; at?: unknown; items?: unknown } | null;
    if (!raw || raw.who !== who() || typeof raw.at !== 'number' || Date.now() - raw.at > DAY_MS || !Array.isArray(raw.items)) {
      if (raw) localStorage.removeItem(QUEUE_KEY);
      return;
    }
    const items = (raw.items as Item[]).filter((i) => i && typeof i.id === 'string' && typeof i.deskId === 'string' && i.who === raw.who).map((i) => ({ ...i, state: i.state === 'applying' ? 'pencilled' : i.state }) as Item);
    if (items.length) useQueue.setState({ items });
  } catch {
    /* nothing kept */
  }
}

export function enqueue(items: readonly NewItem[]): void {
  const me = who();
  // Each run's ids are its own, so a redo never patches the last run's lines.
  const run = crypto.randomUUID().slice(0, 8);
  const added = items.map((i) => ({ ...i, id: `${i.id}-${run}`, who: me, state: 'pencilled', tries: 0, idem: crypto.randomUUID() }) as Item);
  useQueue.setState((s) => ({ items: [...s.items, ...added] }));
  save();
  watchQueue();
  void pump();
}

function update(id: string, patch: Partial<Item>): void {
  useQueue.setState((s) => ({ items: s.items.map((i) => (i.id === id ? ({ ...i, ...patch } as Item) : i)) }));
  save();
}

/** A desk's session is open: its items can go. */
const ready = (deskId: string): boolean => linkOf(deskId)?.status() === 'open';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});


/** One item, through the member's own session. Throws on a refusal. */
async function run(item: Item): Promise<Partial<Item>> {
  if (item.kind === 'rename') {
    await patchDeskName(item.deskId, item.name);
    return {};
  }
  const link = linkOf(item.deskId);
  if (!link) throw new Error('no link');
  const call = (method: string, params: Record<string, unknown>, idem: string) => (link.call as (m: string, p: Record<string, unknown>, o: { idem: string }) => Promise<unknown>)(method, params, { idem });
  const read = (method: string, params: Record<string, unknown> = {}) => (link.call as (m: string, p: Record<string, unknown>) => Promise<unknown>)(method, params);
  switch (item.kind) {
    case 'helper': {
      const h = item.helper;
      let agentId = item.agentId;
      if (!agentId) {
        // No key: where the desk offers MA's credits and the member has some, a new helper takes them (API.md §24). Where it
        // couldn't run (no credits to use and no key), the desk makes nothing (`ifRunnable`, `cant_run`), and the reveal says
        // so in one line: no dead agents on the desk (the owner's two "snowflakes", Nov 15).
        let made: Record<string, unknown>;
        try {
          made = obj(obj(await call('agent.create', { name: h.name, purpose: h.purpose, ifRunnable: true }, item.idem))['agent']);
        } catch (e) {
          if (cantRun(e)) return { skipped: true } as Partial<Item>;
          throw e;
        }
        agentId = typeof made['id'] === 'string' ? made['id'] : undefined;
        if (!agentId) throw new Error('no agent id');
        update(item.id, { agentId } as Partial<Item>);
      }
      // The first save carries every app and every switch; all asking first (§5.2: auto-approve off).
      await call('agent.access.set', { agentId, apps: h.apps, auto: { notebook: null, files: null, todos: false } }, `${item.idem}-access`);
      const agent = obj(obj(await read('agent.get', { agentId }))['agent']);
      // `binding` is null while the helper is dormant for want of a key (`no_key`).
      return { agentId, needsKey: !agent['binding'] } as Partial<Item>;
    }
    case 'todo':
      await call('todo.add', { title: item.title }, item.idem);
      return {};
    case 'maia': {
      await call('agent.maia.set', { on: true, disclosure: 'maia-mode-v2', homeDeskId: item.deskId, ...(item.attention ? { attention: item.attention } : {}) }, item.idem);
      const maia = obj(obj(await read('agent.maia.get'))['maia']);
      const tabId = typeof maia['notesTabId'] === 'string' ? maia['notesTabId'] : null;
      // Her access, saved from the member's own session as the room's first-run sheet does (API.md §23 "Her access"); Q8 says
      // whether she files notes and to-dos without asking.
      await call(
        'agent.access.set',
        { agentId: 'maia', apps: { notebook: true, files: false, browser: false, courier: false, todos: true }, auto: { notebook: item.notes && tabId ? { tabId } : null, files: null, todos: item.notes } },
        `${item.idem}-access`,
      );
      return {};
    }
    case 'reach':
      await call('agent.maia.reach.set', item.reach, item.idem);
      return {};
    case 'notes': {
      const tree = obj(await read('notebook.tree'));
      const tabs = Array.isArray(tree['tabs']) ? (tree['tabs'] as Record<string, unknown>[]) : [];
      let tabId = tabs.map((t) => t['id']).find((id): id is string => typeof id === 'string');
      // A new desk's Notebook may have no notebook yet: one is made, as the Notebook itself does on first use.
      if (!tabId) {
        const made = obj(obj(await call('notebook.notebook.create', {}, `${item.idem}-nb`))['tab']);
        tabId = typeof made['id'] === 'string' ? made['id'] : undefined;
      }
      if (!tabId) throw new Error('no tab');
      await call('notebook.page.import', { tabId, doc: item.doc, label: null }, item.idem);
      return {};
    }
  }
  return {};
}

let pumping = false;
/** Applies every pencilled item whose desk is up, one at a time; a failure is retried once, then said. */
export async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const me = who();
      const next = useQueue.getState().items.find((i) => i.state === 'pencilled' && i.who === me && (i.kind === 'rename' || ready(i.deskId)));
      if (!next) break;
      update(next.id, { state: 'applying' });
      try {
        const patch = await run(next);
        update(next.id, { ...patch, state: 'done' });
      } catch {
        const tries = next.tries + 1;
        update(next.id, { state: tries >= 2 ? 'failed' : 'pencilled', tries });
      }
    }
  } finally {
    pumping = false;
  }
}

/** "Try again" on a line that didn't take. */
export function retry(id: string): void {
  update(id, { state: 'pencilled', tries: 0 });
  void pump();
}

/** Pumps every 2 s while anything waits, for the page's life (the welcome's layer may be long gone); idle once all settle. */
let watch: number | undefined;
export function watchQueue(): () => void {
  if (watch === undefined) {
    watch = window.setInterval(() => {
      if (useQueue.getState().items.some((i) => i.state === 'pencilled')) void pump();
    }, 2000);
  }
  return () => undefined;
}

export const pendingFor = (deskId: string): Item[] => useQueue.getState().items.filter((i) => i.deskId === deskId && i.state !== 'done');
export const allSettled = (): boolean => useQueue.getState().items.every((i) => i.state === 'done' || i.state === 'failed');

/** Another member signed in on this browser: the last member's items go, unsaved (the mirror key went with the change). */
onMemberChange((_sub, before) => {
  if (before !== null) useQueue.setState({ items: [] });
});
