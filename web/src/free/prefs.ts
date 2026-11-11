// What the free tier remembers for the account, in the layout document's `prefs` (design 9.4, Platform's, one document
// per member), so it follows the member to any browser: Maia's "Not now", and the day the office last
// spoke up. Each is mirrored in this browser too, under the member's id, so a reload never shows again what the document
// hasn't brought back yet. Nothing else: no counts, nothing about what the member did on a desk.
import { readJson, writeJson } from '../lib/util';
import { useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { setLayoutPref } from '../shell/layoutSync';

/** The keys, as Platform stores them (proposed in STATUS.md, "For Platform"). */
export const SAID_ON = 'freeSaidOn';
export const MAIA_NOT_NOW = 'maiaTrialNotNow';
export type PrefKey = typeof SAID_ON | typeof MAIA_NOT_NOW;

export const MIRROR = 'ma.free.prefs.v1';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= 64 ? v : null);
const who = (): string | null => useSession.getState().me?.userId ?? null;

/** This browser's copy, only if it's this member's. */
function mirror(): Record<string, unknown> {
  const m = readJson<{ who?: unknown; prefs?: Record<string, unknown> }>(MIRROR);
  return m && m.who === who() && m.prefs && typeof m.prefs === 'object' ? m.prefs : {};
}

/** The account's value, or this browser's while the document hasn't brought it back. */
export function readPref(key: PrefKey): string | null {
  return str(useLayoutPrefs.getState()[key]) ?? str(mirror()[key]);
}

/** For React: the same, and a change to the document re-renders. */
export function usePref(key: PrefKey): string | null {
  const fromDoc = useLayoutPrefs((s) => str(s[key]));
  return fromDoc ?? str(mirror()[key]);
}

/** Written to the document (saved like any other change) and to this browser. */
export function writePref(key: PrefKey, value: string): void {
  writeJson(MIRROR, { who: who(), prefs: { ...mirror(), [key]: value } });
  setLayoutPref({ [key]: value });
}
