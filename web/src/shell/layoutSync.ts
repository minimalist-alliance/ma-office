// A member's arrangement follows them between browsers: Platform's one document per member (contract
// desks.md, "Desk UI layout persistence"), mirrored in localStorage. The canvas paints from the mirror and
// never waits for this. The server's copy lands later, moving nothing if it's the same, and never under a drag.
//
// What's saved comes from `layoutDoc.ts`, which is pure. This holds the rest: when to read, when to write,
// and what to do when that doesn't work. No failure here is shown to the member, because the layout goes on
// working locally. What hasn't reached Platform is written down in `ma.layout.sync.v1` as soon as it changes,
// so it survives a closed tab, a crash or a day offline.
import Konva from 'konva/lib/Core.js';
import { camera } from '../canvas/controller';
import { arrivingLayout, clearLayoutDoc, fitDocToBand, isUntouched, LAYOUT_KEY, MAX_SERVER_BYTES, readLayoutDoc, readServerLayout, sameBounds, sameDesk, sameLayout, writeServerLayout, type LayoutDoc, type ServerExtra } from '../canvas/layoutDoc';
import { adoptLayoutPrefs, resetLayoutPrefs, useLayoutPrefs, withPrefs, type LayoutPrefs } from './layoutPrefs';
import { readJson, writeJson } from '../lib/util';
import { currentBand } from '../platform/age';
import { ApiError, getDeskLayout, putDeskLayout, type ApiResult, type LayoutResponse } from '../platform/api';
import { SignInRequired } from '../platform/auth';
import { decodeJwtPayload } from '../platform/pkce';
import { memberChanged, onBeforeSignOut } from '../platform/session';
import { useDeskStore } from '../state/deskStore';
import { applyQuietly, expectDesks, flushLayoutMirror, isQuietChange, isSavingLayout, LAYOUT_SYNC_KEY, layoutMirrorHeld, layoutMirrorWritable, mirrorIsOurs, reconcileLayout, useLayoutStore } from '../state/layoutStore';
import { getView } from '../state/viewStore';
import { refit } from './actions';
import { anyTidying } from './cleanup';
import { useRing } from './hidden';

export const SYNC_KEY = LAYOUT_SYNC_KEY;

/** After the last change. The contract's own suggestion, and well under its 60 PUTs a minute. */
const DEBOUNCE_MS = 2_000;
/** Steady changes can't hold a save back for longer than this. */
const LONGEST_WAIT_MS = 10_000;
const BUSY_RETRY_MS = 400;
/** How often to ask for what another browser did, while this tab is on show. */
const POLL_MS = 60_000;
/** While Platform says the route isn't there. */
const ROUTE_MISSING_POLL_MS = 15 * 60_000;
/** Coming back to a tab asks again, unless it has only just asked. */
const REFRESH_GAP_MS = 5_000;
const MAX_CONFLICTS = 3;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const FLOOR_BYTES = 8 * 1024;
const SIGN_OUT_WAIT_MS = 1_000;

interface SyncMeta {
  /** The server version this browser's copy was last level with. */
  version: number;
  /** Its ETag, as Platform sent it. */
  etag?: string;
  /** Desks changed here since then. */
  dirty: string[];
  /** Whose these are: the token's `sub`. A record of anyone else's changes means nothing to whoever signs in next. */
  member?: string | null;
}

/** The token that would go is another member's, from a sign-in in another tab. Nothing here is theirs. */
class OtherMember extends Error {}

let running = false;
/** Whose document this is, from the token the first read goes out with. Undefined until then. */
let member: string | null | undefined;
/** Goes up when the member changes under this tab, so an answer to the last one's call is dropped. */
let epoch = 0;
let version: number | null = null; // null until Platform has answered once
/** Platform's ETag for that version, exactly as it came, quotes and all. What goes back in If-Match, and what says nothing has changed. */
let etag: string | null = null;
const dirty = new Set<string>();
/** On their way, with no answer yet: what arrives meanwhile mustn't replace them, and they're still unsaved. */
let sending: readonly string[] = [];
let extra: ServerExtra = {};
/** A preference the member changed that Platform hasn't confirmed. What arrives meanwhile doesn't overrule it. */
let prefsDirty = false;
/** The document is from a newer build: leave it alone, and go on working locally. */
let frozen = false;
/** Platform has nothing usable, so what's here may be the only copy. It goes as soon as the list says whose desks these are. */
let uploading = false;
/** And for as long as that's so, a browser nobody arranged anything in has nothing to send, whatever it pressed. */
let nothingThere = false;
/** What Platform last said, as this browser reads it. A desk that comes back to this hasn't changed. Null if that isn't known. */
let base: LayoutDoc | null = null;
let routeMissing = false;
let saving = false;
let again = false;
let conflicts = 0;
let failures = 0;
let maxBytes = MAX_SERVER_BYTES;
let firstChangeAt = 0;
/** A backoff is running: nothing asks for a save sooner, not even a new change. */
let holdUntil = 0;
/** Platform said Retry-After: even a page going away waits, and the next load sends it. */
let toldUntil = 0;
let saveTimer = 0;
let pollTimer = 0;
let heldTimer = 0;
/** An arrival waiting for the member to finish. `server`: it's Platform's, and `etag` already says this browser has it. */
let held: { doc: LayoutDoc; server: boolean } | null = null;
let lastFetch = 0;
let fetching: Promise<void> | null = null;

function readMeta(): SyncMeta | null {
  const m = readJson<Partial<SyncMeta>>(SYNC_KEY);
  if (!m || typeof m.version !== 'number' || !Array.isArray(m.dirty)) return null;
  return { version: m.version, etag: typeof m.etag === 'string' ? m.etag : `"${m.version}"`, dirty: m.dirty.filter((d): d is string => typeof d === 'string'), member: m.member };
}

const unsaved = (): Set<string> => new Set([...dirty, ...sending]);

function writeMeta(): void {
  // Signed out, here or in another tab: the record went with the rest of the mirror, and nothing brings it back.
  if (!layoutMirrorWritable()) return;
  if (member === undefined) {
    // Nobody has said whose this is yet. What's on record stays, with what's new added: the first token sorts it out.
    const was = readMeta();
    writeJson(SYNC_KEY, { ...was, version: was?.version ?? 0, dirty: [...new Set([...(was?.dirty ?? []), ...unsaved()])] });
    return;
  }
  writeJson(SYNC_KEY, { version: version ?? 0, member, ...(etag ? { etag } : {}), dirty: [...unsaved()] });
}

/** Called with every token a layout call is about to send. The first says whose this is, and whether what's on record is theirs. */
function checkToken(token: string): void {
  const sub = decodeJwtPayload(token)?.['sub'];
  const who = typeof sub === 'string' ? sub : null;
  if (member === undefined) {
    member = who;
    const meta = readMeta();
    if (meta?.member === who) for (const id of meta.dirty) dirty.add(id);
    writeMeta();
    return;
  }
  if (who !== member) throw new OtherMember();
}

/** Someone else's token, so everything held here was the last member's. The desk list is already taking their desks away. */
function startOver(): void {
  epoch += 1;
  member = undefined;
  version = null;
  etag = null;
  extra = {};
  prefsDirty = false;
  resetLayoutPrefs();
  base = null;
  held = null;
  frozen = false;
  uploading = false;
  nothingThere = false;
  routeMissing = false;
  conflicts = 0;
  failures = 0;
  holdUntil = 0;
  toldUntil = 0;
  firstChangeAt = 0;
  maxBytes = MAX_SERVER_BYTES;
  dirty.clear();
  sending = [];
  saving = false;
  expectDesks({});
  window.clearTimeout(saveTimer);
  window.clearTimeout(heldTimer);
  saveTimer = 0;
  // After whatever call found this has finished, so it asks afresh.
  window.setTimeout(() => {
    if (running) void fetchServer();
  });
  memberChanged();
}

/** A member in the middle of something on the canvas. What arrives waits, and what's waiting to go waits too. */
const isBusy = (): boolean => Konva.isDragging() || !!getView().kbEdit || camera.isMoving() || anyTidying();

/** What arrives also waits for a menu, the hidden list and its ring: each was placed from where things are now. A save needn't. */
const holdsArrival = (): boolean => isBusy() || !!getView().deskMenu || !!getView().hiddenList || !!useRing.getState().ring;

const localDoc = (): LayoutDoc => {
  const { desks, z } = useLayoutStore.getState();
  return { desks, z };
};

// ----- what arrives

/** The list's desks, once there's a list. */
function listedIds(): ReadonlySet<string> | null {
  const list = useDeskStore.getState();
  return list.status === 'ready' ? new Set(list.desks.map((d) => d.id)) : null;
}

function adopt(arriving: LayoutDoc, server: boolean): void {
  // What this member's age band has, before anything compares it: the same document for anyone with no band.
  const doc = fitDocToBand(arriving, currentBand());
  window.clearTimeout(heldTimer);
  if (holdsArrival()) {
    // Another tab's mirror can't take the place of what Platform said, since the same ETag won't be read twice. That tab saves, and a later read brings it.
    if (server || !held?.server) held = { doc, server };
    heldTimer = window.setTimeout(() => {
      if (running && held) adopt(held.doc, held.server);
    }, BUSY_RETRY_MS);
    return;
  }
  held = null;
  const local = localDoc();
  // Already there, as after a save that landed just as the page went away. Only Platform can say so: another tab's
  // mirror has this tab's own unsaved change in it as soon as that tab has read it.
  if (server) {
    for (const id of [...dirty]) {
      const mine = local.desks[id];
      const theirs = doc.desks[id];
      if (mine && theirs && sameDesk(mine, theirs)) dirty.delete(id);
    }
  }
  // Platform's word is what a desk has to differ from to be a change. Another tab's mirror isn't that, and after it nothing is known.
  base = server ? clearLayoutDoc(doc) : null;
  const listed = listedIds();
  if (base && listed) expectDesks(Object.fromEntries(Object.entries(base.desks).filter(([id]) => !listed.has(id))));
  // Desks never overlap (ADR 0064), whoever wrote this. Quiet, so it marks nothing as changed, and the same ETag next time never gets this far.
  const merged = arrivingLayout(doc, local, unsaved(), listed);
  if (!sameLayout(merged, local)) {
    applyQuietly(merged);
    const list = useDeskStore.getState();
    if (list.status === 'ready') reconcileLayout(list.desks.map((d) => d.id));
    // Before the version that says so, so another tab can't send what it hasn't got.
    flushLayoutMirror();
    // A desk may have moved out from under the camera. A stack or an app can't have. Never wakes anything: see `refit`.
    if (!sameBounds(merged, local)) refit(false);
  }
  writeMeta();
  if (dirty.size) saveSoon();
}

/** The first load after this shipped finds an empty document, and uploads the arrangement that's only here. */
function uploadWhatsHere(): void {
  const list = useDeskStore.getState();
  if (!uploading || list.status !== 'ready') return;
  uploading = false;
  const ids = list.desks.map((d) => d.id);
  const local = localDoc();
  if (isUntouched(local, ids)) return;
  for (const id of ids) if (local.desks[id]) dirty.add(id);
  writeMeta();
  saveSoon();
}

function receive(res: LayoutResponse, tag: string): void {
  // An answer that crossed a save on the way here.
  if (version !== null && res.version < version) return;
  // Platform has no 304, so every poll brings the whole document. The same ETag is what this browser has already dealt
  // with: nothing is read, merged or written, so nothing can move or render. Anything still to go keeps its own timer,
  // and if it has none, as after a 404 or a 403, this is its next try.
  if (tag === etag) {
    if (dirty.size && !saveTimer && !saving) saveSoon();
    return;
  }
  const read = res.layout === null || res.layout === undefined ? ({ kind: 'empty' } as const) : readServerLayout(res.layout);
  version = res.version;
  etag = tag;
  if (read.kind === 'newer') {
    // A newer build wrote this, and this one can't read it or safely replace it.
    frozen = true;
    return;
  }
  if (read.kind === 'ok') {
    uploading = false;
    nothingThere = false;
    extra = read.extra;
    if (prefsDirty) extra = { ...extra, prefs: withPrefs(extra['prefs']) };
    else adoptLayoutPrefs(extra['prefs']);
    adopt(read.doc, true);
    return;
  }
  // Nothing there, or nothing usable: this browser's copy is the one to keep.
  extra = prefsDirty ? { prefs: withPrefs(undefined) } : {};
  base = null;
  uploading = true;
  nothingThere = true;
  uploadWhatsHere();
  if (dirty.size) saveSoon();
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  if (!running || frozen) return;
  pollTimer = window.setTimeout(() => {
    if (document.hidden) return; // resumes on visibilitychange
    void fetchServer();
  }, routeMissing ? ROUTE_MISSING_POLL_MS : POLL_MS);
}

/** What Platform sent, untouched. It always sends one, and the API's CORS exposes it; the fallback is the contract's own form of it. */
const tagOf = (res: ApiResult<LayoutResponse>, data: LayoutResponse): string => res.etag ?? `"${data.version}"`;

function fetchServer(): Promise<void> {
  fetching ??= (async () => {
    lastFetch = Date.now();
    const asked = epoch;
    try {
      const res = await getDeskLayout(etag, checkToken);
      if (!running || asked !== epoch) return; // signed out, or someone else now, while it was on its way
      routeMissing = false;
      // Platform doesn't answer 304 today, and if it comes to, it says the same as the same ETag.
      if (res.data) receive(res.data, tagOf(res, res.data));
    } catch (err) {
      if (asked !== epoch) return;
      if (err instanceof OtherMember) startOver();
      else if (err instanceof ApiError && err.status === 404) routeMissing = true;
      // Anything else: the layout goes on working here, and the next poll asks again. A 401 is the desk list's to act on, like any other call's.
    } finally {
      fetching = null;
      if (asked !== epoch && running) void fetchServer(); // the one that found out, or one the last member's call was in the way of
      else schedulePoll();
      if (layoutDocRead()) for (const fn of readListeners) fn();
    }
  })();
  return fetching;
}

// ----- what goes

function saveSoon(ms = DEBOUNCE_MS): void {
  if (!running) return;
  const now = Date.now();
  firstChangeAt ||= now;
  window.clearTimeout(saveTimer);
  const soon = Math.min(ms, Math.max(0, firstChangeAt + LONGEST_WAIT_MS - now));
  saveTimer = window.setTimeout(() => void save(), Math.max(soon, holdUntil - now));
}

function backoff(err: ApiError | null): void {
  failures += 1;
  const wait = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (failures - 1));
  const told = err?.retryAfterSec ? err.retryAfterSec * 1000 : 0;
  const hold = Math.max(told, wait * (0.8 + Math.random() * 0.4));
  firstChangeAt = 0;
  holdUntil = Date.now() + hold;
  if (told) toldUntil = Date.now() + told;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), hold);
}

async function onSaveFailed(err: unknown): Promise<void> {
  if (err instanceof SignInRequired) return; // the session is over, and the list's poll says so. What's unsaved stays on record.
  if (!(err instanceof ApiError)) {
    backoff(null); // offline, or the network gave up
    return;
  }
  if (err.status === 412 || err.status === 428) {
    conflicts += 1;
    // Someone else saved first. Take what they saved, with this browser's own desks on top, and go again.
    const before = { version, etag };
    version = null; // ask for all of it, whatever this browser thinks it's level with
    etag = null;
    await fetchServer();
    if (version === null) ({ version, etag } = before);
    // Only a few times running. After that, it's a wait that keeps growing, until a save lands.
    if (conflicts > MAX_CONFLICTS) backoff(null);
    else if (dirty.size || prefsDirty) saveSoon(0);
    return;
  }
  if (err.status === 413 && maxBytes > FLOOR_BYTES) {
    // Under what the contract says, and still too large. Send less, and the rest stays in this browser.
    maxBytes = Math.max(FLOOR_BYTES, Math.floor(maxBytes * 0.75));
    saveSoon(0);
    return;
  }
  if (err.status === 404) {
    routeMissing = true;
    schedulePoll();
    return;
  }
  if (err.status === 429 || err.status >= 500) {
    backoff(err);
    return;
  }
  // 400, 402, 403, or 413 at the floor: asking again won't change the answer. The next change or load tries again.
}

async function save(keepalive = false): Promise<void> {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  if (!dirty.size && !prefsDirty) firstChangeAt = 0; // back to what Platform has: the next change starts its own wait
  if (!running || layoutMirrorHeld() || frozen || routeMissing || version === null || etag === null || (!dirty.size && !prefsDirty)) return;
  if (keepalive ? Date.now() < toldUntil : Date.now() < holdUntil) {
    // Going away during Retry-After leaves it for the next load, which ma.layout.sync.v1 tells. Otherwise it's only early.
    if (!keepalive) saveSoon(0);
    return;
  }
  // The list decides which desks are this member's, so nothing goes before it has answered.
  if (useDeskStore.getState().status !== 'ready') return;
  if (saving) {
    again = true;
    return;
  }
  if (!keepalive && isBusy()) {
    saveTimer = window.setTimeout(() => void save(), BUSY_RETRY_MS);
    return;
  }
  // Going away with a document still held back for a drag: this must carry what that document said, as well.
  const doc = held ? arrivingLayout(held.doc, localDoc(), dirty, listedIds()) : localDoc();
  const ids = useDeskStore.getState().desks.map((d) => d.id);
  // Only desks that have since left this account. Or nothing on Platform, and nothing here but what a first visit
  // does and a press on an app: that's no reason to put a default where a member's arrangement may still be on its way.
  // A preference is the member's own say, so it goes either way, and a browser with an arrangement merges over it as it would over any save.
  if (!prefsDirty && (![...dirty].some((id) => doc.desks[id]) || (nothingThere && isUntouched(doc, ids)))) {
    dirty.clear();
    firstChangeAt = 0;
    writeMeta();
    return;
  }
  saving = true;
  firstChangeAt = 0;
  // The record stays as it is until Platform answers, so if this page never hears back, the next one tries again.
  sending = [...dirty];
  dirty.clear();
  const asked = epoch;
  const prefsSent = useLayoutPrefs.getState();
  try {
    const res = await putDeskLayout(writeServerLayout(doc, extra, maxBytes), etag, keepalive, checkToken);
    if (asked !== epoch) return;
    const landed = res.data?.version ?? (version ?? 0) + 1;
    // A read may have brought something newer while this was on its way, and this browser stays level with that.
    if (version === null || landed >= version) {
      version = landed;
      etag = res.etag ?? `"${landed}"`;
      nothingThere = false;
      base = doc;
      // A document held back went up with this, so what's held back now is what went.
      if (held?.server) held = { doc, server: true };
    }
    conflicts = 0;
    failures = 0;
    holdUntil = 0;
    toldUntil = 0;
    saving = false;
    sending = [];
    if (useLayoutPrefs.getState() === prefsSent) prefsDirty = false;
    flushLayoutMirror(); // before the version that says so, as in `adopt`
    writeMeta();
    if (dirty.size || prefsDirty || again) saveSoon();
  } catch (err) {
    if (asked !== epoch) return;
    if (err instanceof OtherMember) {
      startOver();
      return;
    }
    saving = false;
    for (const id of sending) dirty.add(id);
    sending = [];
    writeMeta();
    await onSaveFailed(err);
  } finally {
    again = false;
  }
}

function onLayoutChange(next: LayoutDoc, prev: LayoutDoc): void {
  // The order of the desks alone doesn't save: it's `z`, which changes on every focus, shows nothing now that desks never
  // overlap, and rides along with the next save. A desk's `stack` is another matter: raising an app changes the desk, and that saves.
  if (isQuietChange() || next.desks === prev.desks) return;
  let changed = false;
  for (const id of Object.keys(next.desks)) {
    const desk = next.desks[id]!;
    if (desk === prev.desks[id]) continue;
    const known = base?.desks[id];
    // Back to what Platform has, as Esc or an undo leaves it: that's not a change, and what arrives next isn't overruled by it.
    if (known && sameDesk(desk, known) && !sending.includes(id)) {
      if (dirty.delete(id)) changed = true;
    } else {
      dirty.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  writeMeta();
  saveSoon();
}

const readListeners = new Set<() => void>();

/**
 * Platform's document has answered on this page, or can't (no route, or no sync at all, as under the fixtures). A pref
 * the office sets by itself waits for this, so it can't write over one the document already had (`setup/prefs.ts`).
 */
export const layoutDocRead = (): boolean => !running || version !== null || routeMissing;

/** Each time a read of the document ends while it's been read: the setup circle's done steps go up then. */
export function onLayoutDocRead(fn: () => void): () => void {
  readListeners.add(fn);
  return () => readListeners.delete(fn);
}

/** A preference the member just changed, kept in the document (design 9.4). It goes like any other change. */
export function setLayoutPref(patch: Partial<LayoutPrefs>): void {
  useLayoutPrefs.setState(patch);
  extra = { ...extra, prefs: withPrefs(extra['prefs']) };
  prefsDirty = true;
  saveSoon();
}

// ----- when

/** Everything still here goes now, as the page goes away. */
function flushOnLeaving(): void {
  flushLayoutMirror();
  void save(true);
}

function onVisibility(): void {
  if (document.hidden) {
    flushOnLeaving();
    return;
  }
  if (Date.now() - lastFetch >= REFRESH_GAP_MS) void fetchServer();
}

function onFocus(): void {
  if (Date.now() - lastFetch >= REFRESH_GAP_MS) void fetchServer();
}

function onOnline(): void {
  failures = 0;
  holdUntil = Math.min(holdUntil, toldUntil); // what Platform told it still stands
  routeMissing = false;
  void fetchServer();
  if (dirty.size) saveSoon(); // the backoff was for the network that just came back
}

function onPageShow(e: PageTransitionEvent): void {
  if (e.persisted) void fetchServer();
}

/** Another tab of this browser: its mirror arrives at once, with no network, and this tab's own changes stay on top. */
function onStorage(e: StorageEvent): void {
  // Another account's, from a tab signed in as them, or a page that has signed out: nothing to take.
  if (!mirrorIsOurs()) return;
  if (e.key === SYNC_KEY) {
    const meta = readMeta();
    if (meta && meta.member === member && version !== null && meta.version > version) {
      version = meta.version;
      etag = meta.etag ?? `"${meta.version}"`;
      base = null;
    }
    return;
  }
  if (e.key !== LAYOUT_KEY || !e.newValue) return;
  try {
    const doc = readLayoutDoc(JSON.parse(e.newValue));
    if (doc) adopt(doc, false);
  } catch {
    /* not ours to worry about: the next read of the server's copy puts it right */
  }
}

/** From sign-in on. Stops at sign-out. The fixtures have their own layout, which never goes anywhere. */
export function startLayoutSync(): () => void {
  if (running || !isSavingLayout()) return () => {};
  running = true;
  member = undefined;
  base = null;
  frozen = false;
  uploading = false;
  nothingThere = false;
  routeMissing = false;
  conflicts = 0;
  failures = 0;
  holdUntil = 0;
  toldUntil = 0;
  firstChangeAt = 0;
  maxBytes = MAX_SERVER_BYTES;
  // What was unsaved when the last page ended comes back with the first token, and only if it's the same member's (`checkToken`).
  dirty.clear();
  version = null;
  etag = null;
  extra = {};
  prefsDirty = false;
  resetLayoutPrefs();
  const offLayout = useLayoutStore.subscribe(onLayoutChange);
  // A save waits for the list, so the list answering may be what it's been waiting for.
  const offList = useDeskStore.subscribe((s, prev) => {
    if (s.status !== 'ready' || prev.status === 'ready') return;
    uploadWhatsHere();
    if (dirty.size || prefsDirty) saveSoon(0);
  });
  const offSignOut = onBeforeSignOut(async () => {
    await Promise.race([save(), new Promise((resolve) => window.setTimeout(resolve, SIGN_OUT_WAIT_MS))]);
  });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flushOnLeaving);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
  window.addEventListener('storage', onStorage);
  void fetchServer();
  return () => {
    running = false;
    offLayout();
    offList();
    offSignOut();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flushOnLeaving);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('storage', onStorage);
    window.clearTimeout(saveTimer);
    window.clearTimeout(pollTimer);
    window.clearTimeout(heldTimer);
    held = null;
  };
}
