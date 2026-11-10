// The few icons only Maia's widget uses, in the same 24-unit stroke style as `chrome/icons.tsx`.
import type { JSX } from 'react';

const PATHS = {
  hide: <path d="M6 12h12" />,
  back: <path d="M19 12H5.5M11 6.5 5.5 12l5.5 5.5" />,
  newChat: (
    <>
      <path d="M12.5 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5" />
      <path d="m10 14 .6-2.6 7-7a1.4 1.4 0 0 1 2 2l-7 7Z" />
    </>
  ),
  memory: (
    <>
      <path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v14l-6.5-4-6.5 4V6A1.5 1.5 0 0 1 7 4.5Z" />
    </>
  ),
  pause: <path d="M9.5 7v10M14.5 7v10" />,
  play: <path d="M8.5 6.5v11l9-5.5Z" />,
  attach: <path d="m19 11.5-7 7a4.5 4.5 0 0 1-6.4-6.4l7.4-7.4a3 3 0 0 1 4.2 4.2l-7.4 7.4a1.5 1.5 0 0 1-2.1-2.1l6.7-6.7" />,
  close: <path d="M7 7l10 10M17 7 7 17" />,
  send: <path d="M12 18.5V6M6.5 11.5 12 6l5.5 5.5" />,
} satisfies Record<string, JSX.Element>;

export type MaiaIconName = keyof typeof PATHS;

export function MaiaIcon({ name, size = 18 }: { name: MaiaIconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
