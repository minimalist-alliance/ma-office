// The hook for the canvas and the proxy layer; the decision itself is `stoppedDim.ts`, which needs no browser.
import { useAccountClosed } from '../platform/accountClosed';
import { useSession } from '../platform/session';
import { useDeskStore } from '../state/deskStore';
import { desksStopped } from './stoppedDim';

export { desksOpacity, STOPPED_OPACITY } from './stoppedDim';

export function useDesksStopped(): boolean {
  const status = useDeskStore((s) => s.status);
  const hasDesks = useDeskStore((s) => s.desks.length > 0);
  const me = useSession((s) => s.me);
  const meFailed = useSession((s) => s.meFailed);
  const closedHeard = useAccountClosed((s) => s.heard);
  return desksStopped({ list: status, me, meFailed, hasDesks, closedHeard });
}
