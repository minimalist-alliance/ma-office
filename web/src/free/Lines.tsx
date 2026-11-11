// The free tier's few lines outside the meter and the spot: the one notice in the stack (the heads-up, or the upgrade's),
// the account menu's tier line (row 4), and the Browser bar's line about busy times (row 8).
import { useEffect } from 'react';
import { Words } from '../bandwidth/Words';
import { useSession } from '../platform/session';
import { useFreeState } from './state';
import { freeName } from './wire';
import { BUSY_LINE } from './words';

/** At the top of the shell's notices stack, gone after its time. Said once, through the live region, by whoever showed it. */
export function FreeNotices() {
  const notice = useFreeState((s) => s.notice);
  useEffect(() => {
    if (!notice) return undefined;
    const t = window.setTimeout(() => useFreeState.setState((s) => (s.notice === notice ? { notice: null } : s)), notice.ms);
    return () => window.clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  // Not live itself: one added with its words may not be heard, so the shell's region says it (`announce`).
  return (
    <div className="notice free-notice" data-testid="free-notice">
      <Words text={notice.text} />
    </div>
  );
}

/**
 * Under the member's name, where a paid member sees their tier: "{free}", and nothing else. See membership is in the setup
 * circle's after-setup card now (the Designer's Nov 9, 9:15 pm change), so the account modal keeps its structure.
 */
export function FreeAccount({ className = 'menu-tier', testId = 'menu-tier' }: { className?: string; testId?: string }) {
  const config = useSession((s) => s.config);
  const phase = useFreeState((s) => s.phase);
  if (phase !== 'free') return null;
  return <p className={className} data-testid={testId}>{freeName(config)}</p>;
}

/** In the Browser's bar, while the desk says it's held back, and only the first time in a day (`office.tsx` decides). */
export function FreeBrowserLine({ deskId }: { deskId?: string }) {
  const shows = useFreeState((s) => !!deskId && s.phase === 'free' && !!s.held[deskId] && !!s.busy[deskId]);
  if (!shows) return null;
  return (
    <span className="br-note free-busy" role="status" title={BUSY_LINE} data-testid="free-busy">
      {BUSY_LINE}
    </span>
  );
}
