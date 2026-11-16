// An attachment's bytes, its preview or a raw message, from the desk over its own `bulk` channel (API.md §21,
// "Attachments"; §12's frames, as `files.read` sends a file): nothing of ours sees them. In Courier's lazy chunk only.
//
// - The listener is on before the call, since CHUNKs can overtake the reply that names their transfer; what comes early is
//   kept (up to 4 MiB) until the id is known.
// - Credit is given back only as the bytes are written, so a slow disk slows its own transfer.
// - The END's trailer (SHA-256 of every byte, then the size) must match what arrived and what the reply named, or the
//   bytes are thrown away: a broken transfer never becomes a file or a picture.
// - A press of Cancel, a closed preview, a dropped session or a minute with nothing arriving ends it on the desk too
//   (`courier.attachment.stop`), so its staged copy goes at once.
import type { BulkChannel, DeskLink } from '../../desk/deskLink';
import { CreditWindow, parseTrailer, trailerMatches } from '../../export/credit';
import { Sha256, toHex } from '../../export/sha256';
import { hubOf } from '../files/hub';

/** The most kept for one transfer before its id is known: its first credit window, and a little more. */
const EARLY_LIMIT = 1024 * 1024 + 64 * 1024;

/** A refusal shaped as the desk's (`code`, `details.reason`), which `toCourierError` reads like any other. */
const fault = (code: string, reason?: string): Error => Object.assign(new Error(`courier ${code}${reason ? ` ${reason}` : ''}`), { code, details: reason ? { reason } : {} });
export const STALL_MS = 60_000;

/** What the desk named about the bytes (its reply), read field by field. */
export interface TransferHead {
  transferId: number;
  size: number;
  sha256: string;
  reply: Record<string, unknown>;
}

export function readHead(v: unknown): TransferHead | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const id = o?.['transferId'];
  const size = o?.['size'];
  const sha = o?.['sha256'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || typeof size !== 'number' || !Number.isInteger(size) || size < 0) return null;
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return { transferId: id, size, sha256: sha, reply: o! };
}

/**
 * One transfer: asks the desk (`start`), then writes each piece in order through `write`, crediting as it goes, and checks the
 * whole against the trailer and the reply. Resolves with the reply once every byte is written and checked.
 *
 * @throws the desk's shape of refusal: `offline` (no session, or it went), `cancelled`, `stalled`, `broken` (a gap, a bad trailer, or bytes
 *     other than the desk named), or the desk's own refusal from `start`
 */
export async function readTransfer(
  link: DeskLink,
  start: () => Promise<unknown>,
  stop: (transferId: number) => Promise<unknown>,
  write: (bytes: Uint8Array) => Promise<void>,
  opts: { signal?: AbortSignal; stallMs?: number; onProgress?(done: number, size: number): void } = {},
): Promise<TransferHead> {
  const bulk: BulkChannel | null = link.bulk();
  if (!bulk) throw fault('offline');
  const stallMs = opts.stallMs ?? STALL_MS;
  // Before the reply names our transfer, pieces are kept per transfer id: only one first seen at seq 0 can be ours (we listen
  // before asking), and ours can't send past the first credit window before we credit it, so another transfer's pieces
  // (one already running) are dropped rather than crowding ours out (Security's CF-I3).
  const early = new Map<number, { seq: number; end: boolean; payload: Uint8Array }[]>();
  const earlyBytes = new Map<number, number>();
  const notOurs = new Set<number>();
  let head: TransferHead | null = null;
  let seq = 0;
  let received = 0;
  let written = 0;
  const sha = new Sha256();
  let credit: CreditWindow | null = null;
  let chain: Promise<void> = Promise.resolve();
  let settle: { resolve(h: TransferHead): void; reject(e: unknown): void } | null = null;
  let failed: unknown = null;
  let finished = false;
  let timer = 0;

  const fail = (e: unknown): void => {
    if (finished) return;
    finished = true;
    failed = e;
    window.clearTimeout(timer);
    if (head) void stop(head.transferId).catch(() => undefined);
    settle?.reject(e);
  };
  const arm = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fail(fault('stalled')), stallMs);
  };
  const onChunk = (id: number, s: number, end: boolean, payload: Uint8Array): void => {
    if (finished) return;
    if (!head) {
      if (notOurs.has(id)) return;
      const list = early.get(id) ?? [];
      const bytes = (earlyBytes.get(id) ?? 0) + payload.length;
      if ((list.length === 0 && s !== 0) || bytes > EARLY_LIMIT) {
        notOurs.add(id);
        early.delete(id);
        earlyBytes.delete(id);
        return;
      }
      list.push({ seq: s, end, payload: payload.slice() });
      early.set(id, list);
      earlyBytes.set(id, bytes);
      return;
    }
    if (id !== head.transferId) return;
    if (s !== seq) return fail(fault('broken', 'seq'));
    seq += 1;
    arm();
    if (end) {
      const trailer = parseTrailer(payload);
      const h = head;
      chain = chain.then(() => {
        if (finished) return;
        const digest = sha.digest();
        // Every byte, the same hash end to end, and the very file the desk's reply named: or nothing is kept.
        if (!trailerMatches(trailer, digest, received) || received !== h.size || toHex(digest) !== h.sha256) {
          fail(fault('broken', 'trailer'));
          return;
        }
        finished = true;
        window.clearTimeout(timer);
        settle?.resolve(h);
      });
      return;
    }
    if (!payload.length) return;
    const bytes = payload.slice();
    received += bytes.length;
    if (received > head.size) return fail(fault('broken', 'size'));
    sha.update(bytes);
    const h = head;
    chain = chain
      .then(async () => {
        if (finished) return;
        await write(bytes);
        written += bytes.length;
        opts.onProgress?.(written, h.size);
        const more = credit!.writtenTo(written);
        if (more) bulk.credit(h.transferId, more);
      })
      .catch((e: unknown) => fail(e));
  };

  const off = hubOf(bulk).listenChunks(onChunk);
  const offStatus = link.onStatus((st) => {
    if (st !== 'open' || link.bulk() !== bulk) fail(fault('offline'));
  });
  const onAbort = (): void => fail(fault('cancelled'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (opts.signal?.aborted) throw fault('cancelled');
    const reply = await start();
    const h = readHead(reply);
    if (!h) throw fault('internal');
    if (failed) {
      void stop(h.transferId).catch(() => undefined);
      throw failed;
    }
    if (link.bulk() !== bulk) {
      void stop(h.transferId).catch(() => undefined);
      throw fault('offline');
    }
    head = h;
    credit = new CreditWindow(0);
    const done = new Promise<TransferHead>((resolve, reject) => (settle = { resolve, reject }));
    arm();
    const mine = early.get(h.transferId) ?? [];
    early.clear();
    for (const c of mine) onChunk(h.transferId, c.seq, c.end, c.payload);
    return await done;
  } finally {
    finished = true;
    window.clearTimeout(timer);
    off();
    offStatus();
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
