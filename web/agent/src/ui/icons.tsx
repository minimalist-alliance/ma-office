// The few glyphs the Agent app needs, drawn on a 20-unit grid in currentColor.
import type { ReactElement } from 'react';

export type IconName =
  | 'plus'
  | 'close'
  | 'send'
  | 'stop'
  | 'key'
  | 'meter'
  | 'list'
  | 'agents'
  | 'download'
  | 'trash'
  | 'gear'
  | 'messages'
  | 'folder'
  | 'file'
  | 'clock'
  | 'upload'
  | 'back'
  | 'attach'
  // S-14: the four levels, an answered card's marks, Memory and its search, and a change's way back.
  | 'eye'
  | 'pencil'
  | 'out'
  | 'coin'
  | 'check'
  | 'minus'
  | 'bookmark'
  | 'search'
  | 'undo'
  // #6, free models: the free card's wait.
  | 'hourglass';

const PATHS: Record<IconName, ReactElement> = {
  plus: <path d="M10 4v12M4 10h12" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  send: <path d="M4 10h11M10.5 5.5L15 10l-4.5 4.5" />,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />,
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
  eye: (
    <>
      <path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.5 15.5l.8-3.2L13 4.6a1.6 1.6 0 0 1 2.3 2.3l-7.7 7.8z" />
      <path d="M11.8 5.8l2.4 2.4" />
    </>
  ),
  out: (
    <>
      <path d="M11.5 4.5h4v4M15.5 4.5L9 11" />
      <path d="M13.5 12v3.5h-9v-9H8" />
    </>
  ),
  coin: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M12 7.8c-.4-.5-1.1-.8-2-.8-1.2 0-2 .6-2 1.4 0 1.9 4 1 4 2.9 0 .8-.8 1.4-2 1.4-.9 0-1.6-.3-2-.9M10 5.6V7M10 13v1.4" />
    </>
  ),
  check: <path d="M5 10.5l3.2 3.2L15 7" />,
  minus: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M7 10h6" />
    </>
  ),
  bookmark: <path d="M6 3.5h8v13l-4-3-4 3z" />,
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="M12.7 12.7L16.5 16.5" />
    </>
  ),
  undo: (
    <>
      <path d="M7.5 5.5L4.5 8.5l3 3" />
      <path d="M4.5 8.5h7a4 4 0 0 1 0 8H9" />
    </>
  ),
  hourglass: <path d="M6 3.5h8M6 16.5h8M7 3.5c0 3.5 6 3.5 6 6.5s-6 3-6 6.5M13 3.5c0 3.5-6 3.5-6 6.5s6 3 6 6.5" />,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className ? `ag-icon ${className}` : 'ag-icon'} width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
