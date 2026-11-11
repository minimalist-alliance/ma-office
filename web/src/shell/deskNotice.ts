// Which notice an account with no desks sees. "Your desk is on its way" is a promise and "not active" is a verdict, so
// nothing shows until `GET /v1/me` has said what the membership is: a paying member whose answer is slow sees the
// canvas as it is while loading, never a card. The desk list can't stand in for it, even when it says unpaid.
import { awaitingParent } from '../platform/age';
import type { Me } from '../platform/api';
import type { DeskListStatus } from '../state/deskStore';

/**
 * The membership cards (the membership card proposal, "Who sees what"): `welcome` is A (never paid), `waitlist` is B,
 * `paused` is C (a payment failed and the desks stopped), `kept` is D (they cancelled, and their desks are kept until a
 * date), `welcomeBack` is E (that date has passed), and `inactive` is F (ended or suspended by us, held, or anything
 * `/v1/me` doesn't explain plainly). `parent` isn't a status of its own: it's a teen who'd be `unpaid` and whose parent
 * or guardian hasn't agreed yet.
 */
export type StopCard = 'paused' | 'kept' | 'welcomeBack';
export type MembershipCard = 'welcome' | 'waitlist' | StopCard | 'inactive';
export type NoDeskNotice = MembershipCard | 'parent' | 'empty' | 'error';

export interface NoDeskInput {
  list: DeskListStatus;
  me: Me | null;
  meFailed: boolean;
  /** The office lists desks (stopped ones too). Then only C and D show, over them; see `noDeskNotice`. */
  hasDesks?: boolean;
  /** For tests; the clock otherwise. D becomes E once the deletion date has passed. */
  now?: number;
}

/**
 * C, D or E from `/v1/me`'s `stoppedBy`, `stoppedAt` and `dataDeleteAt` (ma-platform contract desks.md 0.3.69), or
 * null for F. `suspended` with `payment`, a readable stop and a deletion date still ahead is C; `ended` with `member`
 * is D while that date is ahead, then E. Anything else is F, which says the least: `other`, an end after a failed
 * payment (paying the old invoice no longer starts the desks), a missing field, or a date that doesn't read, which is
 * never guessed.
 */
export function stopCard(membership: Me['membership'], now: number): StopCard | null {
  const deleteAt = Date.parse(membership?.dataDeleteAt ?? '');
  if (Number.isNaN(deleteAt)) return null;
  const { status, stoppedBy } = membership ?? {};
  if (status === 'suspended' && stoppedBy === 'payment') {
    return deleteAt > now && !Number.isNaN(Date.parse(membership?.stoppedAt ?? '')) ? 'paused' : null;
  }
  if (status === 'ended' && stoppedBy === 'member') return deleteAt > now ? 'kept' : 'welcomeBack';
  return null;
}

export function membershipCard(status: string | undefined): MembershipCard | null {
  switch (status) {
    // `none` and `pending` aren't contract values, but the proposal names them with `unpaid`: never paid either way.
    case 'unpaid':
    case 'none':
    case 'pending':
      return 'welcome';
    case 'waitlisted':
      return 'waitlist';
    case 'suspended':
    case 'ended':
    case 'closed':
      return 'inactive';
    default:
      return null;
  }
}

export function noDeskNotice({ list, me, meFailed, hasDesks = false, now = Date.now() }: NoDeskInput): NoDeskNotice | null {
  if (list === 'loading') return null;
  // A suspended or ended member still has desks, stopped. C and D say why they don't wake, over the desks; E and F
  // (and every other state) stay what they are: nothing over desks. An active member's office is untouched.
  if (hasDesks) {
    const stop = membershipCard(me?.membership?.status) === 'inactive' ? stopCard(me?.membership, now) : null;
    return stop === 'paused' || stop === 'kept' ? stop : null;
  }
  const status = me?.membership?.status;
  const plain = membershipCard(status);
  // A stop `/v1/me` explains plainly is C, D or E; F otherwise.
  const card = plain === 'inactive' ? (stopCard(me?.membership, now) ?? plain) : plain;
  // Waiting on a parent, unless something else stands in the way: a held or ended account keeps its own card.
  if (awaitingParent(me) && (card === 'welcome' || card === null)) return 'parent';
  // No desk can come without a membership, so a list that failed doesn't change what the card says.
  if (card) return card;
  if (list === 'error') return 'error';
  if (status) return 'empty';
  return !me && meFailed ? 'error' : null;
}
