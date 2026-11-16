// An app's zoom button (ADR 0055), beside its expand button in every head: a window's, an open tile's, the carousel's and a
// phone's slide. It opens the popout (`ZoomPop.tsx`, a chunk of its own, fetched as the pointer or the keyboard reaches the
// button). A Browser whose desk has no zoom has no button: no control that does nothing.
import { useRef, useState } from 'react';
import { onDemand, useOnDemand } from '../lib/onDemand';
import { levelWords } from './level';
import { useAppLevel } from './store';
import './zoom.css';

const popout = onDemand(() => import('./ZoomPop'));

/**
 * A circle holding two corner brackets, top right and bottom left, pointing out: the owner's pick (Nov 12), drawn here as the
 * bar's other icons are (`chrome/icons.tsx`: a 24-unit view, `currentColor`, the same stroke, caps and joins). The brackets
 * sit well inside, shorter than the radius, so the circle tells it from the expand button's square beside it.
 */
export function ZoomGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12.25 8.25h3.5v3.5M8.25 12.25v3.5h3.5" />
    </svg>
  );
}

export function ZoomButton({ app, deskId, label, className = '' }: {
  app: string;
  deskId: string;
  /** The app's name, which the popout is named by ("Zoom Notebook"). */
  label: string;
  className?: string;
}) {
  const level = useAppLevel(app, deskId);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const Pop = useOnDemand(popout, open && level !== null && 'open')?.ZoomPop;
  if (level === null) return null;
  const words = levelWords(level);
  return (
    // `data-no-drag`: a window's head neither drags nor fills the screen from here.
    <div className={`app-zoom${className ? ` ${className}` : ''}`} data-no-drag="">
      <button
        ref={btn}
        type="button"
        className="icon-btn sm app-zoom-btn"
        aria-label={`Zoom, ${words}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Zoom (${words})`}
        data-level={level}
        onPointerEnter={popout.prefetch}
        onFocus={popout.prefetch}
        onClick={() => setOpen(!open)}
      >
        <ZoomGlyph />
      </button>
      {open && Pop && <Pop app={app} deskId={deskId} label={label} level={level} btn={btn} shut={() => setOpen(false)} />}
    </div>
  );
}
