// The saved layout doc. Version 2 stores sizes in units (ADR 0062). Version 1 stored cells: each desk
// had cols and rows, and each app a size class, with positions coming from packing. Version 1 is
// read once, and left where it is, so rolling the app back finds the member's layout untouched.
import { GUILD_APPS, isGuildPanel } from '../guild/panel';
import { adultOnly, type AgeBand } from '../platform/age';
import { clearSpot, separateDesks } from './deskPush';
import { isDeskStyleId } from '../theme/deskStyles';
import { defaultDesk, deskFromGrid, G, isAgentApp, panelH, placeNewDesk, roundUnit, settleDesk, stackOrder, withStack, type AppId, type DetailLevel, type LayoutDesk, type LayoutItem } from './layout';

export interface LayoutDoc {
  desks: Record<string, LayoutDesk>;
  /** Stacking order, bottom to top. */
  z: string[];
}

export const LAYOUT_KEY = 'ma.layout.v2';
export const LAYOUT_KEY_V1 = 'ma.layout.v1';

const APPS: readonly string[] = ['notebook', 'browser', 'chat', 'agent', 'commons', 'files'];
const LEVELS: readonly string[] = ['icon', 'small', 'wide', 'large'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** One of the four, or an agent's own (task 49): `agent:<agentId>`. */
const isApp = (v: unknown): v is AppId => (typeof v === 'string' && APPS.includes(v)) || isAgentApp(v);

function zOf(raw: Json, desks: Record<string, unknown>): string[] {
  const z = Array.isArray(raw['z']) ? raw['z'] : [];
  return z.filter((id): id is string => typeof id === 'string' && id in desks);
}

/** Version 1 to version 2. Null if it isn't a layout at all. A desk or app it can't read is left out. */
export function migrateLayoutV1(raw: unknown): LayoutDoc | null {
  if (!isObject(raw) || !isObject(raw['desks'])) return null;
  const desks: Record<string, LayoutDesk> = {};
  for (const [id, d] of Object.entries(raw['desks'])) {
    if (!isObject(d)) continue;
    const items = (Array.isArray(d['items']) ? d['items'] : []).flatMap((i: unknown) => {
      if (!isObject(i) || typeof i['id'] !== 'string' || !isApp(i['app'])) return [];
      const level = (typeof i['size'] === 'string' && LEVELS.includes(i['size']) ? i['size'] : 'icon') as DetailLevel;
      return [{ id: i['id'], app: i['app'], level }];
    });
    desks[id] = deskFromGrid({
      id,
      x: isNumber(d['x']) ? d['x'] : 0,
      y: isNumber(d['y']) ? d['y'] : 0,
      cols: isNumber(d['cols']) ? Math.round(d['cols']) : 6,
      rows: isNumber(d['rows']) ? Math.round(d['rows']) : 1,
      items,
    });
  }
  return { desks, z: zOf(raw, desks) };
}

/** Bad numbers don't lose an app: it gets a default place and size, and settleDesk finds it a free spot. */
function readItem(raw: unknown): { item: LayoutItem; bad: boolean } | null {
  if (!isObject(raw) || typeof raw['id'] !== 'string' || !isApp(raw['app'])) return null;
  const { x, y, w, h } = raw;
  const goodW = isNumber(w) && w > 0;
  const goodH = isNumber(h) && h > 0;
  return {
    bad: !isNumber(x) || !isNumber(y) || !goodW || !goodH,
    item: {
      id: raw['id'],
      app: raw['app'],
      x: roundUnit(isNumber(x) ? x : G.padX),
      y: roundUnit(isNumber(y) ? y : G.padTop),
      w: roundUnit(goodW ? w : G.cell),
      h: roundUnit(goodH ? h : G.cell),
    },
  };
}

// ----- Platform's copy (contract desks.md, "Desk UI layout persistence"): one document per member, opaque to
// Platform, which only needs an integer `schemaVersion` and at most 64 KiB. It has the shape of version 2.

export const SCHEMA_VERSION = 2;

/**
 * Under the contract's 64 KiB, with room for a server that counts its bytes differently, and for the browser's
 * own 64 KiB limit on a request sent as the page goes away.
 */
export const MAX_SERVER_BYTES = 60 * 1024;

/** Far past any real desk, and low enough that repairing a bad one can't hang the tab. */
const MAX_ITEMS_PER_DESK = 64;

/** Fields a newer build may have added, such as `prefs`. They go back as they came. */
export type ServerExtra = Record<string, unknown>;

export type ServerRead =
  | { kind: 'ok'; doc: LayoutDoc; extra: ServerExtra }
  /** From a newer build: can't be read, and mustn't be replaced. */
  | { kind: 'newer' }
  /** Not something any build of this app wrote, so it's safe to replace. */
  | { kind: 'bad' };

export function readServerLayout(raw: unknown): ServerRead {
  if (!isObject(raw) || !Number.isInteger(raw['schemaVersion'])) return { kind: 'bad' };
  const schema = raw['schemaVersion'] as number;
  if (schema > SCHEMA_VERSION) return { kind: 'newer' };
  if (schema < SCHEMA_VERSION || !isObject(raw['desks'])) return { kind: 'bad' };
  for (const d of Object.values(raw['desks'])) {
    if (!isObject(d) || !Array.isArray(d['items']) || d['items'].length > MAX_ITEMS_PER_DESK) return { kind: 'bad' };
  }
  const doc = readLayoutDoc(raw);
  if (!doc) return { kind: 'bad' };
  const extra: ServerExtra = { ...raw };
  delete extra['schemaVersion'];
  delete extra['desks'];
  delete extra['z'];
  return { kind: 'ok', doc, extra };
}

const sameItems = (a: readonly LayoutItem[], b: readonly LayoutItem[]): boolean =>
  a.length === b.length && a.every((i, n) => {
    const o = b[n]!;
    return i.id === o.id && i.app === o.app && i.x === o.x && i.y === o.y && i.w === o.w && i.h === o.h;
  });

/** Everything a desk saves, its stack and its style included: how its apps are stacked, and how it looks, are the member's. */
export function sameDesk(a: LayoutDesk, b: LayoutDesk): boolean {
  if (a === b) return true;
  if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h || a.style !== b.style) return false;
  return sameItems(a.items, b.items) && sameList(stackOrder(a), stackOrder(b));
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function sameLayout(a: LayoutDoc, b: LayoutDoc): boolean {
  const ids = Object.keys(a.desks);
  if (ids.length !== Object.keys(b.desks).length || !sameList(a.z, b.z)) return false;
  return ids.every((id) => {
    const x = a.desks[id];
    const y = b.desks[id];
    return !!x && !!y && sameDesk(x, y);
  });
}

/** The same desks in the same places. A stack, an app or the order of `z` can change without the camera having to hear of it. */
export function sameBounds(a: LayoutDoc, b: LayoutDoc): boolean {
  const ids = Object.keys(a.desks);
  if (ids.length !== Object.keys(b.desks).length) return false;
  return ids.every((id) => {
    const x = a.desks[id];
    const y = b.desks[id];
    return !!x && !!y && x.x === y.x && x.y === y.y && x.w === y.w && x.h === y.h;
  });
}

/**
 * Platform's copy, with this browser's own unsaved desks on top: on a desk's own layout, the last to save wins.
 * A desk only this browser has stays, until the desk list says it's gone. An unchanged desk keeps its object, so
 * it doesn't render, and a cleanup's undo stays good. The order of the desks (`z`) stays this browser's, since it
 * changes with every focus, and a new desk goes on top in Platform's order. A desk's `stack` isn't that: it's part
 * of the desk, and goes with it.
 */
export function mergeServerLayout(server: LayoutDoc, local: LayoutDoc, dirty: ReadonlySet<string>): LayoutDoc {
  const desks: Record<string, LayoutDesk> = {};
  for (const [id, theirs] of Object.entries(server.desks)) {
    const mine = local.desks[id];
    desks[id] = mine && (dirty.has(id) || sameDesk(mine, theirs)) ? mine : theirs;
  }
  for (const [id, mine] of Object.entries(local.desks)) {
    if (!desks[id]) desks[id] = mine;
  }
  const z = [...local.z, ...server.z, ...Object.keys(desks)].filter((id, i, all) => id in desks && all.indexOf(id) === i);
  return { desks, z };
}

/**
 * A desk as this age band has it. A teen's holds no adults-only app, so nothing that reads a desk has to know about them:
 * not the canvas, the proxies, the keyboard, the hidden count, cleanup or a save. Someone who has turned 18 gets the
 * Agent back at its default place, or the free spot nearest it. No band changes nothing, and a desk with nothing to
 * change is this same object.
 */
export function fitDeskToBand(desk: LayoutDesk, band: AgeBand): LayoutDesk {
  if (band === 'teen') {
    if (!desk.items.some((i) => adultOnly(i.app))) return desk;
    const kept = { ...desk, items: desk.items.filter((i) => !adultOnly(i.app)) };
    return withStack(kept, stackOrder(kept));
  }
  if (band === 'adult' && !desk.items.some((i) => i.app === 'agent')) {
    const agent = defaultDesk(desk.id, 0, 0).items.find((i) => i.app === 'agent')!;
    return settleDesk({ ...desk, items: [...desk.items, agent] }, new Set([agent.id]));
  }
  return desk;
}

/** Every desk in a document, cleared of any overlap a returning app made. The same document if nothing changed. */
export function fitDocToBand(doc: LayoutDoc, band: AgeBand): LayoutDoc {
  let desks = doc.desks;
  for (const [id, desk] of Object.entries(doc.desks)) {
    const fit = fitDeskToBand(desk, band);
    if (fit === desk) continue;
    if (desks === doc.desks) desks = { ...doc.desks };
    desks[id] = fit;
  }
  return desks === doc.desks ? doc : clearLayoutDoc({ ...doc, desks });
}

/** A desk this browser has no layout for: where it was going, unless a taller desk from another row is there. */
export function freshDesk(id: string, placed: readonly LayoutDesk[], band: AgeBand = null): LayoutDesk {
  const { x, y } = placeNewDesk(placed);
  // A Guild Desk's panel holds Commons, Notebook and Agent, and never a Browser (task 48).
  const fresh = fitDeskToBand(defaultDesk(id, x, y, isGuildPanel(id) ? GUILD_APPS : undefined), band);
  return { ...fresh, ...clearSpot(fresh, placed) };
}

/**
 * What this browser shows once a document has come, whoever wrote it. Desks never overlap (ADR 0064), so it's cleared
 * as a local one is on load. That happens first on the document alone, in its own order, so every browser that reads
 * it gets the same answer whatever its own `z` says, and a browser with nothing to send never disagrees with another.
 * Merging can then make an overlap of its own: a desk moved here, and another moved there. What's unsaved here stays
 * where the member put it, then what the document says, and only a desk that only this browser has goes round them.
 * None of this counts as a change: it saves nothing, so there's nothing for two browsers to pass back and forth.
 * Only `listed` desks come in, once there's a list: one that's gone is gone, however recently it was saved.
 */
export function arrivingLayout(server: LayoutDoc, local: LayoutDoc, unsaved: ReadonlySet<string>, listed: ReadonlySet<string> | null = null): LayoutDoc {
  const clear = clearLayoutDoc(server);
  const theirs: LayoutDoc = listed ? { desks: Object.fromEntries(Object.entries(clear.desks).filter(([id]) => listed.has(id))), z: clear.z.filter((id) => listed.has(id)) } : clear;
  return clearLayoutDoc(mergeServerLayout(theirs, local, unsaved), [...[...unsaved].sort(), ...[...theirs.z].reverse(), ...Object.keys(theirs.desks).sort()]);
}

/** A first desk's height before ADR 0062's new default: one row, which is what a saved or migrated desk still has. */
const OLD_DESK_H = panelH(1);
/** A first desk's place until the name moved into the strip (`G.label`, b0de92f), so the row an older browser's desks are in. */
const OLD_ROW_Y = 36;

/**
 * Nobody has arranged these desks: they're where a first visit put them, in this build or an older one. A browser like
 * this has nothing to upload, and uploading it could replace an arrangement that another browser hasn't had the chance
 * to send yet. That's the worst thing this can get wrong the other way too, so it's narrow: the apps in the list's order
 * at their default places, one row in the list's order, nothing dragged. What older builds wrote is known, and differs
 * only in the desk's height and how far down the row is. The list is in order of creation, so its order doesn't change.
 *
 * The stack doesn't count. Pressing an app raises it, so a browser nobody arranged anything in has one, and at these
 * places nothing overlaps, so it shows nothing. One thing reads the same either way: a new desk shrunk to its smallest
 * from the keyboard, with nothing else touched, is exactly an old default, and stays here until the next real change.
 * A teen's default is the same row without the adults-only apps, and it counts whatever the band is yet, since this can
 * run before `/v1/me` has answered. Nobody else's desk ever lacks them, so it changes nothing for anyone else.
 */
export function isUntouched(doc: LayoutDoc, ids: readonly string[]): boolean {
  const placed: LayoutDesk[] = [];
  return ids.every((id, n) => {
    const fresh = freshDesk(id, placed);
    const mine = doc.desks[id];
    placed.push(mine ?? fresh);
    if (!mine) return true;
    const inRow = mine.y === fresh.y || (n === 0 && mine.y === OLD_ROW_Y);
    // A style is only ever the member's own choice, so a desk wearing one has been touched.
    // An agent's own tile comes from the desk's word, not the member's hand (task 49), so it doesn't make a desk arranged. Nor does Files' tile (`apps/files/tiles.ts`). One
    // that made the desk grow does: there's no telling that from a member's resize, and either way it's something to send.
    const own = mine.items.filter((i) => !isAgentApp(i.app) && i.app !== 'files');
    return !mine.style && inRow && mine.x === fresh.x && mine.w === fresh.w && (mine.h === fresh.h || mine.h === OLD_DESK_H) && (sameItems(own, fresh.items) || sameItems(own, fitDeskToBand(fresh, 'teen').items));
  });
}

const bytesOf = (s: string): number => new TextEncoder().encode(s).length;

/**
 * The body of a save, at most `maxBytes`. If a hostile number of desks won't fit, the most recently raised go
 * first, and the rest stay in this browser: the merge above keeps a desk only it has.
 */
export function writeServerLayout(doc: LayoutDoc, extra: ServerExtra = {}, maxBytes = MAX_SERVER_BYTES): string {
  const wrap = (layout: unknown): string => JSON.stringify({ layout });
  const shell = (kept: ServerExtra): Record<string, unknown> => ({ ...kept, schemaVersion: SCHEMA_VERSION, desks: {}, z: [] });
  const keptExtra = bytesOf(wrap(shell(extra))) <= maxBytes / 2 ? extra : {};
  let used = bytesOf(wrap(shell(keptExtra)));
  const desks: Record<string, unknown> = {};
  const z: string[] = [];
  const order = [...doc.z].reverse().concat(Object.keys(doc.desks));
  for (const id of order) {
    const d = doc.desks[id];
    if (!d || id in desks) continue;
    // `stack` only if the desk has one (ADR 0064), and `style` only once the member has picked one, so a desk that has
    // neither saves as it always did.
    const entry = { x: d.x, y: d.y, w: d.w, h: d.h, items: d.items.map(({ id: itemId, app, x, y, w, h }) => ({ id: itemId, app, x, y, w, h })), ...(d.stack ? { stack: d.stack } : {}), ...(d.style ? { style: d.style } : {}) };
    // Its entry in `desks` and in `z`, each with a comma, and the key's colon.
    const cost = bytesOf(JSON.stringify(id)) * 2 + bytesOf(JSON.stringify(entry)) + 3;
    if (used + cost > maxBytes) continue;
    used += cost;
    desks[id] = entry;
    z.unshift(id);
  }
  return wrap({ ...keptExtra, schemaVersion: SCHEMA_VERSION, desks, z });
}

/** The ids in a stored `stack`, if it's a list at all. `stackOrder` deals with any that are missing, repeated or not on the desk. */
const storedStack = (d: Json): string[] => (Array.isArray(d['stack']) ? d['stack'].filter((id): id is string => typeof id === 'string') : []);

/**
 * Version 2, checked: this came from storage. Null if it isn't a layout at all. Apps stored over each other load
 * as they are, and the list keeps its order, which is a phone's grid. `stack` is optional and has no key of its own
 * (ADR 0064): a desk without one stacks in the list's order and reads and writes exactly as it always did. There's
 * no sort either: no earlier build could save an overlap, and two apps only come to overlap by one of them being
 * moved, which puts it on top, so the order such a desk starts in can never show.
 */
export function readLayoutDoc(raw: unknown): LayoutDoc | null {
  if (!isObject(raw) || !isObject(raw['desks'])) return null;
  const desks: Record<string, LayoutDesk> = {};
  for (const [id, d] of Object.entries(raw['desks'])) {
    if (!isObject(d) || !Array.isArray(d['items'])) continue;
    const read = d['items'].flatMap((i: unknown) => {
      const r = readItem(i);
      return r ? [r] : [];
    });
    const desk = settleDesk({
      id,
      x: isNumber(d['x']) ? d['x'] : 0,
      y: isNumber(d['y']) ? d['y'] : 0,
      w: isNumber(d['w']) ? d['w'] : 0,
      h: isNumber(d['h']) ? d['h'] : 0,
      items: read.map((r) => r.item),
    }, new Set(read.filter((r) => r.bad).map((r) => r.item.id)));
    const stacked = withStack(desk, stackOrder({ items: desk.items, stack: storedStack(d) }));
    // A style is kept by its id, known here or not: one a newer build added draws as the default, and goes back as it came.
    desks[id] = isDeskStyleId(d['style']) ? { ...stacked, style: d['style'] } : stacked;
  }
  return { desks, z: zOf(raw, desks) };
}

/**
 * Desks never overlap (ADR 0064), so one that does when it's read gets the smallest moves that clear it, keeping the
 * desk on top where it is when that costs no more. Anything else, however close, is this same object, so a clean
 * layout comes through byte for byte. Desks in `keep` stay where they are: a member's own unsaved change, when it
 * meets what another browser saved.
 */
export function clearLayoutDoc(doc: LayoutDoc, keep: readonly string[] = []): LayoutDoc {
  const moves = separateDesks(Object.values(doc.desks), [...keep, ...[...doc.z].reverse()], keep.length > 0);
  if (!moves.length) return doc;
  const desks = { ...doc.desks };
  for (const { id, x, y } of moves) desks[id] = { ...desks[id]!, x, y };
  return { ...doc, desks };
}
