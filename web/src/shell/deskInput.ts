// Which desk a piece of input was on, for the idle rule (design 10.5): keyboard, pointer, scroll or touch on that
// desk's panel or windows. Listens in capture, reads and writes no layout on a window, and doesn't look at pointer
// moves, so the camera pays nothing for it. The Browser's stream reports its own, every move included.
import { camera } from '../canvas/controller';
import { deskBounds } from '../canvas/layout';
import { isPhone } from '../canvas/phone';
import { noteDeskInput } from '../desk/liveStore';
import { useLayoutStore } from '../state/layoutStore';
import { getView } from '../state/viewStore';

function deskAt(x: number, y: number): string | null {
  const { desks } = useLayoutStore.getState();
  const phone = isPhone();
  for (const [id, layout] of Object.entries(desks)) {
    const r = camera.toScreen(deskBounds(layout, phone));
    if (x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) return id;
  }
  return null;
}

function deskOf(e: Event): string | null {
  const el = e.target instanceof Element ? e.target : null;
  const win = el?.closest<HTMLElement>('.ma-window');
  if (win) return win.dataset['desk'] ?? null;
  const v = getView();
  if (v.mode === 'desk' || e instanceof KeyboardEvent) return v.activeDesk;
  return e instanceof MouseEvent ? deskAt(e.clientX, e.clientY) : null;
}

export function watchDeskInput(): () => void {
  const onInput = (e: Event): void => {
    if (e.target instanceof Element && e.target.closest('.br-surface')) return; // the stream reports its own
    const deskId = deskOf(e);
    if (deskId) noteDeskInput(deskId, true);
  };
  const options = { capture: true, passive: true };
  window.addEventListener('pointerdown', onInput, options);
  window.addEventListener('keydown', onInput, options);
  window.addEventListener('wheel', onInput, options);
  return () => {
    window.removeEventListener('pointerdown', onInput, options);
    window.removeEventListener('keydown', onInput, options);
    window.removeEventListener('wheel', onInput, options);
  };
}
