// The member's notifications (ma-platform ADR 0125, contract notifications.md 0.3.72): one list per member, read here
// with the office's own token through the shared authorizer. The bell in the top bar (`chrome/Bell.tsx`) is the only
// reader; the words on the panel (the rows, the time, the count) come from the vendored `packages/bell-kit`, not here.
// The count is asked at most once a minute while the tab is visible, with the ETag, and again when the tab comes back;
// nothing is asked while it's hidden. A `503 notifications_paused` (the kill switch) or a 404 hides the bell, and then
// the count is asked every 10 minutes.
import { create } from 'zustand';
import type { BellItem } from '../../../packages/bell-kit/model.mjs';
import { api, ApiError, type ApiResult } from './api';

/** An item as the contract sends it (§3): the kit's row model (`packages/bell-kit`) with the title and the stamps always there. */
export interface NotificationItem extends BellItem {
  title: string;
  critical?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationList {
  items: NotificationItem[];
  /** Every unread item the member has, not only those returned. */
  unread: number;
  seenAt?: string | null;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TIMEOUT_MS = 15_000;

/** `GET /v1/me/notifications?limit=`, newest change first (contract §2). */
export const getNotifications = (limit = 30) => api<NotificationList>(`/v1/me/notifications?limit=${limit}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
/** The poll. With the last `ETag`, a `304` means the count hasn't changed. */
export const getUnread = (etag: string | null) => api<{ unread: number }>('/v1/me/notifications/unread', { etag, signal: AbortSignal.timeout(TIMEOUT_MS) });
/**
 * Marks items read, by id or all of them. Idempotent. `keepalive`, since a click on an item leaves this page while
 * the request is on its way.
 */
export const postRead = (body: { ids: string[] } | { all: true }, keepalive = false) =>
  api<{ unread: number }>('/v1/me/notifications/read', { method: 'POST', keepalive, headers: JSON_HEADERS, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
/** The list was opened. It marks nothing read. */
export const postSeen = () => api<{ seenAt: string }>('/v1/me/notifications/seen', { method: 'POST', headers: JSON_HEADERS, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS) });

/**
 * The kill switch is off (`503 notifications_paused`: contract, "Kill switch"), or the routes aren't there yet (`404`, an office
 * released ahead of the platform's service): either way the bell goes, and comes back on the next poll that answers.
 */
export const isPaused = (e: unknown): boolean =>
  e instanceof ApiError && ((e.status === 503 && e.code === 'notifications_paused') || e.status === 404);

const MINUTE = 60_000;

// ------------------------------------------------------------------ the count

export interface NotificationsState {
  /** Unread items, or null until the first answer (and after the member leaves). */
  unread: number | null;
  /** The last `ETag` on the count, sent back as `If-None-Match`. */
  etag: string | null;
  /** The kill switch is off: the bell hides, and the count keeps being asked, so it comes back when the switch does. */
  paused: boolean;
}

export const useNotifications = create<NotificationsState>(() => ({ unread: null, etag: null, paused: false }));

export type UnreadAnswer = { kind: 'count'; unread: number; etag: string | null } | { kind: 'same' } | { kind: 'paused' } | { kind: 'failed' };

/** One ask for the count. Never throws: offline or a 5xx is `failed`, and nothing changes. */
export async function askUnread(etag: string | null, call: (etag: string | null) => Promise<ApiResult<{ unread: number }>> = getUnread): Promise<UnreadAnswer> {
  try {
    const r = await call(etag);
    if (r.status === 304) return { kind: 'same' };
    const unread = r.data?.unread;
    if (typeof unread !== 'number' || !Number.isFinite(unread)) return { kind: 'failed' };
    return { kind: 'count', unread: Math.max(0, Math.floor(unread)), etag: r.etag };
  } catch (e) {
    return isPaused(e) ? { kind: 'paused' } : { kind: 'failed' };
  }
}

/** What an answer changes. A `304` keeps the count it has; a failure changes nothing. */
export function takeUnread(state: NotificationsState, answer: UnreadAnswer): NotificationsState {
  switch (answer.kind) {
    case 'count':
      return { unread: answer.unread, etag: answer.etag, paused: false };
    case 'same':
      return state.paused ? { ...state, paused: false } : state;
    case 'paused':
      return state.paused ? state : { ...state, paused: true };
    case 'failed':
      return state;
  }
}

/** The count, heard some other way (the list, a read): the ETag no longer stands for it. */
export function setUnread(unread: number): void {
  useNotifications.setState({ unread: Math.max(0, unread), etag: null, paused: false });
}

/** How often a visible tab asks (contract §2: at most once a minute). */
export const UNREAD_POLL_MS = 60_000;
/** While the service is absent (`404`) or paused, the count is asked about every 10 minutes; a real answer brings back the minute. */
export const UNREAD_SLOW_POLL_MS = 10 * 60_000;
/** A tab coming back asks at once, unless it asked this recently. */
const FOCUS_MIN_GAP_MS = 5_000;

export interface UnreadWatch {
  ask: (etag: string | null) => Promise<UnreadAnswer>;
  everyMs?: number;
  slowMs?: number;
  now?: () => number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  store?: typeof useNotifications;
}

/**
 * Starts the poll: at once, then every minute (every 10 while the service is absent or paused) while `document.visibilityState` is `visible`, with the last ETag.
 * Hidden, nothing is asked; shown again, or focused, it asks now. Returns a stop. The caller mounts it only while the
 * member is signed in (`Bell.tsx`).
 */
export function watchUnread(w: UnreadWatch): () => void {
  const fast = w.everyMs ?? UNREAD_POLL_MS;
  const slow = w.slowMs ?? UNREAD_SLOW_POLL_MS;
  let every = fast;
  const now = w.now ?? (() => Date.now());
  const doc = w.doc ?? document;
  const win = w.win ?? window;
  const store = w.store ?? useNotifications;
  let lastAsked = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let asking = false;
  let stopped = false;

  const visible = (): boolean => doc.visibilityState === 'visible';

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped || asking || !visible()) return;
    timer = setTimeout(() => void ask(), Math.max(0, lastAsked + every - now()));
  };

  const ask = async (): Promise<void> => {
    timer = null;
    if (stopped || asking || !visible()) return;
    asking = true;
    lastAsked = now();
    const answer = await w.ask(store.getState().etag);
    asking = false;
    if (stopped) return;
    const before = store.getState();
    const after = takeUnread(before, answer);
    if (after !== before) store.setState(after);
    // Absent or paused: slow down. A count or a 304 is a real answer and brings the minute back; a failure keeps the pace.
    if (answer.kind !== 'failed') every = after.paused ? slow : fast;
    schedule();
  };

  const onVisibility = (): void => {
    if (visible() && now() - lastAsked >= FOCUS_MIN_GAP_MS) lastAsked = -Infinity;
    schedule();
  };
  const onFocus = (): void => {
    if (now() - lastAsked >= FOCUS_MIN_GAP_MS) lastAsked = -Infinity;
    schedule();
  };

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('focus', onFocus);
  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('focus', onFocus);
  };
}

/** For the bell: the real document, window and API. `npm run dev` has no API, so it reads the fixture below. */
export const startUnreadWatch = (): (() => void) => watchUnread({ ask: import.meta.env.DEV ? () => Promise.resolve(devAnswer()) : (etag) => askUnread(etag) });

/** The list for the panel. Never throws: `null` means it couldn't be read. */
export async function loadNotifications(limit = 30): Promise<NotificationList | null> {
  if (import.meta.env.DEV) return devList();
  try {
    return (await getNotifications(limit)).data;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the dev server's fixture (never built for production)

const DEV_ITEMS: NotificationItem[] = [
  { id: 'nt-dev-1', type: 'forums.thread', title: 'New reply in Community Forums', body: 'Quiet mornings', link: 'https://forums.example/t/1', actor: { name: 'Ada' }, count: 3, createdAt: '', updatedAt: '', readAt: null },
  { id: 'nt-dev-2', type: 'forums.reply', title: 'New reply to your thread', body: 'Low-noise notifications', link: 'https://forums.example/t/2', actor: { name: 'lio' }, count: 3, createdAt: '', updatedAt: '', readAt: null },
  { id: 'nt-dev-3', type: 'billing.card_expiring', title: 'Your card expires this month', body: 'Update it before the next renewal.', link: 'https://platform.example/billing', critical: true, createdAt: '', updatedAt: '', readAt: null },
  { id: 'nt-dev-4', type: 'desk.storage', title: 'Work desk is low on space', body: '2 GB left of 20 GB.', link: 'https://office.example/', critical: true, createdAt: '', updatedAt: '', readAt: '2026-11-09T12:00:00Z' },
];
const devStamp = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * MINUTE).toISOString();
const devList = (): NotificationList => {
  const items = DEV_ITEMS.map((it, i) => ({ ...it, createdAt: devStamp(200 * (i + 1)), updatedAt: devStamp([4, 30, 95, 3_000][i] ?? 0) }));
  return { items, unread: items.filter((it) => !it.readAt).length, seenAt: null };
};
const devAnswer = (): UnreadAnswer => ({ kind: 'count', unread: devList().unread, etag: null });
