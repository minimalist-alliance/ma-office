// Hints, desk switcher (with more than one desk) and zoom, from the prototype. The zoom label is
// the only DOM the camera touches at rest, and it writes only when the value changes. In short-viewport mode the zoom is
// one button showing the level, whose popover holds the same three controls (`BarMenus.tsx`). While a desk or an app is
// moved or resized, the row is the edit's own (`EditBar.tsx`, in the popovers chunk).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { camera } from '../canvas/controller';
import { useIsShort } from '../canvas/phone';
import { useOnDemand } from '../lib/onDemand';
import { cycleDesk, fitScope, orderedDeskIds } from '../shell/actions';
import { canvasHasFocus, onFocusMove } from '../shell/canvasFocus';
import { useDeskStore } from '../state/deskStore';
import { setView, useViewStore } from '../state/viewStore';
import { BarMenu } from './BarMenus';
import { Icon } from './icons';
import { popovers } from './popoversChunk';

/** `\` works only while the canvas has the keyboard, so the hint names it only then; the arrows work from anywhere. */
function writePrivacyHint(el: HTMLSpanElement | null): void {
  const text = canvasHasFocus() ? ' · \\ privacy' : '';
  if (el && el.textContent !== text) el.textContent = text;
}

export function BottomBar() {
  const desks = useDeskStore((s) => s.desks);
  const activeDesk = useViewStore((s) => s.activeDesk);
  const editing = useViewStore((s) => s.kbEdit);
  const privacyHint = useRef<HTMLSpanElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const short = useIsShort();
  const EditBar = useOnDemand(popovers, editing || false)?.EditBar;

  // Again as the label changes place (the zoom group, short-viewport mode's button, back after an edit), so it says the level.
  useEffect(() => {
    const write = (): void => {
      const el = zoomLabel.current;
      const text = `${Math.round(camera.cam.s * 100)}%`;
      if (el && el.textContent !== text) el.textContent = text;
    };
    write();
    return camera.onSettle(write);
  }, [short, editing]);

  // Written straight to the DOM, as the zoom label is: a press on the canvas focuses it, and must render nothing.
  useLayoutEffect(() => writePrivacyHint(privacyHint.current));
  useEffect(() => onFocusMove(() => writePrivacyHint(privacyHint.current)), []);

  const many = desks.length > 1;
  const ids = orderedDeskIds();
  const name = desks.find((d) => d.id === activeDesk)?.name ?? '';
  const zoom = (factor: number): void => {
    setView({ mode: 'free' });
    camera.zoomBy(factor);
  };

  // Nothing to zoom or pan until there's a desk.
  if (desks.length === 0) return null;
  if (editing) return <div className="bottombar">{EditBar && <EditBar kind={editing} />}</div>;

  return (
    <div className="bottombar">
      <p className="hints" aria-hidden="true">
        {many && <span className="hint-switch">← → switch desks · </span>}scroll to zoom · drag to pan<span ref={privacyHint} />
      </p>
      {many ? (
        <div className="desk-nav" role="group" aria-label="Switch desk">
          <button type="button" className="icon-btn chrome" onClick={() => cycleDesk(-1)} aria-label="Previous desk" title="Previous desk ( [ )"><Icon name="chevronLeft" /></button>
          <span className="desk-nav-label">
            {name}
            <small>{activeDesk ? ids.indexOf(activeDesk) + 1 : 0} of {ids.length}</small>
          </span>
          <button type="button" className="icon-btn chrome" onClick={() => cycleDesk(1)} aria-label="Next desk" title="Next desk ( ] )"><Icon name="chevronRight" /></button>
        </div>
      ) : <span />}
      {short ? (
        <BarMenu panel="ZoomPanel">
          <span className="sr-only">Zoom </span>
          <span className="zoom-label" ref={zoomLabel}>100%</span>
        </BarMenu>
      ) : (
      <div className="zoom-ctl" role="group" aria-label="Zoom">
        <button type="button" className="icon-btn chrome" onClick={() => zoom(0.8)} aria-label="Zoom out"><Icon name="minus" /></button>
        <span className="zoom-label" ref={zoomLabel}>100%</span>
        <button type="button" className="icon-btn chrome" onClick={() => zoom(1.25)} aria-label="Zoom in"><Icon name="plus" /></button>
        <button type="button" className="icon-btn chrome" onClick={fitScope} aria-label="Fit the desk" title="Fit ( 0 )"><Icon name="fit" /></button>
      </div>
      )}
    </div>
  );
}
