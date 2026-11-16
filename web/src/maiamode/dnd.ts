// Calls and screen shares as "do not disturb" for the focus shield (deskd API.md §23 `focus.call` and `focus.share`): while one
// is on, the home desk holds every card until it ends (the end is a coarse break), and an interrupt that would expire meanwhile
// only turns the held line's dot accent. Small and dependency-free, so a call's own code (a lazy chunk) can say so without
// pulling the shield in.
//
// Who says so today:
//   - a call: Commons voice on a Guild Desk while the member is in the room (`guild/CommonsBody.tsx`);
//   - a share: the office's Privacy shield (the member said someone else can see the screen: a screen share, a presentation, a
//     shoulder), read by `focusEnv.ts` from the view store.
// Any later call or share (Maia's voice, a screen share from the office) calls `setCall` or `setShare` with its own source name.
// Only "on" or "off" travels, never who, where or what.

type Kind = 'call' | 'share';

const on: Record<Kind, Set<string>> = { call: new Set(), share: new Set() };
const fns = new Set<() => void>();

function set(kind: Kind, source: string, value: boolean): void {
  const s = on[kind];
  const was = s.size > 0;
  if (value) s.add(source);
  else s.delete(source);
  if (was !== s.size > 0) for (const f of [...fns]) f();
}

/** A call from `source` started (true) or ended (false). */
export const setCall = (source: string, value: boolean): void => set('call', source, value);
/** A screen share from `source` started (true) or ended (false). */
export const setShare = (source: string, value: boolean): void => set('share', source, value);

export const callOn = (): boolean => on.call.size > 0;
export const shareOn = (): boolean => on.share.size > 0;

/** Called when a call or a share starts or ends (not on every source's change). */
export function onDnd(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}

/** Tests, and a change of member: nothing is on. */
export function resetDnd(): void {
  const was = callOn() || shareOn();
  on.call.clear();
  on.share.clear();
  if (was) for (const f of [...fns]) f();
}
