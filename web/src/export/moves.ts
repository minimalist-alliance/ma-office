// The move's half on Platform (ma-platform draft ADR "data export and transfer", section 4): a one-time code for
// `sudo ma-move` on the member's own computer, and the moves so far.
import { api } from '../platform/api';
import type { PlatformDesk } from '../platform/api';

export interface MoveCode {
  moveId: string;
  code: string;
  expiresAt: string;
}

export interface Move {
  moveId: string;
  sourceDeskId?: string;
  targetDeskId?: string;
  sourceName?: string;
  targetName?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  codeExpiresAt?: string;
}

/** A desk on the member's own computer, where a move can go: `hosting: "self"` on its `GET /v1/desks` row (task 31). */
export const isSelfHosted = (d: PlatformDesk): boolean => d.hosting === 'self';

export async function createMove(sourceDeskId: string, targetDeskId: string): Promise<MoveCode> {
  const r = await api<MoveCode>('/v1/moves', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceDeskId, targetDeskId }) });
  if (!r.data?.code || !r.data.expiresAt) throw new Error('POST /v1/moves gave no code');
  return r.data;
}

export async function listMoves(): Promise<Move[]> {
  const r = await api<{ moves?: Move[] } | Move[]>('/v1/moves');
  const list = Array.isArray(r.data) ? r.data : r.data?.moves;
  return Array.isArray(list) ? list : [];
}

/** The member ends a move (contract desks.md 0.3.43): its token stops at once and an unused code can't be claimed. Safe to repeat. */
export async function cancelMove(moveId: string): Promise<void> {
  await api(`/v1/moves/${encodeURIComponent(moveId)}/cancel`, { method: 'POST' });
}

export interface RemovedDesk {
  deskId?: string;
  /** When the cloud desk's data is gone for good: 30 days after the removal (ISO), if the platform says (`dataKeptUntil`). */
  retainedUntil?: string | null;
}

/** How many times the removal asks again while the cloud desk stops first (the platform answers 202, ask again in 30 s). */
const MAX_ASKS = 12;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * After a finished move, the member removes the cloud desk it came from (contract desks.md 0.3.43):
 * `POST /v1/moves/{moveId}/remove-cloud-desk` with `{confirm: <the desk's ID>}`. A desk that is still up is stopped first and the
 * platform answers `202`; the same request is asked again until it answers `200 {deskId, dataKeptUntil}`. The platform keeps
 * the data 30 days. A Guild Desk is refused (`409 guild_desk_not_removable`) and a failure leaves the desk untouched.
 */
export async function removeMovedDesk(moveId: string, deskId: string, onStopping?: () => void, wait: (ms: number) => Promise<void> = sleep): Promise<RemovedDesk> {
  for (let ask = 0; ask < MAX_ASKS; ask++) {
    const r = await api<{ deskId?: string; dataKeptUntil?: string | null; retryAfterSeconds?: number }>(`/v1/moves/${encodeURIComponent(moveId)}/remove-cloud-desk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: deskId }),
    });
    if (r.status !== 202) return { deskId: r.data?.deskId, retainedUntil: r.data?.dataKeptUntil ?? null };
    onStopping?.();
    const secs = Number(r.retryAfter ?? r.data?.retryAfterSeconds ?? 30);
    await wait(Math.min(Math.max(Number.isFinite(secs) ? secs : 30, 1), 60) * 1000);
  }
  throw new Error('The cloud desk is still stopping.');
}

/** A move that can still be cancelled: a code that's out and unexpired, or one under way. */
export function cancellable(m: Move, now: number = Date.now()): boolean {
  switch (m.state) {
    case 'claimed':
    case 'copying':
    case 'checking':
      return true;
    case 'created': {
      const t = m.codeExpiresAt ? Date.parse(m.codeExpiresAt) : Number.NaN;
      return Number.isNaN(t) || t > now;
    }
    default:
      return false;
  }
}
