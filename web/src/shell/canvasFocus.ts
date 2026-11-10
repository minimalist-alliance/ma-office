// Whether the canvas has the keyboard: a desk, app or strip control on the proxy layer, or the canvas itself after
// a press on it. The canvas's single keys act only then (WCAG 2.1.4, ADR 0062), so a word a member dictates, or a key
// hit by accident, does nothing with focus on the page, the bars, a menu or a window.

export function canvasHasFocus(el: Element | null = document.activeElement): boolean {
  return !!el?.closest('.proxy-layer, .canvas-wrap');
}

/**
 * Calls `onChange` whenever focus moves, for what shows the canvas's keys. Nothing here renders: a press on the canvas
 * focuses it, and a press must cost no React commit (`shell.spec.ts` counts them).
 */
export function onFocusMove(onChange: () => void): () => void {
  // focusout alone covers focus going to nothing; focusin covers the rest. Neither fires during a camera move.
  window.addEventListener('focusin', onChange);
  window.addEventListener('focusout', onChange);
  return () => {
    window.removeEventListener('focusin', onChange);
    window.removeEventListener('focusout', onChange);
  };
}
