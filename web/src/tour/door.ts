// The office tour's only code in the first load (ADR 0056): the kill switch, the member's setting, the once-a-page decision
// to start by itself, and the ways in (`startTour`, `prefetchTour`). The tour itself (the quiet check, its steps, placement,
// keys and focus, the motion and the writes) is `TourLayer.tsx`'s own chunk, with its own stylesheet, fetched only when it
// may start by itself, on "Take the tour", or as the mark's menu opens.
//
// The setting, read in this order (ADR 0056 decision 9):
//   1. Platform's `GET /v1/me` `preferences.officeTour` `{off}`, once Platform has it (absent today);
//   2. the layout document's `prefs.tourOff`, which follows the member to every browser (design 9.4);
//   3. this browser's record, `ma.tour.v1` `{who, off}`, one of the layout mirror's keys, so every signed-out state and
//      change of account wipes it (ISS-67, ISS-89).
// Missing everywhere is a first visit.
import { createElement, useEffect, useState, type ComponentType } from 'react';
import { create } from 'zustand';
import { readJson } from '../lib/util';
import type { Me } from '../platform/api';
import type { ClientConfig } from '../platform/clientConfig';
import { onMemberChange } from '../platform/auth';
import { useSession } from '../platform/session';
import { useLayoutPrefs } from '../shell/layoutPrefs';
import { layoutDocMember, layoutDocRead, onLayoutDocRead, readLayoutNow, setLayoutPref } from '../shell/layoutSync';
import { useDeskStore, type DeskInfo } from '../state/deskStore';
import { useWelcomeDoor, welcomeHolds } from '../welcome/store';

export const TOUR_KEY = 'tourOff';
export const TOUR_MIRROR = 'ma.tour.v1';

/** Client-config `walkthrough: {enabled: false}` is the kill switch; absent is on. */
export const tourOn = (config: ClientConfig | null | undefined): boolean => !!config && config.walkthrough?.enabled !== false;

/** A Personal or Work desk: the tour is about the member's own office (never a Guild Desk alone). */
export const ownDesk = (d: Pick<DeskInfo, 'kind'>): boolean => d.kind === 'personal' || d.kind === 'work';

/** Platform's `preferences.officeTour` as it came, or undefined while Platform doesn't send the field (it can't be written then). */
export const serverTour = (me: Me | null | undefined): unknown => {
  const p = me?.preferences as Record<string, unknown> | null | undefined;
  return p && typeof p === 'object' && 'officeTour' in p ? p['officeTour'] : undefined;
};

/** This browser's record, for this member only. */
export function mirrorOff(me: Me | null | undefined): boolean | undefined {
  const m = readJson<{ who?: unknown; off?: unknown }>(TOUR_MIRROR);
  return m && m.who === (me?.userId ?? null) && typeof m.off === 'boolean' ? m.off : undefined;
}

export interface TourLayerProps {
  /** Started by itself: it waits for the office to be quiet, and gives up quietly if it never is. */
  auto: boolean;
  /** Where focus goes back to at the end ("Take the tour": the mark's button). */
  from: Element | null;
  onEnd: () => void;
  /** The shell's passing notice (`role="status"`, 4.2 s): the note after "Don't show this again". */
  onNotice: (text: string) => void;
}

interface TourState {
  /** Counts this tab's writes, so what reads the setting renders again when only the mirror changed. */
  tick: number;
  /** What this page last sent Platform's `officeTour`, while its answer is on the way or if it never came. */
  sent: boolean | undefined;
  run: { n: number; auto: boolean; from: Element | null } | null;
  Layer: ComponentType<TourLayerProps> | null;
  /** Counts the changes of member in this tab, so the page decides afresh for the new one. */
  era: number;
}
export const useTour = create<TourState>(() => ({ tick: 0, sent: undefined, run: null, Layer: null, era: 0 }));

/** Whether the tour is switched off for this member: Platform's word, else the document's, else this browser's. */
export function tourOff(me: Me | null | undefined = useSession.getState().me, doc: Record<string, unknown> = useLayoutPrefs.getState()): boolean {
  const s = serverTour(me);
  if (s !== undefined) {
    const sent = useTour.getState().sent;
    if (sent !== undefined) return sent;
    const off = s && typeof s === 'object' ? (s as { off?: unknown }).off : undefined;
    if (typeof off === 'boolean') return off;
  }
  const d = doc[TOUR_KEY];
  return typeof d === 'boolean' ? d : mirrorOff(me) === true;
}

/** What this browser kept that the document hasn't heard (a save that never landed), to send up once the document is read. */
export function catchUp(me: Me | null | undefined, doc: Record<string, unknown>): Record<string, boolean> | null {
  const here = mirrorOff(me);
  return typeof doc[TOUR_KEY] !== 'boolean' && here !== undefined ? { [TOUR_KEY]: here } : null;
}

let loading: Promise<ComponentType<TourLayerProps>> | null = null;
function load(): Promise<ComponentType<TourLayerProps>> {
  loading ??= import('./TourLayer')
    .then((m) => m.ready())
    .then(
      (Layer) => {
        useTour.setState({ Layer });
        return Layer;
      },
      (err: unknown) => {
        loading = null; // asked again next time
        throw err;
      },
    );
  return loading;
}

/** The chunk and its stylesheet, ahead of a "Take the tour" (the mark's menu, as it opens). */
export const prefetchTour = (): void => void load().catch(() => undefined);

let runs = 0;
const begin = (auto: boolean, from: Element | null): void =>
  void load().then(
    () => useTour.setState({ run: { n: ++runs, auto, from } }),
    () => undefined,
  );

/** "Take the tour": now, whatever the setting. Focus goes back to `from` at its end. */
export const startTour = (from?: Element | null): void => begin(false, from ?? document.activeElement);

/** Whether this page has decided about starting by itself: once a member, so turning the switch on starts nothing now. */
let decided = false;

/**
 * This tab's tokens became another member's (a sign-in in another tab; ISS-67 and ISS-89's change, as the session, the
 * layout mirror and every app's store take it): the last member's tour closes at once, with nothing written, and nothing
 * of theirs is kept here (the decision, the document's read, what was sent Platform). The page decides afresh for the new
 * member once their `/v1/me`, desk list and document are here. Their record in this browser went with the layout mirror.
 */
onMemberChange((_sub, before) => {
  if (before === null) return;
  decided = false;
  useTour.setState((s) => ({ run: null, sent: undefined, era: s.era + 1 }));
  // Their document now, not at the next poll a minute on: the decision waits for it.
  readLayoutNow();
});

/**
 * In the Shell, beside Account settings' layer: decides a first visit once a page, once the member, the desk list, the
 * canvas's first paint and the layout document are all here, and renders the tour while it runs.
 */
export function TourMount({ closed, painted, onNotice }: { closed: boolean; painted: boolean; onNotice: (text: string) => void }) {
  const on = useSession((s) => tourOn(s.config));
  const me = useSession((s) => s.me);
  const listed = useDeskStore((s) => s.status === 'ready' && s.desks.some(ownDesk));
  /** Only the tour's own key: the document's `prefs` is a new object at every read, and the rest isn't the tour's. */
  const docOff = useLayoutPrefs((s) => s[TOUR_KEY]);
  const era = useTour((s) => s.era);
  /**
   * Each read of the document renders this again, so a read is noticed when it lands: only while a first visit is still to
   * be decided with the tour on. After that, or with it off, a read renders nothing (the layout rule: the same document
   * renders nothing, `shell.spec.ts`).
   */
  const [reads, setReads] = useState(0);
  const run = useTour((s) => s.run);
  const Layer = useTour((s) => s.Layer);
  useEffect(() => onLayoutDocRead(() => {
    if (!decided && tourOn(useSession.getState().config)) setReads((n) => n + 1);
  }), []);
  // A tour under way goes with the office (a sign-out, another account in this tab), and doesn't come back with it.
  useEffect(() => () => useTour.setState({ run: null }), []);
  const welcome = useWelcomeDoor((s) => s.state);
  useEffect(() => {
    // The Shell has started the layout's sync by the first paint, so `layoutDocRead` means a real read (or none to make).
    // And it must be this member's document: after a change of member the sync starts over, and reads theirs.
    // Maia's welcome owns a new member's first load (welcome CONCEPT.md §1): the tour decides once it's off, done or declined.
    if (decided || !on || closed || !me || !listed || !painted || !layoutDocRead() || welcomeHolds()) return;
    const docOf = layoutDocMember();
    if (docOf !== undefined && docOf !== me.userId) return;
    decided = true;
    const prefs = useLayoutPrefs.getState();
    const up = catchUp(me, prefs);
    if (up) setLayoutPref(up);
    if (!tourOff(me, prefs)) begin(true, null);
  }, [on, closed, me, listed, painted, reads, docOff, era, welcome]);
  return run && Layer && !closed ? createElement(Layer, { key: run.n, auto: run.auto, from: run.from, onNotice, onEnd: () => useTour.setState({ run: null }) }) : null;
}
