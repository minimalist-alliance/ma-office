// The member's stream quality (ADR 0039, ma-platform contract stream-quality.md): one document per member on
// Platform, read from `GET /v1/me` and changed with `PUT /v1/me/stream-quality`, a merge. Mirrored in
// localStorage with the member's `sub`, so a new session starts at the right level without waiting for Platform,
// and another member's choice is never used.
//
// It's in layers (the owner's rule, `HANDOFF.md` section 4: the account sets a default, a desk follows it or
// overrides it, an app on that desk overrides the desk, and nothing set on one desk reaches another): the account's
// default and per-app levels, then each desk's own level and each app's on it (contract 0.3.70, `desks`). A desk's own
// goes to Platform like the rest, so it follows the member to any browser.
//
// What shows is what Platform last confirmed, with the change on its way and the newest one waiting on top. A save
// that fails takes its change away again and says so; nothing is retried by itself. Saves go one at a time, and
// changes made meanwhile wait as one merged body, the newest winning. The fixtures (dev and the fixture tests)
// never reach Platform, as with the layout (`shell/layoutSync.ts`): there a choice is kept in memory only.
//
// A Platform from before 0.3.70 has no `desks`. Against one, a desk's level for an app stays in this browser only, as
// it did before (`ma.streamQuality.desks.v1`, with the member's `sub`), and a desk's own level for every app isn't
// offered (`layered` false). Once Platform has `desks`, what this browser kept moves there once, quietly, under
// anything Platform already has, and the browser's copy is emptied.
import { useSyncExternalStore } from 'react';
import { readJson, writeJson } from '../lib/util';
import { api } from '../platform/api';
import { onMemberChange } from '../platform/auth';
import { decodeJwtPayload } from '../platform/pkce';
import { placeTokenFor } from '../platform/tokenStore';
import { isSavingLayout, layoutMirrorWritable } from '../state/layoutStore';
import {
  asDesks,
  deskLevelsToMove,
  hasDeskLayer,
  levelOnDesk,
  mergeChanges,
  NEVER_SET,
  overlay,
  parseDeskLevels,
  parseStreamQuality,
  withDeskLevel,
  type DeskLevels,
  type Level,
  type QualityChange,
  type StreamQuality,
} from './levels';

export const MIRROR_KEY = 'ma.streamQuality.v1';
/** Each desk's levels for its apps, kept in this browser against a Platform from before the desk layer. */
export const DESK_MIRROR_KEY = 'ma.streamQuality.desks.v1';
/** Coming back to the tab asks again, at most this often (interface section 2). */
export const REFRESH_GAP_MS = 60_000;
export const SAVE_FAILED = "That didn't save. Try again in a moment.";
const NOTICE_MS = 6_000;
/** Nothing waits on these, but one that never answers would hold up the next save. */
const TIMEOUT_MS = 15_000;

export type { QualityChange };

export interface QualitySnapshot {
  /** Every layer, a desk's included: Platform's, or against an older Platform this browser's for the desks. */
  doc: StreamQuality;
  /**
   * Platform keeps each desk's own (contract 0.3.70). Null until known, false for a Platform from before it: then a
   * desk's own level for every app isn't offered, and an app's on a desk stays in this browser.
   */
  layered: boolean | null;
  /** A save that didn't work, for a few seconds. */
  notice: string | null;
}

interface Mirror {
  sub: string;
  doc: unknown;
  /** Absent in a mirror from before 0.3.70: not known. */
  layered?: boolean;
}

interface DeskMirror {
  sub: string;
  desks: unknown;
}

/** The token that would go is another member's, from a sign-in in another tab. Nothing here is theirs. */
class OtherMember extends Error {}

let started = false;
/** Whose document this is, from the first token a call goes out with. Undefined until then. */
let member: string | null | undefined;
/** Goes up when the member changes under this tab, so an answer to the last one's call is dropped. */
let epoch = 0;
/** What Platform last said, or the mirror of it, or never set. */
let confirmed: StreamQuality = NEVER_SET;
/** Platform has the desk layer: from its document, or the mirror's word for it. Null until either says. */
let layered: boolean | null = null;
/** Each desk's levels for its apps in this browser, this member's: used while `layered` isn't true, then moved. */
let localDesks: DeskLevels = {};
/** On its way to Platform, with no answer yet. */
let inflight: QualityChange | null = null;
/** Made while a save was on its way: goes next, as one body. */
let pending: QualityChange | null = null;
/** Moving this browser's desk levels to Platform, once: quiet, never shown as the member's own change. */
let moving = false;
/** Saves sent so far. A read that no save overlapped is Platform's word, whatever it says. */
let writes = 0;
let lastRead = 0;
let reading: Promise<void> | null = null;
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let snapshot: QualitySnapshot = { doc: NEVER_SET, layered: null, notice: null };
const listeners = new Set<() => void>();

/** False under the fixtures, whose desks and layout never reach Platform. */
const onPlatform = (): boolean => isSavingLayout();

const same = (a: StreamQuality, b: StreamQuality): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Platform moves `updatedAt` on with every change, so the later one is the newer document. */
function newer(a: StreamQuality, than: StreamQuality): boolean {
  if (a.updatedAt === null) return false;
  if (than.updatedAt === null) return true;
  return Date.parse(a.updatedAt) > Date.parse(than.updatedAt);
}

/**
 * What shows: Platform's, the changes on top, and this browser's desk levels: against an older Platform, as they are;
 * against one with the desk layer, those still to move there, under what Platform has, until they have.
 */
function shown(): StreamQuality {
  if (layered !== true) return { ...overlay(overlay(confirmed, inflight), pending), desks: asDesks(localDesks) };
  return overlay(overlay(overlay(confirmed, deskLevelsToMove(localDesks, confirmed)), inflight), pending);
}

function emit(): void {
  const doc = shown();
  if (same(doc, snapshot.doc) && layered === snapshot.layered && notice === snapshot.notice) return;
  snapshot = { doc: same(doc, snapshot.doc) ? snapshot.doc : doc, layered, notice };
  for (const fn of [...listeners]) fn();
}

function setNotice(text: string | null): void {
  clearTimeout(noticeTimer);
  notice = text;
  if (text) noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
  emit();
}

/**
 * Both mirrors go with the layout's on every signed-out state (`MEMBER_CACHE_KEYS`, ISS-89), and are written only while it
 * may be: never from a tab that has signed out, or that another tab's sign-out left with no token.
 */
function keep(key: string, value: Mirror | DeskMirror): void {
  if (layoutMirrorWritable()) writeJson(key, value);
}

function writeMirror(): void {
  if (typeof member === 'string') keep(MIRROR_KEY, { sub: member, doc: confirmed, ...(layered !== null ? { layered } : {}) });
}

/** This member's desk levels as this browser has them, from any tab. */
function storedDesks(who: string): DeskLevels {
  const mirror = readJson<Partial<DeskMirror>>(DESK_MIRROR_KEY);
  return mirror?.sub === who ? parseDeskLevels(mirror.desks) : {};
}

/** One desk's change, over what this browser has now, so another tab's change to another desk isn't lost. */
function writeDeskChange(deskId: string, app: string, level: Level | null): void {
  if (typeof member !== 'string' || !onPlatform()) return;
  keep(DESK_MIRROR_KEY, { sub: member, desks: withDeskLevel(storedDesks(member), deskId, app, level) });
}

/**
 * Platform has the desk layer and its document is in: what this browser kept moves there, under what Platform has, in
 * one quiet save while nothing else is on its way. A failure leaves it here for the next read.
 */
function moveDeskLevels(): void {
  if (layered !== true || typeof member !== 'string' || !onPlatform() || moving || inflight || pending) return;
  const kept = storedDesks(member);
  if (!Object.keys(kept).length) return;
  const body = deskLevelsToMove(kept, confirmed);
  const who = member;
  const done = (): void => {
    localDesks = {};
    keep(DESK_MIRROR_KEY, { sub: who, desks: {} });
  };
  if (!body) {
    done();
    emit();
    return;
  }
  moving = true;
  writes += 1;
  const asked = epoch;
  void api<unknown>('/v1/me/stream-quality', {
    method: 'PUT',
    onToken: checkToken,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (asked !== epoch) return;
      const raw = res.data;
      if (hasDeskLayer(raw)) {
        const doc = parseStreamQuality(raw);
        if (!newer(confirmed, doc)) confirmed = doc;
      } else confirmed = overlay(confirmed, body);
      writeMirror();
      done();
    })
    .catch((err: unknown) => {
      if (asked === epoch && err instanceof OtherMember) startOver();
      // Anything else: kept here, and the next read tries again. The member chose nothing, so nothing is said.
    })
    .finally(() => {
      if (asked !== epoch) return;
      moving = false;
      emit();
      void send(); // a change the member made meanwhile
    });
}

/** A document from Platform. `authoritative`: no save overlapped the read that brought it, so it's Platform's word as it stands. */
function adopt(doc: StreamQuality, authoritative: boolean, hasDesks: boolean): void {
  const wasLayered = layered;
  if (authoritative) layered = hasDesks;
  else if (hasDesks) layered = true;
  if (authoritative || newer(doc, confirmed)) {
    if (!same(doc, confirmed) || layered !== wasLayered) {
      confirmed = doc;
      writeMirror();
    }
  } else if (layered !== wasLayered) writeMirror();
  emit();
  moveDeskLevels();
}

/** Called with every token a call is about to send. The first says whose this is, and whether the mirror is theirs. */
function checkToken(token: string): void {
  const sub = decodeJwtPayload(token)?.['sub'];
  const who = typeof sub === 'string' ? sub : null;
  if (member === undefined) {
    member = who;
    const mirror = readJson<Partial<Mirror>>(MIRROR_KEY);
    if (who !== null && mirror?.sub === who) {
      const doc = parseStreamQuality(mirror.doc);
      if (layered === null && typeof mirror.layered === 'boolean') layered = mirror.layered;
      if (confirmed === NEVER_SET || newer(doc, confirmed)) confirmed = doc;
    }
    if (who !== null) {
      // What this browser kept for each desk, under anything chosen here before the first token, which then is kept too.
      const chosen = localDesks;
      let merged: DeskLevels = storedDesks(who);
      for (const [deskId, apps] of Object.entries(chosen)) for (const [app, level] of Object.entries(apps)) merged = withDeskLevel(merged, deskId, app, level);
      localDesks = merged;
      for (const [deskId, apps] of Object.entries(chosen)) for (const [app, level] of Object.entries(apps)) writeDeskChange(deskId, app, level);
    }
    emit();
    return;
  }
  if (who !== member) throw new OtherMember();
}

/** Someone else's token: everything here was the last member's. Found by a call, or told at once (below). */
function startOver(): void {
  epoch += 1;
  member = undefined;
  confirmed = NEVER_SET;
  layered = null;
  localDesks = {};
  inflight = null;
  pending = null;
  moving = false;
  clearTimeout(noticeTimer);
  notice = null;
  emit();
  // After the call that found this has finished, so it asks afresh.
  setTimeout(() => void read());
}

function read(): Promise<void> {
  reading ??= (async () => {
    lastRead = Date.now();
    const asked = epoch;
    const writesThen = writes;
    const quietThen = !inflight && !moving;
    try {
      const res = await api<{ streamQuality?: unknown; preferences?: { staySignedIn?: unknown } | null }>('/v1/me', { onToken: checkToken, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (asked !== epoch) return;
      placeTokenFor(res.data); // back from /account, say: "Stay signed in" applies here too
      const raw = res.data?.streamQuality;
      // A Platform from before the contract says nothing, and what's here stands.
      if (raw === undefined || raw === null) return;
      adopt(parseStreamQuality(raw), quietThen && writes === writesThen && !inflight && !moving, hasDeskLayer(raw));
    } catch (err) {
      if (asked !== epoch) return;
      if (err instanceof OtherMember) startOver();
      // Anything else: what's here stands, and coming back to the tab asks again. A 401 is the desk list's to act on.
    } finally {
      reading = null;
    }
  })();
  return reading;
}

async function send(): Promise<void> {
  if (inflight || moving || !pending) return;
  const body = pending;
  inflight = body;
  pending = null;
  writes += 1;
  const asked = epoch;
  try {
    const res = await api<unknown>('/v1/me/stream-quality', {
      method: 'PUT',
      onToken: checkToken,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (asked !== epoch) return;
    inflight = null;
    // The whole document after the change, unless a read has since brought a newer one. Without one, what was sent is what Platform has.
    if (res.data) {
      const doc = parseStreamQuality(res.data);
      adopt(doc, !newer(confirmed, doc), hasDeskLayer(res.data));
    } else {
      confirmed = overlay(confirmed, body);
      writeMirror();
    }
  } catch (err) {
    if (asked !== epoch) return;
    inflight = null;
    if (err instanceof OtherMember) {
      startOver();
      return;
    }
    // Any error, a 404 from a Platform without the route included: the change comes off, and the member hears why.
    setNotice(SAVE_FAILED);
  } finally {
    if (asked === epoch) {
      emit();
      void send(); // the newest change, if one is waiting
    }
  }
}

function change(c: QualityChange): void {
  start();
  clearTimeout(noticeTimer);
  notice = null;
  if (!onPlatform()) {
    confirmed = overlay(confirmed, c);
    emit();
    return;
  }
  pending = pending ? mergeChanges(pending, c) : c;
  emit();
  void send();
}

function onVisibility(): void {
  if (!document.hidden && Date.now() - lastRead >= REFRESH_GAP_MS) void read();
}

/** Another tab of this browser saved: its copy arrives at once, if it's this member's and newer. A desk's, if it's this member's. */
function onStorage(e: StorageEvent): void {
  if (e.key === DESK_MIRROR_KEY && typeof member === 'string') {
    const kept = storedDesks(member);
    if (JSON.stringify(kept) !== JSON.stringify(localDesks)) {
      localDesks = kept;
      emit();
    }
    return;
  }
  if (e.key !== MIRROR_KEY || !e.newValue || typeof member !== 'string') return;
  try {
    const mirror = JSON.parse(e.newValue) as Partial<Mirror> | null;
    if (mirror?.sub === member) adopt(parseStreamQuality(mirror.doc), false, mirror.layered === true);
  } catch {
    /* the next read puts it right */
  }
}

/** First use: read Platform once, and again on coming back to the tab. Nothing at all under the fixtures. */
function start(): void {
  if (started) return;
  started = true;
  // This tab's tokens became someone else's (a sign-in in another tab): the last member's levels go now, before any
  // stream is set by them or an answer to their call lands, not at this store's next call (ISS-89).
  onMemberChange((sub) => {
    if (typeof member === 'string' && sub !== member) startOver();
  });
  if (!onPlatform()) {
    // The fixtures keep every layer in memory, as Platform would.
    layered = true;
    emit();
    return;
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);
  void read();
}

// ----- for the menu and the player

/** The account's own level for an app on every desk. Null follows the account's default again. No menu sets it now. */
export const setOverride = (app: string, level: Level | null): void => change({ apps: { [app]: level } });

/** The account's default for every desk. Null clears it: High, until the member picks one. `/account` sets it. */
export const setDefault = (level: Level | null): void => change({ default: level });

/**
 * One app's own level on one desk, or null to follow that desk again. Shown and sent to that desk at once, and saved
 * to Platform, so no other desk hears of it. Against a Platform without the desk layer, kept in this browser only.
 */
export function setDeskLevel(deskId: string, app: string, level: Level | null): void {
  start();
  if (layered === false) {
    clearTimeout(noticeTimer);
    notice = null;
    localDesks = withDeskLevel(localDesks, deskId, app, level);
    writeDeskChange(deskId, app, level);
    emit();
    return;
  }
  change({ desks: { [deskId]: { apps: { [app]: level } } } });
}

/**
 * One desk's own level for every app on it that streams, or null to follow the account again. Only where Platform keeps
 * the desk layer (`layered`): the menu doesn't offer it otherwise.
 */
export function setDeskOwnLevel(deskId: string, level: Level | null): void {
  start();
  if (layered === false) return;
  change({ desks: { [deskId]: { level } } });
}

export function getSnapshot(): QualitySnapshot {
  return snapshot;
}

/** Calls `fn` after every change of what shows. Starts the store on first use. */
export function subscribe(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The level an app streams at now on a desk, the first that is set: the app on that desk, the desk, the app on every
 * desk, the account's default, then High. Starts the store on first use.
 */
export function levelFor(app: string, deskId?: string): Level {
  start();
  return levelOnDesk(snapshot.doc, deskId, app);
}

export function dismissNotice(): void {
  if (notice) setNotice(null);
}

export function useStreamQuality(): QualitySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
