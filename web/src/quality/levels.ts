// Stream quality levels (ADR 0039): the four levels, what a member reads about each, which apps have one, and
// the `keys` channel's QUALITY events (docs/interfaces/stream-quality.md section 3). Pure: no DOM, no network.
export type Level = 'low' | 'medium' | 'high' | 'max';

/** In order: "highest" and "at most" compare these. */
export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'max'];

/** What a member who never chose gets, and what the desk streams today. */
export const DEFAULT_LEVEL: Level = 'high';

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

/** The member's document (ma-platform contract stream-quality.md). */
export interface StreamQuality {
  default: Level;
  /** Per-app overrides. An app with no entry follows `default`. */
  apps: Readonly<Record<string, Level>>;
  /** The last change, or null if the member never chose. */
  updatedAt: string | null;
}

export const NEVER_SET: StreamQuality = { default: DEFAULT_LEVEL, apps: {}, updatedAt: null };

/** The contract's app ids. Also keeps `__proto__` and its kind out of a plain object. */
export const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Whatever Platform or an old mirror sent. Anything unusable reads as never set, and an unknown level as High. */
export function parseStreamQuality(raw: unknown): StreamQuality {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return NEVER_SET;
  const r = raw as Record<string, unknown>;
  const apps: Record<string, Level> = {};
  const rawApps = r['apps'];
  if (typeof rawApps === 'object' && rawApps !== null && !Array.isArray(rawApps)) {
    for (const [app, v] of Object.entries(rawApps as Record<string, unknown>)) {
      // Null is no override. Anything else that isn't a level is one this build doesn't know, which counts as High.
      if (APP_ID.test(app) && v !== null && v !== undefined) apps[app] = isLevel(v) ? v : DEFAULT_LEVEL;
    }
  }
  const updatedAt = r['updatedAt'];
  return { default: isLevel(r['default']) ? r['default'] : DEFAULT_LEVEL, apps, updatedAt: typeof updatedAt === 'string' ? updatedAt : null };
}

/** An app's level: its override, else the member's default, else High. */
export function levelFor(doc: StreamQuality, app: string): Level {
  return (Object.hasOwn(doc.apps, app) ? doc.apps[app] : undefined) ?? doc.default ?? DEFAULT_LEVEL;
}

/** An app's own override, or null when it follows the default. */
export const overrideFor = (doc: StreamQuality, app: string): Level | null => (Object.hasOwn(doc.apps, app) ? (doc.apps[app] ?? null) : null);

// ----- each desk's own (the owner's rule, `HANDOFF.md` section 4: the account sets a default, a desk overrides it)

/**
 * Levels chosen on one desk, by desk id and then app id. The contract has no desk layer yet, so these are kept in this
 * browser only (`store.ts`), and nothing set on one desk reaches another.
 */
export type DeskLevels = Readonly<Record<string, Readonly<Record<string, Level>>>>;

/** A desk id as Platform makes them (`d-` and letters), or a fixture's. Also keeps `__proto__` out. */
export const DESK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Whatever this browser kept, from any build: anything unusable is dropped, so that desk follows the account. */
export function parseDeskLevels(raw: unknown): DeskLevels {
  const out: Record<string, Record<string, Level>> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [deskId, apps] of Object.entries(raw as Record<string, unknown>)) {
    if (!DESK_ID.test(deskId) || typeof apps !== 'object' || apps === null || Array.isArray(apps)) continue;
    const own: Record<string, Level> = {};
    for (const [app, v] of Object.entries(apps as Record<string, unknown>)) if (APP_ID.test(app) && isLevel(v)) own[app] = v;
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

/** That desk's own level for an app, or null when it follows the account. */
export const deskOverrideFor = (desks: DeskLevels, deskId: string | undefined, app: string): Level | null =>
  deskId !== undefined && Object.hasOwn(desks, deskId) && Object.hasOwn(desks[deskId]!, app) ? (desks[deskId]![app] ?? null) : null;

/** An app's level on a desk: that desk's own, else the account's (its override for the app, else its default), else High. */
export const levelOnDesk = (doc: StreamQuality, desks: DeskLevels, deskId: string | undefined, app: string): Level => deskOverrideFor(desks, deskId, app) ?? levelFor(doc, app);

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
