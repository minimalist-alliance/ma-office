// What the Notebook window says (design 3.14, 5.5). Pure, so every state has a test.
import { browserPanel, type BrowserPanel } from '../browser/panel';
import type { VmState } from '../desk/agentStatus';
import type { DeskRefusal, LinkState } from '../desk/deskLink';

export interface DeskInput {
  vm: VmState;
  phase: string | null;
  queuePosition: number | null;
  link: LinkState;
  unreachable: boolean;
  refusal: DeskRefusal | null;
  busy?: boolean;
}

/** The desk's and the link's state, as the Browser reads them. `playing` means a session is up and it's the Notebook's to say. */
export function deskPanel(i: DeskInput): BrowserPanel {
  return browserPanel({ ...i, canPlayVideo: true, refused: null, hasFrame: true });
}

/** Nothing can open: the Notebook isn't drawn, whatever it had. A page's unconfirmed text stays in `DeskBackend` meanwhile. */
export const isClosed = (p: BrowserPanel): boolean => p.kind === 'settingUp' || p.kind === 'support' || p.kind === 'membership' || p.kind === 'dataGuard' || p.kind === 'denied';

export interface LineInput {
  panel: BrowserPanel;
  unsaved: boolean;
  hasUnsavedText: boolean;
  full: boolean;
  /** The desk refused this app's changes as older than the page (ADR 0091). Optional, so callers before it read as false. */
  outdated?: boolean;
  tooLarge: boolean;
  problem: boolean;
}

export interface Line {
  text: string;
  /** Offer to wake the desk. */
  wake: boolean;
}

const NOT_SAVED = 'Not saved yet.';

/** The quiet line under an open Notebook, or null when there's nothing to say. */
export function notebookLine(i: LineInput): Line | null {
  // The desk has a newer Notebook than this tab (ADR 0091's guard): the page is read-only here until a reload.
  if (i.outdated) return { text: i.hasUnsavedText ? "Notebook was updated, so what you typed last isn't saved. Copy it, then reload to keep editing." : 'Notebook was updated. Reload to keep editing.', wake: false };
  if (i.full) return { text: i.hasUnsavedText ? "This page is full, so what you typed last isn't saved. Copy it to a new page." : 'This page is full. Start a new page to keep writing.', wake: false };
  if (i.tooLarge) return { text: "That's too much to save at once, so it isn't saved yet. Copy it to a new page in parts.", wake: false };
  const prefix = i.hasUnsavedText ? `${NOT_SAVED} ` : '';
  switch (i.panel.kind) {
    case 'playing':
      break;
    case 'asleep':
      return { text: `${prefix}This desk is asleep.`, wake: true };
    case 'failed':
      return { text: `${prefix}Couldn't wake this desk.`, wake: true };
    case 'stopping':
      return { text: `${prefix}This desk is going to sleep.`, wake: false };
    case 'queued':
    case 'waking':
      return { text: `${prefix}Waking this desk…`, wake: false };
    case 'busy':
      return { text: `${prefix}Free desks are all busy right now. Yours is saved, and we'll keep trying.`, wake: false };
    case 'unreachable':
      return { text: `${prefix}Can't reach this desk. Still trying.`, wake: false };
    case 'resting':
      return { text: `${prefix}Paused. Click to pick it back up.`, wake: false };
    default:
      return { text: `${prefix}Reconnecting…`, wake: false };
  }
  if (i.unsaved) return { text: NOT_SAVED, wake: false };
  if (i.problem) return { text: "This desk didn't confirm that. Try again if it isn't there.", wake: false };
  return null;
}
