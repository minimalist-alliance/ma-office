// A desk's link, when it's open: what the sheet and a view ask deskd through. Never wakes anything.
import type { DeskLink } from '../../desk/deskLink';
import { linkOf } from '../../desk/liveStore';

export function liveDeskLink(deskId: string): DeskLink | null {
  const link = linkOf(deskId);
  return link && link.status() === 'open' ? link : null;
}
