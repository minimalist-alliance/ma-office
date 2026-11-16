// Each desk's transfer engine, kept past its Files window: an upload or a download carries on with the window closed, and
// the window opened again finds it in the tray. Part of the Files chunk, so a member who never opens Files pays for none of it.
import type { HostShell } from '../../agent/AgentWindow';
import type { DeskLink } from '../../desk/deskLink';
import { onMemberChange } from '../../platform/auth';
import type { ImageCheck } from '../../platform/imageCheck';
import { FilesApi } from './api';
import { TransferEngine } from './engine';

export interface Held {
  engine: TransferEngine;
  link: DeskLink;
  /** Whoever has the window open, told when a transfer changed a folder. */
  changed: ((folder: string) => void) | null;
}
const engines = new Map<string, Held>();

/** This desk's engine, made the first time and kept while its link is the same one (the page's lifetime, in practice). */
export function engineFor(deskId: string, link: DeskLink, imageCheck: ImageCheck, shell: Pick<HostShell, 'idem' | 'announce' | 'setBusy'>): Held {
  const have = engines.get(deskId);
  if (have && have.link === link) return have;
  have?.engine.dispose();
  const entry: Held = { link, changed: null, engine: null as unknown as TransferEngine };
  entry.engine = new TransferEngine({
    link,
    api: new FilesApi(link, shell.idem),
    imageCheck,
    announce: shell.announce,
    setBusy: (on) => shell.setBusy(deskId, on),
    changed: (f) => entry.changed?.(f),
  });
  engines.set(deskId, entry);
  return entry;
}

/**
 * This tab's tokens became another account's (a sign-in in another tab; ISS-89's follow-up): every desk's transfers here were
 * the last member's, so each engine ends, its uploads and downloads stopped where they are and their names gone with it, and
 * its hold on the close guard let go. The window opened next, on the new member's desk, makes a new one.
 */
export function forgetTransfers(): void {
  for (const held of engines.values()) held.engine.dispose();
  engines.clear();
}

// The first token (`before` null) is nobody's change. This chunk loads with the first Files window, so before it there's none.
onMemberChange((_sub, before) => {
  if (before !== null) forgetTransfers();
});
