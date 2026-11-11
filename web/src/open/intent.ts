// Send to my desk (#9, S-141): a link that came to the office to open on one of the member's desks. This file is the
// whole of it in the first load: reading `/open#u=…` (the iOS Shortcut and the bookmarklet) and `/open?u=&t=&n=` (the
// installed office's share target, once Platform's manifest has one), the link a pasted address brings, and the link that
// waits in this tab's sessionStorage across a sign-in. The sheet, the sending and the notice are their own chunk
// (`OpenLayer.tsx`), fetched only once a link has come.
//
// Privacy: the link leaves the address bar at once (`history.replaceState` to `/`), so it isn't in the history or any
// sign-in redirect's `return`. It's held in memory, or for a sign-in trip in this tab's sessionStorage, read once and
// dropped after 10 minutes. Never in localStorage, and never logged.
import { create } from 'zustand';
import type { ClientConfig } from '../platform/clientConfig';

/** What came in: an http(s) link, or something else, whose text the sheet shows as it came. */
export type Incoming = { kind: 'link'; url: string } | { kind: 'none'; text: string };

export const OPEN_PATH = /^\/open\/?$/;
export const PENDING_KEY = 'ma-open-pending';
/** A link kept for a sign-in trip is dropped after this. */
export const PENDING_MS = 10 * 60_000;
/** The most of what came in that's ever held or shown. */
const MAX_TEXT = 8192;

/** client-config's `browserLinks: { enabled: false }` turns off the hand-off, `/open`, paste and the download action. Absent is on. */
export const linksOn = (cfg: ClientConfig | null | undefined): boolean => cfg?.browserLinks?.enabled !== false;

/** An absolute http or https address with a host, as `URL` reads it, or null. */
export function webLink(text: unknown): string | null {
  if (typeof text !== 'string' || !text || text.length > MAX_TEXT) return null;
  try {
    const u = new URL(text);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' ? u.href : null;
  } catch {
    return null;
  }
}

/** The first http(s) address in some text, as Android's share sheet often puts the link in its words. */
export function firstWebLink(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    // A sentence's own full stop or bracket after the link isn't part of it.
    const link = webLink(m[0].replace(/[.,;:!?)\]}'’]+$/, ''));
    if (link) return link;
  }
  return null;
}

/** A paste on the office counts only when the whole text, trimmed, is one http(s) address. */
export function pastedLink(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return /\s/.test(t) ? null : webLink(t);
}

/**
 * `#u=` is everything after it, as the Shortcut and the bookmarklet add the page's address as it is: its own `&` and `+`
 * belong to it. Encoded whole (`https%3A%2F%2F…`), it's decoded once.
 */
function hashLink(hash: string): string | null {
  if (!hash.startsWith('#u=')) return null;
  const raw = hash.slice(3);
  if (!/^https?%3A/i.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * What an `/open` address brings: `#u=` first, then `?u=`, then the first http(s) address in `?t=`, then in `?n=`. Null when
 * it isn't `/open`, or nothing came at all. Pure.
 */
export function parseOpenIntent(href: string): Incoming | null {
  let at: URL;
  try {
    at = new URL(href);
  } catch {
    return null;
  }
  if (!OPEN_PATH.test(at.pathname)) return null;
  const q = at.searchParams;
  const u = hashLink(at.hash) ?? q.get('u');
  const t = q.get('t');
  const n = q.get('n');
  const link = webLink(u?.trim()) ?? firstWebLink(t) ?? firstWebLink(n);
  if (link) return { kind: 'link', url: link };
  const text = [u, t, n].find((s) => typeof s === 'string' && s.trim() !== '');
  return text ? { kind: 'none', text: text.trim().slice(0, MAX_TEXT) } : null;
}

interface OpenState {
  /** What the sheet shows now, or null. */
  incoming: Incoming | null;
  /** Something was sent from this page: the chunk with its notices is fetched and stays. */
  sending: boolean;
}

export const useOpen = create<OpenState>(() => ({ incoming: null, sending: false }));

export const showIncoming = (incoming: Incoming | null): void => useOpen.setState({ incoming });

/** This page's `/open` address, read once as the app loads, before anything else reads the location. */
let fromAddress: Incoming | null = null;

/** Reads `/open` and takes the link out of the address bar at once. Returns what came. */
export function takeOpenFromLocation(): Incoming | null {
  const came = parseOpenIntent(window.location.href);
  if (!OPEN_PATH.test(window.location.pathname)) return null;
  // A test or dev page keeps its own switches (`?fixture=one`); production keeps nothing of the address.
  let rest = '';
  if (import.meta.env.MODE !== 'production') {
    const q = new URLSearchParams(window.location.search);
    for (const k of ['u', 't', 'n']) q.delete(k);
    rest = q.size ? `?${q.toString()}` : '';
  }
  try {
    window.history.replaceState(null, '', `/${rest}`);
  } catch {
    // An address that can't be replaced keeps the link there; it still never goes in a sign-in's return.
  }
  fromAddress = came;
  showIncoming(came);
  return came;
}

/** The link from the address, while it's still waiting: the signed-out card shows it. */
export const linkFromAddress = (): string | null => (fromAddress?.kind === 'link' ? fromAddress.url : null);

/** For a sign-in trip: the link waits in this tab's sessionStorage, with when it came. */
export function keepPending(url: string, now: number = Date.now()): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ url, at: now }));
  } catch {
    // Storage refused: after sign-in there's simply no sheet.
  }
}

export function dropPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // nothing kept
  }
}

/** Read once: the waiting link, if it's under 10 minutes old and still a web link. It's removed either way. */
export function takePending(now: number = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
  dropPending();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { url?: unknown; at?: unknown };
    const at = typeof v.at === 'number' ? v.at : NaN;
    if (!(now - at >= 0 && now - at < PENDING_MS)) return null;
    return webLink(v.url);
  } catch {
    return null;
  }
}

/** The sheet closed, or what it held went to a desk: nothing waits any more, in memory or in this tab. */
export function closeIncoming(): void {
  fromAddress = null;
  dropPending();
  showIncoming(null);
}
