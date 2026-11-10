// Who wrote what inside a page, on a guild desk, and the rule that follows from it: a member without `moderate` may
// remove only so much of what other members wrote (REMOVAL_BUDGET per page per REMOVAL_WINDOW_MS), so typo fixes, cuts
// and rewrites work and a wipe doesn't. Moving it is free (a split, a join, a new block type, a drag), and moved text
// stays its writer's. Formatting and attributes are free.
//
// Authorship is by Yjs client id. Each browser tab's Y.Doc writes under a random 32-bit client id, and the first update
// that carries structs under a new client id says whose it is: the member on that connection. Text another member's
// update re-inserts as it deletes it (a moved block) is credited back to its writer, by range of the new structs.
//
// The check runs on each update before Yjs applies it, against the page as the desk has it:
//   1. Deleted: every live text item the update deletes, directly or by deleting an element above it, split by writer.
//   2. Inserted: the update's new text, in text nodes the update doesn't also delete, per client in clock order.
//   3. Each run of another member's deleted text is looked for in what's inserted. Found text is credited to its writer.
//      What isn't found is removed, and costs: a character each, a whole block at least BLOCK_MIN, an embed or a leaf
//      block (a rule, an image) BLOCK_MIN. An update that would take a member past the budget is refused, whole.
// Also refused for anyone: new structs under a client id that's another member's, and deletes of another member's
// structs the desk hasn't seen yet (Yjs would keep those and apply them when that member's update arrives).
import * as Y from 'yjs';
import { type Db } from './db.ts';
import { log } from './log.ts';
import { notebookSchema } from './model.ts';
import { DEFAULT_EDIT_BUDGET, type EditBudget } from './settings.ts';

// ---- the defaults, pending the owner's word (settings.ts, which deskd's `editBudget` overrides per connection)
/** How much of other members' content a member without `moderate` may remove from one page in a window. */
export const REMOVAL_BUDGET = DEFAULT_EDIT_BUDGET.chars;
/** The rolling window that budget is for. */
export const REMOVAL_WINDOW_MS = DEFAULT_EDIT_BUDGET.windowMs;
/** What a whole block, an embed or a leaf block (a rule, an image) costs at least. */
export const BLOCK_MIN = 50;

/** Block nodes with no content of their own, such as a horizontal rule, from the Notebook's schema. */
let leafBlocks: Set<string> | null = null;
function isLeafBlock(nodeName: string): boolean {
  leafBlocks ??= new Set(
    Object.values(notebookSchema().nodes)
      .filter((n) => n.isLeaf && n.isBlock)
      .map((n) => n.name),
  );
  return leafBlocks.has(nodeName);
}

interface Credit {
  clock: number;
  end: number;
  member: string;
}

export interface Verdict {
  /**
   * What the update removes of other members' content and doesn't put back, against the budget: a UTF-16 unit of text
   * each, a whole block max(BLOCK_MIN, its text), an embed or a leaf block BLOCK_MIN.
   */
  cost: number;
  /** New structs under another member's client id, or deletes of theirs the desk can't see yet. */
  impersonates: boolean;
  /** Client ids first seen in this update: the sender's from now on. */
  newClients: number[];
  /** New text that is another member's text, moved. */
  credits: { client: number; clock: number; len: number; member: string }[];
}

/** One page's writers: client id to member, and moved text credited to whoever wrote it. */
export class PageOwners {
  readonly clients = new Map<number, string>();
  /** By client, sorted by clock, never overlapping: each covers new structs, credited once. */
  readonly credits = new Map<number, Credit[]>();

  addCredit(client: number, clock: number, len: number, member: string): void {
    let list = this.credits.get(client);
    if (!list) {
      list = [];
      this.credits.set(client, list);
    }
    const c = { clock, end: clock + len, member };
    let i = list.length;
    while (i > 0 && (list[i - 1] as Credit).clock > clock) i -= 1;
    list.splice(i, 0, c);
  }

  /** [a, b) of a client's clocks, cut where the writer changes. A null member is nobody's: text from before this. */
  segments(client: number, a: number, b: number): { a: number; b: number; member: string | null }[] {
    const base = this.clients.get(client) ?? null;
    const list = this.credits.get(client);
    if (!list || !list.length) return [{ a, b, member: base }];
    const out: { a: number; b: number; member: string | null }[] = [];
    // The first credit that ends after a.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((list[mid] as Credit).end <= a) lo = mid + 1;
      else hi = mid;
    }
    let at = a;
    for (let i = lo; i < list.length && at < b; i += 1) {
      const c = list[i] as Credit;
      if (c.clock >= b) break;
      if (c.clock > at) {
        out.push({ a: at, b: c.clock, member: base });
        at = c.clock;
      }
      const end = Math.min(b, c.end);
      out.push({ a: at, b: end, member: c.member });
      at = end;
    }
    if (at < b) out.push({ a: at, b, member: base });
    return out;
  }
}

type Struct = Y.Item | Y.GC | Y.Skip;
type Place = { parent: Y.AbstractType<any> | null; parentStruct: Y.Item | null; sub: string | null } | null;

/** Sorted, merged delete ranges of one client in an update. */
function sortedRanges(items: { clock: number; len: number }[]): [number, number][] {
  const r = items.map((d) => [d.clock, d.clock + d.len] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of r) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function covers(ranges: [number, number][] | undefined, clock: number): boolean {
  if (!ranges) return false;
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid] as [number, number])[1] <= clock) lo = mid + 1;
    else hi = mid;
  }
  const r = ranges[lo];
  return !!r && r[0] <= clock;
}

/** [a, b) less the deleted ranges. */
function subtract(ranges: [number, number][] | undefined, a: number, b: number): [number, number][] {
  if (!ranges) return [[a, b]];
  const out: [number, number][] = [];
  let at = a;
  for (const [x, y] of ranges) {
    if (y <= at) continue;
    if (x >= b) break;
    if (x > at) out.push([at, x]);
    at = Math.max(at, y);
    if (at >= b) break;
  }
  if (at < b) out.push([at, b]);
  return out;
}

const MAX_MATCH_STEPS = 500_000;

/** A run of another member's text the update deletes: its block, its pieces, and how much of it wasn't put back. */
interface Run {
  text: string;
  member: string;
  block: Y.Item | null;
  pieces: string[];
  missing: number;
}

/** Text not put back costs a unit a character; a block none of whose text is put back costs at least BLOCK_MIN. */
function costOf(runs: Run[]): number {
  let cost = 0;
  const blocks = new Map<Y.Item, { total: number; missing: number }>();
  for (const r of runs) {
    if (!r.block) {
      cost += r.missing;
      continue;
    }
    const b = blocks.get(r.block) ?? { total: 0, missing: 0 };
    b.total += r.text.length;
    b.missing += r.missing;
    blocks.set(r.block, b);
  }
  for (const b of blocks.values()) cost += b.missing > 0 && b.missing >= b.total ? Math.max(BLOCK_MIN, b.total) : b.missing;
  return cost;
}

/** Another member's leaf blocks and embeds the update deletes, less as many of each kind as it makes: BLOCK_MIN each. */
function leafCost(leaves: { kind: string; item: Y.Item }[], fresh: Map<number, Y.Item[]>, state: (client: number) => number): number {
  if (!leaves.length) return 0;
  const made = new Map<string, number>();
  for (const list of fresh.values()) {
    for (const it of list) {
      if (it.id.clock + it.length <= state(it.id.client)) continue;
      const kind = it.content instanceof Y.ContentEmbed ? 'embed' : it.content instanceof Y.ContentType && it.content.type instanceof Y.XmlElement ? it.content.type.nodeName : null;
      if (kind) made.set(kind, (made.get(kind) ?? 0) + 1);
    }
  }
  let cost = 0;
  for (const { kind } of leaves) {
    const n = made.get(kind) ?? 0;
    if (n > 0) made.set(kind, n - 1);
    else cost += BLOCK_MIN;
  }
  return cost;
}

/** An update Yjs can't read: damage, handled as any damaged update is. */
export class UnreadableUpdate extends Error {
  override name = 'UnreadableUpdate';
}

/** The check, without side effects: what this update does to other members' text on this page. */
export function judge(doc: Y.Doc, update: Uint8Array, memberId: string, owners: PageOwners): Verdict {
  let decoded: { structs: Struct[]; ds: { clients: Map<number, { clock: number; len: number }[]> } };
  try {
    decoded = Y.decodeUpdate(update) as typeof decoded;
  } catch {
    throw new UnreadableUpdate();
  }
  const { structs, ds } = decoded;
  const store = doc.store;
  const state = (client: number): number => Y.getState(store, client);
  const deleted = new Map<number, [number, number][]>();
  for (const [client, items] of ds.clients) deleted.set(client, sortedRanges(items));
  const verdict: Verdict = { cost: 0, impersonates: false, newClients: [], credits: [] };

  // ---- the update's new structs, and who they claim to be
  const fresh = new Map<number, Y.Item[]>();
  const newClients = new Set<number>();
  for (const s of structs) {
    if (!(s instanceof Y.Item) && !(s instanceof Y.GC)) continue;
    const client = s.id.client;
    if (s.id.clock + s.length <= state(client)) continue;
    const owner = owners.clients.get(client);
    if (owner === undefined) newClients.add(client);
    else if (owner !== memberId) verdict.impersonates = true;
    if (s instanceof Y.Item) {
      let list = fresh.get(client);
      if (!list) {
        list = [];
        fresh.set(client, list);
      }
      list.push(s);
    }
  }
  verdict.newClients = [...newClients];
  // Structs after a gap in a client's clocks wait in Yjs for what's missing, and aren't in the page: they can't count as
  // text put back. (Structs whose origins are missing are left out where they're placed, below.)
  for (const [client, list] of fresh) {
    list.sort((x, y) => x.id.clock - y.id.clock);
    let next = state(client);
    let keep = 0;
    for (const it of list) {
      if (it.id.clock > next) break;
      next = Math.max(next, it.id.clock + it.length);
      keep += 1;
    }
    list.length = keep;
  }

  const freshAt = (id: Y.ID): Y.Item | null => {
    const list = fresh.get(id.client);
    if (!list) return null;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const it = list[mid] as Y.Item;
      if (it.id.clock + it.length <= id.clock) lo = mid + 1;
      else hi = mid;
    }
    const it = list[lo];
    return it && it.id.clock <= id.clock ? it : null;
  };
  const docItemAt = (id: Y.ID): Y.Item | null => {
    if (id.clock >= state(id.client)) return null;
    const s = Y.getItem(store, id) as Y.Item | Y.GC;
    return s instanceof Y.Item ? s : null;
  };

  // Where a new struct goes: its parent and map key, as Yjs will work them out when it integrates it.
  const places = new Map<Y.Item, Place>();
  const placeOf = (it: Y.Item, depth = 0): Place => {
    if (places.has(it)) return places.get(it) as Place;
    let place: Place = null;
    if (depth < 10_000) {
      const parent = it.parent as unknown;
      if (parent !== null) {
        if (typeof parent === 'string') place = { parent: null, parentStruct: null, sub: it.parentSub };
        else {
          const pid = parent as Y.ID;
          const inDoc = docItemAt(pid);
          const inUpdate = inDoc ? null : freshAt(pid);
          const p = inDoc ?? inUpdate;
          if (p && p.content instanceof Y.ContentType) place = { parent: inDoc ? (p.content.type as Y.AbstractType<any>) : null, parentStruct: p, sub: it.parentSub };
        }
      } else {
        for (const oid of [it.origin, it.rightOrigin]) {
          if (!oid) continue;
          const inDoc = docItemAt(oid);
          if (inDoc) {
            place = { parent: inDoc.parent as Y.AbstractType<any>, parentStruct: (inDoc.parent as Y.AbstractType<any>)._item, sub: inDoc.parentSub };
            break;
          }
          const inUpdate = freshAt(oid);
          if (inUpdate) {
            place = placeOf(inUpdate, depth + 1);
            break;
          }
        }
      }
    }
    places.set(it, place);
    return place;
  };

  /** The type an item sits in, or null for a root or a parent that can't be found. */
  const typeAbove = (item: Y.Item): Y.AbstractType<any> | null => {
    if (item.id.clock < state(item.id.client)) return item.parent as Y.AbstractType<any>;
    const up = placeOf(item);
    return up?.parentStruct && up.parentStruct.content instanceof Y.ContentType ? (up.parentStruct.content.type as Y.AbstractType<any>) : null;
  };

  // Whether text in this new item will be live and shown: in a text node inside an element, as the editor writes text,
  // with nothing above it in a map (an attribute) or deleted, by the page already or by this update. Text put anywhere
  // else doesn't count as put back.
  const shown = (it: Y.Item): boolean => {
    const place = placeOf(it);
    if (!place || place.sub !== null || !place.parentStruct) return false;
    const p = place.parentStruct;
    if (!(p.content instanceof Y.ContentType) || !(p.content.type instanceof Y.XmlText)) return false;
    if (!(typeAbove(p) instanceof Y.XmlElement)) return false;
    let cur: Y.Item | null = p;
    for (let guard = 0; cur && guard < 10_000; guard += 1) {
      if (covers(deleted.get(cur.id.client), cur.id.clock)) return false;
      let sub: string | null;
      let next: Y.Item | null;
      if (cur.id.clock < state(cur.id.client)) {
        if (cur.deleted) return false;
        sub = cur.parentSub;
        next = (cur.parent as Y.AbstractType<any>)._item;
      } else {
        const up: Place = placeOf(cur);
        if (!up) return false;
        sub = up.sub;
        next = up.parentStruct;
      }
      if (sub !== null) return false;
      cur = next; // null: under a root type, which is never deleted
    }
    return !cur;
  };

  // ---- 1. other members' live content this update deletes
  const whole = new Set<Y.Item>();
  const partial: { item: Y.Item; a: number; b: number }[] = [];
  /** Elements the update deletes: the top one above a text item is its block. */
  const removedElements = new Set<Y.Item>();
  /** Leaf blocks and embeds it deletes, by kind ('embed' or a node name), whoever wrote them. */
  const removedLeaves: { kind: string; item: Y.Item }[] = [];
  const element = (n: Y.Item): void => {
    const type = (n.content as Y.ContentType).type;
    if (!(type instanceof Y.XmlElement)) return;
    removedElements.add(n);
    if (isLeafBlock(type.nodeName)) removedLeaves.push({ kind: type.nodeName, item: n });
  };
  const collect = (type: Y.AbstractType<any>, depth: number): void => {
    if (depth > 10_000) return;
    for (let n = type._start; n; n = n.right) {
      if (n.deleted) continue;
      if (n.content instanceof Y.ContentString && n.parentSub === null) whole.add(n);
      else if (n.content instanceof Y.ContentEmbed && n.parentSub === null) removedLeaves.push({ kind: 'embed', item: n });
      else if (n.content instanceof Y.ContentType) {
        element(n);
        collect(n.content.type as Y.AbstractType<any>, depth + 1);
      }
    }
    for (const n of type._map.values()) {
      if (!n.deleted && n.content instanceof Y.ContentType) collect(n.content.type as Y.AbstractType<any>, depth + 1);
    }
  };
  for (const [client, ranges] of deleted) {
    const known = state(client);
    const owner = owners.clients.get(client);
    for (const [a, b] of ranges) {
      if (b > known && owner !== undefined && owner !== memberId) verdict.impersonates = true;
      const end = Math.min(b, known);
      if (a >= end) continue;
      const list = store.clients.get(client) as (Y.Item | Y.GC)[];
      for (let i = Y.findIndexSS(list, a); i < list.length; i += 1) {
        const s = list[i] as Y.Item | Y.GC;
        if (s.id.clock >= end) break;
        if (!(s instanceof Y.Item) || s.deleted) continue;
        if (s.content instanceof Y.ContentType) {
          element(s);
          collect(s.content.type as Y.AbstractType<any>, 0);
        } else if (s.content instanceof Y.ContentString && s.parentSub === null) {
          partial.push({ item: s, a: Math.max(a, s.id.clock), b: Math.min(end, s.id.clock + s.length) });
        } else if (s.content instanceof Y.ContentEmbed && s.parentSub === null) {
          removedLeaves.push({ kind: 'embed', item: s });
        }
      }
    }
  }
  /** The top element this update deletes above a text item: the whole block it goes with, or null if none does. */
  const blockOf = (item: Y.Item): Y.Item | null => {
    let top: Y.Item | null = null;
    for (let t = item.parent as Y.AbstractType<any> | null, guard = 0; t?._item && guard < 10_000; t = t._item.parent as Y.AbstractType<any>, guard += 1) {
      if (removedElements.has(t._item)) top = t._item;
    }
    return top;
  };
  const gone: Run[] = [];
  const take = (item: Y.Item, a: number, b: number): void => {
    const str = (item.content as Y.ContentString).str;
    const block = blockOf(item);
    for (const seg of owners.segments(item.id.client, a, b)) {
      if (seg.member === null || seg.member === memberId) continue;
      const text = str.slice(seg.a - item.id.clock, seg.b - item.id.clock);
      gone.push({ text, member: seg.member, block, pieces: [text], missing: 0 });
    }
  };
  // What's cut from each text item, for the second look.
  const cut = new Map<Y.Item, [number, number][]>();
  for (const item of whole) {
    take(item, item.id.clock, item.id.clock + item.length);
    cut.set(item, [[item.id.clock, item.id.clock + item.length]]);
  }
  for (const p of partial) {
    if (whole.has(p.item)) continue;
    take(p.item, p.a, p.b);
    const l = cut.get(p.item);
    if (l) l.push([p.a, p.b]);
    else cut.set(p.item, [[p.a, p.b]]);
  }
  const leaves = removedLeaves.filter(({ item }) => {
    const m = owners.segments(item.id.client, item.id.clock, item.id.clock + 1)[0]?.member ?? null;
    return m !== null && m !== memberId;
  });
  if (!gone.length && !leaves.length) return verdict;

  // ---- 2. the text it inserts, where it will be shown
  interface Pool {
    client: number;
    text: string;
    runs: { at: number; clock: number; len: number }[];
    claimed: Uint8Array;
  }
  const pools: Pool[] = [];
  for (const [client, items] of fresh) {
    const known = state(client);
    let text = '';
    const runs: Pool['runs'] = [];
    for (const it of items) {
      if (!(it.content instanceof Y.ContentString) || !shown(it)) continue;
      const str = it.content.str;
      const from = Math.max(it.id.clock, known);
      for (const [x, y] of subtract(deleted.get(client), from, it.id.clock + it.length)) {
        runs.push({ at: text.length, clock: x, len: y - x });
        text += str.slice(x - it.id.clock, y - it.id.clock);
      }
    }
    if (text) pools.push({ client, text, runs, claimed: new Uint8Array(text.length) });
  }

  // ---- 3. every run of another member's text must be there, whole; longest first, each place used once
  gone.sort((x, y) => y.text.length - x.text.length);
  let steps = 0;
  const free = (pool: Pool, at: number, len: number): boolean => {
    for (let i = at; i < at + len; i += 1) if (pool.claimed[i]) return false;
    return true;
  };
  const hint = new Map<string, number>();
  const unmatched: Run[] = [];
  for (const g of gone) {
    let found = false;
    for (let pi = 0; pi < pools.length && !found && steps < MAX_MATCH_STEPS; pi += 1) {
      const pool = pools[pi] as Pool;
      const key = `${pi}\u0000${g.text}`;
      let from = hint.get(key) ?? 0;
      for (;;) {
        steps += 1;
        if (steps > MAX_MATCH_STEPS) break;
        const at = pool.text.indexOf(g.text, from);
        if (at < 0) break;
        if (!free(pool, at, g.text.length)) {
          from = at + 1;
          continue;
        }
        pool.claimed.fill(1, at, at + g.text.length);
        hint.set(key, at + g.text.length);
        // The first run that ends after `at`, then on while they start before the match ends.
        let lo = 0;
        let hi = pool.runs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const r = pool.runs[mid] as Pool['runs'][number];
          if (r.at + r.len <= at) lo = mid + 1;
          else hi = mid;
        }
        for (let ri = lo; ri < pool.runs.length; ri += 1) {
          const r = pool.runs[ri] as Pool['runs'][number];
          if (r.at >= at + g.text.length) break;
          const x = Math.max(at, r.at);
          const y = Math.min(at + g.text.length, r.at + r.len);
          if (x < y) verdict.credits.push({ client: pool.client, clock: r.clock + (x - r.at), len: y - x, member: g.member });
        }
        found = true;
        break;
      }
    }
    if (!found) {
      // The second look starts over, so there's no use going on here.
      unmatched.push(g);
      break;
    }
  }
  let runs = gone;
  if (unmatched.length) {
    // The first look's choices can take characters the second needs, so the second starts over.
    verdict.credits = [];
    runs = deletedRuns(doc, cut, owners, memberId, blockOf);
    afterwards(doc, update, runs, verdict, fresh, state);
  }
  verdict.cost = costOf(runs) + leafCost(leaves, fresh, state);
  return verdict;
}

/** How long the second look may take before what's left counts as deleted. */
const SECOND_LOOK_MS = 1000;
const SEPARATOR = '\uffff';

/**
 * Other members' text the update deletes, in the order of the page, each run as long as it goes: adjacent deleted
 * characters of one writer in one text node join, across formatting. Each run keeps its pieces, in case it was cut up.
 */
function deletedRuns(doc: Y.Doc, cut: Map<Y.Item, [number, number][]>, owners: PageOwners, memberId: string, blockOf: (item: Y.Item) => Y.Item | null): Run[] {
  const runs: Run[] = [];
  let open: Run | null = null;
  const walk = (type: Y.AbstractType<any>, depth: number): void => {
    if (depth > 10_000) return;
    open = null;
    for (let n = type._start; n; n = n.right) {
      if (n.content instanceof Y.ContentType) {
        if (!n.deleted) walk(n.content.type as Y.AbstractType<any>, depth + 1);
        open = null;
        continue;
      }
      if (n.deleted || !(n.content instanceof Y.ContentString) || n.parentSub !== null) continue;
      const str = n.content.str;
      const ranges = (cut.get(n) ?? []).slice().sort((x, y) => x[0] - y[0]);
      let at = n.id.clock;
      const end = n.id.clock + n.length;
      for (const [a, b] of [...ranges, [end, end] as [number, number]]) {
        if (a > at) open = null; // characters that stay break a run
        for (const seg of a < b ? owners.segments(n.id.client, a, b) : []) {
          const text = str.slice(seg.a - n.id.clock, seg.b - n.id.clock);
          if (seg.member === null || seg.member === memberId) {
            open = null;
            continue;
          }
          const cur = open as Run | null;
          if (cur && cur.member === seg.member) {
            cur.text += text;
            cur.pieces.push(text);
          } else {
            open = { text, member: seg.member, block: blockOf(n), pieces: [text], missing: 0 };
            runs.push(open);
          }
        }
        at = Math.max(at, b);
      }
    }
    for (const n of type._map.values()) if (!n.deleted && n.content instanceof Y.ContentType) walk(n.content.type as Y.AbstractType<any>, depth + 1);
    open = null;
  };
  for (const type of doc.share.values()) walk(type, 0);
  return runs;
}

/**
 * The second look, when the first didn't find everything: the page as it will be after the update, on a copy. The
 * editor rewrites blocks in place when it moves them across blocks of the same type (it keeps a common start and end
 * and replaces the middle), so moved text can come back as new characters next to characters that were already there.
 * Each run must appear in a text node the update writes to, in characters not used for another run, with at least one
 * of them new; failing that, each of its pieces must. Only new characters are credited. Runs are looked for in page
 * order from where the last one was found, as moved text keeps its order.
 */
function afterwards(
  doc: Y.Doc,
  update: Uint8Array,
  runs: Run[],
  verdict: Verdict,
  fresh: Map<number, Y.Item[]>,
  stateBefore: (client: number) => number,
): void {
  const deadline = performance.now() + SECOND_LOOK_MS;
  const copy = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(copy, update);

    // Text nodes the update writes live text into, shown as the editor shows text.
    const touched = new Set<Y.AbstractType<any>>();
    for (const client of fresh.keys()) {
      const list = copy.store.clients.get(client);
      const from = stateBefore(client);
      if (!list || from >= Y.getState(copy.store, client)) continue;
      for (let i = Y.findIndexSS(list, from); i < list.length; i += 1) {
        const it = list[i];
        if (!(it instanceof Y.Item) || it.deleted || it.parentSub !== null || !(it.content instanceof Y.ContentString)) continue;
        const parent = it.parent as Y.AbstractType<any>;
        if (parent instanceof Y.XmlText && visible(parent)) touched.add(parent);
      }
    }

    // Their text, in page order, as one string: a separator between nodes, which no run can use.
    let text = '';
    const ids: number[] = [];
    const clocks: number[] = [];
    const freshFlags: number[] = [];
    const order = (type: Y.AbstractType<any>, depth: number): void => {
      if (depth > 10_000) return;
      if (touched.has(type)) {
        for (let n = type._start; n; n = n.right) {
          if (n.deleted || !(n.content instanceof Y.ContentString)) continue;
          text += n.content.str;
          for (let k = 0; k < n.length; k += 1) {
            ids.push(n.id.client);
            clocks.push(n.id.clock + k);
            freshFlags.push(n.id.clock + k >= stateBefore(n.id.client) ? 1 : 0);
          }
        }
        text += SEPARATOR;
        ids.push(-1);
        clocks.push(-1);
        freshFlags.push(0);
        return;
      }
      for (let n = type._start; n; n = n.right) if (!n.deleted && n.content instanceof Y.ContentType) order(n.content.type as Y.AbstractType<any>, depth + 1);
      for (const n of type._map.values()) if (!n.deleted && n.content instanceof Y.ContentType) order(n.content.type as Y.AbstractType<any>, depth + 1);
    };
    for (const type of copy.share.values()) order(type, 0);
    const claimed = new Uint8Array(text.length);
    for (let k = 0; k < text.length; k += 1) if (ids[k] === -1) claimed[k] = 1;

    let cursor = 0;
    let late = false;
    const place = (t: string, member: string): boolean => {
      if (!t) return true;
      for (const [from, to] of [[cursor, text.length], [0, cursor]] as [number, number][]) {
        let at = text.indexOf(t, from);
        while (at >= 0 && at < to) {
          if (performance.now() > deadline) {
            late = true;
            return false;
          }
          let ok = false;
          let k = at;
          for (; k < at + t.length; k += 1) {
            if (claimed[k]) break;
            if (freshFlags[k]) ok = true;
          }
          if (k === at + t.length && ok) {
            claimed.fill(1, at, at + t.length);
            for (let j = at; j < at + t.length; j += 1) {
              if (!freshFlags[j]) continue;
              const client = ids[j] as number;
              const clock = clocks[j] as number;
              const last = verdict.credits[verdict.credits.length - 1];
              if (last && last.client === client && last.clock + last.len === clock && last.member === member) last.len += 1;
              else verdict.credits.push({ client, clock, len: 1, member });
            }
            cursor = at + t.length;
            return true;
          }
          at = text.indexOf(t, at + 1);
        }
      }
      return false;
    };
    for (const run of runs) {
      if (late || !place(run.text, run.member)) {
        for (const piece of run.pieces) if (late || !place(piece, run.member)) run.missing += piece.length;
      }
    }
    if (late) log('WARN', `judging an update took over ${SECOND_LOOK_MS} ms, so it counts as deleting runs=${runs.length} chars=${text.length}`);
  } finally {
    copy.destroy();
  }
}

/** A text node the editor would show: inside an element, with no attribute or deleted item above it. */
function visible(t: Y.AbstractType<any>): boolean {
  let type: Y.AbstractType<any> | null = t;
  if (!(t._item?.parent instanceof Y.XmlElement)) return false;
  for (let guard = 0; type && guard < 10_000; guard += 1) {
    const item: Y.Item | null = type._item;
    if (!item) return true;
    if (item.deleted || item.parentSub !== null) return false;
    type = item.parent as Y.AbstractType<any>;
  }
  return false;
}

/** Whether any live text in the page is another member's. For Trash: trashing it would delete theirs. */
export function holdsOthersText(doc: Y.Doc, memberId: string, owners: PageOwners): boolean {
  for (const [client, list] of doc.store.clients) {
    for (const s of list) {
      if (!(s instanceof Y.Item) || s.deleted || s.parentSub !== null || !(s.content instanceof Y.ContentString)) continue;
      for (const seg of owners.segments(client, s.id.clock, s.id.clock + s.length)) {
        if (seg.member !== null && seg.member !== memberId) return true;
      }
    }
  }
  return false;
}

/**
 * What each member without `moderate` has removed of others' content, per page. In memory only: a restart starts
 * everyone afresh, which is fine. Kept while a page is closed and opened again, so leaving a page doesn't refill it.
 *
 * <p>The budget and its window come with each check, from the connection's settings, and what was counted stays when they
 * change: a longer window counts more of it, a shorter one less. Entries are kept as long as the longest window asked
 * about, so one connection's shorter window never drops what another's longer one still counts.
 */
export class Removals {
  private readonly pages = new Map<string, Map<string, { at: number; cost: number }[]>>();
  private keepMs = REMOVAL_WINDOW_MS;

  constructor(private readonly now: () => number) {}

  private recent(pageId: string, memberId: string): { at: number; cost: number }[] {
    const members = this.pages.get(pageId);
    const list = members?.get(memberId);
    if (!members || !list) return [];
    const since = this.now() - this.keepMs;
    while (list.length && (list[0] as { at: number }).at <= since) list.shift();
    if (!list.length) {
      members.delete(memberId);
      if (!members.size) this.pages.delete(pageId);
    }
    return list;
  }

  /** Used of the budget on this page in the window. */
  used(pageId: string, memberId: string, windowMs: number = REMOVAL_WINDOW_MS): number {
    if (windowMs > this.keepMs) this.keepMs = windowMs;
    const since = this.now() - windowMs;
    return this.recent(pageId, memberId).reduce((n, e) => (e.at > since ? n + e.cost : n), 0);
  }

  fits(pageId: string, memberId: string, cost: number, budget: EditBudget = DEFAULT_EDIT_BUDGET): boolean {
    return cost <= 0 || this.used(pageId, memberId, budget.windowMs) + cost <= budget.chars;
  }

  charge(pageId: string, memberId: string, cost: number, budget: EditBudget = DEFAULT_EDIT_BUDGET): void {
    if (cost <= 0) return;
    if (budget.windowMs > this.keepMs) this.keepMs = budget.windowMs;
    this.recent(pageId, memberId);
    let members = this.pages.get(pageId);
    if (!members) {
      members = new Map();
      this.pages.set(pageId, members);
    }
    const list = members.get(memberId) ?? [];
    list.push({ at: this.now(), cost });
    members.set(memberId, list);
    if (this.pages.size > 10_000) this.sweep();
  }

  /** Forgets whatever's out of the window everywhere. */
  sweep(): void {
    for (const [pageId, members] of [...this.pages]) for (const memberId of [...members.keys()]) this.recent(pageId, memberId);
  }
}

/** Every page's writers, kept for the pages that are open, and written before the update they come from is applied. */
export class Owners {
  private readonly pages = new Map<string, PageOwners>();

  constructor(private readonly db: Db) {}

  /** From disk, without keeping it: for a page nobody has open. */
  read(pageId: string): PageOwners {
    const o = new PageOwners();
    for (const r of this.db.all<{ client: number; member_id: string }>('SELECT client, member_id FROM page_clients WHERE page_id = ?', pageId)) {
      o.clients.set(Number(r.client), r.member_id);
    }
    for (const r of this.db.all<{ client: number; clock: number; len: number; member_id: string }>(
      'SELECT client, clock, len, member_id FROM page_credits WHERE page_id = ? ORDER BY client, clock',
      pageId,
    )) {
      o.addCredit(Number(r.client), Number(r.clock), Number(r.len), r.member_id);
    }
    return o;
  }

  of(pageId: string): PageOwners {
    let o = this.pages.get(pageId);
    if (!o) {
      o = this.read(pageId);
      this.pages.set(pageId, o);
    }
    return o;
  }

  /** Durable before Yjs applies the update, so nothing of a member's is ever on the page without its writer. */
  record(pageId: string, memberId: string, v: Verdict): void {
    if (!v.newClients.length && !v.credits.length) return;
    this.db.tx(() => {
      for (const client of v.newClients) this.db.run('INSERT OR IGNORE INTO page_clients (page_id, client, member_id) VALUES (?, ?, ?)', pageId, client, memberId);
      for (const c of v.credits) this.db.run('INSERT OR REPLACE INTO page_credits (page_id, client, clock, len, member_id) VALUES (?, ?, ?, ?, ?)', pageId, c.client, c.clock, c.len, c.member);
    });
    const o = this.of(pageId);
    for (const client of v.newClients) if (!o.clients.has(client)) o.clients.set(client, memberId);
    for (const c of v.credits) o.addCredit(c.client, c.clock, c.len, c.member);
  }

  forget(pageId: string): void {
    this.pages.delete(pageId);
  }
}
