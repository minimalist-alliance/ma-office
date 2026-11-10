// Inter is self-hosted (src/main.tsx imports it) and awaited before the first canvas draw. So is Jost 600, for
// the desk's etched name (canvas/etch.ts).
export const CANVAS_FONT = '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Resolves when the canvas weights are ready, or after `capMs` so a slow font never blocks first paint for long. */
export function fontsReady(capMs = 800): Promise<void> {
  const inter = ['300 20px', '400 13px', '600 13px'].map((f) => document.fonts.load(`${f} "Inter Variable"`));
  const load = Promise.all([...inter, document.fonts.load('600 14px "Jost"')]);
  const cap = new Promise<void>((resolve) => window.setTimeout(resolve, capMs));
  return Promise.race([load.then(() => undefined, () => undefined), cap]);
}
