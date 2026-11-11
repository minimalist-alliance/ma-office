import { useAnnouncer } from '../shell/announce';
import { useWakeSaid } from './wakeSaid';

export function LiveRegion() {
  const text = useAnnouncer((s) => s.text);
  useWakeSaid();
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="live-region">
      {text}
    </div>
  );
}
