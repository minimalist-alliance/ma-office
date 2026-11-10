// Esc puts a guild sheet or choice away wherever focus is: a Save that's just gone quiet leaves focus on the page, not
// in the dialog. Captured first, so the office's own Esc (leaving a desk, closing a window) never hears it as well.
import { useEffect } from 'react';

export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}
