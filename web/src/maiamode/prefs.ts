// What Maia Mode remembers for the member, and who may have it at all.
//
// The prefs live in the layout document's `prefs.maiaMode` (Platform's one document per member, which keeps keys it doesn't
// know: design 9.4), so they follow the member to every device and are known before any desk connects (CONCEPT.md §2):
//   on                 the account menu's switch
//   disclosure         { version, at }: the §9 disclosure, accepted
//   trackerCollapsed   the To-do column collapsed (`maiaMode.trackerCollapsed`)
//   startup            { ask, mode: "last" | "maia" | "desk" }: "Ask every time I open my office", and where to open otherwise
//   lastMode           "maia" | "desk": the mode the member was last in
//   offPending         true from the member's "off" until a home desk has it (Security's MR-M2): any device sends it again
//   home               the desk Maia Mode was turned on on, where an "off" goes
//   offered            the first load after Maia Mode was allowed asked once, and the member answered (`offers`)
// This browser keeps a copy under the member's id (`ma.maiaMode.v1`, part of the layout's mirror, wiped on every signed-out
// state), so the loader paints the right ground and the chooser at once; Platform's value wins once it's read.
import type { Me } from '../platform/api';
import { ageBandOf, ageRulesOn } from '../platform/age';
import type { ClientConfig } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { liveTier } from '../platform/tiers';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { layoutDocRead, setLayoutPref } from '../shell/layoutSync';
import { layoutMirrorWritable } from '../state/layoutStore';
import { maiaModeFlag } from './door';
import { DISCLOSURE } from './words';

export const MIRROR = 'ma.maiaMode.v1';
const KEY = 'maiaMode';

export type StartMode = 'last' | 'maia' | 'desk';
export type Mode = 'maia' | 'desk';

export interface MaiaPrefs {
  on: boolean;
  disclosure: { version: number; at: string } | null;
  trackerCollapsed: boolean;
  startup: { ask: boolean; mode: StartMode };
  lastMode: Mode;
  offPending: boolean;
  home: string | null;
  offered: boolean;
}

/**
 * "Ask every time I open my office" is on for every member who never chose (ma-platform desks.md: `{ask: true, mode: "last"}`
 * by default), so turning Maia Mode on is all it takes for the chooser to ask at the next load; a stored choice wins.
 */
export const DEFAULTS: MaiaPrefs = { on: false, disclosure: null, trackerCollapsed: false, startup: { ask: true, mode: 'last' }, lastMode: 'desk', offPending: false, home: null, offered: false };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Read leniently: anything it doesn't understand is the default, and keys it doesn't know go back as they came. */
export function readPrefs(raw: unknown): MaiaPrefs {
  const r = obj(raw);
  const d = obj(r['disclosure']);
  const s = obj(r['startup']);
  const version = typeof d['version'] === 'number' && Number.isInteger(d['version']) && d['version'] > 0 ? d['version'] : 0;
  const mode = s['mode'] === 'maia' || s['mode'] === 'desk' || s['mode'] === 'last' ? s['mode'] : DEFAULTS.startup.mode;
  return {
    on: r['on'] === true,
    disclosure: version ? { version, at: typeof d['at'] === 'string' && d['at'].length <= 40 ? d['at'] : '' } : null,
    trackerCollapsed: r['trackerCollapsed'] === true,
    startup: { ask: typeof s['ask'] === 'boolean' ? s['ask'] : DEFAULTS.startup.ask, mode },
    lastMode: r['lastMode'] === 'maia' ? 'maia' : 'desk',
    offPending: r['offPending'] === true,
    home: typeof r['home'] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(r['home']) ? r['home'] : null,
    offered: r['offered'] === true,
  };
}

/** Turned on, with the current disclosure accepted. */
export const isOn = (p: MaiaPrefs): boolean => p.on && (p.disclosure?.version ?? 0) >= DISCLOSURE.version;

/** Where the office opens when it doesn't ask: the chosen mode, or the last one used. */
export const startModeOf = (p: MaiaPrefs): Mode => (p.startup.mode === 'last' ? p.lastMode : p.startup.mode);

/** Whether the startup chooser asks (CONCEPT.md §2, "Who sees it"): on, accepted, allowed, and "Ask every time" ticked. */
export const asks = (p: MaiaPrefs, allowed: boolean): boolean => allowed && isOn(p) && p.startup.ask;

/**
 * Whether the first load asks a member who may have Maia Mode but never turned it on (the owner, Nov 14): once, the chooser's
 * question without "Ask every time", and never again after they answer either way (`offered`). Someone who turned it on before,
 * or turned it off, has a disclosure on record and is never asked this.
 */
export const offers = (p: MaiaPrefs, allowed: boolean): boolean => allowed && !p.on && p.disclosure === null && !p.offPending && !p.offered;

/**
 * Who may have Maia Mode (ma-platform contract desks.md "Maia Mode", "The Desk app's rule"): never with client-config's switch
 * off for all (`maiaModeFlag`), never a teen nor a band the age rules haven't said, never Free; then `/v1/me`'s
 * `maiaMode.enabled` (the access list, Phase 1), or, in a later tier mode (client-config `maiaMode.enabled`), Officer or
 * Founder on a live tier (§8.4: not Alliance by default), or the owner.
 */
export function allowedFor(me: Me | null | undefined, config: ClientConfig | null | undefined): boolean {
  if (!maiaModeFlag(config) || !me) return false;
  const band = ageBandOf(me);
  if (band === 'teen' || (ageRulesOn(config) && band !== 'adult')) return false;
  if ((me.membership as { tier?: unknown } | undefined)?.tier === 'free') return false;
  if (me.maiaMode?.enabled === true) return true;
  if (config?.maiaMode?.enabled !== true) return false;
  if (me.roles?.includes('owner')) return true;
  const tier = liveTier(me.membership);
  return tier === 'officer' || tier === 'lead';
}

export const allowedNow = (): boolean => {
  const s = useSession.getState();
  return allowedFor(s.me, s.config);
};

const who = (): string | null => useSession.getState().me?.userId ?? null;

/** This browser's copy, if it's this member's. */
export function mirrorPrefs(member: string | null = who()): Record<string, unknown> | null {
  try {
    const m = obj(JSON.parse(localStorage.getItem(MIRROR) ?? 'null'));
    return member !== null && m['who'] === member ? obj(m['prefs']) : null;
  } catch {
    return null;
  }
}

/** The document's value once it's been read (Platform's wins), else this browser's copy, else the defaults. */
export function currentPrefs(doc: Record<string, unknown> = useLayoutPrefs.getState()): MaiaPrefs {
  const fromDoc = doc[KEY];
  if (fromDoc !== undefined) return readPrefs(fromDoc);
  return readPrefs(mirrorPrefs());
}

/** Whether the member's own prefs are known yet: the document has answered, or this browser keeps a copy of theirs. */
export const prefsKnown = (): boolean => useLayoutPrefs.getState()[KEY] !== undefined || layoutDocRead() || mirrorPrefs() !== null;

function writeMirror(p: Record<string, unknown>): void {
  // Part of the saved layout's mirror (ISS-67): never written once this page or another tab has signed out.
  if (!layoutMirrorWritable()) return;
  try {
    localStorage.setItem(MIRROR, JSON.stringify({ who: who(), prefs: p }));
  } catch {
    /* storage refused: the document still has it */
  }
}

/** A change the member made: into the document (it saves like any other) and this browser's copy, at once. */
export function savePrefs(patch: Partial<MaiaPrefs>): MaiaPrefs {
  const doc = useLayoutPrefs.getState()[KEY];
  const base = doc !== undefined ? obj(doc) : (mirrorPrefs() ?? {});
  const next = { ...base, ...patch } as Record<string, unknown>;
  writeMirror(next);
  setLayoutPref({ [KEY]: next });
  return readPrefs(next);
}

/** When the document's value arrives and differs from this browser's copy, the copy follows it (Platform's wins). */
export function followDocument(): () => void {
  return useLayoutPrefs.subscribe((s, was) => {
    if (s[KEY] !== undefined && s[KEY] !== was[KEY]) writeMirror(obj(s[KEY]));
  });
}
