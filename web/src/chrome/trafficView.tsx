// The traffic stop's words and the time it clears, a lazy chunk with the windows that show them (TD-162): the first load keeps
// only the hold check and the strip's short reason (`desk/trafficStop.ts`). Draft words for Sales; no number from `limit`.
import { supportAddress } from '../platform/clientConfig';
import { useSession } from '../platform/session';
import type { TrafficStop } from '../desk/trafficStop';
import { clearsLine, trafficLine } from './trafficWords';

export interface TrafficViewProps {
  stop: TrafficStop;
  /** `hold`: where Start would be, with a way to ask support. `stopping`: the notice, the reason and the time. */
  mode: 'hold' | 'stopping';
}

export default function TrafficView({ stop, mode }: TrafficViewProps) {
  const address = supportAddress(useSession((s) => s.config));
  return (
    <div className="traffic-stop" data-testid="traffic-stop">
      <h3 data-testid="traffic-stop-line">{trafficLine(stop.scope)}</h3>
      {stop.clearsAt && <p data-testid="traffic-stop-clears">{clearsLine(stop.clearsAt)}</p>}
      {mode === 'hold' && <p><a className="closed-link" href={`mailto:${address}`} data-testid="traffic-stop-support">Contact support</a></p>}
    </div>
  );
}
