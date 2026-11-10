// What the simple view needs from a desk, as one typed interface, and `linkSource`, that interface over a desk's link on
// `deskd`'s wire: API.md section 14 (`ma-desk` `sub/minified-stage-a` `8161db0`), and the Desk Engineer's answers to
// this branch's ten assumptions (2026-11-07). Every method name and field of the wire is here and in `mdoc.ts` only.
import { DeskNotConnected, type DeskLink } from '../desk/deskLink';
import { mutate } from '../browser/mutate';
import { fallbackReason, type FallbackReason, type SiteChoice } from './decide';
import type { WirePatch } from './docStore';
import type { Target } from './mdoc';
import type { SiteChoiceStore } from './siteMemory';

/** One thing the member did, on a node of the page (`act`'s `action` and `value`). */
export type SimpleAction =
  | { act: 'click'; ref: string }
  /** The field's whole value, at most once a frame while typing (design 7.3, "Typing"). */
  | { act: 'fill'; ref: string; value: string }
  /** By index, with the option's label as the page gave it, which the desk checks. */
  | { act: 'select'; ref: string; index: number; label: string }
  | { act: 'check'; ref: string; checked: boolean }
  | { act: 'press'; ref: string; key: 'Enter' }
  /**
   * The real page scrolled to a node: `start` puts it at the top, before the real page shows ("switching keeps your
   * place"); near the end of a long list it asks the page for more (design 7.3, two viewports early).
   */
  | { act: 'scroll'; ref: string; to: 'start' | 'center' };

/**
 * An island's own controls drive the real media element on the desk, never clicks by coordinates (the Designer's spec,
 * section 6): `act media` on the island's id. `track` is the captions track's index, -1 for off.
 */
export type MediaOp = { op: 'play' } | { op: 'pause' } | { op: 'seek'; time: number } | { op: 'volume'; volume: number; muted: boolean } | { op: 'captions'; track: number };

/** The element's state after an op, as the desk read it. Any field may be missing. */
export interface MediaState {
  time?: number;
  duration?: number;
  playing?: boolean;
  /** The end of the buffered stretch the playhead is in, in seconds. */
  buffered?: number;
  volume?: number;
  muted?: boolean;
  captions?: boolean;
}

/** `act`'s answer: done, or not, and why (section 14's table: `missed`, `navigated`, `dialog`, `sensitive`...). */
export type ActResult = { done: true } | { done: false; reason: string };

/** An island's box now (`browser.minified.island`): `live: false` says why, such as `covered` or `wall`. */
export interface IslandBox {
  live: boolean;
  reason: string | null;
  /** The media element's own rectangle in the viewport, in CSS pixels, and the device pixel ratio: what the crop is. */
  rect?: { width: number; height: number } | null;
  dpr?: number;
}

/** What the desk says of the tab being watched. */
export type SourceMessage =
  /** The whole document, from `get`. */
  | { kind: 'doc'; mdoc: unknown }
  /** A change in place, from the topic: apply it if it's from the `rev` held, else ask `get` again. */
  | { kind: 'patch'; patch: WirePatch }
  /** The real page shows, and why. */
  | { kind: 'fallback'; reason: FallbackReason }
  /** Nothing yet, as for a page still loading: keep what shows. */
  | { kind: 'pending' };

export interface TabWatch {
  /** The `rev` of the document held for this tab, or null: `get` sends `since`, and a patch must start from it. */
  rev(): number | null;
  message(m: SourceMessage): void;
  /** The desk has no simple view: an older `deskd` (`not_found`), or its switch off (`unavailable`, `disabled`). Final. */
  refused(code: string): void;
}

/** Whether the desk serves the simple view at all: `no` is a `deskd` before section 14, or its switch off. */
export type Probe = 'yes' | 'no' | 'unknown';

export interface SimpleSource {
  /**
   * Asked once as a Browser window opens, beside the stream's start and never ahead of it: a desk of today shows its real
   * page exactly as it always did. Without it (tests), the view starts as if the desk said yes.
   */
  probe?(): Promise<Probe>;
  /** One tab's page: its document now, then its changes, until the returned function is called. */
  watch(tabId: string, w: TabWatch): () => void;
  /** Look at the tab's page again, whatever the site's memory says: "Try again", or the member choosing Simplified. */
  retry(tabId: string): void;
  /** Ask for the tab's whole document again: a patch didn't fit what's held. */
  refresh(tabId: string): void;
  /** One thing the member did, on the real page. Rejects only on an error (refused, stale, unreachable). */
  act(tabId: string, rev: number, target: Target & { node: string }, action: SimpleAction): Promise<ActResult>;
  /** Play, pause, seek, the volume or captions of an island's media element. Rejects on a refusal. */
  media(tabId: string, rev: number, target: Target & { node: string }, op: MediaOp): Promise<MediaState>;
  /** Where an island is on the real page now, and whether it can stream. Cropping the stream to it is the System Engineer's. */
  island(tabId: string, islandId: string): Promise<IslandBox>;
  /** An image the tab has already loaded, as a `blob:` URL made here, or null to leave its frame empty (T47-5). */
  image(tabId: string, imageId: string): Promise<string | null>;
  /** ADR 0073's per-site switch for ads and trackers (section 14's `browser.adblock.site.set`). Rejects as the desk does. */
  blocking(host: string, on: boolean): Promise<void>;
  sites: SiteChoiceStore;
}

const WIRE_VIEW: Record<SiteChoice, 'simplified' | 'stream'> = { simple: 'simplified', full: 'stream' };
/** What `image` may make a picture of: never SVG (section 14), never anything else. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** 700 KiB, `deskd`'s own cap, in base64. */
const IMAGE_MAX = Math.ceil((716_800 * 4) / 3) + 4;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const codeOf = (err: unknown): string => (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : '');
const reasonOf = (err: unknown): string => {
  const d = err && typeof err === 'object' ? (err as { details?: unknown }).details : undefined;
  return d && typeof d === 'object' && typeof (d as { reason?: unknown }).reason === 'string' ? (d as { reason: string }).reason : '';
};

/** `deskd` has no simple view: a method it doesn't know (`not_found` with no reason), its switch off, or not this member's. */
function noView(err: unknown): boolean {
  const code = codeOf(err);
  const reason = reasonOf(err);
  return (code === 'not_found' && reason !== 'tab') || (code === 'unavailable' && reason === 'disabled') || code === 'forbidden';
}

export function mediaState(r: Record<string, unknown>): MediaState {
  const paused = bool(r['paused']);
  return { time: num(r['time']), duration: num(r['duration']), playing: paused === undefined ? undefined : !paused, buffered: num(r['buffered']), volume: num(r['volume']), muted: bool(r['muted']), captions: bool(r['captions']) };
}

/** The `act` params for one action: what the member saw (`node`, `fp`, `block`, `rev`), and what they did. */
function actParams(tabId: string, rev: number, t: Target & { node: string }, a: SimpleAction): Record<string, unknown> {
  const base = { tabId, nodeId: t.node, fp: t.fp, block: t.block, rev };
  switch (a.act) {
    case 'click':
      return { ...base, action: 'click' };
    case 'fill':
      return { ...base, action: 'fill', value: a.value };
    case 'select':
      return { ...base, action: 'select', value: { index: a.index, label: a.label } };
    case 'check':
      return { ...base, action: 'check', value: a.checked };
    case 'press':
      return { ...base, action: 'press', value: a.key };
    case 'scroll':
      return { ...base, action: 'scroll', value: a.to };
  }
}

function mediaValue(op: MediaOp): Record<string, unknown> {
  switch (op.op) {
    case 'play':
    case 'pause':
      return { verb: op.op };
    case 'seek':
      return { verb: 'seek', time: op.time };
    case 'volume':
      return { verb: 'volume', volume: op.volume, muted: op.muted };
    case 'captions':
      return { verb: 'track', track: op.track };
  }
}

/** base64 to a `blob:` URL of its own type, or null. */
function blobUrl(mime: unknown, data: unknown): string | null {
  if (typeof mime !== 'string' || !IMAGE_TYPES.has(mime) || typeof data !== 'string' || !data || data.length > IMAGE_MAX || !BASE64.test(data)) return null;
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
}

interface Watcher {
  w: TabWatch;
  asking: boolean;
  again: boolean;
  retry: boolean;
  gone: boolean;
}

export function linkSource(link: DeskLink): SimpleSource {
  const watchers = new Map<string, Watcher>();

  /** `get`, one at a time per tab; a call while one is out asks once more after it. */
  const fetch = (tabId: string, x: Watcher, retry = false): void => {
    if (retry) x.retry = true;
    if (x.asking) {
      x.again = true;
      return;
    }
    x.asking = true;
    const since = x.retry ? null : x.w.rev();
    const params: Record<string, unknown> = { tabId, ...(since !== null ? { since } : {}), ...(x.retry ? { retry: true } : {}) };
    x.retry = false;
    link.call('browser.minified.get', params).then(
      (r) => {
        if (x.gone) return;
        if (r.view === 'simplified' && r.unchanged !== true && r.mdoc !== undefined) x.w.message({ kind: 'doc', mdoc: r.mdoc });
        else if (r.view === 'stream') x.w.message({ kind: 'fallback', reason: fallbackReason(r.fallback?.reason, r.fallback?.cause) });
        else if (r.view === 'pending') x.w.message({ kind: 'pending' });
      },
      (err: unknown) => {
        if (x.gone) return;
        if (noView(err)) x.w.refused(codeOf(err) || 'unavailable');
        // Anything else (Chromium starting, the session lost, a tab just closed) waits for the topic or the next look.
      },
    ).finally(() => {
      x.asking = false;
      if (x.again && !x.gone) {
        x.again = false;
        fetch(tabId, x);
      }
    });
  };

  return {
    async probe() {
      try {
        // The smallest question section 14 has that needs no tab and no Chromium: the site memory's answer for a name
        // reserved for examples (RFC 2606), which is never used, never set, and names nothing the member visited.
        await link.call('browser.minified.site.get', { host: 'example.com' });
        return 'yes';
      } catch (err) {
        return noView(err) ? 'no' : 'unknown';
      }
    },
    watch(tabId, w) {
      const x: Watcher = { w, asking: false, again: false, retry: false, gone: false };
      watchers.set(tabId, x);
      // The document now, at once; then the topic says when it changes.
      fetch(tabId, x);
      const off = link.subscribe(
        `browser.minified:${tabId}`,
        (e) => {
          if (x.gone || e.tabId !== tabId) return;
          if (e.type === 'patch') {
            if (w.rev() === e.base) w.message({ kind: 'patch', patch: e });
            else fetch(tabId, x);
            return;
          }
          if (e.type !== 'snapshot' && e.type !== 'changed') return;
          if (e.view === 'stream') w.message({ kind: 'fallback', reason: fallbackReason(e.fallback?.reason, e.fallback?.cause) });
          else if (e.view === 'pending') w.message({ kind: 'pending' });
          // `closed`: the tab is gone, which the tab list says too.
          else if (e.view === 'simplified' && e.rev !== w.rev()) fetch(tabId, x);
        },
        (code) => {
          if (!x.gone) w.refused(code);
        },
      );
      return () => {
        x.gone = true;
        if (watchers.get(tabId) === x) watchers.delete(tabId);
        off();
      };
    },
    retry(tabId) {
      const x = watchers.get(tabId);
      if (x) fetch(tabId, x, true);
    },
    refresh(tabId) {
      const x = watchers.get(tabId);
      if (x) fetch(tabId, x);
    },
    async act(tabId, rev, target, action) {
      const r = await mutate((idem) => link.call('browser.minified.act', actParams(tabId, rev, target, action), { idem }));
      return r.done === true ? { done: true } : { done: false, reason: typeof r.reason === 'string' ? r.reason : 'unknown' };
    },
    async media(tabId, rev, target, op) {
      const r = await mutate((idem) => link.call('browser.minified.act', { tabId, nodeId: target.node, fp: target.fp, block: target.block, rev, action: 'media', value: mediaValue(op) }, { idem }));
      if (r.done !== true) throw Object.assign(new Error('refused'), { code: 'refused', details: { reason: r.reason } });
      return mediaState(r as Record<string, unknown>);
    },
    async island(tabId, islandId) {
      const r = await link.call('browser.minified.island', { tabId, islandId });
      const rect = r.rect && typeof r.rect === 'object' ? (r.rect as Record<string, unknown>) : null;
      const width = num(rect?.['width']);
      const height = num(rect?.['height']);
      return {
        live: r.live === true,
        reason: typeof r.reason === 'string' ? r.reason : null,
        rect: width && height && width > 0 && height > 0 ? { width, height } : null,
        dpr: num(r.dpr) ?? 1,
      };
    },
    async image(tabId, imageId) {
      try {
        const r = await link.call('browser.minified.image', { tabId, imageId });
        return blobUrl(r.mime, r.data);
      } catch (err) {
        if (err instanceof DeskNotConnected) return null;
        return null;
      }
    },
    async blocking(host, on) {
      await mutate((idem) => link.call('browser.adblock.site.set', { host, on }, { idem }));
    },
    sites: {
      async get(host) {
        const r = await link.call('browser.minified.site.get', { host });
        // `host` in the reply is the site as the desk keys it, its registrable domain (section 14).
        return { choice: r.view === 'simplified' ? 'simple' : r.view === 'stream' ? 'full' : null, domain: typeof r.host === 'string' ? r.host : null };
      },
      async set(host, choice: SiteChoice | null) {
        // Not a mutation in section 14's table: no `idem`.
        await link.call('browser.minified.site.set', { host, view: choice ? WIRE_VIEW[choice] : null });
      },
    },
  };
}
