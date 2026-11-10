// Window sets per desk (design 3.6): switching the active desk parks the old desk's windows and
// restores the new desk's. Parked windows stay mounted. The overview parks everything.
import { useEffect, useState } from 'react';
import { shownDesk } from '../desk/attention';
import { useDeskStore } from '../state/deskStore';
import { useViewStore } from '../state/viewStore';
import { useWindowStore } from '../state/windowStore';
import { AppWindow } from './AppWindow';

const TABLET_MAX = '(max-width: 1023px)';

function useForceFull(): boolean {
  const [v, setV] = useState(() => window.matchMedia(TABLET_MAX).matches);
  useEffect(() => {
    const mq = window.matchMedia(TABLET_MAX);
    const on = (): void => setV(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return v;
}

export function WindowLayer() {
  const windows = useWindowStore((s) => s.windows);
  const active = useWindowStore((s) => s.active);
  // The same rule that says which desk is looked at (`desk/attention.ts`), so a parked window is always an unseen desk's.
  const shown = useViewStore((s) => shownDesk(s));
  const shield = useViewStore((s) => s.privacyShield);
  const desks = useDeskStore((s) => s.desks);
  const forceFull = useForceFull();

  return (
    <div className={`window-layer${shield ? ' shielded' : ''}`}>
      {Object.values(windows).map((w) => (
        <AppWindow
          key={w.key}
          win={w}
          deskName={desks.find((d) => d.id === w.deskId)?.name ?? ''}
          active={active === w.key}
          parked={w.deskId !== shown}
          forceFull={forceFull}
        />
      ))}
    </div>
  );
}
