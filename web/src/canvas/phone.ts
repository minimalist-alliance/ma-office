// Phones keep the cell grid, with no free placement (ADR 0062). The same width as the camera's phone insets.
import { useEffect, useState } from 'react';

const PHONE = '(max-width: 599px)';
const TOUCH = '(hover: none)';

export const isPhone = (): boolean => window.matchMedia(PHONE).matches;

function useMatches(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (): void => setMatches(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const useIsPhone = (): boolean => useMatches(PHONE);

/** A screen with no hover, whose controls show with focus and are bigger for a finger. */
export const useIsTouch = (): boolean => useMatches(TOUCH);
