// A tab's simple page, kept up to date from the desk (design 7.4, "Progressive delivery"; `deskd` API.md section 14). Pure.
//
// `browser.minified.get` sends the whole MDoc; the topic then sends patches: from `base` to `rev`, remove `remove`
// blocks at `at`, insert `insert` there, and take `head`. Blocks are keyed by a hash of what they hold, so a block that
// didn't change keeps its parsed object and React skips it. A `group` or `fold` header gathers the `grouped` blocks
// after it.
import { blockRef, LIMITS, parseBlock, parseHead, type Block, type InnerBlock, type PageMeta, type Target } from './mdoc';

export interface KeyedBlock {
  /** Stable across patches: `r:` and the block's first node, else `h:` and its key, with `~n` for a repeat. */
  key: string;
  block: Block;
}

interface Parsed {
  block: Block | null;
  nodes: [string, string][];
}

export interface SimpleDoc {
  meta: PageMeta;
  blocks: KeyedBlock[];
  /** Every node the member can act on: its fingerprint and its block's key, which `act` sends back (T47-2). */
  nodes: Map<string, Target>;
  /** The wire's blocks as they came, in order, for the next patch's indexes. */
  raw: readonly unknown[];
  /** Parsed blocks by their wire key. */
  cache: Map<string, Parsed>;
}

/** A block's key on the wire: deskd's is 12 characters of a hash, with `~n` for a repeat. */
const KEY = /^[\w:.~-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const wireKey = (raw: unknown): string | null => (isObj(raw) && typeof raw['key'] === 'string' && KEY.test(raw['key']) ? raw['key'] : null);

const INNER: ReadonlySet<Block['t']> = new Set(['heading', 'para', 'byline', 'item', 'code', 'rule', 'figure', 'table', 'island', 'cards', 'comment']);
const isInner = (b: Block): b is InnerBlock => INNER.has(b.t);

/** A whole MDoc from `get`, or null when it can't be read. `prev` lends its parsed blocks. */
export function applyMDoc(prev: SimpleDoc | null, mdoc: unknown): SimpleDoc | null {
  if (!isObj(mdoc) || !Array.isArray(mdoc['blocks'])) return null;
  return build(mdoc, mdoc['blocks'], prev);
}

export interface WirePatch {
  base?: unknown;
  rev?: unknown;
  at?: unknown;
  remove?: unknown;
  insert?: unknown;
  head?: unknown;
}

/** `prev` with a topic's `patch` applied, or null when it doesn't apply to `prev`: then `get` it again, with `since`. */
export function applyPatch(prev: SimpleDoc | null, p: WirePatch): SimpleDoc | null {
  if (!prev || p.base !== prev.meta.rev || typeof p.rev !== 'number' || !Number.isSafeInteger(p.rev)) return null;
  const at = p.at;
  const remove = p.remove;
  if (typeof at !== 'number' || typeof remove !== 'number' || !Number.isInteger(at) || !Number.isInteger(remove)) return null;
  if (at < 0 || remove < 0 || at + remove > prev.raw.length || !Array.isArray(p.insert) || !isObj(p.head)) return null;
  const raw = [...prev.raw.slice(0, at), ...(p.insert as unknown[]), ...prev.raw.slice(at + remove)];
  // `head` is the whole head but its blocks (deskd's `MDoc.head()`), held to the schema with them.
  return build({ ...p.head, rev: p.rev, blocks: raw }, raw, prev);
}

function build(head: Record<string, unknown>, raw: readonly unknown[], prev: SimpleDoc | null): SimpleDoc | null {
  const nodes = new Map<string, Target>();
  const meta = parseHead(head, nodes);
  if (!meta) return null;
  const cache = new Map<string, Parsed>();
  const old = prev?.cache;
  const before = new Map<string, KeyedBlock>(prev ? prev.blocks.map((b) => [b.key, b]) : []);
  const blocks: KeyedBlock[] = [];
  const seen = new Map<string, number>();

  const parsed = (x: unknown, key: string): Parsed => {
    let p = cache.get(key) ?? old?.get(key);
    if (!p) p = parseBlock(x, key);
    cache.set(key, p);
    for (const [ref, fp] of p.nodes) nodes.set(ref, { fp, block: key });
    return p;
  };

  const push = (block: Block, key: string): void => {
    // By the element it acts on, else by its key (design 7.4): a field keeps its element through the page's echo.
    const ref = blockRef(block);
    const base = ref ? `r:${ref}` : `h:${key}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const k = n ? `${base}~${n}` : base;
    const was = before.get(k);
    blocks.push(was && sameBlock(was.block, block) ? was : { key: k, block });
  };

  const end = Math.min(raw.length, LIMITS.blocks);
  for (let i = 0; i < end; i += 1) {
    const x = raw[i];
    const key = wireKey(x);
    if (!key) continue;
    const { block } = parsed(x, key);
    if (!block) continue;
    if (block.t === 'group' || block.t === 'fold') {
      // A header: the `size` blocks after it that say `grouped` are its own.
      const size = isObj(x) ? Math.min(Math.max(0, Math.floor(Number(x['size']) || 0)), LIMITS.groupBlocks) : 0;
      const inner: InnerBlock[] = [];
      let j = i + 1;
      for (; j < end && j <= i + size; j += 1) {
        const y = raw[j];
        if (!isObj(y) || y['grouped'] !== true) break;
        const k = wireKey(y);
        const b = k ? parsed(y, k).block : null;
        if (b && isInner(b)) inner.push(b);
      }
      i = j - 1;
      if (inner.length || (block.t === 'fold' && block.kind === 'comments')) push({ ...block, blocks: inner }, key);
      continue;
    }
    push(block, key);
    // The real page stops here for this member: nothing after it shows (section 14's policy).
    if (block.t === 'paywall') break;
  }
  return { meta, blocks, nodes, raw, cache };
}

/** The same block as before: the same object, or a header over the same objects, so `memo` holds. */
function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if ((a.t === 'group' && b.t === 'group') || (a.t === 'fold' && b.t === 'fold')) {
    const ab = a.blocks;
    const bb = b.blocks;
    return a.name === b.name && ab.length === bb.length && ab.every((x, i) => x === bb[i]) && (a.t !== 'fold' || (b.t === 'fold' && a.meta === b.meta && a.lead === b.lead && a.kind === b.kind));
  }
  return false;
}

/** How many simple pages a tab keeps for Back, Forward and a switch back (ADR 0030: "the last 10 MDocs per tab"). */
export const HISTORY_PER_TAB = 10;

/**
 * Pages already seen in a tab, by URL, in memory only (security review T47-9): Back and Forward paint at once from here
 * while the real page catches up. Gone with the window, the session or a sign-out, and never written anywhere.
 */
export class PageHistory {
  private readonly tabs = new Map<string, Map<string, SimpleDoc>>();

  put(tabId: string, doc: SimpleDoc): void {
    const url = doc.meta.url;
    if (!url) return;
    let pages = this.tabs.get(tabId);
    if (!pages) {
      pages = new Map();
      this.tabs.set(tabId, pages);
    }
    pages.delete(url); // to the end, as the newest
    pages.set(url, doc);
    while (pages.size > HISTORY_PER_TAB) pages.delete(pages.keys().next().value as string);
  }

  get(tabId: string, url: string): SimpleDoc | null {
    return this.tabs.get(tabId)?.get(url) ?? null;
  }

  /** Tabs the desk no longer has. */
  keepOnly(tabIds: readonly string[]): void {
    for (const id of [...this.tabs.keys()]) if (!tabIds.includes(id)) this.tabs.delete(id);
  }

  clear(): void {
    this.tabs.clear();
  }
}

/** The URL a tab is on, for matching a page to it: without its fragment, which changes nothing the desk sends. */
export const pageKey = (url: string | null | undefined): string => (url ?? '').split('#')[0] ?? '';
