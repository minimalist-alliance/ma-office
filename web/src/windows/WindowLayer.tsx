// Window sets per desk (design 3.6): switching the active desk parks the old desk's windows and
// restores the new desk's. Parked windows stay mounted. The overview parks everything.
import { useEffect, useState } from 'react';
import { prefetchBrowser } from '../apps/chunks';
import { shownDesk } from '../desk/attention';
import { onDemand, useOnDemand } from '../lib/onDemand';
import { useDeskStore } from '../state/deskStore';
import { useViewStore } from '../state/viewStore';
import { useWindowStore } from '../state/windowStore';
// Every app's window (`apps/registry.tsx`) stays in the first load, where `AppWindow` had it: a desk in carousel mode, or a
// phone's carousel restored from this tab, renders its app from it as the office comes up (`carousel/CarouselLayer.tsx`), and
// out of the first load the stage waited for two more chunks, one after the other. Here, where `./AppWindow` was, so the
// stylesheet keeps its order.
import '../apps/registry';

const TABLET_MAX = '(max-width: 1023px)';

// The window itself (its frame, drag and resize) is a chunk of its own. No window outlives a page load, so none is on the
// first paint: `main.tsx` fetches the chunk once the page is idle, and a window
// opened after that renders in the same commit as its store change, as it did from the first load. One opened sooner shows
// as the chunk lands, and a chunk that didn't load is asked for again at the next change to the open windows.
const windowsChunk = onDemand(() => import('./AppWindow'));

/** At idle, from `main.tsx`: the windows, then the Browser's own code (`apps/chunks.ts`). */
export function prefetchWindows(): void {
  windowsChunk.prefetch();
  prefetchBrowser();
}

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
  const AppWindow = useOnDemand(windowsChunk, Object.keys(windows).join(' ') || false)?.AppWindow;

  return (
    <div className={`window-layer${shield ? ' shielded' : ''}`}>
      {AppWindow &&
        Object.values(windows).map((w) => (
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
