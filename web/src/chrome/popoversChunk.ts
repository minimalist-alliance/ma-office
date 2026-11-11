// The office's three small panels: the account menu's (`AccountPanel.tsx`), the bell's (`BellPanel.tsx`) and the bandwidth
// circle's (`bandwidth/BandwidthPanel.tsx`). One chunk, fetched once the page is idle (`main.tsx`). Shut, they draw nothing, so
// none is on the first paint; once the chunk is here a panel opens in the same commit as the press or hover that opens it, and
// one opened sooner shows as the chunk lands.
import { onDemand } from '../lib/onDemand';

export const popovers = onDemand(() => import('./popovers'));
