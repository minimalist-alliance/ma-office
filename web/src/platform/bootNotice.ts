// A desk on the member's own computer started up (a new boot), or a second copy of it tried to. The office says so, once,
// so a start the member didn't make is one they notice (ma-platform draft ADR "self-hosted desks", options 2 and 3 for a
// copied disk; contract selfhost.md §4, "What the desk app reads").
//
// The Platform row gives, for a self-hosted desk only: `bootFirstSeenAt` (when it first saw the current boot),
// `previousBootFirstSeenAt` (the boot before; null on the first) and `bootRefusedAt` (the last second copy it turned
// away). This tab keeps, per desk, the last boot it has told the member about (localStorage, a convenience: with it
// gone, only a boot from the last day is told). A boot while the office was closed is told when it next opens. A cloud
// desk has none of these fields, so nothing is said for it.
//
// What's told is the member's, so it goes with the layout's mirror on every signed-out state and is written only while
// that may be (`MEMBER_CACHE_KEYS` in `state/layoutStore.ts`, ISS-89). A sign-in that wiped it tells a boot from the last
// day again, once.
import { create } from 'zustand';
import { layoutMirrorWritable } from '../state/layoutStore';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { readJson, writeJson } from '../lib/util';
import { onMemberChange } from './auth';

export const SEEN_KEY = 'ma.boots.seen.v1';
/** With nothing remembered, a boot older than this is old news. */
export const FRESH_MS = 24 * 60 * 60_000;
/** The platform's own window for "is trying to start now" (selfhost.md §4). */
export const REFUSED_MS = 10 * 60_000;

export interface BootNotice {
  kind: 'started' | 'refused';
  deskId: string;
  name: string;
  /** ISO time: the boot's first sight, or the refusal. */
  at: string;
}

/** What the member has been told: desk id to the boot's time. */
export type SeenBoots = Record<string, string>;

/**
 * Which boots are news. A boot is news when the desk has had one before and this one is newer than the last told (or,
 * with none told, from the last day). Returns the notices and what to remember.
 */
export function newBoots(desks: readonly DeskInfo[], seen: SeenBoots, now: number = Date.now()): { notices: BootNotice[]; seen: SeenBoots } {
  const next: SeenBoots = {};
  const notices: BootNotice[] = [];
  for (const d of desks) {
    const b = d.boot;
    if (!b?.firstSeenAt) continue;
    const t = Date.parse(b.firstSeenAt);
    if (Number.isNaN(t)) continue;
    const before = seen[d.id];
    if (before !== undefined && t <= Date.parse(before)) {
      next[d.id] = before;
      continue;
    }
    next[d.id] = b.firstSeenAt;
    const isNew = b.previousAt !== null && (before !== undefined || now - t <= FRESH_MS);
    if (isNew) notices.push({ kind: 'started', deskId: d.id, name: d.name, at: b.firstSeenAt });
  }
  return { notices, seen: next };
}

/** A second copy turned away in the last ten minutes, one notice per refusal. */
export function refusedCopies(desks: readonly DeskInfo[], now: number = Date.now()): BootNotice[] {
  const out: BootNotice[] = [];
  for (const d of desks) {
    const at = d.boot?.refusedAt;
    if (!at) continue;
    const t = Date.parse(at);
    if (!Number.isNaN(t) && now - t <= REFUSED_MS && now >= t - 60_000) out.push({ kind: 'refused', deskId: d.id, name: d.name, at });
  }
  return out;
}

/** "3:12 pm" today, "Nov 8, 3:12 pm" on another day, in the member's own time zone. */
export function bootTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export const useBootNotices = create<{ notices: BootNotice[] }>(() => ({ notices: [] }));
/** Refusals the member put away, so a poll doesn't bring one back. */
const putAway = new Set<string>();

export function dismissBoot(n: BootNotice): void {
  if (n.kind === 'refused') putAway.add(`${n.deskId}@${n.at}`);
  useBootNotices.setState((s) => ({ notices: s.notices.filter((m) => !(m.deskId === n.deskId && m.kind === n.kind)) }));
}

function add(list: readonly BootNotice[]): void {
  if (!list.length) return;
  useBootNotices.setState((s) => ({
    notices: [...s.notices.filter((n) => !list.some((m) => m.deskId === n.deskId && m.kind === n.kind)), ...list],
  }));
}

function check(desks: readonly DeskInfo[]): void {
  const prior = readJson<SeenBoots>(SEEN_KEY) ?? {};
  const { notices, seen } = newBoots(desks, prior);
  // A desk missing from the list this time keeps its record.
  const merged = { ...prior, ...seen };
  if (JSON.stringify(merged) !== JSON.stringify(prior) && layoutMirrorWritable()) writeJson(SEEN_KEY, merged);
  add(notices);
  const refused = refusedCopies(desks).filter((n) => !putAway.has(`${n.deskId}@${n.at}`));
  const live = useBootNotices.getState().notices;
  // A refusal that has aged out of the window goes by itself.
  if (live.some((n) => n.kind === 'refused' && !refused.some((r) => r.deskId === n.deskId && r.at === n.at))) {
    useBootNotices.setState((s) => ({ notices: s.notices.filter((n) => n.kind !== 'refused' || refused.some((r) => r.deskId === n.deskId && r.at === n.at)) }));
  }
  add(refused.filter((r) => !live.some((n) => n.kind === 'refused' && n.deskId === r.deskId && n.at === r.at)));
}

/** For the signed-in shell. Reads the desk list now and on every change. Returns a stop. */
export function watchBoots(): () => void {
  let last: unknown;
  const run = (): void => {
    const { desks } = useDeskStore.getState();
    if (desks === last) return;
    last = desks;
    check(desks);
  };
  run();
  const stop = useDeskStore.subscribe(run);
  // This tab's tokens became someone else's: the last member's notices, desk names and all, go from the tab (ISS-89).
  const off = onMemberChange((_sub, before) => {
    if (before === null) return;
    putAway.clear();
    useBootNotices.setState({ notices: [] });
  });
  return () => {
    stop();
    off();
  };
}
