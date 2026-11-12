// Site sign-ins on desks (#11, S-142): the Browser bar's key, its Extensions menu and pins, and the Passwords and sign-ins
// panel's reads, against deskd API.md section 10 "Signing in". The Product Designer's spec is
// `~/ma-coord/design-drafts/launch-features/desk-browser/README.md` (#11 part); where deskd differs, deskd's wire wins and
// `docs/sub-status/signins-11.md` says how. In the Browser window's chunk; the panel itself is a chunk of its own.
//
// What deskd serves: `browser.extensions.list` (the three password managers on the image's allowlist, always in its own
// order, each `installed`, `off` or `missing`, and whether its page is `open`), `browser.extension.open` and `close` (an
// installed one's page in a tab of its own; a missing one's Web Store page as the member's own tab, where Add is their own
// click) and the passwords import (`importPasswords.ts`). A deskd without the list answers `not_found`, and a teen's or an
// unknown band's desk `forbidden`: then nothing of this shows. There's no event: the list is asked again when the bar
// needs to know (the window opening, a change of tabs, a menu or the panel opening, and after the key's own calls).
import type { DeskLink } from '../../desk/deskLink';
import { uuidv7 } from '../../desk/idem';
import type { ClientConfig } from '../../platform/clientConfig';

/** client-config's `siteSignIns: { enabled: false }` turns all of it off. Absent is on. */
export const signInsOn = (cfg: ClientConfig | null | undefined): boolean => cfg?.siteSignIns?.enabled !== false;

export type ExtState = 'installed' | 'off' | 'missing';

/** One extension on the desk's list. Names and makers render as text only. */
export interface DeskExtension {
  id: string;
  name: string;
  /** "Bitwarden Inc.", or null where neither deskd nor the table below says. */
  maker: string | null;
  state: ExtState;
  /** Its page is open in a tab on the desk. */
  open: boolean;
}

/** A Chromium extension id: 32 letters a to p. */
const EXTENSION_ID = /^[a-p]{32}$/;
const STATES: readonly ExtState[] = ['installed', 'off', 'missing'];

/**
 * Who makes each password manager, by its name, for "by <maker>" and the consent's "It's made by <maker>". deskd's list has
 * no maker yet; the day it does, its word wins. Ids are never written here: the desk's list is the allowlist.
 */
const MAKERS: Readonly<Record<string, string>> = { Bitwarden: 'Bitwarden Inc.', '1Password': 'AgileBits Inc.', 'Proton Pass': 'Proton AG' };

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);

/** deskd's `extensions`, field by field. Anything that isn't one is left out; the desk's order is kept. */
export function parseExtensions(raw: unknown): DeskExtension[] {
  const list = (raw as { extensions?: unknown } | null)?.extensions;
  if (!Array.isArray(list)) return [];
  const out: DeskExtension[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r['id'] === 'string' && EXTENSION_ID.test(r['id']) ? r['id'] : null;
    const name = text(r['name'], 64);
    const state = STATES.find((s) => s === r['state']);
    if (!id || !name || !state || out.some((e) => e.id === id)) continue;
    out.push({ id, name, maker: text(r['maker'], 64) ?? MAKERS[name] ?? null, state, open: state === 'installed' && r['open'] === true });
  }
  return out;
}

// ----- pins (layout pref `extPins`, per desk)

/** The layout document's `prefs` key: `{ [deskId]: string[] }`, extension ids in the bar's order. */
export const PINS_PREF = 'extPins';

/** This desk's pins, or null if the member has never had any here (so the first manager installed gets pinned). */
export function pinsFor(raw: unknown, deskId: string): string[] | null {
  const all = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[deskId] : undefined;
  if (!Array.isArray(all)) return null;
  return all.filter((id): id is string => typeof id === 'string' && EXTENSION_ID.test(id));
}

/** The whole pref with this desk's pins replaced. Other desks' stay as they came. */
export function withDeskPins(raw: unknown, deskId: string, pins: string[]): Record<string, unknown> {
  const all = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { ...all, [deskId]: pins };
}

/**
 * Pinning one (`on`), or not. At launch every extension on the list is a password manager, and one manager at a time is
 * the key, so pinning another replaces it. Unpinning leaves an empty list, which stays: no manager is pinned again by itself.
 */
export function pinned(pins: string[] | null, id: string, on: boolean, exts: readonly DeskExtension[]): string[] {
  const managers = new Set(exts.map((e) => e.id));
  const rest = (pins ?? []).filter((p) => p !== id && !(on && managers.has(p)));
  return on ? [id, ...rest] : rest;
}

/** The first manager installed is pinned, on a desk where the member has never pinned or unpinned one. Null: nothing to do. */
export function firstPin(pins: string[] | null, exts: readonly DeskExtension[]): string[] | null {
  if (pins !== null) return null;
  const first = exts.find((e) => e.state === 'installed');
  return first ? [first.id] : null;
}

/** The key: the first pinned manager that's installed. Null shows the key as "Passwords", which opens the panel. */
export function keyExtension(exts: readonly DeskExtension[], pins: string[] | null): DeskExtension | null {
  for (const id of pins ?? []) {
    const e = exts.find((x) => x.id === id && x.state === 'installed');
    if (e) return e;
  }
  return null;
}

/** The key's name and tooltip (spec section 1). */
export const keyName = (key: DeskExtension | null): string => (key ? `${key.name}, password manager` : 'Passwords');

// ----- words

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** The import's done line (spec 9.2), from `added`, `alreadySaved` and `refused`. Never a site, a username or a password. */
export function importDoneWords(r: { added?: unknown; alreadySaved?: unknown; refused?: unknown }): string {
  const added = n(r.added);
  const already = n(r.alreadySaved);
  const refused = n(r.refused);
  const words = [`Added ${added} ${added === 1 ? 'password' : 'passwords'} to this desk’s Browser.`];
  if (already > 0) words.push(`${already} ${already === 1 ? 'was' : 'were'} already here.`);
  if (refused > 0) words.push(`${refused} couldn’t be added.`);
  return words.join(' ');
}

export const NOT_A_PASSWORDS_FILE = 'That file isn’t a passwords export. Choose the CSV your browser saved.';
export const TOO_BIG = 'That file is too big to be a passwords export.';
export const IMPORT_BUSY = 'Another of your sessions is importing passwords. Try again in a minute.';
export const IMPORT_FAILED = 'Your desk couldn’t add the passwords. Try again in a moment.';

const codeOf = (err: unknown): string => (err as { code?: unknown } | null)?.code as string ?? '';
const reasonOf = (err: unknown): unknown => (err as { details?: { reason?: unknown } } | null)?.details?.reason;

/** What the panel says when an import didn't go. */
export function importErrorWords(err: unknown): string {
  const code = codeOf(err);
  if (code === 'bad_request' && reasonOf(err) === 'format') return NOT_A_PASSWORDS_FILE;
  if (code === 'too_large') return TOO_BIG;
  if (code === 'conflict' && reasonOf(err) === 'busy') return IMPORT_BUSY;
  return IMPORT_FAILED;
}

/** "12 passwords are saved in this desk's Browser." (spec 9.5) */
export const savedWords = (saved: number): string => `${saved} ${saved === 1 ? 'password is' : 'passwords are'} saved in this desk’s Browser.`;
export const deleteAskWords = (saved: number): string => `Delete ${saved} saved ${saved === 1 ? 'password' : 'passwords'} from this desk’s Browser?`;
export const deletedWords = (deleted: number): string => `Deleted ${deleted} ${deleted === 1 ? 'password' : 'passwords'}.`;

// ----- the window's store

/** What the bar and the panel read. */
export interface SignInsView {
  /** The desk answers `browser.extensions.list` for this member. Until it does, none of #11 shows. */
  served: boolean;
  exts: DeskExtension[];
  /** `browser.passwords.count`'s answer, or null where the desk doesn't serve it (no Stop section then). */
  saved: number | null;
  /** The key's own call is on its way. */
  busy: boolean;
}

const EMPTY: SignInsView = { served: false, exts: [], saved: null, busy: false };

/** deskd says this desk never will, for this session: an older deskd (`not_found`), a teen's desk or a token without video. */
const final = (err: unknown): boolean => codeOf(err) === 'not_found' || codeOf(err) === 'forbidden';

/** How long a burst of tab changes waits before the list is asked again. */
const REFRESH_DEBOUNCE_MS = 300;
/**
 * After "Add to this desk" the member adds the manager on its Web Store page, on the desk, and nothing tells the office
 * when (an install may open no tab). So the list is asked this often, for this long, until that one is in.
 */
const INSTALL_POLL_MS = 2_000;
const INSTALL_WATCH_MS = 180_000;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
const realTimers: Timers = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
};

type Link = Pick<DeskLink, 'call'>;

/** One Browser window's sign-ins: one per window, so a desk's list is its own. */
export class SignIns {
  private view: SignInsView = EMPTY;
  private readonly listeners = new Set<() => void>();
  private link: Link | null = null;
  /** The desk said no for this session: nothing is asked until a new link. */
  private refused = false;
  private timer: unknown = null;
  private inFlight = false;
  private again = false;
  private countAsked = false;
  private watchTimer: unknown = null;
  private readonly timers: Timers;
  private readonly now: () => number;

  constructor(timers: Timers = realTimers, now: () => number = Date.now) {
    this.timers = timers;
    this.now = now;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get = (): SignInsView => this.view;

  /** Tells the window only when something changed: a Browser window renders on each telling. */
  private set(patch: Partial<SignInsView>): void {
    const keys = Object.keys(patch) as (keyof SignInsView)[];
    if (keys.every((k) => Object.is(this.view[k], patch[k]))) return;
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** The window's link, or null where none of #11 may show (the kill switch, a teen): null hides everything. */
  setLink(link: Link | null): void {
    if (link === this.link) return;
    this.stopWatch();
    this.link = link;
    this.refused = false;
    this.countAsked = false;
    this.set({ ...EMPTY });
  }

  /** A new session on the same link: a deskd updated since may serve what the last one didn't. Asks at once. */
  newSession(): void {
    this.refused = false;
    this.countAsked = false;
    this.refresh(true);
  }

  /** Ask the list again, soon. Bursts of tab changes ask once. */
  refresh(now = false): void {
    if (!this.link || this.refused) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.list();
    }, now ? 0 : REFRESH_DEBOUNCE_MS);
  }

  /** The list now. One at a time; a change while one is out asks once more after it. */
  async list(): Promise<void> {
    const link = this.link;
    if (!link || this.refused) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.inFlight = true;
    try {
      const exts = parseExtensions(await link.call('browser.extensions.list', {}));
      if (link === this.link) this.set({ served: true, exts });
      if (!this.countAsked) {
        this.countAsked = true;
        void this.count();
      }
    } catch (err) {
      // Chromium starting, or no session for a moment: what was said stands, and the next change asks again.
      if (link === this.link && final(err)) {
        this.refused = true;
        this.set(EMPTY);
      }
    } finally {
      this.inFlight = false;
      if (this.again) {
        this.again = false;
        void this.list();
      }
    }
  }

  /** The Stop section's count: shown only where the desk serves it. */
  async count(): Promise<void> {
    const link = this.link;
    if (!link) return;
    try {
      const r = await link.call('browser.passwords.count', {});
      if (link === this.link) this.set({ saved: n(r?.saved) });
    } catch (err) {
      if (link === this.link && final(err)) this.set({ saved: null });
      else this.countAsked = false;
    }
  }

  /** The member deleted them (spec 9.5): the new count. */
  setSaved(saved: number | null): void {
    this.set({ saved });
  }

  /**
   * The key or a menu row: an installed manager's page in a tab on the desk, or a missing one's Web Store page as the
   * member's own tab. One `idem` for the press. Resolves to deskd's `page` (`extension` or `store`).
   */
  async open(id: string): Promise<'extension' | 'store'> {
    const link = this.link;
    if (!link) throw Object.assign(new Error('no desk link'), { code: 'not_connected' });
    this.set({ busy: true });
    try {
      const r = await link.call('browser.extension.open', { id }, { idem: uuidv7() });
      const page = r?.page === 'store' ? 'store' : 'extension';
      if (page === 'extension') this.set({ exts: this.view.exts.map((e) => (e.id === id ? { ...e, open: true } : e)) });
      return page;
    } finally {
      this.set({ busy: false });
      this.refresh();
    }
  }

  /** The key pressed again: that manager's tab closes, and the desk goes back to the member's tab. */
  async close(id: string): Promise<void> {
    const link = this.link;
    if (!link) return;
    this.set({ busy: true, exts: this.view.exts.map((e) => (e.id === id ? { ...e, open: false } : e)) });
    try {
      await link.call('browser.extension.close', { id }, { idem: uuidv7() });
    } finally {
      this.set({ busy: false });
      this.refresh();
    }
  }

  /** The member said yes to adding `id`: its Web Store page is on the desk. Ask the list until it's installed, a while at most. */
  watchInstall(id: string): void {
    this.stopWatch();
    const until = this.now() + INSTALL_WATCH_MS;
    const tick = (): void => {
      this.watchTimer = null;
      const done = this.view.exts.some((e) => e.id === id && e.state === 'installed');
      if (!this.link || this.refused || done || this.now() > until) return;
      void this.list();
      this.watchTimer = this.timers.set(tick, INSTALL_POLL_MS);
    };
    this.watchTimer = this.timers.set(tick, INSTALL_POLL_MS);
  }

  private stopWatch(): void {
    if (this.watchTimer !== null) this.timers.clear(this.watchTimer);
    this.watchTimer = null;
  }

  dispose(): void {
    this.stopWatch();
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.link = null;
    this.listeners.clear();
  }
}
