// Entry. `./theme/boot` must stay first: it sets data-theme before anything paints.
import './theme/boot';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/jost/600.css';
// Both are SIL OFL 1.1. Their licences ship beside the font files, as assets/inter-OFL.txt and assets/jost-OFL.txt
// (from public/assets/, copied from each package's LICENSE). A new font, or a new version, brings its own.
import 'virtual:ma-themes.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ON_CONNECT } from './App';
import { popovers } from './chrome/popoversChunk';
import { prefetchRtcLink } from './desk/deskLink';
import { startExportSweep } from './platform/exportSweep';
import { bootSession } from './platform/session';
import './theme/themeStore';
// Imported here as well as by `themeStore`, so the entry asks for it beside its other imports: without it the first load
// found it a level deeper, one more round trip before the first paint (since the account menu's panel, its other importer
// here, is a chunk).
import './theme/tokens';
import { prefetchWindows } from './windows/WindowLayer';

const el = document.getElementById('ma-root');
if (!el) throw new Error('#ma-root is missing');
createRoot(el).render(
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
  // Once the page is idle, fetch the code a desk needs next (its link, every app's window, the Browser) and the top bar's
  // panels, so opening one doesn't wait for it.
  const prefetch = (): void => {
    prefetchRtcLink();
    prefetchWindows();
    popovers.prefetch();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetch, { timeout: 3000 });
  else setTimeout(prefetch, 1500);
}
