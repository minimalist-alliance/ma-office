// What the Files window says, in one place. Calm, plain, no file names inside an error (deskd's never carry one), and never
// "busy" for the image check: a place in line is said as a place in line. Words for the Browser-on-screen note and the image
// check are the Product Designer's to polish (ADR "Files app", asks of others); these are the working copy.
import { formatBytes } from '../../export/format';
import type { FilesError } from './api';
import type { NameProblem } from './paths';

export const FILES_NAME = 'Files';
export const GUILD_WORDS = "A guild's desk doesn't have Files yet.";
export const OLD_DESK_WORDS = "This desk can't do Files yet. It will after its next update.";
export const WAITING_FOR_DESK = 'Waiting for your desk';
export const BROWSER_ON_SCREEN = 'Downloads are slower while your Browser is on screen.';
export const READ_ONLY_WORDS = "You're looking at the last list your desk gave. It's read-only until your desk is back.";
export const EMPTY_FOLDER = 'Nothing here yet. Drop files here, or press Upload.';
export const EMPTY_SEARCH = 'No names match.';
export const EMPTY_TRASH = 'The trash is empty.';
export const TRASH_NOTE = 'Items stay here for 30 days, then they are gone for good. They still count toward your space.';
export const SKIPPED_NOTE = (n: number): string => (n === 1 ? '1 item on your drive is not shown because Files only shows ordinary files and folders.' : `${n} items on your drive are not shown because Files only shows ordinary files and folders.`);

export function usageWords(used: number, total: number): string {
  return `${formatBytes(used)} of ${formatBytes(total)} used`;
}

// ----- A free desk's drive (ADR 0090, the Designer's free-tier draft row 5). The cap is counted in GiB and said as GB.
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** Said to a screen reader after every link that opens in its own tab (the free tier's own copy of this, which isn't in this chunk). */
export const NEW_TAB = ' (opens in a new tab)';
export const SEE_MEMBERSHIP = 'See membership';

/** "0 MB" up to "1023 MB", then "1.4 GB". Rounded down below the cap, so a nearly full drive never reads as full. */
const capSize = (n: number): string => {
  if (!Number.isFinite(n) || n < GIB) return `${Math.max(0, Math.floor(n / MIB))} MB`;
  return `${Math.floor((n / GIB) * 10) / 10} GB`;
};

/** "1.4 GB of 2 GB used", from the desk's own cap and what it counts (the trash and unfinished uploads too). */
export function capWords(used: number, cap: number): string {
  const full = used >= cap;
  return `${full ? capSize(cap) : capSize(used)} of ${capSize(cap)} used`;
}

/** `over`: more is kept than the cap allows (a step down to a smaller drive). Nothing is deleted; only new writes stop. */
export type CapState = 'ok' | 'near' | 'full' | 'over';
export const capState = (used: number, cap: number): CapState => (used > cap ? 'over' : used === cap ? 'full' : used >= cap * 0.9 ? 'near' : 'ok');

/** The over-drive line (billing spec 4.4, Sales' sentence): what's kept, against what the plan's drive holds. */
export function overDriveWords(used: number, cap: number): string {
  return `You have ${capSize(used)} in Files, more than ${capSize(cap)}. It all stays readable; to add more, make room or move back up.`;
}

/** The second line at 90% and when full, or null. `drive` is the free office's (null when it has none to give). */
export function capNote(state: CapState, drive: { alliance: string; allianceDrive: string | null } | null, over?: { used: number; cap: number }): string | null {
  if (state === 'over') return over ? overDriveWords(over.used, over.cap) : null;
  if (state === 'near') return drive?.allianceDrive ? `${drive.alliance} has a ${drive.allianceDrive} drive.` : null;
  if (state === 'full') {
    return drive?.allianceDrive
      ? `Your drive is full. Delete something to make room, or get ${drive.allianceDrive} with ${drive.alliance}.`
      : 'Your drive is full. Delete something to make room.';
  }
  return null;
}

/** The bar's tooltip and description on a free desk: the parts the cap counts. */
export function capDetailWords(u: { cap: number; used: number; files: number; trash: number }): string {
  const parts = [capWords(u.used, u.cap), `Files ${capSize(u.files)}`];
  if (u.trash > 0) parts.push(`Trash ${capSize(u.trash)}`);
  return `${parts.join(', ')}. The trash counts toward your drive until it is emptied.`;
}

/** One decimal from 1 KB up (formatBytes drops it from 10 on, which is what made 34 - 9.7 look like 25). For the breakdown only. */
const exact = (n: number): string => {
  if (!Number.isFinite(n) || n < 1000) return formatBytes(n);
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let u = 0;
  while (v >= 999.95 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  return `${v.toFixed(1)} ${units[u]}`;
};

/**
 * The footer's breakdown, for the bar's tooltip and its accessible description. "Free" is the drive's total less what is used, so
 * the parts add up; "room for new files" is what an upload may take, which leaves out the floor kept for the Browser.
 */
export function usageDetailWords(u: { total: number; used: number; files: number; trash: number; uploadable: number; floor: number }): string {
  const other = Math.max(0, u.used - u.files - u.trash);
  const parts = [`${exact(u.used)} of ${exact(u.total)} used`, `Files ${exact(u.files)}`];
  if (u.trash > 0) parts.push(`Trash ${exact(u.trash)}`);
  parts.push(`All other apps ${exact(other)}`, `${exact(Math.max(0, u.total - u.used))} free`);
  return `${parts.join(', ')}. New files can use ${exact(u.uploadable)}, because ${exact(u.floor)} is kept for your Browser.`;
}

export function noRoomWords(d: { freeBytes?: unknown; floorBytes?: unknown }): string {
  const free = typeof d.freeBytes === 'number' ? formatBytes(d.freeBytes) : null;
  const floor = typeof d.floorBytes === 'number' ? formatBytes(d.floorBytes) : '2 GB';
  return `${free ? `Not enough room: ${free} free, ` : 'Not enough room: '}${floor} is kept for your Browser. Empty the trash or delete something to make space.`;
}

/** An error from a call, in plain words. `what` is the action: "open this folder", "rename it", ... */
export function errorWords(err: FilesError, what = 'do that'): string {
  switch (err.code) {
    case 'not_found':
      return "It isn't there any more. It may have been moved or deleted in another window.";
    case 'exists':
      return err.details['kind'] === 'dir' ? 'A folder with that name is already there.' : 'A file with that name is already there.';
    case 'no_space':
      return noRoomWords(err.details);
    case 'invalid':
      return invalidWords(String(err.details['reason'] ?? ''));
    case 'too_many':
      return 'Your desk is busy with other transfers. Try again in a moment.';
    case 'rate_limited':
      return 'Too many requests at once. Try again in a moment.';
    case 'unavailable':
      if (err.details['reason'] === 'bandwidth_limit') return `Downloads are paused at your bandwidth limit. Use "Download your data" in your account: it's free and never paused.`;
      if (err.offline) return WAITING_FOR_DESK;
      return `Your desk couldn't ${what} just now. Try again in a moment.`;
    case 'forbidden':
      return GUILD_WORDS;
    case 'hash_mismatch':
      return 'The file changed on its way. Try again.';
    case 'check_required':
    case 'check_invalid':
      return "Your desk wouldn't take that image without a fresh check. Try again.";
    case 'deadline_exceeded':
      return `Your desk took too long to ${what}. Try again.`;
    default:
      return `Your desk couldn't ${what}. Try again in a moment.`;
  }
}

function invalidWords(reason: string): string {
  switch (reason) {
    case 'into_self':
      return "A folder can't be moved into itself.";
    case 'not_a_folder':
      return "That isn't a folder.";
    case 'is_a_folder':
      return "That's a folder, not a file.";
    case 'reserved':
      return 'That name is kept for the drive itself. Pick another.';
    case 'length':
      return 'That name or path is too long.';
    case 'chars':
      return "Names can't contain a slash, a backslash or control characters.";
    case 'nfc':
    case 'dots':
    case 'empty':
      return "That name won't work. Pick another.";
    default:
      return "That didn't work. Check the name and try again.";
  }
}

export function nameProblemWords(p: NameProblem): string {
  switch (p) {
    case 'empty':
      return 'Give it a name.';
    case 'length':
      return 'That name is too long. Names can be 255 bytes at most.';
    case 'chars':
      return "Names can't contain a slash, a backslash or control characters.";
    case 'dots':
      return "A name can't be just dots.";
    case 'reserved':
      return 'That name is kept for the drive itself. Pick another.';
  }
}

/** The words for an upload's end state, for the live region and the tray. */
export const uploadedWords = (name: string): string => `${name} uploaded`;
export const downloadedWords = (name: string): string => `${name} downloaded`;
export const movedToTrashWords = (n: number, name?: string): string => (n === 1 ? `${name ?? 'Item'} moved to the trash` : `${n} items moved to the trash`);

export function speedWords(bytesPerSecond: number | null): string | null {
  return bytesPerSecond && bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : null;
}
