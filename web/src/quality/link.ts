// Stream quality on one session's `keys` channel (ADR 0039, docs/interfaces/stream-quality.md sections 2 and 3). The
// player's side, kept here so `peer.ts` only wires it: send the Browser's level on that desk when `keys` opens and
// whenever it changes, and keep the desk's latest reply per desk for the menu. `desk-rtc` keeps a session's ask and counts it only
// while that session views, so this needn't know whether the Browser is showing.
import { useSyncExternalStore } from 'react';
import { decodeQualityReply, encodeQuality, type Level, type QualityReply } from './levels';
import { levelFor, subscribe } from './store';

/** The desk's one stream, stream 0, carries the Browser. Another streaming app gets its own stream id first. */
const STREAM_APP = 'browser';

/**
 * Sends this desk's level now and on every change of it, until the returned function is called. `send` stamps the
 * session's `seq`. A level chosen on another desk changes nothing here.
 */
export function attachQuality(deskId: string, send: (bytes: Uint8Array<ArrayBuffer>) => void): () => void {
  let sent: Level | null = null;
  const push = (): void => {
    const level = levelFor(STREAM_APP, deskId);
    if (level === sent) return;
    sent = level;
    send(encodeQuality(level));
  };
  push();
  return subscribe(push);
}

const replies = new Map<string, QualityReply>();
const listeners = new Set<() => void>();

/** A message from `keys` that isn't a `CURSOR`. False if it isn't a `QUALITY` reply either. */
export function deskQualityReply(deskId: string, bytes: Uint8Array): boolean {
  const reply = decodeQualityReply(bytes);
  if (!reply) return false;
  const was = replies.get(deskId);
  if (was && was.level === reply.level && was.limit === reply.limit && was.heldByLimit === reply.heldByLimit && was.raisedByOther === reply.raisedByOther) return true;
  replies.set(deskId, reply);
  for (const fn of listeners) fn();
  return true;
}

const listen = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The desk's last word on the level in effect, or null before any. */
export function useDeskQuality(deskId: string | undefined): QualityReply | null {
  return useSyncExternalStore(listen, () => (deskId ? (replies.get(deskId) ?? null) : null));
}

/** For tests. */
export function resetDeskQuality(): void {
  replies.clear();
}
