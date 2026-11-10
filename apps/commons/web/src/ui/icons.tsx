// Line icons on a 20 px grid, 1.6 px strokes in currentColor, so they take the button's token.
import type { ReactNode } from 'react';

function I({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconSelect = () => (
  <I>
    <path d="M5 3.5 15.5 10l-4.6 1.2-2.4 4.3Z" />
  </I>
);
export const IconHand = () => (
  <I>
    <path d="M7 10V5.2a1.2 1.2 0 0 1 2.4 0V9m0-4.6V3.9a1.2 1.2 0 0 1 2.4 0V9m0-4a1.2 1.2 0 0 1 2.4 0V10m0-3a1.2 1.2 0 0 1 2.4 0v4.5a5.5 5.5 0 0 1-5.5 5.5h-.6a5 5 0 0 1-4-2L3.9 12a1.3 1.3 0 0 1 2-1.6L7 11.5" />
  </I>
);
export const IconPen = () => (
  <I>
    <path d="M12.8 3.7a1.9 1.9 0 0 1 2.7 2.7L7 14.9 3.6 16l1.1-3.4Z" />
    <path d="m11.5 5 2.7 2.7" />
  </I>
);
export const IconRect = () => (
  <I>
    <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
  </I>
);
export const IconEllipse = () => (
  <I>
    <ellipse cx="10" cy="10" rx="6.8" ry="5.8" />
  </I>
);
export const IconArrow = () => (
  <I>
    <path d="M4.5 15.5 15 5M8.5 5H15v6.5" />
  </I>
);
export const IconText = () => (
  <I>
    <path d="M4.5 5.5V4h11v1.5M10 4v12M7.5 16h5" />
  </I>
);
export const IconNote = () => (
  <I>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V11l-5 5H5.5A1.5 1.5 0 0 1 4 14.5Z" />
    <path d="M16 11h-3.5a1.5 1.5 0 0 0-1.5 1.5V16" />
  </I>
);
export const IconEraser = () => (
  <I>
    <path d="m8.2 15.5-4-4a1.4 1.4 0 0 1 0-2L10 3.7a1.4 1.4 0 0 1 2 0l4.3 4.3a1.4 1.4 0 0 1 0 2l-5.5 5.5M8.2 15.5H16M6.2 7.5l6.3 6.3" />
  </I>
);
export const IconUndo = () => (
  <I>
    <path d="M7 5 3.5 8.5 7 12" />
    <path d="M3.5 8.5h8.2a4.3 4.3 0 0 1 0 8.5H9" />
  </I>
);
export const IconRedo = () => (
  <I>
    <path d="m13 5 3.5 3.5L13 12" />
    <path d="M16.5 8.5H8.3a4.3 4.3 0 0 0 0 8.5H11" />
  </I>
);
export const IconMic = () => (
  <I>
    <rect x="7.5" y="2.8" width="5" height="9" rx="2.5" />
    <path d="M4.8 9.5a5.2 5.2 0 0 0 10.4 0M10 14.8v2.5" />
  </I>
);
export const IconMicOff = () => (
  <I>
    <path d="M12.5 8.4V5.3a2.5 2.5 0 0 0-4.8-1M7.5 7.5v1.8a2.5 2.5 0 0 0 4 2M4.8 9.5a5.2 5.2 0 0 0 8.4 4.1m2-3.1a5 5 0 0 0 .1-1M10 14.8v2.5M3.5 3.5l13 13" />
  </I>
);
export const IconLeave = () => (
  <I>
    <path d="M8 4.5H5.5a1.5 1.5 0 0 0-1.5 1.5v8a1.5 1.5 0 0 0 1.5 1.5H8M12 6.5 15.5 10 12 13.5M15.5 10H8" />
  </I>
);
export const IconBoards = () => (
  <I>
    <rect x="3.5" y="3.5" width="9.5" height="9.5" rx="1.8" />
    <path d="M7 16.5h7.7a1.8 1.8 0 0 0 1.8-1.8V7" />
  </I>
);
export const IconPlus = () => (
  <I>
    <path d="M10 4.5v11M4.5 10h11" />
  </I>
);
export const IconMinus = () => (
  <I>
    <path d="M4.5 10h11" />
  </I>
);
export const IconChevron = () => (
  <I size={16}>
    <path d="m6 8 4 4 4-4" />
  </I>
);
export const IconFit = () => (
  <I>
    <path d="M4 7.5V5.2A1.2 1.2 0 0 1 5.2 4h2.3M12.5 4h2.3A1.2 1.2 0 0 1 16 5.2v2.3M16 12.5v2.3a1.2 1.2 0 0 1-1.2 1.2h-2.3M7.5 16H5.2A1.2 1.2 0 0 1 4 14.8v-2.3" />
  </I>
);
export const IconTrash = () => (
  <I size={16}>
    <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6" />
  </I>
);
export const IconRename = () => (
  <I size={16}>
    <path d="M12.8 3.7a1.9 1.9 0 0 1 2.7 2.7L7 14.9 3.6 16l1.1-3.4Z" />
  </I>
);
export const IconPeople = () => (
  <I>
    <circle cx="7.5" cy="7" r="2.8" />
    <path d="M2.8 16a4.7 4.7 0 0 1 9.4 0M13 4.5a2.6 2.6 0 0 1 0 5M14.5 12a4.5 4.5 0 0 1 2.7 4" />
  </I>
);
export const IconClose = () => (
  <I size={16}>
    <path d="m5 5 10 10M15 5 5 15" />
  </I>
);
export const IconHash = () => (
  <I size={18}>
    <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16" />
  </I>
);
export const IconChat = () => (
  <I>
    <path d="M4 5.5A2 2 0 0 1 6 3.5h8a2 2 0 0 1 2 2V11a2 2 0 0 1-2 2H9l-3.5 3v-3H6a2 2 0 0 1-2-2Z" />
  </I>
);
export const IconSend = () => (
  <I>
    <path d="M3.5 10 16 4l-4.5 12-2.2-4.8Z" />
    <path d="m9.3 11.2 2.9-2.9" />
  </I>
);
export const IconSettings = () => (
  <I>
    <circle cx="10" cy="10" r="2.4" />
    <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" />
  </I>
);
export const IconSidebar = () => (
  <I>
    <rect x="3" y="4" width="14" height="12" rx="2" />
    <path d="M8 4v12" />
  </I>
);
export const IconSpeaker = () => (
  <I size={16}>
    <path d="M4 8h2.5L10 5v10l-3.5-3H4Z" />
    <path d="M13 7.5a3.5 3.5 0 0 1 0 5" />
  </I>
);

/** A tier's seal beside a name, as the Desk app's avatar draws it (chevron for Officer, star for Founder), from the
 *  app's own seal tokens. Never anything about age. */
export function Seal({ badge, size = 14 }: { badge: 'officer' | 'lead'; size?: number }) {
  const label = badge === 'lead' ? 'Founder' : 'Officer';
  return (
    <span className={`ma-cm-seal ma-cm-seal-${badge}`} role="img" aria-label={label} title={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        {badge === 'lead' ? (
          <polygon
            points="12,5.64 14.03,10.04 18.85,10.62 15.29,13.91 16.23,18.66 12,16.3 7.77,18.66 8.71,13.91 5.15,10.62 9.97,10.04"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="1.44"
            strokeLinejoin="round"
          />
        ) : (
          <polyline points="5.76,16.56 12,10.32 18.24,16.56" fill="none" stroke="currentColor" strokeWidth="3.6" />
        )}
      </svg>
    </span>
  );
}
