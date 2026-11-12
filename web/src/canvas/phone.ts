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

/**
 * The bars' short-viewport mode (the accessibility audit's finding 6, the Product Designer's spec): under 400 CSS px high,
 * at any width, as at 400 % zoom or on a phone on its side, each bar is one 44 px row. The scope switch and the zoom fold
 * into one menu button each. `app.css` uses the same query ("short viewport").
 */
const SHORT = '(max-height: 399.98px)';
export const useIsShort = (): boolean => useMatches(SHORT);
