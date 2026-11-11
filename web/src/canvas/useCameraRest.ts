// DOM laid out over the canvas in screen pixels, as the carousel's stage and the open tiles are (`carousel/CarouselLayer.tsx`,
// `opentile/OpenTileLayer.tsx`): laid out for the camera at its last rest, and moved by one transform on the layer while the
// camera moves (the same on every frame, however many things are on it), so nothing renders during a move. At rest it's laid
// out again at the new size, in the same commit that clears the transform, so nothing jumps. The proxy layer does the same.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { camera } from './controller';

export interface RestCam {
  x: number;
  y: number;
  s: number;
}

/** The camera `layer` is laid out for: its last rest. It changes only when the camera settles (or the page resizes), never during a move. */
export function useCameraRest(layer: RefObject<HTMLElement | null>): RestCam {
  const [rest, setRest] = useState<RestCam>(() => ({ ...camera.cam }));
  const restRef = useRef(rest);

  useEffect(() => {
    const move = (): void => {
      const el = layer.current;
      if (!el) return;
      const c = camera.cam;
      const r = restRef.current;
      const k = c.s / r.s;
      el.style.transform = `translate(${c.x - r.x * k}px, ${c.y - r.y * k}px) scale(${k})`;
    };
    const offMove = camera.onMove(move);
    const offSettle = camera.onSettle(() => setRest({ ...camera.cam }));
    // A resize of the page moves no camera, but what's on screen, and how big, may now decide differently.
    const onResize = (): void => setRest({ ...camera.cam });
    window.addEventListener('resize', onResize);
    return () => {
      offMove();
      offSettle();
      window.removeEventListener('resize', onResize);
    };
  }, [layer]);

  // Laid out again for this rest in the same commit that takes the move's transform away, so nothing jumps.
  useLayoutEffect(() => {
    restRef.current = rest;
    if (layer.current) layer.current.style.transform = '';
  }, [rest, layer]);

  return rest;
}
