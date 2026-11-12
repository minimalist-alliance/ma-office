// Every sentence the Apps sheet and an app's window say (ADR 0054), in one place for Sales. Drafts: Sales has the last word,
// and `docs/sub-status/apps-host.md` lists them. The listing's own words (the Bible's line, description and credits) are Sales'
// and come with the catalog; "It asks for nothing else" is the contract's (6.1).
export const W = {
  sheetTitle: 'Apps',
  free: 'Free',
  add: 'Add to desk',
  adding: 'Adding…',
  open: 'Open',
  remove: 'Remove',
  removing: 'Removing…',
  back: 'Back',
  close: 'Close',
  reviewed: 'Reviewed by Minimalist Alliance',
  byMa: 'By Minimalist Alliance',
  by: (publisher: string): string => `By ${publisher}`,
  asksNothing: 'It asks for nothing else: no internet, no files, no Browser.',
  size: (bytes: string): string => `Size: ${bytes}`,
  loading: 'Looking for apps…',
  none: 'No apps to add right now.',
  asleep: 'This desk is asleep. Wake it to see its apps.',
  wake: 'Wake',
  connecting: 'Connecting to this desk…',
  didntLoad: "The list of apps didn't load. Try again in a moment.",
  tryAgain: 'Try again',
  off: 'Apps are off on this desk for now.',
  // A view that fails its checks builds nothing (contract 3.2).
  unsafe: "This app couldn't be opened safely.",
  frameFailed: "This app's window couldn't start.",
  paused: 'Paused to keep your desk smooth',
  resume: 'Resume',
  restart: 'Restart',
  starting: 'Starting…',
  gone: 'This app is no longer on this desk.',
  noWindow: 'This app shows on its tile only.',
} as const;

/** The closed list of permissions in 1.0, in the member's words (contract section 4). */
export const PERMISSION_WORDS: Record<string, string> = {
  background: 'Keeps running with no window open.',
  net: 'Connects to the hosts listed, through the desk’s proxy.',
  'files.pick': 'Opens or saves a file you choose, each time.',
  'browser.open': 'Opens a link in a new tab of your desk’s Browser. It can’t see the Browser.',
  display: 'Shows its own screen, streamed like the Browser.',
};

/** Why a version can't be added (`installable: false`'s `reason`, API.md section 19). */
export function notInstallableWords(reason: string | null): string {
  switch (reason) {
    case 'app_api':
      return 'Needs a newer desk.';
    case 'not_supported':
      return 'Asks for something desks can’t give yet.';
    case 'revoked':
      return 'No longer offered.';
    default:
      return 'Can’t be added right now.';
  }
}

/**
 * What `apps.install` refused, in plain words. `code` and `reason` are deskd's (API.md section 19, steps 1, 2 and 4). `lead` is
 * the lead tier's name, a setting (tiers.md section 3), for a Guild Desk member, whom deskd refuses.
 */
export function installRefusalWords(code: string, reason: string | null, lead = 'lead'): string {
  if (code === 'forbidden') return `Only the guild’s ${lead} can add apps here.`;
  if (code === 'conflict') return 'Another app is being added. Try again in a moment.';
  if (code === 'not_found') return 'That version isn’t offered any more.';
  if (code === 'unavailable') {
    if (reason === 'switched_off') return 'Apps are off on this desk for now.';
    if (reason === 'no_storage' || reason === 'no_sandbox') return 'This desk can’t add apps yet.';
    if (reason === 'download') return 'That didn’t download. Try again in a moment.';
    return 'That didn’t work. Try again in a moment.';
  }
  if (code === 'precondition_failed') {
    switch (reason) {
      case 'catalog_changed':
      case 'catalog':
        return 'The list of apps just changed. Try again.';
      case 'app_api':
        return 'Needs a newer desk.';
      case 'not_supported':
        return 'Asks for something desks can’t give yet.';
      case 'revoked':
        return 'No longer offered.';
      case 'downgrade':
        return 'A newer version is already on this desk.';
      case 'no_space':
        return 'Not enough room left on this desk.';
      case 'no_hello':
      case 'needs_update':
        return 'It couldn’t start, so nothing was added.';
      default:
        return 'It didn’t pass its checks, so nothing was added.';
    }
  }
  return 'That didn’t work. Try again in a moment.';
}

export const REMOVE_FAILED = 'That didn’t work. Try again in a moment.';
export const START_FAILED = 'It couldn’t start. Try again in a moment.';

/** A package's size, as the detail says it. */
export function sizeWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
