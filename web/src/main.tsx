// Entry. `./theme/boot` must stay first: it sets data-theme before anything paints.
import './theme/boot';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jost/600.css';
// Both are SIL OFL 1.1. Their licences ship beside the font files, as assets/inter-OFL.txt and assets/jost-OFL.txt
// (from public/assets/, copied from each package's LICENSE). A new font, or a new version, brings its own.
import 'virtual:ma-themes.css';
import './styles/app.css';
import './styles/glass.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ON_CONNECT } from './App';
import { loadingDone } from './chrome/loadingOverlay';
import { popovers } from './chrome/popoversChunk';
import { prefetchRtcLink } from './desk/deskLink';
import { followShield, maiaModeKept, startMaiaMode } from './maiamode/door';
import { startExportSweep } from './platform/exportSweep';
import { bootSession } from './platform/session';
import './theme/themeStore';
import { watchAppearance } from './theme/tune/watch';
// Imported here as well as by `themeStore`, so the entry asks for it beside its other imports: without it the first load
// found it a level deeper, one more round trip before the first paint (since the account menu's panel, its other importer
// here, is a chunk).
import './theme/tokens';
import { prefetchWindows } from './windows/WindowLayer';

const el = document.getElementById('ma-root');
if (!el) throw new Error('#ma-root is missing');
// An error React can't recover from leaves nothing on the page, so the loading overlay (ADR 0058)
// fades now, rather than after the loader's 15 s over a blank office. Reported as React does by default.
createRoot(el, {
  onUncaughtError: (error) => {
    loadingDone('error');
    reportError(error);
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// Dev server only: `?perf=1` shows an fps and long-task readout (src/dev/perfOverlay.ts). Not in a build.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('perf')) void import('./dev/perfOverlay').then((m) => m.startPerfOverlay());
// OpenRouter's window back to the office (`/connect/openrouter`) only relays a code to the office tab: no session, which on a
// signed-out page would carry the address, code and all, to the sign-in page; no desks, no sweep, nothing fetched ahead.
if (!ON_CONNECT) {
  void bootSession();
  startExportSweep();
  // The theme sliders follow the member's setting from `/v1/me` (theme/tune/; the colour math is a chunk of its own).
  watchAppearance();
  // Maia Mode's startup (its own chunk) with the entry, where this browser's copy says the member has it on: the chooser and
  // the room's ground come with the first paint, never after the desks (CONCEPT.md §2, "At startup").
  if (maiaModeKept()) startMaiaMode();
  // `npm run dev` and the shell specs: the held line on a stand-in desk with `?shield` (`mockSource.ts`). Not in a build.
  if (import.meta.env.MODE !== 'production' && new URLSearchParams(location.search).has('shield')) followShield(true);
  // Once the page is idle, fetch the code a desk needs next (its link, every app's window, the Browser) and the top bar's
  // panels, so opening one doesn't wait for it.
  const prefetch = (): void => {
    prefetchRtcLink();
    prefetchWindows();
    popovers.prefetch();
    // Documents' one person key for all the member's desks (a chunk of its own): given to each own desk as its link opens.
    void import('./apps/documents/personKey').then((m) => m.startPersonKeys(), () => undefined);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetch, { timeout: 3000 });
  else setTimeout(prefetch, 1500);
}
