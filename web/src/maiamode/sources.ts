// Which `RoomSource` the room talks to: Desk Maia over the home desk in a production build (`deskSource.ts`), the stand-in
// (`mockSource.ts`) under `npm run dev` and the shell specs, which a production build never contains.
import { useDeskStore } from '../state/deskStore';
import type { RoomSource } from './source';

/** The member's own desks, never a Guild Desk (other people see it, CONCEPT.md §4). */
const ownDesks = (): { id: string; name: string }[] => useDeskStore.getState().desks.filter((d) => d.kind !== 'guild');

export async function makeSource(): Promise<RoomSource> {
  if (import.meta.env.MODE !== 'production') {
    const m = await import('./mockSource');
    return m.MockRoomSource(ownDesks);
  }
  const { deskSource } = await import('./deskSource');
  return deskSource();
}
