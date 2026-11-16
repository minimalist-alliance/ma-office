// Whether this member's account is closed (`accountClosed.ts`), as a hook for the chrome. Its own file: `accountClosed.ts`
// is imported by `session.ts`, so it can't import the session itself.
import { useAccountClosed } from './accountClosed';
import { useSession } from './session';

export function useClosed(): boolean {
  const heard = useAccountClosed((s) => s.heard);
  const said = useSession((s) => s.me?.membership?.closed === true);
  return heard || said;
}
