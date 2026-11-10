// Stroke icons in currentColor, drawn on the prototype's 24-unit grid (prototype/src/ui/icons.jsx).
import type { ReactElement } from 'react';

const PATHS: Record<string, ReactElement> = {
  chevronLeft: <path d="M14.5 6 8.5 12l6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  chevronUp: <path d="m6 14.5 6-6 6 6" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  close: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  more: (
    <>
      <circle cx="6.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  bullets: (
    <>
      <path d="M10 7h9M10 12h9M10 17h9" />
      <circle cx="5.5" cy="7" r="1" fill="currentColor" />
      <circle cx="5.5" cy="12" r="1" fill="currentColor" />
      <circle cx="5.5" cy="17" r="1" fill="currentColor" />
    </>
  ),
  numbers: (
    <>
      <path d="M10 7h9M10 12h9M10 17h9" />
      <path d="M4.5 5.5h1.2v3.5M4.3 11h2a.8.8 0 0 1 .5 1.4L4.3 14.5h2.6M4.3 16h2.4l-1.3 1.3a1.1 1.1 0 1 1-1.1 1.6" strokeWidth="1.2" />
    </>
  ),
  checklist: (
    <>
      <path d="M11 7.5h8M11 16.5h8" />
      <rect x="4.5" y="5" width="4.5" height="4.5" rx="1" />
      <path d="m4.8 16.4 1.6 1.6 2.8-3.2" />
    </>
  ),
  highlight: (
    <>
      <path d="m14.5 5 4.5 4.5-7.5 7.5H7v-4.5L14.5 5Z" />
      <path d="M5 20h14" />
    </>
  ),
  calendar: (
    <>
      <rect x="4.5" y="5.5" width="15" height="14" rx="2.5" />
      <path d="M4.5 10h15M8.5 3.5v3.5M15.5 3.5v3.5" />
    </>
  ),
  tabs: (
    <>
      <path d="M4.5 19.5v-11a2 2 0 0 1 2-2h3l1.5 2h6.5a2 2 0 0 1 2 2v9" />
      <path d="M4 19.5h16" />
    </>
  ),
  trash: <path d="M5.5 7.5h13M10 7.5V5.5h4v2M7.5 7.5l.8 11h7.4l.8-11" />,
  search: (
    <>
      <circle cx="11" cy="11" r="5.5" />
      <path d="m15.2 15.2 4 4" />
    </>
  ),
  history: (
    <>
      <path d="M5.5 12a6.5 6.5 0 1 0 2-4.7M5.5 5v3.5H9" />
      <path d="M12 8.5V12l2.5 1.5" />
    </>
  ),
  restore: <path d="M5.5 12a6.5 6.5 0 1 0 2-4.7M5.5 5v3.5H9" />,
  download: <path d="M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13" />,
  undo: <path d="M9 7.5 5 11.5l4 4M5.5 11.5H15a4 4 0 0 1 0 8h-2" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`nb-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The Notebook app glyph, as the canvas draws it (prototype AppGlyph). */
export function NotebookGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="nb-glyph">
      <path className="nb-glyph-page" d="M14 5h15l8 8v27q0 3-3 3H14q-3 0-3-3V8q0-3 3-3Z" />
      <path className="nb-glyph-fold" d="M29 5v6q0 2 2 2h6Z" />
      <rect className="nb-glyph-block" x="16" y="12" width="8" height="8" rx="1.5" />
      <path className="nb-glyph-line" d="M16 27h16M16 32h16" />
      <path className="nb-glyph-accent" d="M16 37h10" />
    </svg>
  );
}
