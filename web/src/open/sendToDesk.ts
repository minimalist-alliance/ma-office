// Send to my desk (#9, S-141): opening a link in a new tab of one desk's Browser, without opening the Browser window on
// this device (a phone that shares a link to read later shouldn't start a stream). The spec's runner:
//   1. wake the desk;
//   2. wait for its link to be open, up to 120 s;
//   3. `browser.tab.open {url, start: true}`, with one `idem` across every retry and Try again (deskd API.md section 10);
//   4. while deskd doesn't take `start` (it answers `unavailable {reason: "chromium"}`, as Chromium isn't up), today's order:
//      open the Browser window, which starts Chromium, then send the tab once it's up. The done line reads the same.
// Its own chunk, with the sheet and the notice (`OpenLayer.tsx`). The desk list and the links are the main bundle's.
import { create } from 'zustand';
import type { DeskLink } from '../desk/deskLink';
import { uuidv7 } from '../desk/idem';
import { mutate } from '../browser/mutate';
import type { DeskInfo } from '../state/deskStore';
import type { LayoutDesk } from '../canvas/layout';

/** How long a desk may take to wake and connect before the notice says it couldn't. */
export const WAKE_WAIT_MS = 120_000;
/** The done line goes after this, unless it's hovered or has focus. */
export const DONE_SHOWN_MS = 12_000;

export type SendPhase = 'waking' | 'opening' | 'done' | 'failed';
/** Why it didn't open: the desk didn't wake, its Browser blocks the site (`forbidden {reason: "blocked"}`), or anything else. */
export type SendWhy = 'wake' | 'blocked' | 'other';

export interface Send {
  id: number;
  deskId: string;
  url: string;
  /** `new URL().hostname`: punycode for an IDN. */
  host: string;
  /** One key for the whole action, Try again included. */
  idem: string;
  phase: SendPhase;
  why: SendWhy | null;
  /** The new tab, once deskd says. */
  tabId: string | null;
}

/** What the runner needs from the office, so it's tested without one. */
export interface SendDeps {
  desk(deskId: string): DeskInfo | undefined;
  link(deskId: string): DeskLink | null;
  /** The link is open: calls can go. */
  linkOpen(deskId: string): boolean;
  wake(deskId: string): void;
  /** Today's fallback: opening the Browser window starts Chromium on the desk. */
  openBrowserWindow(deskId: string): void;
  /** Resolves when `test()` holds, checked on every change of the desk list and the links, or false after `ms`. */
  waitFor(test: () => boolean, ms: number, stop: () => boolean): Promise<boolean>;
}

/** The desks a link can open on: the member's own Personal, Work and other desks with a Browser, that can be reached. Never a Guild Desk. */
export function sendableDesks(own: readonly DeskInfo[], layouts: Record<string, LayoutDesk | undefined>, closed: (deskId: string) => unknown = () => null): DeskInfo[] {
  return own.filter(
    (d) =>
      (d.kind === 'personal' || d.kind === 'work' || d.kind === 'custom') &&
      d.vm !== 'held' &&
      d.vm !== 'setting-up' &&
      d.vm !== 'removed' &&
      !d.removed &&
      !closed(d.id) &&
      (layouts[d.id]?.items.some((i) => i.app === 'browser') ?? false),
  );
}

/** Which desk the sheet chooses first: the last one used, else Personal, else the first. */
export function firstChoice(desks: readonly DeskInfo[], last: unknown): DeskInfo | null {
  return desks.find((d) => d.id === last) ?? desks.find((d) => d.kind === 'personal') ?? desks[0] ?? null;
}

/** A desk's state in the sheet (new, for Sales). Null: say nothing. */
export function deskStateWords(vm: DeskInfo['vm']): string | null {
  switch (vm) {
    case 'running':
      return 'Awake';
    case 'stopped':
      return 'Asleep, wakes to open this';
    case 'starting':
      return 'Waking up';
    case 'stopping':
      return 'Going to sleep, wakes to open this';
    case 'error':
      return 'Couldn’t wake last time, tries again';
    default:
      return null;
  }
}

/** The wake's words in the notice, the desk status line's own steps: "waking, 2 of 4", or "waiting for capacity". */
export function wakeWords(desk: Pick<DeskInfo, 'vm' | 'phase' | 'queuePosition'> | undefined): string {
  if (desk?.vm === 'starting' && desk.phase === 'queued') return 'waiting for capacity';
  const step = desk?.vm !== 'starting' ? 1 : desk.phase === 'booting' ? 2 : desk.phase === 'connecting' ? 3 : 1;
  return `waking, ${step} of 4`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const code = (err: unknown): string => (err as { code?: string } | null)?.code ?? '';
const reason = (err: unknown): unknown => (err as { details?: { reason?: unknown } } | null)?.details?.reason;

interface SendState {
  sends: Send[];
}

export const useSends = create<SendState>(() => ({ sends: [] }));

let nextId = 1;
/** Sends the member stopped or put away: their runs end without a word. */
const stopped = new Set<number>();

function patch(id: number, p: Partial<Send>): void {
  useSends.setState((s) => ({ sends: s.sends.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
}

const current = (id: number): Send | undefined => useSends.getState().sends.find((x) => x.id === id);

/** The runner itself, on one send. Exported for tests. */
export async function run(id: number, deps: SendDeps): Promise<void> {
  const s = current(id);
  if (!s) return;
  const gone = (): boolean => stopped.has(id);
  const { deskId, url, idem } = s;
  // The link open is the desk awake: calls can go.
  const awake = (): boolean => deps.linkOpen(deskId);
  const failedToWake = (): boolean => {
    const d = deps.desk(deskId);
    return !d || d.vm === 'held' || d.vm === 'removed' || d.vm === 'setting-up';
  };

  patch(id, { phase: awake() ? 'opening' : 'waking', why: null });
  deps.wake(deskId);
  if (!awake()) {
    const ok = await deps.waitFor(() => gone() || awake() || failedToWake(), WAKE_WAIT_MS, gone);
    if (gone()) return;
    if (!ok || !awake()) {
      patch(id, { phase: 'failed', why: 'wake' });
      return;
    }
    patch(id, { phase: 'opening' });
  }

  const link = deps.link(deskId);
  if (!link) {
    patch(id, { phase: 'failed', why: 'other' });
    return;
  }
  const open = (k: string): Promise<{ tabId: string }> => link.call('browser.tab.open', { url, start: true }, { idem: k });
  try {
    let tab: { tabId: string };
    try {
      tab = await open(idem);
    } catch (err) {
      if (gone()) return;
      if (code(err) !== 'unavailable' || reason(err) !== 'chromium') throw err;
      // A deskd without `start`: Chromium is only started by the Browser's stream. Today's order, then the tab.
      deps.openBrowserWindow(deskId);
      tab = await mutate(open, idem);
    }
    if (gone()) return;
    patch(id, { phase: 'done', tabId: typeof tab?.tabId === 'string' ? tab.tabId : null });
  } catch (err) {
    if (gone()) return;
    patch(id, { phase: 'failed', why: code(err) === 'forbidden' && reason(err) === 'blocked' ? 'blocked' : 'other' });
  }
}

let depsInUse: SendDeps | null = null;

/** The member pressed Open on <desk>: a new send, with its own key, under way at once. */
export function startSend(deskId: string, url: string, deps: SendDeps): number {
  depsInUse = deps;
  const id = nextId++;
  const send: Send = { id, deskId, url, host: hostOf(url), idem: uuidv7(), phase: 'waking', why: null, tabId: null };
  useSends.setState((s) => ({ sends: [...s.sends, send] }));
  void run(id, deps);
  return id;
}

/** Try again: the same send, the same key. */
export function retrySend(id: number): void {
  if (!depsInUse || !current(id)) return;
  stopped.delete(id);
  void run(id, depsInUse);
}

/** ✕: Stop while it waits (a tab already opened stays open), Dismiss once it's done or couldn't. */
export function endSend(id: number): void {
  stopped.add(id);
  useSends.setState((s) => ({ sends: s.sends.filter((x) => x.id !== id) }));
}

/** For tests. */
export function resetSends(): void {
  for (const s of useSends.getState().sends) stopped.add(s.id);
  useSends.setState({ sends: [] });
  depsInUse = null;
}
