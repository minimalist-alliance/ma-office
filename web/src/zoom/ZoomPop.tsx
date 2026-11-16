// An app's zoom popout (ADR 0055): a slider from 50 to 200 % in 10 % steps, and the level, a button back to 100 %. Like the
// office's other popovers: one at a time (a press anywhere outside shuts it, another popover's button included), Esc shuts
// it and gives the keyboard back to the button, and so does the keyboard leaving it. The slider takes the keyboard as it
// opens: the arrows step 10, Home and End go to 50 and 200.
import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { DEFAULT_LEVEL, levelWords, MAX_LEVEL, MIN_LEVEL, snapLevel, STEP } from './level';
import { setAppLevel } from './store';

export function ZoomPop({ app, deskId, label, level, btn, shut }: {
  app: string;
  deskId: string;
  label: string;
  level: number;
  btn: RefObject<HTMLButtonElement | null>;
  shut: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(shut);
  close.current = shut;
  useEffect(() => {
    const wrap = btn.current?.parentElement;
    ref.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    if (!wrap) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!wrap.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Ours: not the office's (it would leave the desk), an open tile's (back to its tile) or the page's.
      e.preventDefault();
      e.stopPropagation();
      close.current();
      btn.current?.focus({ preventScroll: true });
    };
    const onOut = (e: FocusEvent): void => {
      if (e.relatedTarget && !wrap.contains(e.relatedTarget as Node)) close.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    wrap.addEventListener('keydown', onKey);
    wrap.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      wrap.removeEventListener('keydown', onKey);
      wrap.removeEventListener('focusout', onOut);
    };
  }, [btn]);
  const words = levelWords(level);
  const value = snapLevel(level);
  // How far along the track the value is, 0 to 1: the shared range style (`.ma-range`, app.css) draws the filled part to it.
  const at = { '--ma-range-at': (value - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL) } as CSSProperties;
  return (
    <div ref={ref} className="app-zoom-pop ma-glass" role="dialog" aria-label={`Zoom ${label}`} data-testid="app-zoom-pop">
      <input
        type="range"
        className="ma-range app-zoom-slider"
        style={at}
        min={MIN_LEVEL}
        max={MAX_LEVEL}
        step={STEP}
        value={value}
        aria-label="Zoom"
        aria-valuetext={words}
        onChange={(e) => setAppLevel(app, deskId, Number(e.currentTarget.value))}
      />
      <button type="button" className="app-zoom-reset" aria-label={`${words}, back to 100%`} title="Back to 100%" onClick={() => setAppLevel(app, deskId, DEFAULT_LEVEL)}>
        {words}
      </button>
    </div>
  );
}
