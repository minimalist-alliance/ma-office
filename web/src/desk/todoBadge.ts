// To-do's tile count on a desk (deskd API.md section 22): `todo.summary`'s `badge` (overdue plus due today), read when the
// desk's `todo` topic says anything changed (its first snapshot included, so again after every reconnect), and again just
// after the desk's own midnight, since "due today" moves with the day and no event says so. deskd serves no `summary` topic
// (section 5), which is where the office used to wait for this, so a real desk's tile never had a count. A desk before
// section 22, or one that refuses the topic (a Guild Desk), says nothing, and the tile shows none, as before.
import type { DeskLink } from './deskLink';

type Link = Pick<DeskLink, 'call' | 'subscribe'>;

/** How long from `now` until just after the next midnight in `zone` (IANA), at least a minute; an hour if the zone can't be read. */
export function untilMidnight(now: number, zone: unknown): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: typeof zone === 'string' && zone ? zone : 'UTC', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
    const at = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const left = (86_400 - (at('hour') * 3600 + at('minute') * 60 + at('second'))) * 1000 - (now % 1000);
    return Math.max(60_000, left + 2_000);
  } catch {
    return 3_600_000;
  }
}

/** Watches one desk's To-do count; `onBadge` hears each read, and none is asked while `on()` says no. Returns a stop. */
export function watchTodoBadge(link: Link, onBadge: (badge: number) => void, on: () => boolean = () => true, clock: () => number = Date.now): () => void {
  let stopped = false;
  let reading = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (): void => {
    if (stopped || !on()) return; // the kill switch, read at each event (Security's RF-I1)
    if (reading) {
      again = true; // one more read after this one, however many changes came meanwhile
      return;
    }
    reading = true;
    link.call('todo.summary', {}).then(
      (r) => {
        if (stopped) return;
        const badge = Number(r?.['badge']);
        if (Number.isFinite(badge) && badge >= 0) onBadge(Math.floor(badge));
        clearTimeout(timer);
        timer = setTimeout(read, untilMidnight(clock(), r?.['zone']));
      },
      () => undefined, // not open, an older deskd, a refusal: the next event asks again, and the count stands
    ).finally(() => {
      reading = false;
      if (again) {
        again = false;
        read();
      }
    });
  };
  const off = link.subscribe('todo', read, () => undefined);
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
  };
}
