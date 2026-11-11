// The session state machine: signed out, signed in, or refused. Sign-in always comes first; an
// account the API refuses learns it from a 403 after signing in.
import { create } from 'zustand';
import { dropLastMeter, showLastMeter } from '../bandwidth/store';
import { initialsOf } from '../chrome/avatar';
import { closeAllLinks, dropAdultOnlySummaries, syncLinks } from '../desk/liveStore';
import { clearDeskMirror, dropMirroredDesks, guildDeskIds, renameDeskInStore, setDeskList, setDeskListDirect, setDeskListError, setUnpaid, useDeskStore, type DeskInfo } from '../state/deskStore';
import { fitLayoutToBand, reconcileLayout, useLayoutStore } from '../state/layoutStore';
import { closeAdultOnlyWindows } from '../state/windowStore';
import { ageBandOf, ageRulesOn, awaitingParent, currentBand, setCurrentBand } from './age';
import { ApiError, getDesks, getMe, postSignOut, type DesksResponse, type Me } from './api';
import { answeredWithin, endSession, EVERYWHERE_WAIT_MS, finishSignIn, forAtMost, hasStoredSession, onMemberChange, ownSignInPath, retryRefreshNow, sessionWasRefused, SignInRequired, takeEndedChoice, startSignIn, usesManagedLogin } from './auth';
import { accountUrl, getClientConfig, loadedConfig, type ClientConfig } from './clientConfig';
import { dropExportSoon, keepExportFor } from './exportSweep';
import { linkFromAddress, linksOn } from '../open/intent';
import { clearLastScreens, keepLastScreens } from '../browser/lastScreen';
import { checkedConfig, checkedLastMe, forgetLastKnown, lastKnownFor, lastMeOf, readLastKnown, rememberLastKnown } from './lastKnown';
import { signInAddress } from './signInAddress';
import { placeTokenFor } from './tokenStore';

export type SessionStatus = 'booting' | 'signedOut' | 'signedIn' | 'refused';

interface SessionState {
  status: SessionStatus;
  /** A calm line for the sign-in screen, such as "You're signed out." */
  notice: string | null;
  me: Me | null;
  /** `GET /v1/me` didn't answer. Tried again with each poll of the desk list. */
  meFailed: boolean;
  config: ClientConfig | null;
  configFailed: boolean;
}

export const useSession = create<SessionState>(() => ({
  status: 'booting',
  notice: null,
  me: null,
  meFailed: false,
  config: null,
  configFailed: false,
}));

const set = (p: Partial<SessionState>): void => useSession.setState(p);

/**
 * `me` is what this member's last visit drew (`platform/lastKnown.ts`), not yet Platform's word: the avatar and the menu
 * draw from it, but nothing that decides waits on it (the age rules' wait, `waitsForBand`), and it has no status, age band
 * or roles, so the no-desk cards, the tier and the owner's rows still wait for `/v1/me`.
 */
let meIsLastKnown = false;

async function loadConfig(): Promise<ClientConfig | null> {
  try {
    const config = await getClientConfig();
    set({ config, configFailed: false });
    rememberLastKnown('config', config);
    return config;
  } catch {
    set({ configFailed: true });
    return null;
  }
}

export function retryConfig(): void {
  void loadConfig();
}

/** What this browser keeps of a member for a quick start, which whoever signs in next mustn't see. */
function forgetMember(): Promise<void> {
  clearDeskMirror();
  forgetLastKnown();
  return forAtMost(clearLastScreens());
}

function goSignedOut(notice: string | null): void {
  stopPolling();
  closeAllLinks();
  meIsLastKnown = false;
  set({ status: 'signedOut', notice, me: null, meFailed: false });
  void forgetMember();
  void loadConfig();
}

function refused(): void {
  stopPolling();
  closeAllLinks();
  clearDeskMirror();
  forgetLastKnown();
  set({ status: 'refused' });
}

/** A sign-out or a redirect has begun. A poll still on its way mustn't start anything else. */
let leaving = false;
/** True from the first press of Sign out, so a second press, or a Sign in, can't start anything that cuts it off. */
let signingOut = false;
const LEFT_FOR_SIGN_IN_KEY = 'ma.auth.leftForSignIn';
const LEFT_FOR_SIGN_IN_GUARD_MS = 30_000;

/**
 * Whether this may go off to sign in by itself. Not again within 30 s of the last time: a session that dies that
 * soon after coming back, or a managed login that comes straight back signed out, would go round and round. It
 * lives in sessionStorage so it outlasts the trip, wherever sign-in is, and it's this tab's alone. If it can't be
 * kept the answer is no, since the card can't loop.
 */
function mayLeaveForSignIn(): boolean {
  try {
    const last = Number(sessionStorage.getItem(LEFT_FOR_SIGN_IN_KEY));
    if (last && Math.abs(Date.now() - last) < LEFT_FOR_SIGN_IN_GUARD_MS) return false;
    sessionStorage.setItem(LEFT_FOR_SIGN_IN_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * The API or a refresh says sign in again. Only a token this tab had refused goes off to sign in: to the sign-in
 * pages, carrying the path and their line, or to managed login, which can carry neither, so it comes back to `/`.
 * Anything else gets the card: with no token left, the likely cause is a sign-out in another tab, and a 401 with a
 * good token wouldn't be mended by signing in. So does the setting being on with its route not there yet.
 */
async function sessionOver(): Promise<void> {
  if (leaving) return;
  const cfg = sessionWasRefused() ? await loadConfig() : null;
  if (leaving) return;
  const own = cfg && ownSignInPath(cfg);
  const address = own && signInAddress(own, { return: window.location.pathname + window.location.search, notice: takeEndedChoice() ?? 'session' });
  // A dead session ends an unfinished export as a sign-out does: whoever signs in next may be someone else.
  await dropExportSoon();
  if (cfg && (address || usesManagedLogin(cfg)) && mayLeaveForSignIn()) {
    leaving = true;
    stopPolling();
    closeAllLinks();
    await forgetMember();
    // Replace: Back mustn't land on a page that sends them here again.
    if (address) window.location.replace(address);
    else await startSignIn(cfg, undefined, 'replace');
    return;
  }
  goSignedOut('Please sign in again.');
}

// ----- the desk list: GET /v1/desks with If-None-Match (contract desks.md, polling)
let pollTimer = 0;
let etag: string | null = null;
/** The last full answer. A 304 says the list still reads this way, whatever a link has reported since. */
let lastList: DesksResponse | null = null;
/** When the last answer (a 304 included) was asked for: a link's word since then is newer (`setDeskList`). */
let lastAskedAt: number | undefined;
let polling = false;
const RETRY_MS = 15_000;

function stopPolling(): void {
  polling = false;
  window.clearTimeout(pollTimer);
}

/**
 * With the age rules on, a desk this browser has no layout for waits for `/v1/me`: it would be drawn with every app, and
 * a teen must never see the Agent, even for a moment. A desk with a layout here doesn't wait, since a teen's holds no
 * Agent to begin with (`fitLayoutToBand`). With them off, nothing ever waits. If `/v1/me` fails, it says it can't reach
 * the desks and keeps asking, the careful answer while it can't know who this is.
 */
let waitingForBand = false;
function waitsForBand(res: DesksResponse): boolean {
  if (!ageRulesOn(loadedConfig()) || (useSession.getState().me && !meIsLastKnown)) return false;
  const { desks } = useLayoutStore.getState();
  return res.desks.some((d) => !desks[d.deskId]);
}

function applyDesks(res: DesksResponse): void {
  const status = res.membership?.status;
  if ((status === 'unpaid' || status === 'waitlisted') && !res.desks.length) {
    setUnpaid(res.membership?.billingUrl ?? null);
    return;
  }
  waitingForBand = waitsForBand(res);
  if (waitingForBand) {
    if (useSession.getState().meFailed) setDeskListError();
    return;
  }
  // The Guild Desks follow their own list (`guild/guildStore.ts`), and stay through this one.
  const ids = [...res.desks.map((d) => d.deskId), ...guildDeskIds()];
  reconcileLayout(ids);
  setDeskList(res.desks, lastAskedAt);
  void syncLinks(ids);
}

/**
 * Names this tab gave desks (`deskRenamed`), laid over a list that was asked for before a rename and answered after
 * it, so the old name can't come back for a poll. The next answer is Platform's own.
 */
const renamedHere = new Map<string, string>();
let renames = 0;
const withName = (res: DesksResponse, deskId: string, name: string): DesksResponse =>
  ({ ...res, desks: res.desks.map((d) => (d.deskId === deskId ? { ...d, name } : d)) });

async function pollOnce(): Promise<number> {
  try {
    const asked = renames;
    const askedAt = Date.now();
    const r = await getDesks(etag);
    lastAskedAt = askedAt;
    if (r.data) {
      etag = r.etag;
      lastList = asked === renames ? r.data : [...renamedHere].reduce((res, [id, name]) => withName(res, id, name), r.data);
    }
    // A 304 is the same answer again, so it does what that answer does. `syncLinks` alone wouldn't bring
    // back a resting link: it reopens only what the store says runs, and that link told the store otherwise.
    if (lastList) applyDesks(lastList);
    const { me, meFailed } = useSession.getState();
    // A teen waiting on a parent sees the card change by itself, once the parent has agreed.
    if (meFailed || awaitingParent(me)) void loadMe();
    return (waitingForBand && meFailed ? RETRY_MS / 1000 : lastList?.pollAfterSeconds ?? 60) * 1000;
  } catch (err) {
    if (err instanceof SignInRequired) {
      await sessionOver();
      return -1;
    }
    if (err instanceof ApiError && err.status === 403) {
      refused();
      return -1;
    }
    // A refresh that failed for now lands here too (RefreshUnavailable): the token is kept, and this retry brings it back.
    setDeskListError();
    return RETRY_MS;
  }
}

function schedule(ms: number): void {
  if (!polling || ms < 0) return;
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    if (document.hidden) return; // resumes on visibilitychange
    void pollOnce().then(schedule);
  }, ms);
}

function startPolling(): void {
  polling = true;
  etag = null;
  lastList = null;
  lastAskedAt = undefined;
  void pollOnce().then(schedule);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  retryRefreshNow();
  if (polling) void pollOnce().then(schedule);
});

/** Back online or back in this tab, with the list failing: don't wait out either backoff. */
function onWakeUp(): void {
  retryRefreshNow();
  if (polling && !document.hidden && useDeskStore.getState().status === 'error') void pollOnce().then(schedule);
}
window.addEventListener('online', onWakeUp);
window.addEventListener('focus', onWakeUp);

/**
 * A rename Platform has saved (`PATCH /v1/desks/{deskId}`, contract tiers.md section 8): everywhere the name shows has
 * it at once, the canvas, the windows, the bars and the mirror, with no reload and no wait for the next poll.
 */
export function deskRenamed(deskId: string, name: string): void {
  renames += 1;
  renamedHere.set(deskId, name);
  if (lastList) {
    lastList = withName(lastList, deskId, name);
    applyDesks(lastList);
  } else {
    renameDeskInStore(deskId, name); // a fixture's list, which Platform never sent
  }
}

/**
 * Tier names from a fresh client-config (the new-version check's, every 15 minutes), so a tab left open picks up the
 * owner's rename of a tier without a reload. Nothing changes if they're the same.
 */
export function freshTierNames(raw: unknown): void {
  const config = useSession.getState().config;
  if (!config || JSON.stringify(config.tierNames) === JSON.stringify(raw)) return;
  set({ config: { ...config, tierNames: raw } });
}

export function retryDesks(): void {
  retryRefreshNow();
  if (polling) void pollOnce().then(schedule);
}

/** What `/v1/me` says about age takes hold before anything can draw from it. Nothing happens for no band, as ever. */
function learnBand(me: Me): void {
  const band = ageBandOf(me);
  if (band === currentBand()) return;
  setCurrentBand(band);
  fitLayoutToBand();
  if (band === 'teen') {
    closeAdultOnlyWindows();
    dropAdultOnlySummaries();
  }
}

function meUnknown(): void {
  set({ meFailed: true });
  if (!waitingForBand) return;
  setDeskListError();
  schedule(RETRY_MS);
}

/**
 * This tab's tokens are someone's: the first ones, or another member's after a sign-in in another tab. An unfinished
 * export that isn't theirs goes, and the account menu reads who they are again rather than show the last member.
 */
onMemberChange((sub, before) => {
  void keepExportFor(sub);
  if (!lastKnownFor(sub)) dropLastKnown();
  if (before === null || useSession.getState().status !== 'signedIn') return;
  meIsLastKnown = false;
  set({ me: null, meFailed: false });
  void loadMe();
});

/** Each read of `me`: an answer to an older one, for the member before, is dropped. */
let meReads = 0;

/** `/v1/me` again: the free tier's chunk asks on coming back to the tab, to notice an upgrade made in another one. */
export const rereadMe = (): Promise<void> => loadMe();

/**
 * A returning visit (a token kept here): draw what this member's last visit drew, at once, while client-config, the
 * token refresh, `/v1/me`, the meter and the list are on their way, and warm the connections they'll need. Each fresh
 * answer replaces it. Not on `/export`, which waits for client-config's own word.
 */
function showLastKnown(): void {
  const last = readLastKnown();
  if (!last) return;
  const me = checkedLastMe(last.me);
  const config = /^\/export\/?$/.test(window.location.pathname) ? null : checkedConfig(last.config);
  if (me && !useSession.getState().me) {
    meIsLastKnown = true;
    const { avatarUrl, avatar } = me;
    set({ me: { userId: me.userId, displayName: me.displayName, membership: { badge: me.badge }, ...(avatarUrl ? { avatarUrl } : {}), ...(avatar ? { avatar } : {}) } as Me });
  }
  if (config && !useSession.getState().config) {
    set({ config });
    preconnect([config.auth.domain, config.api]);
  }
  if (last.usage) showLastMeter(last.usage);
}

/** The first token says this browser's kept record was someone else's: what was drawn from it goes. */
function dropLastKnown(): void {
  if (meIsLastKnown) {
    meIsLastKnown = false;
    set({ me: null });
  }
  dropLastMeter();
  dropMirroredDesks();
}

/** Opens the connections a returning visit's first calls need (the token refresh's above all), before they're made. */
function preconnect(urls: string[]): void {
  for (const url of urls) {
    try {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = new URL(url).origin;
      link.crossOrigin = 'anonymous'; // fetch's CORS requests go on the anonymous connections
      document.head.append(link);
    } catch {
      /* not a URL: nothing to warm */
    }
  }
}

async function loadMe(): Promise<void> {
  const read = ++meReads;
  try {
    const r = await getMe();
    if (read !== meReads) return;
    if (!r.data) {
      meUnknown();
      return;
    }
    learnBand(r.data);
    placeTokenFor(r.data);
    meIsLastKnown = false;
    set({ me: r.data, meFailed: false });
    rememberLastKnown('me', lastMeOf(r.data, initialsOf(r.data.displayName, r.data.email)));
    if (waitingForBand && lastList) applyDesks(lastList);
  } catch (err) {
    if (read !== meReads) return;
    if (err instanceof ApiError && err.status === 403) refused();
    // Anything else: the account menu shows less, and an empty desk list can't say why it's empty.
    else meUnknown();
  }
}

/**
 * A sign-in in another tab has put someone else's token here (`layoutSync`). With the age rules on, this tab asks who
 * they are again, so a teen's sign-in can't keep an adult's apps open here.
 */
export function memberChanged(): void {
  if (!ageRulesOn(loadedConfig())) return;
  meIsLastKnown = false;
  set({ me: null, meFailed: false });
  void loadMe();
}

function enterApp(): void {
  keepLastScreens();
  set({ status: 'signedIn', notice: null });
  void loadConfig();
  startPolling();
  void loadMe();
}

/** Dev and test fixtures, stripped from production builds. */
async function fixtureDesks(): Promise<{ desks: DeskInfo[]; apply: () => void } | null> {
  if (import.meta.env.MODE === 'production') return null;
  const name = new URLSearchParams(window.location.search).get('fixture') ?? (import.meta.env.DEV ? 'three' : null);
  if (!name) return null;
  const { makeFixture } = await import('../desk/fixtures');
  return makeFixture(name);
}

export async function bootSession(): Promise<void> {
  const fixture = await fixtureDesks();
  if (import.meta.env.DEV && fixture) {
    // `npm run dev` runs with no network at all.
    fixture.apply();
    setDeskListDirect(fixture.desks);
    void syncLinks(fixture.desks.map((d) => d.id));
    // `?age=teen` or `?age=adult` shows the office as that age band has it.
    const q = new URLSearchParams(window.location.search);
    const ageBand = q.get('age');
    // `?tier=free` is the free tier's office (S-119), with the free chunk's own stand-ins for its wire (`free/wire.ts`).
    const tier = q.get('tier');
    const me: Me = { userId: 'dev', email: 'dev@localhost', displayName: 'Dev', ...(ageBand || tier ? { membership: { ...(ageBand ? { ageBand } : {}), ...(tier ? { tier, status: 'active' } : {}) } } : {}) };
    learnBand(me);
    set({ status: 'signedIn', me });
    return;
  }

  const path = window.location.pathname;
  // The Desk app has no such page: it's the Platform app's, which asks for its own sign-in, so nothing here
  // comes first. Replace, so Back doesn't land here and bounce. Without a good link, this path carries on as any other.
  if (/^\/account\/?$/.test(path)) {
    const cfg = await loadConfig();
    const account = cfg && accountUrl(cfg);
    if (account) {
      window.location.replace(account);
      return;
    }
  }
  if (path === '/signed-out') {
    window.history.replaceState(null, '', '/');
    goSignedOut("You're signed out.");
    return;
  }
  if (path === '/auth/callback') {
    const search = window.location.search;
    window.history.replaceState(null, '', '/');
    // A sign-in can come straight from the sign-in pages over someone else's stored session: none of their pictures stay.
    await forAtMost(clearLastScreens());
    try {
      await finishSignIn(search);
      enterApp();
    } catch (err) {
      // With our own pages on, only Google comes back here, and they say what happened, in their words.
      const cfg = await loadConfig();
      const form = cfg && signInAddress(cfg.auth.signInPath, { error: 'google' });
      if (form) {
        window.location.replace(form);
        return;
      }
      goSignedOut(err instanceof SignInRequired ? err.message : "That sign-in didn't complete. Please try again.");
    }
    return;
  }
  if (await hasStoredSession()) {
    showLastKnown();
    if (fixture) {
      // A test fixture replaces the desk list only: auth still runs for real.
      set({ status: 'signedIn', notice: null });
      fixture.apply();
      setDeskListDirect(fixture.desks);
      void syncLinks(fixture.desks.map((d) => d.id));
      void loadConfig();
      void loadMe();
      return;
    }
    // Paint the shell at once from the mirror (budget B15); the list and the refresh follow behind it.
    enterApp();
    return;
  }
  // Nobody's signed in, so there's nothing to show first, and this screen waits for client-config to say where to
  // go. Managed login can send them straight back with no code, so that way has the guard, and the card ends it.
  // Whoever signs in next may be someone else, so an unfinished export and the kept pictures go first.
  const [cfg] = await Promise.all([loadConfig(), dropExportSoon(), forgetMember()]);
  // A link sent to the office (`/open`, #9) shows its own sign-in card first, which names the link, so this doesn't go
  // off to sign in by itself (`chrome/CalmScreen.tsx`).
  if (cfg && linkFromAddress() && linksOn(cfg)) {
    goSignedOut(null);
    return;
  }
  if (cfg && ownSignInPath(cfg)) {
    // Replace, as for managed login: Back mustn't land on this page, which sends them straight back there.
    await startSignIn(cfg, undefined, 'replace');
    return;
  }
  if (cfg && usesManagedLogin(cfg) && mayLeaveForSignIn()) {
    await startSignIn(cfg, undefined, 'replace');
    return;
  }
  goSignedOut(null);
}

export async function signIn(provider?: 'Google'): Promise<void> {
  // A sign-out on its way ends at Cognito's logout. Leaving for sign-in now would cut its revoke off and skip the logout.
  if (signingOut) return;
  const cfg = useSession.getState().config ?? (await loadConfig());
  if (cfg) await startSignIn(cfg, provider);
}

const beforeSignOut = new Set<() => Promise<void>>();

/** Last words while the session still works, such as a layout that hasn't saved yet. Never holds sign-out up for long. */
export function onBeforeSignOut(fn: () => Promise<void>): () => void {
  beforeSignOut.add(fn);
  return () => beforeSignOut.delete(fn);
}

/** "Sign out everywhere" didn't hear yes from Platform. Nothing ended: the member is still signed in here and elsewhere. */
export class SignOutEverywhereFailed extends Error {}

/**
 * Contract auth.md section 6. Each step is best effort: the browser ends up signed out either way. Each call is waited
 * for, up to `SIGN_OUT_WAIT_MS`, as Platform's sign-out does, and is `keepalive`, so leaving never cuts one off.
 *
 * `everywhere` is the one exception: step 1 ends every session the member has, and it must hear yes, up to
 * `EVERYWHERE_WAIT_MS`. If it doesn't, this throws `SignOutEverywhereFailed` and the office carries on as it was, the
 * list's poll included, since saying "signed out everywhere" when it may not be so is the one wrong answer. A session
 * that died meanwhile then ends as any dead session does, on that poll. With a yes, this browser signs out as usual.
 */
export async function signOut(opts: { everywhere?: boolean } = {}): Promise<void> {
  if (signingOut) return; // a second press: a second run would leave for the logout before the first's revoke is done
  signingOut = true;
  leaving = true;
  const wasPolling = polling;
  stopPolling();
  const lastWords = Promise.all([...beforeSignOut].map((fn) => fn().catch(() => {})));
  if (opts.everywhere) {
    // Last words first, while this session still works: once every session has ended, this one's tokens are refused too.
    // An unfinished export stays until the yes, since a failure leaves the member where they were.
    await lastWords;
    if (!(await answeredWithin(postSignOut(true), EVERYWHERE_WAIT_MS))) {
      signingOut = false;
      leaving = false;
      if (wasPolling) startPolling();
      throw new SignOutEverywhereFailed('sign-out everywhere was not confirmed');
    }
    await dropExportSoon();
  } else {
    await Promise.all([lastWords, dropExportSoon()]);
    await forAtMost(postSignOut()); // tokens still get revoked below
  }
  closeAllLinks();
  clearDeskMirror();
  forgetLastKnown();
  await forAtMost(clearLastScreens()); // the next person on this computer sees none of the kept pictures
  const cfg = useSession.getState().config ?? (await loadConfig());
  await endSession(cfg);
}
