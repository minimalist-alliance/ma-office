// "<desk name> started at <time>" for a desk on the member's own computer (`platform/bootNotice.ts`). One calm line
// per start among the shell's notices, out of the flow, with a way to put it away. It's said once through the polite
// live region; the line itself isn't live, so a screen reader doesn't say it twice.
import { useEffect } from 'react';
import { bootTime, dismissBoot, useBootNotices, type BootNotice } from '../platform/bootNotice';
import { announce } from '../shell/announce';
import { Icon } from './icons';

export const bootSaid = (n: BootNotice): string =>
  n.kind === 'refused' ? `Another copy of ${n.name} is trying to start.` : `${n.name} started at ${bootTime(n.at)}.`;

export function BootNotices() {
  const notices = useBootNotices((s) => s.notices);

  useEffect(
    () =>
      useBootNotices.subscribe((s, was) => {
        for (const n of s.notices) if (!was.notices.some((w) => w.deskId === n.deskId && w.at === n.at && w.kind === n.kind)) announce(bootSaid(n));
      }),
    [],
  );

  return (
    <>
      {notices.map((n) => (
        <div key={`${n.kind}-${n.deskId}`} className="notice boot-notice" role="group" aria-label={n.kind === 'refused' ? `${n.name}: another copy` : `${n.name} started`} data-testid="boot-notice">
          <p className="boot-notice-text">
            {bootSaid(n)}
            <span className="boot-notice-tail">
              {n.kind === 'refused' ? ' Only one can run at a time.' : ' Not you? Remove it in your account settings.'}
            </span>
          </p>
          <button type="button" className="icon-btn sm boot-notice-dismiss" aria-label="Dismiss" title="Dismiss" onClick={() => dismissBoot(n)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </>
  );
}
