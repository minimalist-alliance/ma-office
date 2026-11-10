// `live` of design 3.13: per-desk link state and summaries. Memory only: this is desk content
// and users may be on a shared machine. Incoming messages are applied once per animation frame.
//
// Nothing here runs per frame, and nothing lands in a store while the camera moves (design 2.2):
// updates wait for the settle. `useLive` drives the desk panels, so it holds only what changes their
// text. Numbers that change all the time go to `useAbout`, read only by "About this desk".
import { create } from 'zustand';
import { camera } from '../canvas/controller';
import { adultOnly, currentBand, mayHaveApp } from '../platform/age';
import { getMe } from '../platform/api';
import { loadedConfig, supportAddress } from '../platform/clientConfig';
import { applyDeskProgress, useDeskStore } from '../state/deskStore';
import { getView, useViewStore } from '../state/viewStore';
import { dropRoster, noteAgents } from '../agent/roster';
import { activityOfAgents, deskSummary } from './agentStatus';
import { lookedAtDesk, shownDesk } from './attention';
import { LastSound } from './sound';
import { IDLE_CHECK_MS, IdleRule } from './idle';
import { membershipBack } from './rtc/policy';
import { createDeskLink, type AgentActivity, type AppSummary, type DeskLink, type DeskRefusal, type DeskStatus, type LinkDetails, type LinkState, type SummaryMessage } from './deskLink';

export interface LiveDesk {
  link: LinkState;
  linkAvailable: boolean;
  seq: number;
  agent: AgentActivity;
  apps: Record<string, AppSummary>;
  /** 0, or 30 once the session has been lost that long. */
  lostForSec: number;
  /** `desk.status.get` in words, such as "online · c7g.large · up 3 h". For the accessible name, never drawn. */
  summary: string | null;
  /** `connect` refused this desk (contract 0.3.11). */
  refusal: DeskRefusal | null;
}

export interface DeskAbout {
  status: DeskStatus | null;
  /** When `status` arrived, so uptime can tick locally. */
  fetchedAt: number;
  path: LinkDetails['path'];
  rttMs: number | null;
}

const NO_AGENT: AgentActivity = { state: 'none' };
const EMPTY: LiveDesk = { link: 'idle', linkAvailable: false, seq: 0, agent: NO_AGENT, apps: {}, lostForSec: 0, summary: null, refusal: null };
const NO_ABOUT: DeskAbout = { status: null, fetchedAt: 0, path: null, rttMs: null };

export const useLiveStore = create<{ desks: Record<string, LiveDesk> }>(() => ({ desks: {} }));
const useAboutStore = create<{ desks: Record<string, DeskAbout> }>(() => ({ desks: {} }));
/** What each desk last said on `desk.attention` (task 46, deskd API.md section 10). Absent: it hasn't said. */
const useAttentionStore = create<{ desks: Record<string, { seen: boolean; frozen: boolean }> }>(() => ({ desks: {} }));

export const getLive = (deskId: string): LiveDesk => useLiveStore.getState().desks[deskId] ?? EMPTY;
export const useLive = (deskId: string): LiveDesk => useLiveStore((s) => s.desks[deskId] ?? EMPTY);
export const useAbout = (deskId: string): DeskAbout => useAboutStore((s) => s.desks[deskId] ?? NO_ABOUT);
/** The desk says it has frozen its Chromium, as nobody is looking at it. False where it hasn't said, or can't. */
export const useFrozen = (deskId: string): boolean => useAttentionStore((s) => s.desks[deskId]?.frozen === true);
/**
 * Someone is looking at the desk and its Chromium is still frozen: the moment to say "Resuming…", as deskd API.md
 * section 10 has it. About a tenth of a second, so the Browser window says it only past a short delay (`BrowserWindow`).
 */
export const useResuming = (deskId: string): boolean => useAttentionStore((s) => s.desks[deskId]?.seen === true && s.desks[deskId]?.frozen === true);

/** The part of `statusLine`'s input that comes from the link. */
export const liveStatusInput = (live: LiveDesk) => ({
  link: live.link,
  linkAvailable: live.linkAvailable,
  agent: live.agent,
  lostForSec: live.lostForSec,
  summary: live.summary,
  refusal: live.refusal,
  support: supportAddress(loadedConfig()),
});

export type DeskClosed = 'setting-up' | 'held' | 'membership' | 'data_guard';

/**
 * Why nothing on this desk can open now, or null. `setting-up` and `held` send nothing at all. `membership` has been
 * refused, and only the member's own act or return asks again.
 */
export function deskClosed(deskId: string): DeskClosed | null {
  const vm = useDeskStore.getState().desks.find((d) => d.id === deskId)?.vm;
  if (vm === 'setting-up') return 'setting-up';
  if (vm === 'removed') return 'held'; // a guild the member left: nothing to ask, nothing to open
  const refusal = getLive(deskId).refusal;
  if (vm === 'held' || refusal?.kind === 'unavailable') return 'held';
  if (refusal?.kind === 'data_guard') return 'data_guard';
  return refusal ? 'membership' : null;
}

/** A desk being set up or held is never asked anything: not `connect`, not a wake. */
const sendsNothing = (deskId: string): boolean => {
  const closed = deskClosed(deskId);
  return closed === 'setting-up' || closed === 'held';
};

// Held while the camera moves, so nothing a link reports can render during motion.
const whileMoving: (() => void)[] = [];
camera.onSettle(() => {
  for (const fn of whileMoving.splice(0)) fn();
});
function whenStill(fn: () => void): void {
  if (camera.isMoving()) whileMoving.push(fn);
  else fn();
}

function patch(deskId: string, p: Partial<LiveDesk>): void {
  whenStill(() => useLiveStore.setState((s) => ({ desks: { ...s.desks, [deskId]: { ...(s.desks[deskId] ?? EMPTY), ...p } } })));
}

function setAttention(deskId: string, seen: boolean, frozen: boolean): void {
  whenStill(() => {
    const was = useAttentionStore.getState().desks[deskId];
    if (was?.seen !== seen || was.frozen !== frozen) useAttentionStore.setState((s) => ({ desks: { ...s.desks, [deskId]: { seen, frozen } } }));
  });
}

function patchAbout(deskId: string, p: Partial<DeskAbout>): void {
  whenStill(() => useAboutStore.setState((s) => ({ desks: { ...s.desks, [deskId]: { ...(s.desks[deskId] ?? NO_ABOUT), ...p } } })));
}

// Batched per frame, so a burst of summaries is one store update.
const pending = new Map<string, SummaryMessage>();
let frame = 0;
function flush(): void {
  frame = 0;
  for (const [deskId, queued] of pending) {
    // What's held for a moving camera lands in order, and each adds to what the last one left. The band is read as it
    // lands, not on arrival, as `/v1/me` can answer in between; what's already landed goes in `dropAdultOnlySummaries`.
    whenStill(() => {
      const msg = currentBand() === 'teen' ? withoutAdultOnly(queued) : queued;
      const cur = getLive(deskId);
      patch(deskId, { seq: msg.seq, agent: msg.agent ?? cur.agent, apps: msg.type === 'snapshot' ? (msg.apps ?? {}) : { ...cur.apps, ...msg.apps } });
    });
  }
  pending.clear();
}

/** A teen's desk says nothing of an adults-only app, whatever a desk reports. */
function withoutAdultOnly<T extends { agent?: AgentActivity; apps?: Record<string, AppSummary> }>(s: T): T {
  const apps = s.apps && Object.fromEntries(Object.entries(s.apps).filter(([app]) => !adultOnly(app)));
  return { ...s, ...(s.agent ? { agent: NO_AGENT } : {}), ...(apps ? { apps } : {}) };
}

/** `/v1/me` has just said this member is a teen: what the desks have said so far goes too, and no link asks for the Agent's state. */
export function dropAdultOnlySummaries(): void {
  for (const held of links.values()) held.dropAgents?.();
  dropRoster();
  whenStill(() => useLiveStore.setState((s) => ({ desks: Object.fromEntries(Object.entries(s.desks).map(([id, live]) => [id, withoutAdultOnly(live)])) })));
}

function enqueue(deskId: string, msg: SummaryMessage): void {
  const held = pending.get(deskId);
  // Several in one frame add up. A snapshot wipes what came before it, and a patch keeps the snapshot's word.
  pending.set(deskId, held && msg.type !== 'snapshot' ? { ...held, ...msg, type: held.type ?? msg.type, agent: msg.agent ?? held.agent, apps: { ...held.apps, ...msg.apps } } : msg);
  if (!frame) frame = requestAnimationFrame(flush);
}

/** `dropAgents` ends the link's `agent.state` subscription, for a member `/v1/me` has just said is a teen. */
const links = new Map<string, { link: DeskLink; unsub: () => void; dropAgents?: () => void }>();
/** Asked to wake before their link exists: a reload in desk mode focuses before the list has answered. */
const wakeOnceLinked = new Set<string>();

/** Desks whose sessions the idle rule leaves open: one sending the member's export, which can take hours in a hidden tab. */
const keptOpen = new Set<string>();
export const keepOpen = (deskId: string, on: boolean): unknown => (on ? keptOpen.add(deskId) : keptOpen.delete(deskId));

/** Desks with a file transfer running (the Files app): the idle rule leaves them open, and counts the transfer as input. */
const transferring = new Set<string>();
export function setTransferBusy(deskId: string, on: boolean): void {
  if (on) transferring.add(deskId);
  else transferring.delete(deskId);
}

const idle = new IdleRule({
  busy: (id) => transferring.has(id),
  rest: (id) => keptOpen.has(id) || links.get(id)?.link?.rest(),
  resume: (id) => links.get(id)?.link?.reopen(),
  deskIds: () => links.keys(),
  media: (id) => links.get(id)?.link?.media(),
});
let idleTimer = 0;
document.addEventListener('visibilitychange', () => idle.setHidden(document.hidden));

/**
 * Whether the office is showing desks at all, which the shell says as it mounts: the export page shows none, so it
 * looks at none (`attention.ts`).
 */
let officeShown = false;
export function setOfficeShown(on: boolean): void {
  officeShown = on;
  applyAttention();
}

/** When each desk's sound last reached this tab, across its sessions (`sound.ts`). */
const heard = new Map<string, LastSound>();
let listenTimer = 0;

/** How long the shown desk's sound still counts as playing in this hidden tab: 0 once it's been quiet a minute. */
function soundLeft(deskId: string): number {
  let sound = heard.get(deskId);
  if (!sound) heard.set(deskId, (sound = new LastSound()));
  return sound.left(links.get(deskId)?.link?.media());
}

/**
 * Tell every desk whether the member is looking at it (task 46, `attention.ts`): true for the one shown in a tab that can
 * be seen, or in a hidden one while it plays sound there (ADR 0038), looked at again when the sound may have stopped;
 * false for the rest, at the moment that changes. Each link says it again on every new session, and only over an open
 * one, so this never wakes a desk.
 */
function applyAttention(): void {
  window.clearTimeout(listenTimer);
  listenTimer = 0;
  const view = getView();
  const shown = shownDesk(view, officeShown);
  const left = document.hidden && shown ? soundLeft(shown) : 0;
  if (left > 0) listenTimer = window.setTimeout(applyAttention, left);
  const looked = lookedAtDesk(view, document.hidden, officeShown, left > 0);
  for (const [id, { link }] of links) link?.setSeen(id === looked);
}
useViewStore.subscribe((v, was) => {
  if (v.mode !== was.mode || v.activeDesk !== was.activeDesk) applyAttention();
});
document.addEventListener('visibilitychange', applyAttention);

/**
 * Real input on this desk. On every such event, so it stays cheap. `local`: this app handled it, so the desk
 * hears of it as `ACTIVITY`. The stream's own input is counted by desk-rtc.
 */
export function noteDeskInput(deskId: string, local: boolean): void {
  idle.noteInput(deskId);
  if (local) links.get(deskId)?.link?.reportActivity();
}

/** This desk's link, outside React. Null until the desk list has made one. */
export const linkOf = (deskId: string): DeskLink | null => links.get(deskId)?.link ?? null;

/** This desk's link, for an app window. Null until the desk list has made one. */
export function useDeskLink(deskId: string): DeskLink | null {
  useLiveStore((s) => s.desks[deskId]?.linkAvailable ?? false); // renders again when the link appears
  return links.get(deskId)?.link ?? null;
}

/** The member focused this desk or opened one of its apps. The link decides whether that wakes it. */
export function wakeDesk(deskId: string): void {
  if (sendsNothing(deskId)) return; // they start on their own, or can't be opened
  if (deskClosed(deskId) === 'membership' || deskClosed(deskId) === 'data_guard') {
    // Never `connect`, which would only say no again: perhaps they've paid, or the owner cleared the data guard, so read the membership.
    void recheckMembership().then((back) => back && links.get(deskId)?.link?.wake());
    return;
  }
  const link = links.get(deskId)?.link;
  if (link) link.wake();
  else wakeOnceLinked.add(deskId);
}

/**
 * Desks that start with the office (the Alliance Member's hosted small desk, ma-platform ADR 0097) wake as the office
 * opens, not at the Browser's click: the owner's decision, and the one exception to "rendering never wakes a desk". Once a
 * page load each, and only while the member can see the page, so a tab opened in the background waits until it's looked at.
 */
const wokeWithOffice = new Set<string>();
function wakeWithOffice(deskId: string): void {
  if (wokeWithOffice.has(deskId) || document.hidden) return;
  if (!useDeskStore.getState().desks.find((d) => d.id === deskId)?.startsWithOffice) return;
  if (!links.get(deskId)?.link) return;
  wokeWithOffice.add(deskId);
  wakeDesk(deskId);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) for (const id of links.keys()) wakeWithOffice(id);
});

async function refreshStatus(link: DeskLink): Promise<void> {
  try {
    const status = await link.call('desk.status.get');
    patchAbout(link.deskId, { status, fetchedAt: Date.now() });
    const summary = deskSummary(status);
    if (summary !== getLive(link.deskId).summary) patch(link.deskId, { summary });
  } catch {
    // The link's own state says what's wrong. Keep the last numbers until it recovers.
  }
}

const STATUS_EVERY_MS = 15_000;
let statusTimer = 0;

function refreshOpenLinks(): void {
  if (document.hidden) return;
  for (const { link } of links.values()) {
    if (link?.available && link.status() === 'open') void refreshStatus(link);
  }
}

document.addEventListener('visibilitychange', refreshOpenLinks);

/** Not more often than this, however often the member comes back or presses. */
const MEMBERSHIP_CHECK_GAP_MS = 15_000;
let membershipCheckedAt = 0;
let membershipCheck: Promise<boolean> | null = null;

const refusedForMembership = (): DeskLink[] =>
  [...links.values()].map((e) => e.link).filter((l): l is DeskLink => !!l && !!l.details().refusal && l.details().refusal?.kind !== 'unavailable');

/**
 * Back in this tab, perhaps from paying, or a refused desk pressed. Paying brings the desks back with no other step,
 * and nothing tells this tab, so it reads `GET /v1/me`: once, never `connect`, and not within 15 s of the last read.
 * Only if the membership is active again does each refused link ask `connect` once more (`recheck`). True if it did.
 */
function recheckMembership(): Promise<boolean> {
  if (membershipCheck) return membershipCheck;
  if (document.hidden || !refusedForMembership().length || Date.now() - membershipCheckedAt < MEMBERSHIP_CHECK_GAP_MS) return Promise.resolve(false);
  membershipCheckedAt = Date.now();
  membershipCheck = getMe()
    .then((r) => {
      if (!membershipBack(r.data?.membership?.status)) return false;
      for (const link of refusedForMembership()) link.recheck();
      return true;
    })
    .catch(() => false) // the next return asks again; the refusal stands meanwhile
    .finally(() => {
      membershipCheck = null;
    });
  return membershipCheck;
}
const onReturn = (): void => void recheckMembership();
document.addEventListener('visibilitychange', onReturn);
window.addEventListener('focus', onReturn);

function applyDetails(link: DeskLink): void {
  const d = link.details();
  patchAbout(link.deskId, { path: d.path, rttMs: d.rttMs });
  const lostForSec = d.unreachable ? 30 : 0;
  if (lostForSec !== getLive(link.deskId).lostForSec) patch(link.deskId, { lostForSec });
  if (d.refusal !== getLive(link.deskId).refusal) patch(link.deskId, { refusal: d.refusal });
  if (d.desk) {
    const desk = d.desk;
    whenStill(() => applyDeskProgress(link.deskId, desk));
  }
}

/** Keep one link per given desk: open new ones, close the rest. */
export async function syncLinks(deskIds: readonly string[]): Promise<void> {
  for (const [id, entry] of links) {
    if (!deskIds.includes(id)) {
      entry.unsub();
      entry.link?.close();
      links.delete(id);
      dropRoster(id);
      idle.forget(id);
      heard.delete(id);
    }
  }
  for (const id of wakeOnceLinked) {
    if (!deskIds.includes(id)) wakeOnceLinked.delete(id);
  }
  if (!statusTimer) statusTimer = window.setInterval(refreshOpenLinks, STATUS_EVERY_MS);
  if (!idleTimer) {
    idle.setHidden(document.hidden);
    idleTimer = window.setInterval(() => idle.checkAll(), IDLE_CHECK_MS);
  }
  for (const id of deskIds) {
    const held = links.get(id);
    if (held) {
      if (!held.link) continue;
      const vm = useDeskStore.getState().desks.find((d) => d.id === id)?.vm;
      // The list says a hold or a new start: whatever was open closes, and the link rests with nothing to ask.
      if (vm === 'held' || vm === 'setting-up' || vm === 'removed') {
        if (held.link.status() !== 'idle' || held.link.details().refusal) held.link.close();
      } else if (vm === 'running' && !held.link.details().refusal) {
        // A link that stopped with its desk comes back through a fresh connect, once the desk runs. A refused one waits.
        held.link.connect();
      }
      wakeWithOffice(id);
      continue;
    }
    const claim = { link: null as unknown as DeskLink, unsub: () => {} };
    links.set(id, claim); // claim the slot across the await
    const link = await createDeskLink(id);
    if (links.get(id) !== claim) continue; // closed while it was on its way
    const offStatus = link.onStatus((state) => {
      patch(id, { link: state });
      if (state === 'open') void refreshStatus(link);
    });
    const offDetails = link.onDetails(() => applyDetails(link));
    // Once deskd's `summary` speaks for the agents it wins. Until then `agent.state` fills the panel's word, and a desk that
    // serves neither says nothing.
    let summaryAgent = false;
    const offSummary = link.subscribe('summary', (msg) => {
      if (msg.agent) summaryAgent = true;
      enqueue(id, msg);
    });
    // A teen has no Agent, so their link never asks a desk for its state. One that started before `/v1/me` said so
    // stops when it does (`dropAdultOnlySummaries`), and what it said meanwhile is stripped as it lands.
    let offAgents: (() => void) | null = mayHaveApp('agent')
      ? link.subscribe('agent.state', (msg) => {
          if (!Array.isArray(msg.agents)) return;
          if (!summaryAgent) enqueue(id, { seq: msg.seq, agent: activityOfAgents(msg.agents) });
          // Who's on this desk, for their own tiles (task 49). An uploaded icon comes over this same link, the owner's alone.
          if (currentBand() !== 'teen') noteAgents(id, msg.agents, (agentId) => link.call('agent.icon.get', { agentId }));
        })
      : null;
    const dropAgents = (): void => {
      offAgents?.();
      offAgents = null;
    };
    // A desk that doesn't serve the topic yet says nothing, and counts as never frozen.
    const offAttention = link.subscribe('desk.attention', (msg) => {
      if (typeof msg.frozen === 'boolean') setAttention(id, msg.seen === true, msg.frozen);
    });
    links.set(id, {
      link,
      unsub: () => {
        offStatus();
        offDetails();
        offSummary();
        dropAgents();
        offAttention();
      },
      dropAgents,
    });
    link.setSeen(id === lookedAtDesk(getView(), document.hidden, officeShown)); // before `connect`: its first session says it
    idle.noteInput(id); // arriving counts as being here
    patch(id, { link: link.status(), linkAvailable: link.available });
    const wakeAsked = wakeOnceLinked.delete(id);
    if (sendsNothing(id)) continue; // its link waits for the list to say it runs, and an early focus is forgotten
    link.connect();
    if (wakeAsked) link.wake();
    wakeWithOffice(id);
  }
}

export function closeAllLinks(): void {
  for (const entry of links.values()) {
    entry.unsub();
    entry.link?.close();
  }
  links.clear();
  wakeOnceLinked.clear();
  wokeWithOffice.clear();
  useAttentionStore.setState({ desks: {} });
  window.clearInterval(statusTimer);
  statusTimer = 0;
  window.clearInterval(idleTimer);
  idleTimer = 0;
}

/** Fresh numbers for the "About this desk" panel. */
export function refreshDeskStatus(deskId: string): void {
  const entry = links.get(deskId);
  if (entry?.link?.available && entry.link.status() === 'open') void refreshStatus(entry.link);
}
