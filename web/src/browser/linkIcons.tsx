// The Browser window's glyphs for Links in and out (#9), on the office's 24 grid at a 1.7 stroke, from the Product
// Designer's `mocks.mjs` (`P`; `out` there is `openOut` here). They live in the Browser window's chunk, not in
// `chrome/icons.tsx`, so nothing of them is in the first load.
import type { JSX } from 'react';

const PATHS = {
  openOut: (
    <>
      <path d="M13.5 4.5h6v6M19.5 4.5l-8 8" />
      <path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  mail: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </>
  ),
  call: <path d="M7 4.5h2.5l1.5 4-2 1.3a9 9 0 0 0 5.2 5.2l1.3-2 4 1.5V17a2 2 0 0 1-2 2A14.5 14.5 0 0 1 5 6.5a2 2 0 0 1 2-2Z" />,
  thread: <path d="M5 6.5h14v9h-9l-4 3.5v-3.5H5Z" />,
  video: (
    <>
      <rect x="3.5" y="7" width="12" height="10" rx="2" />
      <path d="m15.5 10.5 5-3v9l-5-3" />
    </>
  ),
  calendar: (
    <>
      <rect x="4.5" y="5.5" width="15" height="14" rx="2" />
      <path d="M4.5 10h15M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
} satisfies Record<string, JSX.Element>;

export type LinkIconName = keyof typeof PATHS;

export function LinkIcon({ name, size = 17 }: { name: LinkIconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
