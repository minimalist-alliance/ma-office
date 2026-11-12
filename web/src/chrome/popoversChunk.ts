// The office's small panels: the account menu's (`AccountPanel.tsx`), the bell's (`BellPanel.tsx`), the bandwidth circle's
// (`bandwidth/BandwidthPanel.tsx`), in short-viewport mode the bars' scope list and zoom popover (`BarPanels.tsx`), and the
// bottom bar's row during a move or a resize (`EditBar.tsx`). One chunk, fetched once the page is idle (`main.tsx`). Shut,
// they draw nothing, so none is on the first paint; once the chunk is here a panel opens in the same commit as the press or
// hover that opens it, and one opened sooner shows as the chunk lands.
import { onDemand } from '../lib/onDemand';

export const popovers = onDemand(() => import('./popovers'));
