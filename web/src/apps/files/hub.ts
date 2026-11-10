// `bulk` has one `onChunk` and one `onCredit` per session (the export page used the first alone); the Files app has several
// transfers at once, so this fans each out to whoever listens, by transfer id. One hub per `bulk`, made the first time it is asked.
import type { BulkChannel, CreditMessage } from '../../desk/deskLink';

type ChunkFn = (id: number, seq: number, end: boolean, payload: Uint8Array) => void;
type CreditFn = (id: number, msg: CreditMessage) => void;

export interface BulkHub {
  listenChunks(fn: ChunkFn): () => void;
  listenCredits(fn: CreditFn): () => void;
}

const hubs = new WeakMap<BulkChannel, BulkHub>();

export function hubOf(bulk: BulkChannel): BulkHub {
  let hub = hubs.get(bulk);
  if (hub) return hub;
  const chunks = new Set<ChunkFn>();
  const credits = new Set<CreditFn>();
  bulk.onChunk = (id, seq, end, payload) => {
    for (const fn of [...chunks]) fn(id, seq, end, payload);
  };
  bulk.onCredit = (id, msg) => {
    for (const fn of [...credits]) fn(id, msg);
  };
  hub = {
    listenChunks: (fn) => (chunks.add(fn), () => void chunks.delete(fn)),
    listenCredits: (fn) => (credits.add(fn), () => void credits.delete(fn)),
  };
  hubs.set(bulk, hub);
  return hub;
}
