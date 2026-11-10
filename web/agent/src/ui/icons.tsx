// The few glyphs the Agent app needs, drawn on a 20-unit grid in currentColor.
import type { ReactElement } from 'react';

export type IconName = 'plus' | 'close' | 'send' | 'stop' | 'spark' | 'key' | 'meter' | 'list' | 'agents' | 'download' | 'trash' | 'gear' | 'messages' | 'folder' | 'file' | 'clock' | 'upload' | 'back' | 'attach';

const PATHS: Record<IconName, ReactElement> = {
  plus: <path d="M10 4v12M4 10h12" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  send: <path d="M4 10h11M10.5 5.5L15 10l-4.5 4.5" />,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />,
  spark: <path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" />,
  key: (
    <>
      <circle cx="7" cy="10" r="3" />
      <path d="M10 10h7M14.5 10v2.5M17 10v2" />
    </>
  ),
  meter: <path d="M4 15.5h12M6 12.5v-3M10 12.5v-7M14 12.5v-5" />,
  list: <path d="M7 6h9M7 10h9M7 14h9M4 6h.01M4 10h.01M4 14h.01" />,
  agents: (
    <>
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="13.5" cy="8.5" r="2" />
      <path d="M3.5 15.5c.6-2.4 2.2-3.5 4-3.5s3.4 1.1 4 3.5M12 12.2c1.9-.4 3.8.6 4.5 3.3" />
    </>
  ),
  download: <path d="M10 4v8M6.5 8.5L10 12l3.5-3.5M4.5 15.5h11" />,
  trash: <path d="M5 6.5h10M8 6.5V5h4v1.5M6.5 6.5l.6 9h5.8l.6-9" />,
  gear: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6L15 15M5 15l1.4-1.4M13.6 6.4L15 5" />
    </>
  ),
  messages: <path d="M3.5 5h9v6h-5l-3 2.5V11h-1zM14.5 8h2v6h-1v2.5l-3-2.5h-4v-1.5" />,
  folder: <path d="M3.5 6V15h13V7.5H10L8.5 5.5h-5z" />,
  file: <path d="M6 3.5h5.5L14.5 6.5v10H6zM11.5 3.5v3h3" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 6.5V10l2.5 1.5" />
    </>
  ),
  upload: <path d="M10 13V4.5M6.5 8L10 4.5 13.5 8M4.5 15.5h11" />,
  back: <path d="M12 5l-5 5 5 5" />,
  attach: <path d="m16.5 9.5-6.2 6.2a3.6 3.6 0 0 1-5.1-5.1l6.4-6.4a2.4 2.4 0 0 1 3.4 3.4l-6.2 6.2a1.2 1.2 0 0 1-1.7-1.7l5.6-5.6" />,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="ag-icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
