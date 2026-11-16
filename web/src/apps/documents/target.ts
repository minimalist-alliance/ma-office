// Where the Documents window should open, by desk: a document, the page asked, and whether "What changed" goes with it. Files'
// View, Maia's handover card and her `office_show` (`d_…#p3`) set it; the window's body takes it once and opens the viewer
// there. Tiny and outside every window's chunk, so whoever asks needn't load Documents to ask.
import { create } from 'zustand';
import { openItem } from '../../shell/actions';
import { useLayoutStore } from '../../state/layoutStore';

export interface DocTarget {
  docId: string;
  page: number | null;
  /** Open with "What changed" showing (a handover's own button). */
  changes: boolean;
  seq: number;
}

export const useDocTargets = create<Record<string, DocTarget>>(() => ({}));

let seq = 0;

/** Asks the Documents window on `deskId` to open `docId` (at `page`, with What changed if asked). */
export function setDocTarget(deskId: string, t: { docId: string; page?: number | null; changes?: boolean }): void {
  seq += 1;
  useDocTargets.setState({ [deskId]: { docId: t.docId, page: t.page ?? null, changes: t.changes === true, seq } });
}

/** The body took it: asked once, opened once. */
export function takeDocTarget(deskId: string, at: number): void {
  const cur = useDocTargets.getState()[deskId];
  if (!cur || cur.seq !== at) return;
  const rest = { ...useDocTargets.getState() };
  delete rest[deskId];
  useDocTargets.setState(rest, true);
}

/** Maia's room, while it's up: opens Documents in her viewport instead of a window on the desk under her. */
let roomOpener: ((deskId: string) => boolean) | null = null;
export function setRoomDocOpener(fn: ((deskId: string) => boolean) | null): void {
  roomOpener = fn;
}

/**
 * Opens Documents on `deskId` at a document: in Maia's viewport while her room is up, else the desk's own Documents window (its
 * tile's own way of opening, `openItem`). Nothing opens on a desk with no Documents tile (its kill switch, a Guild Desk).
 */
export function openDocument(deskId: string, t: { docId: string; page?: number | null; changes?: boolean }): boolean {
  const tile = useLayoutStore.getState().desks[deskId]?.items.find((i) => i.app === 'documents');
  if (!tile) return false;
  setDocTarget(deskId, t);
  if (roomOpener?.(deskId)) return true;
  openItem(deskId, tile.id);
  return true;
}
