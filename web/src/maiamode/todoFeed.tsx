// The To-do column's own half: each of the member's desks' To-do short list (Needs you, `todo.list {view: "needs_you"}`, and
// `todo.summary`'s new-from-agents count), read over that desk's open session and again when its `todo` topic says something
// changed (deskd API.md §22). Reads only: nothing here wakes a desk or writes. Built in the browser, never by a model
// (CONCEPT.md §3); titles are untrusted plain text (`model.ts` `todoItems`).
import { useEffect, useState, type ReactNode } from 'react';
import { rpcTodoClient, toTodoError } from '../apps/todo/client';
import { useDeskLink, useLive } from '../desk/liveStore';
import { useSession } from '../platform/session';
import { useDeskStore } from '../state/deskStore';
import { todoItems, type ColumnItem } from './model';

const noIdem = (): string => crypto.randomUUID(); // reads only; a write would need the window's own

function DeskTodo({ deskId, name, onItems }: { deskId: string; name: string; onItems: (deskId: string, items: ColumnItem[]) => void }) {
  const live = useLive(deskId);
  const link = useDeskLink(deskId);
  const open = live.link === 'open' && link !== null;
  useEffect(() => {
    if (!open || !link) {
      onItems(deskId, []);
      return undefined;
    }
    const c = rpcTodoClient(link, noIdem);
    let gone = false;
    let timer = 0;
    const read = async (): Promise<void> => {
      try {
        const [needs, summary] = await Promise.all([c.list({ view: 'needs_you' }), c.summary()]);
        if (!gone) onItems(deskId, todoItems({ id: deskId, name }, needs.items, summary.newFromAgents, Date.now(), needs.zone || summary.zone || 'UTC'));
      } catch (e) {
        // An older deskd with no To-do, or a refusal: nothing from this desk.
        if (!gone && toTodoError(e).code !== 'offline') onItems(deskId, []);
      }
    };
    const soon = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void read(), 150);
    };
    void read();
    const off = c.watch(soon, () => undefined);
    // A to-do's two hours pass with no event: look again each minute while the room is up.
    const tick = window.setInterval(soon, 60_000);
    return () => {
      gone = true;
      window.clearTimeout(timer);
      window.clearInterval(tick);
      off();
    };
  }, [deskId, name, open, link, onItems]);
  return null;
}

/** Every own desk's To-do lines, merged here in the browser. Guild Desks aren't the member's own and bring nothing. */
export function useTodoColumn(wanted = true): { items: ColumnItem[]; feeds: ReactNode } {
  const [byDesk, setByDesk] = useState<Record<string, ColumnItem[]>>({});
  const desks = useDeskStore((s) => s.desks);
  const on = useSession((s) => s.config?.todo?.enabled !== false) && wanted;
  const own = on ? desks.filter((d) => d.kind !== 'guild') : [];
  const [onItems] = useState(() => (deskId: string, items: ColumnItem[]) => setByDesk((b) => (sameItems(b[deskId], items) ? b : { ...b, [deskId]: items })));
  const items = own.flatMap((d) => byDesk[d.id] ?? []);
  return { items, feeds: own.map((d) => <DeskTodo key={d.id} deskId={d.id} name={d.name} onItems={onItems} />) };
}

function sameItems(a: ColumnItem[] | undefined, b: ColumnItem[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return !!y && x.id === y.id && x.title === y.title && x.meta === y.meta && x.urgency === y.urgency;
  });
}
