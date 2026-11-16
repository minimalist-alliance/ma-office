// The office's one person key for all of the member's desks (Documents; deskd API.md §25 `docs.key.get` and `docs.key.set`,
// the concept's §2.1 "Person keys"). Each desk turns a sender's address into a person key with a secret; when every desk has
// the same secret, "from Rosa" is the same key on Work and Personal, so the home desk's ranking, Maia's finding and the
// Documents window's People match across desks without an address ever leaving the desk that holds it.
//
// The office makes the secret once (32 random bytes, in this browser) and gives it to each of the member's own open desks
// over that desk's own channel. It's never stored here, never sent to the Platform, a model or a push: a desk opened later,
// or another browser, reads it back from a desk that already has it. Two browsers that made one at once agree on the
// earliest (each desk keeps when its secret was first made), checked again once a little later.
import type { DeskLink } from '../../desk/deskLink';
import { linkOf, useLiveStore } from '../../desk/liveStore';
import { useDeskStore } from '../../state/deskStore';
import { newIdem } from '../../../agent/src/client/agentClient';
import { syncKeys, type KeyDesk } from './personKeySync';

/** A pass waits this long after the member's open desks change (links settle as the office opens). */
export const SETTLE_MS = 3_000;
/** After a pass that gave the secret to a desk, one more pass this much later: two browsers at once agree. */
export const RECHECK_MS = 20_000;

const keyDesk = (deskId: string, link: DeskLink): KeyDesk => ({
  deskId,
  call: (m, p, idem) => link.call(m as never, p, idem ? { idem, deadlineMs: 15_000 } : { deadlineMs: 15_000 }),
});

let stop: (() => void) | null = null;

/** Started with the office (once the page is idle): a pass whenever a new one of the member's own desks opens its link. */
export function startPersonKeys(): () => void {
  if (stop) return stop;
  let seen = '';
  let timer = 0;
  let running = false;
  let again = false;
  const openOwn = (): string[] => {
    const live = useLiveStore.getState().desks;
    return useDeskStore
      .getState()
      .desks.filter((d) => d.kind !== 'guild' && !d.removed && live[d.id]?.link === 'open' && linkOf(d.id))
      .map((d) => d.id)
      .sort();
  };
  const pass = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const desks = openOwn().flatMap((id) => {
        const link = linkOf(id);
        return link ? [keyDesk(id, link)] : [];
      });
      const given = await syncKeys(desks, newIdem);
      if (given > 0) schedule(RECHECK_MS);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule(SETTLE_MS);
      }
    }
  };
  const schedule = (ms: number): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void pass(), ms);
  };
  const check = (): void => {
    const now = openOwn();
    // Only a desk newly open asks for a pass (one closing changes nothing).
    const before = new Set(seen ? seen.split(',') : []);
    seen = now.join(',');
    if (now.some((id) => !before.has(id)) && now.length > 0) schedule(SETTLE_MS);
  };
  const offLive = useLiveStore.subscribe(check);
  const offList = useDeskStore.subscribe(check);
  check();
  stop = () => {
    offLive();
    offList();
    window.clearTimeout(timer);
    stop = null;
  };
  return stop;
}
