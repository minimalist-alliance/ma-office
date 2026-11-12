// What the setup circle remembers for the account, in the layout document's `prefs` (design 9.4, Platform's one document
// per member, which keeps keys it doesn't know), so it follows the member to every browser and costs no new route:
//   setup              { done: [ids], skipped: [ids] }
//   circleHidden       true while the member has hidden the circle ("Show setup and what's new" off)
//   whatsNewSeen       [ids] of What's new items they've tried or put away
//   offerNotNowUntil   ISO time: the upgrade offer's "Not now", 30 days
// Each is mirrored in this browser too, under the member's id, so a reload never shows again what the document hasn't
// brought back yet. Nothing else: no counts, nothing about what the member did inside a desk.
import { create } from 'zustand';
import { readJson, writeJson } from '../lib/util';
import { useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { layoutDocRead, setLayoutPref } from '../shell/layoutSync';
import { layoutMirrorWritable } from '../state/layoutStore';
import { isStepId, type SetupPrefs, type StepId } from './steps';

export const SETUP = 'setup';
export const CIRCLE_HIDDEN = 'circleHidden';
export const WHATS_NEW_SEEN = 'whatsNewSeen';
export const OFFER_NOT_NOW_UNTIL = 'offerNotNowUntil';
type Key = typeof SETUP | typeof CIRCLE_HIDDEN | typeof WHATS_NEW_SEEN | typeof OFFER_NOT_NOW_UNTIL;

export const MIRROR = 'ma.setup.prefs.v1';
/** A seen list never grows past this: the oldest go first. */
const MAX_SEEN = 50;

const who = (): string | null => useSession.getState().me?.userId ?? null;

/** Counts this browser's writes, so what reads the mirror renders again when only the mirror changed. */
export const useMirrorTick = create<{ n: number }>(() => ({ n: 0 }));
function writeMirror(key: Key, value: unknown): void {
  // Part of the saved layout's mirror (ISS-67, Security's ISS67-L1): never written once this page or another tab has signed out.
  if (!layoutMirrorWritable()) return;
  writeJson(MIRROR, { who: who(), prefs: { ...mirror(), [key]: value } });
  useMirrorTick.setState((s) => ({ n: s.n + 1 }));
}

function mirror(): Record<string, unknown> {
  const m = readJson<{ who?: unknown; prefs?: Record<string, unknown> }>(MIRROR);
  return m && m.who === who() && m.prefs && typeof m.prefs === 'object' ? m.prefs : {};
}

/** The document's value, or this browser's while the document hasn't brought one. */
const raw = (key: Key, doc: Record<string, unknown> = useLayoutPrefs.getState()): unknown => (doc[key] !== undefined ? doc[key] : mirror()[key]);

function write(key: Key, value: unknown): void {
  writeMirror(key, value);
  setLayoutPref({ [key]: value });
}

const ids = (v: unknown): StepId[] => (Array.isArray(v) ? [...new Set(v.filter(isStepId))] : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(-MAX_SEEN) : []);
const timeOf = (v: unknown): number | null => {
  const t = typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * `prefs.setup`, read leniently. Done is the union of the document and this browser's copy, since a step never comes
 * undone: a step done here a moment before the document arrived stays done. Skipped is the document's, as Undo can take
 * one away.
 */
export function readSetup(doc: Record<string, unknown> = useLayoutPrefs.getState()): SetupPrefs {
  const fromDoc = doc[SETUP] && typeof doc[SETUP] === 'object' ? (doc[SETUP] as Record<string, unknown>) : null;
  const here = mirror()[SETUP] && typeof mirror()[SETUP] === 'object' ? (mirror()[SETUP] as Record<string, unknown>) : null;
  const done = [...new Set([...ids(fromDoc?.['done']), ...ids(here?.['done'])])];
  const skipped = ids((fromDoc ?? here)?.['skipped']).filter((id) => !done.includes(id));
  return { done, skipped };
}

export const readHidden = (doc?: Record<string, unknown>): boolean => raw(CIRCLE_HIDDEN, doc) === true;
export const readSeen = (doc?: Record<string, unknown>): string[] => strings(raw(WHATS_NEW_SEEN, doc));
export const readOfferNotNow = (doc?: Record<string, unknown>): number | null => timeOf(raw(OFFER_NOT_NOW_UNTIL, doc));

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Steps are often noticed before Platform's document has arrived (a desk's name is known at once, its agents a moment
 * later), so a step goes to this browser's copy first and to the document only once it has been read: written earlier,
 * it would hide the steps the document already had from another browser. `flushSetup` sends the two together then.
 */
function writeSetup(next: SetupPrefs): void {
  const value = { done: [...next.done], skipped: [...next.skipped] };
  writeMirror(SETUP, value);
  if (layoutDocRead()) setLayoutPref({ [SETUP]: value });
}

/** Once the document has been read: anything this browser knows that it doesn't goes up, in one save. */
export function flushSetup(): void {
  if (!layoutDocRead()) return;
  const doc = useLayoutPrefs.getState()[SETUP];
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
  const merged = readSetup();
  if (d && sameList(ids(d['done']), merged.done) && sameList(ids(d['skipped']), merged.skipped)) return;
  if (!d && !merged.done.length && !merged.skipped.length) return;
  setLayoutPref({ [SETUP]: { done: [...merged.done], skipped: [...merged.skipped] } });
}

/** A step used. Written once: a step already done costs no save. */
export function markDone(id: StepId): void {
  const cur = readSetup();
  if (cur.done.includes(id)) return;
  writeSetup({ done: [...cur.done, id], skipped: cur.skipped.filter((x) => x !== id) });
}

export function skipStep(id: StepId): void {
  const cur = readSetup();
  if (cur.done.includes(id) || cur.skipped.includes(id)) return;
  writeSetup({ done: cur.done, skipped: [...cur.skipped, id] });
}

export function undoSkip(id: StepId): void {
  const cur = readSetup();
  if (!cur.skipped.includes(id)) return;
  writeSetup({ done: cur.done, skipped: cur.skipped.filter((x) => x !== id) });
}

export function setCircleHidden(hidden: boolean): void {
  if (readHidden() !== hidden) write(CIRCLE_HIDDEN, hidden);
}

export function markSeen(itemIds: readonly string[]): void {
  const cur = readSeen();
  // The shown item comes with every other that fits now, itself among them: each id goes in once.
  const add = [...new Set(itemIds)].filter((id) => !cur.includes(id));
  if (add.length) write(WHATS_NEW_SEEN, [...cur, ...add].slice(-MAX_SEEN));
}

export function offerNotNow(until: number): void {
  write(OFFER_NOT_NOW_UNTIL, new Date(until).toISOString());
}
