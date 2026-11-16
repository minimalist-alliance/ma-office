// What each app has open on each desk, and the actions a member completes there, for Desk Maia's model of now (the focus shield,
// deskd API.md §23 "What reaches the member"; `maiamode/focusSource.ts` reads it). Ids only: a Notebook page's id, a Courier
// channel's id and its contacts' ids, a to-do's id, a Files folder's path (hashed in the browser before anything is sent, so no
// name travels). Never a title, a URL, a tab, a key or any text. In the first load because the apps' own chunks write to it: a
// Map and two sets of listeners, nothing else, and nothing runs unless the shield listens.

export type FocusItemKind = 'page' | 'thread' | 'channel' | 'todo' | 'folder' | 'run';
export type FocusEventKind = 'sent' | 'todo_checked' | 'approval_decided' | 'saved' | 'page_left';

/** An app's open item: an id, or a Files folder's path (`focusSource` hashes it). */
export type FocusItemIn = { kind: Exclude<FocusItemKind, 'folder'>; id: string } | { kind: 'folder'; path: string };
export interface FocusPerson {
  deskId: string;
  contactId: string;
}
export interface FocusEntry {
  item: FocusItemIn | null;
  people: FocusPerson[];
}

const entries = new Map<string, FocusEntry>();
const changed = new Set<() => void>();
const happened = new Set<(kind: FocusEventKind) => void>();

/** What `app` has open on `deskId` now (null when nothing), and the people of it (Courier's open channel). */
export function setFocusItem(deskId: string, app: string, item: FocusItemIn | null, people: FocusPerson[] = []): void {
  const key = `${deskId}|${app}`;
  const before = entries.get(key);
  const same = before && JSON.stringify(before) === JSON.stringify({ item, people });
  if (same || (!before && !item && !people.length)) return;
  if (!item && !people.length) entries.delete(key);
  else entries.set(key, { item, people });
  for (const f of changed) f();
}

export const focusEntryOf = (deskId: string, app: string): FocusEntry | undefined => entries.get(`${deskId}|${app}`);

/** A completed action (a message sent, a to-do checked, an approval decided, a file saved, a page left for another). */
export function noteFocusEvent(kind: FocusEventKind): void {
  for (const f of happened) f(kind);
}

/** The shield's listener: what's open changed, or an action completed. Returns the unsubscribe. */
export function watchFocusItems(onChange: () => void, onEvent: (kind: FocusEventKind) => void): () => void {
  changed.add(onChange);
  happened.add(onEvent);
  return () => {
    changed.delete(onChange);
    happened.delete(onEvent);
  };
}

/** A change of member in the tab: nothing of the last one's stays. */
export function forgetFocusItems(): void {
  entries.clear();
}
