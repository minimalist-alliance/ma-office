// In her room, the viewport's desk and app (`ui.ts` says when it opens and closes): what's in front for Desk Maia's model of now
// (the focus shield, `focusEnv.ts`). Ids only. Its own module so the room's `ui.ts` needs nothing of the observer.
let view: { deskId: string; app: string } | null = null;
const fns = new Set<() => void>();

export function setRoomViewport(v: { deskId: string; app: string } | null): void {
  view = v;
  for (const f of fns) f();
}
export const roomViewport = (): { deskId: string; app: string } | null => view;
export function watchRoomViewport(fn: () => void): () => void {
  fns.add(fn);
  return () => fns.delete(fn);
}
