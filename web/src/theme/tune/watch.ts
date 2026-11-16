// Follows the member's theme sliders from `/v1/me` (ma-platform contract appearance.md): a setting this browser doesn't show
// (moved on another device, or in the Forums) brings the sliders' chunk (`engine.ts`), which eases it in; signing out puts
// today's colours back. A member at the default whose browser shows the default loads nothing. Main chunk, small.
import type { Me } from '../../platform/api';
import { useSession } from '../../platform/session';
import { bootMirror, tuneTarget } from './apply';

const engine = (): Promise<typeof import('./engine')> => import('./engine');

/** `/v1/me`'s `appearance`, or null where it says nothing (a Platform from before it, or the last visit's kept `me`). */
function appearanceOf(me: Me | null): { blue: number; contrast: number } | null {
  const a = (me as { appearance?: unknown } | null)?.appearance;
  if (!a || typeof a !== 'object') return null;
  const { blue, contrast } = a as { blue?: unknown; contrast?: unknown };
  const int = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : d);
  return { blue: int(blue, 100), contrast: int(contrast, 50) };
}

export function watchAppearance(): void {
  // This browser's copy painted the first frame: its colours are checked against today's tokens once the chunk is here.
  if (bootMirror) void engine();
  useSession.subscribe((s, prev) => {
    if (s.status === 'signedOut' && prev.status !== 'signedOut') {
      const t = tuneTarget();
      if (t.blue !== 100 || t.contrast !== 50) void engine().then((e) => e.adopt(null, { blue: 100, contrast: 50 }));
      return;
    }
    if (s.me === prev.me || !s.me) return;
    const want = appearanceOf(s.me);
    if (!want) return;
    const t = tuneTarget();
    // Already what's shown, and nothing came from this browser's copy to check: nothing to do (the default loads nothing).
    if (want.blue === t.blue && want.contrast === t.contrast && !bootMirror) return;
    const who = s.me.userId;
    void engine().then((e) => e.adopt(who, want));
  });
}
