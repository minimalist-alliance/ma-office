// The free tier in the office (S-119; the Product Designer's draft, `~/ma-coord/design-drafts/free-tier/README.md`): its
// own chunk, loaded by `session.ts` only once `GET /v1/me` says `membership.tier: "free"`, which hands its parts to the
// few places that show them (`door.ts`). "Visible everywhere, spoken rarely": the meter, Maia asleep and the account
// menu's tier line show it (the Work desk offer and See membership are the setup circle's after-setup card now), and
// the office speaks up at most once a day, only when the day's Browser time is nearly or wholly used. No modals, no red, no counts, no badges or padlocks; nothing in Chat, Agent or Notebook; nothing in
// full screen; never on the sign-in pages; and nothing while a desk wakes.
//
// The upgrade happens in place: paying is on the membership page in its own tab, and coming back to this one re-reads
// `/v1/me`. The new tier plays one beat (about 600 ms, instant under reduced motion): the meter fills back up and hands
// back to the bandwidth circle, a paused Browser comes back on the same tabs, for {officer} the Work desk simply appears
// in place (the list brings it; there is no spot to rise from), Maia wakes, and one notice says so. Nothing restarts.
import type { ReactElement } from 'react';
import { announce } from '../shell/announce';
import { deskSaysPaused, useBandwidth } from '../bandwidth/store';
import { linkOf, syncLinks, useLiveStore } from '../desk/liveStore';
import type { DeskLink } from '../desk/deskLink';
import { reducedMotion } from '../lib/util';
import { ageBandOf } from '../platform/age';
import { useSession } from '../platform/session';
import { tierNamesFrom } from '../platform/tiers';
import { setDeskListDirect, useDeskStore } from '../state/deskStore';
import { reconcileLayout } from '../state/layoutStore';
import { useFree } from './door';
import { FreeAccount, FreeBrowserLine, FreeNotices } from './Lines';
import { FreeMeter } from './Meter';
import { SAID_ON, readPref, writePref } from './prefs';
import { BEAT_MS, HEADS_UP_MS, showNotice, UPGRADED_MS, useFreeState } from './state';
import { allianceDrive, CONTENTION_TOPIC, devBrowserTime, isFree, membershipUrl, paidTier, readBrowserTime, readHeld, secondsLeft, usedUp, type BrowserTime } from './wire';
import { HEADS_UP_MINUTES, headsUpText, NEW_TAB, noDailyLimit, pausedWords, UPGRADED, UPGRADED_WORK } from './words';
import './free.css';

/** `/v1/me` is asked again on coming back to the tab at most this often, so paying in another tab is noticed. */
const REREAD_MIN_MS = 10_000;
/** The layout document has usually come by then, so the day the office last spoke up is known before it speaks. */
const SETTLE_MS = 3_000;
/** A Browser paused at the day's limit is said again this often, so nothing lifts it before the day resets. */
const PAUSE_REFRESH_MS = 30_000;

/** The paused Browser's quiet link: the tier with no daily limit, on the membership page in its own tab. */
function PauseLink() {
  const config = useSession((s) => s.config);
  const href = membershipUrl(config);
  if (!href) return null;
  return (
    <a className="free-link free-pause-link" href={href} target="_blank" rel="noopener" data-testid="free-pause-link">
      {noDailyLimit(tierNamesFrom(config?.tierNames).alliance)}
      <span className="sr-only">{NEW_TAB}</span>
    </a>
  );
}

/** The free tier's words for a Browser paused at the day's limit (`bandwidth/StreamPause.tsx`), or null for another pause. */
function pause(resumesAt: string | null): { title: string; body: string; link: ReactElement } | null {
  const { time, phase } = useFreeState.getState();
  if (phase !== 'free' || !time || !(usedUp(time) || resumesAt === time.resetsAt)) return null;
  return { ...pausedWords(time.resetsAt, { now: Date.now() }), link: <PauseLink /> };
}

let opened = false;
let reread: () => Promise<void> = async () => {};
let openedAt = 0;
let member: string | null = null;
/** Dev and tests: Browser time set by hand, in place of the meter's. */
let override: BrowserTime | null = null;

/** Called by `session.ts` each time `/v1/me` says free. Once a page; `again` re-reads `/v1/me`. */
export function open(again: () => Promise<void>): void {
  reread = again;
  if (opened) return;
  opened = true;
  openedAt = Date.now();
  member = useSession.getState().me?.userId ?? null;
  useFree.setState({
    free: true,
    Office: FreeMeter,
    Notices: FreeNotices,
    Account: FreeAccount,
    BrowserLine: FreeBrowserLine,
    pause,
    drive: () => {
      const cfg = useSession.getState().config;
      return { alliance: tierNamesFrom(cfg?.tierNames).alliance, allianceDrive: allianceDrive(cfg), href: membershipUrl(cfg) };
    },
  });
  watchTime();
  watchMe();
  watchReturn();
  watchHeld();
  if (import.meta.env.MODE !== 'production') devHooks();
}

// ----- today's Browser time, from the meter (`GET /v1/desks/bandwidth`'s `browserTime`, proposed).

let paused = new Set<string>();
let pauseTimer = 0;
let speakTimer = 0;

function currentTime(): BrowserTime | null {
  return override ?? readBrowserTime(useBandwidth.getState().meter?.browserTime) ?? devBrowserTime();
}

function watchTime(): void {
  const apply = (): void => {
    const time = currentTime();
    const before = useFreeState.getState().time;
    if (JSON.stringify(time) !== JSON.stringify(before)) useFreeState.setState({ time });
    const { phase } = useFreeState.getState();
    useFree.setState({ meter: !!time && phase !== 'after' });
    holdPause();
    headsUp();
  };
  apply();
  useBandwidth.subscribe((s, prev) => {
    if (s.meter !== prev.meter) apply();
  });
  useDeskStore.subscribe((s, prev) => {
    if (s.desks !== prev.desks) {
      holdPause();
      headsUp();
    }
  });
  document.addEventListener('fullscreenchange', headsUp);
  // The day turns over: the pause lifts and the meter shows a new day, even with nothing new from Platform yet.
  window.setInterval(() => {
    const t = useFreeState.getState().time;
    if (t && Date.parse(t.resetsAt) <= Date.now()) apply();
  }, 60_000);
  if (import.meta.env.MODE !== 'production') devTime = apply;
}
let devTime: () => void = () => {};

/**
 * At the day's limit, every cloud desk's Browser shows the pause, through the same hold a desk's own refusal uses
 * (`deskSaysPaused`): it unmounts, so the driver tells the desk `off` and no picture is sent. Said again every 30 s,
 * since the bandwidth meter lifts a desk's hold a minute after it hears nothing new. Lifted at once on an upgrade.
 */
function holdPause(): void {
  const { time, phase } = useFreeState.getState();
  const on = phase === 'free' && usedUp(time);
  window.clearTimeout(pauseTimer);
  if (!on || !time) {
    if (paused.size) liftPauses();
    return;
  }
  // The heads-up has nothing left to say once the day's time is used.
  if (useFreeState.getState().notice?.ms === HEADS_UP_MS) useFreeState.setState({ notice: null });
  for (const d of useDeskStore.getState().desks) {
    if (d.selfHosted || d.guild) continue;
    deskSaysPaused(d.id, time.resetsAt);
    paused.add(d.id);
  }
  pauseTimer = window.setTimeout(holdPause, Math.min(PAUSE_REFRESH_MS, Math.max(1_000, Date.parse(time.resetsAt) - Date.now() + 1_000)));
}

function liftPauses(): void {
  const { desks } = useBandwidth.getState();
  const next = { ...desks };
  for (const id of paused) delete next[id];
  paused = new Set();
  useBandwidth.setState({ desks: next });
}

/** The heads-up (row 6): once a day for the account, at 10 minutes left, as a notice, never in full screen. */
function headsUp(): void {
  window.clearTimeout(speakTimer);
  const { time, phase } = useFreeState.getState();
  if (!time || phase !== 'free' || !useDeskStore.getState().desks.length) return;
  const left = secondsLeft(time);
  if (left < 60 || left > HEADS_UP_MINUTES * 60 || Date.parse(time.resetsAt) <= Date.now()) return;
  const wait = openedAt + SETTLE_MS - Date.now();
  if (wait > 0) {
    speakTimer = window.setTimeout(headsUp, wait);
    return;
  }
  if (document.fullscreenElement || readPref(SAID_ON) === time.startsAt) return;
  writePref(SAID_ON, time.startsAt);
  const text = headsUpText(time, { now: Date.now() });
  showNotice(text, HEADS_UP_MS);
  announce(text);
}

// ----- the upgrade.

function watchMe(): void {
  useSession.subscribe((s, prev) => {
    if (s.me === prev.me || !s.me || useFreeState.getState().phase !== 'free') return;
    if (isFree(s.me)) return;
    // Someone else signed in here: nothing to celebrate, the free office just goes.
    if (s.me.userId !== member) {
      finish();
      return;
    }
    const to = paidTier(s.me);
    if (to) upgrade(to === 'officer' || to === 'lead');
  });
}

function upgrade(withWork: boolean): void {
  const work = withWork && ageBandOf(useSession.getState().me) !== 'teen';
  useFreeState.setState({ phase: 'beat', work });
  useFree.setState({ free: false });
  liftPauses();
  const text = work ? UPGRADED_WORK : UPGRADED;
  showNotice(text, UPGRADED_MS);
  announce(text);
  window.setTimeout(finish, reducedMotion() ? 0 : BEAT_MS);
}

/** After the beat: the bandwidth circle is back, Maia is asked again (and wakes), and nothing of the free tier speaks. */
function finish(): void {
  useFreeState.setState({ phase: 'after' });
  const maia = (useFree.getState().maia ?? 0) + 1;
  useFree.setState({ free: false, meter: false, Account: undefined, BrowserLine: undefined, pause: undefined, drive: undefined, maia });
  window.clearTimeout(pauseTimer);
  window.clearTimeout(speakTimer);
  if (paused.size) liftPauses();
}

/** Back in the tab: perhaps they've paid in the other one, so `/v1/me` is asked again, at most every 10 s. */
function watchReturn(): void {
  let last = 0;
  const again = (): void => {
    if (document.hidden || useFreeState.getState().phase !== 'free' || Date.now() - last < REREAD_MIN_MS) return;
    last = Date.now();
    void reread();
  };
  document.addEventListener('visibilitychange', again);
  window.addEventListener('focus', again);
}

// ----- a desk held back at a busy time (row 8): only its own word, `desk.contention`, proposed.

function watchHeld(): void {
  const subs = new Map<string, { link: DeskLink; off: () => void }>();
  const sync = (): void => {
    const ids = useDeskStore.getState().desks.filter((d) => !d.guild && !d.selfHosted).map((d) => d.id);
    for (const [id, sub] of subs) {
      if (ids.includes(id) && linkOf(id) === sub.link) continue;
      sub.off();
      subs.delete(id);
    }
    for (const id of ids) {
      const link = linkOf(id);
      if (!link || subs.has(id)) continue;
      // A desk with no such topic refuses it (`not_found`), and nothing is ever said: never guessed here.
      subs.set(id, { link, off: link.subscribe(CONTENTION_TOPIC, (msg) => held(id, readHeld(msg)), () => held(id, false)) });
    }
  };
  sync();
  useLiveStore.subscribe(sync);
  useDeskStore.subscribe(sync);
}

function held(id: string, on: boolean): void {
  const s = useFreeState.getState();
  if (!!s.held[id] === on) return;
  // It shows while the desk says so, once a day: when the desk stops saying it, the line goes for the day.
  let busy = on ? s.busy : { ...s.busy, [id]: false };
  if (on && !s.busy[id] && s.phase === 'free') {
    // The first time in a day, and only if the office hasn't spoken up today already.
    const day = s.time?.startsAt ?? new Date().toDateString();
    if (readPref(SAID_ON) !== day) {
      writePref(SAID_ON, day);
      busy = { ...s.busy, [id]: true };
    }
  }
  useFreeState.setState({ held: { ...s.held, [id]: on }, busy });
}

// ----- `npm run dev` and the shell specs: set the day's time, and play an upgrade, by hand. Not in a production build.

function devHooks(): void {
  (window as unknown as Record<string, unknown>)['__maFree'] = {
    /** Minutes used of the limit, today to the next local midnight. */
    time(usedMin: number, limitMin = 45): void {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      override = { usedSeconds: Math.min(usedMin, limitMin) * 60, limitSeconds: limitMin * 60, startsAt: start.toISOString(), resetsAt: end.toISOString() };
      devTime();
    },
    /** `npm run dev` only, where nothing re-reads `/v1/me`: the tier changes here, and an `officer` gets a Work desk setting up. */
    upgrade(tier: string): void {
      const me = useSession.getState().me;
      if (!me) return;
      useSession.setState({ me: { ...me, membership: { ...me.membership, tier } } });
      if (!import.meta.env.DEV || (tier !== 'officer' && tier !== 'lead')) return;
      window.setTimeout(() => {
        const desks = [...useDeskStore.getState().desks];
        if (desks.some((d) => d.kind === 'work')) return;
        desks.push({ id: 'd-work-dev', name: 'Work', kind: 'work', vm: 'setting-up', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {} });
        setDeskListDirect(desks);
        reconcileLayout(desks.map((d) => d.id));
        void syncLinks(desks.map((d) => d.id));
      }, 1_200);
    },
    held,
  };
}
