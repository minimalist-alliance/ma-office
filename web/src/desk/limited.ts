import { useFree } from '../free/door';
import { useDeskStore } from '../state/deskStore';

/**
 * A desk with a short idle limit on the Platform: the Alliance Member's hosted desk (`startsWithOffice`) or a free member's own
 * desk. A Guild Desk or a desk on the member's own computer never is. Both facts are already held, so nothing is asked.
 */
export function isLimitedDesk(deskId: string): boolean {
  const d = useDeskStore.getState().desks.find((x) => x.id === deskId);
  if (!d || d.kind === 'guild' || d.selfHosted) return false;
  return d.startsWithOffice === true || useFree.getState().free === true;
}
