// Stream quality levels (ADR 0039): the four levels, what a member reads about each, which apps have one, and
// the `keys` channel's QUALITY events (docs/interfaces/stream-quality.md section 3). Pure: no DOM, no network.
export type Level = 'low' | 'medium' | 'high' | 'max';

/** In order: "highest" and "at most" compare these. */
export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'max'];

/** What a member who never chose gets, and what the desk streams today. */
export const DEFAULT_LEVEL: Level = 'high';
/** A free member's (the owner, 2026-11-10): Medium. Platform says which applies, as the document's `fallback` (contract 0.3.78). */
export const FREE_DEFAULT_LEVEL: Level = 'medium';

export interface LevelInfo {
  name: string;
  /** What the member reads (ADR 0039 section 1). */
  words: string;
  /** The level's ceiling plus sound, over an hour, in GB (10^9 bytes, as the meter counts). */
  upToGb: number;
}

export const LEVEL_INFO: Readonly<Record<Level, LevelInfo>> = {
  low: { name: 'Low', words: 'Uses the least data. Text and video look softer.', upToGb: 1.2 },
  medium: { name: 'Medium', words: 'Sharp text, softer video. About half the data of High.', upToGb: 1.8 },
  high: { name: 'High', words: 'Sharp text and clear video.', upToGb: 3.6 },
  max: { name: 'Max', words: 'The sharpest picture, for photos and fine detail. Uses the most data and needs a fast connection.', upToGb: 5.4 },
};

export const upTo = (level: Level): string => `Up to ${LEVEL_INFO[level].upToGb.toFixed(1)} GB an hour`;

export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v);

/** Apps that reach the member as video from the desk. Notebook, Chat and Agent don't, and get no setting. */
export const STREAMING_APPS: readonly string[] = ['browser'];

export const streams = (app: string): boolean => STREAMING_APPS.includes(app);

/** One desk's own (ma-platform contract 0.3.70): its level, null while it follows the account, and its apps' levels. */
export interface DeskQuality {
  level: Level | null;
  /** An app with no entry follows the desk. */
  apps: Readonly<Record<string, Level>>;
}

/**
 * The member's document (ma-platform contract stream-quality.md), in layers: the account's default and per-app levels,
 * then each desk's own level and each app's on that desk (the owner's rule, `HANDOFF.md` section 4). Not set is null or
 * no entry at every layer, never a level.
 */
export interface StreamQuality {
  /** The account's level, or null while the member hasn't chosen one: then High. */
  default: Level | null;
  /** The account's per-app levels, on every desk. An app with no entry follows `default`. */
  apps: Readonly<Record<string, Level>>;
  /** Each desk's own, by desk id. A desk with no entry follows the account. */
  desks: Readonly<Record<string, DeskQuality>>;
  /** The last change, or null if the member never chose. */
  updatedAt: string | null;
  /** What a `null` default comes down to (contract 0.3.78): High, or Medium for a free member. Absent from a Platform before it: High. */
  fallback?: Level;
}

export const NEVER_SET: StreamQuality = { default: null, apps: {}, desks: {}, updatedAt: null };

/** The contract's app ids. Also keeps `__proto__` and its kind out of a plain object. */
export const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** A desk id as Platform makes them (`d-` and letters), or a fixture's. Also keeps `__proto__` out. */
export const DESK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Not set (null or missing) stays not set; anything else that isn't a level is one this build doesn't know: High. */
const levelOrUnset = (v: unknown): Level | null => (v === null || v === undefined ? null : isLevel(v) ? v : DEFAULT_LEVEL);

function parseLevels(raw: unknown): Record<string, Level> {
  const out: Record<string, Level> = {};
  if (isObject(raw)) {
    for (const [app, v] of Object.entries(raw)) {
      const level = levelOrUnset(v);
      if (APP_ID.test(app) && level) out[app] = level;
    }
  }
  return out;
}

/**
 * Whatever Platform or an old mirror sent. Anything unusable reads as never set, an unknown level as High, and a layer
 * that isn't set stays not set: a missing or null default is the account's not set, not High.
 */
export function parseStreamQuality(raw: unknown): StreamQuality {
  if (!isObject(raw)) return NEVER_SET;
  const desks: Record<string, DeskQuality> = {};
  if (isObject(raw['desks'])) {
    for (const [id, d] of Object.entries(raw['desks'])) {
      if (!DESK_ID.test(id) || !isObject(d)) continue;
      const own: DeskQuality = { level: levelOrUnset(d['level']), apps: parseLevels(d['apps']) };
      if (own.level !== null || Object.keys(own.apps).length) desks[id] = own;
    }
  }
  const updatedAt = raw['updatedAt'];
  const fallback = raw['fallback'];
  return { default: levelOrUnset(raw['default']), apps: parseLevels(raw['apps']), desks, updatedAt: typeof updatedAt === 'string' ? updatedAt : null, ...(isLevel(fallback) ? { fallback } : {}) };
}

/** Platform keeps each desk's own (contract 0.3.70): its document has `desks`. One from before keeps them in this browser. */
export const hasDeskLayer = (raw: unknown): boolean => isObject(raw) && isObject(raw['desks']);

/** The account's level for an app, which a desk without its own follows: its own on every desk, else the default, else the document's fallback (High; Medium for a free member). */
export function levelFor(doc: StreamQuality, app: string): Level {
  return (Object.hasOwn(doc.apps, app) ? doc.apps[app] : undefined) ?? doc.default ?? doc.fallback ?? DEFAULT_LEVEL;
}

/** The account's own level for an app on every desk, or null when it follows the default. */
export const overrideFor = (doc: StreamQuality, app: string): Level | null => (Object.hasOwn(doc.apps, app) ? (doc.apps[app] ?? null) : null);

const deskOf = (doc: StreamQuality, deskId: string | undefined): DeskQuality | undefined =>
  deskId !== undefined && Object.hasOwn(doc.desks, deskId) ? doc.desks[deskId] : undefined;

/** That desk's own level for every app on it, or null when it follows the account. */
export const deskOwnLevel = (doc: StreamQuality, deskId: string | undefined): Level | null => deskOf(doc, deskId)?.level ?? null;

/** An app's own level on that desk, or null when it follows the desk. */
export function deskOverrideFor(doc: StreamQuality, deskId: string | undefined, app: string): Level | null {
  const desk = deskOf(doc, deskId);
  return desk && Object.hasOwn(desk.apps, app) ? (desk.apps[app] ?? null) : null;
}

/** What an app on a desk follows without a level of its own there: the desk's own, else the account's. */
export const deskLevelFor = (doc: StreamQuality, deskId: string | undefined, app: string): Level => deskOwnLevel(doc, deskId) ?? levelFor(doc, app);

/**
 * An app's level on a desk, the first that is set: the app on that desk, the desk, the app on every desk (the
 * account's), the account's default, then High.
 */
export const levelOnDesk = (doc: StreamQuality, deskId: string | undefined, app: string): Level => deskOverrideFor(doc, deskId, app) ?? deskLevelFor(doc, deskId, app);

// ----- changes: a `PUT /v1/me/stream-quality` body, a merge

/** One desk's part of a change: its own level (null follows the account), its apps' (null follows the desk). */
export interface DeskChange {
  level?: Level | null;
  apps?: Record<string, Level | null>;
}

/**
 * Only what's sent changes, and null clears a layer so it follows the one above. The contract's `desks: {id: null}`
 * isn't used here, so any two changes merge into one body.
 */
export interface QualityChange {
  default?: Level | null;
  apps?: Record<string, Level | null>;
  desks?: Record<string, DeskChange>;
}

function withLevels(apps: Readonly<Record<string, Level>>, change: Record<string, Level | null> | undefined): Record<string, Level> {
  const out: Record<string, Level> = { ...apps };
  for (const [app, level] of Object.entries(change ?? {})) {
    if (level === null) delete out[app];
    else out[app] = level;
  }
  return out;
}

/** `doc` with `change` on top, keeping its `updatedAt`. A desk left with nothing of its own is dropped, as Platform does. */
export function overlay(doc: StreamQuality, change: QualityChange | null): StreamQuality {
  if (!change) return doc;
  const desks: Record<string, DeskQuality> = { ...doc.desks };
  for (const [id, d] of Object.entries(change.desks ?? {})) {
    const was = desks[id] ?? { level: null, apps: {} };
    const own: DeskQuality = { level: d.level !== undefined ? d.level : was.level, apps: withLevels(was.apps, d.apps) };
    if (own.level === null && Object.keys(own.apps).length === 0) delete desks[id];
    else desks[id] = own;
  }
  return { default: change.default !== undefined ? change.default : doc.default, apps: withLevels(doc.apps, change.apps), desks, updatedAt: doc.updatedAt, ...(doc.fallback ? { fallback: doc.fallback } : {}) };
}

/** Two changes as one body, the later winning wherever both say something. */
export function mergeChanges(earlier: QualityChange, later: QualityChange): QualityChange {
  const out: QualityChange = {};
  const d = later.default !== undefined ? later.default : earlier.default;
  if (d !== undefined) out.default = d;
  if (earlier.apps || later.apps) out.apps = { ...earlier.apps, ...later.apps };
  if (earlier.desks || later.desks) {
    const desks: Record<string, DeskChange> = { ...earlier.desks };
    for (const [id, l] of Object.entries(later.desks ?? {})) {
      const e = desks[id] ?? {};
      const level = l.level !== undefined ? l.level : e.level;
      desks[id] = { ...(level !== undefined ? { level } : {}), ...(e.apps || l.apps ? { apps: { ...e.apps, ...l.apps } } : {}) };
    }
    out.desks = desks;
  }
  return out;
}

// ----- each desk's own, in this browser only: a Platform from before contract 0.3.70, and what moves over from it

/**
 * Levels chosen on one desk, by desk id and then app id, as the Desk app kept them before Platform had a desk layer
 * (`ma.streamQuality.desks.v1`): the app on that desk. Still used against such a Platform, and moved to Platform once
 * it has one.
 */
export type DeskLevels = Readonly<Record<string, Readonly<Record<string, Level>>>>;

/** Whatever this browser kept, from any build: anything unusable is dropped, so that desk follows the account. */
export function parseDeskLevels(raw: unknown): DeskLevels {
  const out: Record<string, Record<string, Level>> = {};
  if (!isObject(raw)) return out;
  for (const [deskId, apps] of Object.entries(raw)) {
    if (!DESK_ID.test(deskId) || !isObject(apps)) continue;
    const own: Record<string, Level> = {};
    for (const [app, v] of Object.entries(apps)) if (APP_ID.test(app) && isLevel(v)) own[app] = v;
    if (Object.keys(own).length) out[deskId] = own;
  }
  return out;
}

/** The same levels with one desk's app set, or put back to following the account with null. */
export function withDeskLevel(desks: DeskLevels, deskId: string, app: string, level: Level | null): DeskLevels {
  const own: Record<string, Level> = { ...desks[deskId] };
  if (level === null) delete own[app];
  else own[app] = level;
  const out: Record<string, Readonly<Record<string, Level>>> = { ...desks };
  if (Object.keys(own).length) out[deskId] = own;
  else delete out[deskId];
  return out;
}

/** This browser's levels as the document's desk layer: each an app on that desk, with no level for the desk itself. */
export function asDesks(local: DeskLevels): Record<string, DeskQuality> {
  return Object.fromEntries(Object.entries(local).map(([id, apps]) => [id, { level: null, apps }]));
}

/**
 * What this browser kept that Platform doesn't have yet, as one change: each desk's app with no level there on
 * Platform. A level Platform has for it, set since from anywhere, wins. Null when there's nothing to move.
 */
export function deskLevelsToMove(local: DeskLevels, doc: StreamQuality): QualityChange | null {
  const desks: Record<string, DeskChange> = {};
  for (const [id, apps] of Object.entries(local)) {
    for (const [app, level] of Object.entries(apps)) {
      if (deskOverrideFor(doc, id, app) !== null) continue;
      desks[id] = { apps: { ...desks[id]?.apps, [app]: level } };
    }
  }
  return Object.keys(desks).length ? { desks } : null;
}

// ----- the `keys` channel (channel 7): QUALITY

export const QUALITY_BYTES = 16;
/** Client to desk. Type 6 is task 23's `HOLD` (ADR 0037). */
export const QUALITY_EVENT = 7;
/** Desk to client. */
export const QUALITY_REPLY = 0x82;

const wire = (level: Level): number => LEVELS.indexOf(level) + 1;
const fromWire = (n: number): Level | undefined => LEVELS[n - 1];

/**
 * The 16-byte QUALITY event for the desk's one stream. Null withdraws this session's ask, which counts as never having
 * asked. `seq` is the session's event counter, as every event on `keys` carries; `desk-rtc` doesn't order by it.
 */
export function encodeQuality(level: Level | null, seq = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(QUALITY_BYTES);
  bytes[0] = QUALITY_EVENT;
  bytes[1] = level === null ? 0 : wire(level);
  bytes[2] = 0; // stream 0, the Browser
  new DataView(bytes.buffer).setUint32(4, seq >>> 0);
  return bytes;
}

export interface QualityReply {
  /** The level the stream is running at. */
  level: Level;
  /** The desk's ceiling, or null for none. */
  limit: Level | null;
  /** Below what this session asked, because of the desk's limit. */
  heldByLimit: boolean;
  /** Above what this session asked, because another viewer asked for more. */
  raisedByOther: boolean;
}

/** The desk's answer, type 0x82. Null for anything else, or anything this build can't read. */
export function decodeQualityReply(message: Uint8Array | ArrayBuffer): QualityReply | null {
  const b = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (b.length !== QUALITY_BYTES || b[0] !== QUALITY_REPLY || b[2] !== 0) return null;
  const level = fromWire(b[1] ?? 0);
  const limitByte = b[4] ?? 0;
  const limit = limitByte === 0 ? null : fromWire(limitByte);
  if (!level || limit === undefined) return null;
  const flags = b[3] ?? 0;
  return { level, limit, heldByLimit: (flags & 1) !== 0, raisedByOther: (flags & 2) !== 0 };
}
