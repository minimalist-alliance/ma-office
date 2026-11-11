// The way in to open tiles (ADR 0053) from the shell, all that's in the first load: the kill switch, and whether the layer's
// chunk is needed yet. Everything else is the chunk's (`OpenTileLayer.tsx`).
import { carouselOn } from '../carousel/model';
import { detailLevel, setOpenLevel } from '../canvas/layout';
import { useIsPhone } from '../canvas/phone';
import { shownDesk } from '../desk/attention';
import { useSession } from '../platform/session';
import { useLayoutStore } from '../state/layoutStore';
import { useViewStore } from '../state/viewStore';

/** The layer's own chunk: fetched when a tile first reaches `open` on the shown desk, or on a load with one. */
export const loadOpenTiles = () => import('./OpenTileLayer');

/**
 * From `Shell`, before the desks render: client-config `openTiles: { enabled: false }` is the kill switch (absent is on, as it
 * ships), and off, nothing goes past `large` and the chunk never loads. Then whether the layer has anything to do: a larger
 * screen, and a tile at `open` on the shown desk, not in carousel mode.
 */
export function useOpenNeeded(): boolean {
  const on = useSession((s) => s.config?.openTiles?.enabled !== false);
  setOpenLevel(on);
  const phone = useIsPhone();
  const shown = useViewStore((s) => shownDesk(s));
  const any = useLayoutStore((s) => {
    const d = shown ? s.desks[shown] : undefined;
    return !!d && !carouselOn(d) && d.items.some((i) => detailLevel(i.w, i.h, i.app) === 'open');
  });
  return on && !phone && any;
}
