// Which notice an account with no desks sees. "Your desk is on its way" is a promise and "not active" is a verdict, so
// nothing shows until `GET /v1/me` has said what the membership is: a paying member whose answer is slow sees the
// canvas as it is while loading, never a card. The desk list can't stand in for it, even when it says unpaid.
import { awaitingParent } from '../platform/age';
import type { Me } from '../platform/api';
import type { DeskListStatus } from '../state/deskStore';

/**
 * The membership cards built so far (the membership card proposal, "Who sees what"), the only states before billing:
 * `welcome` is A (never paid), `waitlist` is B, `inactive` is F (ended or suspended, by us or not, or held).
 * C to E need `/v1/me` to say why it stopped and until when (STATUS.md), so until then those people get F too.
 * `parent` isn't a status of its own: it's a teen who'd be `unpaid` and whose parent or guardian hasn't agreed yet.
 */
export type MembershipCard = 'welcome' | 'waitlist' | 'inactive';
export type NoDeskNotice = MembershipCard | 'parent' | 'empty' | 'error';

export interface NoDeskInput {
  list: DeskListStatus;
  me: Me | null;
  meFailed: boolean;
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

export function noDeskNotice({ list, me, meFailed }: NoDeskInput): NoDeskNotice | null {
  if (list === 'loading') return null;
  const status = me?.membership?.status;
  const card = membershipCard(status);
  // Waiting on a parent, unless something else stands in the way: a held or ended account keeps its own card.
  if (awaitingParent(me) && (card === 'welcome' || card === null)) return 'parent';
  // No desk can come without a membership, so a list that failed doesn't change what the card says.
  if (card) return card;
  if (list === 'error') return 'error';
  if (status) return 'empty';
  return !me && meFailed ? 'error' : null;
}
