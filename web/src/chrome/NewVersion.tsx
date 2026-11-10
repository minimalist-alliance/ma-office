// A new release shipped while this tab was open (`platform/newVersion.ts`). It says so among the shell's notices, just
// above the bottom bar and out of the flow, so no control moves or hides for it. Then it waits: a reload closes the
// member's windows, so only they start one, and they can put the notice away.
//
// It's said once, through the polite live region that's always there. The notice itself isn't live, or a screen
// reader would say it twice, and a live region that arrives with its text isn't reliably read.
import { useEffect, useId } from 'react';
import { dismissNewVersion, useNewVersion } from '../platform/newVersion';
import { announce } from '../shell/announce';
import { Icon } from './icons';

export const NEW_VERSION_SAID = 'A new version is ready. Reload when you like.';

export function NewVersion() {
  const show = useNewVersion((s) => s.ready !== null && !s.dismissed);
  const textId = useId();

  useEffect(
    () =>
      useNewVersion.subscribe((s, was) => {
        if (s.ready && !was.ready) announce(NEW_VERSION_SAID);
      }),
    [],
  );

  if (!show) return null;
  return (
    <div className="notice new-version" role="group" aria-labelledby={textId} data-testid="new-version">
      <p className="new-version-text" id={textId}>
        A new version is ready<span className="new-version-tail">, reload when you like</span>
      </p>
      <button type="button" className="new-version-reload" onClick={() => window.location.reload()}>
        Reload
      </button>
      <button type="button" className="icon-btn sm new-version-dismiss" aria-label="Dismiss" title="Dismiss" onClick={dismissNewVersion}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
