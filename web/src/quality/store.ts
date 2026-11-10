// The member's stream quality (ADR 0039, ma-platform contract stream-quality.md): one document per member on
// Platform, read from `GET /v1/me` and changed with `PUT /v1/me/stream-quality`, a merge. Mirrored in
// localStorage with the member's `sub`, so a new session starts at the right level without waiting for Platform,
// and another member's choice is never used.
//
// What shows is what Platform last confirmed, with the change on its way and the newest one waiting on top. A save
// that fails takes its change away again and says so; nothing is retried by itself. Saves go one at a time, and
// changes made meanwhile wait as one merged body, the newest winning. The fixtures (dev and the fixture tests)
// never reach Platform, as with the layout (`shell/layoutSync.ts`): there a choice is kept in memory only.
//
// Each desk's own level sits on top (the owner's rule, `HANDOFF.md` section 4: the account sets a default, a desk
// follows it or overrides it, and nothing set on one desk reaches another). The contract has no desk layer, so the
// app's menu keeps a desk's choice in this browser only, in `ma.streamQuality.desks.v1` with the member's `sub`, and
// sends nothing to Platform: the account's document (`default`, and `apps` as `/account` sets them) is what every desk
// follows until it has its own. It reaches this browser's other tabs, but not another browser or device.
import { useSyncExternalStore } from 'react';
import { readJson, writeJson } from '../lib/util';
import { api } from '../platform/api';
import { decodeJwtPayload } from '../platform/pkce';
import { placeTokenFor } from '../platform/tokenStore';
import { isSavingLayout } from '../state/layoutStore';
import { levelOnDesk, NEVER_SET, parseDeskLevels, parseStreamQuality, withDeskLevel, type DeskLevels, type Level, type StreamQuality } from './levels';

export const MIRROR_KEY = 'ma.streamQuality.v1';
/** Each desk's own levels, with whose they are. This browser's only, until the contract has a desk layer. */
export const DESK_MIRROR_KEY = 'ma.streamQuality.desks.v1';
/** Coming back to the tab asks again, at most this often (interface section 2). */
export const REFRESH_GAP_MS = 60_000;
export const SAVE_FAILED = "That didn't save. Try again in a moment.";
const NOTICE_MS = 6_000;
/** Nothing waits on these, but one that never answers would hold up the next save. */
const TIMEOUT_MS = 15_000;

/** A `PUT /v1/me/stream-quality` body: only what's sent changes, and an app set to null follows the default again. */
export interface QualityChange {
  default?: Level;
  apps?: Record<string, Level | null>;
}

export interface QualitySnapshot {
  doc: StreamQuality;
  /** Each desk's own levels, over the account's. */
  desks: DeskLevels;
  /** A save that didn't work, for a few seconds. */
  notice: string | null;
}

interface Mirror {
  sub: string;
  doc: unknown;
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
/** Each desk's own, this member's, kept in this browser. */
let desks: DeskLevels = {};
/** On its way to Platform, with no answer yet. */
let inflight: QualityChange | null = null;
/** Made while a save was on its way: goes next, as one body. */
let pending: QualityChange | null = null;
/** Saves sent so far. A read that no save overlapped is Platform's word, whatever it says. */
let writes = 0;
let lastRead = 0;
let reading: Promise<void> | null = null;
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let snapshot: QualitySnapshot = { doc: NEVER_SET, desks: {}, notice: null };
const listeners = new Set<() => void>();

/** False under the fixtures, whose desks and layout never reach Platform. */
const onPlatform = (): boolean => isSavingLayout();

function overlay(doc: StreamQuality, change: QualityChange | null): StreamQuality {
  if (!change) return doc;
  const apps: Record<string, Level> = { ...doc.apps };
  for (const [app, level] of Object.entries(change.apps ?? {})) {
    if (level === null) delete apps[app];
    else apps[app] = level;
  }
  return { default: change.default ?? doc.default, apps, updatedAt: doc.updatedAt };
}

/** Two changes as one body, the later winning wherever both say something. */
function merge(earlier: QualityChange, later: QualityChange): QualityChange {
  const out: QualityChange = {};
  const def = later.default ?? earlier.default;
  if (def) out.default = def;
  if (earlier.apps || later.apps) out.apps = { ...earlier.apps, ...later.apps };
  return out;
}

const same = (a: StreamQuality, b: StreamQuality): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Platform moves `updatedAt` on with every change, so the later one is the newer document. */
function newer(a: StreamQuality, than: StreamQuality): boolean {
  if (a.updatedAt === null) return false;
  if (than.updatedAt === null) return true;
  return Date.parse(a.updatedAt) > Date.parse(than.updatedAt);
}

function emit(): void {
  const doc = overlay(overlay(confirmed, inflight), pending);
  if (same(doc, snapshot.doc) && desks === snapshot.desks && notice === snapshot.notice) return;
  snapshot = { doc: same(doc, snapshot.doc) ? snapshot.doc : doc, desks, notice };
  for (const fn of [...listeners]) fn();
}

function setNotice(text: string | null): void {
  clearTimeout(noticeTimer);
  notice = text;
  if (text) noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
  emit();
}

function writeMirror(): void {
  if (typeof member === 'string') writeJson(MIRROR_KEY, { sub: member, doc: confirmed } satisfies Mirror);
}

/** This member's desk levels as this browser has them, from any tab. */
function storedDesks(who: string): DeskLevels {
  const mirror = readJson<Partial<DeskMirror>>(DESK_MIRROR_KEY);
  return mirror?.sub === who ? parseDeskLevels(mirror.desks) : {};
}

/** One desk's change, over what this browser has now, so another tab's change to another desk isn't lost. */
function writeDeskChange(deskId: string, app: string, level: Level | null): void {
  if (typeof member !== 'string' || !onPlatform()) return;
  writeJson(DESK_MIRROR_KEY, { sub: member, desks: withDeskLevel(storedDesks(member), deskId, app, level) } satisfies DeskMirror);
}

/** A document from Platform. `authoritative`: no save overlapped the read that brought it, so it's Platform's word as it stands. */
function adopt(doc: StreamQuality, authoritative: boolean): void {
  if (!authoritative && !newer(doc, confirmed)) return;
  if (same(doc, confirmed)) return;
  confirmed = doc;
  writeMirror();
  emit();
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
      if (confirmed === NEVER_SET || newer(doc, confirmed)) {
        confirmed = doc;
        emit();
      }
    }
    if (who !== null) {
      // What this browser kept for each desk, under anything chosen here before the first token, which then is kept too.
      const kept = storedDesks(who);
      const chosen = desks;
      let merged: DeskLevels = kept;
      for (const [deskId, apps] of Object.entries(chosen)) for (const [app, level] of Object.entries(apps)) merged = withDeskLevel(merged, deskId, app, level);
      if (Object.keys(merged).length) {
        desks = merged;
        for (const [deskId, apps] of Object.entries(chosen)) for (const [app, level] of Object.entries(apps)) writeDeskChange(deskId, app, level);
        emit();
      }
    }
    return;
  }
  if (who !== member) throw new OtherMember();
}

/** Someone else's token: everything here was the last member's. */
function startOver(): void {
  epoch += 1;
  member = undefined;
  confirmed = NEVER_SET;
  desks = {};
  inflight = null;
  pending = null;
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
    const quietThen = !inflight;
    try {
      const res = await api<{ streamQuality?: unknown; preferences?: { staySignedIn?: unknown } | null }>('/v1/me', { onToken: checkToken, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (asked !== epoch) return;
      placeTokenFor(res.data); // back from /account, say: "Stay signed in" applies here too
      const raw = res.data?.streamQuality;
      // A Platform from before the contract says nothing, and what's here stands.
      if (raw === undefined || raw === null) return;
      adopt(parseStreamQuality(raw), quietThen && writes === writesThen && !inflight);
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
  if (inflight || !pending) return;
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
      adopt(doc, !newer(confirmed, doc));
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
  pending = pending ? merge(pending, c) : c;
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
    if (JSON.stringify(kept) !== JSON.stringify(desks)) {
      desks = kept;
      emit();
    }
    return;
  }
  if (e.key !== MIRROR_KEY || !e.newValue || typeof member !== 'string') return;
  try {
    const mirror = JSON.parse(e.newValue) as Partial<Mirror> | null;
    if (mirror?.sub === member) adopt(parseStreamQuality(mirror.doc), false);
  } catch {
    /* the next read puts it right */
  }
}

/** First use: read Platform once, and again on coming back to the tab. Nothing at all under the fixtures. */
function start(): void {
  if (started) return;
  started = true;
  if (!onPlatform()) return;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);
  void read();
}

// ----- for the menu and the player

/**
 * The account's own choice for an app, which every desk without its own follows. Null follows the account's default
 * again. The Desk app's menu doesn't use it: a choice there is that desk's (`setDeskLevel`).
 */
export const setOverride = (app: string, level: Level | null): void => change({ apps: { [app]: level } });

/**
 * One desk's own level for an app, or null to follow the account again. Shown and sent to that desk at once, kept in
 * this browser, and never sent to Platform, whose contract has no desk layer yet: so no other desk hears of it.
 */
export function setDeskLevel(deskId: string, app: string, level: Level | null): void {
  start();
  clearTimeout(noticeTimer);
  notice = null;
  desks = withDeskLevel(desks, deskId, app, level);
  writeDeskChange(deskId, app, level);
  emit();
}

export const setDefault = (level: Level): void => change({ default: level });

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
 * The level an app streams at now on a desk: that desk's own, else the account's override for the app, else the
 * account's default, else High. Starts the store on first use.
 */
export function levelFor(app: string, deskId?: string): Level {
  start();
  return levelOnDesk(snapshot.doc, snapshot.desks, deskId, app);
}

export function dismissNotice(): void {
  if (notice) setNotice(null);
}

export function useStreamQuality(): QualitySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
