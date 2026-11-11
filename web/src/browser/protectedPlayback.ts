// The desk's Chromium refused protected playback (EME: Widevine, PlayReady or FairPlay), as the Browser window hears it.
// ONE ADAPTER: this file turns a tab of `browser.tabs` that carries `protectedMedia {at, keySystem}` (deskd da3738de,
// `services/deskd/docs/API.md` "A protected video that can't play") into `{ tabId, url, origin, at }`; nothing else reads
// the field. deskd sets it once per page and clears it on a navigation to a new document. No site is blocked and nothing
// here claims protected playback works (task 16 G). A desk before the field never has one, so there is never a note.
import type { BrowserTab } from '../desk/deskLink';

export interface ProtectedFailure {
  tabId: string;
  url: string;
  /** `https://example.com`: the "site" the once-per-session rule counts. */
  origin: string;
  /** When deskd heard of it; a new page's refusal has a new one. */
  at: string;
}

/** The refusal of one tab, or null when it has none, or isn't an http(s) page. */
export function protectedFailureOf(tab: BrowserTab | undefined | null): ProtectedFailure | null {
  if (!tab || typeof tab.tabId !== 'string' || typeof tab.url !== 'string') return null;
  const pm: unknown = tab.protectedMedia;
  if (!pm || typeof pm !== 'object') return null;
  const at = (pm as Record<string, unknown>)['at'];
  if (typeof at !== 'string') return null;
  try {
    const u = new URL(tab.url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { tabId: tab.tabId, url: u.href, origin: u.origin, at };
  } catch {
    return null;
  }
}

// Sites the member dismissed, per desk, for this page load ("this session"): no note again for them.
const dismissedByDesk = new Map<string, Set<string>>();

/** Which tab's note to show, minus the sites already dismissed. */
export class ProtectedWatch {
  private readonly dismissed: Set<string>;

  constructor(deskId: string) {
    let set = dismissedByDesk.get(deskId);
    if (!set) dismissedByDesk.set(deskId, (set = new Set()));
    this.dismissed = set;
  }

  /** The note for the active tab, if it has a refusal and its site wasn't dismissed. */
  noteFor(tabs: readonly BrowserTab[]): ProtectedFailure | null {
    const f = protectedFailureOf(tabs.find((t) => t.active));
    return f && !this.dismissed.has(f.origin) ? f : null;
  }

  /** The note goes, and no other for that site this session. */
  dismiss(origin: string): void {
    this.dismissed.add(origin);
  }
}

/** For tests. */
export function resetProtectedDismissals(): void {
  dismissedByDesk.clear();
}
