// Bringing a passwords file in (#11, spec section 9.2; deskd API.md section 10 "Passwords", Security's finding of Nov 11).
// The member picks the CSV on this device. Its bytes are read here, in the member's own browser, and go to the desk only
// over the desk link's `bulk` channel (WebRTC, DTLS from this browser to the desk), straight into deskd's memory:
//
//   `browser.import.begin {kind: "passwords", size}` → `{uploadId, transferId}`, then CHUNK frames on `bulk` (`seq` from 0,
//   16,372-byte payloads, credit for the whole file at once), then `browser.import.finish {uploadId}` → the counts.
//
// Never to Minimalist Alliance's servers (no `fetch`, no upload URL), never kept in the office (no localStorage,
// sessionStorage, IndexedDB, cache or Files), never logged, never turned into text here. The bytes are zeroed as soon as the
// last frame has gone, and on every way out before that; the link's frame copies are zeroed as each is sent (`peer.ts`).
// The caller drops the `File` as it hands the bytes over. A failure after `begin` aborts the desk's copy too, and Try again
// is a new pick of the file: nothing is added twice on the desk, so that's safe.
import type { DeskLink } from '../../desk/deskLink';
import { uuidv7 } from '../../desk/idem';

/** deskd's cap for a passwords file (2 MiB). A bigger one is refused before a byte leaves this device. */
export const MAX_PASSWORDS_FILE = 2 * 1024 * 1024;
/** A CHUNK frame's payload, at most (API.md section 2). */
export const CHUNK_BYTES = 16_372;
/** Wait for `bulk` to drain after this many frames, as the Files app's uploads do. */
const DRAIN_EVERY = 16;
/** Chromium takes rows one at a time: room for a big file. A lost reply is asked again with the same key, which gets the stored result. */
const FINISH_DEADLINE_MS = 120_000;
const FINISH_RETRIES = 2;

export interface ImportCounts {
  found: number;
  added: number;
  alreadySaved: number;
  refused: number;
}

/** An import refused before anything went to the desk, as deskd would have said it. */
export class ImportRefused extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, details: Record<string, unknown>) {
    super(`import refused: ${code}`);
    this.name = 'ImportRefused';
    this.code = code;
    this.details = details;
  }
}

/** The session went while the bytes were going: the desk's copy is aborted, and Try again is a new pick. */
const noSession = (): Error => Object.assign(new Error('the desk link went'), { code: 'not_connected' });

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const codeOf = (err: unknown): string => ((err as { code?: unknown } | null)?.code as string) ?? '';

type Link = Pick<DeskLink, 'call' | 'bulk'>;

/**
 * Sends the file's bytes to the desk and returns deskd's counts. `bytes` is zeroed before this returns or throws, whatever
 * happens; the caller keeps no other copy.
 */
export async function sendPasswordsFile(link: Link, bytes: Uint8Array): Promise<ImportCounts> {
  let uploadId: string | null = null;
  try {
    if (bytes.length === 0) throw new ImportRefused('bad_request', { reason: 'format' });
    if (bytes.length > MAX_PASSWORDS_FILE) throw new ImportRefused('too_large', { limit: MAX_PASSWORDS_FILE });
    const begun = await link.call('browser.import.begin', { kind: 'passwords', size: bytes.length }, { idem: uuidv7() });
    uploadId = begun.uploadId;
    const bulk = link.bulk();
    if (!bulk) throw noSession();
    for (let seq = 0, at = 0; at < bytes.length; seq += 1, at += CHUNK_BYTES) {
      if (!bulk.send(begun.transferId, seq, bytes.subarray(at, at + CHUNK_BYTES))) throw noSession();
      if (seq % DRAIN_EVERY === DRAIN_EVERY - 1) await bulk.drained();
    }
  } catch (err) {
    bytes.fill(0);
    if (uploadId !== null) abort(link, uploadId);
    throw err;
  }
  // Every frame has gone: nothing here needs the file any more.
  bytes.fill(0);
  const finishKey = uuidv7();
  for (let tries = 0; ; tries += 1) {
    try {
      const r = await link.call('browser.import.finish', { uploadId }, { idem: finishKey, deadlineMs: FINISH_DEADLINE_MS });
      return { found: count(r?.found), added: count(r?.added), alreadySaved: count(r?.alreadySaved), refused: count(r?.refused) };
    } catch (err) {
      const lost = codeOf(err) === 'deadline_exceeded' || codeOf(err) === 'cancelled';
      if (lost && tries < FINISH_RETRIES) continue;
      // deskd zeroes its copy on any error after `finish` begins; this makes sure of it when the reply was lost.
      abort(link, uploadId);
      throw err;
    }
  }
}

/** Zeroes the desk's copy, if it still has one. Idempotent on the desk; nothing to wait for here. */
function abort(link: Link, uploadId: string): void {
  void link.call('browser.import.abort', { uploadId }, { idem: uuidv7() }).catch(() => undefined);
}
