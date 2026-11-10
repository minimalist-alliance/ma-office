// The member's guilds in the office (task 48). `GET /v1/guilds` says which guilds they're in, up to three, and each guild's
// one shared Guild Desk becomes a panel in the Guild scope, named for the guild. Its link is the desk's own, opened with a
// guild token (`access.ts`). This store keeps the list, each Guild Desk's last known state, who deskd says this member is on
// it (`guild.hello`), and the guilds the member has just left or been removed from, until they put the panel away.
//
// It starts once the session knows who the member is, so a teen's office never draws an Agent tile, even for a moment, and
// it forgets everything when the session ends. Polls are quiet: a failure keeps what's shown and asks again later.
import { create } from 'zustand';
import { linkOf, syncLinks, useLiveStore } from '../desk/liveStore';
import { ApiError } from '../platform/api';
import { SignInRequired } from '../platform/auth';
import { loadedConfig } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import { focusDesk } from '../shell/actions';
import { allDeskIds, setGuildDesks, useDeskStore, type DeskInfo } from '../state/deskStore';
import { reconcileLayout, useLayoutStore } from '../state/layoutStore';
import { setView } from '../state/viewStore';
import { setGuildAccessHooks } from './access';
import { getGuildDesk, getGuilds, type GuildDesk, type GuildHello, type GuildMine } from './api';
import { guildIdOfPanel, guildPanelId, guildVm, myGuilds } from './panel';

export type GuildListStatus = 'idle' | 'loading' | 'ready' | 'error' | 'off';

export interface GuildState {
  status: GuildListStatus;
  guilds: GuildMine[];
  /** Each Guild Desk's last word from Platform, by guild id. */
  desks: Record<string, GuildDesk>;
  /** Who deskd says this member is on each Guild Desk, from the open session. More current than the list. */
  hello: Record<string, GuildHello>;
  /** Guilds the member was in on this page and isn't any more, by id, with the name they had. */
  removed: Record<string, string>;
  /** The guild settings sheet, open on one guild's agent limits or usage (`GuildSheet.tsx`). */
  sheet: { guildId: string; view: GuildSheetView } | null;
  /** A link pressed in a guild page, waiting for the member to pick which of their own desks opens it (`GuildLinkChoice`). */
  linkChoice: string | null;
  /** Each guild's caps on one member's agent, by guild id, from `guild.settings.get` and every save: the Agent's sidebar shows them. */
  caps: Record<string, GuildMemberCaps>;
  /** The Agent line's "Guild limits", pressed: by Guild Desk panel id, a count the Agent window opens its drawer on. */
  limitsAsk: Record<string, number>;
}

/** What one member's agent may spend and run on a Guild Desk; null is no cap. */
export interface GuildMemberCaps {
  runsPerDay: number | null;
  usdPerDay: number | null;
  usdPerMonth: number | null;
}

export type GuildSheetView = 'limits' | 'usage';

const FRESH: GuildState = { status: 'idle', guilds: [], desks: {}, hello: {}, removed: {}, sheet: null, linkChoice: null, caps: {}, limitsAsk: {} };
export const useGuildStore = create<GuildState>(() => FRESH);
const set = (p: Partial<GuildState>): void => useGuildStore.setState(p);

const LIST_EVERY_MS = 60_000;
const RETRY_MS = 15_000;
/** A guild route that keeps saying no, for a guild the list still has, costs a read of the list this often at most. */
const RECHECK_GAP_MS = 60_000;

let running = false;
let timer = 0;
let etag: string | null = null;
let generation = 0;
/** Guilds this page has shown, so one that goes from the list is said rather than vanishing. */
const shown = new Map<string, string>();
/** `?guild=<guildId>` from the guild app's links: that Guild Desk, selected and opened, once its panel exists. */
let wanted: string | null = new URLSearchParams(window.location.search).get('guild');

// ----- what the office shows

function infoOf(g: GuildMine, desk: GuildDesk | undefined): DeskInfo {
  return {
    id: guildPanelId(g.guildId),
    name: g.name,
    kind: 'guild',
    vm: guildVm(desk?.state),
    phase: desk?.state === 'running' ? 'ready' : desk?.state === 'starting' || desk?.state === 'provisioning' ? (desk.phase && desk.phase !== 'ready' ? desk.phase : 'starting') : null,
    queuePosition: null,
    stopAt: null,
    givebackUntil: null,
    badges: {},
    guild: { guildId: g.guildId, role: g.role, grants: Array.isArray(g.grants) ? g.grants.filter((x) => typeof x === 'string') : [] },
  };
}

function removedInfo(guildId: string, name: string): DeskInfo {
  return { id: guildPanelId(guildId), name, kind: 'guild', vm: 'removed', phase: null, queuePosition: null, stopAt: null, givebackUntil: null, badges: {}, removed: true };
}

/**
 * The panels, their layouts and their links, after a change here. Nothing at all when nothing changed, so a poll that
 * says the same costs the links nothing. The member's own list has to have answered first.
 */
function publish(): void {
  const s = useGuildStore.getState();
  const present = new Set(s.guilds.map((g) => g.guildId));
  const changed = setGuildDesks([
    ...s.guilds.map((g) => infoOf(g, s.desks[g.guildId])),
    ...Object.entries(s.removed).filter(([id]) => !present.has(id)).map(([id, name]) => removedInfo(id, name)),
  ]);
  if (useDeskStore.getState().status === 'loading') return; // the session's own list brings these along (`applyDesks`)
  if (!changed) {
    openWanted();
    return;
  }
  const ids = allDeskIds();
  reconcileLayout(ids);
  void syncLinks(ids);
  openWanted();
}

/** `?guild=` on load: the Guild scope, and that Guild Desk focused, which wakes it as a member's own focus does. */
function openWanted(): void {
  if (!wanted || useGuildStore.getState().status !== 'ready') return;
  const guildId = wanted;
  const present = useGuildStore.getState().guilds.some((g) => g.guildId === guildId);
  const id = guildPanelId(guildId);
  if (present && !useLayoutStore.getState().desks[id]) return; // its layout comes with the next publish
  wanted = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('guild');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  if (!present) return; // not one of theirs: the office as it is
  setView({ scope: 'guild' });
  focusDesk(id);
}

// ----- the list

function applyList(list: GuildMine[]): void {
  const s = useGuildStore.getState();
  const guilds = myGuilds(list);
  const ids = new Set(guilds.map((g) => g.guildId));
  const removed = { ...s.removed };
  for (const [id, name] of shown) if (!ids.has(id)) removed[id] = name;
  for (const id of ids) delete removed[id]; // back in it: the panel is a Guild Desk again
  shown.clear();
  for (const g of guilds) shown.set(g.guildId, g.name);
  const desks = Object.fromEntries(Object.entries(s.desks).filter(([id]) => ids.has(id)));
  const hello = Object.fromEntries(Object.entries(s.hello).filter(([id]) => ids.has(id)));
  const sheet = s.sheet && ids.has(s.sheet.guildId) ? s.sheet : null;
  set({ status: 'ready', guilds, removed, desks, hello, sheet });
  publish();
}

async function readList(gen: number): Promise<number> {
  try {
    const r = await getGuilds(etag);
    if (gen !== generation) return -1;
    if (r.data) {
      etag = r.etag;
      applyList(Array.isArray(r.data.guilds) ? r.data.guilds : []);
    }
    void refreshIdle(gen);
    return LIST_EVERY_MS;
  } catch (err) {
    if (gen !== generation) return -1;
    if (err instanceof SignInRequired) return -1; // the session takes it from here
    // No guild routes here yet (prod before they ship) or guilds switched off: nothing to show, nothing to ask again.
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      set({ status: 'off', guilds: [], desks: {}, hello: {} });
      shown.clear();
      publish();
      return -1;
    }
    if (useGuildStore.getState().status !== 'ready') set({ status: 'error' });
    return RETRY_MS;
  }
}

/**
 * A Guild Desk whose link isn't open learns its state with the list, so one another member woke shows as awake and its
 * session opens, as a member's own running desk's does. One read per guild a minute at most.
 */
async function refreshIdle(gen: number): Promise<void> {
  for (const g of useGuildStore.getState().guilds) {
    const link = linkOf(guildPanelId(g.guildId));
    if (link && link.status() === 'open') continue;
    try {
      const desk = (await getGuildDesk(g.guildId)).data;
      if (gen === generation && desk) noteDesk(g.guildId, desk);
    } catch {
      // The list has just said the member's in it: the next one says if that's changed.
    }
  }
}

function schedule(ms: number): void {
  window.clearTimeout(timer);
  timer = 0;
  if (!running || ms < 0) return;
  timer = window.setTimeout(() => {
    timer = 0;
    if (document.hidden) return; // the tab coming back asks
    const gen = generation;
    void readList(gen).then((next) => gen === generation && schedule(next));
  }, ms);
}

function readNow(): void {
  if (!running) return;
  const gen = generation;
  window.clearTimeout(timer);
  timer = 0;
  void readList(gen).then((next) => gen === generation && schedule(next));
}

let recheckedAt = -Infinity;
/** A guild route said 403 or 404: read the list now, which says whether the member is still in that guild. */
function recheckSoon(): void {
  if (!running || Date.now() - recheckedAt < RECHECK_GAP_MS) return; // the next regular read will say
  recheckedAt = Date.now();
  readNow();
}

function noteDesk(guildId: string, desk: GuildDesk): void {
  const s = useGuildStore.getState();
  if (!s.guilds.some((g) => g.guildId === guildId)) return;
  const was = s.desks[guildId];
  if (was && was.state === desk.state && was.deskId === desk.deskId) return;
  set({ desks: { ...s.desks, [guildId]: desk } });
  publish();
}

setGuildAccessHooks({ desk: noteDesk, refused: recheckSoon });

// The member's own list answering lays the Guild Desks out with it (`session.ts`), so `?guild=` can open its desk now.
useDeskStore.subscribe((s, was) => {
  if (was.status === 'loading' && s.status !== 'loading') openWanted();
});

// ----- who deskd says this member is

const helloAsked = new Set<string>();
useLiveStore.subscribe((live, was) => {
  for (const [id, d] of Object.entries(live.desks)) {
    const guildId = guildIdOfPanel(id);
    if (!guildId) continue;
    const open = d.link === 'open';
    if (!open) {
      if (was.desks[id]?.link === 'open') helloAsked.delete(id);
      continue;
    }
    if (helloAsked.has(id)) continue;
    helloAsked.add(id);
    const gen = generation;
    linkOf(id)
      ?.call('guild.hello')
      .then((hello) => {
        if (gen !== generation || !hello || typeof hello !== 'object') return;
        set({ hello: { ...useGuildStore.getState().hello, [guildId]: hello } });
      })
      .catch(() => {
        // An older deskd, or a session that went: the list's word stands, and the next session asks again.
      });
  }
});

// ----- starting and stopping with the session

export function startGuilds(): void {
  if (running) return;
  // A kill switch only (`guilds.open` in client-config): absent is on.
  const cfg = loadedConfig() as { guilds?: { open?: boolean } } | null;
  if (cfg?.guilds?.open === false) {
    set({ status: 'off' });
    return;
  }
  running = true;
  generation += 1;
  etag = null;
  set({ status: 'loading' });
  readNow();
}

export function stopGuilds(): void {
  running = false;
  recheckedAt = -Infinity;
  generation += 1;
  window.clearTimeout(timer);
  timer = 0;
  etag = null;
  shown.clear();
  helloAsked.clear();
  useGuildStore.setState(FRESH);
}

/**
 * A Guild Desk has no Browser, and the office never moves anything between desks by itself: a link in a guild page asks
 * which of the member's own desks should open it, "Open on Personal" or "Open on Work" (draft ADR section 1).
 */
export function chooseLinkDesk(href: string): void {
  set({ linkChoice: href });
}

export function clearLinkChoice(): void {
  if (useGuildStore.getState().linkChoice !== null) set({ linkChoice: null });
}

export function openGuildSheet(guildId: string, view: GuildSheetView): void {
  set({ sheet: { guildId, view } });
}

/** The guild's caps on each member's agent, as deskd last said them. */
export function setGuildCaps(guildId: string, caps: GuildMemberCaps): void {
  const was = useGuildStore.getState().caps[guildId];
  if (was && was.runsPerDay === caps.runsPerDay && was.usdPerDay === caps.usdPerDay && was.usdPerMonth === caps.usdPerMonth) return;
  set({ caps: { ...useGuildStore.getState().caps, [guildId]: { ...caps } } });
}

/** "Guild limits" on the Agent's line: the Agent window on that Guild Desk opens its own drawer there. */
export function askGuildLimits(panelId: string): void {
  const asks = useGuildStore.getState().limitsAsk;
  set({ limitsAsk: { ...asks, [panelId]: (asks[panelId] ?? 0) + 1 } });
}

export function closeGuildSheet(): void {
  if (useGuildStore.getState().sheet) set({ sheet: null });
}

/** The member puts away the panel of a guild they're no longer in. */
export function dismissRemoved(guildId: string): void {
  const removed = { ...useGuildStore.getState().removed };
  if (!(guildId in removed)) return;
  delete removed[guildId];
  set({ removed });
  publish();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && running && !timer) readNow();
});

// Signed in, and `/v1/me` has said who: start. Signed out, or someone else: forget, and start again for them.
let startedFor: string | null = null;
function follow(s: ReturnType<typeof useSession.getState>): void {
  const who = s.status === 'signedIn' && s.me ? s.me.userId : null;
  if (who === startedFor) return;
  if (startedFor) stopGuilds();
  startedFor = who;
  if (who && import.meta.env.MODE !== 'development') startGuilds(); // `npm run dev` has no network at all
}
useSession.subscribe(follow);
follow(useSession.getState());

/** Tests only. */
export function resetGuildsForTest(search = ''): void {
  stopGuilds();
  startedFor = null;
  wanted = new URLSearchParams(search).get('guild');
}
