// Courier's tile and its count (the launch plan's Wave 3.4; §5 "The tile", §2.11 "While the desk sleeps"). Its own lazy chunk:
// the office loads it only while Courier's switch is on (`door.ts`), so the first load carries none of it.
// - **On a desk that's open:** People's unread messages plus Requests' new senders, as the desk counts them (`courier.status`),
//   read again on each `courier.changed`; and up to three senders' first names from People's unread conversations, the
//   member's own names for them, never a subject, a stranger's display name or an address. The tile hides the names under the
//   privacy shield, as it hides every widget's words.
// - **While a desk sleeps:** the platform's count of sealed messages waiting for it (`GET /v1/me/courier`'s `pending`) is added
//   to the last count the desk itself gave. A desk that answers has collected them (it does at every start), so its own word
//   then stands alone. Nothing here wakes a desk.
// Counts follow ADR 0125: the badge's blue, never red, "9+" past nine (the tile draws it).
import type { DeskLink } from '../../desk/deskLink';
import { useLayoutStore } from '../../state/layoutStore';
import { openWindow } from '../../state/windowStore';
import { loadRegistry } from './address';
import { pendingInvite } from './invite';
import { firstName } from './model';
import { readList, readStatus } from './wire';

export interface CourierTile {
  badge: number;
  /** Up to three first names, newest first. */
  names: string[];
}

/** The office's word on a tile (`noteApp` in `desk/liveStore.ts`): the count, and the names as the widget's title. */
type Sink = (deskId: string, app: 'courier', said: { badge: number; widget?: { title: string } }) => void;
type Link = Pick<DeskLink, 'deskId' | 'call' | 'subscribe'>;

const own = new Map<string, CourierTile>();
const waiting = new Map<string, number>();
let sink: Sink = () => undefined;

function emit(deskId: string): void {
  const t = own.get(deskId) ?? { badge: 0, names: [] };
  const title = namesLine(t.names);
  sink(deskId, 'courier', { badge: t.badge + (waiting.get(deskId) ?? 0), widget: title ? { title } : undefined });
}

/** The tile's words: "Dana", "Dana and Sam", "Dana, Sam and Priya". */
export function namesLine(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What the desk's answers make of the tile. Pure, for the tests. */
export function tileOf(status: unknown, people: unknown): CourierTile {
  const s = readStatus(status);
  if (s.state !== 'on') return { badge: 0, names: [] };
  const badge = Math.max(0, s.lanes.people.unread) + Math.max(0, s.lanes.requests.count);
  const names: string[] = [];
  for (const r of readList(people).rows) {
    if (names.length === 3) break;
    if (r.unread <= 0 || r.kind !== 'direct') continue;
    // The member's name for them, or the name the store kept for a known contact: never an address, never a stranger's.
    const c = r.contacts[0];
    const name = c && c.known ? firstName(c.name) : '';
    if (name && !names.includes(name)) names.push(name);
  }
  return { badge, names };
}

/** Watches one desk's Courier for its tile. Returns a stop. A desk without Courier (an older deskd, a teen's) says nothing. */
export function watchCourierTile(link: Link, onTile: Sink): () => void {
  sink = onTile;
  let stopped = false;
  let reading = false;
  let again = false;
  const read = (): void => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    Promise.all([link.call('courier.status', {}), link.call('courier.list', { lane: 'people', limit: 20 })])
      .then(
        ([status, people]) => {
          if (stopped) return;
          own.set(link.deskId, tileOf(status, people));
          // The desk answered, so it has collected what waited for it on the platform.
          waiting.delete(link.deskId);
          emit(link.deskId);
        },
        () => undefined,
      )
      .finally(() => {
        reading = false;
        if (again) {
          again = false;
          read();
        }
      });
  };
  const off = link.subscribe('courier.changed', read, () => undefined);
  watchWaiting(onTile);
  // An invite link's Add for this desk (the account site's `/c/<name>`): Courier opens on it, and adds the person there. The
  // desk's layout may still be on its way, so it waits for the Courier tile.
  let offLayout = (): void => undefined;
  if (pendingInvite(link.deskId)) {
    const tryOpen = (): boolean => {
      const item = useLayoutStore.getState().desks[link.deskId]?.items.find((i) => i.app === 'courier');
      if (item) openWindow(link.deskId, 'courier', item.id);
      return !!item;
    };
    if (!tryOpen()) {
      offLayout = useLayoutStore.subscribe(() => {
        if (tryOpen()) offLayout();
      });
    }
  }
  return () => {
    stopped = true;
    off();
    offLayout();
    // Nothing of this desk's stays once its link goes (a sign-out, another member in this tab: Security's CU-I2).
    own.delete(link.deskId);
    waiting.delete(link.deskId);
  };
}

let polling: (() => void) | null = null;
const WAITING_EVERY_MS = 10 * 60_000;

/**
 * The platform's count of sealed messages waiting for each desk, asked at the start and every 10 minutes while the tab is
 * shown. Started once; the registry answering nothing (an older platform, Courier paused) changes nothing.
 */
export function watchWaiting(onTile: Sink, every = WAITING_EVERY_MS): () => void {
  sink = onTile;
  if (polling) return polling;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = (): void => {
    if (stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void loadRegistry().then((r) => {
        if (stopped || !r?.enabled) return;
        for (const d of r.desks) {
          if ((waiting.get(d.deskId) ?? 0) === d.pending) continue;
          waiting.set(d.deskId, d.pending);
          emit(d.deskId);
        }
      });
    }
    timer = setTimeout(ask, every);
  };
  ask();
  polling = () => {
    stopped = true;
    clearTimeout(timer);
    polling = null;
  };
  return polling;
}
