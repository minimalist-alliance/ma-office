import { useAnnouncer } from '../shell/announce';

export function LiveRegion() {
  const text = useAnnouncer((s) => s.text);
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="live-region">
      {text}
    </div>
  );
}
